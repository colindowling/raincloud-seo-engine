#!/usr/bin/env python3
"""
WF03 — Competitor Enrichment via Exa
Enriches confirmed competitor list with company data and messaging intelligence.
Uses Exa semantic search + Claude extraction (Clay API endpoint no longer used).
"""
import os
import time
import re
import json
from helpers import (http_post, post_callback, exa_search, claude_message, extract_domain)

WORKFLOW_ID = 'Competitor_Enrichment_Clay'


def exa_firmographic_enrich(domain):
    """
    Fetch firmographic data for a domain via Exa + Claude.
    Searches Crunchbase, LinkedIn, and the company's own about/pricing pages.
    """
    company_name_guess = domain.split('.')[0].capitalize()
    queries = [
        f"{company_name_guess} company employees funding headquarters founded site:crunchbase.com OR site:linkedin.com",
        f"{domain} about company overview",
    ]

    all_texts = []
    for q in queries:
        try:
            resp = exa_search(
                query=q,
                num_results=5,
                contents={'text': True},
                search_type='neural',
                use_autoprompt=False,
            )
            for item in resp.get('results', []):
                text = (item.get('text', '') or '')[:1500]
                if text.strip():
                    all_texts.append(text)
        except Exception as e:
            print(f"[WF03] Exa firmographic error for {domain}: {e}")

    combined = '\n---\n'.join(all_texts[:3])[:3500]
    if not combined.strip():
        return {
            'company_name': company_name_guess,
            'employee_count': '', 'funding_status': '', 'hq': '',
            'linkedin_url': '', 'founded': '', 'revenue_range': '',
            'description': '',
        }

    system = (
        "You are a business intelligence analyst. Extract firmographic data from the text below. "
        "Return ONLY a JSON object with these keys: company_name, employee_count, funding_status, "
        "hq, linkedin_url, founded, revenue_range, description. "
        "Use empty string for any field you cannot find. No markdown, pure JSON."
    )
    user = f"Domain: {domain}\n\nText:\n{combined}"

    try:
        raw = claude_message(system, user, max_tokens=400)
        raw = re.sub(r'```(?:json)?', '', raw).strip().strip('`')
        data = json.loads(raw)
        return {
            'company_name': data.get('company_name', company_name_guess),
            'employee_count': data.get('employee_count', ''),
            'funding_status': data.get('funding_status', ''),
            'hq': data.get('hq', ''),
            'linkedin_url': data.get('linkedin_url', ''),
            'founded': data.get('founded', ''),
            'revenue_range': data.get('revenue_range', ''),
            'description': data.get('description', ''),
        }
    except Exception as e:
        print(f"[WF03] Claude firmographic extraction error for {domain}: {e}")
        return {
            'company_name': company_name_guess,
            'employee_count': '', 'funding_status': '', 'hq': '',
            'linkedin_url': '', 'founded': '', 'revenue_range': '',
            'description': '',
        }


def exa_messaging_intel(competitor_domain):
    """
    Pull messaging intelligence from Exa for a single competitor.
    Returns dict: primary_products, value_proposition, icp_language, key_ctas
    """
    queries = [
        f"What are {competitor_domain}'s main products, value propositions, and target customers",
        f"{competitor_domain} pricing and key features overview",
    ]

    all_texts = []
    for q in queries:
        try:
            resp = exa_search(
                query=q,
                num_results=5,
                include_domains=[competitor_domain],
                contents={'text': True, 'highlights': True},
                search_type='neural',
            )
            for item in resp.get('results', []):
                text = item.get('text', '') or ''
                highlights = item.get('highlights', []) or []
                combined = text[:1500] + ' '.join(highlights)[:500]
                if combined.strip():
                    all_texts.append(combined[:2000])
        except Exception as e:
            print(f"[WF03] Exa messaging error for {competitor_domain}: {e}")

    combined_text = '\n---\n'.join(all_texts[:3])
    if not combined_text.strip():
        return {
            'primary_products': [],
            'value_proposition': '',
            'icp_language': '',
            'key_ctas': [],
        }

    # Extract structured insights from text via simple heuristics
    cta_patterns = re.findall(
        r'\b(get started|free trial|request demo|book a demo|start free|sign up|'
        r'contact sales|schedule a call|try for free|see pricing)\b',
        combined_text.lower()
    )
    key_ctas = list(set(cta_patterns))[:5]

    return {
        'raw_text_sample': combined_text[:800],
        'primary_products': _extract_products(combined_text),
        'value_proposition': _extract_value_prop(combined_text),
        'icp_language': _extract_icp_language(combined_text),
        'key_ctas': key_ctas,
    }


def _extract_products(text):
    """Simple heuristic product extraction."""
    lines = text.split('.')
    products = []
    for line in lines:
        lower = line.lower()
        if any(kw in lower for kw in ['platform', 'software', 'tool', 'solution', 'suite', 'module']):
            cleaned = line.strip()[:120]
            if 10 < len(cleaned) < 120:
                products.append(cleaned)
    return list(set(products))[:5]


def _extract_value_prop(text):
    """Extract what appears to be a value proposition statement."""
    sentences = [s.strip() for s in text.split('.') if len(s.strip()) > 30]
    vp_keywords = ['helps', 'enables', 'allows', 'simplifies', 'automates', 'streamlines',
                   'reduce', 'increase', 'improve', 'save time', 'save money']
    for s in sentences[:30]:
        if any(kw in s.lower() for kw in vp_keywords):
            return s[:250]
    return sentences[0][:250] if sentences else ''


def _extract_icp_language(text):
    """Extract ICP-relevant language (who they target)."""
    icp_patterns = re.findall(
        r'(?:for|trusted by|used by|built for|designed for|ideal for)\s+([^,.]{10,80})',
        text, re.IGNORECASE
    )
    return icp_patterns[0] if icp_patterns else ''


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { confirmed_competitors: [{domain, g2_slug}] }
    returns: { competitor_profiles: [...] }
    """
    confirmed = payload.get('confirmed_competitors', [])

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF03: Enriching {len(confirmed)} competitors via Clay + Exa...')

    if not confirmed:
        return {'competitor_profiles': []}

    competitor_profiles = []
    total = len(confirmed)

    for idx, comp in enumerate(confirmed, 1):
        domain = comp.get('domain', '')
        g2_slug = comp.get('g2_slug', '')

        post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                      log_message=f'WF03: Enriching {domain} ({idx}/{total})...')

        # Firmographic enrichment via Exa + Claude (replaces Clay API)
        firm_data = exa_firmographic_enrich(domain)
        time.sleep(0.5)

        # Exa messaging intel
        messaging = exa_messaging_intel(domain)
        time.sleep(0.5)

        profile = {
            'domain': domain,
            'g2_slug': g2_slug,
            **firm_data,
            'messaging_intel': messaging,
        }
        competitor_profiles.append(profile)
        print(f"[WF03] Enriched {domain}: {firm_data.get('company_name', '')}, "
              f"{firm_data.get('employee_count', '')} employees")

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF03: Complete. {len(competitor_profiles)} profiles built.')

    return {'competitor_profiles': competitor_profiles}
