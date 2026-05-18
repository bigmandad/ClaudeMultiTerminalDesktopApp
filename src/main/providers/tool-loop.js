// ── Tool-execution loop ───────────────────────────────────
// Wraps provider.sendMessage() with multi-round tool execution.
//
// Without this loop, providers yield tool_call chunks but never see the
// results — so a model that needed to call a tool to answer just stops mid-
// thought. With this loop, the provider can call a tool, get the result, and
// continue generating in the same logical "turn" from the caller's view.

const MAX_TOOL_ROUNDS = 5;

/**
 * Run a provider message with full tool-execute round trips.
 *
 * @param {Object} provider - Provider instance from provider-registry
 * @param {string} sessionId
 * @param {string} message - Initial user message
 * @param {Array}  tools - Tools in provider-native format
 * @param {Function} toolHandler - async (name, args) => result
 * @param {Object} [opts]
 * @param {number} [opts.maxRounds=5] - Safety cap on tool round trips
 * @returns {AsyncGenerator<{type, content?, name?, args?, id?, content?}>}
 *
 * Yields the same chunk types provider.sendMessage yields, plus:
 *   { type: 'tool_result', toolCallId, content }
 * after each tool execution.
 */
async function* runWithTools(provider, sessionId, message, tools, toolHandler, opts = {}) {
  const maxRounds = opts.maxRounds || MAX_TOOL_ROUNDS;

  // No tools or no handler: just pass through directly.
  if (!toolHandler || !tools || tools.length === 0) {
    yield* provider.sendMessage(sessionId, message, tools || []);
    return;
  }

  let currentMessage = message;

  for (let round = 0; round < maxRounds; round++) {
    const pendingToolCalls = [];
    const generator = provider.sendMessage(sessionId, currentMessage, tools);

    for await (const chunk of generator) {
      if (chunk.type === 'tool_call') {
        pendingToolCalls.push(chunk);
      }
      // Pass through everything (including tool_call so the UI can show it)
      yield chunk;
      // Stop the inner loop if we see an unrecoverable terminator
      if (chunk.type === 'error' || chunk.type === 'cancelled') {
        return;
      }
    }

    // No tools called this round → we're done
    if (pendingToolCalls.length === 0) return;

    // Execute every tool, feed each result back into the provider's history
    for (const tc of pendingToolCalls) {
      let result;
      try {
        result = await toolHandler(tc.name, tc.args);
      } catch (err) {
        result = { error: err.message };
      }
      yield { type: 'tool_result', toolCallId: tc.id || null, name: tc.name, content: result };
      if (typeof provider.addToolResult === 'function') {
        try {
          provider.addToolResult(sessionId, tc.id || null, result, tc.name);
        } catch (err) {
          console.warn(`[tool-loop] addToolResult failed on ${provider.id}: ${err.message}`);
        }
      }
    }

    // Continue: empty message; provider's history already has the tool result(s).
    currentMessage = '';
  }

  // Hit the round cap — emit a warning chunk so UIs can notify the user.
  yield {
    type: 'error',
    content: `Tool-execution loop exceeded ${maxRounds} rounds. Aborting to avoid runaway calls.`,
  };
}

module.exports = { runWithTools, MAX_TOOL_ROUNDS };
