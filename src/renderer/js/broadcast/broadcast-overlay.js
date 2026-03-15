// ── Broadcast Overlay UI ─────────────────────────────────

import { state } from '../state.js';
import { events } from '../events.js';

export function initBroadcastOverlay() {
  const broadcastBtn = document.getElementById('broadcast-btn');
  const overlay = document.getElementById('broadcast-overlay');
  const closeBtn = overlay?.querySelector('.broadcast-close');
  const sendBtn = document.getElementById('broadcast-send-btn');
  const input = document.getElementById('broadcast-input');
  const scopeSelect = document.getElementById('broadcast-scope');

  if (broadcastBtn) {
    broadcastBtn.addEventListener('click', () => {
      overlay?.classList.toggle('hidden');
      if (!overlay?.classList.contains('hidden')) {
        renderTargets();
        input?.focus();
      }
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      overlay?.classList.add('hidden');
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', () => {
      events.emit('broadcast:send');
    });
  }

  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') e.preventDefault();
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        events.emit('broadcast:send');
      }
    });
  }

  if (scopeSelect) {
    scopeSelect.addEventListener('change', () => renderTargets());
  }

  events.on('broadcast:send', () => {
    const message = input?.value?.trim();
    if (!message) return;

    const targetIds = getSelectedTargets();
    events.emit('broadcast:execute', { message, targetIds });

    input.value = '';
    overlay?.classList.add('hidden');
  });
}

function renderTargets() {
  const container = document.getElementById('broadcast-targets');
  const scopeSelect = document.getElementById('broadcast-scope');
  if (!container) return;

  const scope = scopeSelect?.value || 'all';
  container.innerHTML = '';

  let sessions = [];
  if (scope === 'all') {
    sessions = Array.from(state.sessions.values());
  } else if (scope === 'group') {
    const focusedSessionId = state.paneAssignments[state.focusedPaneIndex];
    const focusedSession = focusedSessionId ? state.getSession(focusedSessionId) : null;
    if (focusedSession?.groupId) {
      sessions = Array.from(state.sessions.values()).filter(s => s.groupId === focusedSession.groupId);
    }
  } else {
    sessions = Array.from(state.sessions.values());
  }

  // Filter out stopped/idle sessions — can't write to dead PTYs
  const activeSessions = sessions.filter(s => s.status !== 'stopped' && s.status !== 'idle');

  for (const session of activeSessions) {
    const label = document.createElement('label');
    label.className = 'broadcast-target';
    label.innerHTML = `
      <input type="checkbox" ${scope !== 'manual' ? 'checked' : ''} value="${session.id}">
      <span>${escapeHtml(session.name)}</span>
    `;
    container.appendChild(label);
  }

  // Show hint if some sessions were filtered
  const stoppedCount = sessions.length - activeSessions.length;
  if (stoppedCount > 0) {
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:var(--font-size-xs);color:var(--cream-faint);padding:4px 0;';
    hint.textContent = `${stoppedCount} stopped session(s) hidden`;
    container.appendChild(hint);
  }
}

function getSelectedTargets() {
  return Array.from(
    document.querySelectorAll('#broadcast-targets input[type="checkbox"]:checked')
  ).map(cb => cb.value);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
