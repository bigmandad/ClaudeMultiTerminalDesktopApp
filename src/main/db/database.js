const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

let db = null;

// Turso sync layer (lazy-loaded, never blocks the existing sync API)
let tursoDB = null;
let syncEngine = null;

function getDbPath() {
  const dir = path.join(os.homedir(), '.claude-sessions');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'claude-sessions.db');
}

function init() {
  if (db) return db;

  db = new Database(getDbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run schema
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  // Kick off Turso sync in the background (non-blocking).
  // This initialises the embedded replica and runs the first cloud sync.
  // Failures are logged but never prevent the app from starting.
  _initTursoSync();

  return db;
}

/**
 * Initialise Turso embedded-replica and sync engine in the background.
 * This is intentionally fire-and-forget so the synchronous init() path
 * is not delayed by network calls.
 */
async function _initTursoSync() {
  try {
    tursoDB = require('./turso-db');
    const client = await tursoDB.initDatabase();
    if (!client) return; // @libsql/client not installed

    // Run the sync-table schema through turso-db as well so the cloud
    // replica has the new tables.
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    await tursoDB.exec(schema);

    if (tursoDB.getMode() === 'embedded-replica') {
      syncEngine = require('../sync/sync-engine');
      await syncEngine.syncOnLaunch();
      syncEngine.startPeriodicSync(60000);
      console.log('[DB] Turso sync layer active');
    }
  } catch (err) {
    console.warn('[DB] Turso sync layer failed to initialise (app continues with local DB):', err.message);
  }
}

function close() {
  // Stop sync first
  if (syncEngine) {
    try { syncEngine.stopPeriodicSync(); } catch (_) {}
  }
  if (tursoDB) {
    // tursoDB.close() is async; best-effort on shutdown
    try { tursoDB.close(); } catch (_) {}
    tursoDB = null;
    syncEngine = null;
  }
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Trigger an immediate Turso sync.  Useful after bulk writes (e.g. session
 * end, transcript flush).  No-op when Turso is not configured.
 * @returns {Promise<void>}
 */
async function sync() {
  if (syncEngine) {
    await syncEngine.syncAfterChange();
  }
}

// ── Sessions ──────────────────────────────────────────────

const sessions = {
  create(session) {
    const stmt = db.prepare(`
      INSERT INTO sessions (id, name, workspace_path, mode, skip_perms, group_id, model, status)
      VALUES (@id, @name, @workspacePath, @mode, @skipPerms, @groupId, @model, @status)
    `);
    stmt.run({
      id: session.id,
      name: session.name,
      workspacePath: session.workspacePath || null,
      mode: session.mode || 'ask',
      skipPerms: session.skipPerms ? 1 : 0,
      groupId: session.groupId || null,
      model: session.model || null,
      status: session.status || 'stopped'
    });
    return session;
  },

  list() {
    return db.prepare('SELECT * FROM sessions ORDER BY last_active_at DESC').all();
  },

  get(id) {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  },

  update(id, data) {
    const fields = [];
    const values = {};
    for (const [key, val] of Object.entries(data)) {
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      fields.push(`${col} = @${key}`);
      values[key] = val;
    }
    values.id = id;
    fields.push("updated_at = datetime('now')");
    fields.push("last_active_at = datetime('now')");
    db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = @id`).run(values);
  },

  delete(id) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  },

  getByWorkspace(workspacePath) {
    return db.prepare('SELECT * FROM sessions WHERE workspace_path = ? ORDER BY last_active_at DESC LIMIT 1').get(workspacePath);
  }
};

// ── Groups ────────────────────────────────────────────────

const groups = {
  create(group) {
    db.prepare('INSERT INTO session_groups (id, name, color) VALUES (@id, @name, @color)').run(group);
    return group;
  },

  list() {
    return db.prepare('SELECT * FROM session_groups ORDER BY created_at DESC').all();
  },

  get(id) {
    return db.prepare('SELECT * FROM session_groups WHERE id = ?').get(id);
  },

  delete(id) {
    db.prepare('DELETE FROM session_groups WHERE id = ?').run(id);
  }
};

// ── Usage Stats ───────────────────────────────────────────

const usage = {
  record(entry) {
    db.prepare(`
      INSERT INTO usage_stats (session_id, tokens_input, tokens_output, cost_usd, model)
      VALUES (@sessionId, @tokensInput, @tokensOutput, @costUsd, @model)
    `).run(entry);
  },

  getBySession(sessionId) {
    return db.prepare('SELECT * FROM usage_stats WHERE session_id = ? ORDER BY timestamp DESC').all(sessionId);
  },

  getTotals() {
    return db.prepare(`
      SELECT
        COUNT(DISTINCT session_id) as session_count,
        SUM(tokens_input) as total_input,
        SUM(tokens_output) as total_output,
        SUM(cost_usd) as total_cost
      FROM usage_stats
    `).get();
  },

  getMonthly() {
    return db.prepare(`
      SELECT
        SUM(tokens_input) as monthly_input,
        SUM(tokens_output) as monthly_output,
        SUM(cost_usd) as monthly_cost
      FROM usage_stats
      WHERE timestamp >= datetime('now', 'start of month')
    `).get();
  }
};

// ── App State ─────────────────────────────────────────────

const appState = {
  get(key) {
    const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  },

  set(key, value) {
    db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  }
};

// ── Recent Paths ──────────────────────────────────────────

const recentPaths = {
  add(sessionId, filePath, type = 'file') {
    db.prepare(`
      INSERT OR REPLACE INTO recent_paths (session_id, path, type, last_used)
      VALUES (@sessionId, @path, @type, datetime('now'))
    `).run({ sessionId, path: filePath, type });
  },

  list(sessionId, limit = 10) {
    return db.prepare('SELECT * FROM recent_paths WHERE session_id = ? ORDER BY last_used DESC LIMIT ?').all(sessionId, limit);
  }
};

// ── Research Targets ─────────────────────────────────────

const researchTargets = {
  create(target) {
    db.prepare(`
      INSERT OR REPLACE INTO research_targets (id, type, name, source_path, editable_files, baseline_metrics, best_metrics, status)
      VALUES (@id, @type, @name, @sourcePath, @editableFiles, @baselineMetrics, @bestMetrics, @status)
    `).run({
      id: target.id,
      type: target.type,
      name: target.name,
      sourcePath: target.sourcePath || null,
      editableFiles: target.editableFiles ? JSON.stringify(target.editableFiles) : null,
      baselineMetrics: target.baselineMetrics ? JSON.stringify(target.baselineMetrics) : null,
      bestMetrics: target.bestMetrics ? JSON.stringify(target.bestMetrics) : null,
      status: target.status || 'idle'
    });
    return target;
  },

  list() {
    return db.prepare('SELECT * FROM research_targets ORDER BY updated_at DESC').all()
      .map(row => ({
        ...row,
        editableFiles: row.editable_files ? JSON.parse(row.editable_files) : [],
        baselineMetrics: row.baseline_metrics ? JSON.parse(row.baseline_metrics) : null,
        bestMetrics: row.best_metrics ? JSON.parse(row.best_metrics) : null,
      }));
  },

  get(id) {
    const row = db.prepare('SELECT * FROM research_targets WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      editableFiles: row.editable_files ? JSON.parse(row.editable_files) : [],
      baselineMetrics: row.baseline_metrics ? JSON.parse(row.baseline_metrics) : null,
      bestMetrics: row.best_metrics ? JSON.parse(row.best_metrics) : null,
    };
  },

  update(id, data) {
    const fields = [];
    const values = { id };
    for (const [key, val] of Object.entries(data)) {
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      const storeVal = (typeof val === 'object' && val !== null) ? JSON.stringify(val) : val;
      fields.push(`${col} = @${key}`);
      values[key] = storeVal;
    }
    fields.push("updated_at = datetime('now')");
    db.prepare(`UPDATE research_targets SET ${fields.join(', ')} WHERE id = @id`).run(values);
  },

  delete(id) {
    db.prepare('DELETE FROM experiments WHERE target_id = ?').run(id);
    db.prepare('DELETE FROM research_targets WHERE id = ?').run(id);
  }
};

// ── Experiments ──────────────────────────────────────────

const experiments = {
  record(exp) {
    const info = db.prepare(`
      INSERT INTO experiments (target_id, session_id, commit_hash, metric_name, metric_value, status, description, diff_summary, duration_seconds)
      VALUES (@targetId, @sessionId, @commitHash, @metricName, @metricValue, @status, @description, @diffSummary, @durationSeconds)
    `).run({
      targetId: exp.targetId,
      sessionId: exp.sessionId || null,
      commitHash: exp.commitHash || null,
      metricName: exp.metricName || null,
      metricValue: exp.metricValue ?? null,
      status: exp.status || 'discard',
      description: exp.description || '',
      diffSummary: exp.diffSummary || null,
      durationSeconds: exp.durationSeconds ?? null
    });

    // Update target counters
    db.prepare(`
      UPDATE research_targets SET
        total_experiments = total_experiments + 1,
        total_improvements = total_improvements + CASE WHEN ? = 'keep' THEN 1 ELSE 0 END,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(exp.status, exp.targetId);

    return { id: info.lastInsertRowid };
  },

  getByTarget(targetId, limit = 100) {
    return db.prepare('SELECT * FROM experiments WHERE target_id = ? ORDER BY created_at DESC LIMIT ?').all(targetId, limit);
  },

  getTimeline(targetId) {
    return db.prepare(`
      SELECT id, metric_name, metric_value, status, description, created_at
      FROM experiments WHERE target_id = ? ORDER BY created_at ASC
    `).all(targetId);
  },

  getBestByTarget(targetId) {
    return db.prepare(`
      SELECT * FROM experiments WHERE target_id = ? AND status = 'keep'
      ORDER BY metric_value DESC LIMIT 1
    `).get(targetId);
  },

  getRecent(limit = 20) {
    return db.prepare(`
      SELECT e.*, rt.name as target_name, rt.type as target_type
      FROM experiments e LEFT JOIN research_targets rt ON e.target_id = rt.id
      ORDER BY e.created_at DESC LIMIT ?
    `).all(limit);
  }
};

// ── Blackboard (cross-session shared state) ──────────────

const blackboard = {
  set(sessionId, key, value, category = 'general', ttlSeconds = null) {
    db.prepare(`
      INSERT OR REPLACE INTO blackboard (session_id, key, value, category, ttl_seconds, updated_at)
      VALUES (@sessionId, @key, @value, @category, @ttlSeconds, datetime('now'))
    `).run({ sessionId, key, value: JSON.stringify(value), category, ttlSeconds });
  },

  get(key) {
    const row = db.prepare('SELECT * FROM blackboard WHERE key = ? ORDER BY updated_at DESC LIMIT 1').get(key);
    if (!row) return null;
    // Check TTL
    if (row.ttl_seconds) {
      const age = (Date.now() - new Date(row.updated_at).getTime()) / 1000;
      if (age > row.ttl_seconds) {
        db.prepare('DELETE FROM blackboard WHERE id = ?').run(row.id);
        return null;
      }
    }
    return { ...row, value: JSON.parse(row.value) };
  },

  getBySession(sessionId) {
    return db.prepare('SELECT * FROM blackboard WHERE session_id = ? ORDER BY updated_at DESC')
      .all(sessionId)
      .map(row => ({ ...row, value: JSON.parse(row.value) }));
  },

  getByCategory(category) {
    return db.prepare('SELECT * FROM blackboard WHERE category = ? ORDER BY updated_at DESC')
      .all(category)
      .map(row => ({ ...row, value: JSON.parse(row.value) }));
  },

  list(limit = 50) {
    return db.prepare('SELECT * FROM blackboard ORDER BY updated_at DESC LIMIT ?')
      .all(limit)
      .map(row => ({ ...row, value: JSON.parse(row.value) }));
  },

  delete(key) {
    db.prepare('DELETE FROM blackboard WHERE key = ?').run(key);
  },

  clear(sessionId = null) {
    if (sessionId) {
      db.prepare('DELETE FROM blackboard WHERE session_id = ?').run(sessionId);
    } else {
      db.prepare('DELETE FROM blackboard').run();
    }
  },

  // Cleanup expired entries
  prune() {
    db.prepare(`
      DELETE FROM blackboard
      WHERE ttl_seconds IS NOT NULL
      AND (julianday('now') - julianday(updated_at)) * 86400 > ttl_seconds
    `).run();
  }
};

// ── Hook Events (Claude Code lifecycle events) ───────────

const hookEvents = {
  record(event) {
    db.prepare(`
      INSERT INTO hook_events (session_id, hook_type, event_name, tool_name, file_path, result, metadata)
      VALUES (@sessionId, @hookType, @eventName, @toolName, @filePath, @result, @metadata)
    `).run({
      sessionId: event.sessionId || null,
      hookType: event.hookType || 'unknown',
      eventName: event.eventName,
      toolName: event.toolName || null,
      filePath: event.filePath || null,
      result: event.result || null,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
    });
  },

  getRecent(limit = 50) {
    return db.prepare('SELECT * FROM hook_events ORDER BY created_at DESC LIMIT ?').all(limit);
  },

  getBySession(sessionId, limit = 50) {
    return db.prepare('SELECT * FROM hook_events WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(sessionId, limit);
  },

  getByEvent(eventName, limit = 50) {
    return db.prepare('SELECT * FROM hook_events WHERE event_name = ? ORDER BY created_at DESC LIMIT ?')
      .all(eventName, limit);
  },

  getToolUsageStats() {
    return db.prepare(`
      SELECT tool_name, COUNT(*) as count,
        SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) as successes,
        SUM(CASE WHEN result = 'error' THEN 1 ELSE 0 END) as errors
      FROM hook_events
      WHERE tool_name IS NOT NULL
      GROUP BY tool_name ORDER BY count DESC
    `).all();
  },

  // Prune old entries: keep last 30 days or 10,000 records max
  prune() {
    db.prepare(`DELETE FROM hook_events WHERE created_at < datetime('now', '-30 days')`).run();
    const count = db.prepare('SELECT COUNT(*) as cnt FROM hook_events').get().cnt;
    if (count > 10000) {
      db.prepare(`
        DELETE FROM hook_events WHERE id NOT IN (
          SELECT id FROM hook_events ORDER BY created_at DESC LIMIT 10000
        )
      `).run();
    }
  }
};

// ── Channel Bindings (messaging platform ↔ session) ──────

const channelBindings = {
  bind(platform, channelId, sessionId, metadata = {}) {
    db.prepare(`
      INSERT OR REPLACE INTO channel_bindings (platform, channel_id, session_id, guild_id, metadata)
      VALUES (@platform, @channelId, @sessionId, @guildId, @metadata)
    `).run({
      platform,
      channelId,
      sessionId,
      guildId: metadata.guild_id || null,
      metadata: JSON.stringify(metadata)
    });
  },

  unbind(platform, channelId) {
    db.prepare('DELETE FROM channel_bindings WHERE platform = ? AND channel_id = ?')
      .run(platform, channelId);
  },

  getByChannel(platform, channelId) {
    return db.prepare('SELECT * FROM channel_bindings WHERE platform = ? AND channel_id = ?')
      .get(platform, channelId);
  },

  getBySession(sessionId) {
    return db.prepare('SELECT * FROM channel_bindings WHERE session_id = ?')
      .all(sessionId);
  },

  listByPlatform(platform) {
    return db.prepare('SELECT * FROM channel_bindings WHERE platform = ?')
      .all(platform);
  },

  clearPlatform(platform) {
    db.prepare('DELETE FROM channel_bindings WHERE platform = ?').run(platform);
  }
};

// ── Maintenance ──────────────────────────────────────────

function runMaintenance() {
  if (!db) return;
  blackboard.prune();
  hookEvents.prune();
}

module.exports = { init, close, sync, runMaintenance, sessions, groups, usage, appState, recentPaths, researchTargets, experiments, blackboard, hookEvents, channelBindings };
