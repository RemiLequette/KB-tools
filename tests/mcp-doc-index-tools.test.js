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
  createContext, search, listTriggers, readSection, writeSection, createDocument, reindex,
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
  it('reads an existing section by its full H1/H2 path', () => {
    const content = readSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/Why' });
    expect(content).toContain('starting point');
  });

  it('throws SECTION_NOT_FOUND for a missing section', () => {
    expect(() => readSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/Nope' }))
      .toThrow(/SECTION_NOT_FOUND/);
  });

  it('throws SECTION_NOT_FOUND for a bare name without the full path', () => {
    expect(() => readSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Why' }))
      .toThrow(/SECTION_NOT_FOUND/);
  });

  it('throws FILE_NOT_FOUND for a missing file', () => {
    expect(() => readSection(ctx, { repo: 'kb', file: 'conventions/nope.md', section: 'Alpha Convention/Why' }))
      .toThrow(/FILE_NOT_FOUND/);
  });

  it('throws REPO_NOT_FOUND for an unknown repo', () => {
    expect(() => readSection(ctx, { repo: 'nope', file: 'conventions/alpha.md', section: 'Alpha Convention/Why' }))
      .toThrow(/REPO_NOT_FOUND/);
  });

  // @convention conventions/mcp-doc-index.md [## How — Implementation > Design decisions > TOC and [[#Quick Start]] wikilink generation]
  it('throws RESERVED_SECTION for the tool-generated Table of Contents path', () => {
    expect(() => readSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/Table of Contents' }))
      .toThrow(/RESERVED_SECTION/);
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
    writeSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/Why', content: 'Updated why.' });
    const content = readSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/Why' });
    expect(content).toBe('Updated why.');
  });

  it('rejects a write that leaves the document non-conformant', () => {
    expect(() => writeSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/Keywords', content: '' }))
      .toThrow(/NOT_CONFORMANT/);
    // File on disk must be untouched.
    const raw = fs.readFileSync(SANDBOX_ALPHA(), 'utf-8');
    expect(raw).toContain('alpha, convention');
  });

  it('inserts a new ## section at a given position', () => {
    writeSection(ctx, {
      repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/How', content: 'Steps here.',
      mode: 'insert', position: 'after:Alpha Convention/What',
    });
    const content = readSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/How' });
    expect(content).toBe('Steps here.');
  });

  it('inserts a new ### subsection under an existing ##', () => {
    writeSection(ctx, {
      repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/Why/Detail', content: 'Detail here.',
      mode: 'insert', position: 'beginning',
    });
    const content = readSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/Why/Detail' });
    expect(content).toBe('Detail here.');
  });

  it('throws PARENT_NOT_FOUND when inserting a ### under a non-existent ##', () => {
    expect(() => writeSection(ctx, {
      repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/Nope/Detail', content: 'X.',
      mode: 'insert', position: 'beginning',
    })).toThrow(/PARENT_NOT_FOUND/);
  });

  it('rejects deleting a mandatory section', () => {
    expect(() => writeSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/Keywords', mode: 'delete' }))
      .toThrow(/PROTECTED_SECTION/);
  });

  it('deletes a non-mandatory section', () => {
    writeSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/Why', mode: 'delete' });
    expect(() => readSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/Why' }))
      .toThrow(/SECTION_NOT_FOUND/);
  });

  it('reindexes the file after a successful write', () => {
    writeSection(ctx, { repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/Why', content: 'Searchable update xyz123.' });
    const result = search(ctx, { query: 'xyz123', repo: 'kb' });
    expect(result.section_matches.length).toBeGreaterThan(0);
  });

  // @convention T-017 Bug 4 — write_section on Table of Contents silently created a
  // phantom section in doc.sections (setSectionByPath's create-new-section branch,
  // since "Table of Contents" is never a real section), producing a duplicate
  // "## Table of Contents" heading instead of the reported "ok: true, no visible change".
  it('regression: rejects mode=set on the Table of Contents path instead of creating a phantom duplicate section', () => {
    expect(() => writeSection(ctx, {
      repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/Table of Contents', content: '- [[#Why]]',
    })).toThrow(/RESERVED_SECTION/);
    const raw = fs.readFileSync(SANDBOX_ALPHA(), 'utf-8');
    expect((raw.match(/## Table of Contents/g) || []).length).toBeLessThanOrEqual(1);
  });

  it('regression: rejects mode=insert on the Table of Contents path', () => {
    expect(() => writeSection(ctx, {
      repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/Table of Contents', content: 'X.',
      mode: 'insert', position: 'beginning',
    })).toThrow(/RESERVED_SECTION/);
  });

  it('regression: rejects mode=delete on the Table of Contents path', () => {
    expect(() => writeSection(ctx, {
      repo: 'kb', file: 'conventions/alpha.md', section: 'Alpha Convention/Table of Contents', mode: 'delete',
    })).toThrow(/RESERVED_SECTION/);
  });
});

// ---------------------------------------------------------------------------
// createDocument
// ---------------------------------------------------------------------------

describe('createDocument', () => {
  let writableRoot;

  beforeEach(() => {
    // Point repos.json at a writable sandbox repo instead of the read-only fixtures.
    writableRoot = path.join(SANDBOX, 'repo');
    fs.mkdirSync(writableRoot, { recursive: true });
    reposJsonPath = path.join(SANDBOX, 'repos-writable.json');
    fs.writeFileSync(reposJsonPath, JSON.stringify([
      { name: 'kb', root: writableRoot, db: path.join(SANDBOX, 'kb-writable.db') },
    ]));
    ctx.close();
    ctx = createContext(reposJsonPath);
  });

  it('scaffolds a new conformant document with Quick Start and Load when', () => {
    const result = createDocument(ctx, {
      repo: 'kb', file: 'conventions/gamma.md', title: 'Gamma Convention',
      quickStart: 'Covers the gamma widget.', loadWhen: 'Creating a gamma widget',
    });
    expect(result.ok).toBe(true);

    const raw = fs.readFileSync(path.join(writableRoot, 'conventions/gamma.md'), 'utf-8');
    expect(raw).toContain('# Gamma Convention');
    expect(raw).toContain('## Quick Start');
    expect(raw).toContain('Covers the gamma widget.');
    expect(raw).toContain('## Load when');
    expect(raw).toContain('Creating a gamma widget');
    expect(raw).toContain('## Table of Contents');

    const content = readSection(ctx, { repo: 'kb', file: 'conventions/gamma.md', section: 'Gamma Convention/Quick Start' });
    expect(content).toBe('Covers the gamma widget.');
  });

  it('includes optional subtitle, documentType, and language in the preamble', () => {
    createDocument(ctx, {
      repo: 'kb', file: 'conventions/delta.md', title: 'Delta Convention',
      subtitle: 'A short description.', documentType: 'Convention', language: 'French',
      quickStart: 'Covers delta.', loadWhen: 'Working with delta',
    });
    const raw = fs.readFileSync(path.join(writableRoot, 'conventions/delta.md'), 'utf-8');
    expect(raw).toContain('A short description.');
    expect(raw).toContain('*Document type: Convention*');
    expect(raw).toContain('*Language: French*');
  });

  it('indexes the new file so it is immediately searchable', () => {
    createDocument(ctx, {
      repo: 'kb', file: 'conventions/epsilon.md', title: 'Epsilon Convention',
      quickStart: 'Searchable epsilon marker xyz789.', loadWhen: 'Working with epsilon',
    });
    const result = search(ctx, { query: 'xyz789', repo: 'kb' });
    expect(result.section_matches.length).toBeGreaterThan(0);
  });

  it('throws FILE_EXISTS when the target file already exists', () => {
    createDocument(ctx, {
      repo: 'kb', file: 'conventions/zeta.md', title: 'Zeta Convention',
      quickStart: 'Covers zeta.', loadWhen: 'Working with zeta',
    });
    expect(() => createDocument(ctx, {
      repo: 'kb', file: 'conventions/zeta.md', title: 'Zeta Convention Again',
      quickStart: 'Covers zeta again.', loadWhen: 'Working with zeta again',
    })).toThrow(/FILE_EXISTS/);
  });

  it('throws MISSING_ARG when title is missing', () => {
    expect(() => createDocument(ctx, {
      repo: 'kb', file: 'conventions/eta.md', title: '',
      quickStart: 'Covers eta.', loadWhen: 'Working with eta',
    })).toThrow(/MISSING_ARG/);
  });

  it('throws MISSING_ARG when quickStart is missing', () => {
    expect(() => createDocument(ctx, {
      repo: 'kb', file: 'conventions/theta.md', title: 'Theta Convention',
      quickStart: '', loadWhen: 'Working with theta',
    })).toThrow(/MISSING_ARG/);
  });

  it('throws MISSING_ARG when loadWhen is missing', () => {
    expect(() => createDocument(ctx, {
      repo: 'kb', file: 'conventions/iota.md', title: 'Iota Convention',
      quickStart: 'Covers iota.', loadWhen: '',
    })).toThrow(/MISSING_ARG/);
  });

  it('throws REPO_NOT_FOUND for an unknown repo', () => {
    expect(() => createDocument(ctx, {
      repo: 'nope', file: 'conventions/kappa.md', title: 'Kappa Convention',
      quickStart: 'Covers kappa.', loadWhen: 'Working with kappa',
    })).toThrow(/REPO_NOT_FOUND/);
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

  // @convention conventions/mcp-doc-index.md [## What — Model > Exclude patterns]
  it('respects the repo exclude patterns from repos.json', () => {
    reposJsonPath = path.join(SANDBOX, 'repos.json');
    fs.writeFileSync(reposJsonPath, JSON.stringify([
      { name: 'kb', root: FIXTURES, db: path.join(SANDBOX, 'kb.db'), exclude: ['**/generated/**'] },
    ]));
    ctx.close();
    ctx = createContext(reposJsonPath);

    reindex(ctx, { repo: 'kb' });
    const result = search(ctx, { query: 'generated', repo: 'kb' });
    expect(result.section_matches.some(m => m.file_path.includes('output.md'))).toBe(false);
  });
});
