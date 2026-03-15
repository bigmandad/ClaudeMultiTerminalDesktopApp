const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const { registerIpcHandlers, cleanup } = require('./ipc-handlers');
const { createMenu } = require('./menu');

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
    titleBarOverlay: {
      color: '#1a1714',
      symbolColor: '#e8ddd0',
      height: 36
    },
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
  registerIpcHandlers(ipcMain);
  createWindow();

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  const { PtyManager } = require('./pty/pty-manager');
  PtyManager.killAll();
  // Mark all active/starting sessions as stopped so they can be restored on next launch
  markAllSessionsStopped();
  cleanup();
  app.quit();
});

app.on('before-quit', () => {
  const { PtyManager } = require('./pty/pty-manager');
  PtyManager.killAll();
  markAllSessionsStopped();
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
