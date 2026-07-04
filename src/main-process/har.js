// HAR capture + offline replay for the Tranquil browser.
//
// Two capabilities, both driven over IPC from the tranquil-browser renderer:
//
//   capture-har  — attach the Chromium DevTools Protocol debugger to a browser
//                  tab's <webview> webContents, enable the Network domain,
//                  reload the page, and record every request/response (with
//                  bodies) into a HAR 1.2 object. CDP is not retroactive, hence
//                  the reload: we must be listening before the requests fire.
//
//   register-har — parse a saved .har and stand up an OFFLINE replay session for
//                  it. Each archive gets its own in-memory session partition
//                  ("har-replay-<id>"); on that session we intercept the page's
//                  original schemes (http/https/file) and serve responses from
//                  the archive by URL. The replay tab then navigates to the
//                  archived page's ORIGINAL url — so relative and absolute refs
//                  alike resolve to archived bytes with zero HTML/CSS rewriting.
//                  Interception is scoped to the per-archive partition, so the
//                  default session (normal browsing) is never touched.

const fs = require('fs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Convert a CDP header map { name: value } into HAR's [{ name, value }].
function toHeaderArray(headers) {
  return Object.entries(headers || {}).map(([name, value]) => ({
    name,
    value: String(value),
  }));
}

// Strip the fragment so lookups match regardless of in-page anchors.
function normalizeUrl(url) {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

// ---- Capture -------------------------------------------------------------

// Capture happens in a HIDDEN background window that loads the same URL with the
// debugger attached from the start — never the user's live tab. That keeps
// capture non-destructive (no reload flash, no chance of disposing the visible
// webview's frame) while still recording every request from the first byte
// (CDP's Network domain is not retroactive). The hidden window uses the same
// session as normal browsing (default session, unless a partition is given), so
// cookies / auth state carry over.
async function captureHar({ BrowserWindow, app }, { url, partition }) {
  if (!url || url === 'about:blank' || url.startsWith('tranquil-browser:')) {
    throw new Error('This tab has no page to capture.');
  }

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      ...(partition ? { partition } : {}),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const wc = win.webContents;
  const dbg = wc.debugger;

  const entries = new Map(); // requestId -> partial HAR entry
  const bodyJobs = []; // promises that fill in response bodies

  const onMessage = (_event, method, params) => {
    try {
      if (method === 'Network.requestWillBeSent') {
        // A redirect reuses the requestId; keep the latest request.
        entries.set(params.requestId, {
          _type: params.type,
          startedDateTime: new Date(params.wallTime * 1000).toISOString(),
          request: {
            method: params.request.method,
            url: params.request.url,
            httpVersion: 'HTTP/1.1',
            headers: toHeaderArray(params.request.headers),
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: params.request.postData
              ? Buffer.byteLength(params.request.postData)
              : 0,
            ...(params.request.postData
              ? { postData: { mimeType: '', text: params.request.postData } }
              : {}),
          },
          response: null,
        });
      } else if (method === 'Network.responseReceived') {
        const entry = entries.get(params.requestId);
        if (!entry) return;
        const r = params.response;
        entry.response = {
          status: r.status,
          statusText: r.statusText || '',
          httpVersion: 'HTTP/1.1',
          headers: toHeaderArray(r.headers),
          cookies: [],
          content: {
            size: -1,
            mimeType: r.mimeType || 'application/octet-stream',
            text: '',
          },
          redirectURL:
            (r.headers && (r.headers.location || r.headers.Location)) || '',
          headersSize: -1,
          bodySize: -1,
        };
      } else if (method === 'Network.loadingFinished') {
        const entry = entries.get(params.requestId);
        if (!entry || !entry.response) return;
        const job = dbg
          .sendCommand('Network.getResponseBody', {
            requestId: params.requestId,
          })
          .then((res) => {
            entry.response.content.text = res.body || '';
            if (res.base64Encoded) {
              entry.response.content.encoding = 'base64';
              entry.response.content.size = Buffer.from(
                res.body || '',
                'base64'
              ).length;
            } else {
              entry.response.content.size = Buffer.byteLength(res.body || '');
            }
            entry.response.bodySize = entry.response.content.size;
          })
          .catch(() => {
            // 204/redirects/aborted requests have no retrievable body.
          });
        bodyJobs.push(job);
      }
    } catch (_e) {
      // Never let a malformed event tear down the capture.
    }
  };

  try {
    // A brand-new hidden window has no renderer process yet, so CDP commands
    // (Network.enable) would hang waiting for a DevTools agent that doesn't
    // exist. Load about:blank first to spin up the renderer — it fetches no
    // subresources, so nothing is missed — THEN attach + enable, THEN navigate
    // to the real URL so every request is recorded from the first byte.
    await wc.loadURL('about:blank');
    try {
      dbg.attach('1.3');
    } catch (e) {
      throw new Error('Could not start HAR capture (' + e.message + ').');
    }
    dbg.on('message', onMessage);
    await dbg.sendCommand('Network.enable');

    // Load fresh in the hidden window; the debugger is already recording.
    // loadURL resolves on load and rejects on aborted sub-loads — either way
    // we've captured what fired, so a rejection is non-fatal. The timeout caps
    // pages whose load event never settles.
    await Promise.race([wc.loadURL(url).catch(() => {}), wait(20000)]);

    // Settle window for late/async resources (xhr/fetch, lazy fonts/images).
    await wait(1500);
    await Promise.allSettled(bodyJobs);

    const alive = !wc.isDestroyed();
    const pageUrl = (alive && wc.getURL()) || url;
    const pageTitle = (alive && wc.getTitle()) || pageUrl;
    const list = Array.from(entries.values()).filter((e) => e.response);

    return {
      log: {
        version: '1.2',
        creator: { name: 'Tranquil', version: app.getVersion() },
        pages: [
          {
            startedDateTime: new Date().toISOString(),
            id: 'page_1',
            title: pageTitle,
            pageTimings: { onContentLoad: -1, onLoad: -1 },
            // Non-standard hint used by the replay opener to know the entry URL.
            _url: pageUrl,
          },
        ],
        entries: list.map((e) => ({
          pageref: 'page_1',
          startedDateTime: e.startedDateTime,
          time: 0,
          request: e.request,
          response: e.response,
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
          _resourceType: e._type,
        })),
      },
    };
  } finally {
    try {
      dbg.removeListener('message', onMessage);
    } catch (_e) {
      /* never attached */
    }
    try {
      if (dbg.isAttached()) dbg.detach();
    } catch (_e) {
      /* already detached */
    }
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch (_e) {
      /* already gone */
    }
  }
}

// ---- Replay --------------------------------------------------------------

let archiveSeq = 0;
// harPath -> { archiveId, index, partition, pageUrl } — keyed by path so
// reopening the same .har (e.g. after a window reload re-runs the opener)
// reuses its replay session instead of leaking a new partition each time.
const archives = new Map();

function decodeBody(content) {
  if (!content || content.text == null) return Buffer.alloc(0);
  return content.encoding === 'base64'
    ? Buffer.from(content.text, 'base64')
    : Buffer.from(content.text, 'utf8');
}

function buildIndex(har) {
  const index = new Map();
  const entries = (har && har.log && har.log.entries) || [];
  for (const entry of entries) {
    if (!entry.request || !entry.response) continue;
    const url = normalizeUrl(entry.request.url);
    // First writer wins — keep the initial response for a URL, not a later
    // cache-buster with the same address.
    if (index.has(url)) continue;
    index.set(url, {
      status: entry.response.status || 200,
      mimeType:
        (entry.response.content && entry.response.content.mimeType) ||
        'application/octet-stream',
      buffer: decodeBody(entry.response.content),
      location: entry.response.redirectURL || '',
    });
  }
  return index;
}

function pageUrlFromHar(har) {
  const page = har && har.log && har.log.pages && har.log.pages[0];
  if (page && page._url) return page._url;
  // Fall back to the first document-type entry, else the first entry.
  const entries = (har && har.log && har.log.entries) || [];
  const doc = entries.find((e) => e._resourceType === 'Document');
  return (doc || entries[0] || {}).request?.url || 'about:blank';
}

function serveFromIndex(index, url, scheme) {
  const hit = index.get(normalizeUrl(url));
  if (!hit) {
    // File-scheme misses fall through to the real file on disk — this keeps the
    // webview's own file:// preload (bp-client.js) and any un-archived local
    // resource working. http/https misses stay offline: nothing hits the
    // network, so a missing remote asset simply 404s.
    if (scheme === 'file') {
      try {
        const filePath = decodeURIComponent(
          new URL(url).pathname.replace(/^\/([a-zA-Z]:)/, '$1')
        );
        return new Response(fs.readFileSync(filePath));
      } catch (_e) {
        return new Response('', { status: 404 });
      }
    }
    return new Response('', { status: 404 });
  }
  const headers = { 'content-type': hit.mimeType, 'cache-control': 'no-store' };
  if (hit.status >= 300 && hit.status < 400 && hit.location) {
    headers.location = hit.location;
  }
  return new Response(hit.buffer, { status: hit.status, headers });
}

// Register a .har for offline replay and return the info the opener needs to
// create a replay browser tab.
function registerHar({ session }, harPath) {
  const existing = archives.get(harPath);
  if (existing) {
    return {
      archiveId: existing.archiveId,
      partition: existing.partition,
      pageUrl: existing.pageUrl,
    };
  }

  const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
  const archiveId = String(++archiveSeq);
  const partition = 'har-replay-' + archiveId;
  const index = buildIndex(har);
  const pageUrl = pageUrlFromHar(har);

  const ses = session.fromPartition(partition);
  // Intercept the schemes an archived page uses. Scoped to this partition's
  // session only — the default session (normal tabs) is untouched.
  for (const scheme of ['http', 'https', 'file']) {
    try {
      ses.protocol.handle(scheme, (request) =>
        serveFromIndex(index, request.url, scheme)
      );
    } catch (_e) {
      // Already handled for this session (shouldn't happen — unique partition).
    }
  }

  archives.set(harPath, { archiveId, index, partition, pageUrl });
  return { archiveId, partition, pageUrl };
}

// ---- Wiring --------------------------------------------------------------

function registerHarIpc({ ipcMain, session, dialog, BrowserWindow, app }) {
  ipcMain.handle('capture-har', async (_event, { url, partition }) =>
    // Overall guard: never let a capture hang silently — surface a timeout the
    // renderer turns into an error toast. captureHar cleans up its own window.
    Promise.race([
      captureHar({ BrowserWindow, app }, { url, partition }),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('HAR capture timed out.')), 45000)
      ),
    ])
  );

  ipcMain.handle('show-save-har-dialog', async (event, { defaultPath }) => {
    const win =
      BrowserWindow.fromWebContents(event.sender) ||
      BrowserWindow.getFocusedWindow();
    return dialog.showSaveDialog(win, {
      defaultPath,
      filters: [{ name: 'HAR Archive', extensions: ['har'] }],
      showsTagField: false,
    });
  });

  ipcMain.handle('register-har', async (_event, { harPath }) =>
    registerHar({ session }, harPath)
  );
}

module.exports = { registerHarIpc };
