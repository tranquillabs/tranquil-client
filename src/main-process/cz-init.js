const {
  app,
  Menu,
  MenuItem,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  globalShortcut,
  dialog,
  session,
} = require('electron');
const path = require('path');
const { registerHarIpc } = require('./har.js');
const { manageBrowserColorScheme } = require('./tb-color-scheme.js');

// HAR capture (hidden-window DevTools Protocol recording) + offline replay
// (per-archive session interception) for the Tranquil browser. See har.js.
registerHarIpc({ ipcMain, session, dialog, BrowserWindow, app });

// Uncomment this to test the updater in dev mode
// Object.defineProperty(app, 'isPackaged', {
//   get() {
//     return true;
//   }
// });

app.on('web-contents-created', (...[, /* event */ webContents]) => {
  // Isolate browser <webview> guests from the editor-driven nativeTheme so
  // websites follow the OS appearance, not the dark editor theme. See
  // tb-color-scheme.js.
  manageBrowserColorScheme(webContents);

  webContents.on('before-input-event', (event, input) => {
    if (webContents.getType() !== 'webview') return;
    if (input.type !== 'keyDown' || input.key !== 'r') return;
    if (!input.meta) return;
    event.preventDefault();
    if (input.shift) {
      webContents.reloadIgnoringCache();
    } else {
      webContents.reload();
    }
  });

  //Webview is being shown here as a window type
  webContents.on(
    'context-menu',
    (event, click) => {
      event.preventDefault();
      var menu = new Menu();
      //Basic Menu For Testing
      menu.append(
        new MenuItem({
          label: 'Copy link address',
          click: async function () {
            // {main} to renderer
            BrowserWindow.getFocusedWindow()?.webContents?.send(
              'get-selected-content-link',
              {
                action: 'copy-link-address',
              }
            );
          },
        })
      );
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(
        new MenuItem({
          label: 'Open link in new tab',
          click: function () {
            // {main} to renderer
            const id = Date.now();  // to prevent this event from being called multiple times at once.
            BrowserWindow.getFocusedWindow()?.webContents?.send(
              'get-selected-content-link',
              {
                action: 'open-in-new-tab',
                id
              }
            );
          },
        })
      );
      menu.append(
        new MenuItem({
          label: 'Open link in default browser',
          click: function () {
            // {main} to renderer
            const id = Date.now(); // to prevent this event from being called multiple times at once.
            BrowserWindow.getFocusedWindow()?.webContents?.send(
              'get-selected-content-link',
              {
                action: 'open-in-default-window',
                id,
              }
            );
          },
        })
      );
      menu.append(
        new MenuItem({
          label: 'Open link in new window',
          click: function () {
            // {main} to renderer
            const id = Date.now(); // to prevent this event from being called multiple times at once.
            BrowserWindow.getFocusedWindow()?.webContents?.send(
              'get-selected-content-link',
              {
                action: 'open-in-new-window',
                id,
              }
            );
          },
        })
      );
      menu.append(
        new MenuItem({
          label: 'Save link to Treeview',
          click: async function () {
            // {main} to renderer
            BrowserWindow.getFocusedWindow()?.webContents?.send(
              'get-selected-content-link',
              {
                action: 'add-link-to-treeview',
              }
            );
          },
        })
      );
      menu.append(
        new MenuItem({
          label: 'Save image to Treeview',
          click: async function () {
            BrowserWindow.getFocusedWindow()?.webContents?.send(
              'get-selected-image-link',
              {
                action: 'add-link-to-treeview',
              }
            );
          },
        })
      );
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Cut', accelerator: 'CmdOrCtrl+X', selector: 'cut:', role: 'cut' }));
      menu.append(new MenuItem({ label: 'Copy', accelerator: 'CmdOrCtrl+C', selector: 'copy:', role: 'copy' }));
      menu.append(new MenuItem({ label: 'Paste', accelerator: 'CmdOrCtrl+V', selector: 'paste:', role: 'paste' }));
      menu.append(new MenuItem({ label: 'Select all', accelerator: 'CmdOrCtrl+A', selector: 'selectAll:', role: 'selectAll' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(
        new MenuItem({
          label: 'Zoom in',
          click: async function () {
            webContents.setZoomFactor(webContents.getZoomFactor() + 0.1);
          },
          accelerator: 'CmdOrCtrl+numadd',
        })
      );
      menu.append(
        new MenuItem({
          label: 'Zoom out',
          click: async function () {
            webContents.setZoomFactor(webContents.getZoomFactor() - 0.1);
          },
          accelerator: 'CmdOrCtrl+numsub',
        })
      );
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(
        new MenuItem({
          label: 'Inspect',
          click: async function () {
            webContents.closeDevTools();
            webContents.openDevTools();
          },
        })
      );
      console.log(webContents.getType());
      menu.popup(webContents);
    },
    false
  );
});

ipcMain.on('open-link-in-new-tab', (event, arg) => {
  BrowserWindow.getFocusedWindow()?.webContents?.send(
    'open-link-in-new-tab',
    arg
  );
});

ipcMain.on('open-link-in-default-window', (event, arg) => {
  BrowserWindow.getFocusedWindow()?.webContents?.send(
    'open-link-in-default-window',
    arg
  );
});

ipcMain.on('open-link-in-new-window', (event, arg) => {
  BrowserWindow.getFocusedWindow()?.webContents?.send(
    'open-link-in-new-window',
    arg
  );
});

ipcMain.handle('show-save-url-dialog', async (event, { defaultPath }) => {
  const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
  return dialog.showSaveDialog(win, {
    defaultPath,
    filters: [{ name: 'URL Shortcut', extensions: ['url'] }],
    showsTagField: false,
  });
});

ipcMain.on('add-link-to-treeview', (event, arg) => {
  BrowserWindow.getFocusedWindow()?.webContents?.send(
    'add-link-to-treeview',
    arg
  );
});

ipcMain.on('webview-key-events', (event, arg) => {
  BrowserWindow.getFocusedWindow()?.webContents?.send(
    'webview-key-events',
    { ...arg, webContentsId: event.sender.id }
  );
});

const addGlobalShortcuts = (arg) => {
  globalShortcut.register('CommandOrControl+numsub', function () {
    BrowserWindow.getFocusedWindow()?.webContents?.send('zoom', {
      type: 'out',
      webViewId: arg?.webViewId,
    });
  });

  globalShortcut.register('CommandOrControl+numadd', function () {
    BrowserWindow.getFocusedWindow()?.webContents?.send('zoom', {
      type: 'in',
      webViewId: arg?.webViewId,
    });
  });
  globalShortcut.register('CommandOrControl+-', function () {
    BrowserWindow.getFocusedWindow()?.webContents?.send('zoom', {
      type: 'out',
      webViewId: arg?.webViewId,
    });
  });
  globalShortcut.register('CommandOrControl+=', function () {
    BrowserWindow.getFocusedWindow()?.webContents?.send('zoom', {
      type: 'in',
      webViewId: arg?.webViewId,
    });
  });


};
const removeGlobalShortcuts = () => {
  globalShortcut.unregister('CommandOrControl+numsub');
  globalShortcut.unregister('CommandOrControl+numadd');
  globalShortcut.unregister('CommandOrControl+-');
  globalShortcut.unregister('CommandOrControl+=');
};
ipcMain.on('add-instance-events', (event, arg) => {
  addGlobalShortcuts(arg);
  BrowserWindow.getFocusedWindow()?.on('focus', () => {
    removeGlobalShortcuts();
    addGlobalShortcuts(arg);
  });
  BrowserWindow.getFocusedWindow()?.on('blur', () => {
    removeGlobalShortcuts();
  });
});

ipcMain.on('hide-login-screen', (event, payload) => {
  BrowserWindow.getAllWindows().forEach(win => {
    win?.webContents?.send('hide-login-screen', payload);
  });
});

ipcMain.on('logout-session', (event, arg) => {
  console.log('ipcMain-logout-session');
  const win = BrowserWindow.getFocusedWindow();
  const ses = win.webContents.session;
  ses.clearCache();
  ses
    .clearStorageData({ storages: ['cookies'] })
    .then(() => {
      console.log('All cookies cleared');
      BrowserWindow.getAllWindows().forEach((windows) => {
        windows?.webContents?.send('show-login-screen', arg);
      });
    })
    .catch((error) => {
      console.error('Failed to clear cookies: ', error);
    });
});


ipcMain.on('tab-focus', async (event, arg) => {
  BrowserWindow.getFocusedWindow()?.webContents?.send(
    'tab-focus',
    arg
  );
});

ipcMain.handle('electron-signed-in-email', async (event, obj) => {
  BrowserWindow.getFocusedWindow()?.webContents?.send(
    'electron-send-email-to-webview',
    {}
  );
});