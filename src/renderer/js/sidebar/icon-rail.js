// ── Icon Rail — Panel switching ────────────────────────────

import { state } from '../state.js';
import { events } from '../events.js';
import { toggleRemoteApi, isRemoteApiRunning } from '../settings/settings-modal.js';

export function initIconRail() {
  const panelBtns = document.querySelectorAll('.rail-btn[data-panel]');

  panelBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = btn.dataset.panel;
      state.setLeftPanel(panel);
      updatePanelButtons(panel);
      updatePanelVisibility(panel);
    });
  });

  // Mute toggle is handled by notification-settings.js

  // Stats button
  const statsBtn = document.getElementById('stats-btn');
  if (statsBtn) {
    statsBtn.addEventListener('click', () => {
      events.emit('stats:open');
    });
  }

  // Remote API toggle
  const remoteBtn = document.getElementById('remote-api-btn');
  if (remoteBtn) {
    remoteBtn.addEventListener('click', async () => {
      await toggleRemoteApi();
      remoteBtn.classList.toggle('active', isRemoteApiRunning());
    });

    // Check initial state
    setTimeout(async () => {
      try {
        const status = await window.api.remote.status();
        remoteBtn.classList.toggle('active', status.running);
      } catch (e) { /* ignore */ }
    }, 2000);
  }
}

function updatePanelButtons(activePanel) {
  document.querySelectorAll('.rail-btn[data-panel]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.panel === activePanel);
  });
}

function updatePanelVisibility(activePanel) {
  const panels = {
    sessions: 'sessions-panel',
    explorer: 'explorer-panel',
    plugins: 'plugins-panel',
    openviking: 'openviking-panel'
  };

  for (const [key, id] of Object.entries(panels)) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', key !== activePanel);
  }
}
