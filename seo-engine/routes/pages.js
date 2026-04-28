'use strict';

const router = require('express').Router();

const { getState, saveState }           = require('../utils/state');
const { triggerWorkflow, buildPayload } = require('../utils/webhook');
const { requireAuth }                   = require('../middleware/session');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find a page by cluster_id across all page arrays.
 * Returns { page, arrayName, index } or null.
 */
function findPage(pages, clusterId) {
  const arrays = ['bofu_pages', 'comparison_pages', 'supporting_content', 'striking_distance'];
  for (const arrayName of arrays) {
    const arr = pages[arrayName] || [];
    const index = arr.findIndex(p => p.cluster_id === clusterId);
    if (index !== -1) {
      return { page: arr[index], arrayName, index };
    }
  }
  return null;
}

/**
 * Strip html content from a page object — we omit it from list responses
 * to keep payloads manageable.
 */
function stripHtml(page) {
  const { html, ...rest } = page;
  return rest;
}

// ─── GET /api/pages/:slug/list  [requireAuth] ────────────────────────────────

router.get('/:slug/list', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const pages = state.pages || {};
    return res.status(200).json({
      pages: {
        bofu_pages:       (pages.bofu_pages       || []).map(stripHtml),
        comparison_pages: (pages.comparison_pages || []).map(stripHtml),
        supporting_content: (pages.supporting_content || []).map(stripHtml),
        striking_distance:  (pages.striking_distance  || []).map(stripHtml)
      }
    });
  } catch (err) {
    console.error('[pages] list error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/pages/:slug/:cluster_id/html  [requireAuth] ────────────────────

router.get('/:slug/:cluster_id/html', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { slug, cluster_id } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const found = findPage(state.pages || {}, cluster_id);
    if (!found) {
      return res.status(404).json({ error: 'Page not found for that cluster_id' });
    }

    if (!found.page.html) {
      return res.status(404).json({ error: 'HTML not yet generated for this page' });
    }

    return res.status(200).json({ html: found.page.html });
  } catch (err) {
    console.error('[pages] get html error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/pages/:slug/:cluster_id/download  [requireAuth] ────────────────

router.get('/:slug/:cluster_id/download', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { slug, cluster_id } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const found = findPage(state.pages || {}, cluster_id);
    if (!found) {
      return res.status(404).json({ error: 'Page not found for that cluster_id' });
    }

    if (!found.page.html) {
      return res.status(404).json({ error: 'HTML not yet generated for this page' });
    }

    // Use recommended_slug or cluster_id as filename base
    const base = (found.page.recommended_slug || cluster_id)
      .replace(/^\//, '')           // strip leading slash
      .replace(/\//g, '-')          // replace path separators
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .slice(0, 100) || cluster_id;

    const filename = `${base}.html`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');

    return res.status(200).send(found.page.html);
  } catch (err) {
    console.error('[pages] download error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/pages/:slug/:cluster_id/generate  [requireAuth] ───────────────

router.post('/:slug/:cluster_id/generate', requireAuth, async (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { slug, cluster_id } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const found = findPage(state.pages || {}, cluster_id);
    if (!found) {
      return res.status(404).json({ error: 'Page not found for that cluster_id' });
    }

    const { page } = found;

    // Build Page_Generator payload
    // Gather cross-link candidates from all other pages
    const allPages = [
      ...(state.pages.bofu_pages       || []),
      ...(state.pages.comparison_pages  || []),
      ...(state.pages.supporting_content || [])
    ].filter(p => p.cluster_id !== cluster_id);

    const crossLinks = allPages
      .slice(0, 20)
      .map(p => ({
        title: p.page_title || p.recommended_slug,
        slug:  p.recommended_slug
      }));

    // Pull relevant G2 excerpts for this page's primary keyword
    const g2Competitors = state.research?.g2_intelligence?.competitors || {};
    const g2Excerpts    = [];
    for (const [domain, data] of Object.entries(g2Competitors)) {
      const phrases = (data.frustrations || data.frustration_phrases || []).slice(0, 3);
      if (phrases.length) g2Excerpts.push({ competitor: domain, phrases });
    }

    const payload = {
      cluster_id,
      page_brief:       page,
      brand_config:     state.config?.brand     || {},
      identity_config:  state.config?.identity  || {},
      contact_form:     state.config?.contact_form || {},
      lead_magnets:     state.config?.lead_magnets || [],
      meta: {
        title_tag:        page.title_tag        || page.page_title,
        meta_description: page.meta_description || '',
        og_title:         page.og_title         || page.page_title,
        canonical:        page.canonical        || page.recommended_slug
      },
      schema_type:  page.schema_type || 'WebPage',
      cross_links:  crossLinks,
      g2_excerpts:  g2Excerpts,
      synthesis_context: state.research?.synthesis ? {
        page_hierarchy:    state.research.synthesis.page_hierarchy,
        competitor_angles: state.research.synthesis.competitor_angles
      } : {}
    };

    const { job_id, sent } = await triggerWorkflow('Page_Generator', slug, payload);
    return res.status(200).json({ job_id, sent });
  } catch (err) {
    console.error('[pages] generate error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/pages/:slug/:cluster_id/brief  [requireAuth] ──────────────────

router.post('/:slug/:cluster_id/brief', requireAuth, async (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { slug, cluster_id } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    // Briefs are for supporting content pages
    const idx = (state.pages.supporting_content || [])
      .findIndex(p => p.cluster_id === cluster_id);

    if (idx === -1) {
      return res.status(404).json({
        error: 'Supporting content page not found for that cluster_id'
      });
    }

    const page = state.pages.supporting_content[idx];

    const payload = {
      cluster_id,
      page_brief:   page,
      identity:     state.config?.identity || {},
      brand_voice:  state.config?.brand?.brand_voice || 'Professional',
      keyword_universe: state.research?.keyword_universe || {},
      synthesis_context: state.research?.synthesis ? {
        ranked_opportunities: state.research.synthesis.ranked_opportunities,
        page_hierarchy:       state.research.synthesis.page_hierarchy
      } : {}
    };

    const { job_id, sent } = await triggerWorkflow('Content_Brief_Generator', slug, payload);
    return res.status(200).json({ job_id, sent });
  } catch (err) {
    console.error('[pages] brief error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/pages/:slug/:cluster_id/status  [requireAuth] ────────────────

const VALID_STATUSES = ['Not Started', 'In Progress', 'Published', 'Ranking'];

router.patch('/:slug/:cluster_id/status', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { slug, cluster_id } = req.params;
    const { status } = req.body;

    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `status must be one of: ${VALID_STATUSES.join(', ')}`
      });
    }

    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const found = findPage(state.pages || {}, cluster_id);
    if (!found) {
      return res.status(404).json({ error: 'Page not found for that cluster_id' });
    }

    state.pages[found.arrayName][found.index] = {
      ...found.page,
      status,
      status_updated_at: new Date().toISOString()
    };

    saveState(slug, state);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[pages] status update error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/pages/:slug/tree  [requireAuth] ────────────────────────────────

router.get('/:slug/tree', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const hierarchy = state.research?.synthesis?.page_hierarchy || {};
    return res.status(200).json({ hierarchy });
  } catch (err) {
    console.error('[pages] tree error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
