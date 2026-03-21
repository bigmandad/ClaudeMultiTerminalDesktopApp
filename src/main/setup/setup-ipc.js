// ── Setup Wizard IPC Handlers ─────────────────────────────
const { ipcMain } = require('electron');
const setup = require('./setup-wizard');

function registerSetupIPC() {
  // ── Legacy / existing handlers ────────────────────────────
  ipcMain.handle('setup:isComplete', () => setup.isSetupComplete());

  ipcMain.handle('setup:checkDeps', () => setup.checkDependencies());

  ipcMain.handle('setup:installDep', async (e, { name, command }) => {
    return setup.installDependency(name, command, (depName, output) => {
      e.sender.send('setup:installProgress', { name: depName, output });
    });
  });

  ipcMain.handle('setup:configure', async (e, opts) => {
    const workspaceRoot = (opts && opts.workspaceRoot) || setup.getWorkspaceRoot();
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

  // ── New: Resumable state ──────────────────────────────────
  ipcMain.handle('setup:getState', () => setup.getSetupState());

  ipcMain.handle('setup:saveState', (e, update) => setup.saveSetupState(update));

  // ── New: Workspace root ───────────────────────────────────
  ipcMain.handle('setup:getWorkspaceRoot', () => setup.getWorkspaceRoot());

  // ── New: Turso credentials ────────────────────────────────
  ipcMain.handle('setup:saveTurso', async (e, { url, token }) => {
    return setup.saveTursoCredentials(url, token);
  });

  ipcMain.handle('setup:testTurso', async (e, { url, token }) => {
    return setup.testTursoConnection(url, token);
  });

  // ── New: Ollama service ───────────────────────────────────
  ipcMain.handle('setup:startOllama', async () => {
    return setup.startOllamaService();
  });

  ipcMain.handle('setup:checkOllama', async () => {
    return setup.checkOllamaRunning();
  });

  // ── New: Repo cloning ─────────────────────────────────────
  ipcMain.handle('setup:cloneRepos', async (e) => {
    return setup.cloneRepos((name, status) => {
      e.sender.send('setup:cloneProgress', { name, status });
    });
  });

  // ── New: Plugin configuration ─────────────────────────────
  ipcMain.handle('setup:configurePlugins', async () => {
    return setup.configurePlugins();
  });

  // ── New: PATH refresh ─────────────────────────────────────
  ipcMain.handle('setup:refreshPath', () => {
    return setup.refreshPath();
  });

  // ── New: Comprehensive verification ───────────────────────
  ipcMain.handle('setup:verify', async () => {
    return setup.runVerification();
  });
}

module.exports = { registerSetupIPC };
