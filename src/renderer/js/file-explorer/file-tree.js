// ── File Explorer Tree Component ──────────────────────────

import { state } from '../state.js';
import { events } from '../events.js';

const EXT_ICONS = {
  folder: '\u{1F4C1}',
  md: '\u{1F4DD}', json: '\u{2699}', js: 'JS', ts: 'TS', jsx: 'JX', tsx: 'TX',
  css: '#', html: '<>', java: 'J', py: '\u{1F40D}', rs: 'R', go: 'G',
  png: '\u{1F5BC}', jpg: '\u{1F5BC}', gif: '\u{1F5BC}', svg: '\u{1F5BC}',
  default: '\u{1F4C4}'
};

export function initFileExplorer() {
  const selectEl = document.getElementById('explorer-project-select');

  // Populate session dropdown
  function refreshExplorerSelect() {
    if (!selectEl) return;
    const currentVal = selectEl.value;
    selectEl.innerHTML = '<option value="">Select Session...</option>';

    for (const [id, session] of state.sessions) {
      if (session.workspacePath) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = session.name + ' — ' + shortenPath(session.workspacePath);
        selectEl.appendChild(opt);
      }
    }

    // Also add option to browse for a folder
    const browseOpt = document.createElement('option');
    browseOpt.value = '__browse__';
    browseOpt.textContent = '+ Browse folder...';
    selectEl.appendChild(browseOpt);

    // Restore selection
    if (currentVal && selectEl.querySelector(`option[value="${currentVal}"]`)) {
      selectEl.value = currentVal;
    }
  }

  // Handle dropdown change
  if (selectEl) {
    selectEl.addEventListener('change', async () => {
      const val = selectEl.value;
      if (val === '__browse__') {
        const result = await window.api.fs.openFolder();
        if (result && !result.canceled && result.path) {
          loadTree(result.path);
        }
        selectEl.value = '';
      } else if (val) {
        const session = state.getSession(val);
        if (session && session.workspacePath) {
          loadTree(session.workspacePath);
        }
      }
    });
  }

  // Refresh dropdown when sessions change
  events.on('session:added', refreshExplorerSelect);
  events.on('session:removed', refreshExplorerSelect);
  events.on('session:updated', refreshExplorerSelect);

  // Auto-load tree on session activation
  events.on('session:activated', (sessionId) => {
    const session = state.getSession(sessionId);
    if (session && session.workspacePath) {
      loadTree(session.workspacePath);
      if (selectEl) selectEl.value = sessionId;
    }
  });

  // Initial populate
  setTimeout(refreshExplorerSelect, 500);
}

function shortenPath(p) {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : p;
}

export async function loadTree(rootPath) {
  const treeEl = document.getElementById('file-tree');
  if (!treeEl) return;

  treeEl.innerHTML = '<div style="padding:12px;color:var(--cream-faint)">Loading...</div>';

  const entries = await window.api.fs.readDir(rootPath);
  if (entries.error) {
    treeEl.innerHTML = `<div style="padding:12px;color:var(--red)">${entries.error}</div>`;
    return;
  }

  treeEl.innerHTML = '';
  renderEntries(treeEl, entries, rootPath, 0);

  // Update footer
  const footer = document.getElementById('explorer-footer');
  if (footer) {
    const basename = rootPath.split(/[\\/]/).pop();
    footer.textContent = `${basename}`;
  }
}

function renderEntries(container, entries, rootPath, depth) {
  // Sort: dirs first, then files
  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const item = document.createElement('div');
    item.className = `tree-item${entry.isDirectory ? ' directory' : ''}`;
    item.style.paddingLeft = `${8 + depth * 16}px`;

    const ext = entry.isDirectory ? 'folder' : (entry.name.split('.').pop() || 'default');
    const iconClass = ext;

    item.innerHTML = `
      ${entry.isDirectory ? '<span class="tree-toggle">&#9654;</span>' : '<span style="width:14px;display:inline-block"></span>'}
      <span class="tree-icon ${iconClass}">${EXT_ICONS[ext] || EXT_ICONS.default}</span>
      <span class="tree-name">${escapeHtml(entry.name)}</span>
    `;

    if (entry.isDirectory) {
      let expanded = false;
      let childContainer = null;

      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const toggle = item.querySelector('.tree-toggle');

        if (!expanded) {
          const children = await window.api.fs.readDir(entry.path);
          if (!children.error) {
            childContainer = document.createElement('div');
            childContainer.className = 'tree-children';
            renderEntries(childContainer, children, rootPath, depth + 1);
            item.after(childContainer);
          }
          toggle.classList.add('expanded');
          expanded = true;
        } else {
          if (childContainer) {
            childContainer.remove();
            childContainer = null;
          }
          toggle.classList.remove('expanded');
          expanded = false;
        }
      });
    } else {
      item.addEventListener('click', (e) => {
        if (e.ctrlKey) {
          // Insert @path into active pane
          const relativePath = entry.path.replace(rootPath, '').replace(/^[\\/]/, '');
          events.emit('file:insertPath', `@${relativePath}`);
        } else {
          // Open with native app
          events.emit('file:open', entry.path);
        }
      });
    }

    container.appendChild(item);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
