// ── IPC: hermes namespace ─────────────────────────────────
// Bridges OmniClaw to a local Hermes Agent gateway (http://localhost:8642).
//
// Exposed as window.api.hermes.* in the preload bridge:
//   - hermes.health()                       — { ok, status, detailed? }
//   - hermes.capabilities()                 — server-reported capabilities object
//   - hermes.models()                       — array of model descriptors
//   - hermes.chat(prompt, opts)             — quick chat completion (uses HermesProvider session)
//   - hermes.delegate({ message, ... })     — async run via /v1/runs (streams events to renderer)
//   - hermes.stopRun(runId)                 — cancel a delegated run
//   - hermes.onRunEvent(callback)           — subscribe to live run events

const eventLog = require('../observability/event-log');
const metrics = require('../observability/metrics');

function register(ipcMain, _deps = {}) {
  const { providerRegistry } = require('../providers/provider-registry');
  const { BrowserWindow } = require('electron');

  function broadcastRunEvent(payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('hermes:runEvent', payload); } catch (_) {}
      }
    }
  }

  function getProvider() {
    const p = providerRegistry.getProvider('hermes');
    if (!p) throw new Error('Hermes provider not registered');
    return p;
  }

  // Health probe — direct, doesn't go through the provider
  ipcMain.handle('hermes:health', async () => {
    const http = require('http');
    const start = Date.now();
    return new Promise((resolve) => {
      const req = http.get('http://localhost:8642/health', { timeout: 3000 }, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          metrics.observe('hermes_health_ms', Date.now() - start);
          resolve({ ok: res.statusCode === 200, statusCode: res.statusCode, body });
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    });
  });

  ipcMain.handle('hermes:capabilities', async () => {
    try {
      const p = getProvider();
      const caps = await p._loadCapabilities();
      return { ok: true, capabilities: caps };
    } catch (e) {
      eventLog.warn('hermes', 'capabilities fetch failed', { error: e.message });
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('hermes:models', async () => {
    try { return { ok: true, models: await getProvider().models() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('hermes:chat', async (_event, prompt, opts = {}) => {
    const p = getProvider();
    const sessionId = opts.sessionId || `hermes-quick-${Date.now()}`;
    const start = Date.now();
    try {
      await p.createSession(sessionId, {
        model: opts.model || 'hermes-agent',
        systemPrompt: opts.systemPrompt,
        hermesSessionId: opts.hermesSessionId,
      });

      let full = '';
      for await (const chunk of p.sendMessage(sessionId, prompt, [])) {
        if (chunk.type === 'text') full += chunk.content;
        if (chunk.type === 'error') {
          eventLog.error('hermes', 'chat stream error', { error: chunk.content });
          return { ok: false, error: chunk.content };
        }
      }
      metrics.observe('hermes_chat_ms', Date.now() - start);
      metrics.incr('hermes_chat_total');
      return { ok: true, response: full };
    } catch (e) {
      eventLog.error('hermes', 'chat failed', { error: e.message });
      return { ok: false, error: e.message };
    } finally {
      try { p.destroy(sessionId); } catch (_) {}
    }
  });

  ipcMain.handle('hermes:delegate', async (_event, opts = {}) => {
    const p = getProvider();
    const start = Date.now();
    const delegationId = `hermes-deleg-${Date.now()}`;
    eventLog.info('hermes', 'delegate start', {
      delegationId,
      message: (opts.message || '').slice(0, 200),
      model: opts.model,
    });
    try {
      const result = await p.delegate({
        message: opts.message,
        model: opts.model || 'hermes-agent',
        sessionId: opts.sessionId,
        sessionKey: opts.sessionKey,
        timeoutMs: opts.timeoutMs || 600000,
        onEvent: (ev) => {
          broadcastRunEvent({ delegationId, ...ev });
        },
      });
      metrics.observe('hermes_delegate_ms', Date.now() - start);
      metrics.incr('hermes_delegate_total');
      eventLog.info('hermes', 'delegate complete', {
        delegationId, runId: result.runId, status: result.status, durationMs: Date.now() - start,
      });
      return { ok: true, ...result };
    } catch (e) {
      eventLog.error('hermes', 'delegate failed', { delegationId, error: e.message });
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('hermes:stopRun', async (_event, runId) => {
    try {
      const r = await getProvider().stopRun(runId);
      return { ok: r.ok, status: r.status };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { register };
