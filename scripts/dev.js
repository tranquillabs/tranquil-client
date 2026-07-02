#!/usr/bin/env node

const path = require('path');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

function main() {
  const electronBin = require('electron');
  const electronProcess = spawn(
    electronBin,
    ['--no-sandbox', '--enable-logging', '.', '-f'],
    {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_PATH: path.join(__dirname, '..', 'node_modules'),
        ATOM_RESOURCE_PATH: path.join(__dirname, '..'),
      },
    }
  );

  function cleanup() {
    process.exit(0);
  }

  electronProcess.on('close', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main();
