// ── File Actions — open and @path insert ──────────────────

import { events } from '../events.js';
import { state } from '../state.js';
import { terminalManager } from '../terminal/terminal-manager.js';

export function initFileActions() {
  events.on('file:open', async (filePath) => {
    await window.api.shell.openPath(filePath);
  });

  events.on('file:insertPath', (atPath) => {
    const pane = terminalManager.getActivePane();
    if (pane && pane.inputEl) {
      const current = pane.inputEl.value;
      pane.inputEl.value = current ? `${current} ${atPath}` : atPath;
      pane.inputEl.focus();
    }
  });
}
