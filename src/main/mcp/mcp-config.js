const fs = require('fs');
const path = require('path');
const os = require('os');

function readGlobalConfig() {
  // Check multiple MCP config locations (Claude uses ~/.claude/.mcp.json as primary)
  const configPaths = [
    path.join(os.homedir(), '.claude', '.mcp.json'),
    path.join(os.homedir(), '.claude.json')
  ];
  const merged = {};
  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const servers = data.mcpServers || {};
        Object.assign(merged, servers);
      }
    } catch (e) {
      console.warn('Failed to read MCP config at', configPath, ':', e.message);
    }
  }
  return merged;
}

function readWorkspaceConfig(workspacePath) {
  if (!workspacePath) return {};
  const configPath = path.join(workspacePath, '.mcp.json');
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return data.mcpServers || {};
    }
  } catch (e) {
    console.warn('Failed to read workspace MCP config:', e.message);
  }
  return {};
}

function readSettingsPlugins() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      return data.enabledPlugins || [];
    }
  } catch (e) {
    console.warn('Failed to read settings plugins:', e.message);
  }
  return [];
}

function mergeConfigs(workspacePath) {
  const global = readGlobalConfig();
  const workspace = readWorkspaceConfig(workspacePath);
  return { ...global, ...workspace };
}

function writeTempConfig(mergedServers) {
  const tmpDir = path.join(os.tmpdir(), 'claude-sessions');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const tmpFile = path.join(tmpDir, `mcp-config-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ mcpServers: mergedServers }, null, 2));
  return tmpFile;
}

function wrapCommand(command, args) {
  // On Windows, wrap npx commands with cmd /c
  if (process.platform === 'win32' && (command === 'npx' || command.endsWith('npx.cmd'))) {
    return { command: 'cmd', args: ['/c', 'npx', '-y', ...args] };
  }
  return { command, args };
}

module.exports = { readGlobalConfig, readWorkspaceConfig, readSettingsPlugins, mergeConfigs, writeTempConfig, wrapCommand };
