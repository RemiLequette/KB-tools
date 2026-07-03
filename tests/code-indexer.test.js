/**
 * code-indexer.test.js
 *
 * Unit tests for lib/code-indexer.js.
 * Tests file-level indexing (read + upsert), repo-level scan, and extension filtering.
 *
 * @convention conventions/mcp-code-index.md [## How — Implementation > File structure]
 * @convention conventions/mcp-code-index.md [## What — Model > Reindexing]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb, getDocumentMtime, searchDocuments, listDocumentPaths } from '../lib/code-index-db.js';
import { indexFile, indexRepo } from '../lib/code-indexer.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES   = path.join(__dirname, 'fixtures', 'mcp-code-index');
const FOO_PATH   = path.join(FIXTURES, 'src', 'foo.js');
const BAR_PATH   = path.join(FIXTURES, 'fragments', 'bar.html');
const EXTENSIONS = ['.js', '.html', '.css'];

// ---------------------------------------------------------------------------
// indexFile
// ---------------------------------------------------------------------------

describe('indexFile', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => db.close());

  it('indexes a file without throwing', () => {
    expect(() => indexFile(db, 'ddscope-code', FOO_PATH)).not.toThrow();
  });

  it('stores mtime matching the file on disk', () => {
    indexFile(db, 'ddscope-code', FOO_PATH);
    const diskMtime = Math.floor(statSync(FOO_PATH).mtimeMs);
    expect(getDocumentMtime(db, 'ddscope-code', FOO_PATH)).toBe(diskMtime);
  });

  it('stores the file extension', () => {
    indexFile(db, 'ddscope-code', FOO_PATH);
    const row = db.prepare('SELECT extension FROM documents WHERE file_path=?').get(FOO_PATH);
    expect(row.extension).toBe('.js');
  });

  it('makes the file content searchable after indexing', () => {
    indexFile(db, 'ddscope-code', FOO_PATH);
    const hits = searchDocuments(db, 'hello');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].file_path).toBe(FOO_PATH);
  });

  // @convention conventions/mcp-code-index.md [## What — Model > Reindexing]
  it('lazy reindex — skips re-parse when file mtime is unchanged', () => {
    indexFile(db, 'ddscope-code', FOO_PATH);
    const mtimeAfterFirst = getDocumentMtime(db, 'ddscope-code', FOO_PATH);

    indexFile(db, 'ddscope-code', FOO_PATH);
    const mtimeAfterSecond = getDocumentMtime(db, 'ddscope-code', FOO_PATH);

    expect(mtimeAfterFirst).toBe(mtimeAfterSecond);
  });

  it('re-indexes when mtime changes — simulated by forcing a stale mtime in db', () => {
    db.prepare('INSERT INTO documents (repo, file_path, extension, mtime) VALUES (?,?,?,?)')
      .run('ddscope-code', FOO_PATH, '.js', 1);

    indexFile(db, 'ddscope-code', FOO_PATH);

    const diskMtime = Math.floor(statSync(FOO_PATH).mtimeMs);
    expect(getDocumentMtime(db, 'ddscope-code', FOO_PATH)).toBe(diskMtime);

    const hits = searchDocuments(db, 'hello');
    expect(hits.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// indexRepo
// ---------------------------------------------------------------------------

describe('indexRepo', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => db.close());

  it('indexes all files matching the given extensions', () => {
    indexRepo(db, 'ddscope-code', FIXTURES, EXTENSIONS);
    const count = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE repo=?').get('ddscope-code').n;
    // fixtures/: foo.js, bar.html, baz.css = 3 files (readme.txt excluded)
    expect(count).toBe(3);
  });

  it('excludes files whose extension is not in the given list', () => {
    indexRepo(db, 'ddscope-code', FIXTURES, EXTENSIONS);
    const row = db.prepare('SELECT * FROM documents WHERE file_path LIKE ?').get('%readme.txt');
    expect(row).toBeUndefined();
  });

  it('makes all indexed files searchable', () => {
    indexRepo(db, 'ddscope-code', FIXTURES, EXTENSIONS);
    const hits = searchDocuments(db, 'baz');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('scopes indexed documents to the provided repo name', () => {
    indexRepo(db, 'other-repo', FIXTURES, EXTENSIONS);
    const count = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE repo='ddscope-code'").get().n;
    expect(count).toBe(0);
  });

  // @convention conventions/mcp-code-index.md [## What — Model > Reindexing]
  it('prunes a document whose file no longer exists on disk', () => {
    const goneePath = path.join(FIXTURES, 'src', 'gone.js');
    db.prepare('INSERT INTO documents (repo, file_path, extension, mtime) VALUES (?,?,?,?)')
      .run('ddscope-code', goneePath, '.js', 1);

    indexRepo(db, 'ddscope-code', FIXTURES, EXTENSIONS);

    expect(listDocumentPaths(db, 'ddscope-code')).not.toContain(goneePath);
  });

  it('leaves documents for files still on disk untouched by pruning', () => {
    indexRepo(db, 'ddscope-code', FIXTURES, EXTENSIONS);
    const before = listDocumentPaths(db, 'ddscope-code').sort();

    indexRepo(db, 'ddscope-code', FIXTURES, EXTENSIONS);
    const after = listDocumentPaths(db, 'ddscope-code').sort();

    expect(after).toEqual(before);
  });

  it('a pruned file no longer appears in search results', () => {
    const goneePath = path.join(FIXTURES, 'src', 'gone.js');
    db.prepare('INSERT INTO documents (repo, file_path, extension, mtime) VALUES (?,?,?,?)')
      .run('ddscope-code', goneePath, '.js', 1);
    db.prepare('INSERT INTO documents_fts (rowid, content, doc_id) VALUES (last_insert_rowid(), ?, last_insert_rowid())')
      .run('zzzneedleuniquemarker');

    indexRepo(db, 'ddscope-code', FIXTURES, EXTENSIONS);

    const hits = searchDocuments(db, 'zzzneedleuniquemarker');
    expect(hits).toHaveLength(0);
  });
});
