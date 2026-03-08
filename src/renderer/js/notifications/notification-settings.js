// ── Notification Settings ────────────────────────────────

import { state } from '../state.js';
import { events } from '../events.js';

export function initNotificationSettings() {
  // Mute toggle in icon rail
  const muteBtn = document.getElementById('mute-btn');
  if (muteBtn) {
    muteBtn.addEventListener('click', async () => {
      const newMuted = !state.muted;
      state.muted = newMuted;
      muteBtn.querySelector('.rail-icon').innerHTML = newMuted ? '&#128263;' : '&#128276;';
      muteBtn.title = newMuted ? 'Unmute Notifications' : 'Mute Notifications';
      await window.api.notify.mute(newMuted);
    });
  }

  // Restore mute state
  restoreMuteState(muteBtn);
}

async function restoreMuteState(muteBtn) {
  try {
    const saved = await window.api.appState.get('notificationsMuted');
    if (saved) {
      state.muted = true;
      if (muteBtn) {
        muteBtn.querySelector('.rail-icon').innerHTML = '&#128263;';
        muteBtn.title = 'Unmute Notifications';
      }
    }
  } catch (e) { /* ignore */ }
}
