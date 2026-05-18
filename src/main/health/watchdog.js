// ── Watchdog — Local Health Monitor Agent ─────────────────
// Monitors all services, auto-fixes failures, pushes to GitHub

const { createProbes } = require('./probes');

// ── State ─────────────────────────────────────────────────
let probes = [];
let intervalHandle = null;
let isRunning = false;
let lastResults = new Map();   // probe name → last check result
let lastCheckTime = null;
let fixHistory = new Map();    // probe name → { attempts, lastAttempt, cooldownUntil }
let gitPushConsented = false;
let deps = {};                 // { db, notifier, mainWindow }

const MAX_FIX_ATTEMPTS = 3;
const FIX_WINDOW_MS = 10 * 60 * 1000;  // 10 minutes
const MAX_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// Global back-pressure: cap destructive fixes (probes that mutate external
// state — git commits, process kills, package installs) at 1 per 60s across
// ALL probes. Prevents a restart storm if multiple probes flap simultaneously.
const GLOBAL_DESTRUCTIVE_WINDOW_MS = 60 * 1000;
let lastDestructiveFixAt = 0;
function _isDestructiveProbe(probe) {
  // Explicit opt-in flag wins; otherwise infer from name.
  if (probe.destructiveFix === true) return true;
  return ['git', 'plugins', 'openviking', 'ollama'].includes(probe.name);
}

// ── Lifecycle ─────────────────────────────────────────────

function init(dependencies) {
  deps = dependencies;

  // Create probes with available dependencies
  let ovServer = null;
  let setup = null;
  let gitOps = null;

  try { ovServer = require('../openviking/ov-server'); } catch {}
  try { setup = require('../setup/setup-wizard'); } catch {}
  try { gitOps = require('../git/git-ops'); } catch {}

  probes = createProbes({
    db: deps.db,
    ovServer,
    setup,
    gitOps
  });

  // Load git push consent from DB (appState stores JSON-encoded values)
  if (deps.db && deps.db.appState) {
    try {
      gitPushConsented = deps.db.appState.get('watchdog_git_push_consented') === true;
    } catch {}
  }

  console.log(`[Watchdog] Initialized with ${probes.length} probes, gitPush=${gitPushConsented}`);
}

function start(intervalMs = 30000) {
  if (isRunning) return;
  isRunning = true;
  console.log(`[Watchdog] Health monitor started (${intervalMs / 1000}s interval)`);

  // Run immediately, then on interval
  runAllProbes().catch(err => console.error('[Watchdog] Initial probe run failed:', err.message));
  intervalHandle = setInterval(() => {
    runAllProbes().catch(err => console.error('[Watchdog] Probe run failed:', err.message));
  }, intervalMs);
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  isRunning = false;
  console.log('[Watchdog] Health monitor stopped');
}

// ── Probe Execution ───────────────────────────────────────

async function runAllProbes() {
  const results = {};
  const checkPromises = probes.map(async (probe) => {
    try {
      const result = await probe.check();
      lastResults.set(probe.name, { ...result, label: probe.label, checkedAt: Date.now() });
      results[probe.name] = { ...result, label: probe.label };

      // Auto-fix if down or degraded and fixable
      if ((result.status === 'down' || result.status === 'degraded') && result.fixable) {
        await attemptFix(probe, result);
      }
    } catch (err) {
      const errResult = { status: 'down', message: `Check error: ${err.message}`, fixable: false, label: probe.label };
      lastResults.set(probe.name, { ...errResult, checkedAt: Date.now() });
      results[probe.name] = errResult;
    }
  });

  await Promise.allSettled(checkPromises);
  lastCheckTime = Date.now();

  // Broadcast to renderer
  broadcastStatus(results);

  return results;
}

// ── Auto-Fix with Backoff ─────────────────────────────────

async function attemptFix(probe, probeResult) {
  const now = Date.now();
  let history = fixHistory.get(probe.name) || { attempts: 0, lastAttempt: 0, cooldownUntil: 0 };

  // Reset attempts if outside the fix window
  if (now - history.lastAttempt > FIX_WINDOW_MS) {
    history = { attempts: 0, lastAttempt: 0, cooldownUntil: 0 };
  }

  // Check cooldown
  if (now < history.cooldownUntil) {
    const remaining = Math.round((history.cooldownUntil - now) / 1000);
    console.log(`[Watchdog] ${probe.name}: cooldown (${remaining}s remaining)`);
    return;
  }

  // Check max attempts
  if (history.attempts >= MAX_FIX_ATTEMPTS) {
    // Apply exponential backoff
    const backoffMs = Math.min(Math.pow(2, history.attempts - MAX_FIX_ATTEMPTS + 1) * 60 * 1000, MAX_COOLDOWN_MS);
    history.cooldownUntil = now + backoffMs;
    fixHistory.set(probe.name, history);
    console.log(`[Watchdog] ${probe.name}: max attempts reached, cooldown ${Math.round(backoffMs / 60000)}min`);
    notify(`${probe.label} — fix attempts exhausted`, `Cooling down for ${Math.round(backoffMs / 60000)} minutes`);
    return;
  }

  // Global destructive-fix back-pressure. If we already kicked off a fix
  // that mutates external state in the last 60s, refuse this one — it can
  // wait for the next probe interval. This prevents two flapping services
  // from triggering simultaneous git commits / process kills / pip installs.
  if (_isDestructiveProbe(probe) && (now - lastDestructiveFixAt) < GLOBAL_DESTRUCTIVE_WINDOW_MS) {
    const wait = Math.ceil((GLOBAL_DESTRUCTIVE_WINDOW_MS - (now - lastDestructiveFixAt)) / 1000);
    console.log(`[Watchdog] ${probe.name}: destructive-fix back-pressure (next eligible in ${wait}s)`);
    return;
  }

  // Attempt the fix
  console.log(`[Watchdog] ${probe.name}: attempting fix (attempt ${history.attempts + 1}/${MAX_FIX_ATTEMPTS})`);
  notify(`Fixing: ${probe.label}`, probeResult.message);

  // Record destructive fix attempt timestamp BEFORE running so a long-running
  // fix still blocks other destructive fixes for the full window.
  if (_isDestructiveProbe(probe)) {
    lastDestructiveFixAt = now;
  }

  try {
    let fixResult;
    // Git probe needs extra context (consent flag)
    if (probe.name === 'git') {
      fixResult = await probe.fix(probeResult, { gitPushConsented });
    } else {
      fixResult = await probe.fix();
    }

    if (fixResult && fixResult.success) {
      console.log(`[Watchdog] ${probe.name}: fix succeeded — ${fixResult.message}`);
      notify(`Fixed: ${probe.label}`, fixResult.message);
      // Reset history on success
      fixHistory.set(probe.name, { attempts: 0, lastAttempt: now, cooldownUntil: 0 });
    } else {
      history.attempts++;
      history.lastAttempt = now;
      fixHistory.set(probe.name, history);
      console.log(`[Watchdog] ${probe.name}: fix failed — ${fixResult?.message || 'unknown'}`);
    }
  } catch (err) {
    history.attempts++;
    history.lastAttempt = now;
    fixHistory.set(probe.name, history);
    console.error(`[Watchdog] ${probe.name}: fix error — ${err.message}`);
  }
}

// ── Git Push Consent ──────────────────────────────────────

function consentGitPush() {
  gitPushConsented = true;
  if (deps.db && deps.db.appState) {
    try { deps.db.appState.set('watchdog_git_push_consented', true); } catch {}
  }
  console.log('[Watchdog] Git push consent granted');
}

function revokeGitPush() {
  gitPushConsented = false;
  if (deps.db && deps.db.appState) {
    try { deps.db.appState.set('watchdog_git_push_consented', false); } catch {}
  }
  console.log('[Watchdog] Git push consent revoked');
}

// ── Status ────────────────────────────────────────────────

function getStatus() {
  const results = {};
  for (const [name, result] of lastResults) {
    results[name] = result;
  }
  return {
    running: isRunning,
    results,
    lastCheck: lastCheckTime,
    gitPushConsented,
    probeCount: probes.length
  };
}

// ── Notifications ─────────────────────────────────────────

function notify(title, body) {
  if (deps.notifier && deps.notifier.showNative) {
    deps.notifier.showNative(`Watchdog: ${title}`, body);
  }
}

function broadcastStatus(results) {
  try {
    if (deps.mainWindow && !deps.mainWindow.isDestroyed()) {
      deps.mainWindow.webContents.send('watchdog:status', {
        running: isRunning,
        results,
        lastCheck: lastCheckTime,
        gitPushConsented
      });
    }
  } catch {}
}

// ── Exports ───────────────────────────────────────────────

module.exports = {
  init,
  start,
  stop,
  runAllProbes,
  getStatus,
  consentGitPush,
  revokeGitPush
};
