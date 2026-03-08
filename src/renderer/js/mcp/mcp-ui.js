// ── MCP UI — sidebar MCP server management panel ────────

import { state } from '../state.js';
import { events } from '../events.js';
import { showToast } from '../notifications/toast.js';

export function initMcpUI() {
  renderPluginsList();

  // Listen for MCP status updates
  const cleanup = window.api.mcp.onServerStatus((status) => {
    updateMcpDot(status);
    renderPluginsList();
  });

  // Add plugin button
  const addBtn = document.getElementById('add-plugin-btn');
  if (addBtn) {
    addBtn.addEventListener('click', showAddPluginFlow);
  }

  // Initial status check
  loadInitialStatus();

  // Also detect plugins on init
  detectPlugins();
}

async function loadInitialStatus() {
  try {
    const status = await window.api.mcp.status();
    updateMcpDot(status);
  } catch (e) {
    // No servers running yet
  }
}

function updateMcpDot(status) {
  const dot = document.getElementById('mcp-global-dot');
  if (!dot) return;

  let allConnected = true;
  let anyRunning = false;
  const statusObj = typeof status === 'object' ? status : {};

  for (const [name, info] of Object.entries(statusObj)) {
    anyRunning = true;
    if (info.status !== 'connected') allConnected = false;
  }

  if (!anyRunning) {
    dot.style.background = 'var(--charcoal-light)';
    dot.title = 'No MCP servers';
  } else if (allConnected) {
    dot.style.background = 'var(--green)';
    dot.title = 'All MCP servers connected';
  } else {
    dot.style.background = 'var(--yellow)';
    dot.title = 'Some MCP servers not connected';
  }
}

let detectedPlugins = [];

async function detectPlugins() {
  try {
    const result = await window.api.plugins.detect();
    detectedPlugins = result?.plugins || [];
    renderPluginsList();
  } catch (e) {
    console.log('[MCP-UI] plugin detection error:', e.message);
  }
}

async function renderPluginsList() {
  const container = document.getElementById('plugins-list');
  if (!container) return;

  try {
    const config = await window.api.mcp.getConfig();
    const status = await window.api.mcp.status();
    const servers = config?.mcpServers || config || {};

    container.innerHTML = '';

    const names = Object.keys(servers);

    // Section: MCP Servers
    if (names.length > 0) {
      const sectionHeader = document.createElement('div');
      sectionHeader.className = 'plugin-section-header';
      sectionHeader.innerHTML = '<span>MCP Servers</span>';
      container.appendChild(sectionHeader);

      for (const name of names) {
        const serverStatus = status[name] || {};
        const isConnected = serverStatus.status === 'connected';
        const dotColor = isConnected ? 'var(--green)' :
                         serverStatus.status === 'starting' ? 'var(--yellow)' : 'var(--charcoal-light)';

        const item = document.createElement('div');
        item.className = 'plugin-item';
        item.innerHTML = `
          <div class="plugin-item-header">
            <span class="plugin-dot" style="background:${dotColor}"></span>
            <span class="plugin-name">${escapeHtml(name)}</span>
            <button class="plugin-toggle-btn" data-server="${escapeHtml(name)}" title="${isConnected ? 'Stop' : 'Start'}">
              ${isConnected ? '&#9632;' : '&#9654;'}
            </button>
          </div>
        `;
        container.appendChild(item);
      }

      // Toggle buttons
      container.querySelectorAll('.plugin-toggle-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const serverName = btn.dataset.server;
          try {
            const st = await window.api.mcp.status();
            if (st[serverName]?.status === 'connected') {
              await window.api.mcp.stopServer(serverName);
              showToast({ title: `Stopped ${serverName}`, icon: '&#9632;' });
            } else {
              const cfg = await window.api.mcp.getConfig();
              const serverCfg = cfg?.mcpServers?.[serverName] || cfg?.[serverName];
              if (serverCfg) {
                await window.api.mcp.startServer({ name: serverName, ...serverCfg });
                showToast({ title: `Started ${serverName}`, icon: '&#9654;' });
              }
            }
            renderPluginsList();
          } catch (e) {
            showToast({ title: `Error: ${e.message}`, icon: '&#9888;' });
          }
        });
      });
    }

    // Section: Detected Plugins / Commands
    if (detectedPlugins.length > 0) {
      const sectionHeader = document.createElement('div');
      sectionHeader.className = 'plugin-section-header';
      sectionHeader.style.marginTop = names.length > 0 ? '12px' : '0';
      sectionHeader.innerHTML = '<span>Detected Plugins</span>';
      container.appendChild(sectionHeader);

      for (const plugin of detectedPlugins) {
        const typeBadge = plugin.type === 'command' ? 'CMD' :
                          plugin.type === 'script' ? 'JS' : 'PLG';
        const typeColor = plugin.type === 'command' ? 'var(--blue)' :
                          plugin.type === 'script' ? 'var(--yellow)' : 'var(--orange)';

        const item = document.createElement('div');
        item.className = 'plugin-item';
        item.innerHTML = `
          <div class="plugin-item-header">
            <span class="plugin-type-tag" style="color:${typeColor};font-size:8px;font-weight:700;margin-right:4px">${typeBadge}</span>
            <span class="plugin-name" style="flex:1">${escapeHtml(plugin.name)}</span>
          </div>
          ${plugin.description ? `<div class="plugin-desc" style="font-size:var(--font-size-xs);color:var(--cream-faint);padding:0 6px 4px 22px">${escapeHtml(plugin.description)}</div>` : ''}
        `;
        container.appendChild(item);
      }
    }

    // Empty state
    if (names.length === 0 && detectedPlugins.length === 0) {
      container.innerHTML = `
        <div style="padding:12px;color:var(--cream-faint);font-size:var(--font-size-sm);text-align:center">
          No MCP servers or plugins detected.<br>
          Add servers to <code style="background:var(--bg-deep);padding:1px 4px;border-radius:3px">~/.claude.json</code>
        </div>
      `;
    }
  } catch (e) {
    container.innerHTML = `<div style="padding:12px;color:var(--red);font-size:var(--font-size-sm)">${e.message}</div>`;
  }
}

async function showAddPluginFlow() {
  showToast({
    title: 'Add MCP Server',
    message: 'Edit ~/.claude.json to add MCP server configurations.',
    icon: '&#10033;'
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
