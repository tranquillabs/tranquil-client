#!/usr/bin/env node

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
const LOG_FILTERS = [
  // A Blink CSS deprecation Chromium injects into our renderer (cites one of our
  // files as source, so the "local source ⇒ keep" rule wouldn't catch it).
  /searchfield-cancel-button.*deprecated/,
];

// Decide whether a fully-assembled console record should be shown. Drops
// Electron's own injected dev warnings (source `node:electron/…`: the CSP /
// Node-integration security warnings, `vm` deprecation, …), remote-page console
// (non-local http origin — third-party cookies, a site's CORS failures, unused
// font preloads), and anything a LOG_FILTERS pattern matches. Keeps console from
// local sources (our own code, e.g. tranquil-rpc) and localhost dev servers
// (browser-sync app-template / automations).
function keepConsoleRecord(record) {
  if (LOG_FILTERS.some((re) => re.test(record))) return false;
  const source = (record.match(CONSOLE_SOURCE) || [])[1] || '';
  if (source.startsWith('node:electron')) return false;
  if (/^https?:\/\/(?!localhost|127\.0\.0\.1)/.test(source)) return false;
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
// electron-builder productName.
function patchMacAppName(electronBin) {
  if (process.platform !== 'darwin') return;
  // electronBin = .../Electron.app/Contents/MacOS/Electron → Contents/Info.plist
  const plist = path.join(path.dirname(path.dirname(electronBin)), 'Info.plist');
  const NAME = 'Tranquil';
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
      }
    } catch {
      // Key missing or PlistBuddy unavailable — skip; the app still launches.
    }
  }
}

function main() {
  const electronBin = require('electron');

  patchMacAppName(electronBin);

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
