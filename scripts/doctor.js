#!/usr/bin/env node
// npm run doctor - cross-platform health check for a Tote checkout.
//
// Reports what matters for running/building the app and exits non-zero only
// when something actually prevents the app from working:
//   node >= 20, npm, electron installed + consistent with the lockfile,
//   vendored xterm assets, home write access, and a real node-pty PTY.
// Everything else (git, electron-builder, optional AI CLIs, packaging cache)
// is reported as advice, never as failure.
//
// Flags:
//   --ci     CI-safe mode: skips host-specific checks (optional CLI presence,
//            packaging cache) so the same command runs on runners.
//   --json   machine-readable output.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const S = require('../src/main/syscheck.js');

const args = process.argv.slice(2);
const CI = args.includes('--ci');
const JSON_OUT = args.includes('--json');
const ROOT = path.join(__dirname, '..');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function moduleVersion(name) {
  const pkg = readJson(path.join(ROOT, 'node_modules', name, 'package.json'));
  return pkg ? pkg.version : null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// --- checks -----------------------------------------------------------------

function checkNode() {
  const v = process.versions.node;
  const ok = S.nodeMajorOk(v, 20);
  return { id: 'node', label: `Node.js ${v}${ok ? '' : ' (need >= 20)'}`, ok, required: true };
}

function checkNpm() {
  const p = S.resolveCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm');
  return {
    id: 'npm',
    label: p ? `npm at ${p}` : 'npm not found (ships with Node.js)',
    ok: !!p,
    required: true,
  };
}

function checkElectron() {
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const manifestSpec = pkg.devDependencies && pkg.devDependencies.electron;
  const locked = moduleVersion('electron');
  const mismatch = S.electronVersionMismatch({
    buildElectronVersion: pkg.build && pkg.build.electronVersion,
    manifestSpec,
    lockedVersion: locked,
  });
  const binary =
    process.platform === 'win32'
      ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
      : process.platform === 'darwin'
        ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app')
        : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
  const ok = !mismatch && fs.existsSync(binary);
  return {
    id: 'electron',
    label: ok
      ? `electron ${locked} installed, build.electronVersion in sync`
      : mismatch || 'electron binary missing - run: npm ci',
    ok,
    detail: mismatch || undefined,
    required: true,
  };
}

function checkVendor() {
  const missing = ['xterm.js', 'xterm.css', 'addon-fit.js'].filter(
    (f) => !fs.existsSync(path.join(ROOT, 'src', 'renderer', 'vendor', f)),
  );
  return {
    id: 'vendor',
    label: missing.length
      ? `vendored xterm assets missing: ${missing.join(', ')}`
      : 'vendored xterm assets present',
    ok: missing.length === 0,
    detail: missing.length ? 'run: node scripts/copy-vendor.js' : undefined,
    required: true,
  };
}

function checkHomeWritable() {
  let ok = true;
  let detail;
  const probe = path.join(os.homedir(), '.tote-write-test');
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
  } catch (e) {
    ok = false;
    detail = e.code || 'write failed';
  }
  return {
    id: 'home',
    label: ok ? `home folder writable (${os.homedir()})` : 'home folder not writable - Tote cannot create ~/tote',
    ok,
    required: true,
  };
}

function checkPty() {
  // Load + spawn a real PTY in this process. This is exactly what the main
  // process does; if it works here it works under Electron (N-API prebuilds
  // are ABI-stable across Node/Electron). Async so pty callbacks can run.
  return new Promise((resolve) => {
    let ptyError = null;
    try {
      const pty = require(path.join(ROOT, 'node_modules', 'node-pty'));
      const shellFile = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh';
      const shellArgs = process.platform === 'win32' ? ['/c', 'echo tote-doctor-ok'] : ['-c', 'echo tote-doctor-ok'];
      const p = pty.spawn(shellFile, shellArgs, {
        name: 'xterm',
        cols: 80,
        rows: 24,
        cwd: ROOT,
        env: process.env,
      });
      const result = { data: '', code: null, done: false };
      p.onData((d) => (result.data += d));
      p.onExit(({ exitCode }) => {
        result.code = exitCode;
        result.done = true;
      });
      const start = Date.now();
      const tick = () => {
        if (!result.done && Date.now() - start < 15000) {
          setTimeout(tick, 100);
          return;
        }
        const version = moduleVersion('node-pty') || '?';
        if (!result.done) {
          try { p.kill(); } catch {}
          ptyError = 'pty did not exit within 15s';
        } else if (result.data.indexOf('tote-doctor-ok') < 0) {
          ptyError = 'pty produced no output';
        }
        const kind = ptyError ? S.classifyPtyProblem(ptyError) : null;
        resolve({
          id: 'pty',
          label: ptyError
            ? `node-pty ${version}: ${kind.label}`
            : `node-pty ${version}: spawns a real PTY`,
          ok: !ptyError,
          detail: ptyError ? kind.hint : undefined,
          required: true,
          _kind: kind ? kind.kind : 'none',
        });
      };
      tick();
    } catch (e) {
      const kind = S.classifyPtyProblem(e.message);
      resolve({
        id: 'pty',
        label: `node-pty: ${kind.label}`,
        ok: false,
        detail: kind.hint,
        required: true,
        _kind: kind.kind,
      });
    }
  });
}

function checkGit() {
  const p = S.resolveCommand('git');
  return {
    id: 'git',
    label: p ? `git at ${p}` : 'git not found - fine for the app, needed by most agents/project spaces',
    ok: !!p,
    required: false,
  };
}

function checkBuilder() {
  const v = moduleVersion('electron-builder');
  return {
    id: 'builder',
    label: v ? `electron-builder ${v}` : 'electron-builder not installed - only needed for npm run dist/pack',
    ok: !!v,
    required: false,
  };
}

function checkOptionalClis() {
  const names = ['claude', 'kimi', 'codex', 'gemini', 'opencode'];
  return names.map((n) => {
    const p = S.resolveCommand(n);
    return {
      id: `cli:${n}`,
      label: p ? `${n} at ${p}` : `${n} not installed (optional - install from the setup wizard or npm i -g)`,
      ok: !!p,
      required: false,
    };
  });
}

function checkSignCache() {
  if (process.platform !== 'win32') return [];
  const wc = require('./win-sign-cache.js');
  const state = wc.classify();
  return [
    {
      id: 'sign-cache',
      label:
        state.status === 'ok'
          ? 'electron-builder sign-tool cache usable'
          : 'packaging may fail on symbolic links - run: node scripts/win-sign-cache.js (or enable Developer Mode)',
      ok: state.status === 'ok',
      required: false,
    },
  ];
}

// --- run ---------------------------------------------------------------------

async function main() {
  const items = [
    checkNode(),
    checkNpm(),
    checkElectron(),
    checkVendor(),
    checkHomeWritable(),
    await checkPty(),
    checkGit(),
    checkBuilder(),
    ...checkSignCache(),
  ];
  items.push(...(CI ? [] : checkOptionalClis()));

  const { healthy, blockers, advice } = S.classifyDoctor(items);

  if (JSON_OUT) {
    console.log(JSON.stringify({ healthy, platform: process.platform, arch: process.arch, node: process.versions.node, checks: items.map(({ _kind, ...rest }) => rest), blockers, advice }, null, 2));
  } else {
    console.log(`Tote doctor - ${process.platform}/${process.arch}, node ${process.versions.node}`);
    console.log('');
    for (const it of items) {
      const mark = it.ok ? '[ok]' : it.required ? '[!!]' : '[--]';
      console.log(`  ${mark} ${it.label}`);
      if (it.detail) console.log(`       ${it.detail}`);
    }
    console.log('');
    if (healthy) {
      for (const a of advice) console.log(`advice: ${a.label}${a.detail ? ` (${a.detail})` : ''}`);
      console.log('Healthy. Optional gaps are marked [--] and never block the app.');
    } else {
      console.log('Not healthy - fix the [!!] items above:');
      for (const p of blockers) console.log(`  - ${p.label}${p.detail ? ` (${p.detail})` : ''}`);
    }
  }
  process.exit(healthy ? 0 : 1);
}

main();
