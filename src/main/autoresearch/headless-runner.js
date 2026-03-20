// ── Headless Research Runner — structured JSON output mode ─────
// Runs Claude CLI in pipe mode (-p) with --output-format stream-json.
// Eliminates PTY greeting detection, ANSI stripping, and fragile regex parsing.

const { spawn } = require('child_process');
const path = require('path');

/**
 * Run a single Claude invocation in headless (pipe) mode.
 * Returns structured results parsed from stream-json output.
 *
 * @param {Object} opts
 * @param {string} opts.prompt - The prompt to send to Claude
 * @param {string} opts.cwd - Working directory
 * @param {number} [opts.maxTurns=50] - Max turns for the invocation
 * @param {string} [opts.model] - Model override
 * @param {string} [opts.mcpConfig] - MCP config file path
 * @param {string[]} [opts.allowedTools] - Allowed tools
 * @param {number} [opts.timeoutMs=300000] - Timeout (5 min default)
 * @param {Function} [opts.onEvent] - Streaming callback for each JSON event
 * @returns {Promise<HeadlessResult>}
 */
function runHeadless(opts) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',                          // Pipe mode (non-interactive)
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
    ];

    if (opts.maxTurns) {
      args.push('--max-turns', String(opts.maxTurns));
    }
    if (opts.model) {
      args.push('--model', opts.model);
    }
    if (opts.mcpConfig) {
      args.push('--mcp-config', opts.mcpConfig);
    }
    if (opts.allowedTools && Array.isArray(opts.allowedTools)) {
      for (const tool of opts.allowedTools) {
        args.push('--allowedTools', tool);
      }
    }

    const proc = spawn('claude', args, {
      cwd: opts.cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      env: {
        ...process.env,
        TERM: 'dumb',  // Prevent color output
      },
    });

    const result = {
      success: false,
      events: [],         // All parsed events
      textBlocks: [],     // Assistant text blocks
      toolUses: [],       // Tool use events
      toolResults: [],    // Tool result events
      finalResult: null,  // The result event (cost, session_id, etc.)
      rawOutput: '',
      errorOutput: '',
      exitCode: null,
    };

    let buffer = '';
    const timeoutMs = opts.timeoutMs || 300000; // 5 min default

    // Set timeout
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, 5000);
      reject(new Error(`Headless runner timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      result.rawOutput += text;
      buffer += text;

      // Parse line-delimited JSON
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete last line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const event = JSON.parse(trimmed);
          result.events.push(event);

          // Categorize events
          if (event.type === 'assistant' || event.type === 'text') {
            const text = event.message || event.content || event.text || '';
            if (text) result.textBlocks.push(text);
          } else if (event.type === 'tool_use') {
            result.toolUses.push({
              name: event.name || event.tool_name || '',
              input: event.input || event.arguments || {},
            });
          } else if (event.type === 'tool_result') {
            result.toolResults.push({
              name: event.name || event.tool_name || '',
              output: event.output || event.content || '',
              isError: event.is_error || false,
            });
          } else if (event.type === 'result') {
            result.finalResult = {
              cost: event.cost_usd || event.cost || 0,
              sessionId: event.session_id || null,
              inputTokens: event.input_tokens || 0,
              outputTokens: event.output_tokens || 0,
              numTurns: event.num_turns || 0,
              isError: event.is_error || false,
            };
          }

          // Forward event to streaming callback
          if (opts.onEvent) {
            try { opts.onEvent(event); } catch { /* ignore callback errors */ }
          }
        } catch (parseErr) {
          // Not JSON — may be plain text output, accumulate it
          if (trimmed.length > 0) {
            result.textBlocks.push(trimmed);
          }
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      result.errorOutput += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      result.exitCode = code;
      result.success = code === 0;
      resolve(result);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start Claude CLI: ${err.message}`));
    });

    // Write prompt to stdin
    proc.stdin.write(opts.prompt);
    proc.stdin.end();
  });
}

/**
 * Run a research experiment iteration in headless mode.
 * Sends the experiment prompt and parses for experiment result blocks.
 *
 * @param {Object} opts
 * @param {string} opts.prompt - The research iteration prompt
 * @param {string} opts.cwd - Working directory
 * @param {number} [opts.maxTurns=50] - Max turns
 * @param {Function} [opts.onEvent] - Streaming callback
 * @returns {Promise<{result: HeadlessResult, experiments: Array}>}
 */
async function runResearchIteration(opts) {
  const result = await runHeadless({
    ...opts,
    timeoutMs: opts.timeoutMs || 600000, // 10 min per iteration
  });

  // Parse experiment results from Claude's text output
  const experiments = parseExperimentResults(result.textBlocks.join('\n'));

  return {
    result,
    experiments,
    cost: result.finalResult?.cost || 0,
    numTurns: result.finalResult?.numTurns || 0,
  };
}

/**
 * Parse experiment result blocks from Claude's text output.
 * Looks for --- delimited blocks with metric_value, status, etc.
 * Also supports JSON-formatted experiment results.
 */
function parseExperimentResults(text) {
  const experiments = [];

  // Try --- delimited blocks first (backward compatible with PTY format)
  const blockRegex = /---\s*\n([\s\S]*?)---/g;
  let match;
  while ((match = blockRegex.exec(text)) !== null) {
    const block = match[1];
    const metricMatch = block.match(/^metric_value:\s*([\d.]+)/m);
    const statusMatch = block.match(/^status:\s*(keep|discard|crash)/m);
    if (!metricMatch || !statusMatch) continue;

    const parsedMetric = parseFloat(metricMatch[1]);
    if (isNaN(parsedMetric)) continue;

    const nameMatch = block.match(/^metric_name:\s*(\S+)/m);
    const descMatch = block.match(/^description:\s*(.+)/m);
    const commitMatch = block.match(/^commit:\s*([a-f0-9]{7,40})/m);
    const durationMatch = block.match(/^duration:\s*(\d+)/m);

    experiments.push({
      metricName: nameMatch?.[1] || 'quality',
      metricValue: parsedMetric,
      status: statusMatch[1],
      description: descMatch?.[1]?.trim() || '',
      commitHash: commitMatch?.[1] || null,
      durationSeconds: durationMatch ? parseInt(durationMatch[1]) : null,
    });
  }

  // Try JSON-formatted experiment results (handles any field ordering)
  const jsonRegex = /\{[^{}]*(?:"metric_value"|"status")[^{}]*\}/g;
  while ((match = jsonRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      // Must have both metric_value and valid status
      if (parsed.metric_value === undefined || !parsed.status) continue;
      if (!['keep', 'discard', 'crash'].includes(parsed.status)) continue;
      const metricValue = parseFloat(parsed.metric_value);
      if (isNaN(metricValue)) continue;

      // Check if this is a duplicate (same metric value + status)
      const isDupe = experiments.some(e =>
        e.metricValue === metricValue && e.status === parsed.status
      );
      if (isDupe) continue;

      experiments.push({
        metricName: parsed.metric_name || 'quality',
        metricValue,
        status: parsed.status,
        description: parsed.description || '',
        commitHash: parsed.commit || parsed.commit_hash || null,
        durationSeconds: parsed.duration ? parseInt(parsed.duration) : null,
      });
    } catch { /* skip malformed JSON */ }
  }

  return experiments;
}

module.exports = { runHeadless, runResearchIteration, parseExperimentResults };
