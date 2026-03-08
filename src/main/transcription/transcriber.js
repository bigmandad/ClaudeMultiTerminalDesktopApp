const fs = require('fs');
const path = require('path');
const os = require('os');

// Strip ANSI escape sequences
function stripAnsi(str) {
  return str.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g,
    ''
  );
}

class Transcriber {
  constructor() {
    this.baseDir = path.join(os.homedir(), '.claude-sessions', 'transcripts');
    this.streams = new Map();
    this.sessionMeta = new Map();

    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  startSession(sessionId, meta = {}) {
    this.sessionMeta.set(sessionId, meta);

    const today = this._today();
    const dir = path.join(this.baseDir, sessionId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `${today}.md`);
    const key = `${sessionId}:${today}`;

    if (!this.streams.has(key)) {
      const stream = fs.createWriteStream(filePath, { flags: 'a' });
      this.streams.set(key, stream);

      // Write session header if file is new/empty
      if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
        const header = [
          `# Session: ${meta.name || sessionId}`,
          `# Date: ${today}`,
          meta.workspacePath ? `# Workspace: ${meta.workspacePath}` : '',
          `# Mode: ${(meta.mode || 'ASK').toUpperCase()} | Skip Perms: ${meta.skipPerms ? 'ON' : 'OFF'}`,
          '',
          '---',
          ''
        ].filter(Boolean).join('\n');
        stream.write(header);
      }
    }
  }

  write(sessionId, rawData) {
    const clean = stripAnsi(rawData);
    if (!clean.trim()) return;

    const today = this._today();
    const key = `${sessionId}:${today}`;

    // Check for day rollover
    if (!this.streams.has(key)) {
      this.startSession(sessionId, this.sessionMeta.get(sessionId) || {});
    }

    const stream = this.streams.get(key);
    if (stream && !stream.destroyed) {
      stream.write(clean);
    }
  }

  endSession(sessionId) {
    const today = this._today();
    const key = `${sessionId}:${today}`;
    const stream = this.streams.get(key);
    if (stream) {
      stream.write('\n\n--- Session ended ---\n');
      stream.end();
      this.streams.delete(key);
    }
    this.sessionMeta.delete(sessionId);
  }

  closeAll() {
    for (const [key, stream] of this.streams) {
      if (!stream.destroyed) stream.end();
    }
    this.streams.clear();
    this.sessionMeta.clear();
  }

  getTranscriptPath(sessionId, date) {
    return path.join(this.baseDir, sessionId, `${date || this._today()}.md`);
  }

  listTranscripts(sessionId) {
    const dir = path.join(this.baseDir, sessionId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();
  }

  _today() {
    return new Date().toISOString().slice(0, 10);
  }
}

module.exports = { Transcriber };
