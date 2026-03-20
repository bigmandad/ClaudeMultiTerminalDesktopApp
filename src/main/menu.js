const { Menu, app } = require('electron');

function createMenu(mainWindow) {
  const isMac = process.platform === 'darwin';

  const template = [
    // macOS app menu (required — first menu becomes the app name menu)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('menu:settings')
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Session',
          accelerator: 'CmdOrCtrl+T',
          click: () => mainWindow?.webContents.send('menu:newSession')
        },
        {
          label: 'Close Session',
          accelerator: 'CmdOrCtrl+W',
          click: () => mainWindow?.webContents.send('menu:closeSession')
        },
        { type: 'separator' },
        // Settings lives in app menu on macOS, in File on Windows/Linux
        ...(!isMac ? [{
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('menu:settings')
        },
        { type: 'separator' }] : []),
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Single Pane',
          accelerator: 'CmdOrCtrl+1',
          click: () => mainWindow?.webContents.send('menu:layout', 'single')
        },
        {
          label: 'Split Panes',
          accelerator: 'CmdOrCtrl+2',
          click: () => mainWindow?.webContents.send('menu:layout', 'split')
        },
        {
          label: 'Triple Panes',
          accelerator: 'CmdOrCtrl+3',
          click: () => mainWindow?.webContents.send('menu:layout', 'triple')
        },
        {
          label: 'Quad Panes',
          accelerator: 'CmdOrCtrl+4',
          click: () => mainWindow?.webContents.send('menu:layout', 'quad')
        },
        { type: 'separator' },
        {
          label: 'Toggle Broadcast',
          accelerator: 'CmdOrCtrl+B',
          click: () => mainWindow?.webContents.send('menu:broadcast')
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' }
      ]
    },
    // macOS Window menu (standard — provides Minimize, Zoom, Front)
    ...(isMac ? [{
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }] : []),
    {
      label: 'Help',
      submenu: [
        ...(!isMac ? [{
          label: 'About Claude Sessions',
          click: () => mainWindow?.webContents.send('menu:about')
        }] : [])
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

module.exports = { createMenu };
