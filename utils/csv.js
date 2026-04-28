'use strict';

const { stringify } = require('csv-stringify/sync');

// ─── Shared stringify wrapper ─────────────────────────────────────────────────
// Always includes header row.  Handles null/undefined cells gracefully.

function toCSV(columns, rows) {
  const header  = columns.map(c => (typeof c === 'string' ? c : c.header));
  const keys    = columns.map(c => (typeof c === 'string' ? c : c.key));
  const records = rows.map(row => keys.map(k => {
    const v = row == null ? '' : row[k];
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.join('; ');
    return String(v);
  }));
  return stringify([header, ...records], { cast: { string: v => v } });
}

// ─── generateKeywordsCSV ──────────────────────────────────────────────────────
// Source: state.research.keyword_universe.clusters

function generateKeywordsCSV(state) {
  const clusters = state?.research?.keyword_universe?.clusters || [];

  const columns = [
    { header: 'Primary Keyword',   key: 'primary_keyword' },
    { header: 'Cluster ID',        key: 'cluster_id' },
    { header: 'Type',              key: 'opportunity_type' },
    { header: 'Volume',            key: 'volume' },
    { header: 'KD',                key: 'keyword_difficulty' },
    { header: 'CPC',               key: 'cpc' },
    { header: 'BoFu Signal',       key: 'bofu_signal' },
    { header: 'Composite Score',   key: 'composite_score' },
    { header: 'Striking Distance', key: 'is_striking_distance' },
    { header: 'Narrative',         key: 'narrative' }
  ];

  const rows = clusters.map(c => ({
    primary_keyword:   c.primary_keyword   || '',
    cluster_id:        c.cluster_id        || '',
    opportunity_type:  c.opportunity_type  || '',
    volume:            c.volume            ?? '',
    keyword_difficulty: c.keyword_difficulty ?? c.kd ?? '',
    cpc:               c.cpc               ?? '',
    bofu_signal:       c.bofu_signal       ?? '',
    composite_score:   c.composite_score   ?? '',
    is_striking_distance: c.is_striking_distance ? 'Yes' : 'No',
    narrative:         c.narrative         || ''
  }));

  return toCSV(columns, rows);
}

// ─── generatePagesCSV ─────────────────────────────────────────────────────────
// Source: state.pages (all types combined, sorted by rank / composite_score)

function generatePagesCSV(state) {
  const pages = state?.pages || {};

  const tag = (arr, type) => (arr || []).map(p => ({ ...p, _type: type }));

  const all = [
    ...tag(pages.bofu_pages,        'BoFu'),
    ...tag(pages.comparison_pages,  'Comparison'),
    ...tag(pages.supporting_content,'Supporting'),
    ...tag(pages.striking_distance, 'Striking Distance')
  ].sort((a, b) => (b.composite_score || b.rank || 0) - (a.composite_score || a.rank || 0));

  const columns = [
    { header: 'Rank',            key: 'rank' },
    { header: 'Page Title',      key: 'page_title' },
    { header: 'URL Slug',        key: 'recommended_slug' },
    { header: 'Page Type',       key: '_type' },
    { header: 'Primary Keyword', key: 'primary_keyword' },
    { header: 'Volume',          key: 'volume' },
    { header: 'KD',              key: 'keyword_difficulty' },
    { header: 'CPC',             key: 'cpc' },
    { header: 'Score',           key: 'composite_score' },
    { header: 'Timeline',        key: 'recommended_timeline' },
    { header: 'Status',          key: 'status' }
  ];

  const rows = all.map((p, i) => ({
    rank:               p.rank               || i + 1,
    page_title:         p.page_title         || p.title || '',
    recommended_slug:   p.recommended_slug   || '',
    _type:              p._type,
    primary_keyword:    p.primary_keyword    || '',
    volume:             p.volume             ?? '',
    keyword_difficulty: p.keyword_difficulty ?? p.kd ?? '',
    cpc:                p.cpc                ?? '',
    composite_score:    p.composite_score    ?? '',
    recommended_timeline: p.recommended_timeline || '',
    status:             p.status             || 'Not Started'
  }));

  return toCSV(columns, rows);
}

// ─── generateContentCSV ───────────────────────────────────────────────────────
// Source: state.pages.supporting_content

function generateContentCSV(state) {
  const content = state?.pages?.supporting_content || [];

  const columns = [
    { header: 'Title',               key: 'page_title' },
    { header: 'URL Slug',            key: 'recommended_slug' },
    { header: 'Primary Keyword',     key: 'primary_keyword' },
    { header: 'Volume',              key: 'volume' },
    { header: 'Content Type',        key: 'content_type' },
    { header: 'Word Count',          key: 'recommended_word_count' },
    { header: 'BoFu Pages Supported',key: 'supports_pages' },
    { header: 'Status',              key: 'status' }
  ];

  const rows = content.map(c => ({
    page_title:           c.page_title           || c.title || '',
    recommended_slug:     c.recommended_slug     || '',
    primary_keyword:      c.primary_keyword      || '',
    volume:               c.volume               ?? '',
    content_type:         c.content_type         || '',
    recommended_word_count: c.recommended_word_count || '',
    supports_pages: Array.isArray(c.supports_pages)
      ? c.supports_pages.join('; ')
      : (c.supports_pages || ''),
    status:               c.status               || 'Not Started'
  }));

  return toCSV(columns, rows);
}

// ─── generateCalendarCSV ──────────────────────────────────────────────────────
// Source: state.calendar.tasks

function generateCalendarCSV(state) {
  const tasks = state?.calendar?.tasks || [];

  const columns = [
    { header: 'Week',               key: 'week' },
    { header: 'Day',                key: 'day' },
    { header: 'Task Title',         key: 'title' },
    { header: 'Task Type',          key: 'task_type' },
    { header: 'Owner',              key: 'owner' },
    { header: 'Hours',              key: 'hours' },
    { header: 'Status',             key: 'status' },
    { header: 'Linked Deliverable', key: 'linked_deliverable' },
    { header: 'Dependencies',       key: 'dependencies' },
    { header: 'Notes',              key: 'notes' }
  ];

  const rows = tasks.map(t => ({
    week:               t.week               || '',
    day:                t.day                || '',
    title:              t.title              || t.task_title || '',
    task_type:          t.task_type          || '',
    owner:              t.owner              || '',
    hours:              t.hours              ?? '',
    status:             t.status             || '',
    linked_deliverable: t.linked_deliverable || '',
    dependencies: Array.isArray(t.dependencies)
      ? t.dependencies.join('; ')
      : (t.dependencies || ''),
    notes:              t.notes              || ''
  }));

  return toCSV(columns, rows);
}

// ─── generateCrosslinksCSV ────────────────────────────────────────────────────
// Source: state.research.synthesis.ranked_opportunities
//         Each opportunity has internal_links_out[] and internal_links_in[] fields

function generateCrosslinksCSV(state) {
  const opportunities = state?.research?.synthesis?.ranked_opportunities || [];

  const columns = [
    { header: 'Page Slug',       key: 'page_slug' },
    { header: 'Direction',       key: 'direction' },
    { header: 'Anchor Text',     key: 'anchor_text' },
    { header: 'Target / Source URL', key: 'target_url' }
  ];

  const rows = [];

  for (const opp of opportunities) {
    const pageSlug = opp.recommended_slug || opp.cluster_id || '';

    // Outbound links
    const linksOut = opp.internal_links_out || [];
    for (const link of linksOut) {
      rows.push({
        page_slug:   pageSlug,
        direction:   'OUT',
        anchor_text: link.anchor_text || link.anchor || '',
        target_url:  link.destination || link.url || link.target_url || ''
      });
    }

    // Inbound links
    const linksIn = opp.internal_links_in || [];
    for (const link of linksIn) {
      rows.push({
        page_slug:   pageSlug,
        direction:   'IN',
        anchor_text: link.anchor_text || link.anchor || '',
        target_url:  link.source      || link.url    || link.source_url || ''
      });
    }
  }

  return toCSV(columns, rows);
}

// ─── generateMetaCSV ─────────────────────────────────────────────────────────
// Source: all pages (bofu + comparison + supporting)

function generateMetaCSV(state) {
  const pages = state?.pages || {};
  const all = [
    ...(pages.bofu_pages        || []),
    ...(pages.comparison_pages  || []),
    ...(pages.supporting_content || [])
  ];

  const domain = state?.config?.identity?.primary_domain || '';

  const columns = [
    { header: 'URL',              key: 'url' },
    { header: 'Title Tag',        key: 'title_tag' },
    { header: 'Meta Description', key: 'meta_description' },
    { header: 'OG Title',         key: 'og_title' },
    { header: 'OG Description',   key: 'og_description' },
    { header: 'Canonical',        key: 'canonical' }
  ];

  const rows = all.map(p => {
    const slug      = p.recommended_slug || '';
    const fullUrl   = slug
      ? `https://${domain}${slug.startsWith('/') ? '' : '/'}${slug}`
      : '';
    const canonical = p.canonical || fullUrl;

    return {
      url:              fullUrl,
      title_tag:        p.title_tag        || p.page_title || '',
      meta_description: p.meta_description || '',
      og_title:         p.og_title         || p.page_title || '',
      og_description:   p.og_description   || p.meta_description || '',
      canonical
    };
  });

  return toCSV(columns, rows);
}

// ─── generateCompetitorsCSV ───────────────────────────────────────────────────
// Source: state.competitors.profiles

function generateCompetitorsCSV(state) {
  const profiles = state?.competitors?.profiles || [];

  const columns = [
    { header: 'Domain',            key: 'domain' },
    { header: 'Company Name',      key: 'company_name' },
    { header: 'Overlap',           key: 'overlap' },
    { header: 'Est. Traffic',      key: 'estimated_traffic' },
    { header: 'Domain Rank',       key: 'domain_rank' },
    { header: 'Funding',           key: 'funding' },
    { header: 'Employees',         key: 'employees' },
    { header: 'G2 Slug',           key: 'g2_slug' },
    { header: 'Value Proposition', key: 'value_proposition' }
  ];

  const rows = profiles.map(p => ({
    domain:             p.domain             || '',
    company_name:       p.company_name       || p.name || '',
    overlap:            p.overlap            ?? '',
    estimated_traffic:  p.estimated_traffic  ?? p.est_traffic ?? '',
    domain_rank:        p.domain_rank        ?? p.dr ?? '',
    funding:            p.funding            || '',
    employees:          p.employees          || '',
    g2_slug:            p.g2_slug            || (state?.competitors?.g2_slugs?.[p.domain] || ''),
    value_proposition:  p.value_proposition  || p.description || ''
  }));

  return toCSV(columns, rows);
}

// ─── generateG2CSV ────────────────────────────────────────────────────────────
// Source: state.research.g2_intelligence.competitors
// Shape: { [domain]: { frustrations/frustration_phrases: [{phrase, frequency, keyword_opps}] } }

function generateG2CSV(state) {
  const competitors = state?.research?.g2_intelligence?.competitors || {};

  const columns = [
    { header: 'Competitor',          key: 'competitor' },
    { header: 'Frustration Phrase',  key: 'phrase' },
    { header: 'Frequency',           key: 'frequency' },
    { header: 'Keyword Opportunity 1', key: 'kw_opp_1' },
    { header: 'Keyword Opportunity 2', key: 'kw_opp_2' }
  ];

  const rows = [];
  for (const [domain, data] of Object.entries(competitors)) {
    const phrases = data?.frustrations
      || data?.frustration_phrases
      || [];

    for (const item of phrases) {
      const opps = Array.isArray(item.keyword_opportunities)
        ? item.keyword_opportunities
        : [];
      rows.push({
        competitor: domain,
        phrase:     item.phrase   || item.text || String(item),
        frequency:  item.frequency ?? '',
        kw_opp_1:   opps[0] || '',
        kw_opp_2:   opps[1] || ''
      });
    }
  }

  return toCSV(columns, rows);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  generateKeywordsCSV,
  generatePagesCSV,
  generateContentCSV,
  generateCalendarCSV,
  generateCrosslinksCSV,
  generateMetaCSV,
  generateCompetitorsCSV,
  generateG2CSV
};
