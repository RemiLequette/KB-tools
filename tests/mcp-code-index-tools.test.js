/**
 * mcp-code-index-tools.test.js
 *
 * Integration tests for mcp-code-index/tools.js — exercises search and reindex
 * against a sandboxed repos.json + fixture repo, without going through the
 * MCP protocol layer.
 *
 * @convention conventions/mcp-code-index.md [## How — Implementation > MCP tools]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createContext, search, reindex } from '../mcp-code-index/tools.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES   = path.join(__dirname, 'fixtures', 'mcp-code-index');
const SANDBOX    = path.join(__dirname, 'sandbox', 'mcp-code-index-tools');

let ctx;
let reposJsonPath;

function writeReposJson(dbPath) {
  reposJsonPath = path.join(SANDBOX, 'repos.json');
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.writeFileSync(reposJsonPath, JSON.stringify([
    { name: 'ddscope-code', root: FIXTURES, db: dbPath, extensions: ['.js', '.html', '.css'] },
  ]));
}

beforeEach(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  writeReposJson(path.join(SANDBOX, 'ddscope-code.db'));
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
  it('finds matches after indexing via reindex', () => {
    reindex(ctx, { repo: 'ddscope-code' });
    const result = search(ctx, { query: 'hello' });
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('throws MISSING_ARG when query is empty', () => {
    expect(() => search(ctx, { query: '' })).toThrow(/MISSING_ARG/);
  });

  it('restricts results to the given repo', () => {
    reindex(ctx, { repo: 'ddscope-code' });
    const result = search(ctx, { query: 'hello', repo: 'ddscope-code' });
    expect(result.matches.every(m => m.repo === 'ddscope-code')).toBe(true);
  });

  it('throws REPO_NOT_FOUND for an unknown repo', () => {
    expect(() => search(ctx, { query: 'hello', repo: 'nope' })).toThrow(/REPO_NOT_FOUND/);
  });
});

// ---------------------------------------------------------------------------
// reindex
// ---------------------------------------------------------------------------

describe('reindex', () => {
  it('indexes every matching file under the repo root', () => {
    reindex(ctx, { repo: 'ddscope-code' });
    const result = search(ctx, { query: 'fragment', repo: 'ddscope-code' });
    const paths = result.matches.map(m => m.file_path);
    expect(paths.some(p => p.includes('bar.html'))).toBe(true);
  });

  it('excludes files whose extension is not configured for the repo', () => {
    reindex(ctx, { repo: 'ddscope-code' });
    const result = search(ctx, { query: 'indexed', repo: 'ddscope-code' });
    const paths = result.matches.map(m => m.file_path);
    expect(paths.some(p => p.includes('readme.txt'))).toBe(false);
  });

  it('reindexes all configured repos when repo is omitted', () => {
    const results = reindex(ctx, {});
    expect(results.map(r => r.repo)).toContain('ddscope-code');
  });
});
