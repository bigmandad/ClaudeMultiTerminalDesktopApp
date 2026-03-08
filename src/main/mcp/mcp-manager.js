const { spawn } = require('child_process');
const { wrapCommand } = require('./mcp-config');
const { McpRegistry } = require('./mcp-registry');

class McpManager {
  constructor() {
    this.servers = new Map(); // name -> { process, status, tools, config }
    this.registry = new McpRegistry();
    this.statusCallback = null;
  }

  onStatusChange(callback) {
    this.statusCallback = callback;
  }

  async startServer(name, config) {
    if (this.servers.has(name)) {
      await this.stopServer(name);
    }

    const { command, args } = wrapCommand(config.command, config.args || []);
    const env = { ...process.env, ...(config.env || {}) };

    try {
      const proc = spawn(command, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

      const server = {
        process: proc,
        status: 'starting',
        tools: [],
        config,
        buffer: ''
      };

      this.servers.set(name, server);

      proc.stdout.on('data', (chunk) => {
        server.buffer += chunk.toString();
        this._processBuffer(name, server);
      });

      proc.stderr.on('data', (chunk) => {
        console.warn(`[MCP:${name}] stderr:`, chunk.toString().trim());
      });

      proc.on('error', (err) => {
        console.error(`[MCP:${name}] process error:`, err.message);
        server.status = 'error';
        this._notifyStatus(name, server);
      });

      proc.on('exit', (code) => {
        console.log(`[MCP:${name}] exited with code ${code}`);
        server.status = 'stopped';
        this._notifyStatus(name, server);
      });

      // Send initialize
      await this._initialize(name, server);

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async stopServer(name) {
    const server = this.servers.get(name);
    if (!server) return;

    try {
      if (server.process && !server.process.killed) {
        server.process.kill();
      }
    } catch (e) { /* ignore */ }

    this.servers.delete(name);
    this._notifyStatus(name, { status: 'stopped', tools: [] });
  }

  async _initialize(name, server) {
    this._sendJsonRpc(server.process, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'claude-sessions', version: '0.1.0' }
      }
    });
  }

  _sendJsonRpc(proc, message) {
    try {
      const json = JSON.stringify(message);
      proc.stdin.write(json + '\n');
    } catch (e) {
      console.error('Failed to send JSON-RPC:', e.message);
    }
  }

  _processBuffer(name, server) {
    const lines = server.buffer.split('\n');
    server.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this._handleMessage(name, server, msg);
      } catch (e) { /* skip non-JSON lines */ }
    }
  }

  _handleMessage(name, server, msg) {
    if (msg.id === 1 && msg.result) {
      // Initialize response
      server.status = 'connected';
      this._notifyStatus(name, server);

      // Send initialized notification
      this._sendJsonRpc(server.process, {
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      });

      // Request tools list
      this._sendJsonRpc(server.process, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list'
      });
    } else if (msg.id === 2 && msg.result) {
      // Tools list response
      server.tools = (msg.result.tools || []).map(t => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || {}
      }));
      this._notifyStatus(name, server);
    } else if (msg.method === 'notifications/tools/list_changed') {
      // Refresh tools
      this._sendJsonRpc(server.process, {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/list'
      });
    }
  }

  _notifyStatus(name, server) {
    if (this.statusCallback) {
      this.statusCallback({
        name,
        status: server.status,
        tools: server.tools || [],
        toolCount: (server.tools || []).length
      });
    }
  }

  getStatus() {
    const result = {};
    for (const [name, server] of this.servers) {
      result[name] = {
        status: server.status,
        tools: server.tools || [],
        toolCount: (server.tools || []).length
      };
    }
    return result;
  }

  getTools(name) {
    const server = this.servers.get(name);
    return server ? server.tools || [] : [];
  }

  getAllTools() {
    const allTools = [];
    for (const [name, server] of this.servers) {
      for (const tool of (server.tools || [])) {
        allTools.push({ ...tool, serverName: name });
      }
    }
    return allTools;
  }

  isAllConnected() {
    if (this.servers.size === 0) return true;
    for (const server of this.servers.values()) {
      if (server.status !== 'connected') return false;
    }
    return true;
  }

  stopAll() {
    for (const name of this.servers.keys()) {
      this.stopServer(name);
    }
  }
}

module.exports = { McpManager };
