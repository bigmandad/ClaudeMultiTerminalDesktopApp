// ── Watchdog IPC Handlers ─────────────────────────────────
const { ipcMain } = require('electron');

function registerWatchdogIPC(watchdog) {
  ipcMain.handle('watchdog:status', () => watchdog.getStatus());
  ipcMain.handle('watchdog:start', () => { watchdog.start(); return true; });
  ipcMain.handle('watchdog:stop', () => { watchdog.stop(); return true; });
  ipcMain.handle('watchdog:runNow', () => watchdog.runAllProbes());
  ipcMain.handle('watchdog:consentGitPush', () => { watchdog.consentGitPush(); return true; });
  ipcMain.handle('watchdog:revokeGitPush', () => { watchdog.revokeGitPush(); return true; });
}

module.exports = { registerWatchdogIPC };
