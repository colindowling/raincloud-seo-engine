/* RAINCLOUD SEO Intelligence Engine — Frontend SPA
 * Vanilla JS, no framework dependencies. All CSS in style.css.
 */
'use strict';

// ─── App State ────────────────────────────────────────────────────────────────

const AppState = {
  authenticated: false,
  slug: null,
  projectName: null,
  currentStep: '00',
  project: null,
  pollingJobs: {},
  stateRefreshInterval: null
};

// ─── API Wrapper ──────────────────────────────────────────────────────────────

async function api(method, path, body) {
  try {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch('/api' + path, opts);
    if (res.status === 401) { handleLogout(); return null; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    if (e.message !== 'Unauthorized') console.error('[api]', method, path, e.message);
    throw e;
  }
}

// ─── Toast Notifications ──────────────────────────────────────────────────────

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<span class="toast-icon">${{ info:'ℹ', success:'✓', error:'✗', warning:'⚠' }[type] || 'ℹ'}</span><span>${msg}</span>`;
  container.appendChild(t);
  setTimeout(() => t.classList.add('toast-show'), 10);
  setTimeout(() => { t.classList.remove('toast-show'); setTimeout(() => t.remove(), 300); }, 3500);
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function showModal(title, bodyHTML, actions = []) {
  const overlay = document.getElementById('modal-overlay');
  const box = document.getElementById('modal-box');
  if (!overlay || !box) return;
  const btns = actions.map(a =>
    `<button class="btn ${a.cls || 'btn-secondary'}" onclick="(${a.onClick.toString()})(this)">${a.label}</button>`
  ).join('');
  box.innerHTML = `
    <div class="modal-header">
      <h3 class="modal-title">${title}</h3>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">${bodyHTML}</div>
    ${btns ? `<div class="modal-footer">${btns}</div>` : ''}
  `;
  overlay.classList.remove('hidden');
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.classList.add('hidden');
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ─── Polling ──────────────────────────────────────────────────────────────────

function startPolling(jobId, slug, onTick, onDone) {
  if (AppState.pollingJobs[jobId]) return;
  const iv = setInterval(async () => {
    try {
      const data = await api('GET', `/research/${slug}/status/${jobId}`);
      if (!data) return;
      onTick(data);
      if (['complete', 'failed', 'timeout', 'partial'].includes(data.status)) {
        clearInterval(iv);
        delete AppState.pollingJobs[jobId];
        // Refresh project state after completion
        const fresh = await api('GET', `/projects/${slug}/state`);
        if (fresh && fresh.state) { AppState.project = fresh.state; }
        onDone(data);
      }
    } catch (e) { /* swallow network errors during polling */ }
  }, 8000);
  AppState.pollingJobs[jobId] = iv;
}

function stopPolling(jobId) {
  if (AppState.pollingJobs[jobId]) {
    clearInterval(AppState.pollingJobs[jobId]);
    delete AppState.pollingJobs[jobId];
  }
}

// ─── Utility Helpers ──────────────────────────────────────────────────────────

function formatNum(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString();
}

function formatCPC(n) {
  if (n == null || isNaN(n)) return '—';
  return `$${Number(n).toFixed(2)}`;
}

function pct(n) {
  if (n == null || isNaN(n)) return '—';
  return `${(Number(n) * 100).toFixed(1)}%`;
}

function timeSince(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function truncate(str, n = 60) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function scoreBadge(score) {
  const n = Number(score) || 0;
  const cls = n >= 75 ? 'badge-green' : n >= 55 ? 'badge-blue' : n >= 40 ? 'badge-amber' : 'badge-muted';
  return `<span class="badge ${cls}">${n}</span>`;
}

function typeBadge(type) {
  const types = { A: ['badge-blue', 'BOFU'], B: ['badge-purple', 'CONTENT'], C: ['badge-green', 'COMPARE'], D: ['badge-amber', 'QUICK WIN'] };
  const typeStr = Array.isArray(type) ? type[0] : String(type || '');
  const [cls, label] = types[typeStr] || ['badge-muted', typeStr || '?'];
  return `<span class="badge ${cls}">${label}</span>`;
}

function statusBadge(status) {
  const map = {
    'Not Started': 'badge-muted', 'In Progress': 'badge-blue',
    'Published': 'badge-green', 'Ranking': 'badge-amber',
    'queued': 'badge-muted', 'running': 'badge-amber',
    'complete': 'badge-green', 'failed': 'badge-red', 'timeout': 'badge-red'
  };
  return `<span class="badge ${map[status] || 'badge-muted'}">${esc(status)}</span>`;
}

function timelineBadge(str) {
  if (!str) return '';
  const cls = str.includes('< 60') ? 'badge-green' : str.includes('60') ? 'badge-blue' : str.includes('4–6') ? 'badge-amber' : 'badge-muted';
  return `<span class="badge ${cls}">${esc(str)}</span>`;
}

function deltaArrow(delta) {
  if (!delta && delta !== 0) return '';
  return delta > 0 ? `<span class="delta-up">↑ ${formatNum(Math.abs(delta))}</span>` : delta < 0 ? `<span class="delta-down">↓ ${formatNum(Math.abs(delta))}</span>` : `<span class="delta-neutral">—</span>`;
}

// ─── Step Definitions ─────────────────────────────────────────────────────────

const STEPS = [
  { id: '00', name: 'Project Setup' },
  { id: '01', name: 'Brand & Identity' },
  { id: '02', name: 'Analytics Connection' },
  { id: '03', name: 'Competitor Discovery' },
  { id: '04', name: 'Research Pipeline' },
  { id: '05', name: 'Keyword Intelligence' },
  { id: '06', name: 'BoFu Page Plan' },
  { id: '07', name: 'Content & Calendar' },
  { id: '08', name: 'Reporting' },
  { id: '09', name: 'Technical SEO' }
];

// ─── Sidebar Navigation ───────────────────────────────────────────────────────

function renderStepNav() {
  const status = AppState.project?.step_status || {};
  return STEPS.map(s => {
    const st = s.id === '00' ? 'complete' : (status[s.id] || 'locked');
    const isActive = AppState.currentStep === s.id;
    const isLocked = st === 'locked';
    return `
      <div class="step-item ${isActive ? 'active' : ''} ${isLocked ? 'locked' : ''}"
           onclick="navigateStep('${s.id}')">
        <div class="step-dot status-${isActive ? 'active' : st}"></div>
        <div class="step-info">
          <div class="step-number">${s.id}</div>
          <div class="step-name">${s.name}</div>
        </div>
      </div>`;
  }).join('');
}

function navigateStep(id) {
  // Step 00 is always accessible — it's the project setup confirmation
  if (id === '00') { window.location.hash = '#step-00'; return; }
  const status = AppState.project?.step_status || {};
  const st = status[id] || 'locked';
  if (st === 'locked') {
    showToast('Complete earlier steps to unlock this one.', 'warning');
    return;
  }
  window.location.hash = `#step-${id}`;
}

// ─── Layout Wrapper ───────────────────────────────────────────────────────────

function renderLayout(content) {
  const domain = AppState.project?.config?.identity?.primary_domain || '';
  return `
    <div class="app-layout">
      <aside class="sidebar">
        <div class="sidebar-logo">
          <div class="logo-mark">RC</div>
          <div>
            <div class="logo-title">RAINCLOUD</div>
            <div class="logo-subtitle">SEO Engine</div>
          </div>
        </div>
        <div class="sidebar-project">
          <div class="sidebar-project-name">${esc(AppState.projectName || '')}</div>
          <div class="sidebar-project-domain">${esc(domain)}</div>
        </div>
        <nav class="sidebar-steps">${renderStepNav()}</nav>
        <div class="sidebar-footer">
          <button class="btn btn-ghost btn-sm" onclick="handleLogout()">← Logout</button>
        </div>
      </aside>
      <main class="main-content">
        <div class="main-inner">${content}</div>
      </main>
    </div>`;
}

// ─── Step Header ─────────────────────────────────────────────────────────────

function stepHeader(num, title, subtitle = '') {
  return `
    <div class="step-header">
      <div class="step-header-num">${num}</div>
      <div>
        <h1 class="step-header-title">${title}</h1>
        ${subtitle ? `<p class="step-header-subtitle">${subtitle}</p>` : ''}
      </div>
    </div>`;
}

// ─── Stat Cards ───────────────────────────────────────────────────────────────

function statCard(label, value, sub = '') {
  return `
    <div class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
      ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 00 — LANDING / PROJECT SELECTOR
// ═══════════════════════════════════════════════════════════════════════════════

async function renderStep00() {
  let projects = [];
  try { const d = await api('GET', '/projects'); projects = d?.projects || []; } catch (e) {}

  const projectCards = projects.length ? projects.map(p => {
    const steps = Object.values(p.step_status || {});
    const dots = Object.entries(p.step_status || {}).map(([k, v]) =>
      `<div class="progress-dot ${v === 'complete' ? 'dot-complete' : v === 'locked' ? 'dot-locked' : 'dot-partial'}" title="Step ${k}: ${v}"></div>`
    ).join('');
    return `
      <div class="project-card" onclick="openProjectPrompt('${esc(p.slug)}', '${esc(p.project_name)}')">
        <div class="project-card-name">${esc(p.project_name)}</div>
        <div class="project-card-domain">${esc(p.primary_domain || '')}</div>
        <div class="project-card-meta">Updated ${timeSince(p.updated_at)}</div>
        <div class="project-progress-dots">${dots}</div>
      </div>`;
  }).join('') : `<div class="empty-state"><div class="empty-icon">📂</div><p>No projects yet — create one to get started.</p></div>`;

  document.getElementById('app').innerHTML = `
    <div class="landing-layout">
      <div class="landing-brand">
        <div class="landing-logo-mark">RC</div>
        <h1 class="landing-title">RAINCLOUD SEO Engine</h1>
        <p class="landing-tagline">Data-driven BoFu content strategy — from research to publish-ready HTML</p>
      </div>
      <div class="landing-panels">
        <div class="landing-panel">
          <h2 class="panel-title">Create New Project</h2>
          <form id="create-form" onsubmit="handleCreateProject(event)">
            <div class="form-group">
              <label class="form-label">Project Name</label>
              <input class="form-input" id="new-name" placeholder="Healthicity Q2 2026" required>
            </div>
            <div class="form-group">
              <label class="form-label">Client Domain</label>
              <input class="form-input" id="new-domain" placeholder="healthicity.com">
            </div>
            <div class="form-group">
              <label class="form-label">Password</label>
              <input class="form-input" id="new-password" type="password" placeholder="min 6 characters" required minlength="6">
            </div>
            <button class="btn btn-primary btn-block" type="submit">Create Project →</button>
          </form>
        </div>
        <div class="landing-panel">
          <h2 class="panel-title">Open Existing Project</h2>
          <div class="project-card-list">${projectCards}</div>
        </div>
      </div>
    </div>`;
}

async function handleCreateProject(e) {
  e.preventDefault();
  const name = document.getElementById('new-name').value.trim();
  const domain = document.getElementById('new-domain').value.trim();
  const password = document.getElementById('new-password').value;
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const d = await api('POST', '/projects/create', { project_name: name, primary_domain: domain, password });
    if (!d) return;
    AppState.slug = d.slug;
    AppState.projectName = d.project_name;
    AppState.authenticated = true;
    await refreshProjectState();
    window.location.hash = '#step-01';
  } catch (e) { showToast(e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Create Project →'; }
}

function openProjectPrompt(slug, name) {
  showModal(`Open: ${name}`,
    `<div class="form-group"><label class="form-label">Password</label>
     <input class="form-input" id="login-pw" type="password" autofocus placeholder="Enter project password"></div>`,
    [
      { label: 'Cancel', cls: 'btn-secondary', onClick: () => closeModal() },
      { label: 'Open Project →', cls: 'btn-primary', onClick: async () => {
        const pw = document.getElementById('login-pw')?.value;
        try {
          const d = await api('POST', '/auth/login', { slug, password: pw });
          if (!d) return;
          AppState.slug = d.slug;
          AppState.projectName = d.project_name;
          AppState.authenticated = true;
          closeModal();
          await refreshProjectState();
          // Navigate to furthest complete step
          const status = AppState.project?.step_status || {};
          const last = Object.entries(status).filter(([,v]) => v === 'complete').map(([k]) => k).sort().pop() || '01';
          window.location.hash = `#step-${last}`;
        } catch (err) { showToast(err.message, 'error'); }
      }}
    ]
  );
  setTimeout(() => document.getElementById('login-pw')?.focus(), 100);
}

async function handleLogout() {
  await api('POST', '/auth/logout');
  AppState.authenticated = false;
  AppState.slug = null;
  AppState.projectName = null;
  AppState.project = null;
  Object.keys(AppState.pollingJobs).forEach(stopPolling);
  if (AppState.stateRefreshInterval) { clearInterval(AppState.stateRefreshInterval); AppState.stateRefreshInterval = null; }
  window.location.hash = '';
  renderCurrentStep();
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 01 — BRAND & IDENTITY
// ═══════════════════════════════════════════════════════════════════════════════

function renderStep01() {
  const cfg = AppState.project?.config || {};
  const id = cfg.identity || {};
  const br = cfg.brand || {};
  const lm = cfg.lead_magnets || [];
  const cf = cfg.contact_form || {};

  const html = `
    ${stepHeader('01', 'Brand & Identity', 'Configure client details, brand style, lead magnets, and contact form.')}
    <div class="tab-bar" id="tab-bar-01">
      <button class="tab-btn active" onclick="switchTab('01','identity',this)">Identity</button>
      <button class="tab-btn" onclick="switchTab('01','brand',this)">Brand Style</button>
      <button class="tab-btn" onclick="switchTab('01','magnets',this)">Lead Magnets</button>
      <button class="tab-btn" onclick="switchTab('01','contact',this)">Contact Form</button>
    </div>

    <div id="tab-identity" class="tab-pane active">
      <div class="card">
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Client Name</label>
            <input class="form-input" id="id-client-name" value="${esc(id.client_name||'')}">
          </div>
          <div class="form-group">
            <label class="form-label">Primary Domain</label>
            <input class="form-input" id="id-domain" value="${esc(id.primary_domain||'')}">
          </div>
          <div class="form-group">
            <label class="form-label">Industry / Vertical</label>
            <input class="form-input" id="id-industry" value="${esc(id.industry||'')}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Offer Description <span class="form-hint">2–4 sentences — what you sell and to whom</span></label>
          <textarea class="form-textarea" id="id-offer" rows="3">${esc(id.offer_description||'')}</textarea>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Primary Products / Services</label>
            <input class="form-input" id="id-products" value="${esc((id.primary_products||[]).join(', '))}">
            <div class="form-hint">Comma-separated</div>
          </div>
          <div class="form-group">
            <label class="form-label">Target Personas</label>
            <input class="form-input" id="id-personas" value="${esc((id.target_personas||[]).join(', '))}">
            <div class="form-hint">Comma-separated</div>
          </div>
          <div class="form-group">
            <label class="form-label">ICP Industries</label>
            <input class="form-input" id="id-icp-industries" value="${esc((id.icp_industries||[]).join(', '))}">
          </div>
          <div class="form-group">
            <label class="form-label">ICP Company Size</label>
            <div class="checkbox-group">
              ${['SMB','Mid-Market','Enterprise'].map(s => `
                <label class="checkbox-label">
                  <input type="checkbox" value="${s}" ${(id.icp_company_size||[]).includes(s) ? 'checked' : ''}> ${s}
                </label>`).join('')}
            </div>
          </div>
        </div>
        <button class="btn btn-primary" onclick="saveIdentity()">Save Identity</button>
      </div>
    </div>

    <div id="tab-brand" class="tab-pane hidden">
      <div class="card">
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Primary Font</label>
            <input class="form-input" id="br-font-primary" value="${esc(br.primary_font||'Inter')}">
          </div>
          <div class="form-group">
            <label class="form-label">Body Font</label>
            <input class="form-input" id="br-font-body" value="${esc(br.secondary_font||'Inter')}">
          </div>
        </div>
        <div class="form-grid-3">
          ${[['Primary Color','br-color-primary',br.primary_color||'#3b82f6'],
             ['Secondary Color','br-color-secondary',br.secondary_color||'#1e40af'],
             ['Accent Color','br-color-accent',br.accent_color||'#10b981'],
             ['Background Color','br-color-bg',br.background_color||'#ffffff'],
             ['Text Color','br-color-text',br.text_color||'#1f2937'],
            ].map(([lbl,id,val]) => `
            <div class="form-group">
              <label class="form-label">${lbl}</label>
              <div class="color-input-row">
                <input type="color" class="color-swatch" id="${id}-picker" value="${val}" oninput="document.getElementById('${id}').value=this.value">
                <input class="form-input form-input-mono" id="${id}" value="${esc(val)}" oninput="document.getElementById('${id}-picker').value=this.value">
              </div>
            </div>`).join('')}
        </div>
        <div class="brand-preview" id="brand-preview-bar">
          <div class="brand-preview-swatch" style="background:${br.primary_color||'#3b82f6'}"></div>
          <div class="brand-preview-swatch" style="background:${br.secondary_color||'#1e40af'}"></div>
          <div class="brand-preview-swatch" style="background:${br.accent_color||'#10b981'}"></div>
          <div class="brand-preview-swatch" style="background:${br.background_color||'#ffffff'}"></div>
          <div class="brand-preview-swatch" style="background:${br.text_color||'#1f2937'}"></div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Logo URL</label>
            <input class="form-input" id="br-logo" value="${esc(br.logo_url||'')}">
          </div>
          <div class="form-group">
            <label class="form-label">Brand Voice</label>
            <select class="form-select" id="br-voice">
              ${['Professional','Authoritative','Conversational','Technical','Challenger'].map(v =>
                `<option ${(br.brand_voice||'Professional')===v?'selected':''}>${v}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">CTA Button Text</label>
            <input class="form-input" id="br-cta-text" value="${esc(br.cta_button_text||'Book a Demo')}">
          </div>
          <div class="form-group">
            <label class="form-label">CTA Button URL</label>
            <input class="form-input" id="br-cta-url" value="${esc(br.cta_button_url||'')}">
          </div>
        </div>
        <button class="btn btn-primary" onclick="saveBrand()">Save Brand Style</button>
      </div>
    </div>

    <div id="tab-magnets" class="tab-pane hidden">
      <div class="card">
        <div id="lead-magnets-list">${renderLeadMagnetsList(lm)}</div>
        <button class="btn btn-secondary" onclick="addLeadMagnet()" id="add-magnet-btn" ${lm.length >= 3 ? 'disabled' : ''}>+ Add Lead Magnet</button>
      </div>
    </div>

    <div id="tab-contact" class="tab-pane hidden">
      <div class="card">
        <div class="form-group">
          <label class="form-label">Form Headline</label>
          <input class="form-input" id="cf-headline" value="${esc(cf.form_headline||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Form Fields</label>
          <div class="checkbox-group">
            ${['name','company','email','phone','message','source'].map(f => `
              <label class="checkbox-label">
                <input type="checkbox" id="cf-field-${f}" ${(cf.fields||['name','company','email']).includes(f)?'checked':''}> ${f.charAt(0).toUpperCase()+f.slice(1)}
              </label>`).join('')}
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Submission Endpoint</label>
            <input class="form-input" id="cf-endpoint" placeholder="https://formspree.io/f/..." value="${esc(cf.submission_endpoint||'')}">
          </div>
          <div class="form-group">
            <label class="form-label">Notification Email</label>
            <input class="form-input" id="cf-notify" type="email" value="${esc(cf.notification_email||'')}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Confirmation Message</label>
          <input class="form-input" id="cf-confirm" value="${esc(cf.confirmation_message||"Thank you — we'll be in touch.")}">
        </div>
        <button class="btn btn-primary" onclick="saveContactForm()">Save Contact Form</button>
      </div>
    </div>`;

  return renderLayout(html);
}

function switchTab(step, tab, btn) {
  const bar = document.getElementById(`tab-bar-${step}`);
  if (bar) bar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  // Hide all panes in this step
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
  const pane = document.getElementById(`tab-${tab}`);
  if (pane) pane.classList.remove('hidden');
}

function renderLeadMagnetsList(lm) {
  if (!lm.length) return '<div class="empty-state-sm">No lead magnets configured. Add up to 3.</div>';
  return lm.map((m, i) => `
    <div class="lead-magnet-row" id="magnet-${i}">
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Title</label>
          <input class="form-input" id="lm-title-${i}" value="${esc(m.title||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Apply To</label>
          <select class="form-select" id="lm-apply-${i}">
            ${['All BoFu pages','Specific pages','None'].map(v => `<option ${m.apply_to===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Description</label>
          <input class="form-input" id="lm-desc-${i}" value="${esc(m.description||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">File URL</label>
          <input class="form-input" id="lm-url-${i}" value="${esc(m.file_url||'')}">
        </div>
      </div>
      <button class="btn btn-ghost btn-sm btn-danger" onclick="removeLeadMagnet(${i})">Remove</button>
    </div>`).join('<hr class="divider">');
}

function addLeadMagnet() {
  const lm = AppState.project?.config?.lead_magnets || [];
  if (lm.length >= 3) return;
  lm.push({ title:'', description:'', file_url:'', apply_to:'All BoFu pages' });
  AppState.project.config.lead_magnets = lm;
  document.getElementById('lead-magnets-list').innerHTML = renderLeadMagnetsList(lm);
  document.getElementById('add-magnet-btn').disabled = lm.length >= 3;
}

function removeLeadMagnet(i) {
  const lm = AppState.project?.config?.lead_magnets || [];
  lm.splice(i, 1);
  AppState.project.config.lead_magnets = lm;
  document.getElementById('lead-magnets-list').innerHTML = renderLeadMagnetsList(lm);
  document.getElementById('add-magnet-btn').disabled = false;
}

async function saveIdentity() {
  const data = {
    client_name: document.getElementById('id-client-name').value.trim(),
    primary_domain: document.getElementById('id-domain').value.trim(),
    industry: document.getElementById('id-industry').value.trim(),
    offer_description: document.getElementById('id-offer').value.trim(),
    primary_products: document.getElementById('id-products').value.split(',').map(s=>s.trim()).filter(Boolean),
    target_personas: document.getElementById('id-personas').value.split(',').map(s=>s.trim()).filter(Boolean),
    icp_industries: document.getElementById('id-icp-industries').value.split(',').map(s=>s.trim()).filter(Boolean),
    icp_company_size: [...document.querySelectorAll('#tab-identity input[type=checkbox]:checked')].map(c=>c.value)
  };
  try {
    const r = await api('PATCH', `/projects/${AppState.slug}/config`, { section:'identity', data });
    if (r) { AppState.project.config.identity = data; AppState.project.step_status = r.step_status || AppState.project.step_status; showToast('Identity saved', 'success'); renderSidebar(); }
  } catch(e) { showToast(e.message, 'error'); }
}

async function saveBrand() {
  const data = {
    primary_font: document.getElementById('br-font-primary').value.trim(),
    secondary_font: document.getElementById('br-font-body').value.trim(),
    primary_color: document.getElementById('br-color-primary').value.trim(),
    secondary_color: document.getElementById('br-color-secondary').value.trim(),
    accent_color: document.getElementById('br-color-accent').value.trim(),
    background_color: document.getElementById('br-color-bg').value.trim(),
    text_color: document.getElementById('br-color-text').value.trim(),
    logo_url: document.getElementById('br-logo').value.trim(),
    brand_voice: document.getElementById('br-voice').value,
    cta_button_text: document.getElementById('br-cta-text').value.trim(),
    cta_button_url: document.getElementById('br-cta-url').value.trim()
  };
  try {
    await api('PATCH', `/projects/${AppState.slug}/config`, { section:'brand', data });
    AppState.project.config.brand = data; showToast('Brand style saved', 'success');
  } catch(e) { showToast(e.message, 'error'); }
}

async function saveContactForm() {
  const fields = ['name','company','email','phone','message','source'].filter(f => document.getElementById(`cf-field-${f}`)?.checked);
  const data = {
    form_headline: document.getElementById('cf-headline').value.trim(),
    fields,
    submission_endpoint: document.getElementById('cf-endpoint').value.trim(),
    notification_email: document.getElementById('cf-notify').value.trim(),
    confirmation_message: document.getElementById('cf-confirm').value.trim()
  };
  try {
    await api('PATCH', `/projects/${AppState.slug}/config`, { section:'contact_form', data });
    AppState.project.config.contact_form = data; showToast('Contact form saved', 'success');
  } catch(e) { showToast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 02 — ANALYTICS CONNECTION
// ═══════════════════════════════════════════════════════════════════════════════

function renderStep02() {
  const an = AppState.project?.analytics || {};
  const baseline = AppState.project?.baseline;
  const stepStatus = AppState.project?.step_status?.['02'];

  const baselineHTML = baseline ? `
    <div class="card mt-4">
      <div class="card-header"><h3 class="card-title">Baseline Results</h3><span class="badge badge-green">COMPLETE</span></div>
      <div class="stat-grid">
        ${statCard('Organic Sessions (90-day)', formatNum(baseline.summary?.total_organic_sessions))}
        ${statCard('Striking Distance Keywords', formatNum(baseline.summary?.striking_distance_count), 'Position 4–20')}
        ${statCard('Total Keyword Universe', formatNum(baseline.summary?.total_queries_with_impressions))}
        ${statCard('Page 1 Keywords', formatNum(baseline.summary?.p1_keyword_count))}
      </div>
      ${baseline.summary?.quick_win_keyword ? `
        <div class="win-box mt-3">
          ⚡ Quick Win: <strong>${esc(baseline.summary.quick_win_keyword.keys?.[0] || '')}</strong>
          — Position ${baseline.summary.quick_win_keyword.position?.toFixed(1)}, ${formatNum(baseline.summary.quick_win_keyword.impressions)} impressions
        </div>` : ''}
      ${(baseline.ga4_top_pages||[]).length ? `
        <h4 class="section-subtitle mt-3">Top Landing Pages (Organic)</h4>
        <table class="data-table">
          <thead><tr><th>Page</th><th>Sessions</th></tr></thead>
          <tbody>${(baseline.ga4_top_pages||[]).slice(0,10).map(p => `
            <tr><td class="mono">${esc(p.pagePath||p.page||'')}</td><td>${formatNum(p.sessions)}</td></tr>`).join('')}
          </tbody>
        </table>` : ''}
    </div>` : '';

  const html = `
    ${stepHeader('02', 'Analytics Connection', 'Connect GA4 and Search Console to establish your pre-campaign baseline.')}
    <div class="card">
      <div class="card-header"><h3 class="card-title">Google Analytics 4</h3></div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">GA4 Property ID</label>
          <input class="form-input mono" id="an-ga4-id" placeholder="G-XXXXXXXXXX" value="${esc(an.ga4_property_id||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Date Range</label>
          <select class="form-select" id="an-range">
            ${[30,60,90].map(d=>`<option value="${d}" ${an.date_range_days==d?'selected':''}>${d} days</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Service Account JSON</label>
        <textarea class="form-textarea mono" id="an-sa-json" rows="5" placeholder='Paste your Google service account JSON here...'>${esc(an.service_account_json ? JSON.stringify(an.service_account_json) : '')}</textarea>
        <div class="form-hint-row">
          <span class="form-hint">Service account needs GA4 Viewer + GSC Full User + Indexing API roles</span>
          <label class="btn btn-ghost btn-sm">Upload JSON <input type="file" accept=".json" style="display:none" onchange="handleSAJsonUpload(event)"></label>
        </div>
      </div>
    </div>
    <div class="card mt-3">
      <div class="card-header"><h3 class="card-title">Google Search Console</h3></div>
      <div class="form-group">
        <label class="form-label">Property URL</label>
        <input class="form-input" id="an-gsc-url" placeholder="https://healthicity.com" value="${esc(an.gsc_property_url||'')}">
        <div class="form-hint">Must match your verified GSC property exactly (including https://)</div>
      </div>
    </div>
    <div class="mt-4" id="baseline-controls">
      <button class="btn btn-primary btn-lg" id="run-baseline-btn" onclick="runBaseline()">
        ${stepStatus === 'complete' ? '↻ Re-run Analytics Baseline' : 'Run Analytics Baseline →'}
      </button>
      <span class="form-hint ml-2">~3–5 minutes</span>
    </div>
    <div id="baseline-progress" class="hidden mt-3"></div>
    ${baselineHTML}`;

  return renderLayout(html);
}

function handleSAJsonUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { document.getElementById('an-sa-json').value = ev.target.result; };
  reader.readAsText(file);
}

async function runBaseline() {
  const ga4Id = document.getElementById('an-ga4-id')?.value.trim();
  const gscUrl = document.getElementById('an-gsc-url')?.value.trim();
  const saJsonStr = document.getElementById('an-sa-json')?.value.trim();
  const range = parseInt(document.getElementById('an-range')?.value || '90');

  if (!ga4Id || !gscUrl) { showToast('GA4 Property ID and GSC URL are required', 'error'); return; }

  let saJson = null;
  if (saJsonStr) {
    try { saJson = JSON.parse(saJsonStr); } catch { showToast('Invalid JSON in Service Account field', 'error'); return; }
  }

  try {
    await api('PATCH', `/projects/${AppState.slug}/analytics`, {
      ga4_property_id: ga4Id, gsc_property_url: gscUrl,
      service_account_json: saJson, date_range_days: range
    });
  } catch(e) { showToast('Failed to save analytics config: ' + e.message, 'error'); return; }

  const btn = document.getElementById('run-baseline-btn');
  const progress = document.getElementById('baseline-progress');
  btn.disabled = true; btn.textContent = 'Running…';
  progress.classList.remove('hidden');
  progress.innerHTML = `<div class="progress-row"><div class="spinner"></div><span>Pulling analytics data…</span></div>`;

  try {
    const r = await api('POST', `/research/${AppState.slug}/trigger`, { workflow_id: 'GA_GSC_Baseline' });
    if (!r?.job_id) { showToast('Failed to start workflow', 'error'); return; }
    startPolling(r.job_id, AppState.slug,
      data => {
        const logs = data.progress_log || [];
        if (logs.length) progress.innerHTML = `<div class="progress-row"><div class="spinner"></div><span>${esc(logs[logs.length-1]?.message||'Running…')}</span></div>`;
      },
      data => {
        btn.disabled = false; btn.textContent = '↻ Re-run Analytics Baseline';
        if (data.status === 'complete') { showToast('Baseline complete!', 'success'); renderCurrentStep(); }
        else showToast('Baseline had issues — check logs', 'warning');
      }
    );
  } catch(e) { showToast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Run Analytics Baseline →'; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 03 — COMPETITOR DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════════

function renderStep03() {
  const comp = AppState.project?.competitors || {};
  const candidates = comp.candidates || [];
  const confirmed = comp.confirmed || [];
  const g2slugs = comp.g2_slugs || {};
  const profiles = comp.profiles || [];

  const candidateCards = candidates.length ? candidates.map((c, i) => {
    const domain = c.domain || '';
    const isIncluded = confirmed.some(x => x.domain === domain) || (!confirmed.length && i < 8);
    const profile = profiles.find(p => p.domain === domain);
    return `
      <div class="competitor-card ${isIncluded ? 'included' : 'excluded'}" id="comp-card-${i}">
        <div class="comp-card-header">
          <div class="comp-domain">${esc(domain)}</div>
          <button class="btn btn-sm ${isIncluded ? 'btn-green' : 'btn-ghost'}" onclick="toggleCompetitor(${i}, '${esc(domain)}')">
            ${isIncluded ? '✓ Include' : '✗ Exclude'}
          </button>
        </div>
        <div class="comp-metrics">
          <span>Overlap: <strong>${formatNum(c.overlap_count||c.intersections||0)} kw</strong></span>
          <span>Traffic: <strong>~${formatNum(c.estimated_monthly_traffic||0)}/mo</strong></span>
          <span>DA: <strong>${c.domain_rank||'—'}</strong></span>
        </div>
        ${profile ? `<div class="comp-profile-chip">${esc(profile.clay_enrichment?.funding_status||'')} · ${esc(profile.clay_enrichment?.employee_count||'')} employees</div>` : ''}
        <div class="form-group mt-2">
          <label class="form-label">G2 Slug</label>
          <input class="form-input form-input-sm mono" id="g2-${i}" value="${esc(g2slugs[domain]||c.g2_slug_suggested||'')}" placeholder="e.g. medtrainer">
        </div>
      </div>`;
  }).join('') : `<div class="empty-state-sm">Click "Discover Competitors" to find your real competitive set.</div>`;

  const html = `
    ${stepHeader('03', 'Competitor Discovery', 'Identify who you actually compete with in search — then enrich them.')}
    <div class="action-row">
      <button class="btn btn-primary" onclick="discoverCompetitors()" id="discover-btn">
        ${candidates.length ? '↻ Re-discover' : 'Discover Competitors →'}
      </button>
      <span class="form-hint">~5–8 min · Uses Exa + DataForSEO keyword intersection</span>
    </div>
    <div id="discover-progress" class="hidden mt-3"></div>

    <div class="mt-4">
      <h3 class="section-title">Competitor Set ${candidates.length ? `(${candidates.length} found)` : ''}</h3>
      <div class="competitor-grid" id="competitor-grid">${candidateCards}</div>

      <div class="card mt-3">
        <h4 class="card-title">Add Competitor Manually</h4>
        <div class="form-row">
          <input class="form-input" id="manual-comp" placeholder="competitor.com">
          <button class="btn btn-secondary" onclick="addManualCompetitor()">+ Add</button>
        </div>
      </div>
    </div>

    <div class="action-row mt-4">
      <button class="btn btn-secondary" onclick="enrichCompetitors()" id="enrich-btn" ${!candidates.length ? 'disabled' : ''}>
        Enrich Competitors (Clay + Exa)
      </button>
      <button class="btn btn-primary ml-2" onclick="confirmCompetitors()" id="confirm-comp-btn" ${!candidates.length ? 'disabled' : ''}>
        Confirm & Continue →
      </button>
    </div>
    <div id="enrich-progress" class="hidden mt-3"></div>`;

  return renderLayout(html);
}

let competitorIncluded = {};

function toggleCompetitor(i, domain) {
  const card = document.getElementById(`comp-card-${i}`);
  if (!card) return;
  const included = card.classList.contains('included');
  card.classList.toggle('included', !included);
  card.classList.toggle('excluded', included);
  const btn = card.querySelector('button');
  btn.textContent = included ? '✗ Exclude' : '✓ Include';
  btn.className = `btn btn-sm ${included ? 'btn-ghost' : 'btn-green'}`;
}

async function discoverCompetitors() {
  const btn = document.getElementById('discover-btn');
  const prog = document.getElementById('discover-progress');
  btn.disabled = true; btn.textContent = 'Discovering…';
  prog.classList.remove('hidden');
  prog.innerHTML = `<div class="progress-row"><div class="spinner"></div><span>Searching Exa + DataForSEO…</span></div>`;
  try {
    const r = await api('POST', `/research/${AppState.slug}/trigger`, { workflow_id: 'Competitor_Discovery' });
    if (!r?.job_id) throw new Error('No job returned');
    startPolling(r.job_id, AppState.slug, () => {},
      data => {
        btn.disabled = false; btn.textContent = '↻ Re-discover';
        prog.classList.add('hidden');
        if (data.status === 'complete') { showToast('Competitors discovered!', 'success'); renderCurrentStep(); }
        else showToast('Discovery had issues', 'warning');
      }
    );
  } catch(e) { showToast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Discover Competitors →'; prog.classList.add('hidden'); }
}

async function enrichCompetitors() {
  const btn = document.getElementById('enrich-btn');
  const prog = document.getElementById('enrich-progress');
  btn.disabled = true; btn.textContent = 'Enriching…';
  prog.classList.remove('hidden');
  prog.innerHTML = `<div class="progress-row"><div class="spinner"></div><span>Enriching with Clay + Exa…</span></div>`;
  try {
    const r = await api('POST', `/research/${AppState.slug}/trigger`, { workflow_id: 'Competitor_Enrichment_Clay' });
    startPolling(r.job_id, AppState.slug, () => {},
      data => {
        btn.disabled = false; btn.textContent = 'Enrich Competitors (Clay + Exa)';
        prog.classList.add('hidden');
        if (data.status === 'complete') { showToast('Enrichment complete', 'success'); renderCurrentStep(); }
      }
    );
  } catch(e) { showToast(e.message, 'error'); btn.disabled = false; prog.classList.add('hidden'); }
}

async function addManualCompetitor() {
  const input = document.getElementById('manual-comp');
  const domain = input?.value.trim();
  if (!domain) return;
  const candidates = AppState.project?.competitors?.candidates || [];
  if (candidates.length >= 15) { showToast('Maximum 15 competitors', 'warning'); return; }
  candidates.push({ domain, overlap_count: 0, source: 'manual' });
  AppState.project.competitors.candidates = candidates;
  input.value = '';
  renderCurrentStep();
}

async function confirmCompetitors() {
  const cards = document.querySelectorAll('.competitor-card');
  const confirmed = [];
  const g2Slugs = {};
  cards.forEach((card, i) => {
    if (!card.classList.contains('included')) return;
    const domain = AppState.project?.competitors?.candidates?.[i]?.domain;
    if (!domain) return;
    const g2Input = document.getElementById(`g2-${i}`);
    const slug = g2Input?.value.trim();
    confirmed.push({ domain });
    if (slug) g2Slugs[domain] = slug;
  });
  if (!confirmed.length) { showToast('Include at least 1 competitor to continue', 'warning'); return; }
  try {
    await api('PATCH', `/projects/${AppState.slug}/competitors`, { confirmed, g2_slugs: g2Slugs });
    AppState.project.competitors.confirmed = confirmed;
    AppState.project.competitors.g2_slugs = g2Slugs;
    showToast(`${confirmed.length} competitors confirmed`, 'success');
    // Unlock step 04
    if (AppState.project.step_status) AppState.project.step_status['04'] = 'ready';
    renderSidebar();
    window.location.hash = '#step-04';
  } catch(e) { showToast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 04 — RESEARCH PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

const PIPELINE_STAGES = [
  { key: 'site_intelligence',   label: 'Site Intelligence',    unit: 'pages' },
  { key: 'permutation_engine',  label: 'Permutation Engine',   unit: 'clusters' },
  { key: 'g2_review_mining',    label: 'G2 Review Mining',     unit: 'competitors' },
  { key: 'reddit_intelligence', label: 'Reddit Intelligence',  unit: 'posts' },
  { key: 'serp_analysis',       label: 'SERP Analysis',        unit: 'queries' },
  { key: 'synthesis_scoring',   label: 'Synthesis & Scoring',  unit: 'opportunities' }
];

function renderStep04() {
  const stages = AppState.project?.research?.pipeline_stages || {};
  const log = AppState.project?.pipeline_log || [];
  const allDone = Object.values(stages).every(s => s.status === 'complete');

  const stageRows = PIPELINE_STAGES.map(s => {
    const st = stages[s.key] || { status: 'queued', records: 0 };
    const icon = { queued:'⏳', running:'⚡', complete:'✓', failed:'✗' }[st.status] || '⏳';
    const spinning = st.status === 'running' ? 'spinning' : '';
    return `
      <div class="pipeline-row" id="prow-${s.key}">
        <div class="pipeline-icon ${spinning}">${icon}</div>
        <div class="pipeline-stage-name">${s.label}</div>
        ${statusBadge(st.status)}
        <div class="pipeline-elapsed mono" id="pelapsed-${s.key}">--:--</div>
        <div class="pipeline-records mono" id="precords-${s.key}">
          ${st.records ? `${formatNum(st.records)} ${s.unit}` : '—'}
        </div>
      </div>`;
  }).join('');

  const logLines = log.slice(-50).map(l => {
    const ts = l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : '';
    return `<div class="log-line"><span class="log-ts">[${ts}]</span> ${esc(l.message)}</div>`;
  }).join('');

  const html = `
    ${stepHeader('04', 'Research Pipeline', 'Run the full 6-stage research pipeline. Estimated time: 15–35 minutes.')}
    <div class="action-row">
      <button class="btn btn-primary btn-xl" onclick="runFullPipeline()" id="run-pipeline-btn">
        ${allDone ? '↻ Re-run Full Pipeline' : '▶ Run Full Research Pipeline'}
      </button>
    </div>
    <div class="pipeline-dashboard mt-4" id="pipeline-dashboard">
      <div class="pipeline-rows">${stageRows}</div>
    </div>
    <div class="log-panel mt-4">
      <div class="log-header">Activity Log</div>
      <div class="log-output" id="pipeline-log">${logLines}</div>
    </div>
    ${allDone ? `
      <div class="success-banner mt-4">
        <div class="success-icon">✓</div>
        <div>
          <strong>Research complete!</strong>
          <p>All 6 stages finished. Your keyword universe and page plan are ready.</p>
        </div>
        <button class="btn btn-primary" onclick="navigateStep('05')">View Keywords →</button>
      </div>` : ''}`;

  return renderLayout(html);
}

let pipelineTimers = {};

function startPipelineTimers() {
  const stages = AppState.project?.research?.pipeline_stages || {};
  PIPELINE_STAGES.forEach(s => {
    const st = stages[s.key];
    if (!st || st.status !== 'running') return;
    const start = st.started_at ? new Date(st.started_at).getTime() : Date.now();
    pipelineTimers[s.key] = setInterval(() => {
      const el = document.getElementById(`pelapsed-${s.key}`);
      if (!el) { clearInterval(pipelineTimers[s.key]); return; }
      const secs = Math.floor((Date.now() - start) / 1000);
      const m = String(Math.floor(secs/60)).padStart(2,'0');
      const sec = String(secs%60).padStart(2,'0');
      el.textContent = `${m}:${sec}`;
    }, 1000);
  });
}

async function runFullPipeline() {
  const btn = document.getElementById('run-pipeline-btn');
  btn.disabled = true; btn.textContent = 'Starting pipeline…';
  try {
    const r = await api('POST', `/research/${AppState.slug}/pipeline/run`);
    if (!r?.job_id) throw new Error('No job returned');
    showToast('Pipeline started — this will take 15–35 minutes', 'info');
    startPipelinePolling(r.job_id);
  } catch(e) { showToast(e.message, 'error'); btn.disabled = false; btn.textContent = '▶ Run Full Research Pipeline'; }
}

function startPipelinePolling(jobId) {
  const iv = setInterval(async () => {
    try {
      const data = await api('GET', `/research/${AppState.slug}/pipeline`);
      if (!data) return;
      if (AppState.project) {
        AppState.project.research.pipeline_stages = data.pipeline_stages || AppState.project.research.pipeline_stages;
        AppState.project.pipeline_log = data.pipeline_log || AppState.project.pipeline_log;
        AppState.project.step_status = data.step_status || AppState.project.step_status;
      }
      updatePipelineUI(data);
      const allDone = Object.values(data.pipeline_stages||{}).every(s => ['complete','failed'].includes(s.status));
      if (allDone) {
        clearInterval(iv);
        const fresh = await api('GET', `/projects/${AppState.slug}/state`);
        if (fresh?.state) AppState.project = fresh.state;
        renderCurrentStep();
      }
    } catch(e) {}
  }, 8000);
  AppState.pollingJobs[jobId] = iv;
}

function updatePipelineUI(data) {
  const stages = data.pipeline_stages || {};
  const log = data.pipeline_log || [];
  PIPELINE_STAGES.forEach(s => {
    const st = stages[s.key] || {};
    const row = document.getElementById(`prow-${s.key}`);
    if (!row) return;
    const icon = { queued:'⏳', running:'⚡', complete:'✓', failed:'✗' }[st.status] || '⏳';
    const iconEl = row.querySelector('.pipeline-icon');
    if (iconEl) { iconEl.textContent = icon; iconEl.className = `pipeline-icon ${st.status==='running'?'spinning':''}`; }
    const badge = row.querySelector('.badge');
    if (badge) badge.outerHTML = statusBadge(st.status);
    const rec = document.getElementById(`precords-${s.key}`);
    if (rec && st.records) rec.textContent = `${formatNum(st.records)} ${s.unit}`;
  });
  const logEl = document.getElementById('pipeline-log');
  if (logEl && log.length) {
    logEl.innerHTML = log.slice(-50).map(l => {
      const ts = l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : '';
      return `<div class="log-line"><span class="log-ts">[${ts}]</span> ${esc(l.message)}</div>`;
    }).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 05 — KEYWORD INTELLIGENCE
// ═══════════════════════════════════════════════════════════════════════════════

let kwSortCol = 'composite_score', kwSortDir = -1, kwFilter = {};

function renderStep05() {
  const ku = AppState.project?.research?.keyword_universe;
  if (!ku) return renderLayout(`${stepHeader('05', 'Keyword Intelligence', 'Run the Research Pipeline in Step 04 first.')}<div class="empty-state"><div class="empty-icon">🔍</div><p>No keyword data yet. Complete the Research Pipeline to see your keyword universe.</p></div>`);

  const clusters = ku.clusters || ku.keyword_clusters || [];
  const excl = ku.exclusions || {};
  const summary = ku.summary || {};
  const striking = AppState.project?.baseline?.striking_distance_keywords || [];

  const totalVol = clusters.reduce((a,c) => a + (Number(c.search_volume)||0), 0);
  const avgKD = clusters.length ? (clusters.reduce((a,c) => a + (Number(c.keyword_difficulty)||0), 0) / clusters.length).toFixed(1) : 0;
  const avgCPC = clusters.length ? (clusters.reduce((a,c) => a + (Number(c.cpc)||0), 0) / clusters.length).toFixed(2) : 0;

  // Filter clusters
  let filtered = clusters.filter(c => {
    if (kwFilter.text && !c.primary_keyword?.toLowerCase().includes(kwFilter.text.toLowerCase())) return false;
    if (kwFilter.type && kwFilter.type !== 'all' && c.opportunity_type && !String(c.opportunity_type).includes(kwFilter.type)) return false;
    if (kwFilter.minVol && (c.search_volume||0) < Number(kwFilter.minVol)) return false;
    if (kwFilter.maxKD && (c.keyword_difficulty||0) > Number(kwFilter.maxKD)) return false;
    return true;
  });

  // Sort
  filtered.sort((a,b) => {
    const va = a[kwSortCol] ?? 0, vb = b[kwSortCol] ?? 0;
    return typeof va === 'string' ? va.localeCompare(vb) * kwSortDir : (va - vb) * kwSortDir;
  });

  const sdCount = striking.length;
  const sdHTML = sdCount ? `
    <div class="win-box mt-4">
      <h4 class="win-box-title">⚡ ${sdCount} Striking Distance Keywords — Quick Wins (Position 4–20)</h4>
      <table class="data-table">
        <thead><tr><th>Keyword</th><th>Position</th><th>Impressions</th><th>CTR</th><th>Recommended Action</th></tr></thead>
        <tbody>${striking.slice(0,15).map(k => `
          <tr>
            <td>${esc(k.keys?.[0]||k.keyword||'')}</td>
            <td class="mono">${Number(k.position||0).toFixed(1)}</td>
            <td class="mono">${formatNum(k.impressions)}</td>
            <td class="mono">${pct(k.ctr)}</td>
            <td><span class="badge badge-blue">Optimize meta + add internal links</span></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>` : '';

  const rows = filtered.map((c, i) => {
    const type = Array.isArray(c.opportunity_type) ? c.opportunity_type[0] : (c.opportunity_type || '?');
    return `
      <tr class="kw-row" onclick="toggleKwDetail(${i})" data-idx="${i}">
        <td>${esc(truncate(c.primary_keyword, 40))}</td>
        <td class="mono">${esc(c.cluster_id||'')}</td>
        <td class="mono">${formatNum(c.search_volume)}</td>
        <td class="mono">${c.keyword_difficulty||'—'}</td>
        <td class="mono">${formatCPC(c.cpc)}</td>
        <td><span class="badge badge-muted">${esc(c.bofu_signal||c.bofu_signal_type||'—')}</span></td>
        <td>${scoreBadge(c.composite_score||c.final_score)}</td>
        <td>${typeBadge(type)}</td>
        <td>${c.striking_distance ? '<span class="badge badge-amber">⚡ Yes</span>' : ''}</td>
        <td><span class="kw-expand">▶</span></td>
      </tr>
      <tr class="kw-detail hidden" id="kw-detail-${i}">
        <td colspan="10">
          <div class="kw-detail-inner">
            ${c.narrative ? `<p class="kw-narrative">${esc(c.narrative)}</p>` : ''}
            ${(c.secondary_keywords||[]).length ? `<div class="kw-sec-kws">${(c.secondary_keywords||[]).map(k=>`<span class="tag-chip">${esc(k)}</span>`).join('')}</div>` : ''}
            ${(c.g2_frustration_phrases||c.g2_aligned ? `<p class="kw-signal">🔴 G2 aligned — buyers express this frustration in reviews</p>` : '')}
            ${c.paa_questions?.length ? `<div class="kw-paa"><strong>PAA Questions:</strong><ul>${c.paa_questions.map(q=>`<li>${esc(q)}</li>`).join('')}</ul></div>` : ''}
            <div class="kw-meta">Timeline: ${timelineBadge(c.estimated_ranking_timeline)} &nbsp; Displaceability: <strong>${esc(c.displaceability||'—')}</strong></div>
          </div>
        </td>
      </tr>`;
  }).join('');

  const exclCounts = { LOW_VOLUME: (excl.low_volume||[]).length, HIGH_DIFFICULTY: (excl.high_difficulty||[]).length, LOW_SCORE: (excl.low_score||[]).length };
  const exclTotal = Object.values(exclCounts).reduce((a,b)=>a+b,0);

  const html = `
    ${stepHeader('05', 'Keyword Intelligence', `${formatNum(summary.surviving||clusters.length)} opportunities identified from ${formatNum(summary.total_evaluated||0)} evaluated.`)}
    <div class="stat-grid mb-4">
      ${statCard('Evaluated', formatNum(summary.total_evaluated||0))}
      ${statCard('Surviving', formatNum(summary.surviving||clusters.length))}
      ${statCard('Clusters', formatNum(summary.clusters_formed||clusters.length))}
      ${statCard('Est. Monthly Vol', formatNum(totalVol))}
      ${statCard('Avg KD', avgKD)}
      ${statCard('Avg CPC', formatCPC(avgCPC))}
    </div>
    <div class="filter-bar mb-3">
      <input class="form-input filter-input" placeholder="Search keywords…" oninput="kwFilter.text=this.value;renderCurrentStep()">
      <select class="form-select filter-select" onchange="kwFilter.type=this.value;renderCurrentStep()">
        <option value="all">All Types</option>
        <option value="A">A — BoFu Pages</option>
        <option value="B">B — Content</option>
        <option value="C">C — Comparison</option>
        <option value="D">D — Striking Distance</option>
      </select>
      <input class="form-input filter-input-sm" type="number" placeholder="Min Vol" oninput="kwFilter.minVol=this.value;renderCurrentStep()">
      <input class="form-input filter-input-sm" type="number" placeholder="Max KD" oninput="kwFilter.maxKD=this.value;renderCurrentStep()">
      <a class="btn btn-secondary btn-sm" href="/api/export/${AppState.slug}/csv/keywords" download>Export CSV</a>
    </div>
    <div class="table-scroll">
      <table class="data-table sortable-table">
        <thead><tr>
          ${[['primary_keyword','Keyword'],['cluster_id','Cluster'],['search_volume','Vol'],['keyword_difficulty','KD'],['cpc','CPC'],['bofu_signal','BoFu'],['composite_score','Score'],['opportunity_type','Type'],['striking_distance','SD']].map(([col,lbl])=>`
            <th class="sortable ${kwSortCol===col?'sorted':''}" onclick="sortKw('${col}')">${lbl} ${kwSortCol===col?(kwSortDir>0?'↑':'↓'):''}</th>`).join('')}
          <th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="10" class="empty-td">No keywords match current filters.</td></tr>`}</tbody>
      </table>
    </div>
    ${sdHTML}
    <details class="excluded-panel mt-4">
      <summary class="excluded-summary">Excluded Keywords (${formatNum(exclTotal)} total)</summary>
      <div class="excluded-content">
        ${Object.entries(exclCounts).map(([k,n])=>`
          <details class="excl-group"><summary class="excl-label">${k} — ${n} keywords</summary>
          <div class="excl-list">${((excl[k.toLowerCase()]||[]).slice(0,50)).map(kw=>`<span class="tag-chip tag-chip-sm">${esc(typeof kw==='string'?kw:kw.keyword||JSON.stringify(kw))}</span>`).join('')}</div>
          </details>`).join('')}
      </div>
    </details>`;

  return renderLayout(html);
}

function sortKw(col) {
  if (kwSortCol === col) kwSortDir *= -1;
  else { kwSortCol = col; kwSortDir = -1; }
  renderCurrentStep();
}

function toggleKwDetail(i) {
  const detail = document.getElementById(`kw-detail-${i}`);
  const row = document.querySelector(`[data-idx="${i}"]`);
  if (!detail) return;
  detail.classList.toggle('hidden');
  const arrow = row?.querySelector('.kw-expand');
  if (arrow) arrow.textContent = detail.classList.contains('hidden') ? '▶' : '▼';
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 06 — BOFU PAGE PLAN
// ═══════════════════════════════════════════════════════════════════════════════

let pageTabFilter = 'all';

function renderStep06() {
  const pages = AppState.project?.pages || {};
  const allPages = [
    ...(pages.bofu_pages||[]).map(p=>({...p, _type:'A'})),
    ...(pages.comparison_pages||[]).map(p=>({...p, _type:'C'})),
    ...(pages.supporting_content||[]).map(p=>({...p, _type:'B'})),
    ...(pages.striking_distance||[]).map(p=>({...p, _type:'D'}))
  ].sort((a,b) => (b.final_score||0) - (a.final_score||0));

  if (!allPages.length) return renderLayout(`${stepHeader('06', 'BoFu Page Plan', 'Complete the Research Pipeline in Step 04 first.')}<div class="empty-state"><div class="empty-icon">📄</div><p>No pages planned yet. Run the Research Pipeline to generate your BoFu page plan.</p></div>`);

  const filtered = pageTabFilter === 'all' ? allPages : allPages.filter(p => p._type === pageTabFilter || (Array.isArray(p.opportunity_type) && p.opportunity_type.includes(pageTabFilter)));

  const totalVol = allPages.reduce((a,p)=>(a + (p.search_volume||0)), 0);

  const cards = filtered.map((p, i) => {
    const type = p._type || (Array.isArray(p.opportunity_type) ? p.opportunity_type[0] : p.opportunity_type);
    const hasHtml = !!p.html;
    return `
      <div class="page-card" id="pcard-${i}">
        <div class="page-card-header" onclick="togglePageCard(${i})">
          <div class="page-card-rank">#${(i+1)}</div>
          <div class="page-card-info">
            <div class="page-card-title">${esc(p.recommended_h1 || p.primary_keyword)}</div>
            <div class="page-card-slug mono">${esc(p.recommended_slug||'')}</div>
          </div>
          <div class="page-card-meta">
            ${typeBadge(type)} ${scoreBadge(p.final_score||p.composite_score)} ${timelineBadge(p.estimated_ranking_timeline)}
          </div>
          <div class="page-card-stats">
            <span>Vol: ${formatNum(p.search_volume)}</span>
            <span>KD: ${p.keyword_difficulty||'—'}</span>
            <span>CPC: ${formatCPC(p.cpc)}</span>
          </div>
          <span class="expand-arrow" id="parrow-${i}">▶</span>
        </div>
        <div class="page-card-body hidden" id="pbody-${i}">
          <div class="tab-bar" id="ptab-bar-${i}">
            <button class="tab-btn active" onclick="switchPageTab(${i},'brief',this)">Brief</button>
            <button class="tab-btn" onclick="switchPageTab(${i},'meta',this)">Meta & Schema</button>
            <button class="tab-btn" onclick="switchPageTab(${i},'html',this)">HTML</button>
            <button class="tab-btn" onclick="switchPageTab(${i},'links',this)">Internal Links</button>
          </div>
          <div id="ptab-brief-${i}" class="tab-pane active p-3">
            ${p.narrative_justification||p.narrative ? `<p class="kw-narrative">${esc(p.narrative_justification||p.narrative)}</p>` : ''}
            <div class="brief-grid">
              <div><strong>Core Problem:</strong> ${esc(p.core_problem||'—')}</div>
              <div><strong>Persona:</strong> ${esc(p.icp_persona||p.target_persona||'—')}</div>
              <div><strong>Word Count:</strong> ${formatNum(p.target_word_count)}</div>
              <div><strong>Format:</strong> ${esc(p.content_format||p.recommended_structure||'—')}</div>
              <div><strong>Content Gap:</strong> ${esc(p.content_gap||'—')}</div>
              <div><strong>Displaceability:</strong> ${esc(p.displaceability||'—')}</div>
            </div>
            ${(p.g2_frustration_phrases||[]).length ? `<div class="mt-2"><strong>G2 Frustrations to Address:</strong><div class="tag-cloud mt-1">${(p.g2_frustration_phrases||[]).map(f=>`<span class="tag-chip">${esc(f)}</span>`).join('')}</div></div>` : ''}
            ${(p.paa_questions||[]).length ? `<div class="mt-2"><strong>PAA Questions (FAQ targets):</strong><ul class="paa-list">${(p.paa_questions||[]).map(q=>`<li>${esc(q)}</li>`).join('')}</ul></div>` : ''}
          </div>
          <div id="ptab-meta-${i}" class="tab-pane hidden p-3">
            <div class="meta-field"><label>Title Tag</label><div class="mono-block">${esc(p.title_tag||'')}</div></div>
            <div class="meta-field"><label>Meta Description</label><div class="mono-block">${esc(p.meta_description||'')}</div></div>
            <div class="meta-field"><label>Canonical</label><div class="mono-block">${esc(`https://${AppState.project?.config?.identity?.primary_domain||''}${p.recommended_slug||''}`)}</div></div>
            ${p.schema_markup ? `<div class="meta-field"><label>Schema (JSON-LD)</label><pre class="code-block">${esc(JSON.stringify(p.schema_markup,null,2))}</pre></div>` : ''}
          </div>
          <div id="ptab-html-${i}" class="tab-pane hidden p-3">
            ${hasHtml ? `
              <div class="action-row">
                <a class="btn btn-primary btn-sm" href="/api/pages/${AppState.slug}/${p.cluster_id}/download" download>Download HTML</a>
                <button class="btn btn-secondary btn-sm" onclick="generatePageHtml('${esc(p.cluster_id)}',${i})">↻ Regenerate</button>
              </div>
              <div class="html-preview-note">Generated ${timeSince(p.html_generated_at)} · ${formatNum(p.html?.length)} chars</div>
            ` : `
              <button class="btn btn-primary" onclick="generatePageHtml('${esc(p.cluster_id)}',${i})" id="gen-html-btn-${i}">Generate HTML →</button>
              <p class="form-hint">~1–2 minutes per page</p>
            `}
            <div id="html-progress-${i}" class="hidden mt-3"></div>
          </div>
          <div id="ptab-links-${i}" class="tab-pane hidden p-3">
            ${(p.internal_links_out||[]).length ? `
              <h4 class="section-subtitle">Outbound Links (from this page)</h4>
              <table class="data-table"><thead><tr><th>Anchor Text</th><th>Destination</th></tr></thead>
              <tbody>${(p.internal_links_out||[]).map(l=>`<tr><td>${esc(l.anchor||l.anchor_text)}</td><td class="mono">${esc(l.destination||l.destination_slug)}</td></tr>`).join('')}</tbody></table>` : ''}
            ${(p.internal_links_in||[]).length ? `
              <h4 class="section-subtitle mt-3">Inbound Links (to this page)</h4>
              <table class="data-table"><thead><tr><th>Source</th><th>Anchor Text</th></tr></thead>
              <tbody>${(p.internal_links_in||[]).map(l=>`<tr><td class="mono">${esc(l.source||l.source_slug)}</td><td>${esc(l.anchor||l.anchor_text)}</td></tr>`).join('')}</tbody></table>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  const html = `
    ${stepHeader('06', 'BoFu Page Plan', `${allPages.length} pages planned · ~${formatNum(totalVol)} monthly impressions at page 1`)}
    <div class="stat-grid mb-4">
      ${statCard('BoFu Pages', formatNum((pages.bofu_pages||[]).length))}
      ${statCard('Comparison Pages', formatNum((pages.comparison_pages||[]).length))}
      ${statCard('Supporting Content', formatNum((pages.supporting_content||[]).length))}
      ${statCard('Striking Distance', formatNum((pages.striking_distance||[]).length))}
      ${statCard('Est. Monthly Vol (P1)', formatNum(totalVol))}
    </div>
    <div class="tab-bar mb-3">
      ${[['all','All Pages'],['A','BoFu'],['C','Comparison'],['B','Content'],['D','Quick Wins']].map(([v,l])=>`
        <button class="tab-btn ${pageTabFilter===v?'active':''}" onclick="pageTabFilter='${v}';renderCurrentStep()">${l}</button>`).join('')}
    </div>
    <div class="page-cards">${cards}</div>`;

  return renderLayout(html);
}

function togglePageCard(i) {
  const body = document.getElementById(`pbody-${i}`);
  const arrow = document.getElementById(`parrow-${i}`);
  if (!body) return;
  body.classList.toggle('hidden');
  if (arrow) arrow.textContent = body.classList.contains('hidden') ? '▶' : '▼';
}

function switchPageTab(i, tab, btn) {
  const bar = document.getElementById(`ptab-bar-${i}`);
  if (bar) bar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  ['brief','meta','html','links'].forEach(t => {
    const pane = document.getElementById(`ptab-${t}-${i}`);
    if (pane) pane.classList.toggle('hidden', t !== tab);
  });
}

async function generatePageHtml(clusterId, cardIdx) {
  const btn = document.getElementById(`gen-html-btn-${cardIdx}`);
  const prog = document.getElementById(`html-progress-${cardIdx}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
  if (prog) { prog.classList.remove('hidden'); prog.innerHTML = `<div class="progress-row"><div class="spinner"></div><span>Generating HTML via Claude…</span></div>`; }
  try {
    const r = await api('POST', `/pages/${AppState.slug}/${clusterId}/generate`);
    if (!r?.job_id) throw new Error('No job returned');
    startPolling(r.job_id, AppState.slug, () => {},
      data => {
        if (btn) { btn.disabled = false; btn.textContent = 'Generate HTML →'; }
        if (prog) prog.classList.add('hidden');
        if (data.status === 'complete') { showToast('HTML generated!', 'success'); renderCurrentStep(); }
        else showToast('HTML generation failed', 'error');
      }
    );
  } catch(e) {
    showToast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Generate HTML →'; }
    if (prog) prog.classList.add('hidden');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 07 — CONTENT STRATEGY & CALENDAR
// ═══════════════════════════════════════════════════════════════════════════════

let calendarMonth = 1;

function renderStep07() {
  const pages = AppState.project?.pages || {};
  const content = pages.supporting_content || [];
  const tasks = AppState.project?.calendar?.tasks || [];
  const startDate = AppState.project?.calendar?.project_start_date;

  const contentCards = content.length ? content.slice(0,20).map((c,i) => `
    <div class="page-card">
      <div class="page-card-header" onclick="this.nextElementSibling.classList.toggle('hidden')">
        <div class="page-card-info">
          <div class="page-card-title">${esc(c.primary_keyword)}</div>
          <div class="page-card-slug mono">${esc(c.recommended_slug||'')}</div>
        </div>
        <div class="page-card-meta">${typeBadge('B')} <span class="badge badge-muted">${formatNum(c.search_volume)} vol</span></div>
        <span class="expand-arrow">▶</span>
      </div>
      <div class="page-card-body hidden p-3">
        ${c.narrative ? `<p class="kw-narrative">${esc(c.narrative)}</p>` : ''}
        ${c.brief ? `<div class="brief-grid">
          <div><strong>Title:</strong> ${esc(c.brief.suggested_title||c.primary_keyword)}</div>
          <div><strong>Format:</strong> ${esc(c.brief.content_format||'')}</div>
          <div><strong>Word Count:</strong> ${formatNum(c.brief.target_word_count||c.target_word_count)}</div>
          <div><strong>Intent:</strong> ${esc(c.brief.search_intent||'informational')}</div>
        </div>` : `<button class="btn btn-secondary btn-sm" onclick="generateBrief('${esc(c.cluster_id)}')">Generate Brief</button>`}
      </div>
    </div>`).join('') : `<div class="empty-state-sm">No supporting content planned yet.</div>`;

  const monthTabs = [1,2,3,4,5,6].map(m => `
    <button class="tab-btn ${calendarMonth===m?'active':''}" onclick="calendarMonth=${m};renderCurrentStep()">Month ${m}</button>`).join('');

  const monthTasks = tasks.filter(t => t.week_number && Math.ceil(t.week_number / 4.33) === calendarMonth);
  const taskTypeColors = { 'Publish Page':'badge-blue', 'Publish Content':'badge-purple', 'Technical Fix':'badge-amber', 'Schema Addition':'badge-muted', 'Internal Link':'badge-green', 'GSC Submit':'badge-muted', 'Analytics Review':'badge-blue' };

  const taskCards = monthTasks.length ? monthTasks.map((t,i) => `
    <div class="task-card">
      <div class="task-card-header">
        <span class="badge ${taskTypeColors[t.task_type]||'badge-muted'}">${esc(t.task_type||'Task')}</span>
        <span class="task-week">Week ${t.week_number}, ${t.day_of_week||''}</span>
        <select class="form-select form-select-sm" onchange="updateTaskStatus(${i},this.value)">
          ${['Not Started','In Progress','Done'].map(s=>`<option ${t.status===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="task-title">${esc(t.title||t.task_title||'')}</div>
      <div class="task-meta">
        <span>Owner: <strong>${esc(t.owner||'RAINCLOUD')}</strong></span>
        <span>${t.estimated_hours ? `${t.estimated_hours}h` : ''}</span>
        ${t.dependencies ? `<span class="form-hint">Depends on: ${esc(t.dependencies)}</span>` : ''}
      </div>
    </div>`).join('') : `<div class="empty-state-sm">No tasks planned for Month ${calendarMonth}.</div>`;

  const html = `
    ${stepHeader('07', 'Content Strategy & Calendar', 'Supporting content plan and 6-month execution calendar.')}

    <div class="card mb-4">
      <div class="card-header">
        <h3 class="card-title">Push to Notion</h3>
        <span class="form-hint">Sync your calendar to a Notion database</span>
      </div>
      <div class="form-row">
        <input class="form-input" id="notion-db-id" placeholder="Notion Database ID" value="${esc(AppState.project?.exports?.notion_database_id||'')}">
        <input class="form-input" id="notion-start" type="date" placeholder="Project Start Date" value="${esc(startDate||'')}">
        <button class="btn btn-primary" onclick="pushToNotion()">Push to Notion →</button>
      </div>
      <div id="notion-progress" class="hidden mt-2"></div>
    </div>

    <h3 class="section-title">Supporting Content Plan (${content.length} pieces)</h3>
    <div class="mb-4">${contentCards}</div>

    <h3 class="section-title mt-4">6-Month Calendar</h3>
    <div class="tab-bar mb-3">${monthTabs}</div>
    <div class="task-grid">${taskCards}</div>`;

  return renderLayout(html);
}

async function generateBrief(clusterId) {
  try {
    const r = await api('POST', `/pages/${AppState.slug}/${clusterId}/brief`);
    if (!r?.job_id) throw new Error('No job returned');
    showToast('Generating brief…', 'info');
    startPolling(r.job_id, AppState.slug, () => {},
      d => { if (d.status==='complete') { showToast('Brief generated', 'success'); renderCurrentStep(); } }
    );
  } catch(e) { showToast(e.message, 'error'); }
}

async function pushToNotion() {
  const dbId = document.getElementById('notion-db-id')?.value.trim();
  const startDate = document.getElementById('notion-start')?.value;
  if (!dbId) { showToast('Enter Notion Database ID', 'error'); return; }
  const prog = document.getElementById('notion-progress');
  prog.classList.remove('hidden');
  prog.innerHTML = `<div class="progress-row"><div class="spinner"></div><span>Pushing to Notion…</span></div>`;
  try {
    await api('PATCH', `/projects/${AppState.slug}/calendar`, { project_start_date: startDate });
    const r = await api('POST', `/research/${AppState.slug}/trigger`, {
      workflow_id: 'Notion_Push',
      payload_overrides: { notion_database_id: dbId, project_name: AppState.projectName, project_start_date: startDate, calendar_tasks: AppState.project?.calendar?.tasks||[] }
    });
    startPolling(r.job_id, AppState.slug, () => {},
      d => {
        prog.classList.add('hidden');
        if (d.status === 'complete') {
          const notionUrl = d.result?.notion_database_url;
          showToast('Pushed to Notion!', 'success');
          if (notionUrl) prog.innerHTML = `<a href="${esc(notionUrl)}" target="_blank" class="btn btn-secondary btn-sm">View in Notion ↗</a>`;
          prog.classList.remove('hidden');
        } else showToast('Notion push failed', 'error');
      }
    );
  } catch(e) { showToast(e.message, 'error'); prog.classList.add('hidden'); }
}

async function updateTaskStatus(i, status) {
  if (!AppState.project?.calendar?.tasks) return;
  AppState.project.calendar.tasks[i].status = status;
  try { await api('PATCH', `/projects/${AppState.slug}/calendar`, { tasks: AppState.project.calendar.tasks }); }
  catch(e) { /* silently fail */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 08 — REPORTING DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

function renderStep08() {
  const reports = AppState.project?.reports || [];
  const latest = reports[reports.length - 1];
  const baseline = AppState.project?.baseline;

  const noData = !latest ? `
    <div class="empty-state">
      <div class="empty-icon">📊</div>
      <p>No refresh data yet. Click "Refresh Analytics Data" to compare current performance against your baseline.</p>
    </div>` : '';

  const deltaCards = latest ? `
    <div class="stat-grid mb-4">
      ${statCard('Organic Sessions', formatNum(latest.ga4_current?.total_sessions), deltaArrow((latest.deltas?.organic_sessions?.delta||0)))}
      ${statCard('Page 1 Keywords', formatNum(latest.deltas?.p1_keywords?.current), deltaArrow((latest.deltas?.p1_keywords?.delta||0)))}
      ${statCard('Striking Distance', formatNum(latest.deltas?.striking_distance?.current), deltaArrow((latest.deltas?.striking_distance?.delta||0)))}
      ${statCard('Avg Position', latest.deltas?.avg_position?.current?.toFixed(1)||'—', deltaArrow(-(latest.deltas?.avg_position?.delta||0)))}
    </div>` : '';

  const winsHTML = latest?.narrative ? `
    <div class="win-box mt-3">
      <h4 class="win-box-title">✓ Wins This Period</h4>
      <div class="report-narrative">${esc(latest.narrative)}</div>
    </div>` : '';

  const alertsHTML = (latest?.alerts||[]).length ? `
    <div class="alert-box mt-3">
      <h4>⚠ Alerts</h4>
      <ul>${(latest.alerts||[]).map(a=>`<li>${esc(typeof a === 'string' ? a : a.message || JSON.stringify(a))}</li>`).join('')}</ul>
    </div>` : '';

  const pagePerf = (latest?.published_page_performance||[]);
  const pagePerfHTML = pagePerf.length ? `
    <h3 class="section-title mt-4">Published Page Performance</h3>
    <table class="data-table">
      <thead><tr><th>Page</th><th>Impressions</th><th>Clicks</th><th>Avg Position</th><th>CTR</th></tr></thead>
      <tbody>${pagePerf.map(p=>`
        <tr>
          <td class="mono">${esc(p.page||p.url||'')}</td>
          <td class="mono">${formatNum(p.impressions)}</td>
          <td class="mono">${formatNum(p.clicks)}</td>
          <td class="mono">${Number(p.position||0).toFixed(1)}</td>
          <td class="mono">${pct(p.ctr)}</td>
        </tr>`).join('')}</tbody>
    </table>` : '';

  const html = `
    ${stepHeader('08', 'Reporting Dashboard', latest ? `Last refreshed: ${timeSince(latest.refresh_date||latest.created_at)}` : 'Connect analytics in Step 02 to enable reporting.')}
    <div class="action-row mb-4">
      <button class="btn btn-primary" onclick="refreshAnalytics()" id="refresh-analytics-btn">↻ Refresh Analytics Data</button>
      <span class="form-hint ml-2">~3–5 minutes</span>
    </div>
    <div id="refresh-progress" class="hidden mb-4"></div>
    ${noData}${deltaCards}${winsHTML}${alertsHTML}${pagePerfHTML}`;

  return renderLayout(html);
}

async function refreshAnalytics() {
  const btn = document.getElementById('refresh-analytics-btn');
  const prog = document.getElementById('refresh-progress');
  btn.disabled = true; btn.textContent = 'Refreshing…';
  prog.classList.remove('hidden');
  prog.innerHTML = `<div class="progress-row"><div class="spinner"></div><span>Pulling 30-day analytics data…</span></div>`;
  try {
    const r = await api('POST', `/research/${AppState.slug}/trigger`, { workflow_id: 'GA_GSC_Refresh' });
    startPolling(r.job_id, AppState.slug, () => {},
      data => {
        btn.disabled = false; btn.textContent = '↻ Refresh Analytics Data';
        prog.classList.add('hidden');
        if (data.status === 'complete') { showToast('Analytics refreshed!', 'success'); renderCurrentStep(); }
        else showToast('Refresh had issues', 'warning');
      }
    );
  } catch(e) { showToast(e.message, 'error'); btn.disabled = false; prog.classList.add('hidden'); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 09 — TECHNICAL SEO PACKAGE
// ═══════════════════════════════════════════════════════════════════════════════

let techSeoTab = 'meta';

function renderStep09() {
  const tech = AppState.project?.tech_seo || {};
  const pages = AppState.project?.pages || {};
  const allPages = [...(pages.bofu_pages||[]), ...(pages.comparison_pages||[]), ...(pages.supporting_content||[])];
  const gscSubs = tech.gsc_submissions || [];

  const tabs = [['meta','Meta Tags'],['schema','Schema'],['robots','robots.txt'],['llms','llms.txt'],['sitemap','Sitemap'],['gsc','GSC Submission']];

  const metaTable = allPages.length ? `
    <table class="data-table">
      <thead><tr><th>Page</th><th>Title Tag</th><th>Meta Description</th></tr></thead>
      <tbody>${allPages.slice(0,30).map(p=>`
        <tr>
          <td class="mono">${esc(p.recommended_slug||'')}</td>
          <td>${esc(truncate(p.title_tag||'',60))}</td>
          <td>${esc(truncate(p.meta_description||'',120))}</td>
        </tr>`).join('')}</tbody>
    </table>
    <div class="mt-3"><a class="btn btn-secondary btn-sm" href="/api/export/${AppState.slug}/csv/meta" download>Export Meta Tags CSV</a></div>` : `<div class="empty-state-sm">No pages generated yet.</div>`;

  const robotsContent = tech.robots_txt || 'User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: https://example.com/sitemap.xml';
  const llmsContent = tech.llms_txt || '# LLM Access Guidelines\n\n## About\nThis site provides products and services.\n\n## Allowed\n- Product information\n- Blog content';
  const sitemapPreview = tech.sitemap_xml ? tech.sitemap_xml.split('\n').slice(0, 25).join('\n') + (tech.sitemap_xml.split('\n').length > 25 ? '\n  <!-- ... and more -->' : '') : '<!-- Run the Research Pipeline to generate sitemap -->';

  const gscTable = gscSubs.length ? `
    <table class="data-table">
      <thead><tr><th>URL</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${gscSubs.map(s=>`
        <tr>
          <td class="mono">${esc(s.url||'')}</td>
          <td>${statusBadge(s.status||'Pending')}</td>
          <td><button class="btn btn-secondary btn-xs" onclick="submitGscUrl('${esc(s.url)}')">Submit</button></td>
        </tr>`).join('')}</tbody>
    </table>
    <div class="mt-3"><button class="btn btn-primary btn-sm" onclick="submitAllGsc()">Submit All Pending</button></div>` :
    `<div class="empty-state-sm">No URLs queued for submission. Pages are added here when generated.</div>`;

  const tabContent = {
    meta:    metaTable,
    schema:  allPages.length ? `<select class="form-select mb-3" id="schema-page-select" onchange="showSchemaForPage(this.value)">${allPages.map((p,i)=>`<option value="${i}">${esc(p.recommended_slug||p.primary_keyword)}</option>`).join('')}</select><pre class="code-block" id="schema-display">${esc(JSON.stringify(allPages[0]?.schema_markup||allPages[0]?.structured_data||{},null,2))}</pre><button class="btn btn-secondary btn-sm mt-2" onclick="copySchemaToClipboard()">Copy to Clipboard</button>` : `<div class="empty-state-sm">No pages generated yet.</div>`,
    robots:  `<textarea class="form-textarea mono" id="robots-txt" rows="12">${esc(robotsContent)}</textarea><div class="action-row mt-2"><button class="btn btn-secondary btn-sm" onclick="saveTechSeoFile('robots_txt','robots-txt')">Save Changes</button><a class="btn btn-ghost btn-sm" href="data:text/plain,${encodeURIComponent(robotsContent)}" download="robots.txt">Download</a></div>`,
    llms:    `<textarea class="form-textarea mono" id="llms-txt" rows="12">${esc(llmsContent)}</textarea><div class="action-row mt-2"><button class="btn btn-secondary btn-sm" onclick="saveTechSeoFile('llms_txt','llms-txt')">Save Changes</button><a class="btn btn-ghost btn-sm" href="data:text/plain,${encodeURIComponent(llmsContent)}" download="llms.txt">Download</a></div>`,
    sitemap: `<pre class="code-block">${esc(sitemapPreview)}</pre><div class="mt-3"><a class="btn btn-secondary btn-sm" href="data:application/xml,${encodeURIComponent(tech.sitemap_xml||'')}" download="sitemap.xml">Download sitemap.xml</a></div>`,
    gsc:     gscTable
  };

  const html = `
    ${stepHeader('09', 'Technical SEO Package', 'All technical assets generated and ready to deploy.')}
    <div class="tab-bar mb-4">
      ${tabs.map(([v,l])=>`<button class="tab-btn ${techSeoTab===v?'active':''}" onclick="techSeoTab='${v}';renderCurrentStep()">${l}</button>`).join('')}
    </div>
    <div class="card">${tabContent[techSeoTab]||''}</div>
    <div class="card mt-4">
      <div class="card-header"><h3 class="card-title">Download Everything</h3></div>
      <p class="form-hint">Packages all CSVs, generated HTML files, robots.txt, llms.txt, sitemap.xml, and schema JSON into a single ZIP.</p>
      <a class="btn btn-primary" href="/api/export/${AppState.slug}/zip" download>Download Full Package (ZIP) →</a>
    </div>`;

  return renderLayout(html);
}

function showSchemaForPage(idx) {
  const pages = AppState.project?.pages || {};
  const allPages = [...(pages.bofu_pages||[]), ...(pages.comparison_pages||[]), ...(pages.supporting_content||[])];
  const p = allPages[idx];
  const el = document.getElementById('schema-display');
  if (el) el.textContent = JSON.stringify(p?.schema_markup||p?.structured_data||{}, null, 2);
}

function copySchemaToClipboard() {
  const el = document.getElementById('schema-display');
  if (el) { navigator.clipboard.writeText(el.textContent).then(() => showToast('Copied!', 'success')); }
}

async function saveTechSeoFile(field, elementId) {
  const val = document.getElementById(elementId)?.value;
  if (!AppState.project) return;
  if (!AppState.project.tech_seo) AppState.project.tech_seo = {};
  AppState.project.tech_seo[field] = val;
  showToast('Saved locally (deploy this file manually)', 'success');
}

async function submitGscUrl(url) {
  try {
    const r = await api('POST', `/research/${AppState.slug}/trigger`, {
      workflow_id: 'GSC_URL_Submit',
      payload_overrides: { urls_to_submit: [url] }
    });
    showToast('Submitted to GSC', 'info');
    startPolling(r.job_id, AppState.slug, () => {}, () => renderCurrentStep());
  } catch(e) { showToast(e.message, 'error'); }
}

async function submitAllGsc() {
  try {
    const r = await api('POST', `/research/${AppState.slug}/trigger`, { workflow_id: 'GSC_URL_Submit' });
    showToast('Submitting all pending URLs…', 'info');
    startPolling(r.job_id, AppState.slug, () => {}, () => { showToast('GSC submission complete', 'success'); renderCurrentStep(); });
  } catch(e) { showToast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTING & RENDER ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

function renderSidebar() {
  const sidebarSteps = document.querySelector('.sidebar-steps');
  if (sidebarSteps) sidebarSteps.innerHTML = renderStepNav();
}

async function refreshProjectState() {
  if (!AppState.slug) return;
  try {
    const d = await api('GET', `/projects/${AppState.slug}/state`);
    if (d?.state) AppState.project = d.state;
  } catch(e) { /* swallow */ }
}

async function renderCurrentStep() {
  const app = document.getElementById('app');
  if (!app) return;

  if (!AppState.authenticated) {
    await renderStep00();
    return;
  }

  const step = AppState.currentStep;
  const renderers = {
    '00': async () => renderLayout(`${stepHeader('00', 'Project Setup', 'Project created and active.')}<div class="card"><p>Project: <strong>${esc(AppState.projectName)}</strong></p><button class="btn btn-primary mt-3" onclick="navigateStep('01')">Configure Brand & Identity →</button></div>`),
    '01': async () => renderStep01(),
    '02': async () => renderStep02(),
    '03': async () => renderStep03(),
    '04': async () => renderStep04(),
    '05': async () => renderStep05(),
    '06': async () => renderStep06(),
    '07': async () => renderStep07(),
    '08': async () => renderStep08(),
    '09': async () => renderStep09()
  };

  const renderer = renderers[step];
  if (renderer) {
    const html = await renderer();
    if (html) app.innerHTML = html;
    // Start elapsed timers for running pipeline stages
    if (step === '04') startPipelineTimers();
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  // Check auth status
  try {
    const d = await api('GET', '/auth/check');
    if (d?.authenticated) {
      AppState.authenticated = true;
      AppState.slug = d.slug;
      AppState.projectName = d.project_name;
      await refreshProjectState();
    }
  } catch(e) { /* not authenticated */ }

  // Hash router
  function handleHash() {
    const hash = window.location.hash.replace('#step-', '');
    if (hash && /^\d{2}$/.test(hash)) AppState.currentStep = hash;
    else if (!AppState.authenticated) AppState.currentStep = '00';
    renderCurrentStep();
  }

  window.addEventListener('hashchange', handleHash);
  handleHash();

  // Background state refresh every 30s when authenticated
  setInterval(async () => {
    if (AppState.authenticated && AppState.slug) {
      await refreshProjectState();
      // Only re-render sidebar steps, not the whole page
      renderSidebar();
    }
  }, 30000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTENT STUDIO — Sidebar entries + router extensions
// ═══════════════════════════════════════════════════════════════════════════════

const STUDIO_STEPS = [
  { id: 'cs-drafts',  name: 'Content Drafts', icon: '✍' },
  { id: 'cs-atoms',   name: 'Atomizer',        icon: '⚡' },
  { id: 'cs-images',  name: 'Image Library',   icon: '🖼' },
  { id: 'cs-export',  name: 'Export',          icon: '📤' },
];

// Patch renderStepNav to append the Content Studio sidebar section
// NOTE: must use variable assignment (not function declaration) to avoid hoisting
const _origRenderStepNav = renderStepNav;
renderStepNav = function() {
  const pipelineItems = _origRenderStepNav();
  const activeStudio = AppState.currentStudio || null;

  const studioItems = STUDIO_STEPS.map(s => {
    const isActive = activeStudio === s.id;
    return `
      <div class="step-item studio-step ${isActive ? 'active' : ''}"
           onclick="navigateStudio('${s.id}')">
        <span class="studio-step-icon">${s.icon}</span>
        <div class="step-info">
          <div class="step-name">${s.name}</div>
        </div>
      </div>`;
  }).join('');

  return pipelineItems + `
    <div class="sidebar-section-divider"></div>
    <div class="sidebar-section-label">Content Studio</div>
    ${studioItems}`;
};

function navigateStudio(id) {
  AppState.currentStudio = id;
  AppState.currentStep = null;
  window.location.hash = `#studio-${id}`;
}

// ─── Patch handleHash (stored in closure — override via hash event) ────────────
// We can't directly patch the inner handleHash, so we intercept hashchange.
// The inner handleHash regex only matches \d{2}, so studio hashes fall through.
// We add a second handler here that catches studio routes first.
window.addEventListener('hashchange', handleStudioHash);
function handleStudioHash() {
  const hash = window.location.hash;
  if (hash && hash.startsWith('#studio-')) {
    const subId = hash.replace('#studio-', '');
    AppState.currentStudio = subId;
    AppState.currentStep = null;
    renderStudioSection(subId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 01e — BRAND VOICE GUIDE (tab inside Step 01)
// ═══════════════════════════════════════════════════════════════════════════════

// Patch renderStep01 to inject the Voice Guide tab button
const _origRenderStep01 = renderStep01;
function renderStep01() {
  const html = _origRenderStep01();
  // Inject "Voice Guide" tab button into Step 01's tab bar
  return html.replace(
    'onclick="switchTab(\'01\',\'contact\',this)">Contact Form</button>',
    'onclick="switchTab(\'01\',\'contact\',this)">Contact Form</button>' +
    '<button class="tab-btn" onclick="switchTab(\'01\',\'voice\',this);loadVoiceGuide()">Voice Guide</button>'
  ).replace(
    // Inject the tab pane placeholder before the closing of renderLayout's content
    // We append it before </div> at the very end of the form HTML block
    '<div id="tab-contact" class="tab-pane hidden">',
    '<div id="tab-voice" class="tab-pane hidden"><div id="voice-guide-pane"><div class="empty-state-sm"><div class="spinner"></div> Loading…</div></div></div>' +
    '<div id="tab-contact" class="tab-pane hidden">'
  );
}

async function loadVoiceGuide() {
  const slug = AppState.slug;
  if (!slug) return;
  const pane = document.getElementById('voice-guide-pane');
  if (!pane) return;
  pane.innerHTML = `<div class="progress-row"><div class="spinner"></div><span>Loading voice guide…</span></div>`;
  try {
    const data = await api('GET', `/voice-guide/${slug}`);
    pane.innerHTML = renderVoiceGuideTab(data || {});
    initVoiceUploadZone();
  } catch(e) {
    pane.innerHTML = renderVoiceGuideTab({});
    initVoiceUploadZone();
  }
}

function renderVoiceGuideTab(data) {
  const docs = data.documents || [];
  const idx = data.index || {};
  const idxStatus = idx.index_status || 'empty';
  const profile = idx.voice_profile || {};

  const statusBadgeVoice = (s) => {
    const map = { empty: 'badge-muted', pending: 'badge-amber', indexing: 'badge-amber', ready: 'badge-green' };
    return `<span class="badge ${map[s] || 'badge-muted'}">${s}</span>`;
  };

  const docsTable = docs.length ? `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>Filename</th><th>Type</th><th>Size</th><th>Uploaded</th><th>Action</th></tr></thead>
        <tbody>
          ${docs.map(d => `
            <tr>
              <td class="mono">${esc(d.filename || '')}</td>
              <td><span class="badge badge-blue">${esc(d.type || 'Other')}</span></td>
              <td>${d.size_bytes ? Math.round(d.size_bytes / 1024) + ' KB' : '—'}</td>
              <td>${timeSince(d.uploaded_at)}</td>
              <td><button class="btn btn-ghost btn-sm btn-danger" onclick="deleteVoiceDoc('${esc(d.filename)}')">Delete</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` :
    `<div class="empty-state-sm">No documents uploaded yet. Add writing instructions, example posts, or grammar rules.</div>`;

  const spinnerIfIndexing = idxStatus === 'indexing' ? `<div class="spinner" style="display:inline-block;margin-left:8px;" id="voice-index-spinner"></div>` : '';

  const profileBlock = (idxStatus === 'ready' && Object.keys(profile).length) ? `
    <div class="card-expandable" id="voice-profile-expander">
      <div class="card-expandable-header" onclick="toggleVoiceProfile()">
        <span style="font-size:13px;font-weight:600;color:var(--text-primary)">View Voice Profile</span>
        <svg class="chevron" id="voice-profile-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 6 8 10 12 6"/></svg>
      </div>
      <div class="card-expandable-body" id="voice-profile-body">
        <div class="card-expandable-body-inner">
          ${profile.tone ? `<div class="form-group"><label class="form-label">Tone</label><p style="color:var(--text-secondary);font-size:13px">${esc(profile.tone)}</p></div>` : ''}
          ${profile.style_rules?.length ? `<div class="form-group"><label class="form-label">Style Rules</label><p style="color:var(--text-secondary);font-size:13px">${profile.style_rules.map(esc).join(', ')}</p></div>` : ''}
          ${profile.avoid?.length ? `<div class="form-group"><label class="form-label">Avoid</label><p style="color:var(--text-secondary);font-size:13px">${profile.avoid.map(esc).join(', ')}</p></div>` : ''}
          ${profile.grammar_rules?.length ? `<div class="form-group"><label class="form-label">Grammar Rules</label><ul style="color:var(--text-secondary);font-size:13px;padding-left:16px">${profile.grammar_rules.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
          ${(profile.persona_ceo || profile.persona_vp_sales || profile.persona_company) ? `
            <div class="form-group"><label class="form-label">Persona Voices</label>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                ${profile.persona_ceo ? `<span class="badge badge-purple">CEO</span>` : ''}
                ${profile.persona_vp_sales ? `<span class="badge badge-blue">VP Sales</span>` : ''}
                ${profile.persona_company ? `<span class="badge badge-green">Company Page</span>` : ''}
              </div>
            </div>` : ''}
        </div>
      </div>
    </div>` : '';

  return `
    <div class="card" style="margin-bottom:16px">
      <div class="card-header">
        <div>
          <h3 class="card-title">Brand Voice Guide</h3>
          <p class="card-subtitle">Upload documents that define your brand's voice — writing instructions, example posts, grammar rules. The machine reads these before every content generation.</p>
        </div>
      </div>

      <!-- Upload Zone -->
      <div class="voice-upload-zone" id="voice-upload-zone">
        <div class="voice-upload-icon">📄</div>
        <p class="voice-upload-text">Drag &amp; drop files here, or click to browse</p>
        <p class="voice-upload-hint">Accepts .txt, .md, .pdf, .docx, .html — max 5 MB each</p>
        <input type="file" id="voice-file-input" accept=".txt,.md,.pdf,.docx,.html" style="display:none" onchange="handleVoiceFileSelect(event)">
      </div>

      <div class="action-row" style="margin-top:12px;flex-wrap:wrap;gap:12px">
        <div class="form-group" style="margin:0">
          <label class="form-label">Document Type</label>
          <select class="form-select" id="voice-doc-type">
            <option>Instructions</option>
            <option>Example Writing</option>
            <option>Grammar Rules</option>
            <option>Persona Notes</option>
            <option>Other</option>
          </select>
        </div>
        <button class="btn btn-primary" onclick="uploadVoiceDoc()" id="voice-upload-btn" style="align-self:flex-end">
          Upload Document
        </button>
      </div>
    </div>

    <!-- Documents List -->
    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><h3 class="card-title">Uploaded Documents</h3></div>
      <div id="voice-docs-table">${docsTable}</div>
    </div>

    <!-- Index Status -->
    <div class="card">
      <div class="card-header">
        <div>
          <h3 class="card-title">Index Status ${statusBadgeVoice(idxStatus)}${spinnerIfIndexing}</h3>
          ${idx.indexed_at ? `<p class="card-subtitle">Last indexed: ${timeSince(idx.indexed_at)} &middot; ${idx.document_count || 0} documents</p>` : ''}
        </div>
        <button class="btn btn-secondary btn-sm" id="reindex-btn" onclick="reindexVoiceGuide()">Re-index Now</button>
      </div>
      ${profileBlock}
    </div>`;
}

function toggleVoiceProfile() {
  const body = document.getElementById('voice-profile-body');
  const chev = document.getElementById('voice-profile-chevron');
  if (!body) return;
  body.classList.toggle('open');
  if (chev) chev.classList.toggle('open');
}

function initVoiceUploadZone() {
  const zone = document.getElementById('voice-upload-zone');
  const input = document.getElementById('voice-file-input');
  if (!zone || !input) return;
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; handleVoiceFileSelect({ target: input }); }
  });
}

// Holds the pending file to upload
let _voicePendingFile = null;
function handleVoiceFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast('File too large — max 5 MB', 'error'); return; }
  _voicePendingFile = file;
  const zone = document.getElementById('voice-upload-zone');
  if (zone) {
    zone.querySelector('.voice-upload-text').textContent = `Ready to upload: ${file.name}`;
  }
}

async function uploadVoiceDoc() {
  if (!_voicePendingFile) { showToast('Select a file first', 'warning'); return; }
  const slug = AppState.slug;
  const type = document.getElementById('voice-doc-type')?.value || 'Other';
  const btn = document.getElementById('voice-upload-btn');
  const origText = btn ? btn.textContent : 'Upload Document';
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Uploading…'; }

  try {
    const fd = new FormData();
    fd.append('document', _voicePendingFile);
    fd.append('type', type);
    const res = await fetch(`/api/voice-guide/${slug}/upload`, {
      method: 'POST',
      credentials: 'include',
      body: fd
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `HTTP ${res.status}`); }
    showToast('Document uploaded', 'success');
    _voicePendingFile = null;
    await loadVoiceGuide();
  } catch(e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

async function deleteVoiceDoc(filename) {
  if (!confirm(`Delete "${filename}"?`)) return;
  const slug = AppState.slug;
  try {
    await api('DELETE', `/voice-guide/${slug}/${encodeURIComponent(filename)}`);
    showToast('Document deleted', 'success');
    await loadVoiceGuide();
  } catch(e) { showToast(e.message, 'error'); }
}

// Poll voice index status
let _voiceIndexPollIv = null;
function startVoiceIndexPoll() {
  if (_voiceIndexPollIv) return;
  _voiceIndexPollIv = setInterval(async () => {
    try {
      const data = await api('GET', `/voice-guide/${AppState.slug}`);
      const status = data?.index?.index_status;
      if (status && status !== 'indexing') {
        clearInterval(_voiceIndexPollIv);
        _voiceIndexPollIv = null;
        const pane = document.getElementById('voice-guide-pane');
        if (pane) pane.innerHTML = renderVoiceGuideTab(data || {});
        initVoiceUploadZone();
        showToast('Voice index ready!', 'success');
      }
    } catch(e) { /* swallow */ }
  }, 5000);
}

async function reindexVoiceGuide() {
  const slug = AppState.slug;
  const btn = document.getElementById('reindex-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Indexing…'; }
  try {
    await api('POST', `/voice-guide/${slug}/reindex`);
    showToast('Indexing started…', 'info');
    startVoiceIndexPoll();
  } catch(e) {
    showToast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Re-index Now'; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTENT STUDIO — Main section renderer
// ═══════════════════════════════════════════════════════════════════════════════

async function renderStudioSection(subId) {
  const app = document.getElementById('app');
  if (!app) return;
  if (!AppState.authenticated) { await renderStep00(); return; }

  // Show a loading shell immediately with sidebar
  const loadingContent = `
    <div class="step-header">
      <div class="step-header-num">✦</div>
      <div><h1 class="step-header-title">Content Studio</h1></div>
    </div>
    <div class="progress-row"><div class="spinner"></div><span>Loading…</span></div>`;
  app.innerHTML = renderLayout(loadingContent);

  try {
    if (subId === 'cs-drafts') await renderCsDrafts();
    else if (subId === 'cs-atoms') await renderCsAtoms();
    else if (subId === 'cs-images') await renderCsImages();
    else if (subId === 'cs-export') await renderCsExport();
  } catch(e) {
    showToast('Failed to load Content Studio: ' + e.message, 'error');
  }
}

// ─── cs-drafts ────────────────────────────────────────────────────────────────

let _studioSettings = {};

async function renderCsDrafts() {
  const slug = AppState.slug;
  let drafts = [], settings = {};
  try {
    const [dr, st] = await Promise.all([
      api('GET', `/studio/${slug}/drafts`),
      api('GET', `/studio/${slug}/settings`)
    ]);
    drafts = dr?.drafts || [];
    settings = st?.settings || {};
    _studioSettings = settings;
  } catch(e) { /* partial data is ok */ }

  const requireApproval = settings.require_approval !== false;
  const plagThreshold = settings.plagiarism_threshold ?? 30;

  const total = drafts.length;
  const countDraft = drafts.filter(d => d.status === 'draft').length;
  const countPending = drafts.filter(d => d.status === 'pending_approval').length;
  const countApproved = drafts.filter(d => d.status === 'approved').length;
  const countPublished = drafts.filter(d => d.status === 'published').length;

  const draftCards = drafts.length
    ? drafts.map(d => renderDraftCard(d, requireApproval)).join('')
    : `<div class="empty-state"><div class="empty-icon">✍</div><p>No content drafts yet. Approve content briefs in Step 07 to generate drafts.</p></div>`;

  const html = `
    ${stepHeader('✦', 'Content Drafts', 'AI-generated content drafts ready for review, editing, and publishing.')}

    <div class="stat-row">
      ${statCard('Total Pieces', total)}
      ${statCard('Draft', countDraft)}
      ${statCard('Pending Approval', countPending)}
      ${statCard('Approved', countApproved)}
      ${statCard('Published', countPublished)}
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="action-row" style="flex-wrap:wrap;gap:20px">
        <div style="display:flex;align-items:center;gap:12px">
          <span class="form-label" style="margin:0">Require Approval</span>
          <label class="toggle-switch">
            <input type="checkbox" id="toggle-approval" ${requireApproval ? 'checked' : ''} onchange="saveStudioSettings()">
            <span class="toggle-slider"></span>
          </label>
          <span class="form-hint" style="margin:0" id="approval-label">${requireApproval ? 'ON' : 'OFF'}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="form-label" style="margin:0">Plagiarism Threshold</span>
          <input type="number" class="form-input" id="plag-threshold" value="${plagThreshold}" min="5" max="100" style="width:70px" onchange="saveStudioSettings()">
          <span class="form-hint" style="margin:0">%</span>
        </div>
        <button class="btn btn-primary btn-sm" onclick="generateAllDrafts(this)">Generate All Pending</button>
      </div>
    </div>

    <div id="draft-cards-container">${draftCards}</div>`;

  const app = document.getElementById('app');
  if (app) app.innerHTML = renderLayout(html);
}

function renderDraftCard(d, requireApproval) {
  const statusMap = { brief_ready: 'badge-muted', draft: 'badge-blue', pending_approval: 'badge-amber', approved: 'badge-green', published: 'badge-green' };
  const statusCls = statusMap[d.status] || 'badge-muted';
  const ctaMap = { Demo: 'badge-purple', 'Lead Magnet 1': 'badge-blue', 'Lead Magnet 2': 'badge-blue', 'Lead Magnet 3': 'badge-blue', Custom: 'badge-amber' };
  const ctaCls = ctaMap[d.cta_assignment] || 'badge-muted';
  const wordCount = d.word_count || 0;
  const readTime = wordCount ? Math.ceil(wordCount / 200) : 0;
  const plagScore = d.plagiarism_score != null ? `· Plag: ${d.plagiarism_score}%` : '';

  const actionBtns = [];
  if (d.status === 'brief_ready') actionBtns.push(`<button class="btn btn-primary btn-sm" onclick="generateDraft('${d.id}',this)">Generate</button>`);
  if (['draft','pending_approval','approved'].includes(d.status)) actionBtns.push(`<button class="btn btn-secondary btn-sm" onclick="expandDraftCard('${d.id}')">Edit</button>`);
  if (['draft','pending_approval','approved'].includes(d.status)) actionBtns.push(`<button class="btn btn-secondary btn-sm" onclick="checkPlagiarism('${d.id}',this)">Check Plagiarism</button>`);
  if (['draft','pending_approval','approved'].includes(d.status)) actionBtns.push(`<button class="btn btn-secondary btn-sm" onclick="addCrossLinks('${d.id}',this)">Cross-Links</button>`);
  if (d.status === 'draft' && requireApproval) actionBtns.push(`<button class="btn btn-success btn-sm" onclick="approveDraft('${d.id}',this)">Approve</button>`);
  if (['draft','approved'].includes(d.status)) actionBtns.push(`<button class="btn btn-ghost btn-sm" onclick="atomizeDraft('${d.id}',this)">Atomize</button>`);
  if (['approved','published'].includes(d.status)) actionBtns.push(`<button class="btn btn-ghost btn-sm" onclick="expandDraftCard('${d.id}','export')">Export</button>`);

  return `
    <div class="draft-card" id="draft-card-${d.id}">
      <div class="draft-card-header" onclick="expandDraftCard('${d.id}')">
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
          <span class="badge ${statusCls}">${d.status || 'brief_ready'}</span>
          ${d.cta_assignment ? `<span class="badge ${ctaCls}">${esc(d.cta_assignment)}</span>` : ''}
          <span class="draft-title">${esc(d.primary_keyword || d.title || 'Untitled')}</span>
        </div>
        <span class="draft-card-meta">${wordCount ? `${formatNum(wordCount)} words · ${readTime}m read ${plagScore}` : ''}</span>
      </div>
      <div class="draft-card-actions">${actionBtns.join('')}</div>
      <div class="draft-card-body hidden" id="draft-body-${d.id}"></div>
    </div>`;
}

async function expandDraftCard(draftId, defaultTab) {
  const bodyEl = document.getElementById(`draft-body-${draftId}`);
  if (!bodyEl) return;
  // Toggle if already open and no tab override
  if (!bodyEl.classList.contains('hidden') && !defaultTab) {
    bodyEl.classList.add('hidden');
    return;
  }
  bodyEl.classList.remove('hidden');
  bodyEl.innerHTML = `<div class="progress-row"><div class="spinner"></div><span>Loading draft…</span></div>`;

  try {
    const slug = AppState.slug;
    const data = await api('GET', `/studio/${slug}/drafts/${draftId}`);
    bodyEl.innerHTML = renderDraftExpanded(data?.draft || {}, defaultTab);
    initDraftEditor(draftId, data?.draft || {});
  } catch(e) {
    bodyEl.innerHTML = `<div class="empty-state-sm">Failed to load draft: ${esc(e.message)}</div>`;
  }
}

function renderDraftExpanded(d, defaultTab) {
  const activeTab = defaultTab || 'editor';
  const tabs = [
    ['editor', 'Editor'],
    ['plagiarism', 'Plagiarism'],
    ['linkedin', 'LinkedIn Posts'],
    ['export', 'Export']
  ];
  const tabBar = `
    <div class="tab-bar" id="tab-bar-draft-${d.id}">
      ${tabs.map(([id, label]) => `<button class="tab-btn ${activeTab===id?'active':''}" onclick="switchDraftTab('${d.id}','${id}',this)">${label}</button>`).join('')}
    </div>`;

  const editorTab = renderDraftEditorTab(d);
  const plagTab = renderDraftPlagiarismTab(d);
  const linkedinTab = renderDraftLinkedInTab(d);
  const exportTab = renderDraftExportTab(d);

  return `
    ${tabBar}
    <div id="draft-tab-editor-${d.id}" class="draft-tab-pane ${activeTab==='editor'?'':'hidden'}">${editorTab}</div>
    <div id="draft-tab-plagiarism-${d.id}" class="draft-tab-pane ${activeTab==='plagiarism'?'':'hidden'}">${plagTab}</div>
    <div id="draft-tab-linkedin-${d.id}" class="draft-tab-pane ${activeTab==='linkedin'?'':'hidden'}">${linkedinTab}</div>
    <div id="draft-tab-export-${d.id}" class="draft-tab-pane ${activeTab==='export'?'':'hidden'}">${exportTab}</div>`;
}

function switchDraftTab(draftId, tabId, btn) {
  const bar = document.getElementById(`tab-bar-draft-${draftId}`);
  if (bar) bar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.querySelectorAll(`[id^="draft-tab-"][id$="-${draftId}"]`).forEach(p => p.classList.add('hidden'));
  const pane = document.getElementById(`draft-tab-${tabId}-${draftId}`);
  if (pane) pane.classList.remove('hidden');
}

function renderDraftEditorTab(d) {
  const requireApproval = _studioSettings.require_approval !== false;
  const ctaMode = d.cta_mode || 'auto';
  const approveBtn = (d.status === 'draft' && requireApproval)
    ? `<button class="btn btn-success btn-sm" onclick="approveDraft('${d.id}',this)">Approve Draft</button>`
    : '';
  const publishBtn = (!requireApproval || d.status === 'approved')
    ? `<button class="btn btn-primary btn-sm" onclick="publishDraft('${d.id}',this)">Publish Without Approval</button>`
    : '';

  return `
    <div style="padding:16px 0">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px">
        <span id="draft-word-count-${d.id}" style="font-size:12px;color:var(--text-muted)">${d.word_count ? `${formatNum(d.word_count)} words` : ''}</span>
        <div class="action-row" style="gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" onclick="checkPlagiarism('${d.id}',this)">Check Plagiarism</button>
          <button class="btn btn-ghost btn-sm" onclick="addCrossLinks('${d.id}',this)">Insert Cross-Links</button>
          ${approveBtn}
          ${publishBtn}
        </div>
      </div>

      <!-- CTA Mode -->
      <div class="cta-toggle-row" style="margin-bottom:12px">
        <span class="form-label" style="margin:0">CTA Mode</span>
        <select class="form-select" id="cta-mode-${d.id}" style="width:auto" onchange="ctaModeChanged('${d.id}')">
          <option value="auto" ${ctaMode==='auto'?'selected':''}>Auto</option>
          <option value="manual" ${ctaMode==='manual'?'selected':''}>Manual</option>
        </select>
        <div id="cta-mode-detail-${d.id}">
          ${ctaMode === 'manual'
            ? `<select class="form-select" id="cta-manual-val-${d.id}" style="width:auto" onchange="saveCTAMode('${d.id}')">
                ${['Demo','Lead Magnet 1','Lead Magnet 2','Lead Magnet 3','Custom'].map(v => `<option ${d.cta_assignment===v?'selected':''}>${v}</option>`).join('')}
               </select>`
            : `<span style="font-size:12px;color:var(--text-muted)">Auto-selected: ${esc(d.cta_assignment||'—')} ${d.cta_auto_reasoning ? '— ' + esc(d.cta_auto_reasoning) : ''}</span>`
          }
        </div>
      </div>

      <!-- Contenteditable Editor -->
      <div class="draft-editor"
           id="draft-editor-${d.id}"
           contenteditable="true"
           oninput="draftEditorInput('${d.id}')"
           onblur="saveDraftBody('${d.id}')"
      >${d.body_html || '<p>No content yet. Generate or paste HTML here.</p>'}</div>
    </div>`;
}

function initDraftEditor(draftId, d) {
  // nothing extra needed — contenteditable handles it inline
}

function draftEditorInput(draftId) {
  const el = document.getElementById(`draft-editor-${draftId}`);
  const countEl = document.getElementById(`draft-word-count-${draftId}`);
  if (!el || !countEl) return;
  const text = el.innerText || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  countEl.textContent = `${formatNum(words)} words`;
}

async function saveDraftBody(draftId) {
  const el = document.getElementById(`draft-editor-${draftId}`);
  if (!el) return;
  const body_html = el.innerHTML;
  try {
    await api('PATCH', `/studio/${AppState.slug}/drafts/${draftId}`, { body_html });
  } catch(e) { showToast('Auto-save failed: ' + e.message, 'error'); }
}

function ctaModeChanged(draftId) {
  const sel = document.getElementById(`cta-mode-${draftId}`);
  const detail = document.getElementById(`cta-mode-detail-${draftId}`);
  if (!sel || !detail) return;
  const mode = sel.value;
  if (mode === 'manual') {
    detail.innerHTML = `<select class="form-select" id="cta-manual-val-${draftId}" style="width:auto" onchange="saveCTAMode('${draftId}')">
      ${['Demo','Lead Magnet 1','Lead Magnet 2','Lead Magnet 3','Custom'].map(v=>`<option>${v}</option>`).join('')}
    </select>`;
  } else {
    detail.innerHTML = `<span style="font-size:12px;color:var(--text-muted)">Auto-selected by engine</span>`;
  }
  saveCTAMode(draftId);
}

async function saveCTAMode(draftId) {
  const modeEl = document.getElementById(`cta-mode-${draftId}`);
  const manualEl = document.getElementById(`cta-manual-val-${draftId}`);
  if (!modeEl) return;
  const cta_mode = modeEl.value;
  const cta_assignment = manualEl?.value || null;
  try {
    await api('PATCH', `/studio/${AppState.slug}/drafts/${draftId}`, { cta_mode, cta_assignment });
  } catch(e) { showToast(e.message, 'error'); }
}

function renderDraftPlagiarismTab(d) {
  const score = d.plagiarism_score;
  const passages = d.plagiarism_passages || [];
  const colorCls = score == null ? '' : score < 15 ? 'plagiarism-green' : score < 30 ? 'plagiarism-amber' : 'plagiarism-red';

  return `
    <div style="padding:16px 0">
      ${score != null
        ? `<div style="text-align:center;margin-bottom:20px">
             <div class="plagiarism-score-big ${colorCls}">${score}%</div>
             <div style="color:var(--text-muted);font-size:12px">${score < 15 ? 'Clean' : score < 30 ? 'Some matches — review flagged passages' : 'High similarity — significant revision needed'}</div>
           </div>`
        : `<div class="empty-state-sm">No plagiarism check run yet.</div>`}
      ${passages.length ? `
        <h4 class="section-heading">Flagged Passages</h4>
        ${passages.map(p => `
          <div class="flagged-passage">
            <div style="margin-bottom:6px">${esc(p.text || '')}</div>
            <div style="font-size:11px;color:var(--text-muted)">Source: <a href="${esc(p.source_url||'')}" target="_blank" rel="noopener noreferrer">${esc(p.source_url||'')}</a> · ${p.match_pct}% match</div>
          </div>`).join('')}` : ''}
      <div style="margin-top:12px">
        <button class="btn btn-secondary btn-sm" onclick="checkPlagiarism('${d.id}',this)">Re-check Plagiarism</button>
      </div>
    </div>`;
}

function renderDraftLinkedInTab(d) {
  const personas = d.linkedin_personas || [];
  const posts = d.linkedin_posts || {};

  const personaForm = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-header">
        <h3 class="card-title">Personas</h3>
        <button class="btn btn-secondary btn-sm" onclick="addLinkedInPersona('${d.id}')" id="add-persona-btn-${d.id}" ${personas.length >= 3 ? 'disabled' : ''}>+ Add Person</button>
      </div>
      <div id="persona-list-${d.id}">
        ${personas.length
          ? personas.map((p, i) => `
              <div class="action-row" style="margin-bottom:10px;flex-wrap:wrap;gap:8px">
                <input class="form-input" style="flex:2;min-width:100px" id="persona-name-${d.id}-${i}" value="${esc(p.name||'')}" placeholder="Name">
                <input class="form-input" style="flex:2;min-width:100px" id="persona-title-${d.id}-${i}" value="${esc(p.title||'')}" placeholder="Title">
                <select class="form-select" style="flex:1;min-width:110px" id="persona-tone-${d.id}-${i}">
                  ${['Strategic','Tactical','Personal'].map(t=>`<option ${p.tone===t?'selected':''}>${t}</option>`).join('')}
                </select>
                <button class="btn btn-ghost btn-sm btn-danger" onclick="removeLinkedInPersona('${d.id}',${i})">✕</button>
              </div>`).join('')
          : `<div class="empty-state-sm">Add up to 3 personas before generating posts.</div>`}
      </div>
    </div>
    <div style="margin-bottom:16px">
      <button class="btn btn-primary" onclick="generateLinkedInPosts('${d.id}',this)">Generate LinkedIn Posts</button>
    </div>`;

  const postGrid = Object.keys(posts).length ? `
    <div class="linkedin-posts-grid">
      <div>
        <h4 class="section-heading">Personal Posts</h4>
        ${(posts.personal_posts || []).map((post, i) => renderLinkedInPostCard(`${d.id}-personal-${i}`, `Post ${i+1}`, post, d)).join('')}
      </div>
      <div>
        <h4 class="section-heading">Company Page Posts</h4>
        ${(posts.company_posts || []).map((post, i) => renderLinkedInPostCard(`${d.id}-company-${i}`, `Post ${i+1}`, post, d)).join('')}
      </div>
    </div>` : '';

  return `<div style="padding:16px 0">${personaForm}${postGrid}</div>`;
}

function renderLinkedInPostCard(uid, label, post, d) {
  const text = typeof post === 'string' ? post : (post?.text || '');
  const charCount = text.length;
  const overLimit = charCount > 3000;
  const imageOptions = (d.images || []).map(img => `<option value="${esc(img.filename)}">${esc(img.filename)}</option>`).join('');
  return `
    <div class="linkedin-post-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:12px;font-weight:600;color:var(--text-secondary)">${label}</span>
        <button class="btn btn-ghost btn-sm" onclick="copyToClipboard('li-post-${uid}')">Copy</button>
      </div>
      <textarea class="linkedin-post-textarea" id="li-post-${uid}" oninput="updateCharCount('li-count-${uid}',this.value)">${esc(text)}</textarea>
      <div class="char-count ${overLimit ? 'over-limit' : ''}" id="li-count-${uid}">${charCount} / 3000</div>
      ${imageOptions ? `
        <div class="form-group" style="margin-top:8px">
          <label class="form-label">Assign Image</label>
          <select class="form-select" id="li-img-${uid}">
            <option value="">No image</option>
            ${imageOptions}
          </select>
        </div>` : ''}
    </div>`;
}

function updateCharCount(countId, text) {
  const el = document.getElementById(countId);
  if (!el) return;
  const n = text.length;
  el.textContent = `${n} / 3000`;
  el.classList.toggle('over-limit', n > 3000);
}

function renderDraftExportTab(d) {
  const requireApproval = _studioSettings.require_approval !== false;
  const canExport = !requireApproval || d.status === 'approved' || d.status === 'published';
  const note = (!canExport) ? `<div class="approval-required-note">Approval required before export. Approve this draft first.</div>` : '';
  return `
    <div style="padding:16px 0">
      ${note}
      <div class="action-row" style="margin-bottom:16px;flex-wrap:wrap;gap:10px">
        <button class="btn btn-secondary" onclick="exportDraftHtml('${d.id}',this)" ${!canExport?'disabled':''}>Download as HTML</button>
        <button class="btn btn-secondary" onclick="exportDraftGoogleDoc('${d.id}',this)" ${!canExport?'disabled':''}>Export to Google Doc</button>
      </div>
      ${d.html_path ? `<div class="form-hint">HTML: <span class="mono">${esc(d.html_path)}</span></div>` : ''}
      ${d.google_doc_url ? `<div class="form-hint">Google Doc: <a href="${esc(d.google_doc_url)}" target="_blank" rel="noopener noreferrer">${esc(d.google_doc_url)}</a></div>` : ''}
    </div>`;
}

// ─── Draft action helpers ──────────────────────────────────────────────────────

async function generateDraft(draftId, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Generating…'; }
  try {
    const r = await api('POST', `/studio/${AppState.slug}/drafts/${draftId}/generate`);
    showToast('Draft generation started…', 'info');
    // Poll until draft status changes from brief_ready
    const pollId = `gen-${draftId}`;
    AppState.pollingJobs[pollId] = setInterval(async () => {
      try {
        const d = await api('GET', `/studio/${AppState.slug}/drafts/${draftId}`);
        if (d?.draft?.status && d.draft.status !== 'brief_ready') {
          clearInterval(AppState.pollingJobs[pollId]);
          delete AppState.pollingJobs[pollId];
          showToast('Draft generated!', 'success');
          await renderCsDrafts();
        }
      } catch(e) { /* swallow */ }
    }, 6000);
  } catch(e) {
    showToast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Generate'; }
  }
}

async function generateAllDrafts(btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Generating…'; }
  try {
    await api('POST', `/studio/${AppState.slug}/drafts/generate-all`);
    showToast('Bulk generation started — this may take several minutes.', 'info');
    setTimeout(() => renderCsDrafts(), 3000);
  } catch(e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Generate All Pending'; }
  }
}

async function checkPlagiarism(draftId, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>'; }
  try {
    await api('POST', `/studio/${AppState.slug}/drafts/${draftId}/plagiarism`);
    showToast('Plagiarism check started…', 'info');
    const pollId = `plag-${draftId}`;
    AppState.pollingJobs[pollId] = setInterval(async () => {
      try {
        const d = await api('GET', `/studio/${AppState.slug}/drafts/${draftId}`);
        if (d?.draft?.plagiarism_score != null) {
          clearInterval(AppState.pollingJobs[pollId]);
          delete AppState.pollingJobs[pollId];
          // Refresh expanded body if open
          const bodyEl = document.getElementById(`draft-body-${draftId}`);
          if (bodyEl && !bodyEl.classList.contains('hidden')) {
            bodyEl.innerHTML = renderDraftExpanded(d.draft, 'plagiarism');
          }
          showToast(`Plagiarism score: ${d.draft.plagiarism_score}%`, 'info');
        }
      } catch(e) { /* swallow */ }
    }, 5000);
  } catch(e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check Plagiarism'; }
  }
}

async function addCrossLinks(draftId, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>'; }
  try {
    const r = await api('POST', `/studio/${AppState.slug}/drafts/${draftId}/crosslinks`);
    showToast(`Cross-links added: ${r?.links_added ?? 0}`, 'success');
  } catch(e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Cross-Links'; }
  }
}

async function approveDraft(draftId, btn) {
  if (btn) { btn.disabled = true; }
  try {
    await api('PATCH', `/studio/${AppState.slug}/drafts/${draftId}`, { status: 'approved' });
    showToast('Draft approved', 'success');
    await renderCsDrafts();
  } catch(e) {
    showToast(e.message, 'error');
    if (btn) { btn.disabled = false; }
  }
}

async function publishDraft(draftId, btn) {
  if (btn) { btn.disabled = true; }
  try {
    await api('PATCH', `/studio/${AppState.slug}/drafts/${draftId}`, { status: 'published' });
    showToast('Draft published', 'success');
    await renderCsDrafts();
  } catch(e) {
    showToast(e.message, 'error');
    if (btn) { btn.disabled = false; }
  }
}

async function atomizeDraft(draftId, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Atomizing…'; }
  try {
    await api('POST', `/studio/${AppState.slug}/drafts/${draftId}/atomize`);
    showToast('Atomization started…', 'info');
    setTimeout(() => expandDraftCard(draftId, 'linkedin'), 2000);
  } catch(e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Atomize'; }
  }
}

async function exportDraftHtml(draftId, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>'; }
  try {
    const r = await api('POST', `/studio/${AppState.slug}/drafts/${draftId}/export/html`);
    if (r?.download_url) window.open(r.download_url, '_blank');
    else showToast('HTML export ready', 'success');
  } catch(e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Download as HTML'; }
  }
}

async function exportDraftGoogleDoc(draftId, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>'; }
  try {
    const r = await api('POST', `/studio/${AppState.slug}/drafts/${draftId}/export/googledoc`);
    if (r?.google_doc_url) {
      showToast('Google Doc created!', 'success');
      window.open(r.google_doc_url, '_blank');
    }
  } catch(e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Export to Google Doc'; }
  }
}

function addLinkedInPersona(draftId) {
  // Re-render the LinkedIn tab after adding a persona row — minimal approach
  const list = document.getElementById(`persona-list-${draftId}`);
  const addBtn = document.getElementById(`add-persona-btn-${draftId}`);
  if (!list) return;
  const existing = list.querySelectorAll('.action-row').length;
  if (existing >= 3) return;
  const i = existing;
  const row = document.createElement('div');
  row.className = 'action-row';
  row.style.cssText = 'margin-bottom:10px;flex-wrap:wrap;gap:8px';
  row.innerHTML = `
    <input class="form-input" style="flex:2;min-width:100px" id="persona-name-${draftId}-${i}" placeholder="Name">
    <input class="form-input" style="flex:2;min-width:100px" id="persona-title-${draftId}-${i}" placeholder="Title">
    <select class="form-select" style="flex:1;min-width:110px" id="persona-tone-${draftId}-${i}">
      <option>Strategic</option><option>Tactical</option><option>Personal</option>
    </select>
    <button class="btn btn-ghost btn-sm btn-danger" onclick="this.parentElement.remove()">✕</button>`;
  list.appendChild(row);
  if (addBtn) addBtn.disabled = list.querySelectorAll('.action-row').length >= 3;
}

function removeLinkedInPersona(draftId, i) {
  const list = document.getElementById(`persona-list-${draftId}`);
  const addBtn = document.getElementById(`add-persona-btn-${draftId}`);
  if (!list) return;
  const rows = list.querySelectorAll('.action-row');
  if (rows[i]) rows[i].remove();
  if (addBtn) addBtn.disabled = false;
}

async function generateLinkedInPosts(draftId, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Generating…'; }

  // Collect personas from DOM
  const personas = [];
  let i = 0;
  while (true) {
    const nameEl = document.getElementById(`persona-name-${draftId}-${i}`);
    if (!nameEl) break;
    personas.push({
      name: nameEl.value.trim(),
      title: document.getElementById(`persona-title-${draftId}-${i}`)?.value.trim() || '',
      tone: document.getElementById(`persona-tone-${draftId}-${i}`)?.value || 'Strategic'
    });
    i++;
  }

  try {
    await api('POST', `/studio/${AppState.slug}/drafts/${draftId}/atomize`, { personas });
    showToast('LinkedIn posts being generated…', 'info');
    // Poll for completion
    const pollId = `atom-${draftId}`;
    AppState.pollingJobs[pollId] = setInterval(async () => {
      try {
        const d = await api('GET', `/studio/${AppState.slug}/drafts/${draftId}`);
        if (d?.draft?.linkedin_posts && Object.keys(d.draft.linkedin_posts).length) {
          clearInterval(AppState.pollingJobs[pollId]);
          delete AppState.pollingJobs[pollId];
          const bodyEl = document.getElementById(`draft-body-${draftId}`);
          if (bodyEl && !bodyEl.classList.contains('hidden')) {
            bodyEl.innerHTML = renderDraftExpanded(d.draft, 'linkedin');
          }
          showToast('LinkedIn posts ready!', 'success');
        }
      } catch(e) { /* swallow */ }
    }, 5000);
  } catch(e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Generate LinkedIn Posts'; }
  }
}

async function saveStudioSettings() {
  const requireApproval = document.getElementById('toggle-approval')?.checked;
  const plagThreshold = parseInt(document.getElementById('plag-threshold')?.value || '30');
  const label = document.getElementById('approval-label');
  if (label) label.textContent = requireApproval ? 'ON' : 'OFF';
  try {
    await api('PATCH', `/studio/${AppState.slug}/settings`, {
      require_approval: requireApproval,
      plagiarism_threshold: plagThreshold
    });
    _studioSettings.require_approval = requireApproval;
    _studioSettings.plagiarism_threshold = plagThreshold;
  } catch(e) { showToast(e.message, 'error'); }
}

function copyToClipboard(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const text = el.tagName === 'TEXTAREA' ? el.value : el.innerText;
  navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success'));
}

// ─── cs-atoms ─────────────────────────────────────────────────────────────────

async function renderCsAtoms() {
  const slug = AppState.slug;
  let drafts = [];
  try {
    const dr = await api('GET', `/studio/${slug}/drafts`);
    drafts = (dr?.drafts || []).filter(d => d.linkedin_posts && Object.keys(d.linkedin_posts).length > 0);
  } catch(e) { /* partial */ }

  const cards = drafts.length
    ? drafts.map(d => {
        const posts = d.linkedin_posts || {};
        const allPosts = [...(posts.personal_posts||[]), ...(posts.company_posts||[])];
        const previews = allPosts.slice(0, 6).map(p => {
          const text = typeof p === 'string' ? p : (p?.text || '');
          return `<div class="atom-preview-item">${esc(truncate(text, 100))}</div>`;
        }).join('');
        return `
          <div class="draft-card" style="cursor:pointer" onclick="navigateStudio('cs-drafts');setTimeout(()=>expandDraftCard('${d.id}','linkedin'),600)">
            <div class="draft-card-header">
              <span class="draft-title">${esc(d.primary_keyword || d.title || 'Untitled')}</span>
              <span class="badge badge-green">${allPosts.length} posts</span>
            </div>
            <div class="atom-previews">${previews}</div>
          </div>`;
      }).join('')
    : `<div class="empty-state"><div class="empty-icon">⚡</div><p>No atomized drafts yet. Approve and atomize drafts in Content Drafts.</p></div>`;

  const html = `
    ${stepHeader('⚡', 'Atomizer', 'All drafts with LinkedIn posts generated.')}
    <div style="margin-bottom:16px">
      <button class="btn btn-primary" onclick="atomizeAllApproved(this)">Generate All (Approved Drafts)</button>
    </div>
    <div id="atoms-container">${cards}</div>`;

  const app = document.getElementById('app');
  if (app) app.innerHTML = renderLayout(html);
}

async function atomizeAllApproved(btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Atomizing…'; }
  try {
    await api('POST', `/studio/${AppState.slug}/atomize-all`);
    showToast('Bulk atomization started…', 'info');
    setTimeout(() => renderCsAtoms(), 4000);
  } catch(e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Generate All (Approved Drafts)'; }
  }
}

// ─── cs-images ────────────────────────────────────────────────────────────────

async function renderCsImages() {
  const slug = AppState.slug;
  let images = [];
  try {
    const r = await api('GET', `/studio/${slug}/images`);
    images = r?.images || [];
  } catch(e) { /* partial */ }

  const grid = images.length
    ? images.map(img => `
        <div class="image-card" id="img-card-${img.filename}">
          <img src="/assets/${slug}/images/${encodeURIComponent(img.filename)}" alt="${esc(img.filename)}" loading="lazy">
          <div class="image-card-footer">
            <div style="font-size:12px;font-weight:500;color:var(--text-primary);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(img.filename)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">${img.size_bytes ? Math.round(img.size_bytes/1024) + ' KB' : ''}</div>
            <div class="tag-cloud" id="img-tags-${img.filename}">
              ${(img.tags||[]).map(t=>`<span class="tag-chip">${esc(t)}</span>`).join('')}
              <input class="form-input" style="width:80px;padding:2px 6px;font-size:11px;height:22px" placeholder="+ tag" onkeydown="addImageTag('${esc(img.filename)}',this,event)">
            </div>
            <button class="btn btn-ghost btn-sm btn-danger" style="margin-top:6px;width:100%" onclick="deleteImage('${esc(img.filename)}')">Delete</button>
          </div>
        </div>`).join('')
    : `<div class="empty-state"><div class="empty-icon">🖼</div><p>No images uploaded yet.</p></div>`;

  const html = `
    ${stepHeader('🖼', 'Image Library', 'Upload and tag images to attach to LinkedIn posts and content.')}

    <div class="card" style="margin-bottom:16px">
      <div class="voice-upload-zone" id="image-upload-zone">
        <div class="voice-upload-icon">🖼</div>
        <p class="voice-upload-text">Drag &amp; drop images here, or click to browse</p>
        <p class="voice-upload-hint">Accepts PNG, JPG, GIF, WebP, SVG</p>
        <input type="file" id="image-file-input" accept="image/*" multiple style="display:none" onchange="handleImageUpload(event)">
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Uploaded Images (${images.length})</h3>
        <div style="display:flex;align-items:center;gap:8px">
          <input class="form-input" id="image-filter" placeholder="Filter by tag…" oninput="filterImages(this.value)" style="width:160px">
        </div>
      </div>
      <div class="image-grid" id="image-grid">${grid}</div>
    </div>`;

  const app = document.getElementById('app');
  if (app) {
    app.innerHTML = renderLayout(html);
    initImageUploadZone();
  }
}

function initImageUploadZone() {
  const zone = document.getElementById('image-upload-zone');
  const input = document.getElementById('image-file-input');
  if (!zone || !input) return;
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleImageUpload({ target: { files: e.dataTransfer.files } });
  });
}

async function handleImageUpload(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  const slug = AppState.slug;
  let uploaded = 0;
  for (const file of files) {
    const fd = new FormData();
    fd.append('image', file);
    try {
      const res = await fetch(`/api/studio/${slug}/images/upload`, {
        method: 'POST',
        credentials: 'include',
        body: fd
      });
      if (!res.ok) { const err = await res.json().catch(()=>({})); throw new Error(err.error || `HTTP ${res.status}`); }
      uploaded++;
    } catch(err) { showToast(`Failed to upload ${file.name}: ${err.message}`, 'error'); }
  }
  if (uploaded) { showToast(`${uploaded} image(s) uploaded`, 'success'); await renderCsImages(); }
}

async function addImageTag(filename, input, event) {
  if (event.key !== 'Enter') return;
  const tag = input.value.trim();
  if (!tag) return;
  input.value = '';
  try {
    await api('PATCH', `/studio/${AppState.slug}/images/${encodeURIComponent(filename)}/tags`, { add: [tag] });
    const cloud = document.getElementById(`img-tags-${filename}`);
    if (cloud) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = tag;
      cloud.insertBefore(chip, input);
    }
  } catch(e) { showToast(e.message, 'error'); }
}

async function deleteImage(filename) {
  if (!confirm(`Delete image "${filename}"?`)) return;
  try {
    await api('DELETE', `/studio/${AppState.slug}/images/${encodeURIComponent(filename)}`);
    showToast('Image deleted', 'success');
    const card = document.getElementById(`img-card-${filename}`);
    if (card) card.remove();
  } catch(e) { showToast(e.message, 'error'); }
}

function filterImages(tag) {
  const grid = document.getElementById('image-grid');
  if (!grid) return;
  const cards = grid.querySelectorAll('.image-card');
  cards.forEach(card => {
    const chips = card.querySelectorAll('.tag-chip');
    const tags = Array.from(chips).map(c => c.textContent.toLowerCase());
    const show = !tag || tags.some(t => t.includes(tag.toLowerCase()));
    card.style.display = show ? '' : 'none';
  });
}

// ─── cs-export ────────────────────────────────────────────────────────────────

async function renderCsExport() {
  const slug = AppState.slug;
  let drafts = [], settings = {};
  try {
    const [dr, st] = await Promise.all([
      api('GET', `/studio/${slug}/drafts`),
      api('GET', `/studio/${slug}/settings`)
    ]);
    drafts = dr?.drafts || [];
    settings = st?.settings || {};
  } catch(e) { /* partial */ }

  const approvedDrafts = drafts.filter(d => ['approved','published'].includes(d.status));
  const tableRows = drafts.map(d => `
    <tr>
      <td>${esc(d.primary_keyword || d.title || 'Untitled')}</td>
      <td><span class="badge ${d.status==='approved'?'badge-green':d.status==='published'?'badge-green':'badge-muted'}">${esc(d.status||'draft')}</span></td>
      <td>${d.html_path ? `<a class="btn btn-ghost btn-sm" href="${esc(d.html_path)}" download>Download</a>` : '—'}</td>
      <td>${d.google_doc_url ? `<a href="${esc(d.google_doc_url)}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm">Open</a>` : '—'}</td>
      <td class="action-row" style="gap:6px">
        <button class="btn btn-secondary btn-sm" onclick="exportDraftHtml('${d.id}',this)" ${['approved','published'].includes(d.status)?'':'disabled'}>HTML</button>
        <button class="btn btn-secondary btn-sm" onclick="exportDraftGoogleDoc('${d.id}',this)" ${['approved','published'].includes(d.status)?'':'disabled'}>Google Doc</button>
      </td>
    </tr>`).join('');

  const html = `
    ${stepHeader('📤', 'Export', 'Export approved content as HTML files or Google Docs.')}

    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><h3 class="card-title">Quick Export</h3></div>
      <div class="action-row" style="flex-wrap:wrap;gap:10px;margin-bottom:16px">
        <button class="btn btn-primary" onclick="exportAllHtml(this)" ${approvedDrafts.length ? '' : 'disabled'}>Export All Approved as HTML</button>
        <button class="btn btn-secondary" onclick="exportAllGoogleDocs(this)" ${approvedDrafts.length ? '' : 'disabled'}>Export All Approved to Google Doc</button>
      </div>
      <div class="form-group">
        <label class="form-label">Google Drive Folder ID <span class="form-hint">(optional — leave blank to save to My Drive)</span></label>
        <div class="action-row">
          <input class="form-input mono" id="drive-folder-id" value="${esc(settings.google_drive_folder_id||'')}" placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs">
          <button class="btn btn-secondary btn-sm" onclick="saveDriveFolderId(this)">Save</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h3 class="card-title">Export Status</h3></div>
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr><th>Draft Title</th><th>Status</th><th>HTML</th><th>Google Doc</th><th>Actions</th></tr></thead>
          <tbody>${tableRows || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No drafts yet.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  const app = document.getElementById('app');
  if (app) app.innerHTML = renderLayout(html);
}

async function exportAllHtml(btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Exporting…'; }
  try {
    await api('POST', `/studio/${AppState.slug}/export/html-all`);
    showToast('HTML export started — files will be available shortly.', 'info');
    setTimeout(() => renderCsExport(), 3000);
  } catch(e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Export All Approved as HTML'; }
  }
}

async function exportAllGoogleDocs(btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Exporting…'; }
  try {
    await api('POST', `/studio/${AppState.slug}/export/googledoc-all`);
    showToast('Google Doc export started…', 'info');
    setTimeout(() => renderCsExport(), 5000);
  } catch(e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Export All Approved to Google Doc'; }
  }
}

async function saveDriveFolderId(btn) {
  const folderId = document.getElementById('drive-folder-id')?.value.trim();
  if (btn) { btn.disabled = true; }
  try {
    await api('PATCH', `/studio/${AppState.slug}/settings`, { google_drive_folder_id: folderId });
    showToast('Drive folder saved', 'success');
  } catch(e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; }
  }
}

document.addEventListener('DOMContentLoaded', init);
