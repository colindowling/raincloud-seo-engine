'use strict';

const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const { createJob, failJob } = require('./jobs');

// ─── HyperAgent Executions API integration ────────────────────────────────────
//
// The Node.js app triggers HyperAgent workflows by sending a message to the
// configured SEO Engine agent via the HyperAgent API. The message contains:
//   - workflow_id: which of the 14 workflows to run
//   - job_id: unique ID for tracking
//   - callback_url: where HyperAgent should POST results when done
//   - payload: workflow-specific parameters
//
// HyperAgent's Python orchestrator reads the message, dispatches to the
// correct workflow script, and POSTs back to callback_url.

const HYPERAGENT_API_BASE = process.env.HYPERAGENT_API_BASE || 'https://api.hyperagent.com/v1';
const HYPERAGENT_API_KEY  = process.env.HYPERAGENT_API_KEY  || '';
const HYPERAGENT_AGENT_ID = process.env.HYPERAGENT_AGENT_ID || '';
const APP_BASE_URL        = process.env.APP_BASE_URL        || 'http://localhost:3000';

async function triggerWorkflow(workflowId, projectSlug, payload) {
  const jobId = uuidv4();
  const callbackUrl = `${APP_BASE_URL}/api/results/${jobId}`;

  // Register job in memory queue
  createJob(jobId, workflowId, projectSlug);

  const envelope = {
    workflow_id: workflowId,
    job_id: jobId,
    callback_url: callbackUrl,
    project_slug: projectSlug,
    payload
  };

  // Build the message text that the HyperAgent workflow agent will parse
  const messageText = [
    `WORKFLOW_TRIGGER`,
    `workflow_id: ${workflowId}`,
    `job_id: ${jobId}`,
    `callback_url: ${callbackUrl}`,
    `project_slug: ${projectSlug}`,
    ``,
    `PAYLOAD:`,
    JSON.stringify(payload, null, 2)
  ].join('\n');

  try {
    if (!HYPERAGENT_API_KEY || !HYPERAGENT_AGENT_ID) {
      console.warn(`[webhook] HyperAgent not configured — job ${jobId} created but not sent.`);
      console.warn(`[webhook] Set HYPERAGENT_API_KEY and HYPERAGENT_AGENT_ID in .env`);
      return { job_id: jobId, sent: false, reason: 'HyperAgent not configured' };
    }

    // POST to HyperAgent Executions API
    const url = `${HYPERAGENT_API_BASE}/threads`;
    const body = {
      agent_id: HYPERAGENT_AGENT_ID,
      messages: [{ role: 'user', content: messageText }],
      metadata: { job_id: jobId, workflow_id: workflowId, project_slug: projectSlug }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HYPERAGENT_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HyperAgent API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    console.log(`[webhook] Workflow ${workflowId} triggered. Job: ${jobId}. HA thread: ${data.id || 'unknown'}`);

    return { job_id: jobId, sent: true, hyperagent_thread_id: data.id };

  } catch (err) {
    console.error(`[webhook] Failed to trigger workflow ${workflowId}:`, err.message);
    failJob(jobId, `Failed to reach HyperAgent: ${err.message}`);
    return { job_id: jobId, sent: false, error: err.message };
  }
}

// ─── Build workflow payloads from project state ───────────────────────────────

function buildPayload(workflowId, state) {
  const id = state.config.identity;
  const base = state.baseline;
  const comp = state.competitors;

  switch (workflowId) {

    case 'GA_GSC_Baseline':
      return {
        ga4_property_id:   state.analytics.ga4_property_id,
        gsc_property_url:  state.analytics.gsc_property_url,
        service_account_json: state.analytics.service_account_json,
        date_range_days:   state.analytics.date_range_days || 90
      };

    case 'Competitor_Discovery':
      return {
        client_domain:     id.primary_domain,
        offer_description: id.offer_description,
        industry:          id.industry,
        gsc_top_keywords:  (base?.gsc_all_queries || []).slice(0, 50)
      };

    case 'Competitor_Enrichment_Clay':
      return {
        confirmed_competitors: comp.confirmed
      };

    case 'Site_Intelligence':
      return {
        client_domain:     id.primary_domain,
        offer_description: id.offer_description,
        industry:          id.industry,
        gsc_all_pages:     base?.gsc_all_pages || []
      };

    case 'Permutation_Engine':
      return {
        client_domain:       id.primary_domain,
        offer_description:   id.offer_description,
        industry:            id.industry,
        primary_products:    id.primary_products,
        target_personas:     id.target_personas,
        icp_company_size:    id.icp_company_size,
        icp_industries:      id.icp_industries,
        confirmed_competitors: comp.confirmed.map(c => c.domain),
        gsc_all_queries:       base?.gsc_all_queries || [],
        already_ranking_p1:    base?.already_ranking_p1 || [],
        striking_distance_keywords: base?.striking_distance_keywords || [],
        site_intelligence:   state.research.site_intelligence
      };

    case 'G2_Review_Mining':
      return {
        competitor_g2_slugs: comp.confirmed.map(c => ({
          domain: c.domain,
          slug: comp.g2_slugs[c.domain] || null
        })).filter(c => c.slug),
        client_g2_slug:    comp.g2_slugs[id.primary_domain] || null,
        keyword_clusters:  state.research.keyword_universe?.clusters || []
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
        keyword_clusters:        state.research.keyword_universe?.clusters || [],
        serp_analysis:           state.research.serp_analysis || {},
        g2_intelligence:         state.research.g2_intelligence || {},
        reddit_intelligence:     state.research.reddit_intelligence || {},
        striking_distance_keywords: base?.striking_distance_keywords || [],
        already_ranking_p1:      base?.already_ranking_p1 || [],
        content_seeds:           state.research.reddit_intelligence?.content_seeds || [],
        client_domain:           id.primary_domain
      };

    case 'GA_GSC_Refresh':
      return {
        ga4_property_id:  state.analytics.ga4_property_id,
        gsc_property_url: state.analytics.gsc_property_url,
        service_account_json: state.analytics.service_account_json,
        baseline:         state.baseline,
        published_pages:  [
          ...(state.pages.bofu_pages || []),
          ...(state.pages.comparison_pages || [])
        ].filter(p => p.status === 'Published').map(p => p.target_url)
      };

    case 'GSC_URL_Submit':
      return {
        gsc_property_url: state.analytics.gsc_property_url,
        service_account_json: state.analytics.service_account_json,
        urls_to_submit:   (state.tech_seo?.gsc_submissions || [])
                            .filter(s => s.status === 'Pending').map(s => s.url)
      };

    // ── Content Studio workflows ───────────────────────────────────────────
    // Note: These are triggered with explicit payload_overrides from the studio
    // routes — the state-based builder is minimal fallback only.

    case 'Voice_Guide_Index':
      return {
        documents:     state.voice_guide?.documents || [],
        project_slug:  state.slug,
        client_name:   id.client_name,
        industry:      id.industry,
        brand_voice:   state.config?.brand?.brand_voice || 'Professional'
      };

    case 'Content_Creator':
      // payload_overrides carries draft_id, brief, voice_index, cta_assignment
      return { project_slug: state.slug };

    case 'Plagiarism_Check':
      // payload_overrides carries draft_id, body_text, threshold
      return { project_slug: state.slug };

    case 'CrossLink_Inserter':
      // payload_overrides carries draft_id, body_html, cross_links
      return { project_slug: state.slug };

    case 'Atomizer':
      // payload_overrides carries draft_id, article_body, personas, brand config
      return { project_slug: state.slug };

    case 'Google_Doc_Export':
      // payload_overrides carries draft_id, title, body_html, linkedin_posts, folder_id
      return { project_slug: state.slug };

    default:
      return {};
  }
}

module.exports = { triggerWorkflow, buildPayload };
