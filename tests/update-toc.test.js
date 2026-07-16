/**
 * update-toc.test.js
 *
 * Vitest test suite for update-toc.js — regenerates the Table of Contents
 * across a Markdown tree via md-parser.js, skipping out-of-scope files.
 *
 * References:
 *   - conventions/documentation.md [section TOC Rule, section Scope]
 *   - conventions/tools.md [## Standard Interface, ## Tests]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT     = path.join(__dirname, '..', 'update-toc.js');
const FIXTURES   = path.join(__dirname, 'fixtures', 'update-toc');
const SANDBOX    = path.join(__dirname, 'sandbox', 'update-toc');
const MISSING_DIR = path.join(__dirname, 'fixtures', 'update-toc-nonexistent');

function run(...args) {
  return execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
}

beforeEach(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  for (const name of fs.readdirSync(FIXTURES)) {
    fs.copyFileSync(path.join(FIXTURES, name), path.join(SANDBOX, name));
  }
});

afterEach(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe('argument validation', () => {
  // @convention conventions/tools.md [## Standard Interface > Error codes > MISSING_ARG]
  it('no args: returns ERROR:MISSING_ARG', () => {
    expect(run()).toMatch(/^ERROR:MISSING_ARG:/);
  });

  // @convention conventions/tools.md [## Standard Interface > Error codes > MISSING_ARG]
  it('invalid mode: returns ERROR:MISSING_ARG', () => {
    expect(run(SANDBOX, 'delete')).toMatch(/^ERROR:MISSING_ARG:/);
  });
});

// ---------------------------------------------------------------------------
// Directory validation
// ---------------------------------------------------------------------------

describe('directory validation', () => {
  // @convention conventions/tools.md [## Standard Interface > Error codes > FILE_NOT_FOUND]
  it('nonexistent dir: returns ERROR:FILE_NOT_FOUND', () => {
    expect(run(MISSING_DIR, 'check')).toMatch(/^ERROR:FILE_NOT_FOUND:/);
  });
});

// ---------------------------------------------------------------------------
// check mode — classification, no writes
// ---------------------------------------------------------------------------

describe('check mode', () => {
  it('reports UNCHANGED for a document already in the new TOC format', () => {
    const out = run(SANDBOX, 'check');
    expect(out).toMatch(/UNCHANGED\tconformant\.md/);
  });

  // @convention conventions/documentation.md [section TOC Rule]
  it('reports CHANGED for a document with a legacy insta-toc block', () => {
    const out = run(SANDBOX, 'check');
    expect(out).toMatch(/CHANGED\tlegacy\.md/);
  });

  // @convention conventions/documentation.md [section Scope]
  it('reports SKIPPED_NON_CONFORMANT for a document missing ## Load when', () => {
    const out = run(SANDBOX, 'check');
    expect(out).toMatch(/SKIPPED_NON_CONFORMANT\tnon-conformant\.md/);
  });

  // @convention conventions/documentation.md [section Scope]
  it('reports SKIPPED_NO_TITLE for a document with no # Title (e.g. GLOSSARY-style)', () => {
    const out = run(SANDBOX, 'check');
    expect(out).toMatch(/SKIPPED_NO_TITLE\tno-title\.md/);
  });

  it('does not modify any file on disk', () => {
    const before = fs.readFileSync(path.join(SANDBOX, 'legacy.md'), 'utf-8');
    run(SANDBOX, 'check');
    const after = fs.readFileSync(path.join(SANDBOX, 'legacy.md'), 'utf-8');
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// write mode — actually rewrites CHANGED files
// ---------------------------------------------------------------------------

describe('write mode', () => {
  // @convention conventions/documentation.md [section TOC Rule]
  it('rewrites a legacy insta-toc block into a wikilink TOC', () => {
    run(SANDBOX, 'write');
    const content = fs.readFileSync(path.join(SANDBOX, 'legacy.md'), 'utf-8');
    // Not `.not.toContain('insta-toc')`: the fixture's own Quick Start prose
    // legitimately mentions "insta-toc" ("Uses the old insta-toc codeblock..."),
    // so that broad assertion always failed regardless of a correct migration.
    // What must actually disappear is the codeblock fence itself.
    expect(content).not.toContain('```insta-toc');
    expect(content).toContain('## Table of Contents');
    expect(content).toContain('- [[#Why]]');
  });

  it('leaves an already-conformant document byte-identical', () => {
    const before = fs.readFileSync(path.join(SANDBOX, 'conformant.md'), 'utf-8');
    run(SANDBOX, 'write');
    const after = fs.readFileSync(path.join(SANDBOX, 'conformant.md'), 'utf-8');
    expect(after).toBe(before);
  });

  // @convention conventions/documentation.md [section Scope]
  it('leaves a skipped (out-of-scope) document byte-identical', () => {
    const before = fs.readFileSync(path.join(SANDBOX, 'no-title.md'), 'utf-8');
    run(SANDBOX, 'write');
    const after = fs.readFileSync(path.join(SANDBOX, 'no-title.md'), 'utf-8');
    expect(after).toBe(before);
  });
});
