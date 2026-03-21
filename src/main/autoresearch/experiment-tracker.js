// ── Experiment Tracker — TSV + DB logging ────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');

const RESEARCH_DIR = path.join(os.homedir(), '.omniclaw', 'autoresearch');

/**
 * Initialize tracker for a target. Creates the results directory and TSV file.
 */
function initTarget(targetId) {
  const dir = getTargetDir(targetId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tsvPath = getTsvPath(targetId);
  if (!fs.existsSync(tsvPath)) {
    fs.writeFileSync(tsvPath, 'commit\tmetric_value\tmetric_name\tstatus\tdescription\ttimestamp\n');
  }
  return { dir, tsvPath };
}

/**
 * Append an experiment result to the TSV log.
 */
function appendTsv(targetId, experiment) {
  initTarget(targetId);
  const line = [
    experiment.commitHash || 'n/a',
    experiment.metricValue?.toFixed(6) ?? '0.000000',
    experiment.metricName || 'quality',
    experiment.status || 'discard',
    (experiment.description || '').replace(/\t/g, ' ').replace(/\n/g, ' '),
    new Date().toISOString(),
  ].join('\t') + '\n';

  fs.appendFileSync(getTsvPath(targetId), line);
}

/**
 * Read all experiments from TSV for a target.
 */
function readTsv(targetId) {
  const tsvPath = getTsvPath(targetId);
  if (!fs.existsSync(tsvPath)) return [];

  const lines = fs.readFileSync(tsvPath, 'utf-8').trim().split('\n');
  if (lines.length <= 1) return []; // header only

  return lines.slice(1).map(line => {
    const [commit, metricValue, metricName, status, description, timestamp] = line.split('\t');
    return {
      commitHash: commit,
      metricValue: parseFloat(metricValue),
      metricName,
      status,
      description,
      timestamp,
    };
  });
}

/**
 * Write an experiment summary markdown file for OpenViking ingestion.
 */
function writeExperimentLog(targetId, experiment) {
  const dir = getTargetDir(targetId);
  const logPath = path.join(dir, `exp-${Date.now()}.md`);

  const content = [
    `# AutoResearch Experiment`,
    ``,
    `**Target:** ${targetId}`,
    `**Status:** ${experiment.status}`,
    `**Metric:** ${experiment.metricName} = ${experiment.metricValue}`,
    `**Commit:** ${experiment.commitHash || 'n/a'}`,
    `**Time:** ${new Date().toISOString()}`,
    ``,
    `## Description`,
    experiment.description || 'No description',
    ``,
    experiment.diffSummary ? `## Diff\n\`\`\`\n${experiment.diffSummary}\n\`\`\`` : '',
  ].filter(Boolean).join('\n');

  fs.writeFileSync(logPath, content);
  return logPath;
}

/**
 * Get experiment statistics for a target.
 */
function getStats(targetId) {
  const experiments = readTsv(targetId);
  if (experiments.length === 0) return { total: 0, kept: 0, discarded: 0, crashed: 0, bestValue: null };

  const kept = experiments.filter(e => e.status === 'keep');
  const discarded = experiments.filter(e => e.status === 'discard');
  const crashed = experiments.filter(e => e.status === 'crash');
  const bestValue = kept.length > 0
    ? Math.max(...kept.map(e => e.metricValue))
    : null;

  return {
    total: experiments.length,
    kept: kept.length,
    discarded: discarded.length,
    crashed: crashed.length,
    bestValue,
    lastExperiment: experiments[experiments.length - 1],
  };
}

// ── Helpers ──────────────────────────────────────────────

function getTargetDir(targetId) {
  const safeName = targetId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(RESEARCH_DIR, safeName);
}

function getTsvPath(targetId) {
  return path.join(getTargetDir(targetId), 'results.tsv');
}

module.exports = { initTarget, appendTsv, readTsv, writeExperimentLog, getStats };
