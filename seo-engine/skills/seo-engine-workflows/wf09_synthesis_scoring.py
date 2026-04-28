#!/usr/bin/env python3
"""
WF09 — Synthesis & Scoring
Combines all research signals to produce ranked content opportunities.
"""
import re
from helpers import (post_callback, keyword_to_slug)

WORKFLOW_ID = 'Synthesis_Scoring'

# Opportunity type definitions
# A = Comparison/Alternative page
# B = Informational / thought-leadership
# C = Solution/category landing page
# D = Direct competitor alternative page

def classify_opportunity_type(keyword, serp_format, bofu_signal):
    """Classify keyword into opportunity type A/B/C/D."""
    kw = keyword.lower()

    # Type A: Direct competitor comparison
    if any(w in kw for w in ['vs', 'versus', 'alternative', 'alternatives', 'compare',
                               'comparison', 'competitor', 'competitors']):
        return 'A'

    # Type B: Informational / top-of-funnel
    if any(w in kw for w in ['how to', 'what is', 'guide', 'tutorial', 'learn',
                               'tips', 'best practices', 'introduction']):
        return 'B'

    # Type C: Commercial/category page
    if bofu_signal >= 20 or any(w in kw for w in ['pricing', 'cost', 'demo', 'trial',
                                                    'software', 'platform', 'solution', 'tool',
                                                    'best ', 'top ']):
        return 'C'

    # Default to D (long-tail / supportive)
    return 'D'


def recommended_page_type(opp_type, serp_format):
    """Return recommended page type based on opportunity type and SERP format."""
    mapping = {
        'A': 'comparison_landing_page',
        'B': 'pillar_guide' if serp_format in ('guide', 'listicle') else 'blog_post',
        'C': 'solution_landing_page',
        'D': 'supporting_content',
    }
    return mapping.get(opp_type, 'landing_page')


def estimated_timeline(displaceability_level, avg_kd):
    """Estimate ranking timeline as string."""
    if displaceability_level == 'High' and avg_kd <= 35:
        return '1-2 months'
    elif displaceability_level == 'High' or avg_kd <= 50:
        return '2-4 months'
    elif displaceability_level == 'Medium':
        return '3-6 months'
    else:
        return '6-12 months'


def target_word_count(page_type, serp_format):
    """Return target word count based on page type and SERP format."""
    if page_type in ('comparison_landing_page', 'solution_landing_page'):
        return '1000-1400'
    elif page_type == 'pillar_guide':
        return '1800-2500'
    elif page_type == 'blog_post':
        return '1400-2000'
    elif page_type == 'supporting_content':
        return '800-1200'
    # Default landing page
    if serp_format in ('guide', 'listicle'):
        return '1400-2000'
    return '1200-1600'


def generate_h1(primary_keyword, opportunity_type, industry):
    """Generate a benefit-oriented H1 from the primary keyword."""
    kw = primary_keyword.title()
    if opportunity_type == 'A':
        return f"The Best {kw}: Side-by-Side Comparison for {industry.title()} Teams"
    elif opportunity_type == 'B':
        return f"The Complete Guide to {kw}: What Every {industry.title()} Team Should Know"
    elif opportunity_type == 'C':
        return f"{kw}: Purpose-Built for High-Growth {industry.title()} Companies"
    else:
        return f"{kw}: A Practical Guide for {industry.title()} Professionals"


def keyword_semantically_matches(keyword, phrases):
    """Simple semantic match: check if any phrase words appear in keyword."""
    if not phrases:
        return False
    kw_words = set(keyword.lower().split())
    for phrase_item in phrases:
        if isinstance(phrase_item, dict):
            phrase = phrase_item.get('phrase', '')
        else:
            phrase = str(phrase_item)
        phrase_words = set(phrase.lower().split())
        if len(phrase_words & kw_words) >= 2:
            return True
    return False


def question_maps_to_cluster(question, cluster_keywords):
    """Check if a Reddit/G2 question semantically maps to cluster."""
    q_words = set(re.findall(r'\w{4,}', question.lower()))
    for kw in cluster_keywords:
        kw_words = set(kw.lower().split())
        if len(q_words & kw_words) >= 2:
            return True
    return False


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { keyword_clusters, serp_analysis, g2_intelligence, reddit_intelligence,
               striking_distance_keywords, already_ranking_p1, content_seeds, client_domain }
    returns: { ranked_opportunities, page_hierarchy, summary }
    """
    keyword_clusters = payload.get('keyword_clusters', []) or []
    serp_analysis = payload.get('serp_analysis', {}) or {}
    g2_intelligence = payload.get('g2_intelligence', {}) or {}
    reddit_intelligence = payload.get('reddit_intelligence', {}) or {}
    striking_keywords = payload.get('striking_distance_keywords', []) or []
    content_seeds = payload.get('content_seeds', []) or []
    client_domain = payload.get('client_domain', '')
    industry = payload.get('industry', '')

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF09: Synthesising {len(keyword_clusters)} clusters...')

    # Prepare G2 frustration phrases (flattened across all competitors)
    all_g2_phrases = []
    for comp_data in (g2_intelligence.get('competitors') or {}).values():
        all_g2_phrases.extend(comp_data.get('frustration_phrases', []) or [])

    # Reddit questions
    reddit_questions = reddit_intelligence.get('reddit_patterns', {}).get('recurring_questions', []) or []
    reddit_pain_phrases = reddit_intelligence.get('pain_phrases', []) or []

    striking_set = {q.get('query', '').lower() for q in striking_keywords if isinstance(q, dict)}

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF09: Applying scoring adjustments and signal matching...')

    ranked_opportunities = []

    for cluster in keyword_clusters:
        cid = cluster.get('cluster_id', '')
        primary_kw = cluster.get('primary_keyword', '')
        base_score = cluster.get('composite_score', 0)
        all_kws = cluster.get('all_keywords', [primary_kw])
        bofu_signal = cluster.get('bofu_signal', 5)

        # Get SERP data for this cluster
        sa = serp_analysis.get(cid, {})
        # displaceability may be a string ('High'/'Medium'/'Low') from wf08,
        # or a legacy dict — handle both gracefully.
        _disp_raw = sa.get('displaceability', 'Medium')
        if isinstance(_disp_raw, dict):
            displace_level = _disp_raw.get('level', 'Medium')
            avg_page1_da   = _disp_raw.get('avg_page1_da', 50)
        else:
            displace_level = _disp_raw if _disp_raw in ('High', 'Medium', 'Low') else 'Medium'
            avg_page1_da   = sa.get('avg_page1_da', 50)
        serp_format = sa.get('content_format_preference', {}).get('preferred', 'other')
        content_gap_exists = sa.get('content_gap', False)
        paa_questions = sa.get('paa_questions', [])
        content_gap_analysis = sa.get('content_gap_analysis', '')
        has_snippet_opportunity = sa.get('featured_snippet_opportunity', False)

        # -----------------------------------------------------------------------
        # Step 1: Final score adjustments
        # -----------------------------------------------------------------------
        adjusted_score = base_score

        # G2 alignment bonus
        if keyword_semantically_matches(primary_kw, all_g2_phrases):
            adjusted_score += 10

        # Reddit alignment bonus
        reddit_matches = [q for q in reddit_questions if question_maps_to_cluster(q, all_kws)]
        if reddit_matches:
            adjusted_score += 8

        # Content gap bonus
        if content_gap_exists:
            adjusted_score += 10

        # Displaceability adjustment
        if displace_level == 'High':
            pass  # No penalty
        elif displace_level == 'Medium':
            adjusted_score -= 5
        else:  # Low
            adjusted_score -= 15

        adjusted_score = max(0, min(100, adjusted_score))

        # -----------------------------------------------------------------------
        # Step 2: Opportunity type
        # -----------------------------------------------------------------------
        opp_type = classify_opportunity_type(primary_kw, serp_format, bofu_signal)

        # -----------------------------------------------------------------------
        # Step 3+4: Page structure and supporting content
        # -----------------------------------------------------------------------
        rec_page_type = recommended_page_type(opp_type, serp_format)
        rec_slug = keyword_to_slug(primary_kw)

        # Supporting content (Type B supports Type A, etc.)
        supporting_content = []
        if opp_type == 'C':
            for other in keyword_clusters[:5]:
                if other['cluster_id'] != cid and classify_opportunity_type(
                        other['primary_keyword'], '', other.get('bofu_signal', 5)) == 'B':
                    supporting_content.append(other['cluster_id'])

        # -----------------------------------------------------------------------
        # Step 5: Hierarchy level
        # -----------------------------------------------------------------------
        if opp_type == 'C' and cluster.get('avg_search_volume', 0) >= 500:
            hierarchy_level = 1  # Category hub
        elif opp_type in ('A', 'C'):
            hierarchy_level = 2  # BoFu page
        elif opp_type == 'B':
            hierarchy_level = 3  # Supporting content
        else:
            hierarchy_level = 3

        # Determine parent
        if hierarchy_level == 1:
            hierarchy_parent = 'homepage'
        elif hierarchy_level == 2:
            # Find a parent Level 1 cluster
            hierarchy_parent = 'homepage'
            for other in ranked_opportunities:
                if other.get('hierarchy_level') == 1:
                    # Check semantic overlap
                    if any(w in other['primary_keyword'].lower()
                           for w in primary_kw.lower().split()[:2]):
                        hierarchy_parent = other['recommended_slug']
                        break
        else:
            hierarchy_parent = None

        # -----------------------------------------------------------------------
        # Build opportunity object
        # -----------------------------------------------------------------------
        g2_phrases_mapped = [
            p for p in all_g2_phrases
            if keyword_semantically_matches(primary_kw, [p])
        ][:5]

        opp = {
            'rank': 0,  # Will be set after sort
            'cluster_id': cid,
            'primary_keyword': primary_kw,
            'secondary_keywords': cluster.get('secondary_keywords', []),
            'final_score': adjusted_score,
            'base_score': base_score,
            'opportunity_type': opp_type,
            'recommended_page_type': rec_page_type,
            'recommended_slug': rec_slug,
            'hierarchy_level': hierarchy_level,
            'hierarchy_parent': hierarchy_parent,
            'estimated_ranking_timeline': estimated_timeline(
                displace_level, cluster.get('primary_kd', 50)),
            # Keyword stats
            'search_volume': cluster.get('primary_search_volume', 0),
            'avg_search_volume': cluster.get('avg_search_volume', 0),
            'keyword_difficulty': cluster.get('primary_kd', 50),
            'avg_keyword_difficulty': cluster.get('avg_keyword_difficulty', 50),
            'cpc': cluster.get('primary_cpc', 0),
            'max_cpc': cluster.get('max_cpc', 0),
            'keyword_count': cluster.get('keyword_count', 1),
            'bofu_signal': bofu_signal,
            'has_striking_distance': cluster.get('has_striking_distance', False),
            # SERP data
            'displaceability': displace_level,
            'avg_page1_da': avg_page1_da,
            'content_format_preference': serp_format,
            'has_featured_snippet_opportunity': has_snippet_opportunity,
            'paa_questions': paa_questions,
            'content_gap': content_gap_exists,
            'content_gap_analysis': content_gap_analysis,
            # Intelligence signals
            'g2_frustration_phrases': g2_phrases_mapped,
            'reddit_questions': reddit_matches[:3],
            # Content planning
            'recommended_h1': generate_h1(primary_kw, opp_type, industry),
            'target_word_count': target_word_count(rec_page_type, serp_format),
            'narrative': cluster.get('narrative', ''),
            'supporting_content_ids': supporting_content,
        }
        ranked_opportunities.append(opp)

    # -----------------------------------------------------------------------
    # Step 6: Sort and assign ranks
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF09: Building page hierarchy and final rankings...')

    ranked_opportunities.sort(key=lambda x: x['final_score'], reverse=True)
    for i, opp in enumerate(ranked_opportunities, 1):
        opp['rank'] = i

    # Internal link mapping (each page links to its children and parent)
    for opp in ranked_opportunities:
        children = [o['recommended_slug'] for o in ranked_opportunities
                    if o.get('hierarchy_parent') == opp['recommended_slug']]
        opp['internal_links_out'] = children[:5]
        parent_slug = opp.get('hierarchy_parent')
        opp['internal_links_in'] = [parent_slug] if parent_slug else []

    # Build page hierarchy summary
    hierarchy_by_level = {0: [], 1: [], 2: [], 3: []}
    for opp in ranked_opportunities:
        lvl = opp.get('hierarchy_level', 3)
        hierarchy_by_level[lvl].append({
            'cluster_id': opp['cluster_id'],
            'primary_keyword': opp['primary_keyword'],
            'slug': opp['recommended_slug'],
            'score': opp['final_score'],
        })

    page_hierarchy = {
        'level_0_homepage': {'slug': '/', 'role': 'Brand hub / primary CTA'},
        'level_1_category_hubs': hierarchy_by_level[1][:5],
        'level_2_bofu_pages': hierarchy_by_level[2][:20],
        'level_3_content_pages': hierarchy_by_level[3][:50],
    }

    summary = {
        'total_opportunities': len(ranked_opportunities),
        'type_a_count': sum(1 for o in ranked_opportunities if o['opportunity_type'] == 'A'),
        'type_b_count': sum(1 for o in ranked_opportunities if o['opportunity_type'] == 'B'),
        'type_c_count': sum(1 for o in ranked_opportunities if o['opportunity_type'] == 'C'),
        'type_d_count': sum(1 for o in ranked_opportunities if o['opportunity_type'] == 'D'),
        'high_displaceability_count': sum(1 for o in ranked_opportunities
                                          if o['displaceability'] == 'High'),
        'top_10_avg_score': round(
            sum(o['final_score'] for o in ranked_opportunities[:10]) / 10, 1
        ) if len(ranked_opportunities) >= 10 else 0,
        'content_gap_opportunities': sum(1 for o in ranked_opportunities if o['content_gap']),
        'striking_distance_opportunities': sum(1 for o in ranked_opportunities
                                                if o['has_striking_distance']),
    }

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF09: Complete. {len(ranked_opportunities)} opportunities ranked.')

    return {
        'ranked_opportunities': ranked_opportunities,
        'page_hierarchy': page_hierarchy,
        'summary': summary,
    }
