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

const remoteApi = require('./remote/remote-api');
const transcriber = new Transcriber();
const mcpManager = new McpManager();
const notifier = new Notifier();

function registerIpcHandlers(ipcMain) {
  const { getMainWindow } = require('./main');

  // Initialize database
  db.init();

  // ── PTY Handlers ──────────────────────────────────────────

  ipcMain.handle('pty:spawn', async (event, opts) => {
    console.log('[Main:pty:spawn] id=' + opts.id, 'cwd=' + (opts.cwd || 'default'), 'launchClaude=' + (opts.launchClaude !== false));

    // OV Context Seeding — query OpenViking for workspace-relevant knowledge
    let ovContext = '';
    if (opts.launchClaude !== false && !opts.resume) {
      try {
        const ovClientLocal = require('./openviking/ov-client');
        const workspaceDir = opts.cwd || os.homedir();
        const workspaceName = path.basename(workspaceDir);
        const results = await ovClientLocal.search(
          `${workspaceName} project context patterns`,
          { topK: 5, tier: 'L0' }
        );
        const resources = results?.resources || [];
        const memories = results?.memories || [];
        const snippets = [];
        for (const r of resources.slice(0, 3)) {
          const text = (r.abstract || r.content || '').slice(0, 150);
          if (text) snippets.push(`- ${text}`);
        }
        for (const m of memories.slice(0, 2)) {
          const text = (m.abstract || m.content || '').slice(0, 150);
          if (text) snippets.push(`- [Memory] ${text}`);
        }
        if (snippets.length > 0) {
          ovContext = `\n\nPrior knowledge from OpenViking:\n${snippets.join('\n')}`;
          console.log(`[Main:pty:spawn] OV context seeded: ${snippets.length} snippets`);
        }
      } catch (ovErr) {
        console.log('[Main:pty:spawn] OV context seeding skipped:', ovErr.message);
      }
    }

    // Inject active research results from blackboard
    let bbContext = '';
    try {
      const researchEntries = db.blackboard.getByCategory('research');
      if (researchEntries && researchEntries.length > 0) {
        const summaries = researchEntries.slice(0, 3).map(e => {
          try { return JSON.parse(e.value); } catch { return null; }
        }).filter(Boolean).map(r => `- ${r.metric}: ${r.value} (${r.status}, exp #${r.experimentCount})`);
        if (summaries.length > 0) {
          bbContext = `\n\nActive research results:\n${summaries.join('\n')}`;
        }
      }
    } catch (bbErr) {
      // Blackboard read failed, non-fatal
    }

    try {
      const combined = (opts.systemPrompt || '') + ovContext + bbContext;
      const effectiveSystemPrompt = combined.length > 0 ? combined : undefined;
      const session = PtyManager.create(opts.id, {
        cwd: opts.cwd || os.homedir(),
        cols: opts.cols || 120,
        rows: opts.rows || 30,
        mode: opts.mode,
        skipPerms: opts.skipPerms,
        model: opts.model,
        mcpConfig: opts.mcpConfig,
        resume: opts.resume,
        resumeSessionId: opts.resumeSessionId,
        systemPrompt: effectiveSystemPrompt,
        name: opts.name,
        maxTurns: opts.maxTurns,
        allowedTools: opts.allowedTools,
        disallowedTools: opts.disallowedTools,
        tools: opts.tools,
        mcpDebug: opts.mcpDebug,
        verbose: opts.verbose,
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

      // Initialize micro-ingest for this session
      const microIngest = require('./openviking/ov-micro-ingest');
      const sessionMeta = { name: opts.name || opts.id, workspacePath: opts.cwd, mode: opts.mode };

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
        try { transcriber.write(opts.id, data); } catch(e) {
          if (dataPackets <= 5) console.warn('[Main:pty:data] transcript write failed:', e.message);
        }
        // Capture for remote API
        try { remoteApi.captureOutput(opts.id, data); } catch(e) {
          if (dataPackets <= 5) console.warn('[Main:pty:data] remote capture failed:', e.message);
        }
        // Real-time micro-ingest to OpenViking
        try { microIngest.processOutput(opts.id, data, sessionMeta); } catch(e) {
          if (dataPackets <= 5) console.warn('[Main:pty:data] micro-ingest failed:', e.message);
        }
        // Dispatch to messaging platforms (Discord, Telegram, etc.)
        try {
          const messagingBridge = require('./remote/messaging-bridge');
          messagingBridge.dispatchOutput(opts.id, data);
        } catch(e) {
          if (dataPackets <= 5) console.warn('[Main:pty:data] messaging dispatch failed:', e.message);
        }
      };

      session.onExitCallback = (exitCode) => {
        console.log('[Main:pty:exit] id=' + opts.id, 'code=' + exitCode);
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('pty:exit', { id: opts.id, exitCode });
        }
        try { transcriber.endSession(opts.id); } catch(e) {
          console.warn('[Main:pty:exit] transcript end failed:', e.message);
        }
        // Clean up micro-ingest state
        try { microIngest.endSession(opts.id); } catch { /* ignore */ }
        // Clean up messaging bridge VT buffer
        try {
          const messagingBridge = require('./remote/messaging-bridge');
          messagingBridge.cleanupSession(opts.id);
        } catch { /* ignore */ }

        // Auto-ingest transcript into OpenViking on session end
        try {
          const transcriptPath = transcriber.getTranscriptPath(opts.id);
          if (fs.existsSync(transcriptPath)) {
            const content = fs.readFileSync(transcriptPath, 'utf-8');
            if (content.length > 100) {
              const ovIngest = require('./openviking/ov-ingest');
              ovIngest.ingestSingleTranscript(opts.id, content, {
                name: opts.name || opts.id,
                workspacePath: opts.cwd,
                mode: opts.mode
              }).then(r => {
                console.log('[Main:pty:exit] Auto-ingested transcript for', opts.id, r.success ? 'OK' : 'FAIL');
              }).catch(e => {
                console.log('[Main:pty:exit] Auto-ingest skipped:', e.message);
              });
            }
          }
        } catch (ingestErr) {
          // Non-fatal — OpenViking may not be running
          console.log('[Main:pty:exit] Auto-ingest skipped (non-fatal):', ingestErr.message);
        }
      };

      session.spawn();
      console.log('[Main:pty:spawn] PTY spawned successfully for', opts.id);

      // Auto-create Discord channel for this session if bot is running
      try {
        const discordBot = require('./remote/discord-bot');
        if (discordBot.isRunning()) {
          const sessionData = {
            id: opts.id,
            name: opts.name || opts.id,
            mode: opts.mode || 'ask',
            workspace_path: opts.cwd,
            status: 'active'
          };
          discordBot.autoCreateChannel(sessionData).then(result => {
            if (result) {
              console.log(`[Main:pty:spawn] Discord channel auto-created for ${opts.name || opts.id}`);
            }
          }).catch(e => {
            console.log('[Main:pty:spawn] Discord auto-channel skipped:', e.message);
          });
        }
      } catch (e) {
        // Discord bot not loaded — non-fatal
      }

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

      // Fallback: try `claude auth status` (returns JSON)
      if (!result.authenticated) {
        const authOutput = await new Promise((resolve) => {
          execFile('claude', ['auth', 'status'], { timeout: 10000, shell: true }, (err, stdout, stderr) => {
            resolve((stdout || '') + (stderr || ''));
          });
        });

        // Claude CLI returns JSON like: {"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}
        try {
          const authJson = JSON.parse(authOutput.trim());
          if (authJson.loggedIn === true) {
            result.authenticated = true;
            result.planType = authJson.authMethod || authJson.apiProvider || null;
            if (authJson.email) result.accountEmail = authJson.email;
          }
        } catch (jsonErr) {
          // Not JSON — try keyword matching as fallback
          const lower = authOutput.toLowerCase();
          if (lower.includes('authenticated') || lower.includes('logged in') || lower.includes('loggedin') ||
              lower.includes('"loggedin":true') || lower.includes('"loggedin": true') ||
              lower.includes('active') || lower.includes('valid')) {
            result.authenticated = true;
            const emailMatch = authOutput.match(/[\w.-]+@[\w.-]+\.\w+/);
            if (emailMatch) result.accountEmail = emailMatch[0];
            const planMatch = authOutput.match(/plan[:\s]+(\w+)/i);
            if (planMatch) result.planType = planMatch[1];
          }
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

  ipcMain.handle('app:dbHealth', () => {
    try {
      const row = db.init().prepare('SELECT 1 as ok').get();
      const sessionCount = db.sessions.list().length;
      const targetCount = db.researchTargets.list().length;
      return { ok: !!row?.ok, sessions: sessionCount, targets: targetCount };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Auto-Update & Restart ────────────────────────────────

  ipcMain.handle('app:update', async () => {
    const { execSync } = require('child_process');
    const appDir = __dirname.includes('app.asar')
      ? path.resolve(__dirname, '..', '..')
      : path.resolve(__dirname, '..');

    // On macOS, run commands through login shell to get full PATH
    const run = (cmd, opts = {}) => {
      const execOpts = { cwd: appDir, encoding: 'utf8', ...opts };
      if (process.platform === 'darwin') {
        const escaped = cmd.replace(/"/g, '\\"');
        return execSync(`/bin/zsh -ilc "cd '${appDir}' && ${escaped}"`, execOpts).trim();
      }
      return execSync(cmd, execOpts).trim();
    };

    try {
      // git pull from origin
      const pullResult = run('git pull --ff-only origin main', { timeout: 30000 });

      if (pullResult.includes('Already up to date')) {
        return { updated: false, message: 'Already up to date' };
      }

      // npm install (include devDeps so esbuild is available for build)
      try {
        run('npm install', { timeout: 120000 });
      } catch (npmErr) {
        console.warn('[Update] npm install warning:', npmErr.message);
      }

      // Rebuild renderer bundle
      try {
        run('node build.js', { timeout: 30000 });
      } catch (buildErr) {
        console.warn('[Update] build.js warning:', buildErr.message);
      }

      // Parse what changed from the pull output
      const summary = pullResult.split('\n').find(l => l.includes('file')) || pullResult.split('\n')[0];
      return { updated: true, summary, output: pullResult };
    } catch (err) {
      return { updated: false, message: `Update failed: ${err.message}` };
    }
  });

  ipcMain.handle('app:restart', () => {
    const { app } = require('electron');
    app.relaunch();
    app.exit(0);
  });

  // ── Provider Handlers ────────────────────────────────────

  // ── Auth Handlers ───────────────────────────────────────

  ipcMain.handle('auth:status', async () => {
    const { authManager } = require('./auth/auth-manager');
    return authManager.getStatus();
  });

  ipcMain.handle('auth:setApiKey', async (event, { provider, apiKey }) => {
    const { authManager } = require('./auth/auth-manager');
    return authManager.setApiKey(provider, apiKey);
  });

  ipcMain.handle('auth:disconnect', async (event, { provider }) => {
    const { authManager } = require('./auth/auth-manager');
    return authManager.disconnect(provider);
  });

  ipcMain.handle('auth:validate', async (event, { provider }) => {
    const { authManager } = require('./auth/auth-manager');
    return await authManager.validate(provider);
  });

  ipcMain.handle('auth:openAuthWindow', async (event, { provider }) => {
    const { authManager } = require('./auth/auth-manager');
    const win = BrowserWindow.fromWebContents(event.sender);
    return authManager.openAuthWindow(provider, win);
  });

  ipcMain.handle('provider:list', async () => {
    try {
      const { providerRegistry } = require('./providers/provider-registry');
      return providerRegistry.listProviders();
    } catch (e) { return []; }
  });

  ipcMain.handle('provider:models', async (event, providerId) => {
    try {
      const { providerRegistry } = require('./providers/provider-registry');
      const provider = providerRegistry.getProvider(providerId);
      if (!provider) return [];
      return await provider.models();
    } catch (e) { return []; }
  });

  ipcMain.handle('provider:allModels', async () => {
    try {
      const { providerRegistry } = require('./providers/provider-registry');
      return await providerRegistry.listAllModels();
    } catch (e) { return []; }
  });

  ipcMain.handle('provider:send', async (event, { sessionId, providerId, message, model }) => {
    try {
      const { providerRegistry } = require('./providers/provider-registry');
      const { ApiPtyEmitter } = require('./providers/api-pty-emitter');
      const { McpBridge } = require('./mcp/mcp-bridge');
      const provider = providerRegistry.getProvider(providerId);
      if (!provider) throw new Error(`Unknown provider: ${providerId}`);

      // Create session if not exists
      await provider.createSession(sessionId, { model });

      // Get MCP tools in provider-native format
      let tools = [];
      let toolHandler = null;
      try {
        const mcpManager = require('./mcp/mcp-manager');
        if (mcpManager.instance) {
          const bridge = new McpBridge(mcpManager.instance);
          tools = bridge.getToolsForProvider(providerId === 'gemini' ? 'gemini' : 'openai');
          toolHandler = bridge.createToolHandler();
        }
      } catch (e) {
        console.warn('[provider:send] MCP bridge unavailable:', e.message);
      }

      // Create emitter to stream output to renderer
      const emitter = new ApiPtyEmitter(event.sender, sessionId, providerId);
      const modelName = model || providerId;

      // Stream the response with tool execution support
      const generator = provider.sendMessage(sessionId, message, tools);
      await emitter.streamResponse(generator, modelName, toolHandler);

      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ── Multi-LLM Orchestration Handlers ─────────────────────

  ipcMain.handle('multiLlm:create', async (event, { sessionId, providers }) => {
    try {
      const { MultiLlmSession, activeSessions } = require('./orchestration/multi-llm-session');
      const session = new MultiLlmSession(sessionId, providers, event.sender);
      activeSessions.set(sessionId, session);
      return { success: true, subSessions: session.getSubSessionIds() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('multiLlm:sendToAll', async (event, { sessionId, message, systemPrompt }) => {
    try {
      const { activeSessions } = require('./orchestration/multi-llm-session');
      const session = activeSessions.get(sessionId);
      if (!session) throw new Error('No multi-LLM session: ' + sessionId);

      let toolHandler = null;
      try {
        const { McpBridge } = require('./mcp/mcp-bridge');
        const mcpManager = require('./mcp/mcp-manager');
        if (mcpManager.instance) {
          toolHandler = new McpBridge(mcpManager.instance).createToolHandler();
        }
      } catch (e) { /* MCP not available */ }

      const results = await session.sendToAll(message, { systemPrompt, onToolCall: toolHandler });
      return { success: true, results };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('multiLlm:synthesize', async (event, { sessionId, originalPrompt, reviewerId, reviewerModel }) => {
    try {
      const { activeSessions } = require('./orchestration/multi-llm-session');
      const { PeerReview } = require('./orchestration/peer-review');
      const session = activeSessions.get(sessionId);
      if (!session) throw new Error('No multi-LLM session: ' + sessionId);

      const responses = session.getResponses();
      const synthesis = await PeerReview.synthesize(responses, originalPrompt, {
        reviewerId, reviewerModel, sessionId, webContents: event.sender,
      });
      return { success: true, synthesis };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('multiLlm:cancel', async (event, { sessionId }) => {
    try {
      const { activeSessions } = require('./orchestration/multi-llm-session');
      const session = activeSessions.get(sessionId);
      if (session) session.cancelAll();
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('multiLlm:destroy', async (event, { sessionId }) => {
    try {
      const { activeSessions } = require('./orchestration/multi-llm-session');
      const session = activeSessions.get(sessionId);
      if (session) { session.destroy(); activeSessions.delete(sessionId); }
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('provider:cancel', async (event, { sessionId, providerId }) => {
    try {
      const { providerRegistry } = require('./providers/provider-registry');
      const provider = providerRegistry.getProvider(providerId);
      if (provider) provider.cancelGeneration(sessionId);
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('app:uploadLog', async () => {
    const { execSync } = require('child_process');
    // __dirname is src/main/, go up two levels to repo root
    const appDir = __dirname.includes('app.asar')
      ? path.resolve(__dirname, '..', '..', '..')
      : path.resolve(__dirname, '..', '..');

    try {
      // Collect diagnostic info
      const lines = [];
      lines.push(`=== OmniClaw Diagnostic Log ===`);
      lines.push(`Date: ${new Date().toISOString()}`);
      lines.push(`Platform: ${process.platform} ${process.arch}`);
      lines.push(`Node: ${process.version}`);
      lines.push(`App Dir: ${appDir}`);
      lines.push(`Machine: ${os.hostname()} / ${os.userInfo().username}`);
      lines.push('');

      // Git status
      try {
        const gitLog = execSync('git log --oneline -5', { cwd: appDir, encoding: 'utf8', timeout: 5000 });
        lines.push('=== Recent Commits ===');
        lines.push(gitLog.trim());
      } catch {}
      lines.push('');

      // Watchdog health
      try {
        const probesModule = require('./health/probes');
        // Just note that probes exist
        lines.push('=== Watchdog Probes Available ===');
      } catch {}

      // Check key paths
      lines.push('=== Path Checks ===');
      const checks = [
        ['DB', path.join(os.homedir(), '.omniclaw', 'omniclaw.db')],
        ['Turso Replica', path.join(os.homedir(), '.omniclaw', 'turso-replica.db')],
        ['.env', path.join(os.homedir(), '.omniclaw', '.env')],
        ['OV Config', path.join(os.homedir(), '.openviking', 'ov.conf')],
        ['Plugins', path.join(os.homedir(), '.claude', 'plugins', 'hytale-modding')],
        ['Plugin Repo', path.join(os.homedir(), 'Documents', 'ClaudeWorkspace', 'claude-plugins-custom', '.git')],
        ['MCP Config', path.join(os.homedir(), 'Documents', 'ClaudeWorkspace', '.mcp.json')],
        ['KingdomsMod', path.join(os.homedir(), 'Documents', 'ClaudeWorkspace', 'ClaudeProjects', 'KingdomsMod', '.git')],
        ['CorruptionMod', path.join(os.homedir(), 'Documents', 'ClaudeWorkspace', 'HYTALEMODWORKSHOP', 'CorruptionMod', '.git')],
      ];
      for (const [name, p] of checks) {
        const exists = fs.existsSync(p);
        let info = exists ? 'EXISTS' : 'MISSING';
        if (exists) {
          try {
            const stats = fs.lstatSync(p);
            if (stats.isSymbolicLink()) info += ` (symlink → ${fs.readlinkSync(p)})`;
          } catch {}
        }
        lines.push(`  ${name}: ${info} — ${p}`);
      }
      lines.push('');

      // Process info
      lines.push('=== Process Env ===');
      lines.push(`  TURSO_DATABASE_URL: ${process.env.TURSO_DATABASE_URL ? 'SET' : 'NOT SET'}`);
      lines.push(`  TURSO_AUTH_TOKEN: ${process.env.TURSO_AUTH_TOKEN ? 'SET' : 'NOT SET'}`);
      lines.push('');

      const logContent = lines.join('\n');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `diagnostic-${timestamp}.log`;

      // Write to logs dir in the app repo
      const logsDir = path.join(appDir, 'logs');
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      const logPath = path.join(logsDir, filename);
      fs.writeFileSync(logPath, logContent);

      // Git add, commit, push
      const run = (cmd) => {
        if (process.platform === 'darwin') {
          return execSync(`/bin/zsh -ilc "cd '${appDir}' && ${cmd.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 30000 }).trim();
        }
        return execSync(cmd, { cwd: appDir, encoding: 'utf8', timeout: 30000 }).trim();
      };

      run(`git add "logs/${filename}"`);
      run(`git commit -m "Upload diagnostic log ${timestamp}"`);
      run('git push origin main');

      return { success: true, filename, message: `Log uploaded: ${filename}` };
    } catch (err) {
      return { success: false, message: `Upload failed: ${err.message}` };
    }
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
    // Read usage data from Claude CLI's stats-cache.json (primary) or usage.json (fallback)
    const possiblePaths = [
      path.join(os.homedir(), '.claude', 'stats-cache.json'),
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
    const results = { mcpServers: {}, plugins: [], settings: {}, installedPlugins: {} };
    const seenPluginPaths = new Set();

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

    // Helper: read plugin manifest from a plugin directory
    function readPluginManifest(pluginDir) {
      // Check .claude-plugin/plugin.json first (standard location)
      const manifestPaths = [
        path.join(pluginDir, '.claude-plugin', 'plugin.json'),
        path.join(pluginDir, 'plugin.json'),
        path.join(pluginDir, 'package.json')
      ];
      for (const mp of manifestPaths) {
        try {
          if (fs.existsSync(mp)) {
            return JSON.parse(fs.readFileSync(mp, 'utf-8'));
          }
        } catch (e) { /* skip */ }
      }
      return null;
    }

    // Helper: detect what a plugin directory contains
    function detectPluginContents(pluginDir) {
      const contents = [];
      try {
        const items = fs.readdirSync(pluginDir);
        if (items.includes('skills')) contents.push('skills');
        if (items.includes('commands')) contents.push('commands');
        if (items.includes('hooks')) contents.push('hooks');
        if (items.includes('agents')) contents.push('agents');
      } catch (e) { /* skip */ }
      return contents;
    }

    // Read installed_plugins.json (official Claude plugin registry)
    const installedPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
    try {
      if (fs.existsSync(installedPath)) {
        const installed = JSON.parse(fs.readFileSync(installedPath, 'utf-8'));
        results.installedPlugins = installed.plugins || {};

        // Convert each installed plugin to our plugin list format
        for (const [pluginId, entries] of Object.entries(results.installedPlugins)) {
          const entry = Array.isArray(entries) ? entries[0] : entries;
          const enabled = results.settings?.enabledPlugins?.[pluginId] === true;
          const nameParts = pluginId.split('@');
          const pluginName = nameParts[0] || pluginId;
          const source = nameParts[1] || 'unknown';

          let description = '';
          let version = entry.version || '';
          let pluginType = 'plugin';
          if (entry.installPath) {
            seenPluginPaths.add(path.resolve(entry.installPath));
            const manifest = readPluginManifest(entry.installPath);
            if (manifest) {
              description = manifest.description || '';
              pluginType = manifest.type || 'plugin';
              if (manifest.version && !version) version = manifest.version;
              if (!version && manifest.version) version = manifest.version;
            }
            const contents = detectPluginContents(entry.installPath);
            if (contents.length > 0 && !description) {
              description = `Contains: ${contents.join(', ')}`;
            }
          }

          results.plugins.push({
            id: pluginId,
            name: pluginName,
            description,
            source,
            path: entry.installPath || '',
            type: pluginType,
            version,
            enabled,
            installedAt: entry.installedAt || '',
            lastUpdated: entry.lastUpdated || ''
          });
        }
      }
    } catch (e) { /* skip */ }

    // Scan ~/.claude/plugins/ for local plugin directories not in registry
    const pluginsDir = path.join(os.homedir(), '.claude', 'plugins');
    try {
      if (fs.existsSync(pluginsDir)) {
        const items = fs.readdirSync(pluginsDir, { withFileTypes: true });
        for (const item of items) {
          if (!item.isDirectory()) continue;
          // Skip internal dirs
          if (['cache', '.install-manifests', 'marketplaces'].includes(item.name)) continue;

          const itemPath = path.resolve(path.join(pluginsDir, item.name));
          if (seenPluginPaths.has(itemPath)) continue;

          // Check if it looks like a plugin (has .claude-plugin/, skills/, commands/, or hooks/)
          const hasPluginMarker = fs.existsSync(path.join(itemPath, '.claude-plugin'));
          const hasSkills = fs.existsSync(path.join(itemPath, 'skills'));
          const hasCommands = fs.existsSync(path.join(itemPath, 'commands'));
          const hasHooks = fs.existsSync(path.join(itemPath, 'hooks'));

          if (hasPluginMarker || hasSkills || hasCommands || hasHooks) {
            const manifest = readPluginManifest(itemPath);
            const pluginName = manifest?.name || item.name;
            const localId = `${pluginName}@local`;
            const enabled = results.settings?.enabledPlugins?.[localId] === true;
            const contents = detectPluginContents(itemPath);

            results.plugins.push({
              id: localId,
              name: pluginName,
              description: manifest?.description || (contents.length > 0 ? `Contains: ${contents.join(', ')}` : 'Local plugin'),
              source: 'local',
              path: itemPath,
              type: manifest?.type || 'plugin',
              version: manifest?.version || '',
              enabled,
              installedAt: '',
              lastUpdated: ''
            });
            seenPluginPaths.add(itemPath);
          }
        }
      }
    } catch (e) { /* skip */ }

    // Scan cache for available plugins not in registry
    const cacheDir = path.join(pluginsDir, 'cache', 'claude-plugins-official');
    try {
      if (fs.existsSync(cacheDir)) {
        const cachedPlugins = fs.readdirSync(cacheDir, { withFileTypes: true });
        for (const item of cachedPlugins) {
          if (!item.isDirectory()) continue;
          const pluginId = `${item.name}@claude-plugins-official`;
          // Skip if already in registry
          if (results.plugins.some(p => p.id === pluginId)) continue;

          const itemPath = path.join(cacheDir, item.name);
          // Find the version directory (first subdir)
          let versionDir = itemPath;
          try {
            const subdirs = fs.readdirSync(itemPath, { withFileTypes: true }).filter(d => d.isDirectory());
            if (subdirs.length > 0) {
              versionDir = path.join(itemPath, subdirs[0].name);
            }
          } catch (e) { /* use itemPath */ }

          const manifest = readPluginManifest(versionDir);
          const contents = detectPluginContents(versionDir);
          const enabled = results.settings?.enabledPlugins?.[pluginId] === true;

          results.plugins.push({
            id: pluginId,
            name: item.name,
            description: manifest?.description || (contents.length > 0 ? `Contains: ${contents.join(', ')}` : 'Cached plugin'),
            source: 'claude-plugins-official',
            path: versionDir,
            type: 'plugin',
            version: manifest?.version || '',
            enabled,
            installedAt: '',
            lastUpdated: '',
            cached: true
          });
        }
      }
    } catch (e) { /* skip */ }

    // Scan for any additional plugins in commands dir
    const commandsDir = path.join(os.homedir(), '.claude', 'commands');
    try {
      if (fs.existsSync(commandsDir)) {
        const items = fs.readdirSync(commandsDir);
        for (const item of items) {
          const itemPath = path.join(commandsDir, item);
          if (item.endsWith('.md') || item.endsWith('.js')) {
            results.plugins.push({
              id: 'command:' + item,
              name: item.replace(/\.(md|js)$/, ''),
              path: itemPath,
              type: item.endsWith('.md') ? 'command' : 'script',
              description: `Custom ${item.endsWith('.md') ? 'command' : 'script'}`,
              enabled: true,
              source: 'local'
            });
          }
        }
      }
    } catch (e) { /* skip */ }

    return results;
  });

  // Toggle plugin on/off in settings.json
  ipcMain.handle('plugins:toggle', (event, pluginId, enabled) => {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      let settings = {};
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      }
      if (!settings.enabledPlugins) settings.enabledPlugins = {};
      if (enabled) {
        settings.enabledPlugins[pluginId] = true;
      } else {
        delete settings.enabledPlugins[pluginId];
      }
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      return { success: true, enabled };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Upload a plugin from a local zip/folder
  ipcMain.handle('plugins:upload', async (event, opts) => {
    const { filePaths } = opts;
    if (!filePaths || filePaths.length === 0) return { success: false, error: 'No files selected' };

    const pluginsDir = path.join(os.homedir(), '.claude', 'plugins');
    if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

    const results = [];
    for (const filePath of filePaths) {
      try {
        const stat = fs.statSync(filePath);
        const basename = path.basename(filePath);

        if (stat.isDirectory()) {
          // Copy plugin directory
          const destDir = path.join(pluginsDir, basename);
          copyDirSync(filePath, destDir);
          results.push({ name: basename, path: destDir, type: 'directory' });
        } else if (filePath.endsWith('.zip')) {
          // For zip files, just copy to plugins directory — user would extract manually
          const destPath = path.join(pluginsDir, basename);
          fs.copyFileSync(filePath, destPath);
          results.push({ name: basename, path: destPath, type: 'zip' });
        } else if (filePath.endsWith('.js') || filePath.endsWith('.md')) {
          // Script or command file — copy to commands directory
          const commandsDir = path.join(os.homedir(), '.claude', 'commands');
          if (!fs.existsSync(commandsDir)) fs.mkdirSync(commandsDir, { recursive: true });
          const destPath = path.join(commandsDir, basename);
          fs.copyFileSync(filePath, destPath);
          results.push({ name: basename, path: destPath, type: filePath.endsWith('.md') ? 'command' : 'script' });
        }
      } catch (e) {
        results.push({ name: path.basename(filePath), error: e.message });
      }
    }
    return { success: true, results };
  });

  // ── Plugin File Watcher — push changes to renderer ──────

  const pluginWatchPaths = [
    path.join(os.homedir(), '.claude', 'plugins'),
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', '.mcp.json'),
    path.join(os.homedir(), '.claude.json')
  ];
  const watchers = [];
  let watchDebounce = null;

  function notifyPluginChange() {
    if (watchDebounce) clearTimeout(watchDebounce);
    watchDebounce = setTimeout(() => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('plugins:changed');
      }
    }, 1500); // Debounce 1.5s to avoid rapid-fire on bulk changes
  }

  for (const watchPath of pluginWatchPaths) {
    try {
      if (fs.existsSync(watchPath)) {
        const isDir = fs.statSync(watchPath).isDirectory();
        const watcher = fs.watch(watchPath, { recursive: isDir }, () => {
          notifyPluginChange();
        });
        watchers.push(watcher);
      }
    } catch (e) {
      // Some paths may not exist yet — that's OK
    }
  }

  // ── Group Coordination ─────────────────────────────────

  ipcMain.handle('group:createSharedFolder', (event, opts) => {
    // Create a shared group folder with member workspaces synced in
    const { groupName, memberNames, memberWorkspaces } = opts;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const folderName = `${memberNames.join('_')}_${timestamp}`;
    const groupsRoot = path.join(os.homedir(), '.omniclaw', 'group-workspaces');
    const groupFolder = path.join(groupsRoot, folderName);

    try {
      // Create group folder
      fs.mkdirSync(groupFolder, { recursive: true });

      // Create a subfolder for each member and copy/symlink their workspace
      for (let i = 0; i < memberNames.length; i++) {
        const memberDir = path.join(groupFolder, memberNames[i]);
        fs.mkdirSync(memberDir, { recursive: true });

        // Write a reference file pointing to the member's actual workspace
        const refFile = path.join(memberDir, '_workspace_ref.json');
        fs.writeFileSync(refFile, JSON.stringify({
          sessionName: memberNames[i],
          workspacePath: memberWorkspaces[i] || '',
          linkedAt: new Date().toISOString()
        }, null, 2));

        // Copy workspace if exists and is small enough
        if (memberWorkspaces[i] && fs.existsSync(memberWorkspaces[i])) {
          try {
            // Create a junction/symlink to the actual workspace for live sync
            const linkPath = path.join(memberDir, 'workspace');
            if (process.platform === 'win32') {
              require('child_process').execSync(`mklink /J "${linkPath}" "${memberWorkspaces[i]}"`, { shell: true });
            } else {
              fs.symlinkSync(memberWorkspaces[i], linkPath, 'dir');
            }
          } catch (linkErr) {
            // If symlink fails, write the path reference
            fs.writeFileSync(path.join(memberDir, 'workspace_path.txt'), memberWorkspaces[i]);
          }
        }
      }

      // Create a shared correspondence log
      const logFile = path.join(groupFolder, 'correspondence.md');
      fs.writeFileSync(logFile, `# Group: ${groupName}\n\nMembers: ${memberNames.join(', ')}\nCreated: ${new Date().toISOString()}\n\n---\n\n`);

      return { success: true, path: groupFolder, logFile };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('group:appendCorrespondence', (event, opts) => {
    const { folderPath, from, to, message } = opts;
    const logFile = path.join(folderPath, 'correspondence.md');
    try {
      const entry = `## ${from} → ${to}\n**${new Date().toISOString()}**\n\n${message}\n\n---\n\n`;
      fs.appendFileSync(logFile, entry);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('group:readCorrespondence', (event, folderPath) => {
    const logFile = path.join(folderPath, 'correspondence.md');
    try {
      if (fs.existsSync(logFile)) {
        return { content: fs.readFileSync(logFile, 'utf-8') };
      }
      return { content: '' };
    } catch (e) {
      return { error: e.message };
    }
  });

  // ── Remote API ──────────────────────────────────────────

  ipcMain.handle('remote:start', (event, port) => {
    return remoteApi.startServer(port || 3456);
  });

  ipcMain.handle('remote:stop', () => {
    remoteApi.stopServer();
    return { success: true };
  });

  ipcMain.handle('remote:status', () => {
    return { running: remoteApi.isRunning() };
  });

  // ── Discord Bot ────────────────────────────────────────

  const discordBot = require('./remote/discord-bot');

  // Forward Discord status changes to renderer
  discordBot.onStatusChange((status) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('discord:statusChanged', status);
    }
  });

  ipcMain.handle('discord:start', async (event, token) => {
    try {
      // Auto-save token and enabled state when starting
      if (token) {
        db.appState.set('discord_bot_token', token);
        db.appState.set('discord_bot_enabled', true);
      }
      return await discordBot.start(token);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('discord:stop', async () => {
    await discordBot.stop();
    return { success: true };
  });

  ipcMain.handle('discord:status', () => {
    return discordBot.getStatus();
  });

  ipcMain.handle('discord:setToken', (event, token) => {
    db.appState.set('discord_bot_token', token);
    return { success: true };
  });

  ipcMain.handle('discord:getToken', () => {
    const token = db.appState.get('discord_bot_token');
    return token ? { exists: true, masked: '***' + token.slice(-4) } : { exists: false };
  });

  ipcMain.handle('discord:bindings', () => {
    return db.channelBindings.listByPlatform('discord');
  });

  // ── App State ───────────────────────────────────────────

  ipcMain.handle('appState:get', (event, key) => {
    return db.appState.get(key);
  });

  ipcMain.handle('appState:set', (event, key, value) => {
    db.appState.set(key, value);
    return { success: true };
  });

  // ── OpenViking Context Database ─────────────────────────

  const ovServer = require('./openviking/ov-server');
  const ovClient = require('./openviking/ov-client');
  const ovIngest = require('./openviking/ov-ingest');

  // Start/stop OpenViking server
  ipcMain.handle('openviking:start', async () => {
    try {
      const started = await ovServer.startServer();
      return { success: started };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('openviking:stop', () => {
    ovServer.stopServer();
    return { success: true };
  });

  ipcMain.handle('openviking:status', async () => {
    const status = ovServer.getStatus();
    if (status.running) {
      try {
        const stats = await ovClient.stats();
        return { ...status, ...stats };
      } catch {
        return status;
      }
    }
    return status;
  });

  // Search
  ipcMain.handle('openviking:search', async (event, query, options = {}) => {
    try {
      return await ovClient.search(query, options);
    } catch (err) {
      return { error: err.message };
    }
  });

  // List / browse context filesystem
  ipcMain.handle('openviking:ls', async (event, uri) => {
    try {
      return await ovClient.ls(uri);
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('openviking:tree', async (event, uri, depth) => {
    try {
      return await ovClient.tree(uri, depth);
    } catch (err) {
      return { error: err.message };
    }
  });

  // Read a resource at a specific tier
  ipcMain.handle('openviking:read', async (event, uri, tier) => {
    try {
      return await ovClient.read(uri, tier);
    } catch (err) {
      return { error: err.message };
    }
  });

  // Add a resource
  ipcMain.handle('openviking:addResource', async (event, source, options) => {
    try {
      return await ovClient.addResource(source, options);
    } catch (err) {
      return { error: err.message };
    }
  });

  // Memory operations
  ipcMain.handle('openviking:listMemories', async (event, agentId, category) => {
    try {
      return await ovClient.listMemories(agentId, category);
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('openviking:searchMemories', async (event, query, agentId) => {
    try {
      return await ovClient.searchMemories(query, agentId);
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('openviking:extractMemory', async (event, sessionId, content) => {
    try {
      return await ovClient.extractMemory(sessionId, content);
    } catch (err) {
      return { error: err.message };
    }
  });

  // Ingestion operations
  ipcMain.handle('openviking:ingestAll', async () => {
    try {
      return await ovIngest.ingestAll();
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('openviking:ingestHytaleRefs', async () => {
    try {
      return await ovIngest.ingestHytaleReferences();
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('openviking:ingestCodex', async (event, codexPath) => {
    try {
      return await ovIngest.ingestCodex(codexPath);
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('openviking:ingestTranscript', async (event, sessionId, content, meta) => {
    try {
      return await ovIngest.ingestSingleTranscript(sessionId, content, meta);
    } catch (err) {
      return { error: err.message };
    }
  });

  // ── AutoResearch ───────────────────────────────────────────

  const targetAnalyzer = require('./autoresearch/target-analyzer');
  const experimentTracker = require('./autoresearch/experiment-tracker');
  const researchEngine = require('./autoresearch/research-engine');

  // Initialize research engine with references
  researchEngine.init({
    ptySpawn: PtyManager.create.bind(PtyManager),
    ptyWrite: PtyManager.write.bind(PtyManager),
    ovClient,
    db
  });

  // Initialize micro-ingest with OV client
  const microIngest = require('./openviking/ov-micro-ingest');
  microIngest.init(ovClient);

  // Forward research status changes to renderer
  researchEngine.onStatus((status) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('research:statusChanged', status);
    }
  });

  // Forward experiment completions to renderer + native notifications + blackboard
  researchEngine.onExperiment((result) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('research:experimentComplete', result);
    }

    // Write experiment results to blackboard for cross-session visibility
    if (result.experiment) {
      const exp = result.experiment;
      const rs = result.researchState;
      try {
        // Latest experiment result — any session can read this
        db.blackboard.set(
          result.targetId,
          `research:${result.targetId}:latest`,
          JSON.stringify({
            status: exp.status,
            metric: exp.metricName,
            value: exp.metricValue,
            description: exp.description,
            experimentCount: rs.experimentCount,
            bestValue: rs.bestMetricValue,
            timestamp: new Date().toISOString()
          }),
          'research',
          3600 // 1 hour TTL
        );
        // Best metric — persists longer
        if (exp.status === 'keep' && rs.bestMetricValue === exp.metricValue) {
          db.blackboard.set(
            result.targetId,
            `research:${result.targetId}:best`,
            JSON.stringify({
              metric: exp.metricName,
              value: exp.metricValue,
              experimentCount: rs.experimentCount,
              timestamp: new Date().toISOString()
            }),
            'research',
            86400 // 24 hour TTL
          );
        }
        // Broadcast blackboard update to renderer
        if (win && !win.isDestroyed()) {
          win.webContents.send('blackboard:updated', {
            sessionId: result.targetId,
            key: `research:${result.targetId}:latest`,
            category: 'research'
          });
        }
      } catch (bbErr) {
        console.log('[Research] Blackboard write failed:', bbErr.message);
      }
    }

    // Native notifications for key research events
    if (result.autoStopped) {
      notifier.researchAutoStopped(result.targetId, result.stopReason);
    } else if (result.experiment) {
      const exp = result.experiment;
      const state = result.researchState;

      // Notify on new best metric
      if (exp.status === 'keep' && state.bestMetricValue === exp.metricValue) {
        notifier.researchNewBest(result.targetId, exp.metricName, exp.metricValue, state.experimentCount);
      }

      // Notify on crashes
      if (exp.status === 'crash') {
        notifier.researchExperimentFailed(result.targetId, state.experimentCount, exp.description);
      }
    }
  });

  // Scan all available targets (plugins, MCPs, skills)
  ipcMain.handle('research:listTargets', () => {
    return targetAnalyzer.scanAll();
  });

  // Deep-analyze a single target
  ipcMain.handle('research:analyzeTarget', (event, targetId) => {
    return targetAnalyzer.analyze(targetId);
  });

  // Start autonomous research on a target
  ipcMain.handle('research:start', async (event, config) => {
    // Headless mode: use claude -p (pipe mode) with structured JSON output
    if (config.mode === 'headless') {
      return startHeadlessResearch(config, getMainWindow, notifier);
    }

    const result = await researchEngine.startResearch(config);
    if (!result.success) return result;

    // Spawn a dedicated PTY session for the research agent
    try {
      const session = PtyManager.create(result.sessionId, {
        cwd: result.workspacePath,
        cols: 120,
        rows: 40,
        skipPerms: true,
        launchClaude: true,
        maxTurns: config.maxTurns || 500,  // Research needs many turns (reads, edits, tests)
        name: `Research: ${result.targetId}`,
        verbose: false,
      });

      let promptSent = false;
      const spawnTime = Date.now();
      console.log(`[Research] PTY spawned for ${result.targetId}, session=${result.sessionId}, cwd=${result.workspacePath}`);

      // Build the research prompt once
      const safePath = result.programPath.replace(/\\/g, '/');
      const researchPrompt = `Read the file ${safePath} for your research instructions, then begin the experiment loop. Start by reading all editable files listed in the program, establish a baseline understanding, then immediately begin your first experiment.`;

      function sendResearchPrompt(reason) {
        if (promptSent) return;
        promptSent = true;
        console.log('[Research] Sending initial prompt (' + reason + ') to', result.sessionId);
        PtyManager.write(result.sessionId, researchPrompt + '\r');
      }

      session.onDataCallback = (data) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('pty:data', { id: result.sessionId, data });
        }
        // Process output for experiment result detection
        researchEngine.processOutput(result.sessionId, data);

        // Detect when Claude CLI is ready and send the initial research prompt.
        // Skip first 1.5s to avoid matching PowerShell's PS C:\...> prompt.
        // Claude CLI launches at T+800ms, greeting arrives ~T+1.5-2.5s.
        if (!promptSent) {
          if (Date.now() - spawnTime < 1500) return;
          const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
          // Match Claude CLI greeting patterns, standalone > prompt, or the tips banner
          if (clean.includes('How can I help') ||
              clean.includes('What would you like') ||
              clean.includes('What can I help') ||
              clean.includes('Tips:') ||
              clean.includes('Claude') ||
              /^\s*>\s*$/m.test(clean)) {
            // Brief delay to let Claude finish rendering its greeting
            setTimeout(() => sendResearchPrompt('greeting-detected'), 300);
          }
        }
      };

      session.onExitCallback = (exitCode) => {
        const elapsedSec = Math.round((Date.now() - spawnTime) / 1000);
        const status = researchEngine.getStatus(result.targetId);
        const expCount = status.experimentCount || 0;
        const wasActive = status.status !== 'idle';
        console.log(`[Research] PTY exited for ${result.targetId}: code=${exitCode}, elapsed=${elapsedSec}s, experiments=${expCount}, promptSent=${promptSent}, wasActive=${wasActive}`);

        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('pty:exit', { id: result.sessionId, exitCode });
        }

        // Skip if already cleaned up by manual stop (prevents duplicate notifications)
        if (!wasActive) {
          console.log(`[Research] PTY exit for ${result.targetId} — already stopped, skipping autoStop`);
          return;
        }

        // Determine stop reason for better diagnostics
        let reason;
        if (exitCode !== 0 && elapsedSec < 10) {
          reason = `CLI exited immediately (code ${exitCode}) — check claude auth/installation`;
        } else if (exitCode !== 0) {
          reason = `CLI exited with error (code ${exitCode}) after ${elapsedSec}s`;
        } else if (expCount === 0 && elapsedSec < 30) {
          reason = `session ended before any experiments (${elapsedSec}s) — may need more max-turns`;
        } else if (expCount === 0) {
          reason = `max-turns reached with 0 experiments — try increasing max-turns`;
        } else {
          reason = `max-turns reached after ${expCount} experiments`;
        }

        // Use autoStop with reason so the user gets a diagnostic toast
        researchEngine.autoStopResearch(result.targetId, reason);
        notifier.researchStopped(result.targetId, reason);
      };

      session.spawn();

      // Fallback: if greeting detection missed, send prompt after 8 seconds regardless.
      // Claude CLI should definitely be ready by then.
      setTimeout(() => sendResearchPrompt('fallback-timer'), 8000);

      // Notify user that research has started
      notifier.researchStarted(result.targetId);
    } catch (err) {
      // Kill any zombie PTY process that may have been created before the error
      try { PtyManager.kill(result.sessionId); } catch { /* may not exist */ }
      researchEngine.stopResearch(result.targetId);
      return { success: false, error: `PTY spawn failed: ${err.message}` };
    }

    return result;
  });

  // Stop research (PTY or headless)
  ipcMain.handle('research:stop', (event, targetId) => {
    // Try headless abort first
    const headlessResearch = require('./autoresearch/headless-research');
    if (headlessResearch.isHeadlessActive(targetId)) {
      const abortResult = headlessResearch.abortHeadlessResearch(targetId);
      // Also clean up research engine state (headless uses both maps)
      try { researchEngine.stopResearch(targetId); } catch { /* may not exist */ }
      if (abortResult.success) notifier.researchStopped(targetId, 'manual stop (headless)');
      return abortResult;
    }

    // PTY mode
    const status = researchEngine.getStatus(targetId);
    if (status.sessionId) {
      try { PtyManager.kill(status.sessionId); } catch (killErr) {
        console.warn('[Research:stop] PTY kill failed:', killErr.message);
      }
    }
    const stopResult = researchEngine.stopResearch(targetId);
    if (stopResult.success) notifier.researchStopped(targetId, 'manual stop');
    return stopResult;
  });

  // Pause research
  ipcMain.handle('research:pause', (event, targetId) => {
    return researchEngine.pauseResearch(targetId);
  });

  // Get status for a single target
  ipcMain.handle('research:status', (event, targetId) => {
    return researchEngine.getStatus(targetId);
  });

  // Get status of all active research (PTY + headless)
  ipcMain.handle('research:allStatus', () => {
    const ptyStatus = researchEngine.getAllStatus();
    try {
      const headlessResearch = require('./autoresearch/headless-research');
      const headlessStatus = headlessResearch.getHeadlessStatus();
      return { ...ptyStatus, ...headlessStatus };
    } catch {
      return ptyStatus;
    }
  });

  // Get experiments for a target (from DB)
  ipcMain.handle('research:experiments', (event, targetId, limit) => {
    return db.experiments.getByTarget(targetId, limit);
  });

  // Get experiment timeline for a target (auto-fallback: DB → TSV)
  ipcMain.handle('research:timeline', (event, targetId) => {
    const dbTimeline = db.experiments.getTimeline(targetId);
    if (dbTimeline && dbTimeline.length > 0) return dbTimeline;
    // Fallback to TSV if DB is empty
    const rows = experimentTracker.readTsv(targetId);
    return rows.map((r, i) => ({
      id: i + 1,
      metric_name: r.metricName,
      metric_value: r.metricValue,
      status: r.status,
      description: r.description,
      created_at: r.timestamp
    }));
  });

  // Get best experiment for a target
  ipcMain.handle('research:bestMetrics', (event, targetId) => {
    return db.experiments.getBestByTarget(targetId);
  });

  // Get recent experiments across all targets
  ipcMain.handle('research:recentExperiments', (event, limit) => {
    return db.experiments.getRecent(limit);
  });

  // Get experiment stats from TSV
  ipcMain.handle('research:stats', (event, targetId) => {
    return experimentTracker.getStats(targetId);
  });

  // Get full TSV timeline data (fallback when DB is empty)
  ipcMain.handle('research:tsvTimeline', (event, targetId) => {
    const rows = experimentTracker.readTsv(targetId);
    return rows.map((r, i) => ({
      id: i + 1,
      metric_name: r.metricName,
      metric_value: r.metricValue,
      status: r.status,
      description: r.description,
      created_at: r.timestamp
    }));
  });

  // Get all research targets from DB
  ipcMain.handle('research:dbTargets', () => {
    return db.researchTargets.list();
  });

  // Delete a research target and its experiments
  ipcMain.handle('research:deleteTarget', (event, targetId) => {
    try {
      researchEngine.stopResearch(targetId);
    } catch (e) {
      console.log('[Research:deleteTarget] Stop skipped (may not be active):', e.message);
    }
    db.researchTargets.delete(targetId);
    return { success: true };
  });

  // ── Blackboard (cross-session shared state) ─────────────

  ipcMain.handle('blackboard:set', (event, sessionId, key, value, category, ttl) => {
    db.blackboard.set(sessionId, key, value, category, ttl);
    // Notify all renderers
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('blackboard:updated', { sessionId, key, value, category });
    }
    return { success: true };
  });

  ipcMain.handle('blackboard:get', (event, key) => {
    return db.blackboard.get(key);
  });

  ipcMain.handle('blackboard:list', (event, category) => {
    if (category) return db.blackboard.getByCategory(category);
    return db.blackboard.list();
  });

  ipcMain.handle('blackboard:delete', (event, key) => {
    db.blackboard.delete(key);
    return { success: true };
  });

  ipcMain.handle('blackboard:clear', (event, sessionId) => {
    db.blackboard.clear(sessionId || null);
    return { success: true };
  });

  // ── Hook Events ─────────────────────────────────────────

  ipcMain.handle('hooks:recent', (event, limit) => {
    return db.hookEvents.getRecent(limit || 50);
  });

  ipcMain.handle('hooks:bySession', (event, sessionId, limit) => {
    return db.hookEvents.getBySession(sessionId, limit || 50);
  });

  ipcMain.handle('hooks:stats', () => {
    return db.hookEvents.getToolUsageStats();
  });

  // Wire hook events from Remote API to renderer
  remoteApi.onHookEvent((hookEvent) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('hooks:event', hookEvent);
    }
  });
}

/**
 * Start headless (pipe mode) research — runs Claude CLI with -p flag.
 * Returns immediately; the research loop runs asynchronously.
 */
async function startHeadlessResearch(config, getMainWindow, notifier) {
  const headlessResearch = require('./autoresearch/headless-research');
  const researchEngine = require('./autoresearch/research-engine');
  const experimentTracker = require('./autoresearch/experiment-tracker');

  // Use the research engine to set up the target and generate program.md
  const result = await researchEngine.startResearch(config);
  if (!result.success) return result;

  // Immediately mark as headless mode and return to UI
  console.log(`[HeadlessResearch] Starting headless research for ${result.targetId}`);
  notifier.researchStarted(result.targetId);

  // Initialize experiment tracking
  experimentTracker.initTarget(result.targetId);

  let ovClient = null;
  try { ovClient = require('./openviking/ov-client'); } catch { /* OV not available */ }

  // Run the headless research loop asynchronously (non-blocking)
  headlessResearch.runHeadlessResearch({
    targetId: result.targetId,
    profile: result.profile,
    programPath: result.programPath,
    workspacePath: result.workspacePath,
    maxExperiments: config.maxExperiments || 20,
    maxTurnsPerExperiment: config.maxTurns || 200,
    maxConsecutiveDiscards: config.maxConsecutiveDiscards || 5,
    dbRef: db,
    ovClientRef: ovClient,
    onExperiment: (data) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('research:experimentComplete', data);
      }

      // Notifications
      if (data.autoStopped) {
        notifier.researchAutoStopped(data.targetId, data.stopReason);
        // Clean up research engine state
        researchEngine.stopResearch(data.targetId);
      } else if (data.experiment) {
        const exp = data.experiment;
        const state = data.researchState;
        if (exp.status === 'keep' && state.bestMetricValue === exp.metricValue) {
          notifier.researchNewBest(data.targetId, exp.metricName, exp.metricValue, state.experimentCount);
        }
        if (exp.status === 'crash') {
          notifier.researchExperimentFailed(data.targetId, state.experimentCount, exp.description);
        }
      }
    },
    onStatus: (status) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('research:statusChanged', status);
      }
    },
  }).then((finalResult) => {
    console.log(`[HeadlessResearch] Completed for ${result.targetId}:`, JSON.stringify(finalResult));
    // Clean up research engine state after headless completion
    researchEngine.stopResearch(result.targetId);
    notifier.researchStopped(result.targetId, finalResult.stopReason || 'completed');
  }).catch((err) => {
    console.error(`[HeadlessResearch] Error for ${result.targetId}:`, err.message);
    researchEngine.stopResearch(result.targetId);
    notifier.researchStopped(result.targetId, `error: ${err.message}`);
  });

  return { ...result, mode: 'headless' };
}

function cleanup() {
  transcriber.closeAll();
  mcpManager.stopAll();
  try {
    const discordBot = require('./remote/discord-bot');
    discordBot.stop();
  } catch (e) {
    console.warn('[Cleanup] Discord bot stop failed:', e.message);
  }
  try {
    const ovServer = require('./openviking/ov-server');
    ovServer.stopServer();
  } catch (e) {
    console.warn('[Cleanup] OV server stop failed:', e.message);
  }
  db.close();
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

module.exports = { registerIpcHandlers, cleanup };
