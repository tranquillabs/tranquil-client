#!/usr/bin/env node

const path = require('path');
const { spawn, execFileSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

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
      stdio: 'inherit',
      env: childEnv,
    }
  );

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
