// ── Group Context — Shared context injection and relay ─────

import { state } from '../state.js';
import { events } from '../events.js';

export function initGroupContext() {
  // Relay command handler
  events.on('group:relay', async ({ fromSessionId, toSessionId, summary }) => {
    const fromSession = state.getSession(fromSessionId);
    const message = `The session '${fromSession?.name || fromSessionId}' just completed the following work: ${summary}. Can you incorporate or act on this?`;
    window.api.pty.write(toSessionId, message + '\r');
  });
}

export function buildGroupContextPrompt(groupId) {
  const group = state.getGroup(groupId);
  if (!group) return '';

  const sessions = state.getGroupSessions(groupId);
  const contextLines = sessions.map(s => `- ${s.name}: ${s.lastMessage || 'idle'}`).join('\n');

  return `[Group Context: ${group.name}]\n${contextLines}\n[End Group Context]`;
}
