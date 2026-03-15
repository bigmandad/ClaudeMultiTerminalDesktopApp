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
      FROM experiments e JOIN research_targets rt ON e.target_id = rt.id
      ORDER BY e.created_at DESC LIMIT ?
    `).all(limit);
  }
};

module.exports = { init, close, sessions, groups, usage, appState, recentPaths, researchTargets, experiments };
