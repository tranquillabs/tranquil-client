// Publishes the user guides (ADR-0029). A user guide is a file in tranquil-llm's users/ folder,
// written for a Tranquil user's LLM, for example the rules for writing an automation. The app
// carries that folder and copies it to ~/.tranquil/llm/ on every start, so the copies always match
// the installed app. Automations point LLMs there by path: their first line names
// ~/.tranquil/llm/writing-automations.md.
//
// Every user guide opens with the same header line (tranquil-llm's tests require it), and that line
// marks the copies too: a file in the folder that opens with it and is no longer a user guide in
// the app is removed. Any other file in the folder is left alone.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/** @param {string} text */
const firstLine = (text) => text.split('\n', 1)[0];

function tranquilHome() {
  return process.env.ATOM_HOME || path.join(app.getPath('home'), '.tranquil');
}

function publishUserGuides() {
  const target = path.join(tranquilHome(), 'llm');
  try {
    const source = path.join(path.dirname(require.resolve('tranquil-llm/package.json')), 'users');
    const userGuides = new Map(
      fs.readdirSync(source)
        .filter((name) => name.endsWith('.md'))
        .map((name) => [name, fs.readFileSync(path.join(source, name), 'utf8')])
    );
    fs.mkdirSync(target, { recursive: true });
    for (const [name, content] of userGuides) {
      const dest = path.join(target, name);
      const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
      if (existing !== content) fs.writeFileSync(dest, content, 'utf8');
    }
    const headers = new Set([...userGuides.values()].map(firstLine));
    for (const name of fs.readdirSync(target)) {
      if (!name.endsWith('.md') || userGuides.has(name)) continue;
      const file = path.join(target, name);
      if (headers.has(firstLine(fs.readFileSync(file, 'utf8')))) fs.rmSync(file);
    }
  } catch (e) {
    console.error(`[user-guides] could not publish the user guides: ${e.message}`);
  }
}

module.exports = { publishUserGuides };
