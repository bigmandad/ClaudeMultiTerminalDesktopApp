-- Claude Sessions Database Schema

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_path TEXT,
  mode TEXT DEFAULT 'ask',
  skip_perms INTEGER DEFAULT 0,
  group_id TEXT,
  model TEXT,
  mcp_config TEXT,
  system_prompt TEXT,
  status TEXT DEFAULT 'stopped',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_active_at TEXT,
  claude_session_id TEXT,
  auto_commit INTEGER DEFAULT 1,
  git_worktree INTEGER DEFAULT 0,
  github_repo TEXT,
  FOREIGN KEY (group_id) REFERENCES session_groups(id)
);

CREATE TABLE IF NOT EXISTS session_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#d4845a',
  context_file TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  date TEXT NOT NULL,
  file_path TEXT NOT NULL,
  size_bytes INTEGER DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS usage_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  timestamp TEXT DEFAULT (datetime('now')),
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  model TEXT
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS recent_paths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  path TEXT NOT NULL,
  type TEXT DEFAULT 'file',
  last_used TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS research_targets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  source_path TEXT,
  editable_files TEXT,
  baseline_metrics TEXT,
  best_metrics TEXT,
  total_experiments INTEGER DEFAULT 0,
  total_improvements INTEGER DEFAULT 0,
  status TEXT DEFAULT 'idle',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id TEXT NOT NULL,
  session_id TEXT,
  commit_hash TEXT,
  metric_name TEXT,
  metric_value REAL,
  status TEXT,
  description TEXT,
  diff_summary TEXT,
  duration_seconds REAL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (target_id) REFERENCES research_targets(id)
);

-- Cross-session shared blackboard for multi-agent coordination
CREATE TABLE IF NOT EXISTS blackboard (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  key TEXT NOT NULL,
  value TEXT,
  category TEXT DEFAULT 'general',
  ttl_seconds INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Claude Code hooks event log
CREATE TABLE IF NOT EXISTS hook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  hook_type TEXT NOT NULL,
  event_name TEXT NOT NULL,
  tool_name TEXT,
  file_path TEXT,
  result TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Messaging platform channel-to-session bindings
CREATE TABLE IF NOT EXISTS channel_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  guild_id TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(platform, channel_id)
);

-- ── Turso cross-machine sync tables ──────────────────────

-- Transcript content (synced across machines)
CREATE TABLE IF NOT EXISTS transcript_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  date TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, date, chunk_index)
);

-- Claude CLI session files (synced across machines)
CREATE TABLE IF NOT EXISTS cli_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_uuid TEXT NOT NULL UNIQUE,
  workspace_path_relative TEXT NOT NULL,
  jsonl_content TEXT,
  file_size INTEGER DEFAULT 0,
  last_message_count INTEGER DEFAULT 0,
  synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  machine_id TEXT NOT NULL
);

-- Plugin sync manifest
CREATE TABLE IF NOT EXISTS plugin_sync (
  plugin_id TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  version TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'project',
  project_path TEXT NOT NULL DEFAULT '',
  file_hash TEXT,
  installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  machine_id TEXT NOT NULL,
  PRIMARY KEY (plugin_id, scope, project_path)
);

-- Machine registry (track which machines are part of the sync)
CREATE TABLE IF NOT EXISTS machines (
  machine_id TEXT PRIMARY KEY,
  machine_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  workspace_root TEXT NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_blackboard_key ON blackboard(key);
CREATE INDEX IF NOT EXISTS idx_blackboard_session ON blackboard(session_id);
CREATE INDEX IF NOT EXISTS idx_blackboard_category ON blackboard(category);
CREATE INDEX IF NOT EXISTS idx_hook_events_session ON hook_events(session_id);
CREATE INDEX IF NOT EXISTS idx_hook_events_type ON hook_events(event_name);
CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_id);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_path);
CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_stats(session_id);
CREATE INDEX IF NOT EXISTS idx_recent_paths_session ON recent_paths(session_id);
CREATE INDEX IF NOT EXISTS idx_experiments_target ON experiments(target_id);
CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);
CREATE INDEX IF NOT EXISTS idx_research_targets_type ON research_targets(type);
CREATE INDEX IF NOT EXISTS idx_channel_bindings_session ON channel_bindings(session_id);
CREATE INDEX IF NOT EXISTS idx_channel_bindings_lookup ON channel_bindings(platform, channel_id);

-- Sync table indexes
CREATE INDEX IF NOT EXISTS idx_transcript_chunks_session ON transcript_chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_transcript_chunks_lookup ON transcript_chunks(session_id, date);
CREATE INDEX IF NOT EXISTS idx_cli_sessions_machine ON cli_sessions(machine_id);
CREATE INDEX IF NOT EXISTS idx_cli_sessions_uuid ON cli_sessions(session_uuid);
CREATE INDEX IF NOT EXISTS idx_plugin_sync_machine ON plugin_sync(machine_id);
CREATE INDEX IF NOT EXISTS idx_machines_last_seen ON machines(last_seen);
