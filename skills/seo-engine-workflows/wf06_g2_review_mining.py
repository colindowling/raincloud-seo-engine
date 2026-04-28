#!/usr/bin/env python3
"""
WF06 — G2 Review Mining
Scrapes G2 reviews via Apify, extracts frustration phrases + keyword variants via Claude.
"""
import os
import time
import re
import json
from helpers import (http_post, post_callback, claude_message)

WORKFLOW_ID = 'G2_Review_Mining'

APIFY_BASE = 'https://api.apify.com/v2'


def apify_headers():
    token = os.environ.get('APIFY_TOKEN', '')
    return {'Authorization': f'Bearer {token}'}


def run_apify_g2(slug, max_reviews=100):
    """
    Run Apify G2 scraper for a given slug.
    Returns list of review dicts.
    """
    g2_url = f"https://www.g2.com/products/{slug}/reviews"
    token = os.environ.get('APIFY_TOKEN', '')

    # Primary actor: apify~g2-review-scraper
    actors_to_try = ['apify~g2-review-scraper', 'apify~web-scraper']

    for actor_id in actors_to_try:
        try:
            input_data = {
                'startUrls': [{'url': g2_url}],
                'maxReviews': max_reviews,
                'includeReviewBody': True,
            }
            url = f"{APIFY_BASE}/acts/{actor_id}/run-sync-get-dataset-items?token={token}"
            resp = http_post(url, input_data, timeout=300)

            if isinstance(resp, list) and resp:
                print(f"[WF06] Apify {actor_id} returned {len(resp)} items for {slug}")
                return resp
        except Exception as e:
            print(f"[WF06] Apify actor {actor_id} error for {slug}: {e}")
            continue

    # Fallback: try Exa to get review text
    try:
        from helpers import exa_search
        exa_resp = exa_search(
            query=f"site:g2.com/products/{slug} reviews",
            num_results=10,
            include_domains=['g2.com'],
            contents={'text': True, 'numSentences': 15},
            search_type='keyword',
        )
        # Synthesise fake review objects from Exa text
        reviews = []
        for item in exa_resp.get('results', []):
            text = item.get('text', '') or ''
            if text.strip():
                reviews.append({'reviewBody': text[:2000], 'rating': None, 'title': item.get('title', '')})
        return reviews
    except Exception as e:
        print(f"[WF06] Exa G2 fallback error for {slug}: {e}")
        return []


def separate_reviews(reviews):
    """Separate reviews into positive and negative based on rating or sentiment cues."""
    positive, negative = [], []
    for r in reviews:
        rating = r.get('rating') or r.get('score') or 0
        body = (r.get('reviewBody') or r.get('body') or r.get('text') or '').strip()
        if not body:
            continue
        try:
            rating = float(str(rating).replace('/5', '').replace('%', ''))
        except (ValueError, TypeError):
            rating = 3.0

        if rating >= 4.0:
            positive.append(body)
        elif rating <= 2.5:
            negative.append(body)
        else:
            # For Exa-sourced text, use keyword heuristic
            negative_cues = {'disappointed', 'frustrating', 'lacking', 'missing', 'slow',
                             'difficult', 'confusing', "doesn't", 'could be better', 'wish',
                             'unfortunately', 'terrible', 'poor', 'limited', 'buggy'}
            if any(c in body.lower() for c in negative_cues):
                negative.append(body)
            else:
                positive.append(body)
    return positive, negative


def extract_frustration_phrases(negative_texts, competitor_name):
    """Claude API call to extract top frustration phrases from negative reviews."""
    if not negative_texts:
        return []

    combined = '\n---\n'.join(negative_texts[:30])[:4000]
    system = (
        "You are a B2B SaaS market intelligence analyst. Extract recurring user frustration phrases "
        "from these competitor reviews. Return ONLY a JSON array of up to 15 objects, each with "
        "'phrase' (the exact or near-exact recurring complaint, max 8 words) and 'frequency' "
        "(estimated number of times this theme appears, integer). No markdown, pure JSON array."
    )
    user = (
        f"Competitor: {competitor_name}\n\n"
        f"Negative reviews (sample):\n{combined}\n\n"
        "Extract the top 15 frustration phrases as a JSON array: "
        '[{"phrase": "...", "frequency": N}, ...]'
    )
    try:
        raw = claude_message(system, user, max_tokens=600)
        # Strip markdown code fences if present
        raw = re.sub(r'```(?:json)?', '', raw).strip().strip('`')
        phrases = json.loads(raw)
        if isinstance(phrases, list):
            return phrases[:15]
    except Exception as e:
        print(f"[WF06] Claude frustration extraction error: {e}")
        # Simple fallback: extract sentences with negative cues
        neg_cues = ['slow', 'missing', 'difficult', 'confusing', 'limited', 'buggy',
                    'poor', 'expensive', 'lack of', 'no support']
        found = []
        for text in negative_texts[:10]:
            for cue in neg_cues:
                if cue in text.lower():
                    found.append({'phrase': cue, 'frequency': 1})
        return found[:15]
    return []


def generate_keyword_variants(frustration_phrases, competitor_name, industry):
    """Claude API call to generate keyword variants from frustration phrases."""
    if not frustration_phrases:
        return []

    phrases_text = '\n'.join(f"- {p.get('phrase', '')}" for p in frustration_phrases[:10])
    system = (
        "You are an SEO keyword strategist. Given a list of user frustration phrases about a "
        "B2B SaaS competitor, generate search keyword variants that buyers would use when looking "
        "for alternatives due to these frustrations. Return ONLY a JSON array of keyword strings."
    )
    user = (
        f"Competitor: {competitor_name}\nIndustry: {industry}\n\n"
        f"Frustration phrases:\n{phrases_text}\n\n"
        "Generate 10-15 keyword variants. Return as JSON array: "
        '["keyword one", "keyword two", ...]'
    )
    try:
        raw = claude_message(system, user, max_tokens=400)
        raw = re.sub(r'```(?:json)?', '', raw).strip().strip('`')
        variants = json.loads(raw)
        if isinstance(variants, list):
            return [v.lower().strip() for v in variants if isinstance(v, str)]
    except Exception as e:
        print(f"[WF06] Claude keyword variants error: {e}")
    return []


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { competitor_g2_slugs, client_g2_slug, keyword_clusters }
    returns: { competitors: {...}, client: {...}, all_g2_keyword_opportunities: [...] }
    """
    import json

    competitor_slugs = payload.get('competitor_g2_slugs', []) or []
    client_slug = payload.get('client_g2_slug', '') or ''
    industry = payload.get('industry', '')

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF06: Mining G2 reviews for {len(competitor_slugs)} competitors...')

    competitors_data = {}
    all_keyword_opportunities = []

    # -----------------------------------------------------------------------
    # Process each competitor slug
    # -----------------------------------------------------------------------
    for idx, slug in enumerate(competitor_slugs, 1):
        if not slug:
            continue

        post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                      log_message=f'WF06: Scraping G2 reviews for {slug} ({idx}/{len(competitor_slugs)})...')

        reviews = run_apify_g2(slug, max_reviews=100)
        positive, negative = separate_reviews(reviews)

        print(f"[WF06] {slug}: {len(positive)} positive, {len(negative)} negative reviews")

        # Extract frustration phrases via Claude
        frustration_phrases = extract_frustration_phrases(negative, slug)

        # Generate keyword variants
        keyword_variants = generate_keyword_variants(frustration_phrases, slug, industry)
        all_keyword_opportunities.extend(keyword_variants)

        competitors_data[slug] = {
            'slug': slug,
            'total_reviews': len(reviews),
            'positive_count': len(positive),
            'negative_count': len(negative),
            'frustration_phrases': frustration_phrases,
            'keyword_variants': keyword_variants,
            'sample_negative_reviews': negative[:5],
            'sample_positive_reviews': positive[:5],
        }
        time.sleep(2)  # Rate limit

    # -----------------------------------------------------------------------
    # Process client's own G2 slug (positioning signals)
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF06: Mining client G2 reviews for positioning signals...')

    client_data = {}
    if client_slug:
        client_reviews = run_apify_g2(client_slug, max_reviews=50)
        client_pos, client_neg = separate_reviews(client_reviews)

        # Extract what clients praise (use for differentiators)
        positive_combined = '\n---\n'.join(client_pos[:20])[:3000]
        positioning_signals = []
        if positive_combined:
            try:
                system = (
                    "Extract 8-10 key differentiator phrases that customers praise about this product. "
                    "Return a JSON array of short phrases (max 6 words each)."
                )
                user = f"Positive reviews:\n{positive_combined}"
                raw = claude_message(system, user, max_tokens=300)
                raw = re.sub(r'```(?:json)?', '', raw).strip().strip('`')
                positioning_signals = json.loads(raw) if raw else []
            except Exception as e:
                print(f"[WF06] Client positioning signal error: {e}")

        client_data = {
            'slug': client_slug,
            'total_reviews': len(client_reviews),
            'positive_count': len(client_pos),
            'negative_count': len(client_neg),
            'positioning_signals': positioning_signals,
            'sample_negative_reviews': client_neg[:5],
        }

    # Deduplicate keyword opportunities
    all_keyword_opportunities = list(set(kw.lower() for kw in all_keyword_opportunities if kw))

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF06: Complete. {len(competitors_data)} competitors mined, '
                               f'{len(all_keyword_opportunities)} keyword opportunities found.')

    return {
        'competitors': competitors_data,
        'client': client_data,
        'all_g2_keyword_opportunities': all_keyword_opportunities,
    }
