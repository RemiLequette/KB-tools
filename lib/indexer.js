/**
 * indexer.js
 *
 * Indexes Markdown files into a SQLite database for the MCP doc index.
 *
 * Two entry points:
 *   - indexFile(db, repo, filePath) — index a single file (with lazy reindex by mtime)
 *   - indexRepo(db, repo, rootDir)  — scan and index all .md files under a directory
 *
 * md-parser.js and fs-scan.js are CommonJS modules (legacy); loaded via createRequire.
 *
 * @convention conventions/mcp-doc-index.md [## What — Model > Reindexing]
 * @convention conventions/mcp-doc-index.md [## How — Implementation > File structure]
 */

import { statSync }     from 'fs';
import { createRequire } from 'module';
import { getDocumentMtime, upsertDocument } from './index-db.js';

// CJS interop — md-parser and fs-scan predate the ESM migration
const require  = createRequire(import.meta.url);
const md       = require('./md-parser.js');
const fsScan   = require('./fs-scan.js');

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
  const diskMtime    = Math.floor(statSync(filePath).mtimeMs);
  const storedMtime  = getDocumentMtime(db, repo, filePath);

  if (storedMtime === diskMtime) return; // lazy reindex: no change

  const doc      = md.parseFile(filePath);
  const title    = md.getTitle(doc);
  const loadWhen = md.getSection(doc, 'Load when');
  const sections = md.getSections(doc).map(({ name, content }) => ({ name, content }));

  upsertDocument(db, repo, filePath, title, loadWhen, diskMtime, sections);
}

// ---------------------------------------------------------------------------
// indexRepo
// ---------------------------------------------------------------------------

/**
 * Scan a directory tree and index every .md file found.
 * Catches new and deleted files that lazy reindex misses.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo    - Repository name.
 * @param {string} rootDir - Absolute path to the repository root.
 */
export function indexRepo(db, repo, rootDir) {
  const files = fsScan.scanMarkdownFiles(rootDir);
  for (const filePath of files) {
    indexFile(db, repo, filePath);
  }
}
