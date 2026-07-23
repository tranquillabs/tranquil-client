#!/usr/bin/env node

// Dev helper: refresh the seeded example project so edits to the
// `tranquil-examples` repo show up in the running app.
//
// The app's first-run seed (AtomApplication#seedExampleProject) is intentionally
// non-destructive — it never overwrites an existing `<ATOM_HOME>/examples`. That's
// right for users, but while iterating on the guided tutorials we need to push the
// latest content in on demand. This replicates the seed's copy exactly (same source
// and skip list), but overwrites the target.
//
//   yarn reseed-examples
//   ATOM_HOME=/tmp/tq-freshrun yarn reseed-examples   # target an isolated home
//
// After running, refresh the tree-view (or File → New Default Window) to see changes.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Same skip list as AtomApplication#seedExampleProject — keep in sync.
const SKIP = new Set([
  'package.json',
  'node_modules',
  '.git',
  '.gitignore',
  '.DS_Store'
]);

// Same source the app uses: the bundled/linked package (symlink → sibling repo in dev).
const source = path.join(__dirname, '..', 'node_modules', 'tranquil-examples');
const atomHome = process.env.ATOM_HOME || path.join(os.homedir(), '.tranquil');
const target = path.join(atomHome, 'examples');

if (!fs.existsSync(source)) {
  console.error(
    `tranquil-examples not found at ${source}\n` +
      `Clone it alongside tranquil-client and run \`yarn install\` to create the link.`
  );
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });

let count = 0;
for (const entry of fs.readdirSync(source)) {
  if (SKIP.has(entry)) continue;
  fs.cpSync(path.join(source, entry), path.join(target, entry), {
    recursive: true,
    dereference: true
  });
  count++;
}

console.log(`Reseeded ${target} from ${source} (${count} top-level entries).`);
