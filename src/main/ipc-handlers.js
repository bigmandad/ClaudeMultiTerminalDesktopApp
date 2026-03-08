const { dialog, shell, Notification, clipboard } = require('electron');
const { PtyManager } = require('./pty/pty-manager');
const db = require('./db/database');
const { Transcriber } = require('./transcription/transcriber');
const { McpManager } = require('./mcp/mcp-manager');
const { mergeConfigs, readGlobalConfig, writeTempConfig } = require('./mcp/mcp-config');
const { readDirectory } = require('./fs/file-explorer');
const { detectClaudeMd, generateFileMap } = require('./fs/workspace');
const gitOps = require('./git/git-ops');
const { Notifier } = require('./notifications/notifier');
const path = require('path');
const fs = require('fs');
const os = require('os');

const transcriber = new Transcriber();
const mcpManager = new McpManager();
const notifier = new Notifier();

function registerIpcHandlers(ipcMain) {
  const { getMainWindow } = require('./main');

  // Initialize database
  db.init();

  // ── PTY Handlers ──────────────────────────────────────────

  ipcMain.handle('pty:spawn', (event, opts) => {
    console.log('[Main:pty:spawn] id=' + opts.id, 'cwd=' + (opts.cwd || 'default'), 'launchClaude=' + (opts.launchClaude !== false));
    try {
      const session = PtyManager.create(opts.id, {
        cwd: opts.cwd || os.homedir(),
        cols: opts.cols || 120,
        rows: opts.rows || 30,
        mode: opts.mode,
        skipPerms: opts.skipPerms,
        model: opts.model,
        mcpConfig: opts.mcpConfig,
        resume: opts.resume,
        systemPrompt: opts.systemPrompt,
        launchClaude: opts.launchClaude !== false
      });
      console.log('[Main:pty:spawn] PtySession created');

      // Start transcription for this session
      try {
        transcriber.startSession(opts.id, {
          name: opts.name || opts.id,
          workspacePath: opts.cwd,
          mode: opts.mode,
          skipPerms: opts.skipPerms
        });
      } catch (tErr) {
        console.error('[Main:pty:spawn] transcription start failed (non-fatal):', tErr.message);
      }

      let dataPackets = 0;
      session.onDataCallback = (data) => {
        dataPackets++;
        if (dataPackets <= 3) {
          console.log('[Main:pty:data] id=' + opts.id, 'packet#' + dataPackets, 'bytes=' + data.length);
        }
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('pty:data', { id: opts.id, data });
        }
        // Write to transcript
        try { transcriber.write(opts.id, data); } catch(e) { /* ignore */ }
      };

      session.onExitCallback = (exitCode) => {
        console.log('[Main:pty:exit] id=' + opts.id, 'code=' + exitCode);
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('pty:exit', { id: opts.id, exitCode });
        }
        try { transcriber.endSession(opts.id); } catch(e) { /* ignore */ }
      };

      session.spawn();
      console.log('[Main:pty:spawn] PTY spawned successfully for', opts.id);
      return { success: true };
    } catch (error) {
      console.error('[Main:pty:spawn] ERROR:', error.message, error.stack);
      return { success: false, error: error.message };
    }
  });

  ipcMain.on('pty:write', (event, { id, data }) => {
    PtyManager.write(id, data);
  });

  ipcMain.on('pty:resize', (event, { id, cols, rows }) => {
    PtyManager.resize(id, cols, rows);
  });

  ipcMain.handle('pty:kill', (event, { id }) => {
    transcriber.endSession(id);
    PtyManager.kill(id);
    return { success: true };
  });

  // ── Database / Session Handlers ─────────────────────────

  ipcMain.handle('session:create', (event, session) => {
    return db.sessions.create(session);
  });

  ipcMain.handle('session:list', () => {
    return db.sessions.list();
  });

  ipcMain.handle('session:get', (event, id) => {
    return db.sessions.get(id);
  });

  ipcMain.handle('session:update', (event, id, data) => {
    db.sessions.update(id, data);
    return { success: true };
  });

  ipcMain.handle('session:delete', (event, id) => {
    db.sessions.delete(id);
    return { success: true };
  });

  ipcMain.handle('session:restore', () => {
    return db.sessions.list().filter(s => s.status !== 'archived');
  });

  ipcMain.handle('session:checkResume', (event, workspacePath) => {
    return db.sessions.getByWorkspace(workspacePath);
  });

  // ── Groups ──────────────────────────────────────────────

  ipcMain.handle('group:create', (event, group) => {
    return db.groups.create(group);
  });

  ipcMain.handle('group:list', () => {
    return db.groups.list();
  });

  ipcMain.handle('group:delete', (event, id) => {
    db.groups.delete(id);
    return { success: true };
  });

  // ── Usage Stats ─────────────────────────────────────────

  ipcMain.handle('usage:record', (event, entry) => {
    db.usage.record(entry);
    return { success: true };
  });

  ipcMain.handle('usage:totals', () => {
    return db.usage.getTotals();
  });

  ipcMain.handle('usage:monthly', () => {
    return db.usage.getMonthly();
  });

  ipcMain.handle('usage:bySession', (event, sessionId) => {
    return db.usage.getBySession(sessionId);
  });

  // ── File System Handlers ──────────────────────────────────

  ipcMain.handle('fs:readDir', async (event, dirPath) => {
    return readDirectory(dirPath);
  });

  ipcMain.handle('fs:readDirDeep', async (event, dirPath, depth) => {
    return readDirectory(dirPath, 0, depth || 2);
  });

  ipcMain.handle('fs:readFile', async (event, filePath) => {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return { content };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('fs:stat', async (event, filePath) => {
    try {
      const stats = await fs.promises.stat(filePath);
      return {
        size: stats.size,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        modified: stats.mtime.toISOString(),
        created: stats.birthtime.toISOString()
      };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    });
    if (result.canceled) return { canceled: true };
    return { path: result.filePaths[0] };
  });

  ipcMain.handle('dialog:openFile', async (event, opts = {}) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: opts.filters || [{ name: 'All Files', extensions: ['*'] }]
    });
    if (result.canceled) return { canceled: true };
    return { paths: result.filePaths };
  });

  // ── Workspace Handlers ──────────────────────────────────

  ipcMain.handle('workspace:detectClaudeMd', (event, workspacePath) => {
    return detectClaudeMd(workspacePath);
  });

  ipcMain.handle('workspace:fileMap', (event, workspacePath) => {
    return generateFileMap(workspacePath);
  });

  // ── MCP Handlers ────────────────────────────────────────

  mcpManager.onStatusChange((status) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('mcp:serverStatus', status);
    }
  });

  ipcMain.handle('mcp:startServer', async (event, opts) => {
    return mcpManager.startServer(opts.name, opts);
  });

  ipcMain.handle('mcp:stopServer', async (event, name) => {
    await mcpManager.stopServer(name);
    return { success: true };
  });

  ipcMain.handle('mcp:listTools', (event, name) => {
    return mcpManager.getTools(name);
  });

  ipcMain.handle('mcp:allTools', () => {
    return mcpManager.getAllTools();
  });

  ipcMain.handle('mcp:status', () => {
    return mcpManager.getStatus();
  });

  ipcMain.handle('mcp:getConfig', () => {
    return readGlobalConfig();
  });

  ipcMain.handle('mcp:mergedConfig', (event, workspacePath) => {
    const merged = mergeConfigs(workspacePath);
    return merged;
  });

  ipcMain.handle('mcp:writeTempConfig', (event, servers) => {
    return writeTempConfig(servers);
  });

  // ── Git Handlers ────────────────────────────────────────

  ipcMain.handle('git:isRepo', async (event, cwd) => {
    return gitOps.isGitRepo(cwd);
  });

  ipcMain.handle('git:status', async (event, cwd) => {
    return gitOps.gitStatus(cwd);
  });

  ipcMain.handle('git:diff', async (event, cwd) => {
    return gitOps.gitDiff(cwd);
  });

  ipcMain.handle('git:diffFull', async (event, cwd) => {
    return gitOps.gitDiffFull(cwd);
  });

  ipcMain.handle('git:autoCommit', async (event, cwd, sessionName) => {
    return gitOps.autoCommit(cwd, sessionName);
  });

  ipcMain.handle('git:createWorktree', async (event, cwd, sessionName) => {
    return gitOps.createGitWorktree(cwd, sessionName);
  });

  ipcMain.handle('git:createRepo', async (event, opts) => {
    return gitOps.createGithubRepo(opts);
  });

  ipcMain.handle('git:log', async (event, cwd, limit) => {
    return gitOps.getCommitLog(cwd, limit);
  });

  // ── Transcription Handlers ──────────────────────────────

  ipcMain.handle('transcript:list', (event, sessionId) => {
    return transcriber.listTranscripts(sessionId);
  });

  ipcMain.handle('transcript:read', async (event, sessionId, date) => {
    const filePath = transcriber.getTranscriptPath(sessionId, date);
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return { content };
    } catch (e) {
      return { error: e.message };
    }
  });

  // ── Recent Paths ────────────────────────────────────────

  ipcMain.handle('recentPaths:add', (event, sessionId, filePath, type) => {
    db.recentPaths.add(sessionId, filePath, type);
    return { success: true };
  });

  ipcMain.handle('recentPaths:list', (event, sessionId) => {
    return db.recentPaths.list(sessionId);
  });

  // ── Shell / App Handlers ──────────────────────────────────

  ipcMain.handle('shell:openExternal', async (event, url) => {
    await shell.openExternal(url);
    return { success: true };
  });

  ipcMain.handle('shell:openPath', async (event, filePath) => {
    await shell.openPath(filePath);
    return { success: true };
  });

  // ── Claude CLI Auth Detection ─────────────────────────────

  ipcMain.handle('app:checkClaudeAuth', async () => {
    const { execFile } = require('child_process');
    const result = {
      installed: false,
      authenticated: false,
      cliVersion: null,
      accountEmail: null,
      planType: null
    };

    // Check if claude CLI is installed
    try {
      const version = await new Promise((resolve, reject) => {
        execFile('claude', ['--version'], { timeout: 5000, shell: true }, (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout.trim());
        });
      });
      result.installed = true;
      result.cliVersion = version;
    } catch (e) {
      return result;
    }

    // Check authentication by reading credentials or running auth status
    try {
      // Try reading credentials files (check multiple known locations)
      const credPaths = [
        path.join(os.homedir(), '.claude', '.credentials.json'),
        path.join(os.homedir(), '.claude', 'credentials.json'),
        path.join(os.homedir(), '.claude', 'auth.json')
      ];

      for (const credPath of credPaths) {
        if (result.authenticated) break;
        try {
          if (fs.existsSync(credPath)) {
            const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
            if (creds && (creds.oauth_token || creds.apiKey || creds.sessionKey || creds.token || creds.access_token)) {
              result.authenticated = true;
              result.accountEmail = creds.email || creds.accountEmail || creds.user_email || null;
              result.planType = creds.planType || creds.plan || creds.tier || null;
            }
          }
        } catch (e) { /* skip bad file */ }
      }

      // Check ~/.claude/settings.json
      if (!result.authenticated) {
        const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        try {
          if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            if (settings && (settings.apiKey || settings.oauthToken)) {
              result.authenticated = true;
            }
          }
        } catch (e) { /* skip */ }
      }

      // Check ANTHROPIC_API_KEY environment variable
      if (!result.authenticated && process.env.ANTHROPIC_API_KEY) {
        result.authenticated = true;
        result.planType = 'API Key';
      }

      // Fallback: try `claude auth status`
      if (!result.authenticated) {
        const authOutput = await new Promise((resolve) => {
          execFile('claude', ['auth', 'status'], { timeout: 10000, shell: true }, (err, stdout, stderr) => {
            resolve((stdout || '') + (stderr || ''));
          });
        });
        const lower = authOutput.toLowerCase();
        if (lower.includes('authenticated') || lower.includes('logged in') || lower.includes('active') || lower.includes('valid')) {
          result.authenticated = true;
          const emailMatch = authOutput.match(/[\w.-]+@[\w.-]+\.\w+/);
          if (emailMatch) result.accountEmail = emailMatch[0];
          const planMatch = authOutput.match(/plan[:\s]+(\w+)/i);
          if (planMatch) result.planType = planMatch[1];
        }
      }
    } catch (e) {
      // Auth check failed, keep authenticated as false
    }

    return result;
  });

  ipcMain.handle('app:getVersion', () => {
    const { app } = require('electron');
    return app.getVersion();
  });

  ipcMain.handle('app:getPlatform', () => {
    return { platform: process.platform, arch: process.arch };
  });

  ipcMain.handle('clipboard:write', (event, text) => {
    clipboard.writeText(text);
    return { success: true };
  });

  ipcMain.handle('clipboard:read', () => {
    return clipboard.readText();
  });

  // ── Notification Handlers ─────────────────────────────────

  ipcMain.handle('notify:show', (event, { title, body }) => {
    notifier.showNative(title, body);
    return { success: true };
  });

  ipcMain.handle('notify:mute', (event, muted) => {
    notifier.setMuted(muted);
    return { success: true };
  });

  // ── Usage JSON (from Claude CLI) ─────────────────────────

  ipcMain.handle('usage:readCliUsage', () => {
    // Try reading ~/.claude/usage.json or ~/.claude/statsig/usage
    const possiblePaths = [
      path.join(os.homedir(), '.claude', 'usage.json'),
      path.join(os.homedir(), '.claude', 'statsig', 'usage.json')
    ];
    for (const p of possiblePaths) {
      try {
        if (fs.existsSync(p)) {
          return JSON.parse(fs.readFileSync(p, 'utf-8'));
        }
      } catch (e) { /* skip */ }
    }
    return null;
  });

  // ── Plugins Detection ─────────────────────────────────────

  ipcMain.handle('plugins:detect', () => {
    const results = { mcpServers: {}, plugins: [], settings: {} };

    // Read MCP servers from global config
    try {
      const globalConfig = readGlobalConfig();
      results.mcpServers = globalConfig || {};
    } catch (e) { /* skip */ }

    // Read Claude settings for enabled plugins
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      if (fs.existsSync(settingsPath)) {
        results.settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      }
    } catch (e) { /* skip */ }

    // Scan for installed plugins in common locations
    const pluginDirs = [
      path.join(os.homedir(), '.claude', 'plugins'),
      path.join(os.homedir(), '.claude', 'commands'),
    ];

    for (const dir of pluginDirs) {
      try {
        if (fs.existsSync(dir)) {
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const itemPath = path.join(dir, item);
            const stat = fs.statSync(itemPath);
            if (stat.isDirectory()) {
              // Check for plugin.json
              const pluginJsonPath = path.join(itemPath, 'plugin.json');
              if (fs.existsSync(pluginJsonPath)) {
                try {
                  const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
                  results.plugins.push({
                    name: pluginJson.name || item,
                    description: pluginJson.description || '',
                    path: itemPath,
                    type: 'plugin'
                  });
                } catch (e) {
                  results.plugins.push({ name: item, path: itemPath, type: 'plugin', description: 'Plugin directory' });
                }
              }
            } else if (item.endsWith('.md') || item.endsWith('.js')) {
              results.plugins.push({
                name: item.replace(/\.(md|js)$/, ''),
                path: itemPath,
                type: item.endsWith('.md') ? 'command' : 'script',
                description: `Custom ${item.endsWith('.md') ? 'command' : 'script'}`
              });
            }
          }
        }
      } catch (e) { /* skip */ }
    }

    return results;
  });

  // ── App State ───────────────────────────────────────────

  ipcMain.handle('appState:get', (event, key) => {
    return db.appState.get(key);
  });

  ipcMain.handle('appState:set', (event, key, value) => {
    db.appState.set(key, value);
    return { success: true };
  });
}

function cleanup() {
  transcriber.closeAll();
  mcpManager.stopAll();
  db.close();
}

module.exports = { registerIpcHandlers, cleanup };
