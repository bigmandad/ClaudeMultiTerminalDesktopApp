// ── OpenViking Client — HTTP API wrapper ──────────────────
// Wraps the OpenViking REST API for use in IPC handlers

const http = require('http');
const { OV_PORT } = require('./ov-server');

const BASE_URL = `http://localhost:${OV_PORT}`;

/**
 * Make an HTTP request to the OpenViking API.
 */
function request(method, apiPath, body = null, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: timeoutMs
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.detail || parsed.message || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve(data);
          }
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Unwrap OpenViking's standard response envelope.
 * Responses come as {status, result, error, time, usage}
 */
function unwrap(response) {
  if (response && typeof response === 'object' && 'result' in response) {
    if (response.error) throw new Error(response.error);
    return response.result;
  }
  return response;
}

// ── High-level API methods ──────────────────────────────────

/**
 * Add a resource (file or directory path) to OpenViking.
 * @param {string} filePath - Absolute path to file or directory
 * @param {object} options - { reason, wait, to, parent, ignore_dirs, include, exclude, instruction }
 */
async function addResource(filePath, options = {}) {
  // Only pass valid AddResourceRequest fields
  const body = { path: filePath };
  const validFields = ['reason', 'instruction', 'wait', 'to', 'parent', 'ignore_dirs', 'include', 'exclude', 'strict', 'preserve_structure', 'directly_upload_media', 'timeout', 'temp_path'];
  for (const field of validFields) {
    if (options[field] !== undefined) body[field] = options[field];
  }
  if (body.wait === undefined) body.wait = true;
  if (!body.reason) body.reason = 'Knowledge base resource';
  const resp = await request('POST', '/api/v1/resources', body, options.timeout || 120000);
  return unwrap(resp);
}

/**
 * Semantic search across the knowledge base.
 */
async function search(query, options = {}) {
  const resp = await request('POST', '/api/v1/search/search', {
    query,
    target_uri: options.targetUri || 'viking://resources/',
    top_k: options.topK || 10,
    tier: options.tier || 'L1',
    ...options
  });
  return unwrap(resp);
}

/**
 * List contents of a viking:// URI.
 */
async function ls(uri = 'viking://') {
  const resp = await request('GET', `/api/v1/fs/ls?uri=${encodeURIComponent(uri)}`);
  return unwrap(resp);
}

/**
 * Read content at a viking:// URI with tier.
 */
async function read(uri, tier = 'L1') {
  let resp;
  if (tier === 'L0') {
    resp = await request('GET', `/api/v1/content/abstract?uri=${encodeURIComponent(uri)}`);
  } else if (tier === 'L1') {
    resp = await request('GET', `/api/v1/content/overview?uri=${encodeURIComponent(uri)}`);
  } else {
    resp = await request('GET', `/api/v1/content/read?uri=${encodeURIComponent(uri)}`);
  }
  return unwrap(resp);
}

/**
 * Tree structure of a viking:// URI.
 */
async function tree(uri = 'viking://', depth = 3) {
  const resp = await request('GET', `/api/v1/fs/tree?uri=${encodeURIComponent(uri)}&depth=${depth}`);
  return unwrap(resp);
}

/**
 * Find resources using semantic search.
 */
async function find(query, targetUri = 'viking://resources/', topK = 5) {
  const resp = await request('POST', '/api/v1/search/find', {
    query,
    target_uri: targetUri,
    top_k: topK
  });
  return unwrap(resp);
}

/**
 * Get the L0 abstract summary (~100 tokens) for a resource.
 */
async function getAbstract(uri) {
  return read(uri, 'L0');
}

/**
 * Get the L1 overview (~2k tokens) for a resource.
 */
async function getOverview(uri) {
  return read(uri, 'L1');
}

/**
 * Get the full L2 content for a resource.
 */
async function getDetail(uri) {
  return read(uri, 'L2');
}

/**
 * Extract memories from a session conversation.
 * Uses sessions API to submit transcript for memory extraction.
 */
async function extractMemory(sessionId, content, agentId = 'claude-sessions') {
  // Create a session first, then add a message
  try {
    await request('POST', '/api/v1/sessions', {
      session_id: sessionId,
      agent_id: agentId
    }, 10000);
  } catch { /* session may already exist */ }

  return request('POST', `/api/v1/sessions/${sessionId}/messages`, {
    role: 'assistant',
    content: content
  }, 60000);
}

/**
 * List all memories for an agent.
 */
async function listMemories(agentId = 'claude-sessions', category = null) {
  let uri = `viking://agent/${agentId}/memories/`;
  if (category) uri += `${category}/`;
  return ls(uri);
}

/**
 * Search memories.
 */
async function searchMemories(query, agentId = 'claude-sessions') {
  return find(query, `viking://agent/${agentId}/memories/`, 10);
}

/**
 * Get server health status.
 */
async function health() {
  return request('GET', '/api/v1/debug/health');
}

/**
 * Get resource count / stats.
 */
async function stats() {
  try {
    // Use fs/ls to count resources and agent memories
    const [resources, agents] = await Promise.allSettled([
      ls('viking://resources/'),
      ls('viking://agent/')
    ]);
    const rList = resources.status === 'fulfilled' ? resources.value : [];
    const aList = agents.status === 'fulfilled' ? agents.value : [];
    return {
      resources: Array.isArray(rList) ? rList.length : 0,
      memories: Array.isArray(aList) ? aList.length : 0
    };
  } catch {
    return { resources: 0, memories: 0 };
  }
}

module.exports = {
  addResource,
  search,
  ls,
  read,
  tree,
  find,
  getAbstract,
  getOverview,
  getDetail,
  extractMemory,
  listMemories,
  searchMemories,
  health,
  stats
};
