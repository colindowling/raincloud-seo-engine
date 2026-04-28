#!/usr/bin/env python3
"""
RAINCLOUD SEO Engine — HyperAgent Workflow Orchestrator
Receives workflow trigger message, dispatches to correct workflow, posts callback.
"""
import sys
import json
import os

# Make sure the workflow directory is on the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from helpers import http_post, post_callback

# Import all workflow modules
from wf01_ga_gsc_baseline import run as run_ga_gsc_baseline
from wf02_competitor_discovery import run as run_competitor_discovery
from wf03_competitor_enrichment_clay import run as run_competitor_enrichment_clay
from wf04_site_intelligence import run as run_site_intelligence
from wf05_permutation_engine import run as run_permutation_engine
from wf06_g2_review_mining import run as run_g2_review_mining
from wf07_reddit_intelligence import run as run_reddit_intelligence
from wf08_serp_analysis import run as run_serp_analysis
from wf09_synthesis_scoring import run as run_synthesis_scoring
from wf10_page_generator import run as run_page_generator
from wf11_content_brief_generator import run as run_content_brief_generator
from wf12_notion_push import run as run_notion_push
from wf13_ga_gsc_refresh import run as run_ga_gsc_refresh
from wf14_gsc_url_submit import run as run_gsc_url_submit
from wf15_voice_guide_index import run as run_voice_guide_index
from wf16_content_creator import run as run_content_creator
from wf17_plagiarism_check import run as run_plagiarism_check
from wf18_crosslink_inserter import run as run_crosslink_inserter
from wf19_atomizer import run as run_atomizer
from wf20_google_doc_export import run as run_google_doc_export


# ---------------------------------------------------------------------------
# Full pipeline runner
# ---------------------------------------------------------------------------

def run_full_pipeline(job_id, callback_url, project_slug, payload):
    """
    Run all 6 research stages sequentially, posting progress after each.
    Results from each stage are injected into payload for subsequent stages.
    """
    combined_result = {'stage_updates': {}}

    stages = [
        ('site_intelligence',    'Site_Intelligence',    run_site_intelligence),
        ('permutation_engine',   'Permutation_Engine',   run_permutation_engine),
        ('g2_review_mining',     'G2_Review_Mining',     run_g2_review_mining),
        ('reddit_intelligence',  'Reddit_Intelligence',  run_reddit_intelligence),
        ('serp_analysis',        'SERP_Analysis',        run_serp_analysis),
        ('synthesis_scoring',    'Synthesis_Scoring',    run_synthesis_scoring),
    ]

    for stage_key, wf_id, runner in stages:
        post_callback(callback_url, job_id, 'Run_Full_Pipeline', 'running',
                      log_message=f'Starting {wf_id}...')
        try:
            result = runner(job_id, callback_url, project_slug, payload)
            combined_result['stage_updates'][stage_key] = result

            # Inject this stage's results into payload for subsequent stages
            if stage_key == 'site_intelligence':
                payload['site_intelligence'] = result
            elif stage_key == 'permutation_engine':
                payload['keyword_clusters'] = result.get('keyword_clusters', [])
            elif stage_key == 'g2_review_mining':
                payload['g2_intelligence'] = result
                # Extract competitor G2 keywords for permutation enrichment
                payload['g2_keyword_opportunities'] = result.get('all_g2_keyword_opportunities', [])
            elif stage_key == 'reddit_intelligence':
                payload['reddit_intelligence'] = result
                payload['content_seeds'] = result.get('content_seeds', [])
            elif stage_key == 'serp_analysis':
                payload['serp_analysis'] = result.get('serp_analysis', {})

            post_callback(callback_url, job_id, 'Run_Full_Pipeline', 'running',
                          log_message=f'{wf_id} complete.')
        except Exception as e:
            import traceback
            err_msg = f'{wf_id} failed: {str(e)[:200]}'
            post_callback(callback_url, job_id, 'Run_Full_Pipeline', 'running',
                          log_message=err_msg)
            print(f"[orchestrator] Stage {wf_id} error: {traceback.format_exc()[:500]}")
            # Continue with remaining stages
            combined_result['stage_updates'][stage_key] = {'error': str(e)[:200]}

    return combined_result


# ---------------------------------------------------------------------------
# Dispatch table
# ---------------------------------------------------------------------------

DISPATCH = {
    'GA_GSC_Baseline':              run_ga_gsc_baseline,
    'Competitor_Discovery':         run_competitor_discovery,
    'Competitor_Enrichment_Clay':   run_competitor_enrichment_clay,
    'Site_Intelligence':            run_site_intelligence,
    'Permutation_Engine':           run_permutation_engine,
    'G2_Review_Mining':             run_g2_review_mining,
    'Reddit_Intelligence':          run_reddit_intelligence,
    'SERP_Analysis':                run_serp_analysis,
    'Synthesis_Scoring':            run_synthesis_scoring,
    'Page_Generator':               run_page_generator,
    'Content_Brief_Generator':      run_content_brief_generator,
    'Notion_Push':                  run_notion_push,
    'GA_GSC_Refresh':               run_ga_gsc_refresh,
    'GSC_URL_Submit':               run_gsc_url_submit,
    'Voice_Guide_Index':            run_voice_guide_index,
    'Content_Creator':              run_content_creator,
    'Plagiarism_Check':             run_plagiarism_check,
    'CrossLink_Inserter':           run_crosslink_inserter,
    'Atomizer':                     run_atomizer,
    'Google_Doc_Export':            run_google_doc_export,
    'Run_Full_Pipeline':            run_full_pipeline,
}


# ---------------------------------------------------------------------------
# Message parser
# ---------------------------------------------------------------------------

def parse_message(text):
    """
    Parse the workflow trigger message from Node.js.

    Message format (plain text, one field per line):
        WORKFLOW_TRIGGER
        workflow_id: X
        job_id: Y
        callback_url: Z
        project_slug: W

        PAYLOAD:
        {...json...}

    Also handles a pure JSON message (for direct testing):
        { "workflow_id": ..., "job_id": ..., "callback_url": ...,
          "project_slug": ..., "payload": {...} }
    """
    text = text.strip()

    # Try pure-JSON format first
    if text.startswith('{'):
        try:
            data = json.loads(text)
            return (
                data.get('workflow_id'),
                data.get('job_id'),
                data.get('callback_url'),
                data.get('project_slug'),
                data.get('payload', {}),
            )
        except json.JSONDecodeError:
            pass

    # Parse line-based format
    lines = text.split('\n')
    meta = {}
    payload_lines = []
    in_payload = False

    for line in lines:
        stripped = line.strip()
        if stripped == 'PAYLOAD:':
            in_payload = True
            continue
        if in_payload:
            payload_lines.append(line)
        elif ':' in stripped and not stripped.startswith('#'):
            k, v = stripped.split(':', 1)
            meta[k.strip()] = v.strip()

    payload_text = '\n'.join(payload_lines).strip()
    payload = {}
    if payload_text:
        try:
            payload = json.loads(payload_text)
        except json.JSONDecodeError as e:
            print(f"[orchestrator] WARNING: Could not parse payload JSON: {e}", file=sys.stderr)

    return (
        meta.get('workflow_id'),
        meta.get('job_id'),
        meta.get('callback_url'),
        meta.get('project_slug'),
        payload,
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    # Read message from stdin or first CLI argument
    if sys.argv[1:]:
        message_text = sys.argv[1]
    else:
        message_text = sys.stdin.read()

    if not message_text.strip():
        print("ERROR: Empty message received", file=sys.stderr)
        sys.exit(1)

    workflow_id, job_id, callback_url, project_slug, payload = parse_message(message_text)

    if not workflow_id:
        print("ERROR: Missing workflow_id in message", file=sys.stderr)
        sys.exit(1)
    if not job_id:
        print("ERROR: Missing job_id in message", file=sys.stderr)
        sys.exit(1)
    if not callback_url:
        print("ERROR: Missing callback_url in message", file=sys.stderr)
        sys.exit(1)

    print(f"[orchestrator] Dispatching workflow_id={workflow_id} job_id={job_id}")

    runner = DISPATCH.get(workflow_id)
    if not runner:
        post_callback(callback_url, job_id, workflow_id, 'failed',
                      error=f'Unknown workflow_id: {workflow_id}. '
                            f'Valid IDs: {list(DISPATCH.keys())}')
        sys.exit(1)

    try:
        result = runner(job_id, callback_url, project_slug, payload)
        post_callback(callback_url, job_id, workflow_id, 'complete', result=result)
        print(f"[orchestrator] Workflow {workflow_id} completed successfully")
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        error_msg = f'{type(e).__name__}: {str(e)}\n{tb[:500]}'
        print(f"[orchestrator] FATAL ERROR in {workflow_id}:\n{tb}", file=sys.stderr)
        post_callback(callback_url, job_id, workflow_id, 'failed', error=error_msg)
        sys.exit(1)


if __name__ == '__main__':
    main()
