// ── Watchdog Health Probes ─────────────────────────────────
// Each probe: { name, label, check() → {status, message, fixable}, fix() }

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

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
        const envPath = path.join(os.homedir(), '.claude-sessions', '.env');
        if (!fs.existsSync(envPath)) {
          return { status: 'healthy', message: 'Local-only mode (no cloud)', fixable: false };
        }
        const env = fs.readFileSync(envPath, 'utf8');
        if (!env.includes('TURSO_DATABASE_URL=') || env.includes('TURSO_DATABASE_URL=\n')) {
          return { status: 'healthy', message: 'Local-only mode', fixable: false };
        }
        // Check if sync is recent (within 5 min)
        if (db && db.get) {
          try {
            const row = db.get("SELECT value FROM app_state WHERE key = 'last_turso_sync'");
            if (row && row.value) {
              const lastSync = new Date(row.value);
              const ageMin = (Date.now() - lastSync.getTime()) / 60000;
              if (ageMin < 5) return { status: 'healthy', message: `Synced ${Math.round(ageMin)}m ago`, fixable: false };
              return { status: 'degraded', message: `Last sync ${Math.round(ageMin)}m ago`, fixable: true };
            }
          } catch {}
        }
        // Can't determine age, just check if replica file exists
        const replicaPath = path.join(os.homedir(), '.claude-sessions', 'turso-replica.db');
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
        const dbPath = path.join(os.homedir(), '.claude-sessions', 'claude-sessions.db');
        if (!fs.existsSync(dbPath)) {
          return { status: 'down', message: 'Database file missing', fixable: false };
        }
        // Check DB is accessible
        if (db && db.get) {
          try {
            const result = db.get("PRAGMA integrity_check(1)");
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
        if (db && db.run) {
          try {
            db.run("PRAGMA wal_checkpoint(PASSIVE)");
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
        return { success: false, message: 'setup.configurePlugins not available' };
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

module.exports = { createProbes };
