#!/usr/bin/env node
// PTY smoke test: proves node-pty can spawn a real terminal, receive input,
// emit output, resize and terminate cleanly - in whatever runtime runs it.
//
//   npm run smoke:pty
//
// When electron is installed locally, the script re-executes itself through
// the actual Electron binary so the native module is loaded under the exact
// runtime/ABI the app ships with (N-API prebuilds make this equivalent to
// plain Node, but we verify rather than assume). Without electron it falls
// back to plain Node and says so.
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');

// NOTE: on Windows you may see "Error: AttachConsole failed" from
// conpty_console_list_agent.js on stderr. That is a separate ELECTRON_RUN_AS_NODE
// child process node-pty spawns; it races us when the ConPTY handle closes.
// It is cosmetic - this script's EXIT CODE is the verdict (0 = pass).
process.on('uncaughtException', (e) => {
  if (/AttachConsole failed/i.test(String(e.message))) return;
  console.error('SMOKE FAILED:', e.message);
  process.exit(1);
});

// Already inside Electron's main process?
if (process.versions.electron) {
  run().then(
    () => process.exit(0),
    (e) => {
      console.error('SMOKE FAILED:', e.message);
      process.exit(1);
    },
  );
} else {
  // Re-exec under Electron when possible.
  const fs = require('fs');
  const electronExe =
    process.platform === 'win32'
      ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
      : process.platform === 'darwin'
        ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
  if (fs.existsSync(electronExe)) {
    console.log('smoke-pty: running under Electron', require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version);
    const { spawnSync } = require('child_process');
    const r = spawnSync(electronExe, [__filename], { stdio: 'inherit', cwd: ROOT, timeout: 60000 });
    process.exit(r.status === null ? 1 : r.status);
  } else {
    console.log('smoke-pty: electron not installed - falling back to plain Node (run npm ci for the real thing)');
    run().then(
      () => process.exit(0),
      (e) => {
        console.error('SMOKE FAILED:', e.message);
        process.exit(1);
      },
    );
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  let pty;
  try {
    pty = require(path.join(ROOT, 'node_modules', 'node-pty'));
  } catch (e) {
    throw new Error('node-pty failed to load: ' + e.message);
  }

  const MARKER = 'tote-smoke-' + Math.random().toString(36).slice(2, 8);
  const isWin = process.platform === 'win32';
  const file = isWin ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh';
  const args = isWin ? [] : ['-i'];

  console.log(`smoke-pty: spawning ${file} ${args.join(' ')}`);
  const p = pty.spawn(file, args, {
    name: 'xterm',
    cols: 80,
    rows: 24,
    cwd: ROOT,
    env: process.env,
  });

  let out = '';
  let exited = false;
  let exitCode = null;
  p.onData((d) => (out += d));
  p.onExit(({ exitCode: c }) => {
    exited = true;
    exitCode = c;
  });

  // 1. output arrives (banner/prompt)
  await waitFor(() => out.length > 0, 10000, 'no output from the shell');

  // 2. input round-trips
  p.write(`echo ${MARKER}\r`);
  await waitFor(() => out.includes(MARKER), 10000, `input not echoed back (marker ${MARKER})`);

  // 3. resize does not throw
  try {
    p.resize(100, 30);
  } catch (e) {
    throw new Error('resize failed: ' + e.message);
  }

  // 4. clean termination
  p.kill();
  await waitFor(() => exited, 10000, 'pty did not terminate after kill()');

  // Give node-pty's Windows conout helper a moment to shut down before the
  // process exits, or it can race us and print a harmless "AttachConsole
  // failed" from its child agent.
  await sleep(500);

  console.log(`smoke-pty: ok - spawn, write/read, resize, exit(${exitCode}) all verified`);
}

function waitFor(cond, timeoutMs, failMsg) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(failMsg));
      setTimeout(tick, 50);
    };
    tick();
  });
}
