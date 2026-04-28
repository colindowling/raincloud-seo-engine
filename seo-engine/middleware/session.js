'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_production';

// ─── Token helpers ────────────────────────────────────────────────────────────

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function setAuthCookie(res, token) {
  res.cookie('seo_auth', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
    secure: process.env.NODE_ENV === 'production'
  });
}

function clearAuthCookie(res) {
  res.clearCookie('seo_auth');
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const token = req.cookies?.seo_auth;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Session expired — please log in again' });

  req.projectSlug = payload.slug;
  req.projectName = payload.project_name;
  next();
}

// Soft auth — attaches slug if token present, but doesn't block
function softAuth(req, res, next) {
  const token = req.cookies?.seo_auth;
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      req.projectSlug = payload.slug;
      req.projectName = payload.project_name;
    }
  }
  next();
}

module.exports = { signToken, verifyToken, setAuthCookie, clearAuthCookie, requireAuth, softAuth };
