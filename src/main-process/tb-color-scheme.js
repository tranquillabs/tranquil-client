// Browser color-scheme isolation
// --------------------------------
// Pulsar's theme-manager (src/theme-manager.js refreshWindowTheme) forces
// `nativeTheme.themeSource` to "dark" or "light" to match the *editor* theme so
// native chrome (menus, scrollbars) matches. But themeSource is app-global: it
// also decides the `prefers-color-scheme` reported to every web frame, including
// the Tranquil browser's <webview> guests. So with a dark editor theme, every
// website that ships a dark stylesheet renders dark — "darker than original."
//
// We can't un-force themeSource without changing editor chrome, and Electron has
// no per-webContents color-scheme flag. The one lever is the Chromium DevTools
// Protocol: attach the debugger to each guest webContents and override the
// `prefers-color-scheme` media feature.
//
// For now we pin browser guests to LIGHT — a browser's conventional default and
// the "original" appearance the sites were reported to lose. The better answer
// is to follow the real OS appearance (like a real browser), but the only clean
// API for reading the OS setting while themeSource is overridden —
// nativeTheme.shouldUseDarkColorsForSystemIntegratedUI — doesn't exist in
// Electron 30. Revisit and switch to OS-following after the Pulsar/Electron
// upgrade.
//
// The live guest tabs are the only webContents of type 'webview'. HAR capture
// (har.js) attaches its own debugger to a hidden capture *window* (type
// 'window'), never a live tab, so the two never contend for the single CDP
// client a webContents allows.

// The scheme to report to browser guests. Constant until we can read the OS
// appearance (see note above).
const GUEST_SCHEME = 'light';

// Guest webContents we currently manage (for cleanup / dedupe).
const managed = new Set();

function applyScheme(wc) {
  if (!wc || wc.isDestroyed()) return;
  const dbg = wc.debugger;
  // Detached (e.g. native DevTools is open and has claimed the CDP client) —
  // nothing to do; we re-apply on 'devtools-closed'.
  if (!dbg.isAttached()) return;
  dbg
    .sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: GUEST_SCHEME }],
    })
    .catch(() => {});
}

function attach(wc) {
  if (!wc || wc.isDestroyed()) return false;
  const dbg = wc.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
  } catch (_) {
    // Another CDP client (DevTools) holds the target — retry when it closes.
    return false;
  }
  applyScheme(wc);
  return true;
}

// Attach to a single browser-guest webContents and keep its color scheme pinned.
// Safe to call for any webContents; no-ops for non-guests and duplicates.
function manageBrowserColorScheme(wc) {
  if (!wc || typeof wc.getType !== 'function' || wc.getType() !== 'webview') return;
  if (managed.has(wc)) return;
  managed.add(wc);

  attach(wc);

  // Re-prime on each document. The attach at creation can fail (the guest's
  // renderer/CDP target isn't ready yet), so we must call attach() again — not
  // just applyScheme() — on every document so a failed initial attach is
  // retried. setEmulatedMedia survives same-document nav, but a cross-process
  // navigation can reset the override, so re-applying keeps every render
  // on-scheme.
  wc.on('dom-ready', () => attach(wc));
  wc.on('did-finish-load', () => attach(wc));

  // Native DevTools on a <webview> guest needs the single CDP client free.
  // Opening DevTools auto-detaches our debugger (Electron fires 'detach' on it);
  // when DevTools closes, reclaim the client and re-apply.
  wc.on('devtools-closed', () => attach(wc));

  wc.once('destroyed', () => managed.delete(wc));
}

module.exports = { manageBrowserColorScheme };
