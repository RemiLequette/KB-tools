import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/todo-filter.test.js',
      'tests/index-db.test.js',
      'tests/indexer.test.js',
      'tests/lock.test.js',
      'tests/mcp-doc-index-tools.test.js',
    ],
    exclude: ['tests/forge/**'],
  },
});
