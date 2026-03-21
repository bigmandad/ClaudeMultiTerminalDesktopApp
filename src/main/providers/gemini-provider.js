// ── Gemini Provider — Google AI models via API streaming ──

const { ProviderInterface } = require('./provider-interface');

class GeminiProvider extends ProviderInterface {
  constructor(credentialStore) {
    super();
    this._credentialStore = credentialStore;
    this._sessions = new Map();
    this._client = null;
  }

  get id() { return 'gemini'; }
  get displayName() { return 'Gemini (Google)'; }
  get color() { return '\x1b[34m'; } // blue
  get uiColor() { return '#4285f4'; }

  isConfigured() {
    if (this._credentialStore) {
      return !!this._credentialStore.getCredential('gemini', 'api_key');
    }
    return !!process.env.GOOGLE_API_KEY;
  }

  _getClient() {
    if (this._client) return this._client;
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      let apiKey = process.env.GOOGLE_API_KEY;
      if (this._credentialStore) {
        apiKey = this._credentialStore.getCredential('gemini', 'api_key') || apiKey;
      }
      if (!apiKey) throw new Error('No Google API key configured');
      this._client = new GoogleGenerativeAI(apiKey);
      return this._client;
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        throw new Error('@google/generative-ai not installed. Run: npm install @google/generative-ai');
      }
      throw e;
    }
  }

  async models() {
    return [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Most capable, thinking' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Fast, efficient' },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: 'Balanced speed/quality' },
    ];
  }

  async createSession(sessionId, opts = {}) {
    this._sessions.set(sessionId, {
      model: opts.model || 'gemini-2.5-flash',
      history: [],
      systemPrompt: opts.systemPrompt || '',
      abortController: null,
    });
  }

  async *sendMessage(sessionId, message, tools = []) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`No session: ${sessionId}`);

    const client = this._getClient();
    const abortController = new AbortController();
    session.abortController = abortController;

    try {
      const modelOpts = {};
      if (session.systemPrompt) {
        modelOpts.systemInstruction = session.systemPrompt;
      }

      // Add tools if available
      if (tools.length > 0) {
        modelOpts.tools = [{
          functionDeclarations: tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema || {},
          }))
        }];
      }

      const model = client.getGenerativeModel({ model: session.model, ...modelOpts });
      const chat = model.startChat({ history: session.history });

      const result = await chat.sendMessageStream(message, {
        signal: abortController.signal,
      });

      let fullContent = '';

      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          fullContent += text;
          yield { type: 'text', content: text };
        }

        // Check for function calls
        const candidates = chunk.candidates || [];
        for (const candidate of candidates) {
          const parts = candidate.content?.parts || [];
          for (const part of parts) {
            if (part.functionCall) {
              yield {
                type: 'tool_call',
                name: part.functionCall.name,
                args: part.functionCall.args || {},
              };
            }
          }
        }
      }

      // Update history
      session.history.push({ role: 'user', parts: [{ text: message }] });
      if (fullContent) {
        session.history.push({ role: 'model', parts: [{ text: fullContent }] });
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
}

module.exports = { GeminiProvider };
