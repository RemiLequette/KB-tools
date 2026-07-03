/**
 * code-index-db.test.js
 *
 * Unit tests for lib/code-index-db.js.
 * Tests the SQLite schema, upsert logic, mtime lookup, and FTS5 whole-file search.
 *
 * @convention conventions/mcp-code-index.md [## How — Implementation > SQLite schema]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, upsertDocument, getDocumentMtime, searchDocuments, deleteDocument, listDocumentPaths } from '../lib/code-index-db.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const FOO = {
  repo:      'ddscope-code',
  filePath:  'src/foo.js',
  extension: '.js',
  mtime:     1700000000,
  content:   'Foo.bar = function () {\n  return "hello world";\n};\n',
};

const BAR = {
  repo:      'ddscope-code',
  filePath:  'fragments/bar.html',
  extension: '.html',
  mtime:     1700000001,
  content:   '<div class="bar">fragment content</div>\n',
};

// ---------------------------------------------------------------------------
// openDb
// ---------------------------------------------------------------------------

describe('openDb', () => {
  it('creates the documents table', () => {
    const db = openDb(':memory:');
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
    expect(tables).toContain('documents');
    db.close();
  });

  it('creates documents_fts virtual table', () => {
    const db = openDb(':memory:');
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='documents_fts'`).get();
    expect(row).toBeDefined();
    db.close();
  });

  it('is idempotent — CREATE IF NOT EXISTS does not throw on second call', () => {
    const db = openDb(':memory:');
    expect(() => openDb(':memory:')).not.toThrow();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// upsertDocument
// ---------------------------------------------------------------------------

describe('upsertDocument', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => db.close());

  it('inserts a document row with correct metadata', () => {
    upsertDocument(db, FOO.repo, FOO.filePath, FOO.extension, FOO.mtime, FOO.content);
    const row = db.prepare('SELECT * FROM documents WHERE repo=? AND file_path=?')
                  .get(FOO.repo, FOO.filePath);
    expect(row).toBeDefined();
    expect(row.extension).toBe('.js');
    expect(row.mtime).toBe(1700000000);
  });

  it('is idempotent — calling twice leaves exactly one document row', () => {
    upsertDocument(db, FOO.repo, FOO.filePath, FOO.extension, FOO.mtime, FOO.content);
    upsertDocument(db, FOO.repo, FOO.filePath, FOO.extension, FOO.mtime, FOO.content);
    const count = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE file_path=?')
                    .get(FOO.filePath).n;
    expect(count).toBe(1);
  });

  it('replaces content on second upsert', () => {
    upsertDocument(db, FOO.repo, FOO.filePath, FOO.extension, FOO.mtime, FOO.content);
    upsertDocument(db, FOO.repo, FOO.filePath, FOO.extension, FOO.mtime + 1, 'Foo.bar = function () { return "updated xyz123"; };');
    const hits = searchDocuments(db, 'xyz123');
    expect(hits.length).toBe(1);
  });

  it('does not mix content across two different documents', () => {
    upsertDocument(db, FOO.repo, FOO.filePath, FOO.extension, FOO.mtime, FOO.content);
    upsertDocument(db, BAR.repo, BAR.filePath, BAR.extension, BAR.mtime, BAR.content);
    const hits = searchDocuments(db, 'fragment');
    expect(hits.every(h => h.file_path === BAR.filePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deleteDocument
// ---------------------------------------------------------------------------

describe('deleteDocument', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => db.close());

  it('removes the document row', () => {
    upsertDocument(db, FOO.repo, FOO.filePath, FOO.extension, FOO.mtime, FOO.content);
    deleteDocument(db, FOO.repo, FOO.filePath);
    const row = db.prepare('SELECT * FROM documents WHERE repo=? AND file_path=?')
                  .get(FOO.repo, FOO.filePath);
    expect(row).toBeUndefined();
  });

  it('removes the document from search results', () => {
    upsertDocument(db, FOO.repo, FOO.filePath, FOO.extension, FOO.mtime, FOO.content);
    deleteDocument(db, FOO.repo, FOO.filePath);
    const hits = searchDocuments(db, 'hello');
    expect(hits).toHaveLength(0);
  });

  it('does not affect other documents', () => {
    upsertDocument(db, FOO.repo, FOO.filePath, FOO.extension, FOO.mtime, FOO.content);
    upsertDocument(db, BAR.repo, BAR.filePath, BAR.extension, BAR.mtime, BAR.content);
    deleteDocument(db, FOO.repo, FOO.filePath);
    const hits = searchDocuments(db, 'fragment');
    expect(hits).toHaveLength(1);
  });

  it('is a no-op when the document does not exist', () => {
    expect(() => deleteDocument(db, 'ddscope-code', 'unknown.js')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// listDocumentPaths
// ---------------------------------------------------------------------------

describe('listDocumentPaths', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => db.close());

  it('returns an empty array when no documents are indexed', () => {
    expect(listDocumentPaths(db, 'ddscope-code')).toEqual([]);
  });

  it('returns the file_path of every indexed document for the repo', () => {
    upsertDocument(db, FOO.repo, FOO.filePath, FOO.extension, FOO.mtime, FOO.content);
    upsertDocument(db, BAR.repo, BAR.filePath, BAR.extension, BAR.mtime, BAR.content);
    expect(listDocumentPaths(db, 'ddscope-code').sort()).toEqual([BAR.filePath, FOO.filePath].sort());
  });

  it('is scoped by repo', () => {
    upsertDocument(db, 'ddscope-code', FOO.filePath, FOO.extension, FOO.mtime, FOO.content);
    expect(listDocumentPaths(db, 'other-repo')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getDocumentMtime
// ---------------------------------------------------------------------------

describe('getDocumentMtime', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => db.close());

  it('returns null for an unknown file', () => {
    expect(getDocumentMtime(db, 'ddscope-code', 'unknown.js')).toBeNull();
  });

  it('returns the stored mtime for a known file', () => {
    upsertDocument(db, 'ddscope-code', 'src/foo.js', '.js', 9999, 'content');
    expect(getDocumentMtime(db, 'ddscope-code', 'src/foo.js')).toBe(9999);
  });

  it('is scoped by repo — same path in a different repo returns null', () => {
    upsertDocument(db, 'ddscope-code', 'src/foo.js', '.js', 9999, 'content');
    expect(getDocumentMtime(db, 'other-repo', 'src/foo.js')).toBeNull();
  });

  it('reflects the updated mtime after a second upsert', () => {
    upsertDocument(db, 'ddscope-code', 'src/foo.js', '.js', 1000, 'content');
    upsertDocument(db, 'ddscope-code', 'src/foo.js', '.js', 2000, 'content');
    expect(getDocumentMtime(db, 'ddscope-code', 'src/foo.js')).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// searchDocuments
// ---------------------------------------------------------------------------

describe('searchDocuments', () => {
  let db;
  beforeEach(() => {
    db = openDb(':memory:');
    upsertDocument(db, 'ddscope-code', FOO.filePath, FOO.extension, FOO.mtime, FOO.content);
    upsertDocument(db, 'ddscope-code', BAR.filePath, BAR.extension, BAR.mtime, BAR.content);
  });
  afterEach(() => db.close());

  it('finds documents matching a single-word query', () => {
    const hits = searchDocuments(db, 'hello');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('returns file_path for each hit', () => {
    const hits = searchDocuments(db, 'hello');
    expect(hits[0].file_path).toBe(FOO.filePath);
  });

  it('returns a snippet containing the matched term', () => {
    const hits = searchDocuments(db, 'hello');
    expect(hits[0].snippet).toContain('hello');
  });

  it('filters by repo when specified', () => {
    const hits = searchDocuments(db, 'hello', 'ddscope-code');
    expect(hits.every(h => h.repo === 'ddscope-code')).toBe(true);
  });

  it('returns empty array when no document matches the query', () => {
    const hits = searchDocuments(db, 'xyznonexistent99');
    expect(hits).toHaveLength(0);
  });

  it('returns empty array when repo filter excludes all matches', () => {
    const hits = searchDocuments(db, 'hello', 'other-repo');
    expect(hits).toHaveLength(0);
  });
});
