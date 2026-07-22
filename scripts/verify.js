#!/usr/bin/env node

// Launch a FULLY ISOLATED Tranquil instance for GUI verification and hold it open.
//
// Isolates three things so the running app never pollutes your real environment
// or operates on real source:
//   1. --user-data-dir=<tmp>  → own window-state + single-instance lock
//   2. ATOM_HOME=<tmp>        → own config/session (seeded from ~/.tranquil so the
//                               theme + packages still match; NEVER touches your
//                               real ~/.tranquil window layout)
//   3. opens tranquil-test-suite as the project, then normalizes project roots to
//      drop the tranquil-client app-dir root that Electron/Atom always adds.
//
// Then it connects over CDP (localhost:9222), applies the root normalization, prints
// status, and stays running so you can drive/inspect the app. Stop it (Ctrl-C, or
// stop the backgrounded task) and it tears the whole app down cleanly — no orphan.
//
// Usage:
//   node scripts/verify.js [projectPath]
// projectPath defaults to ../tranquil-test-suite (sibling repo).

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const CDP_PORT = 9222;
const REPO_ROOT = path.join(__dirname, '..');
const REAL_ATOM_HOME =
  process.env.REAL_ATOM_HOME || path.join(os.homedir(), '.tranquil');
const PROJECT_PATH = path.resolve(
  process.argv[2] || path.join(REPO_ROOT, '..', 'tranquil-test-suite')
);
const VERIFY_UDD = path.join(os.tmpdir(), 'tranquil-verify');
const VERIFY_HOME = path.join(os.tmpdir(), 'tranquil-verify-home');

function log(msg) {
  process.stdout.write(`[verify] ${msg}\n`);
}

// Seed a throwaway ATOM_HOME: copy config (theme/settings) and symlink dev +
// community packages, but leave `storage/` empty so no session is restored.
function seedAtomHome() {
  fs.rmSync(VERIFY_HOME, { recursive: true, force: true });
  fs.mkdirSync(VERIFY_HOME, { recursive: true });

  const realConfig = path.join(REAL_ATOM_HOME, 'config.cson');
  if (fs.existsSync(realConfig)) {
    fs.copyFileSync(realConfig, path.join(VERIFY_HOME, 'config.cson'));
  }
  for (const name of ['dev', 'packages']) {
    const target = path.join(REAL_ATOM_HOME, name);
    if (fs.existsSync(target)) {
      fs.symlinkSync(target, path.join(VERIFY_HOME, name));
    }
  }
}

function cdpVersionUrl() {
  return `http://localhost:${CDP_PORT}/json/version`;
}

async function waitForCdp(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(cdpVersionUrl());
      if (res.ok) return await res.json();
    } catch (_) {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`CDP did not come up on :${CDP_PORT} within ${timeoutMs}ms`);
}

// Find the editor window (a page with the `atom` global) and read its state. The
// TRANQUIL_VERIFY-gated filter in atom-application drops the tranquil-client
// resource-path root before any window opens, so roots should already be exactly
// [PROJECT_PATH] with no flash — this only reads and reports.
async function readStatus() {
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.connect({
    browserURL: `http://localhost:${CDP_PORT}`,
  });
  try {
    let last = null;
    // Retry: the window may still be booting (and its project still settling)
    // when CDP first responds. Prefer a reading where the project has loaded.
    for (let attempt = 0; attempt < 40; attempt++) {
      for (const page of await browser.pages()) {
        let hasAtom = false;
        try {
          hasAtom = await page.evaluate(
            () => typeof atom !== 'undefined' && !!atom.project
          );
        } catch (_) {
          continue; // page navigated / not evaluable
        }
        if (!hasAtom) continue;

        last = await page.evaluate(() => ({
          roots: atom.project.getPaths(),
          theme: atom.config.get('core.themes'),
          version: atom.getVersion(),
        }));
        if (last.roots.length > 0) return last;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (last) return last;
    throw new Error('no editor window with an `atom` global appeared');
  } finally {
    await browser.disconnect();
  }
}

function spawnIsolatedApp() {
  const electronBin = require('electron');

  const childEnv = { ...process.env };
  // The VSCode extension host exports this; inherited it makes Electron run as
  // Node and reject the Chromium flags. See scripts/dev.js.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  childEnv.NODE_PATH = path.join(REPO_ROOT, 'node_modules');
  childEnv.ATOM_RESOURCE_PATH = REPO_ROOT;
  childEnv.ATOM_HOME = VERIFY_HOME;
  // Tells atom-application.openPaths to drop the resource-path (tranquil-client)
  // root, so only the test project opens — no flash of the app's own source.
  childEnv.TRANQUIL_VERIFY = '1';

  // `.` (this app) must be the first positional (Electron's app dir); the project
  // path goes after it, where Atom's parser turns it into a project to open.
  return spawn(
    electronBin,
    [
      '--no-sandbox',
      '--enable-logging',
      `--user-data-dir=${VERIFY_UDD}`,
      '.',
      PROJECT_PATH,
      '-f',
    ],
    { cwd: REPO_ROOT, stdio: 'inherit', env: childEnv }
  );
}

async function main() {
  if (!fs.existsSync(PROJECT_PATH)) {
    log(`ERROR: project path does not exist: ${PROJECT_PATH}`);
    process.exit(1);
  }

  log(`project     : ${PROJECT_PATH}`);
  log(`ATOM_HOME   : ${VERIFY_HOME} (throwaway, seeded from ${REAL_ATOM_HOME})`);
  log(`user-data   : ${VERIFY_UDD} (throwaway)`);

  seedAtomHome();
  fs.rmSync(VERIFY_UDD, { recursive: true, force: true });

  const app = spawnIsolatedApp();

  // Forward termination to the Electron child so stopping this script tears the
  // whole app down (no orphaned GUI).
  let terminating = false;
  function terminate() {
    if (terminating) return;
    terminating = true;
    if (app.exitCode === null && !app.killed) app.kill();
  }
  process.on('SIGINT', terminate);
  process.on('SIGTERM', terminate);
  app.on('close', (code) => process.exit(code == null ? 0 : code));

  try {
    const cdp = await waitForCdp();
    log(`CDP live    : http://localhost:${CDP_PORT}  (${cdp.Browser})`);
    const info = await readStatus();
    log(`version     : ${info.version}`);
    log(`theme       : ${JSON.stringify(info.theme)}`);
    log(`roots       : ${JSON.stringify(info.roots)}`);
    if (info.roots.some((r) => path.normalize(r) === path.normalize(REPO_ROOT))) {
      log('WARNING: tranquil-client is a project root — TRANQUIL_VERIFY filter did not apply.');
    }
    log('ready — drive via CDP; stop this task to tear down.');
  } catch (err) {
    log(`ERROR: ${err.message}`);
    terminate();
  }
}

main();
