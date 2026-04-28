'use strict';

const router = require('express').Router();

const { getState, updateState }           = require('../utils/state');
const { getJob, getJobSummary, checkTimeout } = require('../utils/jobs');
const { triggerWorkflow, buildPayload }   = require('../utils/webhook');
const { requireAuth }                     = require('../middleware/session');

// ─── Workflows that belong to the main 6-stage research pipeline ──────────────

const PIPELINE_STAGE_MAP = {
  Site_Intelligence:   'site_intelligence',
  Permutation_Engine:  'permutation_engine',
  G2_Review_Mining:    'g2_review_mining',
  Reddit_Intelligence: 'reddit_intelligence',
  SERP_Analysis:       'serp_analysis',
  Synthesis_Scoring:   'synthesis_scoring'
};

// ─── POST /api/research/:slug/trigger  [requireAuth] ─────────────────────────

router.post('/:slug/trigger', requireAuth, async (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { slug } = req.params;
    const { workflow_id, payload_overrides = {} } = req.body;

    if (!workflow_id) {
      return res.status(400).json({ error: 'workflow_id is required' });
    }

    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    // Build base payload and merge any client overrides
    const basePayload = buildPayload(workflow_id, state);
    const payload     = deepMerge(basePayload, payload_overrides);

    // Trigger the workflow
    const { job_id, sent, error: triggerError } = await triggerWorkflow(workflow_id, slug, payload);

    const now = new Date().toISOString();
    const stateUpdates = {};

    // Update pipeline stage or step_status depending on workflow
    if (PIPELINE_STAGE_MAP[workflow_id]) {
      const stageName = PIPELINE_STAGE_MAP[workflow_id];
      stateUpdates.research = {
        pipeline_stages: {
          [stageName]: {
            status:     'running',
            started_at: now,
            completed_at: null
          }
        }
      };
      stateUpdates.step_status = { '04': 'running' };
    } else if (workflow_id === 'GA_GSC_Baseline') {
      stateUpdates.step_status = { '02': 'running' };
    } else if (workflow_id === 'Competitor_Discovery') {
      stateUpdates.step_status = { '03': 'running' };
    }

    // Append to pipeline log
    const logEntry = {
      timestamp: now,
      message:   `Triggered ${workflow_id} (job: ${job_id})`
    };

    // Fetch fresh state to merge log correctly
    const currentState = getState(slug);
    const existingLog  = Array.isArray(currentState?.pipeline_log) ? currentState.pipeline_log : [];

    stateUpdates.pipeline_log = [...existingLog, logEntry];

    updateState(slug, stateUpdates);

    return res.status(200).json({ job_id, sent, error: triggerError || undefined });
  } catch (err) {
    console.error('[research] trigger error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/research/:slug/status/:job_id  [requireAuth] ───────────────────

router.get('/:slug/status/:job_id', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { slug, job_id } = req.params;

    const summary = getJobSummary(job_id);
    if (!summary) return res.status(404).json({ error: 'Job not found' });

    // Check / mark timeout if applicable
    checkTimeout(job_id);
    // Re-fetch after possible timeout mutation
    const freshSummary = getJobSummary(job_id);

    const state = getState(slug);
    const pipeline_stages = state?.research?.pipeline_stages || {};

    return res.status(200).json({
      ...freshSummary,
      pipeline_stages
    });
  } catch (err) {
    console.error('[research] status error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/research/:slug/pipeline  [requireAuth] ─────────────────────────

router.get('/:slug/pipeline', requireAuth, (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { slug } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    return res.status(200).json({
      pipeline_stages: state.research?.pipeline_stages || {},
      pipeline_log:    state.pipeline_log || [],
      step_status:     state.step_status  || {}
    });
  } catch (err) {
    console.error('[research] pipeline error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/research/:slug/pipeline/run  [requireAuth] ────────────────────
//
// Triggers the entire 6-stage pipeline via a single "Run_Full_Pipeline" call.
// The HyperAgent orchestrator handles sequencing internally and sends partial
// callbacks per stage. We mark all stages as 'queued' immediately.

router.post('/:slug/pipeline/run', requireAuth, async (req, res) => {
  try {
    if (req.projectSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { slug } = req.params;
    const state = getState(slug);
    if (!state) return res.status(404).json({ error: 'Project not found' });

    const payload = buildPayload('Run_Full_Pipeline', state);

    const { job_id, sent, error: triggerError } = await triggerWorkflow('Run_Full_Pipeline', slug, payload);

    const now = new Date().toISOString();
    const queuedStages = {};
    for (const key of Object.keys(PIPELINE_STAGE_MAP)) {
      queuedStages[PIPELINE_STAGE_MAP[key]] = {
        status:       'queued',
        started_at:   null,
        completed_at: null,
        records:      0
      };
    }

    const logEntry = {
      timestamp: now,
      message:   `Full pipeline triggered (job: ${job_id})`
    };

    const currentState   = getState(slug);
    const existingLog    = Array.isArray(currentState?.pipeline_log) ? currentState.pipeline_log : [];

    updateState(slug, {
      step_status:  { '04': 'running' },
      research: { pipeline_stages: queuedStages, last_run_at: now },
      pipeline_log: [...existingLog, logEntry]
    });

    return res.status(200).json({ job_id, sent, error: triggerError || undefined });
  } catch (err) {
    console.error('[research] pipeline/run error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

module.exports = router;
