const {
  app,
  Menu,
  MenuItem,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  dialog,
  session,
  net,
  powerMonitor,
  webContents,
  clipboard,
} = require('electron');
const path = require('path');
const { registerHarIpc } = require('./har.js');
const { manageBrowserColorScheme } = require('./tb-color-scheme.js');
const { startStallWatchdog } = require('./stall-watchdog.js');
const { applyPagePermissions } = require('./page-permissions.js');
const { cleanUpWindowSessions } = require('./window-session-cleanup.js');
const { publishUserGuides } = require('./user-guides.js');
const { CHANNELS, RELAYED } = require('tranquil-browser/lib/ipc.js');

// A closed window's browser session goes with it (window-session-cleanup.js).
cleanUpWindowSessions(() => global.atomApplication);

// The user guides for users' LLMs, copied to ~/.tranquil/llm/ (user-guides.js).
publishUserGuides();

// HAR capture (hidden-window DevTools Protocol recording) + offline replay
// (per-archive session interception) for the Tranquil browser. See har.js.
registerHarIpc({ ipcMain, session, dialog, BrowserWindow, app });

// Freeze diagnostics: main-process event-loop lag, per-window renderer hangs, and sleep/wake
// markers to tell the two apart. Reports only — see stall-watchdog.js.
startStallWatchdog({ app, BrowserWindow, powerMonitor });

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
ipcMain.on(CHANNELS.setUserAgent, (event, ua) => {
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
    // Web pages get no permission that was not explicitly allowed (page-permissions.js).
    applyPagePermissions(ses);
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
          CHANNELS.openLinkInNewTab,
          { link: url, id: Date.now() }
        );
      }
      return { action: 'deny' };
    });

    // A page's own `beforeunload` handler can cancel its unload — and unlike a
    // BrowserWindow tab, Tranquil shows no "leave site?" confirmation for a
    // guest webview, so a cancelled unload just silently blocks cmd-w with no
    // visible feedback (reads as "closing sometimes does nothing" or "closing
    // is slow" when the handler itself does non-trivial work before deciding).
    // Always allow the close: a closed browser tab isn't a real "you'll lose
    // unsaved work" situation the way closing an editor is.
    webContents.on('will-prevent-unload', (event) => {
      event.preventDefault();
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
              CHANNELS.getSelectedContentLink,
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
              CHANNELS.getSelectedContentLink,
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
              CHANNELS.getSelectedContentLink,
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
              CHANNELS.getSelectedContentLink,
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
              CHANNELS.getSelectedContentLink,
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
              CHANNELS.getSelectedImageLink,
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

// Requests from the page preload (bp-client.js), which runs sandboxed without Node.js.
// Suggestions are for our own start page only, and come from DuckDuckGo only.
function fromOwnPage(event, name) {
  try {
    const u = new URL(event.senderFrame.url);
    return u.protocol === 'file:' && u.pathname.endsWith('/tranquil-browser/resources/' + name);
  } catch {
    return false;
  }
}

ipcMain.handle(CHANNELS.suggest, async (event, term) => {
  if (!fromOwnPage(event, 'home.html')) return [];
  if (typeof term !== 'string' || !term.trim() || term.length > 200) return [];
  try {
    const res = await net.fetch(
      'https://ac.duckduckgo.com/ac/?type=list&q=' + encodeURIComponent(term),
      {
        headers: { 'User-Agent': currentUserAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(4000),
      }
    );
    const data = await res.json();
    return Array.isArray(data && data[1])
      ? data[1].filter((s) => typeof s === 'string').slice(0, 10)
      : [];
  } catch {
    return [];
  }
});

// "Copy link address" from a page's context menu: an http(s) address, nothing else.
ipcMain.on(CHANNELS.copyLink, (event, address) => {
  if (event.sender.getType() !== 'webview') return;
  if (typeof address !== 'string' || address.length > 8192 || !/^https?:\/\//i.test(address)) return;
  clipboard.writeText(address);
});

// Messages from a page's preload that belong to the window showing it, passed on unchanged.
// Key events also say which page sent them, so the window can find its tab (ADR-0018).
for (const channel of RELAYED) {
  ipcMain.on(channel, (event, arg) => {
    const payload =
      channel === CHANNELS.webviewKeyEvents ? { ...arg, webContentsId: event.sender.id } : arg;
    BrowserWindow.getFocusedWindow()?.webContents?.send(channel, payload);
  });
}

// Fallback for a browser tab whose guest won't close gracefully — a page
// stuck in heavy/blocking synchronous JS (not `beforeunload`; that's handled
// above via `will-prevent-unload`) can leave its renderer unresponsive to the
// teardown Electron sends when the <webview> is detached. The renderer sends
// this after giving the normal close a grace period (see
// tranquil-browser-view.js); if the webContents still exists by then, kill
// its process outright so the tab actually closes. Harmless no-op if it
// already tore down cleanly in the meantime.
ipcMain.on(CHANNELS.forceCloseWebview, (event, webContentsId) => {
  const guest = webContents.fromId(webContentsId);
  if (guest && !guest.isDestroyed()) {
    guest.forcefullyCrashRenderer();
  }
});

ipcMain.handle(CHANNELS.showSaveUrlDialog, async (event, { defaultPath }) => {
  const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
  return dialog.showSaveDialog(win, {
    defaultPath,
    filters: [{ name: 'URL Shortcut', extensions: ['url'] }],
    showsTagField: false,
  });
});

