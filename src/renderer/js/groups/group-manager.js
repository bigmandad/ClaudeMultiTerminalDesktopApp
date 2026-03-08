// ── Group Manager — Session groups with shared context ────

import { state } from '../state.js';
import { events } from '../events.js';

const GROUP_COLORS = ['#d4845a', '#7ab87a', '#7aa0c8', '#c8a96a', '#c07070', '#a07ab8', '#7ab8b8'];

export function initGroupManager() {
  const newGroupBtn = document.getElementById('new-group-btn');
  if (newGroupBtn) {
    newGroupBtn.addEventListener('click', () => {
      showNewGroupDialog();
    });
  }

  // Load groups from DB
  loadGroups();
}

async function loadGroups() {
  const groups = await window.api.group.list();
  for (const group of groups) {
    state.addGroup({
      id: group.id,
      name: group.name,
      color: group.color || GROUP_COLORS[0]
    });
  }
  renderGroups();
}

function showNewGroupDialog() {
  const name = prompt('Group name:');
  if (!name || !name.trim()) return;

  const colorIndex = state.groups.size % GROUP_COLORS.length;
  const group = {
    id: `group-${Date.now()}`,
    name: name.trim(),
    color: GROUP_COLORS[colorIndex]
  };

  window.api.group.create(group);
  state.addGroup(group);
  renderGroups();
  updateGroupSelect();
}

export function renderGroups() {
  const listEl = document.getElementById('groups-list');
  if (!listEl) return;

  listEl.innerHTML = '';

  for (const [id, group] of state.groups) {
    const header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML = `
      <span class="group-color" style="background:${group.color}"></span>
      <span class="group-name">${escapeHtml(group.name)}</span>
      <span class="group-toggle">&#9660;</span>
    `;
    listEl.appendChild(header);

    // List sessions in this group
    const sessions = state.getGroupSessions(id);
    for (const session of sessions) {
      const item = document.createElement('div');
      item.className = 'session-item';
      item.style.paddingLeft = '28px';
      item.innerHTML = `
        <span class="session-status-dot ${session.status === 'active' ? 'active' : ''}"></span>
        <div class="session-info">
          <div class="session-name">${escapeHtml(session.name)}</div>
        </div>
      `;
      item.addEventListener('click', () => {
        state.setActiveSession(session.id);
        events.emit('session:switchTo', session.id);
      });
      listEl.appendChild(item);
    }
  }
}

export function updateGroupSelect() {
  const select = document.getElementById('session-group-select');
  if (!select) return;

  // Keep "None" option, clear rest
  while (select.options.length > 1) select.remove(1);

  for (const [id, group] of state.groups) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = group.name;
    select.appendChild(option);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
