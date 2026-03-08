// ── Session Manager — Create and track sessions ──────────

import { state } from '../state.js';
import { events } from '../events.js';

let sessionCounter = 0;

function generateId() {
  return `session-${Date.now()}-${++sessionCounter}`;
}

export async function createSession(opts = {}) {
  const id = generateId();
  console.log('[SessionManager] createSession id=' + id, 'opts:', JSON.stringify(opts));

  const session = {
    id,
    name: opts.name || `Session ${state.sessions.size + 1}`,
    workspacePath: opts.workspacePath || '',
    mode: opts.mode || 'ask',
    skipPerms: opts.skipPerms || false,
    groupId: opts.groupId || null,
    model: opts.model || null,
    status: 'starting',
    createdAt: new Date().toISOString(),
    lastMessage: ''
  };

  state.addSession(session);
  console.log('[SessionManager] session added to state');

  // Spawn PTY
  const spawnOpts = {
    id: session.id,
    cwd: session.workspacePath || undefined,
    mode: session.mode,
    skipPerms: session.skipPerms,
    model: session.model,
    launchClaude: opts.launchClaude !== false
  };
  console.log('[SessionManager] calling pty.spawn with:', JSON.stringify(spawnOpts));

  const result = await window.api.pty.spawn(spawnOpts);
  console.log('[SessionManager] pty.spawn result:', JSON.stringify(result));

  if (result.success) {
    state.updateSession(id, { status: 'active' });
    console.log('[SessionManager] session status → active');
  } else {
    state.updateSession(id, { status: 'error' });
    console.error('[SessionManager] FAILED to spawn session:', result.error);
  }

  return session;
}

export async function killSession(id) {
  await window.api.pty.kill(id);
  state.removeSession(id);
}

export function getSessionsByGroup(groupId) {
  return state.getGroupSessions(groupId);
}

export function getAllSessions() {
  return Array.from(state.sessions.values());
}

// Listen for exit events
events.on('session:exited', ({ id, exitCode }) => {
  state.updateSession(id, { status: 'stopped' });
});
