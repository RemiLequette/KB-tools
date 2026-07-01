/**
 * lock.js
 *
 * Advisory file lock for single-writer protection on a per-repo SQLite db.
 * Used by write_section to serialize concurrent writes to the same repo.
 *
 * Lock file: `<dbPath>.lock`, containing `{ pid, timestamp }` as JSON.
 * A stale lock (owning PID no longer running, or older than staleTimeoutMs)
 * is reclaimed automatically rather than blocking forever.
 *
 * @convention conventions/mcp-doc-index.md [## How — Implementation > Design decisions > Concurrency]
 */

import fs   from 'fs';
import path from 'path';

const DEFAULT_STALE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function _lockPath(dbPath) {
  return dbPath + '.lock';
}

/** Returns true if a process with the given PID is currently running. */
function _isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but owned by another user — treat as alive
  }
}

function _readLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return null; // missing or corrupt — treat as no lock
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Acquire the advisory lock for a db path. Reclaims a stale lock (dead PID,
 * or older than staleTimeoutMs) automatically. Throws LOCK_HELD if a live,
 * fresh lock owned by another process is found.
 *
 * @param {string} dbPath
 * @param {number} [staleTimeoutMs]
 * @returns {string} the lock file path (pass to releaseLock)
 */
export function acquireLock(dbPath, staleTimeoutMs = DEFAULT_STALE_TIMEOUT_MS) {
  const lockPath = _lockPath(dbPath);
  const existing = _readLock(lockPath);

  if (existing) {
    const age = Date.now() - existing.timestamp;
    const alive = _isPidAlive(existing.pid);
    if (alive && age < staleTimeoutMs) {
      const err = new Error(`LOCK_HELD: ${lockPath} held by pid ${existing.pid} (age ${age}ms)`);
      err.code = 'LOCK_HELD';
      throw err;
    }
    // Stale (dead pid, or too old) — reclaim below.
  }

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), 'utf-8');
  return lockPath;
}

/**
 * Release the advisory lock for a db path. No-op if the lock file is absent
 * or owned by a different PID (never release a lock you don't hold).
 *
 * @param {string} dbPath
 */
export function releaseLock(dbPath) {
  const lockPath = _lockPath(dbPath);
  const existing = _readLock(lockPath);
  if (!existing) return;
  if (existing.pid !== process.pid) return; // not ours — do not touch
  try {
    fs.unlinkSync(lockPath);
  } catch (e) {
    // Already gone — fine.
  }
}

/**
 * Run fn() while holding the lock for dbPath, releasing it afterward
 * (success or failure).
 *
 * @param {string} dbPath
 * @param {() => any} fn
 * @param {number} [staleTimeoutMs]
 */
export function withLock(dbPath, fn, staleTimeoutMs = DEFAULT_STALE_TIMEOUT_MS) {
  acquireLock(dbPath, staleTimeoutMs);
  try {
    return fn();
  } finally {
    releaseLock(dbPath);
  }
}
