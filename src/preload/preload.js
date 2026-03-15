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
    checkClaudeAuth: () => ipcRenderer.invoke('app:checkClaudeAuth')
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

  // ── App State ────────────────────────────────────────────
  appState: {
    get: (key) => ipcRenderer.invoke('appState:get', key),
    set: (key, value) => ipcRenderer.invoke('appState:set', key, value)
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
  }
});
