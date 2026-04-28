"""
Domain Authority estimation for SERP displaceability scoring.

DataForSEO's SERP endpoint does not include domain authority scores —
rank_info is null for organic results and domain_rank_overview only
covers major domains (status 40000 for most B2B SaaS sites).

This module provides a curated DA table covering the ~50 domains that
account for the vast majority of B2B SaaS SERP page-1 results, plus
heuristics for unknowns.

DA scale (0-100):
  90+   Massive aggregators (Reddit, Wikipedia, major news)
  80-90 Major review sites (G2, Capterra, Gartner) + top-tier media
  70-80 Mid-tier SaaS leaders, strong media outlets
  55-70 Established SaaS vendors
  40-55 Growing SaaS vendors, active tech blogs
  25-40 Small vendors, niche blogs
  10-25 Very new / low-authority sites
"""

import math
import re
from typing import Optional

# ---------------------------------------------------------------------------
# Curated DA table — covers most common B2B SaaS SERP domains
# ---------------------------------------------------------------------------
KNOWN_DA: dict[str, int] = {
    # ── Massive aggregators (90-99) ──────────────────────────────────────
    'reddit.com':         93,
    'quora.com':          87,
    'linkedin.com':       99,
    'youtube.com':        99,
    'wikipedia.org':      97,
    'google.com':         99,
    'microsoft.com':      96,
    'amazon.com':         96,
    'apple.com':          94,

    # ── Review & comparison sites (75-90) ────────────────────────────────
    'g2.com':             85,
    'capterra.com':       84,
    'getapp.com':         80,
    'softwareadvice.com': 77,
    'trustradius.com':    79,
    'trustpilot.com':     80,
    'glassdoor.com':      89,
    'yelp.com':           91,
    'pcmag.com':          85,
    'pcworld.com':        83,
    'cnet.com':           91,
    'techradar.com':      85,
    'tomsguide.com':      83,

    # ── Analyst / media (80-94) ──────────────────────────────────────────
    'gartner.com':        88,
    'forrester.com':      84,
    'idc.com':            80,
    'hbr.org':            91,
    'mckinsey.com':       87,
    'deloitte.com':       84,
    'techcrunch.com':     91,
    'forbes.com':         94,
    'businessinsider.com':92,
    'entrepreneur.com':   90,
    'inc.com':            88,
    'wsj.com':            93,
    'nytimes.com':        95,
    'venturebeat.com':    86,
    'zdnet.com':          87,
    'infoworld.com':      84,
    'computerworld.com':  83,
    'siliconangle.com':   77,

    # ── Major SaaS platforms (70-92) ─────────────────────────────────────
    'salesforce.com':     92,
    'hubspot.com':        91,
    'zendesk.com':        84,
    'atlassian.com':      85,
    'slack.com':          89,
    'zoom.us':            87,
    'intercom.com':       79,
    'mailchimp.com':      85,
    'shopify.com':        90,
    'stripe.com':         83,
    'twilio.com':         80,
    'sendgrid.com':       78,

    # ── Revenue intelligence / sales engagement (50-70) ──────────────────
    'gong.io':            63,
    'chorus.ai':          51,
    'salesloft.com':      57,
    'outreach.io':        60,
    'clari.com':          55,
    'revenue.io':         47,
    'mindtickle.com':     50,
    'apollo.io':          65,
    'zoominfo.com':       80,
    'seamless.ai':        60,
    'lusha.com':          62,
    'clearbit.com':       67,
    '6sense.com':         65,
    'demandbase.com':     67,
    'bombora.com':        62,
    'cognism.com':        60,

    # ── CRM / RevOps (60-80) ─────────────────────────────────────────────
    'pipedrive.com':      73,
    'close.com':          67,
    'freshsales.com':     70,
    'copper.com':         60,
    'nutshell.com':       58,

    # ── Content / SEO tools (55-75) ──────────────────────────────────────
    'semrush.com':        75,
    'ahrefs.com':         72,
    'moz.com':            70,
    'similarweb.com':     73,
    'hootsuite.com':      79,
    'buffer.com':         77,

    # ── Tech media / documentation (60-80) ───────────────────────────────
    'medium.com':         91,
    'dev.to':             78,
    'stackoverflow.com':  93,
    'github.com':         96,
    'npmjs.com':          83,
    'pypi.org':           79,

    # ── Competing page types in B2B SaaS SERPs ───────────────────────────
    'klenty.com':         55,
    'yesware.com':        60,
    'groove.co':          48,
    'reply.io':           58,
    'woodpecker.co':      55,
    'lemlist.com':        60,
    'mixmax.com':         58,
    'overloop.io':        42,
    'instantly.ai':       55,
    'smartlead.ai':       45,
    'claap.io':           45,
    'revenuegrid.com':    52,
    'ringcentral.com':    79,
    'dialpad.com':        68,
    'aircall.io':         62,
    'justcall.io':        52,
}

# Subdomains we can map to the root domain
_SUBDOMAIN_STRIP = re.compile(
    r'^(?:www\.|blog\.|support\.|help\.|docs\.|community\.|learn\.|resources\.|go\.)'
)


def _normalize_domain(domain: str) -> str:
    """Strip common subdomains to match the curated table."""
    return _SUBDOMAIN_STRIP.sub('', domain.lower())


def get_da(domain: str, etv: Optional[float] = None) -> int:
    """
    Return an estimated domain authority (0-100) for a given domain.

    Priority order:
    1. Curated table (exact match after normalizing subdomains)
    2. ETV-based estimate if provided (from DataForSEO domain_rank_overview)
    3. Heuristic from domain characteristics
    """
    normalized = _normalize_domain(domain)

    # 1. Curated table
    if normalized in KNOWN_DA:
        return KNOWN_DA[normalized]

    # 2. ETV proxy (log10 scale — calibrated against Reddit=95, medium SaaS=55)
    if etv and etv > 0:
        return min(95, max(10, int(math.log10(etv + 1) * 12)))

    # 3. Heuristics
    # Known large TLDs / brand signals
    if any(large in normalized for large in ['.gov', '.edu', '.org']):
        return 72
    # Single-word .com domains often belong to established companies
    parts = normalized.replace('.io', '').replace('.com', '').replace('.ai', '').split('.')
    if len(parts) == 1 and len(parts[0]) <= 8:
        return 48  # short domain → likely established vendor
    # Longer / complex domains tend to be smaller sites
    return 35


def avg_page1_da(organic_results: list[dict]) -> dict:
    """
    Given a list of top-10 organic SERP results (each with a 'domain' key),
    return:
      - avg_da: average estimated domain authority (0-100)
      - displaceability: 'High' | 'Medium' | 'Low'
      - domain_breakdown: list of {domain, da} for transparency

    Displaceability thresholds:
      avg_da < 45 → High  (new domain can realistically rank in 3-4 months)
      avg_da 45-65 → Medium  (requires 4-6 months + content investment)
      avg_da > 65 → Low  (6+ months, existing authority required)
    """
    breakdown = []
    for result in organic_results[:10]:
        domain = result.get('domain', '')
        etv = result.get('_etv')  # optional — filled by ETV lookup
        da = get_da(domain, etv)
        breakdown.append({'domain': domain, 'da': da})

    if not breakdown:
        return {'avg_da': 50, 'displaceability': 'Medium', 'domain_breakdown': []}

    avg = round(sum(b['da'] for b in breakdown) / len(breakdown), 1)

    if avg < 45:
        level = 'High'
    elif avg <= 65:
        level = 'Medium'
    else:
        level = 'Low'

    return {
        'avg_da': avg,
        'avg_page1_da': avg,      # alias for engine compatibility
        'displaceability': level,
        'domain_breakdown': breakdown,
    }


if __name__ == '__main__':
    # Smoke test with the real gong pricing SERP results
    test_organic = [
        {'domain': 'www.gong.io'},
        {'domain': 'www.claap.io'},
        {'domain': 'www.reddit.com'},
        {'domain': 'revenuegrid.com'},
        {'domain': 'www.outdoo.ai'},
        {'domain': 'www.trustradius.com'},
        {'domain': 'www.g2.com'},
        {'domain': 'salesloft.com'},
        {'domain': 'techcrunch.com'},
        {'domain': 'unknownblog.com'},
    ]
    result = avg_page1_da(test_organic)
    print(f"\nGong Pricing SERP — DA Analysis")
    print(f"  Avg page-1 DA: {result['avg_da']}")
    print(f"  Displaceability: {result['displaceability']}")
    print(f"  Domain breakdown:")
    for b in result['domain_breakdown']:
        print(f"    {b['domain']:<35} DA={b['da']}")
