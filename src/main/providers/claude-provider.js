// ── Claude Provider — PTY-based adapter wrapping existing CLI ──

const { ProviderInterface } = require('./provider-interface');

class ClaudeProvider extends ProviderInterface {
  constructor(ptyManager) {
    super();
    this._ptyManager = ptyManager;
    this._sessions = new Map(); // sessionId → { ptySession }
  }

  get id() { return 'claude'; }
  get displayName() { return 'Claude'; }
  get color() { return '\x1b[38;5;208m'; } // orange
  get uiColor() { return '#cc9966'; }

  isConfigured() {
    // Claude is configured if the CLI is installed (checked separately)
    return true;
  }

  async models() {
    return [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', description: 'Fast, capable' },
      { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', description: 'Most intelligent' },
      { id: 'claude-haiku-3-5-20241022', name: 'Claude Haiku 3.5', description: 'Fastest, cheapest' },
    ];
  }

  async createSession(sessionId, opts = {}) {
    // Claude sessions are created via PtyManager — this is handled by pty:spawn IPC
    // This method exists for API parity; actual PTY creation happens in ipc-handlers.js
    this._sessions.set(sessionId, { model: opts.model, active: true });
  }

  async *sendMessage(sessionId, message, tools = []) {
    // Claude PTY sessions write directly to stdin via pty:write IPC
    // Output comes back via pty:data events, not through this generator
    // This method exists for API parity with other providers
    if (this._ptyManager) {
      const session = this._ptyManager.get(sessionId);
      if (session) {
        session.write(message + '\r');
        yield { type: 'delegated', content: 'Message sent to Claude CLI PTY' };
      }
    }
    yield { type: 'done' };
  }

  cancelGeneration(sessionId) {
    // Send Ctrl+C to PTY
    if (this._ptyManager) {
      const session = this._ptyManager.get(sessionId);
      if (session) session.write('\x03');
    }
  }

  destroy(sessionId) {
    this._sessions.delete(sessionId);
    if (this._ptyManager) {
      this._ptyManager.kill(sessionId);
    }
  }
}

module.exports = { ClaudeProvider };
