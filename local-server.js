/**
 * local-server.js — Shared local development server
 *
 * Pure HTTP wrapper over tools/lib/server-core.js.
 * No business logic — reads, writes, deletes, and lists files only.
 *
 * Also exposes:
 *   POST /forge        — proxy to the Forge MCP server (v2)
 *   POST /forge-reload — hot-reload Forge tool + format registries
 *   POST /exec         — start a process session or send stdin input
 *   GET  /exec/stream  — SSE stream of stdout/stderr for a session
 *   DELETE /exec       — terminate a session
 *
 * Forge v2 uses McpServer from forge/src/mcp-server.js.
 * dispatch(tool, args) routes calls to the registered tool handlers.
 * Hot-reload rebuilds McpServer from forge-tools.json + forge-formats.json
 * — handler JS modules are NOT reloaded (ESM cache), only JSON config changes
 * are picked up.
 *
 * Exec sessions are managed by tools/lib/exec-manager.js.
 * See conventions/local-server.md [section Session model] for the full spec.
 *
 * Usage:
 *   node tools/local-server.js <root1> [<root2> ...] [--port <port>]
 *
 * See conventions/local-server.md for the full specification.
 */

const http = require('http');
const path = require('path');
const url  = require('url');
const core = require('./lib/server-core');
const exec = require('./lib/exec-manager');

// ---------------------------------------------------------------------------
// Configuration from CLI arguments
// ---------------------------------------------------------------------------

const args         = process.argv.slice(2);
const allowedRoots = core.parseAllowedRoots(args);
const PORT         = core.parsePort(args);

if (allowedRoots.length === 0) {
  console.error('Error: at least one allowed root path is required.');
  console.error('Usage: node local-server.js <root1> [<root2> ...] [--port <port>]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Content-Type map
// ---------------------------------------------------------------------------

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function send(res, status, body, contentType) {
  const isString = typeof body === 'string';
  const data     = isString ? body : JSON.stringify(body);
  const ct       = contentType || 'application/json; charset=utf-8';
  res.writeHead(status, { 'Content-Type': ct, ...CORS_HEADERS });
  res.end(data);
}

function sendResult(res, result, contentType) {
  if (result.status === 200 && result.content !== undefined) {
    send(res, 200, result.content, contentType);
  } else if (result.status === 200) {
    send(res, 200, { ok: true });
  } else {
    send(res, result.status, { error: result.error || 'Unknown error' });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end',  () => resolve(data));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Forge proxy (v2) — McpServer from forge/src/mcp-server.js
// forgeServer = McpServer instance, replaced on every reload.
// ---------------------------------------------------------------------------

let forgeServer    = null; // McpServer instance
let forgeMcpMod    = null; // { McpServer } from forge/src/mcp-server.js
let forgeToolsPath = null; // absolute path to forge-tools.json

async function loadForgeMod() {
  if (forgeMcpMod) return;
  const forgeDir    = path.resolve(__dirname, 'forge');
  const mcpServerUrl = 'file:///' + path.join(forgeDir, 'src', 'mcp-server.js').replace(/\\/g, '/');
  forgeMcpMod    = await import(mcpServerUrl);
  forgeToolsPath = path.join(forgeDir, 'forge-tools.json');
}

async function reloadForge() {
  const fs = require('fs');
  await loadForgeMod();

  if (!fs.existsSync(forgeToolsPath)) {
    throw new Error(`forge-tools.json not found at ${forgeToolsPath}`);
  }

  const server = new forgeMcpMod.McpServer();

  // Build context — load registries the same way startMcpServer() does
  const forgeDir      = path.dirname(forgeToolsPath);
  const forgeConfigUrl = 'file:///' + path.join(forgeDir, 'forge.config.json').replace(/\\/g, '/');
  const rootRegUrl     = 'file:///' + path.join(forgeDir, 'src', 'root-registry.js').replace(/\\/g, '/');
  const fmtRegUrl      = 'file:///' + path.join(forgeDir, 'src', 'format-registry.js').replace(/\\/g, '/');

  const [{ RootRegistry }, { FormatRegistry }] = await Promise.all([
    import(rootRegUrl),
    import(fmtRegUrl),
  ]);

  const forgeConfig  = JSON.parse(fs.readFileSync(path.join(forgeDir, 'forge.config.json'), 'utf8'));
  const rootRegistry = new RootRegistry();
  await rootRegistry.load(forgeConfig.roots);

  const formatRegistry = new FormatRegistry();
  const formatsPath    = path.join(forgeDir, 'forge-formats.json');
  if (fs.existsSync(formatsPath)) await formatRegistry.load(formatsPath);

  await server.loadTools(forgeToolsPath, { rootRegistry, formatRegistry });

  forgeServer = server;

  const roots = forgeConfig.roots.map(r => r.name);
  const tools = server.toolNames();
  return { roots, tools };
}

async function initForge() {
  try {
    const { roots, tools } = await reloadForge();
    console.log(`[forge] Forge v2 ready — ${roots.length} root(s): ${roots.join(', ')} — ${tools.length} tool(s)`);
  } catch (err) {
    console.warn('[forge] Could not initialise Forge proxy: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query    = parsed.query;
  const method   = req.method.toUpperCase();

  // Preflight CORS
  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  // GET /ping
  if (method === 'GET' && pathname === '/ping') {
    return send(res, 200, { ok: true });
  }

  // POST /forge — Forge v2 tool proxy
  if (method === 'POST' && pathname === '/forge') {
    if (!forgeServer) {
      return send(res, 503, { error: 'Forge proxy not available' });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'Invalid JSON body' });
    }
    const { tool, args: toolArgs = {} } = body;
    if (!tool) {
      return send(res, 400, { error: 'Missing field: tool' });
    }
    try {
      const result = await forgeServer.dispatch(tool, toolArgs);
      return send(res, 200, result);
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  }

  // POST /forge-reload — hot-reload Forge tool + format registries
  if (method === 'POST' && pathname === '/forge-reload') {
    try {
      const { roots, tools } = await reloadForge();
      console.log(`[forge] Reloaded — ${roots.length} root(s), ${tools.length} tool(s)`);
      return send(res, 200, { ok: true, roots, tools });
    } catch (err) {
      console.warn('[forge] Reload failed: ' + err.message);
      return send(res, 500, { error: err.message });
    }
  }

  // ---------------------------------------------------------------------------
  // Exec routes
  // ---------------------------------------------------------------------------

  // GET /exec/stream — SSE stream for a session
  if (method === 'GET' && pathname === '/exec/stream') {
    const { sessionId } = query;
    if (!sessionId) {
      return send(res, 400, { error: 'Missing parameter: sessionId' });
    }

    // SSE headers — must be set before attachStream writes to res
    res.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders();

    const result = exec.attachStream(sessionId, res);
    if (result.status) {
      // Session not found — we already wrote headers, send error event and close
      res.write(`event: error\ndata: ${result.error}\n\n`);
      res.end();
    }
    return;
  }

  // POST /exec — start session or send input
  if (method === 'POST' && pathname === '/exec') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'Invalid JSON body' });
    }

    // Send input to existing session
    if (body.sessionId) {
      const result = exec.sendInput(body.sessionId, body.input ?? '');
      if (result.ok) return send(res, 200, { ok: true });
      return send(res, result.status, { error: result.error });
    }

    // Start a new session
    if (!body.cwd) {
      return send(res, 400, { error: 'Missing field: cwd' });
    }

    // Validate cwd against allowed roots
    const safeCwd = core.safePath(body.cwd, allowedRoots);
    if (!safeCwd) {
      return send(res, 403, { error: 'Access denied' });
    }

    const result = exec.startSession(safeCwd, body.command || 'gemini');
    if (result.error) return send(res, 500, { error: result.error });
    return send(res, 200, { sessionId: result.sessionId });
  }

  // DELETE /exec — terminate a session
  if (method === 'DELETE' && pathname === '/exec') {
    const { sessionId } = query;
    if (!sessionId) {
      return send(res, 400, { error: 'Missing parameter: sessionId' });
    }
    const result = exec.terminateSession(sessionId);
    if (result.ok) return send(res, 200, { ok: true });
    return send(res, result.status, { error: result.error });
  }

  // ---------------------------------------------------------------------------
  // File routes
  // ---------------------------------------------------------------------------

  // /file — read, write, delete
  if (pathname === '/file') {
    if (!query.path) {
      return send(res, 400, { error: 'Missing parameter: path' });
    }

    if (method === 'GET') {
      const result = core.readFile(query.path, allowedRoots);
      return sendResult(res, result, contentTypeFor(query.path));
    }

    if (method === 'POST') {
      const body   = await readBody(req);
      const result = core.writeFile(query.path, body, allowedRoots);
      return sendResult(res, result);
    }

    if (method === 'DELETE') {
      const result = core.deleteFile(query.path, allowedRoots);
      return sendResult(res, result);
    }
  }

  // GET /dir — list directory
  if (method === 'GET' && pathname === '/dir') {
    if (!query.path) {
      return send(res, 400, { error: 'Missing parameter: path' });
    }
    const result = core.listDir(query.path, allowedRoots);
    if (result.status === 200) {
      return send(res, 200, { entries: result.entries });
    }
    return send(res, result.status, { error: result.error });
  }

  // GET /* — static file serving (absolute path in URL)
  if (method === 'GET') {
    const filePath = decodeURIComponent(pathname.replace(/^\//, ''));
    const result   = core.readFile(filePath, allowedRoots);
    return sendResult(res, result, contentTypeFor(filePath));
  }

  send(res, 404, { error: 'Unknown route' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, '127.0.0.1', async () => {
  console.log('');
  console.log('Local server started on http://localhost:' + PORT);
  console.log('Allowed roots:');
  allowedRoots.forEach(r => console.log('  ' + r));
  console.log('');
  console.log('Ctrl+C to stop.');
  console.log('');

  await initForge();
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('Error: port ' + PORT + ' is already in use. A server may already be running.');
  } else {
    console.error('Server error: ' + err.message);
  }
  process.exit(1);
});
