/**
 * server-core.js
 *
 * Pure filesystem logic for the local development server.
 * No HTTP, no side effects at require time.
 * All functions take an explicit `allowedRoots` array for testability.
 */

import fs   from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// safePath — resolve and validate against allowed roots
// ---------------------------------------------------------------------------

/**
 * Resolves `inputPath` to an absolute path and checks it is inside one of
 * the allowed roots. Returns the resolved path, or null if access is denied.
 *
 * @param {string} inputPath
 * @param {string[]} allowedRoots - absolute paths
 * @returns {string|null}
 */
function safePath(inputPath, allowedRoots) {
  if (!inputPath || !allowedRoots || allowedRoots.length === 0) return null;
  const resolved = path.resolve(inputPath);
  for (const root of allowedRoots) {
    const resolvedRoot = path.resolve(root);
    if (resolved.startsWith(resolvedRoot + path.sep) || resolved === resolvedRoot) {
      return resolved;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

/**
 * Read a file from disk.
 * Returns { status, content } where content is a string (utf-8).
 *
 * @param {string} filePath - absolute path
 * @param {string[]} allowedRoots
 * @returns {{ status: number, content?: string, error?: string }}
 */
function readFile(filePath, allowedRoots) {
  const safe = safePath(filePath, allowedRoots);
  if (!safe) return { status: 403, error: 'Access denied' };
  if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) {
    return { status: 404, error: 'File not found' };
  }
  try {
    const content = fs.readFileSync(safe, 'utf8');
    return { status: 200, content };
  } catch (e) {
    return { status: 500, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// writeFile
// ---------------------------------------------------------------------------

/**
 * Write body to filePath, creating intermediate directories as needed.
 * Body is written as-is — no validation.
 *
 * @param {string} filePath - absolute path
 * @param {string} body - content to write
 * @param {string[]} allowedRoots
 * @returns {{ status: number, error?: string }}
 */
function writeFile(filePath, body, allowedRoots) {
  const safe = safePath(filePath, allowedRoots);
  if (!safe) return { status: 403, error: 'Access denied' };
  try {
    fs.mkdirSync(path.dirname(safe), { recursive: true });
    fs.writeFileSync(safe, body, 'utf8');
    return { status: 200 };
  } catch (e) {
    return { status: 500, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// deleteFile
// ---------------------------------------------------------------------------

/**
 * Delete a file from disk. Idempotent — returns 200 even if file is absent.
 *
 * @param {string} filePath - absolute path
 * @param {string[]} allowedRoots
 * @returns {{ status: number, error?: string }}
 */
function deleteFile(filePath, allowedRoots) {
  const safe = safePath(filePath, allowedRoots);
  if (!safe) return { status: 403, error: 'Access denied' };
  try {
    if (fs.existsSync(safe)) fs.unlinkSync(safe);
    return { status: 200 };
  } catch (e) {
    return { status: 500, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// listDir
// ---------------------------------------------------------------------------

/**
 * List the contents of a directory.
 * Returns { status, entries } where entries is [{ name, type }], sorted by name.
 * type is "file" or "dir".
 *
 * @param {string} dirPath - absolute path
 * @param {string[]} allowedRoots
 * @returns {{ status: number, entries?: Array<{name:string, type:string}>, error?: string }}
 */
function listDir(dirPath, allowedRoots) {
  const safe = safePath(dirPath, allowedRoots);
  if (!safe) return { status: 403, error: 'Access denied' };
  if (!fs.existsSync(safe)) return { status: 404, error: 'Directory not found' };
  try {
    const names = fs.readdirSync(safe).sort();
    const entries = names.map(name => {
      const stat = fs.statSync(path.join(safe, name));
      return { name, type: stat.isDirectory() ? 'dir' : 'file' };
    });
    return { status: 200, entries };
  } catch (e) {
    return { status: 500, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// parseAllowedRoots — extract path arguments from argv
// ---------------------------------------------------------------------------

/**
 * Extract allowed root paths from a process.argv-style array.
 * Skips --port and its value. Returns remaining non-flag arguments.
 *
 * @param {string[]} args - e.g. process.argv.slice(2)
 * @returns {string[]}
 */
function parseAllowedRoots(args) {
  const roots = [];
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--port') {
      i += 2; // skip flag and value
    } else if (args[i].startsWith('--')) {
      i += 1; // skip unknown flag
    } else {
      roots.push(args[i]);
      i += 1;
    }
  }
  return roots;
}

// ---------------------------------------------------------------------------
// parsePort — extract --port value from argv
// ---------------------------------------------------------------------------

/**
 * Extract the port number from a process.argv-style array.
 * Returns 3000 if --port is not provided.
 *
 * @param {string[]} args
 * @returns {number}
 */
function parsePort(args) {
  const idx = args.indexOf('--port');
  if (idx !== -1 && args[idx + 1]) {
    const p = parseInt(args[idx + 1], 10);
    if (!isNaN(p)) return p;
  }
  return 3000;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { safePath, readFile, writeFile, deleteFile, listDir, parseAllowedRoots, parsePort };
