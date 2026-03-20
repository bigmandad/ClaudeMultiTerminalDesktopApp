// ── Quick Launch — one-click session creation ────────────

import { state } from '../state.js';
import { events } from '../events.js';
import { createSession } from './session-manager.js';
import { showToast } from '../notifications/toast.js';

export function initQuickLaunch() {
  const btn = document.getElementById('quick-launch-btn');
  console.log('[QuickLaunch] init — button found:', !!btn);
  if (btn) {
    btn.addEventListener('click', () => {
      console.log('[QuickLaunch] button clicked!');
      quickLaunch();
    });
  }

}

async function quickLaunch() {
  try {
    const name = generateUniqueName();
    console.log('[QuickLaunch] starting session:', name);

    showToast({
      title: `Starting ${name}...`,
      icon: '&#9889;'
    });

    const paneIndex = findEmptyPane();
    const workspacePath = await getLastWorkspacePath();
    console.log('[QuickLaunch] target pane:', paneIndex, 'workspace:', workspacePath || '(home)');

    console.log('[QuickLaunch] calling createSession...');
    const session = await createSession({
      name,
      workspacePath,
      mode: 'ask',
      skipPerms: false
    });
    console.log('[QuickLaunch] session created:', session.id, 'status:', session.status);

    // Mark active so tabs highlight
    state.setActiveSession(session.id);

    // Assign session to pane so output is visible
    state.assignPane(paneIndex, session.id);
    console.log('[QuickLaunch] emitting session:assignToPane pane=' + paneIndex, 'session=' + session.id);
    events.emit('session:assignToPane', { sessionId: session.id, paneIndex });
    console.log('[QuickLaunch] done — session should now be visible in pane', paneIndex);
  } catch (err) {
    console.error('[QuickLaunch] ERROR:', err);
    showToast({
      title: 'Quick Launch Failed',
      message: err.message || String(err),
      icon: '&#9888;'
    });
  }
}

function generateUniqueName() {
  const existingNames = Array.from(state.sessions.values()).map(s => s.name);
  let name = 'Claude';
  let counter = 1;
  while (existingNames.includes(name)) {
    counter++;
    name = `Claude ${counter}`;
  }
  return name;
}

function findEmptyPane() {
  const maxPanes = getPaneCount();
  for (let i = 0; i < maxPanes; i++) {
    if (!state.paneAssignments[i]) return i;
  }
  return state.focusedPaneIndex;
}

function getPaneCount() {
  switch (state.layout) {
    case 'single': return 1;
    case 'split': return 2;
    case 'triple': return 3;
    case 'quad': return 4;
    default: return 1;
  }
}

/**
 * Get the last used workspace path from:
 * 1. Currently active sessions in memory
 * 2. App memory state (persisted across restarts)
 * 3. Falls back to empty string (home directory)
 */
async function getLastWorkspacePath() {
  // Check active sessions first — most recent workspace wins
  for (const session of state.sessions.values()) {
    if (session.workspacePath) return session.workspacePath;
  }

  // Check app memory for previously saved sessions
  try {
    const memory = await window.api.appState.get('app_memory');
    if (memory?.sessions?.length > 0) {
      for (const s of memory.sessions) {
        if (s.workspacePath) return s.workspacePath;
      }
    }
  } catch (e) {
    console.log('[QuickLaunch] could not read app memory:', e.message);
  }

  return '';
}
