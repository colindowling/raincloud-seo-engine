'use strict';

const archiver = require('archiver');

const {
  generateKeywordsCSV,
  generatePagesCSV,
  generateContentCSV,
  generateCalendarCSV,
  generateCrosslinksCSV,
  generateMetaCSV,
  generateCompetitorsCSV,
  generateG2CSV
} = require('./csv');

// ─── createExportZip ──────────────────────────────────────────────────────────
// Streams a complete SEO package ZIP to an Express response object.
// Contents:
//   - 8 CSV files
//   - /html/  — one HTML file per generated BoFu + comparison page
//   - robots.txt, llms.txt, sitemap.xml
//   - schema_all_pages.json

function createExportZip(state, res) {
  const archive = archiver('zip', {
    zlib: { level: 6 }   // balanced speed / compression
  });

  // Pipe errors to stderr; attempt to send a note if headers not yet committed
  archive.on('error', (err) => {
    console.error('[zip] archiver error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: `ZIP generation failed: ${err.message}` });
    } else {
      // Headers already sent — abort connection cleanly
      res.destroy();
    }
  });

  // Pipe archive output directly to the HTTP response
  archive.pipe(res);

  // ── CSV files ──────────────────────────────────────────────────────────────

  const csvFiles = [
    { name: 'keywords_all.csv',            fn: generateKeywordsCSV    },
    { name: 'bofu_pages_plan.csv',         fn: generatePagesCSV       },
    { name: 'content_plan.csv',            fn: generateContentCSV     },
    { name: 'calendar_6_month.csv',        fn: generateCalendarCSV    },
    { name: 'cross_links_map.csv',         fn: generateCrosslinksCSV  },
    { name: 'meta_tags_all_pages.csv',     fn: generateMetaCSV        },
    { name: 'competitor_intelligence.csv', fn: generateCompetitorsCSV },
    { name: 'g2_frustration_phrases.csv',  fn: generateG2CSV          }
  ];

  for (const { name, fn } of csvFiles) {
    try {
      const csvString = fn(state);
      archive.append(Buffer.from(csvString, 'utf8'), { name });
    } catch (err) {
      console.warn(`[zip] failed to generate ${name}: ${err.message}`);
      // Append an error note file rather than silently skipping
      archive.append(
        Buffer.from(`Error generating this file: ${err.message}\n`, 'utf8'),
        { name: name + '.error.txt' }
      );
    }
  }

  // ── HTML pages ─────────────────────────────────────────────────────────────

  const pagesWithHtml = [
    ...(state.pages?.bofu_pages       || []),
    ...(state.pages?.comparison_pages  || [])
  ].filter(p => p.html);

  for (const page of pagesWithHtml) {
    try {
      // Derive a safe filename from recommended_slug or cluster_id
      const rawName = (page.recommended_slug || page.cluster_id || 'page')
        .replace(/^\//, '')
        .replace(/\//g, '-')
        .replace(/[^a-zA-Z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 120);

      const filename = `html/${rawName || page.cluster_id || 'page'}.html`;
      archive.append(Buffer.from(page.html, 'utf8'), { name: filename });
    } catch (err) {
      console.warn(`[zip] failed to add HTML for page ${page.cluster_id}: ${err.message}`);
    }
  }

  // ── Tech SEO files ─────────────────────────────────────────────────────────

  const techSeo = state.tech_seo || {};

  if (techSeo.robots_txt) {
    archive.append(Buffer.from(techSeo.robots_txt, 'utf8'), { name: 'robots.txt' });
  } else {
    archive.append(
      Buffer.from('# robots.txt — run the full pipeline to generate this file\n', 'utf8'),
      { name: 'robots.txt' }
    );
  }

  if (techSeo.llms_txt) {
    archive.append(Buffer.from(techSeo.llms_txt, 'utf8'), { name: 'llms.txt' });
  } else {
    archive.append(
      Buffer.from('# llms.txt — run the full pipeline to generate this file\n', 'utf8'),
      { name: 'llms.txt' }
    );
  }

  if (techSeo.sitemap_xml) {
    archive.append(Buffer.from(techSeo.sitemap_xml, 'utf8'), { name: 'sitemap.xml' });
  } else {
    archive.append(
      Buffer.from('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', 'utf8'),
      { name: 'sitemap.xml' }
    );
  }

  // ── Schema JSON ────────────────────────────────────────────────────────────
  // Collect schema objects from all page types

  const allPages = [
    ...(state.pages?.bofu_pages        || []),
    ...(state.pages?.comparison_pages   || []),
    ...(state.pages?.supporting_content || []),
    ...(state.pages?.striking_distance  || [])
  ];

  const schemaObjects = allPages
    .filter(p => p.schema || p.schema_markup || p.structured_data)
    .map(p => ({
      cluster_id:       p.cluster_id,
      recommended_slug: p.recommended_slug,
      page_title:       p.page_title,
      schema:           p.schema || p.schema_markup || p.structured_data
    }));

  const schemaJson = JSON.stringify(schemaObjects, null, 2);
  archive.append(Buffer.from(schemaJson, 'utf8'), { name: 'schema_all_pages.json' });

  // ── Finalise ───────────────────────────────────────────────────────────────

  archive.finalize();
}

module.exports = { createExportZip };
