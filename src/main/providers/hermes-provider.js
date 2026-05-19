// ── Hermes Provider — bridge to a local Hermes agent ──────
//
// Hermes (https://github.com/NousResearch/hermes-agent) runs a gateway with
// an OpenAI-compatible API server. We use it as a first-class provider so
// OmniClaw can:
//   1. Delegate chat completions to Hermes (auth-free on localhost)
//   2. Delegate longer-running work to /v1/runs (async, SSE event stream)
//   3. Preserve cross-message session continuity via X-Hermes-Session-Id
//
// Hermes auth/capabilities are discovered from /v1/capabilities on first use.

const http = require('http');
const { ProviderInterface } = require('./provider-interface');

const DEFAULT_BASE = 'http://localhost:8642';

class HermesProvider extends ProviderInterface {
  constructor(opts = {}) {
    super();
    this._base = opts.base || process.env.HERMES_BASE_URL || DEFAULT_BASE;
    this._sessions = new Map(); // sessionId → { messages, model, abortController, hermesSessionId }
    this._capabilities = null;
    this._capabilitiesPromise = null;
  }

  get id() { return 'hermes'; }
  get displayName() { return 'Hermes (Local Agent)'; }
  get color() { return '\x1b[38;5;220m'; } // gold
  get uiColor() { return '#ffd700'; }

  /**
   * Hermes is "configured" when the gateway responds on /health. Cheap probe.
   * Cached for ~10s to avoid hammering on every isConfigured() call.
   */
  isConfigured() {
    const now = Date.now();
    if (this._configCheckAt && (now - this._configCheckAt) < 10000) {
      return !!this._isConfigured;
    }
    this._configCheckAt = now;
    // Synchronous best-effort: kick off a probe and return the previous answer.
    // The first call returns false; subsequent calls reflect reality.
    this._probe().then(ok => { this._isConfigured = ok; }).catch(() => { this._isConfigured = false; });
    return !!this._isConfigured;
  }

  async _probe() {
    try {
      const res = await this._fetch('/health', { method: 'GET', timeoutMs: 2000 });
      return res.statusCode === 200;
    } catch { return false; }
  }

  async _loadCapabilities() {
    if (this._capabilities) return this._capabilities;
    if (this._capabilitiesPromise) return this._capabilitiesPromise;
    this._capabilitiesPromise = (async () => {
      try {
        const res = await this._fetch('/v1/capabilities', { method: 'GET', timeoutMs: 3000 });
        if (res.statusCode === 200) {
          this._capabilities = JSON.parse(res.body);
        }
      } catch (_) { /* leave null; cap-dependent code falls back */ }
      return this._capabilities;
    })();
    return this._capabilitiesPromise;
  }

  async models() {
    try {
      const res = await this._fetch('/v1/models', { method: 'GET', timeoutMs: 3000 });
      if (res.statusCode !== 200) return [{ id: 'hermes-agent', name: 'Hermes Agent', description: 'Hermes gateway (degraded probe)' }];
      const data = JSON.parse(res.body);
      const arr = Array.isArray(data.data) ? data.data : [];
      return arr.map(m => ({
        id: m.id,
        name: m.id,
        description: `Hermes ${m.owned_by ? `· ${m.owned_by}` : ''}`.trim(),
      }));
    } catch (e) {
      return [{ id: 'hermes-agent', name: 'Hermes Agent', description: `Unreachable: ${e.message}` }];
    }
  }

  async createSession(sessionId, opts = {}) {
    const messages = [];
    if (opts.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt });
    // X-Hermes-Session-Id triggers Hermes's "session continuation" feature
    // which requires the gateway to be running with API_SERVER_KEY set. We
    // already track history client-side in `messages`, so the header is
    // opt-in only — caller passes `hermesSessionId` explicitly to use it.
    this._sessions.set(sessionId, {
      messages,
      model: opts.model || 'hermes-agent',
      abortController: null,
      hermesSessionId: opts.hermesSessionId || null,
      systemPrompt: opts.systemPrompt || '',
    });
  }

  async *sendMessage(sessionId, message, tools = []) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`No session: ${sessionId}`);

    session.messages.push({ role: 'user', content: message });

    const abortController = new AbortController();
    session.abortController = abortController;

    try {
      const body = {
        model: session.model || 'hermes-agent',
        messages: session.messages,
        stream: true,
      };
      // Hermes executes tools server-side; passing OmniClaw's MCP tools would
      // confuse the agent (it has its own tool registry). Intentionally ignore
      // the `tools` argument here. If a future user wants to constrain Hermes
      // to a specific toolset, they can set it via Hermes's own config.

      const headers = {
        'Content-Type': 'application/json',
      };
      // Only attach the session header when the caller explicitly opted in.
      // Hermes rejects requests with X-Hermes-Session-Id unless API_SERVER_KEY
      // is configured on the gateway (HTTP 403, "Session continuation requires
      // API key authentication"). For stateless chat we don't need it.
      if (session.hermesSessionId) {
        headers['X-Hermes-Session-Id'] = session.hermesSessionId;
      }

      const generator = this._streamCompletions('/v1/chat/completions', body, headers, abortController.signal);

      let fullContent = '';
      for await (const chunk of generator) {
        if (chunk.type === 'text') fullContent += chunk.content;
        yield chunk;
      }

      if (fullContent) {
        session.messages.push({ role: 'assistant', content: fullContent });
      }

      yield { type: 'done' };
    } catch (e) {
      if (e.name === 'AbortError') yield { type: 'cancelled' };
      else yield { type: 'error', content: e.message };
    } finally {
      session.abortController = null;
    }
  }

  cancelGeneration(sessionId) {
    const session = this._sessions.get(sessionId);
    if (session?.abortController) session.abortController.abort();
  }

  destroy(sessionId) {
    this.cancelGeneration(sessionId);
    this._sessions.delete(sessionId);
  }

  // ── Async task delegation (Hermes /v1/runs) ────────────
  // Use this instead of sendMessage for tasks that may take minutes or hours.
  // Returns { runId, status, result, events } once the run reaches a terminal state.
  // The caller can also pass an onEvent callback to stream events live.
  /**
   * @param {Object} opts
   * @param {string} opts.message       - User instruction for Hermes
   * @param {string} [opts.model]       - default 'hermes-agent'
   * @param {string} [opts.sessionKey]  - X-Hermes-Session-Key (long-term memory scope)
   * @param {string} [opts.sessionId]   - X-Hermes-Session-Id (short-term continuity)
   * @param {Function} [opts.onEvent]   - (event) => void for SSE stream
   * @param {number}  [opts.timeoutMs=300000] - hard cap
   * @returns {Promise<{runId, status, result, events}>}
   */
  async delegate(opts = {}) {
    const message = opts.message || '';
    if (!message) throw new Error('hermes.delegate: message required');
    const model = opts.model || 'hermes-agent';
    const headers = { 'Content-Type': 'application/json' };
    // Session headers require API_SERVER_KEY auth on the Hermes side; only
    // attach when the caller explicitly passes them so the default path works
    // out of the box on a vanilla Hermes install.
    if (opts.sessionId)  headers['X-Hermes-Session-Id']  = opts.sessionId;
    if (opts.sessionKey) headers['X-Hermes-Session-Key'] = opts.sessionKey;

    // 1. Submit the run
    const submit = await this._fetch('/v1/runs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: message }),
      timeoutMs: 10000,
    });
    if (submit.statusCode !== 202 && submit.statusCode !== 200) {
      throw new Error(`Hermes /v1/runs returned HTTP ${submit.statusCode}: ${submit.body.slice(0, 200)}`);
    }
    const submitData = JSON.parse(submit.body);
    const runId = submitData.run_id || submitData.id;
    if (!runId) throw new Error(`Hermes /v1/runs did not return a run_id: ${submit.body.slice(0, 200)}`);

    // 2. Stream events if requested, else poll
    const collectedEvents = [];
    const deadline = Date.now() + (opts.timeoutMs || 300000);

    if (typeof opts.onEvent === 'function') {
      await this._streamRunEvents(runId, deadline, (ev) => {
        collectedEvents.push(ev);
        try { opts.onEvent(ev); } catch (_) {}
      });
    } else {
      // Polling fallback
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        const st = await this._fetch(`/v1/runs/${encodeURIComponent(runId)}`, { method: 'GET', timeoutMs: 5000 });
        if (st.statusCode === 200) {
          const data = JSON.parse(st.body);
          const status = data.status || data.state;
          if (['completed', 'failed', 'cancelled', 'error', 'succeeded'].includes(status)) {
            return { runId, status, result: data.result || data.output || data, events: collectedEvents };
          }
        }
      }
      throw new Error(`Hermes run ${runId} did not finish within ${opts.timeoutMs || 300000}ms`);
    }

    // 3. Final status fetch after event stream completes
    const finalSt = await this._fetch(`/v1/runs/${encodeURIComponent(runId)}`, { method: 'GET', timeoutMs: 5000 });
    let finalData = {};
    try { finalData = JSON.parse(finalSt.body); } catch (_) {}
    return {
      runId,
      status: finalData.status || finalData.state || 'unknown',
      result: finalData.result || finalData.output || finalData,
      events: collectedEvents,
    };
  }

  /** Cancel a delegated run by run_id. */
  async stopRun(runId) {
    const res = await this._fetch(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
      method: 'POST', timeoutMs: 5000,
    });
    return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode };
  }

  // ── HTTP helpers ──────────────────────────────────────

  _fetch(path, opts = {}) {
    const url = new URL(path, this._base);
    return new Promise((resolve, reject) => {
      const reqOpts = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + (url.search || ''),
        method: opts.method || 'GET',
        headers: opts.headers || {},
        timeout: opts.timeoutMs || 30000,
      };
      const req = http.request(reqOpts, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error(`Hermes request timeout (${opts.timeoutMs || 30000}ms): ${path}`)); });
      if (opts.signal) opts.signal.addEventListener('abort', () => req.destroy(new Error('AbortError')));
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  async *_streamCompletions(path, body, headers, signal) {
    const url = new URL(path, this._base);
    const response = await new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const opts = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
        timeout: 300000,
      };
      const req = http.request(opts, resolve);
      req.on('error', reject);
      if (signal) signal.addEventListener('abort', () => req.destroy(new Error('AbortError')));
      req.write(payload);
      req.end();
    });

    if (response.statusCode !== 200) {
      const errBody = await new Promise(r => {
        let s = '';
        response.on('data', c => s += c);
        response.on('end', () => r(s));
      });
      yield { type: 'error', content: `Hermes HTTP ${response.statusCode}: ${errBody.slice(0, 300)}` };
      return;
    }

    // Parse SSE: "data: {json}\n\n"
    let buffer = '';
    for await (const chunk of response) {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = event.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) yield { type: 'text', content: delta.content };
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name) {
                  let args = {};
                  try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
                  yield { type: 'tool_call', id: tc.id, name: tc.function.name, args };
                }
              }
            }
          } catch (_) { /* skip malformed chunks */ }
        }
      }
    }
  }

  async _streamRunEvents(runId, deadline, onEvent) {
    const url = new URL(`/v1/runs/${encodeURIComponent(runId)}/events`, this._base);
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'GET',
        headers: { 'Accept': 'text/event-stream' },
        timeout: Math.max(5000, deadline - Date.now()),
      };
      const req = http.request(opts, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Hermes /v1/runs/.../events returned HTTP ${res.statusCode}`));
        }
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const event = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const lines = event.split('\n');
            let eventType = 'message';
            let dataLine = '';
            for (const line of lines) {
              if (line.startsWith('event:')) eventType = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLine = line.slice(5).trim();
            }
            if (dataLine) {
              try {
                const data = JSON.parse(dataLine);
                onEvent({ event: eventType, data });
              } catch (_) {
                onEvent({ event: eventType, data: dataLine });
              }
            }
          }
        });
        res.on('end', () => resolve());
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }
}

module.exports = { HermesProvider };
