#!/usr/bin/env python3
"""
WF13 — GA4 + GSC Refresh
Pulls current 30-day performance data and computes deltas vs baseline.
"""
import os
import re
import json
import urllib.parse
from datetime import date, timedelta
from helpers import (http_post, post_callback, get_google_access_token,
                     claude_message)

WORKFLOW_ID = 'GA_GSC_Refresh'

GA4_API = 'https://analyticsdata.googleapis.com/v1beta'
GSC_API = 'https://searchconsole.googleapis.com/v1'
GA_SCOPES = [
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/webmasters.readonly',
]


def pull_ga4_sessions(property_id, start_date, end_date, auth_headers):
    """Pull organic sessions + channel breakdown for date range."""
    try:
        body = {
            'dateRanges': [{'startDate': start_date, 'endDate': end_date}],
            'dimensions': [{'name': 'sessionDefaultChannelGroup'}],
            'metrics': [
                {'name': 'sessions'},
                {'name': 'activeUsers'},
                {'name': 'bounceRate'},
                {'name': 'averageSessionDuration'},
                {'name': 'conversions'},
            ],
            'limit': 20,
        }
        resp = http_post(
            f'{GA4_API}/properties/{property_id}:runReport',
            body, headers=auth_headers, timeout=60
        )
        channels = []
        for row in resp.get('rows', []):
            dims = row.get('dimensionValues', [])
            mets = row.get('metricValues', [])
            channels.append({
                'channel': dims[0]['value'] if dims else '',
                'sessions': int(float(mets[0]['value'])) if len(mets) > 0 else 0,
                'active_users': int(float(mets[1]['value'])) if len(mets) > 1 else 0,
                'bounce_rate': round(float(mets[2]['value']), 4) if len(mets) > 2 else 0,
                'avg_session_duration': round(float(mets[3]['value']), 2) if len(mets) > 3 else 0,
                'conversions': int(float(mets[4]['value'])) if len(mets) > 4 else 0,
            })
        return channels
    except Exception as e:
        print(f"[WF13] GA4 sessions error: {e}")
        return []


def pull_gsc_queries(property_url, start_date, end_date, auth_headers, row_limit=1000):
    """Pull GSC query data for date range."""
    encoded_prop = urllib.parse.quote(property_url, safe='')
    try:
        body = {
            'startDate': start_date,
            'endDate': end_date,
            'dimensions': ['query'],
            'rowLimit': row_limit,
        }
        resp = http_post(
            f'{GSC_API}/sites/{encoded_prop}/searchAnalytics/query',
            body, headers=auth_headers, timeout=90
        )
        rows = []
        for row in resp.get('rows', []):
            rows.append({
                'query': row.get('keys', [''])[0],
                'clicks': int(row.get('clicks', 0)),
                'impressions': int(row.get('impressions', 0)),
                'ctr': round(float(row.get('ctr', 0)), 4),
                'position': round(float(row.get('position', 0)), 2),
            })
        return rows
    except Exception as e:
        print(f"[WF13] GSC queries error: {e}")
        return []


def pull_gsc_pages(property_url, start_date, end_date, auth_headers, page_filter=None):
    """Pull GSC page data, optionally filtered to specific pages."""
    encoded_prop = urllib.parse.quote(property_url, safe='')
    try:
        body = {
            'startDate': start_date,
            'endDate': end_date,
            'dimensions': ['page'],
            'rowLimit': 500,
        }
        if page_filter:
            body['dimensionFilterGroups'] = [{
                'filters': [{
                    'dimension': 'page',
                    'operator': 'includingRegex',
                    'expression': '|'.join(re.escape(p) for p in page_filter[:20]),
                }]
            }]
        resp = http_post(
            f'{GSC_API}/sites/{encoded_prop}/searchAnalytics/query',
            body, headers=auth_headers, timeout=90
        )
        rows = []
        for row in resp.get('rows', []):
            rows.append({
                'page': row.get('keys', [''])[0],
                'clicks': int(row.get('clicks', 0)),
                'impressions': int(row.get('impressions', 0)),
                'ctr': round(float(row.get('ctr', 0)), 4),
                'position': round(float(row.get('position', 0)), 2),
            })
        return rows
    except Exception as e:
        print(f"[WF13] GSC pages error: {e}")
        return []


def compute_delta(current_val, baseline_val):
    """Compute absolute and percentage delta."""
    delta_abs = current_val - baseline_val
    if baseline_val and baseline_val != 0:
        delta_pct = round((delta_abs / abs(baseline_val)) * 100, 1)
    else:
        delta_pct = 100.0 if delta_abs > 0 else 0.0
    return {'absolute': delta_abs, 'pct': delta_pct}


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { ga4_property_id, gsc_property_url, service_account_json, baseline, published_pages }
    returns: { refresh_date, period, ga4_current, gsc_current, published_page_performance,
               deltas, wins, alerts, narrative }
    """
    ga4_property_id = payload.get('ga4_property_id', '')
    gsc_property_url = payload.get('gsc_property_url', '')
    baseline = payload.get('baseline', {}) or {}
    published_pages = payload.get('published_pages', []) or []

    sa_json = payload.get('service_account_json') or os.environ.get('GOOGLE_SERVICE_ACCOUNT_JSON', '{}')
    if isinstance(sa_json, str):
        sa_json = json.loads(sa_json)

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF13: Starting GA4 + GSC 30-day refresh...')

    # Date range: last 30 days
    end_dt = date.today()
    start_dt = end_dt - timedelta(days=30)
    end_date = end_dt.isoformat()
    start_date = start_dt.isoformat()
    period = f"{start_date} to {end_date}"

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF13: Authenticating... Period: {period}')

    access_token = get_google_access_token(sa_json, GA_SCOPES)
    auth_headers = {'Authorization': f'Bearer {access_token}'}

    # -----------------------------------------------------------------------
    # Step 1: Pull current GA4 data
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF13: Pulling current GA4 channel data...')

    ga4_current = pull_ga4_sessions(ga4_property_id, start_date, end_date, auth_headers)

    # -----------------------------------------------------------------------
    # Step 2: Pull current GSC data
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF13: Pulling current GSC query data...')

    gsc_current_queries = pull_gsc_queries(gsc_property_url, start_date, end_date, auth_headers)

    # -----------------------------------------------------------------------
    # Step 3: Pull per-page GSC for published pages
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF13: Pulling GSC data for {len(published_pages)} published pages...')

    published_page_performance = []
    if published_pages:
        page_gsc_rows = pull_gsc_pages(
            gsc_property_url, start_date, end_date, auth_headers,
            page_filter=published_pages
        )
        page_gsc_map = {r['page']: r for r in page_gsc_rows}

        for pg_url in published_pages:
            gsc = page_gsc_map.get(pg_url, {})
            published_page_performance.append({
                'url': pg_url,
                'clicks': gsc.get('clicks', 0),
                'impressions': gsc.get('impressions', 0),
                'ctr': gsc.get('ctr', 0),
                'position': gsc.get('position', 0),
                'days_since_publish': (date.today() - date.today()).days,  # Could track pub date
                'indexed': gsc.get('impressions', 0) > 0,
            })

    # -----------------------------------------------------------------------
    # Step 4: Compute deltas vs baseline
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF13: Computing deltas vs baseline...')

    # Find organic channel in current
    organic_current = next(
        (c for c in ga4_current if 'organic' in c.get('channel', '').lower()),
        {}
    )
    organic_baseline = next(
        (c for c in (baseline.get('ga4_channel_breakdown') or [])
         if 'organic' in c.get('channel', '').lower()),
        {}
    )

    # GSC aggregate metrics
    current_clicks = sum(q['clicks'] for q in gsc_current_queries)
    current_impressions = sum(q['impressions'] for q in gsc_current_queries)
    current_avg_pos = (
        round(sum(q['position'] for q in gsc_current_queries) / len(gsc_current_queries), 2)
        if gsc_current_queries else 0
    )

    baseline_summary = baseline.get('summary', {})
    # Scale baseline to 30-day equivalent
    baseline_days = baseline_summary.get('date_range_days', 90)
    scale = 30 / baseline_days if baseline_days > 0 else 1

    baseline_clicks_30 = int((baseline_summary.get('total_gsc_clicks', 0) or 0) * scale)
    baseline_impressions_30 = int((baseline_summary.get('total_gsc_impressions', 0) or 0) * scale)
    baseline_sessions_30 = int((organic_baseline.get('sessions', 0) or 0) * scale)

    deltas = {
        'organic_sessions': compute_delta(
            organic_current.get('sessions', 0), baseline_sessions_30),
        'gsc_clicks': compute_delta(current_clicks, baseline_clicks_30),
        'gsc_impressions': compute_delta(current_impressions, baseline_impressions_30),
        'avg_position': compute_delta(
            current_avg_pos,
            baseline_summary.get('average_position', current_avg_pos)
        ),
    }

    # -----------------------------------------------------------------------
    # Step 5: Identify wins and alerts
    # -----------------------------------------------------------------------
    baseline_queries = {q['query']: q for q in (baseline.get('gsc_all_queries') or [])}

    wins = []
    alerts = []

    for q in gsc_current_queries:
        query = q['query']
        baseline_q = baseline_queries.get(query, {})

        if baseline_q:
            baseline_pos = baseline_q.get('position', 100)
            current_pos = q['position']

            # Win: moved from outside top 10 to top 10
            if baseline_pos > 10 and current_pos <= 10:
                wins.append({
                    'keyword': query,
                    'old_position': round(baseline_pos, 1),
                    'new_position': round(current_pos, 1),
                    'impressions': q['impressions'],
                    'clicks': q['clicks'],
                    'win_type': 'entered_top_10',
                })
            # Win: significant position improvement
            elif baseline_pos - current_pos >= 5:
                wins.append({
                    'keyword': query,
                    'old_position': round(baseline_pos, 1),
                    'new_position': round(current_pos, 1),
                    'improvement': round(baseline_pos - current_pos, 1),
                    'impressions': q['impressions'],
                    'win_type': 'position_improvement',
                })

    # Alerts for published pages not yet ranking
    for pg in published_page_performance:
        if not pg['indexed'] and pg.get('days_since_publish', 0) > 90:
            alerts.append({
                'url': pg['url'],
                'type': 'not_indexed_90_days',
                'message': f"Page published >90 days ago has zero GSC impressions",
            })
        elif pg['position'] > 20 and pg['impressions'] > 0:
            alerts.append({
                'url': pg['url'],
                'type': 'still_outside_top_20',
                'position': pg['position'],
                'message': f"Page ranking at position {pg['position']:.1f} — below top 20",
            })

    wins.sort(key=lambda x: x.get('improvement', x.get('old_position', 0) - x.get('new_position', 0)), reverse=True)

    # -----------------------------------------------------------------------
    # Step 6: Claude narrative
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF13: Generating performance narrative via Claude...')

    narrative = ''
    try:
        wins_text = '\n'.join(
            f"- '{w['keyword']}': position {w.get('old_position', '?')} → {w['new_position']}"
            for w in wins[:5]
        )
        alerts_text = '\n'.join(f"- {a['message']}: {a.get('url', '')}" for a in alerts[:3])

        system = (
            "You are an SEO performance analyst. Write a concise 5-7 sentence executive summary "
            "of SEO performance this period. Include 3-5 win bullets and 1-2 alert bullets. "
            "Be specific about numbers. Professional tone."
        )
        user = (
            f"Period: {period}\n\n"
            f"Key metrics:\n"
            f"- Organic sessions delta: {deltas['organic_sessions']['absolute']:+d} "
            f"({deltas['organic_sessions']['pct']:+.1f}%)\n"
            f"- GSC clicks delta: {deltas['gsc_clicks']['absolute']:+d} "
            f"({deltas['gsc_clicks']['pct']:+.1f}%)\n"
            f"- GSC impressions delta: {deltas['gsc_impressions']['absolute']:+d}\n"
            f"- Avg position delta: {deltas['avg_position']['absolute']:+.2f}\n\n"
            f"Top wins:\n{wins_text or 'None yet'}\n\n"
            f"Alerts:\n{alerts_text or 'None'}\n\n"
            f"Published pages tracked: {len(published_pages)}"
        )
        narrative = claude_message(system, user, max_tokens=400)
    except Exception as e:
        print(f"[WF13] Narrative generation error: {e}")
        narrative = (
            f"30-day refresh complete. "
            f"Organic clicks {deltas['gsc_clicks']['pct']:+.1f}% vs baseline. "
            f"{len(wins)} keyword wins recorded. "
            f"{len(alerts)} alerts requiring attention."
        )

    gsc_current = {
        'queries': gsc_current_queries[:100],
        'total_queries': len(gsc_current_queries),
        'total_clicks': current_clicks,
        'total_impressions': current_impressions,
        'avg_position': current_avg_pos,
    }

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF13: Complete. {len(wins)} wins, {len(alerts)} alerts.')

    return {
        'refresh_date': date.today().isoformat(),
        'period': period,
        'ga4_current': ga4_current,
        'gsc_current': gsc_current,
        'published_page_performance': published_page_performance,
        'deltas': deltas,
        'wins': wins[:20],
        'alerts': alerts[:10],
        'narrative': narrative,
    }
