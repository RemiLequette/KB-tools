/**
 * viewer-server.js
 *
 * Read-only HTTP server for canvas-player, distributed to non-technical
 * colleagues in place of local-server.js.
 *
 * Serves only what canvas-player.js ever calls: GET /ping, GET /file,
 * GET /dir, and static GET /*. No /exec family, no POST/DELETE /file —
 * see tools/canvas-player.md [section Distribution/Viewer Server].
 *
 * References (documents used to design this script):
 *   - tools/canvas-player.md [section Distribution/Viewer Server]
 *   - conventions/local-server.md
 *   - lib/server-core.js
 *
 * Not yet in references (document debt — update the refs to absorb these):
 *   none
 *
 * Usage:
 *   node tools/viewer-server.js <root1> [<root2> ...] [--port <port>]
 */

import http from 'http';
import path from 'path';
import * as core from './lib/server-core.js';

// ---------------------------------------------------------------------------
// Configuration from CLI arguments
// ---------------------------------------------------------------------------

const args         = process.argv.slice(2);
const allowedRoots = core.parseAllowedRoots(args);
const PORT         = core.parsePort(args);

if (allowedRoots.length === 0) {
  console.error('Error: at least one allowed root path is required.');
  console.error('Usage: node viewer-server.js <root1> [<root2> ...] [--port <port>]');
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
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function send(res, status, body, contentType) {
  const isRaw = typeof body === 'string' || Buffer.isBuffer(body);
  const data  = isRaw ? body : JSON.stringify(body);
  const ct    = contentType || 'application/json; charset=utf-8';
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

// ---------------------------------------------------------------------------
// Router — GET/OPTIONS only, no request body ever read
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const parsed   = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(parsed.pathname);
  const query    = parsed.searchParams;
  const method   = req.method.toUpperCase();

  // Preflight CORS
  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  if (method !== 'GET') {
    return send(res, 405, { error: 'Method not allowed — viewer-server is read-only' });
  }

  // GET /ping
  if (pathname === '/ping') {
    return send(res, 200, { ok: true });
  }

  // GET /file — read a file from disk
  if (pathname === '/file') {
    const filePath = query.get('path');
    if (!filePath) {
      return send(res, 400, { error: 'Missing parameter: path' });
    }
    const result = core.readFile(filePath, allowedRoots);
    return sendResult(res, result, contentTypeFor(filePath));
  }

  // GET /dir — list directory
  if (pathname === '/dir') {
    const dirPath = query.get('path');
    if (!dirPath) {
      return send(res, 400, { error: 'Missing parameter: path' });
    }
    const result = core.listDir(dirPath, allowedRoots);
    if (result.status === 200) {
      return send(res, 200, { entries: result.entries });
    }
    return send(res, result.status, { error: result.error });
  }

  // GET /* — static file serving (absolute path in URL)
  const filePath = pathname.replace(/^\//, '');
  const result   = core.readFile(filePath, allowedRoots);
  return sendResult(res, result, contentTypeFor(filePath));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('Canvas Player viewer server started on http://localhost:' + PORT);
  console.log('Read-only — no /exec, no write. Allowed roots:');
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
