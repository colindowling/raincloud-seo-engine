#!/usr/bin/env python3
"""
WF02 — Competitor Discovery
Discovers SEO competitors via Exa semantic search + DataForSEO overlap analysis.
"""
import os
import time
import urllib.parse
from helpers import (http_post, http_get, post_callback,
                     dfs_auth, exa_search, extract_domain)

WORKFLOW_ID = 'Competitor_Discovery'

AGGREGATOR_DOMAINS = {
    # Review / comparison sites
    'g2.com', 'capterra.com', 'getapp.com', 'softwareadvice.com',
    'trustpilot.com', 'trustradius.com', 'gartner.com', 'forrester.com',
    # Social / content
    'linkedin.com', 'reddit.com', 'twitter.com', 'x.com', 'instagram.com',
    'facebook.com', 'youtube.com', 'tiktok.com', 'medium.com', 'substack.com',
    # General web
    'wikipedia.org', 'producthunt.com', 'crunchbase.com', 'glassdoor.com',
    'yelp.com', 'inc.com', 'forbes.com', 'techcrunch.com', 'venturebeat.com',
    'businessinsider.com', 'entrepreneur.com', 'hbr.org', 'zdnet.com',
    # AI model hosts that flood results
    'huggingface.co', 'openai.com', 'anthropic.com', 'xai.com', 'x.ai',
    'perplexity.ai', 'mistral.ai',
    # Marketplaces / app stores
    'appsumo.com', 'alternativeto.net', 'slashdot.org', 'sourceforge.net',
}


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { client_domain, offer_description, industry, gsc_top_keywords }
    returns: { competitor_candidates, total_candidates_evaluated, top_10 }
    """
    client_domain = payload.get('client_domain', '')
    offer_description = payload.get('offer_description', '')
    industry = payload.get('industry', '')
    gsc_top_keywords = payload.get('gsc_top_keywords', [])

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF02: Starting competitor discovery for {client_domain}...')

    client_bare = extract_domain(client_domain)
    domain_scores = {}   # domain -> overlap_count

    # -----------------------------------------------------------------------
    # Step 1: Exa semantic competitor search
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF02: Running Exa semantic competitor search...')

    # Queries are anchored on OFFER + INDUSTRY — never on the client domain name.
    # Domain-anchored queries return social profiles, review sites, and name matches.
    # Category-anchored queries return actual product competitors.
    exa_queries = [
        f"Best {industry} software tools — top vendors and platforms",
        f"Top companies that provide {offer_description}",
        f"{industry} software comparison — leading solutions",
        f"Alternatives for {offer_description} — vendor list",
        f"Best {industry} platforms for B2B teams",
    ]

    exa_domains = set()
    for q in exa_queries:
        try:
            resp = exa_search(
                query=q,
                num_results=20,
                exclude_domains=[client_bare],
                search_type='neural',
                use_autoprompt=True,
            )
            for item in resp.get('results', []):
                url = item.get('url', '')
                d = extract_domain(url)
                # Normalise to root domain only
                parts = d.split('.')
                if len(parts) > 2:
                    d = '.'.join(parts[-2:])
                # Skip aggregators, social, AI model hosts, and the client itself
                if d and d not in AGGREGATOR_DOMAINS and d != client_bare:
                    exa_domains.add(d)
        except Exception as e:
            print(f"[WF02] Exa query error ({q[:60]}): {e}")

    print(f"[WF02] Exa found {len(exa_domains)} unique competitor domains")
    for d in exa_domains:
        domain_scores[d] = domain_scores.get(d, 0) + 1

    # -----------------------------------------------------------------------
    # Step 2: DataForSEO competitors_domain
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF02: Running DataForSEO keyword-overlap analysis...')

    # Brand root for filtering (ONLY the domain name itself, e.g. 'rncld' or 'raincloud')
    # Do NOT use words from offer_description — they will false-positive on real competitors
    import re as _re
    brand_root = client_bare.split('.')[0].lower()  # e.g. 'rncld'

    # Also derive the human brand name if it appears in offer/industry
    # e.g. if offer contains "raincloud" but domain is rncld.com
    client_name_words = set()
    client_name_words.add(brand_root)
    # Extract capitalised proper nouns from offer that might be the brand name
    for word in _re.findall(r'\b[A-Z][a-z]{3,}\b', offer_description):
        client_name_words.add(word.lower())

    def is_brand_variant(domain):
        """True only if the domain literally contains the client's brand name."""
        d = domain.lower()
        return any(name in d for name in client_name_words if len(name) >= 4)

    dfs_domains = []

    # Use Exa-discovered competitors as seeds for DataForSEO so we get real
    # category overlaps — but ALSO run against client domain as a supplement
    seed_targets = list(exa_domains)[:4]
    all_targets  = list(dict.fromkeys(seed_targets + [client_bare]))

    for target in all_targets:
        try:
            dfs_resp = http_post(
                'https://api.dataforseo.com/v3/dataforseo_labs/google/competitors_domain/live',
                [{'target': target, 'language_code': 'en', 'location_code': 2840, 'limit': 20}],
                headers=dfs_auth(), timeout=60
            )
            for task in dfs_resp.get('tasks', []):
                for item in (task.get('result') or []):
                    for comp in (item.get('items') or []):
                        d = comp.get('domain', '').lower().lstrip('www.')
                        if not d or d in AGGREGATOR_DOMAINS or d == client_bare:
                            continue
                        if is_brand_variant(d):
                            print(f"[WF02] Filtered brand variant: {d}")
                            continue
                        existing = next((x for x in dfs_domains if x['domain'] == d), None)
                        if existing:
                            existing['intersections'] += comp.get('intersections', 0)
                        else:
                            dfs_domains.append({
                                'domain': d,
                                'intersections': comp.get('intersections', 0),
                                'competitor_relevance': comp.get('competitor_relevance', 0),
                                'avg_position': comp.get('avg_position', 0),
                                'sum_position': comp.get('sum_position', 0),
                            })
                        domain_scores[d] = domain_scores.get(d, 0) + 3
            time.sleep(0.3)
        except Exception as e:
            print(f"[WF02] DataForSEO error for {target}: {e}")

    print(f"[WF02] DataForSEO found {len(dfs_domains)} competitors after filtering")

    # -----------------------------------------------------------------------
    # Step 3: Merge, rank, take top 10
    # -----------------------------------------------------------------------
    all_candidates = sorted(domain_scores.items(), key=lambda x: x[1], reverse=True)
    top_10_domains = [d for d, _ in all_candidates[:10]]

    print(f"[WF02] Top 10 candidates: {top_10_domains}")

    # -----------------------------------------------------------------------
    # Step 4: Enrich top 10 with DataForSEO domain_rank_overview
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF02: Enriching top {len(top_10_domains)} competitors with rank overview...')

    enriched = {}
    try:
        rank_body = [{'target': d, 'location_code': 2840, 'language_code': 'en'}
                     for d in top_10_domains]
        rank_resp = http_post(
            'https://api.dataforseo.com/v3/dataforseo_labs/google/domain_rank_overview/live',
            rank_body, headers=dfs_auth(), timeout=90
        )
        for task in rank_resp.get('tasks', []):
            for item in (task.get('result') or []):
                d = item.get('target', '')
                metrics = item.get('metrics', {}).get('organic', {})
                enriched[d] = {
                    'domain': d,
                    'organic_traffic': metrics.get('etv', 0),
                    'organic_keywords': metrics.get('count', 0),
                    'domain_rank': metrics.get('pos_1', 0) + metrics.get('pos_2_3', 0),
                    'pos_1': metrics.get('pos_1', 0),
                    'pos_1_3': metrics.get('pos_1', 0) + metrics.get('pos_2_3', 0),
                    'pos_4_10': metrics.get('pos_4_10', 0),
                }
    except Exception as e:
        print(f"[WF02] Rank overview error: {e}")

    # -----------------------------------------------------------------------
    # Step 5: Auto-suggest G2 slugs via Exa
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF02: Auto-detecting G2 slugs for top competitors...')

    import re
    g2_slugs = {}
    for d in top_10_domains:
        company_name = d.split('.')[0]
        try:
            g2_resp = exa_search(
                query=f"site:g2.com/products {company_name} reviews",
                num_results=5,
                include_domains=['g2.com'],
                search_type='keyword',
            )
            for item in g2_resp.get('results', []):
                url = item.get('url', '')
                m = re.search(r'g2\.com/products/([^/]+)', url)
                if m:
                    g2_slugs[d] = m.group(1)
                    break
        except Exception as e:
            print(f"[WF02] G2 slug search error for {d}: {e}")

        time.sleep(0.3)  # Rate limit Exa

    # -----------------------------------------------------------------------
    # Build final top_10 list
    # -----------------------------------------------------------------------
    top_10 = []
    for d in top_10_domains:
        rank_data = enriched.get(d, {})
        dfs_data = next((x for x in dfs_domains if x['domain'] == d), {})
        top_10.append({
            'domain': d,
            'overlap_score': domain_scores.get(d, 0),
            'intersections': dfs_data.get('intersections', 0),
            'competitor_relevance': dfs_data.get('competitor_relevance', 0),
            'organic_traffic': rank_data.get('organic_traffic', 0),
            'organic_keywords': rank_data.get('organic_keywords', 0),
            'pos_1': rank_data.get('pos_1', 0),
            'pos_1_3': rank_data.get('pos_1_3', 0),
            'g2_slug': g2_slugs.get(d, ''),
        })

    competitor_candidates = []
    for d, score in all_candidates:
        dfs_data = next((x for x in dfs_domains if x['domain'] == d), {})
        competitor_candidates.append({
            'domain': d,
            'overlap_score': score,
            'intersections': dfs_data.get('intersections', 0),
        })

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF02: Complete. {len(competitor_candidates)} candidates evaluated, '
                               f'top 10 enriched.')

    return {
        'competitor_candidates': competitor_candidates,
        'total_candidates_evaluated': len(competitor_candidates),
        'top_10': top_10,
    }
