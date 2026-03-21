// ── Messaging Bridge — Platform-agnostic adapter for chat platforms ────
// Routes messages between chat platforms (Discord, Telegram, etc.)
// and OmniClaw PTY instances.
//
// Output strategy (VT buffer approach):
//   1. Raw PTY data is fed into a per-session VirtualTerminal buffer
//   2. The VT correctly interprets cursor positioning, screen clears, etc.
//   3. On flush, the screen content is read from the VT buffer
//   4. CLI chrome (status bars, prompts, spinners) is stripped
//   5. Diff against last sent content extracts only NEW response text
//   6. Only new content is dispatched to platforms (no garbled duplicates)
//
// This replaces the old approach of stripping ANSI codes from a text stream,
// which failed because cursor-positioning sequences can't be correctly
// translated to linear text (words get concatenated, TUI artifacts leak).

const { PtyManager } = require('../pty/pty-manager');
const { VirtualTerminal } = require('./virtual-terminal');
const db = require('../db/database');

// Registered platform output callbacks: platform -> (channelId, text) => void
const platforms = new Map();

// Session → bound channels lookup (rebuilt from DB on demand)
let bindingsCache = null;
let bindingsCacheTime = 0;
const CACHE_TTL = 5000; // refresh every 5s

// ── Per-session virtual terminal buffers ──
// Each session gets its own VT that accumulates screen state.
// sessionId -> VirtualTerminal
const sessionVTs = new Map();

// ── Per-channel output tracking ──
// Tracks what content has already been sent to each channel,
// so we can diff and only send new content.
// "platform:channelId" -> { lastContent: string, sessionId: string }
const channelState = new Map();

// ── Batching timers ──
// "platform:channelId" -> { timer, sessionId, promptDetected }
const outputBatches = new Map();

const FLUSH_DELAY = 6000;   // flush after 6s silence (wait for complete response)
const PROMPT_FLUSH = 800;   // flush 800ms after prompt detected (response complete)
const MIN_OUTPUT = 5;        // minimum chars to send (skip trivial fragments)

/**
 * Detect whether the VT screen or raw data contains the Claude CLI prompt.
 * The prompt (❯) reappearing means the CLI is done responding and ready
 * for next input — this is the strongest completion signal we can detect.
 */
function hasPromptSignal(rawData) {
  // Quick check on raw data (strip just enough ANSI to find the prompt)
  const rough = rawData
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  if (/(?:^|\n)\s*❯/m.test(rough)) return true;
  if (/❯\s/.test(rough)) return true;
  return false;
}

/**
 * Strip Claude CLI TUI chrome from terminal screen content.
 * The VT buffer captures everything on screen — we only want the actual
 * response content, not the UI elements (status bar, progress, prompts).
 */
function stripCliChrome(text) {
  return text
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return false;

      // ── Drop known CLI UI patterns ──

      // Mode / permission / UI indicators
      if (/don't ask on|shift\+tab|esc to interrupt|to cycle|compact mode|auto-accept|yes.*all|interrupt claude/i.test(trimmed)) return false;

      // Loading / thinking animations (with any prefix like · • spinner chars)
      if (/^[·•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✦✧⊹*\s]*(?:Cascading|Hyperspacing|Thinking|Loading|Connecting|Warming|Processing|Analyzing|Searching|Reading|Writing|Editing|Generating|Compiling|Running|Executing|Planning|Reasoning)[.…·]*$/i.test(trimmed)) return false;

      // Spinner characters only (any combo of spinners/bullets/stars)
      if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✦✧⊹*·•─━═\s]+$/.test(trimmed)) return false;

      // Progress bars (lines of mostly box-drawing / dash chars)
      if (/^[─━═\-_\.·•\s]{5,}$/.test(trimmed)) return false;

      // Prompt lines (❯ › followed by optional text = echoed user input)
      if (/^[❯›]\s/.test(trimmed) || /^[❯›>$]\s*$/.test(trimmed)) return false;

      // Cost / token counters (multiple formats Claude CLI uses)
      if (/^\$[\d.]+\s+\d+[kK]?\s+tokens?/i.test(trimmed)) return false;
      if (/\d+[kK]?\s+input.*\d+[kK]?\s+output/i.test(trimmed)) return false;
      if (/^\d+[kK]?\s+tokens?\s+remaining/i.test(trimmed)) return false;

      // Tool use decorative headers: ──── Read ────, ━━━ Bash ━━━, etc.
      if (/^[─━═]+\s*(Read|Write|Edit|Bash|Glob|Grep|Search|Agent|TodoWrite|WebFetch|WebSearch|NotebookEdit|AskUser)\s*[─━═]+$/i.test(trimmed)) return false;

      // Tool use indicators: ⏺ Read(file_path: "..."), ● Edit(...), etc.
      if (/^[⏺●○◉◎⊙]\s*(Read|Write|Edit|Bash|Glob|Grep|Search|Agent|TodoWrite|WebFetch|WebSearch)\s*\(/i.test(trimmed)) return false;

      // Tool use compact format: Read(src/main/foo.js)
      if (/^(Read|Write|Edit|Bash|Glob|Grep|Search)\s*\(.+\)\s*$/i.test(trimmed)) return false;

      // Permission prompts
      if (/^(Allow|Deny|Skip)\s+(once|always)/i.test(trimmed)) return false;
      if (/^\[Y\/n\]|\[y\/N\]|^y\/n\s*$/i.test(trimmed)) return false;

      // Claude CLI version/startup banner
      if (/^claude\s+v?\d+\.\d+/i.test(trimmed)) return false;
      if (/^Claude Code\s/i.test(trimmed)) return false;
      if (/^Tips:/i.test(trimmed)) return false;

      // "Tool result" headers
      if (/^(Tool result|Output|Result|Input):\s*$/i.test(trimmed)) return false;

      // Lines that are ONLY control chars / whitespace / special Unicode
      if (/^[\s\x00-\x1f\u200b-\u200f\ufeff]+$/.test(trimmed)) return false;

      // ── Garble detection ──
      const alphanumCount = (trimmed.match(/[a-zA-Z0-9]/g) || []).length;
      const totalLen = trimmed.length;

      // Low alphanumeric ratio = likely TUI artifacts
      if (totalLen > 4 && alphanumCount / totalLen < 0.3) return false;

      // Symbol-letter mixing: He*Hdrdng*Hd● pattern
      const garbleSymbols = (trimmed.match(/[A-Za-z][*●•⏺○◉◎⊙✦✧⊹⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|[*●•⏺○◉◎⊙✦✧⊹⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏][A-Za-z]/g) || []).length;
      if (garbleSymbols > 1) return false;

      // Lines with excessive asterisks/symbols mixed with letters (garbled animations)
      if (/\*[A-Za-z]\*|[+*]{3,}|Ca\*s|Ca\*C|Th\*i|Hy\*p/i.test(trimmed)) return false;

      // Repeated single-char patterns (garbled redraw artifacts)
      if (totalLen > 3 && /^(.)\1{2,}$/.test(trimmed)) return false;

      // Very short lines (1-3 chars) that aren't code/markdown
      if (totalLen <= 3 && !/^[`#>*\-\d]/.test(trimmed) && !/^[A-Z]/.test(trimmed)) return false;

      // Character-by-character cursor positioning artifacts ("H e a d i n g")
      if (/^([A-Za-z] ){4,}[A-Za-z]?$/.test(trimmed)) return false;

      return true;
    })
    // Post-process: strip trailing prompt characters from content lines
    .map(line => line.replace(/\s*[❯›]\s*$/, '').trimEnd())
    .filter(line => line.trim().length > 0)
    .join('\n');
}

/**
 * Find the new content in screenContent that wasn't in lastSent.
 * Handles both appending (streaming response) and complete replacement (new response).
 */
function findNewContent(lastSent, screenContent) {
  if (!lastSent) return screenContent;

  // If screen content starts with what we already sent, extract the rest
  if (screenContent.startsWith(lastSent)) {
    return screenContent.slice(lastSent.length);
  }

  // Try to find an overlap: end of lastSent matches somewhere in screenContent.
  // This handles cases where some old content scrolled off the top of the screen.
  const maxCheck = Math.min(lastSent.length, 300);
  for (let overlap = maxCheck; overlap >= 20; overlap--) {
    const suffix = lastSent.slice(-overlap);
    const idx = screenContent.indexOf(suffix);
    if (idx !== -1) {
      return screenContent.slice(idx + overlap);
    }
  }

  // No overlap found — this is completely new content (new response)
  return screenContent;
}

// ── Platform Registration ────────────────────────────────

function registerPlatform(name, outputCallback) {
  platforms.set(name, outputCallback);
  console.log(`[MessagingBridge] Registered platform: ${name}`);
}

function unregisterPlatform(name) {
  platforms.delete(name);
  // Clear any pending batches for this platform
  for (const [key, batch] of outputBatches) {
    if (key.startsWith(name + ':')) {
      if (batch.timer) clearTimeout(batch.timer);
      outputBatches.delete(key);
    }
  }
  // Clear channel state for this platform
  for (const [key] of channelState) {
    if (key.startsWith(name + ':')) {
      channelState.delete(key);
    }
  }
  console.log(`[MessagingBridge] Unregistered platform: ${name}`);
}

// ── Channel Bindings ─────────────────────────────────────

function refreshBindingsCache() {
  const now = Date.now();
  if (bindingsCache && (now - bindingsCacheTime) < CACHE_TTL) return;

  bindingsCache = new Map();
  try {
    // Load all bindings from DB grouped by session
    for (const [platformName] of platforms) {
      const rows = db.channelBindings.listByPlatform(platformName);
      for (const row of rows) {
        if (!bindingsCache.has(row.session_id)) {
          bindingsCache.set(row.session_id, []);
        }
        bindingsCache.get(row.session_id).push({
          platform: row.platform,
          channelId: row.channel_id
        });
      }
    }
  } catch (e) {
    console.warn('[MessagingBridge] Failed to load bindings:', e.message);
  }
  bindingsCacheTime = now;
}

function invalidateCache() {
  bindingsCache = null;
  bindingsCacheTime = 0;
}

function bindChannel(platform, channelId, sessionId, metadata = {}) {
  db.channelBindings.bind(platform, channelId, sessionId, metadata);
  invalidateCache();
  console.log(`[MessagingBridge] Bound ${platform}:${channelId} → session ${sessionId.slice(0, 12)}`);
}

function unbindChannel(platform, channelId) {
  db.channelBindings.unbind(platform, channelId);
  const key = `${platform}:${channelId}`;
  channelState.delete(key);
  invalidateCache();
  console.log(`[MessagingBridge] Unbound ${platform}:${channelId}`);
}

function getBinding(platform, channelId) {
  return db.channelBindings.getByChannel(platform, channelId);
}

function getBindingsForSession(sessionId) {
  return db.channelBindings.getBySession(sessionId);
}

// ── Message Routing ──────────────────────────────────────

function routeMessage(platform, channelId, text) {
  const binding = getBinding(platform, channelId);
  if (!binding) {
    console.warn(`[MessagingBridge] No binding for ${platform}:${channelId}`);
    return false;
  }

  try {
    // Verify the PTY session exists and is alive before writing.
    const ptySession = PtyManager.get(binding.session_id);
    if (!ptySession || !ptySession.process) {
      console.warn(`[MessagingBridge] PTY not alive for session ${binding.session_id.slice(0, 12)}`);
      return false;
    }

    PtyManager.write(binding.session_id, text + '\r');
    console.log(`[MessagingBridge] Routed ${platform}:${channelId} → ${binding.session_id.slice(0, 12)}: ${text.slice(0, 60)}`);

    // Reset channel state when a new message is sent — the next response
    // is fresh content, so clear the diff tracker.
    const key = `${platform}:${channelId}`;
    const state = channelState.get(key);
    if (state) {
      state.lastContent = '';
    }

    return true;
  } catch (e) {
    console.error(`[MessagingBridge] Route failed:`, e.message);
    return false;
  }
}

// ── Output Dispatch & Batching ───────────────────────────

function flushBatch(platform, channelId, batch) {
  if (batch.timer) {
    clearTimeout(batch.timer);
    batch.timer = null;
  }

  batch.promptDetected = false;

  const vt = sessionVTs.get(batch.sessionId);
  if (!vt) return;

  // Read the current screen content from the VT buffer
  const screenContent = stripCliChrome(vt.getContent()).trim();

  // Collapse multiple blank lines
  const cleaned = screenContent.replace(/\n{3,}/g, '\n\n');

  if (!cleaned || cleaned.length < MIN_OUTPUT) return;

  // Diff against what we already sent to this channel
  const key = `${platform}:${channelId}`;
  let state = channelState.get(key);
  if (!state) {
    state = { lastContent: '', sessionId: batch.sessionId };
    channelState.set(key, state);
  }

  const newContent = findNewContent(state.lastContent, cleaned).trim();

  if (!newContent || newContent.length < MIN_OUTPUT) return;

  // Update what we've sent
  state.lastContent = cleaned;

  const callback = platforms.get(platform);
  if (!callback) return;

  try {
    callback(channelId, newContent);
  } catch (e) {
    console.error(`[MessagingBridge] Output delivery to ${platform} failed:`, e.message);
  }
}

function dispatchOutput(sessionId, rawData) {
  refreshBindingsCache();

  const bindings = bindingsCache ? bindingsCache.get(sessionId) : null;
  if (!bindings || bindings.length === 0) return;

  // Get or create VT buffer for this session
  let vt = sessionVTs.get(sessionId);
  if (!vt) {
    vt = new VirtualTerminal(120, 30);
    sessionVTs.set(sessionId, vt);
  }

  // Feed raw PTY data into the VT buffer.
  // This correctly interprets cursor positioning, screen clears, etc.
  // The VT buffer now reflects the current state of the terminal screen.
  vt.write(rawData);

  // Check for prompt signal in the raw data
  const promptDetected = hasPromptSignal(rawData);

  // Also check the VT screen for prompt
  const vtPrompt = vt.hasPrompt();

  const isPrompt = promptDetected || vtPrompt;

  for (const { platform, channelId } of bindings) {
    if (!platforms.has(platform)) continue;

    const key = `${platform}:${channelId}`;
    let batch = outputBatches.get(key);
    if (!batch) {
      batch = { timer: null, sessionId, promptDetected: false };
      outputBatches.set(key, batch);
    }

    if (isPrompt) batch.promptDetected = true;

    // Clear existing timer
    if (batch.timer) clearTimeout(batch.timer);

    // ── Flush strategy ──
    if (batch.promptDetected) {
      // Prompt detected = response is complete → quick flush
      batch.timer = setTimeout(() => flushBatch(platform, channelId, batch), PROMPT_FLUSH);
    } else {
      // Default: flush after silence (wait for more output)
      batch.timer = setTimeout(() => flushBatch(platform, channelId, batch), FLUSH_DELAY);
    }
  }
}

// ── Cleanup ──────────────────────────────────────────────

/**
 * Clean up VT buffer for a session (call when PTY exits).
 */
function cleanupSession(sessionId) {
  sessionVTs.delete(sessionId);
  // Also clear channel state for channels bound to this session
  for (const [key, state] of channelState) {
    if (state.sessionId === sessionId) {
      channelState.delete(key);
    }
  }
}

// ── Output Formatting ────────────────────────────────────

function formatOutput(text, platform, maxLength = 1900) {
  if (!text || !text.trim()) return '_No output._';

  let formatted = text.trim();

  // Truncate from the start if too long (keep most recent output)
  if (formatted.length > maxLength - 20) {
    formatted = '...' + formatted.slice(-(maxLength - 30));
  }

  // Wrap in code block for Discord/Telegram
  if (platform === 'discord' || platform === 'telegram') {
    formatted = '```\n' + formatted + '\n```';
  }

  // Final safety truncation
  if (formatted.length > maxLength) {
    formatted = formatted.slice(0, maxLength - 3) + '...';
  }

  return formatted;
}

// ── Session List Helper ──────────────────────────────────

function listSessions() {
  return db.sessions.list();
}

module.exports = {
  registerPlatform,
  unregisterPlatform,
  bindChannel,
  unbindChannel,
  getBinding,
  getBindingsForSession,
  routeMessage,
  dispatchOutput,
  formatOutput,
  listSessions,
  invalidateCache,
  cleanupSession
};
