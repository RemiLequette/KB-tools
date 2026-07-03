/**
 * mcp-doc-index-tools.test.js
 *
 * Integration tests for mcp-doc-index/tools.js — exercises search, list_triggers,
 * read_section, write_section, reindex against sandboxed repos.json + fixture repo,
 * without going through the MCP protocol layer.
 *
 * @convention conventions/mcp-doc-index.md [## How — Implementation > MCP tools (draft contract)]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  createContext, search, listTriggers, readSection, writeSection, reindex,
} from '../mcp-doc-index/tools.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES   = path.join(__dirname, 'fixtures', 'mcp-doc-index');
const SANDBOX    = path.join(__dirname, 'sandbox', 'mcp-doc-index-tools');

let ctx;
let reposJsonPath;

function writeReposJson(dbPath) {
  reposJsonPath = path.join(SANDBOX, 'repos.json');
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.writeFileSync(reposJsonPath, JSON.stringify([
    { name: 'kb', root: FIXTURES, db: dbPath },
  ]));
}

beforeEach(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  writeReposJson(path.join(SANDBOX, 'kb.db'));
  ctx = createContext(reposJsonPath);
});

afterEach(() => {
  ctx.close();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe('search', () => {
  it('finds section matches after indexing via reindex', () => {
    reindex(ctx, { repo: 'kb' });
    const result = search(ctx, { query: 'foundation' });
    expect(result.section_matches.length).toBeGreaterThan(0);
  });

  it('returns title_matches for a query matching a document title', () => {
    reindex(ctx, { repo: 'kb' });
    const result = search(ctx, { query: 'Alpha' });
    expect(result.title_matches.some(m => m.file_path.includes('alpha.md'))).toBe(true);
  });

  it('throws MISSING_ARG when query is empty', () => {
    expect(() => search(ctx, { query: '' })).toThrow(/MISSING_ARG/);
  });

  it('restricts results to the given repo', () => {
    reindex(ctx, { repo: 'kb' });
    const result = search(ctx, { query: 'foundation', repo: 'kb' });
    expect(result.section_matches.every(m => m.repo === 'kb')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listTriggers
// ---------------------------------------------------------------------------

describe('listTriggers', () => {
  it('returns documents that declare a Load when section', () => {
    reindex(ctx, { repo: 'kb' });
    const triggers = listTriggers(ctx, { repo: 'kb' });
    expect(triggers.some(t => t.file_path.includes('beta.md'))).toBe(true);
  });

  it('excludes documents without a Load when section', () => {
    reindex(ctx, { repo: 'kb' });
    const triggers = listTriggers(ctx, { repo: 'kb' });
    expect(triggers.some(t => t.file_path.includes('alpha.md'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readSection
// ---------------------------------------------------------------------------

describe('readSection', () => {
  it('reads an existing section', () => {
    const content = readSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Why' });
    expect(content).toContain('starting point');
  });

  it('throws SECTION_NOT_FOUND for a missing section', () => {
    expect(() => readSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Nope' }))
      .toThrow(/SECTION_NOT_FOUND/);
  });

  it('throws FILE_NOT_FOUND for a missing file', () => {
    expect(() => readSection(ctx, { repo: 'kb', file: 'conventions/nope.md', section: 'Why' }))
      .toThrow(/FILE_NOT_FOUND/);
  });

  it('throws REPO_NOT_FOUND for an unknown repo', () => {
    expect(() => readSection(ctx, { repo: 'nope', file: 'conventions/alpha.md', section: 'Why' }))
      .toThrow(/REPO_NOT_FOUND/);
  });
});

// ---------------------------------------------------------------------------
// writeSection
// ---------------------------------------------------------------------------

describe('writeSection', () => {
  const SANDBOX_ALPHA = () => path.join(SANDBOX, 'repo', 'conventions', 'alpha.md');

  beforeEach(() => {
    // Copy the alpha fixture into a writable sandbox repo so tests don't mutate fixtures/.
    const dest = SANDBOX_ALPHA();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'conventions', 'alpha.md'), dest);

    // The alpha fixture intentionally has no ## Load when — used elsewhere to test
    // the load_when=null case (see indexer.test.js). conventions/documentation.md
    // makes ## Load when mandatory, so writeSection's conformance gate (getIssues)
    // would reject every write below unless the sandboxed *copy* has it. Inject it
    // here, in the copy only — the fixture on disk stays untouched.
    const withLoadWhen = fs.readFileSync(dest, 'utf-8')
      .replace('\n## Why', '\n## Load when\nWorking with alpha things\n\n## Why');
    fs.writeFileSync(dest, withLoadWhen);

    // Point repos.json at the sandbox repo instead of the read-only fixtures.
    reposJsonPath = path.join(SANDBOX, 'repos-writable.json');
    fs.writeFileSync(reposJsonPath, JSON.stringify([
      { name: 'kb', root: path.join(SANDBOX, 'repo'), db: path.join(SANDBOX, 'kb-writable.db') },
    ]));
    ctx.close();
    ctx = createContext(reposJsonPath);
  });

  it('overwrites an existing section (mode=set, default)', () => {
    writeSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Why', content: 'Updated why.' });
    const content = readSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Why' });
    expect(content).toBe('Updated why.');
  });

  it('rejects a write that leaves the document non-conformant', () => {
    expect(() => writeSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Keywords', content: '' }))
      .toThrow(/NOT_CONFORMANT/);
    // File on disk must be untouched.
    const raw = fs.readFileSync(SANDBOX_ALPHA(), 'utf-8');
    expect(raw).toContain('alpha, convention');
  });

  it('inserts a new section at a given position', () => {
    writeSection(ctx, {
      repo: 'kb', file: 'conventions/alpha.md', section: 'How', content: 'Steps here.',
      mode: 'insert', position: 'after:What',
    });
    const content = readSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'How' });
    expect(content).toBe('Steps here.');
  });

  it('rejects deleting a mandatory section', () => {
    expect(() => writeSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Keywords', mode: 'delete' }))
      .toThrow(/PROTECTED_SECTION/);
  });

  it('deletes a non-mandatory section', () => {
    writeSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Why', mode: 'delete' });
    expect(() => readSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Why' }))
      .toThrow(/SECTION_NOT_FOUND/);
  });

  it('reindexes the file after a successful write', () => {
    writeSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Why', content: 'Searchable update xyz123.' });
    const result = search(ctx, { query: 'xyz123', repo: 'kb' });
    expect(result.section_matches.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// reindex
// ---------------------------------------------------------------------------

describe('reindex', () => {
  it('indexes every .md file under the repo root', () => {
    reindex(ctx, { repo: 'kb' });
    const result = search(ctx, { query: 'test', repo: 'kb' });
    const paths = result.section_matches.map(m => m.file_path);
    expect(paths.some(p => p.includes('alpha.md'))).toBe(true);
    expect(paths.some(p => p.includes('beta.md'))).toBe(true);
  });

  it('reindexes all configured repos when repo is omitted', () => {
    const results = reindex(ctx, {});
    expect(results.map(r => r.repo)).toContain('kb');
  });
});
