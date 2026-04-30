#!/usr/bin/env python3
"""
WF07 — Reddit Intelligence
Discovers subreddits, scrapes threads via Apify, extracts patterns via Claude.
"""
import os
import re
import time
import json
from helpers import (http_post, post_callback, exa_search, claude_message)

WORKFLOW_ID = 'Reddit_Intelligence'

APIFY_BASE = 'https://api.apify.com/v2'

# Generic B2B defaults — industry-specific subs come from Exa discovery
DEFAULT_SUBREDDITS = [
    'r/startups', 'r/entrepreneur', 'r/SaaS', 'r/marketing',
    'r/sales', 'r/automation', 'r/productivity', 'r/smallbusiness',
]

QUESTION_SIGNALS = [
    '?', 'recommend', 'looking for', 'suggestions', 'anyone use',
    'has anyone', 'what is the best', 'which is better', 'advice',
    'help', 'how do you', 'how to', 'struggling with', 'need help',
    'alternatives to', 'vs ', ' vs', 'comparison',
]


def discover_subreddits(icp_personas, industry, offer_description):
    """Use Exa to find relevant subreddits for the ICP."""
    persona_str = ', '.join(icp_personas[:3]) if icp_personas else 'professionals'
    query = f"Reddit communities where {persona_str} discuss {industry} {offer_description}"

    discovered = set()
    try:
        resp = exa_search(
            query=query,
            num_results=10,
            include_domains=['reddit.com'],
            search_type='neural',
        )
        for item in resp.get('results', []):
            url = item.get('url', '')
            m = re.search(r'reddit\.com/(r/[A-Za-z0-9_]+)', url)
            if m:
                discovered.add(m.group(1))
    except Exception as e:
        print(f"[WF07] Subreddit discovery error: {e}")

    # Merge with defaults
    all_subs = list(discovered | set(DEFAULT_SUBREDDITS))
    return all_subs[:15]


def scrape_reddit_apify(subreddits, search_terms, max_posts=25):
    """
    Run Apify Reddit scraper.
    Returns list of post dicts.
    """
    token = os.environ.get('APIFY_TOKEN', '')
    all_posts = []
    seen_urls = set()

    # Build start URLs for each subreddit × search term combo
    start_urls = []
    for sub in subreddits[:8]:
        sub_name = sub.lstrip('r/')
        for term in search_terms[:3]:
            # Properly URL-encode search terms
            from urllib.parse import quote_plus
            encoded_term = quote_plus(re.sub(r'[^a-zA-Z0-9 \-]', '', term)[:50])
            start_urls.append({
                'url': f"https://www.reddit.com/r/{sub_name}/search/?q={encoded_term}&sort=top&restrict_sr=1"
            })
        # Also scrape hot posts from subreddit directly
        start_urls.append({'url': f"https://www.reddit.com/r/{sub_name}/hot/"})

    input_data = {
        'startUrls': start_urls[:24],
        'maxItems': max_posts,          # correct key for apify/reddit-scraper
        'includeComments': True,
        'maxComments': 10,
    }

    try:
        url = f"{APIFY_BASE}/acts/apify~reddit-scraper/run-sync-get-dataset-items?token={token}"
        resp = http_post(url, input_data, timeout=300)
        if isinstance(resp, list):
            for post in resp:
                post_url = post.get('url', post.get('postUrl', ''))
                if post_url not in seen_urls:
                    seen_urls.add(post_url)
                    all_posts.append(post)
        print(f"[WF07] Apify Reddit scraper returned {len(all_posts)} posts")
    except Exception as e:
        print(f"[WF07] Apify Reddit scraper error: {e}")
        # Fallback: Exa Reddit search
        try:
            for term in search_terms[:3]:
                exa_resp = exa_search(
                    query=f"reddit {term} recommendations problems",
                    num_results=10,
                    include_domains=['reddit.com'],
                    contents={'text': True, 'numSentences': 10},
                    search_type='neural',
                )
                for item in exa_resp.get('results', []):
                    post_url = item.get('url', '')
                    if post_url not in seen_urls:
                        seen_urls.add(post_url)
                        all_posts.append({
                            'title': item.get('title', ''),
                            'body': item.get('text', ''),
                            'url': post_url,
                            'subreddit': re.search(r'/r/([^/]+)', post_url).group(1)
                                         if re.search(r'/r/([^/]+)', post_url) else 'unknown',
                            'score': 0,
                        })
        except Exception as e2:
            print(f"[WF07] Exa Reddit fallback error: {e2}")

    return all_posts


def is_question_post(post):
    """Return True if post appears to be a question/recommendation request."""
    title = (post.get('title', '') or '').lower()
    body = (post.get('body', '') or post.get('selftext', '') or '').lower()
    combined = title + ' ' + body
    return any(signal in combined for signal in QUESTION_SIGNALS)


def extract_reddit_patterns(posts_text, industry, competitor_names):
    """Claude API extraction of recurring patterns from Reddit posts."""
    system = (
        "You are a B2B market intelligence analyst. Analyze these Reddit posts and extract "
        "structured insights. Return ONLY valid JSON with this structure:\n"
        "{\n"
        '  "recurring_questions": ["question1", ...],\n'
        '  "pain_phrases": ["phrase1", ...],\n'
        '  "product_gap_patterns": ["gap1", ...],\n'
        '  "competitor_sentiment": {"competitor_name": "positive|negative|mixed", ...}\n'
        "}"
    )
    user = (
        f"Industry: {industry}\n"
        f"Competitors mentioned: {', '.join(competitor_names[:5])}\n\n"
        f"Reddit posts:\n{posts_text[:4000]}\n\n"
        "Extract patterns as JSON."
    )
    try:
        raw = claude_message(system, user, max_tokens=600)
        raw = re.sub(r'```(?:json)?', '', raw).strip().strip('`')
        data = json.loads(raw)
        return data
    except Exception as e:
        print(f"[WF07] Claude pattern extraction error: {e}")
        return {
            'recurring_questions': [],
            'pain_phrases': [],
            'product_gap_patterns': [],
            'competitor_sentiment': {},
        }


def generate_content_seeds(questions, industry, offer_description):
    """Claude generates content seed ideas from recurring questions."""
    if not questions:
        return []

    q_text = '\n'.join(f"- {q}" for q in questions[:15])
    system = (
        "You are an SEO content strategist. Given recurring questions from an industry community, "
        "generate content seed ideas. Return ONLY a JSON array of objects with keys: "
        "'title', 'primary_keyword', 'content_type' "
        "(one of: guide, comparison, listicle, case_study, how_to, faq)."
    )
    user = (
        f"Industry: {industry}\nProduct context: {offer_description}\n\n"
        f"Recurring questions:\n{q_text}\n\n"
        "Generate content seeds as JSON array."
    )
    try:
        raw = claude_message(system, user, max_tokens=600)
        raw = re.sub(r'```(?:json)?', '', raw).strip().strip('`')
        seeds = json.loads(raw)
        if isinstance(seeds, list):
            return seeds[:15]
    except Exception as e:
        print(f"[WF07] Content seed generation error: {e}")
    return []


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { industry, offer_description, competitor_names, primary_keywords, icp_personas }
    returns: { subreddits_searched, total_posts_collected, question_posts_count,
               reddit_patterns, content_seeds }
    """
    industry = payload.get('industry', '')
    offer_description = payload.get('offer_description', '')
    competitor_names = payload.get('competitor_names', []) or []
    primary_keywords = payload.get('primary_keywords', []) or []
    icp_personas = payload.get('icp_personas', []) or []

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF07: Starting Reddit intelligence gathering...')

    # -----------------------------------------------------------------------
    # Step 1: Subreddit discovery
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF07: Discovering relevant subreddits...')

    subreddits = discover_subreddits(icp_personas, industry, offer_description)
    print(f"[WF07] Targeting {len(subreddits)} subreddits: {subreddits[:5]}...")

    # -----------------------------------------------------------------------
    # Step 2: Apify Reddit scrape
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF07: Scraping Reddit posts from {len(subreddits)} subreddits...')

    search_terms = primary_keywords[:5] + competitor_names[:3]
    if not search_terms:
        search_terms = [industry, offer_description[:40]]

    posts = scrape_reddit_apify(subreddits, search_terms, max_posts=25)

    # -----------------------------------------------------------------------
    # Step 3: Filter question posts
    # -----------------------------------------------------------------------
    question_posts = [p for p in posts if is_question_post(p)]
    print(f"[WF07] {len(posts)} total posts, {len(question_posts)} question posts")

    # -----------------------------------------------------------------------
    # Step 4: Claude pattern extraction
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF07: Extracting patterns from {len(posts)} posts via Claude...')

    # Compile post texts
    post_texts = []
    for p in posts[:40]:
        title = p.get('title', '') or ''
        body = p.get('body', p.get('selftext', '')) or ''
        sub = p.get('subreddit', '') or ''
        score = p.get('score', p.get('ups', 0)) or 0
        post_texts.append(f"[r/{sub}] {title}\n{body[:300]}")

    combined_text = '\n\n'.join(post_texts)
    reddit_patterns = extract_reddit_patterns(combined_text, industry, competitor_names)

    # -----------------------------------------------------------------------
    # Step 5: Content seed generation
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF07: Generating content seeds from Reddit patterns...')

    recurring_questions = reddit_patterns.get('recurring_questions', [])
    content_seeds = generate_content_seeds(recurring_questions, industry, offer_description)

    # Build structured post sample
    post_sample = []
    for p in posts[:20]:
        post_sample.append({
            'subreddit': p.get('subreddit', ''),
            'title': p.get('title', ''),
            'url': p.get('url', p.get('postUrl', '')),
            'score': p.get('score', p.get('ups', 0)),
            'is_question': is_question_post(p),
        })

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF07: Complete. {len(posts)} posts, '
                               f'{len(question_posts)} questions, '
                               f'{len(content_seeds)} content seeds.')

    return {
        'subreddits_searched': subreddits,
        'total_posts_collected': len(posts),
        'question_posts_count': len(question_posts),
        'reddit_patterns': reddit_patterns,
        'content_seeds': content_seeds,
        'post_sample': post_sample,
        'pain_phrases': reddit_patterns.get('pain_phrases', []),
        'product_gap_patterns': reddit_patterns.get('product_gap_patterns', []),
        'competitor_sentiment': reddit_patterns.get('competitor_sentiment', {}),
    }
