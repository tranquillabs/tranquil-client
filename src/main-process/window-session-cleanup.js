// Browser sessions belong to windows (ADR-0011): each window keeps its cookies, logins and cache
// in a saved partition of its own, `persist:tb-window-<windowSessionId>`, so a restored window
// comes back signed in. A window that is gone for good never comes back, so its session must not
// outlive it: otherwise old logins stay on disk indefinitely.
//
// - When a window closes for good, its session's data is cleared at once.
// - At startup, the partition folders of windows that no longer exist are deleted. The windows
//   that still exist are the ones Pulsar saved for restore (storage/application.json, written by
//   atom-application.js saveCurrentWindowOptions) plus any window already open. If that file
//   cannot be read, or has another format, nothing is deleted.
const fs = require('fs');
const path = require('path');
const { app, session } = require('electron');

const PREFIX = 'tb-window-';

const partitionFor = (id) => `persist:${PREFIX}${id}`;

// The window session ids saved for restore, or null when they cannot be known.
function savedSessionIds() {
  try {
    const home = process.env.ATOM_HOME || path.join(app.getPath('home'), '.tranquil');
    const state = JSON.parse(
      fs.readFileSync(path.join(home, 'storage', 'application.json'), 'utf8')
    );
    if (!state || state.version !== '1' || !Array.isArray(state.windows)) return null;
    return new Set(state.windows.map((w) => w && w.windowSessionId).filter(Boolean));
  } catch {
    return null;
  }
}

async function deleteOrphanedPartitions(atomApplication) {
  const live = savedSessionIds();
  if (!live || !atomApplication) return;
  for (const w of atomApplication.getAllWindows()) {
    if (w.windowSessionId) live.add(w.windowSessionId);
  }
  const dir = path.join(app.getPath('userData'), 'Partitions');
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  // Only folders that exist now: a new window's folder appears when its first browser tab
  // loads, after the window is already in the list above.
  const orphans = names.filter(
    (n) => n.startsWith(PREFIX) && !live.has(n.slice(PREFIX.length))
  );
  for (const name of orphans) {
    await fs.promises
      .rm(path.join(dir, name), { recursive: true, force: true })
      .catch((e) => console.error(`[window-session-cleanup] could not remove ${name}: ${e.message}`));
  }
  if (orphans.length) {
    console.log(`[window-session-cleanup] removed ${orphans.length} browser session(s) of closed windows`);
  }
}

// A window is closed for good unless the app is quitting (its windows are saved for restore
// first), or it is the last window on Windows or Linux, where closing it quits the app and it is
// restored on the next launch. On macOS the app outlives its last window, and Pulsar saves an
// empty restore list then, so that window is gone.
function closedForGood(atomApplication, browserWindow) {
  if (atomApplication.quitting) return false;
  const others = atomApplication
    .getAllWindows()
    .filter((w) => w.browserWindow !== browserWindow);
  return process.platform === 'darwin' || others.length > 0;
}

function cleanUpWindowSessions(getAtomApplication) {
  app.once('browser-window-created', () =>
    setImmediate(() => deleteOrphanedPartitions(getAtomApplication()))
  );

  app.on('browser-window-created', (_event, browserWindow) => {
    browserWindow.once('closed', () => {
      const atomApplication = getAtomApplication();
      if (!atomApplication) return;
      const window = atomApplication
        .getAllWindows()
        .find((w) => w.browserWindow === browserWindow);
      if (!window || window.isSpec || !window.windowSessionId) return;
      if (!closedForGood(atomApplication, browserWindow)) return;
      // The folder itself goes at the next startup; this session is still loaded in this process.
      const ses = session.fromPartition(partitionFor(window.windowSessionId));
      Promise.all([ses.clearStorageData(), ses.clearCache()]).catch((e) =>
        console.error(`[window-session-cleanup] could not clear a closed window's session: ${e.message}`)
      );
    });
  });
}

module.exports = { cleanUpWindowSessions };
