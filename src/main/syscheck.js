// Shared system-inspection helpers used by scripts/doctor.js and the setup
// wizard (installer.js). Everything here is dependency-free; the functions
// that touch the OS are thin wrappers kept separate from the pure decision
// logic so both can be unit-tested (scripts/test-syscheck.js).
'use strict';

const { execFile } = require('child_process');

// --- versions -----------------------------------------------------------------

// "v24.3.0", "24.3.0", "24.3" -> { major, minor, patch } ; garbage -> null.
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().replace(/^v/, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: m[2] !== undefined ? parseInt(m[2], 10) : 0,
    patch: m[3] !== undefined ? parseInt(m[3], 10) : 0,
  };
}

function nodeMajorOk(version, minMajor) {
  const parsed = parseVersion(version);
  return !!parsed && parsed.major >= minMajor;
}

// --- node-pty failure classification -------------------------------------------

// Map a node-pty load/spawn error onto a coarse kind the UI can explain.
// Kinds: 'missing' (package absent), 'abi' (built for another runtime),
// 'toolchain' (compile failed), 'spawn' (loaded but could not start a shell),
// 'none', 'unknown'.
function classifyPtyProblem(message) {
  if (!message) return { kind: 'none', label: '', hint: '' };
  const s = String(message);
  if (/cannot find module|module_not_found|ERR_MODULE_NOT_FOUND/i.test(s)) {
    return {
      kind: 'missing',
      label: 'node-pty is not installed',
      hint: 'run: npm ci',
    };
  }
  if (/node_module_version|compiled against a different node\.js|abi/i.test(s)) {
    return {
      kind: 'abi',
      label: 'native module built for a different runtime',
      hint: 'reinstall against this runtime: npm ci (or npm rebuild node-pty)',
    };
  }
  if (/node-gyp|\bgyp\b|python|visual studio|msbuild|cl\.exe|link\.exe|windows sdk|build tools/i.test(s)) {
    return {
      kind: 'toolchain',
      label: 'native build failed - C++ toolchain problem',
      hint:
        process.platform === 'win32'
          ? 'install Visual Studio 2022 Build Tools with "Desktop development with C++" (includes the Windows SDK), plus Python 3 if asked, then re-run: npm ci'
          : process.platform === 'darwin'
            ? 'run: xcode-select --install, then re-run: npm ci'
            : 'install build tools (Debian/Ubuntu: sudo apt install build-essential python3), then re-run: npm ci',
    };
  }
  if (/posix_spawnp|spawnhelper|spawn-helper|spawn[^]*enoent|enoent[^]*spawn|access is denied|eacces|eperm/i.test(s)) {
    return {
      kind: 'spawn',
      label: 'loaded, but spawning a terminal failed',
      hint:
        process.platform === 'win32'
          ? 'check that your shell exists (powershell.exe/cmd.exe) and the workspace folder is accessible'
          : 'the login shell could not start - check $SHELL and PATH; on macOS re-run npm ci to restore node-pty\'s spawn-helper exec bit',
    };
  }
  return { kind: 'unknown', label: s.slice(0, 200), hint: 'run: npm ci, then npm run doctor' };
}

// --- doctor result classification -----------------------------------------------

// items: [{ id, label, ok, detail?, required }]
// A check only counts as passing when ok === true; anything else is a failure.
// Failures are blockers unless the item explicitly says required === false,
// in which case they are advice. Conservative on purpose: an item that forgot
// to set `required` blocks health rather than silently disappearing.
function classifyDoctor(items) {
  const blockers = [];
  const advice = [];
  for (const it of items || []) {
    if (it.ok === true) continue;
    const entry = { id: it.id, label: it.label || it.id, detail: it.detail || '' };
    if (it.required === false) advice.push(entry);
    else blockers.push(entry);
  }
  return {
    healthy: blockers.length === 0,
    blockers,
    advice,
  };
}

// --- dependency consistency ------------------------------------------------------

// The build.electronVersion declared to electron-builder must equal the
// electron version actually locked, and the manifest must pin it exactly.
// All inputs are plain objects so this stays pure and testable.
// Returns null when consistent, otherwise a human-readable reason.
function electronVersionMismatch({ buildElectronVersion, manifestSpec, lockedVersion }) {
  if (!lockedVersion) return 'electron is not in the lockfile - run npm install';
  if (!buildElectronVersion) return 'build.electronVersion is not set - electron-builder would have to guess';
  if (String(buildElectronVersion) !== String(lockedVersion)) {
    return `build.electronVersion (${buildElectronVersion}) != locked electron (${lockedVersion})`;
  }
  if (manifestSpec && !manifestSpec.startsWith(lockedVersion)) {
    return `devDependencies.electron (${manifestSpec}) is not pinned exactly (expected ${lockedVersion})`;
  }
  return null;
}

// --- executable resolution --------------------------------------------------------

// Truthful native resolution: `where`/`which` only see executables the current
// OS can actually launch. A WSL-only binary is correctly NOT found here.
function resolveCommand(cmd, opts) {
  if (!cmd || typeof cmd !== 'string') return null;
  const o = opts || {};
  try {
    const { execFileSync } = require('child_process');
    const isWin = process.platform === 'win32';
    const out = execFileSync(
      o.resolver || (isWin ? 'where' : 'which'),
      [cmd],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: o.timeout || 5000 },
    ).toString();
    const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

// Async twin of resolveCommand for callers on a shared event loop -- IPC
// handlers in Tote's main process. The sync version parks that loop for up to
// its whole timeout on every call; this one only costs a thread-pool slot.
function resolveCommandAsync(cmd, opts) {
  if (!cmd || typeof cmd !== 'string') return Promise.resolve(null);
  const o = opts || {};
  const isWin = process.platform === 'win32';
  return new Promise((resolve) => {
    execFile(
      o.resolver || (isWin ? 'where' : 'which'),
      [cmd],
      { timeout: o.timeout || 5000 },
      (err, out) => {
        if (err) return resolve(null);
        const first = String(out).split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        resolve(first || null);
      },
    );
  });
}

module.exports = {
  parseVersion,
  nodeMajorOk,
  classifyPtyProblem,
  classifyDoctor,
  electronVersionMismatch,
  resolveCommand,
  resolveCommandAsync,
};
