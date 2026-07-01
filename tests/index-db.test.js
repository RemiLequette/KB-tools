/**
 * index-db.test.js
 *
 * Unit tests for lib/index-db.js.
 * Tests the SQLite schema, upsert logic, mtime lookup, and FTS5 search.
 *
 * @convention conventions/mcp-doc-index.md [## How — Implementation > SQLite schema]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, upsertDocument, getDocumentMtime, searchSections } from '../lib/index-db.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ALPHA = {
  repo:      'kb',
  filePath:  'conventions/alpha.md',
  title:     'Alpha Convention',
  loadWhen:  null,
  mtime:     1700000000,
  sections:  [
    { name: 'Quick Start', content: 'Load when working with alpha things.' },
    { name: 'Why',         content: 'Alpha is the first letter of the Greek alphabet.' },
    { name: 'What',        content: 'Alpha establishes the foundation of all things.' },
    { name: 'Keywords',    content: 'alpha, convention' },
  ],
};

const BETA = {
  repo:      'kb',
  filePath:  'guides/beta.md',
  title:     'Beta Guide',
  loadWhen:  'Following the beta process\nSetting up beta workflows',
  mtime:     1700000001,
  sections:  [
    { name: 'Steps', content: 'Beta follows alpha in the Greek alphabet.' },
  ],
};

// ---------------------------------------------------------------------------
// openDb
// ---------------------------------------------------------------------------

describe('openDb', () => {
  it('creates documents and sections tables', () => {
    const db = openDb(':memory:');
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
    expect(tables).toContain('documents');
    expect(tables).toContain('sections');
    db.close();
  });

  it('creates sections_fts virtual table', () => {
    const db = openDb(':memory:');
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sections_fts'`).get();
    expect(row).toBeDefined();
    db.close();
  });

  it('is idempotent — CREATE IF NOT EXISTS does not throw on second call', () => {
    const db = openDb(':memory:');
    // Calling exec schema again should not throw
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
    upsertDocument(db, ALPHA.repo, ALPHA.filePath, ALPHA.title, ALPHA.loadWhen, ALPHA.mtime, ALPHA.sections);
    const row = db.prepare('SELECT * FROM documents WHERE repo=? AND file_path=?')
                  .get(ALPHA.repo, ALPHA.filePath);
    expect(row).toBeDefined();
    expect(row.title).toBe('Alpha Convention');
    expect(row.mtime).toBe(1700000000);
    expect(row.load_when).toBeNull();
  });

  it('inserts all sections for the document', () => {
    upsertDocument(db, ALPHA.repo, ALPHA.filePath, ALPHA.title, ALPHA.loadWhen, ALPHA.mtime, ALPHA.sections);
    const docRow = db.prepare('SELECT id FROM documents WHERE file_path=?').get(ALPHA.filePath);
    const sections = db.prepare('SELECT name FROM sections WHERE doc_id=?').all(docRow.id);
    const names = sections.map(s => s.name);
    expect(names).toContain('Why');
    expect(names).toContain('What');
    expect(sections.length).toBe(ALPHA.sections.length);
  });

  it('stores load_when when provided', () => {
    upsertDocument(db, BETA.repo, BETA.filePath, BETA.title, BETA.loadWhen, BETA.mtime, BETA.sections);
    const row = db.prepare('SELECT load_when FROM documents WHERE file_path=?').get(BETA.filePath);
    expect(row.load_when).toBe(BETA.loadWhen);
  });

  it('is idempotent — calling twice leaves exactly one document row', () => {
    upsertDocument(db, ALPHA.repo, ALPHA.filePath, ALPHA.title, ALPHA.loadWhen, ALPHA.mtime, ALPHA.sections);
    upsertDocument(db, ALPHA.repo, ALPHA.filePath, ALPHA.title, ALPHA.loadWhen, ALPHA.mtime, ALPHA.sections);
    const count = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE file_path=?')
                    .get(ALPHA.filePath).n;
    expect(count).toBe(1);
  });

  it('replaces sections on second upsert', () => {
    upsertDocument(db, ALPHA.repo, ALPHA.filePath, ALPHA.title, ALPHA.loadWhen, ALPHA.mtime, ALPHA.sections);
    // Second upsert with fewer sections
    const updatedSections = [{ name: 'Quick Start', content: 'Updated.' }];
    upsertDocument(db, ALPHA.repo, ALPHA.filePath, ALPHA.title, ALPHA.loadWhen, ALPHA.mtime + 1, updatedSections);
    const docRow = db.prepare('SELECT id FROM documents WHERE file_path=?').get(ALPHA.filePath);
    const sections = db.prepare('SELECT name FROM sections WHERE doc_id=?').all(docRow.id);
    expect(sections.length).toBe(1);
    expect(sections[0].name).toBe('Quick Start');
  });

  it('does not mix sections across two different documents', () => {
    upsertDocument(db, ALPHA.repo, ALPHA.filePath, ALPHA.title, ALPHA.loadWhen, ALPHA.mtime, ALPHA.sections);
    upsertDocument(db, BETA.repo,  BETA.filePath,  BETA.title,  BETA.loadWhen,  BETA.mtime,  BETA.sections);
    const alphaDoc = db.prepare('SELECT id FROM documents WHERE file_path=?').get(ALPHA.filePath);
    const alphaSections = db.prepare('SELECT name FROM sections WHERE doc_id=?').all(alphaDoc.id);
    expect(alphaSections.map(s => s.name)).not.toContain('Steps');
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
    expect(getDocumentMtime(db, 'kb', 'unknown.md')).toBeNull();
  });

  it('returns the stored mtime for a known file', () => {
    upsertDocument(db, 'kb', 'conventions/alpha.md', 'Alpha', null, 9999, []);
    expect(getDocumentMtime(db, 'kb', 'conventions/alpha.md')).toBe(9999);
  });

  it('is scoped by repo — same path in a different repo returns null', () => {
    upsertDocument(db, 'kb', 'conventions/alpha.md', 'Alpha', null, 9999, []);
    expect(getDocumentMtime(db, 'other-repo', 'conventions/alpha.md')).toBeNull();
  });

  it('reflects the updated mtime after a second upsert', () => {
    upsertDocument(db, 'kb', 'conventions/alpha.md', 'Alpha', null, 1000, []);
    upsertDocument(db, 'kb', 'conventions/alpha.md', 'Alpha', null, 2000, []);
    expect(getDocumentMtime(db, 'kb', 'conventions/alpha.md')).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// searchSections
// ---------------------------------------------------------------------------

describe('searchSections', () => {
  let db;
  beforeEach(() => {
    db = openDb(':memory:');
    upsertDocument(db, 'kb', 'conventions/alpha.md', 'Alpha Convention', null, 1, ALPHA.sections);
    upsertDocument(db, 'kb', 'guides/beta.md',       'Beta Guide',       null, 2, BETA.sections);
  });
  afterEach(() => db.close());

  it('finds sections matching a single-word query', () => {
    const hits = searchSections(db, 'alphabet');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('returns file_path and section name for each hit', () => {
    const hits = searchSections(db, 'foundation');
    expect(hits[0].file_path).toBe('conventions/alpha.md');
    expect(hits[0].section).toBe('What');
  });

  it('returns a snippet containing the matched term', () => {
    const hits = searchSections(db, 'foundation');
    expect(hits[0].snippet).toContain('foundation');
  });

  it('returns hits from both documents when query matches both', () => {
    // 'alphabet' appears in both ALPHA.sections[1] and BETA.sections[0]
    const hits = searchSections(db, 'alphabet');
    const paths = hits.map(h => h.file_path);
    expect(paths).toContain('conventions/alpha.md');
    expect(paths).toContain('guides/beta.md');
  });

  it('filters by repo when specified', () => {
    const hits = searchSections(db, 'alphabet', 'kb');
    expect(hits.every(h => h.repo === 'kb')).toBe(true);
  });

  it('returns empty array when no section matches the query', () => {
    const hits = searchSections(db, 'xyznonexistent99');
    expect(hits).toHaveLength(0);
  });

  it('returns empty array when repo filter excludes all matches', () => {
    const hits = searchSections(db, 'foundation', 'other-repo');
    expect(hits).toHaveLength(0);
  });
});
