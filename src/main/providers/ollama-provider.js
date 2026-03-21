// ── Ollama Provider — Local LLMs via HTTP API ──

const { ProviderInterface } = require('./provider-interface');
const http = require('http');

const OLLAMA_BASE = 'http://localhost:11434';

class OllamaProvider extends ProviderInterface {
  constructor() {
    super();
    this._sessions = new Map();
    this._available = null; // cached availability check
  }

  get id() { return 'ollama'; }
  get displayName() { return 'Ollama (Local)'; }
  get color() { return '\x1b[35m'; } // purple/magenta
  get uiColor() { return '#a07ab8'; }

  isConfigured() {
    // Ollama is "configured" if it's running locally — no API key needed
    return true; // We check availability lazily
  }

  /** Check if Ollama server is actually reachable */
  async _checkAvailable() {
    try {
      const res = await this._httpGet('/api/version');
      this._available = !!res.version;
      return this._available;
    } catch {
      this._available = false;
      return false;
    }
  }

  async models() {
    try {
      const res = await this._httpGet('/api/tags');
      return (res.models || []).map(m => ({
        id: m.name,
        name: m.name,
        description: `${(m.size / 1e9).toFixed(1)}GB — ${m.details?.family || 'unknown'}`,
      }));
    } catch (e) {
      console.warn('[Ollama] Cannot list models:', e.message);
      return [];
    }
  }

  async createSession(sessionId, opts = {}) {
    this._sessions.set(sessionId, {
      model: opts.model || 'llama3.2',
      messages: [],
      systemPrompt: opts.systemPrompt || '',
      abortController: null,
    });

    if (opts.systemPrompt) {
      this._sessions.get(sessionId).messages.push({
        role: 'system', content: opts.systemPrompt,
      });
    }
  }

  async *sendMessage(sessionId, message, tools = []) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`No session: ${sessionId}`);

    session.messages.push({ role: 'user', content: message });

    const abortController = new AbortController();
    session.abortController = abortController;

    try {
      const body = {
        model: session.model,
        messages: session.messages,
        stream: true,
      };

      // Add tools if available (Ollama supports OpenAI-compatible tool format)
      if (tools.length > 0) {
        body.tools = tools.map(t => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema || {} }
        }));
      }

      const chunks = await this._httpPostStream('/api/chat', body, abortController.signal);
      let fullContent = '';

      for await (const line of chunks) {
        if (!line.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }

        if (parsed.message?.content) {
          fullContent += parsed.message.content;
          yield { type: 'text', content: parsed.message.content };
        }

        // Handle tool calls
        if (parsed.message?.tool_calls) {
          for (const tc of parsed.message.tool_calls) {
            yield {
              type: 'tool_call',
              name: tc.function?.name,
              args: tc.function?.arguments || {},
            };
          }
        }

        if (parsed.done) break;
      }

      if (fullContent) {
        session.messages.push({ role: 'assistant', content: fullContent });
      }

      yield { type: 'done' };
    } catch (e) {
      if (e.name === 'AbortError') {
        yield { type: 'cancelled' };
      } else {
        yield { type: 'error', content: e.message };
      }
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

  // ── HTTP helpers ──

  _httpGet(urlPath) {
    return new Promise((resolve, reject) => {
      const req = http.get(`${OLLAMA_BASE}${urlPath}`, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Ollama not reachable')); });
    });
  }

  async *_httpPostStream(urlPath, body, signal) {
    const url = new URL(urlPath, OLLAMA_BASE);

    const response = await new Promise((resolve, reject) => {
      const postData = JSON.stringify(body);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 300000, // 5 min for generation
      };

      const req = http.request(options, resolve);
      req.on('error', reject);

      if (signal) {
        signal.addEventListener('abort', () => req.destroy(new Error('AbortError')));
      }

      req.write(postData);
      req.end();
    });

    let buffer = '';
    for await (const chunk of response) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line
      for (const line of lines) {
        yield line;
      }
    }
    if (buffer.trim()) yield buffer;
  }
}

module.exports = { OllamaProvider };
