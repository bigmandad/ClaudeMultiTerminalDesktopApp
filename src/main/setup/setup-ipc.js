// ── Setup Wizard IPC Handlers ─────────────────────────────
const { ipcMain } = require('electron');
const setup = require('./setup-wizard');

function registerSetupIPC() {
  ipcMain.handle('setup:isComplete', () => setup.isSetupComplete());

  ipcMain.handle('setup:checkDeps', () => setup.checkDependencies());

  ipcMain.handle('setup:installDep', async (e, { name, command }) => {
    return setup.installDependency(name, command, (depName, output) => {
      e.sender.send('setup:installProgress', { name: depName, output });
    });
  });

  ipcMain.handle('setup:configure', async (e, { workspaceRoot }) => {
    return setup.configureWorkspace(workspaceRoot);
  });

  ipcMain.handle('setup:pullModel', async (e, { model }) => {
    return setup.pullOllamaModel(model, (output) => {
      e.sender.send('setup:modelProgress', { output });
    });
  });

  ipcMain.handle('setup:markComplete', () => {
    setup.markSetupComplete();
    return true;
  });

  ipcMain.handle('setup:getMachineId', () => setup.getMachineId());

  ipcMain.handle('setup:detectHytalePath', () => setup.detectHytaleGamePath());
}

module.exports = { registerSetupIPC };
