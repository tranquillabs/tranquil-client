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
  net,
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

// Browser <webview> guests present a configurable, clean User-Agent (no Electron
// or app tokens). The renderer (tranquil-browser) owns the value and pushes it via
// 'set-user-agent' whenever it changes; we seed a clean default from the app's own
// fallback UA so guest requests are clean even before that first push.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripAppUaTokens = (ua) =>
  (ua || '').replace(
    new RegExp(` (?:${escapeRegExp(app.getName())}|Electron)\\/\\S+`, 'g'),
    ''
  );
// Seed with the Chrome version token pinned to a current release, mirroring the
// renderer's CLEAN_USER_AGENT (tranquil-browser/lib/utils.js) — the bundled
// Chromium's frozen version reads as an outdated browser to bot heuristics. The
// renderer's first 'set-user-agent' push replaces this anyway.
let currentUserAgent = stripAppUaTokens(app.userAgentFallback).replace(
  /Chrome\/[\d.]+/,
  'Chrome/139.0.0.0'
);
ipcMain.on('set-user-agent', (event, ua) => {
  if (typeof ua === 'string' && ua.trim()) currentUserAgent = ua.trim();
});

// Latest stable Chrome/Firefox versions, fetched on demand from the vendors'
// official version endpoints — only when the user clicks "Check Current
// Versions" in the Tranquil settings tab (tranquil-config), never
// automatically. Runs here so the requests use net.fetch (proxy-aware, no page
// CORS). Returns tokens in the shape real browsers advertise: Chrome froze its
// minor as 0.0.0, Firefox reports major.0.
ipcMain.handle('fetch-browser-versions', async () => {
  // The `releases` endpoint (vs plain `versions`) includes serving.startTime —
  // when the build started rolling out — which the settings tab shows and uses
  // for its staleness hint. Firefox's payload carries its release dates (and
  // the scheduled NEXT_RELEASE_DATE) alongside the version.
  const [chromeRes, firefoxRes] = await Promise.all([
    net.fetch(
      'https://versionhistory.googleapis.com/v1/chrome/platforms/mac/channels/stable/versions/all/releases?pageSize=1'
    ),
    net.fetch('https://product-details.mozilla.org/1.0/firefox_versions.json'),
  ]);
  if (!chromeRes.ok || !firefoxRes.ok) {
    throw new Error(
      `version endpoints returned ${chromeRes.status} / ${firefoxRes.status}`
    );
  }
  const chromeJson = await chromeRes.json();
  const firefoxJson = await firefoxRes.json();
  const chromeRelease =
    (chromeJson.releases && chromeJson.releases[0]) || {};
  const chromeMajor = String(chromeRelease.version || '').split('.')[0];
  const firefoxMajor = String(firefoxJson.LATEST_FIREFOX_VERSION || '').split('.')[0];
  if (!/^\d+$/.test(chromeMajor) || !/^\d+$/.test(firefoxMajor)) {
    throw new Error('unexpected version endpoint response shape');
  }
  return {
    chrome: `${chromeMajor}.0.0.0`,
    chromeReleased: String(
      (chromeRelease.serving && chromeRelease.serving.startTime) || ''
    ).slice(0, 10),
    firefox: `${firefoxMajor}.0`,
    firefoxReleased: firefoxJson.LAST_RELEASE_DATE || '',
    firefoxNextRelease: firefoxJson.NEXT_RELEASE_DATE || '',
  };
});

// Clear the cookies a browser guest's current site can see (the "Clear Cookies"
// pane-control button in tranquil-automations). Scoped to the tab's session
// partition and to cookies that would be sent to `url` — including parent-domain
// cookies (.example.com) — so the rest of the window session's logins survive.
ipcMain.handle('clear-site-cookies', async (event, { partition, url }) => {
  const ses = partition
    ? session.fromPartition(partition)
    : session.defaultSession;
  const cookies = await ses.cookies.get({ url });
  await Promise.all(
    cookies.map((cookie) =>
      ses.cookies.remove(
        `http${cookie.secure ? 's' : ''}://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
        cookie.name
      )
    )
  );
  return cookies.length;
});
// Rewrite the User-Agent header once per guest session (WeakSet-guarded so shared
// per-window partitions aren't re-bound). The closure reads the live currentUserAgent.
const uaHeaderSessions = new WeakSet();

app.on('web-contents-created', (...[, /* event */ webContents]) => {
  // Isolate browser <webview> guests from the editor-driven nativeTheme so
  // websites follow the OS appearance, not the dark editor theme. See
  // tb-color-scheme.js.
  manageBrowserColorScheme(webContents);

  // Browser guests only: rewrite the User-Agent header on every outgoing request
  // (main document + subresources + WebSockets — the last two are missed by the
  // <webview useragent> attribute / setUserAgent; electron #7203/#7205).
  if (webContents.getType() === 'webview') {
    const ses = webContents.session;
    if (!uaHeaderSessions.has(ses)) {
      uaHeaderSessions.add(ses);
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['User-Agent'] = currentUserAgent;
        callback({ requestHeaders: details.requestHeaders });
      });
    }

    // Links that ask for a new window/tab — target="_blank" and window.open,
    // which most cross-domain "external" links use — must be intercepted on the
    // guest's webContents. Deny the native popup and route the URL back to the
    // embedding renderer to open as a new browser tab (reusing the same
    // open-link-in-new-tab flow as cmd-click, so it lands in the source tab's
    // stack). Plain same-window links (target=_self / none) are unaffected and
    // navigate in the current tab as usual.
    webContents.setWindowOpenHandler(({ url }) => {
      if (url && /^https?:\/\//i.test(url)) {
        // Same delivery the cmd-click flow uses (ipcMain 'open-link-in-new-tab'
        // below): send to the focused window — the one whose guest was just
        // clicked. The renderer handler dedups by id across its per-tab
        // listeners, so exactly one tab opens.
        BrowserWindow.getFocusedWindow()?.webContents?.send(
          'open-link-in-new-tab',
          { link: url, id: Date.now() }
        );
      }
      return { action: 'deny' };
    });
  }

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

// Zoom is driven by process-global accelerators, so they must be (re)registered
// for whichever browser window currently holds focus. The renderer's `zoom`
// handler zooms the *active* tab's webview (see tranquil-browser utils.js), so
// the accelerators just send a plain zoom command — no per-tab webViewId needed.
const addGlobalShortcuts = () => {
  const sendZoom = (type) =>
    BrowserWindow.getFocusedWindow()?.webContents?.send('zoom', { type });
  globalShortcut.register('CommandOrControl+numsub', () => sendZoom('out'));
  globalShortcut.register('CommandOrControl+numadd', () => sendZoom('in'));
  globalShortcut.register('CommandOrControl+-', () => sendZoom('out'));
  globalShortcut.register('CommandOrControl+=', () => sendZoom('in'));
};
const removeGlobalShortcuts = () => {
  globalShortcut.unregister('CommandOrControl+numsub');
  globalShortcut.unregister('CommandOrControl+numadd');
  globalShortcut.unregister('CommandOrControl+-');
  globalShortcut.unregister('CommandOrControl+=');
};

// `add-instance-events` fires once per browser TAB, but the focus/blur wiring
// that (re)registers the zoom accelerators is a per-WINDOW concern. Wire each
// window exactly once — the old code stacked a fresh focus+blur listener on the
// same BrowserWindow for every tab, leaking them (MaxListenersExceededWarning
// after ~10 tabs). The WeakSet entry drops when the window is destroyed.
const zoomWiredWindows = new WeakSet();
ipcMain.on('add-instance-events', (event) => {
  const win =
    BrowserWindow.fromWebContents(event.sender) ||
    BrowserWindow.getFocusedWindow();
  if (!win || zoomWiredWindows.has(win)) return;
  zoomWiredWindows.add(win);

  if (win.isFocused()) addGlobalShortcuts();
  win.on('focus', () => {
    removeGlobalShortcuts();
    addGlobalShortcuts();
  });
  win.on('blur', removeGlobalShortcuts);
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