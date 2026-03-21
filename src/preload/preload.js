const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── PTY ──────────────────────────────────────────────────
  pty: {
    spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
    write: (id, data) => ipcRenderer.send('pty:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke('pty:kill', { id }),
    onData: (callback) => {
      const handler = (_event, payload) => callback(payload.id, payload.data);
      ipcRenderer.on('pty:data', handler);
      return () => ipcRenderer.removeListener('pty:data', handler);
    },
    onExit: (callback) => {
      const handler = (_event, payload) => callback(payload.id, payload.exitCode);
      ipcRenderer.on('pty:exit', handler);
      return () => ipcRenderer.removeListener('pty:exit', handler);
    },
    onDiscordSessionRequested: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('discord:sessionRequested', handler);
      return () => ipcRenderer.removeListener('discord:sessionRequested', handler);
    },
    onDiscordSessionEnded: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('discord:sessionEnded', handler);
      return () => ipcRenderer.removeListener('discord:sessionEnded', handler);
    }
  },

  // ── Sessions ─────────────────────────────────────────────
  session: {
    create: (session) => ipcRenderer.invoke('session:create', session),
    list: () => ipcRenderer.invoke('session:list'),
    get: (id) => ipcRenderer.invoke('session:get', id),
    update: (id, data) => ipcRenderer.invoke('session:update', id, data),
    delete: (id) => ipcRenderer.invoke('session:delete', id),
    restore: () => ipcRenderer.invoke('session:restore'),
    checkResume: (path) => ipcRenderer.invoke('session:checkResume', path)
  },

  // ── Groups ───────────────────────────────────────────────
  group: {
    create: (group) => ipcRenderer.invoke('group:create', group),
    list: () => ipcRenderer.invoke('group:list'),
    delete: (id) => ipcRenderer.invoke('group:delete', id),
    createSharedFolder: (opts) => ipcRenderer.invoke('group:createSharedFolder', opts),
    appendCorrespondence: (opts) => ipcRenderer.invoke('group:appendCorrespondence', opts),
    readCorrespondence: (folderPath) => ipcRenderer.invoke('group:readCorrespondence', folderPath)
  },

  // ── Usage Stats ──────────────────────────────────────────
  usage: {
    record: (entry) => ipcRenderer.invoke('usage:record', entry),
    totals: () => ipcRenderer.invoke('usage:totals'),
    monthly: () => ipcRenderer.invoke('usage:monthly'),
    bySession: (id) => ipcRenderer.invoke('usage:bySession', id),
    readCliUsage: () => ipcRenderer.invoke('usage:readCliUsage')
  },

  // ── Plugins Detection & Management ──────────────────────
  plugins: {
    detect: () => ipcRenderer.invoke('plugins:detect'),
    toggle: (pluginId, enabled) => ipcRenderer.invoke('plugins:toggle', pluginId, enabled),
    upload: (opts) => ipcRenderer.invoke('plugins:upload', opts),
    onChanged: (callback) => {
      const handler = () => callback();
      ipcRenderer.on('plugins:changed', handler);
      return () => ipcRenderer.removeListener('plugins:changed', handler);
    }
  },

  // ── File System ──────────────────────────────────────────
  fs: {
    readDir: (path) => ipcRenderer.invoke('fs:readDir', path),
    readDirDeep: (path, depth) => ipcRenderer.invoke('fs:readDirDeep', path, depth),
    readFile: (path) => ipcRenderer.invoke('fs:readFile', path),
    stat: (path) => ipcRenderer.invoke('fs:stat', path),
    openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
    openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts)
  },

  // ── Workspace ────────────────────────────────────────────
  workspace: {
    detectClaudeMd: (path) => ipcRenderer.invoke('workspace:detectClaudeMd', path),
    fileMap: (path) => ipcRenderer.invoke('workspace:fileMap', path)
  },

  // ── MCP ──────────────────────────────────────────────────
  mcp: {
    startServer: (opts) => ipcRenderer.invoke('mcp:startServer', opts),
    stopServer: (name) => ipcRenderer.invoke('mcp:stopServer', name),
    listTools: (name) => ipcRenderer.invoke('mcp:listTools', name),
    allTools: () => ipcRenderer.invoke('mcp:allTools'),
    status: () => ipcRenderer.invoke('mcp:status'),
    getConfig: () => ipcRenderer.invoke('mcp:getConfig'),
    mergedConfig: (workspacePath) => ipcRenderer.invoke('mcp:mergedConfig', workspacePath),
    writeTempConfig: (servers) => ipcRenderer.invoke('mcp:writeTempConfig', servers),
    onServerStatus: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('mcp:serverStatus', handler);
      return () => ipcRenderer.removeListener('mcp:serverStatus', handler);
    }
  },

  // ── Git ──────────────────────────────────────────────────
  git: {
    isRepo: (cwd) => ipcRenderer.invoke('git:isRepo', cwd),
    status: (cwd) => ipcRenderer.invoke('git:status', cwd),
    diff: (cwd) => ipcRenderer.invoke('git:diff', cwd),
    diffFull: (cwd) => ipcRenderer.invoke('git:diffFull', cwd),
    autoCommit: (cwd, name) => ipcRenderer.invoke('git:autoCommit', cwd, name),
    createWorktree: (cwd, name) => ipcRenderer.invoke('git:createWorktree', cwd, name),
    createRepo: (opts) => ipcRenderer.invoke('git:createRepo', opts),
    log: (cwd, limit) => ipcRenderer.invoke('git:log', cwd, limit)
  },

  // ── Transcription ────────────────────────────────────────
  transcript: {
    list: (sessionId) => ipcRenderer.invoke('transcript:list', sessionId),
    read: (sessionId, date) => ipcRenderer.invoke('transcript:read', sessionId, date)
  },

  // ── Recent Paths ─────────────────────────────────────────
  recentPaths: {
    add: (sessionId, path, type) => ipcRenderer.invoke('recentPaths:add', sessionId, path, type),
    list: (sessionId) => ipcRenderer.invoke('recentPaths:list', sessionId)
  },

  // ── Shell / App ──────────────────────────────────────────
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    openPath: (path) => ipcRenderer.invoke('shell:openPath', path)
  },

  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getPlatform: () => ipcRenderer.invoke('app:getPlatform'),
    checkClaudeAuth: () => ipcRenderer.invoke('app:checkClaudeAuth'),
    dbHealth: () => ipcRenderer.invoke('app:dbHealth'),
    update: () => ipcRenderer.invoke('app:update'),
    restart: () => ipcRenderer.invoke('app:restart'),
    uploadLog: () => ipcRenderer.invoke('app:uploadLog')
  },

  clipboard: {
    write: (text) => ipcRenderer.invoke('clipboard:write', text),
    read: () => ipcRenderer.invoke('clipboard:read')
  },

  // ── Notifications ────────────────────────────────────────
  notify: {
    show: (opts) => ipcRenderer.invoke('notify:show', opts),
    mute: (muted) => ipcRenderer.invoke('notify:mute', muted)
  },

  // ── Remote API ──────────────────────────────────────────
  remote: {
    start: (port) => ipcRenderer.invoke('remote:start', port),
    stop: () => ipcRenderer.invoke('remote:stop'),
    status: () => ipcRenderer.invoke('remote:status')
  },

  // ── Discord Bot ────────────────────────────────────────
  discord: {
    start: (token) => ipcRenderer.invoke('discord:start', token),
    stop: () => ipcRenderer.invoke('discord:stop'),
    status: () => ipcRenderer.invoke('discord:status'),
    setToken: (token) => ipcRenderer.invoke('discord:setToken', token),
    getToken: () => ipcRenderer.invoke('discord:getToken'),
    bindings: () => ipcRenderer.invoke('discord:bindings'),
    onStatusChanged: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('discord:statusChanged', handler);
      return () => ipcRenderer.removeListener('discord:statusChanged', handler);
    }
  },

  // ── App State ────────────────────────────────────────────
  appState: {
    get: (key) => ipcRenderer.invoke('appState:get', key),
    set: (key, value) => ipcRenderer.invoke('appState:set', key, value)
  },

  // ── AutoResearch ─────────────────────────────────────────
  research: {
    listTargets: () => ipcRenderer.invoke('research:listTargets'),
    analyzeTarget: (targetId) => ipcRenderer.invoke('research:analyzeTarget', targetId),
    start: (config) => ipcRenderer.invoke('research:start', config),
    stop: (targetId) => ipcRenderer.invoke('research:stop', targetId),
    pause: (targetId) => ipcRenderer.invoke('research:pause', targetId),
    status: (targetId) => ipcRenderer.invoke('research:status', targetId),
    allStatus: () => ipcRenderer.invoke('research:allStatus'),
    experiments: (targetId, limit) => ipcRenderer.invoke('research:experiments', targetId, limit),
    timeline: (targetId) => ipcRenderer.invoke('research:timeline', targetId),
    bestMetrics: (targetId) => ipcRenderer.invoke('research:bestMetrics', targetId),
    recentExperiments: (limit) => ipcRenderer.invoke('research:recentExperiments', limit),
    stats: (targetId) => ipcRenderer.invoke('research:stats', targetId),
    tsvTimeline: (targetId) => ipcRenderer.invoke('research:tsvTimeline', targetId),
    dbTargets: () => ipcRenderer.invoke('research:dbTargets'),
    deleteTarget: (targetId) => ipcRenderer.invoke('research:deleteTarget', targetId),
    onStatusChanged: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('research:statusChanged', handler);
      return () => ipcRenderer.removeListener('research:statusChanged', handler);
    },
    onExperimentComplete: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('research:experimentComplete', handler);
      return () => ipcRenderer.removeListener('research:experimentComplete', handler);
    }
  },

  // ── OpenViking Context Database ─────────────────────────
  openviking: {
    start: () => ipcRenderer.invoke('openviking:start'),
    stop: () => ipcRenderer.invoke('openviking:stop'),
    status: () => ipcRenderer.invoke('openviking:status'),
    onServerReady: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('openviking:serverReady', handler);
      return () => ipcRenderer.removeListener('openviking:serverReady', handler);
    },
    search: (query, options) => ipcRenderer.invoke('openviking:search', query, options),
    ls: (uri) => ipcRenderer.invoke('openviking:ls', uri),
    tree: (uri, depth) => ipcRenderer.invoke('openviking:tree', uri, depth),
    read: (uri, tier) => ipcRenderer.invoke('openviking:read', uri, tier),
    addResource: (source, options) => ipcRenderer.invoke('openviking:addResource', source, options),
    listMemories: (agentId, category) => ipcRenderer.invoke('openviking:listMemories', agentId, category),
    searchMemories: (query, agentId) => ipcRenderer.invoke('openviking:searchMemories', query, agentId),
    extractMemory: (sessionId, content) => ipcRenderer.invoke('openviking:extractMemory', sessionId, content),
    ingestAll: () => ipcRenderer.invoke('openviking:ingestAll'),
    ingestHytaleRefs: () => ipcRenderer.invoke('openviking:ingestHytaleRefs'),
    ingestCodex: (codexPath) => ipcRenderer.invoke('openviking:ingestCodex', codexPath),
    ingestTranscript: (sessionId, content, meta) => ipcRenderer.invoke('openviking:ingestTranscript', sessionId, content, meta)
  },

  // ── Blackboard (cross-session shared state) ─────────────
  blackboard: {
    set: (sessionId, key, value, category, ttl) => ipcRenderer.invoke('blackboard:set', sessionId, key, value, category, ttl),
    get: (key) => ipcRenderer.invoke('blackboard:get', key),
    list: (category) => ipcRenderer.invoke('blackboard:list', category),
    delete: (key) => ipcRenderer.invoke('blackboard:delete', key),
    clear: (sessionId) => ipcRenderer.invoke('blackboard:clear', sessionId),
    onUpdated: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('blackboard:updated', handler);
      return () => ipcRenderer.removeListener('blackboard:updated', handler);
    }
  },

  // ── Setup Wizard ────────────────────────────────────────
  setup: {
    // Legacy / existing
    isComplete: () => ipcRenderer.invoke('setup:isComplete'),
    checkDeps: () => ipcRenderer.invoke('setup:checkDeps'),
    installDep: (name, command) => ipcRenderer.invoke('setup:installDep', { name, command }),
    configure: (opts) => ipcRenderer.invoke('setup:configure', opts),
    pullModel: (model) => ipcRenderer.invoke('setup:pullModel', { model }),
    markComplete: () => ipcRenderer.invoke('setup:markComplete'),
    getMachineId: () => ipcRenderer.invoke('setup:getMachineId'),
    detectHytalePath: () => ipcRenderer.invoke('setup:detectHytalePath'),
    onInstallProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('setup:installProgress', handler);
      return () => ipcRenderer.removeListener('setup:installProgress', handler);
    },
    onModelProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('setup:modelProgress', handler);
      return () => ipcRenderer.removeListener('setup:modelProgress', handler);
    },
    // New: Resumable state
    getState: () => ipcRenderer.invoke('setup:getState'),
    saveState: (update) => ipcRenderer.invoke('setup:saveState', update),
    // New: Workspace root
    getWorkspaceRoot: () => ipcRenderer.invoke('setup:getWorkspaceRoot'),
    // New: Turso credentials
    saveTurso: (url, token) => ipcRenderer.invoke('setup:saveTurso', { url, token }),
    testTurso: (url, token) => ipcRenderer.invoke('setup:testTurso', { url, token }),
    // New: Ollama service
    startOllama: () => ipcRenderer.invoke('setup:startOllama'),
    checkOllama: () => ipcRenderer.invoke('setup:checkOllama'),
    // New: Repo cloning
    cloneRepos: () => ipcRenderer.invoke('setup:cloneRepos'),
    onCloneProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('setup:cloneProgress', handler);
      return () => ipcRenderer.removeListener('setup:cloneProgress', handler);
    },
    // New: Plugin configuration
    configurePlugins: () => ipcRenderer.invoke('setup:configurePlugins'),
    // New: PATH refresh
    refreshPath: () => ipcRenderer.invoke('setup:refreshPath'),
    // New: Comprehensive verification
    verify: () => ipcRenderer.invoke('setup:verify'),
  },

  // ── Plugin Sync (cross-machine plugin synchronisation) ──
  pluginSync: {
    getInstalled: () => ipcRenderer.invoke('pluginSync:getInstalled'),
    getMissing: () => ipcRenderer.invoke('pluginSync:getMissing'),
    pushManifest: () => ipcRenderer.invoke('pluginSync:pushManifest'),
    syncAll: () => ipcRenderer.invoke('pluginSync:syncAll'),
  },

  // ── Watchdog Health Monitor ─────────────────────────────
  watchdog: {
    status: () => ipcRenderer.invoke('watchdog:status'),
    start: () => ipcRenderer.invoke('watchdog:start'),
    stop: () => ipcRenderer.invoke('watchdog:stop'),
    runNow: () => ipcRenderer.invoke('watchdog:runNow'),
    consentGitPush: () => ipcRenderer.invoke('watchdog:consentGitPush'),
    revokeGitPush: () => ipcRenderer.invoke('watchdog:revokeGitPush'),
    onStatus: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('watchdog:status', handler);
      return () => ipcRenderer.removeListener('watchdog:status', handler);
    }
  },

  // ── Hook Events (Claude Code lifecycle) ──────────────────
  hooks: {
    recent: (limit) => ipcRenderer.invoke('hooks:recent', limit),
    bySession: (sessionId, limit) => ipcRenderer.invoke('hooks:bySession', sessionId, limit),
    stats: () => ipcRenderer.invoke('hooks:stats'),
    onEvent: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('hooks:event', handler);
      return () => ipcRenderer.removeListener('hooks:event', handler);
    }
  }
});
