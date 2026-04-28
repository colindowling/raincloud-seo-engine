#!/usr/bin/env python3
"""
WF11 — Content Brief Generator
Generates structured content briefs for blog posts, guides, and comparison pages.
"""
import re
import json
from helpers import (post_callback, claude_message, keyword_to_slug)

WORKFLOW_ID = 'Content_Brief_Generator'

BRIEF_SYSTEM_PROMPT = """You are a senior SEO content strategist and editorial director at a B2B SaaS agency.
You produce comprehensive, actionable content briefs that writers can execute without further guidance.

Your briefs are:
- Deeply informed by search intent and SERP analysis
- Structured to answer all related questions (PAA, G2 frustrations, Reddit pain points)
- Commercially oriented — every piece should move readers closer to conversion
- Specific about word count, headings, and internal linking requirements

Output ONLY valid JSON matching the exact schema provided. No markdown, no commentary."""


def build_brief_prompt(payload):
    """Build the content brief generation prompt."""
    cluster = payload.get('cluster', {}) or {}
    serp_data = payload.get('serp_data', {}) or {}
    g2_phrases = payload.get('g2_phrases', []) or []
    reddit_seed = payload.get('reddit_seed', {}) or {}
    bofu_pages_supported = payload.get('bofu_pages_supported', []) or []
    brand = payload.get('brand_config', {}) or {}

    industry = payload.get('industry', brand.get('industry', ''))

    primary_kw = cluster.get('primary_keyword', '')
    secondary_kws = cluster.get('secondary_keywords', [])
    opp_type = cluster.get('opportunity_type', 'B')
    narrative = cluster.get('narrative', '')
    kd = cluster.get('primary_kd', cluster.get('keyword_difficulty', 50))
    volume = cluster.get('primary_search_volume', cluster.get('search_volume', 0))
    word_count = cluster.get('target_word_count', '1400-2000')
    paa = serp_data.get('paa_questions', [])
    serp_format = serp_data.get('content_format_preference', {}).get('preferred', 'guide')
    content_gap = serp_data.get('content_gap_analysis', '')
    top_10_titles = [r.get('title', '') for r in serp_data.get('top_10_results', [])[:5]]

    g2_text = '; '.join(
        str(p.get('phrase', p) if isinstance(p, dict) else p)
        for p in g2_phrases[:8]
    )
    reddit_questions = reddit_seed.get('recurring_questions', []) if isinstance(reddit_seed, dict) else []
    content_seeds = reddit_seed.get('content_seeds', []) if isinstance(reddit_seed, dict) else []

    bofu_links_text = '; '.join(str(p) for p in bofu_pages_supported[:4])

    prompt = f"""Generate a detailed content brief for the following target:

PRIMARY KEYWORD: {primary_kw}
SECONDARY KEYWORDS: {', '.join(secondary_kws[:8])}
INDUSTRY: {industry}
OPPORTUNITY TYPE: {opp_type} (A=Comparison, B=Informational, C=Commercial Landing, D=Long-tail)
SEARCH VOLUME: {volume} / month
KEYWORD DIFFICULTY: {kd}
NARRATIVE: {narrative}
TARGET WORD COUNT: {word_count}
CONTENT FORMAT PREFERENCE: {serp_format}

SERP INTELLIGENCE:
- Current page 1 titles: {'; '.join(top_10_titles)}
- Content gap identified: {content_gap}
- PAA questions on SERP: {'; '.join(paa[:6])}

VOICE OF CUSTOMER:
- G2 frustration phrases to address: {g2_text}
- Reddit pain questions: {'; '.join(reddit_questions[:5])}

CONVERSION REQUIREMENTS:
- Company: {brand.get('company_name', 'the client')}
- CTA: {brand.get('cta_text', 'Book a Demo')} → {brand.get('cta_url', '/demo')}
- Internal links to BoFu pages: {bofu_links_text}

OUTPUT SCHEMA (return ONLY this JSON, no markdown):
{{
  "suggested_title": "...",
  "url_slug": "...",
  "meta_title": "...",
  "meta_description": "...",
  "primary_keyword": "...",
  "secondary_keywords": ["..."],
  "target_word_count": "...",
  "content_format": "...",
  "target_persona": "...",
  "search_intent": "...",
  "angle": "...",
  "outline": [
    {{"heading": "H1: ...", "type": "h1", "notes": "...", "word_count": 0}},
    {{"heading": "H2: ...", "type": "h2", "notes": "...", "word_count": 0}},
    ...
  ],
  "paa_questions_to_answer": ["..."],
  "g2_phrases_to_address": ["..."],
  "internal_links_required": [
    {{"anchor_text": "...", "url": "...", "placement": "..."}}
  ],
  "call_to_action": {{
    "placement": "...",
    "button_text": "...",
    "url": "...",
    "surrounding_copy": "..."
  }},
  "lead_magnet_applicable": true,
  "estimated_ranking_timeline": "...",
  "brief_narrative": "..."
}}"""

    return prompt


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { cluster, serp_data, g2_phrases, reddit_seed, bofu_pages_supported, brand_config }
    returns: brief JSON object
    """
    cluster = payload.get('cluster', {}) or {}
    primary_kw = cluster.get('primary_keyword', 'unknown')
    cluster_id = cluster.get('cluster_id', '')

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF11: Generating content brief for {cluster_id}: {primary_kw}...')

    prompt = build_brief_prompt(payload)

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF11: Calling Claude API for brief generation...')

    raw_brief = None
    for attempt in range(1, 3):
        try:
            raw = claude_message(BRIEF_SYSTEM_PROMPT, prompt, max_tokens=2000)

            # Strip markdown fences if present
            raw = re.sub(r'^```(?:json)?\s*', '', raw.strip())
            raw = re.sub(r'```\s*$', '', raw.strip())

            # Find JSON object
            json_match = re.search(r'\{[\s\S]*\}', raw)
            if json_match:
                raw = json_match.group(0)

            brief = json.loads(raw)

            # Ensure required fields exist
            required_fields = ['suggested_title', 'url_slug', 'meta_title', 'meta_description',
                                'primary_keyword', 'secondary_keywords', 'target_word_count',
                                'content_format', 'outline']
            missing = [f for f in required_fields if f not in brief]

            if not missing:
                raw_brief = brief
                print(f"[WF11] Brief generated successfully on attempt {attempt}")
                break
            else:
                print(f"[WF11] Missing fields on attempt {attempt}: {missing}")
                prompt += f"\n\nIMPORTANT: Your response is missing these required fields: {missing}. Include them all."

        except json.JSONDecodeError as e:
            print(f"[WF11] JSON parse error on attempt {attempt}: {e}")
            prompt += "\n\nIMPORTANT: Return ONLY valid JSON. No markdown, no text outside the JSON object."
        except Exception as e:
            print(f"[WF11] Claude API error on attempt {attempt}: {e}")

    if raw_brief is None:
        # Build fallback brief from payload
        raw_brief = _build_fallback_brief(payload, cluster, primary_kw)

    # Ensure cluster_id is included
    raw_brief['cluster_id'] = cluster_id
    raw_brief['primary_keyword'] = primary_kw

    # Ensure url_slug is valid
    if not raw_brief.get('url_slug'):
        raw_brief['url_slug'] = keyword_to_slug(primary_kw)

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF11: Brief complete for {cluster_id}. '
                               f'Outline: {len(raw_brief.get("outline", []))} sections.')

    return raw_brief


def _build_fallback_brief(payload, cluster, primary_kw):
    """Return a minimal valid brief if Claude fails."""
    brand = payload.get('brand_config', {}) or {}
    return {
        'suggested_title': f"The Complete Guide to {primary_kw.title()}",
        'url_slug': keyword_to_slug(primary_kw),
        'meta_title': f"{primary_kw.title()} | {brand.get('company_name', '')}",
        'meta_description': f"Learn everything about {primary_kw} in this comprehensive guide.",
        'primary_keyword': primary_kw,
        'secondary_keywords': cluster.get('secondary_keywords', [])[:5],
        'target_word_count': cluster.get('target_word_count', '1400-2000'),
        'content_format': 'guide',
        'target_persona': payload.get('industry', 'business') + ' professional',
        'search_intent': 'informational',
        'angle': f"Practical guide to {primary_kw}",
        'outline': [
            {'heading': f'H1: The Complete Guide to {primary_kw.title()}', 'type': 'h1',
             'notes': 'Introduce topic and value proposition', 'word_count': 150},
            {'heading': f'H2: What is {primary_kw.title()}?', 'type': 'h2',
             'notes': 'Define and explain core concept', 'word_count': 200},
            {'heading': 'H2: Key Benefits', 'type': 'h2',
             'notes': 'List primary benefits with examples', 'word_count': 300},
            {'heading': 'H2: How It Works', 'type': 'h2',
             'notes': 'Step-by-step explanation', 'word_count': 400},
            {'heading': 'H2: Frequently Asked Questions', 'type': 'h2',
             'notes': 'Address PAA questions', 'word_count': 400},
        ],
        'paa_questions_to_answer': payload.get('serp_data', {}).get('paa_questions', [])[:5],
        'g2_phrases_to_address': [
            str(p.get('phrase', p) if isinstance(p, dict) else p)
            for p in payload.get('g2_phrases', [])[:5]
        ],
        'internal_links_required': [],
        'call_to_action': {
            'placement': 'end of article',
            'button_text': brand.get('cta_text', 'Book a Demo'),
            'url': brand.get('cta_url', '/demo'),
            'surrounding_copy': f'Ready to see how {brand.get("company_name", "we")} can help?',
        },
        'lead_magnet_applicable': False,
        'estimated_ranking_timeline': cluster.get('estimated_ranking_timeline', '2-4 months'),
        'brief_narrative': cluster.get('narrative', ''),
    }
