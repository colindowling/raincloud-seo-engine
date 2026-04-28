#!/usr/bin/env python3
"""
WF16 — Content Creator
Generates a full SEO-optimised article body HTML via Claude, following the brand
voice index and content brief.
"""
import re

from helpers import http_post, http_get, post_callback, claude_message, chunked

WORKFLOW_ID = 'Content_Creator'


def strip_tags(html):
    """Remove HTML tags and return plain text."""
    text = re.sub(r'<[^>]+>', ' ', html)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def count_words(text):
    return len(text.split())


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { draft_id, cluster_id, brief, voice_index, cta_assignment, cta_data,
               cross_links, brand_config, client_name, industry, all_pages }
    returns: { draft_id, title, body_html, body_text, word_count, cta_assignment,
               cta_auto_reasoning }
    """
    draft_id = payload.get('draft_id', '')
    cluster_id = payload.get('cluster_id', '')
    brief = payload.get('brief', {}) or {}
    voice_index = payload.get('voice_index') or {}
    cta_assignment = payload.get('cta_assignment', 'demo')
    cta_data = payload.get('cta_data', {}) or {}
    client_name = payload.get('client_name', '')
    industry = payload.get('industry', '')

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF16: Preparing content for draft {draft_id} '
                               f'({brief.get("primary_keyword", "")})...')

    # Step 1: Minimal voice defaults if empty
    if not voice_index:
        voice_index = {
            'tone': 'Professional and authoritative.',
            'style_rules': ['Use active voice', 'Be concise'],
            'avoid': ['Jargon without explanation'],
            'grammar_rules': ['Oxford comma', 'Sentence case for headings'],
            'example_phrases': [],
            'persona_voices': {},
        }

    # Step 2: Build CTA section content
    if cta_assignment == 'demo':
        cta_section = (
            f"CTA: {cta_data.get('text', 'Book a Demo')} "
            f"→ {cta_data.get('url', '#')}"
        )
    elif 'lead_magnet' in str(cta_assignment):
        cta_section = (
            f"CTA: Download '{cta_data.get('title', 'Resource')}' — "
            f"{cta_data.get('description', '')} "
            f"→ {cta_data.get('file_url', '#')}"
        )
    else:
        cta_section = (
            f"CTA: {cta_data.get('text', 'Learn More')} "
            f"→ {cta_data.get('url', '#')}"
        )

    # Step 3: Call Claude for full article body HTML
    target_word_count = brief.get('target_word_count', 1400)

    system_prompt = f"""You are an expert B2B content writer generating a complete, SEO-optimized article body.

VOICE GUIDE (follow these rules strictly):
Tone: {voice_index.get('tone', 'Professional and authoritative')}
Style rules: {'; '.join(voice_index.get('style_rules', []))}
Avoid: {'; '.join(voice_index.get('avoid', []))}
Grammar rules: {'; '.join(voice_index.get('grammar_rules', []))}

OUTPUT RULES:
1. Output ONLY the article body as HTML. No full page wrapper, no <html>/<head>/<body> tags.
2. Use <h2>, <h3>, <p>, <ul>, <ol>, <strong>, <em> tags only.
3. Target word count: {target_word_count} words.
4. Include the primary keyword naturally in: the first paragraph, at least 2 H2s, and the conclusion.
5. Answer every PAA question provided — use them as H2 or H3 headings where appropriate.
6. Address each G2 frustration phrase — work them into the problem sections naturally.
7. Include a CTA section near the end (before the conclusion) using the provided CTA data.
8. DO NOT include any internal links in the HTML — the CrossLink_Inserter will add those.
9. DO NOT include any meta tags, schema, or page-level HTML.
10. Write as if the author IS {client_name} — first person plural where appropriate."""

    paa_questions = (
        brief.get('paa_questions_to_answer') or brief.get('paa_questions', [])
    )
    g2_phrases = brief.get('g2_phrases_to_address', [])
    outline = brief.get('outline') or []

    user_message = f"""Write a complete {brief.get('content_format', 'guide')} for:

Title/H1: {brief.get('suggested_title', brief.get('primary_keyword', ''))}
Primary keyword: {brief.get('primary_keyword', '')}
Secondary keywords: {', '.join(brief.get('secondary_keywords', [])[:5])}
Target persona: {brief.get('target_persona', 'B2B decision maker')}
Search intent: {brief.get('search_intent', 'informational')}
Unique angle: {brief.get('angle', 'Comprehensive guide')}

PAA questions to answer (use as section headings where natural):
{chr(10).join(f'- {q}' for q in paa_questions[:5])}

G2/review frustrations to address in the copy (real buyer language):
{chr(10).join(f'- {p}' for p in g2_phrases[:5])}

Content gap to fill: {brief.get('serp_content_gap', brief.get('angle', ''))}

CTA to include: {cta_section}

Outline to follow (approximate — adapt as needed):
{chr(10).join(f"{s.get('section', '')}: {s.get('guidance', '')} (~{s.get('word_count', 150)} words)" for s in outline[:8])}"""

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF16: Calling Claude API to generate article body HTML...')

    body_html = ''
    try:
        raw = claude_message(system_prompt, user_message, max_tokens=6000)

        # Strip markdown fences
        raw = re.sub(r'^```html\s*', '', raw.strip())
        raw = re.sub(r'^```\s*', '', raw.strip())
        raw = re.sub(r'```\s*$', '', raw.strip())

        body_html = raw.strip()
    except Exception as e:
        print(f'[WF16] Claude API error: {e}')
        body_html = f'<p>Content generation failed: {e}</p>'

    body_text = strip_tags(body_html)
    word_count = count_words(body_text)

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF16: Article generated. {word_count} words, {len(body_html)} chars.')

    return {
        'draft_id': draft_id,
        'title': brief.get('suggested_title', brief.get('primary_keyword', '')),
        'body_html': body_html,
        'body_text': body_text,
        'word_count': word_count,
        'cta_assignment': cta_assignment,
        'cta_auto_reasoning': payload.get('cta_auto_reasoning', ''),
    }
