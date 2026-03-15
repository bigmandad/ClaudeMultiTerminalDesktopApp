// ── Claude Sessions — App Entry Point ─────────────────────

import { state } from './state.js';
import { events } from './events.js';
import { terminalManager } from './terminal/terminal-manager.js';
import { createSession, killSession, resumeSession } from './session/session-manager.js';
import { initTabBar, renderTabs } from './session/session-tab.js';
import { initSessionForm } from './session/session-form.js';
import { initLayoutManager } from './layout/layout-manager.js';
import { initPaneAssignment } from './layout/pane-assignment.js';
import { initIconRail } from './sidebar/icon-rail.js';
import { initLeftPanel } from './sidebar/left-panel.js';
import { showToast } from './notifications/toast.js';
import { initNotificationSettings } from './notifications/notification-settings.js';
import { initFileExplorer } from './file-explorer/file-tree.js';
import { initFileActions } from './file-explorer/file-actions.js';
import { initGroupManager } from './groups/group-manager.js';
import { initGroupContext } from './groups/group-context.js';
import { initUsageModal } from './stats/usage-modal.js';
import { initContextBar } from './stats/context-bar.js';
import { initDiffBadge } from './diff/diff-badge.js';
import { initDiffViewer } from './diff/diff-viewer.js';
import { initAttachments } from './attachments/attachment-popover.js';
import { initPluginDrawer } from './mcp/plugin-drawer.js';
import { initMcpUI } from './mcp/mcp-ui.js';
import { initBroadcastOverlay } from './broadcast/broadcast-overlay.js';
import { initBroadcastManager } from './broadcast/broadcast-manager.js';
import { initSpeechInput } from './speech/speech-input.js';
import { initSettingsModal } from './settings/settings-modal.js';
import { initKeybindings } from './settings/keybindings.js';
import { initAuthStatus } from './auth/auth-status.js';
import { initQuickLaunch } from './session/quick-launch.js';
import { initOpenVikingPanel } from './openviking/openviking-panel.js';
import { initKnowledgeSearch } from './openviking/knowledge-search.js';
import { initSystemStatus } from './stats/system-status.js';

// ── Initialize ────────────────────────────────────────────

async function init() {
  console.log('Claude Sessions initializing...');

  // Init core UI modules
  terminalManager.init();
  initTabBar();
  initSessionForm();
  initLayoutManager();
  initPaneAssignment();
  initIconRail();
  initLeftPanel();

  // Init feature modules
  initNotificationSettings();
  initFileExplorer();
  initFileActions();
  initGroupManager();
  initGroupContext();
  initUsageModal();
  initContextBar();
  initDiffBadge();
  initDiffViewer();
  initAttachments();
  initPluginDrawer();
  initMcpUI();
  initBroadcastOverlay();
  initBroadcastManager();
  initSpeechInput();
  initSettingsModal();
  initKeybindings();
  initAuthStatus();
  initQuickLaunch();
  initOpenVikingPanel();
  initKnowledgeSearch();
  initSystemStatus();

  // Tab key prevention on ALL inputs globally
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && e.target.matches('input, textarea, select, [contenteditable]')) {
      e.preventDefault();
    }
  });

  // ── Wire events ─────────────────────────────────────────

  // Session assigned to pane
  events.on('session:assignToPane', ({ sessionId, paneIndex }) => {
    console.log('[App] session:assignToPane event received — session=' + sessionId, 'pane=' + paneIndex);
    terminalManager.attachSessionToPane(paneIndex, sessionId);
  });

  // Session switch via tab or sidebar click
  events.on('session:switchTo', async (sessionId) => {
    const session = state.getSession(sessionId);
    const focusedPane = state.focusedPaneIndex;

    // If session is stopped/idle, resume it first
    if (session && (session.status === 'stopped' || session.status === 'idle')) {
      console.log('[App] Resuming stopped session:', sessionId);
      showToast({ title: `Resuming ${session.name}...`, icon: '&#9889;' });
      try {
        await resumeSession(session);
      } catch (e) {
        console.error('[App] Failed to resume session:', e);
        showToast({ title: 'Resume failed', message: e.message, icon: '&#9888;' });
      }
    }

    terminalManager.attachSessionToPane(focusedPane, sessionId);
  });

  // Session archive
  events.on('session:archive', async (id) => {
    await killSession(id);
    showToast({ title: 'Session archived', icon: '&#9998;' });
  });

  // Mode change
  events.on('pane:modeChanged', async ({ paneIndex, sessionId, mode }) => {
    if (!sessionId) return;
    state.updateSession(sessionId, { mode });

    // Re-spawn session with new mode
    await window.api.pty.kill(sessionId);
    const session = state.getSession(sessionId);
    if (session) {
      await window.api.pty.spawn({
        id: sessionId,
        cwd: session.workspacePath || undefined,
        mode: mode,
        skipPerms: session.skipPerms,
        launchClaude: true
      });

      // Reattach terminal so user sees the new session output
      const pane = terminalManager.getPane(paneIndex);
      if (pane) {
        pane.clear();
        pane.attachSession(sessionId);
      }
    }
  });

  // Skip perms change
  events.on('pane:skipPermsChanged', async ({ paneIndex, sessionId, skipPerms }) => {
    if (!sessionId) return;
    state.updateSession(sessionId, { skipPerms });

    // Re-spawn session
    await window.api.pty.kill(sessionId);
    const session = state.getSession(sessionId);
    if (session) {
      await window.api.pty.spawn({
        id: sessionId,
        cwd: session.workspacePath || undefined,
        mode: session.mode,
        skipPerms: skipPerms,
        launchClaude: true
      });

      // Reattach
      const pane = terminalManager.getPane(paneIndex);
      if (pane) {
        pane.clear();
        pane.attachSession(sessionId);
      }

      if (skipPerms) {
        showToast({
          title: 'Skip Permissions ON',
          message: 'Claude will not ask before editing files or running commands.',
          icon: '&#9889;'
        });
      }
    }
  });

  // ── Keyboard Shortcuts ──────────────────────────────────

  document.addEventListener('keydown', (e) => {
    // Ctrl+1-4: Focus pane
    if (e.ctrlKey && e.key >= '1' && e.key <= '4') {
      e.preventDefault();
      const index = parseInt(e.key) - 1;
      if (index < state.getPaneCount()) {
        events.emit('pane:requestFocus', index);
      }
    }

    // Ctrl+T: New session
    if (e.ctrlKey && e.key === 't') {
      e.preventDefault();
      document.getElementById('new-session-modal')?.classList.remove('hidden');
      document.getElementById('session-name-input')?.focus();
    }

    // Ctrl+W: Close active session
    if (e.ctrlKey && e.key === 'w') {
      e.preventDefault();
      const activeId = state.paneAssignments[state.focusedPaneIndex];
      if (activeId) {
        killSession(activeId);
      }
    }

    // Ctrl+B: Toggle broadcast
    if (e.ctrlKey && e.key === 'b') {
      e.preventDefault();
      const overlay = document.getElementById('broadcast-overlay');
      if (overlay) overlay.classList.toggle('hidden');
    }
  });

  // Restore previous sessions from database
  try {
    const previousSessions = await window.api.session.restore();
    if (previousSessions?.length > 0) {
      console.log(`Found ${previousSessions.length} previous session(s) to restore`);
      for (const s of previousSessions) {
        // Add to in-memory state as stopped (they need to be resumed)
        state.addSession({
          id: s.id,
          name: s.name,
          workspacePath: s.workspace_path,
          mode: s.mode || 'ask',
          skipPerms: !!s.skip_perms,
          groupId: s.group_id || null,
          model: s.model || null,
          status: 'stopped',
          lastMessage: ''
        });
      }
      renderTabs();

      // Show toast about restored sessions
      showToast({
        title: `${previousSessions.length} session(s) restored`,
        message: 'Click a session to resume it',
        icon: '&#128260;'
      });
    }
  } catch (e) {
    console.log('No previous sessions to restore');
  }

  // ── App Memory State — persist conversation context ────

  // Restore app memory
  try {
    const savedState = await window.api.appState.get('app_memory');
    if (savedState) {
      console.log('[AppMemory] Restored:', Object.keys(savedState));
      state._appMemory = savedState;
    }
  } catch (e) {
    console.log('[AppMemory] No previous memory');
  }

  // Save app state periodically (every 30s) and on session changes
  async function saveAppMemory() {
    const memory = {
      lastActive: new Date().toISOString(),
      sessionCount: state.sessions.size,
      layout: state.layout,
      focusedPane: state.focusedPaneIndex,
      sessions: Array.from(state.sessions.values()).map(s => ({
        id: s.id, name: s.name, workspacePath: s.workspacePath,
        mode: s.mode, groupId: s.groupId, status: s.status,
        lastMessage: s.lastMessage
      })),
      paneAssignments: state.paneAssignments,
      groups: Array.from(state.groups.values()).map(g => ({
        id: g.id, name: g.name, color: g.color
      }))
    };
    try { await window.api.appState.set('app_memory', memory); } catch (e) { /* ignore */ }
  }

  setInterval(saveAppMemory, 30000);
  events.on('session:added', () => setTimeout(saveAppMemory, 1000));
  events.on('session:removed', () => setTimeout(saveAppMemory, 1000));
  events.on('layout:changed', () => setTimeout(saveAppMemory, 500));

  // Track last messages from PTY output per session + emit parsed output for context bar
  window.api.pty.onData((id, data) => {
    const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (clean.length > 5) {
      const preview = clean.slice(0, 80).replace(/\n/g, ' ');
      const session = state.getSession(id);
      if (session) session.lastMessage = preview;

      // Emit parsed output — drives context bar, auto-status detection
      events.emit('pty:outputParsed', { sessionId: id, data: clean });

      // Auto-detect session status from Claude CLI output patterns
      if (session) {
        // Claude shows ">" prompt when waiting for input
        if (/^>\s*$/.test(clean) || /waiting for your/i.test(clean)) {
          if (session.status !== 'waiting') {
            state.updateSession(id, { status: 'waiting' });
          }
        } else if (session.status === 'waiting' && clean.length > 10) {
          state.updateSession(id, { status: 'active' });
        }
      }
    }
  });

  console.log('Claude Sessions ready.');
}

// ── Start ─────────────────────────────────────────────────
init().catch(err => console.error('Init failed:', err));
