/**
 * fs-scan.cjs
 *
 * Filesystem utilities for KB tools: directory scanning, safe file reading, path helpers.
 * CommonJS module (.cjs) — loadable from ESM via createRequire regardless of package "type".
 * No side effects at require time.
 *
 * Usage (from ESM):
 *   import { createRequire } from 'module';
 *   const fsScan = createRequire(import.meta.url)('./fs-scan.cjs');
 */

'use strict';

const fs   = require('fs');
const path = require('path');

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

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    throw new Error(`Cannot read file: ${filePath} — ${e.message}`);
  }
}

function writeFile(filePath, content) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch (e) {
    throw new Error(`Cannot write file: ${filePath} — ${e.message}`);
  }
}

function assertDirectory(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Not a valid directory: ${dirPath}`);
  }
}

function relativePath(rootDir, filePath) {
  return path.relative(rootDir, filePath);
}

module.exports = { scanMarkdownFiles, readFile, writeFile, assertDirectory, relativePath };
