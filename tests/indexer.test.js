/**
 * indexer.test.js
 *
 * Unit tests for lib/indexer.js.
 * Tests file-level indexing (parse + upsert) and repo-level scan.
 *
 * @convention conventions/mcp-doc-index.md [## How — Implementation > File structure]
 * @convention conventions/mcp-doc-index.md [## What — Model > Reindexing]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb, getDocumentMtime, searchSections } from '../lib/index-db.js';
import { indexFile, indexRepo } from '../lib/indexer.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES   = path.join(__dirname, 'fixtures', 'mcp-doc-index');
const ALPHA_PATH = path.join(FIXTURES, 'conventions', 'alpha.md');
const BETA_PATH  = path.join(FIXTURES, 'guides', 'beta.md');
const NC_PATH    = path.join(FIXTURES, 'non-conformant.md');

// ---------------------------------------------------------------------------
// indexFile
// ---------------------------------------------------------------------------

describe('indexFile', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => db.close());

  it('indexes a conformant .md file without throwing', () => {
    expect(() => indexFile(db, 'kb', ALPHA_PATH)).not.toThrow();
  });

  it('stores mtime matching the file on disk', () => {
    indexFile(db, 'kb', ALPHA_PATH);
    const diskMtime = Math.floor(statSync(ALPHA_PATH).mtimeMs);
    expect(getDocumentMtime(db, 'kb', ALPHA_PATH)).toBe(diskMtime);
  });

  it('makes the file content searchable after indexing', () => {
    indexFile(db, 'kb', ALPHA_PATH);
    const hits = searchSections(db, 'foundation');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].file_path).toBe(ALPHA_PATH);
  });

  it('stores load_when from ## Load when section', () => {
    indexFile(db, 'kb', BETA_PATH);
    const row = db.prepare('SELECT load_when FROM documents WHERE file_path=?').get(BETA_PATH);
    expect(row).toBeDefined();
    expect(row.load_when).not.toBeNull();
    expect(row.load_when).toContain('beta');
  });

  it('load_when is null for a file without ## Load when section', () => {
    indexFile(db, 'kb', ALPHA_PATH);
    const row = db.prepare('SELECT load_when FROM documents WHERE file_path=?').get(ALPHA_PATH);
    expect(row.load_when).toBeNull();
  });

  it('indexes a non-conformant file without throwing', () => {
    expect(() => indexFile(db, 'kb', NC_PATH)).not.toThrow();
  });

  // @convention conventions/mcp-doc-index.md [## What — Model > Reindexing]
  it('lazy reindex — skips re-parse when file mtime is unchanged', () => {
    indexFile(db, 'kb', ALPHA_PATH);
    const mtimeAfterFirst = getDocumentMtime(db, 'kb', ALPHA_PATH);

    // Second call on same file — mtime on disk has not changed
    indexFile(db, 'kb', ALPHA_PATH);
    const mtimeAfterSecond = getDocumentMtime(db, 'kb', ALPHA_PATH);

    expect(mtimeAfterFirst).toBe(mtimeAfterSecond);
  });

  it('re-indexes when mtime changes — simulated by forcing a stale mtime in db', () => {
    // Seed db with a fake old mtime so indexFile sees it as stale
    db.prepare('INSERT INTO documents (repo, file_path, title, load_when, mtime) VALUES (?,?,?,?,?)')
      .run('kb', ALPHA_PATH, 'Old Title', null, 1);

    indexFile(db, 'kb', ALPHA_PATH);

    const diskMtime = Math.floor(statSync(ALPHA_PATH).mtimeMs);
    expect(getDocumentMtime(db, 'kb', ALPHA_PATH)).toBe(diskMtime);

    // Content should now be searchable (was not before re-index)
    const hits = searchSections(db, 'foundation');
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

  it('indexes all .md files in the repo directory tree', () => {
    indexRepo(db, 'kb', FIXTURES);
    const count = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE repo=?').get('kb').n;
    // fixtures/: alpha.md, beta.md, non-conformant.md, generated/output.md = 4 files
    expect(count).toBe(4);
  });

  it('makes all indexed files searchable', () => {
    indexRepo(db, 'kb', FIXTURES);
    // 'workflow' appears in beta.md Keywords section
    const hits = searchSections(db, 'workflow');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('scopes indexed documents to the provided repo name', () => {
    indexRepo(db, 'my-project', FIXTURES);
    const count = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE repo='kb'").get().n;
    expect(count).toBe(0);
  });

  // @convention conventions/mcp-doc-index.md [## What — Model > Exclude patterns]
  it('exclude — skips .md files matching a glob pattern', () => {
    indexRepo(db, 'kb', FIXTURES, ['**/generated/**']);
    const row = db.prepare('SELECT * FROM documents WHERE file_path LIKE ?').get('%output.md');
    expect(row).toBeUndefined();
  });

  it('exclude — leaves non-matching files indexed', () => {
    indexRepo(db, 'kb', FIXTURES, ['**/generated/**']);
    const count = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE repo=?').get('kb').n;
    expect(count).toBe(3);
  });

  it('exclude — omitted argument indexes everything (backward compatible)', () => {
    indexRepo(db, 'kb', FIXTURES);
    const count = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE repo=?').get('kb').n;
    expect(count).toBe(4);
  });
});
