// ── OpenViking Knowledge Ingestion ────────────────────────
// Ingests Hytale references, codex entries, session transcripts,
// and plugin knowledge into the OpenViking context database.

const fs = require('fs');
const path = require('path');
const os = require('os');
const ovClient = require('./ov-client');

// Search for hytale-modding plugin in user-level and common workspace locations
function findHytalePluginDir() {
  const candidates = [
    path.join(os.homedir(), '.claude', 'plugins', 'hytale-modding'),
    path.join(os.homedir(), 'Documents', 'ClaudeWorkspace', '.claude', 'plugins', 'hytale-modding'),
    process.env.HYTALE_PLUGIN_DIR,
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(path.join(p, '.claude-plugin', 'plugin.json')) || fs.existsSync(path.join(p, 'skills'))) || candidates[0];
}
const HYTALE_PLUGIN_DIR = findHytalePluginDir();
const HYTALE_SKILLS_DIR = path.join(HYTALE_PLUGIN_DIR, 'skills');
const TRANSCRIPTS_DIR = path.join(os.homedir(), '.claude-sessions', 'transcripts');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/**
 * Ingest all Hytale API reference files into OpenViking.
 * These are the 45 deep reference files (59K+ lines, 3400+ classes).
 * OpenViking will auto-generate L0/L1/L2 tiers for each.
 */
async function ingestHytaleReferences() {
  const results = { success: 0, failed: 0, errors: [] };

  if (!fs.existsSync(HYTALE_SKILLS_DIR)) {
    return { ...results, errors: ['Hytale plugin skills directory not found'] };
  }

  // Walk all skill directories for reference files
  const skillDirs = fs.readdirSync(HYTALE_SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const skillName of skillDirs) {
    const skillDir = path.join(HYTALE_SKILLS_DIR, skillName);
    const mdFiles = findMarkdownFiles(skillDir);

    for (const mdFile of mdFiles) {
      try {
        const relativePath = path.relative(HYTALE_SKILLS_DIR, mdFile);
        await ovClient.addResource(mdFile, {
          scope: 'resources',
          reason: `Hytale modding reference: ${relativePath}`,
          tags: ['hytale', 'reference', skillName]
        });
        results.success++;
        console.log(`[OV-Ingest] Added: ${relativePath}`);
      } catch (err) {
        results.failed++;
        results.errors.push(`${mdFile}: ${err.message}`);
      }
    }
  }

  return results;
}

/**
 * Ingest HYTALE_CODEX.md entries as agent memories/patterns.
 */
async function ingestCodex(codexPath) {
  if (!codexPath) {
    // Try to find it in common locations (env var, plugin dir, workspace, home)
    const home = os.homedir();
    const candidates = [
      process.env.HYTALE_CODEX_PATH,
      path.join(home, '.claude', 'plugins', 'hytale-modding', 'HYTALE_CODEX.md'),
      path.join(home, 'Documents', 'ClaudeWorkspace', 'HYTALEMODWORKSHOP', 'CorruptionMod', 'HYTALE_CODEX.md'),
      path.join(home, 'Documents', 'ClaudeWorkspace', 'ClaudeProjects', 'KingdomsMod', 'HYTALE_CODEX.md'),
    ].filter(Boolean);
    codexPath = candidates.find(p => fs.existsSync(p));
  }

  if (!codexPath || !fs.existsSync(codexPath)) {
    return { success: 0, failed: 0, errors: ['HYTALE_CODEX.md not found'] };
  }

  try {
    await ovClient.addResource(codexPath, {
      scope: 'resources',
      reason: 'Hytale Living Codex — verified engine discoveries and patterns',
      tags: ['hytale', 'codex', 'discoveries', 'patterns']
    });
    return { success: 1, failed: 0, errors: [] };
  } catch (err) {
    return { success: 0, failed: 1, errors: [err.message] };
  }
}

/**
 * Ingest session transcripts for a specific session or all sessions.
 */
async function ingestTranscripts(sessionId = null) {
  const results = { success: 0, failed: 0, errors: [] };

  if (!fs.existsSync(TRANSCRIPTS_DIR)) {
    return { ...results, errors: ['Transcripts directory not found'] };
  }

  const sessionDirs = sessionId
    ? [path.join(TRANSCRIPTS_DIR, sessionId)]
    : fs.readdirSync(TRANSCRIPTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(TRANSCRIPTS_DIR, d.name));

  for (const sessionDir of sessionDirs) {
    if (!fs.existsSync(sessionDir)) continue;

    const transcriptFiles = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(sessionDir, f));

    for (const file of transcriptFiles) {
      try {
        const sid = path.basename(path.dirname(file));
        const date = path.basename(file, '.md');
        await ovClient.addResource(file, {
          scope: 'resources',
          reason: `Session transcript: ${sid} (${date})`,
          tags: ['transcript', 'session', sid, date]
        });
        results.success++;
      } catch (err) {
        results.failed++;
        results.errors.push(`${file}: ${err.message}`);
      }
    }
  }

  return results;
}

/**
 * Ingest a single session transcript (called when a session ends).
 */
async function ingestSingleTranscript(sessionId, transcriptContent, meta = {}) {
  try {
    // Write to temp file and ingest
    const tmpDir = path.join(os.tmpdir(), 'openviking-ingest');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const tmpFile = path.join(tmpDir, `${sessionId}-${Date.now()}.md`);
    const header = [
      `# Session: ${meta.name || sessionId}`,
      `# Date: ${new Date().toISOString()}`,
      meta.workspacePath ? `# Workspace: ${meta.workspacePath}` : '',
      `# Mode: ${meta.mode || 'ask'}`,
      '',
      '---',
      ''
    ].filter(Boolean).join('\n');

    fs.writeFileSync(tmpFile, header + transcriptContent);

    await ovClient.addResource(tmpFile, {
      scope: 'resources',
      reason: `Session transcript: ${meta.name || sessionId}`,
      tags: ['transcript', 'session', sessionId]
    });

    // Also try to extract memories
    try {
      await ovClient.extractMemory(sessionId, transcriptContent, 'claude-sessions');
    } catch (memErr) {
      console.log('[OV-Ingest] Memory extraction skipped:', memErr.message);
    }

    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Ingest project memory files from ~/.claude/projects/
 */
async function ingestProjectMemories() {
  const results = { success: 0, failed: 0, errors: [] };

  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    return { ...results, errors: ['Projects directory not found'] };
  }

  const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(CLAUDE_PROJECTS_DIR, d.name));

  for (const projectDir of projectDirs) {
    const memoryDir = path.join(projectDir, 'memory');
    if (!fs.existsSync(memoryDir)) continue;

    const memFiles = findMarkdownFiles(memoryDir);
    for (const file of memFiles) {
      try {
        const projectName = path.basename(projectDir);
        await ovClient.addResource(file, {
          scope: 'resources',
          reason: `Project memory: ${projectName}`,
          tags: ['project-memory', projectName]
        });
        results.success++;
      } catch (err) {
        results.failed++;
        results.errors.push(`${file}: ${err.message}`);
      }
    }
  }

  return results;
}

/**
 * Run full ingestion of all knowledge sources.
 */
async function ingestAll() {
  console.log('[OV-Ingest] Starting full knowledge ingestion...');

  const allResults = {
    references: await ingestHytaleReferences(),
    codex: await ingestCodex(),
    transcripts: await ingestTranscripts(),
    projectMemories: await ingestProjectMemories()
  };

  const totalSuccess = Object.values(allResults).reduce((sum, r) => sum + r.success, 0);
  const totalFailed = Object.values(allResults).reduce((sum, r) => sum + r.failed, 0);

  console.log(`[OV-Ingest] Complete: ${totalSuccess} succeeded, ${totalFailed} failed`);
  return allResults;
}

// ── Helpers ──────────────────────────────────────────────────

function findMarkdownFiles(dir, maxDepth = 3, depth = 0) {
  const results = [];
  if (depth > maxDepth || !fs.existsSync(dir)) return results;

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findMarkdownFiles(fullPath, maxDepth, depth + 1));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
  } catch { /* ignore permission errors */ }

  return results;
}

module.exports = {
  ingestHytaleReferences,
  ingestCodex,
  ingestTranscripts,
  ingestSingleTranscript,
  ingestProjectMemories,
  ingestAll
};
