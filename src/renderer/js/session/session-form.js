// ── New Session Form ──────────────────────────────────────

import { events } from '../events.js';
import { createSession } from './session-manager.js';
import { state } from '../state.js';
import { showToast } from '../notifications/toast.js';

export function initSessionForm() {
  const modal = document.getElementById('new-session-modal');
  const newSessionBtn = document.getElementById('new-session-btn');
  const tabNewBtn = document.getElementById('tab-new-btn');
  const launchBtn = document.getElementById('launch-session-btn');
  const browseBtn = document.getElementById('browse-path-btn');
  const closeBtn = modal?.querySelector('.modal-close');
  const cancelBtn = modal?.querySelector('.modal-cancel');

  function openModal() {
    if (modal) modal.classList.remove('hidden');
    const nameInput = document.getElementById('session-name-input');
    if (nameInput) {
      nameInput.value = '';
      nameInput.focus();
    }
  }

  function closeModal() {
    if (modal) modal.classList.add('hidden');
  }

  if (newSessionBtn) newSessionBtn.addEventListener('click', openModal);
  if (tabNewBtn) tabNewBtn.addEventListener('click', openModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  // Browse workspace path
  if (browseBtn) {
    browseBtn.addEventListener('click', async () => {
      const result = await window.api.fs.openFolder();
      if (result && !result.canceled && result.path) {
        document.getElementById('session-path-input').value = result.path;
      }
    });
  }

  // Launch session
  if (launchBtn) {
    launchBtn.addEventListener('click', async () => {
      const name = document.getElementById('session-name-input')?.value?.trim();
      const workspacePath = document.getElementById('session-path-input')?.value?.trim();
      const mode = document.getElementById('session-mode-select')?.value || 'ask';
      const skipPerms = document.getElementById('session-skip-perms')?.checked || false;
      const groupId = document.getElementById('session-group-select')?.value || null;
      const useWorktree = document.getElementById('session-git-worktree')?.checked || false;
      const createGithubRepo = document.getElementById('session-github-repo')?.checked || false;

      if (!name) {
        document.getElementById('session-name-input')?.focus();
        return;
      }

      closeModal();

      // Git worktree: create a worktree branch before session launch
      let effectivePath = workspacePath;
      if (useWorktree && workspacePath) {
        try {
          const wtResult = await window.api.git.createWorktree(workspacePath, name);
          if (wtResult && wtResult.worktreePath) {
            effectivePath = wtResult.worktreePath;
            showToast({ title: 'Git worktree created', message: wtResult.branch || '', icon: '&#128268;' });
          }
        } catch (wtErr) {
          showToast({ title: 'Worktree failed', message: wtErr.message || String(wtErr), icon: '&#9888;' });
        }
      }

      // GitHub repo: create a new repo for the workspace
      if (createGithubRepo && workspacePath) {
        try {
          const repoResult = await window.api.git.createRepo({ name, cwd: workspacePath });
          if (repoResult && repoResult.success) {
            showToast({ title: 'GitHub repo created', message: repoResult.url || '', icon: '&#128230;' });
          }
        } catch (repoErr) {
          showToast({ title: 'Repo creation failed', message: repoErr.message || String(repoErr), icon: '&#9888;' });
        }
      }

      const session = await createSession({
        name,
        workspacePath: effectivePath,
        mode,
        skipPerms,
        groupId: groupId || null
      });

      // Activate and assign to focused pane
      state.setActiveSession(session.id);
      events.emit('session:assignToPane', {
        sessionId: session.id,
        paneIndex: state.focusedPaneIndex
      });
    });
  }

  // Escape to close
  if (modal) {
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }

  // ── Knowledge Context Suggestions ──────────────────────
  const pathInput = document.getElementById('session-path-input');
  let knowledgeDebounce = null;

  async function suggestKnowledge() {
    const suggestionsEl = document.getElementById('knowledge-context-suggestions');
    if (!suggestionsEl) return;

    const workspacePath = pathInput?.value?.trim();
    if (!workspacePath || workspacePath.length < 3) {
      suggestionsEl.innerHTML = '<div class="knowledge-ctx-hint">Relevant knowledge will appear when you set a workspace path.</div>';
      return;
    }

    suggestionsEl.innerHTML = '<div class="knowledge-ctx-hint">Searching knowledge base...</div>';

    try {
      // Extract project name from path for search query
      const projectName = workspacePath.split(/[/\\]/).filter(Boolean).pop() || workspacePath;
      const results = await window.api.openviking.search(projectName, { topK: 5, tier: 'L0' });

      // Parse nested response
      let items = [];
      if (results && typeof results === 'object' && !Array.isArray(results)) {
        items = [...(results.resources || []), ...(results.memories || [])].filter(r =>
          r.uri && !r.uri.endsWith('/.abstract.md') && !r.uri.endsWith('/.overview.md')
        );
      }

      if (items.length === 0) {
        suggestionsEl.innerHTML = '<div class="knowledge-ctx-hint">No relevant knowledge found for this workspace.</div>';
        return;
      }

      let html = '';
      for (const item of items.slice(0, 4)) {
        const uri = item.uri || '';
        const name = uri.split('/').filter(Boolean).pop() || uri;
        const abstract = item.abstract || item.overview || '';
        const score = item.score ? `${(item.score * 100).toFixed(0)}%` : '';
        html += `<div class="knowledge-ctx-chip" data-uri="${escapeHtml(uri)}" title="${escapeHtml(abstract)}">
          <span class="knowledge-ctx-name">${escapeHtml(name)}</span>
          <span class="knowledge-ctx-score">${score}</span>
        </div>`;
      }
      suggestionsEl.innerHTML = html;
    } catch {
      suggestionsEl.innerHTML = '<div class="knowledge-ctx-hint">OpenViking not available.</div>';
    }
  }

  if (pathInput) {
    pathInput.addEventListener('input', () => {
      clearTimeout(knowledgeDebounce);
      knowledgeDebounce = setTimeout(suggestKnowledge, 500);
    });
    pathInput.addEventListener('change', suggestKnowledge);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Tab key prevention on all modal inputs
  modal?.querySelectorAll('input, textarea, select').forEach(el => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') e.preventDefault();
    });
  });
}
