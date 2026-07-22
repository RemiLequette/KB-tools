/**
 * canvas-player.js
 *
 * Browser-side runtime for canvas-player: loads a presentation script, its
 * canvas, and micro-notes through the shared local server, renders the
 * graph as SVG, and drives the step engine (show/hide, pan/zoom fit, fade).
 * All parsing/cascade/step-engine logic is delegated to
 * lib/canvas-player-core.js — this file only does DOM/SVG rendering,
 * fetch orchestration, and control wiring.
 *
 * References (documents used to design this script):
 *   - tools/canvas-player.md (full spec)
 *   - tools/canvas-player.md [section Micro-note Front Matter/Style resolution]
 *   - tools/canvas-player.md [section Style Note Front Matter]
 *   - tools/canvas-player.md [section Style Mapper Front Matter]
 *   - tools/canvas-player.md [section Badge Note Front Matter]
 *   - tools/canvas-player.md [section Badge Mapper Front Matter]
 *   - conventions/local-server.md [section API Contract, section Building API paths in pages]
 *   - conventions/color-palette.md
 *   - lib/canvas-player-core.js
 *
 * Not yet in references (document debt — update the refs to absorb these):
 *   - Entry point contract: this page is opened plain (no required query
 *     params) and the "Open script" button browses the local server's
 *     /dir API to pick a presentation script .md file. A native file
 *     picker was considered and rejected: browsers never expose the
 *     absolute path of a natively-picked file, which this tool needs to
 *     resolve the canvas and micro-notes next to it. A dropdown of
 *     favorite vault roots (name -> absolute path, in localStorage) speeds
 *     up starting the browse across several vaults. Optional query params
 *     script=<absolute-path>&vault=<absolute-path>[&lang=en] skip the
 *     picker and load directly. tools/canvas-player.md does not specify
 *     how the script is selected.
 *   - Vault root auto-detection: once a script is picked, the vault root
 *     is found by walking up parent directories (via /dir) looking for a
 *     `.obsidian` folder — the actual Obsidian vault-root marker — and is
 *     used to resolve canvas node `file` fields (vault-relative paths).
 *     Not specified by tools/canvas-player.md.
 *   - Icon rendering (`icon:` front matter field) fetches the matching
 *     Lucide icon SVG from unpkg.com at load time and caches it; falls
 *     back to the placeholder letter badge if the fetch fails (no network,
 *     unknown icon name). Not specified by tools/canvas-player.md which CDN
 *     or fallback behavior is used.
 *   - No keyboard shortcuts (decided out of scope for now, see T-020 notes).
 *   - Pan/zoom transition is animated via requestAnimationFrame with an
 *     ease-in-out-quad curve, not a native CSS transition on the viewBox
 *     attribute (unreliable cross-browser). The easing curve itself is not
 *     specified by tools/canvas-player.md.
 */

import {
  parseFrontMatter,
  extractWikilinkTarget,
  resolveWikilink,
  parseStyleMapper,
  resolveNodeStyleTarget,
  parseBadgeMapper,
  resolveNodeBadgeTarget,
  composeNodeStyle,
  resolveText,
  parseMicroNoteBody,
  resolveBody,
  splitBodyIntoParagraphs,
  resolvePaletteTargets,
  parsePalette,
  mergePalettes,
  resolveStyleColors,
  resolveBadgeColors,
  resolveTheme,
  resolveTransitionDuration,
  parsePresentationScript,
  buildNodeLookup,
  buildGroupLookup,
  buildNodeConditionsLookup,
  buildNodeFileById,
  resolveScriptSteps,
  buildGroupMembership,
  applyStepDeltas,
  computeEdgePath,
  resolveEdgeOffsets,
  badgeAnchorPoint,
  computeFitBox,
} from './lib/canvas-player-core.js';

// ---------------------------------------------------------------------------
// Path helpers — server paths use forward slashes regardless of OS,
// see conventions/local-server.md [section URL scheme for static files]
// ---------------------------------------------------------------------------

function toServerPath(p) {
  return String(p).replace(/\\/g, '/');
}

function dirOf(p) {
  const norm = toServerPath(p);
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? '' : norm.slice(0, idx);
}

function joinPath(dir, file) {
  return dir ? `${dir}/${file}` : file;
}

/** Path of `file` relative to `root`, both server (forward-slash) paths. */
function relativeTo(root, file) {
  const r = toServerPath(root).replace(/\/$/, '');
  const f = toServerPath(file);
  return f.startsWith(`${r}/`) ? f.slice(r.length + 1) : f;
}

// ---------------------------------------------------------------------------
// Server fetch helpers
// ---------------------------------------------------------------------------

async function ping() {
  try {
    const res = await fetch('/ping');
    return res.ok;
  } catch {
    return false;
  }
}

async function readFile(absolutePath) {
  const res = await fetch(`/file?path=${encodeURIComponent(toServerPath(absolutePath))}`);
  if (!res.ok) throw new Error(`Failed to read ${absolutePath}: ${res.status}`);
  return res.text();
}

async function listDir(absolutePath) {
  const res = await fetch(`/dir?path=${encodeURIComponent(toServerPath(absolutePath))}`);
  if (!res.ok) throw new Error(`Failed to list ${absolutePath}: ${res.status}`);
  const { entries } = await res.json();
  return entries;
}

/**
 * Walks up parent directories from `startDir` looking for a `.obsidian`
 * folder — the Obsidian vault-root marker. Returns the vault root path,
 * or null if none is found within `maxHops` levels.
 */
async function findVaultRoot(startDir, maxHops = 20) {
  let dir = startDir;
  for (let i = 0; i < maxHops; i++) {
    let entries;
    try {
      entries = await listDir(dir);
    } catch {
      return null;
    }
    if (entries.some(e => e.type === 'dir' && e.name === '.obsidian')) return dir;
    const parent = dirOf(dir);
    if (!parent || parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Recursively indexes every file under `vaultRoot` via GET /dir, mapping
 * filename -> vault-relative path list. Backs vault-wide wikilink
 * resolution — see tools/canvas-player.md [section How It Works].
 * Skips `.obsidian` (Obsidian's own config folder, not vault content).
 */
async function buildVaultIndex(vaultRoot) {
  const index = new Map();
  async function walk(dir) {
    let entries;
    try {
      entries = await listDir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.type === 'dir') {
        if (e.name === '.obsidian') continue;
        await walk(joinPath(dir, e.name));
      } else {
        const relPath = relativeTo(vaultRoot, joinPath(dir, e.name));
        const list = index.get(e.name) || [];
        list.push(relPath);
        index.set(e.name, list);
      }
    }
  }
  await walk(vaultRoot);
  return index;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
let scriptPath = params.get('script');
let vaultRoot  = params.get('vault');
// `lang` query param wins if given; otherwise the last language selected in
// a previous session (localStorage, see getLastLang() below), otherwise
// 'en' — see tools/canvas-player.md [section Controls].
let lang       = params.get('lang') || getLastLang() || 'en';

const LAST_SCRIPT_KEY = 'canvas-player:last-script'; // { script, vault }

function getLastScript() {
  try {
    return JSON.parse(localStorage.getItem(LAST_SCRIPT_KEY));
  } catch {
    return null;
  }
}

function saveLastScript(script, vault) {
  try {
    localStorage.setItem(LAST_SCRIPT_KEY, JSON.stringify({ script, vault }));
  } catch {
    // localStorage unavailable — non-fatal, persistence is a convenience only
  }
}

const LAST_LANG_KEY = 'canvas-player:last-lang';

/** Reads the last presentation language successfully selected via the language dropdown, or null if none/unavailable. */
function getLastLang() {
  try {
    return localStorage.getItem(LAST_LANG_KEY);
  } catch {
    return null;
  }
}

/** Persists the given language as the last one selected, for the next session's default (see the `lang` initialization above) — see tools/canvas-player.md [section Controls]. */
function saveLastLang(l) {
  try {
    localStorage.setItem(LAST_LANG_KEY, l);
  } catch {
    // localStorage unavailable — non-fatal, persistence is a convenience only
  }
}

// No script given on the URL — default to the last one successfully opened,
// per tools/canvas-player.md [section Controls].
if (!scriptPath) {
  const last = getLastScript();
  if (last && last.script) {
    scriptPath = last.script;
    vaultRoot = last.vault || vaultRoot;
  }
}

const state = {
  canvasNodes: [],       // file nodes only, with resolved style
  groupMembership: null, // Map<groupId, nodeId[]>
  steps: [],
  stepIndex: -1,
  visible: new Set(),
  focus: new Set(),
  viewBox: null,         // last rendered {x,y,width,height} — animation start point
  edgeOffsets: {},       // resolved from the script's edge-offset/edge-target-offset, see tools/canvas-player.md [section Script Format]
};

const PADDING = 60;
let transitionDurationMs = 1000; // resolved from the script's front matter, see tools/canvas-player.md [section Script Format]

// Step position across a Reload — kept in memory only, for the current page
// session, never written to localStorage (unlike the last script/last
// language, see getLastScript()/getLastLang() above): set by the Reload
// button just before loadPresentation() runs, consumed and cleared at the
// end of loadPresentation() — see tools/canvas-player.md [section Controls].
let reloadStepIndex = null;

// ---------------------------------------------------------------------------
// Theme — see tools/canvas-player.md [section Script Format]
// ---------------------------------------------------------------------------

/** Applies a resolved theme (background/edge/text colors, edge width) as CSS custom properties on the document root. */
function applyTheme(theme) {
  const root = document.documentElement.style;
  root.setProperty('--cp-bg', theme.background);
  root.setProperty('--cp-edge', theme.edge);
  root.setProperty('--cp-text', theme.text);
  root.setProperty('--cp-edge-width', theme.edgeWidth);
}

// ---------------------------------------------------------------------------
// Icons — Lucide, fetched from CDN and cached; falls back to a
// letter badge when a fetch fails (no network, unknown icon name) — see
// tools/canvas-player.md [section Micro-note Front Matter]
// ---------------------------------------------------------------------------

const ICON_CDN_BASE = 'https://unpkg.com/lucide-static@latest/icons/';
const iconCache = new Map(); // icon name -> parsed <svg> Element, or null on failure

async function loadIcon(name) {
  if (iconCache.has(name)) return iconCache.get(name);
  try {
    const res = await fetch(`${ICON_CDN_BASE}${name}.svg`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const svgText = await res.text();
    const svgEl = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement;
    if (svgEl.nodeName !== 'svg') throw new Error('unexpected content');
    iconCache.set(name, svgEl);
    return svgEl;
  } catch (err) {
    console.warn(`canvas-player: could not load icon "${name}" from Lucide CDN, falling back to letter badge.`, err);
    iconCache.set(name, null);
    return null;
  }
}

/** Pre-fetches every distinct icon used by the given nodes, once, before the first render — both a node's own content icon and its resolved badge icon, if any, see tools/canvas-player.md [section Badge Note Front Matter]. */
async function preloadIcons(nodes) {
  const names = [...new Set(nodes.flatMap(n => [n.style.icon, n.badge && n.badge.icon]).filter(Boolean))];
  await Promise.all(names.map(loadIcon));
}

// ---------------------------------------------------------------------------
// Loading — Steps 1-4 of tools/canvas-player.md [section How It Works]
// ---------------------------------------------------------------------------

async function loadPresentation() {
  if (!scriptPath) {
    openBrowser();
    return;
  }

  if (!vaultRoot) {
    vaultRoot = await findVaultRoot(dirOf(scriptPath));
    if (!vaultRoot) {
      setStepError();
      console.error('canvas-player: could not find a .obsidian vault root above', scriptPath);
      return;
    }
  }

  const scriptText = await readFile(scriptPath);
  const script = parsePresentationScript(scriptText);

  const vaultIndex = await buildVaultIndex(vaultRoot);

  // `palette` — zero or more palette-note wikilinks, resolved vault-wide the
  // same way as the canvas and micro-notes, then merged into a single
  // name -> hex map (later palette wins on a name collision) — see
  // conventions/color-palette.md and tools/canvas-player.md [section Script
  // Format]. An empty list (no `palette` set) merges to {}, so every color
  // resolution below simply requires literal hex, unchanged from before.
  const paletteTargets = resolvePaletteTargets(script);
  const palettes = await Promise.all(paletteTargets.map(async target => {
    const relPath = resolveWikilink(target, vaultIndex);
    const text = await readFile(joinPath(vaultRoot, relPath));
    try {
      return parsePalette(parseFrontMatter(text));
    } catch (err) {
      // Adds the palette note's own path to the error — not known inside
      // parsePalette() itself, which stays pure/file-agnostic, see
      // lib/canvas-player-core.js.
      throw new Error(`${relPath}: ${err.message}`);
    }
  }));
  const palette = mergePalettes(palettes);

  let theme;
  try {
    theme = resolveTheme(script, palette);
  } catch (err) {
    // Adds the script's own path to the error — not known inside
    // resolveTheme() itself, see lib/canvas-player-core.js.
    throw new Error(`${scriptPath}: ${err.message}`);
  }
  applyTheme(theme);

  // `style-mapper` — zero or one style-mapper note, resolved vault-wide the
  // same way as the canvas and micro-notes, then parsed into its tag rules
  // and `default` entry — see tools/canvas-player.md [section Style Mapper
  // Front Matter]. Absent `style-mapper` yields an empty mapper, so a node
  // relying on tags or on `default` (rather than a direct `style`) fails
  // loudly in resolveNodeStyleTarget() below, same as an unresolved
  // wikilink.
  let styleMapper = { entries: [], defaultTarget: null };
  if (script['style-mapper']) {
    const mapperTarget = extractWikilinkTarget(script['style-mapper']);
    const mapperRelPath = resolveWikilink(mapperTarget, vaultIndex);
    try {
      styleMapper = parseStyleMapper(parseFrontMatter(await readFile(joinPath(vaultRoot, mapperRelPath))));
    } catch (err) {
      throw new Error(`${mapperRelPath}: ${err.message}`);
    }
  }
  // `badge-mapper` — zero or one badge-mapper note, resolved vault-wide the
  // same way as style-mapper, then parsed into its condition-matching
  // entries — see tools/canvas-player.md [section Badge Mapper Front
  // Matter]. Absent `badge-mapper` yields an empty mapper, so every node
  // simply has no badge (not an error, unlike an unresolved style) — see
  // resolveNodeBadgeTarget() in lib/canvas-player-core.js.
  let badgeMapper = { entries: [] };
  if (script['badge-mapper']) {
    const badgeMapperTarget = extractWikilinkTarget(script['badge-mapper']);
    const badgeMapperRelPath = resolveWikilink(badgeMapperTarget, vaultIndex);
    try {
      badgeMapper = parseBadgeMapper(parseFrontMatter(await readFile(joinPath(vaultRoot, badgeMapperRelPath))));
    } catch (err) {
      throw new Error(`${badgeMapperRelPath}: ${err.message}`);
    }
  }

  transitionDurationMs = resolveTransitionDuration(script) * 1000;
  state.edgeOffsets = resolveEdgeOffsets(script);

  const canvasRelPath = resolveWikilink(script.canvas, vaultIndex);
  const canvasPath = joinPath(vaultRoot, canvasRelPath);
  const canvasJson = JSON.parse(await readFile(canvasPath));

  state.groupMembership = buildGroupMembership(canvasJson);

  const fileNodes = canvasJson.nodes.filter(n => n.type === 'file');
  const groupNodes = canvasJson.nodes.filter(n => n.type === 'group');
  const nodeLookup = buildNodeLookup(fileNodes);
  const groupLookup = buildGroupLookup(groupNodes);

  // Micro-note front matter is read once, up front, for every file node —
  // needed both for condition-group script-target matching ({tag,
  // key:value}, see tools/canvas-player.md [section Script Format]) and,
  // below, for style/badge resolution — the same fetch backs both, rather
  // than reading each micro-note twice.
  const microNoteData = await Promise.all(fileNodes.map(async node => {
    const noteText = await readFile(joinPath(vaultRoot, node.file));
    return { id: node.id, localFm: parseFrontMatter(noteText), noteText };
  }));
  const nodeConditionsLookup = buildNodeConditionsLookup(microNoteData);
  const nodeFileById = buildNodeFileById(fileNodes);

  state.steps = resolveScriptSteps(script.steps, {
    nodeLookup, groupLookup, vaultIndex,
    nodeConditionsLookup, groupMembership: state.groupMembership, nodeFileById,
  });
  populateStepSelect();

  const microNoteById = new Map(microNoteData.map(m => [m.id, m]));

  state.canvasNodes = await Promise.all(fileNodes.map(async node => {
    const { localFm, noteText } = microNoteById.get(node.id);

    let style;
    try {
      // Style resolution order — direct `style:`, else the style-mapper
      // entry matching `tags`, else the style-mapper's `default` — see
      // tools/canvas-player.md [section Micro-note Front Matter/Style
      // resolution]. The resolved style note is then read the same
      // vault-wide way as any other wikilink target, and its visual
      // properties are combined with the micro-note's own content fields.
      const styleTarget = resolveNodeStyleTarget(localFm, styleMapper);
      const styleRelPath = resolveWikilink(styleTarget, vaultIndex);
      const styleFm = parseFrontMatter(await readFile(joinPath(vaultRoot, styleRelPath)));
      style = resolveStyleColors(composeNodeStyle(localFm, styleFm), palette);
    } catch (err) {
      // Adds the micro-note's own path to the error — not known inside
      // resolveNodeStyleTarget()/resolveStyleColors() themselves, which stay
      // pure/file-agnostic, see lib/canvas-player-core.js.
      throw new Error(`${node.file}: ${err.message}`);
    }

    // `image:` — vault-linked image, resolved the same vault-wide way as
    // `style:` — see tools/canvas-player.md [section Micro-note Front Matter].
    // Resolved to a /file server URL (GET /file serves the raw bytes with
    // the correct Content-Type, see conventions/local-server.md [section API
    // Contract, "GET /file"]), usable directly as an SVG <image> href.
    if (style.image) {
      const imageRelPath = resolveWikilink(extractWikilinkTarget(style.image), vaultIndex);
      const imageAbsPath = joinPath(vaultRoot, imageRelPath);
      style.imageUrl = `/file?path=${encodeURIComponent(toServerPath(imageAbsPath))}`;
    }

    // Badge resolution — independent of style resolution above, via the
    // presentation's badge-mapper (if set) — see tools/canvas-player.md
    // [section Badge Mapper Front Matter]. No match (or no `badge-mapper`
    // set at all) simply means no badge for this node, not an error.
    let badge = null;
    try {
      const badgeTarget = resolveNodeBadgeTarget(localFm, badgeMapper);
      if (badgeTarget) {
        const badgeRelPath = resolveWikilink(badgeTarget, vaultIndex);
        const badgeFm = parseFrontMatter(await readFile(joinPath(vaultRoot, badgeRelPath)));
        badge = resolveBadgeColors(badgeFm, palette);
      }
    } catch (err) {
      // Adds the micro-note's own path to the error, same treatment as the
      // style-resolution try/catch above.
      throw new Error(`${node.file}: ${err.message}`);
    }

    return {
      id: node.id,
      x: node.x, y: node.y, width: node.width, height: node.height,
      style,
      body: parseMicroNoteBody(noteText), // per-language body sections (## en / ## fr), see tools/canvas-player.md [section Micro-note Front Matter]
      badge, // resolved badge (icon/color/position), or null — see tools/canvas-player.md [section Badge Note Front Matter]
    };
  }));

  state.canvasEdges = canvasJson.edges || [];

  await preloadIcons(state.canvasNodes);

  saveLastScript(scriptPath, vaultRoot);

  // Apply Step 0, or restore the step a Reload was triggered from when it
  // is still valid for the reloaded script (same or greater step count) —
  // see tools/canvas-player.md [section How It Works], step 5, and
  // [section Controls]. A restore index no longer valid (the script now
  // has fewer steps) falls back to Step 0, same as a first load.
  state.stepIndex = -1;
  state.visible = new Set();
  state.focus = new Set();
  state.viewBox = null;
  const restoreIndex = reloadStepIndex;
  reloadStepIndex = null;
  const startIndex = restoreIndex !== null && restoreIndex < state.steps.length ? restoreIndex : 0;
  goToStep(startIndex, 'cut');
}

// ---------------------------------------------------------------------------
// Step display — the step-number input and total, see
// tools/canvas-player.md [section Controls]
// ---------------------------------------------------------------------------

/** Reflects the current step (1-based) and total into the step-nav input/label, re-enabling the input after a prior error. */
function updateStepDisplay(targetIndex) {
  const input = document.getElementById('step-input');
  const total = document.getElementById('step-total');
  input.disabled = false;
  input.max = state.steps.length;
  input.value = targetIndex + 1;
  total.textContent = `/ ${state.steps.length}`;

  const select = document.getElementById('step-select');
  select.disabled = false;
  select.value = targetIndex;
}

/**
 * Rebuilds the step-select dropdown from state.steps, one option per step
 * in playback order, so the viewer can jump directly to a step by its
 * label (the free-form text after `## Step` in the script, captured by
 * parsePresentationScript() — see tools/canvas-player.md [section Script
 * Format] and [section Controls]). A step with no label (bare `## Step`)
 * falls back to "Step N"; a step whose heading used `show-focus-each` and
 * so shares its label with sibling steps shows identically — there is
 * nothing more specific to disambiguate them by, only their position
 * differs.
 */
function populateStepSelect() {
  const select = document.getElementById('step-select');
  select.innerHTML = '';
  state.steps.forEach((step, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = step.label ? step.label : `Step ${i + 1}`;
    select.appendChild(opt);
  });
}

/** Shows an error state in the step-nav (load failure) — mirrors the previous step-label 'error' text. */
function setStepError() {
  const input = document.getElementById('step-input');
  const total = document.getElementById('step-total');
  input.value = '';
  input.disabled = true;
  total.textContent = 'error';

  const select = document.getElementById('step-select');
  select.innerHTML = '';
  select.disabled = true;
}

/** Reads the step-input value, clamps it to the valid step range, and jumps there — called on Enter, see wireControls(). */
function jumpToStepInput() {
  const input = document.getElementById('step-input');
  const raw = parseInt(input.value, 10);
  if (!state.steps.length || isNaN(raw)) { updateStepDisplay(state.stepIndex); return; }
  const clamped = Math.min(Math.max(raw, 1), state.steps.length);
  goToStep(clamped - 1, 'cut');
  input.blur();
}

// ---------------------------------------------------------------------------
// Step navigation — recomputes cumulative state from Step 0 for determinism
// on both forward and backward moves.
// ---------------------------------------------------------------------------

function goToStep(targetIndex, forcedTransition) {
  if (targetIndex < 0 || targetIndex >= state.steps.length) return;

  let visible = new Set();
  let focus = new Set();
  for (let i = 0; i <= targetIndex; i++) {
    const result = applyStepDeltas(visible, focus, state.steps[i], state.groupMembership);
    visible = result.visible;
    focus = result.focus;
  }

  const transition = forcedTransition || state.steps[targetIndex].transition;
  state.stepIndex = targetIndex;
  state.visible = visible;
  state.focus = focus;

  render(transition);
  updateStepDisplay(targetIndex);
}

function nextStep() {
  if (state.stepIndex < state.steps.length - 1) goToStep(state.stepIndex + 1);
}

function prevStep() {
  if (state.stepIndex > 0) goToStep(state.stepIndex - 1);
}

function firstStep() {
  goToStep(0, 'cut');
}

function lastStep() {
  goToStep(state.steps.length - 1, 'cut');
}

// ---------------------------------------------------------------------------
// Rendering — SVG, styled from each node's resolved micro-note style
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function shapeElement(node) {
  const { shape } = node.style;
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;

  if (shape === 'circle') {
    const el = document.createElementNS(SVG_NS, 'ellipse');
    el.setAttribute('cx', cx); el.setAttribute('cy', cy);
    el.setAttribute('rx', node.width / 2); el.setAttribute('ry', node.height / 2);
    return el;
  }
  if (shape === 'diamond') {
    const el = document.createElementNS(SVG_NS, 'polygon');
    const pts = [
      [cx, node.y], [node.x + node.width, cy], [cx, node.y + node.height], [node.x, cy],
    ].map(p => p.join(',')).join(' ');
    el.setAttribute('points', pts);
    return el;
  }
  const el = document.createElementNS(SVG_NS, 'rect');
  el.setAttribute('x', node.x); el.setAttribute('y', node.y);
  el.setAttribute('width', node.width); el.setAttribute('height', node.height);
  if (shape === 'rounded') { el.setAttribute('rx', 14); el.setAttribute('ry', 14); }
  return el;
}

/**
 * Wraps `text` into lines that each fit within `maxWidth`, at the given
 * `fontSize`, by greedily packing words and measuring candidate lines with
 * a temporary, invisible <text> element (removed before returning) —
 * SVG has no automatic text wrapping, so this backs the multi-line content
 * block, see tools/canvas-player.md [section Micro-note Front Matter].
 *
 * @param {SVGSVGElement} svg - connected to the document, for measurement
 * @param {string} text
 * @param {number} maxWidth
 * @param {number} fontSize
 * @returns {string[]} wrapped lines, [] for an empty/whitespace-only text
 */
function wrapTextToLines(svg, text, maxWidth, fontSize) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const scratch = document.createElementNS(SVG_NS, 'text');
  scratch.setAttribute('font-size', fontSize);
  scratch.style.visibility = 'hidden';
  svg.appendChild(scratch);

  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    scratch.textContent = candidate;
    if (scratch.getComputedTextLength() > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  svg.removeChild(scratch);
  return lines;
}

/**
 * Builds the final list of rendered body lines for a node: splits the raw
 * body text into paragraphs and forced-break lines (Obsidian-style, see
 * splitBodyIntoParagraphs() in lib/canvas-player-core.js), then word-wraps
 * each forced-break line independently to `maxWidth` via wrapTextToLines().
 * The first wrapped line of every paragraph after the first is flagged
 * `gapBefore`, so the caller can add extra vertical spacing there — see
 * tools/canvas-player.md [section Micro-note Front Matter].
 *
 * @param {SVGSVGElement} svg - connected to the document, for measurement
 * @param {string} bodyText - resolved body content for the active language
 * @param {number} maxWidth
 * @param {number} fontSize
 * @returns {Array<{text: string, gapBefore: boolean}>}
 */
function buildBodyLines(svg, bodyText, maxWidth, fontSize) {
  const paragraphs = splitBodyIntoParagraphs(bodyText);
  const lines = [];
  paragraphs.forEach((paragraph, pIndex) => {
    paragraph.forEach((forcedLine, lIndex) => {
      const wrapped = wrapTextToLines(svg, forcedLine, maxWidth, fontSize);
      wrapped.forEach((text, wIndex) => {
        lines.push({ text, gapBefore: pIndex > 0 && lIndex === 0 && wIndex === 0 });
      });
    });
  });
  return lines;
}

function renderNode(svg, node) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('data-node-id', node.id);
  g.setAttribute('opacity', state.visible.has(node.id) ? '1' : '0');
  g.setAttribute('class', 'cp-node');

  const shape = shapeElement(node);
  shape.setAttribute('class', 'cp-node-shape');
  shape.setAttribute('fill', node.style.fill || '#4a4a4a');
  shape.setAttribute('stroke', node.style.stroke || '#222');
  shape.setAttribute('stroke-width', node.style['stroke-width'] ?? 1);
  g.appendChild(shape);
  svg.appendChild(g); // connect to the document now, so text measurement below (title width, body wrapping) reflects real layout

  const textValue = resolveText(node.style, lang);
  const hasImage = !!node.style.imageUrl;
  const hasText = textValue !== '';
  const fontSize = node.style['text-size'] || 14;
  const padding = 8;

  // `body` — optional multi-line content below the title, from the
  // micro-note's `## <lang>` sections — see
  // tools/canvas-player.md [section Micro-note Front Matter]. Wrapped to
  // the node's inner width; silently absent if the active language has no
  // matching section.
  const bodyText = resolveBody(node.body, lang);
  const bodyFontSize = Math.max(10, fontSize * 0.75);
  const bodyLineHeight = bodyFontSize * 1.25;
  // Extra vertical spacing before the first line of a new paragraph (a
  // blank line in the source), on top of the normal line height —
  // Obsidian-style body line breaks, see splitBodyIntoParagraphs() in
  // lib/canvas-player-core.js and tools/canvas-player.md [section
  // Micro-note Front Matter].
  const bodyParagraphGap = bodyLineHeight * 0.5;
  const contentWidth = Math.max(0, node.width - padding * 2);
  const bodyLines = bodyText ? buildBodyLines(svg, bodyText, contentWidth, bodyFontSize) : [];
  const bodyGapCount = bodyLines.filter(l => l.gapBefore).length;

  // Combined height of the title line (if any) and the wrapped body block
  // (if any), stacked with a small gap between them.
  const titleLineHeight = hasText ? fontSize * 1.3 : 0;
  const bodyBlockHeight = bodyLines.length ? bodyLines.length * bodyLineHeight + bodyGapCount * bodyParagraphGap : 0;
  const titleBodyGap = hasText && bodyLines.length ? 4 : 0;
  const textBlockHeight = titleLineHeight + titleBodyGap + bodyBlockHeight;

  // When a node has both an image and a title/body, the image is confined
  // to the upper area and a band at the bottom is reserved for the text
  // block, sized to fit the title and the wrapped body together — see
  // tools/canvas-player.md [section Micro-note Front Matter]. With neither
  // title nor body, the image keeps filling the whole node (minus padding),
  // as before.
  const textBandHeight = hasImage && textBlockHeight > 0 ? Math.max(24, textBlockHeight + padding) : 0;

  // `image` — vault-linked image, drawn in the node (minus a small padding,
  // and minus the text band when a title/body is also present), preserving
  // aspect ratio — see tools/canvas-player.md [section Micro-note Front
  // Matter]. Resolved to a /file server URL in loadPresentation(); a load
  // failure (missing/unreadable file) is logged to the console only, same
  // non-fatal treatment as a failed icon fetch.
  if (hasImage) {
    const image = document.createElementNS(SVG_NS, 'image');
    image.setAttribute('class', 'cp-node-image');
    image.setAttribute('x', node.x + padding);
    image.setAttribute('y', node.y + padding);
    image.setAttribute('width', Math.max(0, node.width - padding * 2));
    image.setAttribute('height', Math.max(0, node.height - padding * 2 - textBandHeight));
    image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', node.style.imageUrl);
    image.setAttribute('href', node.style.imageUrl);
    image.style.pointerEvents = 'none';
    image.addEventListener('error', () => {
      console.warn(`canvas-player: could not load image for node "${node.id}" from ${node.style.imageUrl}`);
    });
    g.appendChild(image);
  }

  // The title (+ optional body block) is vertically centered as a group,
  // either within the image's text band or, with no image, within the
  // whole node.
  const blockTop = hasImage ? node.y + node.height - textBandHeight : node.y;
  const blockHeight = hasImage ? textBandHeight : node.height;
  const stackTop = blockTop + blockHeight / 2 - textBlockHeight / 2;
  const centerX = node.x + node.width / 2;
  const titleCenterY = hasText ? stackTop + titleLineHeight / 2 : stackTop;

  let text = null;
  if (hasText) {
    text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', 'cp-node-text');
    text.setAttribute('x', centerX); // provisional; adjusted below once an icon's width (if any) is known
    text.setAttribute('y', titleCenterY);
    text.setAttribute('font-size', fontSize);
    text.setAttribute('font-weight', node.style['text-bold'] ? 'bold' : 'normal');
    text.textContent = textValue;
    g.appendChild(text);
  }

  // `icon` — when paired with a title, sized to match the title's height
  // and placed to its left, the icon+title pair centered together as a
  // single unit (text.getBBox() gives the actual rendered text width, only
  // available once the element is connected to the document) — see
  // tools/canvas-player.md [section Micro-note Front Matter]. Without a
  // title, the icon keeps its original small corner badge.
  if (node.style.icon && hasText) {
    const iconSize = Math.max(14, fontSize);
    const gap = 6;
    const textWidth = text.getBBox().width;
    const startX = centerX - (iconSize + gap + textWidth) / 2;
    const iconX = startX;
    const iconY = titleCenterY - iconSize / 2;
    text.setAttribute('x', startX + iconSize + gap + textWidth / 2);

    const iconSvg = iconCache.get(node.style.icon);
    if (iconSvg) {
      const icon = iconSvg.cloneNode(true);
      icon.setAttribute('x', iconX);
      icon.setAttribute('y', iconY);
      icon.setAttribute('width', iconSize);
      icon.setAttribute('height', iconSize);
      icon.setAttribute('stroke', '#222');
      icon.style.pointerEvents = 'none';
      g.appendChild(icon);
    } else {
      const letter = document.createElementNS(SVG_NS, 'text');
      letter.setAttribute('class', 'cp-icon-letter');
      letter.setAttribute('x', iconX + iconSize / 2);
      letter.setAttribute('y', titleCenterY);
      letter.setAttribute('font-size', iconSize * 0.8);
      letter.textContent = node.style.icon.charAt(0).toUpperCase();
      g.appendChild(letter);
    }
  } else if (node.style.icon) {
    const badge = document.createElementNS(SVG_NS, 'circle');
    badge.setAttribute('class', 'cp-icon-badge');
    badge.setAttribute('cx', node.x + 16); badge.setAttribute('cy', node.y + 16); badge.setAttribute('r', 10);
    g.appendChild(badge);

    const iconSvg = iconCache.get(node.style.icon);
    if (iconSvg) {
      const icon = iconSvg.cloneNode(true);
      icon.setAttribute('x', node.x + 16 - 7);
      icon.setAttribute('y', node.y + 16 - 7);
      icon.setAttribute('width', 14);
      icon.setAttribute('height', 14);
      icon.setAttribute('stroke', '#222');
      icon.style.pointerEvents = 'none';
      g.appendChild(icon);
    } else {
      const letter = document.createElementNS(SVG_NS, 'text');
      letter.setAttribute('class', 'cp-icon-letter');
      letter.setAttribute('x', node.x + 16); letter.setAttribute('y', node.y + 17);
      letter.setAttribute('font-size', 11);
      letter.textContent = node.style.icon.charAt(0).toUpperCase();
      g.appendChild(letter);
    }
  }

  // Body block — wrapped lines, centered below the title (or alone, if
  // there is no title) — see tools/canvas-player.md [section Micro-note
  // Front Matter].
  if (bodyLines.length) {
    const bodyStartCenterY = hasText
      ? titleCenterY + titleLineHeight / 2 + titleBodyGap + bodyLineHeight / 2
      : stackTop + bodyLineHeight / 2;
    const bodyEl = document.createElementNS(SVG_NS, 'text');
    bodyEl.setAttribute('class', 'cp-node-body');
    bodyEl.setAttribute('font-size', bodyFontSize);
    let bodyCursorY = bodyStartCenterY;
    bodyLines.forEach((line, i) => {
      if (i > 0) bodyCursorY += bodyLineHeight + (line.gapBefore ? bodyParagraphGap : 0);
      const tspan = document.createElementNS(SVG_NS, 'tspan');
      tspan.setAttribute('x', centerX);
      tspan.setAttribute('y', bodyCursorY);
      tspan.textContent = line.text;
      bodyEl.appendChild(tspan);
    });
    g.appendChild(bodyEl);
  }

  // Badge — small additive decoration for a visual exception, resolved
  // independently of style in loadPresentation(); drawn last, above
  // everything else in the node, anchored at its `position` on the node's
  // bounding box regardless of `shape` — see tools/canvas-player.md
  // [section Badge Note Front Matter] and [section How It Works].
  if (node.badge) {
    const badgeRadius = typeof node.badge.size === 'number' ? node.badge.size : 12;
    const anchor = badgeAnchorPoint(node, node.badge.position, node.badge.offset || 0);

    const badgeCircle = document.createElementNS(SVG_NS, 'circle');
    badgeCircle.setAttribute('class', 'cp-badge');
    badgeCircle.setAttribute('cx', anchor.x);
    badgeCircle.setAttribute('cy', anchor.y);
    badgeCircle.setAttribute('r', badgeRadius);
    badgeCircle.setAttribute('fill', node.badge.color || '#e11d48');
    g.appendChild(badgeCircle);

    const badgeIconSize = badgeRadius * 1.2;
    const badgeIconSvg = iconCache.get(node.badge.icon);
    if (badgeIconSvg) {
      const icon = badgeIconSvg.cloneNode(true);
      icon.setAttribute('x', anchor.x - badgeIconSize / 2);
      icon.setAttribute('y', anchor.y - badgeIconSize / 2);
      icon.setAttribute('width', badgeIconSize);
      icon.setAttribute('height', badgeIconSize);
      icon.setAttribute('stroke', '#fff');
      icon.style.pointerEvents = 'none';
      g.appendChild(icon);
    } else {
      const letter = document.createElementNS(SVG_NS, 'text');
      letter.setAttribute('class', 'cp-badge-letter');
      letter.setAttribute('x', anchor.x);
      letter.setAttribute('y', anchor.y);
      letter.setAttribute('font-size', badgeIconSize * 0.9);
      letter.textContent = node.badge.icon.charAt(0).toUpperCase();
      g.appendChild(letter);
    }
  }
}

function renderEdges(svg) {
  for (const edge of state.canvasEdges) {
    if (!state.visible.has(edge.fromNode) || !state.visible.has(edge.toNode)) continue;
    const from = state.canvasNodes.find(n => n.id === edge.fromNode);
    const to = state.canvasNodes.find(n => n.id === edge.toNode);
    if (!from || !to) continue;

    const { p1, c1, c2, p2 } = computeEdgePath(from, edge.fromSide, to, edge.toSide, state.edgeOffsets);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'cp-edge');
    path.setAttribute('fill', 'none');
    path.setAttribute('marker-end', 'url(#cp-arrow)');
    path.setAttribute('d', `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`);
    svg.insertBefore(path, svg.firstChild); // edges under nodes
  }
}

/** Defines the reusable arrowhead marker referenced by every edge path — re-added on each render since render() clears the SVG. refX matches the tip's x-coordinate (10) so the tip lands exactly on the path's endpoint (the node boundary) instead of overshooting into the node. */
function renderEdgeDefs(svg) {
  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.innerHTML = `
    <marker id="cp-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="cp-edge-arrow" d="M0,0 L10,5 L0,10 z" />
    </marker>
  `;
  svg.appendChild(defs);
}

// ---------------------------------------------------------------------------
// Pan/zoom animation — requestAnimationFrame, not a native CSS transition on
// the viewBox attribute (unreliable cross-browser support for animating
// SVG viewBox via CSS) — see tools/canvas-player.md [section How It Works]
// ---------------------------------------------------------------------------

let viewBoxAnimFrame = null;

function setViewBoxImmediate(svg, box) {
  svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
}

/** Eases a linear progress value 0..1 into an ease-in-out-quad curve. */
function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Animates the SVG viewBox from `fromBox` to `toBox` over `durationMs`, canceling any animation already in progress. */
function animateViewBox(svg, fromBox, toBox, durationMs) {
  if (viewBoxAnimFrame) cancelAnimationFrame(viewBoxAnimFrame);
  if (durationMs <= 0) { setViewBoxImmediate(svg, toBox); return; }

  const start = performance.now();
  function step(now) {
    const t = Math.min((now - start) / durationMs, 1);
    const eased = easeInOutQuad(t);
    setViewBoxImmediate(svg, {
      x: fromBox.x + (toBox.x - fromBox.x) * eased,
      y: fromBox.y + (toBox.y - fromBox.y) * eased,
      width: fromBox.width + (toBox.width - fromBox.width) * eased,
      height: fromBox.height + (toBox.height - fromBox.height) * eased,
    });
    viewBoxAnimFrame = t < 1 ? requestAnimationFrame(step) : null;
  }
  viewBoxAnimFrame = requestAnimationFrame(step);
}

function render(transition) {
  const svg = document.getElementById('viewport');
  svg.innerHTML = '';
  renderEdgeDefs(svg);

  for (const node of state.canvasNodes) renderNode(svg, node);
  renderEdges(svg);

  const box = computeFitBox(state.canvasNodes, state.focus, PADDING);
  if (box) {
    if (transition === 'fade' && state.viewBox) {
      animateViewBox(svg, state.viewBox, box, transitionDurationMs);
    } else {
      setViewBoxImmediate(svg, box);
    }
    state.viewBox = box;
  }
  // If focus is empty, the view does not move — see
  // tools/canvas-player.md [section How It Works], step 6.
}

/** Language switch re-renders every node (text content, plus icon+text layout since the icon's position depends on the rendered text width) — visibility, focus, and the current view are untouched, see tools/canvas-player.md [section How It Works]. */
function reRenderForLanguage() {
  render('cut');
}

// ---------------------------------------------------------------------------
// Script browser — "Open script" button, backed by GET /dir
// ---------------------------------------------------------------------------

const VAULTS_KEY = 'canvas-player:vaults'; // [{ name, path }]
let browseDir = null;

function getVaults() {
  try {
    return JSON.parse(localStorage.getItem(VAULTS_KEY)) || [];
  } catch {
    return [];
  }
}

function saveVaults(vaults) {
  localStorage.setItem(VAULTS_KEY, JSON.stringify(vaults));
}

function populateVaultSelect(selectPath) {
  const select = document.getElementById('vault-select');
  select.innerHTML = '<option value="">— Favorite vaults —</option>';
  for (const v of getVaults()) {
    const opt = document.createElement('option');
    opt.value = v.path;
    opt.textContent = v.name;
    select.appendChild(opt);
  }
  select.value = selectPath && getVaults().some(v => v.path === selectPath) ? selectPath : '';
}

async function openBrowser() {
  document.getElementById('browser').classList.add('open');
  const vaults = getVaults();
  const start = vaultRoot || (vaults[0] && vaults[0].path) || '';
  populateVaultSelect(start);
  document.getElementById('browser-path').value = start;
  if (start) await browseTo(start);
}

function closeBrowser() {
  document.getElementById('browser').classList.remove('open');
}

async function browseTo(dir) {
  let entries;
  try {
    entries = await listDir(dir);
  } catch (err) {
    alert(`Could not open folder:\n${dir}\n\n${err.message}`);
    return;
  }
  browseDir = dir;
  document.getElementById('browser-path').value = dir;
  populateVaultSelect(dir);

  const list = document.getElementById('browser-list');
  list.innerHTML = '';
  const dirs = entries.filter(e => e.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
  const mdFiles = entries.filter(e => e.type === 'file' && e.name.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const d of dirs) {
    const row = document.createElement('div');
    row.className = 'dir';
    row.textContent = d.name;
    row.addEventListener('click', () => browseTo(joinPath(dir, d.name)));
    list.appendChild(row);
  }
  for (const f of mdFiles) {
    const row = document.createElement('div');
    row.className = 'md';
    row.textContent = f.name;
    row.addEventListener('click', () => selectScript(joinPath(dir, f.name)));
    list.appendChild(row);
  }
}

function selectScript(absPath) {
  scriptPath = absPath;
  vaultRoot = null; // re-detect for the newly picked script
  closeBrowser();
  loadPresentation().catch(err => {
    console.error('canvas-player: failed to load presentation.', err);
    setStepError();
  });
}

// ---------------------------------------------------------------------------
// Controls — see tools/canvas-player.md [section Controls]
// ---------------------------------------------------------------------------

async function updateStatusDot() {
  const dot = document.getElementById('status-dot');
  dot.className = (await ping()) ? 'ok' : 'down';
}

// Overlay auto-hide — fades out after a few seconds of inactivity, reappears
// as soon as the cursor re-enters its own area (mouseenter/mouseleave on
// #overlay itself, kept hoverable even while faded since pointer-events
// stays enabled) — see tools/canvas-player.md [section Controls].
const OVERLAY_IDLE_DELAY_MS = 3000;
let overlayIdleTimer = null;

function showOverlay() {
  clearTimeout(overlayIdleTimer);
  document.getElementById('overlay').classList.remove('idle');
}

function scheduleOverlayHide() {
  clearTimeout(overlayIdleTimer);
  overlayIdleTimer = setTimeout(() => {
    document.getElementById('overlay').classList.add('idle');
  }, OVERLAY_IDLE_DELAY_MS);
}

function wireControls() {
  document.getElementById('overlay').addEventListener('mouseenter', showOverlay);
  document.getElementById('overlay').addEventListener('mouseleave', scheduleOverlayHide);
  document.getElementById('btn-open').addEventListener('click', openBrowser);
  document.getElementById('btn-reload').addEventListener('click', async () => {
    if (!scriptPath) { openBrowser(); return; }
    reloadStepIndex = state.stepIndex >= 0 ? state.stepIndex : null;
    document.getElementById('status-dot').className = '';
    await loadPresentation();
    await updateStatusDot();
  });
  document.getElementById('btn-first').addEventListener('click', firstStep);
  document.getElementById('btn-prev').addEventListener('click', prevStep);
  document.getElementById('btn-next').addEventListener('click', nextStep);
  document.getElementById('btn-last').addEventListener('click', lastStep);
  document.getElementById('viewport').addEventListener('click', nextStep);
  document.getElementById('step-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') jumpToStepInput();
  });
  document.addEventListener('keydown', e => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return; // don't hijack typing in a field
    if (e.key === 'ArrowRight') nextStep();
    else if (e.key === 'ArrowLeft') prevStep();
  });
  document.getElementById('lang-select').addEventListener('change', e => {
    lang = e.target.value;
    saveLastLang(lang);
    reRenderForLanguage();
  });
  document.getElementById('lang-select').value = lang;

  document.getElementById('step-select').addEventListener('change', e => {
    goToStep(parseInt(e.target.value, 10), 'cut');
  });

  document.getElementById('browser-go').addEventListener('click', () => {
    const p = document.getElementById('browser-path').value.trim();
    if (p) browseTo(p);
  });
  document.getElementById('browser-up').addEventListener('click', () => {
    if (browseDir) browseTo(dirOf(browseDir));
  });
  document.getElementById('browser-cancel').addEventListener('click', closeBrowser);

  document.getElementById('vault-select').addEventListener('change', e => {
    if (e.target.value) browseTo(e.target.value);
  });
  document.getElementById('vault-save').addEventListener('click', () => {
    if (!browseDir) return;
    const name = prompt('Name for this vault:', browseDir.split(/[\\/]/).pop());
    if (!name) return;
    const vaults = getVaults().filter(v => v.path !== browseDir);
    vaults.push({ name, path: browseDir });
    saveVaults(vaults);
    populateVaultSelect(browseDir);
  });
  document.getElementById('vault-remove').addEventListener('click', () => {
    const select = document.getElementById('vault-select');
    if (!select.value) return;
    saveVaults(getVaults().filter(v => v.path !== select.value));
    populateVaultSelect(browseDir);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

wireControls();
updateStatusDot();
scheduleOverlayHide();
loadPresentation().catch(err => {
  console.error('canvas-player: failed to load presentation.', err);
  setStepError();
});
