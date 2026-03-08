const { PtySession } = require('./pty-session');

class PtyManagerClass {
  constructor() {
    this.sessions = new Map();
  }

  create(id, options) {
    if (this.sessions.has(id)) {
      this.kill(id);
    }
    const session = new PtySession(id, options);
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    return this.sessions.get(id);
  }

  write(id, data) {
    const session = this.sessions.get(id);
    if (session) session.write(data);
  }

  resize(id, cols, rows) {
    const session = this.sessions.get(id);
    if (session) session.resize(cols, rows);
  }

  kill(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.kill();
      this.sessions.delete(id);
    }
  }

  killAll() {
    for (const [id, session] of this.sessions) {
      session.kill();
    }
    this.sessions.clear();
  }

  list() {
    return Array.from(this.sessions.keys());
  }
}

const PtyManager = new PtyManagerClass();

module.exports = { PtyManager };
