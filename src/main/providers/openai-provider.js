// ── OpenAI Provider — GPT models via API streaming ──

const { ProviderInterface } = require('./provider-interface');

class OpenAIProvider extends ProviderInterface {
  constructor(credentialStore) {
    super();
    this._credentialStore = credentialStore;
    this._sessions = new Map(); // sessionId → { messages[], model, abortController }
    this._client = null;
  }

  get id() { return 'openai'; }
  get displayName() { return 'GPT (OpenAI)'; }
  get color() { return '\x1b[32m'; } // green
  get uiColor() { return '#74aa9c'; }

  isConfigured() {
    if (this._credentialStore) {
      return !!this._credentialStore.getCredential('openai', 'api_key');
    }
    return !!process.env.OPENAI_API_KEY;
  }

  _getClient() {
    if (this._client) return this._client;
    try {
      const OpenAI = require('openai');
      let apiKey = process.env.OPENAI_API_KEY;
      if (this._credentialStore) {
        apiKey = this._credentialStore.getCredential('openai', 'api_key') || apiKey;
      }
      if (!apiKey) throw new Error('No OpenAI API key configured');
      this._client = new OpenAI({ apiKey });
      return this._client;
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        throw new Error('openai package not installed. Run: npm install openai');
      }
      throw e;
    }
  }

  async models() {
    return [
      { id: 'gpt-4o', name: 'GPT-4o', description: 'Most capable, multimodal' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast, affordable' },
      { id: 'o3', name: 'o3', description: 'Advanced reasoning' },
      { id: 'o4-mini', name: 'o4-mini', description: 'Fast reasoning' },
    ];
  }

  async createSession(sessionId, opts = {}) {
    const messages = [];
    if (opts.systemPrompt) {
      messages.push({ role: 'system', content: opts.systemPrompt });
    }
    this._sessions.set(sessionId, {
      messages,
      model: opts.model || 'gpt-4o',
      abortController: null,
    });
  }

  async *sendMessage(sessionId, message, tools = []) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`No session: ${sessionId}`);

    const client = this._getClient();
    session.messages.push({ role: 'user', content: message });

    const abortController = new AbortController();
    session.abortController = abortController;

    try {
      const requestOpts = {
        model: session.model,
        messages: session.messages,
        stream: true,
      };

      // Add tools if available
      if (tools.length > 0) {
        requestOpts.tools = tools.map(t => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema || {} }
        }));
      }

      const stream = await client.chat.completions.create(requestOpts, {
        signal: abortController.signal,
      });

      let fullContent = '';
      const toolCalls = [];

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          fullContent += delta.content;
          yield { type: 'text', content: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = { id: tc.id, name: '', args: '' };
              }
              if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].args += tc.function.arguments;
            }
          }
        }
      }

      // Process any tool calls
      for (const tc of toolCalls) {
        if (!tc || !tc.name) continue;
        let args = {};
        try { args = JSON.parse(tc.args); } catch (e) { /* ignore */ }
        yield { type: 'tool_call', id: tc.id, name: tc.name, args };
      }

      // Store assistant message
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

  /**
   * Feed a tool result back into the conversation for continued generation.
   */
  addToolResult(sessionId, toolCallId, result) {
    const session = this._sessions.get(sessionId);
    if (!session) return;
    session.messages.push({ role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(result) });
  }

  cancelGeneration(sessionId) {
    const session = this._sessions.get(sessionId);
    if (session?.abortController) {
      session.abortController.abort();
    }
  }

  destroy(sessionId) {
    this.cancelGeneration(sessionId);
    this._sessions.delete(sessionId);
  }
}

module.exports = { OpenAIProvider };
