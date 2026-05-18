// ── Metrics ring buffer ─────────────────────────────────
// Lightweight in-memory time series. Subsystems push samples via:
//   metrics.observe('ov_seed_duration_ms', 47);   // latency-style histogram
//   metrics.incr('watchdog_fixes_total');         // monotonic counter
// And query via:
//   metrics.snapshot()  → { histograms: {...p50/p95/p99...}, counters: {...} }
//
// The renderer reads snapshots through window.api.metrics.snapshot to drive
// sparklines or "is this thing actually making progress" liveness panels.
//
// Memory is bounded: each histogram keeps the last SAMPLES_PER_METRIC samples
// (default 1000) and the last RATE_WINDOW_MS=1h rate samples.

const SAMPLES_PER_METRIC = 1000;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// metric name → { samples: [{ts, value}], }
const histograms = new Map();

// metric name → { total: <bigint-friendly number>, samples: [{ts, value}] }
const counters = new Map();

/**
 * Record a numeric observation (latency, size, duration). Used to compute
 * p50/p95/p99 over the recent window.
 */
function observe(name, value) {
  if (typeof value !== 'number' || isNaN(value)) return;
  const now = Date.now();
  let h = histograms.get(name);
  if (!h) {
    h = { samples: [] };
    histograms.set(name, h);
  }
  h.samples.push({ ts: now, value });
  if (h.samples.length > SAMPLES_PER_METRIC) h.samples.shift();
}

/**
 * Increment a monotonic counter. Tracks rate-per-hour using the timestamped
 * sample list (samples older than RATE_WINDOW_MS are dropped on each call).
 */
function incr(name, delta = 1) {
  const now = Date.now();
  let c = counters.get(name);
  if (!c) {
    c = { total: 0, samples: [] };
    counters.set(name, c);
  }
  c.total += delta;
  c.samples.push({ ts: now, delta });
  // Trim samples older than the rate window
  const cutoff = now - RATE_WINDOW_MS;
  while (c.samples.length && c.samples[0].ts < cutoff) c.samples.shift();
}

function _percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * @returns {{histograms: Object, counters: Object, generatedAt: string}}
 */
function snapshot() {
  const hOut = {};
  for (const [name, h] of histograms) {
    if (h.samples.length === 0) continue;
    const values = h.samples.map(s => s.value).slice().sort((a, b) => a - b);
    const total = values.reduce((a, b) => a + b, 0);
    hOut[name] = {
      count: values.length,
      min: values[0],
      max: values[values.length - 1],
      avg: total / values.length,
      p50: _percentile(values, 50),
      p95: _percentile(values, 95),
      p99: _percentile(values, 99),
    };
  }

  const cOut = {};
  for (const [name, c] of counters) {
    const ratePerHour = c.samples.reduce((sum, s) => sum + (s.delta || 1), 0);
    cOut[name] = {
      total: c.total,
      ratePerHour,
    };
  }

  return { histograms: hOut, counters: cOut, generatedAt: new Date().toISOString() };
}

/** Reset everything (mostly for tests). */
function reset() {
  histograms.clear();
  counters.clear();
}

module.exports = { observe, incr, snapshot, reset };
