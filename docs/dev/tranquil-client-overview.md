# Tranquil Client — Developer Overview

## What is Tranquil?

Tranquil is a fork of [Pulsar](https://pulsar-edit.dev/) (Electron 30, Node 20) with five custom packages that power Tranquil's workflow automation tooling. The fork was created at Pulsar v1.132.1 in June 2026.

**GitHub repos:**
- `tranquillabs/tranquil-client` — this repo (Tranquil development)
- `tranquillabs/pulsar` — upstream fork of `pulsar-edit/pulsar` (sync reference)
- `tranquillabs/tranquil-automations` — login/session automation package
- `tranquillabs/tranquil-browser` — embedded browser package
- `tranquillabs/tranquil-config` — secrets/config package

---

## Custom Packages

Owned packages live in their own repos, cloned as siblings of `tranquil-client`, and linked via `link:../` in `package.json`. They are registered as `packageDependencies` and bundled into the app — not user-installed.

| Package | Repo | Purpose |
| --- | --- | --- |
| `tranquil-automations` | `tranquillabs/tranquil-automations` | Browser-webview automation (runs JS scripts against tabs via Puppeteer/CDP), business-theme mockups + custom pane controls, tree-view folder-count badges |
| `tranquil-browser` | `tranquillabs/tranquil-browser` | Embedded browser panel: tab management, `.url` file handling, URL bar, favourites, find-in-page |
| `tranquil-config` | `tranquillabs/tranquil-config` | Secrets injection — provides `posthog_key` and `github_token` |

**Hub main-process customisation:** `src/main-process/cz-init.js` — wires IPC for session management, context menus, tab routing, and zoom. Required by `src/main-process/start.js`.

---

## Running Locally

```bash
# 1. Install dependencies
yarn install

# 2. Rebuild native modules against Electron 30
yarn build

# 3. Launch Tranquil (must run from a user terminal — Electron can't start from a subprocess)
cd /Users/david/Documents/Tranquil/Repos/tranquil-client
yarn start                        # prod mode
yarn start -- -d                  # dev mode
```

Dev mode (`-d` flag) sets `atom.inDevMode() === true`.

---

## IPC Architecture

The active IPC path is **renderer ↔ Electron main**: owned renderer packages talk to the main process via `ipcRenderer`/`ipcMain`, and `src/main-process/cz-init.js` forwards events to all windows (`BrowserWindow.getAllWindows().forEach(...)`). Live traffic includes `uri-message` (deep links → `tranquil-automations`), tab focus, zoom, and context-menu actions.

`cz-init.js` also defines dormant session handlers — `logout-session`, `show-login-screen`, `hide-login-screen`, `electron-signed-in-email` — left over from an earlier login flow. No renderer currently listens for them; there is no login/logout UI wired up today.

See `../tranquil-automations/lib/tranquil-automations.js` and `src/main-process/cz-init.js` for details.

---

## Syncing with Upstream Pulsar

Tranquil tracks Pulsar releases via a clean commit stack on top of release tags. Pulsar releases roughly monthly.

```bash
# Fetch the new Pulsar release tag
git fetch upstream --tags

# Rebase our stack onto it
git rebase v1.133.0

# Resolve the one predictable conflict: package.json
# → keep our name/productName/version/description/branding
# → accept Pulsar's updated dependencies and packageDependencies
# → re-add our five link: entries to packageDependencies if they were lost
git add package.json && git rebase --continue

# Rebuild native modules for the new Electron version (if it changed)
yarn install && yarn build
```

Enable `git rerere` once to auto-resolve the recurring `package.json` conflict:
```bash
git config rerere.enabled true
```

**Before each sync:** skim the Pulsar changelog for Electron version bumps or `atom` API removals that could affect `tranquil-automations` or `tranquil-browser`.

### The commit stack

```
[Pulsar vX.Y.Z base]
  ↑ chore: Tranquil branding (package.json)
  ↑ feat: add cz-init.js to main process
  ↑ feat: add Tranquil themes + set defaults
  ↑ feat: add tranquil-automations
  ↑ feat: add tranquil-browser
  ↑ feat: add config package
```

---

## Prior Planning Documents

The Claude planning sessions that preceded this repo are saved in:
- `/Users/david/.claude/plans/` — all session plans
- `docs/dev/pulsar-fork-migration.md` — the fork migration plan (this session)

Key prior plans:
- `i-want-to-implement-greedy-abelson.md` — Phase 0: `.url` file opener
- `let-s-do-a-more-mossy-moore.md` — Phase 2: tranquil-browser modernisation (remove atom-space-pen-views/jQuery)
- `i-noticed-that-vs-dynamic-duckling.md` — overall upgrade strategy
- `with-phase-2-done-crispy-lovelace.md` — this fork migration (Phase 3+)
