/**
 * code-index-db.js
 *
 * SQLite database access for the MCP code index — schema creation, document
 * upsert, mtime lookup, and FTS5 whole-file full-text search.
 *
 * One database per indexed repo. Callers open a db handle with openDb() and
 * pass it to all other functions. The caller is responsible for closing the
 * handle.
 *
 * @convention conventions/mcp-code-index.md [## How — Implementation > SQLite schema]
 */

import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS documents (
    id        INTEGER PRIMARY KEY,
    repo      TEXT    NOT NULL,
    file_path TEXT    NOT NULL,
    extension TEXT    NOT NULL,
    mtime     INTEGER NOT NULL,
    UNIQUE(repo, file_path)
  );

  -- Non-content FTS5 table over whole-file content (no section grammar in Lot 1).
  -- rowid is set to documents.id to enable efficient joins.
  -- doc_id is stored UNINDEXED for repo-scoped search filtering.
  CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    content, doc_id UNINDEXED
  );
`;

// ---------------------------------------------------------------------------
// openDb
// ---------------------------------------------------------------------------

/**
 * Open (or create) a SQLite database at the given path and apply the schema.
 * Pass ':memory:' for an in-memory database (useful in tests).
 *
 * @param {string} dbPath - Absolute path to the .db file, or ':memory:'.
 * @returns {import('better-sqlite3').Database}
 */
export function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------
// upsertDocument
// ---------------------------------------------------------------------------

/**
 * Insert or replace a document's content in the database.
 * If the document already exists (same repo + file_path), it is deleted first
 * so its FTS entry is fully replaced.
 *
 * Runs inside a single transaction.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo      - Repository name (e.g. 'ddscope-code').
 * @param {string} filePath  - Absolute or relative file path used as the document key.
 * @param {string} extension - File extension, including the leading dot (e.g. '.js').
 * @param {number} mtime     - File mtime in milliseconds (integer).
 * @param {string} content   - Whole-file text content.
 */
export function upsertDocument(db, repo, filePath, extension, mtime, content) {
  db.transaction(() => {
    const existing = db.prepare('SELECT id FROM documents WHERE repo=? AND file_path=?')
                       .get(repo, filePath);

    if (existing) {
      db.prepare('DELETE FROM documents_fts WHERE rowid=?').run(existing.id);
      db.prepare('DELETE FROM documents WHERE id=?').run(existing.id);
    }

    const { lastInsertRowid: docId } = db
      .prepare('INSERT INTO documents (repo, file_path, extension, mtime) VALUES (?,?,?,?)')
      .run(repo, filePath, extension, mtime);

    db.prepare('INSERT INTO documents_fts (rowid, content, doc_id) VALUES (?,?,?)')
      .run(docId, content, docId);
  })();
}

// ---------------------------------------------------------------------------
// deleteDocument
// ---------------------------------------------------------------------------

/**
 * Delete a document and its FTS entry from the database.
 * No-op if the document does not exist.
 *
 * Runs inside a single transaction.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo
 * @param {string} filePath
 */
export function deleteDocument(db, repo, filePath) {
  db.transaction(() => {
    const existing = db.prepare('SELECT id FROM documents WHERE repo=? AND file_path=?')
                       .get(repo, filePath);
    if (!existing) return;

    db.prepare('DELETE FROM documents_fts WHERE rowid=?').run(existing.id);
    db.prepare('DELETE FROM documents WHERE id=?').run(existing.id);
  })();
}

// ---------------------------------------------------------------------------
// listDocumentPaths
// ---------------------------------------------------------------------------

/**
 * Return the file_path of every document currently indexed for a repo.
 * Used by indexRepo to prune entries for files deleted from disk.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo
 * @returns {string[]}
 */
export function listDocumentPaths(db, repo) {
  return db.prepare('SELECT file_path FROM documents WHERE repo=?')
           .all(repo)
           .map(r => r.file_path);
}

// ---------------------------------------------------------------------------
// getDocumentMtime
// ---------------------------------------------------------------------------

/**
 * Return the stored mtime for a known document, or null if not indexed.
 * Used by the indexer to decide whether a lazy reindex is needed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo
 * @param {string} filePath
 * @returns {number|null}
 */
export function getDocumentMtime(db, repo, filePath) {
  const row = db.prepare('SELECT mtime FROM documents WHERE repo=? AND file_path=?')
                .get(repo, filePath);
  return row ? row.mtime : null;
}

// ---------------------------------------------------------------------------
// sanitizeFtsQuery
// ---------------------------------------------------------------------------

/**
 * Sanitize a raw user query for safe use as an FTS5 MATCH argument.
 *
 * FTS5's query syntax gives special meaning to characters that are common
 * and legitimate in source-code identifiers — notably '-' (unary NOT /
 * column-filter parsing), ':' (column filter), '*' (prefix), '"' (phrase).
 * An unescaped query like `dds-btn-elements` is misparsed by FTS5's query
 * grammar (not just its content tokenizer) and throws or silently changes
 * meaning.
 *
 * Fix: wrap each whitespace-separated token in double quotes, turning every
 * token into an FTS5 phrase. The content-side tokenizer (unicode61) splits
 * hyphenated identifiers the same way at index time, so a quoted token still
 * matches hyphenated occurrences — while space-separated tokens keep the
 * existing implicit-AND, multi-term search behaviour.
 *
 * @param {string} query - Raw user-supplied query string.
 * @returns {string} FTS5-safe query string.
 */
export function sanitizeFtsQuery(query) {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(token => `"${token.replace(/"/g, '""')}"`)
    .join(' ');
}

// ---------------------------------------------------------------------------
// searchDocuments
// ---------------------------------------------------------------------------

/**
 * Full-text search across indexed file content using FTS5.
 * Returns one hit per matching document, ranked by relevance (bm25 descending).
 *
 * The query is sanitized via sanitizeFtsQuery() before reaching FTS5, so
 * characters with special meaning in FTS5 query syntax (notably '-', ':',
 * '*', '"') are treated as literal query content instead of query-grammar
 * operators — e.g. 'dds-btn-elements' searches for that literal identifier
 * rather than being misparsed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string}      query  - Raw query string (e.g. 'DDS_CMD dispatch', 'dds-btn-elements').
 * @param {string|null} [repo] - Optional repo filter.
 * @returns {{ repo: string, file_path: string, snippet: string }[]}
 */
export function searchDocuments(db, query, repo) {
  let sql = `
    SELECT d.repo,
           d.file_path,
           snippet(documents_fts, 0, '<mark>', '</mark>', '…', 64) AS snippet
    FROM   documents_fts
    JOIN   documents d ON d.id = documents_fts.rowid
    WHERE  documents_fts MATCH ?
  `;
  const params = [sanitizeFtsQuery(query)];

  if (repo) {
    sql += ' AND d.repo = ?';
    params.push(repo);
  }

  sql += ' ORDER BY rank';

  return db.prepare(sql).all(...params);
}
