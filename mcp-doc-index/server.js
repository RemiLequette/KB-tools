/**
 * server.js
 *
 * MCP server entry point for the doc index — registers search, list_triggers,
 * read_section, write_section, reindex as MCP tools over stdio.
 *
 * Registered in the AI client under the name `kb-doc-index`.
 *
 * @convention conventions/mcp-doc-index.md [## How — Implementation > MCP tools (draft contract)]
 * @convention conventions/mcp-doc-index.md [## How — Implementation > Client configuration]
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

import { createContext, search, listTriggers, readSection, writeSection, reindex } from './tools.js';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const REPOS_JSON    = path.join(__dirname, 'repos.json');

const ctx = createContext(REPOS_JSON);

const server = new McpServer({ name: 'kb-doc-index', version: '1.0.0' });

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(e) {
  const code = e.code || 'ERROR';
  // e.message already carries a "CODE: detail" prefix from tools.js's fail() —
  // strip it here so the stdout-style ERROR:<code>:<message> line isn't doubled.
  const detail = e.message.startsWith(`${code}: `) ? e.message.slice(code.length + 2) : e.message;
  return { content: [{ type: 'text', text: `ERROR:${code}:${detail}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.registerTool(
  'search',
  {
    title: 'Search doc index',
    description: 'Full-text search across indexed sections (and document titles/load_when triggers) for one repo or all configured repos.',
    inputSchema: {
      query: z.string().describe('FTS5 query string, e.g. "alpha convention"'),
      repo: z.string().optional().describe('Repo name to restrict the search to (see repos.json). Omit to search all configured repos.'),
    },
  },
  async ({ query, repo }) => {
    try { return ok(search(ctx, { query, repo })); }
    catch (e) { return err(e); }
  }
);

server.registerTool(
  'list_triggers',
  {
    title: 'List load_when triggers',
    description: 'Returns the full load_when -> file table for a repo, built from each document\'s ## Load when section.',
    inputSchema: {
      repo: z.string().describe('Repo name (see repos.json).'),
    },
  },
  async ({ repo }) => {
    try { return ok(listTriggers(ctx, { repo })); }
    catch (e) { return err(e); }
  }
);

server.registerTool(
  'read_section',
  {
    title: 'Read a document section',
    description: 'Reads one ## section\'s content from a Markdown document, by repo-relative or absolute file path.',
    inputSchema: {
      repo: z.string().describe('Repo name (see repos.json).'),
      file: z.string().describe('File path, relative to the repo root (or absolute).'),
      section: z.string().describe('Section heading name, without the ## prefix.'),
    },
  },
  async ({ repo, file, section }) => {
    try { return ok({ content: readSection(ctx, { repo, file, section }) }); }
    catch (e) { return err(e); }
  }
);

server.registerTool(
  'write_section',
  {
    title: 'Write a document section',
    description: 'Creates, overwrites, inserts, or deletes a ## section, then writes the file — rejected if the resulting document fails conformance (getIssues).',
    inputSchema: {
      repo: z.string().describe('Repo name (see repos.json).'),
      file: z.string().describe('File path, relative to the repo root (or absolute).'),
      section: z.string().describe('Section heading name, without the ## prefix.'),
      content: z.string().optional().describe('New section body. Ignored when mode=delete.'),
      mode: z.enum(['set', 'insert', 'delete']).optional().describe('set (default): create or overwrite. insert: requires position. delete: removes the section (blocked for mandatory sections).'),
      position: z.string().optional().describe('Required when mode=insert. "beginning", "before:<Section Name>", or "after:<Section Name>".'),
    },
  },
  async ({ repo, file, section, content, mode, position }) => {
    try { return ok(writeSection(ctx, { repo, file, section, content, mode, position })); }
    catch (e) { return err(e); }
  }
);

server.registerTool(
  'reindex',
  {
    title: 'Reindex a repo',
    description: 'Full directory walk and reindex of a repo (or all configured repos) — catches new/deleted files that lazy reindex misses.',
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
