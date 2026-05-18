// ── Structured Event Log ─────────────────────────────────
// Single point of truth for "what happened, when, where, why".
// Replaces ad-hoc console.log calls across subsystems and persists each event
// as JSON Lines for later analysis (autoresearch, debugging, crash reports).
//
// Each entry: { ts, source, level, message, ctx }
//   ts:      ISO 8601 timestamp
//   source:  subsystem name (e.g. 'watchdog', 'autoresearch', 'mcp:my-server')
//   level:   debug | info | warn | error
//   message: short human-readable string
//   ctx:     arbitrary structured payload (optional)
//
// File location: ~/.omniclaw/logs/YYYY-MM-DD.jsonl (one file per UTC date)
// Rotation:      files older than RETENTION_DAYS are deleted on startup
// In-memory:     last RING_SIZE entries are kept for fast renderer tailing

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(os.homedir(), '.omniclaw', 'logs');
const RETENTION_DAYS = 7;
const RING_SIZE = 500;
const VALID_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

// In-memory ring buffer for renderer tailing.
const ring = [];

// Per-day write streams cached so we don't reopen on every log line.
const streamCache = new Map(); // dateStr -> writeStream

let initialized = false;
let listeners = new Set();

function _ensureInit() {
  if (initialized) return;
  initialized = true;
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    _rotateOldLogs();
  } catch (err) {
    console.warn('[event-log] init failed:', err.message);
  }
}

function _rotateOldLogs() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(LOG_DIR)) {
      if (!file.endsWith('.jsonl')) continue;
      const full = path.join(LOG_DIR, file);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
      } catch (_) { /* ignore individual file errors */ }
    }
  } catch (err) {
    console.warn('[event-log] rotation skipped:', err.message);
  }
}

function _todayStr() {
  // YYYY-MM-DD in UTC so a long-running session doesn't switch files at midnight local
  return new Date().toISOString().slice(0, 10);
}

function _streamFor(dateStr) {
  let s = streamCache.get(dateStr);
  if (s && !s.destroyed) return s;
  try {
    s = fs.createWriteStream(path.join(LOG_DIR, `${dateStr}.jsonl`), { flags: 'a' });
    s.on('error', err => console.warn('[event-log] stream error:', err.message));
    streamCache.set(dateStr, s);
    return s;
  } catch (err) {
    console.warn('[event-log] cannot open stream:', err.message);
    return null;
  }
}

/**
 * Log a structured event.
 *
 * @param {Object} entry
 * @param {string} entry.source  Subsystem name
 * @param {string} entry.level   debug | info | warn | error
 * @param {string} entry.message Short human-readable string
 * @param {*}      [entry.ctx]   Optional structured payload
 */
function log(entry) {
  _ensureInit();
  const ts = new Date().toISOString();
  const source = entry.source || 'app';
  const level = VALID_LEVELS.has(entry.level) ? entry.level : 'info';
  const message = String(entry.message || '');
  const ctx = entry.ctx !== undefined ? entry.ctx : null;

  const rec = { ts, source, level, message, ctx };

  // Ring buffer
  ring.push(rec);
  if (ring.length > RING_SIZE) ring.shift();

  // Persist to file (async, fire-and-forget — never block caller)
  try {
    const stream = _streamFor(_todayStr());
    if (stream) stream.write(JSON.stringify(rec) + '\n');
  } catch (_) { /* ignore */ }

  // Fan out to listeners (e.g. renderer tail)
  for (const listener of listeners) {
    try { listener(rec); } catch (_) {}
  }

  // Mirror to console with a consistent prefix so we still see things during dev
  const consoleFn = level === 'error' ? console.error
                  : level === 'warn'  ? console.warn
                  : console.log;
  consoleFn(`[${source}] ${message}` + (ctx ? ` ${_safeStringify(ctx)}` : ''));

  return rec;
}

// Convenience helpers.
function debug(source, message, ctx) { return log({ source, level: 'debug', message, ctx }); }
function info(source, message, ctx)  { return log({ source, level: 'info',  message, ctx }); }
function warn(source, message, ctx)  { return log({ source, level: 'warn',  message, ctx }); }
function error(source, message, ctx) { return log({ source, level: 'error', message, ctx }); }

/**
 * Read the current ring buffer (newest last). Pass `filter` to narrow.
 */
function tail(opts = {}) {
  const { limit = 200, source = null, level = null } = opts;
  let out = ring;
  if (source) out = out.filter(r => r.source === source || r.source.startsWith(source + ':'));
  if (level)  out = out.filter(r => r.level === level);
  return out.slice(-limit);
}

/**
 * List available log files (filename, size, mtime).
 */
function listFiles() {
  _ensureInit();
  try {
    return fs.readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const full = path.join(LOG_DIR, f);
        const stat = fs.statSync(full);
        return { name: f, path: full, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (err) {
    return [];
  }
}

/**
 * Read entries from a specific log file.
 */
function readFile(name, opts = {}) {
  _ensureInit();
  const limit = opts.limit || 1000;
  const full = path.join(LOG_DIR, path.basename(name));
  if (!fs.existsSync(full)) return [];
  const content = fs.readFileSync(full, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  // Take the last `limit` entries
  const slice = lines.slice(-limit);
  const out = [];
  for (const line of slice) {
    try { out.push(JSON.parse(line)); } catch (_) {}
  }
  return out;
}

/**
 * Subscribe to live log events. Returns an unsubscribe function.
 */
function subscribe(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function _safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Capture an uncaught exception. Writes a crash dump alongside the daily log.
 */
function captureUncaught(err) {
  try {
    error('app', 'uncaughtException', {
      message: err.message,
      stack: err.stack,
      name: err.name,
    });
    const crashDir = path.join(os.homedir(), '.omniclaw', 'crashes');
    if (!fs.existsSync(crashDir)) fs.mkdirSync(crashDir, { recursive: true });
    const fn = path.join(crashDir, `crash-${Date.now()}.json`);
    fs.writeFileSync(fn, JSON.stringify({
      ts: new Date().toISOString(),
      error: { message: err.message, stack: err.stack, name: err.name },
      tail: ring.slice(-50),
    }, null, 2));
  } catch (_) { /* don't crash the crash handler */ }
}

module.exports = {
  log, debug, info, warn, error,
  tail, listFiles, readFile, subscribe,
  captureUncaught,
  LOG_DIR,
};
