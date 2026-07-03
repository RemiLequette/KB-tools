/**
 * fs-scan.js
 *
 * Filesystem utilities for KB tools: directory scanning, safe file reading, path helpers.
 * No side effects at require time.
 *
 * Usage:
 *   const fs = require('./lib/fs-scan');
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Recursively scan a directory and return all file paths matching any of the
 * given extensions, sorted.
 * @param {string} rootDir - Absolute path to the root directory.
 * @param {string[]} extensions - File extensions to match, e.g. ['.js', '.html', '.css'].
 * @returns {string[]} Sorted list of absolute matching file paths.
 */
const IGNORED_DIRS = new Set(['node_modules', '.git']);

function scanFiles(rootDir, extensions) {
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
 * @returns {string[]} Sorted list of absolute .md file paths.
 */
function scanMarkdownFiles(rootDir) {
  return scanFiles(rootDir, ['.md']);
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

module.exports = {
  scanFiles,
  scanMarkdownFiles,
  readFile,
  writeFile,
  assertDirectory,
  relativePath,
};
