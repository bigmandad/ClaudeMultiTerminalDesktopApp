// ── Remote API — HTTP server for remote terminal access ────
// Allows external services (Google Chat, webhooks, etc.) to
// send messages to terminal sessions via HTTP.

const http = require('http');
const { PtyManager } = require('../pty/pty-manager');
const db = require('../db/database');

let server = null;
let outputBuffers = new Map(); // sessionId -> last N lines of output
let hookEventCallback = null; // Callback for forwarding hook events to renderer
const MAX_BUFFER_LINES = 50;

function captureOutput(sessionId, data) {
  if (!outputBuffers.has(sessionId)) {
    outputBuffers.set(sessionId, []);
  }
  const buffer = outputBuffers.get(sessionId);
  // Strip ANSI codes
  const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
  const lines = clean.split('\n').filter(l => l.trim());
  buffer.push(...lines);
  // Keep only last N lines
  while (buffer.length > MAX_BUFFER_LINES) buffer.shift();
}

function getOutput(sessionId) {
  return (outputBuffers.get(sessionId) || []).join('\n');
}

function startServer(port = 3456) {
  if (server) return { port, status: 'already_running' };

  server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        handleRequest(req, body, res);
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[RemoteAPI] HTTP server listening on port ${port}`);
  });

  server.on('error', (err) => {
    console.error('[RemoteAPI] Server error:', err.message);
    server = null;
  });

  return { port, status: 'started' };
}

function handleRequest(req, body, res) {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  // GET /api/sessions — list all sessions
  if (req.method === 'GET' && pathname === '/api/sessions') {
    const sessions = db.sessions.list();
    res.writeHead(200);
    res.end(JSON.stringify({ sessions: sessions.map(s => ({
      id: s.id, name: s.name, status: s.status, mode: s.mode,
      workspace: s.workspace_path
    })) }));
    return;
  }

  // GET /api/session/:id/output — get recent output
  if (req.method === 'GET' && pathname.startsWith('/api/session/') && pathname.endsWith('/output')) {
    const sessionId = pathname.split('/')[3];
    const output = getOutput(sessionId);
    res.writeHead(200);
    res.end(JSON.stringify({ sessionId, output, lines: (outputBuffers.get(sessionId) || []).length }));
    return;
  }

  // POST /api/session/:id/send — send message to session
  if (req.method === 'POST' && pathname.startsWith('/api/session/') && pathname.endsWith('/send')) {
    const sessionId = pathname.split('/')[3];
    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const message = data.message || data.text || '';
    if (!message) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'No message provided' }));
      return;
    }

    PtyManager.write(sessionId, message + '\r');
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, sessionId, messageSent: message }));
    return;
  }

  // POST /api/webhook/gchat — Google Chat webhook handler
  if (req.method === 'POST' && pathname === '/api/webhook/gchat') {
    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    // Google Chat sends message in data.message.text
    const text = data.message?.text || data.text || '';
    if (!text) {
      res.writeHead(200);
      res.end(JSON.stringify({ text: 'No message received.' }));
      return;
    }

    // Parse command: "@session_name message" or just "message" for first session
    const match = text.match(/^@(\S+)\s+([\s\S]+)$/);
    let targetSession = null;
    let messageToSend = text;

    if (match) {
      const sessionName = match[1];
      messageToSend = match[2].trim();
      const sessions = db.sessions.list();
      targetSession = sessions.find(s =>
        s.name.toLowerCase() === sessionName.toLowerCase() ||
        s.id === sessionName
      );
    }

    // If no target session, use first active session
    if (!targetSession) {
      const sessions = db.sessions.list();
      targetSession = sessions.find(s => s.status === 'active') || sessions[0];
    }

    if (!targetSession) {
      res.writeHead(200);
      res.end(JSON.stringify({ text: 'No active sessions found.' }));
      return;
    }

    PtyManager.write(targetSession.id, messageToSend + '\r');

    // Wait a moment and return recent output
    setTimeout(() => {
      const output = getOutput(targetSession.id);
      const lastLines = (outputBuffers.get(targetSession.id) || []).slice(-10).join('\n');
      res.writeHead(200);
      res.end(JSON.stringify({
        text: `Sent to ${targetSession.name}:\n\`\`\`\n${lastLines || '(waiting for response...)'}\n\`\`\``
      }));
    }, 2000);
    return;
  }

  // ── Claude Code Hooks Receiver ─────────────────────────

  // POST /api/hooks — receive lifecycle events from Claude Code hooks
  if (req.method === 'POST' && pathname === '/api/hooks') {
    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const event = {
      sessionId: data.session_id || data.sessionId || null,
      hookType: data.hook_type || data.hookType || data.type || 'unknown',
      eventName: data.event || data.eventName || 'unknown',
      toolName: data.tool_name || data.toolName || data.tool || null,
      filePath: data.file_path || data.filePath || null,
      result: data.result || data.status || null,
      metadata: data.metadata || data,
    };

    try {
      db.hookEvents.record(event);
    } catch (e) {
      console.warn('[RemoteAPI] Hook event DB record failed:', e.message);
    }

    // Emit to renderer via callback
    if (hookEventCallback) {
      hookEventCallback(event);
    }

    console.log(`[RemoteAPI] Hook: ${event.eventName} (${event.hookType}) tool=${event.toolName || '-'}`);
    res.writeHead(200);
    res.end(JSON.stringify({ received: true, event: event.eventName }));
    return;
  }

  // GET /api/hooks/recent — get recent hook events
  if (req.method === 'GET' && pathname === '/api/hooks/recent') {
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const events = db.hookEvents.getRecent(limit);
    res.writeHead(200);
    res.end(JSON.stringify({ events }));
    return;
  }

  // GET /api/hooks/stats — get tool usage statistics from hooks
  if (req.method === 'GET' && pathname === '/api/hooks/stats') {
    const stats = db.hookEvents.getToolUsageStats();
    res.writeHead(200);
    res.end(JSON.stringify({ stats }));
    return;
  }

  // ── Blackboard (cross-session state) ──────────────────

  // GET /api/blackboard — list all blackboard entries
  if (req.method === 'GET' && pathname === '/api/blackboard') {
    db.blackboard.prune(); // cleanup expired entries
    const entries = db.blackboard.list();
    res.writeHead(200);
    res.end(JSON.stringify({ entries }));
    return;
  }

  // POST /api/blackboard — set a blackboard entry
  if (req.method === 'POST' && pathname === '/api/blackboard') {
    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!data.key) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing key' }));
      return;
    }

    db.blackboard.set(
      data.session_id || data.sessionId || null,
      data.key,
      data.value,
      data.category || 'general',
      data.ttl || null
    );

    res.writeHead(200);
    res.end(JSON.stringify({ success: true, key: data.key }));
    return;
  }

  // GET /api/blackboard/:key — get a specific entry
  if (req.method === 'GET' && pathname.startsWith('/api/blackboard/')) {
    const key = decodeURIComponent(pathname.split('/api/blackboard/')[1]);
    const entry = db.blackboard.get(key);
    if (entry) {
      res.writeHead(200);
      res.end(JSON.stringify(entry));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Key not found' }));
    }
    return;
  }

  // GET /api/status — server status
  if (req.method === 'GET' && (pathname === '/api/status' || pathname === '/')) {
    res.writeHead(200);
    res.end(JSON.stringify({
      app: 'Claude Sessions',
      status: 'running',
      sessions: db.sessions.list().length,
      endpoints: [
        'GET  /api/sessions',
        'GET  /api/session/:id/output',
        'POST /api/session/:id/send',
        'POST /api/webhook/gchat',
        'POST /api/hooks',
        'GET  /api/hooks/recent',
        'GET  /api/hooks/stats',
        'GET  /api/blackboard',
        'POST /api/blackboard',
        'GET  /api/blackboard/:key',
        'GET  /api/status'
      ]
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
}

function stopServer() {
  if (server) {
    server.close();
    server = null;
    console.log('[RemoteAPI] Server stopped');
  }
}

function isRunning() {
  return server !== null;
}

function onHookEvent(callback) {
  hookEventCallback = callback;
}

module.exports = { startServer, stopServer, isRunning, captureOutput, getOutput, onHookEvent };
