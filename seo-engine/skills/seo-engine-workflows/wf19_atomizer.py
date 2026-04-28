#!/usr/bin/env python3
"""
WF19 — Atomizer
Generates LinkedIn posts (personal per-persona + company page) from a published article.
"""
import re
import json

from helpers import http_post, http_get, post_callback, claude_message, chunked

WORKFLOW_ID = 'Atomizer'


def strip_tags(html):
    """Remove HTML tags and return plain text."""
    text = re.sub(r'<[^>]+>', ' ', html)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def parse_posts_json(raw):
    """Parse JSON from Claude response, returning list of 3 posts (with fallback)."""
    raw = re.sub(r'^```(?:json)?\s*', '', raw.strip())
    raw = re.sub(r'```\s*$', '', raw.strip())
    try:
        parsed = json.loads(raw)
        posts = parsed.get('posts', [])
        if isinstance(posts, list):
            return posts[:3]
    except (json.JSONDecodeError, AttributeError):
        pass
    # Fallback: split by double newline and return up to 3 blocks
    blocks = [b.strip() for b in re.split(r'\n{2,}', raw) if b.strip()]
    return blocks[:3]


def generate_persona_posts(persona, target_keyword, article_text, cta_ref, voice_index, brand_voice):
    """Generate 3 LinkedIn posts for a single persona via Claude."""
    name = persona.get('name', 'Executive')
    title = persona.get('title', 'Leader')
    tone_key = persona.get('tone', 'ceo').lower().replace(' ', '_')

    persona_voice = (
        brand_voice.get(tone_key)
        or brand_voice.get('ceo')
        or voice_index.get('tone', 'Professional and authoritative')
    )

    system_prompt = f"""You are a LinkedIn ghostwriter creating posts for a {title} named {name}.
Voice: {persona_voice}
Style: {'; '.join(voice_index.get('style_rules', [])[:5])}
Avoid: {'; '.join(voice_index.get('avoid', [])[:4])}"""

    user_message = f"""Based on this article about "{target_keyword}", write 3 LinkedIn posts for {name}, {title}.

Article summary (first 800 words):
{article_text[:800]}

CTA for each post: {cta_ref}

Requirements:
- Post 1: Hook-based — open with a counterintuitive insight or surprising stat from the article (max 1,200 chars)
- Post 2: Personal story angle — first person, "I've seen this..." or "We discovered..." framing (max 1,200 chars)
- Post 3: Data/list format — structured takeaways, numbered or bulleted (max 1,500 chars)
- Each post must end with a soft CTA referencing {cta_ref}
- Do NOT use em-dashes. No hashtag spam (max 3 relevant hashtags per post).
- LinkedIn max: 3,000 chars. Keep under 1,500 unless format requires more.

Return JSON: {{ "posts": ["post1 text", "post2 text", "post3 text"] }}"""

    try:
        raw = claude_message(system_prompt, user_message, max_tokens=2000)
        return parse_posts_json(raw)
    except Exception as e:
        print(f'[WF19] Error generating posts for {name}: {e}')
        return [
            f'[Post generation failed for {name}: {e}]',
            f'[Post generation failed for {name}: {e}]',
            f'[Post generation failed for {name}: {e}]',
        ]


def generate_company_posts(company_name, target_keyword, article_text, cta_ref, voice_index):
    """Generate 3 LinkedIn posts for the company page via Claude."""
    company_page_voice = (
        voice_index.get('persona_voices', {}).get('company_page')
        or 'Educational, third-person, data-led'
    )

    system_prompt = f"""You are a LinkedIn content manager writing for the {company_name} company page.
Voice: {company_page_voice}"""

    user_message = f"""Write 3 LinkedIn posts for the {company_name} company page about "{target_keyword}".

Based on article (first 600 words): {article_text[:600]}
CTA: {cta_ref}

Requirements:
- Post 1: Educational insight — "New analysis shows..." or "The data on X is clear:" format
- Post 2: Industry trend angle — connects the article topic to a broader market shift
- Post 3: Practical tip/checklist format — actionable takeaway from the article
- Third person, no "I" or "we"
- Educational / data-forward / thought leadership tone
- More formal than personal posts

Return JSON: {{ "posts": ["post1 text", "post2 text", "post3 text"] }}"""

    try:
        raw = claude_message(system_prompt, user_message, max_tokens=2000)
        return parse_posts_json(raw)
    except Exception as e:
        print(f'[WF19] Error generating company posts: {e}')
        return [
            f'[Company post generation failed: {e}]',
            f'[Company post generation failed: {e}]',
            f'[Company post generation failed: {e}]',
        ]


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { draft_id, title, article_html, target_keyword, cta_assignment,
               cta_data, personas, company_name, brand_voice, voice_index }
    returns: { draft_id, personal_posts, company_posts, total_posts }
    """
    draft_id = payload.get('draft_id', '')
    title = payload.get('title', '')
    article_html = payload.get('article_html', '')
    target_keyword = payload.get('target_keyword', title)
    cta_assignment = payload.get('cta_assignment', 'demo')
    cta_data = payload.get('cta_data', {}) or {}
    personas = payload.get('personas', []) or []
    company_name = payload.get('company_name', '')
    brand_voice = payload.get('brand_voice', {}) or {}
    voice_index = payload.get('voice_index', {}) or {}

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF19: Atomizing draft {draft_id} for {len(personas)} persona(s) + company page...')

    # Step 1: Extract plain text
    article_text = strip_tags(article_html)

    # Step 2: Build CTA reference string
    if cta_assignment == 'demo':
        cta_ref = f"Link to book a demo with {company_name}"
    elif 'lead_magnet' in str(cta_assignment):
        cta_ref = f"Link to download '{cta_data.get('title', 'resource')}'"
    else:
        cta_ref = cta_data.get('text', 'Learn more')

    # Step 3: Generate personal posts per persona
    personal_posts = []
    for persona in personas[:3]:
        name = persona.get('name', 'Executive')
        title_p = persona.get('title', 'Leader')

        post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                      log_message=f'WF19: Generating posts for {name} ({title_p})...')

        posts = generate_persona_posts(
            persona, target_keyword, article_text, cta_ref, voice_index, brand_voice
        )
        personal_posts.append({
            'persona': {'name': name, 'title': title_p},
            'posts': posts,
        })

    # Step 4: Generate company page posts
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF19: Generating company page posts for {company_name}...')

    company_posts = generate_company_posts(
        company_name, target_keyword, article_text, cta_ref, voice_index
    )

    total_posts = (len(personal_posts) * 3) + 3

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF19: Generated {total_posts} total LinkedIn posts.')

    return {
        'draft_id': draft_id,
        'personal_posts': personal_posts,
        'company_posts': company_posts,
        'total_posts': total_posts,
    }
