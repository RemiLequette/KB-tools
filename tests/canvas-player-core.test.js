/**
 * canvas-player-core.test.js
 *
 * Unit tests for lib/canvas-player-core.js — front matter parsing, style
 * cascade, presentation script parsing, group membership, step engine,
 * and focus-fit bounding box.
 *
 * @convention conventions/tools.md [section Tests]
 * @convention tools/canvas-player.md [section Micro-note Front Matter]
 * @convention tools/canvas-player.md [section Script Format]
 * @convention tools/canvas-player.md [section How It Works]
 * @convention conventions/color-palette.md
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseFrontMatter,
  resolveMicroNoteStyle,
  resolveText,
  parseMicroNoteBody,
  resolveBody,
  splitBodyIntoParagraphs,
  resolveTheme,
  resolveTransitionDuration,
  resolvePaletteTargets,
  isColorLiteral,
  interpolateColors,
  parsePalette,
  mergePalettes,
  resolveColor,
  resolveStyleColors,
  extractWikilinkTarget,
  resolveWikilink,
  classifyReference,
  buildNodeLookup,
  buildGroupLookup,
  resolveScriptSteps,
  parsePresentationScript,
  buildGroupMembership,
  applyStepDeltas,
  edgeAnchorPoint,
  computeEdgePath,
  resolveEdgeOffsets,
  computeFitBox,
} from '../lib/canvas-player-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'canvas-player-demo');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// ---------------------------------------------------------------------------
// parseFrontMatter
// ---------------------------------------------------------------------------

describe('parseFrontMatter', () => {
  // @convention tools/canvas-player.md [section Micro-note Front Matter]
  it('parses flat scalar fields, quoted and unquoted', () => {
    const fm = parseFrontMatter(readFixture('Node Intro.md'));
    expect(fm.shape).toBe('rounded');
    expect(fm.fill).toBe('#4A90D9');
    expect(fm['stroke-width']).toBe(2);
    expect(fm.icon).toBe('play');
    expect(fm.text).toBe('Introduction');
    expect(fm['text-fr']).toBe('Introduction');
  });

  // @convention tools/canvas-player.md [section Micro-note Front Matter]
  it('parses flat number properties (text-size, text-bold)', () => {
    const fm = parseFrontMatter(readFixture('Node Intro.md'));
    expect(fm['text-size']).toBe(16);
    expect(fm['text-bold']).toBe(true);
  });

  // @convention none — edge case, no specific convention applies
  it('parses a decimal number', () => {
    const fm = parseFrontMatter('---\nedge-width: 1.5\n---\n');
    expect(fm['edge-width']).toBe(1.5);
  });

  // @convention none — edge case, no specific convention applies
  it('returns an empty object when there is no front matter', () => {
    expect(parseFrontMatter('# Just a title\n\nbody text')).toEqual({});
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('parses an inline YAML list value (e.g. palette: several wikilinks)', () => {
    const fm = parseFrontMatter('---\npalette: ["[[Brand Colors]]", "[[Semantic Colors]]"]\n---\n');
    expect(fm.palette).toEqual(['[[Brand Colors]]', '[[Semantic Colors]]']);
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('still parses a single wikilink as a plain scalar', () => {
    const fm = parseFrontMatter('---\npalette: "[[Brand Colors]]"\n---\n');
    expect(fm.palette).toBe('[[Brand Colors]]');
  });
});

// ---------------------------------------------------------------------------
// extractWikilinkTarget
// ---------------------------------------------------------------------------

describe('extractWikilinkTarget', () => {
  // @convention conventions/obsidian-links.md [section Wikilink Syntax]
  it('strips brackets from a simple wikilink', () => {
    expect(extractWikilinkTarget('[[Demo.canvas]]')).toBe('Demo.canvas');
  });

  // @convention conventions/obsidian-links.md [section Wikilink Syntax]
  it('strips brackets from a wikilink containing a space', () => {
    expect(extractWikilinkTarget('[[Shared Style]]')).toBe('Shared Style');
  });
});

// ---------------------------------------------------------------------------
// resolveMicroNoteStyle — cascade
// ---------------------------------------------------------------------------

describe('resolveMicroNoteStyle', () => {
  // @convention tools/canvas-player.md [section Micro-note Front Matter]
  it('applies the style note first, then overrides with local properties', () => {
    const local = parseFrontMatter(readFixture('Node Concept.md'));
    const base = parseFrontMatter(readFixture('Shared Style.md'));
    const resolved = resolveMicroNoteStyle(local, base);

    // inherited from Shared Style, not overridden locally
    expect(resolved.shape).toBe('diamond');
    expect(resolved.stroke).toBe('#8A6D1A');
    expect(resolved['text-size']).toBe(14);
    expect(resolved['text-bold']).toBe(false);
    // overridden locally
    expect(resolved.fill).toBe('#27AE60');
    expect(resolved.text).toBe('Core Concept');
  });

  // @convention tools/canvas-player.md [section Micro-note Front Matter]
  it('returns the local front matter unchanged when there is no style reference', () => {
    const local = parseFrontMatter(readFixture('Node Conclusion.md'));
    expect(resolveMicroNoteStyle(local, null)).toEqual(local);
  });
});

// ---------------------------------------------------------------------------
// resolveText
// ---------------------------------------------------------------------------

describe('resolveText', () => {
  // @convention tools/canvas-player.md [section Micro-note Front Matter]
  it('returns the language override when present', () => {
    const style = { text: 'Conclusion', 'text-fr': 'Conclusion FR' };
    expect(resolveText(style, 'fr')).toBe('Conclusion FR');
  });

  // @convention tools/canvas-player.md [section Micro-note Front Matter]
  it('falls back to the default text when no override exists for the language', () => {
    const style = { text: 'Conclusion' };
    expect(resolveText(style, 'de')).toBe('Conclusion');
  });

  // @convention none — edge case, no specific convention applies
  it('returns an empty string when there is no text at all', () => {
    expect(resolveText({}, 'en')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseMicroNoteBody / resolveBody
// ---------------------------------------------------------------------------

describe('parseMicroNoteBody', () => {
  // @convention tools/canvas-player.md [section Micro-note Front Matter]
  it('splits the body into a map of lang -> section content, keyed by heading', () => {
    const fileText = [
      '---',
      'text: Intro',
      '---',
      '',
      '## en',
      'English content, on one or more lines.',
      '',
      '## fr',
      'Contenu en français.',
    ].join('\n');
    const body = parseMicroNoteBody(fileText);
    expect(body.en).toBe('English content, on one or more lines.');
    expect(body.fr).toBe('Contenu en français.');
  });

  // @convention tools/canvas-player.md [section Micro-note Front Matter]
  it('lowercases the heading token as the language key', () => {
    const fileText = ['---', '---', '', '## EN', 'Content'].join('\n');
    expect(parseMicroNoteBody(fileText).en).toBe('Content');
  });

  // @convention tools/canvas-player.md [section Micro-note Front Matter]
  it('ignores any text before the first heading (no unlabeled default section)', () => {
    const fileText = ['---', '---', '', 'Preamble, not attached to any language.', '', '## en', 'Real content'].join('\n');
    const body = parseMicroNoteBody(fileText);
    expect(body.en).toBe('Real content');
    expect(Object.keys(body)).toEqual(['en']);
  });

  // @convention none — edge case, no specific convention applies
  it('returns an empty object when the micro-note has no body sections', () => {
    expect(parseMicroNoteBody('---\ntext: Intro\n---\n')).toEqual({});
  });
});

describe('resolveBody', () => {
  // @convention tools/canvas-player.md [section Micro-note Front Matter]
  it('returns the section content for the active language', () => {
    expect(resolveBody({ en: 'Hello', fr: 'Bonjour' }, 'fr')).toBe('Bonjour');
  });

  // @convention tools/canvas-player.md [section Micro-note Front Matter]
  it('returns an empty string, silently, when the active language has no section', () => {
    expect(resolveBody({ en: 'Hello' }, 'fr')).toBe('');
  });

  // @convention none — edge case, no specific convention applies
  it('returns an empty string for an empty or missing body map', () => {
    expect(resolveBody({}, 'en')).toBe('');
    expect(resolveBody(undefined, 'en')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parsePresentationScript
// ---------------------------------------------------------------------------

describe('parsePresentationScript', () => {
  // @convention tools/canvas-player.md [section Script Format]
  it('extracts the canvas wikilink target from front matter', () => {
    const script = parsePresentationScript(readFixture('Demo Script.md'));
    expect(script.canvas).toBe('Demo.canvas');
  });

  // @convention regression: parsePresentationScript dropped the palette front-matter field, always resolving to an empty palette
  it('carries the palette front-matter field through, single wikilink or a list', () => {
    const single = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      'palette: "[[Brand Colors]]"',
      '---',
      '',
      '## Step 0',
      'show-focus: [[A]]',
    ].join('\n'));
    expect(single.palette).toBe('[[Brand Colors]]');

    const list = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      'palette: ["[[Brand Colors]]", "[[Semantic Colors]]"]',
      '---',
      '',
      '## Step 0',
      'show-focus: [[A]]',
    ].join('\n'));
    expect(list.palette).toEqual(['[[Brand Colors]]', '[[Semantic Colors]]']);
  });

  // @convention regression: resolvePaletteTargets(script) always returned [] because parsePresentationScript dropped `palette`
  it('the parsed script feeds resolvePaletteTargets correctly (end-to-end regression)', () => {
    const script = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      'palette: "[[Brand Colors]]"',
      '---',
      '',
      '## Step 0',
      'show-focus: [[A]]',
    ].join('\n'));
    expect(resolvePaletteTargets(script)).toEqual(['Brand Colors']);
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('extracts steps in order with their directive lists (raw tokens, not yet resolved)', () => {
    const script = parsePresentationScript(readFixture('Demo Script.md'));
    expect(script.steps).toHaveLength(3);
    expect(script.steps[0]).toEqual({
      show: ['[[Node Intro]]'], hide: [], inFocus: ['[[Node Intro]]'], outFocus: [], transition: 'fade', label: '0',
    });
    expect(script.steps[1]).toEqual({
      show: ['[Core Ideas]'], hide: [], inFocus: ['[Core Ideas]'], outFocus: ['[[Node Intro]]'], transition: 'fade', label: '1',
    });
    expect(script.steps[2]).toEqual({
      show: [], hide: ['[[Node Intro]]'], inFocus: ['[[Node Conclusion]]'], outFocus: ['[Core Ideas]'], transition: 'fade', label: '2',
    });
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('defaults transition to fade when not specified', () => {
    const script = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      '---',
      '',
      '## Step 0',
      'show: [a]',
      'in-focus: [a]',
    ].join('\n'));
    expect(script.steps[0].transition).toBe('fade');
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('uses an explicit transition: cut when specified', () => {
    const script = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      '---',
      '',
      '## Step 0',
      'show: [a]',
      'in-focus: [a]',
      'transition: cut',
    ].join('\n'));
    expect(script.steps[0].transition).toBe('cut');
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('expands show-focus into both the show and in-focus lists', () => {
    const script = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      '---',
      '',
      '## Step 0',
      'show-focus: [[Intro Note]], [Core Ideas]',
    ].join('\n'));
    expect(script.steps[0]).toEqual({
      show: ['[[Intro Note]]', '[Core Ideas]'],
      hide: [],
      inFocus: ['[[Intro Note]]', '[Core Ideas]'],
      outFocus: [],
      transition: 'fade',
      label: '0',
    });
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('expands hide-focus into both the hide and out-focus lists', () => {
    const script = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      '---',
      '',
      '## Step 0',
      'hide-focus: [[Intro Note]]',
    ].join('\n'));
    expect(script.steps[0]).toEqual({
      show: [], hide: ['[[Intro Note]]'], inFocus: [], outFocus: ['[[Intro Note]]'], transition: 'fade', label: '0',
    });
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('combines show-focus with a plain show/in-focus on the same step without overwriting either', () => {
    const script = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      '---',
      '',
      '## Step 0',
      'show: [[Background Note]]',
      'show-focus: [[Intro Note]]',
    ].join('\n'));
    expect(script.steps[0].show).toEqual(['[[Background Note]]', '[[Intro Note]]']);
    expect(script.steps[0].inFocus).toEqual(['[[Intro Note]]']);
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('expands show-focus-each into one show-focus step per target, in order', () => {
    const script = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      '---',
      '',
      '## Step 0',
      'show-focus: [[Intro Note]]',
      '',
      '## Step 1',
      'show-focus-each: [[A]], [[B]], [Group C]',
      'transition: cut',
    ].join('\n'));
    expect(script.steps).toHaveLength(4); // Step 0 + 3 generated from show-focus-each
    expect(script.steps[1]).toEqual({ show: ['[[A]]'], hide: [], inFocus: ['[[A]]'], outFocus: [], transition: 'cut', label: '1' });
    expect(script.steps[2]).toEqual({ show: ['[[B]]'], hide: [], inFocus: ['[[B]]'], outFocus: [], transition: 'cut', label: '1' });
    expect(script.steps[3]).toEqual({ show: ['[Group C]'], hide: [], inFocus: ['[Group C]'], outFocus: [], transition: 'cut', label: '1' });
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('reuses the same heading label on every step generated by show-focus-each', () => {
    const script = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      '---',
      '',
      '## Step 0',
      'show-focus: [[Intro Note]]',
      '',
      '## Step Reveal Items',
      'show-focus-each: [[A]], [[B]]',
    ].join('\n'));
    expect(script.steps[1].label).toBe('Reveal Items');
    expect(script.steps[2].label).toBe('Reveal Items');
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('defaults show-focus-each generated steps to transition: fade when not specified', () => {
    const script = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      '---',
      '',
      '## Step 0',
      'show-focus: [[Intro Note]]',
      '',
      '## Step 1',
      'show-focus-each: [[A]], [[B]]',
    ].join('\n'));
    expect(script.steps[1].transition).toBe('fade');
    expect(script.steps[2].transition).toBe('fade');
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('throws when show-focus-each is combined with another directive on the same step', () => {
    const source = [
      '---',
      'canvas: "[[X.canvas]]"',
      '---',
      '',
      '## Step 0',
      'show-focus: [[Intro Note]]',
      '',
      '## Step 1',
      'show-focus-each: [[A]], [[B]]',
      'hide: [[Intro Note]]',
    ].join('\n');
    expect(() => parsePresentationScript(source)).toThrow(/cannot be combined/);
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('throws when show-focus-each is used on Step 0', () => {
    const source = [
      '---',
      'canvas: "[[X.canvas]]"',
      '---',
      '',
      '## Step 0',
      'show-focus-each: [[A]], [[B]]',
    ].join('\n');
    expect(() => parsePresentationScript(source)).toThrow(/not allowed on Step 0/);
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('accepts a non-integer suffix after Step (e.g. 1.1, 1.2) as a distinct step heading', () => {
    const script = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      '---',
      '',
      '## Step 0',
      'show-focus: [[Intro]]',
      '',
      '## Step 1.1',
      'show-focus: [[A]]',
      '',
      '## Step 1.2',
      'show-focus: [[B]]',
      '',
      '## Step 1.3',
      'show-focus: [[C]]',
    ].join('\n'));
    expect(script.steps).toHaveLength(4);
    expect(script.steps[1].show).toEqual(['[[A]]']);
    expect(script.steps[2].show).toEqual(['[[B]]']);
    expect(script.steps[3].show).toEqual(['[[C]]']);
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('accepts an arbitrary text label after Step as a distinct step heading', () => {
    const script = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      '---',
      '',
      '## Step Intro',
      'show-focus: [[Intro]]',
      '',
      '## Step Core Ideas',
      'show-focus: [[Core]]',
    ].join('\n'));
    expect(script.steps).toHaveLength(2);
    expect(script.steps[0].show).toEqual(['[[Intro]]']);
    expect(script.steps[1].show).toEqual(['[[Core]]']);
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('accepts a bare Step heading with no suffix at all', () => {
    const script = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      '---',
      '',
      '## Step',
      'show-focus: [[Intro]]',
      '',
      '## Step',
      'show-focus: [[A]]',
    ].join('\n'));
    expect(script.steps).toHaveLength(2);
    expect(script.steps[1].show).toEqual(['[[A]]']);
  });

  // @convention none — edge case, no specific convention applies
  it('does not treat a heading with a different word after ## as a step boundary', () => {
    const script = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      '---',
      '',
      '## Step 0',
      'show-focus: [[Intro]]',
      '',
      '## Stepping Stones',
      'show-focus: [[A]]',
    ].join('\n'));
    // "## Stepping Stones" is not a valid Step heading (word boundary), so it
    // and everything after it stays merged into the single Step 0 block.
    expect(script.steps).toHaveLength(1);
    expect(script.steps[0].show).toEqual(['[[Intro]]', '[[A]]']);
  });

  // @convention tools/canvas-player.md [section Controls]
  it('captures the heading text as each step\'s label, trimmed', () => {
    const script = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      '---',
      '',
      '## Step   Intro   ',
      'show-focus: [[A]]',
    ].join('\n'));
    expect(script.steps[0].label).toBe('Intro');
  });

  // @convention tools/canvas-player.md [section Controls]
  it('captures an empty label for a bare Step heading with no suffix', () => {
    const script = parsePresentationScript([
      '---',
      'canvas: "[[X.canvas]]"',
      '---',
      '',
      '## Step',
      'show-focus: [[A]]',
    ].join('\n'));
    expect(script.steps[0].label).toBe('');
  });
});

// ---------------------------------------------------------------------------
// splitBodyIntoParagraphs — Obsidian-style line breaks (not strict
// CommonMark): a single newline forces a line break within the same
// paragraph; a blank line starts a new paragraph.
// ---------------------------------------------------------------------------

describe('splitBodyIntoParagraphs', () => {
  // @convention tools/canvas-player.md [section Micro-note Front Matter]
  it('returns a single paragraph with a single line for plain text', () => {
    expect(splitBodyIntoParagraphs('Hello world')).toEqual([['Hello world']]);
  });

  // @convention tools/canvas-player.md [section Micro-note Front Matter]
  it('keeps a single newline as a forced line break within the same paragraph', () => {
    expect(splitBodyIntoParagraphs('Line one\nLine two')).toEqual([['Line one', 'Line two']]);
  });

  // @convention tools/canvas-player.md [section Micro-note Front Matter]
  it('starts a new paragraph on a blank line', () => {
    expect(splitBodyIntoParagraphs('Para one\n\nPara two')).toEqual([['Para one'], ['Para two']]);
  });

  // @convention tools/canvas-player.md [section Micro-note Front Matter]
  it('collapses multiple consecutive blank lines into a single paragraph break', () => {
    expect(splitBodyIntoParagraphs('Para one\n\n\n\nPara two')).toEqual([['Para one'], ['Para two']]);
  });

  // @convention none — edge case, no specific convention applies
  it('treats a whitespace-only line as blank', () => {
    expect(splitBodyIntoParagraphs('Para one\n   \nPara two')).toEqual([['Para one'], ['Para two']]);
  });

  // @convention none — edge case, no specific convention applies
  it('trims each line', () => {
    expect(splitBodyIntoParagraphs('  Line one  \n  Line two  ')).toEqual([['Line one', 'Line two']]);
  });

  // @convention none — edge case, no specific convention applies
  it('normalizes CRLF line endings', () => {
    expect(splitBodyIntoParagraphs('Line one\r\nLine two\r\n\r\nPara two')).toEqual([['Line one', 'Line two'], ['Para two']]);
  });

  // @convention none — edge case, no specific convention applies
  it('returns an empty array for an empty or blank-only string', () => {
    expect(splitBodyIntoParagraphs('')).toEqual([]);
    expect(splitBodyIntoParagraphs('   \n  \n ')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveTheme
// ---------------------------------------------------------------------------

describe('resolveTheme', () => {
  // @convention tools/canvas-player.md [section Script Format]
  it('defaults to the dark preset when no theme is specified', () => {
    expect(resolveTheme({})).toEqual({ background: '#1e1e1e', edge: '#888', text: '#fff', edgeWidth: 1.5 });
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('selects the light preset when theme: light is specified', () => {
    expect(resolveTheme({ theme: 'light' })).toEqual({ background: '#f5f5f5', edge: '#999', text: '#1e1e1e', edgeWidth: 1.5 });
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('overrides only the background when background is specified, keeping the rest of the preset', () => {
    expect(resolveTheme({ theme: 'light', background: '#ffffff' }))
      .toEqual({ background: '#ffffff', edge: '#999', text: '#1e1e1e', edgeWidth: 1.5 });
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('overrides only the edge color when edge-color is specified', () => {
    expect(resolveTheme({ 'edge-color': '#ff0000' }))
      .toEqual({ background: '#1e1e1e', edge: '#ff0000', text: '#fff', edgeWidth: 1.5 });
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('overrides only the edge width when edge-width is specified', () => {
    expect(resolveTheme({ 'edge-width': 3 }))
      .toEqual({ background: '#1e1e1e', edge: '#888', text: '#fff', edgeWidth: 3 });
  });

  // @convention none — edge case, no specific convention applies
  it('falls back to the dark preset for an unknown theme name', () => {
    expect(resolveTheme({ theme: 'neon' })).toEqual({ background: '#1e1e1e', edge: '#888', text: '#fff', edgeWidth: 1.5 });
  });

  // @convention conventions/color-palette.md [section Name vs hex]
  it('resolves a named background color against a given palette', () => {
    const theme = resolveTheme({ background: 'primary' }, { primary: '#3b82f6' });
    expect(theme.background).toBe('#3b82f6');
  });

  // @convention conventions/color-palette.md [section Name vs hex]
  it('resolves a named edge color against a given palette', () => {
    const theme = resolveTheme({ 'edge-color': 'danger' }, { danger: '#ef4444' });
    expect(theme.edge).toBe('#ef4444');
  });

  // @convention conventions/color-palette.md [section Name vs hex]
  it('still accepts a literal hex for background/edge-color when a palette is given', () => {
    const theme = resolveTheme({ background: '#ffffff', 'edge-color': '#000000' }, { primary: '#3b82f6' });
    expect(theme.background).toBe('#ffffff');
    expect(theme.edge).toBe('#000000');
  });

  // @convention conventions/color-palette.md [section Name vs hex]
  it('throws when background/edge-color is an unresolved name', () => {
    expect(() => resolveTheme({ background: 'unknown' }, {})).toThrow(/Unresolved color name/);
  });

  // @convention conventions/color-palette.md [section Name vs hex]
  it('identifies background vs edge-color in the unresolved-name error', () => {
    expect(() => resolveTheme({ background: 'unknown' }, {})).toThrow(/\(background\)/);
    expect(() => resolveTheme({ 'edge-color': 'unknown' }, {})).toThrow(/\(edge-color\)/);
  });
});

// ---------------------------------------------------------------------------
// resolvePaletteTargets / parsePalette / mergePalettes / resolveColor /
// resolveStyleColors — see conventions/color-palette.md
// ---------------------------------------------------------------------------

describe('resolvePaletteTargets', () => {
  // @convention conventions/color-palette.md [section Contract for consuming tools]
  it('returns an empty list when palette is absent from front matter', () => {
    expect(resolvePaletteTargets({})).toEqual([]);
  });

  // @convention conventions/color-palette.md [section Contract for consuming tools]
  it('normalizes a single wikilink string into a one-item target list', () => {
    expect(resolvePaletteTargets({ palette: '[[Brand Colors]]' })).toEqual(['Brand Colors']);
  });

  // @convention conventions/color-palette.md [section Merging several palettes]
  it('normalizes a list of wikilinks, stripping brackets from each, preserving order', () => {
    expect(resolvePaletteTargets({ palette: ['[[Brand Colors]]', '[[Semantic Colors]]'] }))
      .toEqual(['Brand Colors', 'Semantic Colors']);
  });
});

describe('isColorLiteral', () => {
  // @convention conventions/color-palette.md [section Name vs hex]
  it('accepts a literal hex value', () => {
    expect(isColorLiteral('#3b82f6')).toBe(true);
  });

  // @convention conventions/color-palette.md [section Name vs hex]
  it('accepts a standard CSS color name, case-insensitively', () => {
    expect(isColorLiteral('coral')).toBe(true);
    expect(isColorLiteral('CornflowerBlue')).toBe(true);
  });

  // @convention conventions/color-palette.md [section Name vs hex]
  it('rejects a name that is neither a hex literal nor a standard CSS color name', () => {
    expect(isColorLiteral('primary')).toBe(false);
  });
});

describe('interpolateColors', () => {
  // @convention conventions/color-palette.md [section Palette Note/Generated gradients]
  it('returns the exact start and end hex as the first and last steps', () => {
    const steps = interpolateColors('#000000', '#ffffff', 3);
    expect(steps[0]).toBe('#000000');
    expect(steps[2]).toBe('#ffffff');
  });

  // @convention conventions/color-palette.md [section Palette Note/Generated gradients]
  it('interpolates evenly in RGB space between the endpoints', () => {
    expect(interpolateColors('#000000', '#ffffff', 3)).toEqual(['#000000', '#808080', '#ffffff']);
  });

  // @convention conventions/color-palette.md [section Palette Note/Generated gradients]
  it('expands 3-digit shorthand hex before interpolating', () => {
    expect(interpolateColors('#000', '#fff', 2)).toEqual(['#000000', '#ffffff']);
  });

  // @convention conventions/color-palette.md [section Palette Note/Generated gradients]
  it('returns count entries', () => {
    expect(interpolateColors('#000000', '#ffffff', 5)).toHaveLength(5);
  });

  // @convention conventions/color-palette.md [section Palette Note/Generated gradients]
  it('throws when count is less than 2', () => {
    expect(() => interpolateColors('#000000', '#ffffff', 1)).toThrow(/count/);
  });

  // @convention none — edge case, no specific convention applies
  it('throws on a malformed hex endpoint', () => {
    expect(() => interpolateColors('#zzzzzz', '#ffffff', 2)).toThrow(/Invalid hex color/);
  });
});

describe('parsePalette', () => {
  // @convention conventions/color-palette.md [section Palette Note/Format]
  it('extracts string-valued front matter entries as a name -> hex map', () => {
    const fm = parseFrontMatter('---\nprimary: "#3b82f6"\nsecondary: "#10b981"\n---\n');
    expect(parsePalette(fm)).toEqual({ primary: '#3b82f6', secondary: '#10b981' });
  });

  // @convention conventions/color-palette.md [section Palette Note/Format]
  it('accepts a standard CSS color name as a palette entry value', () => {
    const fm = parseFrontMatter('---\nprimary: coral\nsecondary: "rebeccapurple"\n---\n');
    expect(parsePalette(fm)).toEqual({ primary: 'coral', secondary: 'rebeccapurple' });
  });

  // @convention none — edge case, no specific convention applies
  it('ignores non-string entries', () => {
    expect(parsePalette({ primary: '#3b82f6', weight: 2, flag: true })).toEqual({ primary: '#3b82f6' });
  });

  // @convention conventions/color-palette.md [section Palette Note/Format]
  it('throws on a palette entry that is neither a hex literal nor a standard CSS color name', () => {
    expect(() => parsePalette({ primary: 'bluee' })).toThrow(/Invalid palette entry/);
  });

  // @convention conventions/color-palette.md [section Palette Note/Generated gradients]
  it('expands a gradient spec into <key>-1..<key>-N generated entries', () => {
    const palette = parsePalette({ primary: '#000000 -> #ffffff (3)' });
    expect(palette).toEqual({ 'primary-1': '#000000', 'primary-2': '#808080', 'primary-3': '#ffffff' });
    expect(palette.primary).toBeUndefined();
  });

  // @convention conventions/color-palette.md [section Palette Note/Generated gradients]
  it('accepts extra whitespace around the arrow and count in a gradient spec', () => {
    const palette = parsePalette({ primary: '#000000  ->  #ffffff  ( 3 )' });
    expect(Object.keys(palette)).toEqual(['primary-1', 'primary-2', 'primary-3']);
  });

  // @convention conventions/color-palette.md [section Palette Note/Generated gradients]
  it('coexists with plain color entries in the same palette note', () => {
    const palette = parsePalette({ danger: '#ef4444', primary: '#000000 -> #ffffff (2)' });
    expect(palette).toEqual({ danger: '#ef4444', 'primary-1': '#000000', 'primary-2': '#ffffff' });
  });

  // @convention conventions/color-palette.md [section Palette Note/Generated gradients]
  it('throws a clear error on an invalid gradient spec, naming the offending entry', () => {
    expect(() => parsePalette({ primary: '#000000 -> #ffffff (1)' })).toThrow(/Invalid gradient entry "primary/);
  });
});

describe('mergePalettes', () => {
  // @convention conventions/color-palette.md [section Merging several palettes]
  it('merges several palettes in list order, later entries overriding earlier ones on name collision', () => {
    const brand = { primary: '#3b82f6', danger: '#ef4444' };
    const semantic = { primary: '#111111' };
    expect(mergePalettes([brand, semantic])).toEqual({ primary: '#111111', danger: '#ef4444' });
  });

  // @convention none — edge case, no specific convention applies
  it('returns an empty object for an empty list', () => {
    expect(mergePalettes([])).toEqual({});
  });
});

describe('resolveColor', () => {
  // @convention conventions/color-palette.md [section Name vs hex]
  it('returns a literal hex value unchanged', () => {
    expect(resolveColor('#3b82f6', {})).toBe('#3b82f6');
  });

  // @convention conventions/color-palette.md [section Name vs hex]
  it('resolves a name against the palette', () => {
    expect(resolveColor('primary', { primary: '#3b82f6' })).toBe('#3b82f6');
  });

  // @convention conventions/color-palette.md [section Name vs hex]
  it('accepts a standard CSS color name and returns it unchanged', () => {
    expect(resolveColor('coral', {})).toBe('coral');
    expect(resolveColor('CornflowerBlue', {})).toBe('CornflowerBlue');
  });

  // @convention conventions/color-palette.md [section Name vs hex]
  it('prefers a palette entry over a same-named standard CSS color', () => {
    expect(resolveColor('tomato', { tomato: '#111111' })).toBe('#111111');
  });

  // @convention conventions/color-palette.md [section Name vs hex]
  it('throws on an unresolved name, not a silent fallback', () => {
    expect(() => resolveColor('primary', {})).toThrow(/Unresolved color name/);
  });

  // @convention conventions/color-palette.md [section Name vs hex]
  it('includes the given field in the unresolved-name error, for traceability', () => {
    expect(() => resolveColor('primary', {}, 'fill')).toThrow(/Unresolved color name "primary" \(fill\)/);
  });

  // @convention none — edge case, no specific convention applies
  it('omits the field parenthetical when no field is given', () => {
    expect(() => resolveColor('primary', {})).toThrow('Unresolved color name "primary" — not a hex literal');
  });

  // @convention none — edge case, no specific convention applies
  it('passes through null/undefined unchanged', () => {
    expect(resolveColor(undefined, {})).toBeUndefined();
    expect(resolveColor(null, {})).toBeNull();
  });
});

describe('resolveStyleColors', () => {
  // @convention conventions/color-palette.md [section Contract for consuming tools]
  it('resolves fill and stroke against the palette, leaving other properties unchanged', () => {
    const style = { shape: 'circle', fill: 'primary', stroke: 'danger', 'stroke-width': 2 };
    const palette = { primary: '#3b82f6', danger: '#ef4444' };
    expect(resolveStyleColors(style, palette)).toEqual({
      shape: 'circle', fill: '#3b82f6', stroke: '#ef4444', 'stroke-width': 2,
    });
  });

  // @convention conventions/color-palette.md [section Name vs hex]
  it('identifies fill vs stroke in the unresolved-name error', () => {
    expect(() => resolveStyleColors({ fill: 'unknown' }, {})).toThrow(/\(fill\)/);
    expect(() => resolveStyleColors({ stroke: 'unknown' }, {})).toThrow(/\(stroke\)/);
  });

  // @convention conventions/color-palette.md [section Name vs hex]
  it('leaves literal hex fill/stroke unchanged', () => {
    const style = { fill: '#000000', stroke: '#ffffff' };
    expect(resolveStyleColors(style, {})).toEqual({ fill: '#000000', stroke: '#ffffff' });
  });

  // @convention none — edge case, no specific convention applies
  it('passes through a style with no fill/stroke unchanged', () => {
    const style = { shape: 'rect' };
    expect(resolveStyleColors(style, {})).toEqual({ shape: 'rect' });
  });

  // @convention conventions/color-palette.md [section Name vs hex]
  it('throws on an unresolved fill name', () => {
    expect(() => resolveStyleColors({ fill: 'unknown' }, {})).toThrow(/Unresolved color name/);
  });
});

// ---------------------------------------------------------------------------
// resolveTransitionDuration
// ---------------------------------------------------------------------------

describe('resolveTransitionDuration', () => {
  // @convention tools/canvas-player.md [section Script Format]
  it('defaults to 1 second when not specified', () => {
    expect(resolveTransitionDuration({})).toBe(1);
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('uses the specified duration, including decimals', () => {
    expect(resolveTransitionDuration({ 'transition-duration': 0.3 })).toBe(0.3);
    expect(resolveTransitionDuration({ 'transition-duration': 2 })).toBe(2);
  });

  // @convention none — edge case, no specific convention applies
  it('defaults to 1 second for a negative or non-numeric value', () => {
    expect(resolveTransitionDuration({ 'transition-duration': -1 })).toBe(1);
    expect(resolveTransitionDuration({ 'transition-duration': 'fast' })).toBe(1);
  });

  // @convention none — edge case, no specific convention applies
  it('accepts 0 as an explicit instantaneous duration', () => {
    expect(resolveTransitionDuration({ 'transition-duration': 0 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveWikilink
// ---------------------------------------------------------------------------

describe('resolveWikilink', () => {
  // @convention tools/canvas-player.md [section How It Works]
  it('resolves a target to its vault-relative path via the vault index', () => {
    const vaultIndex = new Map([['Node Intro.md', ['KB/tools/canvas-player-demo/Node Intro.md']]]);
    expect(resolveWikilink('Node Intro', vaultIndex)).toBe('KB/tools/canvas-player-demo/Node Intro.md');
  });

  // @convention tools/canvas-player.md [section How It Works]
  it('throws when the target matches no file in the vault', () => {
    expect(() => resolveWikilink('Missing Note', new Map())).toThrow(/not found/);
  });

  // @convention tools/canvas-player.md [section How It Works]
  it('throws when the target matches more than one file in the vault', () => {
    const vaultIndex = new Map([['Node Intro.md', ['a/Node Intro.md', 'b/Node Intro.md']]]);
    expect(() => resolveWikilink('Node Intro', vaultIndex)).toThrow(/Ambiguous/);
  });
});

// ---------------------------------------------------------------------------
// classifyReference
// ---------------------------------------------------------------------------

describe('classifyReference', () => {
  // @convention tools/canvas-player.md [section Script Format]
  it('classifies a wikilink token as a node reference', () => {
    expect(classifyReference('[[Node Intro]]')).toEqual({ type: 'node', target: 'Node Intro' });
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('classifies a bracketed label token as a group reference', () => {
    expect(classifyReference('[Core Ideas]')).toEqual({ type: 'group', label: 'Core Ideas' });
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('throws on a token with no brackets at all', () => {
    expect(() => classifyReference('Core Ideas')).toThrow(/Invalid script target syntax/);
  });
});

// ---------------------------------------------------------------------------
// buildNodeLookup / buildGroupLookup
// ---------------------------------------------------------------------------

describe('buildNodeLookup', () => {
  // @convention tools/canvas-player.md [section Script Format]
  it('maps each micro-note file path to its node id', () => {
    const canvas = JSON.parse(readFixture('Demo.canvas'));
    const fileNodes = canvas.nodes.filter(n => n.type === 'file');
    const lookup = buildNodeLookup(fileNodes);
    expect(lookup.get('tools/canvas-player-demo/Node Intro.md')).toBe('nodeIntro');
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('throws when a micro-note is linked by more than one node', () => {
    const fileNodes = [{ id: 'a', file: 'Note.md' }, { id: 'b', file: 'Note.md' }];
    expect(() => buildNodeLookup(fileNodes)).toThrow(/Ambiguous/);
  });
});

describe('buildGroupLookup', () => {
  // @convention tools/canvas-player.md [section Script Format]
  it('maps each group label to its group id', () => {
    const canvas = JSON.parse(readFixture('Demo.canvas'));
    const groupNodes = canvas.nodes.filter(n => n.type === 'group');
    const lookup = buildGroupLookup(groupNodes);
    expect(lookup.get('Core Ideas')).toBe('groupDemo');
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('throws on a duplicate group label', () => {
    const groupNodes = [{ id: 'g1', label: 'X' }, { id: 'g2', label: 'X' }];
    expect(() => buildGroupLookup(groupNodes)).toThrow(/Ambiguous/);
  });

  // @convention none — edge case, no specific convention applies
  it('skips unlabeled groups', () => {
    expect(buildGroupLookup([{ id: 'g1' }]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveScriptSteps
// ---------------------------------------------------------------------------

describe('resolveScriptSteps', () => {
  // @convention tools/canvas-player.md [section Script Format]
  it('resolves wikilink and group-label tokens to canvas ids, end to end on the demo fixtures', () => {
    const canvas = JSON.parse(readFixture('Demo.canvas'));
    const script = parsePresentationScript(readFixture('Demo Script.md'));
    const fileNodes = canvas.nodes.filter(n => n.type === 'file');
    const groupNodes = canvas.nodes.filter(n => n.type === 'group');
    const nodeLookup = buildNodeLookup(fileNodes);
    const groupLookup = buildGroupLookup(groupNodes);
    const vaultIndex = new Map(fileNodes.map(n => [n.file.split('/').pop(), [n.file]]));

    const steps = resolveScriptSteps(script.steps, { nodeLookup, groupLookup, vaultIndex });

    expect(steps[0]).toEqual({ show: ['nodeIntro'], hide: [], inFocus: ['nodeIntro'], outFocus: [], transition: 'fade', label: '0' });
    expect(steps[1]).toEqual({ show: ['groupDemo'], hide: [], inFocus: ['groupDemo'], outFocus: ['nodeIntro'], transition: 'fade', label: '1' });
    expect(steps[2]).toEqual({ show: [], hide: ['nodeIntro'], inFocus: ['nodeConclusion'], outFocus: ['groupDemo'], transition: 'fade', label: '2' });
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('throws a clear error when a script wikilink does not resolve to any vault file', () => {
    const steps = [{ show: ['[[Missing Note]]'], hide: [], inFocus: [], outFocus: [], transition: 'cut' }];
    expect(() => resolveScriptSteps(steps, { nodeLookup: new Map(), groupLookup: new Map(), vaultIndex: new Map() }))
      .toThrow(/not found/);
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('throws a clear error when a script group label does not match any group', () => {
    const steps = [{ show: ['[Unknown Label]'], hide: [], inFocus: [], outFocus: [], transition: 'cut' }];
    expect(() => resolveScriptSteps(steps, { nodeLookup: new Map(), groupLookup: new Map(), vaultIndex: new Map() }))
      .toThrow(/No group/);
  });
});

// ---------------------------------------------------------------------------
// edgeAnchorPoint / computeEdgePath
// ---------------------------------------------------------------------------

describe('edgeAnchorPoint', () => {
  const node = { x: 100, y: 50, width: 200, height: 100 };

  // @convention tools/canvas-player.md [section Concepts/Canvas]
  it('returns the midpoint of the requested side', () => {
    expect(edgeAnchorPoint(node, 'top')).toEqual({ x: 200, y: 50 });
    expect(edgeAnchorPoint(node, 'bottom')).toEqual({ x: 200, y: 150 });
    expect(edgeAnchorPoint(node, 'left')).toEqual({ x: 100, y: 100 });
    expect(edgeAnchorPoint(node, 'right')).toEqual({ x: 300, y: 100 });
  });

  // @convention none — edge case, no specific convention applies
  it('falls back to the node center for an unknown or missing side', () => {
    expect(edgeAnchorPoint(node, undefined)).toEqual({ x: 200, y: 100 });
    expect(edgeAnchorPoint(node, 'diagonal')).toEqual({ x: 200, y: 100 });
  });
});

describe('computeEdgePath', () => {
  // @convention tools/canvas-player.md [section Concepts/Canvas]
  it('anchors the path on the given sides and bows control points outward from each side', () => {
    const from = { x: 0, y: 0, width: 100, height: 100 };
    const to = { x: 300, y: 0, width: 100, height: 100 };
    const { p1, c1, c2, p2 } = computeEdgePath(from, 'right', to, 'left');

    expect(p1).toEqual({ x: 100, y: 50 });
    expect(p2).toEqual({ x: 300, y: 50 });
    // control points bow outward: c1 further right than p1, c2 further left than p2
    expect(c1.x).toBeGreaterThan(p1.x);
    expect(c2.x).toBeLessThan(p2.x);
    expect(c1.y).toBe(p1.y);
    expect(c2.y).toBe(p2.y);
  });

  // @convention none — edge case, no specific convention applies
  it('clamps the control-point offset between a minimum and maximum', () => {
    const closeFrom = { x: 0, y: 0, width: 10, height: 10 };
    const closeTo = { x: 20, y: 0, width: 10, height: 10 };
    const { p1, c1 } = computeEdgePath(closeFrom, 'right', closeTo, 'left');
    expect(c1.x - p1.x).toBe(40); // clamped to the source minimum, not half the (short) distance

    const farFrom = { x: 0, y: 0, width: 10, height: 10 };
    const farTo = { x: 10000, y: 0, width: 10, height: 10 };
    const { p1: fp1, c1: fc1 } = computeEdgePath(farFrom, 'right', farTo, 'left');
    expect(fc1.x - fp1.x).toBe(120); // clamped to the source maximum
  });

  // @convention tools/canvas-player.md [section Concepts/Canvas]
  it('defaults the target-end offset larger than the source-end offset', () => {
    const from = { x: 0, y: 0, width: 10, height: 10 };
    const to = { x: 10000, y: 0, width: 10, height: 10 };
    const { p1, c1, p2, c2 } = computeEdgePath(from, 'right', to, 'left');
    expect(c1.x - p1.x).toBe(120); // source clamp max
    expect(p2.x - c2.x).toBe(200); // target clamp max, larger than the source's
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('uses a fixed sourceOffset/targetOffset when given, instead of the distance-based default', () => {
    const from = { x: 0, y: 0, width: 10, height: 10 };
    const to = { x: 300, y: 0, width: 10, height: 10 };
    const { p1, c1, c2, p2 } = computeEdgePath(from, 'right', to, 'left', { sourceOffset: 15, targetOffset: 250 });
    expect(c1.x - p1.x).toBe(15);
    expect(p2.x - c2.x).toBe(250);
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('falls back to the distance-based default for an end left unset in the offsets object', () => {
    const from = { x: 0, y: 0, width: 10, height: 10 };
    const to = { x: 10000, y: 0, width: 10, height: 10 };
    const { p1, c1, p2, c2 } = computeEdgePath(from, 'right', to, 'left', { sourceOffset: 15 });
    expect(c1.x - p1.x).toBe(15);       // explicit override
    expect(p2.x - c2.x).toBe(200);      // targetOffset unset -> distance-based default (clamped to max)
  });
});

// ---------------------------------------------------------------------------
// resolveEdgeOffsets
// ---------------------------------------------------------------------------

describe('resolveEdgeOffsets', () => {
  // @convention tools/canvas-player.md [section Script Format]
  it('returns undefined for both ends when neither is specified', () => {
    expect(resolveEdgeOffsets({})).toEqual({ sourceOffset: undefined, targetOffset: undefined });
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('applies edge-offset to both ends when edge-target-offset is not specified', () => {
    expect(resolveEdgeOffsets({ 'edge-offset': 100 })).toEqual({ sourceOffset: 100, targetOffset: 100 });
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('lets edge-target-offset override just the target end, keeping edge-offset on the source end', () => {
    expect(resolveEdgeOffsets({ 'edge-offset': 100, 'edge-target-offset': 200 }))
      .toEqual({ sourceOffset: 100, targetOffset: 200 });
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('accepts edge-target-offset alone, leaving the source end unset (distance-based default)', () => {
    expect(resolveEdgeOffsets({ 'edge-target-offset': 200 })).toEqual({ sourceOffset: undefined, targetOffset: 200 });
  });
});

// ---------------------------------------------------------------------------
// buildGroupMembership
// ---------------------------------------------------------------------------

describe('buildGroupMembership', () => {
  // @convention tools/canvas-player.md [section Concepts/Canvas]
  it('maps a group id to the file nodes positioned inside its bounding box', () => {
    const canvas = JSON.parse(readFixture('Demo.canvas'));
    const membership = buildGroupMembership(canvas);
    expect(membership.get('groupDemo').sort()).toEqual(['nodeConcept', 'nodeConclusion']);
  });

  // @convention tools/canvas-player.md [section Concepts/Canvas]
  it('does not include a node outside the group bounding box', () => {
    const canvas = JSON.parse(readFixture('Demo.canvas'));
    const membership = buildGroupMembership(canvas);
    expect(membership.get('groupDemo')).not.toContain('nodeIntro');
  });
});

// ---------------------------------------------------------------------------
// applyStepDeltas — the step engine
// ---------------------------------------------------------------------------

describe('applyStepDeltas', () => {
  const canvas = { nodes: [
    { id: 'n1', type: 'file', x: 0, y: 0, width: 100, height: 100 },
    { id: 'n2', type: 'file', x: 200, y: 0, width: 100, height: 100 },
    { id: 'g1', type: 'group', x: -10, y: -10, width: 320, height: 120 },
  ] };
  const membership = buildGroupMembership(canvas);

  // @convention tools/canvas-player.md [section Concepts/Step]
  it('Step 0 starts from empty visible and focus sets', () => {
    const step = { show: ['n1'], hide: [], inFocus: ['n1'], outFocus: [], transition: 'cut' };
    const result = applyStepDeltas(new Set(), new Set(), step, membership);
    expect([...result.visible]).toEqual(['n1']);
    expect([...result.focus]).toEqual(['n1']);
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('expands a group id in show/in-focus to its member file node ids', () => {
    const step = { show: ['g1'], hide: [], inFocus: ['g1'], outFocus: [], transition: 'cut' };
    const result = applyStepDeltas(new Set(), new Set(), step, membership);
    expect([...result.visible].sort()).toEqual(['n1', 'n2']);
    expect([...result.focus].sort()).toEqual(['n1', 'n2']);
  });

  // @convention tools/canvas-player.md [section Script Format]
  it('applies hide/out-focus as removals from the inherited sets', () => {
    const prevVisible = new Set(['n1', 'n2']);
    const prevFocus = new Set(['n1', 'n2']);
    const step = { show: [], hide: ['n1'], inFocus: [], outFocus: ['n1'], transition: 'cut' };
    const result = applyStepDeltas(prevVisible, prevFocus, step, membership);
    expect([...result.visible]).toEqual(['n2']);
    expect([...result.focus]).toEqual(['n2']);
  });
});

// ---------------------------------------------------------------------------
// computeFitBox
// ---------------------------------------------------------------------------

describe('computeFitBox', () => {
  const nodes = [
    { id: 'n1', x: 0, y: 0, width: 100, height: 100 },
    { id: 'n2', x: 200, y: 50, width: 100, height: 100 },
  ];

  // @convention tools/canvas-player.md [section How It Works]
  it('returns the padded bounding box union of the focused nodes', () => {
    const box = computeFitBox(nodes, new Set(['n1', 'n2']), 10);
    expect(box).toEqual({ x: -10, y: -10, width: 320, height: 170 });
  });

  // @convention tools/canvas-player.md [section How It Works]
  it('returns null when the focus set is empty (view does not move)', () => {
    expect(computeFitBox(nodes, new Set(), 10)).toBeNull();
  });

  // @convention tools/canvas-player.md [section How It Works]
  it('fits a single focused node with padding on all sides', () => {
    const box = computeFitBox(nodes, new Set(['n1']), 20);
    expect(box).toEqual({ x: -20, y: -20, width: 140, height: 140 });
  });
});
