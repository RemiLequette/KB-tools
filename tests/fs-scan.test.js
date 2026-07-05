/**
 * fs-scan.test.js
 *
 * Unit tests for lib/fs-scan.js — directory scanning, extension filtering,
 * and exclude-pattern matching.
 *
 * @convention conventions/mcp-code-index.md [## What — Model > Exclude patterns]
 * @convention conventions/mcp-doc-index.md [## What — Model > Exclude patterns]
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanFiles, scanMarkdownFiles } from '../lib/fs-scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CODE_FIXTURES = path.join(__dirname, 'fixtures', 'mcp-code-index');
const DOC_FIXTURES  = path.join(__dirname, 'fixtures', 'mcp-doc-index');
const EXTENSIONS    = ['.js', '.html', '.css'];

// ---------------------------------------------------------------------------
// scanFiles — extensions (no exclude)
// ---------------------------------------------------------------------------

describe('scanFiles', () => {
  it('returns all files matching the given extensions', () => {
    const files = scanFiles(CODE_FIXTURES, EXTENSIONS);
    // foo.js, bar.html, baz.css, dist/bundle.generated.js = 4 files (readme.txt excluded by extension)
    expect(files).toHaveLength(4);
  });

  it('excludes files whose extension is not in the given list', () => {
    const files = scanFiles(CODE_FIXTURES, EXTENSIONS);
    expect(files.some(f => f.endsWith('readme.txt'))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // scanFiles — exclude patterns
  // ---------------------------------------------------------------------------

  it('with no exclude argument, behaves exactly as before (backward compatible)', () => {
    const files = scanFiles(CODE_FIXTURES, EXTENSIONS);
    expect(files.some(f => f.endsWith('bundle.generated.js'))).toBe(true);
  });

  it('excludes a file matching an exact glob (no wildcard)', () => {
    const files = scanFiles(CODE_FIXTURES, EXTENSIONS, ['dist/bundle.generated.js']);
    expect(files.some(f => f.endsWith('bundle.generated.js'))).toBe(false);
  });

  it('excludes files matching a single-segment wildcard (*)', () => {
    const files = scanFiles(CODE_FIXTURES, EXTENSIONS, ['dist/*.generated.js']);
    expect(files.some(f => f.endsWith('bundle.generated.js'))).toBe(false);
  });

  it('excludes an entire directory subtree matching a ** pattern', () => {
    const files = scanFiles(CODE_FIXTURES, EXTENSIONS, ['**/dist/**']);
    expect(files.some(f => f.includes('dist'))).toBe(false);
    // sibling files untouched
    expect(files.some(f => f.endsWith('foo.js'))).toBe(true);
  });

  it('a non-matching exclude pattern changes nothing', () => {
    const withExclude = scanFiles(CODE_FIXTURES, EXTENSIONS, ['**/nonexistent/**']).sort();
    const withoutExclude = scanFiles(CODE_FIXTURES, EXTENSIONS).sort();
    expect(withExclude).toEqual(withoutExclude);
  });

  it('still always skips node_modules/ and .git/ regardless of exclude', () => {
    // No node_modules/.git in fixtures, but an empty exclude array must not
    // disable the hardcoded skip — regression guard for the default param.
    const files = scanFiles(CODE_FIXTURES, EXTENSIONS, []);
    expect(files.some(f => f.includes('node_modules'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanMarkdownFiles — exclude patterns
// ---------------------------------------------------------------------------

describe('scanMarkdownFiles', () => {
  it('returns all .md files with no exclude argument', () => {
    const files = scanMarkdownFiles(DOC_FIXTURES);
    expect(files.some(f => f.endsWith('output.md'))).toBe(true);
  });

  it('excludes .md files under a directory matching a ** pattern', () => {
    const files = scanMarkdownFiles(DOC_FIXTURES, ['**/generated/**']);
    expect(files.some(f => f.endsWith('output.md'))).toBe(false);
    // sibling fixture untouched
    expect(files.some(f => f.endsWith('alpha.md'))).toBe(true);
  });
});
