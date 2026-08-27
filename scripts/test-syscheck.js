#!/usr/bin/env node
// Dependency-free tests for src/main/syscheck.js - the pure decision logic
// shared by scripts/doctor.js and the setup wizard.
// Run: node scripts/test-syscheck.js
const assert = require('assert');
const S = require('../src/main/syscheck.js');

let pass = 0, fail = 0, skipped = 0;
const describe = (name, fn) => { console.log('\n' + name); fn(); };
const jobs = [];
const test = (name, fn) => {
  // Wrapped in a resolved-promise chain so both sync and async assertions are
  // awaited before the summary at the bottom runs.
  jobs.push(
    Promise.resolve().then(fn).then(
      () => { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); },
      (e) => {
        if (e && e.skip) { skipped++; console.log('  \x1b[33m-\x1b[0m ' + name + '\n      skipped: ' + e.message); return; }
        fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message);
      },
    ),
  );
};

describe('parseVersion', () => {
  test('parses a full version', () => {
    assert.deepStrictEqual(S.parseVersion('24.3.1'), { major: 24, minor: 3, patch: 1 });
  });
  test('strips the v prefix npm prints', () => {
    assert.deepStrictEqual(S.parseVersion('v20.11.0'), { major: 20, minor: 11, patch: 0 });
  });
  test('tolerates a missing patch and minor', () => {
    assert.deepStrictEqual(S.parseVersion('22.5'), { major: 22, minor: 5, patch: 0 });
    assert.deepStrictEqual(S.parseVersion('21'), { major: 21, minor: 0, patch: 0 });
  });
  test('returns null for garbage and non-input', () => {
    assert.strictEqual(S.parseVersion('vabc'), null);
    assert.strictEqual(S.parseVersion(''), null);
    assert.strictEqual(S.parseVersion(null), null);
    assert.strictEqual(S.parseVersion(42), null);
  });
});

describe('nodeMajorOk', () => {
  test('accepts exactly the minimum major', () => {
    assert.strictEqual(S.nodeMajorOk('v20.0.0', 20), true);
  });
  test('rejects one below it', () => {
    assert.strictEqual(S.nodeMajorOk('19.9.9', 20), false);
  });
  test('accepts anything newer', () => {
    assert.strictEqual(S.nodeMajorOk('24.3.0', 20), true);
  });
  test('garbage is never ok', () => {
    assert.strictEqual(S.nodeMajorOk(undefined, 20), false);
  });
});

describe('classifyPtyProblem', () => {
  test('a missing package is "missing"', () => {
    const r = S.classifyPtyProblem("Cannot find module 'node-pty'");
    assert.strictEqual(r.kind, 'missing');
    assert.match(r.hint, /npm ci/);
  });
  test('an ABI mismatch is "abi"', () => {
    const r = S.classifyPtyProblem('was compiled against a different Node.js version using NODE_MODULE_VERSION 108');
    assert.strictEqual(r.kind, 'abi');
  });
  test('a compile failure is "toolchain" with platform-specific advice', () => {
    const r = S.classifyPtyProblem('gyp ERR! find VS msvs_version not set');
    assert.strictEqual(r.kind, 'toolchain');
    if (process.platform === 'win32') assert.match(r.hint, /Visual Studio 2022 Build Tools/);
  });
  test('a spawn failure is "spawn"', () => {
    assert.strictEqual(S.classifyPtyProblem('posix_spawnp failed. errno: 2').kind, 'spawn');
    assert.strictEqual(S.classifyPtyProblem('spawn ENOENT').kind, 'spawn');
  });
  test('an empty message is "none", an alien one is "unknown"', () => {
    assert.strictEqual(S.classifyPtyProblem('').kind, 'none');
    assert.strictEqual(S.classifyPtyProblem(null).kind, 'none');
    assert.strictEqual(S.classifyPtyProblem('something entirely else').kind, 'unknown');
  });
});

describe('classifyDoctor', () => {
  test('all green is healthy with nothing to report', () => {
    const r = S.classifyDoctor([{ id: 'a', label: 'A', ok: true, required: true }]);
    assert.strictEqual(r.healthy, true);
    assert.strictEqual(r.blockers.length, 0);
    assert.strictEqual(r.advice.length, 0);
  });
  test('a failing required item blocks health', () => {
    const r = S.classifyDoctor([{ id: 'a', label: 'A broken', ok: false, detail: 'fix it', required: true }]);
    assert.strictEqual(r.healthy, false);
    assert.strictEqual(r.blockers.length, 1);
    assert.strictEqual(r.blockers[0].detail, 'fix it');
  });
  test('a failing optional item is advice only', () => {
    const r = S.classifyDoctor([
      { id: 'a', label: 'A', ok: true, required: true },
      { id: 'cli:x', label: 'x not installed', ok: false, required: false },
    ]);
    assert.strictEqual(r.healthy, true);
    assert.strictEqual(r.advice.length, 1);
    assert.strictEqual(r.blockers.length, 0);
  });
  test('missing items default to failing', () => {
    const r = S.classifyDoctor([{ id: 'a', label: 'A' }]);
    assert.strictEqual(r.healthy, false);
    assert.strictEqual(r.blockers.length, 1);
  });
  test('null input is healthy', () => {
    assert.strictEqual(S.classifyDoctor(null).healthy, true);
  });
});

describe('electronVersionMismatch', () => {
  const good = {
    buildElectronVersion: '37.10.3',
    manifestSpec: '37.10.3',
    lockedVersion: '37.10.3',
  };
  test('a pinned, synced setup is consistent', () => {
    assert.strictEqual(S.electronVersionMismatch(good), null);
  });
  test('a ranged manifest spec fails even when locked matches', () => {
    assert.match(
      S.electronVersionMismatch({ ...good, manifestSpec: '^37.0.0' }),
      /not pinned exactly/,
    );
  });
  test('build.electronVersion disagreeing with the lockfile fails', () => {
    assert.match(
      S.electronVersionMismatch({ ...good, buildElectronVersion: '36.0.0' }),
      /!= locked electron/,
    );
  });
  test('a missing lockfile entry and a missing declaration both fail', () => {
    assert.match(S.electronVersionMismatch({ ...good, lockedVersion: null }), /lockfile/);
    assert.match(S.electronVersionMismatch({ ...good, buildElectronVersion: null }), /electronVersion/);
  });
});

describe('resolveCommand', () => {
  test('finds something that certainly exists on this platform', function () {
    const cmd = process.platform === 'win32' ? 'cmd.exe' : 'sh';
    const p = S.resolveCommand(cmd);
    if (!p) throw { skip: `${cmd} not on PATH here` };
    assert.ok(p.length > 0);
  });
  test('returns null for a command that does not exist natively', () => {
    // WSL-only or fictional binaries must NOT be claimed as available -
    // that is exactly the truthfulness this helper exists for.
    assert.strictEqual(S.resolveCommand('definitely-not-a-real-cli-tote'), null);
    assert.strictEqual(S.resolveCommand(''), null);
    assert.strictEqual(S.resolveCommand(null), null);
  });
});

describe('resolveCommandAsync', () => {
  test('agrees with the sync resolver and resolves a real binary', async function () {
    const cmd = process.platform === 'win32' ? 'cmd.exe' : 'sh';
    const p = await S.resolveCommandAsync(cmd);
    if (p === null) throw { skip: `${cmd} not on PATH here` };
    assert.strictEqual(p, S.resolveCommand(cmd));
  });
  test('resolves null for missing/fictional commands instead of throwing', async () => {
    assert.strictEqual(await S.resolveCommandAsync('definitely-not-a-real-cli-tote'), null);
    assert.strictEqual(await S.resolveCommandAsync(''), null);
    assert.strictEqual(await S.resolveCommandAsync(null), null);
  });
});

Promise.all(jobs).then(() => {
  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
});
