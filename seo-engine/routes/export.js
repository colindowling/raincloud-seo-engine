'use strict';

const router = require('express').Router();

const { getState }    = require('../utils/state');
const { requireAuth } = require('../middleware/session');
const {
  generateKeywordsCSV,
  generatePagesCSV,
  generateContentCSV,
  generateCalendarCSV,
  generateCrosslinksCSV,
  generateMetaCSV,
  generateCompetitorsCSV,
  generateG2CSV
} = require('../utils/csv');
const { createExportZip } = require('../utils/zip');

// ─── CSV type → generator map ─────────────────────────────────────────────────

const CSV_GENERATORS = {
  keywords:    generateKeywordsCSV,
  pages:       generatePagesCSV,
  content:     generateContentCSV,
  calendar:    generateCalendarCSV,
  crosslinks:  generateCrosslinksCSV,
  meta:        generateMetaCSV,
  competitors: generateCompetitorsCSV,
  g2:          generateG2CSV
};

// ─── GET /api/export/:slug/csv/:type  [requireAuth] ──────────────────────────

router.get('/:slug/csv/:type', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { slug, type } = req.params;

    if (!CSV_GENERATORS[type]) {
      return res.status(400).json({
        error: `Unknown CSV type "${type}". Valid types: ${Object.keys(CSV_GENERATORS).join(', ')}`
      });
    }

    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const csvString = CSV_GENERATORS[type](state);
    const date      = new Date().toISOString().split('T')[0];
    const filename  = `${type}_${slug}_${date}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');

    return res.status(200).send(csvString);
  } catch (err) {
    console.error('[export] csv error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/export/:slug/zip  [requireAuth] ────────────────────────────────

router.get('/:slug/zip', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { slug } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const date     = new Date().toISOString().split('T')[0];
    const filename = `seo-package_${slug}_${date}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');

    // createExportZip streams directly to res and calls res.end() when done
    createExportZip(state, res);
  } catch (err) {
    console.error('[export] zip error:', err.message);
    // Only send JSON error if headers haven't been sent yet
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message });
    }
  }
});

module.exports = router;
