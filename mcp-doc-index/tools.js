/**
 * tools.js
 *
 * Pure orchestration layer for the MCP doc index tools — search, list_triggers,
 * read_section, write_section, create_document, reindex. Kept separate from
 * server.js (the MCP transport wiring) so it can be unit-tested without
 * spinning up a protocol connection.
 *
 * A Context groups the open db handles for all configured repos, keyed by repo
 * name, plus repo metadata (root, db path). Callers create one Context per
 * server process with createContext() and reuse it across tool calls.
 *
 * `read_section`/`write_section`'s `section` argument is the full H1/H2 or
 * H1/H2/H3 path — see conventions/mcp-doc-index.md [section Section granularity].
 * No bare heading name is accepted.
 *
 * @convention conventions/mcp-doc-index.md [## How — Implementation > MCP tools]
 * @convention conventions/mcp-doc-index.md [## How — Implementation > Design decisions]
 *
 * Not yet in references (document debt — update mcp-doc-index.md to absorb these):
 *   - REQUIRED_SECTIONS (protected-from-delete list) duplicates the list in
 *     md-parser.js; md-parser does not currently export it.
 *   - Error codes (FILE_NOT_FOUND, FILE_EXISTS, SECTION_NOT_FOUND, PARENT_NOT_FOUND,
 *     PROTECTED_SECTION, RESERVED_SECTION, NOT_CONFORMANT, REPO_NOT_FOUND,
 *     LOCK_HELD) follow conventions/tools.md's general error-code catalogue,
 *     applied here to MCP tool results instead of the stdout
 *     `ERROR:<code>:<message>` line format.
 */

import fs   from 'fs';
import path from 'path';

import { openDb, searchSections, searchDocumentMeta, listTriggers as dbListTriggers } from '../lib/index-db.js';
import { indexFile, indexRepo, refreshRepo } from '../lib/indexer.js';
import { withLock } from '../lib/lock.js';
import { loadRepos, findRepo } from '../lib/repo-config.js';
import * as md from '../lib/md-parser.js';

// Mirrors md-parser.js REQUIRED_SECTIONS — see "Not yet in references" above.
const REQUIRED_SECTIONS = ['Quick Start', 'Keywords', 'Index', 'Changelog'];

// Tool-owned, fully generated sections — never a real entry in doc.sections
// (md-parser.js [_parse] discards them on read, [toMarkdown]/[buildTocLines]
// regenerate them on every write). Not addressable by read_section or
// write_section under any mode — see T-017 Bug 4.
const RESERVED_SECTIONS = ['Table of Contents'];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Throws a tagged error carrying a `.code` for the MCP tool result mapping. */
function fail(code, message) {
  const err = new Error(`${code}: ${message ?? code}`);
  err.code = code;
  throw err;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Create a tool context from a repos.json path — loads repo config and opens
 * one db handle per repo, cached for reuse.
 *
 * @param {string} reposJsonPath - Absolute path to repos.json.
 * @returns {{ repos: {name:string,root:string,db:string,exclude?:string[]}[], getDb: (repoName:string) => import('better-sqlite3').Database, close: () => void }}
 */
export function createContext(reposJsonPath) {
  const repos = loadRepos(reposJsonPath);
  const dbHandles = new Map();

  function getDb(repoName) {
    const repo = findRepo(repos, repoName);
    if (!dbHandles.has(repo.name)) {
      fs.mkdirSync(path.dirname(repo.db), { recursive: true });
      dbHandles.set(repo.name, openDb(repo.db));
    }
    return dbHandles.get(repo.name);
  }

  function close() {
    for (const db of dbHandles.values()) db.close();
    dbHandles.clear();
  }

  return { repos, getDb, close };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _resolveFile(repo, relOrAbsFile) {
  const absPath = path.isAbsolute(relOrAbsFile)
    ? relOrAbsFile
    : path.resolve(repo.root, relOrAbsFile);
  if (!fs.existsSync(absPath)) fail('FILE_NOT_FOUND', `File not found: ${absPath}`);
  return absPath;
}

/** Throws RESERVED_SECTION when the path's leaf segment is tool-owned (e.g. Table of Contents). */
function _checkNotReserved(section) {
  const segments = section.split('/');
  const leafName = segments[segments.length - 1];
  if (RESERVED_SECTIONS.includes(leafName)) {
    fail('RESERVED_SECTION', `Section is tool-generated and not directly addressable: ${section}`);
  }
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/**
 * Full-text search across one repo or all configured repos.
 * Refreshes (lazy reindex) every already-known document in scope before
 * answering. Title/load_when matches are returned as a separate, higher-
 * relevance group ahead of section-body matches.
 *
 * @param {ReturnType<typeof createContext>} ctx
 * @param {{ query: string, repo?: string }} args
 * @returns {{ title_matches: object[], section_matches: object[] }}
 */
export function search(ctx, { query, repo }) {
  if (!query || !query.trim()) fail('MISSING_ARG', 'query is required');

  const targetRepos = repo ? [findRepo(ctx.repos, repo)] : ctx.repos;
  const titleMatches = [];
  const sectionMatches = [];

  for (const r of targetRepos) {
    const db = ctx.getDb(r.name);
    refreshRepo(db, r.name);
    titleMatches.push(...searchDocumentMeta(db, query, r.name));
    sectionMatches.push(...searchSections(db, query, r.name));
  }

  return { title_matches: titleMatches, section_matches: sectionMatches };
}

// ---------------------------------------------------------------------------
// listTriggers
// ---------------------------------------------------------------------------

/**
 * Return the load_when -> file table for a repo, refreshed via lazy reindex.
 *
 * @param {ReturnType<typeof createContext>} ctx
 * @param {{ repo: string }} args
 * @returns {{ file_path: string, title: string|null, load_when: string }[]}
 */
export function listTriggers(ctx, { repo }) {
  const r = findRepo(ctx.repos, repo);
  const db = ctx.getDb(r.name);
  refreshRepo(db, r.name);
  return dbListTriggers(db, r.name);
}

// ---------------------------------------------------------------------------
// readSection
// ---------------------------------------------------------------------------

/**
 * Read one section's content from a document. Lazy-reindexes the file first
 * (keeps the search index fresh as a side effect of the read).
 *
 * @param {ReturnType<typeof createContext>} ctx
 * @param {{ repo: string, file: string, section: string }} args
 * @returns {string} section content
 */
export function readSection(ctx, { repo, file, section }) {
  _checkNotReserved(section);

  const r = findRepo(ctx.repos, repo);
  const absPath = _resolveFile(r, file);
  const db = ctx.getDb(r.name);

  indexFile(db, r.name, absPath);

  const doc = md.parseFile(absPath);
  if (!md.hasSectionByPath(doc, section)) fail('SECTION_NOT_FOUND', `Section not found: ${section}`);
  return md.getSectionByPath(doc, section);
}

// ---------------------------------------------------------------------------
// writeSection
// ---------------------------------------------------------------------------

/**
 * Create, overwrite, insert, or delete a section, then write the file back —
 * blocked by conformance (getIssues). All three modes share one write path
 * so the conformance gate cannot be bypassed by any mode.
 *
 * Acquires the repo's advisory lock for the duration of the read-modify-write.
 *
 * @param {ReturnType<typeof createContext>} ctx
 * @param {{ repo: string, file: string, section: string, content?: string, mode?: 'set'|'insert'|'delete', position?: string }} args
 * @returns {{ ok: true }}
 */
export function writeSection(ctx, { repo, file, section, content, mode = 'set', position }) {
  if (!['set', 'insert', 'delete'].includes(mode)) {
    fail('MISSING_ARG', `Invalid mode: ${mode}`);
  }

  _checkNotReserved(section);

  const r = findRepo(ctx.repos, repo);
  const absPath = _resolveFile(r, file);
  const db = ctx.getDb(r.name);

  const pathSegments = section.split('/');
  const leafName = pathSegments[pathSegments.length - 1];
  if (mode === 'delete' && pathSegments.length === 2 && REQUIRED_SECTIONS.includes(leafName)) {
    fail('PROTECTED_SECTION', `Section is mandatory and cannot be deleted: ${section}`);
  }

  return withLock(r.db, () => {
    const doc = md.parseFile(absPath);

    if (mode === 'set') {
      md.setSectionByPath(doc, section, content ?? '');
    } else if (mode === 'insert') {
      if (!position) fail('MISSING_ARG', 'position is required for mode=insert');
      const result = md.insertSectionAt(doc, section, content ?? '', position);
      if (typeof result === 'string' && result.startsWith('SECTION_NOT_FOUND:')) {
        fail('SECTION_NOT_FOUND', `Reference section not found: ${result.split(':').slice(1).join(':')}`);
      } else if (typeof result === 'string' && result.startsWith('PARENT_NOT_FOUND:')) {
        fail('PARENT_NOT_FOUND', `Parent section not found: ${result.split(':').slice(1).join(':')}`);
      }
    } else if (mode === 'delete') {
      const deleted = md.deleteSection(doc, section);
      if (!deleted) fail('SECTION_NOT_FOUND', `Section not found: ${section}`);
    }

    const markdown = md.toMarkdown(doc);
    const issues = md.getIssues(doc);
    if (issues.length > 0) {
      fail('NOT_CONFORMANT', `Write rejected — conformance issues: ${issues.join('; ')}`);
    }

    try {
      fs.writeFileSync(absPath, markdown, 'utf-8');
    } catch (e) {
      fail('WRITE_ERROR', `Could not write file: ${absPath} — ${e.message}`);
    }

    indexFile(db, r.name, absPath); // mtime changed — indexFile re-parses and upserts
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// createDocument
// ---------------------------------------------------------------------------

/**
 * Scaffold a brand-new conformant Markdown document — title, optional
 * subtitle/document-type/language preamble, then the two conformance-required
 * sections (`## Quick Start`, `## Load when`) — and write + index it.
 *
 * `write_section` assumes a file that already exists and already conforms to
 * `conventions/documentation.md`; without this tool, the initial creation of
 * a new `.md` still required the filesystem MCP directly (see T-004). Fails
 * with FILE_EXISTS if the target path already exists — use `write_section` to
 * edit an existing document instead.
 *
 * Reuses the same `md-parser.js` accessors as `write_section` (`setTitle`,
 * `setSectionByPath`, `toMarkdown`, `getIssues`) rather than hand-assembling
 * Markdown text, so a scaffolded document is byte-for-byte what a subsequent
 * `write_section` call would also produce (auto-generated TOC and
 * `[[#Quick Start]]` up-links included) — no separate template to drift out
 * of sync with `md-parser.js`.
 *
 * @param {ReturnType<typeof createContext>} ctx
 * @param {{ repo: string, file: string, title: string, quickStart: string, loadWhen: string, subtitle?: string, documentType?: string, language?: string }} args
 * @returns {{ ok: true, file: string }}
 */
export function createDocument(ctx, { repo, file, title, quickStart, loadWhen, subtitle, documentType, language }) {
  if (!title || !title.trim()) fail('MISSING_ARG', 'title is required');
  if (!quickStart || !quickStart.trim()) fail('MISSING_ARG', 'quickStart is required');
  if (!loadWhen || !loadWhen.trim()) fail('MISSING_ARG', 'loadWhen is required');

  const r = findRepo(ctx.repos, repo);
  const absPath = path.isAbsolute(file) ? file : path.resolve(r.root, file);
  if (fs.existsSync(absPath)) fail('FILE_EXISTS', `File already exists: ${absPath}`);

  const db = ctx.getDb(r.name);

  return withLock(r.db, () => {
    const doc = md.parseText('', absPath);
    md.setTitle(doc, title);

    const preambleLines = [];
    if (subtitle) preambleLines.push(subtitle.trim());
    if (documentType) preambleLines.push(`*Document type: ${documentType.trim()}*`);
    if (language) preambleLines.push(`*Language: ${language.trim()}*`);
    if (preambleLines.length > 0) doc.preamble = preambleLines;

    md.setSectionByPath(doc, `${title}/Quick Start`, quickStart);
    md.setSectionByPath(doc, `${title}/Load when`, loadWhen);

    const markdown = md.toMarkdown(doc);
    const issues = md.getIssues(doc);
    if (issues.length > 0) {
      fail('NOT_CONFORMANT', `Document rejected — conformance issues: ${issues.join('; ')}`);
    }

    try {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, markdown, 'utf-8');
    } catch (e) {
      fail('WRITE_ERROR', `Could not write file: ${absPath} — ${e.message}`);
    }

    indexFile(db, r.name, absPath); // new file — indexFile parses and inserts
    return { ok: true, file: absPath };
  });
}

// ---------------------------------------------------------------------------
// reindex
// ---------------------------------------------------------------------------

/**
 * Full directory walk and reindex — one repo, or every configured repo.
 * Catches new/deleted files that lazy reindex misses.
 *
 * @param {ReturnType<typeof createContext>} ctx
 * @param {{ repo?: string }} args
 * @returns {{ repo: string, indexed: boolean }[]}
 */
export function reindex(ctx, { repo } = {}) {
  const targetRepos = repo ? [findRepo(ctx.repos, repo)] : ctx.repos;
  const results = [];
  for (const r of targetRepos) {
    const db = ctx.getDb(r.name);
    indexRepo(db, r.name, r.root, r.exclude);
    results.push({ repo: r.name, indexed: true });
  }
  return results;
}
