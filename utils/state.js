'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || './data/projects';

// ─── PostgreSQL pool (lazy init) ─────────────────────────────────────────────

let _pool     = null;
let _dbReady  = false;

function getPool() {
  if (_pool) return _pool;
  if (!process.env.DATABASE_URL) return null;
  try {
    const { Pool } = require('pg');
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
    _pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        slug       TEXT PRIMARY KEY,
        state      JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).then(() => {
      _dbReady = true;
      console.log('[state] PostgreSQL ready — persistent storage active');
    }).catch(e => console.error('[state] DB table init error:', e.message));
    return _pool;
  } catch (e) {
    console.error('[state] pg unavailable, using filesystem:', e.message);
    return null;
  }
}

// ─── In-memory cache (avoids repeated DB reads within a request cycle) ───────

const _cache = new Map();

// ─── Directory helpers (always needed for uploaded files) ────────────────────

function projectDir(slug)    { return path.resolve(DATA_DIR, slug); }
function statePath(slug)     { return path.join(projectDir(slug), 'state.json'); }
function assetsDir(slug)     { return path.join(projectDir(slug), 'assets'); }
function exportsDir(slug)    { return path.join(projectDir(slug), 'exports'); }
function voiceGuideDir(slug) { return path.join(projectDir(slug), 'voice-guide'); }
function imagesDir(slug)     { return path.join(projectDir(slug), 'assets', 'images'); }

function ensureProjectDirs(slug) {
  const dirs = [projectDir(slug), assetsDir(slug), exportsDir(slug),
                voiceGuideDir(slug), imagesDir(slug)];
  for (const d of dirs) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function ensureDataRoot() {
  const root = path.resolve(DATA_DIR);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
}

// ─── Deep merge ───────────────────────────────────────────────────────────────

function deepMerge(a, b) {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return b;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return b;
  const result = Object.assign({}, a);
  for (const key of Object.keys(b)) {
    if (key in a &&
        typeof a[key] === 'object' && a[key] !== null && !Array.isArray(a[key]) &&
        typeof b[key] === 'object' && b[key] !== null && !Array.isArray(b[key])) {
      result[key] = deepMerge(a[key], b[key]);
    } else {
      result[key] = b[key];
    }
  }
  return result;
}

// ─── Async DB helpers ─────────────────────────────────────────────────────────

async function dbGet(slug) {
  const pool = getPool();
  if (!pool) return null;
  const res = await pool.query('SELECT state FROM projects WHERE slug = $1', [slug]);
  return res.rows.length ? res.rows[0].state : null;
}

async function dbSave(slug, state) {
  const pool = getPool();
  if (!pool) return;
  await pool.query(`
    INSERT INTO projects (slug, state, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (slug) DO UPDATE
      SET state = EXCLUDED.state, updated_at = NOW()
  `, [slug, JSON.stringify(state)]);
}

async function dbList() {
  const pool = getPool();
  if (!pool) return null;
  const res = await pool.query(`
    SELECT slug,
           state->>'project_name'                          AS project_name,
           state->'config'->'identity'->>'primary_domain'  AS primary_domain,
           state->>'created_at'                            AS created_at,
           state->>'updated_at'                            AS updated_at,
           state->'step_status'                            AS step_status
    FROM projects ORDER BY updated_at DESC
  `);
  return res.rows.map(r => ({
    slug:           r.slug,
    project_name:   r.project_name   || '',
    primary_domain: r.primary_domain || '',
    created_at:     r.created_at     || '',
    updated_at:     r.updated_at     || '',
    step_status:    r.step_status    || {},
  }));
}

// ─── Public sync API (same signatures as before — no callers need to change) ──
//
// Strategy:
//   getState  — returns from cache (instant) or filesystem.
//               DB-backed projects are pre-loaded into cache by saveState / preload.
//   saveState — writes to cache immediately, then fires async DB write.
//               Falls back to filesystem if no DB.
//   updateState — getState → deepMerge → saveState.
//   getProjectList — reads cache + filesystem OR DB (async, called from async route).

function getState(slug) {
  // 1. Cache hit
  if (_cache.has(slug)) return _cache.get(slug);

  // 2. Filesystem (always available as fallback)
  const p = statePath(slug);
  if (fs.existsSync(p)) {
    try {
      const state = JSON.parse(fs.readFileSync(p, 'utf8'));
      _cache.set(slug, state);
      return state;
    } catch (e) {
      throw new Error(`Failed to parse state.json for "${slug}": ${e.message}`);
    }
  }

  // 3. DB — schedule async load into cache; return null for now
  //    (caller will retry after the async route's await resolves)
  const pool = getPool();
  if (pool) {
    dbGet(slug).then(state => {
      if (state) _cache.set(slug, state);
    }).catch(e => console.error('[state] async preload error:', e.message));
  }
  return null;
}

function saveState(slug, state) {
  state.updated_at = new Date().toISOString();

  // Always update cache first (instant, sync)
  _cache.set(slug, state);

  const pool = getPool();
  if (pool) {
    // Async DB write — fire and forget, log on error
    dbSave(slug, state).catch(e => {
      console.error(`[state] DB save error for "${slug}":`, e.message);
      // Fallback: write to filesystem
      try {
        ensureProjectDirs(slug);
        const p = statePath(slug), tmp = p + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
        fs.renameSync(tmp, p);
      } catch (fe) {
        console.error('[state] filesystem fallback also failed:', fe.message);
      }
    });
  } else {
    // Pure filesystem
    ensureProjectDirs(slug);
    const p = statePath(slug), tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  }
}

function updateState(slug, updates) {
  const state = getState(slug);
  if (!state) throw new Error(`Project "${slug}" not found`);
  const merged = deepMerge(state, updates);
  saveState(slug, merged);
  return merged;
}

// getProjectList is called from an async Express route handler, so we can await here
async function getProjectList() {
  const pool = getPool();

  if (pool) {
    try {
      const rows = await dbList();
      // Warm the cache with any projects not already there
      for (const row of rows) {
        if (!_cache.has(row.slug)) {
          const full = await dbGet(row.slug);
          if (full) _cache.set(row.slug, full);
        }
      }
      return rows;
    } catch (e) {
      console.error('[state] getProjectList DB error:', e.message);
    }
  }

  // Filesystem fallback
  ensureDataRoot();
  const root = path.resolve(DATA_DIR);
  if (!fs.existsSync(root)) return [];
  const slugs = fs.readdirSync(root).filter(name =>
    fs.existsSync(path.join(root, name, 'state.json'))
  );
  return slugs.map(slug => {
    try {
      const state = JSON.parse(fs.readFileSync(statePath(slug), 'utf8'));
      _cache.set(slug, state);
      return {
        slug,
        project_name:   state.project_name,
        primary_domain: state.config?.identity?.primary_domain || '',
        created_at:     state.created_at,
        updated_at:     state.updated_at,
        step_status:    state.step_status || {},
      };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

// ─── Startup: pre-warm cache from DB ─────────────────────────────────────────
// Called once when server starts so getState hits cache on first request.

async function warmCache() {
  const pool = getPool();
  if (!pool) return;
  try {
    const res = await pool.query('SELECT slug, state FROM projects');
    for (const row of res.rows) {
      _cache.set(row.slug, row.state);
    }
    console.log(`[state] Cache warmed: ${res.rows.length} projects loaded from DB`);
  } catch (e) {
    console.error('[state] Cache warm error:', e.message);
  }
}

// ─── Initial state factory ────────────────────────────────────────────────────

function createInitialState({ project_id, project_name, slug, password_hash, primary_domain }) {
  const now = new Date().toISOString();
  return {
    project_id, project_name, slug, password_hash,
    created_at: now, updated_at: now,
    step_status: {
      '00': 'complete', '01': 'ready',
      '02': 'locked', '03': 'locked', '04': 'locked', '05': 'locked',
      '06': 'locked', '07': 'locked', '08': 'locked', '09': 'locked'
    },
    config: {
      identity: {
        client_name: '', primary_domain: primary_domain || '',
        industry: '', primary_products: [], offer_description: '',
        target_personas: [], icp_company_size: [], icp_industries: []
      },
      brand: {
        primary_font: 'Inter', secondary_font: 'Inter',
        primary_color: '#3b82f6', secondary_color: '#1e40af',
        accent_color: '#10b981', background_color: '#ffffff',
        text_color: '#1f2937', logo_url: '', brand_voice: 'Professional',
        cta_button_text: 'Book a Demo', cta_button_url: ''
      },
      lead_magnets: [],
      contact_form: {
        form_headline: '', fields: ['name', 'company', 'email'],
        submission_endpoint: '',
        confirmation_message: "Thank you — we'll be in touch shortly.",
        notification_email: ''
      }
    },
    analytics: {
      ga4_property_id: '', gsc_property_url: '',
      service_account_json: null, date_range_days: 90
    },
    baseline: null,
    competitors: { candidates: [], confirmed: [], profiles: [], g2_slugs: {} },
    research: {
      last_run_at: null,
      pipeline_stages: {
        site_intelligence:   { status: 'queued', started_at: null, completed_at: null, records: 0 },
        permutation_engine:  { status: 'queued', started_at: null, completed_at: null, records: 0 },
        g2_review_mining:    { status: 'queued', started_at: null, completed_at: null, records: 0 },
        reddit_intelligence: { status: 'queued', started_at: null, completed_at: null, records: 0 },
        serp_analysis:       { status: 'queued', started_at: null, completed_at: null, records: 0 },
        synthesis_scoring:   { status: 'queued', started_at: null, completed_at: null, records: 0 }
      },
      site_intelligence: null, keyword_universe: null, g2_intelligence: null,
      reddit_intelligence: null, serp_analysis: null, synthesis: null
    },
    pipeline_log: [],
    pages: { bofu_pages: [], comparison_pages: [], supporting_content: [], striking_distance: [] },
    calendar: { project_start_date: null, tasks: [] },
    reports: [],
    tech_seo: { robots_txt: null, llms_txt: null, sitemap_xml: null, gsc_submissions: [] },
    content_studio: {
      settings: { require_approval: true, plagiarism_threshold: 30, personas: [] },
      drafts: [], image_library: []
    },
    voice_guide: {
      documents: [], index: null, index_status: 'empty',
      index_job_id: null, indexed_at: null
    },
    runs: []
  };
}

module.exports = {
  getState, saveState, updateState, getProjectList,
  createInitialState, ensureProjectDirs, ensureDataRoot,
  projectDir, assetsDir, exportsDir, voiceGuideDir, imagesDir,
  deepMerge, warmCache,
};
