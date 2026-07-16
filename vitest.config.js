import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/md-parser.test.js',
      'tests/update-toc.test.js',
      'tests/todo-filter.test.js',
      'tests/index-db.test.js',
      'tests/indexer.test.js',
      'tests/lock.test.js',
      'tests/mcp-doc-index-tools.test.js',
      'tests/code-index-db.test.js',
      'tests/code-indexer.test.js',
      'tests/mcp-code-index-tools.test.js',
      'tests/fs-scan.test.js',
    ],
    exclude: ['tests/forge/**'],
  },
});
