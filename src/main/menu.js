const { Menu, app } = require('electron');

function createMenu(mainWindow) {
  const template = [
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
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('menu:settings')
        },
        { type: 'separator' },
        { role: 'quit' }
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
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Claude Sessions',
          click: () => mainWindow?.webContents.send('menu:about')
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

module.exports = { createMenu };
