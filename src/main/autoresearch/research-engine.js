// ── Research Engine — autonomous improvement loop orchestration ──

const fs = require('fs');
const path = require('path');
const os = require('os');
const targetAnalyzer = require('./target-analyzer');
const experimentTracker = require('./experiment-tracker');
const programTemplates = require('./program-templates');

const RESEARCH_DIR = path.join(os.homedir(), '.omniclaw', 'autoresearch');

// ── Safety limits & diminishing returns defaults ─────────
const DEFAULTS = {
  maxExperiments: 100,       // Hard cap on experiment count per session
  timeoutMinutes: 180,       // 3-hour max runtime
  stagnationWindow: 8,       // Number of recent experiments to check for stagnation
  stagnationThreshold: 0.001, // Min improvement delta to count as "progress"
  maxConsecutiveDiscards: 5, // Stop after N discards in a row
};

// Active research sessions: targetId -> { sessionId, status, experimentCount, ... }
const activeResearch = new Map();

// Per-session output buffers for handling chunked PTY data
const outputBuffers = new Map();

// Callbacks
let onExperimentComplete = null;
let onStatusChanged = null;
let ptySpawnFn = null;
let ptyWriteFn = null;
let ovClientRef = null;
let dbRef = null;

/**
 * Initialize the research engine with references to other systems.
 */
function init({ ptySpawn, ptyWrite, ovClient, db }) {
  ptySpawnFn = ptySpawn;
  ptyWriteFn = ptyWrite;
  ovClientRef = ovClient;
  dbRef = db;
}

/**
 * Set callback for experiment completion events.
 */
function onExperiment(cb) { onExperimentComplete = cb; }
function onStatus(cb) { onStatusChanged = cb; }

/**
 * Start autonomous research on a target.
 * Spawns a Claude CLI session with generated program.md as context.
 */
async function startResearch(config) {
  const { targetId } = config;

  if (activeResearch.has(targetId)) {
    return { success: false, error: 'Research already active for this target' };
  }

  // Analyze the target
  const profile = targetAnalyzer.analyze(targetId);
  if (!profile) {
    return { success: false, error: `Target not found: ${targetId}` };
  }

  // Query OpenViking for past experiments (if available)
  let pastContext = '';
  if (ovClientRef) {
    try {
      const results = await ovClientRef.search(
        `autoresearch experiments on ${profile.name}`,
        { topK: 10, tier: 'L1' }
      );
      const resources = results?.resources || results?.result?.resources || [];
      if (resources.length > 0) {
        pastContext = resources
          .map(r => `- ${(r.abstract || r.content || r.overview || 'no content').slice(0, 200)}`)
          .join('\n');
      }
    } catch { /* OV not available, continue without context */ }
  }

  // Generate program.md
  const programMd = programTemplates.generate(profile, pastContext);
  const programDir = path.join(RESEARCH_DIR, targetId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  if (!fs.existsSync(programDir)) fs.mkdirSync(programDir, { recursive: true });
  const programPath = path.join(programDir, 'program.md');
  fs.writeFileSync(programPath, programMd);

  // Initialize experiment tracking
  experimentTracker.initTarget(targetId);

  // Save target to DB
  if (dbRef) {
    try {
      dbRef.researchTargets.create({
        id: targetId,
        type: profile.type,
        name: profile.name,
        sourcePath: profile.sourcePath,
        editableFiles: profile.editableFiles,
        baselineMetrics: profile.metrics || null,
        bestMetrics: null,
        status: 'active',
      });
    } catch { /* may already exist, try update */
      try {
        dbRef.researchTargets.update(targetId, { status: 'active' });
      } catch { /* ignore */ }
    }
  }

  // Generate session ID
  const sessionId = `research-${targetId.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`;

  // Track active research (with safety limits from config or defaults)
  const researchState = {
    sessionId,
    targetId,
    profile,
    programPath,
    status: 'starting',
    experimentCount: 0,
    lastMetricValue: null,
    bestMetricValue: null,
    startedAt: new Date().toISOString(),
    // Safety limits
    maxExperiments: config.maxExperiments || DEFAULTS.maxExperiments,
    timeoutMinutes: config.timeoutMinutes || DEFAULTS.timeoutMinutes,
    stagnationWindow: config.stagnationWindow || DEFAULTS.stagnationWindow,
    stagnationThreshold: config.stagnationThreshold || DEFAULTS.stagnationThreshold,
    maxConsecutiveDiscards: config.maxConsecutiveDiscards || DEFAULTS.maxConsecutiveDiscards,
    // Diminishing returns tracking
    recentMetrics: [],            // Rolling window of recent metric values
    consecutiveDiscards: 0,       // Counter for discards in a row
    stopReason: null,             // Why research was auto-stopped (null if still running)
  };
  activeResearch.set(targetId, researchState);
  console.log(`[ResearchEngine] Research started for ${targetId}: maxExp=${researchState.maxExperiments}, timeout=${researchState.timeoutMinutes}min, maxDiscards=${researchState.maxConsecutiveDiscards}, stagnationWin=${researchState.stagnationWindow}`);

  emitStatus(targetId, researchState);

  return {
    success: true,
    sessionId,
    targetId,
    programPath,
    workspacePath: profile.sourcePath || os.homedir(),
    profile,
  };
}

/**
 * Stop an active research session.
 */
function stopResearch(targetId) {
  const research = activeResearch.get(targetId);
  if (!research) return { success: false, error: 'No active research for this target' };

  research.status = 'stopped';
  activeResearch.delete(targetId);

  if (dbRef) {
    try { dbRef.researchTargets.update(targetId, { status: 'idle' }); } catch { /* ignore */ }
  }

  emitStatus(targetId, { ...research, status: 'stopped' });
  return { success: true, sessionId: research.sessionId };
}

/**
 * Pause an active research session (keep state, just stop processing).
 */
function pauseResearch(targetId) {
  const research = activeResearch.get(targetId);
  if (!research) return { success: false, error: 'No active research for this target' };

  research.status = 'paused';
  if (dbRef) {
    try { dbRef.researchTargets.update(targetId, { status: 'paused' }); } catch { /* ignore */ }
  }

  emitStatus(targetId, research);
  return { success: true };
}

/**
 * Get status of research for a target.
 */
function getStatus(targetId) {
  const research = activeResearch.get(targetId);
  if (!research) return { status: 'idle', targetId };
  return { ...research };
}

/**
 * Get status of all active research.
 */
function getAllStatus() {
  const result = {};
  for (const [targetId, research] of activeResearch) {
    result[targetId] = { ...research };
  }
  return result;
}

/**
 * Process PTY output from a research session.
 * Buffers data to handle experiment result blocks split across chunks.
 */
function processOutput(sessionId, data) {
  // Find which target this session belongs to
  let targetId = null;
  let research = null;
  for (const [tid, r] of activeResearch) {
    if (r.sessionId === sessionId) {
      targetId = tid;
      research = r;
      break;
    }
  }
  if (!research) return;

  // Update status to running on first output
  if (research.status === 'starting') {
    research.status = 'running';
    console.log(`[ResearchEngine] First output received for ${targetId}, status → running`);
    if (dbRef) {
      try { dbRef.researchTargets.update(targetId, { status: 'running' }); } catch { /* ignore */ }
    }
    emitStatus(targetId, research);
  }

  // Strip ANSI codes and accumulate into buffer
  const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const buf = (outputBuffers.get(sessionId) || '') + clean;

  // Look for complete result blocks delimited by --- markers
  // Format: ---\nmetric_name: ...\nmetric_value: ...\nstatus: ...\ndescription: ...\n---
  const blockRegex = /---\s*\n([\s\S]*?)---/g;
  let match;
  let lastIndex = 0;

  while ((match = blockRegex.exec(buf)) !== null) {
    lastIndex = match.index + match[0].length;
    const block = match[1];

    const metricMatch = block.match(/^metric_value:\s*([\d.]+)/m);
    const statusMatch = block.match(/^status:\s*(keep|discard|crash)/m);
    if (!metricMatch || !statusMatch) continue;

    const nameMatch = block.match(/^metric_name:\s*(\S+)/m);
    const descMatch = block.match(/^description:\s*(.+)/m);
    const commitMatch = block.match(/^commit:\s*([a-f0-9]{7,40})/m);
    const durationMatch = block.match(/^duration:\s*(\d+)/m);

    const parsedMetric = parseFloat(metricMatch[1]);

    // Validate metric value — skip malformed results
    if (isNaN(parsedMetric)) {
      console.warn(`[ResearchEngine] Skipping experiment with NaN metric value for ${targetId}`);
      continue;
    }

    const experiment = {
      targetId,
      sessionId,
      commitHash: commitMatch?.[1] || null,
      metricName: nameMatch?.[1] || 'quality',
      metricValue: parsedMetric,
      status: statusMatch[1],
      description: descMatch?.[1]?.trim() || '',
      durationSeconds: durationMatch ? parseInt(durationMatch[1]) : null,
    };

    // Log to TSV
    try {
      experimentTracker.appendTsv(targetId, experiment);
    } catch (tsvErr) {
      console.error(`[ResearchEngine] TSV write failed for ${targetId}:`, tsvErr.message);
    }

    // Log to DB
    if (dbRef) {
      try {
        dbRef.experiments.record(experiment);
      } catch (dbErr) {
        console.error(`[ResearchEngine] DB record failed for ${targetId}:`, dbErr.message);
      }
    }

    // Write experiment log for OV ingestion
    const logPath = experimentTracker.writeExperimentLog(targetId, experiment);

    // Auto-ingest to OpenViking (fire-and-forget with proper logging)
    if (ovClientRef) {
      ingestExperiment(targetId, experiment, logPath).catch((ovErr) => {
        console.warn(`[ResearchEngine] OV ingest failed for ${targetId} exp#${research.experimentCount + 1}:`, ovErr.message);
      });
    }

    // Update research state
    research.experimentCount++;
    research.lastMetricValue = experiment.metricValue;
    research.recentMetrics.push(experiment.metricValue);
    console.log(`[ResearchEngine] Experiment #${research.experimentCount} for ${targetId}: ${experiment.status} ${experiment.metricName}=${experiment.metricValue.toFixed(4)} — ${experiment.description?.slice(0, 80)}`);

    // Track consecutive discards
    if (experiment.status === 'discard' || experiment.status === 'crash') {
      research.consecutiveDiscards++;
    } else {
      research.consecutiveDiscards = 0;
    }

    if (experiment.status === 'keep') {
      if (!research.bestMetricValue || experiment.metricValue > research.bestMetricValue) {
        research.bestMetricValue = experiment.metricValue;
        // Sync best metric back to DB for crash recovery
        if (dbRef) {
          try {
            dbRef.researchTargets.update(targetId, {
              bestMetrics: JSON.stringify({ [experiment.metricName]: experiment.metricValue })
            });
          } catch { /* ignore */ }
        }
      }
    }

    // Emit event
    if (onExperimentComplete) {
      onExperimentComplete({
        targetId,
        experiment,
        researchState: { ...research },
      });
    }

    // Check safety limits after emitting (so UI shows the experiment that triggered the stop)
    const safetyCheck = checkSafetyLimits(targetId, research);
    if (safetyCheck && safetyCheck.shouldStop) {
      autoStopResearch(targetId, safetyCheck.reason);
      return; // Stop processing further blocks
    }
  }

  // Keep only unconsumed data in buffer (max 8KB to prevent unbounded growth)
  const remaining = buf.slice(lastIndex);
  outputBuffers.set(sessionId, remaining.length > 8192 ? remaining.slice(-4096) : remaining);
}

/**
 * Check if a session ID belongs to a research session.
 */
function isResearchSession(sessionId) {
  for (const r of activeResearch.values()) {
    if (r.sessionId === sessionId) return true;
  }
  return false;
}

// ── Safety limits & diminishing returns ──────────────────

/**
 * Check if research should be auto-stopped due to safety limits or stagnation.
 * Returns { shouldStop: boolean, reason: string } or null if fine.
 */
function checkSafetyLimits(targetId, research) {
  // 1. Experiment count hard cap
  if (research.experimentCount >= research.maxExperiments) {
    return { shouldStop: true, reason: `max-experiments (${research.maxExperiments})` };
  }

  // 2. Timeout
  const elapsedMs = Date.now() - new Date(research.startedAt).getTime();
  const elapsedMins = elapsedMs / 60000;
  if (elapsedMins >= research.timeoutMinutes) {
    return { shouldStop: true, reason: `timeout (${research.timeoutMinutes}min)` };
  }

  // 3. Consecutive discards
  if (research.consecutiveDiscards >= research.maxConsecutiveDiscards) {
    return { shouldStop: true, reason: `${research.consecutiveDiscards} consecutive discards` };
  }

  // 4. Stagnation detection (moving average not improving)
  if (research.recentMetrics.length >= research.stagnationWindow) {
    const window = research.recentMetrics.slice(-research.stagnationWindow);
    const firstHalf = window.slice(0, Math.floor(window.length / 2));
    const secondHalf = window.slice(Math.floor(window.length / 2));
    const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    const improvement = avgSecond - avgFirst;

    if (Math.abs(improvement) < research.stagnationThreshold) {
      return { shouldStop: true, reason: `stagnation (Δ=${improvement.toFixed(4)} over last ${research.stagnationWindow} experiments)` };
    }
  }

  return null;
}

/**
 * Auto-stop research session due to safety limits.
 * @param {string} targetId
 * @param {string} reason
 */
function autoStopResearch(targetId, reason) {
  const research = activeResearch.get(targetId);
  if (!research) {
    console.log(`[ResearchEngine] autoStop called for ${targetId} but no active research found (already stopped?)`);
    return;
  }

  const elapsedMs = Date.now() - new Date(research.startedAt).getTime();
  const elapsedMin = (elapsedMs / 60000).toFixed(1);
  console.log(`[ResearchEngine] Auto-stopping ${targetId}: ${reason} (${research.experimentCount} experiments, ${elapsedMin}min, best=${research.bestMetricValue})`);
  research.status = 'auto-stopped';
  research.stopReason = reason;
  activeResearch.delete(targetId);

  if (dbRef) {
    try { dbRef.researchTargets.update(targetId, { status: 'auto-stopped' }); } catch { /* ignore */ }
  }

  emitStatus(targetId, { ...research, status: 'auto-stopped', stopReason: reason });

  // Emit as experiment event too so renderer gets notified
  if (onExperimentComplete) {
    onExperimentComplete({
      targetId,
      autoStopped: true,
      stopReason: reason,
      researchState: { ...research },
    });
  }
}

// ── OpenViking auto-ingest ───────────────────────────────

async function ingestExperiment(targetId, experiment, logPath) {
  if (!ovClientRef || !logPath) return;
  try {
    const research = activeResearch.get(targetId);
    const expNum = research ? research.experimentCount : '?';
    await ovClientRef.addResource(logPath, {
      scope: 'resources',
      reason: `AutoResearch exp #${expNum}: ${experiment.status} on ${targetId} (${experiment.metricName}=${experiment.metricValue.toFixed(3)}) — ${experiment.description}`,
      tags: ['autoresearch', targetId, experiment.status, experiment.metricName],
    });
  } catch (err) {
    console.log('[ResearchEngine] OV ingest failed:', err.message);
  }
}

// ── Helpers ──────────────────────────────────────────────

function emitStatus(targetId, state) {
  if (onStatusChanged) {
    onStatusChanged({ targetId, ...state });
  }
}

module.exports = {
  init,
  onExperiment,
  onStatus,
  startResearch,
  stopResearch,
  pauseResearch,
  autoStopResearch,
  getStatus,
  getAllStatus,
  processOutput,
  isResearchSession,
  DEFAULTS,
};
