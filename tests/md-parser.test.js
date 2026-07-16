/**
 * md-parser.test.js
 *
 * Unit tests for lib/md-parser.js — parsing, section mutation, and
 * Table of Contents generation.
 *
 * @convention conventions/documentation.md [section TOC Rule]
 * @convention conventions/documentation.md [section Up Link Rule]
 * @convention conventions/mcp-doc-index.md [## How — Implementation > Design decisions]
 */

import { describe, it, expect } from 'vitest';
import {
  parseText, getSection, hasSection, getSectionByPath, hasSectionByPath, getSections,
  getIssues, isConformant,
  setSectionByPath, insertSectionAt, deleteSection,
  toMarkdown, buildTocLines,
} from '../lib/md-parser.js';

const FILE = 'test.md';

// ---------------------------------------------------------------------------
// parseText — basic structure
// ---------------------------------------------------------------------------

describe('parseText', () => {
  it('extracts title, subtitle, and sections', () => {
    const doc = parseText([
      '# Test Doc',
      '',
      'A short subtitle.',
      '',
      '## Quick Start',
      '',
      'Summary here.',
      '',
      '## Load when',
      'Some trigger.',
      '',
      '## Why',
      '',
      'Because reasons.',
    ].join('\n'), FILE);

    expect(doc.title).toBe('Test Doc');
    expect(doc.subtitle).toBe('A short subtitle.');
    expect(getSection(doc, 'Why')).toBe('Because reasons.');
    expect(hasSection(doc, 'Load when')).toBe(true);
  });

  // @convention conventions/documentation.md [section TOC Rule]
  it('discards a ## Table of Contents heading and its wikilink list on read', () => {
    const doc = parseText([
      '# Test Doc',
      '',
      '## Quick Start',
      'Summary.',
      '',
      '## Load when',
      'Trigger.',
      '',
      '## Table of Contents',
      '',
      '- [[#Why]]',
      '',
      '## Why',
      '[[#Quick Start]]',
      '',
      'Because reasons.',
    ].join('\n'), FILE);

    expect(hasSection(doc, 'Table of Contents')).toBe(false);
    expect(getSection(doc, 'Why')).toBe('Because reasons.');
  });

  // @convention none — backward compatibility for repos not yet migrated (e.g. ddscope)
  it('discards a legacy bare insta-toc codeblock without leaking into the preceding section', () => {
    const doc = parseText([
      '# Test Doc',
      '',
      '## Quick Start',
      'Summary.',
      '',
      '## Load when',
      'Trigger.',
      '',
      '---',
      '```insta-toc',
      '---',
      'title:',
      '  name: "Table of Contents"',
      '---',
      '```',
      '',
      '## Why',
      'Because reasons.',
    ].join('\n'), FILE);

    expect(getSection(doc, 'Load when')).toBe('Trigger.');
    expect(getSection(doc, 'Why')).toBe('Because reasons.');
    expect(hasSection(doc, 'Table of Contents')).toBe(false);
  });

  it('discards the [[#Quick Start]] up-link wikilink on read', () => {
    const doc = parseText([
      '# Test Doc',
      '',
      '## Quick Start',
      'Summary.',
      '',
      '## Why',
      '[[#Quick Start]]',
      '',
      'Because reasons.',
    ].join('\n'), FILE);

    expect(getSection(doc, 'Why')).toBe('Because reasons.');
  });
});

// ---------------------------------------------------------------------------
// Preamble — subtitle + Document type + Language declarations (T-017 Bug 2:
// only the first non-Language line survived, everything else was dropped)
// ---------------------------------------------------------------------------

describe('preamble (subtitle, Document type, Language declarations)', () => {
  // @convention conventions/documentation.md [section Document Structure]
  it('parseText captures every header-zone declaration line, not just the first', () => {
    const doc = parseText([
      '# Test Doc', '',
      'A short subtitle.', '',
      '*Document type: Reference*', '',
      '*Language: French*', '',
      '## Quick Start', 'S.', '',
      '## Load when', 'T.',
    ].join('\n'), FILE);

    expect(doc.preamble).toEqual([
      'A short subtitle.',
      '*Document type: Reference*',
      '*Language: French*',
    ]);
    expect(doc.subtitle).toBe('A short subtitle.');
    expect(doc.language).toBe('*Language: French*');
  });

  // @convention T-017 Bug 2 — write_section drops the document preamble
  it('toMarkdown round-trips all three preamble lines verbatim, not just subtitle+language', () => {
    const doc = parseText([
      '# Test Doc', '',
      'A short subtitle.', '',
      '*Document type: Reference*', '',
      '*Language: French*', '',
      '## Quick Start', 'S.', '',
      '## Load when', 'T.',
    ].join('\n'), FILE);

    const out = toMarkdown(doc);
    expect(out).toContain('A short subtitle.');
    expect(out).toContain('*Document type: Reference*');
    expect(out).toContain('*Language: French*');
  });

  it('a document with no preamble declarations has doc.preamble === null', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n', FILE);
    expect(doc.preamble).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getIssues / isConformant
// ---------------------------------------------------------------------------

describe('getIssues', () => {
  // @convention conventions/documentation.md [section Quick Start Rule]
  it('flags a missing ## Quick Start', () => {
    const doc = parseText('# Test Doc\n\n## Load when\nTrigger.\n', FILE);
    expect(getIssues(doc)).toContain('Missing ## Quick Start');
  });

  it('is conformant when both mandatory sections are present', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n\n## Load when\nT.\n', FILE);
    expect(isConformant(doc)).toBe(true);
  });

  // @convention conventions/documentation.md [section Headings]
  it('flags a ### duplicated under the same ## parent', () => {
    const doc = parseText([
      '# Test Doc', '',
      '## Quick Start', 'S.', '',
      '## Load when', 'T.', '',
      '## Why', '',
      '### Rule', 'A.', '',
      '### Rule', 'B.',
    ].join('\n'), FILE);
    expect(getIssues(doc)).toContain('Duplicate ### heading under ## Why: Rule');
  });

  // @convention conventions/mcp-doc-index.md [section Section granularity]
  it('does not flag the same ### name recurring under different ## parents', () => {
    const doc = parseText([
      '# Test Doc', '',
      '## Quick Start', 'S.', '',
      '## Load when', 'T.', '',
      '## Why', '',
      '### Rule', 'A.', '',
      '## What', '',
      '### Rule', 'B.',
    ].join('\n'), FILE);
    expect(isConformant(doc)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setSection / insertSectionAt / deleteSection
// ---------------------------------------------------------------------------

describe('section mutation — ## (H1/H2 paths)', () => {
  it('setSectionByPath overwrites an existing section', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n\n## Why\nOld.\n', FILE);
    setSectionByPath(doc, 'Test Doc/Why', 'New.');
    expect(getSection(doc, 'Why')).toBe('New.');
    expect(getSectionByPath(doc, 'Test Doc/Why')).toBe('New.');
  });

  it('setSectionByPath throws on a title mismatch', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n\n## Why\nOld.\n', FILE);
    expect(() => setSectionByPath(doc, 'Wrong Title/Why', 'New.')).toThrow();
  });

  it('insertSectionAt inserts a new ## section at the given position', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n\n## Why\nW.\n\n## What\nWh.\n', FILE);
    insertSectionAt(doc, 'Test Doc/How', 'H.', 'after:Test Doc/Why');
    const names = doc.sections.map(s => s.name);
    expect(names).toEqual(['Quick Start', 'Why', 'How', 'What']);
  });

  it('deleteSection removes a ## section', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n\n## Why\nW.\n', FILE);
    deleteSection(doc, 'Test Doc/Why');
    expect(hasSection(doc, 'Why')).toBe(false);
  });

  // @convention T-017 Bug 1 — write_section append-instead-of-replace on sections with subsections
  it('setSectionByPath replaces existing ### subsections when the new content embeds its own ### headings, instead of appending after them', () => {
    const doc = parseText([
      '# Test Doc', '',
      '## Quick Start', 'S.', '',
      '## Load when', 'T.', '',
      '## Meta-Model', '',
      '### Old Sub A', 'OldA.', '',
      '### Old Sub B', 'OldB.',
    ].join('\n'), FILE);

    setSectionByPath(doc, 'Test Doc/Meta-Model', [
      '### New Sub A',
      'NewA.',
      '',
      '### New Sub B',
      'NewB.',
    ].join('\n'));

    const metaModel = doc.sections.find(s => s.name === 'Meta-Model');
    expect(metaModel.subsections.map(s => s.name)).toEqual(['New Sub A', 'New Sub B']);
    expect(getSectionByPath(doc, 'Test Doc/Meta-Model/New Sub A')).toBe('NewA.');
    expect(getSectionByPath(doc, 'Test Doc/Meta-Model/New Sub B')).toBe('NewB.');
    expect(hasSectionByPath(doc, 'Test Doc/Meta-Model/Old Sub A')).toBe(false);
    expect(hasSectionByPath(doc, 'Test Doc/Meta-Model/Old Sub B')).toBe(false);
    expect(isConformant(doc)).toBe(true);
  });

  // @convention T-017 Bug 1 — full-replace semantics: content with no embedded ### clears any pre-existing subsections
  it('setSectionByPath clears pre-existing ### subsections when the new content has none', () => {
    const doc = parseText([
      '# Test Doc', '',
      '## Quick Start', 'S.', '',
      '## Meta-Model', '',
      '### Old Sub A', 'OldA.',
    ].join('\n'), FILE);

    setSectionByPath(doc, 'Test Doc/Meta-Model', 'Plain replacement, no subsections.');

    const metaModel = doc.sections.find(s => s.name === 'Meta-Model');
    expect(metaModel.subsections).toEqual([]);
    expect(getSectionByPath(doc, 'Test Doc/Meta-Model')).toBe('Plain replacement, no subsections.');
  });
});

describe('section mutation — ### (H1/H2/H3 paths)', () => {
  it('getSectionByPath reads a subsection\'s own content, not its siblings', () => {
    const doc = parseText([
      '# Test Doc', '',
      '## Quick Start', 'S.', '',
      '## Why', '',
      '### Detail A', 'A.', '',
      '### Detail B', 'B.',
    ].join('\n'), FILE);

    expect(getSectionByPath(doc, 'Test Doc/Why/Detail A')).toBe('A.');
    expect(getSectionByPath(doc, 'Test Doc/Why/Detail B')).toBe('B.');
    expect(hasSectionByPath(doc, 'Test Doc/Why/Detail C')).toBe(false);
  });

  it('getSectionByPath on the parent H1/H2 returns only the direct content, excluding subsections', () => {
    const doc = parseText([
      '# Test Doc', '',
      '## Quick Start', 'S.', '',
      '## Why', 'Intro.', '',
      '### Detail A', 'A.',
    ].join('\n'), FILE);

    expect(getSectionByPath(doc, 'Test Doc/Why')).toBe('Intro.');
    expect(getSectionByPath(doc, 'Test Doc/Why/Detail A')).toBe('A.');
  });

  it('the same ### name is addressable independently under different ## parents', () => {
    const doc = parseText([
      '# Test Doc', '',
      '## Quick Start', 'S.', '',
      '## Why', '',
      '### Rule', 'A.', '',
      '## What', '',
      '### Rule', 'B.',
    ].join('\n'), FILE);

    expect(getSectionByPath(doc, 'Test Doc/Why/Rule')).toBe('A.');
    expect(getSectionByPath(doc, 'Test Doc/What/Rule')).toBe('B.');
  });

  it('setSectionByPath creates a new ### under an existing ##', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n\n## Why\n', FILE);
    setSectionByPath(doc, 'Test Doc/Why/Detail', 'New.');
    expect(getSectionByPath(doc, 'Test Doc/Why/Detail')).toBe('New.');
  });

  it('setSectionByPath throws when the parent ## does not exist', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n', FILE);
    expect(() => setSectionByPath(doc, 'Test Doc/Missing/Detail', 'New.')).toThrow(/parent section not found/i);
  });

  it('insertSectionAt inserts a new ### among its parent\'s siblings', () => {
    const doc = parseText([
      '# Test Doc', '',
      '## Quick Start', 'S.', '',
      '## Why', '',
      '### Detail A', 'A.', '',
      '### Detail C', 'C.',
    ].join('\n'), FILE);

    insertSectionAt(doc, 'Test Doc/Why/Detail B', 'B.', 'after:Test Doc/Why/Detail A');
    const why = doc.sections.find(s => s.name === 'Why');
    expect(why.subsections.map(s => s.name)).toEqual(['Detail A', 'Detail B', 'Detail C']);
  });

  it('insertSectionAt returns PARENT_NOT_FOUND when the parent ## is missing', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n', FILE);
    const result = insertSectionAt(doc, 'Test Doc/Missing/Detail', 'X.', 'beginning');
    expect(result).toBe('PARENT_NOT_FOUND:Missing');
  });

  it('deleteSection removes a ### without affecting its siblings', () => {
    const doc = parseText([
      '# Test Doc', '',
      '## Quick Start', 'S.', '',
      '## Why', '',
      '### Detail A', 'A.', '',
      '### Detail B', 'B.',
    ].join('\n'), FILE);

    const deleted = deleteSection(doc, 'Test Doc/Why/Detail A');
    expect(deleted).toBe(true);
    expect(hasSectionByPath(doc, 'Test Doc/Why/Detail A')).toBe(false);
    expect(getSectionByPath(doc, 'Test Doc/Why/Detail B')).toBe('B.');
  });
});

describe('getSections', () => {
  it('returns one leaf per ## (direct content) and one per ###, with full H1/H2/H3 paths', () => {
    const doc = parseText([
      '# Test Doc', '',
      '## Quick Start', 'S.', '',
      '## Why', 'Intro.', '',
      '### Detail A', 'A.',
    ].join('\n'), FILE);

    const sections = getSections(doc);
    expect(sections).toContainEqual({ path: 'Test Doc/Quick Start', level: 2, content: 'S.' });
    expect(sections).toContainEqual({ path: 'Test Doc/Why', level: 2, content: 'Intro.' });
    expect(sections).toContainEqual({ path: 'Test Doc/Why/Detail A', level: 3, content: 'A.' });
  });

  // @convention conventions/mcp-doc-index.md [section Section granularity]
  it('falls back to the filename (without extension) as H1 when the document has no # Title', () => {
    const doc = parseText([
      '## Quick Start', 'S.', '',
      '## Definition', 'A term.',
    ].join('\n'), 'GLOSSARY/ITEMS/Some Term.md');

    expect(doc.title).toBeNull();
    const sections = getSections(doc);
    expect(sections).toContainEqual({ path: 'Some Term/Definition', level: 2, content: 'A term.' });
  });

  // @convention conventions/mcp-doc-index.md [section Section granularity]
  it('quotes a path segment that itself contains a / so the path stays splittable', () => {
    const doc = parseText([
      '# API Doc', '',
      '## Quick Start', 'S.', '',
      '## API Contract', '',
      '### GET /file', 'Reads a file.',
    ].join('\n'), FILE);

    const sections = getSections(doc);
    expect(sections).toContainEqual({
      path: 'API Doc/API Contract/"GET /file"', level: 3, content: 'Reads a file.',
    });
  });
});

describe('section addressing edge cases — title fallback and / escaping', () => {
  // @convention conventions/mcp-doc-index.md [section Section granularity]
  it('getSectionByPath resolves a title-less document via its filename', () => {
    const doc = parseText([
      '## Quick Start', 'S.', '',
      '## Definition', 'A term.',
    ].join('\n'), 'GLOSSARY/ITEMS/Some Term.md');

    expect(getSectionByPath(doc, 'Some Term/Definition')).toBe('A term.');
  });

  // @convention conventions/mcp-doc-index.md [section Section granularity]
  it('getSectionByPath and setSectionByPath round-trip a quoted / segment', () => {
    const doc = parseText([
      '# API Doc', '',
      '## Quick Start', 'S.', '',
      '## API Contract', '',
      '### GET /file', 'Reads a file.',
    ].join('\n'), FILE);

    expect(getSectionByPath(doc, 'API Doc/API Contract/"GET /file"')).toBe('Reads a file.');

    setSectionByPath(doc, 'API Doc/API Contract/"GET /file"', 'Updated.');
    expect(getSectionByPath(doc, 'API Doc/API Contract/"GET /file"')).toBe('Updated.');
  });
});

// ---------------------------------------------------------------------------
// YAML frontmatter — title-less items (TODO/AREAS/CHANGELOG) carry a YAML
// frontmatter block instead of a # Title; it must survive parse -> toMarkdown
// verbatim rather than being silently dropped (discovered while fixing T-016).
// ---------------------------------------------------------------------------

describe('YAML frontmatter (title-less items — TODO/AREAS/CHANGELOG)', () => {
  const withFrontmatter = [
    '---',
    'id: T-999',
    'Status: Todo',
    'importance: Medium',
    'effort: S',
    'type: todo',
    '---',
    '',
    '## Description',
    '',
    'Some description.',
    '',
    '## Notes',
    '',
    'Some notes.',
  ].join('\n');

  it('parseText captures the frontmatter verbatim and still parses sections on a title-less doc', () => {
    const doc = parseText(withFrontmatter, 'TODO/ITEMS/T-999 Some Item.md');
    expect(doc.title).toBeNull();
    expect(doc.frontmatter).toEqual([
      'id: T-999', 'Status: Todo', 'importance: Medium', 'effort: S', 'type: todo',
    ]);
    expect(getSection(doc, 'Description')).toBe('Some description.');
    expect(getSection(doc, 'Notes')).toBe('Some notes.');
  });

  it('toMarkdown round-trips the frontmatter block verbatim ahead of the content', () => {
    const doc = parseText(withFrontmatter, 'TODO/ITEMS/T-999 Some Item.md');
    const out = toMarkdown(doc);
    expect(out).toContain(
      '---\nid: T-999\nStatus: Todo\nimportance: Medium\neffort: S\ntype: todo\n---'
    );
    expect(out).toContain('## Description');
    expect(out).toContain('Some description.');
  });

  it('a document with no frontmatter block has doc.frontmatter === null', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n', FILE);
    expect(doc.frontmatter).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildTocLines — TOC generation
// ---------------------------------------------------------------------------

describe('buildTocLines', () => {
  // @convention conventions/documentation.md [section TOC Rule]
  it('generates a wikilink item per content section, excluding Quick Start / Load when', () => {
    const doc = parseText([
      '# Test Doc', '',
      '## Quick Start', 'S.', '',
      '## Load when', 'T.', '',
      '## Why', 'W.', '',
      '## What', 'Wh.',
    ].join('\n'), FILE);

    const toc = buildTocLines(doc);
    expect(toc).toContain('- [[#Why]]');
    expect(toc).toContain('- [[#What]]');
    expect(toc.some(l => l.includes('Quick Start'))).toBe(false);
    expect(toc.some(l => l.includes('Load when'))).toBe(false);
  });

  // @convention conventions/documentation.md [section Subsections]
  it('indents ### subsections as sub-items under their parent ## section', () => {
    const doc = parseText([
      '# Test Doc', '',
      '## Quick Start', 'S.', '',
      '## Why', '',
      '### Detail A',
      'Content A.', '',
      '### Detail B',
      'Content B.',
    ].join('\n'), FILE);

    const toc = buildTocLines(doc);
    const whyIdx = toc.indexOf('- [[#Why]]');
    expect(whyIdx).toBeGreaterThanOrEqual(0);
    expect(toc[whyIdx + 1]).toBe('  - [[#Detail A]]');
    expect(toc[whyIdx + 2]).toBe('  - [[#Detail B]]');
  });

  it('ends with a blank line for readability before the next section', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n\n## Why\nW.\n', FILE);
    const toc = buildTocLines(doc);
    expect(toc[toc.length - 1]).toBe('');
  });

  // @convention none — edge case, avoids false positives from fenced code content
  it('ignores lines starting with ### inside a fenced code block', () => {
    const doc = parseText([
      '# Test Doc', '',
      '## Quick Start', 'S.', '',
      '## Why', '',
      '```markdown',
      '### Not a real heading',
      '```',
    ].join('\n'), FILE);

    const toc = buildTocLines(doc);
    expect(toc.some(l => l.includes('Not a real heading'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toMarkdown — end-to-end TOC placement
// ---------------------------------------------------------------------------

describe('toMarkdown', () => {
  // @convention T-016 — write_section fails on title-less exempt documents
  it('reconstructs a title-less document without a # Title line, mirroring the read-side title fallback', () => {
    const doc = parseText([
      '## Quick Start', 'S.', '',
      '## Load when', 'T.', '',
      '## Definition', 'A term.',
    ].join('\n'), 'GLOSSARY/ITEMS/Some Term.md');

    expect(doc.title).toBeNull();
    const out = toMarkdown(doc);
    expect(out.split('\n')[0]).not.toMatch(/^# /);
    expect(out).toContain('## Definition');
    expect(out).toContain('A term.');
  });

  // @convention T-016 — write_section fails on title-less exempt documents
  it('does not throw for a fully empty title-less document', () => {
    const doc = parseText('', 'GLOSSARY/ITEMS/Empty.md');
    expect(() => toMarkdown(doc)).not.toThrow();
  });

  // @convention conventions/documentation.md [section Document Structure]
  it('places ## Table of Contents right after ## Load when', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n\n## Load when\nT.\n\n## Why\nW.\n', FILE);
    const out = toMarkdown(doc);
    const lines = out.split('\n');
    const loadWhenIdx = lines.indexOf('## Load when');
    const tocIdx = lines.indexOf('## Table of Contents');
    expect(tocIdx).toBeGreaterThan(loadWhenIdx);
    expect(lines[tocIdx + 1]).toBe('');
    expect(lines[tocIdx + 2]).toBe('- [[#Why]]');
  });

  it('inserts a blank line between the TOC list and the next section heading', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n\n## Load when\nT.\n\n## Why\nW.\n', FILE);
    const out = toMarkdown(doc);
    const lines = out.split('\n');
    const whyIdx = lines.indexOf('## Why');
    expect(lines[whyIdx - 1]).toBe('');
  });

  it('adds [[#Quick Start]] wikilink to every content section except excluded ones', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n\n## Why\nW.\n', FILE);
    const out = toMarkdown(doc);
    const lines = out.split('\n');
    const whyIdx = lines.indexOf('## Why');
    expect(lines[whyIdx + 1]).toBe('[[#Quick Start]]');
  });

  // @convention none — backward compatibility for repos not yet migrated (e.g. ddscope)
  it('regenerates a clean TOC when re-parsing a document that had a legacy insta-toc block', () => {
    const legacy = [
      '# Test Doc', '',
      '## Quick Start', 'S.', '',
      '## Load when', 'T.', '',
      '---',
      '```insta-toc',
      '---',
      'title:',
      '  name: "Table of Contents"',
      '---',
      '```', '',
      '## Why', 'W.',
    ].join('\n');

    const doc = parseText(legacy, FILE);
    const out = toMarkdown(doc);
    expect(out).not.toContain('insta-toc');
    expect(out).toContain('## Table of Contents');
    expect(out).toContain('- [[#Why]]');
  });
});
