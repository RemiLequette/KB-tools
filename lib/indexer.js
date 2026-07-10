/**
 * indexer.js
 *
 * Indexes Markdown files into a SQLite database for the MCP doc index.
 *
 * Two entry points:
 *   - indexFile(db, repo, filePath)          — index a single file (with lazy reindex by mtime)
 *   - indexRepo(db, repo, rootDir, exclude)  — scan and index all .md files under a directory
 *
 * @convention conventions/mcp-doc-index.md [## What — Model > Reindexing]
 * @convention conventions/mcp-doc-index.md [## How — Implementation > File structure]
 * @convention conventions/mcp-doc-index.md [## What — Model > Scope > Exclude patterns]
 */

import { statSync } from 'fs';
import * as md      from './md-parser.js';
import * as fsScan  from './fs-scan.js';
import { getDocumentMtime, upsertDocument, deleteDocument, listDocumentPaths } from './index-db.js';

// ---------------------------------------------------------------------------
// indexFile
// ---------------------------------------------------------------------------

/**
 * Index a single Markdown file into the database.
 *
 * Lazy reindex: if the file's mtime on disk matches the stored mtime, the file
 * is skipped — no re-parse, no db write.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo     - Repository name (e.g. 'kb').
 * @param {string} filePath - Absolute path to the .md file.
 */
export function indexFile(db, repo, filePath) {
  const diskMtime   = Math.floor(statSync(filePath).mtimeMs);
  const storedMtime = getDocumentMtime(db, repo, filePath);

  if (storedMtime === diskMtime) return; // lazy reindex: no change

  const doc      = md.parseFile(filePath);
  const title    = md.getTitle(doc);
  const loadWhen = md.getSection(doc, 'Load when');
  const sections = md.getSections(doc).map(({ path, content }) => ({ path, content }));

  upsertDocument(db, repo, filePath, title, loadWhen, diskMtime, sections);
}

// ---------------------------------------------------------------------------
// indexRepo
// ---------------------------------------------------------------------------

/**
 * Scan a directory tree and index every .md file found.
 * Catches new files, and prunes documents whose file was deleted from disk
 * since the last indexRepo pass — both cases lazy reindex misses.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo    - Repository name.
 * @param {string} rootDir - Absolute path to the repository root.
 * @param {string[]} [exclude] - Glob patterns for files/directories to skip — see
 *   conventions/mcp-doc-index.md [## What — Model > Scope > Exclude patterns].
 */
export function indexRepo(db, repo, rootDir, exclude) {
  const files = fsScan.scanMarkdownFiles(rootDir, exclude);
  const foundSet = new Set(files);

  for (const filePath of files) {
    indexFile(db, repo, filePath);
  }

  // Prune documents whose file no longer exists on disk — lazy reindex
  // (indexFile/refreshRepo) never removes rows, so a full indexRepo pass
  // is the only place stale entries get purged.
  for (const knownPath of listDocumentPaths(db, repo)) {
    if (!foundSet.has(knownPath)) {
      deleteDocument(db, repo, knownPath);
    }
  }
}

// ---------------------------------------------------------------------------
// refreshRepo
// ---------------------------------------------------------------------------

/**
 * Lazy reindex sweep over documents already known to the index for a repo —
 * re-parses any file whose disk mtime has changed since it was last indexed.
 *
 * Does NOT discover new or deleted files (that requires indexRepo / the
 * `reindex` MCP tool, which walks the directory tree). This is the cheap
 * per-call refresh used by `search` and `list_triggers` before answering.
 *
 * A file that has been deleted from disk since it was indexed is skipped
 * silently — it is left stale in the index until an explicit `reindex`.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo - Repository name.
 */
export function refreshRepo(db, repo) {
  const rows = db.prepare('SELECT file_path FROM documents WHERE repo=?').all(repo);
  for (const { file_path } of rows) {
    try {
      indexFile(db, repo, file_path);
    } catch (e) {
      // File likely deleted from disk since last index — leave as-is,
      // caught up by the next explicit `reindex`.
    }
  }
}
