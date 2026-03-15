// ── Diff Stats Badge ──────────────────────────────────────

import { state } from '../state.js';
import { events } from '../events.js';

export function initDiffBadge() {
  events.on('diff:stats', ({ sessionId, additions, deletions }) => {
    // Find the pane(s) displaying this session and update their diff badge
    for (let i = 0; i < 4; i++) {
      if (state.paneAssignments[i] === sessionId) {
        const paneEl = document.getElementById(`pane-${i}`);
        if (!paneEl) continue;
        const diffBtn = paneEl.querySelector('.diff-btn');
        if (diffBtn) {
          if (additions > 0 || deletions > 0) {
            diffBtn.innerHTML = `<span class="diff-stats-badge"><span class="additions">+${additions}</span> <span class="deletions">-${deletions}</span></span>`;
            diffBtn.title = `${additions} additions, ${deletions} deletions`;
          } else {
            diffBtn.innerHTML = '';
            diffBtn.title = 'Diff stats';
          }
        }
      }
    }
  });

  // Periodically poll git diff stats for active sessions with workspace paths
  setInterval(async () => {
    const checked = new Set();
    for (let i = 0; i < 4; i++) {
      const sessionId = state.paneAssignments[i];
      if (!sessionId || checked.has(sessionId)) continue;
      checked.add(sessionId);

      const session = state.getSession(sessionId);
      if (!session?.workspacePath || session.status === 'stopped') continue;

      try {
        const isRepo = await window.api.git.isRepo(session.workspacePath);
        if (!isRepo) continue;

        const diffStat = await window.api.git.diff(session.workspacePath);
        if (diffStat) {
          // Parse "git diff --stat" summary line:
          // "X files changed, Y insertions(+), Z deletions(-)"
          const addMatch = diffStat.match(/(\d+)\s+insertion/);
          const delMatch = diffStat.match(/(\d+)\s+deletion/);
          const additions = addMatch ? parseInt(addMatch[1]) : 0;
          const deletions = delMatch ? parseInt(delMatch[1]) : 0;
          events.emit('diff:stats', { sessionId, additions, deletions });
        }
      } catch (e) {
        // Silently ignore — git may not be available
      }
    }
  }, 15000); // Poll every 15s
}
