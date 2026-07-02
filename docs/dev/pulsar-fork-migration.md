# Plan: Tranquil ← Pulsar v1.132.1 Fork Migration (tranquil-client)

## Context

The app (Electron 12.2.3, version 2.3.3, currently called "Hub") needs to migrate to Pulsar v1.132.1 (Electron 30.5.1) and be rebranded as "Tranquil" — an 18-major-version Electron jump. A rebase would produce thousands of conflicts; a fresh fork is the right approach.

**Completed prereqs:**
- Phase 0 ✓ — `.url` opener moved to tranquil-browser (`fca12e4`)
- Phase 2 (tranquil-browser modernization: remove atom-space-pen-views/jQuery) — per user, done

**Important:** `git log` on tranquil/main shows the Phase 2 changes are not yet committed there. If there are uncommitted local changes, commit them to tranquil/main before Step 3 (package copy).

**New fork name:** `tranquil-client`
**Local path:** `/Users/david/Documents/Tranquil/Repos/tranquil-client`
**Upstream reference:** existing Pulsar clone stays at `/Users/david/Documents/Tranquil/Repos/pulsar` (untouched)

---

## Step 1 — Create both GitHub repos under tranquillabs

Two repos need to exist at `https://github.com/tranquillabs`:

| Repo | Purpose | How to create |
|------|---------|--------------|
| `tranquillabs/pulsar` | Upstream reference (tracks `pulsar-edit/pulsar`) | Fork `pulsar-edit/pulsar` on GitHub → tranquillabs |
| `tranquillabs/tranquil-client` | The Hub editor fork | Fork `tranquillabs/pulsar` on GitHub → tranquillabs (rename to `tranquil-client`) |

**Local setup after creating both GitHub repos:**

```bash
# 1. Update the existing local Pulsar clone to point to tranquillabs/pulsar
cd /Users/david/Documents/Tranquil/Repos/pulsar
git remote set-url origin git@github.com:tranquillabs/pulsar.git

# 2. Clone tranquil-client locally
git clone git@github.com:tranquillabs/tranquil-client.git \
          /Users/david/Documents/Tranquil/Repos/tranquil-client
cd /Users/david/Documents/Tranquil/Repos/tranquil-client

# 3. Add tranquillabs/pulsar as upstream (for syncing new Pulsar releases)
git remote add upstream git@github.com:tranquillabs/pulsar.git

# 4. Check out the target release tag and create the tranquil/main branch
git fetch upstream --tags
git checkout v1.132.1 -b tranquil/main
git push -u origin tranquil/main
```

`/Repos/pulsar` (now pointing to `tranquillabs/pulsar`) remains the upstream reference. `tranquil-client` is where all Hub development happens.

---

## Step 2 — Update branding (`package.json`)

In the new fork's root `package.json`:

| Field | Current (Pulsar) | New (Tranquil) |
|-------|-----------------|----------------|
| `name` | `"pulsar"` | `"tranquil"` |
| `productName` | `"Pulsar"` | `"Tranquil"` |
| `version` | `"1.132.1"` | `"2.4.0"` |
| `description` | Pulsar description | `"Automate your work"` |

Also check `build.appId` and `build.productName` in the same file — update to Tranquil equivalents.

No `product.json` exists in Pulsar — all branding is in `package.json`.

---

## Step 3 — Port custom packages

**Prerequisite:** Confirm Phase 2 changes are committed in tranquil/main before copying `tranquil-browser`.

Copy each package from `hub/packages/` → new fork's `packages/`:

| Package | Notes |
|---------|-------|
| `apm-automations/` | Copy as-is — pure JS, no deprecated APIs |
| `tranquil-browser/` | Copy Phase 2 version (no atom-space-pen-views/jQuery) |
| `apm-hub-theme-dark/` | CSS theme, copy directly |
| `apm-hub-theme-light/` | CSS theme, copy directly |
| `config/` | Secrets injection module, copy directly |

**Deferred:** `pulsar-updater` — built for old Atom update infra; skip for now, revisit when Hub has a release pipeline.

**Register in root `package.json`** under `packageDependencies` (same pattern Pulsar uses for all its built-in packages):

```json
"apm-automations": "file:packages/apm-automations",
"tranquil-browser": "file:packages/tranquil-browser",
"apm-hub-theme-dark": "file:packages/apm-hub-theme-dark",
"apm-hub-theme-light": "file:packages/apm-hub-theme-light",
"config": "file:packages/config"
```

---

## Step 4 — Port `cz-init.js` (hub main-process customizations)

`cz-init.js` is the hub-specific main-process file that wires IPC for login, sessions, context menus, tab routing, and zoom. It exists only in hub, not in Pulsar.

1. Copy `src/main-process/cz-init.js` from hub into the new fork's `src/main-process/`
2. In new fork's `src/main-process/start.js`, add at the end of the require block:
   ```js
   require('./cz-init.js');
   ```
   (Same pattern as hub's `start.js`.)

---

## Step 5 — Set default Tranquil themes

In `src/config-schema.js`, find the default `core.themes` value and change it to:
```js
['apm-hub-theme-dark', 'one-dark-syntax']
```
This ensures new users get Tranquil branding on first launch rather than default Pulsar themes.

---

## Step 6 — Install and rebuild native modules

```bash
yarn install
yarn build   # runs electron-rebuild against Electron 30
```

If native module build fails (likely for anything using N-API), run:
```bash
./node_modules/.bin/electron-rebuild -v 30.5.1
```

---

## Verification

**Launch:**
```bash
# Must run from a user terminal (not Claude Code subprocess — Electron won't start otherwise):
cd /Users/david/Documents/Tranquil/Repos/tranquil-client   # on tranquil/main branch
yarn start
```

**Checklist:**
1. Tranquil window opens with Tranquil themes (not default Pulsar theme)
2. In DevTools console: `atom.packages.isPackageActive('apm-automations')` → `true`
3. In DevTools console: `atom.packages.isPackageActive('tranquil-browser')` → `true`
4. Login modal appears and routes to correct URL (dev/staging/prod per `atom.inDevMode()`)
5. Click a `.url` file in tree-view → browser panel opens with the URL
6. Browser toolbar: back, forward, refresh, URL bar all work
7. Cmd+F (find-in-page) works in browser panel
8. Favorites panel opens (Cmd+B or toolbar button)
9. "Open in default browser" works (exercises `shell.openExternal`)
10. Tabs survive window reload (serialization)

**IPC sanity check** (in DevTools console):
```js
// Login IPC
const { ipcRenderer } = require('electron')
ipcRenderer.send('show-login-screen', {})  // modal should appear
```

---

## Step 8 — Save plan and work summary as repo documentation

After all verification passes, commit this plan and a brief implementation summary into `tranquil-client` as developer docs:

```bash
mkdir -p /Users/david/Documents/Tranquil/Repos/tranquil-client/docs/dev
# Copy this plan file:
cp /Users/david/.claude/plans/with-phase-2-done-crispy-lovelace.md \
   /Users/david/Documents/Tranquil/Repos/tranquil-client/docs/dev/pulsar-fork-migration.md
```

Also create `docs/dev/tranquil-client-overview.md` capturing:
- What Tranquil is (Pulsar fork + Tranquil packages)
- The 5 custom packages and their purpose
- How to run locally (yarn start, dev mode)
- How to sync with upstream Pulsar (see sync strategy below)
- Where to find the Claude plans that preceded this repo

Commit as: `docs: add fork migration plan and developer overview`

---

## Ongoing sync strategy

### The commit stack

Keep Tranquil-specific changes as a small, clean commit stack on top of a Pulsar release tag — never squash them into one blob:

```
[Pulsar v1.132.1 base]
  ↑ chore: Tranquil branding (package.json)    ← touches package.json only
  ↑ feat: add cz-init.js to main process      ← touches start.js + adds cz-init.js
  ↑ feat: add Tranquil themes + set defaults   ← touches src/config-schema.js + adds 2 packages
  ↑ feat: add apm-automations                 ← adds packages/apm-automations/ only
  ↑ feat: add tranquil-browser                ← adds packages/tranquil-browser/ only
  ↑ feat: add config package                  ← adds packages/config/ only
```

Keeping commits small and single-purpose means each rebase conflict is isolated to the files that commit actually touched.

### What conflicts during a rebase sync

Our delta is **orthogonal** to Pulsar's changes — we touch very few files that Pulsar also modifies:

| File | Our change | Pulsar changes it? | Conflict frequency |
|------|-----------|-------------------|-------------------|
| `package.json` | branding + added packageDependencies | Yes (every release — deps, version) | **Every sync** — easy: keep our branding, accept their new packageDeps |
| `src/main-process/start.js` | one `require('./cz-init.js')` line | Rarely | Infrequent, trivial |
| `src/config-schema.js` | default themes | Rarely | Infrequent, trivial |
| `packages/apm-automations/` | new directory | Never — Pulsar has no such package | No conflict ever |
| `packages/tranquil-browser/` | new directory | Never | No conflict ever |
| `src/main-process/cz-init.js` | new file | Never | No conflict ever |

In practice: **one predictable conflict per sync** (`package.json`), and occasionally a trivial one in `start.js` or `config-schema.js`.

### Sync procedure (monthly)

```bash
cd /Users/david/Documents/Tranquil/Repos/tranquil-client

# 1. Pull the new Pulsar release tag
git fetch upstream --tags

# 2. Rebase our stack onto the new tag
git rebase v1.133.0

# 3. Resolve the package.json conflict: keep our name/productName/version,
#    accept Pulsar's updated deps and packageDependencies (add our file: entries back if lost)
git add package.json && git rebase --continue

# 4. If start.js or config-schema.js conflict: trivial — keep our added line/value
#    alongside whatever Pulsar changed

# 5. Run install + rebuild
yarn install && yarn build
```

### Using git rerere to automate repeated conflicts

Since `package.json` conflicts the same way every month, enable rerere to record the resolution once and replay it automatically:

```bash
git config rerere.enabled true   # run once in tranquil-client
```

After resolving the first sync's `package.json` conflict, git records it. Future syncs with the same conflict pattern resolve automatically.

### Watching for breaking Pulsar changes

Before each sync, skim the Pulsar release notes / changelog for:
- Electron version bumps (may require `yarn build` / native module rebuild)
- Removals from the `atom` API surface that `apm-automations` or `tranquil-browser` use
- Changes to `src/main-process/start.js` or `atom-application.js` that might conflict with `cz-init.js` IPC setup

Pulsar releases roughly monthly; this review takes ~5 minutes.
