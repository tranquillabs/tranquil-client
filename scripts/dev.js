#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

// --- dev-console noise filtering -------------------------------------------
//
// `--enable-logging` makes Electron forward every renderer's console output AND
// Chromium's own internal logging to our stderr, each record shaped like:
//   [PID:MMDD/HHMMSS.mmm:LEVEL:TAG(line)] message[, source: <src> (line)]
// where TAG is either `CONSOLE(n)` (a renderer console.* call) or a C++ source
// such as `runtime_features.cc(730)` (Chromium internals). Almost all of it is
// noise we can't act on. Rather than matching each individual message, classify
// records by that structure and keep only what's useful — our own logs, real
// Node warnings, and plain output.

// A forwarded Chromium record always starts with `[<pid>:<timestamp>:LEVEL:`.
const RECORD_START = /^\[\d+:\d{4}\/[\d.]+:([A-Z]+):/;
// A renderer console message specifically tags `CONSOLE(line)`.
const CONSOLE_RECORD = /^\[\d+:\d{4}\/[\d.]+:[A-Z]+:CONSOLE\(\d+\)\]/;
// Terminator of a console record: Electron appends `, source: <src> (line)` as
// the final line (single- or multi-line message).
const CONSOLE_SOURCE = /, source: (\S+)/;

// Explicit content patterns to drop, tested against a fully-assembled console
// record (message + source, joined). Add narrow RegExps here for one-off
// console noise the structural rules below don't already cover.
const LOG_FILTERS = [];

// Our own log lines carry a `[tranquil-*]` tag. Matched against the whole record
// so they survive every structural rule below — including any future tightening.
const TRANQUIL_TAG = /\[tranquil[\w-]*\]/;

// Blink reports every failed subresource this way: a site's 404s and blocked
// requests, a dropped dev-server connection, a webview losing the network. The app
// embeds a full browser, so this is unbounded third-party noise by construction —
// there is no version of it we act on.
const RESOURCE_LOAD_FAILURE = /Failed to load resource:/;

// A `node_modules/` path means a dependency we don't own and can't fix (marked's
// deprecation notices via markdown-preview, xterm's WebGL timing warnings). Owned
// packages are linked from sibling repos and resolve to real paths outside
// node_modules, so they're unaffected.
const NODE_MODULES = /[\\/]node_modules[\\/]/;

// Decide whether a fully-assembled console record should be shown. This is an
// allowlist: a record has to come from code we actually maintain. In precedence
// order it drops anything a LOG_FILTERS pattern matches (the explicit escape
// hatch), keeps anything carrying our own `[tranquil-*]` tag, then drops by
// structure — resource-load failures, Electron's injected dev warnings (source
// `node:electron/…`: the CSP / Node-integration security warnings, `vm`
// deprecation), remote-page console, dependencies under `node_modules/`, and
// anything addressed by a URL scheme other than http(s). What survives is console
// from our own absolute filesystem paths and from localhost dev servers (the
// app-template / ops-demo pages).
//
// Our code always reports a bare absolute path as its source, never a scheme, so
// the last rule costs us nothing and covers every browser-internal surface at
// once: `file://` (Blink warnings attributed to the window shell rather than to a
// script — third-party cookie notices and the like), `devtools://` (DevTools'
// own internal errors), `chrome-error://`, extensions, `blob:`, `data:`.
function keepConsoleRecord(record) {
  if (LOG_FILTERS.some((re) => re.test(record))) return false;
  if (TRANQUIL_TAG.test(record)) return true;
  if (RESOURCE_LOAD_FAILURE.test(record)) return false;
  const source = (record.match(CONSOLE_SOURCE) || [])[1] || '';
  if (source.startsWith('node:electron')) return false;
  if (NODE_MODULES.test(source)) return false;
  // Adjudicate http(s) first — localhost dev servers are the one remote-ish
  // source worth keeping — then drop every other scheme wholesale.
  if (/^https?:\/\//.test(source)) {
    return !/^https?:\/\/(?!localhost|127\.0\.0\.1)/.test(source);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return false;
  return true;
}

// Pipe `readable` (a child stdout/stderr) to `out`, applying the classifier.
// Buffers partial lines across chunks, and accumulates the lines of a
// multi-line console record until its `source:` terminator so the whole record
// is judged (and kept/dropped) as a unit.
function filterStream(readable, out) {
  let buffer = '';
  let pending = null; // lines of an in-progress multi-line console record

  const flushPending = () => {
    if (!pending) return;
    const record = pending.join('\n');
    if (keepConsoleRecord(record)) out.write(record + '\n');
    pending = null;
  };

  const handleLine = (line) => {
    // Mid console record: accumulate until the `source:` terminator, then judge.
    // A new record starting first (missing terminator) flushes what we have.
    if (pending) {
      if (RECORD_START.test(line)) flushPending();
      else {
        pending.push(line);
        if (CONSOLE_SOURCE.test(line)) flushPending();
        return;
      }
    }
    if (CONSOLE_RECORD.test(line)) {
      if (CONSOLE_SOURCE.test(line)) {
        if (keepConsoleRecord(line)) out.write(line + '\n'); // single-line
      } else {
        pending = [line]; // multi-line; wait for the terminator
      }
      return;
    }
    if (RECORD_START.test(line)) {
      // Chromium internal C++ log. Drop INFO/WARNING chatter (runtime_features,
      // spdy_session, ANGLE/Metal, …); keep ERROR/FATAL — those can be real.
      const level = RECORD_START.exec(line)[1];
      if (level !== 'ERROR' && level !== 'FATAL') return;
    }
    out.write(line + '\n'); // plain line: Node warning, main-process log, etc.
  };

  readable.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // trailing element is a possibly-incomplete line
    for (const line of lines) handleLine(line);
  });
  readable.on('end', () => {
    if (buffer) handleLine(buffer);
    flushPending();
  });
}

// In dev we launch Electron's own unbranded app bundle, so on macOS the bold
// application-menu title and dock label are taken from that bundle's Info.plist
// (CFBundleName / CFBundleDisplayName), which read "Electron". app.setName() does
// NOT override this for the running process — the OS reads the plist at launch.
// So patch the bundle's plist to "Tranquil" before spawning. Idempotent and
// best-effort: any failure just leaves the default name rather than blocking the
// launch. macOS-only; packaged builds already carry the correct name via
// electron-builder productName. Returns true if it changed the plist (so the
// caller can re-register the bundle with LaunchServices).
function patchMacAppName(electronBin) {
  if (process.platform !== 'darwin') return false;
  // electronBin = .../Electron.app/Contents/MacOS/Electron → Contents/Info.plist
  const plist = path.join(path.dirname(path.dirname(electronBin)), 'Info.plist');
  const NAME = 'Tranquil';
  let changed = false;
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    try {
      const current = execFileSync(
        '/usr/libexec/PlistBuddy',
        ['-c', `Print :${key}`, plist],
        { encoding: 'utf8' }
      ).trim();
      if (current !== NAME) {
        execFileSync('/usr/libexec/PlistBuddy', [
          '-c',
          `Set :${key} ${NAME}`,
          plist,
        ]);
        changed = true;
      }
    } catch {
      // Key missing or PlistBuddy unavailable — skip; the app still launches.
    }
  }
  return changed;
}

// Same story for the dock / app-switcher icon: in dev the running bundle is the
// stock Electron.app, whose CFBundleIconFile points at Electron's default atom
// icon. There is no BrowserWindow-level override on macOS (the OS takes the app
// icon from the bundle plist, not the window), so brand it by dropping our
// tranquil.icns into the bundle's Resources and repointing CFBundleIconFile at
// it — the exact same runtime-bundle patch mechanism patchMacAppName() uses.
// macOS-only, best-effort, idempotent: any failure just leaves the default icon.
// Packaged builds carry the real icon via electron-builder, so this is dev-only.
function patchMacAppIcon(electronBin) {
  if (process.platform !== 'darwin') return false;
  try {
    // electronBin = .../Electron.app/Contents/MacOS/Electron
    const contents = path.dirname(path.dirname(electronBin));
    const appBundle = path.dirname(contents);
    const plist = path.join(contents, 'Info.plist');
    const ICON = 'tranquil'; // CFBundleIconFile value, extension-less
    const src = path.join(__dirname, '..', 'resources', 'app-icons', `${ICON}.icns`);
    const dest = path.join(contents, 'Resources', `${ICON}.icns`);
    if (!fs.existsSync(src)) return false;

    // Copy only when missing or changed, so a normal relaunch does no work and
    // doesn't needlessly bump the bundle mtime.
    let iconChanged = true;
    if (fs.existsSync(dest)) {
      iconChanged = !fs.readFileSync(src).equals(fs.readFileSync(dest));
    }
    if (iconChanged) fs.copyFileSync(src, dest);

    // Point the bundle at our icon. Set if the key exists, otherwise Add it.
    let plistChanged = false;
    let current = null;
    try {
      current = execFileSync(
        '/usr/libexec/PlistBuddy',
        ['-c', 'Print :CFBundleIconFile', plist],
        { encoding: 'utf8' }
      ).trim();
    } catch {
      current = null; // key absent
    }
    if (current === null) {
      execFileSync('/usr/libexec/PlistBuddy', [
        '-c',
        `Add :CFBundleIconFile string ${ICON}`,
        plist,
      ]);
      plistChanged = true;
    } else if (current !== ICON) {
      execFileSync('/usr/libexec/PlistBuddy', [
        '-c',
        `Set :CFBundleIconFile ${ICON}`,
        plist,
      ]);
      plistChanged = true;
    }

    // macOS's icon-services cache is keyed on the bundle's mtime; bump it so a
    // freshly-patched bundle shows the new icon instead of a stale cached one.
    // (If the Dock still shows the old icon, `killall Dock` forces a refresh.)
    const changed = iconChanged || plistChanged;
    if (changed) {
      const now = new Date();
      try { fs.utimesSync(appBundle, now, now); } catch {}
    }
    return changed;
  } catch {
    // Anything unexpected (PlistBuddy missing, permissions) — skip; the app
    // still launches with the default icon.
    return false;
  }
}

// After patching the bundle's plist (name and/or icon), the Dock's hover
// tooltip can still show the OLD name because LaunchServices caches the app's
// display name in its own database, keyed independently of the icon cache. Force
// LaunchServices to re-read the bundle so the next launch's dock tile reflects
// the patched CFBundleName. Best-effort and macOS-only; only worth doing when a
// patch actually changed the bundle. `lsregister` lives at a fixed path inside
// the (private) LaunchServices framework.
function reregisterMacBundle(electronBin) {
  if (process.platform !== 'darwin') return;
  const appBundle = path.dirname(path.dirname(path.dirname(electronBin)));
  const lsregister =
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/' +
    'LaunchServices.framework/Support/lsregister';
  try {
    execFileSync(lsregister, ['-f', appBundle]);
  } catch {
    // lsregister missing/moved or the call failed — skip; the app still
    // launches, the dock tooltip just keeps its stale cached name.
  }
}

function main() {
  const electronBin = require('electron');

  const nameChanged = patchMacAppName(electronBin);
  const iconChanged = patchMacAppIcon(electronBin);
  // Only re-register when we actually touched the bundle — LaunchServices
  // otherwise keeps a stale "Electron" tooltip on the dock tile.
  if (nameChanged || iconChanged) reregisterMacBundle(electronBin);

  const childEnv = { ...process.env };
  // An agent/IDE shell (e.g. the VSCode extension host) may export
  // ELECTRON_RUN_AS_NODE=1. Inherited by the spawn below it makes the Electron
  // binary run as a plain Node interpreter, which then rejects the Chromium
  // flags ("bad option: --no-sandbox") and exits instead of opening a window.
  // Deleting it is a no-op in a normal terminal where it isn't set.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  childEnv.NODE_PATH = path.join(__dirname, '..', 'node_modules');
  childEnv.ATOM_RESOURCE_PATH = path.join(__dirname, '..');

  // Forward any extra CLI args to Electron, e.g.
  //   yarn start --user-data-dir=/tmp/tranquil-verify /path/to/test-project
  // launches an isolated, disposable instance (own window-state + single-instance
  // lock) opening an isolated *test-only* project, so the running app never
  // operates on the real tranquil-client working tree.
  //
  // Electron consumes the FIRST positional as the app directory, so `.` (this
  // app) must always come first. A caller-supplied project path is passed AFTER
  // it, where the app's own command-line parser turns it into a project to open.
  // Split forwarded args accordingly; pass flags in `--flag=value` form so a
  // value is never mistaken for a path.
  const extraArgs = process.argv.slice(2);
  const flagArgs = extraArgs.filter((arg) => arg.startsWith('-'));
  const pathArgs = extraArgs.filter((arg) => !arg.startsWith('-'));

  const electronProcess = spawn(
    electronBin,
    ['--no-sandbox', '--enable-logging', ...flagArgs, '.', ...pathArgs, '-f'],
    {
      cwd: path.join(__dirname, '..'),
      // stdin inherited; stdout/stderr piped so filterStream can drop noise
      // lines (LOG_FILTERS) before re-emitting to our own stdout/stderr.
      stdio: ['inherit', 'pipe', 'pipe'],
      env: childEnv,
    }
  );

  filterStream(electronProcess.stdout, process.stdout);
  filterStream(electronProcess.stderr, process.stderr);

  // Forward termination to the Electron child. Without this, a SIGTERM to this
  // wrapper (e.g. stopping a backgrounded launch) exits Node but ORPHANS the
  // Electron GUI, which then has to be hunted down with a broad `pkill`. Killing
  // the child makes stopping the launcher cleanly tear down the whole app.
  let terminating = false;
  function terminate() {
    if (terminating) return;
    terminating = true;
    if (electronProcess.exitCode === null && !electronProcess.killed) {
      electronProcess.kill();
    }
  }

  // When Electron exits (on its own, or because terminate() killed it), exit the
  // wrapper with the same code so the process tree fully unwinds.
  electronProcess.on('close', (code) => process.exit(code == null ? 0 : code));
  process.on('SIGINT', terminate);
  process.on('SIGTERM', terminate);
}

main();
