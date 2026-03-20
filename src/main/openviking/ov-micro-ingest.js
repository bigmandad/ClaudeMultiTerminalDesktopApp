// ── OpenViking Micro-Ingest — real-time knowledge capture ────
// Detects significant patterns in PTY output and ingests them
// to OpenViking as they happen (not just at session end).

const fs = require('fs');
const path = require('path');
const os = require('os');

let ovClient = null;
const MICRO_DIR = path.join(os.tmpdir(), 'openviking-micro');

// Per-session state: buffers and throttle timers
const sessionState = new Map();

// Patterns that indicate significant content worth ingesting
const SIGNIFICANT_PATTERNS = [
  // Claude tool use results
  { regex: /(?:Created|Updated|Wrote|Modified)\s+(?:file\s+)?([^\s]+\.\w{1,5})/i, category: 'file-change', minLength: 20 },
  // Error discoveries
  { regex: /(?:Error|Bug|Issue|Fixed|Resolved):\s*(.{20,200})/i, category: 'discovery', minLength: 30 },
  // Key decisions
  { regex: /(?:Decision|Conclusion|Solution|Approach):\s*(.{20,200})/i, category: 'decision', minLength: 30 },
  // Test results
  { regex: /(?:Tests?\s+(?:passed|failed)|✓|✗|PASS|FAIL)\s*(.{0,100})/i, category: 'test-result', minLength: 10 },
  // Git operations
  { regex: /(?:commit\s+[a-f0-9]{7,40}|pushed\s+to\s+\S+|merged\s+\S+)/i, category: 'git-op', minLength: 10 },
];

// Minimum interval between ingests per session (ms) to prevent flooding
const INGEST_INTERVAL_MS = 30000; // 30 seconds

/**
 * Initialize micro-ingest with an OV client reference.
 */
function init(client) {
  ovClient = client;
  if (!fs.existsSync(MICRO_DIR)) {
    try { fs.mkdirSync(MICRO_DIR, { recursive: true }); } catch { /* ignore */ }
  }
}

/**
 * Process PTY output for micro-ingest opportunities.
 * Call this from the pty:data handler for each session.
 */
function processOutput(sessionId, data, meta = {}) {
  if (!ovClient) return;

  // Get or create session state
  if (!sessionState.has(sessionId)) {
    sessionState.set(sessionId, {
      buffer: '',
      lastIngestTime: 0,
      pendingSnippets: [],
      ingestCount: 0,
    });
  }

  const state = sessionState.get(sessionId);

  // Strip ANSI and accumulate
  const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
  state.buffer += clean;

  // Only keep last 4KB of buffer
  if (state.buffer.length > 4096) {
    state.buffer = state.buffer.slice(-2048);
  }

  // Check for significant patterns
  for (const pattern of SIGNIFICANT_PATTERNS) {
    const match = state.buffer.match(pattern.regex);
    if (match && match[0].length >= pattern.minLength) {
      // Extract a context window around the match
      const matchIdx = state.buffer.indexOf(match[0]);
      const start = Math.max(0, matchIdx - 100);
      const end = Math.min(state.buffer.length, matchIdx + match[0].length + 100);
      const snippet = state.buffer.slice(start, end).trim();

      // Deduplicate: don't re-ingest the same snippet
      const snippetHash = simpleHash(snippet);
      if (!state.pendingSnippets.includes(snippetHash)) {
        state.pendingSnippets.push(snippetHash);
        // Keep only last 50 hashes
        if (state.pendingSnippets.length > 50) state.pendingSnippets.shift();

        // Throttle: only ingest if enough time has passed
        const now = Date.now();
        if (now - state.lastIngestTime >= INGEST_INTERVAL_MS) {
          state.lastIngestTime = now;
          state.ingestCount++;
          ingestSnippet(sessionId, snippet, pattern.category, meta).catch((err) => {
            console.warn(`[MicroIngest] Failed for ${sessionId}:`, err.message);
          });
        }
      }
    }
  }
}

/**
 * Ingest a significant snippet to OpenViking.
 */
async function ingestSnippet(sessionId, snippet, category, meta) {
  const tmpFile = path.join(MICRO_DIR, `micro-${sessionId}-${Date.now()}.md`);

  const content = [
    `# Micro-Ingest: ${category}`,
    ``,
    `**Session:** ${meta.name || sessionId}`,
    `**Workspace:** ${meta.workspacePath || 'unknown'}`,
    `**Category:** ${category}`,
    `**Time:** ${new Date().toISOString()}`,
    ``,
    '## Content',
    '```',
    snippet.slice(0, 500),
    '```',
  ].join('\n');

  fs.writeFileSync(tmpFile, content);

  try {
    await ovClient.addResource(tmpFile, {
      scope: 'resources',
      reason: `Real-time capture (${category}) from session ${meta.name || sessionId}`,
      tags: ['micro-ingest', category, sessionId],
    });
    console.log(`[MicroIngest] Ingested ${category} snippet for ${sessionId}`);
  } finally {
    // Cleanup temp file
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

/**
 * Clean up session state when a session ends.
 */
function endSession(sessionId) {
  sessionState.delete(sessionId);
}

/**
 * Get micro-ingest stats for a session.
 */
function getStats(sessionId) {
  const state = sessionState.get(sessionId);
  if (!state) return { ingestCount: 0, bufferSize: 0 };
  return {
    ingestCount: state.ingestCount,
    bufferSize: state.buffer.length,
    pendingHashes: state.pendingSnippets.length,
  };
}

// Simple hash for deduplication (not cryptographic)
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash;
}

module.exports = { init, processOutput, endSession, getStats };
