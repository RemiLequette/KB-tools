/**
 * fs-scan.js
 *
 * Filesystem utilities for KB tools: directory scanning, safe file reading, path helpers.
 * ESM module — imported directly, no CJS interop needed.
 * No side effects at import time.
 *
 * @convention conventions/mcp-code-index.md [## How — Implementation > File structure]
 * @convention conventions/mcp-doc-index.md [## How — Implementation > File structure]
 */

import fs   from 'fs';
import path from 'path';

const IGNORED_DIRS = new Set(['node_modules', '.git']);

/**
 * Convert a simple glob pattern (`*`, `**`) to a RegExp, anchored to the full string.
 * `**` matches any number of path segments, including none — `**\/foo` also matches
 * `foo` itself, and `foo\/**` also matches `foo` itself (the adjoining `/` collapses
 * along with the zero-segment match, same as standard glob semantics). `*` matches
 * within a single path segment only (never crosses `/`).
 * @param {string} pattern - Glob pattern, matched against a POSIX-style relative path.
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&'); // escape regex specials, but not * or /

  // Order matters: handle the slash-adjacent ** forms first (collapsing the
  // adjoining /), then any remaining standalone **, then single *.
  const converted = escaped
    .replace(/\*\*\//g, '\u0001')  // '**/' — zero or more full segments, or none
    .replace(/\/\*\*/g, '\u0002')  // '/**' — zero or more full segments, or none
    .replace(/\*\*/g, '\u0003')    // remaining standalone '**' — anything, across segments
    .replace(/\*/g, '[^/]*')       // '*' — within one segment
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '(?:/.*)?')
    .replace(/\u0003/g, '.*');

  return new RegExp(`^${converted}$`);
}

/**
 * Check whether a relative path (POSIX separators) matches any of the given glob patterns.
 * @param {string} relPath - Path relative to the scan root, POSIX separators.
 * @param {string[]} patterns - Glob patterns (e.g. ['**\/generated/**', '*.min.js']).
 * @returns {boolean}
 */
function matchesAny(relPath, patterns) {
  return patterns.some(p => globToRegExp(p).test(relPath));
}

/**
 * Recursively scan a directory and return all file paths matching any of the
 * given extensions, sorted. `node_modules/` and `.git/` are always skipped.
 * @param {string} rootDir - Absolute path to the root directory.
 * @param {string[]} extensions - File extensions to match, e.g. ['.js', '.html', '.css'].
 * @param {string[]} [excludePatterns] - Glob patterns (relative to rootDir, POSIX separators)
 *   for files/directories to skip in addition to the always-ignored dirs. Supports `*`
 *   (within a segment) and `**` (across segments), e.g. `**\/generated/**`, `*.min.js`.
 * @returns {string[]} Sorted list of absolute matching file paths.
 */
function scanFiles(rootDir, extensions, excludePatterns = []) {
  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw new Error(`Cannot read directory: ${dir} — ${e.message}`);
    }

    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel  = path.relative(rootDir, full).split(path.sep).join('/');

      if (excludePatterns.length > 0 && matchesAny(rel, excludePatterns)) continue;

      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }

  walk(rootDir);
  return results.sort();
}

/**
 * Recursively scan a directory and return all .md file paths, sorted.
 * @param {string} rootDir - Absolute path to the root directory.
 * @param {string[]} [excludePatterns] - See scanFiles.
 * @returns {string[]} Sorted list of absolute .md file paths.
 */
function scanMarkdownFiles(rootDir, excludePatterns = []) {
  return scanFiles(rootDir, ['.md'], excludePatterns);
}

/**
 * Read a file as UTF-8 text. Throws if the file cannot be read.
 * @param {string} filePath - Absolute path to the file.
 * @returns {string} File content.
 */
function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    throw new Error(`Cannot read file: ${filePath} — ${e.message}`);
  }
}

/**
 * Write text content to a file. Creates parent directories if needed.
 * @param {string} filePath - Absolute path to the output file.
 * @param {string} content  - Text content to write.
 */
function writeFile(filePath, content) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch (e) {
    throw new Error(`Cannot write file: ${filePath} — ${e.message}`);
  }
}

/**
 * Check that a path exists and is a directory. Throws if not.
 * @param {string} dirPath - Path to validate.
 */
function assertDirectory(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Not a valid directory: ${dirPath}`);
  }
}

/**
 * Return the relative path of filePath from rootDir.
 * @param {string} rootDir  - Root directory.
 * @param {string} filePath - Absolute file path.
 * @returns {string}
 */
function relativePath(rootDir, filePath) {
  return path.relative(rootDir, filePath);
}

export {
  scanFiles,
  scanMarkdownFiles,
  readFile,
  writeFile,
  assertDirectory,
  relativePath,
};
