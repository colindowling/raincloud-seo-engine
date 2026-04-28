#!/usr/bin/env python3
"""
WF01 — GA4 + GSC Baseline
Pulls GA4 traffic data and GSC keyword data to establish pre-campaign baseline.
"""
import os
import json
import urllib.parse
from datetime import date, timedelta
from helpers import (http_post, http_get, post_callback,
                     get_google_access_token, dfs_auth)

WORKFLOW_ID = 'GA_GSC_Baseline'

GA4_API = 'https://analyticsdata.googleapis.com/v1beta'
GSC_API = 'https://searchconsole.googleapis.com/v1'
GA_SCOPES = [
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/webmasters.readonly',
]


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { ga4_property_id, gsc_property_url, service_account_json, date_range_days }
    returns: { baseline_date_range, ga4_channel_breakdown, ga4_top_pages, gsc_all_queries,
               gsc_all_pages, striking_distance_keywords, already_ranking_p1, summary }
    """
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF01: Initialising GA4 + GSC baseline pull...')

    ga4_property_id = payload.get('ga4_property_id', '')
    gsc_property_url = payload.get('gsc_property_url', '')
    date_range_days = int(payload.get('date_range_days', 90))

    # Parse service account JSON
    sa_json = payload.get('service_account_json') or os.environ.get('GOOGLE_SERVICE_ACCOUNT_JSON', '{}')
    if isinstance(sa_json, str):
        try:
            sa_json = json.loads(sa_json)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"Invalid service_account_json: {e}")

    # Build date range
    end_dt = date.today()
    start_dt = end_dt - timedelta(days=date_range_days)
    end_date = end_dt.isoformat()
    start_date = start_dt.isoformat()

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF01: Authenticating with Google APIs ({start_date} → {end_date})...')

    # Obtain access token
    access_token = get_google_access_token(sa_json, GA_SCOPES)
    auth_headers = {'Authorization': f'Bearer {access_token}'}

    # -----------------------------------------------------------------------
    # GA4 — channel breakdown
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF01: Pulling GA4 channel breakdown...')

    ga4_channel_breakdown = []
    try:
        ga4_ch_body = {
            'dateRanges': [{'startDate': start_date, 'endDate': end_date}],
            'dimensions': [{'name': 'sessionDefaultChannelGroup'}],
            'metrics': [
                {'name': 'sessions'},
                {'name': 'activeUsers'},
                {'name': 'bounceRate'},
                {'name': 'averageSessionDuration'},
            ],
            'limit': 20,
        }
        ch_resp = http_post(
            f'{GA4_API}/properties/{ga4_property_id}:runReport',
            ga4_ch_body, headers=auth_headers, timeout=60
        )
        for row in ch_resp.get('rows', []):
            dims = row.get('dimensionValues', [])
            mets = row.get('metricValues', [])
            ga4_channel_breakdown.append({
                'channel': dims[0]['value'] if dims else '',
                'sessions': int(float(mets[0]['value'])) if len(mets) > 0 else 0,
                'active_users': int(float(mets[1]['value'])) if len(mets) > 1 else 0,
                'bounce_rate': round(float(mets[2]['value']), 4) if len(mets) > 2 else 0,
                'avg_session_duration': round(float(mets[3]['value']), 2) if len(mets) > 3 else 0,
            })
        print(f"[WF01] GA4 channel rows: {len(ga4_channel_breakdown)}")
    except Exception as e:
        print(f"[WF01] GA4 channel breakdown error: {e}")
        ga4_channel_breakdown = []

    # -----------------------------------------------------------------------
    # GA4 — top 50 organic pages
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF01: Pulling GA4 top organic pages...')

    ga4_top_pages = []
    try:
        ga4_pages_body = {
            'dateRanges': [{'startDate': start_date, 'endDate': end_date}],
            'dimensions': [
                {'name': 'pagePath'},
                {'name': 'pageTitle'},
                {'name': 'sessionDefaultChannelGroup'},
            ],
            'metrics': [
                {'name': 'sessions'},
                {'name': 'activeUsers'},
                {'name': 'bounceRate'},
                {'name': 'averageSessionDuration'},
            ],
            'dimensionFilter': {
                'filter': {
                    'fieldName': 'sessionDefaultChannelGroup',
                    'stringFilter': {'matchType': 'CONTAINS', 'value': 'Organic'},
                }
            },
            'orderBys': [{'metric': {'metricName': 'sessions'}, 'desc': True}],
            'limit': 50,
        }
        pages_resp = http_post(
            f'{GA4_API}/properties/{ga4_property_id}:runReport',
            ga4_pages_body, headers=auth_headers, timeout=60
        )
        for row in pages_resp.get('rows', []):
            dims = row.get('dimensionValues', [])
            mets = row.get('metricValues', [])
            ga4_top_pages.append({
                'page_path': dims[0]['value'] if dims else '',
                'page_title': dims[1]['value'] if len(dims) > 1 else '',
                'sessions': int(float(mets[0]['value'])) if len(mets) > 0 else 0,
                'active_users': int(float(mets[1]['value'])) if len(mets) > 1 else 0,
                'bounce_rate': round(float(mets[2]['value']), 4) if len(mets) > 2 else 0,
                'avg_session_duration': round(float(mets[3]['value']), 2) if len(mets) > 3 else 0,
            })
        print(f"[WF01] GA4 top pages: {len(ga4_top_pages)}")
    except Exception as e:
        print(f"[WF01] GA4 top pages error: {e}")
        ga4_top_pages = []

    # -----------------------------------------------------------------------
    # GSC — all queries (up to 1000)
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF01: Pulling GSC query data...')

    gsc_all_queries = []
    try:
        gsc_q_body = {
            'startDate': start_date,
            'endDate': end_date,
            'dimensions': ['query'],
            'rowLimit': 1000,
            'startRow': 0,
        }
        encoded_prop = urllib.parse.quote(gsc_property_url, safe='')
        gsc_q_resp = http_post(
            f'{GSC_API}/sites/{encoded_prop}/searchAnalytics/query',
            gsc_q_body, headers=auth_headers, timeout=90
        )
        for row in gsc_q_resp.get('rows', []):
            gsc_all_queries.append({
                'query': row.get('keys', [''])[0],
                'clicks': int(row.get('clicks', 0)),
                'impressions': int(row.get('impressions', 0)),
                'ctr': round(float(row.get('ctr', 0)), 4),
                'position': round(float(row.get('position', 0)), 2),
            })
        print(f"[WF01] GSC queries: {len(gsc_all_queries)}")
    except Exception as e:
        print(f"[WF01] GSC queries error: {e}")
        gsc_all_queries = []

    # -----------------------------------------------------------------------
    # GSC — all pages (up to 500)
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF01: Pulling GSC page data...')

    gsc_all_pages = []
    try:
        gsc_p_body = {
            'startDate': start_date,
            'endDate': end_date,
            'dimensions': ['page'],
            'rowLimit': 500,
            'startRow': 0,
        }
        gsc_p_resp = http_post(
            f'{GSC_API}/sites/{encoded_prop}/searchAnalytics/query',
            gsc_p_body, headers=auth_headers, timeout=90
        )
        for row in gsc_p_resp.get('rows', []):
            gsc_all_pages.append({
                'page': row.get('keys', [''])[0],
                'clicks': int(row.get('clicks', 0)),
                'impressions': int(row.get('impressions', 0)),
                'ctr': round(float(row.get('ctr', 0)), 4),
                'position': round(float(row.get('position', 0)), 2),
            })
        print(f"[WF01] GSC pages: {len(gsc_all_pages)}")
    except Exception as e:
        print(f"[WF01] GSC pages error: {e}")
        gsc_all_pages = []

    # -----------------------------------------------------------------------
    # Derived: striking distance + P1 rankings
    # -----------------------------------------------------------------------
    striking_distance_keywords = []
    already_ranking_p1 = []

    for q in gsc_all_queries:
        pos = q['position']
        imp = q['impressions']
        if imp >= 10:
            if 4.0 <= pos <= 20.0:
                striking_distance_keywords.append(q)
            elif pos <= 3.0:
                already_ranking_p1.append(q)

    striking_distance_keywords.sort(key=lambda x: x['impressions'], reverse=True)
    already_ranking_p1.sort(key=lambda x: x['clicks'], reverse=True)

    print(f"[WF01] Striking distance: {len(striking_distance_keywords)}, P1: {len(already_ranking_p1)}")

    # -----------------------------------------------------------------------
    # Summary stats
    # -----------------------------------------------------------------------
    organic_channel = next(
        (c for c in ga4_channel_breakdown
         if 'organic' in c['channel'].lower()),
        {}
    )
    total_gsc_clicks = sum(q['clicks'] for q in gsc_all_queries)
    total_gsc_impressions = sum(q['impressions'] for q in gsc_all_queries)
    avg_position = (
        round(sum(q['position'] for q in gsc_all_queries) / len(gsc_all_queries), 2)
        if gsc_all_queries else 0
    )

    summary = {
        'organic_sessions': organic_channel.get('sessions', 0),
        'organic_users': organic_channel.get('active_users', 0),
        'total_indexed_queries': len(gsc_all_queries),
        'total_gsc_clicks': total_gsc_clicks,
        'total_gsc_impressions': total_gsc_impressions,
        'average_position': avg_position,
        'striking_distance_count': len(striking_distance_keywords),
        'p1_keywords_count': len(already_ranking_p1),
        'date_range_days': date_range_days,
    }

    result = {
        'baseline_date_range': {'start_date': start_date, 'end_date': end_date},
        'ga4_channel_breakdown': ga4_channel_breakdown,
        'ga4_top_pages': ga4_top_pages,
        'gsc_all_queries': gsc_all_queries,
        'gsc_all_pages': gsc_all_pages,
        'striking_distance_keywords': striking_distance_keywords,
        'already_ranking_p1': already_ranking_p1,
        'summary': summary,
    }

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF01: Complete. {len(gsc_all_queries)} queries, '
                               f'{len(striking_distance_keywords)} striking-distance, '
                               f'{len(already_ranking_p1)} P1 rankings.')
    return result
