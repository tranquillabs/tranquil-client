// Freeze diagnostics for the main process.
//
// When the app locks up there is currently nothing in the logs to look at afterwards. The two
// failure modes need different detectors, and only one of them is covered by Electron:
//
//   - A blocked RENDERER. Electron already notices this and emits 'unresponsive' on the window,
//     but the only handler (atom-window.js) opens a dialog and records nothing, and Chromium
//     doesn't consider a renderer hung until ~30s of unacknowledged input — so a shorter stall
//     passes in silence. We log the event and how long it lasted.
//   - A blocked MAIN PROCESS. This freezes every window at once, and nothing detects it: the
//     process that would have to notice is the one that's stuck. The event-loop lag check below
//     is the only thing that catches it. It reports *after* the stall clears, which is exactly
//     why it survives to be read.
//
// Everything here is passive — a timer and some event listeners. It reports; it does not
// intervene. Lines are tagged `[tranquil]` so scripts/dev.js keeps them unconditionally.
const TAG = '[tranquil]';

// How often to check, and how much drift counts as a stall. Normal jitter is single-digit ms
// and a bad GC pause is a couple hundred, so a full second of drift means something blocked.
const TICK_MS = 1000;
const MAIN_STALL_MS = 1000;

const ts = (ms) => new Date(ms).toISOString();

function startStallWatchdog({ app, BrowserWindow, powerMonitor }) {
  // --- main-process event-loop lag ---------------------------------------------------------
  //
  // Suspending the machine stops the loop for as long as it sleeps, which is not a stall — so
  // the timer is rebased on resume and the first tick after it is skipped rather than reported.
  let expected = Date.now() + TICK_MS;
  let skipNextTick = false;

  const timer = setInterval(() => {
    const now = Date.now();
    const drift = now - expected;
    expected = now + TICK_MS;
    if (skipNextTick) {
      skipNextTick = false;
      return;
    }
    if (drift >= MAIN_STALL_MS) {
      console.log(`${TAG} main-process stall: ${drift}ms, ended ${ts(now)}`);
    }
  }, TICK_MS);
  // Never hold the process open on account of diagnostics.
  if (typeof timer.unref === 'function') timer.unref();

  // --- per-window renderer hangs -----------------------------------------------------------
  //
  // Additive: atom-window.js keeps its own 'unresponsive' handler and its dialog. This only
  // records that it happened, to which window, and for how long.
  app.on('browser-window-created', (_event, win) => {
    let stalledAt = null;
    const name = () => {
      try {
        return win.getTitle();
      } catch (e) {
        return 'unknown window';
      }
    };
    win.on('unresponsive', () => {
      stalledAt = Date.now();
      console.log(`${TAG} renderer unresponsive: "${name()}" at ${ts(stalledAt)}`);
    });
    win.on('responsive', () => {
      const held = stalledAt == null ? null : Date.now() - stalledAt;
      console.log(
        `${TAG} renderer responsive again: "${name()}"` +
          (held == null ? '' : ` after ${held}ms`)
      );
      stalledAt = null;
    });
  });

  // --- sleep / wake ------------------------------------------------------------------------
  //
  // Two lines that make a stall report self-explanatory: without them, telling "the app hung"
  // from "the laptop was closed" means going to `pmset -g log` after the fact and lining up
  // timestamps by hand. powerMonitor is only usable once the app is ready.
  app.whenReady().then(() => {
    try {
      powerMonitor.on('suspend', () => console.log(`${TAG} system suspend at ${ts(Date.now())}`));
      powerMonitor.on('resume', () => {
        // Rebase the lag timer: the loop was stopped for the duration of the sleep, and that
        // gap is not a stall.
        expected = Date.now() + TICK_MS;
        skipNextTick = true;
        console.log(`${TAG} system resume at ${ts(Date.now())}`);
      });
    } catch (e) {
      // powerMonitor is unavailable on some platforms/headless runs. The lag check still works;
      // it just can't tell a sleep from a stall, so leave it reporting either way.
      console.log(`${TAG} powerMonitor unavailable, sleep/wake will not be logged:`, e.message);
    }
  });
}

module.exports = { startStallWatchdog };
