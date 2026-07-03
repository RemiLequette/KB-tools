/**
 * code-indexer.js
 *
 * Indexes source code files into a SQLite database for the MCP code index.
 *
 * Two entry points:
 *   - indexFile(db, repo, filePath)            — index a single file (with lazy reindex by mtime)
 *   - indexRepo(db, repo, rootDir, extensions)  — scan and index all matching files under a directory
 *
 * fs-scan is loaded as .cjs — the .cjs extension bypasses "type":"module" so
 * createRequire can load it as CommonJS regardless of package.json type.
 *
 * @convention conventions/mcp-code-index.md [## What — Model > Reindexing]
 * @convention conventions/mcp-code-index.md [## How — Implementation > File structure]
 */

import { statSync, readFileSync } from 'fs';
import { extname }       from 'path';
import { createRequire } from 'module';
import { getDocumentMtime, upsertDocument, deleteDocument, listDocumentPaths } from './code-index-db.js';

// CJS interop — .cjs extension bypasses "type":"module" so createRequire can load it
const require = createRequire(import.meta.url);
const fsScan  = require('./fs-scan.cjs');

// ---------------------------------------------------------------------------
// indexFile
// ---------------------------------------------------------------------------

/**
 * Index a single code file into the database.
 *
 * Lazy reindex: if the file's mtime on disk matches the stored mtime, the file
 * is skipped — no re-read, no db write.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo     - Repository name (e.g. 'ddscope-code').
 * @param {string} filePath - Absolute path to the code file.
 */
export function indexFile(db, repo, filePath) {
  const diskMtime   = Math.floor(statSync(filePath).mtimeMs);
  const storedMtime = getDocumentMtime(db, repo, filePath);

  if (storedMtime === diskMtime) return; // lazy reindex: no change

  const content = readFileSync(filePath, 'utf-8');
  upsertDocument(db, repo, filePath, extname(filePath), diskMtime, content);
}

// ---------------------------------------------------------------------------
// indexRepo
// ---------------------------------------------------------------------------

/**
 * Scan a directory tree and index every file matching the given extensions.
 * Catches new files, and prunes documents whose file was deleted from disk
 * since the last indexRepo pass — both cases lazy reindex misses.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string}   repo       - Repository name.
 * @param {string}   rootDir    - Absolute path to the repository root.
 * @param {string[]} extensions - File extensions to index, e.g. ['.js', '.html', '.css'].
 */
export function indexRepo(db, repo, rootDir, extensions) {
  const files = fsScan.scanFiles(rootDir, extensions);
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
 * re-reads any file whose disk mtime has changed since it was last indexed.
 *
 * Does NOT discover new or deleted files (that requires indexRepo / the
 * `reindex` MCP tool, which walks the directory tree). This is the cheap
 * per-call refresh used by `search` before answering.
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
