/**
 * md-parser.js
 *
 * Parse Markdown files conforming to the documentation convention into a structured
 * doc object, and provide accessor functions. The doc object is opaque — always use
 * the exported functions, never access doc internals directly.
 *
 * Addressable sections go down to ### granularity. A `##` section may carry its own
 * direct content (before its first `###`, possibly empty) plus a list of `###`
 * subsections. Path-aware functions (`getSectionByPath`, `setSectionByPath`,
 * `insertSectionAt`, `deleteSection`) identify a section by its full `H1/H2` or
 * `H1/H2/H3` path, joined with `/`. Plain-name functions (`getSection`, `hasSection`)
 * only ever look up a top-level `##` by its bare name — used internally for the
 * fixed sections (Quick Start, Load when, Keywords) that are always top-level.
 *
 * ESM module — imported directly, no CJS interop needed.
 * Conforms to: conventions/documentation.md, conventions/mcp-doc-index.md [section Section granularity]
 *
 * Usage:
 *   import * as md from './md-parser.js';
 *   const doc = md.parseFile('/path/to/file.md');
 *   console.log(md.getKeywords(doc));
 *   md.getSectionByPath(doc, 'Document Title/Some Heading/Some Subheading');
 */

import * as fs from './fs-scan.js';
import { basename } from 'path';

// Required sections per documentation convention
const REQUIRED_SECTIONS = ['Quick Start', 'Load when'];

// Sections excluded from [up] links (and, for legacy files, from TOC skip-parsing).
// Keywords/Index/Changelog are no longer part of the canonical structure
// (conventions/documentation.md) but stay listed here so files not yet
// migrated away from them still render correctly.
const TOC_EXCLUDED = new Set(['Quick Start', 'Load when', 'Keywords', 'Table of Contents', 'Index', 'Changelog']);

// Table of Contents generation — see conventions/documentation.md [TOC Rule].
// `toMarkdown()` regenerates a plain wikilink list identically on every write;
// the AI Assistant never writes or edits this list by hand. `###` subsections
// are listed as indented sub-items under their parent `##` section.
function buildTocLines(doc) {
  const lines = ['## Table of Contents', ''];
  for (const s of doc.sections) {
    if (TOC_EXCLUDED.has(s.name)) continue;
    lines.push(`- [[#${s.name}]]`);
    for (const sub of s.subsections) {
      lines.push(`  - [[#${sub.name}]]`);
    }
  }
  lines.push('');
  return lines;
}

function _parse(text, filePath) {
  const lines    = text.split(/\r?\n/);
  const sections = [];

  // YAML frontmatter — title-less items (TODO/AREAS/CHANGELOG, see
  // conventions/todo-list.md) open with a `---` delimiter on the very first
  // line, followed by `key: value` lines, closed by another `---`. Captured
  // verbatim (untouched, unparsed) so `toMarkdown` can reproduce it exactly;
  // it is not part of the H1/H2/H3 section model. Only recognized at the
  // start of the file — a `---` appearing later is a horizontal rule / TOC
  // delimiter, handled by the existing skip below. See T-017 frontmatter loss.
  let frontmatter = null;
  let startIdx = 0;
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    const closeIdx = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
    if (closeIdx !== -1) {
      frontmatter = lines.slice(1, closeIdx);
      startIdx = closeIdx + 1;
    }
  }

  let title            = null;
  let subtitle         = null;
  let language         = null;
  let preamble         = null;  // every non-blank header-zone line, verbatim, in order — see T-017 Bug 2
  let currentSection   = null;  // current ## node — { name, level, lines, subsections }
  let currentSubsection = null; // current ### node within currentSection — { name, level, lines }
  let inCodeBlock      = false;
  let inInstaToc       = false;
  let headerZone       = true;

  function pushLine(line) {
    if (currentSubsection) currentSubsection.lines.push(line);
    else if (currentSection) currentSection.lines.push(line);
  }

  for (let i = startIdx; i < lines.length; i++) {
    const line    = lines[i];
    const trimmed = line.trim();

    // Legacy-format shim: some not-yet-migrated repos (e.g. ddscope) may still
    // contain a bare insta-toc codeblock with no preceding `## Table of Contents`
    // heading — see conventions/documentation.md [TOC Rule] for the current format.
    // Kept for backward-compatible reads only; toMarkdown() never writes this form.
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
      pushLine(line);
      continue;
    }

    if (inCodeBlock) {
      pushLine(line);
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
        currentSubsection = null;
        continue;
      }

      currentSection = { name: sectionName, level: 2, startLine: i, lines: [], subsections: [] };
      currentSubsection = null;
      sections.push(currentSection);
      continue;
    }

    const h3Match = line.match(/^###\s+(.+)$/);
    if (h3Match && currentSection && !headerZone) {
      const subName = h3Match[1].trim();
      currentSubsection = { name: subName, level: 3, startLine: i, lines: [] };
      currentSection.subsections.push(currentSubsection);
      continue;
    }

    if (headerZone && title) {
      if (trimmed === '') continue;
      if (preamble === null) preamble = [];
      preamble.push(trimmed);
      if (/^\*Language:/i.test(trimmed)) { language = trimmed; continue; }
      if (subtitle === null) { subtitle = trimmed; continue; }
      continue;
    }

    if (/^\[\[#Quick Start(\|up)?\]\]$/.test(trimmed)) continue;
    if (/^\[up\]\(#(quick-start|table-of-contents)\)/.test(trimmed)) continue;

    pushLine(line);
  }

  for (const s of sections) {
    while (s.lines.length > 0 && s.lines[0].trim() === '') {
      s.lines.shift();
    }
    while (s.lines.length > 0 && s.lines[s.lines.length - 1].trim() === '') {
      s.lines.pop();
    }
    for (const sub of s.subsections) {
      while (sub.lines.length > 0 && sub.lines[0].trim() === '') {
        sub.lines.shift();
      }
      while (sub.lines.length > 0 && sub.lines[sub.lines.length - 1].trim() === '') {
        sub.lines.pop();
      }
    }
  }

  return { filePath, title, subtitle, language, preamble, frontmatter, sections };
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

// ---------------------------------------------------------------------------
// Top-level (bare-name) accessors — internal use only (Quick Start, Load when,
// Keywords), never exposed as the public MCP `section` argument.
// ---------------------------------------------------------------------------

function getSection(doc, name) {
  const s = doc.sections.find(s => s.name === name);
  return s ? s.lines.join('\n') : null;
}

function hasSection(doc, name) { return doc.sections.some(s => s.name === name); }
function getFilePath(doc) { return doc.filePath; }

// ---------------------------------------------------------------------------
// Full-path accessors — see conventions/mcp-doc-index.md [section Section granularity].
// A path is `H1/H2` (the ## section's own direct content) or `H1/H2/H3` (a
// subsection). The leading H1 must match doc.title (or, if the document has
// none, its filename without extension — see _effectiveTitle). A segment
// containing `/` is quoted — see _quoteSegment / _splitPathSegments.
// ---------------------------------------------------------------------------

/**
 * The document's effective H1 for path purposes. Falls back to the filename
 * (without extension) when the document has no `# Title` — some file types
 * legitimately omit it (e.g. GLOSSARY/ITEMS, exempt from `documentation.md`
 * by `conventions/glossary-rules.md`), and a `null` title would otherwise make
 * every section in that file permanently unaddressable by path.
 */
function _effectiveTitle(doc) {
  if (doc.title) return doc.title;
  return doc.filePath ? basename(doc.filePath, '.md') : '';
}

/**
 * A path segment (H1, H2, or H3 name) is wrapped in double quotes when it
 * contains `/` — the path separator — so it can still round-trip through
 * `_splitPathSegments`. Headings should not contain `/` per
 * `conventions/documentation.md [section Headings]`, but this keeps
 * pre-existing non-conformant headings addressable rather than silently
 * broken. Only quoted when necessary — the common case is unaffected.
 */
function _quoteSegment(name) {
  return name.includes('/') ? `"${name}"` : name;
}

/**
 * Splits a full path into its segments on `/`, treating a `".."`-quoted run as
 * one atomic segment (its own `/` characters are not split points). Quotes
 * are stripped from the returned segments. Mirrors `_quoteSegment` — a path
 * built by `getSections` always round-trips through this function.
 */
function _splitPathSegments(str) {
  const segments = [];
  let current = '';
  let inQuotes = false;
  for (const ch of str) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === '/' && !inQuotes) { segments.push(current); current = ''; continue; }
    current += ch;
  }
  segments.push(current);
  return segments;
}

function _parsePath(doc, targetPath) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') return null;
  const segments = _splitPathSegments(targetPath);
  if (segments.length < 2 || segments.length > 3) return null;
  if (segments[0] !== _effectiveTitle(doc)) return null;
  return { h2Name: segments[1], h3Name: segments.length === 3 ? segments[2] : null };
}

/** Every addressable leaf of the document as `{ path, level, content }` — one per
 *  `##` (its own direct content, excluding subsections) and one per `###`. */
function getSections(doc) {
  const result = [];
  const title = _quoteSegment(_effectiveTitle(doc));
  for (const s of doc.sections) {
    const h2 = _quoteSegment(s.name);
    result.push({ path: `${title}/${h2}`, level: 2, content: s.lines.join('\n') });
    for (const sub of s.subsections) {
      result.push({ path: `${title}/${h2}/${_quoteSegment(sub.name)}`, level: 3, content: sub.lines.join('\n') });
    }
  }
  return result;
}

function getSectionByPath(doc, targetPath) {
  const parsed = _parsePath(doc, targetPath);
  if (!parsed) return null;
  const h2 = doc.sections.find(s => s.name === parsed.h2Name);
  if (!h2) return null;
  if (!parsed.h3Name) return h2.lines.join('\n');
  const sub = h2.subsections.find(x => x.name === parsed.h3Name);
  return sub ? sub.lines.join('\n') : null;
}

function hasSectionByPath(doc, targetPath) { return getSectionByPath(doc, targetPath) !== null; }

function getIssues(doc) {
  const issues = [];

  for (const required of REQUIRED_SECTIONS) {
    if (!hasSection(doc, required)) issues.push(`Missing ## ${required}`);
  }

  if (hasSection(doc, 'Keywords') && getKeywords(doc).length === 0) {
    issues.push('## Keywords section is empty');
  }

  const seenH2 = new Set();
  for (const s of doc.sections) {
    if (seenH2.has(s.name)) issues.push(`Duplicate ## heading: ${s.name}`);
    seenH2.add(s.name);

    const seenH3 = new Set();
    for (const sub of s.subsections) {
      if (seenH3.has(sub.name)) issues.push(`Duplicate ### heading under ## ${s.name}: ${sub.name}`);
      seenH3.add(sub.name);
    }
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
  // Invalidate the verbatim preamble — it would otherwise take precedence in
  // toMarkdown and silently ignore this change. Falls back to reconstructing
  // from subtitle/language alone (loses any other preamble line there may
  // have been); acceptable since these setters bypass parsing altogether.
  doc.preamble = null;
}

function setLanguage(doc, value) {
  if (typeof value !== 'string') throw new Error('setLanguage: value must be a string');
  doc.language = value.trim() === '' ? null : value.trim();
  doc.preamble = null;
}

/**
 * Split the raw content of an `H1/H2` section into its own direct lines
 * (everything before the first embedded `###`) plus any `###` subsections
 * found in the content itself — mirrors how `_parse` splits a real document,
 * so `set` on an `H1/H2` path is a full replace of the section's subtree, not
 * just its direct text. A `###` line inside a fenced code block is not
 * treated as a heading, same rule as `_parse`. See T-017 Bug 1.
 */
function _splitIntoSubsections(contentStr) {
  const rawLines = contentStr === '' ? [] : contentStr.split(/\r?\n/);
  const ownLines = [];
  const subsections = [];
  let current = null;
  let inCodeBlock = false;

  for (const line of rawLines) {
    const trimmed = line.trim();

    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      (current ? current.lines : ownLines).push(line);
      continue;
    }

    if (!inCodeBlock) {
      const h3Match = line.match(/^###\s+(.+)$/);
      if (h3Match) {
        current = { name: h3Match[1].trim(), level: 3, startLine: -1, lines: [] };
        subsections.push(current);
        continue;
      }
    }

    (current ? current.lines : ownLines).push(line);
  }

  function trimBlock(arr) {
    while (arr.length > 0 && arr[0].trim() === '') arr.shift();
    while (arr.length > 0 && arr[arr.length - 1].trim() === '') arr.pop();
  }
  trimBlock(ownLines);
  for (const sub of subsections) trimBlock(sub.lines);

  return { lines: ownLines, subsections };
}

/**
 * Create or overwrite the section at `path` (`H1/H2` or `H1/H2/H3`).
 * A new `H1/H2/H3` requires its parent `H1/H2` to already exist.
 *
 * Setting an `H1/H2` path is a full replace of that section's subtree:
 * `content` may itself embed `###` headings, which become the section's new
 * subsections — any subsection not present in the new content is removed.
 * Setting an `H1/H2/H3` path only ever replaces that subsection's own lines.
 */
function setSectionByPath(doc, targetPath, content) {
  const parsed = _parsePath(doc, targetPath);
  if (!parsed) throw new Error('setSectionByPath: invalid or mismatched path: ' + targetPath);

  const contentStr = typeof content === 'string' ? content : '';

  const h2 = doc.sections.find(s => s.name === parsed.h2Name);

  if (!parsed.h3Name) {
    const { lines, subsections } = _splitIntoSubsections(contentStr);

    if (h2) { h2.lines = lines; h2.subsections = subsections; return; }

    const anchors = ['Index', 'Changelog'];
    let insertAt = doc.sections.length;
    for (const anchor of anchors) {
      const idx = doc.sections.findIndex(s => s.name === anchor);
      if (idx !== -1) { insertAt = idx; break; }
    }
    doc.sections.splice(insertAt, 0, { name: parsed.h2Name, level: 2, startLine: -1, lines, subsections });
    return;
  }

  const lines = contentStr === '' ? [] : contentStr.split(/\r?\n/);
  if (!h2) throw new Error('setSectionByPath: parent section not found: ' + parsed.h2Name);
  const sub = h2.subsections.find(x => x.name === parsed.h3Name);
  if (sub) { sub.lines = lines; return; }
  h2.subsections.push({ name: parsed.h3Name, level: 3, startLine: -1, lines });
}

/**
 * Insert a new section at `path` (`H1/H2` or `H1/H2/H3`), relative to `position`.
 * `position` is `"beginning"`, `"before:<path>"`, or `"after:<path>"` — the
 * reference path must be a sibling: another top-level `H1/H2` when inserting a
 * `##`, or another `H1/H2/H3` under the same parent when inserting a `###`.
 *
 * Returns null on success (including a no-op if `path` already exists),
 * `"SECTION_NOT_FOUND:<path>"` if the reference sibling doesn't exist, or
 * `"PARENT_NOT_FOUND:<name>"` if the parent `##` doesn't exist for a `###` insert.
 */
function insertSectionAt(doc, targetPath, content, position) {
  const parsed = _parsePath(doc, targetPath);
  if (!parsed) throw new Error('insertSectionAt: invalid or mismatched path: ' + targetPath);
  if (typeof position !== 'string' || position.trim() === '') {
    throw new Error('insertSectionAt: position must be a non-empty string');
  }

  const lines = content ? content.split(/\r?\n/) : [];

  if (!parsed.h3Name) {
    if (doc.sections.some(s => s.name === parsed.h2Name)) return null;
    const newSection = { name: parsed.h2Name, level: 2, startLine: -1, lines, subsections: [] };

    if (position === 'beginning') { doc.sections.unshift(newSection); return null; }

    const match = position.match(/^(before|after):(.+)$/);
    if (!match) throw new Error('insertSectionAt: invalid position format: ' + position);
    const [, direction, refPath] = match;

    const refParsed = _parsePath(doc, refPath);
    if (!refParsed || refParsed.h3Name) return 'SECTION_NOT_FOUND:' + refPath;
    const refIdx = doc.sections.findIndex(s => s.name === refParsed.h2Name);
    if (refIdx === -1) return 'SECTION_NOT_FOUND:' + refPath;

    const insertAt = direction === 'before' ? refIdx : refIdx + 1;
    doc.sections.splice(insertAt, 0, newSection);
    return null;
  }

  const h2 = doc.sections.find(s => s.name === parsed.h2Name);
  if (!h2) return 'PARENT_NOT_FOUND:' + parsed.h2Name;
  if (h2.subsections.some(x => x.name === parsed.h3Name)) return null;
  const newSubsection = { name: parsed.h3Name, level: 3, startLine: -1, lines };

  if (position === 'beginning') { h2.subsections.unshift(newSubsection); return null; }

  const match = position.match(/^(before|after):(.+)$/);
  if (!match) throw new Error('insertSectionAt: invalid position format: ' + position);
  const [, direction, refPath] = match;

  const refParsed = _parsePath(doc, refPath);
  if (!refParsed || !refParsed.h3Name || refParsed.h2Name !== parsed.h2Name) return 'SECTION_NOT_FOUND:' + refPath;
  const refIdx = h2.subsections.findIndex(x => x.name === refParsed.h3Name);
  if (refIdx === -1) return 'SECTION_NOT_FOUND:' + refPath;

  const insertAt = direction === 'before' ? refIdx : refIdx + 1;
  h2.subsections.splice(insertAt, 0, newSubsection);
  return null;
}

/** Delete the section at `path` (`H1/H2` or `H1/H2/H3`). Returns false if not found. */
function deleteSection(doc, targetPath) {
  const parsed = _parsePath(doc, targetPath);
  if (!parsed) return false;

  if (!parsed.h3Name) {
    const idx = doc.sections.findIndex(s => s.name === parsed.h2Name);
    if (idx === -1) return false;
    doc.sections.splice(idx, 1);
    return true;
  }

  const h2 = doc.sections.find(s => s.name === parsed.h2Name);
  if (!h2) return false;
  const idx = h2.subsections.findIndex(x => x.name === parsed.h3Name);
  if (idx === -1) return false;
  h2.subsections.splice(idx, 1);
  return true;
}

function toMarkdown(doc) {
  // Mirrors the read-side title fallback (_effectiveTitle / getSections) —
  // a document legitimately without a `# Title` (see conventions/glossary-rules.md)
  // is reconstructed without one instead of failing the write. See T-016.
  const parts = [];
  if (doc.frontmatter) {
    parts.push('---');
    parts.push(...doc.frontmatter);
    parts.push('---');
    parts.push('');
  }
  if (doc.title) {
    parts.push(`# ${doc.title}`);
    parts.push('');
  }
  // Preamble (subtitle / Document type / Language declarations) is replayed
  // verbatim, one declaration per line each followed by a blank line, per
  // conventions/documentation.md [section Document Structure]. Falls back to
  // the individual subtitle/language fields when there is no `preamble`
  // (e.g. a doc built programmatically via setSubtitle/setLanguage rather
  // than parsed) — see T-017 Bug 2.
  if (doc.preamble) {
    for (const line of doc.preamble) { parts.push(line); parts.push(''); }
  } else {
    if (doc.subtitle) { parts.push(doc.subtitle); parts.push(''); }
    if (doc.language) { parts.push(doc.language); parts.push(''); }
  }

  let tocInserted = false;

  for (const s of doc.sections) {
    parts.push(`## ${s.name}`);
    if (!TOC_EXCLUDED.has(s.name)) parts.push('[[#Quick Start]]');
    if (s.lines.length > 0) parts.push(...s.lines);
    parts.push('');

    for (const sub of s.subsections) {
      parts.push(`### ${sub.name}`);
      if (sub.lines.length > 0) parts.push(...sub.lines);
      parts.push('');
    }

    if (s.name === 'Load when' && !tocInserted) {
      parts.push(...buildTocLines(doc));
      tocInserted = true;
    }
  }

  if (!tocInserted) {
    parts.push(...buildTocLines(doc));
  }

  return parts.join('\n').trimEnd() + '\n';
}

export {
  parseFile, parseText,
  getTitle, getSubtitle, getLanguage, getQuickStart, getKeywords,
  getSections, getSection, hasSection, getSectionByPath, hasSectionByPath, getFilePath,
  getIssues, isConformant,
  setTitle, setSubtitle, setLanguage, setSectionByPath, insertSectionAt, deleteSection,
  toMarkdown, buildTocLines,
};
