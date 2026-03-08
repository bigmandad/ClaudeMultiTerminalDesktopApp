// ── Diff Viewer Panel ─────────────────────────────────────

import { events } from '../events.js';

export function initDiffViewer() {
  // Diff button click handler
  document.addEventListener('click', async (e) => {
    const diffBtn = e.target.closest('.diff-btn');
    if (!diffBtn) return;

    const pane = diffBtn.closest('.terminal-pane');
    if (!pane) return;

    // Get workspace path from active session
    const sessionId = pane.dataset?.sessionId;
    if (!sessionId) return;

    // Toggle diff viewer
    let viewer = pane.querySelector('.diff-viewer-overlay');
    if (viewer) {
      viewer.remove();
      return;
    }

    showDiffViewer(pane);
  });
}

async function showDiffViewer(paneEl) {
  const viewer = document.createElement('div');
  viewer.className = 'diff-viewer-overlay';
  viewer.innerHTML = `
    <div class="diff-viewer-header">
      <span>Diff Viewer</span>
      <button class="btn btn-secondary" style="padding:2px 8px;font-size:var(--font-size-xs)">Close</button>
    </div>
    <div class="diff-viewer-content">
      <div class="diff-output" style="padding:16px;color:var(--cream-dim);font-size:var(--font-size-sm)">
        No diff data available. Run git diff in the session workspace.
      </div>
    </div>
  `;

  viewer.querySelector('button').addEventListener('click', () => viewer.remove());

  paneEl.appendChild(viewer);
}

export function renderDiff(diffText) {
  if (!diffText) return '<div style="color:var(--cream-faint)">No changes detected.</div>';

  return diffText.split('\n').map(line => {
    let cls = '';
    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'added';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'removed';
    else if (line.startsWith('@@')) cls = 'header';

    return `<div class="diff-line ${cls}">${escapeHtml(line)}</div>`;
  }).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
