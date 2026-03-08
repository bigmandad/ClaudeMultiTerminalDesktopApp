let pty;
try {
  pty = require('@homebridge/node-pty-prebuilt-multiarch');
} catch (e) {
  pty = require('node-pty');
}
const os = require('os');

class PtySession {
  constructor(id, options = {}) {
    this.id = id;
    this.process = null;
    this.options = options;
    this.onDataCallback = null;
    this.onExitCallback = null;
  }

  spawn() {
    const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');
    const cwd = this.options.cwd || os.homedir();
    console.log('[PtySession] spawning shell:', shell, 'cwd:', cwd, 'id:', this.id);

    this.process = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: this.options.cols || 120,
      rows: this.options.rows || 30,
      cwd: cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      }
    });
    console.log('[PtySession] shell process started, pid:', this.process.pid);

    this.process.onData((data) => {
      if (this.onDataCallback) this.onDataCallback(data);
    });

    this.process.onExit(({ exitCode }) => {
      console.log('[PtySession] process exited, id:', this.id, 'code:', exitCode);
      if (this.onExitCallback) this.onExitCallback(exitCode);
    });

    // After shell is ready, send the claude command
    if (this.options.launchClaude !== false) {
      const claudeArgs = this._buildClaudeArgs();
      const cmd = `claude ${claudeArgs}`.trim();
      console.log('[PtySession] will write command in 800ms:', cmd);
      setTimeout(() => {
        console.log('[PtySession] writing command now:', cmd);
        this.process.write(`${cmd}\r`);
      }, 800);
    } else {
      console.log('[PtySession] launchClaude=false, shell-only mode');
    }

    return this.process;
  }

  _buildClaudeArgs() {
    const args = [];

    if (this.options.mode === 'bypassPermissions' || this.options.skipPerms) {
      args.push('--dangerously-skip-permissions');
    }

    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    if (this.options.mcpConfig) {
      args.push('--mcp-config', `"${this.options.mcpConfig}"`);
    }

    if (this.options.resume) {
      args.push('--continue');
    }

    if (this.options.systemPrompt) {
      args.push('--append-system-prompt', `"${this.options.systemPrompt.replace(/"/g, '\\"')}"`);
    }

    return args.join(' ');
  }

  write(data) {
    if (this.process) {
      this.process.write(data);
    }
  }

  resize(cols, rows) {
    if (this.process) {
      try {
        this.process.resize(cols, rows);
      } catch (e) {
        // Ignore resize errors on dead process
      }
    }
  }

  kill() {
    if (this.process) {
      try {
        this.process.kill();
      } catch (e) {
        // Already dead
      }
    }
  }
}

module.exports = { PtySession };
