// ── Setup Wizard — Dependency Detection & Installation ────
const { execSync, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// ── State file paths ──────────────────────────────────────
const SETUP_COMPLETE_FILE = path.join(os.homedir(), '.claude-sessions', 'setup-complete.json');
const SETUP_STATE_FILE = path.join(os.homedir(), '.claude-sessions', 'setup-state.json');

// ── Workspace root helper ─────────────────────────────────

function getWorkspaceRoot() {
  return path.join(os.homedir(), 'Documents', 'ClaudeWorkspace');
}

// ── Shared Turso credentials (same for all installations) ─
const TURSO_DEFAULTS = {
  url: 'libsql://claude-sessions-bigmandad.aws-us-east-1.turso.io',
  token: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzM5OTEzMDIsImlkIjoiMDE5ZDBhMWUtYTYwMS03ZGU5LTgxNTEtNjRlOTI4YjI2ZjQxIiwicmlkIjoiYzk5NGE0MDItMGQ5Zi00ZWNlLThhNTktYzg4MmYxYzUxYzJhIn0.16i9-BkZR1pDuKeq5Yy0INt2JUj3PTx2CY4-p6E7eijPfxCZAq_Wl59fqVU_pG3bkdpJR4XZ59YbtUIj0avACA'
};

// ── Resumable state management ────────────────────────────

function getSetupState() {
  if (!fs.existsSync(SETUP_STATE_FILE)) {
    return { currentStep: 'welcome', completedSteps: [], tursoConfigured: false, completedAt: null };
  }
  return JSON.parse(fs.readFileSync(SETUP_STATE_FILE, 'utf8'));
}

function saveSetupState(update) {
  const state = getSetupState();
  Object.assign(state, update);
  const dir = path.dirname(SETUP_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETUP_STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

// ── Setup completion checks ───────────────────────────────

function isSetupComplete() {
  // Check the legacy setup-complete.json
  if (fs.existsSync(SETUP_COMPLETE_FILE)) return true;
  // Check the new setup-state.json for completedAt
  if (fs.existsSync(SETUP_STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(SETUP_STATE_FILE, 'utf8'));
      return state.completedAt !== null;
    } catch {
      // Corrupted state file — treat as incomplete
    }
  }
  return false;
}

function markSetupComplete() {
  const dir = path.dirname(SETUP_COMPLETE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Write legacy setup-complete.json
  fs.writeFileSync(SETUP_COMPLETE_FILE, JSON.stringify({
    completedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    machineId: getMachineId()
  }, null, 2));

  // Also update the new state file
  saveSetupState({ completedAt: new Date().toISOString() });
}

function getMachineId() {
  // Use the canonical implementation from path-utils for consistency
  const { getMachineId: canonical } = require('../sync/path-utils');
  return canonical();
}

// ── PATH refresh ──────────────────────────────────────────

function refreshPath() {
  if (process.platform === 'darwin') {
    try {
      const shellPath = execSync('/bin/zsh -ilc "echo $PATH"', { encoding: 'utf8', timeout: 5000 }).trim();
      if (shellPath && shellPath.length > 0) {
        process.env.PATH = shellPath;
        return { success: true, source: 'zsh' };
      }
    } catch {}
    // Fallback: prepend common macOS paths including Python bin dirs
    const fallbackPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
    // Add Python user bin dirs (where pip3 install --user puts binaries)
    for (const ver of ['3.14', '3.13', '3.12', '3.11', '3.10']) {
      fallbackPaths.push(path.join(os.homedir(), 'Library', 'Python', ver, 'bin'));
      fallbackPaths.push(`/opt/homebrew/opt/python@${ver}/libexec/bin`);
    }
    fallbackPaths.push(path.join(os.homedir(), '.local', 'bin'));
    const current = process.env.PATH || '';
    const missing = fallbackPaths.filter(p => !current.includes(p) && fs.existsSync(p));
    if (missing.length > 0) {
      process.env.PATH = missing.join(':') + ':' + current;
      return { success: true, source: 'fallback' };
    }
    return { success: true, source: 'unchanged' };
  }

  if (process.platform === 'win32') {
    // Reload PATH from registry
    try {
      const userPath = execSync('reg query "HKCU\\Environment" /v Path', { encoding: 'utf8', timeout: 5000 });
      const systemPath = execSync('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path', { encoding: 'utf8', timeout: 5000 });
      // Extract values after REG_EXPAND_SZ or REG_SZ
      const extractPath = (output) => {
        const match = output.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
        return match ? match[1].trim() : '';
      };
      process.env.PATH = extractPath(systemPath) + ';' + extractPath(userPath);
      return { success: true, source: 'registry' };
    } catch {}
  }

  return { success: true, source: 'no-op' };
}

// ── Dependency checker ────────────────────────────────────

async function checkDependencies() {
  const deps = [
    {
      name: 'Git',
      check: () => tryCommand('git --version'),
      install: { win32: 'winget install -e --id Git.Git', darwin: 'brew install git' }
    },
    {
      name: 'Node.js',
      check: () => tryCommand('node --version'),
      install: { win32: 'winget install -e --id OpenJS.NodeJS', darwin: 'brew install node' }
    },
    {
      name: 'Python',
      check: () => tryCommand('python --version') || tryCommand('python3 --version'),
      install: { win32: 'winget install -e --id Python.Python.3.12', darwin: 'brew install python@3.12' }
    },
    {
      name: 'Java 25',
      check: () => {
        const v = tryCommand('java --version');
        return v && v.includes('25') ? v : null;
      },
      install: { win32: 'winget install -e --id Adoptium.Temurin.25.JDK', darwin: 'brew install --cask temurin@25' }
    },
    {
      name: 'Ollama',
      check: () => tryCommand('ollama --version'),
      install: { win32: 'winget install -e --id Ollama.Ollama', darwin: 'brew install ollama' }
    },
    {
      name: 'Claude CLI',
      check: () => tryCommand('claude --version'),
      install: { win32: 'npm install -g @anthropic-ai/claude-code', darwin: 'npm install -g @anthropic-ai/claude-code' }
    },
    {
      name: 'OpenViking',
      check: () => tryCommand('openviking-server --version') || tryCommand('openviking --version') || tryCommand('ov --version'),
      install: { win32: 'pip install openviking', darwin: 'pip3 install --break-system-packages openviking' }
    },
  ];

  const results = [];
  for (const dep of deps) {
    let version = null;
    try {
      version = dep.check();
    } catch {
      // check failed
    }
    results.push({
      name: dep.name,
      found: !!version,
      version: version || null,
      installCommand: dep.install[process.platform] || null
    });
  }
  return results;
}

function tryCommand(cmd) {
  try {
    // On macOS, run through login shell to get full PATH (Electron has minimal PATH)
    if (process.platform === 'darwin') {
      const escaped = cmd.replace(/"/g, '\\"');
      return execSync(`/bin/zsh -ilc "${escaped}"`, { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    }
    return execSync(cmd, { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

// ── Install a dependency ──────────────────────────────────

async function installDependency(name, command, onProgress) {
  return new Promise((resolve, reject) => {
    // On macOS, run through login shell to get full PATH (brew, pip paths)
    let shell, args;
    if (process.platform === 'darwin') {
      shell = '/bin/zsh';
      args = ['-ilc', command];
    } else {
      const parts = command.split(' ');
      shell = parts[0];
      args = parts.slice(1);
    }

    const proc = spawn(shell, args, {
      shell: process.platform !== 'darwin',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let output = '';
    proc.stdout.on('data', (data) => {
      output += data.toString();
      if (onProgress) onProgress(name, data.toString());
    });
    proc.stderr.on('data', (data) => {
      output += data.toString();
      if (onProgress) onProgress(name, data.toString());
    });

    proc.on('close', (code) => {
      // Refresh PATH after install so next checks find the new binary
      refreshPath();
      if (code === 0) resolve({ success: true, output });
      else reject(new Error(`${name} install failed (exit ${code}): ${output.slice(-500)}`));
    });
    proc.on('error', (err) => reject(err));
  });
}

// ── Turso credentials ─────────────────────────────────────

// Auto-configure Turso with shared credentials (no user input needed)
async function autoConfigureTurso() {
  const envPath = path.join(os.homedir(), '.claude-sessions', '.env');
  // Only write if not already configured
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    if (content.includes('TURSO_DATABASE_URL=') && !content.includes('TURSO_DATABASE_URL=\n')) {
      // Already configured, just ensure env vars are set
      process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || TURSO_DEFAULTS.url;
      process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || TURSO_DEFAULTS.token;
      return { success: true, alreadyConfigured: true };
    }
  }
  return saveTursoCredentials(TURSO_DEFAULTS.url, TURSO_DEFAULTS.token);
}

async function saveTursoCredentials(url, token) {
  const envPath = path.join(os.homedir(), '.claude-sessions', '.env');
  const dir = path.dirname(envPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(envPath, `TURSO_DATABASE_URL=${url}\nTURSO_AUTH_TOKEN=${token}\n`);
  // Also set in current process so sync can start immediately
  process.env.TURSO_DATABASE_URL = url;
  process.env.TURSO_AUTH_TOKEN = token;
  return { success: true };
}

async function testTursoConnection(url, token) {
  try {
    const { createClient } = require('@libsql/client');
    const client = createClient({ url, authToken: token });
    await client.execute('SELECT 1');
    client.close();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Ollama service management ─────────────────────────────

async function checkOllamaRunning() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:11434/api/version', { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => {
        try { resolve({ running: true, version: JSON.parse(data).version }); }
        catch { resolve({ running: true, version: 'unknown' }); }
      });
    });
    req.on('error', () => resolve({ running: false }));
    req.on('timeout', () => { req.destroy(); resolve({ running: false }); });
  });
}

function findOllamaBinary() {
  if (process.platform === 'win32') {
    const candidates = [
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'),
      'ollama'
    ];
    for (const c of candidates) {
      try { execSync(`"${c}" --version`, { stdio: 'pipe', timeout: 5000 }); return c; } catch {}
    }
  } else {
    const candidates = ['/opt/homebrew/bin/ollama', '/usr/local/bin/ollama', '/usr/bin/ollama'];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    try { return execSync('which ollama', { encoding: 'utf8', timeout: 5000 }).trim(); } catch {}
  }
  return null;
}

async function startOllamaService() {
  const status = await checkOllamaRunning();
  if (status.running) return { success: true, alreadyRunning: true, version: status.version };

  // Find ollama binary
  const ollamaPath = findOllamaBinary();
  if (!ollamaPath) return { success: false, error: 'Ollama binary not found' };

  // Start ollama serve detached
  const proc = spawn(ollamaPath, ['serve'], {
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32'
  });
  proc.unref();

  // Wait up to 15 seconds for it to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const check = await checkOllamaRunning();
    if (check.running) return { success: true, alreadyRunning: false, version: check.version };
  }
  return { success: false, error: 'Ollama started but not responding after 15s' };
}

// ── Configure workspace ───────────────────────────────────

async function configureWorkspace(workspaceRoot) {
  if (!workspaceRoot) workspaceRoot = getWorkspaceRoot();
  const home = os.homedir();

  // 1. Create ~/.openviking/ov.conf (always overwrite so it updates on re-run)
  const ovDir = path.join(home, '.openviking');
  if (!fs.existsSync(ovDir)) fs.mkdirSync(ovDir, { recursive: true });
  if (!fs.existsSync(path.join(ovDir, 'data'))) fs.mkdirSync(path.join(ovDir, 'data'), { recursive: true });

  const ovConf = {
    server: { host: '127.0.0.1', port: 1933, workers: 1, cors_origins: ['*'] },
    storage: { workspace: path.join(home, '.openviking', 'data').replace(/\\/g, '/') },
    embedding: {
      dense: {
        provider: 'openai',
        model: 'qwen3-embedding:4b',
        api_key: 'ollama',
        api_base: 'http://localhost:11434/v1',
        dimension: 2560,
        batch_size: 8
      }
    },
    auto_generate_l0: true,
    auto_generate_l1: true,
    default_search_mode: 'fast',
    default_search_limit: 5
  };

  fs.writeFileSync(path.join(ovDir, 'ov.conf'), JSON.stringify(ovConf, null, 2));

  // 2. Generate .mcp.json — use template if available, otherwise hardcode hytale-dev config
  const templatePath = path.join(workspaceRoot, '.mcp.json.template');
  const mcpPath = path.join(workspaceRoot, '.mcp.json');

  if (fs.existsSync(templatePath)) {
    let template = fs.readFileSync(templatePath, 'utf8');
    const hytaleGamePath = detectHytaleGamePath();
    template = template.replace(/\$\{WORKSPACE_ROOT\}/g, workspaceRoot.replace(/\\/g, '/'));
    template = template.replace(/\$\{HYTALE_GAME_PATH\}/g, (hytaleGamePath || '').replace(/\\/g, '/'));
    fs.writeFileSync(mcpPath, template);
  } else {
    // Generate a default .mcp.json with hytale-dev server config
    const hytaleGamePath = detectHytaleGamePath();
    const mcpConfig = {
      mcpServers: {
        'hytale-dev': {
          command: 'node',
          args: [
            path.join(workspaceRoot, 'claude-plugins-custom', 'hytale-modding', 'mcp-server', 'index.js').replace(/\\/g, '/')
          ],
          env: {
            HYTALE_GAME_PATH: (hytaleGamePath || '').replace(/\\/g, '/'),
            WORKSPACE_ROOT: workspaceRoot.replace(/\\/g, '/'),
            MOD_SOURCE_DIR: path.join(workspaceRoot, 'ClaudeProjects', 'KingdomsMod', 'src').replace(/\\/g, '/'),
            OV_BASE_URL: 'http://localhost:1933'
          }
        }
      }
    };
    fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));
  }

  // 3. Auto-configure Turso cloud sync (shared credentials)
  try {
    await autoConfigureTurso();
  } catch (e) {
    console.warn('[Setup] Turso auto-config failed (non-fatal):', e.message);
  }

  return { success: true };
}

function detectHytaleGamePath() {
  const candidates = process.platform === 'win32' ? [
    path.join(os.homedir(), 'AppData', 'Roaming', 'Hytale', 'install', 'release', 'package', 'game', 'latest'),
  ] : [
    path.join(os.homedir(), 'Library', 'Application Support', 'Hytale', 'install', 'release', 'package', 'game', 'latest'),
    path.join(os.homedir(), '.local', 'share', 'Hytale', 'install', 'release', 'package', 'game', 'latest'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Repo cloning ──────────────────────────────────────────

async function cloneRepos(onProgress) {
  const workspace = path.join(os.homedir(), 'Documents', 'ClaudeWorkspace');
  const projects = path.join(workspace, 'ClaudeProjects');
  const modshop = path.join(workspace, 'HYTALEMODWORKSHOP');

  const repos = [
    { name: 'claude-plugins-custom', repo: 'bigmandad/claude-plugins-custom', dest: path.join(workspace, 'claude-plugins-custom') },
    { name: 'KingdomsMod', repo: 'bigmandad/KingdomsMod', dest: path.join(projects, 'KingdomsMod') },
    { name: 'CorruptionMod', repo: 'bigmandad/CorruptionModSourceCode', dest: path.join(modshop, 'CorruptionMod') },
    { name: 'CorruptionModDeployment', repo: 'bigmandad/CorruptionModDeployment', dest: path.join(modshop, 'CorruptionModDeployment') },
    { name: 'HytaleModdingPluginRefinementWorkspace', repo: 'bigmandad/HytaleModdingPluginRefinementWorkspace', dest: path.join(projects, 'HytaleModdingPluginRefinementWorkspace') },
  ];

  const results = [];
  for (const { name, repo, dest } of repos) {
    if (fs.existsSync(path.join(dest, '.git'))) {
      results.push({ name, status: 'exists' });
      if (onProgress) onProgress(name, 'already cloned');
      continue;
    }

    // Create parent dir
    const parent = path.dirname(dest);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

    try {
      if (onProgress) onProgress(name, 'cloning...');
      execSync(`git clone https://github.com/${repo}.git "${dest}"`, {
        encoding: 'utf8', timeout: 120000, stdio: 'pipe'
      });
      results.push({ name, status: 'cloned' });
      if (onProgress) onProgress(name, 'done');
    } catch (e) {
      results.push({ name, status: 'failed', error: e.message });
      if (onProgress) onProgress(name, `failed: ${e.message}`);
    }
  }
  return results;
}

// ── Plugin configuration ──────────────────────────────────

async function configurePlugins() {
  const workspace = getWorkspaceRoot();
  const pluginSourceDir = path.join(workspace, 'claude-plugins-custom', 'hytale-modding');
  const pluginJsonPath = path.join(pluginSourceDir, '.claude-plugin', 'plugin.json');
  const claudePluginsDir = path.join(os.homedir(), '.claude', 'plugins');
  const installedPluginsPath = path.join(claudePluginsDir, 'installed_plugins.json');

  // 1. Check if already installed
  let alreadyInstalled = false;
  try {
    if (fs.existsSync(installedPluginsPath)) {
      const installed = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf8'));
      const pluginKeys = Object.keys(installed.plugins || {});
      alreadyInstalled = pluginKeys.some(k => k.startsWith('hytale-modding'));
    }
  } catch {}

  if (alreadyInstalled) {
    return { success: true, plugins: ['hytale-modding'], message: 'hytale-modding plugin already installed' };
  }

  // 2. Check if plugin source exists (cloned from repo)
  if (!fs.existsSync(pluginJsonPath)) {
    return {
      success: false,
      plugins: [],
      message: 'Plugin directory missing — clone repos first',
      detail: `Expected: ${pluginSourceDir}`
    };
  }

  // 3. Install the plugin by creating a symlink in ~/.claude/plugins/
  const targetDir = path.join(claudePluginsDir, 'hytale-modding');
  try {
    if (!fs.existsSync(claudePluginsDir)) fs.mkdirSync(claudePluginsDir, { recursive: true });

    // Remove existing symlink/dir if broken
    if (fs.existsSync(targetDir)) {
      const stats = fs.lstatSync(targetDir);
      if (stats.isSymbolicLink()) fs.unlinkSync(targetDir);
    }

    // Create symlink (junction on Windows, dir symlink on macOS/Linux)
    if (!fs.existsSync(targetDir)) {
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(pluginSourceDir, targetDir, linkType);
    }

    // 4. Register in installed_plugins.json
    let installed = { plugins: {} };
    try {
      if (fs.existsSync(installedPluginsPath)) {
        installed = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf8'));
        if (!installed.plugins) installed.plugins = {};
      }
    } catch {}

    const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
    const pluginKey = `hytale-modding@local-custom-plugins`;
    installed.plugins[pluginKey] = {
      name: pluginJson.name || 'hytale-modding',
      version: pluginJson.version || '6.3.0',
      path: pluginSourceDir,
      installedAt: new Date().toISOString(),
      source: 'local'
    };

    fs.writeFileSync(installedPluginsPath, JSON.stringify(installed, null, 2));

    // 5. Remove any orphaned marker
    const orphanedFile = path.join(targetDir, '.orphaned_at');
    if (fs.existsSync(orphanedFile)) fs.unlinkSync(orphanedFile);

    return {
      success: true,
      plugins: ['hytale-modding'],
      message: 'hytale-modding plugin installed and symlinked'
    };
  } catch (e) {
    return {
      success: false,
      plugins: [],
      message: `Plugin install failed: ${e.message}`
    };
  }
}

// ── Pull Ollama model ─────────────────────────────────────

async function pullOllamaModel(modelName, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ollama', ['pull', modelName], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proc.stdout.on('data', (data) => { if (onProgress) onProgress(data.toString()); });
    proc.stderr.on('data', (data) => { if (onProgress) onProgress(data.toString()); });
    proc.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`Ollama pull failed with code ${code}`));
    });
    proc.on('error', reject);
  });
}

// ── Comprehensive verification ────────────────────────────

async function runVerification() {
  const results = {};

  // 1. Ollama
  const ollamaStatus = await checkOllamaRunning();
  results.ollama = { pass: ollamaStatus.running, detail: ollamaStatus.running ? `v${ollamaStatus.version}` : 'Not running' };

  // 2. OpenViking
  results.openviking = await new Promise((resolve) => {
    const req = http.get('http://localhost:1933/api/v1/debug/health', { timeout: 3000 }, (res) => {
      resolve({ pass: res.statusCode === 200, detail: `Status ${res.statusCode}` });
    });
    req.on('error', () => resolve({ pass: false, detail: 'Not running' }));
    req.on('timeout', () => { req.destroy(); resolve({ pass: false, detail: 'Timeout' }); });
  });

  // 3. Database
  const dbPath = path.join(os.homedir(), '.claude-sessions', 'claude-sessions.db');
  results.database = { pass: fs.existsSync(dbPath), detail: fs.existsSync(dbPath) ? 'Database file exists' : 'No database file' };

  // 4. Turso
  const envPath = path.join(os.homedir(), '.claude-sessions', '.env');
  if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, 'utf8');
    const hasUrl = env.includes('TURSO_DATABASE_URL=') && !env.includes('TURSO_DATABASE_URL=\n');
    results.turso = { pass: hasUrl, detail: hasUrl ? 'Credentials configured' : 'Incomplete credentials' };
  } else {
    results.turso = { pass: true, detail: 'Skipped (local-only mode)', skipped: true };
  }

  // 5. MCP Config
  const workspace = getWorkspaceRoot();
  const mcpPath = path.join(workspace, '.mcp.json');
  if (fs.existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      const serverCount = Object.keys(mcp.mcpServers || {}).length;
      results.mcpConfig = { pass: serverCount > 0, detail: `${serverCount} server(s) configured` };
    } catch (e) {
      results.mcpConfig = { pass: false, detail: 'Invalid JSON: ' + e.message };
    }
  } else {
    results.mcpConfig = { pass: false, detail: '.mcp.json not found' };
  }

  // 6. Plugins — check symlink AND installed_plugins.json
  const claudePluginsDir = path.join(os.homedir(), '.claude', 'plugins');
  const pluginSymlink = path.join(claudePluginsDir, 'hytale-modding');
  const installedPluginsPath = path.join(claudePluginsDir, 'installed_plugins.json');
  let pluginFound = false;
  let pluginDetail = 'Plugin directory missing';

  // Check symlink exists and points to a real directory
  if (fs.existsSync(pluginSymlink)) {
    const pluginJsonCheck = path.join(pluginSymlink, '.claude-plugin', 'plugin.json');
    if (fs.existsSync(pluginJsonCheck)) {
      pluginFound = true;
      pluginDetail = 'hytale-modding plugin linked and valid';
    } else {
      pluginDetail = 'Plugin symlink exists but plugin.json missing';
    }
  }

  // Also check installed_plugins.json as fallback
  if (!pluginFound) {
    try {
      if (fs.existsSync(installedPluginsPath)) {
        const installed = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf8'));
        const pluginKeys = Object.keys(installed.plugins || {});
        const hytaleKey = pluginKeys.find(k => k.startsWith('hytale-modding'));
        if (hytaleKey) {
          pluginFound = true;
          pluginDetail = `Hytale modding plugin registered (${hytaleKey.split('@')[1] || 'local'})`;
        }
      }
    } catch {}
  }
  results.plugins = { pass: pluginFound, detail: pluginDetail };

  // 7. Ollama models
  try {
    const modelList = execSync('ollama list', { encoding: 'utf8', timeout: 5000 });
    const hasEmbedding = modelList.includes('qwen3-embedding');
    results.models = { pass: hasEmbedding, detail: hasEmbedding ? 'qwen3-embedding:4b available' : 'Embedding model not pulled' };
  } catch {
    results.models = { pass: false, detail: 'Cannot check models (Ollama not running)' };
  }

  return results;
}

// ── Exports ───────────────────────────────────────────────

module.exports = {
  // existing
  isSetupComplete,
  markSetupComplete,
  getMachineId,
  checkDependencies,
  installDependency,
  configureWorkspace,
  detectHytaleGamePath,
  pullOllamaModel,
  // new
  getSetupState,
  saveSetupState,
  autoConfigureTurso,
  saveTursoCredentials,
  testTursoConnection,
  checkOllamaRunning,
  startOllamaService,
  cloneRepos,
  configurePlugins,
  getWorkspaceRoot,
  refreshPath,
  runVerification
};
