'use strict';

const router  = require('express').Router();
const bcrypt  = require('bcryptjs');

const { getState }                                  = require('../utils/state');
const { signToken, verifyToken, setAuthCookie,
        clearAuthCookie }                           = require('../middleware/session');

// ─── POST /api/auth/login ─────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  try {
    const { slug, password } = req.body;

    if (!slug || !password) {
      return res.status(400).json({ error: 'slug and password are required' });
    }

    const state = getState(slug);
    if (!state) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!state.password_hash) {
      return res.status(500).json({ error: 'Project has no password configured' });
    }

    const valid = await bcrypt.compare(password, state.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    const token = signToken({ slug, project_name: state.project_name });
    setAuthCookie(res, token);

    return res.status(200).json({
      success:      true,
      project_name: state.project_name,
      slug,
      step_status:  state.step_status || {}
    });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
  try {
    clearAuthCookie(res);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[auth] logout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/auth/check ──────────────────────────────────────────────────────

router.get('/check', (req, res) => {
  try {
    const token = req.cookies?.seo_auth;
    if (!token) {
      return res.status(200).json({ authenticated: false });
    }

    const payload = verifyToken(token);
    if (!payload) {
      return res.status(200).json({ authenticated: false });
    }

    return res.status(200).json({
      authenticated: true,
      slug:          payload.slug,
      project_name:  payload.project_name
    });
  } catch (err) {
    console.error('[auth] check error:', err.message);
    return res.status(200).json({ authenticated: false });
  }
});

module.exports = router;
