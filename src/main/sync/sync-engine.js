/**
 * Sync engine for cross-machine session synchronisation.
 *
 * Responsibilities:
 *   - Register this machine in the machines table on launch
 *   - Push / pull CLI session JSONL files between filesystem and cli_sessions table
 *   - Push / pull transcript Markdown files between filesystem and transcript_chunks table
 *   - Coordinate sync timing (on launch, after changes, periodic)
 *
 * This module depends on turso-db.js for all database access and only activates
 * when turso-db is running in embedded-replica mode.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const tursoDB = require('../db/turso-db');
const { toPortablePath, toAbsolutePath, getMachineId, getMachineName } = require('./path-utils');
const { syncPlugins } = require('./plugin-sync');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MACHINE_ID = getMachineId();
const MACHINE_NAME = getMachineName();
const PLATFORM = os.platform();
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'projects');
const TRANSCRIPTS_DIR = path.join(os.homedir(), '.omniclaw', 'transcripts');

// ---------------------------------------------------------------------------
// Machine registration
// ---------------------------------------------------------------------------

async function registerMachine() {
  const workspaceRoot = toPortablePath(os.homedir());
  await tursoDB.run(
    `INSERT INTO machines (machine_id, machine_name, platform, last_seen, workspace_root)
     VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT(machine_id) DO UPDATE SET
       machine_name = excluded.machine_name,
       last_seen = datetime('now'),
       workspace_root = excluded.workspace_root`,
    [MACHINE_ID, MACHINE_NAME, PLATFORM, workspaceRoot]
  );
  console.log(`[Sync] Machine registered: ${MACHINE_NAME} (${MACHINE_ID})`);
}

// ---------------------------------------------------------------------------
// CLI session JSONL sync
// ---------------------------------------------------------------------------

/**
 * Scan local Claude CLI session directories and push any new / changed
 * JSONL content into the cli_sessions table.
 */
async function pushCliSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return;

  let pushed = 0;
  try {
    const projects = fs.readdirSync(SESSIONS_DIR);
    for (const project of projects) {
      const projectDir = path.join(SESSIONS_DIR, project);
      if (!fs.statSync(projectDir).isDirectory()) continue;

      const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const filePath = path.join(projectDir, file);
        const sessionUuid = path.basename(file, '.jsonl');
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;

        // Check if we already have this version
        const existing = await tursoDB.get(
          'SELECT file_size FROM cli_sessions WHERE session_uuid = ? AND machine_id = ?',
          [sessionUuid, MACHINE_ID]
        );

        if (existing && existing.file_size === fileSize) continue;

        // Read and store
        const content = fs.readFileSync(filePath, 'utf-8');
        const messageCount = content.split('\n').filter(Boolean).length;
        const relativePath = toPortablePath(projectDir);

        await tursoDB.run(
          `INSERT INTO cli_sessions (session_uuid, workspace_path_relative, jsonl_content, file_size, last_message_count, synced_at, machine_id)
           VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
           ON CONFLICT(session_uuid) DO UPDATE SET
             jsonl_content = excluded.jsonl_content,
             file_size = excluded.file_size,
             last_message_count = excluded.last_message_count,
             synced_at = datetime('now')`,
          [sessionUuid, relativePath, content, fileSize, messageCount, MACHINE_ID]
        );
        pushed++;
      }
    }
  } catch (err) {
    console.warn('[Sync] pushCliSessions error:', err.message);
  }
  if (pushed > 0) console.log(`[Sync] Pushed ${pushed} CLI session(s)`);
}

/**
 * Pull CLI session JSONL files from the database that were uploaded by
 * other machines, and write them to the local filesystem.
 */
async function pullCliSessions() {
  try {
    const rows = await tursoDB.query(
      'SELECT * FROM cli_sessions WHERE machine_id != ?',
      [MACHINE_ID]
    );

    let pulled = 0;
    for (const row of rows) {
      if (!row.jsonl_content) continue;

      const localDir = toAbsolutePath(row.workspace_path_relative);
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }

      const localFile = path.join(localDir, `${row.session_uuid}.jsonl`);

      // Only write if newer / different size
      if (fs.existsSync(localFile)) {
        const localSize = fs.statSync(localFile).size;
        if (localSize >= row.file_size) continue;
      }

      fs.writeFileSync(localFile, row.jsonl_content, 'utf-8');
      pulled++;
    }
    if (pulled > 0) console.log(`[Sync] Pulled ${pulled} CLI session(s) from other machines`);
  } catch (err) {
    console.warn('[Sync] pullCliSessions error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Transcript sync
// ---------------------------------------------------------------------------

/**
 * Push local transcript Markdown files into the transcript_chunks table.
 */
async function pushTranscripts() {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) return;

  let pushed = 0;
  try {
    const sessionDirs = fs.readdirSync(TRANSCRIPTS_DIR);
    for (const sessionId of sessionDirs) {
      const sessionDir = path.join(TRANSCRIPTS_DIR, sessionId);
      if (!fs.statSync(sessionDir).isDirectory()) continue;

      const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filePath = path.join(sessionDir, file);
        const date = path.basename(file, '.md');
        const content = fs.readFileSync(filePath, 'utf-8');

        // Split into chunks of ~100KB for storage efficiency
        const CHUNK_SIZE = 100 * 1024;
        const chunks = [];
        for (let i = 0; i < content.length; i += CHUNK_SIZE) {
          chunks.push(content.slice(i, i + CHUNK_SIZE));
        }

        for (let idx = 0; idx < chunks.length; idx++) {
          await tursoDB.run(
            `INSERT INTO transcript_chunks (session_id, date, chunk_index, content, created_at)
             VALUES (?, ?, ?, ?, datetime('now'))
             ON CONFLICT(session_id, date, chunk_index) DO UPDATE SET
               content = excluded.content`,
            [sessionId, date, idx, chunks[idx]]
          );
        }
        pushed++;
      }
    }
  } catch (err) {
    console.warn('[Sync] pushTranscripts error:', err.message);
  }
  if (pushed > 0) console.log(`[Sync] Pushed ${pushed} transcript file(s)`);
}

/**
 * Pull transcript chunks from the database and reassemble them into
 * local Markdown files.
 */
async function pullTranscripts() {
  try {
    // Get all unique session/date combos in the DB
    const combos = await tursoDB.query(
      `SELECT DISTINCT session_id, date FROM transcript_chunks ORDER BY session_id, date`
    );

    let pulled = 0;
    for (const { session_id, date } of combos) {
      const localDir = path.join(TRANSCRIPTS_DIR, session_id);
      const localFile = path.join(localDir, `${date}.md`);

      // Get chunks ordered by index
      const chunks = await tursoDB.query(
        'SELECT content FROM transcript_chunks WHERE session_id = ? AND date = ? ORDER BY chunk_index ASC',
        [session_id, date]
      );
      const fullContent = chunks.map(c => c.content).join('');

      // Only write if the DB version is larger
      if (fs.existsSync(localFile)) {
        const localSize = fs.statSync(localFile).size;
        if (localSize >= fullContent.length) continue;
      }

      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(localFile, fullContent, 'utf-8');
      pulled++;
    }
    if (pulled > 0) console.log(`[Sync] Pulled ${pulled} transcript file(s)`);
  } catch (err) {
    console.warn('[Sync] pullTranscripts error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// High-level sync operations
// ---------------------------------------------------------------------------

/**
 * Full sync on app launch: pull from cloud, register machine, hydrate local files.
 */
async function syncOnLaunch() {
  if (tursoDB.getMode() !== 'embedded-replica') {
    console.log('[Sync] Skipping launch sync — not in embedded-replica mode');
    return;
  }

  console.log('[Sync] Running launch sync...');
  try {
    await tursoDB.syncNow();       // Pull latest from Turso
    await registerMachine();
    await pullCliSessions();
    await pullTranscripts();

    // Plugin sync — reconcile marketplace manifests and custom plugin repos
    try {
      const Database = require('better-sqlite3');
      const dbPath = path.join(os.homedir(), '.omniclaw', 'omniclaw.db');
      const localDb = new Database(dbPath, { readonly: false });
      const customRepo = path.join(os.homedir(), 'Documents', 'ClaudeWorkspace', 'claude-plugins-custom');
      try {
        await syncPlugins(localDb, fs.existsSync(customRepo) ? customRepo : null);
      } finally {
        try { localDb.close(); } catch (_) { /* already closed */ }
      }
    } catch (pluginErr) {
      console.warn('[Sync] Plugin sync skipped:', pluginErr.message);
    }

    console.log('[Sync] Launch sync complete');
  } catch (err) {
    console.error('[Sync] Launch sync failed:', err.message);
  }
}

/**
 * Push local changes to the cloud after a meaningful event (session end,
 * transcript write, etc.).
 */
async function syncAfterChange() {
  if (tursoDB.getMode() !== 'embedded-replica') return;

  try {
    await pushCliSessions();
    await pushTranscripts();
    await tursoDB.syncNow();
  } catch (err) {
    console.warn('[Sync] Post-change sync failed:', err.message);
  }
}

/**
 * Start the periodic background sync via turso-db's built-in timer.
 */
function startPeriodicSync(intervalMs = 60000) {
  tursoDB.startPeriodicSync(intervalMs);
}

function stopPeriodicSync() {
  tursoDB.stopPeriodicSync();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  syncOnLaunch,
  syncAfterChange,
  startPeriodicSync,
  stopPeriodicSync,
  pushCliSessions,
  pullCliSessions,
  pushTranscripts,
  pullTranscripts,
  registerMachine,
  MACHINE_ID,
};
