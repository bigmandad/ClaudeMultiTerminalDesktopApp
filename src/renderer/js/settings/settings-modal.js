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
