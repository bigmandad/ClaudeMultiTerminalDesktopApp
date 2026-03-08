// ── Claude Sessions — App Entry Point ─────────────────────

import { state } from './state.js';
import { events } from './events.js';
import { terminalManager } from './terminal/terminal-manager.js';
import { createSession, killSession } from './session/session-manager.js';
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
import { updateLimitBar } from './stats/limit-bars.js';
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
  // updateLimitBar is called on-demand, no init needed
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
  events.on('session:switchTo', (sessionId) => {
    const focusedPane = state.focusedPaneIndex;
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

  // Restore previous sessions
  try {
    const previousSessions = await window.api.session.restore();
    if (previousSessions?.length > 0) {
      console.log(`Found ${previousSessions.length} previous session(s)`);
      for (const s of previousSessions) {
        state.addSession({
          id: s.id,
          name: s.name,
          workspacePath: s.workspace_path,
          mode: s.mode || 'ask',
          skipPerms: !!s.skip_perms,
          groupId: s.group_id || null,
          status: 'idle'
        });
      }
      renderTabs();
    }
  } catch (e) {
    console.log('No previous sessions to restore');
  }

  console.log('Claude Sessions ready.');
}

// ── Start ─────────────────────────────────────────────────
init().catch(err => console.error('Init failed:', err));
