/**
 * md-to-html.js
 *
 * Convert a Markdown document (conforming to documentation convention) to a
 * standalone HTML file with a neutral print-ready CSS and a generated TOC.
 *
 * Args: <source.md> <output.html>
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const mdParser = require('./lib/md-parser');
const renderer = require('./lib/md-renderer');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const [,, sourcePath, outputPath] = process.argv;

if (!sourcePath || !outputPath) {
  console.log('ERROR:MISSING_ARG:Usage: node md-to-html.js <source.md> <output.html>');
  process.exit(0);
}

if (!fs.existsSync(sourcePath)) {
  console.log(`ERROR:FILE_NOT_FOUND:${sourcePath}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CSS — neutral, print-ready
// ---------------------------------------------------------------------------

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 15px;
    line-height: 1.7;
    color: #1a1a1a;
    background: #fff;
    max-width: 820px;
    margin: 0 auto;
    padding: 48px 40px 80px;
  }

  /* Title */
  h1 {
    font-size: 1.7em;
    font-weight: bold;
    border-bottom: 2px solid #1a1a1a;
    padding-bottom: 10px;
    margin-bottom: 6px;
  }

  .doc-subtitle {
    font-size: 0.95em;
    color: #444;
    margin-bottom: 4px;
  }

  .doc-meta {
    font-size: 0.85em;
    color: #666;
    font-style: italic;
    margin-bottom: 32px;
  }

  /* TOC */
  nav.doc-toc {
    border: 1px solid #ccc;
    padding: 16px 20px;
    margin-bottom: 40px;
    background: #fafafa;
  }

  .doc-toc-title {
    font-size: 0.8em;
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #555;
    margin-bottom: 8px;
  }

  nav.doc-toc ol {
    padding-left: 20px;
  }

  nav.doc-toc li {
    margin: 3px 0;
    font-size: 0.92em;
  }

  nav.doc-toc a {
    color: #1a1a1a;
    text-decoration: none;
  }

  nav.doc-toc a:hover {
    text-decoration: underline;
  }

  /* Sections */
  section {
    margin-bottom: 40px;
  }

  h2 {
    font-size: 1.2em;
    font-weight: bold;
    border-bottom: 1px solid #ccc;
    padding-bottom: 4px;
    margin-bottom: 14px;
    margin-top: 36px;
  }

  h3 {
    font-size: 1.05em;
    font-weight: bold;
    margin-top: 22px;
    margin-bottom: 8px;
  }

  h4 {
    font-size: 0.95em;
    font-weight: bold;
    margin-top: 16px;
    margin-bottom: 6px;
    color: #333;
  }

  p { margin-bottom: 12px; }

  a { color: #1a1a1a; }

  /* Back to top */
  a.back-to-top {
    display: block;
    font-size: 0.78em;
    color: #888;
    text-decoration: none;
    margin-bottom: 12px;
  }

  a.back-to-top:hover { text-decoration: underline; }

  /* Lists */
  ul, ol {
    padding-left: 22px;
    margin-bottom: 12px;
  }

  li { margin-bottom: 4px; }

  /* Tables */
  table {
    border-collapse: collapse;
    width: 100%;
    margin-bottom: 16px;
    font-size: 0.92em;
  }

  th, td {
    border: 1px solid #ccc;
    padding: 7px 12px;
    text-align: left;
    vertical-align: top;
  }

  th {
    background: #f0f0f0;
    font-weight: bold;
  }

  tr:nth-child(even) td { background: #fafafa; }

  /* Code */
  code {
    font-family: 'Courier New', Courier, monospace;
    font-size: 0.88em;
    background: #f4f4f4;
    padding: 1px 5px;
    border-radius: 2px;
  }

  pre {
    background: #f4f4f4;
    border: 1px solid #ddd;
    padding: 14px 16px;
    overflow-x: auto;
    margin-bottom: 16px;
    font-size: 0.85em;
    line-height: 1.5;
  }

  pre code {
    background: none;
    padding: 0;
    border-radius: 0;
  }

  /* Blockquote */
  blockquote {
    border-left: 3px solid #bbb;
    padding-left: 14px;
    margin: 0 0 12px 0;
    color: #555;
    font-style: italic;
  }

  /* Horizontal rule */
  hr {
    border: none;
    border-top: 1px solid #ddd;
    margin: 24px 0;
  }

  /* Print */
  @media print {
    body { max-width: 100%; padding: 0; font-size: 12px; }
    a.back-to-top { display: none; }
    nav.doc-toc { break-inside: avoid; }
    section { break-inside: avoid; }
    pre { white-space: pre-wrap; }
  }
`;

// ---------------------------------------------------------------------------
// Build HTML
// ---------------------------------------------------------------------------

try {
  const doc      = mdParser.parseFile(sourcePath);
  const title    = mdParser.getTitle(doc)    || path.basename(sourcePath, '.md');
  const subtitle = mdParser.getSubtitle(doc) || '';
  const language = mdParser.getLanguage(doc) || '';
  const body     = renderer.renderDoc(doc);

  const metaParts = [language].filter(Boolean);
  const metaHtml  = metaParts.length
    ? `<div class="doc-meta">${metaParts.map(p => p.replace(/\*/g, '')).join(' — ')}</div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>${CSS}</style>
</head>
<body>
  <h1>${title}</h1>
  ${subtitle ? `<div class="doc-subtitle">${subtitle}</div>` : ''}
  ${metaHtml}
  ${body}
</body>
</html>`;

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(`OK`);
  console.log(outputPath);

} catch (err) {
  console.log(`ERROR:WRITE_ERROR:${err.message}`);
  process.exit(0);
}
