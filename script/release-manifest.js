#!/usr/bin/env node
//
// Generates release-manifest.json — the reproducibility record for a Tranquil
// release. The client bundles its owned packages via `link:../<repo>` (they are
// not published to a registry), so a build ships whatever is checked out in each
// sibling repo. This manifest pins each owned package to its version + commit
// SHA at release time, so a build can be reproduced by checking out those refs.
//
// Usage:
//   node script/release-manifest.js [YYYY-MM-DD]
//
// IMPORTANT: re-run this AFTER committing the release changes in every owned
// repo (version bumps, licenses, etc.) and BEFORE tagging, so the recorded SHAs
// point at the tagged commits — not at pre-release HEADs.
//
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// The owned, bundled set = every dependency resolved from a sibling repo via
// the `link:` protocol. Deriving it from package.json keeps the manifest in
// lockstep with what actually ships.
const owned = Object.entries(pkg.dependencies || {})
  .filter(([name, spec]) => name.startsWith('tranquil-') && String(spec).startsWith('link:'))
  .map(([name, spec]) => ({ name, dir: path.resolve(root, String(spec).slice('link:'.length)) }))
  .sort((a, b) => a.name.localeCompare(b.name));

const packages = {};
for (const { name, dir } of owned) {
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  let sha = null;
  try {
    sha = execSync('git rev-parse HEAD', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // repo not a git checkout / no commits yet — leave sha null
  }
  packages[name] = { version: p.version, sha };
}

const manifest = {
  release: 'v' + pkg.version,
  date: process.argv[2] || new Date().toISOString().slice(0, 10),
  packages,
};

fs.writeFileSync(
  path.join(root, 'release-manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);
console.log(
  `Wrote release-manifest.json for ${manifest.release} (${manifest.date}) — ` +
    `${Object.keys(packages).length} owned packages`
);
