/**
 * local-server.js — Shared local development server
 *
 * Pure HTTP wrapper over tools/lib/server-core.js.
 * No business logic — reads, writes, deletes, and lists files only.
 *
 * Also exposes:
 *   POST /exec         — start a process session or send stdin input
 *   GET  /exec/stream  — SSE stream of stdout/stderr for a session
 *   DELETE /exec       — terminate a session
 *
 * Exec sessions are managed by tools/lib/exec-manager.js.
 * See conventions/local-server.md [section Session model] for the full spec.
 *
 * Usage:
 *   node tools/local-server.js <root1> [<root2> ...] [--port <port>]
 *
 * See conventions/local-server.md for the full specification.
 */

import http from 'http';
import path from 'path';
import url  from 'url';
import * as core from './lib/server-core.js';
import * as exec from './lib/exec-manager.js';

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
  const isRaw    = typeof body === 'string' || Buffer.isBuffer(body);
  const data     = isRaw ? body : JSON.stringify(body);
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
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('Error: port ' + PORT + ' is already in use. A server may already be running.');
  } else {
    console.error('Server error: ' + err.message);
  }
  process.exit(1);
});
