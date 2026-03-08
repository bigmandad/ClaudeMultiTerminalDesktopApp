// ── Attachment Popover — Per-pane file attachments ─────────

import { events } from '../events.js';
import { terminalManager } from '../terminal/terminal-manager.js';

export function initAttachments() {
  // Attach button click handler (delegated)
  document.addEventListener('click', async (e) => {
    const attachBtn = e.target.closest('.attach-btn');
    if (!attachBtn) return;

    const pane = attachBtn.closest('.terminal-pane');
    if (!pane) return;

    const inputBar = pane.querySelector('.pane-input-bar');
    togglePopover(pane, inputBar);
  });
}

function togglePopover(paneEl, inputBar) {
  let popover = paneEl.querySelector('.attachment-popover');

  if (popover) {
    popover.remove();
    return;
  }

  popover = document.createElement('div');
  popover.className = 'attachment-popover';
  popover.innerHTML = `
    <div class="attachment-popover-header">
      <span>ADD REFERENCE PATH</span>
      <button class="modal-close" style="font-size:14px">&times;</button>
    </div>
    <div class="attachment-popover-body">
      <div class="input-with-btn">
        <input type="text" class="attachment-path-input" placeholder="Enter file or folder path...">
        <button class="btn btn-primary" style="padding:4px 8px">ADD</button>
      </div>
      <div class="attachment-recent" id="attachment-recent-list">
        <div class="attachment-recent-title">Recent paths</div>
      </div>
    </div>
  `;

  const pathInput = popover.querySelector('.attachment-path-input');
  const addBtn = popover.querySelector('.btn-primary');
  const closeBtn = popover.querySelector('.modal-close');

  // Tab key prevention
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') e.preventDefault();
    if (e.key === 'Enter') {
      addAttachment(paneEl, pathInput.value);
      pathInput.value = '';
    }
    if (e.key === 'Escape') popover.remove();
  });

  addBtn.addEventListener('click', () => {
    addAttachment(paneEl, pathInput.value);
    pathInput.value = '';
  });

  closeBtn.addEventListener('click', () => popover.remove());

  inputBar.style.position = 'relative';
  inputBar.appendChild(popover);

  setTimeout(() => pathInput.focus(), 50);
}

function addAttachment(paneEl, filePath) {
  if (!filePath || !filePath.trim()) return;
  filePath = filePath.trim();

  const pillsContainer = paneEl.querySelector('.attachment-pills');
  if (!pillsContainer) return;

  // Get filename for display
  const filename = filePath.split(/[\\/]/).pop();

  const pill = document.createElement('div');
  pill.className = 'attachment-pill';
  pill.dataset.path = filePath;
  pill.innerHTML = `
    <span>${escapeHtml(filename)}</span>
    <button class="attachment-pill-remove">&times;</button>
  `;

  pill.querySelector('.attachment-pill-remove').addEventListener('click', () => {
    pill.remove();
  });

  pillsContainer.appendChild(pill);
}

export function getAttachments(paneEl) {
  const pills = paneEl.querySelectorAll('.attachment-pill');
  return Array.from(pills).map(p => p.dataset.path);
}

export function formatAttachmentsForInput(attachments) {
  return attachments.map(p => `@${p}`).join(' ');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
