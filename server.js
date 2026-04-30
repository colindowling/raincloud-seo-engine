'use strict';

require('dotenv').config();

const express     = require('express');
const cookieParser = require('cookie-parser');
const path        = require('path');
const fs          = require('fs');

const { ensureDataRoot, warmCache } = require('./utils/state');

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Serve static assets
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded project assets
const DATA_DIR = process.env.DATA_DIR || './data/projects';
app.use('/assets', express.static(path.resolve(DATA_DIR)));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/auth',        require('./routes/auth'));
app.use('/api/projects',   require('./routes/projects'));
app.use('/api/research',   require('./routes/research'));
app.use('/api/results',    require('./routes/results'));
app.use('/api/export',     require('./routes/export'));
app.use('/api/pages',      require('./routes/pages'));
app.use('/api/voice-guide', require('./routes/voice-guide'));
app.use('/api/studio',      require('./routes/studio'));

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({
  status: 'ok',
  version: '1.0.0',
  uptime: process.uptime()
}));

// ─── SPA fallback ─────────────────────────────────────────────────────────────
// Serve index.html for all non-API routes so the SPA router handles navigation

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Global error handler ────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error('[server error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

ensureDataRoot();

// Pre-warm in-memory cache from DB (non-blocking — server starts immediately)
warmCache().catch(e => console.error('[server] Cache warm error:', e.message));

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║   RAINCLOUD SEO Engine — v1.0.0              ║`);
  console.log(`║   http://localhost:${PORT}                      ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
  console.log(`  Data dir: ${path.resolve(DATA_DIR)}`);
  console.log(`  HyperAgent: ${process.env.HYPERAGENT_API_KEY ? '✓ configured' : '⚠ not configured (set HYPERAGENT_API_KEY)'}`);
  console.log();
});

module.exports = app;
