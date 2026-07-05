/**
 * md-parser.js
 *
 * Parse Markdown files conforming to the documentation convention into a structured
 * doc object, and provide accessor functions. The doc object is opaque — always use
 * the exported functions, never access doc internals directly.
 *
 * ESM module — imported directly, no CJS interop needed.
 * Conforms to: conventions/documentation.md
 *
 * Usage:
 *   import * as md from './md-parser.js';
 *   const doc = md.parseFile('/path/to/file.md');
 *   console.log(md.getKeywords(doc));
 */

import * as fs from './fs-scan.js';

// Required sections per documentation convention
const REQUIRED_SECTIONS = ['Quick Start', 'Load when'];

// Sections excluded from [up] links (and, for legacy files, from TOC skip-parsing).
// Keywords/Index/Changelog are no longer part of the canonical structure
// (conventions/documentation.md) but stay listed here so files not yet
// migrated away from them still render correctly.
const TOC_EXCLUDED = new Set(['Quick Start', 'Load when', 'Keywords', 'Table of Contents', 'Index', 'Changelog']);

// Insta-TOC codeblock inserted by toMarkdown() — see conventions/documentation.md [TOC Rule].
// `title` is the only field the renderer needs; the AI Assistant never writes this block
// by hand and never edits it — it is regenerated identically on every write.
const INSTA_TOC_BLOCK = [
  '---',
  '```insta-toc',
  '---',
  'title:',
  '  name: "Table of Contents"',
  '  level: 2',
  '  center: false',
  'exclude:',
  'style:',
  '  listType:',
  'omit:',
  'levels:',
  '  min:',
  '  max:',
  '---',
  '```',
];

function _parse(text, filePath) {
  const lines    = text.split(/\r?\n/);
  const sections = [];

  let title          = null;
  let subtitle       = null;
  let language       = null;
  let currentSection = null;
  let inCodeBlock    = false;
  let inInstaToc     = false;
  let headerZone     = true;

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i];
    const trimmed = line.trim();

    if (inInstaToc) {
      if (/^`{3,}\s*$/.test(trimmed)) inInstaToc = false;
      continue;
    }
    if (!inCodeBlock && /^`{3,}insta-toc\b/.test(trimmed)) {
      inInstaToc = true;
      continue;
    }

    if (/^(`{3,}|~{3,})/.test(trimmed)) {
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

    if (/^---+$/.test(trimmed)) continue;

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
      if (trimmed === '') continue;
      if (/^\*Language:/i.test(trimmed)) { language = trimmed; continue; }
      if (subtitle === null) { subtitle = trimmed; continue; }
      continue;
    }

    if (/^\[\[#Quick Start(\|up)?\]\]$/.test(trimmed)) continue;
    if (/^\[up\]\(#(quick-start|table-of-contents)\)/.test(trimmed)) continue;

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

  let tocInserted = false;

  for (const s of doc.sections) {
    parts.push(`## ${s.name}`);
    if (!TOC_EXCLUDED.has(s.name)) parts.push('[[#Quick Start]]');
    if (s.lines.length > 0) parts.push(...s.lines);
    parts.push('');

    if (s.name === 'Load when' && !tocInserted) {
      parts.push(...INSTA_TOC_BLOCK);
      parts.push('');
      tocInserted = true;
    }
  }

  if (!tocInserted) {
    parts.push(...INSTA_TOC_BLOCK);
    parts.push('');
  }

  return parts.join('\n').trimEnd() + '\n';
}

export {
  parseFile, parseText,
  getTitle, getSubtitle, getLanguage, getQuickStart, getKeywords,
  getSections, getSection, hasSection, getFilePath,
  getIssues, isConformant,
  setTitle, setSubtitle, setLanguage, setSection, insertSectionAt, deleteSection,
  toMarkdown,
};
