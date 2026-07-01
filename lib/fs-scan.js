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
 * Recursively scan a directory and return all .md file paths, sorted.
 * @param {string} rootDir - Absolute path to the root directory.
 * @returns {string[]} Sorted list of absolute .md file paths.
 */
function scanMarkdownFiles(rootDir) {
  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw new Error(`Cannot read directory: ${dir} — ${e.message}`);
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  }

  walk(rootDir);
  return results.sort();
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
  scanMarkdownFiles,
  readFile,
  writeFile,
  assertDirectory,
  relativePath,
};
