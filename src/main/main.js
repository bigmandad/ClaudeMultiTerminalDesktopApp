const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { registerIpcHandlers, cleanup } = require('./ipc-handlers');
const { registerSetupIPC } = require('./setup/setup-ipc');
const { registerPluginSyncIPC } = require('./sync/plugin-sync-ipc');
const { createMenu } = require('./menu');

// ── Load env vars from ~/.claude-sessions/.env (if it exists) ──
// Simple key=value parser — no dotenv dependency required.
// Must run before any module reads process.env for Turso config.
(function loadDotEnv() {
  try {
    const envPath = path.join(os.homedir(), '.claude-sessions', '.env');
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Only set if not already defined (real env vars take precedence)
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    console.log('[Main] Loaded env vars from', envPath);
  } catch (err) {
    console.warn('[Main] Failed to load .env file:', err.message);
  }
})();

// ── Fix macOS PATH for Electron apps launched from Finder/Dock ──
function fixMacOSPath() {
  if (process.platform !== 'darwin') return;
  try {
    const { execSync } = require('child_process');
    const shellPath = execSync('/bin/zsh -ilc "echo $PATH"', { encoding: 'utf8', timeout: 5000 }).trim();
    if (shellPath) {
      process.env.PATH = shellPath;
    }
  } catch (e) {
    console.warn('[PATH] Could not resolve macOS shell PATH, using fallback:', e.message);
    // Fallback: prepend common Homebrew paths
    const fallback = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
    const current = process.env.PATH || '';
    const missing = fallback.filter(p => !current.includes(p));
    if (missing.length > 0) {
      process.env.PATH = missing.join(':') + ':' + current;
    }
  }
}
fixMacOSPath();

// ── Prevent EPIPE crashes from broken stdout/stderr pipes ──
// In Electron, stdout/stderr can become broken pipes when running
// without a console or when the parent process closes. Without this,
// any console.log/warn/error call crashes the entire app.
for (const stream of [process.stdout, process.stderr]) {
  if (stream) {
    stream.on('error', (err) => {
      if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
    });
  }
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1a1714',
    frame: false,
    titleBarStyle: 'hidden',
    ...(process.platform === 'win32' ? {
      titleBarOverlay: {
        color: '#1a1714',
        symbolColor: '#e8ddd0',
        height: 36
      }
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png')
  });

  // Grant microphone permissions for speech-to-text
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'microphone') {
      callback(true);
    } else {
      callback(false);
    }
  });

  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media' || permission === 'microphone') {
      return true;
    }
    return false;
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Create app menu
  createMenu(mainWindow);

  // Open DevTools in dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  registerSetupIPC();
  registerIpcHandlers(ipcMain);
  createWindow();

  // Run database maintenance (prune expired blackboard entries + old hook events)
  try {
    const db = require('./db/database');
    db.runMaintenance();
    console.log('[Main] Database maintenance completed');
  } catch (err) {
    console.log('[Main] Database maintenance skipped:', err.message);
  }

  // Plugin sync — register IPC handlers and wire up custom plugin repo
  try {
    const db = require('./db/database');
    const localDb = db.init();
    const customPluginsRepo = path.join(os.homedir(), 'Documents', 'ClaudeWorkspace', 'claude-plugins-custom');
    registerPluginSyncIPC(localDb, fs.existsSync(customPluginsRepo) ? customPluginsRepo : null);
    console.log('[Main] Plugin sync IPC registered');
  } catch (err) {
    console.log('[Main] Plugin sync setup skipped:', err.message);
  }

  // Auto-start OpenViking server in background
  try {
    const ovServer = require('./openviking/ov-server');
    ovServer.startServer().then(healthy => {
      if (healthy) {
        console.log('[Main] OpenViking server started automatically');
        // Broadcast status to renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('openviking:serverReady', {
            running: true, healthy: true, port: ovServer.OV_PORT
          });
        }
      } else {
        console.log('[Main] OpenViking server failed to start (Ollama may not be running)');
      }
    }).catch(err => {
      console.log('[Main] OpenViking auto-start skipped:', err.message);
    });
  } catch (err) {
    console.log('[Main] OpenViking module not available:', err.message);
  }

  // Auto-start Discord bot if token is available
  try {
    const db = require('./db/database');
    const discordToken = db.appState.get('discord_bot_token');
    if (discordToken) {
      // Auto-enable when token exists
      db.appState.set('discord_bot_enabled', true);
      const discordBot = require('./remote/discord-bot');
      discordBot.start(discordToken).then((result) => {
        if (result.success) {
          console.log('[Main] Discord bot started automatically as', result.tag);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('discord:statusChanged', { connected: true });
          }
        } else {
          console.log('[Main] Discord bot auto-start failed:', result.error || result.status);
        }
      }).catch(err => {
        console.log('[Main] Discord bot auto-start skipped:', err.message);
      });
    }
  } catch (err) {
    console.log('[Main] Discord bot module not available:', err.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  const { PtyManager } = require('./pty/pty-manager');
  PtyManager.killAll();
  // Mark all active/starting sessions as stopped so they can be restored on next launch
  markAllSessionsStopped();
  // Push final state to Turso before closing
  try { const db = require('./db/database'); db.sync(); } catch (_) {}
  cleanup();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  const { PtyManager } = require('./pty/pty-manager');
  PtyManager.killAll();
  markAllSessionsStopped();
  // Push final state to Turso before quitting
  try { const db = require('./db/database'); db.sync(); } catch (_) {}
  cleanup();
});

function markAllSessionsStopped() {
  try {
    const db = require('./db/database');
    const sessions = db.sessions.list();
    for (const s of sessions) {
      if (s.status === 'active' || s.status === 'starting') {
        db.sessions.update(s.id, { status: 'stopped' });
      }
    }
  } catch (e) {
    // DB may already be closed
  }
}

// Expose mainWindow for IPC handlers
module.exports = { getMainWindow: () => mainWindow };
