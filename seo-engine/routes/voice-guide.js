'use strict';

const router  = require('express').Router();
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');

const { getState, saveState, voiceGuideDir } = require('../utils/state');
const { triggerWorkflow, buildPayload }       = require('../utils/webhook');
const { requireAuth }                         = require('../middleware/session');

// ─── Multer storage — destination resolved per-request from slug ──────────────

const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const dir = voiceGuideDir(req.params.slug);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) {
    cb(null, file.originalname);
  }
});

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'application/octet-stream'
]);

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  }
});

// ─── Slug ownership check ─────────────────────────────────────────────────────

function checkSlug(req, res) {
  if (req.projectSlug !== req.params.slug) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

// ─── POST /api/voice-guide/:slug/upload ──────────────────────────────────────

router.post('/:slug/upload', requireAuth, upload.single('document'), async (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { slug } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const now = new Date().toISOString();
    const docEntry = {
      filename:    req.file.originalname,
      type:        req.body.type || 'instructions',
      size:        req.file.size,
      uploaded_at: now
    };

    if (!Array.isArray(state.voice_guide.documents)) {
      state.voice_guide.documents = [];
    }
    state.voice_guide.documents.push(docEntry);
    state.voice_guide.index_status = 'pending';

    const r = await triggerWorkflow('Voice_Guide_Index', slug, buildPayload('Voice_Guide_Index', state));
    state.voice_guide.index_job_id = r.job_id;
    state.voice_guide.index_status = 'indexing';

    saveState(slug, state);

    return res.status(201).json({
      filename:     docEntry.filename,
      type:         docEntry.type,
      size:         docEntry.size,
      index_job_id: r.job_id
    });
  } catch (err) {
    console.error('[voice-guide] upload error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/voice-guide/:slug ───────────────────────────────────────────────

router.get('/:slug', requireAuth, (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const vg = state.voice_guide || {};
    return res.status(200).json({
      documents:    vg.documents    || [],
      index_status: vg.index_status || 'empty',
      indexed_at:   vg.indexed_at   || null,
      index:        vg.index        || null
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/voice-guide/:slug/:filename ──────────────────────────────────

router.delete('/:slug/:filename', requireAuth, async (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const { slug, filename } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const filePath = path.join(voiceGuideDir(slug), filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    state.voice_guide.documents = (state.voice_guide.documents || [])
      .filter(d => d.filename !== filename);

    state.voice_guide.index_status = 'pending';

    const r = await triggerWorkflow('Voice_Guide_Index', slug, buildPayload('Voice_Guide_Index', state));
    state.voice_guide.index_job_id = r.job_id;
    state.voice_guide.index_status = 'indexing';

    saveState(slug, state);

    return res.status(200).json({ success: true, index_job_id: r.job_id });
  } catch (err) {
    console.error('[voice-guide] delete error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/voice-guide/:slug/reindex ─────────────────────────────────────

router.post('/:slug/reindex', requireAuth, async (req, res) => {
  try {
    if (!checkSlug(req, res)) return;

    const { slug } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const r = await triggerWorkflow('Voice_Guide_Index', slug, buildPayload('Voice_Guide_Index', state));
    state.voice_guide.index_job_id = r.job_id;
    state.voice_guide.index_status = 'indexing';

    saveState(slug, state);

    return res.status(200).json({ job_id: r.job_id });
  } catch (err) {
    console.error('[voice-guide] reindex error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
