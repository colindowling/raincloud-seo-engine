#!/usr/bin/env python3
"""
WF04 — Site Intelligence
Crawls client site via Exa, classifies pages, clusters topics, builds outside-in view.
"""
import re
from helpers import (post_callback, exa_search, extract_domain)

WORKFLOW_ID = 'Site_Intelligence'


# ---------------------------------------------------------------------------
# Page classification
# ---------------------------------------------------------------------------

PAGE_TYPES = [
    ('homepage', ['/'], lambda url, title: url.rstrip('/').count('/') <= 1),
    ('pricing', ['pricing', 'plans', 'cost', 'price'], None),
    ('comparison', ['vs ', ' vs', 'compare', 'alternative', 'versus'], None),
    ('case_study', ['case-study', 'case_study', 'customer', 'success-story', 'success_story'], None),
    ('blog', ['blog', 'news', 'post', 'article', 'insights', 'resources/'], None),
    ('resource_guide', ['guide', 'resource', 'whitepaper', 'ebook', 'report', 'tutorial', 'how-to'], None),
    ('product', ['product', 'feature', 'solution', 'platform', 'tool', 'software'], None),
    ('about', ['about', 'team', 'company', 'mission', 'careers', 'jobs', 'press'], None),
]


def classify_page(url, title=''):
    url_lower = url.lower()
    title_lower = (title or '').lower()
    combined = url_lower + ' ' + title_lower

    for page_type, keywords, fn in PAGE_TYPES:
        if fn and fn(url, title):
            return page_type
        if keywords:
            if any(kw in combined for kw in keywords):
                return page_type
    return 'other'


def estimate_word_count(text):
    if not text:
        return 0
    words = re.findall(r'\w+', text)
    return len(words)


# ---------------------------------------------------------------------------
# Topic clustering by title keyword co-occurrence
# ---------------------------------------------------------------------------

def cluster_topics(pages):
    """
    Simple topic clustering: group pages that share 2+ significant words in their titles.
    Returns list of { cluster_name, pages }.
    """
    # Build word frequency across all titles
    stop_words = {
        'a', 'an', 'the', 'and', 'or', 'for', 'to', 'of', 'in',
        'on', 'at', 'with', 'how', 'what', 'why', 'when', 'is',
        'are', 'your', 'our', 'we', 'you', 'it', 'be', 'can',
        'best', 'top', 'guide', 'page', 'home',
    }

    def title_words(title):
        return {w.lower() for w in re.findall(r'\w{3,}', title or '')
                if w.lower() not in stop_words}

    clusters = {}
    assigned = set()

    for i, page in enumerate(pages):
        if i in assigned:
            continue
        seed_words = title_words(page.get('title', ''))
        if not seed_words:
            continue
        cluster_pages = [page]
        assigned.add(i)

        for j, other in enumerate(pages):
            if j in assigned or j == i:
                continue
            other_words = title_words(other.get('title', ''))
            shared = seed_words & other_words
            if len(shared) >= 2:
                cluster_pages.append(other)
                assigned.add(j)

        if len(cluster_pages) >= 2:
            cluster_name = ' / '.join(sorted(list(seed_words & title_words(cluster_pages[1].get('title', ''))))[:2])
            clusters[cluster_name or f'cluster_{i}'] = cluster_pages

    # Any unclustered pages go to 'standalone'
    standalone = [pages[i] for i in range(len(pages)) if i not in assigned]
    if standalone:
        clusters['standalone'] = standalone

    return [{'cluster_name': k, 'page_count': len(v), 'pages': [p['url'] for p in v]}
            for k, v in clusters.items()]


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { client_domain, offer_description, industry, gsc_all_pages }
    returns: { indexed_pages, existing_topic_clusters, thin_content_pages, strong_pages,
               outside_in_description }
    """
    client_domain = payload.get('client_domain', '')
    offer_description = payload.get('offer_description', '')
    gsc_all_pages = payload.get('gsc_all_pages', [])

    client_bare = extract_domain(client_domain)
    gsc_page_urls = {p.get('page', '') for p in gsc_all_pages}

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF04: Starting site intelligence crawl for {client_bare}...')

    # -----------------------------------------------------------------------
    # Step 1: Exa site crawl
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF04: Crawling site pages via Exa...')

    indexed_pages = []
    try:
        exa_resp = exa_search(
            query=f"All pages and content on {client_bare}",
            num_results=50,
            include_domains=[client_bare],
            contents={
                'text': True,
                'highlights': True,
                'numSentences': 5,
            },
            search_type='neural',
        )

        for item in exa_resp.get('results', []):
            url = item.get('url', '')
            title = item.get('title', '')
            text = item.get('text', '') or ''
            highlights = item.get('highlights', []) or []

            word_count = estimate_word_count(text)
            is_thin = word_count < 400 and word_count > 0

            indexed_pages.append({
                'url': url,
                'title': title,
                'content_type': classify_page(url, title),
                'estimated_word_count': word_count,
                'is_thin': is_thin,
                'text_sample': text[:300] if text else (
                    ' '.join(highlights[:2]) if highlights else ''),
                'in_gsc': url in gsc_page_urls,
            })

        print(f"[WF04] Exa returned {len(indexed_pages)} pages")
    except Exception as e:
        print(f"[WF04] Exa site crawl error: {e}")

    # -----------------------------------------------------------------------
    # Step 2 + 3: Page classification + topic clustering (done above)
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF04: Classifying {len(indexed_pages)} pages and clustering topics...')

    thin_content_pages = [p for p in indexed_pages if p['is_thin']]
    existing_topic_clusters = cluster_topics(indexed_pages)

    # -----------------------------------------------------------------------
    # Step 4: Exa outside-in description (exclude client domain)
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF04: Building outside-in description via Exa...')

    outside_in_description = ''
    try:
        oi_resp = exa_search(
            query=f"What is {client_bare}? What do they do? Who are their customers? {offer_description}",
            num_results=5,
            exclude_domains=[client_bare],
            contents={
                'text': True,
                'numSentences': 8,
            },
            search_type='neural',
        )
        excerpts = []
        for item in oi_resp.get('results', []):
            txt = (item.get('text') or '')[:600]
            if txt.strip():
                excerpts.append(txt.strip())
        outside_in_description = '\n---\n'.join(excerpts[:5])[:800]
        print(f"[WF04] Outside-in description: {len(outside_in_description)} chars")
    except Exception as e:
        print(f"[WF04] Outside-in description error: {e}")

    # -----------------------------------------------------------------------
    # Step 5: Mark strong pages (in GSC AND word count > 800)
    # -----------------------------------------------------------------------
    strong_pages = [
        p for p in indexed_pages
        if p['in_gsc'] and p['estimated_word_count'] >= 800
    ]

    # Augment GSC data onto indexed pages
    gsc_by_url = {p.get('page', ''): p for p in gsc_all_pages}
    for page in indexed_pages:
        gsc = gsc_by_url.get(page['url'], {})
        page['gsc_clicks'] = gsc.get('clicks', 0)
        page['gsc_impressions'] = gsc.get('impressions', 0)
        page['gsc_position'] = gsc.get('position', 0)

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF04: Complete. {len(indexed_pages)} pages indexed, '
                               f'{len(thin_content_pages)} thin, {len(strong_pages)} strong, '
                               f'{len(existing_topic_clusters)} topic clusters.')

    return {
        'indexed_pages': indexed_pages,
        'existing_topic_clusters': existing_topic_clusters,
        'thin_content_pages': [p['url'] for p in thin_content_pages],
        'strong_pages': [p['url'] for p in strong_pages],
        'outside_in_description': outside_in_description,
        'summary': {
            'total_pages': len(indexed_pages),
            'thin_pages': len(thin_content_pages),
            'strong_pages': len(strong_pages),
            'topic_clusters': len(existing_topic_clusters),
            'gsc_matched': sum(1 for p in indexed_pages if p['in_gsc']),
        },
    }
