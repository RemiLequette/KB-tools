/**
 * update-toc.js
 *
 * Regenerate the Table of Contents (and [[#Quick Start]] up-links) for every
 * conformant Markdown document under a root directory, by re-running each
 * file through md-parser.js [parseText / toMarkdown] — the same logic used
 * by write_section. A document is skipped, not modified, if it is out of
 * scope for the generic documentation convention.
 *
 * References (documents used to design this script):
 *   - conventions/documentation.md [section TOC Rule]
 *   - conventions/documentation.md [section Scope]
 *   - conventions/tools.md [section Standard Interface]
 *   - conventions/tools.md [section Script Self-Documentation]
 *
 * Not yet in references (document debt — update the refs to absorb these):
 *   - A document is skipped (left untouched) when md-parser.js [getIssues] reports
 *     it non-conformant (missing ## Quick Start / ## Load when) or when it has no
 *     # Title. This is how files out of scope for documentation.md (TODO items,
 *     GLOSSARY items, etc. — see [Scope]) are excluded, without hardcoding their
 *     paths here. Not itself spelled out as a migration-tool rule anywhere.
 *
 * Args: <root_directory> <check|write>
 */

import * as md from './lib/md-parser.js';
import * as fs from './lib/fs-scan.js';

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
  fs.assertDirectory(rootDir);
  files = fs.scanMarkdownFiles(rootDir);
} catch (e) {
  console.log(`ERROR:FILE_NOT_FOUND:${e.message}`);
  process.exit(0);
}

const out = ['OK'];

for (const filePath of files) {
  const rel = fs.relativePath(rootDir, filePath);

  let original;
  try {
    original = fs.readFile(filePath);
  } catch (e) {
    out.push(`ERROR_READ\t${rel}\t${e.message}`);
    continue;
  }

  let doc;
  try {
    doc = md.parseText(original, filePath);
  } catch (e) {
    out.push(`SKIPPED_PARSE_ERROR\t${rel}\t${e.message}`);
    continue;
  }

  if (!doc.title) {
    out.push(`SKIPPED_NO_TITLE\t${rel}`);
    continue;
  }

  const issues = md.getIssues(doc);
  if (issues.length > 0) {
    out.push(`SKIPPED_NON_CONFORMANT\t${rel}\t${issues.join('; ')}`);
    continue;
  }

  let regenerated;
  try {
    regenerated = md.toMarkdown(doc);
  } catch (e) {
    out.push(`ERROR_REGENERATE\t${rel}\t${e.message}`);
    continue;
  }

  if (regenerated === original) {
    out.push(`UNCHANGED\t${rel}`);
    continue;
  }

  if (mode === 'write') {
    try {
      fs.writeFile(filePath, regenerated);
    } catch (e) {
      out.push(`ERROR_WRITE\t${rel}\t${e.message}`);
      continue;
    }
  }

  out.push(`CHANGED\t${rel}`);
}

console.log(out.join('\n'));

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------
//
// Version 1.0 - Creation: migrate hand-written TOC lists to the insta-toc
//               codeblock.
// Date: 2026-06-30
//
// Version 2.0 - Reversed direction: the Insta TOC Obsidian plugin is retired
//               (it never refreshed on file writes from outside Obsidian).
//               Now regenerates the TOC as a plain wikilink list via
//               md-parser.js, reusable for any future re-generation need.
// Date: 2026-07-05
