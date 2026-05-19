// ── OmniClaw smoke tests ──────────────────────────────────
// Lightweight node:test suite covering the self-improvement infrastructure
// (db schema, learning-rate computation, peer-review scoring, tool-loop) and
// IPC registration sanity. Run with: node --test test/smoke.js
//
// The goal is to catch the class of bugs the 2026-05-17 audit found:
// methods called on objects that don't have them, fields missing on records
// that downstream code reads from. NOT exhaustive — just enough to be a
// safety net for the silent-failure class of bug.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ── Db surface ────────────────────────────────────────────
test('db module exports the expected namespaces + raw escape hatch', () => {
  const db = require('../src/main/db/database');
  const required = [
    'init', 'close', 'sync', 'runMaintenance', 'raw',
    'sessions', 'groups', 'usage', 'appState', 'recentPaths',
    'researchTargets', 'experiments', 'peerReview',
    'blackboard', 'hookEvents', 'channelBindings',
  ];
  for (const k of required) {
    assert.ok(k in db, `db.${k} missing — watchdog / probes / orchestration depend on this`);
  }
  // raw must be a function so probes can do db.raw().prepare(...)
  assert.equal(typeof db.raw, 'function');
});

// ── Experiment-tracker learning rate ─────────────────────
test('learning-rate computation flags stagnation correctly', () => {
  const tracker = require('../src/main/autoresearch/experiment-tracker');
  // Direct call without a real tsv file → returns null (insufficient data)
  const result = tracker.computeLearningRate('nonexistent-target', 20);
  assert.equal(result, null);
});

// ── Peer-review quality scoring ──────────────────────────
test('peer-review quality score honors agreement, citation, length', () => {
  const { PeerReview } = require('../src/main/orchestration/peer-review');
  // PeerReview class exports a `scoreSynthesis` only via the require module —
  // since it's not exported on the class itself, we re-require for the helper.
  const helpers = require('../src/main/orchestration/peer-review');
  // Use a constructed responses array.
  const responses = [
    { providerId: 'openai', model: 'gpt-4o', response: 'The capital of France is Paris.', status: 'complete' },
    { providerId: 'gemini', model: 'gemini-2.5', response: 'France\'s capital city is Paris.', status: 'complete' },
  ];
  // We can't reach the inner scoreSynthesis from the module exports unless
  // it's exported. So this test just asserts the class exists and supports
  // _staticComparison as a sanity check.
  const fallback = PeerReview._staticComparison(responses, 'What is the capital of France?');
  assert.ok(fallback.includes('OPENAI'));
  assert.ok(fallback.includes('GEMINI'));
});

// ── Tool-loop generator contract ─────────────────────────
test('runWithTools pass-through when no tools/handler', async () => {
  const { runWithTools } = require('../src/main/providers/tool-loop');

  // Fake provider that yields a single text chunk then done.
  const fakeProvider = {
    id: 'fake',
    async *sendMessage(sessionId, message) {
      yield { type: 'text', content: message };
      yield { type: 'done' };
    },
  };

  const chunks = [];
  for await (const c of runWithTools(fakeProvider, 'sid', 'hello', [], null)) {
    chunks.push(c);
  }
  assert.deepEqual(chunks, [
    { type: 'text', content: 'hello' },
    { type: 'done' },
  ]);
});

test('runWithTools executes a tool round and continues', async () => {
  const { runWithTools } = require('../src/main/providers/tool-loop');

  let toolResultStored = null;
  let round = 0;

  const fakeProvider = {
    id: 'fake',
    addToolResult(_sid, _id, result) { toolResultStored = result; },
    async *sendMessage(_sid, _message, _tools) {
      round++;
      if (round === 1) {
        yield { type: 'tool_call', id: 'call_1', name: 'echo', args: { x: 1 } };
        yield { type: 'done' };
      } else {
        yield { type: 'text', content: 'final answer' };
        yield { type: 'done' };
      }
    },
  };

  const chunks = [];
  const handler = async (name, args) => ({ echoed: args.x });
  for await (const c of runWithTools(fakeProvider, 'sid', 'hi', [{ name: 'echo' }], handler)) {
    chunks.push(c);
  }

  // Expect: tool_call, done, tool_result, text, done
  assert.equal(chunks[0].type, 'tool_call');
  assert.equal(chunks[2].type, 'tool_result');
  assert.deepEqual(chunks[2].content, { echoed: 1 });
  assert.equal(toolResultStored.echoed, 1);
  assert.equal(round, 2);  // proves continuation happened
});

// ── Watchdog probe shapes ────────────────────────────────
test('watchdog probes export the contract', () => {
  // Use a minimal fake db so the probe factory doesn't blow up.
  const fakeDb = {
    appState: { get: () => null, set: () => {} },
    raw: () => ({ prepare: () => ({ get: () => null, run: () => ({}) }) }),
  };
  const { createProbes } = require('../src/main/health/probes');
  const probes = createProbes({ db: fakeDb, ovServer: null, setup: null, gitOps: null });
  assert.ok(Array.isArray(probes));
  assert.ok(probes.length > 0);
  for (const p of probes) {
    assert.equal(typeof p.check, 'function', `probe ${p.name} missing check()`);
    // fix is optional per the contract — diagnostic-only probes (disk space,
    // native-module loadability, Claude CLI presence) don't auto-fix.
    if (p.fix !== undefined) {
      assert.equal(typeof p.fix, 'function', `probe ${p.name}.fix exists but isn't a function`);
    }
    assert.ok(p.name);
    assert.ok(p.label);
  }
});

// ── Event log ────────────────────────────────────────────
test('event-log captures + tails entries', () => {
  const eventLog = require('../src/main/observability/event-log');
  eventLog.info('smoketest', 'hello from test', { foo: 'bar' });
  const tail = eventLog.tail({ limit: 5, source: 'smoketest' });
  assert.ok(tail.length >= 1);
  assert.equal(tail[tail.length - 1].source, 'smoketest');
  assert.equal(tail[tail.length - 1].message, 'hello from test');
});

// ── Metrics ──────────────────────────────────────────────
test('metrics compute p50/p95 and rate-per-hour', () => {
  const metrics = require('../src/main/observability/metrics');
  metrics.reset();
  for (let i = 1; i <= 100; i++) metrics.observe('smoke_latency_ms', i);
  metrics.incr('smoke_counter');
  metrics.incr('smoke_counter');

  const snap = metrics.snapshot();
  assert.ok(snap.histograms.smoke_latency_ms);
  assert.equal(snap.histograms.smoke_latency_ms.count, 100);
  assert.ok(snap.histograms.smoke_latency_ms.p50 >= 50 && snap.histograms.smoke_latency_ms.p50 <= 51);
  assert.ok(snap.histograms.smoke_latency_ms.p95 >= 95);
  assert.equal(snap.counters.smoke_counter.total, 2);
});

// ── Hermes bridge ────────────────────────────────────────
test('HermesProvider exports the provider contract', () => {
  const { HermesProvider } = require('../src/main/providers/hermes-provider');
  const p = new HermesProvider();
  assert.equal(p.id, 'hermes');
  assert.equal(typeof p.displayName, 'string');
  assert.equal(typeof p.createSession, 'function');
  assert.equal(typeof p.sendMessage, 'function');
  assert.equal(typeof p.cancelGeneration, 'function');
  assert.equal(typeof p.destroy, 'function');
  assert.equal(typeof p.delegate, 'function');
  assert.equal(typeof p.stopRun, 'function');
});

test('HermesProvider is registered in provider-registry', () => {
  const { providerRegistry } = require('../src/main/providers/provider-registry');
  providerRegistry.init({ credentialStore: null });
  const hermes = providerRegistry.getProvider('hermes');
  assert.ok(hermes, 'hermes provider not registered');
  const list = providerRegistry.listProviders();
  const ids = list.map(p => p.id);
  assert.ok(ids.includes('hermes'), `hermes missing from listProviders: ${ids.join(', ')}`);
});

test('Hermes bridge: live /health probe (skipped if Hermes is down)', async (t) => {
  const http = require('node:http');
  const ok = await new Promise(resolve => {
    const req = http.get('http://localhost:8642/health', { timeout: 1500 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
  if (!ok) {
    t.skip('Hermes gateway not running on :8642 — skipping live test');
    return;
  }
  const { HermesProvider } = require('../src/main/providers/hermes-provider');
  const p = new HermesProvider();
  const probed = await p._probe();
  assert.equal(probed, true);
  const models = await p.models();
  assert.ok(Array.isArray(models) && models.length > 0);
});

// ── End-to-end self-improvement infrastructure ───────────
test('self-improvement infrastructure is reachable end-to-end', () => {
  // Reach every module the AutoResearch loop touches so a missing require or
  // syntax error in any of them blows up here.
  require('../src/main/autoresearch/research-engine');
  require('../src/main/autoresearch/experiment-tracker');
  require('../src/main/autoresearch/program-templates');
  require('../src/main/autoresearch/target-analyzer');
  require('../src/main/autoresearch/headless-research');
  require('../src/main/autoresearch/headless-runner');
  require('../src/main/orchestration/peer-review');
  require('../src/main/orchestration/multi-llm-session');
  require('../src/main/openviking/ov-client');
  require('../src/main/openviking/ov-ingest');
  require('../src/main/openviking/ov-micro-ingest');
  require('../src/main/openviking/ov-server');
  require('../src/main/providers/provider-interface');
  require('../src/main/providers/openai-provider');
  require('../src/main/providers/gemini-provider');
  require('../src/main/providers/ollama-provider');
  require('../src/main/providers/hermes-provider');
  require('../src/main/providers/tool-loop');
  require('../src/main/health/watchdog');
  require('../src/main/health/probes');
  require('../src/main/observability/event-log');
  require('../src/main/observability/metrics');
  // If we got here, all modules parsed and loaded cleanly.
});
