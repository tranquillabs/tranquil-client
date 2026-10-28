// Permissions for web pages in the Tranquil browser: denied unless listed here.
//
// Electron approves every permission request (camera, microphone, location, notifications, MIDI,
// opening external apps, ...) when the app installs no handler, so each browser tab's session
// gets one. Only what a page gets from any browser without being asked is allowed. Anything more
// will need an explicit, per-site decision by the user; until that exists, it is denied.
const ALLOWED = new Set([
  'fullscreen', // the page's own fullscreen button, after a click
  'clipboard-sanitized-write', // copy buttons: writing only, after a click
  // A third-party frame asking for its own cookies, which Chrome grants without a prompt.
  // reCAPTCHA needs it: refused, it issues no token, and Greenhouse and Ashby forms fail with 428.
  'storage-access',
  'top-level-storage-access',
]);

const handled = new WeakSet();

function applyPagePermissions(session) {
  if (handled.has(session)) return;
  handled.add(session);
  session.setPermissionRequestHandler((_webContents, permission, callback) =>
    callback(ALLOWED.has(permission))
  );
  session.setPermissionCheckHandler((_webContents, permission) => ALLOWED.has(permission));
}

module.exports = { applyPagePermissions };
