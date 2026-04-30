'use strict';

// ─── Workflow Executor — Direct Python Subprocess ────────────────────────────
//
// Workflows run as Python subprocesses on the same DigitalOcean instance.
// No HyperAgent API needed. All API credentials come from environment variables
// set in DigitalOcean App Platform (encrypted env vars).
//
// Flow:
//   1. Node.js spawns: python3 skills/seo-engine-workflows/orchestrator.py
//   2. Sends the WORKFLOW_TRIGGER message to the process's stdin
//   3. Python orchestrator dispatches to correct workflow script
//   4. Workflow script POSTs result to http://localhost:{PORT}/api/results/{jobId}
//   5. Node.js /api/results handler stores result + updates state.json

const { spawn }  = require('child_process');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');
const { createJob, failJob, addProgressLog } = require('./jobs');

const PORT           = process.env.PORT || 3000;
const ORCHESTRATOR   = path.join(__dirname, '..', 'skills', 'seo-engine-workflows', 'orchestrator.py');

// ─── Core trigger ─────────────────────────────────────────────────────────────

async function triggerWorkflow(workflowId, projectSlug, payload) {
  const jobId      = uuidv4();
  const callbackUrl = `http://localhost:${PORT}/api/results/${jobId}`;

  // Register job in memory queue
  createJob(jobId, workflowId, projectSlug);

  // Build the WORKFLOW_TRIGGER message (same format orchestrator.py expects)
  const message = [
    'WORKFLOW_TRIGGER',
    `workflow_id: ${workflowId}`,
    `job_id: ${jobId}`,
    `callback_url: ${callbackUrl}`,
    `project_slug: ${projectSlug}`,
    '',
    'PAYLOAD:',
    JSON.stringify(payload, null, 2)
  ].join('\n');

  // Spawn python3 as a detached background process
  let child;
  try {
    child = spawn('python3', [ORCHESTRATOR], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }   // all env vars (API keys) passed to child
    });

    // Write trigger message to stdin then close it
    child.stdin.write(message);
    child.stdin.end();

    // Log stdout from the workflow (shows in DO runtime logs)
    child.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          console.log(`[${workflowId}/${jobId.slice(0, 8)}] ${line}`);
          addProgressLog(jobId, line);
        }
      });
    });

    // Log stderr
    child.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.error(`[${workflowId}/${jobId.slice(0, 8)}] ERR: ${line}`);
    });

    child.on('exit', (code) => {
      console.log(`[${workflowId}] Process exited (code ${code})`);
      if (code !== 0) {
        failJob(jobId, `Process exited with code ${code}`);
      }
    });

    child.on('error', (err) => {
      console.error(`[${workflowId}] Spawn error:`, err.message);
      failJob(jobId, `Failed to start workflow: ${err.message}`);
    });

    // Detach so Node.js doesn't wait for it
    child.unref();

    console.log(`[webhook] Triggered ${workflowId} | job: ${jobId} | pid: ${child.pid}`);
    return { job_id: jobId, sent: true, pid: child.pid };

  } catch (err) {
    console.error(`[webhook] Failed to spawn ${workflowId}:`, err.message);
    failJob(jobId, err.message);
    return { job_id: jobId, sent: false, error: err.message };
  }
}

// ─── Build workflow payloads from project state ───────────────────────────────

function buildPayload(workflowId, state) {
  const id   = state.config?.identity || {};
  const base = state.baseline;
  const comp = state.competitors;

  switch (workflowId) {

    case 'GA_GSC_Baseline':
      return {
        ga4_property_id:      state.analytics.ga4_property_id,
        gsc_property_url:     state.analytics.gsc_property_url,
        service_account_json: state.analytics.service_account_json,
        date_range_days:      state.analytics.date_range_days || 90
      };

    case 'Competitor_Discovery':
      return {
        client_domain:     id.primary_domain,
        client_name:       id.client_name || '',
        offer_description: id.offer_description || '',
        industry:          id.industry || '',
        primary_products:  id.primary_products || [],
        target_personas:   id.target_personas || [],
        gsc_top_keywords:  (base?.gsc_all_queries || []).slice(0, 50)
      };

    case 'Competitor_Enrichment_Clay':
      return { confirmed_competitors: comp.confirmed };

    case 'Site_Intelligence':
      return {
        client_domain:     id.primary_domain,
        offer_description: id.offer_description,
        industry:          id.industry,
        gsc_all_pages:     base?.gsc_all_pages || []
      };

    case 'Permutation_Engine':
      return {
        client_domain:              id.primary_domain,
        offer_description:          id.offer_description,
        industry:                   id.industry,
        primary_products:           id.primary_products,
        target_personas:            id.target_personas,
        icp_company_size:           id.icp_company_size,
        icp_industries:             id.icp_industries,
        confirmed_competitors:      comp.confirmed.map(c => c.domain),
        gsc_all_queries:            base?.gsc_all_queries || [],
        already_ranking_p1:         base?.already_ranking_p1 || [],
        striking_distance_keywords: base?.striking_distance_keywords || [],
        site_intelligence:          state.research.site_intelligence
      };

    case 'G2_Review_Mining':
      return {
        competitor_g2_slugs: comp.confirmed.map(c => ({
          domain: c.domain,
          slug:   comp.g2_slugs?.[c.domain] || null
        })).filter(c => c.slug),
        client_g2_slug:   comp.g2_slugs?.[id.primary_domain] || null,
        keyword_clusters: state.research.keyword_universe?.clusters || []
      };

    case 'Reddit_Intelligence':
      return {
        industry:          id.industry,
        offer_description: id.offer_description,
        competitor_names:  comp.confirmed.map(c => c.company_name || c.domain),
        primary_keywords:  (state.research.keyword_universe?.clusters || [])
                             .slice(0, 10).map(c => c.primary_keyword),
        icp_personas:      id.target_personas
      };

    case 'SERP_Analysis':
      return {
        keyword_clusters: state.research.keyword_universe?.clusters || [],
        client_domain:    id.primary_domain
      };

    case 'Synthesis_Scoring':
      return {
        keyword_clusters:           state.research.keyword_universe?.clusters || [],
        serp_analysis:              state.research.serp_analysis || {},
        g2_intelligence:            state.research.g2_intelligence || {},
        reddit_intelligence:        state.research.reddit_intelligence || {},
        striking_distance_keywords: base?.striking_distance_keywords || [],
        already_ranking_p1:         base?.already_ranking_p1 || [],
        content_seeds:              state.research.reddit_intelligence?.content_seeds || [],
        client_domain:              id.primary_domain
      };

    case 'GA_GSC_Refresh':
      return {
        ga4_property_id:      state.analytics.ga4_property_id,
        gsc_property_url:     state.analytics.gsc_property_url,
        service_account_json: state.analytics.service_account_json,
        baseline:             state.baseline,
        published_pages:      [
          ...(state.pages.bofu_pages || []),
          ...(state.pages.comparison_pages || [])
        ].filter(p => p.status === 'Published').map(p => p.target_url)
      };

    case 'GSC_URL_Submit':
      return {
        gsc_property_url:     state.analytics.gsc_property_url,
        service_account_json: state.analytics.service_account_json,
        urls_to_submit:       (state.tech_seo?.gsc_submissions || [])
                                .filter(s => s.status === 'Pending').map(s => s.url)
      };

    // ── Content Studio workflows ───────────────────────────────────────────
    case 'Voice_Guide_Index':
      return {
        documents:   state.voice_guide?.documents || [],
        project_slug: state.slug,
        client_name: id.client_name,
        industry:    id.industry,
        brand_voice: state.config?.brand?.brand_voice || 'Professional'
      };

    // Content Studio workflows pass payload_overrides from the route handlers
    case 'Content_Creator':
    case 'Plagiarism_Check':
    case 'CrossLink_Inserter':
    case 'Atomizer':
    case 'Google_Doc_Export':
      return { project_slug: state.slug };

    case 'Run_Full_Pipeline':
      return {
        client_domain:              id.primary_domain,
        offer_description:          id.offer_description,
        industry:                   id.industry,
        primary_products:           id.primary_products,
        target_personas:            id.target_personas,
        icp_company_size:           id.icp_company_size,
        icp_industries:             id.icp_industries,
        confirmed_competitors:      comp.confirmed.map(c => c.domain),
        gsc_all_queries:            base?.gsc_all_queries || [],
        already_ranking_p1:         base?.already_ranking_p1 || [],
        striking_distance_keywords: base?.striking_distance_keywords || [],
        site_intelligence:          state.research.site_intelligence,
        competitor_g2_slugs:        comp.confirmed.map(c => ({
                                      domain: c.domain,
                                      slug:   comp.g2_slugs?.[c.domain] || null
                                    })).filter(c => c.slug),
        client_g2_slug:             comp.g2_slugs?.[id.primary_domain] || null,
        keyword_clusters:           state.research.keyword_universe?.clusters || [],
        client_domain_target:       id.primary_domain
      };

    default:
      return {};
  }
}

module.exports = { triggerWorkflow, buildPayload };
