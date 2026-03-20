const { ipcMain } = require('electron');
const { syncPlugins, getInstalledPlugins, getMissingPlugins, pushPluginManifest } = require('./plugin-sync');

function registerPluginSyncIPC(db, customRepoPath) {
  ipcMain.handle('pluginSync:getInstalled', () => getInstalledPlugins());

  ipcMain.handle('pluginSync:getMissing', () => getMissingPlugins(db));

  ipcMain.handle('pluginSync:pushManifest', () => {
    pushPluginManifest(db);
    return { success: true };
  });

  ipcMain.handle('pluginSync:syncAll', async () => {
    try {
      await syncPlugins(db, customRepoPath);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = { registerPluginSyncIPC };
