// ── OpenViking Server Manager ──────────────────────────────
// Manages the OpenViking HTTP server lifecycle as a child process

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const http = require('http');
const fs = require('fs');

const { execSync } = require('child_process');

/**
 * Resolve the Ollama binary path cross-platform.
 */
function resolveOllamaPath() {
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe');
  }
  const candidates = process.platform === 'darwin'
    ? ['/opt/homebrew/bin/ollama', '/usr/local/bin/ollama']
    : ['/usr/local/bin/ollama'];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    return execSync('which ollama', { encoding: 'utf8', timeout: 3000 }).trim();
  } catch (_) { /* not found */ }
  return 'ollama';
}

/**
 * Resolve the openviking-server binary path cross-platform.
 */
function resolveOvServerCmd() {
  // Try to find via full shell PATH first (most reliable on macOS)
  if (process.platform !== 'win32') {
    try {
      const shell = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
      const resolved = execSync(`${shell} -ilc "which openviking-server"`, { encoding: 'utf8', timeout: 5000 }).trim();
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch (_) { /* continue to manual search */ }
  }

  if (process.platform === 'win32') {
    const pythonVersions = ['Python312', 'Python311', 'Python310', 'Python313', 'Python314'];
    for (const ver of pythonVersions) {
      const candidate = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', ver, 'Scripts', 'openviking-server.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
    // Also check pip --user on Windows
    for (const ver of pythonVersions) {
      const candidate = path.join(os.homedir(), 'AppData', 'Roaming', 'Python', ver, 'Scripts', 'openviking-server.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  } else {
    const candidates = [
      path.join(os.homedir(), '.local', 'bin', 'openviking-server'),
      '/opt/homebrew/bin/openviking-server',
      '/usr/local/bin/openviking-server',
    ];
    // pip --user install locations on macOS (~/Library/Python/3.X/bin/)
    if (process.platform === 'darwin') {
      for (const ver of ['3.14', '3.13', '3.12', '3.11', '3.10']) {
        candidates.push(path.join(os.homedir(), 'Library', 'Python', ver, 'bin', 'openviking-server'));
      }
    }
    // Also check Homebrew Python's bin dirs
    for (const ver of ['3.14', '3.13', '3.12', '3.11', '3.10']) {
      candidates.push(`/opt/homebrew/lib/python${ver}/site-packages/bin/openviking-server`);
      candidates.push(`/opt/homebrew/opt/python@${ver}/bin/openviking-server`);
    }
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    // Last resort: plain which (Electron's minimal PATH)
    try {
      return execSync('which openviking-server', { encoding: 'utf8', timeout: 3000 }).trim();
    } catch (_) { /* not found */ }
  }
  return 'openviking-server';
}

const OV_PORT = 1933;
const OV_HEALTH_URL = `http://localhost:${OV_PORT}/api/v1/debug/health`;
const OV_CONFIG = path.join(os.homedir(), '.openviking', 'ov.conf');
const OV_DATA = path.join(os.homedir(), '.openviking', 'data');

let serverProcess = null;
let isStarting = false;
let isHealthy = false;

/**
 * Start the OpenViking HTTP server as a background child process.
 * Returns a promise that resolves when the server is healthy.
 */
async function startServer() {
  if (serverProcess && isHealthy) {
    console.log('[OpenViking] Server already running');
    return true;
  }

  if (isStarting) {
    console.log('[OpenViking] Server already starting...');
    return waitForHealth();
  }

  isStarting = true;
  console.log('[OpenViking] Starting server on port', OV_PORT);

  try {
    // First check if something is already running on the port
    const alreadyRunning = await checkHealth();
    if (alreadyRunning) {
      console.log('[OpenViking] Server already running externally');
      isHealthy = true;
      isStarting = false;
      return true;
    }

    // Ensure Ollama is running (needed for embeddings)
    try {
      const ollamaPath = resolveOllamaPath();
      const ollamaRunning = await new Promise(resolve => {
        const req = http.get('http://localhost:11434/api/version', { timeout: 2000 }, () => resolve(true));
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (!ollamaRunning && fs.existsSync(ollamaPath)) {
        console.log('[OpenViking] Starting Ollama...');
        const ollamaProc = spawn(ollamaPath, ['serve'], {
          stdio: 'ignore', detached: true, windowsHide: true
        });
        ollamaProc.unref();
        await new Promise(r => setTimeout(r, 3000));
      }
    } catch (ollamaErr) {
      console.log('[OpenViking] Ollama pre-check skipped:', ollamaErr.message);
    }

    // Spawn the server process
    // Use the openviking-server CLI command (installed by pip)
    const cmd = resolveOvServerCmd();
    serverProcess = spawn(cmd, ['--port', String(OV_PORT), '--config', OV_CONFIG], {
      env: {
        ...process.env,
        OPENVIKING_CONFIG_FILE: OV_CONFIG,
        OPENVIKING_DATA_PATH: OV_DATA
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true
    });

    serverProcess.stdout.on('data', (data) => {
      console.log('[OpenViking-Server]', data.toString().trim());
    });

    serverProcess.stderr.on('data', (data) => {
      console.log('[OpenViking-Server ERR]', data.toString().trim());
    });

    serverProcess.on('error', (err) => {
      console.error('[OpenViking] Failed to start server:', err.message);
      serverProcess = null;
      isStarting = false;
      isHealthy = false;
    });

    serverProcess.on('exit', (code, signal) => {
      console.log('[OpenViking] Server exited with code', code, 'signal', signal);
      serverProcess = null;
      isHealthy = false;
    });

    // Wait for health check
    const healthy = await waitForHealth(15000);
    isStarting = false;
    isHealthy = healthy;
    return healthy;
  } catch (err) {
    console.error('[OpenViking] Start failed:', err.message);
    isStarting = false;
    return false;
  }
}

/**
 * Stop the OpenViking server.
 */
function stopServer() {
  if (serverProcess) {
    console.log('[OpenViking] Stopping server...');
    try {
      serverProcess.kill('SIGTERM');
      // Force kill after 3 seconds
      setTimeout(() => {
        try {
          if (serverProcess) serverProcess.kill('SIGKILL');
        } catch (e) { /* already dead */ }
      }, 3000);
    } catch (e) { /* ignore */ }
    serverProcess = null;
  }
  isHealthy = false;
  isStarting = false;
}

/**
 * Check if the OpenViking server is healthy.
 */
function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(OV_HEALTH_URL, { timeout: 2000 }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Wait for the server to become healthy, with timeout.
 */
async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const healthy = await checkHealth();
    if (healthy) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Get the server status.
 */
function getStatus() {
  return {
    running: !!serverProcess || isHealthy,
    healthy: isHealthy,
    port: OV_PORT,
    pid: serverProcess?.pid || null
  };
}

/**
 * Make an HTTP request to the OpenViking API.
 */
function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: OV_PORT,
      path: path,
      method: method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
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

module.exports = {
  startServer,
  stopServer,
  checkHealth,
  getStatus,
  apiRequest,
  OV_PORT,
  resolveOvServerCmd,
  resolveOllamaPath
};
