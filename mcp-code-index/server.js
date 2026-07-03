/**
 * server.js
 *
 * MCP server entry point for the code index — registers search, reindex as
 * MCP tools over stdio.
 *
 * Registered in the AI client under the name `mcp-code-index`.
 *
 * @convention conventions/mcp-code-index.md [## How — Implementation > MCP tools]
 * @convention conventions/mcp-code-index.md [## How — Implementation > Client configuration]
 *
 * Not yet in references (document debt):
 *   - Concrete SDK usage (McpServer, registerTool, StdioServerTransport from
 *     @modelcontextprotocol/sdk 1.29) is not documented in the convention,
 *     which only specifies the tool contract, not the SDK wiring.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createContext, search, reindex } from './tools.js';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const REPOS_JSON    = path.join(__dirname, 'repos.json');

const ctx = createContext(REPOS_JSON);

const server = new McpServer({ name: 'mcp-code-index', version: '1.0.0' });

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(e) {
  const code = e.code || 'ERROR';
  const detail = e.message.startsWith(`${code}: `) ? e.message.slice(code.length + 2) : e.message;
  return { content: [{ type: 'text', text: `ERROR:${code}:${detail}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.registerTool(
  'search',
  {
    title: 'Search code index',
    description: 'Full-text search across indexed source code files (src/, fragments/, styles/) for one repo or all configured repos.',
    inputSchema: {
      query: z.string().describe('FTS5 query string, e.g. "DDS_CMD dispatch"'),
      repo: z.string().optional().describe('Repo name to restrict the search to (see repos.json). Omit to search all configured repos.'),
    },
  },
  async ({ query, repo }) => {
    try { return ok(search(ctx, { query, repo })); }
    catch (e) { return err(e); }
  }
);

server.registerTool(
  'reindex',
  {
    title: 'Reindex a code repo',
    description: 'Full directory walk and reindex of a code repo (or all configured repos) — catches new/deleted files that lazy reindex misses.',
    inputSchema: {
      repo: z.string().optional().describe('Repo name to reindex. Omit to reindex all configured repos.'),
    },
  },
  async ({ repo }) => {
    try { return ok(reindex(ctx, { repo })); }
    catch (e) { return err(e); }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

process.on('SIGINT', () => { ctx.close(); process.exit(0); });
process.on('SIGTERM', () => { ctx.close(); process.exit(0); });
