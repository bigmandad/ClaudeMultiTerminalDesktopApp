// ── Diff Viewer Panel ─────────────────────────────────────

import { state } from '../state.js';
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

    await showDiffViewer(pane, sessionId);
  });
}

async function showDiffViewer(paneEl, sessionId) {
  const session = state.getSession(sessionId);
  const workspacePath = session?.workspacePath;

  const viewer = document.createElement('div');
  viewer.className = 'diff-viewer-overlay';
  viewer.innerHTML = `
    <div class="diff-viewer-header">
      <span>Diff Viewer${workspacePath ? ' — ' + escapeHtml(workspacePath.split(/[\\/]/).pop()) : ''}</span>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="btn btn-secondary diff-refresh-btn" style="padding:2px 8px;font-size:var(--font-size-xs)">Refresh</button>
        <button class="btn btn-secondary diff-close-btn" style="padding:2px 8px;font-size:var(--font-size-xs)">Close</button>
      </div>
    </div>
    <div class="diff-viewer-content">
      <div class="diff-output" style="padding:16px;color:var(--cream-dim);font-size:var(--font-size-sm)">
        Loading diff...
      </div>
    </div>
  `;

  viewer.querySelector('.diff-close-btn').addEventListener('click', () => viewer.remove());
  viewer.querySelector('.diff-refresh-btn').addEventListener('click', () => loadDiff(viewer, workspacePath, sessionId));

  paneEl.appendChild(viewer);

  await loadDiff(viewer, workspacePath, sessionId);
}

async function loadDiff(viewer, workspacePath, sessionId) {
  const outputEl = viewer.querySelector('.diff-output');

  if (!workspacePath) {
    outputEl.innerHTML = '<div style="color:var(--cream-faint)">No workspace path set for this session. Open a project folder to view diffs.</div>';
    return;
  }

  try {
    // Check if it's a git repo
    const isRepo = await window.api.git.isRepo(workspacePath);
    if (!isRepo) {
      outputEl.innerHTML = '<div style="color:var(--cream-faint)">Not a git repository. Initialize with <code style="background:var(--bg-deep);padding:1px 4px;border-radius:3px">git init</code></div>';
      return;
    }

    // Fetch full diff
    const diffText = await window.api.git.diffFull(workspacePath);
    if (!diffText || diffText.trim().length === 0) {
      outputEl.innerHTML = '<div style="color:var(--cream-faint)">No uncommitted changes detected.</div>';
      // Also emit empty diff stats
      events.emit('diff:stats', { sessionId, additions: 0, deletions: 0 });
      return;
    }

    // Count additions/deletions for badge
    let additions = 0, deletions = 0;
    for (const line of diffText.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }
    events.emit('diff:stats', { sessionId, additions, deletions });

    // Render the diff
    outputEl.innerHTML = renderDiff(diffText);
  } catch (err) {
    outputEl.innerHTML = `<div style="color:var(--red)">Error loading diff: ${escapeHtml(err.message)}</div>`;
  }
}

export function renderDiff(diffText) {
  if (!diffText) return '<div style="color:var(--cream-faint)">No changes detected.</div>';

  return diffText.split('\n').map(line => {
    let cls = '';
    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'added';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'removed';
    else if (line.startsWith('@@')) cls = 'header';
    else if (line.startsWith('diff --git')) cls = 'header';

    return `<div class="diff-line ${cls}">${escapeHtml(line)}</div>`;
  }).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
