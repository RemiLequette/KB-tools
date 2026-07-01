/**
 * update-toc.js
 *
 * Replace hand-written Table of Contents lists with the insta-toc codeblock,
 * and remove [up](#table-of-contents) navigation links, across all Markdown
 * documents under a root directory.
 *
 * References (documents used to design this script):
 *   - conventions/documentation.md [section TOC Rule]
 *   - conventions/documentation.md [section Scope] (exemption list)
 *   - conventions/tools.md [section Standard Interface]
 *   - conventions/tools.md [section Script Self-Documentation]
 *
 * Not yet in references (document debt — update the refs to absorb these):
 *   - Files exempt from this migration (basename match): TODO.md, GLOSSARY.md,
 *     Journal.md, CHANGELOG.md, and any file under a `TODO` directory. This
 *     exemption mirrors documentation.md's Scope table but is not itself
 *     spelled out as a migration-tool rule anywhere.
 *   - A document with no existing `## Table of Contents` heading is left
 *     untouched even if it has more than 2 content sections (TOC Rule would
 *     require one) — this script only migrates existing TOCs, it does not
 *     enforce the Rule itself.
 *
 * Args: <root_directory> <check|write>
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Inline fs-scan utilities (avoid CJS/ESM mismatch with lib/)
// ---------------------------------------------------------------------------

function scanMarkdownFiles(rootDir) {
  const results = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) results.push(full);
    }
  }
  walk(rootDir);
  return results.sort();
}

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

function writeFileSafe(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function assertDirectory(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Not a valid directory: ${dirPath}`);
  }
}

function relativePath(rootDir, filePath) {
  return path.relative(rootDir, filePath);
}

// ---------------------------------------------------------------------------
// Exemptions
// ---------------------------------------------------------------------------

const EXEMPT_BASENAMES = new Set(['TODO.md', 'GLOSSARY.md', 'Journal.md', 'CHANGELOG.md']);

function isExempt(filePath) {
  const base = filePath.split(/[\\/]/).pop();
  if (EXEMPT_BASENAMES.has(base)) return true;
  if (/[\\/]TODO[\\/]/.test(filePath)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Transform — pure function, no file I/O
// ---------------------------------------------------------------------------

const UP_LINK_LINE = '[up](#table-of-contents)';
const TOC_ITEM_RE = /^\s*(?:\d+\.|-)\s+\[.+\]\(#.+\)\s*$/;
const TOC_HEADING = '## Table of Contents';

/**
 * Apply the TOC/[up]-link migration to a document's raw text.
 * @param {string} text - Original file content.
 * @returns {{content: string, changed: boolean, tocReplaced: boolean, upLinksRemoved: number}}
 */
function migrateToc(text) {
  const lines = text.split(/\r?\n/);

  // Step 1 — remove [up](#table-of-contents) lines
  let upLinksRemoved = 0;
  const withoutUpLinks = [];
  for (const line of lines) {
    if (line.trim() === UP_LINK_LINE) {
      upLinksRemoved++;
      continue;
    }
    withoutUpLinks.push(line);
  }

  // Step 2 — replace hand-written TOC list with insta-toc codeblock
  let result = withoutUpLinks;
  let tocReplaced = false;

  const tocIdx = result.findIndex(l => l.trim() === TOC_HEADING);
  if (tocIdx !== -1) {
    const next1 = result[tocIdx + 1];
    const next2 = result[tocIdx + 2];
    const alreadyMigrated =
      (next1 !== undefined && next1.trim() === '```insta-toc') ||
      (next1 !== undefined && next1.trim() === '' && next2 !== undefined && next2.trim() === '```insta-toc');

    if (!alreadyMigrated) {
      let end = tocIdx + 1;
      while (end < result.length && (result[end].trim() === '' || TOC_ITEM_RE.test(result[end]))) {
        end++;
      }
      result = [
        ...result.slice(0, tocIdx + 1),
        '',
        '```insta-toc',
        '```',
        '',
        ...result.slice(end),
      ];
      tocReplaced = true;
    }
  }

  const newText = result.join('\n');
  return {
    content: newText,
    changed: newText !== text,
    tocReplaced,
    upLinksRemoved,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , rootDir, mode] = process.argv;

if (!rootDir || !mode) {
  console.log('ERROR:MISSING_ARG:Usage: node update-toc.js <root_directory> <check|write>');
  process.exit(0);
}
if (mode !== 'check' && mode !== 'write') {
  console.log('ERROR:MISSING_ARG:mode must be "check" or "write"');
  process.exit(0);
}

let files;
try {
  assertDirectory(rootDir);
  files = scanMarkdownFiles(rootDir);
} catch (e) {
  console.log(`ERROR:FILE_NOT_FOUND:${e.message}`);
  process.exit(0);
}

const out = ['OK'];

for (const filePath of files) {
  if (isExempt(filePath)) continue;

  let text;
  try {
    text = readFile(filePath);
  } catch (e) {
    out.push(`ERROR_READ\t${filePath}\t${e.message}`);
    continue;
  }

  const result = migrateToc(text);
  const rel = relativePath(rootDir, filePath);

  if (!result.changed) {
    out.push(`UNCHANGED\t${rel}`);
    continue;
  }

  if (mode === 'write') {
    try {
      writeFileSafe(filePath, result.content);
    } catch (e) {
      out.push(`ERROR_WRITE\t${rel}\t${e.message}`);
      continue;
    }
  }

  out.push(`CHANGED\t${rel}\ttoc=${result.tocReplaced ? 1 : 0}\tup_links=${result.upLinksRemoved}`);
}

console.log(out.join('\n'));

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------
//
// Version 1.0 - Creation
// Date: 2026-06-30
