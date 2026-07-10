/**
 * index-db.js
 *
 * SQLite database access for the MCP doc index — schema creation, document upsert,
 * mtime lookup, and FTS5 full-text search.
 *
 * One database per indexed repo. Callers open a db handle with openDb() and pass it
 * to all other functions. The caller is responsible for closing the handle.
 *
 * @convention conventions/mcp-doc-index.md [## How — Implementation > SQLite schema]
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
    title     TEXT,
    load_when TEXT,
    mtime     INTEGER NOT NULL,
    UNIQUE(repo, file_path)
  );

  CREATE TABLE IF NOT EXISTS sections (
    id      INTEGER PRIMARY KEY,
    doc_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    path    TEXT    NOT NULL,
    content TEXT    NOT NULL
  );

  -- Non-content FTS5 table. rowid is set to sections.id to enable efficient joins.
  -- doc_id is stored UNINDEXED for repo-scoped search filtering. path is the full
  -- H1/H2 or H1/H2/H3 identifier — see conventions/mcp-doc-index.md [section Section granularity].
  CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
    path, content, doc_id UNINDEXED
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
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------
// upsertDocument
// ---------------------------------------------------------------------------

/**
 * Insert or replace a document and its sections in the database.
 * If the document already exists (same repo + file_path), it is deleted first
 * so that sections and FTS entries are fully replaced.
 *
 * Runs inside a single transaction.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string}   repo      - Repository name (e.g. 'kb').
 * @param {string}   filePath  - Absolute or relative file path used as the document key.
 * @param {string}   title     - Document title (from md-parser getTitle).
 * @param {string|null} loadWhen - Content of ## Load when section, or null.
 * @param {number}   mtime     - File mtime in milliseconds (integer).
 * @param {{ path: string, content: string }[]} sections - Parsed sections, full H1/H2[/H3] path each.
 */
export function upsertDocument(db, repo, filePath, title, loadWhen, mtime, sections) {
  db.transaction(() => {
    // If the document already exists, remove its FTS entries before cascading delete.
    const existing = db.prepare('SELECT id FROM documents WHERE repo=? AND file_path=?')
                       .get(repo, filePath);

    if (existing) {
      const oldSectionIds = db.prepare('SELECT id FROM sections WHERE doc_id=?')
                              .all(existing.id)
                              .map(r => r.id);

      for (const sid of oldSectionIds) {
        db.prepare('DELETE FROM sections_fts WHERE rowid=?').run(sid);
      }

      // Cascade-deletes sections
      db.prepare('DELETE FROM documents WHERE id=?').run(existing.id);
    }

    // Insert the document
    const { lastInsertRowid: docId } = db
      .prepare('INSERT INTO documents (repo, file_path, title, load_when, mtime) VALUES (?,?,?,?,?)')
      .run(repo, filePath, title, loadWhen ?? null, mtime);

    // Insert sections and their FTS entries
    const insertSection = db.prepare(
      'INSERT INTO sections (doc_id, path, content) VALUES (?,?,?)'
    );
    const insertFts = db.prepare(
      'INSERT INTO sections_fts (rowid, path, content, doc_id) VALUES (?,?,?,?)'
    );

    for (const { path, content } of sections) {
      const { lastInsertRowid: secId } = insertSection.run(docId, path, content);
      insertFts.run(secId, path, content, docId);
    }
  })();
}

// ---------------------------------------------------------------------------
// deleteDocument
// ---------------------------------------------------------------------------

/**
 * Delete a document, its sections, and their FTS entries from the database.
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

    const sectionIds = db.prepare('SELECT id FROM sections WHERE doc_id=?')
                         .all(existing.id)
                         .map(r => r.id);

    for (const sid of sectionIds) {
      db.prepare('DELETE FROM sections_fts WHERE rowid=?').run(sid);
    }

    // Cascade-deletes sections
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
// listTriggers
// ---------------------------------------------------------------------------

/**
 * Return the load_when -> file table for a repo, i.e. every document that
 * declares a `## Load when` section. Used by the `list_triggers` MCP tool.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo
 * @returns {{ file_path: string, title: string|null, load_when: string }[]}
 */
export function listTriggers(db, repo) {
  return db.prepare(`
    SELECT file_path, title, load_when
    FROM   documents
    WHERE  repo = ? AND load_when IS NOT NULL
    ORDER BY file_path
  `).all(repo);
}

// ---------------------------------------------------------------------------
// searchSections
// ---------------------------------------------------------------------------

/**
 * Full-text search across indexed sections using FTS5.
 * Returns one hit per matching section, ranked by relevance (bm25 descending).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string}      query  - FTS5 query string (e.g. 'alpha convention').
 * @param {string|null} [repo] - Optional repo filter.
 * @returns {{ repo: string, file_path: string, section: string, snippet: string }[]}
 */
export function searchSections(db, query, repo) {
  let sql = `
    SELECT d.repo,
           d.file_path,
           s.path    AS section,
           snippet(sections_fts, 1, '<mark>', '</mark>', '…', 64) AS snippet
    FROM   sections_fts
    JOIN   sections  s ON s.id  = sections_fts.rowid
    JOIN   documents d ON d.id  = s.doc_id
    WHERE  sections_fts MATCH ?
  `;
  const params = [query];

  if (repo) {
    sql += ' AND d.repo = ?';
    params.push(repo);
  }

  sql += ' ORDER BY rank';

  return db.prepare(sql).all(...params);
}

// ---------------------------------------------------------------------------
// searchDocumentMeta
// ---------------------------------------------------------------------------

/**
 * Match a query against document title and load_when (trigger phrases).
 * A title/load_when hit is a stronger relevance signal than a section-body
 * hit — callers surface this result group above searchSections() results.
 * Plain case-insensitive substring match (title/load_when are short, no FTS needed).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string}      query
 * @param {string|null} [repo]
 * @returns {{ repo: string, file_path: string, title: string|null, load_when: string|null }[]}
 */
export function searchDocumentMeta(db, query, repo) {
  let sql = `
    SELECT repo, file_path, title, load_when
    FROM   documents
    WHERE  (title LIKE @needle OR load_when LIKE @needle)
  `;
  const params = { needle: `%${query}%` };

  if (repo) {
    sql += ' AND repo = @repo';
    params.repo = repo;
  }

  sql += ' ORDER BY file_path';

  return db.prepare(sql).all(params);
}
