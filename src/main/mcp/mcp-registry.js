// MCP Registry — Stores discovered tools from all MCP servers

class McpRegistry {
  constructor() {
    this.tools = new Map(); // serverName -> tool[]
  }

  setTools(serverName, tools) {
    this.tools.set(serverName, tools);
  }

  getTools(serverName) {
    return this.tools.get(serverName) || [];
  }

  getAllTools() {
    const allTools = [];
    for (const [serverName, tools] of this.tools) {
      for (const tool of tools) {
        allTools.push({ ...tool, serverName });
      }
    }
    return allTools;
  }

  removeServer(serverName) {
    this.tools.delete(serverName);
  }

  clear() {
    this.tools.clear();
  }
}

module.exports = { McpRegistry };
