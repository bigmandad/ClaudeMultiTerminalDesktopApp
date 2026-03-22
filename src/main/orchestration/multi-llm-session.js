// ── Multi-LLM Session — Fans out prompts to multiple providers in parallel ──

const { providerRegistry } = require('../providers/provider-registry');
const { ApiPtyEmitter } = require('../providers/api-pty-emitter');

class MultiLlmSession {
  /**
   * @param {string} sessionId - Parent session ID
   * @param {Array<{providerId: string, model: string}>} providerConfigs
   * @param {Electron.WebContents} webContents
   */
  constructor(sessionId, providerConfigs, webContents) {
    this.sessionId = sessionId;
    this.providerConfigs = providerConfigs;
    this.webContents = webContents;
    this.subSessions = new Map(); // providerId → { sessionId, model, emitter, status, response }
    this.allResponses = []; // Collected after all complete
    this._initSubSessions();
  }

  _initSubSessions() {
    for (const config of this.providerConfigs) {
      // Use providerId:model as key to support multiple models from same provider (e.g. ollama)
      const key = `${config.providerId}:${config.model}`;
      const subId = `${this.sessionId}__${config.providerId}__${config.model}`;
      const emitter = new ApiPtyEmitter(this.webContents, subId, config.providerId);
      this.subSessions.set(key, {
        sessionId: subId,
        providerId: config.providerId,
        model: config.model,
        emitter,
        status: 'idle',
        response: '',
      });
    }
  }

  /**
   * Send a prompt to all providers simultaneously.
   * @param {string} message
   * @param {object} opts - { systemPrompt?, tools?, onToolCall? }
   * @returns {Promise<Array<{providerId, model, response, status, duration}>>}
   */
  async sendToAll(message, opts = {}) {
    const startTime = Date.now();
    const promises = [];

    for (const [key, sub] of this.subSessions) {
      const provider = providerRegistry.getProvider(sub.providerId);
      if (!provider) {
        sub.status = 'error';
        sub.response = `Provider ${sub.providerId} not available`;
        continue;
      }

      sub.status = 'streaming';

      const promise = (async () => {
        const t0 = Date.now();
        try {
          // Create session if needed
          await provider.createSession(sub.sessionId, {
            model: sub.model,
            systemPrompt: opts.systemPrompt,
          });

          // Stream response
          const generator = provider.sendMessage(sub.sessionId, message, opts.tools || []);
          sub.emitter.writeHeader(`${provider.displayName} — ${sub.model}`);

          let fullResponse = '';
          for await (const chunk of generator) {
            switch (chunk.type) {
              case 'text':
                fullResponse += chunk.content;
                sub.emitter.writeChunk(chunk.content);
                break;
              case 'tool_call':
                sub.emitter.writeToolCall(chunk.name, chunk.args);
                if (opts.onToolCall) {
                  try {
                    const result = await opts.onToolCall(chunk.name, chunk.args);
                    sub.emitter.writeToolResult(result);
                  } catch (e) {
                    sub.emitter.writeError(`Tool failed: ${e.message}`);
                  }
                }
                break;
              case 'error':
                sub.emitter.writeError(chunk.content);
                break;
              case 'done':
              case 'delegated':
                break;
            }
          }

          sub.emitter.writeDone();
          sub.response = fullResponse;
          sub.status = 'complete';
          sub.duration = Date.now() - t0;
        } catch (e) {
          sub.emitter.writeError(e.message);
          sub.status = 'error';
          sub.response = e.message;
          sub.duration = Date.now() - t0;
        }

        return {
          providerId: sub.providerId,
          model: sub.model,
          response: sub.response,
          status: sub.status,
          duration: sub.duration,
        };
      })();

      promises.push(promise);
    }

    this.allResponses = await Promise.allSettled(promises);
    return this.allResponses.map(r => r.status === 'fulfilled' ? r.value : {
      providerId: 'unknown', model: '', response: r.reason?.message || 'Failed',
      status: 'error', duration: 0,
    });
  }

  /**
   * Get collected responses for peer review.
   */
  getResponses() {
    return [...this.subSessions.entries()].map(([key, sub]) => ({
      providerId: sub.providerId,
      model: sub.model,
      response: sub.response,
      status: sub.status,
      duration: sub.duration || 0,
    }));
  }

  /**
   * Get sub-session IDs for the renderer to create sub-panes.
   */
  getSubSessionIds() {
    return [...this.subSessions.entries()].map(([key, sub]) => ({
      providerId: sub.providerId,
      sessionId: sub.sessionId,
      model: sub.model,
      color: providerRegistry.getProvider(sub.providerId)?.uiColor || '#ccc',
    }));
  }

  /**
   * Cancel all in-flight generations.
   */
  cancelAll() {
    for (const [key, sub] of this.subSessions) {
      const provider = providerRegistry.getProvider(sub.providerId);
      if (provider) provider.cancelGeneration(sub.sessionId);
      sub.status = 'cancelled';
    }
  }

  /**
   * Destroy all sub-sessions.
   */
  destroy() {
    for (const [key, sub] of this.subSessions) {
      const provider = providerRegistry.getProvider(sub.providerId);
      if (provider) provider.destroy(sub.sessionId);
    }
    this.subSessions.clear();
  }
}

// Active multi-LLM sessions
const activeSessions = new Map();

module.exports = { MultiLlmSession, activeSessions };
