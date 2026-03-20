// ── Setup Wizard — Dependency Detection & Installation ────
const { execSync, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const SETUP_STATE_FILE = path.join(os.homedir(), '.claude-sessions', 'setup-complete.json');

function isSetupComplete() {
  return fs.existsSync(SETUP_STATE_FILE);
}

function markSetupComplete() {
  const dir = path.dirname(SETUP_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETUP_STATE_FILE, JSON.stringify({
    completedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    machineId: getMachineId()
  }, null, 2));
}

function getMachineId() {
  // Use the canonical implementation from path-utils for consistency
  const { getMachineId: canonical } = require('../sync/path-utils');
  return canonical();
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
      check: () => tryCommand('openviking --version') || tryCommand('ov --version'),
      install: { win32: 'pip install openviking', darwin: 'pip3 install openviking' }
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
    return execSync(cmd, { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

// ── Install a dependency ──────────────────────────────────

async function installDependency(name, command, onProgress) {
  return new Promise((resolve, reject) => {
    const parts = command.split(' ');
    const proc = spawn(parts[0], parts.slice(1), {
      shell: true,
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
      if (code === 0) resolve({ success: true, output });
      else reject(new Error(`${name} install failed (exit ${code}): ${output.slice(-500)}`));
    });
    proc.on('error', (err) => reject(err));
  });
}

// ── Configure workspace ───────────────────────────────────

async function configureWorkspace(workspaceRoot) {
  const home = os.homedir();

  // 1. Create ~/.openviking/ov.conf
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

  if (!fs.existsSync(path.join(ovDir, 'ov.conf'))) {
    fs.writeFileSync(path.join(ovDir, 'ov.conf'), JSON.stringify(ovConf, null, 2));
  }

  // 2. Generate .mcp.json if template exists
  const templatePath = path.join(workspaceRoot, '.mcp.json.template');
  const mcpPath = path.join(workspaceRoot, '.mcp.json');
  if (fs.existsSync(templatePath) && !fs.existsSync(mcpPath)) {
    let template = fs.readFileSync(templatePath, 'utf8');
    const hytaleGamePath = detectHytaleGamePath();
    template = template.replace(/\$\{WORKSPACE_ROOT\}/g, workspaceRoot.replace(/\\/g, '/'));
    template = template.replace(/\$\{HYTALE_GAME_PATH\}/g, (hytaleGamePath || '').replace(/\\/g, '/'));
    fs.writeFileSync(mcpPath, template);
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

module.exports = {
  isSetupComplete,
  markSetupComplete,
  getMachineId,
  checkDependencies,
  installDependency,
  configureWorkspace,
  detectHytaleGamePath,
  pullOllamaModel
};
