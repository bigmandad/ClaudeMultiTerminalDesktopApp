// ── Icon Rail — Panel switching ────────────────────────────

import { state } from '../state.js';
import { events } from '../events.js';
import { toggleRemoteApi, isRemoteApiRunning, toggleDiscordBot, isDiscordBotConnected, showDiscordTokenPopover } from '../settings/settings-modal.js';

export function initIconRail() {
  const panelBtns = document.querySelectorAll('.rail-btn[data-panel]');

  panelBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = btn.dataset.panel;
      state.setLeftPanel(panel);
      updatePanelButtons(panel);
      updatePanelVisibility(panel);
      events.emit('panel:shown', panel);
    });
  });

  // Update & Restart button
  const updateBtn = document.getElementById('update-btn');
  if (updateBtn) {
    updateBtn.addEventListener('click', async () => {
      // Visual feedback
      updateBtn.classList.add('updating');
      updateBtn.title = 'Updating...';
      const icon = updateBtn.querySelector('.rail-icon');
      if (icon) icon.style.animation = 'spin 1s linear infinite';

      try {
        const result = await window.api.app.update();
        if (result.updated) {
          updateBtn.title = `Updated! Restarting... (${result.summary})`;
          // Brief delay so user sees the message
          setTimeout(() => window.api.app.restart(), 1500);
        } else {
          updateBtn.title = result.message || 'Already up to date';
          updateBtn.classList.remove('updating');
          if (icon) icon.style.animation = '';
          // Reset title after 3 seconds
          setTimeout(() => { updateBtn.title = 'Check for Updates & Restart'; }, 3000);
        }
      } catch (err) {
        updateBtn.title = `Update failed: ${err.message}`;
        updateBtn.classList.remove('updating');
        if (icon) icon.style.animation = '';
        setTimeout(() => { updateBtn.title = 'Check for Updates & Restart'; }, 3000);
      }
    });
  }

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

  // Discord Bot toggle
  const discordBtn = document.getElementById('discord-bot-btn');
  if (discordBtn) {
    discordBtn.addEventListener('click', async () => {
      // If no token configured, show the token popover
      const tokenInfo = await window.api.discord.getToken();
      if (!tokenInfo.exists && !isDiscordBotConnected()) {
        showDiscordTokenPopover(discordBtn);
        return;
      }
      await toggleDiscordBot();
      discordBtn.classList.toggle('active', isDiscordBotConnected());
    });

    // Check initial state
    setTimeout(async () => {
      try {
        const status = await window.api.discord.status();
        discordBtn.classList.toggle('active', status.connected);
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
    openviking: 'openviking-panel',
    autoresearch: 'autoresearch-panel',
    activity: 'activity-panel'
  };

  for (const [key, id] of Object.entries(panels)) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', key !== activePanel);
  }
}
