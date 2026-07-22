#!/usr/bin/env node

const path = require('path');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

function main() {
  const electronBin = require('electron');

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
