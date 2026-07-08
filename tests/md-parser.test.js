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
  parseText, getSection, hasSection, getIssues, isConformant,
  setSection, insertSectionAt, deleteSection,
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
});

// ---------------------------------------------------------------------------
// setSection / insertSectionAt / deleteSection
// ---------------------------------------------------------------------------

describe('section mutation', () => {
  it('setSection overwrites an existing section', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n\n## Why\nOld.\n', FILE);
    setSection(doc, 'Why', 'New.');
    expect(getSection(doc, 'Why')).toBe('New.');
  });

  it('insertSectionAt inserts a new section at the given position', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n\n## Why\nW.\n\n## What\nWh.\n', FILE);
    insertSectionAt(doc, 'How', 'H.', 'after:Why');
    const names = doc.sections.map(s => s.name);
    expect(names).toEqual(['Quick Start', 'Why', 'How', 'What']);
  });

  it('deleteSection removes a section', () => {
    const doc = parseText('# Test Doc\n\n## Quick Start\nS.\n\n## Why\nW.\n', FILE);
    deleteSection(doc, 'Why');
    expect(hasSection(doc, 'Why')).toBe(false);
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
  it('throws when the document has no title', () => {
    const doc = parseText('', FILE);
    expect(() => toMarkdown(doc)).toThrow(/no title/);
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
