'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || './data/projects';

// ─── Directory helpers ────────────────────────────────────────────────────────

function projectDir(slug) {
  return path.resolve(DATA_DIR, slug);
}

function statePath(slug) {
  return path.join(projectDir(slug), 'state.json');
}

function assetsDir(slug) {
  return path.join(projectDir(slug), 'assets');
}

function exportsDir(slug) {
  return path.join(projectDir(slug), 'exports');
}

function voiceGuideDir(slug) {
  return path.join(projectDir(slug), 'voice-guide');
}

function imagesDir(slug) {
  return path.join(projectDir(slug), 'assets', 'images');
}

function ensureProjectDirs(slug) {
  const dirs = [
    projectDir(slug), assetsDir(slug), exportsDir(slug),
    voiceGuideDir(slug), imagesDir(slug)
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function ensureDataRoot() {
  const root = path.resolve(DATA_DIR);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
}

// ─── State read / write ───────────────────────────────────────────────────────

function getState(slug) {
  const p = statePath(slug);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse state.json for project "${slug}": ${e.message}`);
  }
}

function saveState(slug, state) {
  ensureProjectDirs(slug);
  const p = statePath(slug);
  const tmp = p + '.tmp';
  state.updated_at = new Date().toISOString();
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function updateState(slug, updates) {
  const state = getState(slug);
  if (!state) throw new Error(`Project "${slug}" not found`);
  const merged = deepMerge(state, updates);
  saveState(slug, merged);
  return merged;
}

// Deep merge — arrays and primitives from `b` replace those in `a`
// Objects are merged recursively
function deepMerge(a, b) {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return b;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return b;
  const result = Object.assign({}, a);
  for (const key of Object.keys(b)) {
    if (
      key in a &&
      typeof a[key] === 'object' && a[key] !== null && !Array.isArray(a[key]) &&
      typeof b[key] === 'object' && b[key] !== null && !Array.isArray(b[key])
    ) {
      result[key] = deepMerge(a[key], b[key]);
    } else {
      result[key] = b[key];
    }
  }
  return result;
}

// ─── Project list ─────────────────────────────────────────────────────────────

function getProjectList() {
  ensureDataRoot();
  const root = path.resolve(DATA_DIR);
  if (!fs.existsSync(root)) return [];

  const slugs = fs.readdirSync(root).filter(name => {
    const p = path.join(root, name, 'state.json');
    return fs.existsSync(p);
  });

  return slugs.map(slug => {
    try {
      const state = getState(slug);
      return {
        slug,
        project_name: state.project_name,
        primary_domain: state.config?.identity?.primary_domain || '',
        created_at: state.created_at,
        updated_at: state.updated_at,
        step_status: state.step_status || {}
      };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

// ─── Initial state factory ────────────────────────────────────────────────────

function createInitialState({ project_id, project_name, slug, password_hash, primary_domain }) {
  const now = new Date().toISOString();
  return {
    project_id,
    project_name,
    slug,
    password_hash,
    created_at: now,
    updated_at: now,

    step_status: {
      '00': 'complete',
      '01': 'ready',
      '02': 'locked',
      '03': 'locked',
      '04': 'locked',
      '05': 'locked',
      '06': 'locked',
      '07': 'locked',
      '08': 'locked',
      '09': 'locked'
    },

    config: {
      identity: {
        client_name: '',
        primary_domain: primary_domain || '',
        industry: '',
        primary_products: [],
        offer_description: '',
        target_personas: [],
        icp_company_size: [],
        icp_industries: []
      },
      brand: {
        primary_font: 'Inter',
        secondary_font: 'Inter',
        primary_color: '#3b82f6',
        secondary_color: '#1e40af',
        accent_color: '#10b981',
        background_color: '#ffffff',
        text_color: '#1f2937',
        logo_url: '',
        brand_voice: 'Professional',
        cta_button_text: 'Book a Demo',
        cta_button_url: ''
      },
      lead_magnets: [],
      contact_form: {
        form_headline: '',
        fields: ['name', 'company', 'email'],
        submission_endpoint: '',
        confirmation_message: 'Thank you — we\'ll be in touch shortly.',
        notification_email: ''
      }
    },

    analytics: {
      ga4_property_id: '',
      gsc_property_url: '',
      service_account_json: null,
      date_range_days: 90
    },

    baseline: null,

    competitors: {
      candidates: [],
      confirmed: [],
      profiles: [],
      g2_slugs: {}
    },

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
      site_intelligence: null,
      keyword_universe: null,
      g2_intelligence: null,
      reddit_intelligence: null,
      serp_analysis: null,
      synthesis: null
    },

    pipeline_log: [],

    pages: {
      bofu_pages: [],
      comparison_pages: [],
      supporting_content: [],
      striking_distance: []
    },

    calendar: {
      project_start_date: null,
      tasks: []
    },

    reports: [],

    tech_seo: {
      robots_txt: null,
      llms_txt: null,
      sitemap_xml: null,
      gsc_submissions: []
    },

    // ─── Content Studio ──────────────────────────────────────────────────────
    content_studio: {
      settings: {
        require_approval: true,
        plagiarism_threshold: 30,   // % — above this triggers rewrite warning
        personas: []                // [{ id, name, title, tone }] for Atomizer
      },
      drafts: [],                   // content draft objects (see schema below)
      image_library: []             // uploaded image metadata
    },

    // ─── Brand Voice Guide (Step 01e) ────────────────────────────────────────
    // Raw documents stored in /data/projects/{slug}/voice-guide/
    // Processed index stored here
    voice_guide: {
      documents: [],  // [{ filename, type, size, uploaded_at }]
      index: null,    // structured voice profile JSON produced by Voice_Guide_Index
      index_status: 'empty',  // 'empty' | 'pending' | 'indexing' | 'ready'
      index_job_id: null,
      indexed_at: null
    },

    runs: []
  };
}

// ─── Content Studio draft schema ─────────────────────────────────────────────
// Each draft corresponds to one Type B supporting content piece
// {
//   draft_id: uuid,
//   cluster_id: 'CL-001',
//   title: '...',
//   target_keyword: '...',
//   brief: { ...content brief... },
//   body_html: '...',        // generated article HTML (body only, not full page)
//   body_text: '...',        // plain text for plagiarism check
//   word_count: 1400,
//   reading_time_mins: 6,
//   cta_mode: 'auto' | 'manual',
//   cta_assignment: 'demo' | 'lead_magnet_1' | 'lead_magnet_2' | 'lead_magnet_3' | 'custom',
//   cta_auto_reasoning: '...',
//   cross_links_applied: false,
//   cross_links: [...],
//   plagiarism_score: null,          // 0-1 float from Quetext
//   plagiarism_results: [],          // [{ text, source, percentMatch }]
//   plagiarism_checked_at: null,
//   status: 'brief_ready' | 'generating' | 'draft' | 'pending_approval' | 'approved' | 'published',
//   images: [],                      // [image_id strings from image_library]
//   linkedin_posts: null,            // { personal: [...], company: [...] }
//   linkedin_personas: [],           // [{ name, title, tone }]
//   exports: { html_path: null, google_doc_id: null, google_doc_url: null },
//   created_at: ISO,
//   updated_at: ISO
// }

module.exports = {
  getState,
  saveState,
  updateState,
  getProjectList,
  createInitialState,
  ensureProjectDirs,
  ensureDataRoot,
  projectDir,
  assetsDir,
  exportsDir,
  voiceGuideDir,
  imagesDir,
  deepMerge
};
