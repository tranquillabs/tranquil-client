# Tranquil Client — Claude Guidelines

## Node Version

Always run `source ~/.nvm/nvm.sh && nvm use` before running any `node`, `yarn`, `npm`, or `pnpm` commands. The correct version is defined in `.nvmrc` (currently 20.16.0). Skipping this causes silent failures or corepack errors on the system default Node.

## Git Commits

Never add Claude as a co-author on commits. Do not include `Co-Authored-By: Claude` or any similar AI attribution in commit messages.

## Branch Strategy

- `tranquil/main` — the active development branch. All work goes here.
- `master` — tracks `upstream/master` (Pulsar). Do not commit or merge directly to `master`. Changes reach `master` only via an intentional `git merge --allow-unrelated-histories tranquil/main` when ready to integrate upstream.

## Reference Docs

- [Pulsar documentation](https://docs.pulsar-edit.dev/)

When solving a problem, check how Pulsar handles it first. Prefer the upstream approach over inventing something new. The Pulsar repo is at `/Users/david/Documents/Tranquil/Repos/pulsar`.

## Project Overview

Tranquil is an Electron-based desktop app forked from Pulsar (which is itself a fork of Atom). Most of `packages/` and `src/` is upstream Pulsar code. A small set of packages are Tranquil-owned and actively developed.

## Owned Packages

Tranquil's own packages live in separate repos, cloned as siblings of `tranquil-client`:

| npm name | Repo | Local dir |
| --- | --- | --- |
| `tranquil-automations` | `tranquillabs/tranquil-automations` | `../tranquil-automations` |
| `tranquil-browser` | `tranquillabs/tranquil-browser` | `../tranquil-browser` |
| `tranquil-config` | `tranquillabs/tranquil-config` | `../tranquil-config` |
| `tranquil-theme-dark` | `tranquillabs/tranquil-theme-dark` | `../tranquil-theme-dark` |
| `tranquil-theme-light` | `tranquillabs/tranquil-theme-light` | `../tranquil-theme-light` |

Everything in `packages/` is forked Pulsar. Avoid modifying it.

## Third-Party Package Rule

**Never modify packages we don't own.** This includes all Pulsar core packages (`tabs`, `tree-view`, `settings-view`, etc.) and anything in `node_modules/` that isn't a symlink to an owned repo.

If a fix requires changing behavior in a third-party package, implement it in an owned package instead — either by implementing the expected interface on our models (e.g. `terminatePendingState()` on `HTMLEditor`) or by creating a new package.

## Package Dependency Pattern

Owned packages are linked via `link:../` in `package.json` so changes in sibling directories are live without `yarn install`. Example:

- `"tranquil-automations": "link:../tranquil-automations"`
- `"tranquil-browser": "link:../tranquil-browser"`
- `"tranquil-config": "link:../tranquil-config"`
- `"tranquil-theme-dark": "link:../tranquil-theme-dark"`
- `"tranquil-theme-light": "link:../tranquil-theme-light"`

## Dev Setup (First Time)

Clone all owned repos alongside `tranquil-client` in the same parent directory:

```sh
cd /Users/david/Documents/Tranquil/Repos
git clone https://github.com/tranquillabs/tranquil-automations.git
git clone https://github.com/tranquillabs/tranquil-browser.git
git clone https://github.com/tranquillabs/tranquil-config.git
git clone https://github.com/tranquillabs/tranquil-theme-dark.git
git clone https://github.com/tranquillabs/tranquil-theme-light.git
cd tranquil-client
source ~/.nvm/nvm.sh && nvm use
yarn install
git submodule update --init ppm
cd ppm && yarn install && cd ..
```

## Dev Startup

`yarn start` runs `scripts/dev.js` which:
1. Finds a free port
2. Starts pms-accounts (Vite/SvelteKit) via `node <pms-accounts>/node_modules/vite/bin/vite.js`
3. Polls until pms-accounts is ready
4. Spawns Electron with `PMS_ACCOUNTS_PORT` set

pms-accounts path is configured via `.env` (see `.env-example`). Node version is managed by `.nvmrc` — always run `nvm use` before `yarn` commands.

## IPC Architecture

- pms-accounts webview preload → `contextBridge.exposeInMainWorld` → `ipcRenderer.send` → ipcMain
- `src/main-process/cz-init.js` forwards IPC events from ipcMain to all renderer windows via `BrowserWindow.getAllWindows().forEach(win => win.webContents.send(...))`
- Renderer (`apm-automations`) listens on `ipcRenderer` for events forwarded from cz-init

## Silent Crash Pattern

If an IPC handler or feature silently does nothing, check for missing `require()`s at the top of the file — a MODULE_NOT_FOUND error at module load time crashes the entire file without any obvious error. Check that all dependencies in `cz-init.js` and other main-process files are actually installed.

## ppm

`ppm` is a git submodule (`pulsar-edit/ppm`). After cloning, initialize and build it once:

```sh
git submodule update --init ppm
cd ppm && yarn install
```

This populates `ppm/bin/ppm`, which `settings-view` uses to list installed packages. Tranquil does not use ppm to install or manage packages.
