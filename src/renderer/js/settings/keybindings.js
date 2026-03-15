// ── Keybindings ──────────────────────────────────────────
// Centralized keyboard shortcut registration.
// Most shortcuts are inline in app.js; this module adds extras.

import { state } from '../state.js';
import { events } from '../events.js';

export function initKeybindings() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+L: Cycle layout — handled by layout-manager.js

    // Ctrl+Shift+B: Toggle broadcast
    if (e.ctrlKey && e.shiftKey && e.key === 'B') {
      e.preventDefault();
      const overlay = document.getElementById('broadcast-overlay');
      if (overlay) overlay.classList.toggle('hidden');
    }

    // Escape: Close overlays/modals
    if (e.key === 'Escape') {
      document.getElementById('broadcast-overlay')?.classList.add('hidden');
      document.getElementById('new-session-modal')?.classList.add('hidden');
    }

    // Ctrl+`: Focus terminal (re-focus from input)
    if (e.ctrlKey && e.key === '`') {
      e.preventDefault();
      events.emit('pane:requestFocus', state.focusedPaneIndex);
    }
  });
}
