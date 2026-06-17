#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const PMS_PATH = process.env.PMS_ACCOUNTS_PATH;
const PID_FILE = path.join(os.tmpdir(), 'tranquil-pms-accounts.pid');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function stopPms() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pid) process.kill(pid, 'SIGTERM');
    fs.unlinkSync(PID_FILE);
    console.log(`[dev] stopped previous pms-accounts (pid ${pid})`);
  } catch (_) {
    // no previous instance
  }
}

function waitForServer(port, timeout = 30000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get(`http://localhost:${port}`, (res) => {
        res.destroy();
        resolve();
      }).on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`pms-accounts did not become ready within ${timeout}ms`));
        } else {
          setTimeout(attempt, 500);
        }
      });
    };
    attempt();
  });
}

async function main() {
  stopPms();

  const port = await findFreePort();

  let pmsProcess = null;
  if (PMS_PATH) {
    console.log(`[dev] starting pms-accounts on port ${port}`);
    pmsProcess = spawn(process.execPath, [
      path.join(PMS_PATH, 'node_modules/vite/bin/vite.js'),
      'dev', '--port', String(port),
    ], {
      cwd: PMS_PATH,
      stdio: 'inherit',
    });
    pmsProcess.on('error', err => console.error('[pms-accounts] error:', err));
    fs.writeFileSync(PID_FILE, String(pmsProcess.pid));

    console.log('[dev] waiting for pms-accounts to be ready...');
    await waitForServer(port);
  } else {
    console.warn('[dev] PMS_ACCOUNTS_PATH not set in .env — skipping pms-accounts');
  }

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
        PMS_ACCOUNTS_PORT: String(port),
        ATOM_RESOURCE_PATH: path.join(__dirname, '..'),
      },
    }
  );

  function cleanup() {
    if (pmsProcess) {
      pmsProcess.kill('SIGTERM');
      try { fs.unlinkSync(PID_FILE); } catch (_) {}
    }
    process.exit(0);
  }

  electronProcess.on('close', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
