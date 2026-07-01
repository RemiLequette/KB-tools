/**
 * lock.test.js
 *
 * Unit tests for lib/lock.js.
 * Tests advisory lock acquire/release, stale-timeout reclaim, and dead-PID reclaim.
 *
 * @convention conventions/mcp-doc-index.md [## How — Implementation > Design decisions > Concurrency]
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { acquireLock, releaseLock, withLock } from '../lib/lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX   = path.join(__dirname, 'sandbox');
fs.mkdirSync(SANDBOX, { recursive: true });

let dbPath;

function freshDbPath() {
  return path.join(SANDBOX, `lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

afterEach(() => {
  if (dbPath) {
    try { fs.unlinkSync(dbPath + '.lock'); } catch (e) { /* fine */ }
  }
});

// ---------------------------------------------------------------------------
// acquireLock / releaseLock
// ---------------------------------------------------------------------------

describe('acquireLock', () => {
  it('creates a lock file at <dbPath>.lock', () => {
    dbPath = freshDbPath();
    acquireLock(dbPath);
    expect(fs.existsSync(dbPath + '.lock')).toBe(true);
  });

  it('writes the current pid and a timestamp into the lock file', () => {
    dbPath = freshDbPath();
    acquireLock(dbPath);
    const data = JSON.parse(fs.readFileSync(dbPath + '.lock', 'utf-8'));
    expect(data.pid).toBe(process.pid);
    expect(typeof data.timestamp).toBe('number');
  });

  it('throws LOCK_HELD when a live, fresh lock already exists', () => {
    dbPath = freshDbPath();
    acquireLock(dbPath);
    expect(() => acquireLock(dbPath)).toThrow(/LOCK_HELD/);
  });

  it('reclaims a lock whose owning pid is not running', () => {
    dbPath = freshDbPath();
    const deadPid = 999999; // exceedingly unlikely to be a live process
    fs.mkdirSync(SANDBOX, { recursive: true });
    fs.writeFileSync(dbPath + '.lock', JSON.stringify({ pid: deadPid, timestamp: Date.now() }));
    expect(() => acquireLock(dbPath)).not.toThrow();
    const data = JSON.parse(fs.readFileSync(dbPath + '.lock', 'utf-8'));
    expect(data.pid).toBe(process.pid);
  });

  it('reclaims a lock older than the stale timeout, even if the pid is alive', () => {
    dbPath = freshDbPath();
    fs.writeFileSync(dbPath + '.lock', JSON.stringify({ pid: process.pid, timestamp: Date.now() - 100_000 }));
    expect(() => acquireLock(dbPath, 30_000)).not.toThrow();
  });

  it('treats a missing lock file as no lock', () => {
    dbPath = freshDbPath();
    expect(() => acquireLock(dbPath)).not.toThrow();
  });
});

describe('releaseLock', () => {
  it('removes the lock file when owned by the current pid', () => {
    dbPath = freshDbPath();
    acquireLock(dbPath);
    releaseLock(dbPath);
    expect(fs.existsSync(dbPath + '.lock')).toBe(false);
  });

  it('is a no-op when no lock file exists', () => {
    dbPath = freshDbPath();
    expect(() => releaseLock(dbPath)).not.toThrow();
  });

  it('does not remove a lock file owned by a different pid', () => {
    dbPath = freshDbPath();
    fs.writeFileSync(dbPath + '.lock', JSON.stringify({ pid: process.pid + 1, timestamp: Date.now() }));
    releaseLock(dbPath);
    expect(fs.existsSync(dbPath + '.lock')).toBe(true);
  });

  it('allows re-acquiring after release', () => {
    dbPath = freshDbPath();
    acquireLock(dbPath);
    releaseLock(dbPath);
    expect(() => acquireLock(dbPath)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// withLock
// ---------------------------------------------------------------------------

describe('withLock', () => {
  it('runs fn while holding the lock, then releases it', () => {
    dbPath = freshDbPath();
    let heldDuringFn;
    withLock(dbPath, () => {
      heldDuringFn = fs.existsSync(dbPath + '.lock');
    });
    expect(heldDuringFn).toBe(true);
    expect(fs.existsSync(dbPath + '.lock')).toBe(false);
  });

  it('releases the lock even when fn throws', () => {
    dbPath = freshDbPath();
    expect(() => withLock(dbPath, () => { throw new Error('boom'); })).toThrow('boom');
    expect(fs.existsSync(dbPath + '.lock')).toBe(false);
  });

  it('returns the value returned by fn', () => {
    dbPath = freshDbPath();
    const result = withLock(dbPath, () => 42);
    expect(result).toBe(42);
  });
});
