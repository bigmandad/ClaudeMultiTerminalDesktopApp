// ── API-to-PTY Emitter — Formats API streaming as ANSI terminal output ──
//
// Takes streamed text chunks from API providers and formats them
// with ANSI color codes so xterm.js renders them naturally.
// Emits data through the same pty:data IPC channel the renderer listens on.

const PROVIDER_COLORS = {
  openai:  { badge: '\x1b[48;5;29m\x1b[97m', text: '\x1b[38;5;114m', reset: '\x1b[0m' },
  gemini:  { badge: '\x1b[48;5;27m\x1b[97m', text: '\x1b[38;5;75m',  reset: '\x1b[0m' },
  ollama:  { badge: '\x1b[48;5;91m\x1b[97m', text: '\x1b[38;5;177m', reset: '\x1b[0m' },
  claude:  { badge: '\x1b[48;5;172m\x1b[97m', text: '\x1b[38;5;215m', reset: '\x1b[0m' },
};

class ApiPtyEmitter {
  /**
   * @param {Electron.WebContents} webContents - The renderer to emit to
   * @param {string} sessionId - Session identifier for pty:data events
   * @param {string} providerId - Provider ID for color coding
   */
  constructor(webContents, sessionId, providerId) {
    this._webContents = webContents;
    this._sessionId = sessionId;
    this._providerId = providerId;
    this._colors = PROVIDER_COLORS[providerId] || PROVIDER_COLORS.claude;
    this._started = false;
  }

  /** Emit raw data as if it came from a PTY */
  _emit(data) {
    if (this._webContents && !this._webContents.isDestroyed()) {
      this._webContents.send('pty:data', { id: this._sessionId, data });
    }
  }

  /** Write the provider badge header at the start of a response */
  writeHeader(modelName) {
    const { badge, reset } = this._colors;
    this._emit(`\r\n${badge} ${modelName} ${reset}\r\n\r\n`);
    this._started = true;
  }

  /** Write a text chunk (streamed content) */
  writeChunk(text) {
    if (!this._started) this._started = true;
    // Convert newlines to \r\n for terminal
    const formatted = text.replace(/\n/g, '\r\n');
    this._emit(`${this._colors.text}${formatted}${this._colors.reset}`);
  }

  /** Write a tool call notification */
  writeToolCall(toolName, args) {
    const argsStr = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
    this._emit(`\r\n\x1b[33m⚡ Tool: ${toolName}\x1b[0m\r\n`);
    if (argsStr && argsStr !== '{}') {
      this._emit(`\x1b[90m${argsStr.replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
    }
  }

  /** Write a tool result */
  writeToolResult(result) {
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    const truncated = text.length > 500 ? text.slice(0, 500) + '...' : text;
    this._emit(`\x1b[90m→ ${truncated.replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
  }

  /** Write an error message */
  writeError(message) {
    this._emit(`\r\n\x1b[31m✗ Error: ${message}\x1b[0m\r\n`);
  }

  /** Write completion indicator */
  writeDone() {
    this._emit(`\r\n\x1b[90m─── response complete ───\x1b[0m\r\n\r\n`);
  }

  /** Write a status message */
  writeStatus(message) {
    this._emit(`\x1b[90m${message}\x1b[0m\r\n`);
  }

  /**
   * Stream a full provider response through this emitter.
   * @param {AsyncGenerator} generator - From provider.sendMessage()
   * @param {string} modelName - Display name for the header
   * @param {Function} onToolCall - Optional callback for tool execution
   */
  async streamResponse(generator, modelName, onToolCall) {
    this.writeHeader(modelName);

    for await (const chunk of generator) {
      switch (chunk.type) {
        case 'text':
          this.writeChunk(chunk.content);
          break;

        case 'tool_call':
          this.writeToolCall(chunk.name, chunk.args);
          if (onToolCall) {
            try {
              const result = await onToolCall(chunk.name, chunk.args);
              this.writeToolResult(result);
            } catch (e) {
              this.writeError(`Tool ${chunk.name} failed: ${e.message}`);
            }
          }
          break;

        case 'error':
          this.writeError(chunk.content);
          break;

        case 'cancelled':
          this.writeStatus('Generation cancelled');
          break;

        case 'done':
        case 'delegated':
          break;
      }
    }

    this.writeDone();
  }
}

module.exports = { ApiPtyEmitter, PROVIDER_COLORS };
