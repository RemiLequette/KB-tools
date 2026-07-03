/**
 * tools.js
 *
 * Pure orchestration layer for the MCP code index tools — search, reindex.
 * Kept separate from server.js (the MCP transport wiring) so it can be
 * unit-tested without spinning up a protocol connection.
 *
 * A Context groups the open db handles for all configured repos, keyed by repo
 * name, plus repo metadata (root, db path, extensions). Callers create one
 * Context per server process with createContext() and reuse it across tool
 * calls.
 *
 * @convention conventions/mcp-code-index.md [## How — Implementation > MCP tools]
 * @convention conventions/mcp-code-index.md [## What — Model > Scope]
 *
 * Not yet in references (document debt — update mcp-code-index.md to absorb these):
 *   - Error codes (REPO_NOT_FOUND, MISSING_ARG) follow conventions/tools.md's
 *     general error-code catalogue, applied here to MCP tool results instead
 *     of the stdout `ERROR:<code>:<message>` line format.
 */

import fs   from 'fs';
import path from 'path';

import { openDb, searchDocuments } from '../lib/code-index-db.js';
import { indexRepo, refreshRepo } from '../lib/code-indexer.js';
import { loadRepos, findRepo } from '../lib/repo-config.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Throws a tagged error carrying a `.code` for the MCP tool result mapping. */
function fail(code, message) {
  const err = new Error(`${code}: ${message ?? code}`);
  err.code = code;
  throw err;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Create a tool context from a repos.json path — loads repo config and opens
 * one db handle per repo, cached for reuse.
 *
 * @param {string} reposJsonPath - Absolute path to repos.json.
 * @returns {{ repos: {name:string,root:string,db:string,extensions:string[]}[], getDb: (repoName:string) => import('better-sqlite3').Database, close: () => void }}
 */
export function createContext(reposJsonPath) {
  const repos = loadRepos(reposJsonPath);
  const dbHandles = new Map();

  function getDb(repoName) {
    const repo = findRepo(repos, repoName);
    if (!dbHandles.has(repo.name)) {
      fs.mkdirSync(path.dirname(repo.db), { recursive: true });
      dbHandles.set(repo.name, openDb(repo.db));
    }
    return dbHandles.get(repo.name);
  }

  function close() {
    for (const db of dbHandles.values()) db.close();
    dbHandles.clear();
  }

  return { repos, getDb, close };
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/**
 * Full-text search across one repo or all configured repos.
 * Refreshes (lazy reindex) every already-known document in scope before
 * answering.
 *
 * @param {ReturnType<typeof createContext>} ctx
 * @param {{ query: string, repo?: string }} args
 * @returns {{ matches: object[] }}
 */
export function search(ctx, { query, repo }) {
  if (!query || !query.trim()) fail('MISSING_ARG', 'query is required');

  const targetRepos = repo ? [findRepo(ctx.repos, repo)] : ctx.repos;
  const matches = [];

  for (const r of targetRepos) {
    const db = ctx.getDb(r.name);
    refreshRepo(db, r.name);
    matches.push(...searchDocuments(db, query, r.name));
  }

  return { matches };
}

// ---------------------------------------------------------------------------
// reindex
// ---------------------------------------------------------------------------

/**
 * Full directory walk and reindex — one repo, or every configured repo.
 * Catches new/deleted files that lazy reindex misses.
 *
 * @param {ReturnType<typeof createContext>} ctx
 * @param {{ repo?: string }} args
 * @returns {{ repo: string, indexed: boolean }[]}
 */
export function reindex(ctx, { repo } = {}) {
  const targetRepos = repo ? [findRepo(ctx.repos, repo)] : ctx.repos;
  const results = [];
  for (const r of targetRepos) {
    const db = ctx.getDb(r.name);
    indexRepo(db, r.name, r.root, r.extensions);
    results.push({ repo: r.name, indexed: true });
  }
  return results;
}
