/**
 * exec-manager.js
 *
 * Process session manager for local-server.js.
 * Spawns interactive child processes, streams stdout/stderr via SSE,
 * and manages session lifecycle (creation, input, timeout, termination).
 *
 * No HTTP logic — callers handle request/response.
 * Sessions are held in memory only — lost on server restart.
 *
 * See conventions/local-server.md [section Session model] for the full spec.
 */

const { spawn } = require('child_process');
const crypto    = require('crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

/**
 * Map of sessionId → Session
 *
 * Session shape:
 * {
 *   sessionId:    string,
 *   process:      ChildProcess,
 *   cwd:          string,
 *   command:      string,
 *   lastActivity: number,      // Date.now()
 *   sseClients:   Response[],  // active SSE response objects
 *   buffer:       string[],    // lines buffered before first SSE client connects
 *   ended:        boolean,
 *   exitCode:     number|null,
 * }
 */
const sessions = new Map();

// ---------------------------------------------------------------------------
// Inactivity watchdog
// ---------------------------------------------------------------------------

const watchdog = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (!session.ended && now - session.lastActivity > INACTIVITY_TIMEOUT_MS) {
      console.log(`[exec] Session ${id} timed out after inactivity — killing process`);
      _terminate(session, 'timeout');
      sessions.delete(id);
    }
  }
}, 60_000); // check every minute

// Allow the process to exit even if this interval is still running
watchdog.unref();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _generateId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Send an SSE event to all connected clients of a session.
 * Also appends to the session buffer for clients that connect later.
 *
 * @param {object} session
 * @param {string} type  - event type (stdout | stderr | exit | error)
 * @param {string} data  - event payload
 */
function _broadcast(session, type, data) {
  const line = `event: ${type}\ndata: ${data}\n\n`;
  session.buffer.push(line);
  for (const res of session.sseClients) {
    try { res.write(line); } catch (_) { /* client disconnected */ }
  }
}

/**
 * Terminate a session's process and notify connected SSE clients.
 *
 * @param {object} session
 * @param {string} reason - 'user' | 'timeout' | 'exit'
 */
function _terminate(session, reason) {
  if (session.ended) return;
  session.ended = true;
  try { session.process.kill('SIGTERM'); } catch (_) { /* already gone */ }
  if (reason !== 'exit') {
    _broadcast(session, 'exit', reason === 'timeout' ? 'timeout' : '-1');
  }
  // Close SSE connections
  for (const res of session.sseClients) {
    try { res.end(); } catch (_) { /* already closed */ }
  }
  session.sseClients = [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a new process session.
 *
 * @param {string} cwd     - working directory (already validated by caller)
 * @param {string} command - executable to spawn (default: 'gemini')
 * @returns {{ sessionId: string } | { error: string }}
 */
function startSession(cwd, command = 'gemini') {
  const sessionId = _generateId();

  let proc;
  try {
    proc = spawn(command, [], {
      cwd,
      shell: true,      // needed on Windows for PATH resolution
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    return { error: err.message };
  }

  const session = {
    sessionId,
    process:      proc,
    cwd,
    command,
    lastActivity: Date.now(),
    sseClients:   [],
    buffer:       [],
    ended:        false,
    exitCode:     null,
  };

  sessions.set(sessionId, session);

  // stdout
  proc.stdout.on('data', chunk => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line !== '') _broadcast(session, 'stdout', line);
    }
  });

  // stderr
  proc.stderr.on('data', chunk => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line !== '') _broadcast(session, 'stderr', line);
    }
  });

  // exit
  proc.on('exit', code => {
    session.ended   = true;
    session.exitCode = code;
    _broadcast(session, 'exit', String(code ?? -1));
    for (const res of session.sseClients) {
      try { res.end(); } catch (_) { /* already closed */ }
    }
    session.sseClients = [];
    // Keep session in map briefly so callers can read exitCode, then remove
    setTimeout(() => sessions.delete(sessionId), 5000);
  });

  // error (e.g. ENOENT — command not found)
  proc.on('error', err => {
    _broadcast(session, 'error', err.message);
    _terminate(session, 'exit');
    sessions.delete(sessionId);
  });

  console.log(`[exec] Session ${sessionId} started — command: ${command} — cwd: ${cwd}`);
  return { sessionId };
}

/**
 * Send text input to a running session's stdin.
 *
 * @param {string} sessionId
 * @param {string} input - text to write (newline appended automatically)
 * @returns {{ ok: true } | { status: number, error: string }}
 */
function sendInput(sessionId, input) {
  const session = sessions.get(sessionId);
  if (!session)        return { status: 404, error: 'Session not found' };
  if (session.ended)   return { status: 404, error: 'Session has ended' };

  try {
    session.process.stdin.write(input + '\n');
    session.lastActivity = Date.now();
    return { ok: true };
  } catch (err) {
    return { status: 500, error: err.message };
  }
}

/**
 * Register an SSE response object for a session.
 * Replays buffered output to the new client immediately.
 *
 * @param {string}   sessionId
 * @param {object}   res       - HTTP response object (Node.js)
 * @returns {{ ok: true } | { status: number, error: string }}
 */
function attachStream(sessionId, res) {
  const session = sessions.get(sessionId);
  if (!session) return { status: 404, error: 'Session not found' };

  // Replay buffered lines
  for (const line of session.buffer) {
    try { res.write(line); } catch (_) { return { ok: true }; }
  }

  // If session already ended, send exit and close immediately
  if (session.ended) {
    try {
      res.write(`event: exit\ndata: ${session.exitCode ?? -1}\n\n`);
      res.end();
    } catch (_) { /* ignore */ }
    return { ok: true };
  }

  session.sseClients.push(res);

  // Remove client from list on disconnect
  res.on('close', () => {
    session.sseClients = session.sseClients.filter(r => r !== res);
  });

  return { ok: true };
}

/**
 * Terminate a session by sessionId.
 *
 * @param {string} sessionId
 * @returns {{ ok: true } | { status: number, error: string }}
 */
function terminateSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return { status: 404, error: 'Session not found' };
  _terminate(session, 'user');
  sessions.delete(sessionId);
  console.log(`[exec] Session ${sessionId} terminated by user`);
  return { ok: true };
}

/**
 * Return a snapshot of all active sessions (for diagnostics).
 *
 * @returns {Array<{ sessionId, cwd, command, ended, lastActivity }>}
 */
function listSessions() {
  return [...sessions.values()].map(s => ({
    sessionId:    s.sessionId,
    cwd:          s.cwd,
    command:      s.command,
    ended:        s.ended,
    lastActivity: s.lastActivity,
  }));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { startSession, sendInput, attachStream, terminateSession, listSessions };
