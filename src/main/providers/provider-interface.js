// ── Provider Interface — Abstract base for all LLM providers ──

/**
 * All providers must implement this contract.
 * Claude uses PTY (native CLI), others use API streaming.
 */
class ProviderInterface {
  constructor() {
    if (new.target === ProviderInterface) {
      throw new Error('ProviderInterface is abstract — use a concrete provider');
    }
  }

  /** @returns {string} Unique provider ID (claude, openai, gemini, ollama) */
  get id() { throw new Error('Not implemented'); }

  /** @returns {string} Human-readable name */
  get displayName() { throw new Error('Not implemented'); }

  /** @returns {string} ANSI color code for terminal badge */
  get color() { return '\x1b[37m'; } // default white

  /** @returns {string} Hex color for UI elements */
  get uiColor() { return '#cccccc'; }

  /** @returns {boolean} Whether this provider is configured (has credentials) */
  isConfigured() { return false; }

  /**
   * List available models for this provider.
   * @returns {Promise<Array<{id: string, name: string, description?: string}>>}
   */
  async models() { return []; }

  /**
   * Create a new conversation session.
   * @param {string} sessionId - Unique session identifier
   * @param {object} opts - { model, systemPrompt, tools[], workspacePath }
   * @returns {Promise<void>}
   */
  async createSession(sessionId, opts) { throw new Error('Not implemented'); }

  /**
   * Send a message and stream the response.
   * @param {string} sessionId
   * @param {string} message - User message
   * @param {Array} tools - MCP tools in provider-native format
   * @returns {AsyncGenerator<{type: string, content: string}>} Yields chunks:
   *   { type: 'text', content: '...' }
   *   { type: 'tool_call', name: '...', args: {...} }
   *   { type: 'tool_result', content: '...' }
   *   { type: 'done' }
   *   { type: 'error', content: '...' }
   */
  async *sendMessage(sessionId, message, tools = []) { throw new Error('Not implemented'); }

  /**
   * Cancel an in-flight generation.
   * @param {string} sessionId
   */
  cancelGeneration(sessionId) {}

  /**
   * Destroy a session and free resources.
   * @param {string} sessionId
   */
  destroy(sessionId) {}
}

module.exports = { ProviderInterface };
