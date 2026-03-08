// ── New Session Form ──────────────────────────────────────

import { events } from '../events.js';
import { createSession } from './session-manager.js';
import { state } from '../state.js';

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

      if (!name) {
        document.getElementById('session-name-input')?.focus();
        return;
      }

      closeModal();

      const session = await createSession({
        name,
        workspacePath,
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

  // Tab key prevention on all modal inputs
  modal?.querySelectorAll('input, textarea, select').forEach(el => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') e.preventDefault();
    });
  });
}
