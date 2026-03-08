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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_id);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_path);
CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_stats(session_id);
CREATE INDEX IF NOT EXISTS idx_recent_paths_session ON recent_paths(session_id);
