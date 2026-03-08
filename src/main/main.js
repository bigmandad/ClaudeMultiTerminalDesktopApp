const { app, BrowserWindow, ipcMain } = require('electron');
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

app.whenReady().then(() => {
  registerIpcHandlers(ipcMain);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  const { PtyManager } = require('./pty/pty-manager');
  PtyManager.killAll();
  cleanup();
  app.quit();
});

app.on('before-quit', () => {
  const { PtyManager } = require('./pty/pty-manager');
  PtyManager.killAll();
  cleanup();
});

// Expose mainWindow for IPC handlers
module.exports = { getMainWindow: () => mainWindow };
