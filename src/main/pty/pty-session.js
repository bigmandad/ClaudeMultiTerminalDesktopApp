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
      this.process = null; // Mark as dead so write() and isAlive checks work
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

    // Session resume: --resume <specificId> or --continue (most recent)
    if (this.options.resumeSessionId) {
      args.push('--resume', this.options.resumeSessionId);
    } else if (this.options.resume) {
      args.push('--continue');
    }

    if (this.options.systemPrompt) {
      // Collapse newlines → spaces to avoid breaking PowerShell command parsing.
      // Multi-line strings split across PTY write chunks cause PS to interpret
      // each line as a separate statement, producing "Missing expression" errors.
      const safePrompt = this.options.systemPrompt
        .replace(/\r?\n/g, ' ')   // newlines → spaces
        .replace(/\s{2,}/g, ' ')   // collapse multiple spaces
        .replace(/"/g, '\\"')      // escape inner quotes
        .trim();
      args.push('--append-system-prompt', `"${safePrompt}"`);
    }

    // Session display name (--name)
    if (this.options.name) {
      args.push('--name', `"${this.options.name.replace(/"/g, '\\"')}"`);
    }

    // Max turns limit for cost/runaway protection
    if (this.options.maxTurns) {
      args.push('--max-turns', String(this.options.maxTurns));
    }

    // Granular tool permissions (safer than --dangerously-skip-permissions)
    if (this.options.allowedTools && Array.isArray(this.options.allowedTools)) {
      for (const tool of this.options.allowedTools) {
        args.push('--allowedTools', `"${tool}"`);
      }
    }

    if (this.options.disallowedTools && Array.isArray(this.options.disallowedTools)) {
      for (const tool of this.options.disallowedTools) {
        args.push('--disallowedTools', `"${tool}"`);
      }
    }

    // Tool restriction (--tools for whitelisting available tools)
    if (this.options.tools && Array.isArray(this.options.tools)) {
      for (const tool of this.options.tools) {
        args.push('--tools', `"${tool}"`);
      }
    }

    // MCP debug output
    if (this.options.mcpDebug) {
      args.push('--mcp-debug');
    }

    // Verbose output for debugging
    if (this.options.verbose) {
      args.push('--verbose');
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
