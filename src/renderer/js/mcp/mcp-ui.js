// ── MCP UI — sidebar plugins & MCP server panel ────────

import { state } from '../state.js';
import { events } from '../events.js';
import { showToast } from '../notifications/toast.js';

let detectedPlugins = [];
let pluginData = null;

export function initMcpUI() {
  renderPluginsList();

  window.api.mcp.onServerStatus((status) => {
    updateMcpDot(status);
    renderPluginsList();
  });

  const addBtn = document.getElementById('add-plugin-btn');
  if (addBtn) {
    addBtn.addEventListener('click', showUploadDialog);
  }

  loadInitialStatus();
  detectPlugins();

  events.on('session:added', () => renderPluginsList());
  events.on('session:removed', () => renderPluginsList());
}

async function loadInitialStatus() {
  try {
    const status = await window.api.mcp.status();
    updateMcpDot(status);
  } catch (e) { /* no servers */ }
}

function updateMcpDot(status) {
  const dot = document.getElementById('mcp-global-dot');
  if (!dot) return;
  let allConnected = true, anyRunning = false;
  const statusObj = typeof status === 'object' ? status : {};
  for (const info of Object.values(statusObj)) {
    anyRunning = true;
    if (info.status !== 'connected') allConnected = false;
  }
  dot.style.background = !anyRunning ? 'var(--charcoal-light)' :
                          allConnected ? 'var(--green)' : 'var(--yellow)';
  dot.title = !anyRunning ? 'No MCP servers' :
              allConnected ? 'All MCP servers connected' : 'Some MCP servers not connected';
}

async function detectPlugins() {
  try {
    pluginData = await window.api.plugins.detect();
    detectedPlugins = pluginData?.plugins || [];
    renderPluginsList();
  } catch (e) {
    console.log('[MCP-UI] plugin detection error:', e.message);
  }
}

async function togglePlugin(pluginId, currentlyEnabled) {
  const newState = !currentlyEnabled;
  try {
    const result = await window.api.plugins.toggle(pluginId, newState);
    if (result.success) {
      showToast({
        title: `${pluginId.split('@')[0]} ${newState ? 'enabled' : 'disabled'}`,
        message: newState ? 'Plugin will be active in new sessions.' : 'Plugin will be inactive in new sessions.',
        icon: newState ? '&#9989;' : '&#10060;'
      });
      // Refresh detection
      await detectPlugins();
    } else {
      showToast({ title: 'Error: ' + result.error, icon: '&#9888;' });
    }
  } catch (e) {
    showToast({ title: 'Error: ' + e.message, icon: '&#9888;' });
  }
}

async function showUploadDialog() {
  try {
    const result = await window.api.fs.openFile({
      filters: [
        { name: 'Plugin Files', extensions: ['js', 'md', 'zip'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.paths || result.paths.length === 0) return;

    const uploadResult = await window.api.plugins.upload({ filePaths: result.paths });
    if (uploadResult.success) {
      const uploaded = uploadResult.results.filter(r => !r.error);
      const errors = uploadResult.results.filter(r => r.error);

      if (uploaded.length > 0) {
        showToast({
          title: `Uploaded ${uploaded.length} plugin(s)`,
          message: uploaded.map(r => r.name).join(', '),
          icon: '&#10033;'
        });
      }
      if (errors.length > 0) {
        showToast({
          title: `${errors.length} upload error(s)`,
          message: errors.map(r => `${r.name}: ${r.error}`).join('; '),
          icon: '&#9888;'
        });
      }
      // Refresh
      await detectPlugins();
    }
  } catch (e) {
    showToast({ title: 'Upload failed: ' + e.message, icon: '&#9888;' });
  }
}

async function renderPluginsList() {
  const container = document.getElementById('plugins-list');
  if (!container) return;

  try {
    const config = await window.api.mcp.getConfig();
    const status = await window.api.mcp.status();
    const servers = config?.mcpServers || config || {};
    const serverNames = Object.keys(servers);

    container.innerHTML = '';

    // ── Section: Installed Plugins ────────────────────────
    const installedPlugins = detectedPlugins.filter(p => p.id && !p.id.startsWith('command:'));
    if (installedPlugins.length > 0) {
      const header = document.createElement('div');
      header.className = 'plugin-section-header';
      header.innerHTML = `<span>Installed Plugins (${installedPlugins.length})</span>`;
      container.appendChild(header);

      for (const plugin of installedPlugins) {
        const item = document.createElement('div');
        item.className = 'plugin-item' + (plugin.enabled ? ' enabled' : '');
        const sourceLabel = plugin.source === 'claude-plugins-official' ? 'Official' :
                            plugin.source === 'local-desktop-app-uploads' ? 'Local' : plugin.source;

        item.innerHTML = `
          <div class="plugin-item-header">
            <span class="plugin-dot" style="background:${plugin.enabled ? 'var(--green)' : 'var(--cream-faint)'}"></span>
            <span class="plugin-name" style="flex:1">${escapeHtml(plugin.name)}</span>
            <button class="plugin-on-off-btn ${plugin.enabled ? 'is-on' : 'is-off'}" data-plugin-id="${escapeHtml(plugin.id)}" data-enabled="${plugin.enabled ? 'true' : 'false'}" title="${plugin.enabled ? 'Click to disable' : 'Click to enable'}">
              ${plugin.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          <div class="plugin-meta">
            <span class="plugin-source">${escapeHtml(sourceLabel)}</span>
            ${plugin.version ? `<span class="plugin-version">v${escapeHtml(plugin.version)}</span>` : ''}
          </div>
          ${plugin.description ? `<div class="plugin-desc">${escapeHtml(plugin.description)}</div>` : ''}
        `;
        container.appendChild(item);
      }

      // Wire toggle buttons
      container.querySelectorAll('.plugin-on-off-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const pluginId = btn.dataset.pluginId;
          const isEnabled = btn.dataset.enabled === 'true';
          togglePlugin(pluginId, isEnabled);
        });
      });
    }

    // ── Section: Custom Commands ──────────────────────────
    const commands = detectedPlugins.filter(p => p.id && p.id.startsWith('command:'));
    if (commands.length > 0) {
      const header = document.createElement('div');
      header.className = 'plugin-section-header';
      header.style.marginTop = installedPlugins.length > 0 ? '12px' : '0';
      header.innerHTML = `<span>Custom Commands (${commands.length})</span>`;
      container.appendChild(header);

      for (const cmd of commands) {
        const item = document.createElement('div');
        item.className = 'plugin-item';
        item.innerHTML = `
          <div class="plugin-item-header">
            <span class="plugin-type-tag cmd-tag">CMD</span>
            <span class="plugin-name" style="flex:1">${escapeHtml(cmd.name)}</span>
          </div>
        `;
        container.appendChild(item);
      }
    }

    // ── Section: MCP Servers ─────────────────────────────
    if (serverNames.length > 0) {
      const header = document.createElement('div');
      header.className = 'plugin-section-header';
      header.style.marginTop = (installedPlugins.length > 0 || commands.length > 0) ? '12px' : '0';
      header.innerHTML = `<span>MCP Servers (${serverNames.length})</span>`;
      container.appendChild(header);

      for (const name of serverNames) {
        const serverStatus = status[name] || {};
        const isConnected = serverStatus.status === 'connected';
        const dotColor = isConnected ? 'var(--green)' :
                         serverStatus.status === 'starting' ? 'var(--yellow)' : 'var(--charcoal-light)';

        const item = document.createElement('div');
        item.className = 'plugin-item';
        item.innerHTML = `
          <div class="plugin-item-header">
            <span class="plugin-dot" style="background:${dotColor}"></span>
            <span class="plugin-name" style="flex:1">${escapeHtml(name)}</span>
            <button class="plugin-toggle-btn" data-server="${escapeHtml(name)}" title="${isConnected ? 'Stop' : 'Start'}">
              ${isConnected ? '&#9632;' : '&#9654;'}
            </button>
          </div>
        `;
        container.appendChild(item);
      }

      container.querySelectorAll('.plugin-toggle-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
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

    // ── Empty state ──────────────────────────────────────
    if (serverNames.length === 0 && detectedPlugins.length === 0) {
      container.innerHTML = `
        <div style="padding:16px;color:var(--cream-faint);font-size:var(--font-size-sm);text-align:center">
          No plugins or MCP servers detected.<br><br>
          <span style="font-size:var(--font-size-xs)">
            Click <strong>+</strong> above to upload a plugin, or<br>
            run <code style="background:var(--bg-deep);padding:1px 4px;border-radius:3px">claude plugin add</code> in a session
          </span>
        </div>
      `;
    }
  } catch (e) {
    container.innerHTML = `<div style="padding:12px;color:var(--red);font-size:var(--font-size-sm)">${e.message}</div>`;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
