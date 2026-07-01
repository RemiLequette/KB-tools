/**
 * md-renderer.js
 *
 * Render parsed doc objects (from md-parser.js) to HTML.
 * Depends on: marked (npm install marked)
 *
 * Usage:
 *   const renderer = require('./lib/md-renderer');
 *   const html = renderer.renderSection(doc, 'Quick Start');
 *   const full  = renderer.renderDoc(doc);
 */

'use strict';

const { marked }   = require('marked');
const mdParser     = require('./md-parser');

// Configure marked once — no side effects at require time
const _renderer = new marked.Renderer();
marked.setOptions({ renderer: _renderer, gfm: true, breaks: false });

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Convert a Markdown string to an HTML fragment.
 * @param {string} markdown
 * @returns {string} HTML string.
 */
function _toHtml(markdown) {
  if (!markdown || markdown.trim() === '') return '';
  return marked.parse(markdown);
}

/**
 * Escape a string for safe use in HTML attributes.
 * @param {string} str
 * @returns {string}
 */
function _escAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a single named section of a doc to an HTML fragment.
 * Returns empty string if the section is absent.
 * @param {object} doc
 * @param {string} name - Exact section name.
 * @returns {string} HTML fragment.
 */
function renderSection(doc, name) {
  const content = mdParser.getSection(doc, name);
  if (!content) return '';
  return _toHtml(content);
}

/**
 * Generate a section anchor id from a section name.
 * @param {string} name
 * @returns {string}
 */
function _sectionId(name) {
  return 'section-' + name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/**
 * Render all sections of a doc to HTML, in document order.
 * Includes a TOC at the top and a back-to-top link after each section heading.
 * Each section is wrapped in a <section> element with a data-name attribute.
 * @param {object} doc
 * @returns {string} HTML string.
 */
function renderDoc(doc) {
  const parts    = [];
  const sections = mdParser.getSections(doc);

  // TOC — skip structural/meta sections
  const META = new Set(['Quick Start', 'Keywords', 'Table des matieres', 'Index', 'Changelog']);
  const tocSections = sections.filter(s => !META.has(s.name));

  if (tocSections.length > 1) {
    parts.push('<nav class="doc-toc" id="doc-toc">');
    parts.push('<div class="doc-toc-title">Contents</div>');
    parts.push('<ol>');
    for (const { name } of tocSections) {
      const id = _sectionId(name);
      parts.push(`<li><a href="#${id}">${_escAttr(name)}</a></li>`);
    }
    parts.push('</ol>');
    parts.push('</nav>');
  }

  // Sections
  for (const { name, content } of sections) {
    const id        = _sectionId(name);
    const isContent = !META.has(name);
    parts.push(`<section data-section="${_escAttr(name)}" id="${id}">`);
    parts.push(`<h2>${_escAttr(name)}</h2>`);
    if (isContent && tocSections.length > 1) {
      parts.push('<a class="back-to-top" href="#doc-toc">↑ contents</a>');
    }
    parts.push(_toHtml(content));
    parts.push('</section>');
  }

  return parts.join('\n');
}

/**
 * Render the Keywords section as an array of HTML-safe strings.
 * Returns [] if the section is absent.
 * @param {object} doc
 * @returns {string[]}
 */
function renderKeywords(doc) {
  return mdParser.getKeywords(doc).map(k => _escAttr(k));
}

module.exports = {
  renderSection,
  renderDoc,
  renderKeywords,
};
