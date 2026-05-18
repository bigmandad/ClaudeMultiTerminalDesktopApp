// ── IPC: log + metrics namespaces ─────────────────────────
// First extraction from the ipc-handlers.js monolith. Demonstrates the
// per-namespace register(ipcMain, deps) pattern. See ./README.md for the
// rest of the migration roadmap.

const eventLog = require('../observability/event-log');
const metrics = require('../observability/metrics');

function register(ipcMain, _deps = {}) {
  ipcMain.handle('log:tail',      (_e, opts)       => eventLog.tail(opts || {}));
  ipcMain.handle('log:listFiles', ()               => eventLog.listFiles());
  ipcMain.handle('log:readFile',  (_e, name, opts) => eventLog.readFile(name, opts || {}));
  ipcMain.handle('metrics:snapshot', () => metrics.snapshot());

  // Live push subscription: fan out new log entries to all renderer windows.
  // Returns a teardown function the caller can stash if needed.
  const { BrowserWindow } = require('electron');
  const unsubscribe = eventLog.subscribe((rec) => {
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win && !win.isDestroyed()) win.webContents.send('log:event', rec);
      }
    } catch (_) {}
  });

  return { unsubscribe };
}

module.exports = { register };
