const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const { getMachineId } = require('./path-utils');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins');
const INSTALLED_MANIFEST = path.join(PLUGINS_DIR, 'installed_plugins.json');

/**
 * Read the current installed plugins manifest
 */
function getInstalledPlugins() {
  try {
    if (!fs.existsSync(INSTALLED_MANIFEST)) return [];
    const data = JSON.parse(fs.readFileSync(INSTALLED_MANIFEST, 'utf8'));
    return Array.isArray(data) ? data : (data.plugins || []);
  } catch (e) {
    console.warn('[PluginSync] Failed to read installed_plugins.json:', e.message);
    return [];
  }
}

/**
 * Hash a plugin directory's contents for change detection
 */
function hashPluginDir(dirPath) {
  const hash = crypto.createHash('sha256');
  try {
    const files = getAllFiles(dirPath);
    for (const file of files.sort()) {
      const relativePath = path.relative(dirPath, file);
      // Skip .local/ directory (machine-specific overrides)
      if (relativePath.startsWith('.local')) continue;
      hash.update(relativePath);
      hash.update(fs.readFileSync(file));
    }
  } catch (e) {
    hash.update('error-' + e.message);
  }
  return hash.digest('hex').slice(0, 16);
}

function getAllFiles(dirPath, fileList = []) {
  if (!fs.existsSync(dirPath)) return fileList;
  const items = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);
    if (item.isDirectory()) {
      if (item.name === 'node_modules' || item.name === '.git') continue;
      getAllFiles(fullPath, fileList);
    } else {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

/**
 * Push local plugin state to the plugin_sync table in the database
 */
function pushPluginManifest(db) {
  const machineId = getMachineId();
  const plugins = getInstalledPlugins();
  const now = new Date().toISOString();

  for (const plugin of plugins) {
    const pluginId = plugin.name || plugin.id || 'unknown';
    const marketplace = plugin.marketplace || plugin.source || 'local';
    const version = plugin.version || plugin.gitCommitSha || 'unknown';
    const scope = plugin.scope || 'project';
    const projectPath = plugin.projectPath || '';

    // Calculate file hash for custom plugins
    let fileHash = '';
    if (plugin.installPath && fs.existsSync(plugin.installPath)) {
      fileHash = hashPluginDir(plugin.installPath);
    }

    try {
      db.prepare(`
        INSERT INTO plugin_sync (plugin_id, marketplace, version, scope, project_path, file_hash, installed_at, updated_at, machine_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plugin_id, scope, project_path) DO UPDATE SET
          version = excluded.version,
          file_hash = excluded.file_hash,
          updated_at = excluded.updated_at,
          machine_id = excluded.machine_id
      `).run(pluginId, marketplace, version, scope, projectPath, fileHash, now, now, machineId);
    } catch (e) {
      console.warn(`[PluginSync] Failed to push ${pluginId}:`, e.message);
    }
  }
}

/**
 * Pull plugin manifest from Turso and identify missing plugins
 */
function getMissingPlugins(db) {
  const machineId = getMachineId();
  try {
    // Get all plugins known to any machine
    const allPlugins = db.prepare(`
      SELECT DISTINCT plugin_id, marketplace, version, scope, project_path
      FROM plugin_sync
      WHERE machine_id != ?
    `).all(machineId);

    // Get plugins installed on this machine
    const localPlugins = db.prepare(`
      SELECT plugin_id, scope, project_path
      FROM plugin_sync
      WHERE machine_id = ?
    `).all(machineId);

    const localSet = new Set(localPlugins.map(p => `${p.plugin_id}|${p.scope}|${p.project_path}`));

    return allPlugins.filter(p => !localSet.has(`${p.plugin_id}|${p.scope}|${p.project_path}`));
  } catch (e) {
    console.warn('[PluginSync] Failed to get missing plugins:', e.message);
    return [];
  }
}

/**
 * Install a missing marketplace plugin via Claude CLI
 */
async function installMarketplacePlugin(pluginId) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['plugins', 'install', pluginId], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000
    });

    let output = '';
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => output += d.toString());
    proc.on('close', code => {
      if (code === 0) resolve({ success: true, output });
      else resolve({ success: false, output, code });
    });
    proc.on('error', e => resolve({ success: false, output: e.message }));
  });
}

/**
 * Manage the custom plugins Git repo
 */
class CustomPluginGitSync {
  constructor(repoPath) {
    this.repoPath = repoPath;
    this.remoteUrl = null;
  }

  isGitRepo() {
    return fs.existsSync(path.join(this.repoPath, '.git'));
  }

  hasRemote() {
    if (!this.isGitRepo()) return false;
    try {
      const remotes = execSync('git remote -v', { cwd: this.repoPath, encoding: 'utf8', timeout: 5000 });
      return remotes.includes('origin');
    } catch { return false; }
  }

  pull() {
    if (!this.isGitRepo() || !this.hasRemote()) return false;
    try {
      execSync('git pull --ff-only origin main 2>/dev/null || git pull --ff-only origin master 2>/dev/null || true', {
        cwd: this.repoPath,
        encoding: 'utf8',
        timeout: 30000
      });
      return true;
    } catch (e) {
      console.warn('[PluginSync] Git pull failed:', e.message);
      return false;
    }
  }

  pushChanges(message) {
    if (!this.isGitRepo() || !this.hasRemote()) return false;
    try {
      const status = execSync('git status --porcelain', { cwd: this.repoPath, encoding: 'utf8', timeout: 5000 }).trim();
      if (!status) return false; // Nothing to commit

      execSync('git add -A', { cwd: this.repoPath, encoding: 'utf8', timeout: 5000 });
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: this.repoPath, encoding: 'utf8', timeout: 10000 });
      execSync('git push origin HEAD', { cwd: this.repoPath, encoding: 'utf8', timeout: 30000 });
      return true;
    } catch (e) {
      console.warn('[PluginSync] Git push failed:', e.message);
      return false;
    }
  }

  /**
   * Sync a custom plugin folder TO the git repo
   */
  syncPluginToRepo(pluginName, sourceDir) {
    const destDir = path.join(this.repoPath, pluginName);
    if (!fs.existsSync(sourceDir)) return;

    // Copy plugin files (excluding .local/)
    copyDirSync(sourceDir, destDir, ['.local', 'node_modules', '.git']);
  }

  /**
   * Sync a custom plugin FROM the git repo to the Claude plugins dir
   */
  syncPluginFromRepo(pluginName, destDir) {
    const sourceDir = path.join(this.repoPath, pluginName);
    if (!fs.existsSync(sourceDir)) return;

    copyDirSync(sourceDir, destDir, ['.local', 'node_modules', '.git']);

    // Fix permissions on macOS/Linux
    if (process.platform !== 'win32') {
      try {
        const shFiles = getAllFiles(destDir).filter(f => f.endsWith('.sh'));
        for (const f of shFiles) {
          fs.chmodSync(f, 0o755);
        }
      } catch (e) {
        console.warn('[PluginSync] chmod failed:', e.message);
      }
    }
  }
}

function copyDirSync(src, dest, excludeDirs = []) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const items = fs.readdirSync(src, { withFileTypes: true });
  for (const item of items) {
    if (excludeDirs.includes(item.name)) continue;
    const srcPath = path.join(src, item.name);
    const destPath = path.join(dest, item.name);
    if (item.isDirectory()) {
      copyDirSync(srcPath, destPath, excludeDirs);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Full plugin sync orchestration
 */
async function syncPlugins(db, customRepoPath) {
  console.log('[PluginSync] Starting plugin sync...');

  // 1. Push local manifest to Turso
  pushPluginManifest(db);

  // 2. Sync custom plugins via Git
  if (customRepoPath) {
    const gitSync = new CustomPluginGitSync(customRepoPath);
    if (gitSync.isGitRepo() && gitSync.hasRemote()) {
      // Pull latest
      gitSync.pull();

      // Sync custom plugins from repo to Claude plugins dir
      try {
        const dirs = fs.readdirSync(customRepoPath, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.'));
        for (const dir of dirs) {
          const destDir = path.join(PLUGINS_DIR, dir.name);
          gitSync.syncPluginFromRepo(dir.name, destDir);
          console.log(`[PluginSync] Synced custom plugin: ${dir.name}`);
        }
      } catch (e) {
        console.warn('[PluginSync] Custom plugin sync failed:', e.message);
      }
    }
  }

  // 3. Check for missing marketplace plugins
  const missing = getMissingPlugins(db);
  for (const plugin of missing) {
    if (plugin.marketplace && plugin.marketplace !== 'local') {
      console.log(`[PluginSync] Installing missing marketplace plugin: ${plugin.plugin_id}`);
      const result = await installMarketplacePlugin(plugin.plugin_id);
      if (result.success) {
        console.log(`[PluginSync] Installed: ${plugin.plugin_id}`);
      } else {
        console.warn(`[PluginSync] Failed to install ${plugin.plugin_id}:`, result.output);
      }
    }
  }

  console.log('[PluginSync] Plugin sync complete');
}

module.exports = {
  getInstalledPlugins,
  hashPluginDir,
  pushPluginManifest,
  getMissingPlugins,
  installMarketplacePlugin,
  CustomPluginGitSync,
  syncPlugins
};
