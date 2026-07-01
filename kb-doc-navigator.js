/**
 * kb-doc-navigator.js
 *
 * Generate a self-contained HTML documentation navigator for a Markdown tree.
 * Conformant docs are listed and rendered. Non-conformant docs are reported separately.
 * Includes real-time filter on titles and keywords.
 *
 * Usage:
 *   node tools/kb-doc-navigator.js <root_dir> [output.html]
 *
 * Output defaults to: tools/kb-navigator.html
 */

'use strict';

const path       = require('path');
const md         = require('./lib/md-parser');
const renderer   = require('./lib/md-renderer');
const fss        = require('./lib/fs-scan');

// ---------------------------------------------------------------------------
// Build doc list
// ---------------------------------------------------------------------------

function buildDocs(rootDir) {
  const files     = fss.scanMarkdownFiles(rootDir);
  const conformant    = [];
  const nonConformant = [];

  for (const filePath of files) {
    let doc;
    try {
      doc = md.parseFile(filePath);
    } catch (e) {
      nonConformant.push({ relPath: fss.relativePath(rootDir, filePath), issues: [e.message] });
      continue;
    }

    const relPath = fss.relativePath(rootDir, filePath);
    if (md.isConformant(doc)) {
      conformant.push({
        relPath,
        title:     md.getTitle(doc) || relPath,
        keywords:  md.getKeywords(doc),
        quickStart: md.getQuickStart(doc) || '',
        html:      renderer.renderDoc(doc),
      });
    } else {
      nonConformant.push({ relPath, issues: md.getIssues(doc) });
    }
  }

  return { conformant, nonConformant };
}

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml(rootDir, conformant, nonConformant) {
  const generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');

  // Sidebar entries
  const sidebarItems = conformant.map((doc, i) => {
    const kwList = doc.keywords.map(k => `<span class="kw">${esc(k)}</span>`).join(' ');
    const kwData = doc.keywords.join(',').toLowerCase();
    return `
      <div class="nav-item" data-index="${i}"
           data-title="${esc(doc.title.toLowerCase())}"
           data-kw="${esc(kwData)}"
           onclick="showDoc(${i})">
        <div class="nav-title">${esc(doc.title)}</div>
        <div class="nav-path">${esc(doc.relPath)}</div>
        <div class="nav-kws">${kwList}</div>
      </div>`;
  }).join('');

  // Non-conformant list
  const nonConformantItems = nonConformant.map(f => `
    <div class="nc-item">
      <div class="nc-path">${esc(f.relPath)}</div>
      <div class="nc-issues">${f.issues.map(i => `<span class="issue">${esc(i)}</span>`).join(' ')}</div>
    </div>`).join('');

  // Doc content panels (hidden by default)
  const docPanels = conformant.map((doc, i) => `
    <div class="doc-panel" id="doc-${i}" style="display:none">
      <div class="doc-header">
        <h1 class="doc-title">${esc(doc.title)}</h1>
        <div class="doc-path">${esc(doc.relPath)}</div>
        <div class="doc-kws">${doc.keywords.map(k => `<span class="kw">${esc(k)}</span>`).join(' ')}</div>
      </div>
      <div class="doc-content">${doc.html}</div>
    </div>`).join('');

  // Welcome panel
  const welcomePanel = `
    <div class="doc-panel" id="doc-welcome">
      <div class="welcome">
        <div class="welcome-title">KB Doc Navigator</div>
        <div class="welcome-meta">${esc(rootDir)}</div>
        <div class="welcome-stats">
          <span>${conformant.length} conformant docs</span>
          <span>${nonConformant.length} non-conformant</span>
          <span>Generated ${generatedAt}</span>
        </div>
        <div class="welcome-hint">Select a document from the sidebar.</div>
      </div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KB Navigator — ${esc(path.basename(rootDir))}</title>
  <style>
    :root {
      --bg: #ffffff;
      --surface: #f8f9fc;
      --surface2: #f1f3f8;
      --border: #e2e6ef;
      --accent: #3b5bdb;
      --accent2: #6741d9;
      --green: #2f9e44;
      --red: #c92a2a;
      --yellow: #e67700;
      --text: #1a1d27;
      --text-muted: #4a5068;
      --text-dim: #868e96;
      --mono: 'JetBrains Mono', 'Fira Code', monospace;
      --sans: 'Inter', system-ui, sans-serif;
      --sidebar-w: 320px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    html, body { height: 100%; overflow: hidden; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 14px;
      display: flex;
      flex-direction: column;
    }

    /* Top bar */
    .topbar {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: .6rem 1rem;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      z-index: 10;
    }

    .topbar-title {
      font-weight: 700;
      color: var(--accent);
      font-size: .95rem;
      white-space: nowrap;
    }

    .search-input {
      flex: 1;
      max-width: 360px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-family: var(--mono);
      font-size: .82rem;
      padding: .35rem .75rem;
      outline: none;
      transition: border-color .2s;
    }

    .search-input:focus { border-color: var(--accent); }
    .search-input::placeholder { color: var(--text-dim); }

    .topbar-stats {
      margin-left: auto;
      color: var(--text-dim);
      font-size: .78rem;
      white-space: nowrap;
    }

    /* Main layout */
    .layout {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    /* Sidebar */
    .sidebar {
      width: var(--sidebar-w);
      flex-shrink: 0;
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .sidebar-section-label {
      padding: .5rem .9rem;
      font-size: .7rem;
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--text-dim);
      background: var(--surface2);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    .sidebar-docs {
      flex: 1;
      overflow-y: auto;
    }

    .nav-item {
      padding: .65rem .9rem;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      transition: background .1s;
    }

    .nav-item:hover { background: var(--surface); }
    .nav-item.active { background: var(--surface2); border-left: 2px solid var(--accent); }

    .nav-title {
      font-size: .85rem;
      font-weight: 600;
      color: var(--text);
      margin-bottom: .15rem;
    }

    .nav-path {
      font-family: var(--mono);
      font-size: .72rem;
      color: var(--text-dim);
      margin-bottom: .3rem;
    }

    .nav-kws {
      display: flex;
      flex-wrap: wrap;
      gap: .25rem;
    }

    /* Non-conformant section */
    .nc-toggle {
      padding: .5rem .9rem;
      font-size: .7rem;
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--red);
      background: var(--surface2);
      border-top: 1px solid var(--border);
      cursor: pointer;
      flex-shrink: 0;
      user-select: none;
    }

    .nc-toggle:hover { background: var(--surface); }

    .nc-list {
      overflow-y: auto;
      max-height: 200px;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }

    .nc-item {
      padding: .5rem .9rem;
      border-bottom: 1px solid var(--border);
    }

    .nc-path {
      font-family: var(--mono);
      font-size: .72rem;
      color: var(--text-muted);
      margin-bottom: .2rem;
    }

    .nc-issues { display: flex; flex-wrap: wrap; gap: .2rem; }

    /* Keywords */
    .kw {
      display: inline-block;
      background: rgba(108,142,247,.1);
      color: var(--accent);
      border: 1px solid rgba(108,142,247,.2);
      border-radius: 4px;
      padding: .05rem .35rem;
      font-size: .7rem;
      font-family: var(--mono);
      white-space: nowrap;
    }

    .issue {
      display: inline-block;
      background: rgba(248,113,113,.1);
      color: var(--red);
      border: 1px solid rgba(248,113,113,.2);
      border-radius: 4px;
      padding: .05rem .35rem;
      font-size: .7rem;
    }

    /* Content area */
    .content {
      flex: 1;
      overflow-y: auto;
      padding: 2rem 2.5rem;
    }

    /* Welcome */
    .welcome {
      margin: 4rem auto;
      max-width: 480px;
      text-align: center;
    }

    .welcome-title {
      font-size: 1.6rem;
      font-weight: 700;
      color: var(--accent);
      margin-bottom: .5rem;
    }

    .welcome-meta {
      font-family: var(--mono);
      font-size: .8rem;
      color: var(--text-dim);
      margin-bottom: 1.5rem;
    }

    .welcome-stats {
      display: flex;
      justify-content: center;
      gap: 1.5rem;
      color: var(--text-muted);
      font-size: .85rem;
      margin-bottom: 2rem;
    }

    .welcome-hint { color: var(--text-dim); font-size: .9rem; }

    /* Doc panel */
    .doc-header {
      margin-bottom: 2rem;
      padding-bottom: 1.2rem;
      border-bottom: 1px solid var(--border);
    }

    .doc-title {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text);
      margin-bottom: .3rem;
    }

    .doc-path {
      font-family: var(--mono);
      font-size: .78rem;
      color: var(--text-dim);
      margin-bottom: .6rem;
    }

    .doc-kws { display: flex; flex-wrap: wrap; gap: .3rem; }

    /* Markdown content styles */
    .doc-content { max-width: 780px; line-height: 1.75; }

    .doc-content section { margin-bottom: 2rem; }

    .doc-content h1 { font-size: 1.5rem; color: var(--text); margin-bottom: 1rem; }
    .doc-content h2 {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--accent2);
      margin: 1.8rem 0 .8rem;
      padding-bottom: .4rem;
      border-bottom: 1px solid var(--border);
    }
    .doc-content h3 { font-size: .95rem; font-weight: 600; color: var(--text-muted); margin: 1.2rem 0 .5rem; }
    .doc-content p  { margin-bottom: .85rem; color: var(--text); }
    .doc-content ul, .doc-content ol { padding-left: 1.5rem; margin-bottom: .85rem; }
    .doc-content li { margin-bottom: .3rem; }
    .doc-content a  { color: var(--accent); text-decoration: none; }
    .doc-content a:hover { text-decoration: underline; }

    .doc-content code {
      font-family: var(--mono);
      font-size: .82rem;
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: .1rem .35rem;
      color: var(--accent2);
    }

    .doc-content pre {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem 1.2rem;
      overflow-x: auto;
      margin-bottom: 1rem;
    }

    .doc-content pre code {
      background: none;
      border: none;
      padding: 0;
      color: var(--text);
      font-size: .82rem;
    }

    .doc-content table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 1rem;
      font-size: .85rem;
    }

    .doc-content th {
      background: var(--surface2);
      padding: .5rem .8rem;
      text-align: left;
      color: var(--text-muted);
      font-size: .75rem;
      text-transform: uppercase;
      letter-spacing: .05em;
      border: 1px solid var(--border);
    }

    .doc-content td {
      padding: .5rem .8rem;
      border: 1px solid var(--border);
      vertical-align: top;
    }

    .doc-content blockquote {
      border-left: 3px solid var(--accent);
      padding-left: 1rem;
      color: var(--text-muted);
      margin-bottom: .85rem;
    }

    .doc-content hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 1.5rem 0;
    }

    /* TOC */
    .doc-toc {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem 1.4rem;
      margin-bottom: 2rem;
      display: inline-block;
      min-width: 220px;
    }

    .doc-toc-title {
      font-size: .72rem;
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--text-dim);
      margin-bottom: .6rem;
      font-weight: 600;
    }

    .doc-toc ol {
      padding-left: 1.2rem;
      margin: 0;
    }

    .doc-toc li { margin-bottom: .25rem; }

    .doc-toc a {
      color: var(--accent);
      text-decoration: none;
      font-size: .85rem;
    }

    .doc-toc a:hover { text-decoration: underline; }

    /* Back to top */
    .back-to-top {
      display: inline-block;
      font-size: .72rem;
      color: var(--text-dim);
      text-decoration: none;
      margin-bottom: .6rem;
      transition: color .15s;
    }

    .back-to-top:hover { color: var(--accent); }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    /* Hidden */
    .hidden { display: none !important; }
  </style>
</head>
<body>

<div class="topbar">
  <div class="topbar-title">KB Navigator</div>
  <input class="search-input" type="text" id="search"
         placeholder="Filter by title or keyword..."
         oninput="filterDocs()">
  <div class="topbar-stats">${conformant.length} docs &nbsp;·&nbsp; ${nonConformant.length} issues</div>
</div>

<div class="layout">

  <!-- Sidebar -->
  <div class="sidebar">
    <div class="sidebar-section-label">Documents (${conformant.length})</div>
    <div class="sidebar-docs" id="sidebar-docs">
      ${sidebarItems}
    </div>
    ${nonConformant.length > 0 ? `
    <div class="nc-toggle" onclick="toggleNc()">
      Non-conformant (${nonConformant.length}) ▾
    </div>
    <div class="nc-list" id="nc-list" style="display:none">
      ${nonConformantItems}
    </div>` : ''}
  </div>

  <!-- Content -->
  <div class="content" id="content">
    ${welcomePanel}
    ${docPanels}
  </div>

</div>

<script>
  // Embedded doc data for search
  const docs = ${JSON.stringify(conformant.map((d, i) => ({
    i,
    title: d.title,
    path:  d.relPath,
    kw:    d.keywords,
  })))};

  let activeIndex = -1;

  function showDoc(i) {
    // Hide all panels
    document.getElementById('doc-welcome').style.display = 'none';
    document.querySelectorAll('.doc-panel').forEach(p => p.style.display = 'none');

    // Show selected
    document.getElementById('doc-' + i).style.display = 'block';

    // Highlight sidebar item
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const item = document.querySelector('[data-index="' + i + '"]');
    if (item) item.classList.add('active');

    activeIndex = i;
  }

  function filterDocs() {
    const q = document.getElementById('search').value.toLowerCase().trim();
    document.querySelectorAll('.nav-item').forEach(el => {
      if (!q) { el.classList.remove('hidden'); return; }
      const title = el.dataset.title || '';
      const kw    = el.dataset.kw    || '';
      el.classList.toggle('hidden', !title.includes(q) && !kw.includes(q));
    });
  }

  function toggleNc() {
    const list = document.getElementById('nc-list');
    if (list) list.style.display = list.style.display === 'none' ? 'block' : 'none';
  }
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args      = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node tools/kb-doc-navigator.js <root_dir> [output.html]');
  process.exit(1);
}

const rootDir    = path.resolve(args[0]);
const outputPath = args[1]
  ? path.resolve(args[1])
  : path.join(__dirname, 'kb-navigator.html');

try {
  fss.assertDirectory(rootDir);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

console.log(`Scanning: ${rootDir}`);
const { conformant, nonConformant } = buildDocs(rootDir);
console.log(`  Conformant    : ${conformant.length}`);
console.log(`  Non-conformant: ${nonConformant.length}`);

const html = renderHtml(rootDir, conformant, nonConformant);

try {
  fss.writeFile(outputPath, html);
  console.log(`  Output        : ${outputPath}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
