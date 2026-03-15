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

  // Persist session to database so it survives app restarts
  try {
    await window.api.session.create({
      id: session.id,
      name: session.name,
      workspacePath: session.workspacePath,
      mode: session.mode,
      skipPerms: session.skipPerms,
      groupId: session.groupId,
      model: session.model,
      status: session.status
    });
    console.log('[SessionManager] session persisted to DB');
  } catch (dbErr) {
    console.error('[SessionManager] DB persist failed (non-fatal):', dbErr.message);
  }

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
    // Update status in DB
    try { await window.api.session.update(id, { status: 'active' }); } catch (e) { /* ignore */ }
    console.log('[SessionManager] session status → active');
  } else {
    state.updateSession(id, { status: 'error' });
    try { await window.api.session.update(id, { status: 'error' }); } catch (e) { /* ignore */ }
    console.error('[SessionManager] FAILED to spawn session:', result.error);
  }

  return session;
}

export async function killSession(id) {
  await window.api.pty.kill(id);
  // Update DB status to archived (don't delete — keeps history)
  try { await window.api.session.update(id, { status: 'archived' }); } catch (e) { /* ignore */ }
  state.removeSession(id);
}

// Resume a previously saved session (re-spawn PTY)
export async function resumeSession(savedSession) {
  const session = {
    id: savedSession.id,
    name: savedSession.name,
    workspacePath: savedSession.workspace_path || savedSession.workspacePath || '',
    mode: savedSession.mode || 'ask',
    skipPerms: !!(savedSession.skip_perms || savedSession.skipPerms),
    groupId: savedSession.group_id || savedSession.groupId || null,
    model: savedSession.model || null,
    status: 'starting',
    lastMessage: ''
  };

  // Update in-memory state
  const existing = state.getSession(session.id);
  if (existing) {
    state.updateSession(session.id, { status: 'starting' });
  } else {
    state.addSession(session);
  }

  // Spawn PTY
  const result = await window.api.pty.spawn({
    id: session.id,
    cwd: session.workspacePath || undefined,
    mode: session.mode,
    skipPerms: session.skipPerms,
    model: session.model,
    resume: true,
    launchClaude: true
  });

  if (result.success) {
    state.updateSession(session.id, { status: 'active' });
    try { await window.api.session.update(session.id, { status: 'active' }); } catch (e) { /* ignore */ }
  } else {
    state.updateSession(session.id, { status: 'error' });
    try { await window.api.session.update(session.id, { status: 'error' }); } catch (e) { /* ignore */ }
  }

  return session;
}

export function getAllSessions() {
  return Array.from(state.sessions.values());
}

// Listen for exit events — mark as stopped in both state and DB
events.on('session:exited', async ({ id, exitCode }) => {
  state.updateSession(id, { status: 'stopped' });
  try { await window.api.session.update(id, { status: 'stopped' }); } catch (e) { /* ignore */ }
});
