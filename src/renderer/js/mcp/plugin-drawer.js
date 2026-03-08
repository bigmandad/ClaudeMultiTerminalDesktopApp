// ── Plugin Drawer — Per-pane MCP tool list ────────────────

import { events } from '../events.js';

export function initPluginDrawer() {
  // Plugin button click handler (delegated)
  document.addEventListener('click', async (e) => {
    const pluginBtn = e.target.closest('.plugin-btn');
    if (!pluginBtn) return;

    const pane = pluginBtn.closest('.terminal-pane');
    if (!pane) return;

    toggleDrawer(pane);
  });
}

async function toggleDrawer(paneEl) {
  let drawer = paneEl.querySelector('.plugin-drawer');

  if (drawer) {
    drawer.remove();
    return;
  }

  drawer = document.createElement('div');
  drawer.className = 'plugin-drawer';

  // Load tools from MCP
  const tools = await window.api.mcp.allTools();
  const status = await window.api.mcp.status();

  // Group tools by server
  const serverGroups = {};
  for (const tool of tools) {
    if (!serverGroups[tool.serverName]) {
      serverGroups[tool.serverName] = [];
    }
    serverGroups[tool.serverName].push(tool);
  }

  const serverNames = Object.keys(serverGroups);

  if (serverNames.length === 0) {
    drawer.innerHTML = `
      <div style="padding:16px;color:var(--cream-faint);font-size:var(--font-size-sm);text-align:center">
        No MCP servers connected.<br>
        Configure servers in ~/.claude.json
      </div>
    `;
  } else {
    let tabsHtml = '';
    let contentHtml = '';

    for (let i = 0; i < serverNames.length; i++) {
      const name = serverNames[i];
      const serverTools = serverGroups[name];
      const isActive = i === 0 ? ' active' : '';
      const statusInfo = status[name] || {};
      const statusDot = statusInfo.status === 'connected' ? 'var(--green)' :
                        statusInfo.status === 'starting' ? 'var(--yellow)' : 'var(--red)';

      tabsHtml += `<button class="plugin-drawer-tab${isActive}" data-server="${name}">
        <span style="width:6px;height:6px;border-radius:50%;background:${statusDot};display:inline-block;margin-right:4px"></span>
        ${escapeHtml(name)}
      </button>`;

      let cardsHtml = '';
      for (const tool of serverTools) {
        cardsHtml += `
          <div class="tool-card" data-tool-name="${escapeHtml(tool.name)}">
            <span class="tool-type-badge tool">TOOL</span>
            <div class="tool-info">
              <div class="tool-name">/${escapeHtml(tool.name)}</div>
              <div class="tool-desc">${escapeHtml(tool.description || 'No description')}</div>
            </div>
          </div>
        `;
      }

      contentHtml += `<div class="plugin-drawer-server${isActive ? '' : ' hidden'}" data-server="${name}">${cardsHtml}</div>`;
    }

    drawer.innerHTML = `
      <div class="plugin-drawer-tabs">${tabsHtml}</div>
      <div class="plugin-drawer-content">${contentHtml}</div>
    `;

    // Tab switching
    drawer.querySelectorAll('.plugin-drawer-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        drawer.querySelectorAll('.plugin-drawer-tab').forEach(t => t.classList.remove('active'));
        drawer.querySelectorAll('.plugin-drawer-server').forEach(s => s.classList.add('hidden'));
        tab.classList.add('active');
        drawer.querySelector(`.plugin-drawer-server[data-server="${tab.dataset.server}"]`)?.classList.remove('hidden');
      });
    });

    // Tool card click -> insert command
    drawer.querySelectorAll('.tool-card').forEach(card => {
      card.addEventListener('click', () => {
        const toolName = card.dataset.toolName;
        const input = paneEl.querySelector('.pane-input');
        if (input) {
          input.value = `/${toolName} `;
          input.focus();
        }
        drawer.remove();
      });
    });
  }

  const inputBar = paneEl.querySelector('.pane-input-bar');
  inputBar.style.position = 'relative';
  inputBar.appendChild(drawer);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
