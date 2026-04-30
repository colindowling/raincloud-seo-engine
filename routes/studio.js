'use strict';

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');
const multer = require('multer');

const {
  getState, saveState,
  imagesDir, exportsDir
} = require('../utils/state');
const { triggerWorkflow } = require('../utils/webhook');
const { requireAuth }     = require('../middleware/session');

// ─── Slug ownership check ─────────────────────────────────────────────────────

function checkSlug(req, res) {
  if (req.projectSlug !== req.params.slug) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

// ─── CTA auto-select logic ────────────────────────────────────────────────────

function autoSelectCTA(cluster, state) {
  const allPages = [
    ...(state.pages.bofu_pages      || []),
    ...(state.pages.comparison_pages || [])
  ];
  const lm = state.config?.lead_magnets || [];
  const kw = cluster.primary_keyword.toLowerCase();

  // Rule 1: if cluster has internal_links_out pointing to a BoFu page, use demo CTA
  // internal_links_out is an array of slug strings (not objects), so compare directly
  const linkedPage = allPages.find(p =>
    (cluster.internal_links_out || []).some(l =>
      (typeof l === 'string' ? l : l.destination || l.slug || '') === p.recommended_slug
    )
  );
  if (linkedPage) {
    return {
      assignment: 'demo',
      reasoning: 'Matched linked BoFu page — demo CTA aligns with commercial intent'
    };
  }

  // Rule 2: if keyword contains informational signals, use lead magnet if available
  const infoSignals = ['how to', 'guide', 'what is', 'checklist', 'tips', 'benchmark', 'report', 'statistics'];
  const isInfo = infoSignals.some(s => kw.includes(s));
  if (isInfo && lm.length > 0) {
    const bestLM = lm.find(m =>
      kw.split(' ').some(w => m.title?.toLowerCase().includes(w))
    ) || lm[0];
    const idx = lm.indexOf(bestLM) + 1;
    return {
      assignment: `lead_magnet_${idx}`,
      reasoning: `Informational keyword matched lead magnet: "${bestLM.title}"`
    };
  }

  // Default: demo
  return {
    assignment: 'demo',
    reasoning: 'Default — commercial intent or no matching lead magnet'
  };
}

// ─── Build CTA data object from state + assignment ────────────────────────────

function buildCtaData(ctaAssignment, state) {
  if (ctaAssignment && ctaAssignment.startsWith('lead_magnet_')) {
    const idx = parseInt(ctaAssignment.replace('lead_magnet_', ''), 10) - 1;
    const lm  = (state.config?.lead_magnets || [])[idx];
    if (lm) return lm;
  }
  return {
    text: state.config?.brand?.cta_button_text || 'Book a Demo',
    url:  state.config?.brand?.cta_button_url  || ''
  };
}

// ─── Strip HTML tags for word count ──────────────────────────────────────────

function countWords(html) {
  const text = (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.split(' ').filter(Boolean).length : 0;
}

// ─── Multer for image uploads ─────────────────────────────────────────────────

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml'
]);

const imageStorage = multer.diskStorage({
  destination(req, _file, cb) {
    const dir = imagesDir(req.params.slug);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) {
    const savedName = `${uuidv4()}-${file.originalname}`;
    cb(null, savedName);
  }
});

const imageUpload = multer({
  storage: imageStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported image type: ${file.mimetype}`));
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DRAFT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/studio/:slug/drafts ─────────────────────────────────────────────

router.get('/:slug/drafts', requireAuth, (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const drafts = (state.content_studio?.drafts || []).map(d => {
      const { body_html, ...rest } = d;
      return {
        ...rest,
        body_html_preview: (body_html || '').substring(0, 200)
      };
    });

    return res.status(200).json({ drafts });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/studio/:slug/drafts/generate/:clusterId ───────────────────────

router.post('/:slug/drafts/generate/:clusterId', requireAuth, async (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const { slug, clusterId } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    // Search all page arrays — not just supporting_content
    const allPageArrays = [
      ...(state.pages.supporting_content || []),
      ...(state.pages.bofu_pages         || []),
      ...(state.pages.comparison_pages   || []),
      ...(state.pages.striking_distance  || []),
    ];
    const cluster = allPageArrays.find(c => c.cluster_id === clusterId);
    if (!cluster) {
      return res.status(404).json({ error: `Cluster "${clusterId}" not found in any page group` });
    }

    const now     = new Date().toISOString();
    const draftId = uuidv4();

    const ctaResult    = autoSelectCTA(cluster, state);
    const ctaAssignment = ctaResult.assignment;
    const ctaData       = buildCtaData(ctaAssignment, state);

    const draft = {
      draft_id:            draftId,
      cluster_id:          clusterId,
      title:               cluster.primary_keyword,
      target_keyword:      cluster.primary_keyword,
      brief:               cluster.brief || {},
      status:              'generating',
      cta_mode:            'auto',
      cta_assignment:      ctaAssignment,
      cta_auto_reasoning:  ctaResult.reasoning,
      cross_links_applied: false,
      created_at:          now,
      updated_at:          now,
      images:              [],
      exports:             {}
    };

    if (!Array.isArray(state.content_studio.drafts)) {
      state.content_studio.drafts = [];
    }
    state.content_studio.drafts.push(draft);

    const allPages = [
      ...(state.pages.bofu_pages      || []),
      ...(state.pages.comparison_pages || [])
    ].map(p => ({
      slug:    p.recommended_slug,
      keyword: p.primary_keyword,
      type:    p.opportunity_type
    }));

    const payload = {
      draft_id:       draftId,
      cluster_id:     clusterId,
      brief: cluster.brief || {
        primary_keyword:    cluster.primary_keyword,
        secondary_keywords: cluster.secondary_keywords || [],
        target_word_count:  1400,
        content_format:     'guide'
      },
      voice_index:    state.voice_guide?.index || null,
      cta_assignment: ctaAssignment,
      cta_data:       ctaData,
      cross_links:    cluster.internal_links_out || [],
      brand_config:   state.config?.brand   || {},
      client_name:    state.config?.identity?.client_name || '',
      industry:       state.config?.identity?.industry    || '',
      all_pages:      allPages
    };

    const r = await triggerWorkflow('Content_Creator', slug, payload);
    saveState(slug, state);

    return res.status(201).json({ draft_id: draftId, job_id: r.job_id });
  } catch (err) {
    console.error('[studio] drafts/generate error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/studio/:slug/drafts/:draftId ───────────────────────────────────

router.get('/:slug/drafts/:draftId', requireAuth, (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const draft = (state.content_studio?.drafts || [])
      .find(d => d.draft_id === req.params.draftId);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });

    return res.status(200).json({ draft });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/studio/:slug/drafts/:draftId ─────────────────────────────────

router.patch('/:slug/drafts/:draftId', requireAuth, (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const { slug, draftId } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const draft = (state.content_studio?.drafts || [])
      .find(d => d.draft_id === draftId);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });

    const {
      body_html, body_text, status, cta_mode, cta_assignment,
      images, linkedin_posts, linkedin_personas
    } = req.body;

    if (body_html !== undefined) {
      draft.body_html  = body_html;
      draft.word_count = countWords(body_html);
      draft.reading_time_mins = Math.ceil(draft.word_count / 200);
    }
    if (body_text        !== undefined) draft.body_text        = body_text;
    if (status           !== undefined) draft.status           = status;
    if (cta_mode         !== undefined) draft.cta_mode         = cta_mode;
    if (cta_assignment   !== undefined) draft.cta_assignment   = cta_assignment;
    if (images           !== undefined) draft.images           = images;
    if (linkedin_posts   !== undefined) draft.linkedin_posts   = linkedin_posts;
    if (linkedin_personas !== undefined) draft.linkedin_personas = linkedin_personas;

    draft.updated_at = new Date().toISOString();

    saveState(slug, state);
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/studio/:slug/drafts/:draftId/approve ──────────────────────────

router.post('/:slug/drafts/:draftId/approve', requireAuth, (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const { slug, draftId } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const draft = (state.content_studio?.drafts || [])
      .find(d => d.draft_id === draftId);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });

    draft.status      = 'approved';
    draft.approved_at = new Date().toISOString();
    draft.updated_at  = draft.approved_at;

    saveState(slug, state);
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/studio/:slug/drafts/:draftId/plagiarism ───────────────────────

router.post('/:slug/drafts/:draftId/plagiarism', requireAuth, async (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const { slug, draftId } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const draft = (state.content_studio?.drafts || [])
      .find(d => d.draft_id === draftId);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (!draft.body_text) {
      return res.status(400).json({ error: 'No content to check' });
    }

    const threshold = state.content_studio?.settings?.plagiarism_threshold ?? 30;
    const r = await triggerWorkflow('Plagiarism_Check', slug, {
      draft_id:  draftId,
      body_text: draft.body_text,
      threshold
    });

    return res.status(200).json({ job_id: r.job_id });
  } catch (err) {
    console.error('[studio] plagiarism error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/studio/:slug/drafts/:draftId/crosslinks ───────────────────────

router.post('/:slug/drafts/:draftId/crosslinks', requireAuth, async (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const { slug, draftId } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const draft = (state.content_studio?.drafts || [])
      .find(d => d.draft_id === draftId);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (!draft.body_html) {
      return res.status(400).json({ error: 'Generate content first' });
    }

    const cluster = (state.pages.supporting_content || [])
      .find(c => c.cluster_id === draft.cluster_id);

    const r = await triggerWorkflow('CrossLink_Inserter', slug, {
      draft_id:    draftId,
      body_html:   draft.body_html,
      cross_links: cluster?.internal_links_out || []
    });

    return res.status(200).json({ job_id: r.job_id });
  } catch (err) {
    console.error('[studio] crosslinks error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/studio/:slug/drafts/:draftId/atomize ──────────────────────────

router.post('/:slug/drafts/:draftId/atomize', requireAuth, async (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const { slug, draftId } = req.params;
    const { personas } = req.body;

    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const draft = (state.content_studio?.drafts || [])
      .find(d => d.draft_id === draftId);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (!draft.body_html) {
      return res.status(400).json({ error: 'Generate content first' });
    }

    const ctaData = buildCtaData(draft.cta_assignment, state);

    const r = await triggerWorkflow('Atomizer', slug, {
      draft_id:       draftId,
      title:          draft.title,
      article_html:   draft.body_html,
      target_keyword: draft.target_keyword,
      cta_assignment: draft.cta_assignment,
      cta_data:       ctaData,
      personas:       personas || [],
      company_name:   state.config?.identity?.client_name || '',
      brand_voice:    state.voice_guide?.index?.persona_voices || {},
      voice_index:    state.voice_guide?.index || null
    });

    draft.linkedin_personas = personas || [];
    draft.updated_at = new Date().toISOString();

    saveState(slug, state);
    return res.status(200).json({ job_id: r.job_id });
  } catch (err) {
    console.error('[studio] atomize error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE LIBRARY
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/studio/:slug/images/upload ────────────────────────────────────

router.post('/:slug/images/upload', requireAuth, imageUpload.single('image'), (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    const { slug } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const imageId    = uuidv4();
    const savedName  = req.file.filename;
    const imageEntry = {
      image_id:      imageId,
      filename:      savedName,
      original_name: req.file.originalname,
      url:           `/assets/${slug}/images/${savedName}`,
      size:          req.file.size,
      tags:          [],
      uploaded_at:   new Date().toISOString()
    };

    if (!Array.isArray(state.content_studio.image_library)) {
      state.content_studio.image_library = [];
    }
    state.content_studio.image_library.push(imageEntry);

    saveState(slug, state);
    return res.status(201).json({
      image_id: imageId,
      url:      imageEntry.url,
      filename: savedName
    });
  } catch (err) {
    console.error('[studio] image upload error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/studio/:slug/images ────────────────────────────────────────────

router.get('/:slug/images', requireAuth, (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    return res.status(200).json({
      images: state.content_studio?.image_library || []
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/studio/:slug/images/:imageId ────────────────────────────────

router.delete('/:slug/images/:imageId', requireAuth, (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const { slug, imageId } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const lib = state.content_studio?.image_library || [];
    const img = lib.find(i => i.image_id === imageId);
    if (!img) return res.status(404).json({ error: 'Image not found' });

    const filePath = path.join(imagesDir(slug), img.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    state.content_studio.image_library = lib.filter(i => i.image_id !== imageId);
    saveState(slug, state);

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/studio/:slug/images/:imageId ─────────────────────────────────

router.patch('/:slug/images/:imageId', requireAuth, (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const { slug, imageId } = req.params;
    const { tags } = req.body;

    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const img = (state.content_studio?.image_library || [])
      .find(i => i.image_id === imageId);
    if (!img) return res.status(404).json({ error: 'Image not found' });

    img.tags = tags || [];
    saveState(slug, state);

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/studio/:slug/drafts/:draftId/export/html ──────────────────────

router.post('/:slug/drafts/:draftId/export/html', requireAuth, (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const { slug, draftId } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const draft = (state.content_studio?.drafts || [])
      .find(d => d.draft_id === draftId);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });

    const requireApproval = state.content_studio?.settings?.require_approval !== false;
    if (requireApproval && draft.status !== 'approved') {
      return res.status(400).json({ error: 'Draft must be approved before export' });
    }

    const brand   = state.config?.brand   || {};
    const id      = state.config?.identity || {};
    const domain  = id.primary_domain || 'example.com';
    const metaTitle = draft.brief?.meta_title       || draft.title;
    const metaDesc  = draft.brief?.meta_description || '';

    const crossLinks = (draft.cross_links || []).map(l =>
      `<li><a href="${l.destination || '#'}">${l.anchor_text || l.destination || ''}</a></li>`
    ).join('\n          ');

    const ctaData = buildCtaData(draft.cta_assignment, state);

    const htmlPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${metaTitle}</title>
  <meta name="description" content="${metaDesc}" />
  <meta property="og:title" content="${metaTitle}" />
  <meta property="og:description" content="${metaDesc}" />
  <meta property="og:type" content="article" />
  <link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(brand.primary_font || 'Inter')}:wght@400;600;700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: '${brand.primary_font || 'Inter'}', sans-serif;
      color: ${brand.text_color || '#1f2937'};
      background: ${brand.background_color || '#ffffff'};
      line-height: 1.7;
    }
    .container { max-width: 800px; margin: 0 auto; padding: 2rem 1.5rem; }
    h1 { font-size: 2rem; margin-bottom: 1rem; color: ${brand.primary_color || '#3b82f6'}; }
    h2 { font-size: 1.4rem; margin: 1.5rem 0 0.5rem; }
    p  { margin-bottom: 1rem; }
    a  { color: ${brand.primary_color || '#3b82f6'}; }
    .cta-block {
      margin: 2.5rem 0;
      padding: 1.5rem;
      background: ${brand.primary_color || '#3b82f6'};
      border-radius: 8px;
      text-align: center;
    }
    .cta-block a {
      display: inline-block;
      padding: 0.75rem 1.75rem;
      background: #fff;
      color: ${brand.primary_color || '#3b82f6'};
      font-weight: 700;
      border-radius: 5px;
      text-decoration: none;
    }
    .related-links { margin-top: 2rem; }
    .related-links ul { list-style: disc; padding-left: 1.25rem; }
  </style>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "${metaTitle.replace(/"/g, '\\"')}",
    "description": "${metaDesc.replace(/"/g, '\\"')}",
    "author": { "@type": "Organization", "name": "${(id.client_name || '').replace(/"/g, '\\"')}" },
    "publisher": {
      "@type": "Organization",
      "name": "${(id.client_name || '').replace(/"/g, '\\"')}",
      "url": "https://${domain}"
    }
  }
  </script>
</head>
<body>
  <div class="container">
    <h1>${draft.title}</h1>
    <div class="article-body">
      ${draft.body_html || ''}
    </div>
    <div class="cta-block">
      <a href="${ctaData.url || '#'}">${ctaData.text || brand.cta_button_text || 'Book a Demo'}</a>
    </div>
    ${crossLinks ? `<div class="related-links"><h2>Related Resources</h2><ul>\n          ${crossLinks}\n        </ul></div>` : ''}
  </div>
</body>
</html>`;

    const expDir  = exportsDir(slug);
    fs.mkdirSync(expDir, { recursive: true });
    const htmlPath = path.join(expDir, `content-${draftId}.html`);
    fs.writeFileSync(htmlPath, htmlPage, 'utf8');

    draft.exports        = draft.exports || {};
    draft.exports.html_path = htmlPath;
    draft.status         = 'published';
    draft.updated_at     = new Date().toISOString();
    saveState(slug, state);

    const filename = `content-${draftId}.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.sendFile(htmlPath);
  } catch (err) {
    console.error('[studio] export/html error:', err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message });
    }
  }
});

// ─── POST /api/studio/:slug/drafts/:draftId/export/googledoc ─────────────────

router.post('/:slug/drafts/:draftId/export/googledoc', requireAuth, async (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const { slug, draftId } = req.params;
    const { google_folder_id } = req.body;

    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const draft = (state.content_studio?.drafts || [])
      .find(d => d.draft_id === draftId);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });

    const requireApproval = state.content_studio?.settings?.require_approval !== false;
    if (requireApproval && draft.status !== 'approved') {
      return res.status(400).json({ error: 'Draft must be approved before export' });
    }

    const r = await triggerWorkflow('Google_Doc_Export', slug, {
      draft_id:         draftId,
      title:            draft.title,
      body_html:        draft.body_html,
      linkedin_posts:   draft.linkedin_posts || null,
      client_name:      state.config?.identity?.client_name || '',
      project_name:     state.project_name || '',
      target_keyword:   draft.target_keyword,
      meta_title:       draft.brief?.meta_title       || draft.title,
      meta_description: draft.brief?.meta_description || '',
      folder_id:        google_folder_id || null
    });

    return res.status(200).json({ job_id: r.job_id });
  } catch (err) {
    console.error('[studio] export/googledoc error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STUDIO SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/studio/:slug/settings ──────────────────────────────────────────

router.get('/:slug/settings', requireAuth, (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    return res.status(200).json({
      settings: state.content_studio?.settings || {}
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/studio/:slug/settings ────────────────────────────────────────

router.patch('/:slug/settings', requireAuth, (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const { slug } = req.params;
    const { require_approval, plagiarism_threshold, personas } = req.body;

    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    if (!state.content_studio) state.content_studio = {};
    if (!state.content_studio.settings) state.content_studio.settings = {};

    if (require_approval        !== undefined) state.content_studio.settings.require_approval        = require_approval;
    if (plagiarism_threshold    !== undefined) state.content_studio.settings.plagiarism_threshold    = plagiarism_threshold;
    if (personas                !== undefined) state.content_studio.settings.personas                = personas;

    saveState(slug, state);
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
