#!/usr/bin/env python3
"""
WF05 — Permutation Engine
The core keyword research engine. Generates, enriches, scores, and clusters all target keywords.
"""
import os
import re
import time
from helpers import (http_post, post_callback, dfs_auth, exa_search,
                     claude_message, extract_domain, chunked, keyword_to_slug)

WORKFLOW_ID = 'Permutation_Engine'

BOFU_MODIFIERS = {
    'alternative', 'alternatives', 'vs', 'versus', 'pricing', 'cost', 'price',
    'demo', 'trial', 'free trial', 'comparison', 'compare', 'review', 'reviews',
    'best', 'top', 'buy', 'purchase', 'hire', 'get', 'tool', 'software', 'platform',
    'solution', 'provider', 'vendor', 'agency',
}

INFO_MODIFIERS = {
    'how to', 'what is', 'why', 'guide', 'tutorial', 'tips', 'learn',
    'introduction', 'overview', 'explained', 'definition', 'example',
}


def score_bofu(keyword):
    kw_lower = keyword.lower()
    if any(m in kw_lower for m in BOFU_MODIFIERS):
        return 20
    if any(m in kw_lower for m in INFO_MODIFIERS):
        return 10
    return 5


def composite_score(kw_data):
    vol = kw_data.get('search_volume', 0) or 0
    kd = kw_data.get('keyword_difficulty', 50) or 50
    cpc = kw_data.get('cpc', 0) or 0
    keyword = kw_data.get('keyword', '')
    is_striking = kw_data.get('is_striking_distance', False)

    # Volume score
    if vol >= 100:
        vscore = 20
    elif vol >= 50:
        vscore = 15
    elif vol >= 10:
        vscore = 10
    elif vol >= 1:
        vscore = 5
    else:
        vscore = 0

    # Difficulty score
    if kd <= 20:
        dscore = 25
    elif kd <= 35:
        dscore = 20
    elif kd <= 50:
        dscore = 12
    elif kd <= 65:
        dscore = 5
    else:
        dscore = 0

    # CPC score
    if cpc > 10:
        cscore = 20
    elif cpc >= 5:
        cscore = 15
    elif cpc >= 2:
        cscore = 10
    elif cpc > 0:
        cscore = 5
    else:
        cscore = 2

    bofu = score_bofu(keyword)
    sd_bonus = 15 if is_striking else 0

    total = vscore + dscore + cscore + bofu + sd_bonus
    return min(total, 100)


def extract_primary_category(offer_description):
    """Extract 2-3 key nouns from offer description as primary category."""
    stop = {'a','an','the','and','or','for','to','of','in','on','at','with',
            'is','are','we','our','your','that','which','help','helps','using',
            'build','built','designed','provide','provides','service','services'}
    words = [w.lower() for w in re.findall(r'\b[a-zA-Z]{3,}\b', offer_description)
             if w.lower() not in stop]
    # Prefer nouns (heuristic: capitalised or known patterns)
    return ' '.join(words[:3]) if words else 'software'


def generate_permutations(payload):
    """Build permutation matrix from 5 pattern sets."""
    client_domain = payload.get('client_domain', '')
    offer_description = payload.get('offer_description', '')
    industry = payload.get('industry', '')
    primary_products = payload.get('primary_products', []) or []
    target_personas = payload.get('target_personas', []) or []
    icp_company_size = payload.get('icp_company_size', '') or ''
    icp_industries = payload.get('icp_industries', []) or []
    confirmed_competitors = payload.get('confirmed_competitors', []) or []

    client_name = extract_domain(client_domain).split('.')[0]
    primary_category = extract_primary_category(offer_description)

    # Ensure lists are non-empty with sensible defaults
    if not primary_products:
        primary_products = [primary_category]
    if not target_personas:
        target_personas = ['operations manager', 'IT director', 'compliance officer']
    if not icp_industries:
        icp_industries = [industry] if industry else ['enterprise']
    if not icp_company_size:
        icp_company_size = 'mid-market'

    keywords = []

    # Pattern Set A: Category + ICP
    for ind in icp_industries[:5]:
        keywords.append(f"{ind} {primary_category}")
        keywords.append(f"{primary_category} for {ind}")
    for persona in target_personas[:4]:
        keywords.append(f"{primary_category} for {persona}s")
    keywords.append(f"{primary_category} for {icp_company_size} companies")
    keywords.append(f"{primary_category} for {icp_company_size} business")
    for ind in icp_industries[:5]:
        keywords.append(f"{ind} {primary_category} solution")
        keywords.append(f"{ind} {primary_category} software")

    # Pattern Set B: Competitor-anchored
    for comp in confirmed_competitors[:10]:
        cname = comp.get('domain', '').split('.')[0] if isinstance(comp, dict) else str(comp).split('.')[0]
        if not cname:
            continue
        keywords.extend([
            f"{cname} alternative",
            f"{cname} alternatives",
            f"{cname} vs {client_name}",
            f"{client_name} vs {cname}",
            f"{cname} pricing",
            f"{cname} reviews",
            f"{cname} complaints",
            f"best {cname} alternative",
            f"{cname} competitors",
            f"{cname} review",
        ])

    # Pattern Set C: Problem/Outcome
    core_problems = [
        f"how to {primary_category.replace(' ', '-').replace('-', ' ')}",
        f"{primary_category} solution",
        f"{primary_category} software",
        f"{primary_category} tool",
        f"{primary_category} platform",
    ]
    if industry:
        core_problems.extend([
            f"{industry} {primary_category} solution",
            f"best {industry} {primary_category} software",
        ])
    keywords.extend(core_problems)

    # Pattern Set D: Commercial Intent Modifiers
    for mod in ['best', 'top', 'leading']:
        keywords.append(f"{mod} {primary_category}")
        keywords.append(f"{mod} {primary_category} software")
        keywords.append(f"{mod} {primary_category} tools")
    for mod in ['comparison', 'pricing', 'cost', 'demo', 'free trial', 'roi']:
        keywords.append(f"{primary_category} {mod}")
    keywords.append(f"{primary_category} vendor")
    keywords.append(f"{primary_category} providers")

    # Pattern Set E: Long-tail product × industry
    for prod in primary_products[:5]:
        for ind in icp_industries[:5]:
            keywords.append(f"{prod} for {ind}")
        for mod in ['implementation', 'onboarding', 'support', 'training', 'integration']:
            keywords.append(f"{prod} {mod}")

    return keywords


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { client_domain, offer_description, industry, primary_products, target_personas,
               icp_company_size, icp_industries, confirmed_competitors, gsc_all_queries,
               already_ranking_p1, striking_distance_keywords, site_intelligence }
    returns: { summary, exclusions, keyword_clusters }
    """
    client_domain = payload.get('client_domain', '')
    client_bare = extract_domain(client_domain)
    confirmed_competitors = payload.get('confirmed_competitors', []) or []
    gsc_all_queries = payload.get('gsc_all_queries', []) or []
    already_ranking_p1 = payload.get('already_ranking_p1', []) or []
    striking_distance = payload.get('striking_distance_keywords', []) or []

    p1_keywords = {q.get('query', '').lower() for q in already_ranking_p1}
    striking_set = {q.get('query', '').lower() for q in striking_distance}

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF05: Starting permutation engine...')

    all_keywords = set()

    # -----------------------------------------------------------------------
    # Step 1: DataForSEO ranked_keywords for client domain
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF05: Pulling client ranked keywords from DataForSEO...')

    try:
        dfs_body = [{
            'target': client_bare,
            'location_code': 2840,
            'language_code': 'en',
            'limit': 200,
            'filters': [['keyword_data.keyword_info.search_volume', '>', 0]],
        }]
        resp = http_post(
            'https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live',
            dfs_body, headers=dfs_auth(), timeout=90
        )
        for task in resp.get('tasks', []):
            for item in (task.get('result') or []):
                for kw_item in (item.get('items') or []):
                    kw = kw_item.get('keyword_data', {}).get('keyword', '')
                    if kw:
                        all_keywords.add(kw.lower())
        print(f"[WF05] Client ranked keywords: {len(all_keywords)}")
    except Exception as e:
        print(f"[WF05] Client ranked_keywords error: {e}")

    # -----------------------------------------------------------------------
    # Step 2: DataForSEO ranked_keywords for each competitor
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF05: Pulling keywords for {len(confirmed_competitors)} competitors...')

    comp_keyword_counts = {}
    for comp in confirmed_competitors[:10]:
        d = comp.get('domain', '') if isinstance(comp, dict) else str(comp)
        comp_bare = extract_domain(d)
        try:
            dfs_body = [{
                'target': comp_bare,
                'location_code': 2840,
                'language_code': 'en',
                'limit': 200,
            }]
            resp = http_post(
                'https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live',
                dfs_body, headers=dfs_auth(), timeout=90
            )
            count = 0
            for task in resp.get('tasks', []):
                for item in (task.get('result') or []):
                    for kw_item in (item.get('items') or []):
                        kw = kw_item.get('keyword_data', {}).get('keyword', '')
                        if kw:
                            all_keywords.add(kw.lower())
                            count += 1
            comp_keyword_counts[comp_bare] = count
            time.sleep(0.5)
        except Exception as e:
            print(f"[WF05] Competitor {comp_bare} ranked_keywords error: {e}")

    print(f"[WF05] After competitor keywords: {len(all_keywords)} total")

    # -----------------------------------------------------------------------
    # Step 3: Exa semantic keyword expansion
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF05: Running Exa semantic keyword expansion...')

    offer_description = payload.get('offer_description', '')
    industry = payload.get('industry', '')

    exa_queries = [
        f"What search terms do people use when looking for {offer_description}",
        f"SEO keywords for {industry} software companies",
        f"Long-tail keywords for {offer_description} buyers",
    ]

    for q in exa_queries:
        try:
            resp = exa_search(query=q, num_results=10, search_type='neural')
            for item in resp.get('results', []):
                text = (item.get('text') or '')[:2000]
                # Extract keyword-like phrases (2-6 words)
                phrases = re.findall(r'\b(?:[a-z][a-z0-9-]+\s){1,5}[a-z][a-z0-9-]+\b', text.lower())
                for ph in phrases[:20]:
                    ph = ph.strip()
                    if 3 <= len(ph.split()) <= 6:
                        all_keywords.add(ph)
        except Exception as e:
            print(f"[WF05] Exa expansion error: {e}")

    # -----------------------------------------------------------------------
    # Step 4: Generate permutation matrix
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF05: Generating permutation matrix...')

    permutations = generate_permutations(payload)
    for kw in permutations:
        all_keywords.add(kw.lower().strip())

    # Add GSC queries
    for q in gsc_all_queries:
        kw = q.get('query', '').lower()
        if kw:
            all_keywords.add(kw)

    # -----------------------------------------------------------------------
    # Step 5: Deduplication + filtering
    # -----------------------------------------------------------------------
    exclusions = {'p1_excluded': 0, 'single_word': 0, 'total_before': len(all_keywords)}

    filtered_keywords = []
    for kw in all_keywords:
        kw = kw.strip()
        if not kw:
            continue
        if len(kw.split()) < 2:
            exclusions['single_word'] += 1
            continue
        if kw in p1_keywords:
            exclusions['p1_excluded'] += 1
            continue
        filtered_keywords.append(kw)

    print(f"[WF05] After filtering: {len(filtered_keywords)} keywords")

    # -----------------------------------------------------------------------
    # Step 6: DataForSEO batch search volume (batches of 700)
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF05: Fetching search volume for {len(filtered_keywords)} keywords...')

    volume_map = {}
    for batch in chunked(filtered_keywords, 700):
        try:
            sv_body = [{
                'keywords': batch,
                'location_code': 2840,
                'language_code': 'en',
            }]
            resp = http_post(
                'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live',
                sv_body, headers=dfs_auth(), timeout=120
            )
            for task in resp.get('tasks', []):
                for item in (task.get('result') or []):
                    kw = item.get('keyword', '').lower()
                    volume_map[kw] = {
                        'search_volume': item.get('search_volume', 0) or 0,
                        'cpc': item.get('cpc', 0) or 0,
                        'competition': item.get('competition', 0) or 0,
                        'monthly_searches': item.get('monthly_searches', []),
                    }
            time.sleep(1)
        except Exception as e:
            print(f"[WF05] Search volume batch error: {e}")

    print(f"[WF05] Volume data for {len(volume_map)} keywords")

    # -----------------------------------------------------------------------
    # Step 7: Bulk keyword difficulty (batches of 1000)
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF05: Fetching keyword difficulty scores...')

    kd_map = {}
    for batch in chunked(filtered_keywords, 1000):
        try:
            kd_body = [{
                'keywords': batch,
                'location_code': 2840,
                'language_code': 'en',
            }]
            resp = http_post(
                'https://api.dataforseo.com/v3/dataforseo_labs/google/bulk_keyword_difficulty/live',
                kd_body, headers=dfs_auth(), timeout=120
            )
            for task in resp.get('tasks', []):
                for item in (task.get('result') or []):
                    for kw_item in (item.get('items') or []):
                        kw = kw_item.get('keyword', '').lower()
                        kd_map[kw] = kw_item.get('keyword_difficulty', 50) or 50
            time.sleep(1)
        except Exception as e:
            print(f"[WF05] KD batch error: {e}")

    print(f"[WF05] KD data for {len(kd_map)} keywords")

    # -----------------------------------------------------------------------
    # Step 8: Composite scoring + exclusions
    # -----------------------------------------------------------------------
    scored_keywords = []
    score_exclusions = 0

    for kw in filtered_keywords:
        vol_data = volume_map.get(kw, {})
        kd = kd_map.get(kw, 50)
        cpc = float(vol_data.get('cpc', 0) or 0)
        vol = int(vol_data.get('search_volume', 0) or 0)
        is_striking = kw in striking_set

        kw_data = {
            'keyword': kw,
            'search_volume': vol,
            'keyword_difficulty': kd,
            'cpc': cpc,
            'competition': vol_data.get('competition', 0),
            'monthly_searches': vol_data.get('monthly_searches', []),
            'is_striking_distance': is_striking,
        }

        score = composite_score(kw_data)

        # Exclusion rules
        if score < 40:
            score_exclusions += 1
            continue
        if kd > 65 and cpc < 15:
            score_exclusions += 1
            continue

        kw_data['composite_score'] = score
        scored_keywords.append(kw_data)

    exclusions['low_score_excluded'] = score_exclusions
    scored_keywords.sort(key=lambda x: x['composite_score'], reverse=True)
    print(f"[WF05] Scored keywords after exclusion: {len(scored_keywords)}")

    # -----------------------------------------------------------------------
    # Step 9: Keyword clustering (sequential greedy)
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF05: Clustering {len(scored_keywords)} keywords...')

    def keywords_related(seed, candidate):
        """True if candidate is a variant/related form of seed."""
        seed_words = set(seed.lower().split())
        cand_words = set(candidate.lower().split())
        # Share 60%+ of words
        overlap = len(seed_words & cand_words)
        union = len(seed_words | cand_words)
        if union == 0:
            return False
        return (overlap / union) >= 0.5

    clusters = []
    clustered = set()

    for kw_data in scored_keywords:
        kw = kw_data['keyword']
        if kw in clustered:
            continue

        # Seed a new cluster
        cluster_kws = [kw_data]
        clustered.add(kw)

        for other in scored_keywords:
            ok = other['keyword']
            if ok in clustered:
                continue
            if keywords_related(kw, ok):
                cluster_kws.append(other)
                clustered.add(ok)

        cluster_id = f"CL-{len(clusters) + 1:03d}"
        primary_kw = cluster_kws[0]
        secondary_kws = [k['keyword'] for k in cluster_kws[1:10]]

        avg_vol = int(sum(k['search_volume'] for k in cluster_kws) / len(cluster_kws))
        avg_kd = round(sum(k['keyword_difficulty'] for k in cluster_kws) / len(cluster_kws), 1)
        max_cpc = max(k['cpc'] for k in cluster_kws)
        cluster_score = primary_kw['composite_score']

        clusters.append({
            'cluster_id': cluster_id,
            'primary_keyword': primary_kw['keyword'],
            'secondary_keywords': secondary_kws,
            'all_keywords': [k['keyword'] for k in cluster_kws],
            'keyword_count': len(cluster_kws),
            'composite_score': cluster_score,
            'avg_search_volume': avg_vol,
            'primary_search_volume': primary_kw['search_volume'],
            'avg_keyword_difficulty': avg_kd,
            'primary_kd': primary_kw['keyword_difficulty'],
            'max_cpc': round(max_cpc, 2),
            'primary_cpc': round(primary_kw['cpc'], 2),
            'bofu_signal': score_bofu(primary_kw['keyword']),
            'has_striking_distance': primary_kw.get('is_striking_distance', False),
            'narrative': '',  # Filled in Step 10
        })

    clusters.sort(key=lambda x: x['composite_score'], reverse=True)
    print(f"[WF05] Created {len(clusters)} keyword clusters")

    # -----------------------------------------------------------------------
    # Step 10: Claude narrative generation (top 30 clusters)
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF05: Generating Claude narratives for top {min(30, len(clusters))} clusters...')

    system_prompt = (
        "You are an expert SEO strategist. Given a keyword cluster, write a concise 2-3 sentence "
        "strategic narrative explaining: (1) who searches this, (2) what intent stage they are at, "
        "and (3) what type of content would rank best. Be specific and actionable. No fluff."
    )

    for cluster in clusters[:30]:
        try:
            user_msg = (
                f"Keyword cluster:\n"
                f"Primary: {cluster['primary_keyword']}\n"
                f"Related: {', '.join(cluster['secondary_keywords'][:5])}\n"
                f"Monthly volume: {cluster['primary_search_volume']}\n"
                f"KD: {cluster['primary_kd']}, CPC: ${cluster['primary_cpc']}\n"
                f"Industry: {payload.get('industry', '')}"
            )
            narrative = claude_message(system_prompt, user_msg, max_tokens=250)
            cluster['narrative'] = narrative.strip()
            time.sleep(0.5)
        except Exception as e:
            print(f"[WF05] Claude narrative error for {cluster['cluster_id']}: {e}")
            cluster['narrative'] = ''

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF05: Complete. {len(clusters)} clusters, '
                               f'{len(scored_keywords)} scored keywords.')

    return {
        'summary': {
            'total_keywords_generated': exclusions['total_before'],
            'after_dedup_filter': len(filtered_keywords),
            'after_scoring_filter': len(scored_keywords),
            'total_clusters': len(clusters),
            'p1_excluded': exclusions['p1_excluded'],
            'single_word_excluded': exclusions['single_word'],
            'low_score_excluded': exclusions.get('low_score_excluded', 0),
        },
        'exclusions': exclusions,
        'keyword_clusters': clusters,
    }
