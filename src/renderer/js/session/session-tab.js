// ── Session Tab Bar ───────────────────────────────────────

import { state } from '../state.js';
import { events } from '../events.js';
import { killSession } from './session-manager.js';

const tabsContainer = () => document.getElementById('tabs-container');

export function initTabBar() {
  events.on('session:added', renderTabs);
  events.on('session:removed', renderTabs);
  events.on('session:updated', renderTabs);
  events.on('session:activated', renderTabs);
}

export function renderTabs() {
  const container = tabsContainer();
  if (!container) return;

  container.innerHTML = '';

  for (const [id, session] of state.sessions) {
    const tab = document.createElement('div');
    tab.className = `tab${id === state.activeSessionId ? ' active' : ''}`;
    tab.dataset.sessionId = id;

    const isStopped = session.status === 'stopped' || session.status === 'idle';
    const statusClass = session.status === 'active' ? 'active' :
                        session.status === 'waiting' ? 'waiting' :
                        isStopped ? 'stopped' : '';
    const modeClass = session.mode || 'ask';

    tab.innerHTML = `
      <span class="tab-dot session-status-dot ${statusClass}"></span>
      <span class="tab-name${isStopped ? ' stopped-name' : ''}">${escapeHtml(session.name)}</span>
      ${isStopped ? '<span class="mode-badge stopped">STOPPED</span>' : `<span class="mode-badge ${modeClass}">${(session.mode || 'ASK').toUpperCase()}</span>`}
      ${session.skipPerms ? '<span class="skip-badge">&#9889;</span>' : ''}
      <button class="tab-close" title="Close">&times;</button>
    `;

    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) {
        killSession(id);
        return;
      }
      state.setActiveSession(id);
      events.emit('session:switchTo', id);
    });

    container.appendChild(tab);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
