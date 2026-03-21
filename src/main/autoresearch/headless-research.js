// ── Headless Research — iteration loop using headless Claude CLI ────
// Manages the research experiment loop using `claude -p` (pipe mode)
// instead of PTY output parsing. Each iteration is a separate CLI call
// with accumulated context from prior experiments.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { runResearchIteration } = require('./headless-runner');
const experimentTracker = require('./experiment-tracker');

const RESEARCH_DIR = path.join(os.homedir(), '.omniclaw', 'autoresearch');

// Active headless research sessions
const activeHeadless = new Map();

/**
 * Run a headless research loop on a target.
 * @param {Object} config
 * @param {string} config.targetId
 * @param {Object} config.profile - Target profile from analyzer
 * @param {string} config.programPath - Path to generated program.md
 * @param {string} config.workspacePath - Working directory
 * @param {number} [config.maxExperiments=20] - Max experiments per loop
 * @param {number} [config.maxTurnsPerExperiment=50] - Max turns per iteration
 * @param {number} [config.maxConsecutiveDiscards=5]
 * @param {Function} [config.onExperiment] - Callback per experiment result
 * @param {Function} [config.onStatus] - Callback for status changes
 * @param {Function} [config.onEvent] - Callback for streaming JSON events
 * @param {Object} [config.dbRef] - Database reference for persistence
 * @param {Object} [config.ovClientRef] - OpenViking client for ingestion
 * @returns {Promise<HeadlessResearchResult>}
 */
async function runHeadlessResearch(config) {
  const {
    targetId,
    profile,
    programPath,
    workspacePath,
    maxExperiments = 20,
    maxTurnsPerExperiment = 50,
    maxConsecutiveDiscards = 5,
    onExperiment,
    onStatus,
    onEvent,
    dbRef,
    ovClientRef,
  } = config;

  // Prevent duplicate runs
  if (activeHeadless.has(targetId)) {
    return { success: false, error: 'Headless research already running for this target' };
  }

  // Read program.md content
  let programContent;
  try {
    programContent = fs.readFileSync(programPath, 'utf-8');
  } catch (err) {
    return { success: false, error: `Cannot read program.md: ${err.message}` };
  }

  const state = {
    targetId,
    status: 'running',
    experimentCount: 0,
    totalCost: 0,
    totalTurns: 0,
    bestMetricValue: null,
    bestMetricName: null,
    consecutiveDiscards: 0,
    experiments: [],
    startedAt: new Date().toISOString(),
    aborted: false,
  };
  activeHeadless.set(targetId, state);
  emitStatus(onStatus, targetId, state);

  // Update DB status
  if (dbRef) {
    try { dbRef.researchTargets.update(targetId, { status: 'running' }); } catch { /* ignore */ }
  }

  try {
    for (let i = 0; i < maxExperiments; i++) {
      if (state.aborted) {
        state.status = 'stopped';
        break;
      }

      // Build iteration prompt with accumulated context
      const iterationPrompt = buildIterationPrompt(programContent, state, i);

      console.log(`[HeadlessResearch] Iteration ${i + 1}/${maxExperiments} for ${targetId}`);
      emitStatus(onStatus, targetId, { ...state, currentIteration: i + 1 });

      let iterResult;
      try {
        iterResult = await runResearchIteration({
          prompt: iterationPrompt,
          cwd: workspacePath,
          maxTurns: maxTurnsPerExperiment,
          timeoutMs: 600000, // 10 min per iteration
          onEvent: (event) => {
            if (onEvent) onEvent({ targetId, iteration: i + 1, event });
          },
        });
      } catch (err) {
        console.error(`[HeadlessResearch] Iteration ${i + 1} failed:`, err.message);
        state.consecutiveDiscards++;
        if (state.consecutiveDiscards >= maxConsecutiveDiscards) {
          state.status = 'auto-stopped';
          state.stopReason = `${state.consecutiveDiscards} consecutive failures`;
          break;
        }
        continue;
      }

      // Accumulate costs
      state.totalCost += iterResult.cost || 0;
      state.totalTurns += iterResult.numTurns || 0;

      // Process each experiment result from the iteration
      if (iterResult.experiments.length === 0) {
        console.warn(`[HeadlessResearch] Iteration ${i + 1} produced no experiment results`);
        state.consecutiveDiscards++;
        if (state.consecutiveDiscards >= maxConsecutiveDiscards) {
          state.status = 'auto-stopped';
          state.stopReason = `${state.consecutiveDiscards} consecutive discards/no-results`;
          break;
        }
        continue;
      }

      for (const exp of iterResult.experiments) {
        state.experimentCount++;
        exp.targetId = targetId;
        exp.sessionId = `headless-${targetId}`;
        state.experiments.push(exp);

        // Track discards
        if (exp.status === 'discard' || exp.status === 'crash') {
          state.consecutiveDiscards++;
        } else {
          state.consecutiveDiscards = 0;
        }

        // Track best metric
        if (exp.status === 'keep') {
          if (state.bestMetricValue === null || exp.metricValue > state.bestMetricValue) {
            state.bestMetricValue = exp.metricValue;
            state.bestMetricName = exp.metricName;
            // Sync to DB
            if (dbRef) {
              try {
                dbRef.researchTargets.update(targetId, {
                  bestMetrics: JSON.stringify({ [exp.metricName]: exp.metricValue })
                });
              } catch { /* ignore */ }
            }
          }
        }

        // Log to TSV
        try { experimentTracker.appendTsv(targetId, exp); } catch (e) {
          console.error(`[HeadlessResearch] TSV write failed:`, e.message);
        }

        // Log to DB
        if (dbRef) {
          try { dbRef.experiments.record(exp); } catch (e) {
            console.error(`[HeadlessResearch] DB record failed:`, e.message);
          }
        }

        // Ingest to OV
        if (ovClientRef) {
          const logPath = experimentTracker.writeExperimentLog(targetId, exp);
          ingestToOV(ovClientRef, targetId, exp, logPath, state.experimentCount).catch((e) => {
            console.warn(`[HeadlessResearch] OV ingest failed:`, e.message);
          });
        }

        // Emit experiment event
        if (onExperiment) {
          onExperiment({
            targetId,
            experiment: exp,
            researchState: { ...state },
          });
        }
      }

      // Check consecutive discard limit
      if (state.consecutiveDiscards >= maxConsecutiveDiscards) {
        state.status = 'auto-stopped';
        state.stopReason = `${state.consecutiveDiscards} consecutive discards`;
        break;
      }
    }

    // Loop completed normally
    if (state.status === 'running') {
      state.status = state.experimentCount >= maxExperiments ? 'auto-stopped' : 'completed';
      if (state.experimentCount >= maxExperiments) {
        state.stopReason = `max experiments (${maxExperiments})`;
      }
    }
  } catch (err) {
    state.status = 'error';
    state.stopReason = err.message;
    console.error(`[HeadlessResearch] Loop error for ${targetId}:`, err.message);
  } finally {
    activeHeadless.delete(targetId);
    state.endedAt = new Date().toISOString();

    if (dbRef) {
      try {
        dbRef.researchTargets.update(targetId, {
          status: state.status === 'running' ? 'idle' : state.status,
          totalExperiments: state.experimentCount,
        });
      } catch { /* ignore */ }
    }

    emitStatus(onStatus, targetId, state);

    // Emit auto-stop event
    if (state.status === 'auto-stopped' && onExperiment) {
      onExperiment({
        targetId,
        autoStopped: true,
        stopReason: state.stopReason,
        researchState: state,
      });
    }
  }

  return {
    success: true,
    status: state.status,
    stopReason: state.stopReason || null,
    experimentCount: state.experimentCount,
    bestMetricValue: state.bestMetricValue,
    bestMetricName: state.bestMetricName,
    totalCost: state.totalCost,
    totalTurns: state.totalTurns,
    duration: state.endedAt ? (new Date(state.endedAt) - new Date(state.startedAt)) / 1000 : 0,
  };
}

/**
 * Abort a running headless research session.
 */
function abortHeadlessResearch(targetId) {
  const state = activeHeadless.get(targetId);
  if (!state) return { success: false, error: 'No active headless research for this target' };
  state.aborted = true;
  return { success: true };
}

/**
 * Check if headless research is active for a target.
 */
function isHeadlessActive(targetId) {
  return activeHeadless.has(targetId);
}

/**
 * Get all active headless research statuses.
 */
function getHeadlessStatus() {
  const result = {};
  for (const [targetId, state] of activeHeadless) {
    result[targetId] = { ...state };
  }
  return result;
}

// ── Internal helpers ─────────────────────────────────────────

function buildIterationPrompt(programContent, state, iteration) {
  const parts = [];

  // Include full program.md for first iteration, summary for subsequent
  if (iteration === 0) {
    parts.push(`Here are your research instructions:\n\n${programContent}`);
    parts.push(`\nStart by reading all editable files, establish a baseline understanding, then run your FIRST experiment.`);
  } else {
    // For subsequent iterations, include summary of past experiments
    parts.push(`You are continuing an autonomous research experiment loop.`);
    parts.push(`\nThis is iteration #${iteration + 1}. So far: ${state.experimentCount} experiments completed.`);

    if (state.bestMetricValue !== null) {
      parts.push(`Best metric so far: ${state.bestMetricName} = ${state.bestMetricValue.toFixed(4)}`);
    }

    // Include last 5 experiment summaries for context
    const recentExps = state.experiments.slice(-5);
    if (recentExps.length > 0) {
      parts.push(`\nRecent experiments:`);
      for (const exp of recentExps) {
        parts.push(`  - ${exp.status}: ${exp.metricName}=${exp.metricValue.toFixed(4)} — ${exp.description}`);
      }
    }

    parts.push(`\nRun your NEXT experiment. Try a different approach than previous attempts.`);
    parts.push(`Remember to output results in this format:`);
    parts.push(`---`);
    parts.push(`metric_name: <name>`);
    parts.push(`metric_value: <value>`);
    parts.push(`status: keep|discard`);
    parts.push(`description: <what you changed>`);
    parts.push(`---`);
  }

  return parts.join('\n');
}

function emitStatus(callback, targetId, state) {
  if (callback) {
    try { callback({ targetId, ...state }); } catch { /* ignore */ }
  }
}

async function ingestToOV(ovClient, targetId, experiment, logPath, expNum) {
  if (!ovClient || !logPath) return;
  await ovClient.addResource(logPath, {
    scope: 'resources',
    reason: `Headless research exp #${expNum}: ${experiment.status} on ${targetId} (${experiment.metricName}=${experiment.metricValue.toFixed(3)})`,
    tags: ['autoresearch', 'headless', targetId, experiment.status],
  });
}

module.exports = {
  runHeadlessResearch,
  abortHeadlessResearch,
  isHeadlessActive,
  getHeadlessStatus,
};
