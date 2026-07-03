/**
 * md-parser.cjs
 *
 * Parse Markdown files conforming to the documentation convention into a structured
 * doc object, and provide accessor functions. The doc object is opaque — always use
 * the exported functions, never access doc internals directly.
 *
 * CommonJS module (.cjs) — loadable from ESM via createRequire regardless of package "type".
 * Conforms to: conventions/documentation.md
 *
 * Usage (from ESM):
 *   import { createRequire } from 'module';
 *   const md = createRequire(import.meta.url)('./md-parser.cjs');
 */

'use strict';

const fs = require('./fs-scan.cjs');   // ← .cjs to avoid ERR_REQUIRE_ESM

const REQUIRED_SECTIONS = ['Quick Start', 'Load when'];
const TOC_EXCLUDED = new Set(['Quick Start', 'Load when', 'Keywords', 'Table of Contents', 'Index', 'Changelog']);

function _toAnchor(name) {
  return name
    .toLowerCase()
    .replace(/ /g, '-')
    .replace(/[^\w\-\u00C0-\u024F]/g, '')
    .replace(/'/g, '');
}

function _generateToc(sections) {
  const tocSections = sections.filter(s => {
    if (s.name === 'Quick Start')       return false;
    if (s.name === 'Keywords')          return false;
    if (s.name === 'Table of Contents') return false;
    if (s.name === 'Changelog')         return false;
    return true;
  });

  if (tocSections.length <= 2) return null;

  const lines = tocSections.map((s, i) => {
    const anchor = _toAnchor(s.name);
    return `${i + 1}. [${s.name}](#${anchor})`;
  });

  return lines.join('\n');
}

function _parse(text, filePath) {
  const lines    = text.split(/\r?\n/);
  const sections = [];

  let title          = null;
  let subtitle       = null;
  let language       = null;
  let currentSection = null;
  let inCodeBlock    = false;
  let headerZone     = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^(`{3,}|~{3,})/.test(line.trim())) {
      inCodeBlock = !inCodeBlock;
      if (currentSection) currentSection.lines.push(line);
      continue;
    }

    if (inCodeBlock) {
      if (currentSection) currentSection.lines.push(line);
      continue;
    }

    if (!title && /^#\s+\S/.test(line)) {
      title = line.replace(/^#\s+/, '').trim();
      continue;
    }

    if (/^---+$/.test(line.trim())) continue;

    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      headerZone = false;
      const sectionName = h2Match[1].trim();

      if (sectionName === 'Table of Contents') {
        currentSection = null;
        continue;
      }

      currentSection = { name: sectionName, level: 2, startLine: i, lines: [] };
      sections.push(currentSection);
      continue;
    }

    if (headerZone && title) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      if (/^\*Language:/i.test(trimmed)) { language = trimmed; continue; }
      if (subtitle === null) { subtitle = trimmed; continue; }
      continue;
    }

    if (/^\[up\]\(#table-of-contents\)/.test(line.trim())) continue;

    if (currentSection) currentSection.lines.push(line);
  }

  for (const s of sections) {
    while (s.lines.length > 0 && s.lines[s.lines.length - 1].trim() === '') {
      s.lines.pop();
    }
  }

  return { filePath, title, subtitle, language, sections };
}

function parseFile(filePath) {
  const text = fs.readFile(filePath);
  return _parse(text, filePath);
}

function parseText(text, filePath) {
  if (typeof filePath === 'undefined') throw new Error('parseText requires a filePath argument');
  return _parse(text, filePath);
}

function getTitle(doc)    { return doc.title    || null; }
function getSubtitle(doc) { return doc.subtitle || null; }
function getLanguage(doc) { return doc.language || null; }
function getQuickStart(doc) { return getSection(doc, 'Quick Start'); }

function getKeywords(doc) {
  const raw = getSection(doc, 'Keywords');
  if (!raw) return [];
  return raw.split(',').map(k => k.trim()).filter(Boolean);
}

function getSections(doc) {
  return doc.sections.map(s => ({ name: s.name, level: s.level, content: s.lines.join('\n') }));
}

function getSection(doc, name) {
  const s = doc.sections.find(s => s.name === name);
  return s ? s.lines.join('\n') : null;
}

function hasSection(doc, name) { return doc.sections.some(s => s.name === name); }
function getFilePath(doc) { return doc.filePath; }

function getIssues(doc) {
  const issues = [];

  for (const required of REQUIRED_SECTIONS) {
    if (!hasSection(doc, required)) issues.push(`Missing ## ${required}`);
  }

  if (hasSection(doc, 'Keywords') && getKeywords(doc).length === 0) {
    issues.push('## Keywords section is empty');
  }

  return issues;
}

function isConformant(doc) { return getIssues(doc).length === 0; }

function setTitle(doc, title) {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error('setTitle: title must be a non-empty string');
  }
  doc.title = title.trim();
}

function setSubtitle(doc, value) {
  if (typeof value !== 'string') throw new Error('setSubtitle: value must be a string');
  doc.subtitle = value.trim() === '' ? null : value.trim();
}

function setLanguage(doc, value) {
  if (typeof value !== 'string') throw new Error('setLanguage: value must be a string');
  doc.language = value.trim() === '' ? null : value.trim();
}

function insertSectionAt(doc, name, content, position) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('insertSectionAt: name must be a non-empty string');
  }
  if (typeof position !== 'string' || position.trim() === '') {
    throw new Error('insertSectionAt: position must be a non-empty string');
  }
  if (doc.sections.some(s => s.name === name)) return null;

  const lines = content ? content.split(/\r?\n/) : [];
  const newSection = { name, level: 2, startLine: -1, lines };

  if (position === 'beginning') { doc.sections.unshift(newSection); return null; }

  const match = position.match(/^(before|after):(.+)$/);
  if (!match) throw new Error('insertSectionAt: invalid position format: ' + position);

  const [, direction, refName] = match;
  const refIdx = doc.sections.findIndex(s => s.name === refName);
  if (refIdx === -1) return 'SECTION_NOT_FOUND:' + refName;

  const insertAt = direction === 'before' ? refIdx : refIdx + 1;
  doc.sections.splice(insertAt, 0, newSection);
  return null;
}

function deleteSection(doc, name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('deleteSection: name must be a non-empty string');
  }
  const idx = doc.sections.findIndex(s => s.name === name);
  if (idx === -1) return false;
  doc.sections.splice(idx, 1);
  return true;
}

function setSection(doc, name, content) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('setSection: name must be a non-empty string');
  }
  const contentStr = typeof content === 'string' ? content : '';
  const lines = contentStr === '' ? [] : contentStr.split(/\r?\n/);

  const existing = doc.sections.find(s => s.name === name);
  if (existing) { existing.lines = lines; return; }

  const anchors = ['Index', 'Changelog'];
  let insertAt = doc.sections.length;
  for (const anchor of anchors) {
    const idx = doc.sections.findIndex(s => s.name === anchor);
    if (idx !== -1) { insertAt = idx; break; }
  }

  doc.sections.splice(insertAt, 0, { name, level: 2, startLine: -1, lines });
}

function toMarkdown(doc) {
  if (!doc.title) throw new Error('toMarkdown: document has no title');

  const parts = [];
  parts.push(`# ${doc.title}`);
  parts.push('');
  if (doc.subtitle) { parts.push(doc.subtitle); parts.push(''); }
  if (doc.language) { parts.push(doc.language); parts.push(''); }

  const tocContent = _generateToc(doc.sections);
  const hasToc     = tocContent !== null;
  const needsUpLink = (name) => hasToc && !TOC_EXCLUDED.has(name);

  for (const s of doc.sections) {
    if (hasToc && s.name !== 'Quick Start' && s.name !== 'Keywords' &&
        s.name !== 'Index' && s.name !== 'Changelog' && !TOC_EXCLUDED.has(s.name)) {
      if (!parts.includes('## Table of Contents')) {
        parts.push('## Table of Contents');
        parts.push('');
        parts.push(tocContent);
        parts.push('');
      }
    }

    parts.push(`## ${s.name}`);
    if (needsUpLink(s.name)) parts.push('[up](#table-of-contents)');
    if (s.lines.length > 0) parts.push(...s.lines);
    parts.push('');
  }

  return parts.join('\n').trimEnd() + '\n';
}

module.exports = {
  parseFile, parseText,
  getTitle, getSubtitle, getLanguage, getQuickStart, getKeywords,
  getSections, getSection, hasSection, getFilePath,
  getIssues, isConformant,
  setTitle, setSubtitle, setLanguage, setSection, insertSectionAt, deleteSection,
  toMarkdown,
};
