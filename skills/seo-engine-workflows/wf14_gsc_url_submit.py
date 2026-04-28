#!/usr/bin/env python3
"""
WF14 — GSC URL Submission
Inspects URLs via GSC URL Inspection API and submits non-indexed URLs to Google Indexing API.
"""
import os
import json
import time
from helpers import (http_post, post_callback, get_google_access_token)

WORKFLOW_ID = 'GSC_URL_Submit'

GSC_INSPECT_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect'
INDEXING_API_URL = 'https://indexing.googleapis.com/v3/urlNotifications:publish'

GA_SCOPES = [
    'https://www.googleapis.com/auth/webmasters',
    'https://www.googleapis.com/auth/indexing',
]

# Coverage states that mean the URL is already indexed
INDEXED_STATES = {'Submitted and indexed', 'Indexed, not submitted in sitemap',
                  'Indexed, submitted in sitemap'}

# Coverage states that should trigger an indexing request
INDEXABLE_STATES = {
    'URL is unknown to Google', 'Crawled - currently not indexed',
    'Discovered - currently not indexed', 'Page with redirect',
    'Excluded by noindex tag',  # Intentionally skip this one in logic
}


def inspect_url(url, site_url, auth_headers):
    """
    Inspect a URL via GSC URL Inspection API.
    Returns: { coverage_state, last_crawl_time, indexing_state, is_indexed }
    """
    body = {
        'inspectionUrl': url,
        'siteUrl': site_url,
        'languageCode': 'en-US',
    }
    try:
        resp = http_post(GSC_INSPECT_URL, body, headers=auth_headers, timeout=30)
        result = resp.get('inspectionResult', {})
        index_status = result.get('indexStatusResult', {})
        coverage = index_status.get('coverageState', 'URL is unknown to Google')
        verdict = index_status.get('verdict', 'VERDICT_UNSPECIFIED')

        return {
            'coverage_state': coverage,
            'verdict': verdict,
            'last_crawl_time': index_status.get('lastCrawlTime', ''),
            'is_indexed': coverage in INDEXED_STATES or verdict == 'PASS',
            'robots_txt_state': index_status.get('robotsTxtState', ''),
            'indexing_state': index_status.get('indexingState', ''),
            'sitemap': index_status.get('sitemap', []),
        }
    except Exception as e:
        print(f"[WF14] Inspection error for {url}: {e}")
        return {
            'coverage_state': 'Error',
            'verdict': 'ERROR',
            'last_crawl_time': '',
            'is_indexed': False,
            'error': str(e),
        }


def submit_url_for_indexing(url, auth_headers):
    """
    Submit a URL to Google Indexing API.
    Returns: { notified, notification_type, url, error }
    """
    body = {
        'url': url,
        'type': 'URL_UPDATED',
    }
    try:
        resp = http_post(INDEXING_API_URL, body, headers=auth_headers, timeout=30)
        return {
            'notified': True,
            'notification_type': resp.get('urlNotificationMetadata', {}).get('latestUpdate', {}).get('type', 'URL_UPDATED'),
            'url': url,
            'notify_time': resp.get('urlNotificationMetadata', {}).get('latestUpdate', {}).get('notifyTime', ''),
        }
    except Exception as e:
        print(f"[WF14] Indexing API error for {url}: {e}")
        return {
            'notified': False,
            'url': url,
            'error': str(e),
        }


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { gsc_property_url, service_account_json, urls_to_submit }
    returns: { submission_results, total_submitted, already_indexed, indexing_requested }
    """
    gsc_property_url = payload.get('gsc_property_url', '')
    urls_to_submit = payload.get('urls_to_submit', []) or []

    sa_json = payload.get('service_account_json') or os.environ.get('GOOGLE_SERVICE_ACCOUNT_JSON', '{}')
    if isinstance(sa_json, str):
        sa_json = json.loads(sa_json)

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF14: Preparing to submit {len(urls_to_submit)} URLs...')

    if not urls_to_submit:
        return {
            'submission_results': [],
            'total_submitted': 0,
            'already_indexed': 0,
            'indexing_requested': 0,
        }

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF14: Authenticating with Google APIs...')

    access_token = get_google_access_token(sa_json, GA_SCOPES)
    auth_headers = {'Authorization': f'Bearer {access_token}'}

    submission_results = []
    already_indexed = 0
    indexing_requested = 0
    total_submitted = len(urls_to_submit)

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF14: Inspecting and submitting {total_submitted} URLs...')

    for idx, url in enumerate(urls_to_submit, 1):
        if not url or not url.startswith('http'):
            submission_results.append({
                'url': url,
                'status': 'skipped',
                'reason': 'Invalid URL',
            })
            continue

        print(f"[WF14] Processing URL {idx}/{total_submitted}: {url}")

        # Step 1: Inspect URL
        inspection = inspect_url(url, gsc_property_url, auth_headers)
        result = {
            'url': url,
            'coverage_state': inspection.get('coverage_state', ''),
            'verdict': inspection.get('verdict', ''),
            'last_crawl_time': inspection.get('last_crawl_time', ''),
            'is_indexed': inspection.get('is_indexed', False),
            'indexing_requested': False,
        }

        if inspection.get('is_indexed'):
            result['status'] = 'already_indexed'
            already_indexed += 1
            print(f"[WF14]   Already indexed: {inspection['coverage_state']}")
        elif inspection.get('error'):
            result['status'] = 'inspection_failed'
            result['error'] = inspection['error']
            print(f"[WF14]   Inspection failed: {inspection['error']}")
        else:
            # Step 2: Submit to Indexing API
            coverage = inspection.get('coverage_state', '')

            # Skip noindex pages
            if 'noindex' in coverage.lower():
                result['status'] = 'skipped_noindex'
                result['reason'] = coverage
                print(f"[WF14]   Skipped (noindex): {coverage}")
            else:
                submit_result = submit_url_for_indexing(url, auth_headers)
                result['indexing_requested'] = submit_result.get('notified', False)
                result['notification_type'] = submit_result.get('notification_type', '')
                result['notify_time'] = submit_result.get('notify_time', '')

                if submit_result.get('notified'):
                    result['status'] = 'indexing_requested'
                    indexing_requested += 1
                    print(f"[WF14]   Submitted for indexing")
                else:
                    result['status'] = 'submission_failed'
                    result['error'] = submit_result.get('error', 'Unknown error')
                    print(f"[WF14]   Submission failed: {result['error']}")

        submission_results.append(result)

        # 1-second wait between submissions (per spec)
        time.sleep(1)

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF14: Complete. Total: {total_submitted}, '
                               f'Already indexed: {already_indexed}, '
                               f'Submitted: {indexing_requested}.')

    return {
        'submission_results': submission_results,
        'total_submitted': total_submitted,
        'already_indexed': already_indexed,
        'indexing_requested': indexing_requested,
        'submission_failed': sum(1 for r in submission_results if r['status'] == 'submission_failed'),
    }
