// ── Central State Store ───────────────────────────────────

import { events } from './events.js';

class StateStore {
  constructor() {
    this.sessions = new Map();         // id -> session object
    this.activeSessionId = null;
    this.layout = 'single';            // single | split | triple | quad
    this.paneAssignments = [null, null, null, null]; // pane index -> session id
    this.focusedPaneIndex = 0;
    this.groups = new Map();           // id -> group object
    this.muted = false;
    this.mcpServers = new Map();       // name -> { status, tools }
    this.broadcastActive = false;
    this.leftPanel = 'sessions';       // sessions | explorer | plugins
  }

  // ── Sessions ───────────────────────────────────────────

  addSession(session) {
    this.sessions.set(session.id, session);
    events.emit('session:added', session);
    return session;
  }

  getSession(id) {
    return this.sessions.get(id);
  }

  updateSession(id, updates) {
    const session = this.sessions.get(id);
    if (session) {
      Object.assign(session, updates);
      events.emit('session:updated', session);
    }
    return session;
  }

  removeSession(id) {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.delete(id);
      // Clear pane assignments
      this.paneAssignments = this.paneAssignments.map(pid => pid === id ? null : pid);
      if (this.activeSessionId === id) {
        this.activeSessionId = this.sessions.size > 0 ? this.sessions.keys().next().value : null;
      }
      events.emit('session:removed', { id, session });
    }
  }

  setActiveSession(id) {
    this.activeSessionId = id;
    events.emit('session:activated', id);
  }

  // ── Layout ─────────────────────────────────────────────

  setLayout(layout) {
    this.layout = layout;
    events.emit('layout:changed', layout);
  }

  getPaneCount() {
    const counts = { single: 1, split: 2, triple: 3, quad: 4 };
    return counts[this.layout] || 1;
  }

  assignPane(paneIndex, sessionId) {
    this.paneAssignments[paneIndex] = sessionId;
    events.emit('pane:assigned', { paneIndex, sessionId });
  }

  setFocusedPane(index) {
    this.focusedPaneIndex = index;
  }

  // ── Groups ─────────────────────────────────────────────

  addGroup(group) {
    this.groups.set(group.id, group);
    events.emit('group:added', group);
  }

  getGroup(id) {
    return this.groups.get(id);
  }

  removeGroup(id) {
    this.groups.delete(id);
    events.emit('group:removed', id);
  }

  getGroupSessions(groupId) {
    return Array.from(this.sessions.values()).filter(s => s.groupId === groupId);
  }

  // ── Left Panel ─────────────────────────────────────────

  setLeftPanel(panel) {
    this.leftPanel = panel;
  }

  // ── MCP ────────────────────────────────────────────────

  setMcpServer(name, data) {
    this.mcpServers.set(name, data);
    events.emit('mcp:updated', { name, data });
  }
}

export const state = new StateStore();
