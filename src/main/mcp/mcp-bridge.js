// ── MCP Bridge — Translates MCP tools to provider-native function-calling ──
//
// Reads tools from McpManager, converts schemas to OpenAI/Gemini/Ollama format,
// and executes tool calls by routing back through MCP JSON-RPC.

class McpBridge {
  /**
   * @param {import('./mcp-manager').McpManager} mcpManager
   */
  constructor(mcpManager) {
    this._mcp = mcpManager;
  }

  /**
   * Get all MCP tools formatted for a specific provider.
   * @param {'openai'|'gemini'|'ollama'} format
   * @returns {Array} Tools in provider-native format
   */
  getToolsForProvider(format = 'openai') {
    const allTools = this._mcp.getAllTools();
    if (!allTools.length) return [];

    switch (format) {
      case 'openai':
      case 'ollama':
        return allTools.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description || `MCP tool: ${t.name}`,
            parameters: this._cleanSchema(t.inputSchema),
          }
        }));

      case 'gemini':
        return [{
          functionDeclarations: allTools.map(t => ({
            name: t.name,
            description: t.description || `MCP tool: ${t.name}`,
            parameters: this._cleanSchema(t.inputSchema),
          }))
        }];

      case 'raw':
        // Return raw MCP format (name, description, inputSchema)
        return allTools;

      default:
        return allTools;
    }
  }

  /**
   * Execute a tool call by routing to the appropriate MCP server.
   * @param {string} toolName
   * @param {object} args
   * @returns {Promise<string>} Tool result as string
   */
  async executeTool(toolName, args = {}) {
    const match = this._mcp.findToolServer(toolName);
    if (!match) {
      throw new Error(`Unknown tool: ${toolName}. Available: ${this._mcp.getAllTools().map(t => t.name).join(', ')}`);
    }

    console.log(`[McpBridge] Executing ${toolName} on ${match.serverName}`);
    const result = await this._mcp.callTool(match.serverName, toolName, args);

    // MCP tool results can be structured — extract text content
    return this._extractResultText(result);
  }

  /**
   * Create a tool call handler function for use with ApiPtyEmitter.streamResponse().
   * @returns {Function} (toolName, args) => Promise<string>
   */
  createToolHandler() {
    return async (toolName, args) => {
      return await this.executeTool(toolName, args);
    };
  }

  /**
   * Clean a JSON Schema for provider compatibility.
   * Some providers are strict about schema format.
   */
  _cleanSchema(schema) {
    if (!schema || typeof schema !== 'object') {
      return { type: 'object', properties: {} };
    }

    // Ensure it has a type
    const cleaned = { ...schema };
    if (!cleaned.type) cleaned.type = 'object';
    if (!cleaned.properties) cleaned.properties = {};

    return cleaned;
  }

  /**
   * Extract text from MCP tool result format.
   * MCP returns { content: [{ type: 'text', text: '...' }] }
   */
  _extractResultText(result) {
    if (!result) return 'No result';
    if (typeof result === 'string') return result;

    // MCP standard format
    if (result.content && Array.isArray(result.content)) {
      return result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n') || JSON.stringify(result);
    }

    // Direct text
    if (result.text) return result.text;

    // Fallback
    return JSON.stringify(result, null, 2);
  }
}

module.exports = { McpBridge };
