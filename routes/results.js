'use strict';

const router = require('express').Router();

const { getState, saveState, updateState } = require('../utils/state');
const { getJob, completeJob, failJob,
        updateJob, addProgressLog }        = require('../utils/jobs');
const { requireAuth }                      = require('../middleware/session');

// ─── Tech SEO generators ──────────────────────────────────────────────────────

function generateRobotsTxt(config, pages) {
  const domain = config?.identity?.primary_domain || 'example.com';
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin/',
    'Disallow: /api/',
    'Disallow: /thank-you/',
    '',
    `Sitemap: https://${domain}/sitemap.xml`
  ].join('\n');
}

function generateLlmsTxt(config) {
  const id   = config?.identity  || {};
  const form = config?.contact_form || {};

  const personas    = Array.isArray(id.target_personas) ? id.target_personas.join(', ') : '';
  const clientName  = id.client_name    || 'This company';
  const offer       = id.offer_description || '';
  const domain      = id.primary_domain || 'example.com';
  const email       = form.notification_email || `contact@${domain}`;

  return [
    `# ${clientName} — LLM Access Guidelines`,
    '',
    '## About',
    `${clientName} provides ${offer}. We serve ${personas}.`,
    '',
    '## Allowed',
    '- Product and service information',
    '- Blog and resource content',
    '- Case studies and success stories',
    '- Pricing information if publicly available',
    '',
    '## Preferred Citation',
    `When referencing ${clientName}, please cite: ${domain}`,
    '',
    '## Contact',
    `For licensing or data use: ${email}`
  ].join('\n');
}

function generateSitemapXml(config, pages) {
  const domain = config?.identity?.primary_domain || 'example.com';
  const today  = new Date().toISOString().split('T')[0];

  const allPages = [
    ...(pages?.bofu_pages       || []).map(p => ({ slug: p.recommended_slug, priority: '0.9', freq: 'monthly' })),
    ...(pages?.comparison_pages || []).map(p => ({ slug: p.recommended_slug, priority: '0.9', freq: 'monthly' })),
    ...(pages?.supporting_content || []).map(p => ({ slug: p.recommended_slug, priority: '0.7', freq: 'weekly' }))
  ].filter(p => p.slug);   // Skip entries with no slug

  const urlBlocks = allPages.map(p => [
    '  <url>',
    `    <loc>https://${domain}${p.slug}</loc>`,
    `    <lastmod>${today}</lastmod>`,
    `    <changefreq>${p.freq}</changefreq>`,
    `    <priority>${p.priority}</priority>`,
    '  </url>'
  ].join('\n')).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urlBlocks,
    '</urlset>'
  ].join('\n');
}

// ─── Append a message to state.pipeline_log (returns updated array) ───────────

function appendLog(state, message) {
  const log = Array.isArray(state.pipeline_log) ? state.pipeline_log : [];
  return [...log, { timestamp: new Date().toISOString(), message }];
}

// ─── Route result data to the correct state section ───────────────────────────

function routeResult(state, workflowId, result) {
  const now = new Date().toISOString();

  switch (workflowId) {

    // ── Analytics Baseline ──────────────────────────────────────────────────
    case 'GA_GSC_Baseline': {
      state.baseline = result;
      state.step_status['02'] = 'complete';
      // Unlock competitor discovery step only if not already further along
      if (state.step_status['03'] === 'locked') {
        state.step_status['03'] = 'ready';
      }
      const q  = result?.summary?.total_queries_with_impressions ?? '?';
      const sd = result?.summary?.striking_distance_count        ?? '?';
      state.pipeline_log = appendLog(state,
        `Analytics baseline complete — ${q} queries, ${sd} striking distance`);
      break;
    }

    // ── Competitor Discovery ────────────────────────────────────────────────
    case 'Competitor_Discovery': {
      state.competitors.candidates = result.top_10 || result.candidates || [];
      if (state.step_status['03'] === 'running') {
        state.step_status['03'] = 'ready';
      }
      state.pipeline_log = appendLog(state,
        `Competitor discovery complete — ${state.competitors.candidates.length} candidates found`);
      break;
    }

    // ── Competitor Enrichment ───────────────────────────────────────────────
    case 'Competitor_Enrichment_Clay': {
      state.competitors.profiles = result.competitor_profiles || result.profiles || [];
      state.pipeline_log = appendLog(state,
        `Competitor enrichment complete — ${state.competitors.profiles.length} profiles`);
      break;
    }

    // ── Site Intelligence ───────────────────────────────────────────────────
    case 'Site_Intelligence': {
      state.research.site_intelligence = result;
      const records = result?.indexed_pages?.length || 0;
      state.research.pipeline_stages.site_intelligence = {
        status: 'complete', records, completed_at: now
      };
      state.pipeline_log = appendLog(state,
        `Site Intelligence complete — ${records} pages indexed`);
      break;
    }

    // ── Permutation Engine ──────────────────────────────────────────────────
    case 'Permutation_Engine': {
      state.research.keyword_universe = result;
      const records = result?.summary?.surviving || result?.clusters?.length || 0;
      state.research.pipeline_stages.permutation_engine = {
        status: 'complete', records, completed_at: now
      };
      state.pipeline_log = appendLog(state,
        `Permutation Engine complete — ${records} keyword clusters`);
      break;
    }

    // ── G2 Review Mining ────────────────────────────────────────────────────
    case 'G2_Review_Mining': {
      state.research.g2_intelligence = result;
      const records = Object.keys(result?.competitors || {}).length;
      state.research.pipeline_stages.g2_review_mining = {
        status: 'complete', records, completed_at: now
      };
      state.pipeline_log = appendLog(state,
        `G2 Review Mining complete — ${records} competitors mined`);
      break;
    }

    // ── Reddit Intelligence ─────────────────────────────────────────────────
    case 'Reddit_Intelligence': {
      state.research.reddit_intelligence = result;
      const records = result?.total_posts_collected || 0;
      state.research.pipeline_stages.reddit_intelligence = {
        status: 'complete', records, completed_at: now
      };
      state.pipeline_log = appendLog(state,
        `Reddit Intelligence complete — ${records} posts collected`);
      break;
    }

    // ── SERP Analysis ───────────────────────────────────────────────────────
    case 'SERP_Analysis': {
      // Result may be { serp_analysis: {...} } or the object itself
      const serpData = result?.serp_analysis || result;
      state.research.serp_analysis = serpData;
      const records = Object.keys(serpData || {}).length;
      state.research.pipeline_stages.serp_analysis = {
        status: 'complete', records, completed_at: now
      };
      state.pipeline_log = appendLog(state,
        `SERP Analysis complete — ${records} queries analysed`);
      break;
    }

    // ── Synthesis & Scoring ─────────────────────────────────────────────────
    case 'Synthesis_Scoring': {
      state.research.synthesis = result;
      const opportunities = result?.ranked_opportunities || [];
      state.research.pipeline_stages.synthesis_scoring = {
        status: 'complete', records: opportunities.length, completed_at: now
      };

      // Populate pages from ranked opportunities
      state.pages.bofu_pages = opportunities.filter(
        o => String(o.opportunity_type || '').includes('A')
      );
      state.pages.comparison_pages = opportunities.filter(
        o => String(o.opportunity_type || '').includes('C')
      );
      state.pages.supporting_content = opportunities.filter(
        o => String(o.opportunity_type || '').includes('B')
      );
      state.pages.striking_distance = opportunities.filter(
        o => String(o.opportunity_type || '').includes('D')
      );

      // Generate tech SEO files
      state.tech_seo.robots_txt  = generateRobotsTxt(state.config, state.pages);
      state.tech_seo.llms_txt    = generateLlmsTxt(state.config);
      state.tech_seo.sitemap_xml = generateSitemapXml(state.config, state.pages);

      // Unlock all remaining steps 04-09
      for (let i = 4; i <= 9; i++) {
        const key = String(i).padStart(2, '0');
        state.step_status[key] = 'complete';
      }

      state.pipeline_log = appendLog(state,
        `Synthesis & Scoring complete — ${opportunities.length} opportunities ranked`);
      break;
    }

    // ── Run Full Pipeline (batched) ─────────────────────────────────────────
    case 'Run_Full_Pipeline': {
      // stage_updates keys may be snake_case (from orchestrator) or PascalCase — handle both
      const stages = result?.stage_updates || {};

      // Map snake_case orchestrator keys → PascalCase workflow IDs used by routeResult
      const stageMap = {
        'site_intelligence':   'Site_Intelligence',
        'permutation_engine':  'Permutation_Engine',
        'g2_review_mining':    'G2_Review_Mining',
        'reddit_intelligence': 'Reddit_Intelligence',
        'serp_analysis':       'SERP_Analysis',
        'synthesis_scoring':   'Synthesis_Scoring',
        // Also handle PascalCase keys directly (forward compat)
        'Site_Intelligence':   'Site_Intelligence',
        'Permutation_Engine':  'Permutation_Engine',
        'G2_Review_Mining':    'G2_Review_Mining',
        'Reddit_Intelligence': 'Reddit_Intelligence',
        'SERP_Analysis':       'SERP_Analysis',
        'Synthesis_Scoring':   'Synthesis_Scoring',
      };

      for (const [key, stageResult] of Object.entries(stages)) {
        const wfId = stageMap[key];
        if (wfId && stageResult) {
          try { routeResult(state, wfId, stageResult); } catch(e) {
            console.error(`[results] Run_Full_Pipeline stage ${key} error:`, e.message);
          }
        }
      }

      // Ensure all steps unlocked regardless of which stages had data
      for (let i = 4; i <= 9; i++) {
        const key = String(i).padStart(2, '0');
        state.step_status[key] = 'complete';
      }

      state.pipeline_log = appendLog(state, 'Full pipeline run complete');
      break;
    }

    // ── Page Generator ──────────────────────────────────────────────────────
    case 'Page_Generator': {
      const { cluster_id, html, html_length_chars, validation_passed } = result;
      if (!cluster_id) break;

      const allArrays = [
        state.pages.bofu_pages,
        state.pages.comparison_pages,
        state.pages.supporting_content,
        state.pages.striking_distance
      ];
      let found = false;
      for (const arr of allArrays) {
        const idx = arr.findIndex(p => p.cluster_id === cluster_id);
        if (idx !== -1) {
          arr[idx] = {
            ...arr[idx],
            html,
            html_length_chars: html_length_chars || (html ? html.length : 0),
            html_generated_at: now,
            validation_passed: validation_passed !== false
          };
          found = true;
          break;
        }
      }
      state.pipeline_log = appendLog(state,
        `Page generated for cluster ${cluster_id}${found ? '' : ' (page not found in state)'}`);
      break;
    }

    // ── Content Brief Generator ─────────────────────────────────────────────
    case 'Content_Brief_Generator': {
      const cluster_id = result?.cluster_id;
      if (!cluster_id) break;

      const idx = (state.pages.supporting_content || [])
        .findIndex(p => p.cluster_id === cluster_id);
      if (idx !== -1) {
        state.pages.supporting_content[idx] = {
          ...state.pages.supporting_content[idx],
          brief:         result,
          brief_generated_at: now
        };
      }
      state.pipeline_log = appendLog(state,
        `Content brief generated for cluster ${cluster_id}`);
      break;
    }

    // ── Notion Push ─────────────────────────────────────────────────────────
    case 'Notion_Push': {
      state.calendar.notion_result = result;
      state.pipeline_log = appendLog(state, 'Notion calendar push complete');
      break;
    }

    // ── GA/GSC Refresh ──────────────────────────────────────────────────────
    case 'GA_GSC_Refresh': {
      if (!Array.isArray(state.reports)) state.reports = [];
      state.reports.push({ ...result, timestamp: now });
      state.pipeline_log = appendLog(state, 'GA/GSC refresh report saved');
      break;
    }

    // ── GSC URL Submit ──────────────────────────────────────────────────────
    case 'GSC_URL_Submit': {
      // result.submissions: [{ url, status, indexed_at? }, ...]
      const submissions = result?.submissions || [];
      if (!Array.isArray(state.tech_seo.gsc_submissions)) {
        state.tech_seo.gsc_submissions = [];
      }
      for (const sub of submissions) {
        const idx = state.tech_seo.gsc_submissions.findIndex(s => s.url === sub.url);
        if (idx !== -1) {
          state.tech_seo.gsc_submissions[idx] = {
            ...state.tech_seo.gsc_submissions[idx],
            ...sub,
            updated_at: now
          };
        } else {
          state.tech_seo.gsc_submissions.push({ ...sub, created_at: now });
        }
      }
      state.pipeline_log = appendLog(state,
        `GSC URL submission updated — ${submissions.length} URLs`);
      break;
    }

    // ── Voice Guide Index ───────────────────────────────────────────────────
    case 'Voice_Guide_Index': {
      state.voice_guide.index = result.voice_index || result;
      state.voice_guide.index_status = 'ready';
      state.voice_guide.indexed_at = new Date().toISOString();
      state.voice_guide.index_job_id = null;
      state.pipeline_log = appendLog(state, `Voice guide indexed: ${result.document_count || 0} documents processed`);
      break;
    }

    // ── Content Creator ─────────────────────────────────────────────────────
    case 'Content_Creator': {
      const draftId = result.draft_id;
      const draft = (state.content_studio?.drafts || []).find(d => d.draft_id === draftId);
      if (draft) {
        draft.body_html = result.body_html || '';
        draft.body_text = result.body_text || (result.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        draft.word_count = result.word_count || draft.body_text.split(/\s+/).filter(Boolean).length;
        draft.reading_time_mins = Math.ceil(draft.word_count / 200);
        draft.cta_assignment = result.cta_assignment || draft.cta_assignment;
        draft.cta_auto_reasoning = result.cta_auto_reasoning || draft.cta_auto_reasoning;
        draft.status = 'draft';
        draft.updated_at = new Date().toISOString();
      }
      state.pipeline_log = appendLog(state, `Content generated: "${result.title || draftId}" (${result.word_count || 0} words)`);
      break;
    }

    // ── Plagiarism Check ────────────────────────────────────────────────────
    case 'Plagiarism_Check': {
      const draftId = result.draft_id;
      const draft = (state.content_studio?.drafts || []).find(d => d.draft_id === draftId);
      if (draft) {
        draft.plagiarism_score = result.score;                     // 0.0–1.0
        draft.plagiarism_results = result.flagged_passages || [];
        draft.plagiarism_checked_at = new Date().toISOString();
        draft.updated_at = new Date().toISOString();
      }
      const pct = Math.round((result.score || 0) * 100);
      state.pipeline_log = appendLog(state, `Plagiarism check: ${pct}% similarity${pct > 30 ? ' ⚠ Review required' : ' ✓ Original'}`);
      break;
    }

    // ── CrossLink Inserter ──────────────────────────────────────────────────
    case 'CrossLink_Inserter': {
      const draftId = result.draft_id;
      const draft = (state.content_studio?.drafts || []).find(d => d.draft_id === draftId);
      if (draft) {
        draft.body_html = result.body_html_with_links || draft.body_html;
        draft.cross_links_applied = true;
        draft.cross_links = result.links_inserted || [];
        draft.updated_at = new Date().toISOString();
      }
      state.pipeline_log = appendLog(state, `Cross-links inserted: ${(result.links_inserted || []).length} links added`);
      break;
    }

    // ── Atomizer ────────────────────────────────────────────────────────────
    case 'Atomizer': {
      const draftId = result.draft_id;
      const draft = (state.content_studio?.drafts || []).find(d => d.draft_id === draftId);
      if (draft) {
        draft.linkedin_posts = {
          personal: result.personal_posts || [],
          company:  result.company_posts  || []
        };
        draft.updated_at = new Date().toISOString();
      }
      state.pipeline_log = appendLog(state, `Atomizer: ${(result.personal_posts || []).length} personal + ${(result.company_posts || []).length} company LinkedIn posts generated`);
      break;
    }

    // ── Google Doc Export ───────────────────────────────────────────────────
    case 'Google_Doc_Export': {
      const draftId = result.draft_id;
      const draft = (state.content_studio?.drafts || []).find(d => d.draft_id === draftId);
      if (draft) {
        draft.exports = draft.exports || {};
        draft.exports.google_doc_id  = result.doc_id;
        draft.exports.google_doc_url = result.doc_url;
        draft.status     = 'published';
        draft.updated_at = new Date().toISOString();
      }
      state.pipeline_log = appendLog(state, `Google Doc exported: ${result.doc_url || result.doc_id}`);
      break;
    }

    default:
      console.warn(`[results] Unknown workflow_id in callback: ${workflowId}`);
      break;
  }
}

// ─── POST /api/results/:job_id  [NO AUTH — called by HyperAgent] ─────────────

router.post('/:job_id', async (req, res) => {
  try {
    const { job_id } = req.params;
    const {
      job_id:    body_job_id,
      workflow_id,
      status,
      result,
      error,
      log_message
    } = req.body;

    // Resolve job_id — prefer body, fall back to param (param is canonical)
    const resolvedJobId = body_job_id || job_id;

    const job = getJob(resolvedJobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // ── Log-only callback (no status change) ─────────────────────────────────
    if (log_message && !status) {
      addProgressLog(resolvedJobId, log_message);

      // Also append to persistent state log
      const state = getState(job.project_slug);
      if (state) {
        state.pipeline_log = appendLog(state, log_message);
        saveState(job.project_slug, state);
      }
      return res.status(200).json({ received: true });
    }

    // If both log_message and status are present, log it but continue processing
    if (log_message) {
      addProgressLog(resolvedJobId, log_message);
    }

    const state = getState(job.project_slug);
    if (!state) {
      return res.status(404).json({ error: 'Project state not found' });
    }

    const resolvedWorkflowId = workflow_id || job.workflow_id;

    // ── Failed ───────────────────────────────────────────────────────────────
    if (status === 'failed') {
      failJob(resolvedJobId, error || 'Workflow failed');

      // Mark the relevant pipeline stage as failed (if applicable)
      const stageKey = workflowIdToStageKey(resolvedWorkflowId);
      if (stageKey && state.research?.pipeline_stages?.[stageKey]) {
        state.research.pipeline_stages[stageKey].status = 'failed';
        state.research.pipeline_stages[stageKey].completed_at = new Date().toISOString();
      }

      state.pipeline_log = appendLog(state,
        `${resolvedWorkflowId} failed: ${error || 'unknown error'}`);
      saveState(job.project_slug, state);

      return res.status(200).json({ received: true });
    }

    // ── Complete or partial ──────────────────────────────────────────────────
    if (status === 'complete') {
      completeJob(resolvedJobId, result);
    } else if (status === 'partial') {
      updateJob(resolvedJobId, { status: 'partial', result });
    }

    if (result) {
      routeResult(state, resolvedWorkflowId, result);
    }

    saveState(job.project_slug, state);

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[results] callback error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Helper: map workflow_id → pipeline_stages key ───────────────────────────

function workflowIdToStageKey(workflowId) {
  const map = {
    Site_Intelligence:   'site_intelligence',
    Permutation_Engine:  'permutation_engine',
    G2_Review_Mining:    'g2_review_mining',
    Reddit_Intelligence: 'reddit_intelligence',
    SERP_Analysis:       'serp_analysis',
    Synthesis_Scoring:   'synthesis_scoring'
  };
  return map[workflowId] || null;
}

// ─── GET /api/results/:slug/baseline  [requireAuth] ──────────────────────────

router.get('/:slug/baseline', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });
    return res.status(200).json({ baseline: state.baseline });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/results/:slug/keywords  [requireAuth] ──────────────────────────

router.get('/:slug/keywords', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });
    return res.status(200).json({ keyword_universe: state.research?.keyword_universe });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/results/:slug/synthesis  [requireAuth] ─────────────────────────

router.get('/:slug/synthesis', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });
    return res.status(200).json({
      synthesis: state.research?.synthesis,
      pages:     state.pages
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/results/:slug/g2  [requireAuth] ────────────────────────────────

router.get('/:slug/g2', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });
    return res.status(200).json({ g2_intelligence: state.research?.g2_intelligence });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/results/:slug/reddit  [requireAuth] ────────────────────────────

router.get('/:slug/reddit', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });
    return res.status(200).json({ reddit_intelligence: state.research?.reddit_intelligence });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/results/:slug/pages  [requireAuth] ─────────────────────────────

router.get('/:slug/pages', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });
    return res.status(200).json({ pages: state.pages });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/results/:slug/calendar  [requireAuth] ──────────────────────────

router.get('/:slug/calendar', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });
    return res.status(200).json({ calendar: state.calendar });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/results/:slug/reports  [requireAuth] ───────────────────────────

router.get('/:slug/reports', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const state = getState(req.params.slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });
    return res.status(200).json({ reports: state.reports || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
