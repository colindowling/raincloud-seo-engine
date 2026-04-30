#!/usr/bin/env python3
"""
WF10 — Page Generator
Generates full HTML landing pages via Claude using the page brief + brand config.
"""
import re
from helpers import (http_post, post_callback, claude_message)

WORKFLOW_ID = 'Page_Generator'

BANNED_PHRASES = [
    'keyword difficulty', 'composite score', 'dataforseo', 'apify',
    'exa.ai', 'clay enrichment', 'orchestrator',
    'workflow_id', 'job_id',
]

SYSTEM_PROMPT = """You are an expert B2B conversion copywriter and frontend developer. You build complete, polished,
production-ready HTML landing pages that:
1. Are optimised for the target keyword (in H1, first paragraph, meta title, URL slug, alt text)
2. Follow brand voice and style guidelines precisely
3. Include persuasive conversion copy with clear value propositions
4. Have a logical content hierarchy (H1 → H2 → H3) that matches search intent
5. Include a compelling CTA section with the provided CTA URL and button text
6. Include the lead magnet section if provided
7. Include the contact/demo form section if provided
8. Include schema markup as a <script type="application/ld+json"> block in <head>
9. Include all provided internal links naturally within body copy
10. Include G2 social proof quotes if provided (with star ratings)
11. Use modern, clean HTML5 with embedded CSS (no external stylesheets)
12. The page must be fully self-contained — no external JS or CSS dependencies except Google Fonts
13. NEVER include meta-commentary, debug info, or internal tool names in the output
14. Output ONLY the complete HTML document starting with <!DOCTYPE html>"""


def build_page_prompt(payload):
    """Construct the full user message from payload sections."""
    brief = payload.get('page_brief', {}) or {}
    brand = payload.get('brand_config', {}) or {}
    lead_magnet = payload.get('lead_magnet_config', {}) or {}
    contact_form = payload.get('contact_form_config', {}) or {}
    meta_tags = payload.get('meta_tags', {}) or {}
    schema = payload.get('schema_markup', {}) or {}
    cross_links = payload.get('cross_links', []) or []
    social_proof = payload.get('g2_social_proof', []) or []

    import json

    sections = []

    # BRAND STYLE
    sections.append(f"""## BRAND STYLE
Company Name: {brand.get('company_name', '')}
Primary Color: {brand.get('primary_color', '#2563EB')}
Secondary Color: {brand.get('secondary_color', '#1E40AF')}
Accent Color: {brand.get('accent_color', '#F59E0B')}
Font Family: {brand.get('font_family', 'Inter, system-ui, sans-serif')}
Brand Voice: {brand.get('voice', 'Professional, direct, outcome-focused')}
Tagline: {brand.get('tagline', '')}
Logo URL: {brand.get('logo_url', '')}""")

    # PAGE BRIEF
    sections.append(f"""## PAGE BRIEF
Primary Keyword: {brief.get('primary_keyword', '')}
Secondary Keywords: {', '.join(brief.get('secondary_keywords', [])[:6])}
Target Persona: {brief.get('target_persona', '')}
Search Intent: {brief.get('search_intent', 'commercial')}
Content Format: {brief.get('content_format', 'landing_page')}
Opportunity Type: {brief.get('opportunity_type', 'C')}
Recommended H1: {brief.get('recommended_h1', brief.get('primary_keyword', ''))}
Core Problem Solved: {brief.get('core_problem', '')}
Target Word Count: {brief.get('target_word_count', '1200-1600')}
Narrative: {brief.get('narrative', '')}
URL Slug: {brief.get('recommended_slug', '')}
PAA Questions to answer: {'; '.join(brief.get('paa_questions', [])[:5])}
G2 Pain Phrases to address: {'; '.join(str(p.get('phrase', p) if isinstance(p, dict) else p) for p in brief.get('g2_frustration_phrases', [])[:5])}
Reddit Questions to address: {'; '.join(brief.get('reddit_questions', [])[:3])}
Outline: {json.dumps(brief.get('outline', []), indent=2) if brief.get('outline') else 'Generate based on keyword and intent'}""")

    # CTA
    cta_url = brand.get('cta_url', '#demo')
    cta_text = brand.get('cta_text', 'Book a Free Demo')
    sections.append(f"""## CALL TO ACTION
Primary CTA URL: {cta_url}
Primary CTA Text: {cta_text}
Secondary CTA: {brand.get('secondary_cta_text', 'Start Free Trial')} → {brand.get('secondary_cta_url', '#trial')}""")

    # LEAD MAGNET
    if lead_magnet:
        sections.append(f"""## LEAD MAGNET SECTION
Title: {lead_magnet.get('title', '')}
Description: {lead_magnet.get('description', '')}
CTA Button Text: {lead_magnet.get('cta_text', 'Download Free Guide')}
Form Fields: {', '.join(lead_magnet.get('form_fields', ['First Name', 'Work Email', 'Company']))}""")

    # CONTACT FORM
    if contact_form:
        sections.append(f"""## CONTACT/DEMO FORM
Headline: {contact_form.get('headline', 'See It In Action')}
Subheadline: {contact_form.get('subheadline', 'Book a personalised 30-minute demo')}
Fields: {', '.join(contact_form.get('fields', ['First Name', 'Last Name', 'Work Email', 'Company', 'Team Size']))}
Submit Button: {contact_form.get('submit_text', 'Book My Demo')}
Form Action URL: {contact_form.get('action_url', '#')}""")

    # META TAGS
    sections.append(f"""## META TAGS
Title: {meta_tags.get('title', brief.get('primary_keyword', '') + ' | ' + brand.get('company_name', ''))}
Description: {meta_tags.get('description', '')}
Canonical URL: {meta_tags.get('canonical', '')}
OG Image: {meta_tags.get('og_image', '')}""")

    # SCHEMA
    if schema:
        sections.append(f"## SCHEMA MARKUP\n{json.dumps(schema, indent=2)}")

    # FAQ
    paa = brief.get('paa_questions', [])
    if paa:
        sections.append(f"""## FAQ SECTION
Include an FAQ section answering these questions naturally:
{chr(10).join(f'- {q}' for q in paa[:6])}""")

    # SOCIAL PROOF
    if social_proof:
        proof_text = '\n'.join(
            f'- "{p.get("text", p)}" — {p.get("reviewer", "")} ({p.get("stars", 5)} stars)'
            if isinstance(p, dict) else f'- "{p}"'
            for p in social_proof[:4]
        )
        sections.append(f"""## G2 SOCIAL PROOF
Include these verified G2 review quotes in a testimonials section:
{proof_text}""")

    # INTERNAL LINKS
    if cross_links:
        links_text = '\n'.join(
            f'- Anchor: "{lnk.get("anchor", "")}" → URL: {lnk.get("url", "")}'
            if isinstance(lnk, dict) else f'- {lnk}'
            for lnk in cross_links[:6]
        )
        sections.append(f"""## INTERNAL LINKS TO INCLUDE
Weave these internal links naturally into body copy:
{links_text}""")

    # PAGE STRUCTURE instructions
    sections.append("""## PAGE STRUCTURE REQUIREMENTS
1. <head>: charset, viewport, meta title, meta description, canonical, OG tags, schema JSON-LD, Google Fonts import, embedded <style>
2. Above-fold hero: H1, sub-headline (benefit statement), primary CTA button
3. Trust bar: logos or stat callouts (make up plausible stats if not provided)
4. Problem/solution section with H2
5. Feature/benefit sections (3-4 blocks) with H2s using secondary keywords
6. G2 social proof / testimonials section
7. FAQ section (H2 "Frequently Asked Questions", H3 per question)
8. Lead magnet section (if provided)
9. Contact/demo form section (if provided)
10. Footer with nav links and copyright
All sections should use semantic HTML. CTA buttons must use the exact CTA URL provided.""")

    return '\n\n'.join(sections)


def validate_html(html, brief, brand):
    """Validate the generated HTML meets minimum requirements."""
    errors = []

    if not html.strip().startswith('<!DOCTYPE html>'):
        errors.append('Does not start with <!DOCTYPE html>')

    if '<head>' not in html.lower():
        errors.append('Missing <head> tag')

    if '<body>' not in html.lower():
        errors.append('Missing <body> tag')

    h1_keyword = (brief.get('primary_keyword') or '').lower()
    if h1_keyword and h1_keyword[:15] not in html.lower():
        errors.append(f'H1 keyword "{h1_keyword[:15]}" not found in HTML')

    cta_url = brand.get('cta_url', '')
    if cta_url and cta_url != '#demo' and cta_url not in html:
        errors.append(f'CTA URL {cta_url} not found in HTML')

    for phrase in BANNED_PHRASES:
        if phrase.lower() in html.lower():
            errors.append(f'Banned phrase found: "{phrase}"')

    return errors


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { page_brief, brand_config, lead_magnet_config, contact_form_config,
               meta_tags, schema_markup, cross_links, g2_social_proof }
    returns: { cluster_id, page_slug, html, html_length_chars, validation_passed }
    """
    brief = payload.get('page_brief', {}) or {}
    brand = payload.get('brand_config', {}) or {}
    cluster_id = brief.get('cluster_id', payload.get('cluster_id', ''))
    page_slug = brief.get('recommended_slug', '')

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF10: Generating page for cluster {cluster_id} '
                               f'({brief.get("primary_keyword", "")})...')

    user_message = build_page_prompt(payload)

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF10: Calling Claude API for HTML generation...')

    html = ''
    validation_errors = []

    for attempt in range(1, 3):
        try:
            prompt = user_message
            if attempt == 2:
                prompt += (
                    "\n\nIMPORTANT: Your previous response failed validation. "
                    "Ensure the output:\n"
                    "1. Starts EXACTLY with <!DOCTYPE html>\n"
                    "2. Contains a proper <head> with meta tags and schema\n"
                    "3. Contains the primary keyword in the H1\n"
                    "4. Uses the exact CTA URL provided\n"
                    "5. Contains NO internal tool names or debug information\n"
                    "Output ONLY the complete HTML, nothing else."
                )
            raw = claude_message(SYSTEM_PROMPT, prompt, max_tokens=8000)

            # Strip any markdown code fences
            raw = re.sub(r'^```html\s*', '', raw.strip())
            raw = re.sub(r'```\s*$', '', raw.strip())

            # Find DOCTYPE start
            doctype_idx = raw.lower().find('<!doctype html>')
            if doctype_idx > 0:
                raw = raw[doctype_idx:]

            html = raw
            validation_errors = validate_html(html, brief, brand)

            if not validation_errors:
                print(f"[WF10] HTML generated successfully on attempt {attempt}")
                break
            else:
                print(f"[WF10] Validation errors on attempt {attempt}: {validation_errors}")

        except Exception as e:
            print(f"[WF10] Claude API error on attempt {attempt}: {e}")
            validation_errors = [str(e)]

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF10: HTML generation complete. '
                               f'{len(html)} chars. '
                               f'Validation: {"passed" if not validation_errors else "warnings: " + str(validation_errors[:2])}')

    return {
        'cluster_id': cluster_id,
        'page_slug': page_slug,
        'primary_keyword': brief.get('primary_keyword', ''),
        'html': html,
        'html_length_chars': len(html),
        'validation_passed': len(validation_errors) == 0,
        'validation_errors': validation_errors,
    }
