// ── Left Panel — Session list ─────────────────────────────

import { state } from '../state.js';
import { events } from '../events.js';

export function initLeftPanel() {
  events.on('session:added', renderSessionList);
  events.on('session:removed', renderSessionList);
  events.on('session:updated', renderSessionList);
  events.on('session:activated', renderSessionList);
}

export function renderSessionList() {
  const listEl = document.getElementById('sessions-list');
  if (!listEl) return;

  listEl.innerHTML = '';

  for (const [id, session] of state.sessions) {
    const item = document.createElement('div');
    item.className = `session-item${id === state.activeSessionId ? ' active' : ''}`;
    item.dataset.sessionId = id;

    const isStopped = session.status === 'stopped' || session.status === 'idle';
    const statusClass = session.status === 'active' ? 'active' :
                        session.status === 'waiting' ? 'waiting' :
                        isStopped ? 'stopped' : '';
    const modeClass = session.mode || 'ask';

    let groupDot = '';
    if (session.groupId) {
      const group = state.getGroup(session.groupId);
      if (group) {
        groupDot = `<span class="group-swatch" style="background:${group.color}"></span>`;
      }
    }

    // Make draggable for group drag-drop
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/session-id', id);
      e.dataTransfer.effectAllowed = 'move';
    });

    const previewText = isStopped ? (session.workspacePath || 'Click to resume') :
                        (session.lastMessage || session.workspacePath || '');

    item.innerHTML = `
      <span class="session-status-dot ${statusClass}"></span>
      <div class="session-info">
        <div class="session-name${isStopped ? ' stopped-name' : ''}">${escapeHtml(session.name)}</div>
        <div class="session-preview">${escapeHtml(previewText)}</div>
      </div>
      <div class="session-badges">
        ${isStopped ? '<span class="mode-badge stopped">STOPPED</span>' : `<span class="mode-badge ${modeClass}">${(session.mode || 'ASK').toUpperCase()}</span>`}
        ${session.skipPerms ? '<span class="skip-badge">&#9889;</span>' : ''}
        ${groupDot}
      </div>
      <button class="session-archive-btn" title="Archive">&times;</button>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('session-archive-btn')) {
        events.emit('session:archive', id);
        return;
      }
      state.setActiveSession(id);
      events.emit('session:switchTo', id);
    });

    listEl.appendChild(item);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
