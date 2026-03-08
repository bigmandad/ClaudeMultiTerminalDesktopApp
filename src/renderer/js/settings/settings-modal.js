// ── Settings Modal ───────────────────────────────────────

import { state } from '../state.js';
import { showToast } from '../notifications/toast.js';

export function initSettingsModal() {
  // Settings can be opened via menu or keyboard shortcut
  // For now, settings are managed through the sidebar panels
  // and per-session configuration in the session form.
}

export function showSettings() {
  showToast({
    title: 'Settings',
    message: 'Configure sessions via the session form. MCP servers via ~/.claude.json.',
    icon: '&#9881;'
  });
}
