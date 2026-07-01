/**
 * todo-filter.js
 *
 * Filters todo item files in a directory by a YAML front matter property and value.
 * Outputs matching filenames (not full paths) to stdout, one per line.
 *
 * References:
 *   - conventions/todo-list.md [## Tools > todo-filter.js]
 *   - conventions/tools.md [## Standard Interface, ## Script Self-Documentation]
 *
 * Not yet in references:
 *   - none
 *
 * Args: <items-dir> <property> <value>
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

const [itemsDir, property, value] = process.argv.slice(2);

if (!itemsDir || !property || !value) {
  process.stdout.write('ERROR:MISSING_ARG:Expected 3 arguments: <items-dir> <property> <value>\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Directory validation
// ---------------------------------------------------------------------------

if (!fs.existsSync(itemsDir) || !fs.statSync(itemsDir).isDirectory()) {
  process.stdout.write(`ERROR:FILE_NOT_FOUND:Directory not found: ${itemsDir}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

const files = fs.readdirSync(itemsDir).filter(f => f.endsWith('.md'));
const matches = [];

for (const file of files) {
  const filePath = path.join(itemsDir, file);
  const content = fs.readFileSync(filePath, 'utf8');
  if (matchesFrontMatter(content, property, value)) {
    matches.push(file);
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const lines = ['OK', ...matches].join('\n');
process.stdout.write(lines + '\n');
process.exit(0);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the YAML front matter of content contains `property: value` (case-sensitive).
 * Only reads the front matter block (between the first pair of `---` lines).
 *
 * @param {string} content - Full file content
 * @param {string} property - YAML key to match
 * @param {string} value - Expected value (case-sensitive)
 * @returns {boolean}
 */
function matchesFrontMatter(content, property, value) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return false;
  const frontMatter = match[1];
  const pattern = new RegExp(`^${escapeRegex(property)}:\\s*${escapeRegex(value)}\\s*$`, 'm');
  return pattern.test(frontMatter);
}

/**
 * Escapes special regex characters in a string.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
