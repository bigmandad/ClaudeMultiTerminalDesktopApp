/**
 * Turso embedded-replica database wrapper.
 *
 * Provides the same logical API surface as better-sqlite3 but uses @libsql/client
 * under the hood so that the database can optionally sync to Turso Cloud.
 *
 * Modes:
 *   1. Embedded replica  -- local SQLite file + cloud sync (when TURSO_DATABASE_URL
 *      and TURSO_AUTH_TOKEN are set).
 *   2. Local-only        -- plain local SQLite file, no cloud (default).
 *
 * IMPORTANT: @libsql/client is fully async.  This wrapper exposes an async
 * interface.  Callers that previously used better-sqlite3's synchronous API
 * must be updated to await the results.  The existing database.js is left
 * untouched for now; consumers should migrate to this module incrementally.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TURSO_URL = process.env.TURSO_DATABASE_URL || null;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || null;

function getLocalDbPath() {
  const dir = path.join(os.homedir(), '.claude-sessions');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'claude-sessions.db');
}

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

let client = null;
let mode = 'uninitialized'; // 'embedded-replica' | 'local-only' | 'uninitialized'

/**
 * Initialise the libsql client.  Safe to call multiple times (idempotent).
 * Returns the client instance.
 */
async function initDatabase() {
  if (client) return client;

  // Lazy-require so the module doesn't explode if @libsql/client isn't
  // installed yet (allows the rest of the app to keep running on better-sqlite3).
  let createClient;
  try {
    ({ createClient } = require('@libsql/client'));
  } catch (err) {
    console.warn('[TursoDB] @libsql/client not installed — turso-db unavailable.', err.message);
    mode = 'unavailable';
    return null;
  }

  const localPath = getLocalDbPath();

  if (TURSO_URL && TURSO_TOKEN) {
    // Embedded replica mode: local file with cloud sync
    client = createClient({
      url: `file:${localPath}`,
      syncUrl: TURSO_URL,
      authToken: TURSO_TOKEN,
      syncInterval: 60, // auto-sync every 60 seconds
    });
    mode = 'embedded-replica';
    console.log('[TursoDB] Embedded replica mode — syncing to', TURSO_URL);

    // Pull latest state from cloud on first init
    try {
      await client.sync();
      console.log('[TursoDB] Initial sync complete');
    } catch (err) {
      console.warn('[TursoDB] Initial sync failed (will retry later):', err.message);
    }
  } else {
    // Local-only mode
    client = createClient({
      url: `file:${localPath}`,
    });
    mode = 'local-only';
    console.log('[TursoDB] Local-only mode — no cloud sync configured');
  }

  return client;
}

// ---------------------------------------------------------------------------
// Query helpers — thin wrappers around libsql's client.execute()
// ---------------------------------------------------------------------------

/**
 * Execute a SQL statement that returns rows (SELECT, etc.).
 * @param {string} sql
 * @param {Array|Object} params  positional (array) or named (object) params
 * @returns {Promise<Array<Object>>}  array of row objects
 */
async function query(sql, params = []) {
  if (!client) throw new Error('[TursoDB] Database not initialised — call initDatabase() first');
  const rs = await client.execute({ sql, args: normalizeParams(params) });
  return rs.rows;
}

/**
 * Execute a SQL statement that does not return rows (INSERT, UPDATE, DELETE).
 * @returns {Promise<{rowsAffected: number, lastInsertRowid: BigInt}>}
 */
async function run(sql, params = []) {
  if (!client) throw new Error('[TursoDB] Database not initialised — call initDatabase() first');
  const rs = await client.execute({ sql, args: normalizeParams(params) });
  return { rowsAffected: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid };
}

/**
 * Execute raw SQL (multiple statements, DDL, etc.).  Typically used for schema
 * migrations.  libsql's executeMultiple handles statement splitting.
 */
async function exec(sql) {
  if (!client) throw new Error('[TursoDB] Database not initialised — call initDatabase() first');
  // executeMultiple is not available on all libsql builds; fall back to
  // splitting on semicolons and running one-by-one.
  if (typeof client.executeMultiple === 'function') {
    await client.executeMultiple(sql);
  } else {
    const stmts = sql
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);
    for (const stmt of stmts) {
      await client.execute(stmt);
    }
  }
}

/**
 * Execute a single-row query and return the first row or null.
 */
async function get(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// ---------------------------------------------------------------------------
// Sync helpers
// ---------------------------------------------------------------------------

/**
 * Trigger an immediate sync to/from Turso Cloud.
 * No-op in local-only mode.
 */
async function syncNow() {
  if (mode !== 'embedded-replica' || !client) return;
  try {
    await client.sync();
    console.log('[TursoDB] Manual sync complete');
  } catch (err) {
    console.warn('[TursoDB] Manual sync failed:', err.message);
  }
}

let periodicSyncTimer = null;

/**
 * Start a periodic sync loop (in addition to the libsql built-in syncInterval).
 * Useful for pushing local writes to the cloud on a shorter cadence.
 */
function startPeriodicSync(intervalMs = 60000) {
  if (periodicSyncTimer) return;
  if (mode !== 'embedded-replica') return;
  periodicSyncTimer = setInterval(async () => {
    try {
      await client.sync();
    } catch (err) {
      console.warn('[TursoDB] Periodic sync failed:', err.message);
    }
  }, intervalMs);
  console.log(`[TursoDB] Periodic sync started (every ${intervalMs / 1000}s)`);
}

function stopPeriodicSync() {
  if (periodicSyncTimer) {
    clearInterval(periodicSyncTimer);
    periodicSyncTimer = null;
    console.log('[TursoDB] Periodic sync stopped');
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function close() {
  stopPeriodicSync();
  if (client) {
    // Push any remaining writes before closing
    if (mode === 'embedded-replica') {
      try { await client.sync(); } catch (_) { /* best-effort */ }
    }
    client.close();
    client = null;
    mode = 'uninitialized';
    console.log('[TursoDB] Database closed');
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Normalise parameters for libsql.  better-sqlite3 uses @named params in
 * objects; libsql expects positional arrays or named objects with slightly
 * different conventions.  This helper bridges the gap.
 */
function normalizeParams(params) {
  if (Array.isArray(params)) return params;
  if (typeof params === 'object' && params !== null) {
    // libsql named params use ':name' or '$name' keys; better-sqlite3 uses
    // @name (which maps to object keys without the prefix).  libsql accepts
    // plain object keys as-is when using { sql, args } form.
    return params;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  initDatabase,
  close,
  query,
  run,
  exec,
  get,
  syncNow,
  startPeriodicSync,
  stopPeriodicSync,
  getMode: () => mode,
  getClient: () => client,
};
