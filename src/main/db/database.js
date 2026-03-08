const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

let db = null;

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

  return db;
}

function close() {
  if (db) {
    db.close();
    db = null;
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

module.exports = { init, close, sessions, groups, usage, appState, recentPaths };
