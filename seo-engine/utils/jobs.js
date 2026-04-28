'use strict';

// ─── In-memory job queue ──────────────────────────────────────────────────────
// Each job tracks: workflow execution triggered by Node.js and awaiting HyperAgent callback
// Jobs expire after 2 hours to prevent unbounded memory growth

const JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const jobs = new Map();

// ─── Create / update / retrieve ───────────────────────────────────────────────

function createJob(jobId, workflowId, projectSlug) {
  const job = {
    job_id: jobId,
    workflow_id: workflowId,
    project_slug: projectSlug,
    status: 'running',      // running | complete | partial | failed | timeout
    created_at: Date.now(),
    completed_at: null,
    result: null,
    error: null,
    progress_log: [],       // array of { timestamp, message }
    stage_statuses: {}      // for pipeline: { stage_name: 'running'|'complete'|'failed' }
  };
  jobs.set(jobId, job);
  return job;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function updateJob(jobId, updates) {
  const job = jobs.get(jobId);
  if (!job) return null;
  Object.assign(job, updates);
  return job;
}

function completeJob(jobId, result) {
  return updateJob(jobId, {
    status: 'complete',
    completed_at: Date.now(),
    result
  });
}

function failJob(jobId, error) {
  return updateJob(jobId, {
    status: 'failed',
    completed_at: Date.now(),
    error: typeof error === 'string' ? error : error.message
  });
}

function addProgressLog(jobId, message) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.progress_log.push({
    timestamp: new Date().toISOString(),
    message
  });
}

function updateStageStatus(jobId, stageName, status, records = null) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.stage_statuses[stageName] = { status, records, updated_at: new Date().toISOString() };
}

// ─── Query helpers ────────────────────────────────────────────────────────────

function getJobsForProject(projectSlug) {
  const result = [];
  for (const job of jobs.values()) {
    if (job.project_slug === projectSlug) result.push(job);
  }
  return result.sort((a, b) => b.created_at - a.created_at);
}

function getJobSummary(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  return {
    job_id: job.job_id,
    workflow_id: job.workflow_id,
    status: job.status,
    created_at: job.created_at,
    completed_at: job.completed_at,
    elapsed_ms: job.completed_at
      ? job.completed_at - job.created_at
      : Date.now() - job.created_at,
    progress_log: job.progress_log,
    stage_statuses: job.stage_statuses,
    error: job.error
  };
}

// ─── Timeout watchdog ─────────────────────────────────────────────────────────

function checkTimeout(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'running') return false;
  const elapsed = Date.now() - job.created_at;
  if (elapsed > 45 * 60 * 1000) { // 45 minutes
    updateJob(jobId, {
      status: 'timeout',
      completed_at: Date.now(),
      error: 'Workflow timed out after 45 minutes. Check HyperAgent logs and retry.'
    });
    return true;
  }
  return false;
}

// ─── Cleanup interval (every 30 min, remove jobs older than TTL) ──────────────

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.created_at > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}, 30 * 60 * 1000);

module.exports = {
  createJob,
  getJob,
  updateJob,
  completeJob,
  failJob,
  addProgressLog,
  updateStageStatus,
  getJobsForProject,
  getJobSummary,
  checkTimeout
};
