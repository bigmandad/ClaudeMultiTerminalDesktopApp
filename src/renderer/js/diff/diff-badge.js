// ── Diff Stats Badge ──────────────────────────────────────

import { events } from '../events.js';

export function initDiffBadge() {
  events.on('diff:stats', ({ sessionId, additions, deletions }) => {
    // Update diff button in pane header
    const panes = document.querySelectorAll('.terminal-pane');
    for (const pane of panes) {
      const diffBtn = pane.querySelector('.diff-btn');
      if (diffBtn) {
        if (additions > 0 || deletions > 0) {
          diffBtn.innerHTML = `<span class="diff-stats-badge"><span class="additions">+${additions}</span> <span class="deletions">-${deletions}</span></span>`;
        } else {
          diffBtn.innerHTML = '';
        }
      }
    }
  });
}
