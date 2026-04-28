'use strict';

const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');

const {
  getState, saveState, updateState,
  getProjectList, createInitialState,
  ensureProjectDirs, projectDir, assetsDir
} = require('../utils/state');

const {
  signToken, setAuthCookie, clearAuthCookie, requireAuth
} = require('../middleware/session');

// ─── Identity fields required before step 02 becomes 'ready' ─────────────────

const REQUIRED_IDENTITY_FIELDS = [
  'client_name', 'primary_domain', 'industry',
  'offer_description', 'target_personas'
];

function identityComplete(identity) {
  if (!identity) return false;
  return REQUIRED_IDENTITY_FIELDS.every(field => {
    const v = identity[field];
    if (Array.isArray(v)) return v.length > 0;
    return v && String(v).trim().length > 0;
  });
}

// ─── GET /api/projects ────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const projects = getProjectList();
    return res.status(200).json({ projects });
  } catch (err) {
    console.error('[projects] list error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/projects/create ────────────────────────────────────────────────

router.post('/create', async (req, res) => {
  try {
    const { project_name, primary_domain = '', password } = req.body;

    // Validation
    if (!project_name || String(project_name).trim().length === 0) {
      return res.status(400).json({ error: 'project_name is required' });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'password must be at least 6 characters' });
    }

    // Generate slug
    const slug = String(project_name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    if (!slug) {
      return res.status(400).json({ error: 'project_name produced an empty slug' });
    }

    // Duplicate check
    const existing = getState(slug);
    if (existing) {
      return res.status(409).json({ error: 'Project with that name already exists' });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Build initial state
    const initialState = createInitialState({
      project_id: uuidv4(),
      project_name: String(project_name).trim(),
      slug,
      password_hash,
      primary_domain: String(primary_domain).trim()
    });

    // Persist
    saveState(slug, initialState);

    // Auto-login
    const token = signToken({ slug, project_name: initialState.project_name });
    setAuthCookie(res, token);

    return res.status(201).json({ slug, project_name: initialState.project_name });
  } catch (err) {
    console.error('[projects] create error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/projects/:slug/state  [requireAuth] ────────────────────────────

router.get('/:slug/state', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    // Strip sensitive field before sending
    const { password_hash, ...safeState } = state;
    return res.status(200).json({ state: safeState });
  } catch (err) {
    console.error('[projects] get state error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/projects/:slug/config  [requireAuth] ─────────────────────────

router.patch('/:slug/config', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { slug } = req.params;
    const { section, data } = req.body;

    const validSections = ['identity', 'brand', 'lead_magnets', 'contact_form'];
    if (!section || !validSections.includes(section)) {
      return res.status(400).json({
        error: `section must be one of: ${validSections.join(', ')}`
      });
    }
    if (data === undefined || data === null) {
      return res.status(400).json({ error: 'data is required' });
    }

    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    // Apply update: arrays are replaced, objects are deep-merged (handled by updateState)
    // lead_magnets is always replaced as an array
    const configUpdate = { config: { [section]: data } };
    const updated = updateState(slug, configUpdate);

    // Determine step_status updates
    const statusUpdates = {};

    // step 01 → complete after any config save (if not already)
    if (updated.step_status['01'] !== 'complete') {
      statusUpdates['01'] = 'complete';
    }

    // step 02 → ready if all required identity fields present
    if (section === 'identity') {
      const finalIdentity = updated.config.identity;
      if (identityComplete(finalIdentity)) {
        if (updated.step_status['02'] === 'locked') {
          statusUpdates['02'] = 'ready';
        }
      }
    }

    if (Object.keys(statusUpdates).length > 0) {
      const stepUpdate = { step_status: statusUpdates };
      const withStatus = updateState(slug, stepUpdate);
      return res.status(200).json({ success: true, step_status: withStatus.step_status });
    }

    return res.status(200).json({ success: true, step_status: updated.step_status });
  } catch (err) {
    console.error('[projects] config update error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/projects/:slug/analytics  [requireAuth] ──────────────────────

router.patch('/:slug/analytics', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { slug } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const updated = updateState(slug, { analytics: req.body });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[projects] analytics update error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/projects/:slug/competitors  [requireAuth] ────────────────────

router.patch('/:slug/competitors', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { slug } = req.params;
    const { confirmed, g2_slugs, candidates } = req.body;

    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const competitorUpdate = {};
    if (candidates  !== undefined) competitorUpdate.candidates  = candidates;
    if (confirmed   !== undefined) competitorUpdate.confirmed   = confirmed;
    if (g2_slugs    !== undefined) competitorUpdate.g2_slugs    = g2_slugs;

    const updates = { competitors: competitorUpdate };

    // If confirmed list has entries, unlock step 04
    const confirmedList = confirmed !== undefined ? confirmed : state.competitors.confirmed;
    if (Array.isArray(confirmedList) && confirmedList.length > 0) {
      if (state.step_status['04'] === 'locked') {
        updates.step_status = { '04': 'ready' };
      }
    }

    const updated = updateState(slug, updates);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[projects] competitors update error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/projects/:slug/calendar  [requireAuth] ───────────────────────

router.patch('/:slug/calendar', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { slug } = req.params;
    const { project_start_date, tasks } = req.body;

    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const calendarUpdate = {};
    if (project_start_date !== undefined) calendarUpdate.project_start_date = project_start_date;
    if (tasks              !== undefined) calendarUpdate.tasks = tasks;

    updateState(slug, { calendar: calendarUpdate });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[projects] calendar update error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/projects/:slug/asset  [requireAuth] ───────────────────────────
//
// Multer storage is configured per-request so we can use the slug to place
// files directly into the correct assets directory.

router.post('/:slug/asset', requireAuth, (req, res) => {
  if (req.projectSlug !== req.params.slug) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { slug } = req.params;

  // Ensure dirs exist before multer tries to write there
  ensureProjectDirs(slug);
  const targetDir = assetsDir(slug);

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, targetDir),
    filename:    (_req, file, cb) => {
      // Sanitise filename: keep extension, replace unsafe chars
      const ext  = path.extname(file.originalname).toLowerCase();
      const base = path.basename(file.originalname, ext)
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 100);
      const name = `${Date.now()}_${base}${ext}`;
      cb(null, name);
    }
  });

  const upload = multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024 } // 25 MB
  }).single('file');

  upload(req, res, (err) => {
    if (err) {
      console.error('[projects] asset upload error:', err.message);
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file received' });
    }

    const url = `/assets/${slug}/${req.file.filename}`;
    return res.status(200).json({ url, filename: req.file.filename });
  });
});

// ─── DELETE /api/projects/:slug  [requireAuth] ───────────────────────────────

router.delete('/:slug', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { slug } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const dir = projectDir(slug);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    clearAuthCookie(res);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[projects] delete error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/projects/:slug/read-site  [requireAuth] ──────────────────────
// Crawls the project domain with Exa and extracts business identity via Claude.
// Auto-populates offer description, industry, personas, products.

router.post('/:slug/read-site', requireAuth, async (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const domain = req.body.domain || state.config?.identity?.primary_domain || '';
    if (!domain) return res.status(400).json({ error: 'No domain configured. Enter your domain first.' });

    const EXA_KEY       = process.env.EXA_API_KEY       || '';
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

    if (!EXA_KEY)       return res.status(500).json({ error: 'EXA_API_KEY not configured on server.' });
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server.' });

    const fetch = require('node-fetch');

    // Step 1: Exa crawl — read the site content
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const exaResp = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'x-api-key': EXA_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `What does ${cleanDomain} do, who do they serve, and what are their products`,
        numResults: 8,
        type: 'neural',
        includeDomains: [cleanDomain],
        useAutoprompt: false,
        contents: { text: true, highlights: true }
      })
    });

    const exaData = await exaResp.json();
    const siteText = (exaData.results || [])
      .map(r => [r.title, r.text || '', (r.highlights || []).join(' ')].join('\n'))
      .join('\n\n')
      .slice(0, 8000);

    if (!siteText.trim()) {
      return res.status(422).json({ error: `Could not read content from ${cleanDomain}. Make sure the site is live and publicly accessible.` });
    }

    // Step 2: Claude extracts structured identity from site content
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-20250514',
        max_tokens: 1000,
        system: 'You are a business analyst. Extract structured information from website content. Return ONLY valid JSON, no explanation.',
        messages: [{
          role: 'user',
          content: `Analyze this website content and extract business identity information.

Website domain: ${cleanDomain}
Content:
${siteText}

Return ONLY this JSON structure (no markdown, no explanation):
{
  "client_name": "Company name (proper case)",
  "offer_description": "2-3 sentences: what they sell, who they sell it to, and the core outcome they deliver. Be specific.",
  "industry": "Industry/vertical in 2-4 words (e.g. 'B2B SaaS Marketing', 'Healthcare Compliance Software')",
  "primary_products": ["product or service 1", "product or service 2", "product or service 3"],
  "target_personas": ["Job title/role 1", "Job title/role 2", "Job title/role 3"],
  "icp_company_size": ["SMB", "Mid-Market", "Enterprise"],
  "icp_industries": ["industry 1", "industry 2", "industry 3"]
}`
        }]
      })
    });

    const claudeData = await claudeResp.json();
    const rawText = claudeData.content?.[0]?.text || '{}';

    let extracted;
    try {
      // Strip markdown fences if present
      const clean = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'').trim();
      extracted = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: 'Could not parse site intelligence. Try again or fill in manually.' });
    }

    return res.json({ extracted, domain_read: cleanDomain, chars_read: siteText.length });

  } catch (err) {
    console.error('[projects] read-site error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
