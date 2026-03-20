// ── Settings Modal ───────────────────────────────────────

import { showToast } from '../notifications/toast.js';

let remoteApiRunning = false;

export function initSettingsModal() {
  // Auto-start remote API from saved preference
  initRemoteApi();
}

async function initRemoteApi() {
  try {
    const pref = await window.api.appState.get('remote_api_enabled');
    if (pref) {
      const result = await window.api.remote.start(3456);
      remoteApiRunning = result.status === 'started' || result.status === 'already_running';
      if (remoteApiRunning) {
        console.log('[Settings] Remote API started on port 3456');
      }
    }
  } catch (e) {
    console.log('[Settings] Remote API init error:', e.message);
  }
}

export async function toggleRemoteApi() {
  try {
    if (remoteApiRunning) {
      await window.api.remote.stop();
      remoteApiRunning = false;
      await window.api.appState.set('remote_api_enabled', false);
      showToast({ title: 'Remote API Stopped', icon: '&#128274;' });
    } else {
      const result = await window.api.remote.start(3456);
      remoteApiRunning = result.status === 'started' || result.status === 'already_running';
      await window.api.appState.set('remote_api_enabled', true);
      showToast({
        title: 'Remote API Started',
        message: 'Listening on port 3456. Google Chat webhook: POST /api/webhook/gchat',
        icon: '&#127760;'
      });
    }
  } catch (e) {
    showToast({ title: 'Error: ' + e.message, icon: '&#9888;' });
  }
}

export function isRemoteApiRunning() {
  return remoteApiRunning;
}

// ── Discord Bot ──────────────────────────────────────────

let discordBotConnected = false;

export async function initDiscordBot() {
  try {
    const pref = await window.api.appState.get('discord_bot_enabled');
    const tokenInfo = await window.api.discord.getToken();
    if (pref && tokenInfo.exists) {
      const result = await window.api.discord.start();
      discordBotConnected = result.success || result.status === 'already_connected';
      if (discordBotConnected) {
        console.log('[Settings] Discord bot started');
      }
    }
  } catch (e) {
    console.log('[Settings] Discord bot init error:', e.message);
  }
}

export async function toggleDiscordBot() {
  try {
    if (discordBotConnected) {
      await window.api.discord.stop();
      discordBotConnected = false;
      await window.api.appState.set('discord_bot_enabled', false);
      showToast({ title: 'Discord Bot Disconnected', icon: '&#128308;' });
    } else {
      const tokenInfo = await window.api.discord.getToken();
      if (!tokenInfo.exists) {
        showToast({ title: 'No Discord token configured', message: 'Click the Discord button to set up', icon: '&#9888;' });
        return;
      }
      const result = await window.api.discord.start();
      discordBotConnected = result.success;
      if (discordBotConnected) {
        await window.api.appState.set('discord_bot_enabled', true);
        showToast({ title: 'Discord Bot Connected', message: result.tag || '', icon: '&#128172;' });
      } else {
        showToast({ title: 'Discord Error', message: result.error || 'Failed to connect', icon: '&#9888;' });
      }
    }
  } catch (e) {
    showToast({ title: 'Error: ' + e.message, icon: '&#9888;' });
  }
}

export function isDiscordBotConnected() {
  return discordBotConnected;
}

export async function saveDiscordToken(token) {
  await window.api.discord.setToken(token);
  showToast({ title: 'Discord token saved', icon: '&#9989;' });
}

export function showDiscordTokenPopover(anchorEl) {
  // Remove any existing popover
  const existing = document.querySelector('.discord-token-popover');
  if (existing) existing.remove();

  const popover = document.createElement('div');
  popover.className = 'discord-token-popover';
  popover.style.cssText = `
    position: fixed;
    background: var(--bg-panel, #252118);
    border: 1px solid var(--border, #3a352f);
    border-radius: 6px;
    padding: 10px;
    z-index: 9999;
    width: 260px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--cream, #e8ddd0);
  `;

  popover.innerHTML = `
    <div style="margin-bottom:8px;font-weight:600;color:var(--orange,#d4845a)">Discord Bot Setup</div>
    <div style="margin-bottom:6px;color:var(--cream-dim,#a89882);font-size:10px">
      Create a bot at discord.com/developers/applications.<br>
      Enable MESSAGE CONTENT intent. Paste token below.
    </div>
    <input type="password" id="discord-token-input"
           placeholder="Bot token..."
           style="width:100%;padding:5px 7px;background:var(--bg-deep,#151210);border:1px solid var(--border,#3a352f);color:var(--cream,#e8ddd0);border-radius:4px;font-size:11px;font-family:var(--font-mono);box-sizing:border-box;margin-bottom:6px;">
    <button id="discord-save-connect-btn"
            style="width:100%;padding:5px;font-size:11px;background:var(--orange,#d4845a);color:#1a1714;border:none;border-radius:4px;cursor:pointer;font-family:var(--font-mono);font-weight:600;">
      Save & Connect
    </button>
  `;

  // Position to the right of the anchor
  const rect = anchorEl.getBoundingClientRect();
  popover.style.left = (rect.right + 8) + 'px';
  popover.style.top = Math.max(rect.top - 40, 10) + 'px';
  document.body.appendChild(popover);

  // Focus the input
  setTimeout(() => {
    const input = document.getElementById('discord-token-input');
    if (input) input.focus();
  }, 50);

  // Save & Connect handler
  document.getElementById('discord-save-connect-btn').addEventListener('click', async () => {
    const token = document.getElementById('discord-token-input').value.trim();
    if (!token) return;

    await saveDiscordToken(token);
    popover.remove();
    await toggleDiscordBot();

    // Update the rail button
    const discordBtn = document.getElementById('discord-bot-btn');
    if (discordBtn) discordBtn.classList.toggle('active', isDiscordBotConnected());
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function close(e) {
      if (!popover.contains(e.target) && !anchorEl.contains(e.target)) {
        popover.remove();
        document.removeEventListener('click', close);
      }
    });
  }, 100);
}

// Listen for Discord status changes from main process
if (window.api?.discord?.onStatusChanged) {
  window.api.discord.onStatusChanged((payload) => {
    discordBotConnected = payload.connected;
    const discordBtn = document.getElementById('discord-bot-btn');
    if (discordBtn) discordBtn.classList.toggle('active', payload.connected);
  });
}
