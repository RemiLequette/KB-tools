/**
 * todo-filter.test.js
 *
 * Vitest test suite for todo-filter.js.
 *
 * References:
 *   - conventions/todo-list.md [## Tools > todo-filter.js]
 *   - conventions/tools.md [## Standard Interface, ## Tests]
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'todo-filter.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'todo-filter');
const MISSING_DIR = path.join(__dirname, 'fixtures', 'todo-filter-nonexistent');

function run(...args) {
  return execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe('argument validation', () => {
  // @convention conventions/tools.md [## Standard Interface > Error codes > MISSING_ARG]
  it('no args: returns ERROR:MISSING_ARG', () => {
    const out = run();
    expect(out).toMatch(/^ERROR:MISSING_ARG:/);
  });

  // @convention conventions/tools.md [## Standard Interface > Error codes > MISSING_ARG]
  it('one arg: returns ERROR:MISSING_ARG', () => {
    const out = run(FIXTURES);
    expect(out).toMatch(/^ERROR:MISSING_ARG:/);
  });

  // @convention conventions/tools.md [## Standard Interface > Error codes > MISSING_ARG]
  it('two args: returns ERROR:MISSING_ARG', () => {
    const out = run(FIXTURES, 'Status');
    expect(out).toMatch(/^ERROR:MISSING_ARG:/);
  });
});

// ---------------------------------------------------------------------------
// Directory validation
// ---------------------------------------------------------------------------

describe('directory validation', () => {
  // @convention conventions/tools.md [## Standard Interface > Error codes > FILE_NOT_FOUND]
  it('nonexistent dir: returns ERROR:FILE_NOT_FOUND', () => {
    const out = run(MISSING_DIR, 'Status', 'WIP');
    expect(out).toMatch(/^ERROR:FILE_NOT_FOUND:/);
  });
});

// ---------------------------------------------------------------------------
// Filtering — matches
// ---------------------------------------------------------------------------

describe('filtering — matches', () => {
  // @convention conventions/todo-list.md [## Tools > todo-filter.js]
  it('Status WIP: returns Item-WIP.md only', () => {
    const lines = run(FIXTURES, 'Status', 'WIP').trim().split('\n');
    expect(lines[0]).toBe('OK');
    expect(lines).toContain('Item-WIP.md');
    expect(lines.length).toBe(2);
  });

  // @convention conventions/todo-list.md [## Tools > todo-filter.js]
  it('importance High: returns Item-High.md only', () => {
    const lines = run(FIXTURES, 'importance', 'High').trim().split('\n');
    expect(lines[0]).toBe('OK');
    expect(lines).toContain('Item-High.md');
    expect(lines.length).toBe(2);
  });

  // @convention conventions/todo-list.md [## Tools > todo-filter.js]
  it('effort S: returns Item-Effort-S.md only', () => {
    const lines = run(FIXTURES, 'effort', 'S').trim().split('\n');
    expect(lines[0]).toBe('OK');
    expect(lines).toContain('Item-Effort-S.md');
    expect(lines.length).toBe(2);
  });

  // @convention conventions/todo-list.md [## Tools > todo-filter.js]
  it('Status Done: returns Item-High.md only', () => {
    const lines = run(FIXTURES, 'Status', 'Done').trim().split('\n');
    expect(lines[0]).toBe('OK');
    expect(lines).toContain('Item-High.md');
    expect(lines.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Filtering — no match
// ---------------------------------------------------------------------------

describe('filtering — no match', () => {
  // @convention conventions/todo-list.md [## Tools > todo-filter.js]
  it('unknown value: returns OK with empty list', () => {
    const lines = run(FIXTURES, 'Status', 'NoSuchStatus').trim().split('\n');
    expect(lines[0]).toBe('OK');
    expect(lines.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Case sensitivity
// ---------------------------------------------------------------------------

describe('case sensitivity', () => {
  // @convention conventions/todo-list.md [## Format > Status values]
  it('Status wip (lowercase): returns no match', () => {
    const lines = run(FIXTURES, 'Status', 'wip').trim().split('\n');
    expect(lines[0]).toBe('OK');
    expect(lines.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

describe('output format', () => {
  // @convention conventions/tools.md [## Standard Interface > stdout]
  it('output contains filenames only, not full paths', () => {
    const lines = run(FIXTURES, 'Status', 'WIP').trim().split('\n');
    const dataLines = lines.slice(1);
    for (const line of dataLines) {
      expect(line).not.toContain(path.sep);
    }
  });
});
