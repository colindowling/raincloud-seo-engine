#!/usr/bin/env python3
"""
WF08 — SERP Analysis
Analyses search engine results for each keyword cluster to assess competition and opportunity.

DA Note: DataForSEO's SERP endpoint does not return domain authority scores (rank_info is null).
We use a curated domain authority table + heuristics to estimate avg_page1_da.
Displaceability thresholds: avg_da < 45 = High, 45-65 = Medium, >65 = Low.
"""
import time
import re
import math
from helpers import (http_post, post_callback, dfs_auth, claude_message, chunked)

WORKFLOW_ID = 'SERP_Analysis'

DFS_SERP_URL = 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced'


# ---------------------------------------------------------------------------
# Domain Authority lookup — curated table covering common B2B SaaS SERP domains
# DataForSEO doesn't provide DA in SERP responses; this is our best-effort estimate.
# ---------------------------------------------------------------------------
_KNOWN_DA = {
    # Aggregators
    'reddit.com': 93, 'quora.com': 87, 'linkedin.com': 99, 'youtube.com': 99,
    'wikipedia.org': 97, 'google.com': 99, 'microsoft.com': 96, 'amazon.com': 96,
    # Review / comparison sites
    'g2.com': 85, 'capterra.com': 84, 'getapp.com': 80, 'softwareadvice.com': 77,
    'trustradius.com': 79, 'trustpilot.com': 80, 'glassdoor.com': 89, 'pcmag.com': 85,
    # Analyst / media
    'gartner.com': 88, 'forrester.com': 84, 'idc.com': 80, 'hbr.org': 91,
    'techcrunch.com': 91, 'forbes.com': 94, 'businessinsider.com': 92,
    'entrepreneur.com': 90, 'inc.com': 88, 'venturebeat.com': 86,
    'zdnet.com': 87, 'infoworld.com': 84, 'medium.com': 91,
    # Large SaaS platforms
    'salesforce.com': 92, 'hubspot.com': 91, 'zendesk.com': 84, 'atlassian.com': 85,
    'slack.com': 89, 'zoom.us': 87, 'intercom.com': 79, 'shopify.com': 90,
    'stripe.com': 83, 'mailchimp.com': 85, 'zoominfo.com': 80,
    # Revenue intelligence / sales engagement
    'gong.io': 63, 'chorus.ai': 51, 'salesloft.com': 57, 'outreach.io': 60,
    'clari.com': 55, 'revenue.io': 47, 'mindtickle.com': 50, 'apollo.io': 65,
    'seamless.ai': 60, 'lusha.com': 62, 'clearbit.com': 67, '6sense.com': 65,
    'demandbase.com': 67, 'bombora.com': 62, 'cognism.com': 60,
    # Other common B2B SaaS
    'pipedrive.com': 73, 'close.com': 67, 'semrush.com': 75, 'ahrefs.com': 72,
    'moz.com': 70, 'similarweb.com': 73, 'hootsuite.com': 79,
    'ringcentral.com': 79, 'dialpad.com': 68, 'aircall.io': 62,
    'claap.io': 45, 'revenuegrid.com': 52, 'klenty.com': 55, 'reply.io': 58,
    'lemlist.com': 60, 'mixmax.com': 58, 'instantly.ai': 55, 'smartlead.ai': 45,
    'yesware.com': 60, 'groove.co': 48, 'woodpecker.co': 55, 'overloop.io': 42,
}

_SUBDOMAIN_RE = re.compile(r'^(?:www\.|blog\.|support\.|help\.|docs\.|community\.|learn\.|resources\.|go\.)')


def _domain_da(domain: str) -> int:
    """Return estimated DA for a domain (0-100)."""
    normalized = _SUBDOMAIN_RE.sub('', (domain or '').lower())
    if normalized in _KNOWN_DA:
        return _KNOWN_DA[normalized]
    # Heuristic: .gov/.edu/.org tend to be authoritative
    if any(tld in normalized for tld in ['.gov', '.edu', '.org']):
        return 72
    # Short single-segment domains (e.g., stripe.com) tend to be established
    bare = normalized.split('.')[0]
    if len(bare) <= 8:
        return 48
    return 35


def assess_displaceability(organic_results: list[dict]) -> dict:
    """
    Compute avg_page1_da from organic SERP results using curated DA table.
    Returns: { avg_page1_da, level, domain_breakdown }
    level: 'High' | 'Medium' | 'Low'
    """
    if not organic_results:
        return {'avg_page1_da': 50, 'level': 'Medium', 'domain_breakdown': []}

    breakdown = []
    for r in organic_results[:10]:
        domain = r.get('domain', '')
        da = _domain_da(domain)
        breakdown.append({'domain': domain, 'da': da})

    avg_da = round(sum(b['da'] for b in breakdown) / len(breakdown), 1)
    level = 'High' if avg_da < 45 else 'Medium' if avg_da <= 65 else 'Low'

    return {
        'avg_page1_da': avg_da,
        'level': level,
        'domain_breakdown': breakdown,
    }


def detect_content_format_preference(serp_results):
    """
    Classify the predominant content format from SERP page 1.
    Returns a dict of format counts and the preferred format.
    """
    format_counts = {
        'listicle': 0,
        'guide': 0,
        'comparison': 0,
        'product_page': 0,
        'homepage': 0,
        'review': 0,
        'tool': 0,
        'other': 0,
    }

    for r in serp_results:
        title = (r.get('title', '') or '').lower()
        url = (r.get('url', '') or '').lower()
        combined = title + ' ' + url

        if any(w in combined for w in ['top ', 'best ', 'ranked', 'review', 'list of']):
            if 'comparison' in combined or ' vs ' in combined:
                format_counts['comparison'] += 1
            elif 'review' in combined:
                format_counts['review'] += 1
            else:
                format_counts['listicle'] += 1
        elif any(w in combined for w in ['guide', 'how to', 'tutorial', 'learn', 'what is']):
            format_counts['guide'] += 1
        elif any(w in combined for w in ['vs ', ' vs', 'compare', 'alternative']):
            format_counts['comparison'] += 1
        elif any(w in combined for w in ['/product', '/solution', '/platform', '/software']):
            format_counts['product_page'] += 1
        elif url.count('/') <= 2:
            format_counts['homepage'] += 1
        else:
            format_counts['other'] += 1

    preferred = max(format_counts, key=lambda k: format_counts[k])
    return {'counts': format_counts, 'preferred': preferred}


def detect_featured_snippet_opportunity(keyword, serp_items):
    """
    True if there is a question-style keyword and no featured snippet exists yet.
    """
    has_question = any(kw in keyword.lower() for kw in ['how', 'what', 'why', 'when', 'which', 'who'])
    has_snippet = any(i.get('type') == 'featured_snippet' for i in serp_items)
    return has_question and not has_snippet


def extract_paa_questions(serp_items):
    """Extract People Also Ask questions from SERP items."""
    questions = []
    for item in serp_items:
        if item.get('type') == 'people_also_ask':
            for q in item.get('items', []):
                text = q.get('title') or q.get('question') or ''
                if text:
                    questions.append(text)
    return questions[:8]


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { keyword_clusters, client_domain }
    returns: { serp_analysis: { "CL-001": {...}, ... } }
    """
    keyword_clusters = payload.get('keyword_clusters', []) or []
    client_domain = payload.get('client_domain', '')

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF08: Starting SERP analysis for {len(keyword_clusters)} clusters...')

    serp_analysis = {}
    total = len(keyword_clusters)

    # Process in batches of 10
    batch_num = 0
    for batch in chunked(keyword_clusters, 10):
        batch_num += 1
        post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                      log_message=f'WF08: Fetching SERPs batch {batch_num} '
                                   f'({(batch_num-1)*10+1}-{min(batch_num*10, total)} of {total})...')

        # Build DFS task list
        tasks = []
        for cluster in batch:
            tasks.append({
                'keyword': cluster['primary_keyword'],
                'location_code': 2840,
                'language_code': 'en',
                'device': 'desktop',
                'os': 'windows',
                'depth': 10,
                'load_async': False,
            })

        try:
            resp = http_post(DFS_SERP_URL, tasks, headers=dfs_auth(), timeout=120)
        except Exception as e:
            print(f"[WF08] SERP batch {batch_num} error: {e}")
            # Mark clusters as failed
            for cluster in batch:
                cid = cluster['cluster_id']
                serp_analysis[cid] = {'cluster_id': cid, 'error': str(e)}
            time.sleep(2)
            continue

        # Map results back to clusters by keyword
        result_by_keyword = {}
        for task in resp.get('tasks', []):
            # keyword is in the original post data
            kw = task.get('data', {}).get('keyword', '')
            for result in (task.get('result') or []):
                result_by_keyword[kw] = result

        for cluster in batch:
            cid = cluster['cluster_id']
            kw = cluster['primary_keyword']
            result = result_by_keyword.get(kw, {})
            items = result.get('items', []) or []

            # Extract organic results only
            organic_items = [i for i in items if i.get('type') == 'organic']
            paa_items = [i for i in items if i.get('type') == 'people_also_ask']
            has_snippet = any(i.get('type') == 'featured_snippet' for i in items)

            # Build top 10 results — include estimated DA per result
            top_10 = []
            for item in organic_items[:10]:
                domain = item.get('domain', '')
                top_10.append({
                    'position': item.get('rank_absolute') or item.get('rank_group', 0),
                    'url': item.get('url', ''),
                    'domain': domain,
                    'title': item.get('title', ''),
                    'description': item.get('description', ''),
                    'da': _domain_da(domain),   # estimated domain authority
                    'type': item.get('type', 'organic'),
                })

            # Displaceability — uses curated DA table (rank_info is null in DFS SERP)
            displaceability_data = assess_displaceability(top_10)
            format_preference = detect_content_format_preference(top_10)
            snippet_opportunity = detect_featured_snippet_opportunity(kw, items)
            paa_questions = extract_paa_questions(paa_items)

            # Detect if client is already ranking
            client_domain_bare = (client_domain
                .replace('https://', '').replace('http://', '')
                .split('/')[0].lstrip('www.'))
            client_position = None
            for r in top_10:
                if client_domain_bare in r.get('domain', ''):
                    client_position = r['position']
                    break

            # Content gap: True if no clear winner / mixed formats / snippet opportunity
            dominant_format_count = max(format_preference['counts'].values()) if format_preference['counts'] else 0
            has_content_gap = dominant_format_count < 3 or snippet_opportunity

            serp_analysis[cid] = {
                'cluster_id': cid,
                'primary_keyword': kw,
                'top_10_results': top_10,
                # Displaceability — real avg DA via curated domain table
                'avg_page1_da': displaceability_data['avg_page1_da'],
                'displaceability': displaceability_data['level'],
                'domain_breakdown': displaceability_data.get('domain_breakdown', []),
                # Format and content signals
                'content_format_preference': format_preference,
                'has_featured_snippet': has_snippet,
                'featured_snippet_opportunity': snippet_opportunity,
                'paa_questions': paa_questions,
                'client_position': client_position,
                'content_gap': has_content_gap,
                'total_results': result.get('items_count', len(items)),
            }

        time.sleep(1.5)  # Rate limit between batches

    # -----------------------------------------------------------------------
    # Claude content gap analysis (brief, per cluster, top 20 only)
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF08: Running Claude content gap analysis on top clusters...')

    top_clusters = sorted(
        keyword_clusters,
        key=lambda x: x.get('composite_score', 0),
        reverse=True
    )[:20]

    for cluster in top_clusters:
        cid = cluster['cluster_id']
        sa = serp_analysis.get(cid, {})
        if not sa or sa.get('error'):
            continue

        top_titles = [r.get('title', '') for r in sa.get('top_10_results', [])[:5]]
        paa_qs = sa.get('paa_questions', [])

        try:
            system = "You are an SEO content strategist. In 40-50 words, identify the key content gap for this keyword."
            user = (
                f"Keyword: {cluster['primary_keyword']}\n"
                f"Current page 1 titles: {'; '.join(top_titles)}\n"
                f"People Also Ask: {'; '.join(paa_qs[:3])}\n"
                f"Format preference: {sa.get('content_format_preference', {}).get('preferred', '')}\n"
                "What content angle is missing from page 1?"
            )
            gap_analysis = claude_message(system, user, max_tokens=250)
            serp_analysis[cid]['content_gap_analysis'] = gap_analysis.strip()
            time.sleep(0.4)
        except Exception as e:
            print(f"[WF08] Claude gap analysis error for {cid}: {e}")

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF08: Complete. Analysed {len(serp_analysis)} clusters.')

    return {'serp_analysis': serp_analysis}
