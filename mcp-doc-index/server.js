/**
 * server.js
 *
 * MCP server entry point for the doc index — registers search, list_triggers,
 * read_section, write_section, create_document, reindex as MCP tools over stdio.
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

import { createContext, search, listTriggers, readSection, writeSection, createDocument, reindex } from './tools.js';

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
    description: 'Reads one section\'s content from a Markdown document, by repo-relative or absolute file path. A section is a ## or ### heading. IMPORTANT: if the ## has ### subsections, its own path returns only its direct content (the text before the first ###) — subsections are separate, addressed independently; the ## path never includes them.',
    inputSchema: {
      repo: z.string().describe('Repo name (see repos.json).'),
      file: z.string().describe('File path, relative to the repo root (or absolute).'),
      section: z.string().describe('Full section path: "Document Title/Heading" for a ## section, or "Document Title/Heading/Subheading" for a ### subsection. Bare heading names are not accepted. If the ## has ### subsections, this path returns only the ##\'s own direct content (before its first ###) — read each ### subsection with its own path to get its content.'),
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
    description: 'Creates, overwrites, inserts, or deletes a ## or ### section, then writes the file — rejected if the resulting document fails conformance (getIssues). IMPORTANT: mode=set on a ## path replaces its ENTIRE subtree — content may itself embed ### headings, which become the new subsections, and any pre-existing subsection absent from the new content is removed (including all of them, if content has no ### at all). To only change the ##\'s own intro text without touching its subsections, write each ### subsection separately instead.',
    inputSchema: {
      repo: z.string().describe('Repo name (see repos.json).'),
      file: z.string().describe('File path, relative to the repo root (or absolute).'),
      section: z.string().describe('Full section path: "Document Title/Heading" for a ## section, or "Document Title/Heading/Subheading" for a ### subsection. Bare heading names are not accepted. For mode=insert, this is the path being created; a new ### requires its parent ## to already exist.'),
      content: z.string().optional().describe('New section body. Ignored when mode=delete. For a ## path with mode=set, this replaces the whole subtree: embed ### headings here to define the section\'s new subsections, or omit them entirely to clear all existing subsections. For a ### path, this only ever replaces that subsection\'s own lines.'),
      mode: z.enum(['set', 'insert', 'delete']).optional().describe('set (default): create or overwrite. insert: requires position. delete: removes the section (blocked for mandatory sections).'),
      position: z.string().optional().describe('Required when mode=insert. "beginning", "before:<Section Path>", or "after:<Section Path>" — the reference must be a sibling (same parent).'),
    },
  },
  async ({ repo, file, section, content, mode, position }) => {
    try { return ok(writeSection(ctx, { repo, file, section, content, mode, position })); }
    catch (e) { return err(e); }
  }
);

server.registerTool(
  'create_document',
  {
    title: 'Create a new document',
    description: 'Scaffolds a brand-new conformant Markdown document — title, optional subtitle/document-type/language preamble, and the two conformance-required sections (## Quick Start, ## Load when) — then writes and indexes it. Fails with FILE_EXISTS if the target path already exists; use write_section to edit an existing document instead.',
    inputSchema: {
      repo: z.string().describe('Repo name (see repos.json).'),
      file: z.string().describe('File path for the new document, relative to the repo root (or absolute). Must not already exist.'),
      title: z.string().describe('Document title — becomes the # heading.'),
      quickStart: z.string().describe('Content of the mandatory ## Quick Start section — 3 to 6 lines describing theme, scope, and when to load the document (see conventions/documentation.md [section Quick Start Rule]).'),
      loadWhen: z.string().describe('Content of the mandatory ## Load when section — one trigger phrase per line, each describing a situation that warrants loading the document.'),
      subtitle: z.string().optional().describe('Optional short plain-text subtitle, placed immediately under the title.'),
      documentType: z.string().optional().describe('Optional document type (see conventions/documentation-style.md [section Document Taxonomy]) — rendered as *Document type: <value>*.'),
      language: z.string().optional().describe('Optional language declaration, only needed when the document is not in English — rendered as *Language: <value>*.'),
    },
  },
  async ({ repo, file, title, quickStart, loadWhen, subtitle, documentType, language }) => {
    try { return ok(createDocument(ctx, { repo, file, title, quickStart, loadWhen, subtitle, documentType, language })); }
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
