// ── Group Manager — Session groups with full CRUD ────

import { state } from '../state.js';
import { events } from '../events.js';
import { showToast } from '../notifications/toast.js';

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

  // Re-render groups when sessions change
  events.on('session:added', () => renderGroups());
  events.on('session:removed', () => renderGroups());
  events.on('session:updated', () => renderGroups());
}

async function loadGroups() {
  try {
    const groups = await window.api.group.list();
    for (const group of groups) {
      state.addGroup({
        id: group.id,
        name: group.name,
        color: group.color || GROUP_COLORS[0]
      });
    }
  } catch (e) {
    console.log('[GroupManager] No groups loaded:', e.message);
  }
  renderGroups();
}

function showNewGroupDialog() {
  const listEl = document.getElementById('groups-list');
  if (!listEl) return;

  // Remove any existing create form
  const existingForm = listEl.querySelector('.group-create-form');
  if (existingForm) { existingForm.remove(); return; }

  const form = document.createElement('div');
  form.className = 'group-create-form';

  const colorIndex = state.groups.size % GROUP_COLORS.length;

  form.innerHTML = `
    <div class="group-create-row">
      <div class="group-color-picker">
        ${GROUP_COLORS.map((c, i) =>
          `<span class="group-color-swatch ${i === colorIndex ? 'selected' : ''}" data-color="${c}" style="background:${c}" title="${c}"></span>`
        ).join('')}
      </div>
      <input type="text" class="group-name-input" placeholder="Group name..." autofocus>
    </div>
    <div class="group-create-actions">
      <button class="group-create-ok">Create</button>
      <button class="group-create-cancel">Cancel</button>
    </div>
  `;

  listEl.insertBefore(form, listEl.firstChild);

  let selectedColor = GROUP_COLORS[colorIndex];
  const nameInput = form.querySelector('.group-name-input');
  nameInput.focus();

  // Color swatch clicks
  form.querySelectorAll('.group-color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      form.querySelectorAll('.group-color-swatch').forEach(s => s.classList.remove('selected'));
      swatch.classList.add('selected');
      selectedColor = swatch.dataset.color;
    });
  });

  // Create handler
  const doCreate = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }

    const group = {
      id: `group-${Date.now()}`,
      name,
      color: selectedColor
    };

    try {
      await window.api.group.create(group);
      state.addGroup(group);
      renderGroups();
      updateGroupSelect();
      showToast({ title: 'Group created', message: name, icon: '&#128194;' });
    } catch (e) {
      showToast({ title: 'Failed to create group', message: e.message, icon: '&#9888;' });
    }
  };

  form.querySelector('.group-create-ok').addEventListener('click', doCreate);
  form.querySelector('.group-create-cancel').addEventListener('click', () => form.remove());
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doCreate();
    if (e.key === 'Escape') form.remove();
  });
}

export function renderGroups() {
  const listEl = document.getElementById('groups-list');
  if (!listEl) return;

  // Preserve any open create form
  const existingForm = listEl.querySelector('.group-create-form');
  listEl.innerHTML = '';
  if (existingForm) listEl.appendChild(existingForm);

  if (state.groups.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'groups-empty';
    empty.textContent = 'No groups yet';
    listEl.appendChild(empty);
    return;
  }

  for (const [id, group] of state.groups) {
    const block = document.createElement('div');
    block.className = 'group-block';
    block.dataset.groupId = id;

    // Header row
    const header = document.createElement('div');
    header.className = 'group-block-header';
    header.innerHTML = `
      <span class="group-color" style="background:${group.color}"></span>
      <span class="group-name">${escapeHtml(group.name)}</span>
      <div class="group-actions">
        <button class="group-action-btn group-add-member-btn" title="Add session to group">+</button>
        <button class="group-action-btn group-delete-btn" title="Delete group">&times;</button>
      </div>
    `;
    block.appendChild(header);

    // Members list
    const members = document.createElement('div');
    members.className = 'group-members';

    const sessions = state.getGroupSessions(id);
    if (sessions.length === 0) {
      members.innerHTML = '<div class="group-empty-members">No sessions — click + to add</div>';
    } else {
      for (const session of sessions) {
        const memberEl = document.createElement('div');
        memberEl.className = 'group-member-item';
        memberEl.innerHTML = `
          <span class="session-status-dot ${session.status === 'active' ? 'active' : ''}"></span>
          <span class="group-member-name">${escapeHtml(session.name || session.id)}</span>
          <button class="group-remove-member-btn" data-session-id="${session.id}" title="Remove from group">&times;</button>
        `;

        // Click member to focus that session
        memberEl.addEventListener('click', (e) => {
          if (e.target.closest('.group-remove-member-btn')) return;
          state.setActiveSession(session.id);
          events.emit('session:switchTo', session.id);
        });

        members.appendChild(memberEl);
      }
    }
    block.appendChild(members);

    // --- Event wiring ---

    // Add member button
    header.querySelector('.group-add-member-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      showAddMemberMenu(block, id);
    });

    // Delete group
    header.querySelector('.group-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteGroup(id, group.name);
    });

    // Remove member buttons
    members.querySelectorAll('.group-remove-member-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeSessionFromGroup(btn.dataset.sessionId);
      });
    });

    // Allow header click to toggle collapse
    header.addEventListener('click', (e) => {
      if (e.target.closest('.group-actions')) return;
      members.classList.toggle('collapsed');
      header.classList.toggle('collapsed');
    });

    // Drag-drop: accept sessions dragged onto this group block
    block.addEventListener('dragover', (e) => {
      e.preventDefault();
      block.classList.add('group-drag-over');
      e.dataTransfer.dropEffect = 'move';
    });
    block.addEventListener('dragleave', (e) => {
      if (!block.contains(e.relatedTarget)) {
        block.classList.remove('group-drag-over');
      }
    });
    block.addEventListener('drop', (e) => {
      e.preventDefault();
      block.classList.remove('group-drag-over');
      const sessionId = e.dataTransfer.getData('text/session-id');
      if (sessionId) {
        assignSessionToGroup(sessionId, id);
      }
    });

    listEl.appendChild(block);
  }
}

function showAddMemberMenu(blockEl, groupId) {
  // Remove any existing menu
  document.querySelectorAll('.group-add-menu').forEach(m => m.remove());

  // Get sessions not in this group
  const groupSessionIds = new Set(state.getGroupSessions(groupId).map(s => s.id));
  const available = Array.from(state.sessions.values()).filter(s => !groupSessionIds.has(s.id));

  if (available.length === 0) {
    showToast({ title: 'No available sessions', message: 'All sessions are already in this group', icon: '&#9888;' });
    return;
  }

  const menu = document.createElement('div');
  menu.className = 'group-add-menu';

  for (const session of available) {
    const item = document.createElement('div');
    item.className = 'group-add-menu-item';
    item.innerHTML = `
      <span class="session-status-dot ${session.status === 'active' ? 'active' : ''}"></span>
      <span>${escapeHtml(session.name || session.id)}</span>
      ${session.groupId ? '<span class="group-add-menu-tag">in group</span>' : ''}
    `;
    item.addEventListener('click', () => {
      assignSessionToGroup(session.id, groupId);
      menu.remove();
    });
    menu.appendChild(item);
  }

  blockEl.appendChild(menu);

  // Close menu on outside click
  const closeHandler = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
}

async function assignSessionToGroup(sessionId, groupId) {
  const session = state.getSession(sessionId);
  if (!session) return;

  // Update in state
  state.updateSession(sessionId, { groupId });

  // Persist to DB
  try {
    await window.api.session.update(sessionId, { groupId });
  } catch (e) {
    console.log('[GroupManager] Failed to persist group assignment:', e.message);
  }

  renderGroups();
  updateGroupSelect();
  showToast({
    title: 'Session added to group',
    message: `${session.name || sessionId} → ${state.getGroup(groupId)?.name || groupId}`,
    icon: '&#128279;'
  });
}

async function removeSessionFromGroup(sessionId) {
  const session = state.getSession(sessionId);
  if (!session) return;

  state.updateSession(sessionId, { groupId: null });

  try {
    await window.api.session.update(sessionId, { groupId: null });
  } catch (e) {
    console.log('[GroupManager] Failed to persist group removal:', e.message);
  }

  renderGroups();
  updateGroupSelect();
  showToast({
    title: 'Session removed from group',
    message: session.name || sessionId,
    icon: '&#128275;'
  });
}

async function deleteGroup(groupId, groupName) {
  // Ungroup all sessions in this group first
  const sessions = state.getGroupSessions(groupId);
  for (const session of sessions) {
    state.updateSession(session.id, { groupId: null });
    try {
      await window.api.session.update(session.id, { groupId: null });
    } catch (e) { /* ignore */ }
  }

  // Delete group from state and DB
  state.removeGroup(groupId);
  try {
    await window.api.group.delete(groupId);
  } catch (e) {
    console.log('[GroupManager] Failed to delete group from DB:', e.message);
  }

  renderGroups();
  updateGroupSelect();
  showToast({
    title: 'Group deleted',
    message: groupName,
    icon: '&#128465;'
  });
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
