/**
 * repo-config.js
 *
 * Loads and resolves the mcp-doc-index repos.json — repo name to {root, db} mapping.
 *
 * @convention conventions/mcp-doc-index.md [## What — Model > Scope]
 */

import fs   from 'fs';
import path from 'path';

/**
 * Load repos.json and resolve each entry's db path relative to the repos.json
 * file's own directory (per convention: "Database paths in repos.json are
 * relative to server.js"). Fields beyond name/root/db (e.g. `extensions`,
 * used by mcp-code-index) are passed through unchanged.
 *
 * @param {string} reposJsonPath - Absolute path to repos.json.
 * @returns {{ name: string, root: string, db: string, [key: string]: unknown }[]}
 */
export function loadRepos(reposJsonPath) {
  if (!fs.existsSync(reposJsonPath)) {
    throw new Error(`repos.json not found: ${reposJsonPath}`);
  }
  const raw  = fs.readFileSync(reposJsonPath, 'utf-8');
  const list = JSON.parse(raw);
  const baseDir = path.dirname(reposJsonPath);

  return list.map(({ db, ...rest }) => ({
    ...rest,
    db: path.isAbsolute(db) ? db : path.resolve(baseDir, db),
  }));
}

/**
 * Find a repo entry by name. Throws REPO_NOT_FOUND if absent.
 *
 * @param {{ name: string, root: string, db: string }[]} repos
 * @param {string} name
 * @returns {{ name: string, root: string, db: string }}
 */
export function findRepo(repos, name) {
  const repo = repos.find(r => r.name === name);
  if (!repo) {
    const err = new Error(`REPO_NOT_FOUND: ${name}`);
    err.code = 'REPO_NOT_FOUND';
    throw err;
  }
  return repo;
}
