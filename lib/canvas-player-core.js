/**
 * canvas-player-core.js
 *
 * Pure logic for canvas-player: front matter parsing (micro-notes and
 * presentation scripts), style cascade resolution, group membership,
 * the step engine (visible/focus deltas), and the focus-fit bounding box.
 * No DOM, no fetch, no side effects at import time — see canvas-player.js
 * for the browser-side rendering that consumes this module.
 *
 * References (documents used to design this module):
 *   - tools/canvas-player.md [section Micro-note Front Matter]
 *   - tools/canvas-player.md [section Micro-note Front Matter/Style resolution]
 *   - tools/canvas-player.md [section Style Note Front Matter]
 *   - tools/canvas-player.md [section Style Mapper Front Matter]
 *   - tools/canvas-player.md [section Badge Note Front Matter]
 *   - tools/canvas-player.md [section Badge Mapper Front Matter]
 *   - tools/canvas-player.md [section Script Format]
 *   - tools/canvas-player.md [section Concepts]
 *   - tools/canvas-player.md [section How It Works]
 *   - conventions/obsidian-links.md [section Wikilink Syntax]
 *   - conventions/color-palette.md
 *
 * Not yet in references (document debt — update the refs to absorb these):
 *   - none currently.
 */

// ---------------------------------------------------------------------------
// parseFrontMatter
// ---------------------------------------------------------------------------

/**
 * Parses the YAML front matter block of a micro-note or presentation script
 * into a plain object. Supports flat `key: value` scalars (quoted string,
 * unquoted string, number, boolean), a flat inline list of scalars
 * (`key: ["a", "b"]`, e.g. the `palette` field — see
 * tools/canvas-player.md [section Script Format]), and a block-style YAML
 * list (`key:` alone on its line, followed by indented `- item` lines) —
 * the form Obsidian's own Properties panel writes by default for a list
 * property (e.g. a micro-note's `tags`) edited there rather than typed as
 * raw YAML, see tools/canvas-player.md [section Micro-note Front Matter].
 * Both list forms parse to the same array. This is the subset used by the
 * canvas-player schema, not general YAML; there is no nested-mapping
 * support, by design (see tools/canvas-player.md [section Micro-note Front Matter]
 * on why the schema stays flat).
 *
 * @param {string} fileText - full file content, front matter + body
 * @returns {Object} parsed front matter, {} if none present
 */
function parseFrontMatter(fileText) {
  const match = fileText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const result = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // A block-list item belonging to the preceding key is consumed by
    // that key's own handling below, never reached here as a fresh
    // top-level line in a conformant file — skip an orphaned one (a
    // malformed file) rather than misreading it as `key: value`, since it
    // carries no top-level colon of its own in that role.
    if (/^-\s/.test(line)) continue;

    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = parseKey(line.slice(0, sep).trim());
    const value = line.slice(sep + 1).trim();

    if (value === '') {
      // Empty inline value — either a genuinely empty scalar, or a
      // YAML block-style list: collect every immediately-following
      // indented `- item` line into an array; see the doc comment above.
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        items.push(parseScalar(lines[j].trim().slice(1).trim()));
        j++;
      }
      if (items.length > 0) {
        result[key] = items;
        i = j - 1;
        continue;
      }
      result[key] = '';
      continue;
    }

    result[key] = value.startsWith('[') && value.endsWith(']') ? parseInlineList(value) : parseScalar(value);
  }
  return result;
}

/**
 * Strips matching surrounding quotes from a YAML mapping key, same rule as
 * a quoted scalar value (see parseScalar()) — needed for a style-mapper
 * note's entries, whose keys are wikilinks quoted to avoid `[[`/`]]` being
 * misread as YAML flow syntax, see
 * tools/canvas-player.md [section Style Mapper Front Matter]. A plain,
 * unquoted key (every other front-matter field in this schema) passes
 * through unchanged.
 */
function parseKey(key) {
  if (/^".*"$/.test(key) || /^'.*'$/.test(key)) return key.slice(1, -1);
  return key;
}

/** Parses a single scalar YAML value: quoted string, boolean, number (integer or decimal), or plain string. */
function parseScalar(value) {
  if (/^".*"$/.test(value) || /^'.*'$/.test(value)) return value.slice(1, -1);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return parseFloat(value);
  return value;
}

/**
 * Parses an inline YAML flow-sequence value, e.g. '["[[Brand Colors]]", "[[Semantic Colors]]"]',
 * into its scalar items. Splits on top-level commas only — nested brackets
 * (e.g. the `[[` `]]` of a quoted wikilink item) are balanced pairs, so the
 * same bracket-depth counting as parseTargetList() correctly keeps each
 * item intact regardless of the surrounding quotes.
 *
 * @param {string} value - e.g. '["a", "b"]'
 * @returns {Array<string|number|boolean>} parsed items, via parseScalar() each
 */
function parseInlineList(value) {
  const inner = value.trim().slice(1, -1);
  if (!inner.trim()) return [];
  const tokens = [];
  let depth = 0, start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      tokens.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  tokens.push(inner.slice(start).trim());
  return tokens.filter(Boolean).map(parseScalar);
}

// ---------------------------------------------------------------------------
// extractWikilinkTarget
// ---------------------------------------------------------------------------

/**
 * Strips the `[[` `]]` brackets from an Obsidian wikilink, returning the
 * bare note/file name (no alias, no heading anchor resolution — this
 * module only ever links to whole files: canvas, style note).
 *
 * @param {string} wikilink - e.g. '[[Demo.canvas]]'
 * @returns {string} e.g. 'Demo.canvas'
 */
function extractWikilinkTarget(wikilink) {
  const match = String(wikilink).match(/^\[\[(.+?)\]\]$/);
  return match ? match[1] : String(wikilink);
}

// ---------------------------------------------------------------------------
// resolveNoteFile / resolveWikilink — vault-wide wikilink resolution
// ---------------------------------------------------------------------------

/** Appends .md to a wikilink target that has no extension (micro-notes, style notes; canvases keep their own extension). */
function resolveNoteFile(target) {
  const base = target.split('/').pop();
  return base.includes('.') ? target : `${target}.md`;
}

/**
 * Resolves a wikilink target to a single vault-relative file path, using a
 * prebuilt vault-wide index (filename -> vault-relative path list). Matches
 * Obsidian's own resolution model — by unique file name, not by the
 * referencing file's own folder. See
 * tools/canvas-player.md [section How It Works].
 *
 * @param {string} target - wikilink target, e.g. 'Intro Note' or 'Demo.canvas'
 * @param {Map<string, string[]>} vaultIndex - filename -> vault-relative paths
 * @returns {string} vault-relative path of the resolved file
 * @throws {Error} if the target matches zero or more than one file
 */
function resolveWikilink(target, vaultIndex) {
  const filename = resolveNoteFile(target);
  const matches = vaultIndex.get(filename) || [];
  if (matches.length === 0) {
    throw new Error(`Wikilink target not found in vault: [[${target}]]`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous wikilink [[${target}]] — multiple files named "${filename}" found in vault:\n${matches.join('\n')}`);
  }
  return matches[0];
}

// ---------------------------------------------------------------------------
// parseTagList / parseStyleMapper / resolveTagStyleTarget / resolveNodeStyleTarget /
// composeNodeStyle — tag-based style resolution, see
// tools/canvas-player.md [section Micro-note Front Matter/Style resolution]
// and tools/canvas-player.md [section Style Mapper Front Matter]
// ---------------------------------------------------------------------------

/**
 * Normalizes a tag-list value into trimmed, non-empty tag strings. Accepts
 * either an already-split array (a micro-note's `tags:` bracket-list
 * front-matter value, see tools/canvas-player.md [section Micro-note Front
 * Matter]) or a comma-separated scalar string (a style-mapper entry's
 * value, see tools/canvas-player.md [section Style Mapper Front Matter]).
 *
 * @param {string[]|string|null|undefined} value
 * @returns {string[]}
 */
function parseTagList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String).map(t => t.trim()).filter(Boolean);
  return String(value).split(',').map(t => t.trim()).filter(Boolean);
}

// Front-matter keys on a micro-note that are never eligible as a
// style-mapper condition key — `tags`/`style` are routing-only, the rest
// are content (icon/image/text/text-<lang>) — see
// tools/canvas-player.md [section Micro-note Front Matter] and
// tools/canvas-player.md [section Style Mapper Front Matter].
const MICRO_NOTE_ROUTING_KEYS = new Set(['tags', 'style']);
const MICRO_NOTE_CONTENT_KEYS = new Set(['icon', 'image', 'text']);

/** True for a micro-note front-matter key that is routing-only or content, never a style-mapper condition key. */
function isReservedMicroNoteKey(key) {
  return MICRO_NOTE_ROUTING_KEYS.has(key) || MICRO_NOTE_CONTENT_KEYS.has(key) || key.startsWith('text-');
}

/**
 * Parses one style-mapper entry's (or a micro-note's own) condition list
 * into typed condition objects, splitting on commas via parseTagList()
 * then, per token, on the first `:` — a bare token (`warning`) is a tag
 * condition; a `key:value` token (`level:0`) is a property condition —
 * see tools/canvas-player.md [section Style Mapper Front Matter].
 *
 * @param {string[]|string|null|undefined} value
 * @returns {Array<{type: 'tag', tag: string}|{type: 'property', key: string, value: string}>}
 */
function parseConditionList(value) {
  return parseTagList(value).map(token => {
    const sep = token.indexOf(':');
    if (sep === -1) return { type: 'tag', tag: token };
    return { type: 'property', key: token.slice(0, sep).trim(), value: token.slice(sep + 1).trim() };
  });
}

/**
 * Parses a style-mapper note's front matter into its condition-matching
 * entries plus its optional `default` target — see
 * tools/canvas-player.md [section Style Mapper Front Matter]. Each
 * non-`default` key is a (quote-stripped, see parseKey() in
 * parseFrontMatter()) wikilink to a style note; entries are returned in
 * the note's own declaration order, since object key order follows
 * insertion order for non-numeric string keys — this order backs the
 * declaration-order tie-break in resolveConditionStyleTarget().
 *
 * @param {Object} frontMatter - parsed front matter of a style-mapper note (parseFrontMatter())
 * @returns {{entries: Array<{styleTarget: string, conditions: Array<{type:string}>}>, defaultTarget: string|null}}
 */
function parseStyleMapper(frontMatter) {
  const entries = [];
  let defaultTarget = null;
  for (const [key, value] of Object.entries(frontMatter)) {
    if (key === 'default') {
      defaultTarget = extractWikilinkTarget(value);
      continue;
    }
    entries.push({ styleTarget: extractWikilinkTarget(key), conditions: parseConditionList(value) });
  }
  return { entries, defaultTarget };
}

/**
 * Builds a micro-note's own condition set for style-mapper matching: one
 * tag condition per entry in `tags`, plus one property condition
 * (value stringified) per other front-matter key not reserved for
 * routing or content (`tags`, `style`, `icon`, `image`, `text`/
 * `text-<lang>`) — see tools/canvas-player.md [section Style Mapper Front
 * Matter]. Nothing extra to declare on the micro-note: any flat property
 * (e.g. `level: 0`) is usable as a condition simply by being set.
 *
 * @param {Object} local - the micro-note's own parsed front matter
 * @returns {Array<{type: 'tag', tag: string}|{type: 'property', key: string, value: string}>}
 */
function buildNodeConditions(local) {
  const conditions = parseTagList(local.tags).map(tag => ({ type: 'tag', tag }));
  for (const [key, value] of Object.entries(local)) {
    if (isReservedMicroNoteKey(key)) continue;
    conditions.push({ type: 'property', key, value: String(value) });
  }
  return conditions;
}

/** True when every one of `entryConditions` is satisfied by some condition in `nodeConditions` — a tag condition matches an equal tag, a property condition matches an equal key and (stringified) value. */
function conditionsMatch(nodeConditions, entryConditions) {
  return entryConditions.every(cond => {
    if (cond.type === 'tag') {
      return nodeConditions.some(nc => nc.type === 'tag' && nc.tag === cond.tag);
    }
    return nodeConditions.some(nc => nc.type === 'property' && nc.key === cond.key && nc.value === cond.value);
  });
}

/**
 * Resolves which style-mapper entry matches a node's condition set (tags
 * and flat properties together, see buildNodeConditions()): an entry
 * matches when every one of its own conditions is satisfied by the node
 * (extra node conditions beyond the entry's own are ignored). Among
 * matching entries, the one listing the most conditions wins; a tie is
 * broken by declaration order, the later entry winning — the same
 * direction as a `palette` list merge (see mergePalettes()) — see
 * tools/canvas-player.md [section Style Mapper Front Matter].
 *
 * @param {Array<{type:string}>} nodeConditions - the node's own conditions (buildNodeConditions())
 * @param {Array<{styleTarget: string, conditions: Array<{type:string}>}>} entries - style-mapper entries, in file order (parseStyleMapper())
 * @returns {string|null} the matching entry's style-note wikilink target, or null if none matches
 */
function resolveConditionStyleTarget(nodeConditions, entries) {
  let best = null;
  for (const entry of entries) {
    if (entry.conditions.length === 0) continue;
    if (!conditionsMatch(nodeConditions, entry.conditions)) continue;
    if (!best || entry.conditions.length >= best.conditions.length) best = entry;
  }
  return best ? best.styleTarget : null;
}

/**
 * Resolves which style note a micro-note's front matter should draw its
 * visual style from — the single entry point for the resolution order
 * documented in tools/canvas-player.md [section Micro-note Front
 * Matter/Style resolution]: a direct `style:` wikilink overrides tag and
 * property resolution entirely; otherwise the micro-note's own condition
 * set (buildNodeConditions()) is matched against the style-mapper's
 * entries (resolveConditionStyleTarget()); with no conditions at all
 * (no tags, no other usable property), the style-mapper's `default`
 * entry applies.
 *
 * @param {Object} local - the micro-note's own parsed front matter
 * @param {{entries: Array<{styleTarget:string, conditions: Array<{type:string}>}>, defaultTarget: string|null}} mapper - parsed style-mapper (parseStyleMapper()); `{entries: [], defaultTarget: null}` when the script sets no `style-mapper`
 * @returns {string} the resolved style note's wikilink target (unbracketed)
 * @throws {Error} if the micro-note has conditions but no style-mapper entry matches them, or if there is neither `style` nor a matching condition nor a `default` entry
 */
function resolveNodeStyleTarget(local, mapper) {
  if (local.style) return extractWikilinkTarget(local.style);

  const conditions = buildNodeConditions(local);
  if (conditions.length > 0) {
    const target = resolveConditionStyleTarget(conditions, mapper.entries);
    if (!target) {
      const summary = conditions.map(c => c.type === 'tag' ? c.tag : `${c.key}:${c.value}`).join(', ');
      throw new Error(`No style-mapper entry matches [${summary}] — see tools/canvas-player.md [section Style Mapper Front Matter].`);
    }
    return target;
  }

  if (mapper.defaultTarget) return mapper.defaultTarget;
  throw new Error('Micro-note has no tags, no other usable property, and no direct style, and the style-mapper defines no "default" entry — see tools/canvas-player.md [section Style Mapper Front Matter].');
}

/**
 * Parses a badge-mapper note's front matter into its condition-matching
 * entries — structurally identical to parseStyleMapper() except there is
 * no `default` key: every key in a badge-mapper note is a (quote-stripped,
 * see parseKey() in parseFrontMatter()) wikilink to a badge note — see
 * tools/canvas-player.md [section Badge Mapper Front Matter].
 *
 * @param {Object} frontMatter - parsed front matter of a badge-mapper note (parseFrontMatter())
 * @returns {{entries: Array<{badgeTarget: string, conditions: Array<{type:string}>}>}}
 */
function parseBadgeMapper(frontMatter) {
  const entries = [];
  for (const [key, value] of Object.entries(frontMatter)) {
    entries.push({ badgeTarget: extractWikilinkTarget(key), conditions: parseConditionList(value) });
  }
  return { entries };
}

/**
 * Resolves which badge-mapper entry matches a node's condition set — same
 * matching rule and tie-break as resolveConditionStyleTarget() (most
 * conditions wins; a tie is broken by declaration order, the later entry
 * winning), applied to badge-mapper entries instead of style-mapper ones
 * — see tools/canvas-player.md [section Badge Mapper Front Matter].
 *
 * @param {Array<{type:string}>} nodeConditions - the node's own conditions (buildNodeConditions())
 * @param {Array<{badgeTarget: string, conditions: Array<{type:string}>}>} entries - badge-mapper entries, in file order (parseBadgeMapper())
 * @returns {string|null} the matching entry's badge-note wikilink target, or null if none matches
 */
function resolveConditionBadgeTarget(nodeConditions, entries) {
  let best = null;
  for (const entry of entries) {
    if (entry.conditions.length === 0) continue;
    if (!conditionsMatch(nodeConditions, entry.conditions)) continue;
    if (!best || entry.conditions.length >= best.conditions.length) best = entry;
  }
  return best ? best.badgeTarget : null;
}

/**
 * Resolves which badge note, if any, a micro-note's front matter should
 * draw a badge from — see tools/canvas-player.md [section Concepts/Badge
 * Note] and [section Badge Mapper Front Matter]. Unlike style resolution,
 * there is no direct per-micro-note override and no `default` entry: a
 * micro-note with no tags and no other usable property, or with none of
 * them matching any badge-mapper entry, simply has no badge — the normal,
 * expected case, not a load-time error the way an unresolved style is.
 *
 * @param {Object} local - the micro-note's own parsed front matter
 * @param {{entries: Array<{badgeTarget:string, conditions: Array<{type:string}>}>}} badgeMapper - parsed badge-mapper (parseBadgeMapper()); `{entries: []}` when the script sets no `badge-mapper`
 * @returns {string|null} the resolved badge note's wikilink target (unbracketed), or null if no badge applies
 */
function resolveNodeBadgeTarget(local, badgeMapper) {
  const conditions = buildNodeConditions(local);
  if (conditions.length === 0) return null;
  return resolveConditionBadgeTarget(conditions, badgeMapper.entries);
}

/**
 * Composes a node's final rendering style: visual properties from the
 * resolved style note (`shape`/`fill`/`stroke`/`stroke-width`/`text-size`/
 * `text-bold`, see tools/canvas-player.md [section Style Note Front
 * Matter]), combined with the micro-note's own content fields (`icon`,
 * `image`, `text`/`text-<lang>`, per MICRO_NOTE_CONTENT_KEYS above) — the
 * two are not expected to overlap. `tags`, `style`, and any other flat
 * property used only for style-mapper routing (e.g. `level`, `domain`)
 * are never copied into the result. Local content fields win on an
 * accidental key collision with the style note, since a style note is
 * meant to carry only visual properties.
 *
 * @param {Object} local - the micro-note's own parsed front matter
 * @param {Object} resolvedStyleFm - the resolved style note's parsed front matter (resolveNodeStyleTarget() then the loaded note)
 * @returns {Object}
 */
function composeNodeStyle(local, resolvedStyleFm) {
  const content = {};
  for (const [key, value] of Object.entries(local)) {
    if (MICRO_NOTE_CONTENT_KEYS.has(key) || key.startsWith('text-')) content[key] = value;
  }
  return { ...resolvedStyleFm, ...content };
}

// ---------------------------------------------------------------------------
// resolveText — language fallback
// ---------------------------------------------------------------------------

/**
 * Resolves the display text for a resolved style, given the active language.
 * `text-<lang>` overrides `text` when present; falls back to `text`, then ''.
 *
 * @param {Object} style - resolved micro-note style (post-cascade)
 * @param {string} lang - active presentation language, e.g. 'fr'
 * @returns {string}
 */
function resolveText(style, lang) {
  return style[`text-${lang}`] ?? style.text ?? '';
}

// ---------------------------------------------------------------------------
// parseMicroNoteBody / resolveBody — optional per-language body content, see
// tools/canvas-player.md [section Micro-note Front Matter]
// ---------------------------------------------------------------------------

/**
 * Parses a micro-note's body (everything after the front matter block) into
 * a map of language code -> section content, split on `## <lang>` headings
 * (e.g. `## en`, `## fr`). Any text before the first such heading is
 * ignored — unlike `text`/`text-<lang>` in the front matter, there is no
 * unlabeled default section. See
 * tools/canvas-player.md [section Micro-note Front Matter].
 *
 * @param {string} fileText - full file content, front matter + body
 * @returns {Object<string,string>} lang code (lowercased) -> trimmed section content, {} if none
 */
function parseMicroNoteBody(fileText) {
  const body = fileText.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  const result = {};
  const headingRe = /^##\s+(\S+)\s*$/gm;
  const matches = [...body.matchAll(headingRe)];

  for (let i = 0; i < matches.length; i++) {
    const lang = matches[i][1].toLowerCase();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    result[lang] = body.slice(start, end).trim();
  }
  return result;
}

/**
 * Resolves a micro-note's body content for the active language. No
 * fallback: if the active language has no matching section, returns ''
 * (silent) — see tools/canvas-player.md [section Micro-note Front Matter].
 *
 * @param {Object<string,string>} bodyMap - result of parseMicroNoteBody()
 * @param {string} lang - active presentation language, e.g. 'fr'
 * @returns {string}
 */
function resolveBody(bodyMap, lang) {
  return (bodyMap && bodyMap[lang]) || '';
}

/**
 * Splits a resolved body string into paragraphs and, within each
 * paragraph, forced line-break lines — matching Obsidian's own default
 * (non-strict) line-break behavior, not CommonMark: a single newline
 * forces a line break within the same paragraph; a blank line (whitespace
 * only, once trimmed) starts a new paragraph; consecutive blank lines
 * collapse into a single paragraph break. Word-wrapping to the node's
 * width is applied separately, per resulting line, by the DOM-dependent
 * renderer — see tools/canvas-player.md [section Micro-note Front Matter].
 *
 * @param {string} text - resolved body content for the active language (resolveBody())
 * @returns {string[][]} paragraphs, each an array of trimmed forced-break lines; [] for empty/blank-only input
 */
function splitBodyIntoParagraphs(text) {
  if (!text) return [];
  const rawLines = String(text).replace(/\r\n/g, '\n').split('\n').map(l => l.trim());

  const paragraphs = [];
  let current = [];
  for (const line of rawLines) {
    if (line === '') {
      if (current.length) {
        paragraphs.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length) paragraphs.push(current);
  return paragraphs;
}

// ---------------------------------------------------------------------------
// Color palette resolution — see conventions/color-palette.md
// ---------------------------------------------------------------------------

/**
 * Normalizes a presentation script's `palette` front-matter value into an
 * ordered list of wikilink targets, stripping brackets from each. Accepts
 * a single wikilink string or a list of wikilink strings (parsed as an
 * inline YAML list by parseFrontMatter()) — see
 * tools/canvas-player.md [section Script Format] and
 * conventions/color-palette.md [section Contract for consuming tools].
 * Absent `palette` yields an empty list.
 *
 * @param {{palette?: string|string[]}} frontMatter - presentation script front matter (or a subset of it)
 * @returns {string[]} wikilink targets, e.g. ['Brand Colors', 'Semantic Colors']
 */
function resolvePaletteTargets(frontMatter) {
  const raw = frontMatter.palette;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(extractWikilinkTarget);
}

// The standard CSS Color Module named-color keywords (148 names, including
// both "gray"/"grey" spellings throughout and "rebeccapurple"), lowercase.
// SVG/CSS render these natively — no hex conversion needed — see
// conventions/color-palette.md [section Name vs hex].
const CSS_COLOR_NAMES = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black',
  'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse',
  'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan',
  'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta',
  'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink',
  'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen',
  'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow',
  'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
  'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon',
  'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue',
  'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine',
  'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream',
  'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange',
  'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred',
  'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple',
  'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell',
  'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen',
  'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white',
  'whitesmoke', 'yellow', 'yellowgreen',
]);

/**
 * Returns whether a value can be handed directly to CSS/SVG as a color,
 * with no further lookup: a literal hex string ('#...') or a recognized
 * standard CSS color name (case-insensitive) — see
 * conventions/color-palette.md [section Name vs hex].
 *
 * @param {string} value
 * @returns {boolean}
 */
function isColorLiteral(value) {
  const str = String(value);
  return str.startsWith('#') || CSS_COLOR_NAMES.has(str.toLowerCase());
}

// Matches a gradient spec value, e.g. '#000000 -> #ffffff (5)' — two hex
// endpoints (3 or 6 hex digits each), an arrow, and a parenthesized step
// count. Whitespace around the arrow and inside the parens is optional.
// See conventions/color-palette.md [section Palette Note/Generated gradients].
const GRADIENT_SPEC_RE = /^(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3}))\s*->\s*(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3}))\s*\(\s*(\d+)\s*\)$/;

/**
 * Expands a 3-digit hex shorthand ('#abc') to its 6-digit form ('#aabbcc');
 * a 6-digit hex passes through unchanged.
 *
 * @param {string} hex
 * @returns {string}
 */
function expandHexShorthand(hex) {
  const digits = hex.slice(1);
  return digits.length === 3 ? `#${digits.split('').map(c => c + c).join('')}` : hex;
}

/**
 * Parses a 3- or 6-digit hex color into its {r,g,b} channels (0-255 each).
 *
 * @param {string} hex
 * @returns {{r: number, g: number, b: number}}
 * @throws {Error} if hex is not a well-formed 3- or 6-digit hex color
 */
function hexToRgb(hex) {
  const digits = expandHexShorthand(hex).slice(1);
  if (!/^[0-9a-fA-F]{6}$/.test(digits)) {
    throw new Error(`Invalid hex color "${hex}" — expected 3 or 6 hex digits.`);
  }
  const num = parseInt(digits, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

/** Formats {r,g,b} channels (each rounded, clamped 0-255 by construction) as a 6-digit lowercase hex color. */
function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Generates `count` hex colors evenly interpolated, channel-by-channel in
 * RGB space (no other color space), between `startHex` and `endHex`
 * inclusive — the first result is exactly `startHex`, the last is exactly
 * `endHex`. Backs the `"#hex -> #hex (N)"` gradient spec in a palette
 * entry's value, see
 * conventions/color-palette.md [section Palette Note/Generated gradients].
 *
 * @param {string} startHex - 3- or 6-digit hex color
 * @param {string} endHex - 3- or 6-digit hex color
 * @param {number} count - number of colors to generate, >= 2
 * @returns {string[]} `count` 6-digit hex colors, start to end
 * @throws {Error} if count is not an integer >= 2, or either endpoint is not a well-formed hex color
 */
function interpolateColors(startHex, endHex, count) {
  if (!Number.isInteger(count) || count < 2) {
    throw new Error(`Gradient step count must be an integer of 2 or more, got ${count}.`);
  }
  const start = hexToRgb(startHex);
  const end = hexToRgb(endHex);
  const steps = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    steps.push(rgbToHex({
      r: start.r + (end.r - start.r) * t,
      g: start.g + (end.g - start.g) * t,
      b: start.b + (end.b - start.b) * t,
    }));
  }
  return steps;
}

/**
 * Extracts a palette note's color entries from its parsed front matter.
 * Each string-valued key is either:
 * - a plain color name -> value pair, the value a hex literal or a
 *   standard CSS color name (validated eagerly here, at palette-load
 *   time — a typo in a palette note's own value would otherwise render
 *   silently as black in SVG instead of failing loudly); or
 * - a gradient spec (`"#hex -> #hex (N)"`, see interpolateColors()),
 *   expanded into `N` generated entries named `<key>-1` .. `<key>-N` —
 *   the bare `<key>` itself is not registered, only the numbered entries.
 * Non-string front-matter entries (should not occur in a conformant
 * palette note) are ignored. See
 * conventions/color-palette.md [section Palette Note/Format] and
 * [section Palette Note/Generated gradients].
 *
 * @param {Object} frontMatter - parsed front matter of a palette note (parseFrontMatter())
 * @returns {Object<string,string>} name -> hex or CSS color name
 * @throws {Error} if a string-valued entry is neither a hex literal, a recognized CSS color name, nor a well-formed gradient spec
 */
function parsePalette(frontMatter) {
  const palette = {};
  for (const [key, value] of Object.entries(frontMatter)) {
    if (typeof value !== 'string') continue;
    const gradientMatch = value.trim().match(GRADIENT_SPEC_RE);
    if (gradientMatch) {
      const [, startHex, endHex, countStr] = gradientMatch;
      let steps;
      try {
        steps = interpolateColors(startHex, endHex, parseInt(countStr, 10));
      } catch (err) {
        throw new Error(`Invalid gradient entry "${key}: ${value}" — ${err.message} See conventions/color-palette.md.`);
      }
      steps.forEach((hex, i) => { palette[`${key}-${i + 1}`] = hex; });
      continue;
    }
    if (!isColorLiteral(value)) {
      throw new Error(`Invalid palette entry "${key}: ${value}" — a palette color must be a hex literal, a standard CSS color name, or a gradient spec ("#hex -> #hex (N)"). See conventions/color-palette.md.`);
    }
    palette[key] = value;
  }
  return palette;
}

/**
 * Merges several parsed palettes into one, in list order — later palettes
 * override earlier ones on a name collision, the same direction as a
 * plain object spread. See
 * conventions/color-palette.md [section Merging several palettes].
 *
 * @param {Array<Object<string,string>>} palettes
 * @returns {Object<string,string>} merged name -> hex
 */
function mergePalettes(palettes) {
  return Object.assign({}, ...palettes);
}

/**
 * Resolves one color value — from a script or micro-note front-matter
 * field — against a merged palette. A value starting with '#' is a
 * literal hex color, returned as-is; `null`/`undefined` pass through
 * unchanged (property simply absent). Any other value is a palette color
 * name, looked up in `palette` — an unresolved name is a load-time error,
 * not a silent fallback. See
 * conventions/color-palette.md [section Name vs hex].
 *
 * @param {string|null|undefined} value - e.g. '#3b82f6' or 'primary'
 * @param {Object<string,string>} palette - merged name -> hex map
 * @param {string} [field] - the front-matter field this value came from
 *   (e.g. 'fill', 'background'), included in the thrown error so an
 *   unresolved name can be traced back to what property caused it — the
 *   caller (canvas-player.js) further prefixes the source file's path,
 *   since that is not known at this pure-logic layer.
 * @returns {string|null|undefined} resolved hex color
 * @throws {Error} if value is not a hex literal and not found in palette
 */
function resolveColor(value, palette, field) {
  if (value == null) return value;
  const str = String(value);
  if (str.startsWith('#')) return str;
  if (Object.prototype.hasOwnProperty.call(palette, str)) return palette[str];
  if (CSS_COLOR_NAMES.has(str.toLowerCase())) return str;
  const suffix = field ? ` (${field})` : '';
  throw new Error(`Unresolved color name "${str}"${suffix} — not a hex literal, not found in the presentation's palette, and not a standard CSS color name. See conventions/color-palette.md.`);
}

/**
 * Resolves the `fill` and `stroke` properties of a (post-cascade)
 * micro-note style against the presentation's merged palette — see
 * conventions/color-palette.md. Other properties pass through unchanged.
 *
 * @param {Object} style - resolved micro-note style (resolveMicroNoteStyle())
 * @param {Object<string,string>} palette - merged name -> hex map
 * @returns {Object} style with fill/stroke resolved to hex
 * @throws {Error} if fill or stroke is an unresolved palette name
 */
function resolveStyleColors(style, palette) {
  const resolved = { ...style };
  if (resolved.fill != null) resolved.fill = resolveColor(resolved.fill, palette, 'fill');
  if (resolved.stroke != null) resolved.stroke = resolveColor(resolved.stroke, palette, 'stroke');
  return resolved;
}

/**
 * Resolves a badge note's `color` property against the presentation's
 * merged palette — mirrors resolveStyleColors() for a style note's
 * fill/stroke. See tools/canvas-player.md [section Badge Note Front
 * Matter] and conventions/color-palette.md.
 *
 * @param {Object} badgeFm - parsed badge note front matter (icon/color/position)
 * @param {Object<string,string>} palette - merged name -> hex map
 * @returns {Object} badge front matter with color resolved to hex
 * @throws {Error} if color is an unresolved palette name
 */
function resolveBadgeColors(badgeFm, palette) {
  const resolved = { ...badgeFm };
  if (resolved.color != null) resolved.color = resolveColor(resolved.color, palette, 'color');
  return resolved;
}

// ---------------------------------------------------------------------------
// resolveTheme — presentation-level background/theme, see
// tools/canvas-player.md [section Script Format]
// ---------------------------------------------------------------------------

const THEME_PRESETS = {
  dark: { background: '#1e1e1e', edge: '#888', text: '#fff', edgeWidth: 1.5 },
  light: { background: '#f5f5f5', edge: '#999', text: '#1e1e1e', edgeWidth: 1.5 },
};

/**
 * Resolves the presentation's background/theme/edge styling from the
 * script's front matter: `theme` selects a preset (`dark`, the default, or
 * `light`); `background` overrides just the preset's background color;
 * `edge-color` overrides just the preset's edge color; `edge-width`
 * overrides the edge stroke width. Each override is independent — the
 * rest of the preset still applies. `background`/`edge-color` each accept
 * a literal hex or, when `palette` resolves to a non-empty map, a color
 * name — resolved via resolveColor(), see
 * conventions/color-palette.md [section Name vs hex]. See
 * tools/canvas-player.md [section Script Format].
 *
 * @param {{theme?: string, background?: string, 'edge-color'?: string, 'edge-width'?: number}} frontMatter - presentation script front matter (or a subset of it)
 * @param {Object<string,string>} [palette] - merged name -> hex map, {} if the script sets no palette
 * @returns {{background: string, edge: string, text: string, edgeWidth: number}}
 */
function resolveTheme(frontMatter, palette = {}) {
  const preset = THEME_PRESETS[frontMatter.theme] || THEME_PRESETS.dark;
  return {
    ...preset,
    background: frontMatter.background ? resolveColor(frontMatter.background, palette, 'background') : preset.background,
    edge: frontMatter['edge-color'] ? resolveColor(frontMatter['edge-color'], palette, 'edge-color') : preset.edge,
    edgeWidth: frontMatter['edge-width'] != null ? frontMatter['edge-width'] : preset.edgeWidth,
  };
}

/**
 * Resolves the presentation's step-transition duration, in seconds, from
 * the script's front matter. Defaults to 1 second when absent or invalid
 * (not a non-negative number). Applies to both the visibility fade and the
 * pan/zoom move, per `transition: fade` — see
 * tools/canvas-player.md [section Script Format].
 *
 * @param {{'transition-duration'?: number}} frontMatter - presentation script front matter (or a subset of it)
 * @returns {number} duration in seconds
 */
function resolveTransitionDuration(frontMatter) {
  const value = frontMatter['transition-duration'];
  return typeof value === 'number' && value >= 0 ? value : 1;
}

// ---------------------------------------------------------------------------
// parsePresentationScript
// ---------------------------------------------------------------------------

const DIRECTIVE_LIST_KEYS = {
  'show': 'show',
  'hide': 'hide',
  'in-focus': 'inFocus',
  'out-focus': 'outFocus',
};

// `show-focus` / `hide-focus` — shorthand directives combining visibility
// and focus on the same target list, see
// tools/canvas-player.md [section Script Format]. Each maps to two output
// lists instead of one, on the same generated step.
const COMBINED_DIRECTIVE_KEYS = {
  'show-focus': ['show', 'inFocus'],
  'hide-focus': ['hide', 'outFocus'],
};

// `show-focus-each` — compact directive expanding, at parse time, into one
// `show-focus` step per target, in list order — see
// tools/canvas-player.md [section Script Format]. Not a per-step directive
// like the ones above: it produces multiple steps from a single heading.
const EACH_DIRECTIVE_KEY = 'show-focus-each';

// `show-focus-each-in` — like EACH_DIRECTIVE_KEY, but expands a group
// target (canvas group or condition group) into one step per *member*
// file node instead of one step for the whole group — see
// tools/canvas-player.md [section Script Format]. Unlike show-focus-each,
// this expansion needs canvas/vault data (group membership, condition
// matching, filenames for sort order) that isn't available at raw-script
// parse time, so parseStepBlock() below only produces a single pseudo-step
// carrying the raw target list (`eachInTargets`); the actual per-member
// steps are generated later by resolveEachInSteps(), once that data is
// loaded — see resolveScriptSteps().
const EACH_IN_DIRECTIVE_KEY = 'show-focus-each-in';

/**
 * Parses a presentation script: front matter `canvas:` wikilink, and the
 * ordered list of `## Step N` sections, each with its show/hide/in-focus/
 * out-focus id lists and its transition mode. `show-focus`/`hide-focus`
 * are combined-directive shorthands, expanded here into both underlying
 * lists (show+inFocus, hide+outFocus); `show-focus-each` is an
 * expansion directive, turning one heading into several generated steps
 * — see tools/canvas-player.md [section Script Format] and
 * parseStepBlock() below.
 *
 * @param {string} fileText
 * @returns {{ canvas: string, steps: Array<{show:string[], hide:string[], inFocus:string[], outFocus:string[], transition:string}> }}
 */
function parsePresentationScript(fileText) {
  const frontMatter = parseFrontMatter(fileText);
  const canvas = frontMatter.canvas ? extractWikilinkTarget(frontMatter.canvas) : null;

  const body = fileText.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  // A step heading is `## Step` optionally followed by any free-form label
  // (a number, a decimal like `1.1`, arbitrary text, or nothing at all) —
  // the label plays no role in step identity or order (both come purely
  // from position in the file, see tools/canvas-player.md [section Script
  // Format]) but is captured verbatim (via the capture group below) and
  // carried onto each resulting step so the runtime can offer a "jump to
  // step by label" selector — see tools/canvas-player.md [section
  // Controls]. Whitespace is matched with `[ \t]`, not `\s`, so the
  // optional label can never swallow the newline into the next line
  // (which `\s` would, being greedy and matching `\n` too) — a bare
  // `## Step` right before the file's last line was losing that line
  // entirely to an earlier, buggier version of this regex that used `\s`.
  // The required `[ \t]+` before the label also keeps `## Stepping Stones`
  // from matching as a step heading.
  const HEADING_RE = /^##[ \t]+Step(?:[ \t]+([^\n]*?))?[ \t]*$/gm;
  const headings = [...body.matchAll(HEADING_RE)];

  const steps = headings.flatMap((heading, i) => {
    const start = heading.index + heading[0].length;
    const end = i + 1 < headings.length ? headings[i + 1].index : body.length;
    const label = (heading[1] || '').trim();
    return parseStepBlock(body.slice(start, end), i, label);
  });

  return {
    canvas,
    theme: frontMatter.theme,
    palette: frontMatter.palette,
    'style-mapper': frontMatter['style-mapper'],
    'badge-mapper': frontMatter['badge-mapper'],
    background: frontMatter.background,
    'edge-color': frontMatter['edge-color'],
    'edge-width': frontMatter['edge-width'],
    'edge-offset': frontMatter['edge-offset'],
    'edge-target-offset': frontMatter['edge-target-offset'],
    'transition-duration': frontMatter['transition-duration'],
    steps,
  };
}

/**
 * Parses one `## Step` block into one or more step objects.
 * Normally returns a single step. When the block carries
 * `show-focus-each`, returns one generated `show-focus` step per target
 * instead — see tools/canvas-player.md [section Script Format]. Every
 * returned step carries the heading's own free-form `label` (may be '');
 * a `show-focus-each` expansion reuses the same label on every generated
 * step, since they all originate from the one heading.
 *
 * @param {string} block - raw text of one step section (after its heading)
 * @param {number} blockIndex - 0 for the first block ("## Step ...")
 * @param {string} label - the heading's own free-form label, trimmed ('' if none)
 * @returns {Array<{show:string[], hide:string[], inFocus:string[], outFocus:string[], transition:string, label:string}>}
 * @throws {Error} if show-focus-each is combined with another directive, or used on Step 0
 */
function parseStepBlock(block, blockIndex, label) {
  const directiveLines = block.split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const sep = line.indexOf(':');
      return sep === -1 ? null : { key: line.slice(0, sep).trim(), value: line.slice(sep + 1).trim() };
    })
    .filter(Boolean);

  const eachLine = directiveLines.find(l => l.key === EACH_DIRECTIVE_KEY);
  const eachInLine = directiveLines.find(l => l.key === EACH_IN_DIRECTIVE_KEY);

  if (eachLine && eachInLine) {
    throw new Error(`"${EACH_DIRECTIVE_KEY}" and "${EACH_IN_DIRECTIVE_KEY}" cannot both appear on the same step — see tools/canvas-player.md [section Script Format]`);
  }

  if (eachLine || eachInLine) {
    const activeKey = eachLine ? EACH_DIRECTIVE_KEY : EACH_IN_DIRECTIVE_KEY;
    const activeLine = eachLine || eachInLine;
    const strayLines = directiveLines.filter(l => l.key !== activeKey && l.key !== 'transition');
    if (strayLines.length > 0) {
      throw new Error(`"${activeKey}" cannot be combined with other directives on the same step (found: ${strayLines.map(l => l.key).join(', ')}) — see tools/canvas-player.md [section Script Format]`);
    }
    if (blockIndex === 0) {
      throw new Error(`"${activeKey}" is not allowed on Step 0 — see tools/canvas-player.md [section Script Format]`);
    }
    const transitionLine = directiveLines.find(l => l.key === 'transition');
    const transition = transitionLine ? transitionLine.value : 'fade';

    if (eachLine) {
      return parseTargetList(eachLine.value).map(target => ({
        show: [target], hide: [], inFocus: [target], outFocus: [], transition, label,
      }));
    }
    // show-focus-each-in — member-level expansion needs canvas/vault data
    // not yet available at parse time; kept as a single pseudo-step
    // carrying the raw target list, expanded later by resolveScriptSteps()
    // — see tools/canvas-player.md [section Script Format] and [section How
    // It Works].
    return [{
      show: [], hide: [], inFocus: [], outFocus: [], transition, label,
      eachInTargets: parseTargetList(activeLine.value),
    }];
  }

  const step = { show: [], hide: [], inFocus: [], outFocus: [], transition: 'fade', label };
  for (const { key, value } of directiveLines) {
    if (key === 'transition') {
      step.transition = value;
    } else if (COMBINED_DIRECTIVE_KEYS[key]) {
      const targets = parseTargetList(value);
      for (const outputKey of COMBINED_DIRECTIVE_KEYS[key]) {
        step[outputKey].push(...targets);
      }
    } else if (DIRECTIVE_LIST_KEYS[key]) {
      step[DIRECTIVE_LIST_KEYS[key]].push(...parseTargetList(value));
    }
  }
  return [step];
}

/** Splits a directive value into its self-delimiting target tokens: each token keeps its own brackets, '[[Note]]' for a node, '[Label]' for a group, or '{tag, key:value}' for a condition group, comma-separated, no enclosing outer bracket — see tools/canvas-player.md [section Script Format]. Tracks '['/']' and '{'/'}' as the same nesting depth (a token never mixes both kinds), so a comma *inside* a condition group's own '{...}' — separating its AND-ed conditions — is not mistaken for the list's own top-level separator between targets. */
function parseTargetList(value) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const tokens = [];
  let depth = 0, start = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      tokens.push(trimmed.slice(start, i).trim());
      start = i + 1;
    }
  }
  tokens.push(trimmed.slice(start).trim());
  return tokens.filter(Boolean);
}

// ---------------------------------------------------------------------------
// edgeAnchorPoint / computeEdgePath — curved edge geometry, see
// tools/canvas-player.md [section Concepts/Canvas]
// ---------------------------------------------------------------------------

// Default control-point offset bounds (used when not overridden by the
// script's `edge-offset`/`edge-target-offset` front matter, see
// resolveEdgeOffsets() below). The target end defaults larger than the
// source end so a curve keeps its incoming tangent longer and turns in
// gradually, instead of bending sharply right before the arrowhead — see
// tools/canvas-player.md [section Concepts/Canvas].
const EDGE_SOURCE_OFFSET_MIN = 40;
const EDGE_SOURCE_OFFSET_MAX = 120;
const EDGE_TARGET_OFFSET_MIN = 60;
const EDGE_TARGET_OFFSET_MAX = 200;

/**
 * Point on a node's bounding box where an edge attaches, per its
 * `fromSide`/`toSide` canvas field. Falls back to the node's center for an
 * unknown or missing side.
 *
 * @param {{x:number,y:number,width:number,height:number}} node
 * @param {string} [side] - 'top' | 'bottom' | 'left' | 'right'
 * @returns {{x:number, y:number}}
 */
function edgeAnchorPoint(node, side) {
  switch (side) {
    case 'top': return { x: node.x + node.width / 2, y: node.y };
    case 'bottom': return { x: node.x + node.width / 2, y: node.y + node.height };
    case 'left': return { x: node.x, y: node.y + node.height / 2 };
    case 'right': return { x: node.x + node.width, y: node.y + node.height / 2 };
    default: return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  }
}

/** Outward unit normal for a node side — the direction a curve's control point extends toward. */
function sideNormal(side) {
  switch (side) {
    case 'top': return { x: 0, y: -1 };
    case 'bottom': return { x: 0, y: 1 };
    case 'left': return { x: -1, y: 0 };
    case 'right': return { x: 1, y: 0 };
    default: return { x: 0, y: 0 };
  }
}

/**
 * Computes a cubic-bezier edge path between two nodes, anchored on their
 * `fromSide`/`toSide` and bowing outward from each side — matching
 * Obsidian's own canvas edge rendering. See
 * tools/canvas-player.md [section Concepts/Canvas].
 *
 * @param {{x:number,y:number,width:number,height:number}} fromNode
 * @param {string} fromSide
 * @param {{x:number,y:number,width:number,height:number}} toNode
 * @param {string} toSide
 * @param {{sourceOffset?: number, targetOffset?: number}} [offsets] - fixed
 *   control-point distances overriding the default distance-based
 *   calculation, resolved from the script's front matter by
 *   resolveEdgeOffsets() — see tools/canvas-player.md [section Script Format]
 * @returns {{p1:{x,y}, c1:{x,y}, c2:{x,y}, p2:{x,y}}}
 */
function computeEdgePath(fromNode, fromSide, toNode, toSide, offsets = {}) {
  const p1 = edgeAnchorPoint(fromNode, fromSide);
  const p2 = edgeAnchorPoint(toNode, toSide);
  const n1 = sideNormal(fromSide);
  const n2 = sideNormal(toSide);
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const sourceOffset = offsets.sourceOffset != null
    ? offsets.sourceOffset
    : Math.max(EDGE_SOURCE_OFFSET_MIN, Math.min(dist * 0.5, EDGE_SOURCE_OFFSET_MAX));
  const targetOffset = offsets.targetOffset != null
    ? offsets.targetOffset
    : Math.max(EDGE_TARGET_OFFSET_MIN, Math.min(dist * 0.5, EDGE_TARGET_OFFSET_MAX));
  return {
    p1,
    c1: { x: p1.x + n1.x * sourceOffset, y: p1.y + n1.y * sourceOffset },
    c2: { x: p2.x + n2.x * targetOffset, y: p2.y + n2.y * targetOffset },
    p2,
  };
}

/**
 * Resolves the presentation-wide edge control-point offsets from the
 * script's front matter — see
 * tools/canvas-player.md [section Script Format]. `edge-offset` sets a
 * fixed value for both ends; `edge-target-offset` overrides just the
 * target end, on top of `edge-offset` or the default. Returns `undefined`
 * for an end that is not overridden, so computeEdgePath() falls back to
 * its own distance-based default for that end.
 *
 * @param {{'edge-offset'?: number, 'edge-target-offset'?: number}} frontMatter - presentation script front matter (or a subset of it)
 * @returns {{sourceOffset?: number, targetOffset?: number}}
 */
function resolveEdgeOffsets(frontMatter) {
  const base = typeof frontMatter['edge-offset'] === 'number' ? frontMatter['edge-offset'] : undefined;
  const target = typeof frontMatter['edge-target-offset'] === 'number' ? frontMatter['edge-target-offset'] : base;
  return { sourceOffset: base, targetOffset: target };
}

// ---------------------------------------------------------------------------
// badgeAnchorPoint — badge position on a node's bounding box, see
// tools/canvas-player.md [section Badge Note Front Matter]
// ---------------------------------------------------------------------------

// Per-position offset direction — the position's own OUTWARD direction
// (away from the node), in SVG coordinates where y grows downward: `top`
// points up (dy: -1), `bottom` points down (dy: +1), `left`/`right` point
// sideways (dx: ∓1), a corner combines its two edges' outward directions
// (e.g. `top-right` is up-and-right). A positive `offset` moves the badge
// this many units further along this direction (outward); negative moves
// it the same amount the other way (toward the node's interior) — see
// tools/canvas-player.md [section Badge Note Front Matter]. First shipped
// with `top`/`bottom` inverted (dy sign matched the compass word instead
// of the actual SVG direction it points to) — see C-067.
const BADGE_OFFSET_DIRECTIONS = {
  left: { dx: -1, dy: 0 },
  'top-left': { dx: -1, dy: -1 },
  top: { dx: 0, dy: -1 },
  'top-right': { dx: 1, dy: -1 },
  right: { dx: 1, dy: 0 },
  'bottom-right': { dx: 1, dy: 1 },
  bottom: { dx: 0, dy: 1 },
  'bottom-left': { dx: -1, dy: 1 },
};

/**
 * Point on a node's bounding box for a badge's `position` — one of eight
 * compass positions (a corner or an edge midpoint), independent of the
 * node's `shape` (the same anchor works for a rectangle, a circle, or a
 * diamond), displaced by `offset` along that position's own direction
 * (BADGE_OFFSET_DIRECTIONS) — see tools/canvas-player.md [section Badge
 * Note Front Matter]. Falls back to `top-right`, the documented default,
 * for an absent or unrecognized `position`.
 *
 * @param {{x:number,y:number,width:number,height:number}} node
 * @param {string} [position] - one of left | top-left | top | top-right | right | bottom-right | bottom | bottom-left
 * @param {number} [offset] - displacement along position's own direction; negative toward the node's interior, positive further outward. Default 0.
 * @returns {{x:number, y:number}}
 */
function badgeAnchorPoint(node, position, offset = 0) {
  const { x, y, width, height } = node;
  const resolvedPosition = BADGE_OFFSET_DIRECTIONS[position] ? position : 'top-right';
  let point;
  switch (resolvedPosition) {
    case 'left': point = { x, y: y + height / 2 }; break;
    case 'top-left': point = { x, y }; break;
    case 'top': point = { x: x + width / 2, y }; break;
    case 'right': point = { x: x + width, y: y + height / 2 }; break;
    case 'bottom-right': point = { x: x + width, y: y + height }; break;
    case 'bottom': point = { x: x + width / 2, y: y + height }; break;
    case 'bottom-left': point = { x, y: y + height }; break;
    default: point = { x: x + width, y }; // top-right
  }
  const dir = BADGE_OFFSET_DIRECTIONS[resolvedPosition];
  return { x: point.x + dir.dx * offset, y: point.y + dir.dy * offset };
}

// ---------------------------------------------------------------------------
// buildGroupMembership
// ---------------------------------------------------------------------------

/**
 * Maps each group node id to the ids of the file nodes positioned inside
 * its bounding box, per the canvas layout — see
 * tools/canvas-player.md [section Concepts/Canvas].
 *
 * @param {{nodes: Array<Object>}} canvas - parsed .canvas JSON
 * @returns {Map<string, string[]>}
 */
function buildGroupMembership(canvas) {
  const groups = canvas.nodes.filter(n => n.type === 'group');
  const files = canvas.nodes.filter(n => n.type === 'file');
  const membership = new Map();

  for (const group of groups) {
    const gLeft = group.x, gRight = group.x + group.width;
    const gTop = group.y, gBottom = group.y + group.height;
    const members = files
      .filter(f => f.x >= gLeft && f.x + f.width <= gRight && f.y >= gTop && f.y + f.height <= gBottom)
      .map(f => f.id);
    membership.set(group.id, members);
  }
  return membership;
}

/** Expands node/group ids into file-node ids only, per groupMembership. Groups have no rendering of their own. */
function expandIds(ids, groupMembership) {
  const expanded = new Set();
  for (const id of ids) {
    if (groupMembership.has(id)) {
      for (const memberId of groupMembership.get(id)) expanded.add(memberId);
    } else {
      expanded.add(id);
    }
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// classifyReference / buildNodeLookup / buildGroupLookup / resolveScriptSteps
// — script target resolution, see tools/canvas-player.md [section Script Format]
// ---------------------------------------------------------------------------

/**
 * Classifies one raw script reference token: '[[Note Name]]' targets a file
 * node (via its linked micro-note), '[Group Label]' targets a group,
 * '{tag, key:value}' targets a condition group — every file node whose
 * linked micro-note satisfies all of the listed conditions, same syntax
 * and AND semantics as one Style Mapper/Badge Mapper entry (see
 * parseConditionList()) — see tools/canvas-player.md [section Script
 * Format].
 *
 * @param {string} token - e.g. '[[Intro Note]]', '[Core Ideas]', or '{warning, level:0}'
 * @returns {{type: 'node', target: string}|{type: 'group', label: string}|{type: 'condition', conditions: Array<{type:string}>}}
 * @throws {Error} if the token is neither a wikilink, a bracketed label, nor a non-empty condition group
 */
function classifyReference(token) {
  const str = String(token);
  const wikilink = str.match(/^\[\[(.+)\]\]$/);
  if (wikilink) return { type: 'node', target: wikilink[1] };
  const groupRef = str.match(/^\[(.+)\]$/);
  if (groupRef) return { type: 'group', label: groupRef[1] };
  const conditionRef = str.match(/^\{(.+)\}$/);
  if (conditionRef) {
    const conditions = parseConditionList(conditionRef[1]);
    if (conditions.length === 0) {
      throw new Error(`Invalid script target syntax: "${str}" — a condition group must list at least one tag or key:value condition.`);
    }
    return { type: 'condition', conditions };
  }
  throw new Error(`Invalid script target syntax: "${str}" \u2014 expected [[Note Name]] for a node, [Group Label] for a group, or {tag, key:value} for a condition group.`);
}

/**
 * Builds a lookup from micro-note vault-relative file path to file-node id.
 * Throws if a micro-note is linked by more than one node — see the
 * uniqueness constraint in tools/canvas-player.md [section Script Format].
 *
 * @param {Array<{id: string, file: string}>} fileNodes - canvas nodes of type 'file'
 * @returns {Map<string, string>}
 */
function buildNodeLookup(fileNodes) {
  const lookup = new Map();
  for (const node of fileNodes) {
    if (lookup.has(node.file)) {
      throw new Error(`Ambiguous script target: micro-note "${node.file}" is linked by more than one node in the canvas.`);
    }
    lookup.set(node.file, node.id);
  }
  return lookup;
}

/**
 * Builds a lookup from group label to group id. Throws on a duplicate
 * label — see the uniqueness constraint in
 * tools/canvas-player.md [section Script Format]. Unlabeled groups are
 * skipped (cannot be targeted from a script).
 *
 * @param {Array<{id: string, label?: string}>} groupNodes - canvas nodes of type 'group'
 * @returns {Map<string, string>}
 */
function buildGroupLookup(groupNodes) {
  const lookup = new Map();
  for (const group of groupNodes) {
    if (!group.label) continue;
    if (lookup.has(group.label)) {
      throw new Error(`Ambiguous script target: group label "${group.label}" is used by more than one group in the canvas.`);
    }
    lookup.set(group.label, group.id);
  }
  return lookup;
}

/**
 * Builds each file node's own condition set (tags + flat properties) for
 * condition-group script-target matching, keyed by node id — reuses
 * buildNodeConditions(), the same condition builder used for style/badge-
 * mapper matching. Read once per presentation, alongside the micro-note
 * loading already done for style resolution — see
 * tools/canvas-player.md [section Script Format] and [section How It
 * Works].
 *
 * @param {Array<{id: string, localFm: Object}>} fileNodesWithFrontMatter - one entry per canvas file node, with its linked micro-note's parsed front matter
 * @returns {Map<string, Array<{type:string}>>} node id -> its condition set (buildNodeConditions())
 */
function buildNodeConditionsLookup(fileNodesWithFrontMatter) {
  const lookup = new Map();
  for (const { id, localFm } of fileNodesWithFrontMatter) {
    lookup.set(id, buildNodeConditions(localFm));
  }
  return lookup;
}

/**
 * Builds a lookup from file node id to its linked micro-note's
 * vault-relative path — the inverse of buildNodeLookup(). Used to sort a
 * show-focus-each-in group's member nodes by filename, independent of
 * canvas layout — see tools/canvas-player.md [section Script Format].
 *
 * @param {Array<{id: string, file: string}>} fileNodes - canvas nodes of type 'file'
 * @returns {Map<string, string>}
 */
function buildNodeFileById(fileNodes) {
  const map = new Map();
  for (const node of fileNodes) map.set(node.id, node.file);
  return map;
}

/** Last path segment of a vault-relative file path, e.g. 'a/b/Note.md' -> 'Note.md' — the filename used to sort show-focus-each-in group members, see tools/canvas-player.md [section Script Format]. */
function fileBasename(filePath) {
  return String(filePath).split('/').pop();
}

/**
 * Resolves a condition-group script target ({tag, key:value, ...}) to the
 * ids of every file node whose own condition set satisfies every listed
 * condition (AND, via conditionsMatch()) — see
 * tools/canvas-player.md [section Script Format]. Zero matches is a
 * valid, silent result, unlike an unresolved wikilink or group label.
 *
 * @param {Array<{type:string}>} conditions - parsed via parseConditionList() (classifyReference())
 * @param {Map<string, Array<{type:string}>>} nodeConditionsLookup - node id -> its own conditions (buildNodeConditionsLookup())
 * @returns {string[]} matching file node ids
 */
function resolveConditionGroupIds(conditions, nodeConditionsLookup = new Map()) {
  const matches = [];
  for (const [nodeId, nodeConditions] of nodeConditionsLookup) {
    if (conditionsMatch(nodeConditions, conditions)) matches.push(nodeId);
  }
  return matches;
}

/**
 * Resolves one step directive's raw tokens to canvas node ids. A wikilink
 * or group-label token resolves to exactly one id (a node id or a group
 * id, expanded to its members later by applyStepDeltas()); a condition-
 * group token resolves directly to zero or more file node ids — see
 * tools/canvas-player.md [section Script Format].
 *
 * @param {string[]} tokens
 * @param {{nodeLookup: Map<string,string>, groupLookup: Map<string,string>, vaultIndex: Map<string,string[]>, nodeConditionsLookup?: Map<string,Array<{type:string}>>}} ctx
 * @returns {string[]} resolved canvas ids
 */
function resolveStepIds(tokens, { nodeLookup, groupLookup, vaultIndex, nodeConditionsLookup }) {
  return tokens.flatMap(token => {
    const ref = classifyReference(token);
    if (ref.type === 'node') {
      const filePath = resolveWikilink(ref.target, vaultIndex);
      const nodeId = nodeLookup.get(filePath);
      if (!nodeId) throw new Error(`No canvas node links to "${filePath}" (referenced as [[${ref.target}]])`);
      return [nodeId];
    }
    if (ref.type === 'group') {
      const groupId = groupLookup.get(ref.label);
      if (!groupId) throw new Error(`No group with label "${ref.label}" found in canvas`);
      return [groupId];
    }
    return resolveConditionGroupIds(ref.conditions, nodeConditionsLookup);
  });
}

/**
 * Resolves one show-focus-each-in heading's raw target tokens into its
 * generated show-focus steps, walking into any group target (a canvas
 * group label or a condition group) instead of stopping at it — unlike
 * show-focus-each, which treats a group as a single opaque token. Each
 * group target expands into one step per member file node, ordered by
 * the linked micro-note's own filename; an individual wikilink target is
 * a group of one, producing a single step — see
 * tools/canvas-player.md [section Script Format].
 *
 * @param {string[]} tokens - raw target tokens (parseTargetList() output)
 * @param {string} transition
 * @param {string} label
 * @param {{nodeLookup: Map<string,string>, groupLookup: Map<string,string>, vaultIndex: Map<string,string[]>, nodeConditionsLookup: Map<string,Array<{type:string}>>, groupMembership: Map<string,string[]>, nodeFileById: Map<string,string>}} ctx
 * @returns {Array<{show:string[], hide:string[], inFocus:string[], outFocus:string[], transition:string, label:string}>}
 */
function resolveEachInSteps(tokens, transition, label, ctx) {
  const { nodeLookup, groupLookup, vaultIndex, nodeConditionsLookup, groupMembership, nodeFileById } = ctx;
  const byFilename = (a, b) => fileBasename(nodeFileById.get(a) || '').localeCompare(fileBasename(nodeFileById.get(b) || ''));

  return tokens.flatMap(token => {
    const ref = classifyReference(token);
    let memberIds;
    if (ref.type === 'node') {
      const filePath = resolveWikilink(ref.target, vaultIndex);
      const nodeId = nodeLookup.get(filePath);
      if (!nodeId) throw new Error(`No canvas node links to "${filePath}" (referenced as [[${ref.target}]])`);
      memberIds = [nodeId];
    } else if (ref.type === 'group') {
      const groupId = groupLookup.get(ref.label);
      if (!groupId) throw new Error(`No group with label "${ref.label}" found in canvas`);
      memberIds = [...(groupMembership.get(groupId) || [])].sort(byFilename);
    } else {
      memberIds = resolveConditionGroupIds(ref.conditions, nodeConditionsLookup).sort(byFilename);
    }
    return memberIds.map(id => ({ show: [id], hide: [], inFocus: [id], outFocus: [], transition, label }));
  });
}

/**
 * Resolves every step's show/hide/in-focus/out-focus token lists to canvas
 * ids, given the node/group lookups and vault index built from the loaded
 * canvas — see tools/canvas-player.md [section Script Format]. `label`
 * (the heading's own free-form text, used by the step selector — see
 * tools/canvas-player.md [section Controls]) passes through unchanged. A
 * show-focus-each-in pseudo-step (carrying `eachInTargets` instead of
 * resolved-looking token lists, see parseStepBlock()) expands into one or
 * more resolved steps via resolveEachInSteps() instead of the normal
 * per-directive resolution — this is why the result can have more steps
 * than the input.
 *
 * @param {Array<{show:string[], hide:string[], inFocus:string[], outFocus:string[], transition:string, label:string, eachInTargets?:string[]}>} steps
 * @param {{nodeLookup: Map<string,string>, groupLookup: Map<string,string>, vaultIndex: Map<string,string[]>, nodeConditionsLookup?: Map<string,Array<{type:string}>>, groupMembership?: Map<string,string[]>, nodeFileById?: Map<string,string>}} ctx
 * @returns {Array<{show:string[], hide:string[], inFocus:string[], outFocus:string[], transition:string, label:string}>}
 */
function resolveScriptSteps(steps, ctx) {
  return steps.flatMap(step => {
    if (step.eachInTargets) {
      return resolveEachInSteps(step.eachInTargets, step.transition, step.label, ctx);
    }
    return [{
      show: resolveStepIds(step.show, ctx),
      hide: resolveStepIds(step.hide, ctx),
      inFocus: resolveStepIds(step.inFocus, ctx),
      outFocus: resolveStepIds(step.outFocus, ctx),
      transition: step.transition,
      label: step.label,
    }];
  });
}

// ---------------------------------------------------------------------------
// applyStepDeltas — the step engine
// ---------------------------------------------------------------------------

/**
 * Applies one step's show/hide/in-focus/out-focus deltas to the visible and
 * focus sets inherited from the previous step. Group ids are expanded to
 * their member file-node ids before being applied — see
 * tools/canvas-player.md [section Script Format].
 *
 * @param {Set<string>} prevVisible
 * @param {Set<string>} prevFocus
 * @param {{show:string[], hide:string[], inFocus:string[], outFocus:string[]}} step
 * @param {Map<string,string[]>} groupMembership
 * @returns {{ visible: Set<string>, focus: Set<string> }}
 */
function applyStepDeltas(prevVisible, prevFocus, step, groupMembership) {
  const visible = new Set(prevVisible);
  for (const id of expandIds(step.show, groupMembership)) visible.add(id);
  for (const id of expandIds(step.hide, groupMembership)) visible.delete(id);

  const focus = new Set(prevFocus);
  for (const id of expandIds(step.inFocus, groupMembership)) focus.add(id);
  for (const id of expandIds(step.outFocus, groupMembership)) focus.delete(id);

  return { visible, focus };
}

// ---------------------------------------------------------------------------
// computeFitBox
// ---------------------------------------------------------------------------

/**
 * Computes the padded bounding box union of the currently focused file
 * nodes, for the auto pan/zoom fit. Returns null when the focus set is
 * empty — the view does not move, see
 * tools/canvas-player.md [section How It Works].
 *
 * @param {Array<{id:string,x:number,y:number,width:number,height:number}>} nodes
 * @param {Set<string>} focusIds
 * @param {number} padding
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
function computeFitBox(nodes, focusIds, padding) {
  const focused = nodes.filter(n => focusIds.has(n.id));
  if (focused.length === 0) return null;

  const left = Math.min(...focused.map(n => n.x));
  const top = Math.min(...focused.map(n => n.y));
  const right = Math.max(...focused.map(n => n.x + n.width));
  const bottom = Math.max(...focused.map(n => n.y + n.height));

  return {
    x: left - padding,
    y: top - padding,
    width: (right - left) + 2 * padding,
    height: (bottom - top) + 2 * padding,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  parseFrontMatter,
  extractWikilinkTarget,
  resolveNoteFile,
  resolveWikilink,
  parseTagList,
  parseConditionList,
  parseStyleMapper,
  buildNodeConditions,
  resolveConditionStyleTarget,
  resolveNodeStyleTarget,
  parseBadgeMapper,
  resolveConditionBadgeTarget,
  resolveNodeBadgeTarget,
  composeNodeStyle,
  resolveText,
  parseMicroNoteBody,
  resolveBody,
  splitBodyIntoParagraphs,
  resolvePaletteTargets,
  isColorLiteral,
  interpolateColors,
  parsePalette,
  mergePalettes,
  resolveColor,
  resolveStyleColors,
  resolveBadgeColors,
  resolveTheme,
  resolveTransitionDuration,
  parsePresentationScript,
  classifyReference,
  buildNodeLookup,
  buildGroupLookup,
  buildNodeConditionsLookup,
  buildNodeFileById,
  resolveConditionGroupIds,
  resolveScriptSteps,
  buildGroupMembership,
  applyStepDeltas,
  edgeAnchorPoint,
  computeEdgePath,
  resolveEdgeOffsets,
  badgeAnchorPoint,
  computeFitBox,
};
