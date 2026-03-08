// ── Group Context — Coordination agent with shared folders ─────

import { state } from '../state.js';
import { events } from '../events.js';
import { showToast } from '../notifications/toast.js';

// Track shared folders for each group
const groupFolders = new Map(); // groupId -> { path, logFile }

export function initGroupContext() {
  // Relay command handler — coordination agent sends work summaries
  events.on('group:relay', async ({ fromSessionId, toSessionId, summary }) => {
    const fromSession = state.getSession(fromSessionId);
    const toSession = state.getSession(toSessionId);
    const groupId = fromSession?.groupId;

    // Log correspondence to shared folder
    if (groupId && groupFolders.has(groupId)) {
      const folder = groupFolders.get(groupId);
      try {
        await window.api.group.appendCorrespondence({
          folderPath: folder.path,
          from: fromSession?.name || fromSessionId,
          to: toSession?.name || toSessionId,
          message: summary
        });
      } catch (e) {
        console.log('[GroupContext] Failed to log correspondence:', e.message);
      }
    }

    // Send the coordination message through the agent
    const message = `[Group Coordination Agent]\nSession "${fromSession?.name || fromSessionId}" has shared the following update:\n\n${summary}\n\nPlease review and incorporate this into your current work as needed. Respond with any relevant updates or questions.`;
    window.api.pty.write(toSessionId, message + '\r');
  });

  // Wire up relay buttons on all panes (delegated)
  document.addEventListener('click', async (e) => {
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

    const groupSessions = state.getGroupSessions(session.groupId).filter(s => s.id !== sessionId);
    if (groupSessions.length === 0) {
      showToast({ title: 'No other sessions in group', icon: '&#9888;' });
      return;
    }

    // Ensure shared folder exists for this group
    await ensureGroupFolder(session.groupId);

    const summary = prompt('Describe what this session accomplished (the coordination agent will share this with all group members):');
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
      message: `Coordination agent sent to ${groupSessions.length} member(s)`,
      icon: '&#8594;'
    });
  });

  // When sessions are assigned to panes, update group banners
  events.on('pane:assigned', ({ paneIndex, sessionId }) => {
    updateGroupBanner(paneIndex, sessionId);
  });

  // When a session is added to a group, create shared folder
  events.on('session:updated', ({ sessionId }) => {
    const session = state.getSession(sessionId);
    if (session?.groupId) {
      ensureGroupFolder(session.groupId);
    }
  });
}

async function ensureGroupFolder(groupId) {
  if (groupFolders.has(groupId)) return groupFolders.get(groupId);

  const group = state.getGroup(groupId);
  if (!group) return null;

  const groupSessions = state.getGroupSessions(groupId);
  const memberNames = groupSessions.map(s => s.name || s.id);
  const memberWorkspaces = groupSessions.map(s => s.workspacePath || '');

  try {
    const result = await window.api.group.createSharedFolder({
      groupName: group.name,
      memberNames,
      memberWorkspaces
    });

    if (result.success) {
      groupFolders.set(groupId, { path: result.path, logFile: result.logFile });
      console.log('[GroupContext] Shared folder created:', result.path);

      // Notify all group members about the shared folder
      for (const session of groupSessions) {
        const otherNames = groupSessions.filter(s => s.id !== session.id).map(s => s.name);
        const introMessage = `[Group Coordination Agent]\nYou are now in group "${group.name}" with: ${otherNames.join(', ')}.\nShared workspace folder: ${result.path}\nAll correspondence between group members is logged there. You can reference other members' workspaces in the group folder.`;
        window.api.pty.write(session.id, introMessage + '\r');
      }

      return groupFolders.get(groupId);
    }
  } catch (e) {
    console.error('[GroupContext] Failed to create shared folder:', e);
  }
  return null;
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
  const folderInfo = groupFolders.has(session.groupId) ? ' | Shared folder active' : '';

  banner.innerHTML = `<span style="color:${group.color}">&#9679;</span> ${escapeHtml(group.name)}${otherNames ? ' — with: ' + escapeHtml(otherNames) : ''}${folderInfo}`;
  banner.classList.remove('hidden');
}

export function buildGroupContextPrompt(groupId) {
  const group = state.getGroup(groupId);
  if (!group) return '';

  const sessions = state.getGroupSessions(groupId);
  const contextLines = sessions.map(s => `- ${s.name}: ${s.lastMessage || 'idle'}`).join('\n');
  const folderPath = groupFolders.has(groupId) ? `\nShared folder: ${groupFolders.get(groupId).path}` : '';

  return `[Group Context: ${group.name}]\n${contextLines}${folderPath}\n[End Group Context]`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
