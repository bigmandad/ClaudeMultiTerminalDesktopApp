// ── Group Context — Shared context injection and relay ─────

import { state } from '../state.js';
import { events } from '../events.js';
import { showToast } from '../notifications/toast.js';

export function initGroupContext() {
  // Relay command handler — send work summary between grouped sessions
  events.on('group:relay', async ({ fromSessionId, toSessionId, summary }) => {
    const fromSession = state.getSession(fromSessionId);
    const message = `The session '${fromSession?.name || fromSessionId}' just completed the following work: ${summary}. Can you incorporate or act on this?`;
    window.api.pty.write(toSessionId, message + '\r');
  });

  // Wire up relay buttons on all panes
  document.addEventListener('click', (e) => {
    const relayBtn = e.target.closest('.relay-btn');
    if (!relayBtn) return;

    const pane = relayBtn.closest('.terminal-pane');
    if (!pane) return;

    const paneIndex = parseInt(pane.id.replace('pane-', ''));
    const sessionId = state.paneAssignments[paneIndex];
    if (!sessionId) {
      showToast({ title: 'No session in this pane', icon: '&#9888;' });
      return;
    }

    const session = state.getSession(sessionId);
    if (!session?.groupId) {
      showToast({
        title: 'Not in a group',
        message: 'Assign this session to a group first to relay context.',
        icon: '&#9888;'
      });
      return;
    }

    // Relay to all other sessions in the same group
    const groupSessions = state.getGroupSessions(session.groupId).filter(s => s.id !== sessionId);
    if (groupSessions.length === 0) {
      showToast({ title: 'No other sessions in group', icon: '&#9888;' });
      return;
    }

    const summary = prompt('Describe what this session accomplished (will be shared with group members):');
    if (!summary || !summary.trim()) return;

    for (const target of groupSessions) {
      events.emit('group:relay', {
        fromSessionId: sessionId,
        toSessionId: target.id,
        summary: summary.trim()
      });
    }

    showToast({
      title: 'Context relayed',
      message: `Sent to ${groupSessions.length} session(s) in group`,
      icon: '&#8594;'
    });
  });

  // Update group banner when sessions are assigned
  events.on('pane:assigned', ({ paneIndex, sessionId }) => {
    updateGroupBanner(paneIndex, sessionId);
  });
}

function updateGroupBanner(paneIndex, sessionId) {
  const paneEl = document.getElementById(`pane-${paneIndex}`);
  if (!paneEl) return;

  const banner = paneEl.querySelector('.pane-group-banner');
  if (!banner) return;

  if (!sessionId) {
    banner.classList.add('hidden');
    return;
  }

  const session = state.getSession(sessionId);
  if (!session?.groupId) {
    banner.classList.add('hidden');
    return;
  }

  const group = state.getGroup(session.groupId);
  if (!group) {
    banner.classList.add('hidden');
    return;
  }

  const groupSessions = state.getGroupSessions(session.groupId);
  const otherNames = groupSessions.filter(s => s.id !== sessionId).map(s => s.name).join(', ');

  banner.innerHTML = `<span style="color:${group.color}">&#9679;</span> ${escapeHtml(group.name)}${otherNames ? ' — with: ' + escapeHtml(otherNames) : ''}`;
  banner.classList.remove('hidden');
}

export function buildGroupContextPrompt(groupId) {
  const group = state.getGroup(groupId);
  if (!group) return '';

  const sessions = state.getGroupSessions(groupId);
  const contextLines = sessions.map(s => `- ${s.name}: ${s.lastMessage || 'idle'}`).join('\n');

  return `[Group Context: ${group.name}]\n${contextLines}\n[End Group Context]`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
