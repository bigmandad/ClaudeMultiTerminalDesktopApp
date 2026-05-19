// ── Watchdog Health Probes ─────────────────────────────────
//
// Probe contract:
//   {
//     name:    string         (unique identifier)
//     label:   string         (human-readable)
//     check:   async () => { status: 'healthy'|'degraded'|'down', message, fixable, ...extras }
//     fix?:    async (probeResult, ctx) => { success, message }
//     liveness?: async () => boolean   (optional: is this thing MAKING PROGRESS, not just responding?)
//     destructiveFix?: boolean         (true if fix() mutates external state — counted for back-pressure)
//   }
//
// Additional probes can be registered at runtime via registerProbe(probe).
// The createProbes() function returns the built-in set; registerProbe lets
// plugins / experimental modules add their own without modifying this file.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const _extraProbes = [];

/**
 * Register an additional probe at runtime. Returns a deregistration function.
 */
function registerProbe(probe) {
  if (!probe || typeof probe.check !== 'function' || !probe.name || !probe.label) {
    throw new Error('Invalid probe — needs { name, label, check }');
  }
  _extraProbes.push(probe);
  return () => {
    const idx = _extraProbes.indexOf(probe);
    if (idx >= 0) _extraProbes.splice(idx, 1);
  };
}

function httpCheck(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, data }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
  });
}

function createProbes(deps) {
  const { db, ovServer, setup, gitOps } = deps;
  const workspace = path.join(os.homedir(), 'Documents', 'ClaudeWorkspace');

  return [
    // ── 1. OpenViking ────────────────────────────────────────
    {
      name: 'openviking',
      label: 'OpenViking Knowledge Base',
      check: async () => {
        const result = await httpCheck('http://localhost:1933/api/v1/debug/health');
        if (result.ok) return { status: 'healthy', message: 'Responding on port 1933', fixable: false };
        return { status: 'down', message: 'Not responding', fixable: true };
      },
      fix: async () => {
        console.log('[Watchdog] Restarting OpenViking...');
        // First check if openviking-server binary exists — if not, install it
        const { resolveOvServerCmd } = require('../openviking/ov-server');
        const resolved = resolveOvServerCmd();
        if (resolved === 'openviking-server') {
          // Binary not found — try to install via pip
          console.log('[Watchdog] openviking-server not found — installing via pip...');
          try {
            const { execSync } = require('child_process');
            const installCmd = process.platform === 'darwin'
              ? '/bin/zsh -ilc "pip3 install --break-system-packages openviking"'
              : 'pip install openviking';
            execSync(installCmd, { encoding: 'utf8', timeout: 60000 });
            console.log('[Watchdog] OpenViking installed successfully');
            // Refresh PATH so resolveOvServerCmd finds it
            if (setup && setup.refreshPath) setup.refreshPath();
          } catch (pipErr) {
            console.warn('[Watchdog] pip install openviking failed:', pipErr.message);
          }
        }
        if (ovServer && ovServer.startServer) {
          const ok = await ovServer.startServer();
          return ok ? { success: true, message: 'OpenViking restarted' } : { success: false, message: 'Failed to start' };
        }
        return { success: false, message: 'ovServer not available' };
      }
    },

    // ── 2. Ollama ────────────────────────────────────────────
    {
      name: 'ollama',
      label: 'Ollama AI Engine',
      check: async () => {
        const result = await httpCheck('http://localhost:11434/api/version');
        if (result.ok) {
          let version = 'unknown';
          try { version = JSON.parse(result.data).version; } catch {}
          return { status: 'healthy', message: `v${version}`, fixable: false };
        }
        return { status: 'down', message: 'Not responding', fixable: true };
      },
      fix: async () => {
        console.log('[Watchdog] Starting Ollama...');
        // Use setup's startOllamaService if available
        if (setup && setup.startOllamaService) {
          const result = await setup.startOllamaService();
          return result.success
            ? { success: true, message: 'Ollama started' }
            : { success: false, message: result.error || 'Failed to start' };
        }
        // Fallback: try to spawn directly
        const { spawn } = require('child_process');
        try {
          let ollamaPath = 'ollama';
          if (ovServer && ovServer.resolveOllamaPath) {
            ollamaPath = ovServer.resolveOllamaPath();
          }
          const proc = spawn(ollamaPath, ['serve'], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
          proc.unref();
          // Wait 5s for startup
          await new Promise(r => setTimeout(r, 5000));
          const check = await httpCheck('http://localhost:11434/api/version');
          return check.ok ? { success: true, message: 'Ollama started' } : { success: false, message: 'Started but not responding' };
        } catch (e) {
          return { success: false, message: e.message };
        }
      }
    },

    // ── 3. Turso Sync ────────────────────────────────────────
    {
      name: 'turso',
      label: 'Cloud Sync (Turso)',
      check: async () => {
        // Check if Turso is configured
        const envPath = path.join(os.homedir(), '.omniclaw', '.env');
        if (!fs.existsSync(envPath)) {
          return { status: 'healthy', message: 'Local-only mode (no cloud)', fixable: false };
        }
        const env = fs.readFileSync(envPath, 'utf8');
        if (!env.includes('TURSO_DATABASE_URL=') || env.includes('TURSO_DATABASE_URL=\n')) {
          return { status: 'healthy', message: 'Local-only mode', fixable: false };
        }
        // Check if sync is recent (within 5 min)
        if (db && db.appState) {
          try {
            const lastSyncRaw = db.appState.get('last_turso_sync');
            if (lastSyncRaw) {
              const lastSync = new Date(lastSyncRaw);
              const ageMin = (Date.now() - lastSync.getTime()) / 60000;
              if (ageMin < 5) return { status: 'healthy', message: `Synced ${Math.round(ageMin)}m ago`, fixable: false };
              return { status: 'degraded', message: `Last sync ${Math.round(ageMin)}m ago`, fixable: true };
            }
          } catch {}
        }
        // Can't determine age, just check if replica file exists
        const replicaPath = path.join(os.homedir(), '.omniclaw', 'turso-replica.db');
        if (fs.existsSync(replicaPath)) {
          return { status: 'healthy', message: 'Replica exists', fixable: false };
        }
        return { status: 'degraded', message: 'No replica file', fixable: true };
      },
      fix: async () => {
        console.log('[Watchdog] Forcing Turso sync...');
        if (db && db.sync) {
          try {
            await db.sync();
            return { success: true, message: 'Sync completed' };
          } catch (e) {
            return { success: false, message: e.message };
          }
        }
        return { success: false, message: 'db.sync not available' };
      }
    },

    // ── 4. Database ──────────────────────────────────────────
    {
      name: 'database',
      label: 'Session Database',
      check: async () => {
        const dbPath = path.join(os.homedir(), '.omniclaw', 'omniclaw.db');
        if (!fs.existsSync(dbPath)) {
          return { status: 'down', message: 'Database file missing', fixable: false };
        }
        // Check DB is accessible
        if (db && db.raw) {
          try {
            const result = db.raw().prepare('PRAGMA integrity_check(1)').get();
            if (result && result.integrity_check === 'ok') {
              return { status: 'healthy', message: 'Integrity OK', fixable: false };
            }
            return { status: 'degraded', message: 'Integrity issue', fixable: true };
          } catch (e) {
            return { status: 'degraded', message: `Query error: ${e.message}`, fixable: true };
          }
        }
        return { status: 'healthy', message: 'File exists', fixable: false };
      },
      fix: async () => {
        console.log('[Watchdog] Running WAL checkpoint...');
        if (db && db.raw) {
          try {
            db.raw().prepare('PRAGMA wal_checkpoint(PASSIVE)').run();
            return { success: true, message: 'WAL checkpoint complete' };
          } catch (e) {
            return { success: false, message: e.message };
          }
        }
        return { success: false, message: 'db not available' };
      }
    },

    // ── 5. MCP Config ────────────────────────────────────────
    {
      name: 'mcp',
      label: 'MCP Server Config',
      check: async () => {
        const mcpPath = path.join(workspace, '.mcp.json');
        if (!fs.existsSync(mcpPath)) {
          return { status: 'down', message: '.mcp.json missing', fixable: true };
        }
        try {
          const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
          const count = Object.keys(mcp.mcpServers || {}).length;
          if (count > 0) return { status: 'healthy', message: `${count} server(s)`, fixable: false };
          return { status: 'degraded', message: 'No servers configured', fixable: true };
        } catch (e) {
          return { status: 'down', message: `Invalid JSON: ${e.message}`, fixable: true };
        }
      },
      fix: async () => {
        console.log('[Watchdog] Regenerating .mcp.json...');
        if (setup && setup.configureWorkspace) {
          try {
            await setup.configureWorkspace();
            return { success: true, message: '.mcp.json regenerated' };
          } catch (e) {
            return { success: false, message: e.message };
          }
        }
        return { success: false, message: 'setup.configureWorkspace not available' };
      }
    },

    // ── 6. Plugins ───────────────────────────────────────────
    {
      name: 'plugins',
      label: 'Modding Plugins',
      check: async () => {
        const pluginDir = path.join(os.homedir(), '.claude', 'plugins', 'hytale-modding');
        if (!fs.existsSync(pluginDir)) {
          return { status: 'down', message: 'Plugin not installed', fixable: true };
        }
        // Check if it's a valid symlink pointing to a real dir
        try {
          const stats = fs.lstatSync(pluginDir);
          if (stats.isSymbolicLink()) {
            const target = fs.readlinkSync(pluginDir);
            const resolvedTarget = path.resolve(path.dirname(pluginDir), target);
            if (!fs.existsSync(resolvedTarget)) {
              return { status: 'down', message: 'Broken symlink', fixable: true };
            }
          }
        } catch {}
        // Check plugin.json exists
        const pluginJson = path.join(pluginDir, '.claude-plugin', 'plugin.json');
        if (!fs.existsSync(pluginJson)) {
          return { status: 'degraded', message: 'plugin.json missing', fixable: true };
        }
        return { status: 'healthy', message: 'hytale-modding active', fixable: false };
      },
      fix: async () => {
        console.log('[Watchdog] Re-linking plugins...');
        const pluginRepoDir = path.join(workspace, 'claude-plugins-custom');

        // 1. Clone plugin repo if missing or incomplete
        const pluginJsonExpected = path.join(pluginRepoDir, 'hytale-modding', '.claude-plugin', 'plugin.json');
        if (!fs.existsSync(pluginJsonExpected)) {
          console.log('[Watchdog] Plugin repo not found — cloning...');
          try {
            if (fs.existsSync(pluginRepoDir)) {
              // Remove empty/broken dir first
              fs.rmSync(pluginRepoDir, { recursive: true, force: true });
            }
            // Try gh CLI first (handles private repos with auth token)
            const cloneUrl = 'https://github.com/bigmandad/claude-plugins-custom.git';
            let cloneCmd;
            try {
              // Check if gh is available
              execSync('gh auth status', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
              cloneCmd = `gh repo clone bigmandad/claude-plugins-custom "${pluginRepoDir}"`;
            } catch {
              // Fall back to plain git (works for public repos or if git credentials are cached)
              cloneCmd = `git clone "${cloneUrl}" "${pluginRepoDir}"`;
            }

            if (process.platform === 'darwin') {
              execSync(`/bin/zsh -ilc '${cloneCmd}'`, { encoding: 'utf8', timeout: 60000, stdio: 'pipe' });
            } else {
              execSync(cloneCmd, { encoding: 'utf8', timeout: 60000, stdio: 'pipe' });
            }
            console.log('[Watchdog] Plugin repo cloned successfully');
          } catch (cloneErr) {
            console.warn('[Watchdog] Plugin repo clone failed:', cloneErr.message);
            return { success: false, message: `Clone failed: ${cloneErr.message.slice(0, 80)}` };
          }
        }

        // 2. Symlink and register plugin
        if (setup && setup.configurePlugins) {
          try {
            const result = await setup.configurePlugins();
            return result.success
              ? { success: true, message: result.message }
              : { success: false, message: result.message };
          } catch (e) {
            return { success: false, message: e.message };
          }
        }

        // 3. Fallback: manual symlink if setup not available
        const pluginSource = path.join(pluginRepoDir, 'hytale-modding');
        const pluginTarget = path.join(os.homedir(), '.claude', 'plugins', 'hytale-modding');
        if (fs.existsSync(pluginSource) && !fs.existsSync(pluginTarget)) {
          try {
            fs.mkdirSync(path.dirname(pluginTarget), { recursive: true });
            const linkType = process.platform === 'win32' ? 'junction' : 'dir';
            fs.symlinkSync(pluginSource, pluginTarget, linkType);
            return { success: true, message: 'Plugin symlinked manually' };
          } catch (e) {
            return { success: false, message: `Symlink failed: ${e.message}` };
          }
        }

        return { success: false, message: 'Could not resolve plugin fix' };
      }
    },

    // ── 7. Git Repos ─────────────────────────────────────────
    {
      name: 'git',
      label: 'Git Repositories',
      check: async () => {
        const repos = [
          { name: 'App', path: path.join(workspace, 'ClaudeProjects', 'ClaudeMultiTerminalDesktopApp') },
          { name: 'KingdomsMod', path: path.join(workspace, 'ClaudeProjects', 'KingdomsMod') },
          { name: 'CorruptionMod', path: path.join(workspace, 'HYTALEMODWORKSHOP', 'CorruptionMod') },
          { name: 'Plugins', path: path.join(workspace, 'claude-plugins-custom') },
        ];

        const dirty = [];
        for (const repo of repos) {
          if (!fs.existsSync(path.join(repo.path, '.git'))) continue;
          if (gitOps && gitOps.gitStatus) {
            try {
              const status = await gitOps.gitStatus(repo.path);
              if (status && status.trim().length > 0) {
                dirty.push(repo.name);
              }
            } catch {}
          } else {
            try {
              const status = execSync('git status --porcelain', { cwd: repo.path, encoding: 'utf8', timeout: 5000 });
              if (status.trim().length > 0) dirty.push(repo.name);
            } catch {}
          }
        }

        if (dirty.length === 0) return { status: 'healthy', message: 'All repos clean', fixable: false };
        return { status: 'degraded', message: `Uncommitted: ${dirty.join(', ')}`, fixable: true, dirty };
      },
      fix: async (probeResult, { gitPushConsented }) => {
        if (!probeResult || !probeResult.dirty) return { success: false, message: 'No dirty repos specified' };

        const results = [];
        for (const repoName of probeResult.dirty) {
          const repoMap = {
            'App': path.join(workspace, 'ClaudeProjects', 'ClaudeMultiTerminalDesktopApp'),
            'KingdomsMod': path.join(workspace, 'ClaudeProjects', 'KingdomsMod'),
            'CorruptionMod': path.join(workspace, 'HYTALEMODWORKSHOP', 'CorruptionMod'),
            'Plugins': path.join(workspace, 'claude-plugins-custom'),
          };
          const cwd = repoMap[repoName];
          if (!cwd) continue;

          try {
            // Auto-commit
            if (gitOps && gitOps.autoCommit) {
              await gitOps.autoCommit(cwd, 'watchdog');
            } else {
              execSync('git add -A && git commit -m "[watchdog] Auto-commit changes"', { cwd, encoding: 'utf8', timeout: 15000, shell: true });
            }
            results.push(`${repoName}: committed`);

            // Push if consented
            if (gitPushConsented) {
              try {
                execSync('git push origin HEAD', { cwd, encoding: 'utf8', timeout: 30000 });
                results.push(`${repoName}: pushed`);
              } catch (pushErr) {
                results.push(`${repoName}: push failed (${pushErr.message.slice(0, 50)})`);
              }
            }
          } catch (e) {
            results.push(`${repoName}: commit failed (${e.message.slice(0, 50)})`);
          }
        }

        return { success: true, message: results.join('; ') };
      }
    }
  ];
}

// ── New probes from C-REL-2 (coverage gaps) ─────────────────
function _coreProbes(deps) {
  const { db } = deps;
  const homeDir = os.homedir();

  return [
    // Hermes Agent bridge — OmniClaw can delegate tasks to a local Hermes
    // gateway. If Hermes is installed but its gateway is down, surface that
    // so the user knows the bridge is one-way (OmniClaw → Hermes won't work).
    {
      name: 'hermes',
      label: 'Hermes Agent Bridge',
      check: async () => {
        // Hermes is optional — don't show as "down" if not installed.
        const hermesDir = path.join(homeDir, '.hermes');
        if (!fs.existsSync(hermesDir)) {
          return { status: 'healthy', message: 'Not installed (optional bridge)', fixable: false };
        }
        const result = await httpCheck('http://localhost:8642/health');
        if (!result.ok) {
          return { status: 'degraded', message: 'Hermes installed but gateway unreachable on :8642', fixable: false };
        }
        // Pull detailed status too so the panel shows useful context
        const detailed = await httpCheck('http://localhost:8642/health/detailed');
        if (detailed.ok) {
          try {
            const d = JSON.parse(detailed.data);
            const platforms = Object.keys(d.platforms || {}).join(', ');
            const agents = d.active_agents ?? 0;
            return { status: 'healthy', message: `Gateway up · ${agents} active agent(s) · platforms: ${platforms || 'none'}`, fixable: false };
          } catch {}
        }
        return { status: 'healthy', message: 'Gateway up on :8642', fixable: false };
      },
    },
    // Native modules — the better-sqlite3 / node-pty binaries can mismatch
    // Electron's ABI after a `npm install`. Surface this so the user sees a
    // toast instead of a silent crash.
    {
      name: 'native-modules',
      label: 'Native Modules',
      check: async () => {
        const missing = [];
        try { require('better-sqlite3'); } catch (e) { missing.push(`better-sqlite3: ${e.code || e.message}`); }
        try { require('@homebridge/node-pty-prebuilt-multiarch'); } catch (e) { missing.push(`node-pty: ${e.code || e.message}`); }
        if (missing.length === 0) return { status: 'healthy', message: 'All native modules loaded', fixable: false };
        return { status: 'down', message: missing.join('; '), fixable: false };
      },
    },

    // Disk space — the app writes transcripts, vector DB, autoresearch
    // results to ~/.omniclaw and ~/.openviking. Running out of space causes
    // silent write failures.
    {
      name: 'disk-space',
      label: 'Disk Space',
      check: async () => {
        try {
          // statfs is Node 18.15+; fall back gracefully if unavailable.
          if (typeof fs.statfsSync !== 'function') {
            return { status: 'healthy', message: 'statfs unavailable, skipped', fixable: false };
          }
          const stats = fs.statfsSync(homeDir);
          const freeGB = (stats.bavail * stats.bsize) / 1e9;
          const totalGB = (stats.blocks * stats.bsize) / 1e9;
          const pctFree = (freeGB / totalGB) * 100;
          if (freeGB < 1) return { status: 'down',     message: `${freeGB.toFixed(2)}GB free (<1GB)`, fixable: false };
          if (pctFree < 5) return { status: 'degraded', message: `${freeGB.toFixed(1)}GB free (${pctFree.toFixed(0)}% — <5%)`, fixable: false };
          return { status: 'healthy', message: `${freeGB.toFixed(1)}GB free`, fixable: false };
        } catch (e) {
          return { status: 'healthy', message: `disk check skipped: ${e.message}`, fixable: false };
        }
      },
    },

    // Claude CLI present + authenticated. Without this, every session that
    // tries to launch Claude fails — but the failure shows up as a PTY exit,
    // not as a clear status.
    {
      name: 'claude-cli',
      label: 'Claude CLI',
      check: async () => {
        try {
          const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
          const out = execSync(cmd, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          if (!out) return { status: 'down', message: 'claude not on PATH', fixable: false };
          return { status: 'healthy', message: out.split('\n')[0], fixable: false };
        } catch (_) {
          return { status: 'down', message: 'claude not found on PATH', fixable: false };
        }
      },
    },

    // Discord bot connection liveness. Token presence alone doesn't tell us
    // if the bot is actually connected to Discord's gateway right now.
    {
      name: 'discord-bot',
      label: 'Discord Bot',
      check: async () => {
        try {
          const token = db?.appState?.get('discord_bot_token');
          if (!token) return { status: 'healthy', message: 'Not configured', fixable: false };
          // Reach into the discord-bot module's status — cheap probe.
          let bot;
          try { bot = require('../remote/discord-bot'); } catch (_) { return { status: 'healthy', message: 'Module not loaded', fixable: false }; }
          const status = typeof bot.getStatus === 'function' ? bot.getStatus() : null;
          if (status && status.connected) return { status: 'healthy', message: `Connected as ${status.tag || 'bot'}`, fixable: false };
          return { status: 'degraded', message: 'Token set but bot not connected', fixable: false };
        } catch (e) {
          return { status: 'healthy', message: `Probe skipped: ${e.message}`, fixable: false };
        }
      },
    },
  ];
}

// ── Liveness probes from C-REL-3 ─────────────────────────────
function _livenessProbes(deps) {
  const { db } = deps;
  return [
    // AutoResearch liveness: if any target is `status='running'` but has had
    // no experiment recorded in the last 15 minutes, mark it degraded. This
    // catches the case where the loop is technically alive but stuck.
    {
      name: 'autoresearch-progress',
      label: 'AutoResearch Progress',
      check: async () => {
        try {
          if (!db || !db.raw) return { status: 'healthy', message: 'db.raw unavailable', fixable: false };
          const running = db.raw().prepare("SELECT id FROM research_targets WHERE status = 'running'").all();
          if (running.length === 0) return { status: 'healthy', message: 'No active research', fixable: false };
          const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
          const stalled = [];
          for (const t of running) {
            const recent = db.raw().prepare(
              "SELECT COUNT(1) AS c FROM experiments WHERE target_id = ? AND created_at > ?"
            ).get(t.id, cutoff);
            if (!recent || recent.c === 0) stalled.push(t.id);
          }
          if (stalled.length > 0) {
            return { status: 'degraded', message: `${stalled.length} target(s) stalled >15min: ${stalled.join(', ')}`, fixable: false };
          }
          return { status: 'healthy', message: `${running.length} target(s) producing experiments`, fixable: false };
        } catch (e) {
          return { status: 'healthy', message: `Probe skipped: ${e.message}`, fixable: false };
        }
      },
    },
  ];
}

const _originalCreateProbes = createProbes;

/**
 * Compose the full probe set: built-ins + coverage-gap probes + liveness
 * probes + any registered via registerProbe(). Order is intentional —
 * built-ins first so they appear at the top of the watchdog panel.
 */
function createAllProbes(deps) {
  return [
    ..._originalCreateProbes(deps),
    ..._coreProbes(deps),
    ..._livenessProbes(deps),
    ..._extraProbes,
  ];
}

module.exports = { createProbes: createAllProbes, registerProbe };
