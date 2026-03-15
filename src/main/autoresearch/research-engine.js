// ── Research Engine — autonomous improvement loop orchestration ──

const fs = require('fs');
const path = require('path');
const os = require('os');
const targetAnalyzer = require('./target-analyzer');
const experimentTracker = require('./experiment-tracker');
const programTemplates = require('./program-templates');

const RESEARCH_DIR = path.join(os.homedir(), '.claude-sessions', 'autoresearch');

// Active research sessions: targetId -> { sessionId, status, experimentCount, ... }
const activeResearch = new Map();

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
      if (results?.result?.resources?.length > 0) {
        pastContext = results.result.resources
          .map(r => `- ${r.content?.slice(0, 200) || 'no content'}`)
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

  // Build the initial prompt that kicks off the research loop
  const initialPrompt = `Read the file ${programPath} for your research instructions, then begin the experiment loop. Start by reading all editable files listed in the program, establish a baseline understanding, then immediately begin your first experiment.`;

  // Track active research
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
  };
  activeResearch.set(targetId, researchState);

  emitStatus(targetId, researchState);

  return {
    success: true,
    sessionId,
    targetId,
    programPath,
    initialPrompt,
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
 * Process a PTY output line from a research session.
 * Detects experiment result markers and logs them.
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
    emitStatus(targetId, research);
  }

  // Detect experiment result block
  const metricMatch = data.match(/^metric_value:\s*([\d.]+)/m);
  const statusMatch = data.match(/^status:\s*(keep|discard|crash)/m);
  const nameMatch = data.match(/^metric_name:\s*(\S+)/m);
  const descMatch = data.match(/^description:\s*(.+)/m);

  if (metricMatch && statusMatch) {
    const experiment = {
      targetId,
      sessionId,
      commitHash: null,
      metricName: nameMatch?.[1] || 'quality',
      metricValue: parseFloat(metricMatch[1]),
      status: statusMatch[1],
      description: descMatch?.[1] || '',
      durationSeconds: null,
    };

    // Log to TSV
    experimentTracker.appendTsv(targetId, experiment);

    // Log to DB
    if (dbRef) {
      try { dbRef.experiments.record(experiment); } catch { /* ignore */ }
    }

    // Write experiment log for OV ingestion
    const logPath = experimentTracker.writeExperimentLog(targetId, experiment);

    // Auto-ingest to OpenViking
    if (ovClientRef) {
      ingestExperiment(targetId, experiment, logPath).catch(() => { /* ignore */ });
    }

    // Update research state
    research.experimentCount++;
    research.lastMetricValue = experiment.metricValue;
    if (experiment.status === 'keep') {
      if (!research.bestMetricValue || experiment.metricValue > research.bestMetricValue) {
        research.bestMetricValue = experiment.metricValue;
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
  }
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

// ── OpenViking auto-ingest ───────────────────────────────

async function ingestExperiment(targetId, experiment, logPath) {
  if (!ovClientRef || !logPath) return;
  try {
    await ovClientRef.addResource(logPath, {
      scope: 'resources',
      reason: `AutoResearch: ${experiment.status} on ${targetId} — ${experiment.description}`,
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
  getStatus,
  getAllStatus,
  processOutput,
  isResearchSession,
};
