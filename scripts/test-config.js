#!/usr/bin/env node
// Dependency-free tests for ConfigStore: default seeding, read caching that
// still honors edits made outside the app, atomic writes, and the
// back-up-once-then-fallback path for malformed files.
// Run: node scripts/test-config.js   (exits non-zero on failure)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigStore } = require('../src/main/config');

let pass = 0, fail = 0;
const describe = (name, fn) => { console.log('\n' + name); fn(); };
const jobs = [];
const test = (name, fn) => {
  // Registered as a job and awaited at the bottom: assertions here are async.
  jobs.push(fn().then(
    () => { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); },
    (e) => { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); },
  ));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-config-test-'));
  // ConfigStore joins 'config' under the passed "userData" path.
  const cfgDir = path.join(dir, 'config');
  const fakeApp = { getPath: () => dir };
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, cfgDir, store: new ConfigStore(fakeApp), cleanup };
}

// Bump an existing file so a different (size, mtimeMs) is visible even on
// filesystems with coarse timestamps: rewrite with distinct content + delays.
async function editExternally(file, contents) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(15);
    fs.writeFileSync(file, contents);
    await sleep(15);
    return fs.statSync(file);
  }
}

describe('ConfigStore: seeding', () => {
  test('copies every default into userData on construction', async () => {
    const h = harness();
    try {
      for (const f of ['providers.json', 'cli-profiles.json', 'workspaces.json', 'apps.json', 'settings.json', 'views.json']) {
        assert.ok(fs.existsSync(path.join(h.cfgDir, f)), f);
      }
    } finally { h.cleanup(); }
  });

  test('reads return parsed defaults and are stable across calls', async () => {
    const h = harness();
    try {
      const first = h.store.getSettings();
      const second = h.store.getSettings();
      assert.deepStrictEqual(second, first);
    } finally { h.cleanup(); }
  });
});

describe('ConfigStore: writing', () => {
  test('write -> read round-trips what was written', async () => {
    const h = harness();
    try {
      const doc = { bridgeDownloads: false, scratchDays: 3 };
      h.store.saveSettings(doc);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(h.cfgDir, 'settings.json'), 'utf8')), doc);
      assert.deepStrictEqual(h.store.read('settings.json', null), doc);
    } finally { h.cleanup(); }
  });

  test('writes are atomic: no temp file ever survives a successful save', async () => {
    const h = harness();
    try {
      h.store.saveSettings({ bridgeDownloads: false });
      const leftovers = fs.readdirSync(h.cfgDir).filter((f) => f.includes('.tmp'));
      assert.deepStrictEqual(leftovers, []);
      // And the final file parses (rename left a complete document behind).
      assert.deepStrictEqual(h.store.getSettings(), { bridgeDownloads: false });
    } finally { h.cleanup(); }
  });

  test('a value written through the store is not aliased into later reads', async () => {
    const h = harness();
    try {
      const list = [{ id: 'a' }];
      h.store.saveProviders(list);
      list.push({ id: 'mutated-after-save' });
      assert.deepStrictEqual(h.store.getProviders(), [{ id: 'a' }]);
    } finally { h.cleanup(); }
  });
});

describe('ConfigStore: cache coherence', () => {
  test('edits made outside the app are picked up on the next read', async () => {
    const h = harness();
    try {
      h.store.getSettings();                     // prime the cache
      await editExternally(path.join(h.cfgDir, 'settings.json'), '{"bridgeDownloads": false, "scratchDays": 9}');
      assert.deepStrictEqual(h.store.getSettings(), { bridgeDownloads: false, scratchDays: 9 });
    } finally { h.cleanup(); }
  });

  test('an internally written file is visible even if another read comes fast', async () => {
    const h = harness();
    try {
      h.store.getCliProfiles();
      h.store.saveCliProfiles([{ id: 'shell', name: 'Shell' }]);
      for (let i = 0; i < 5; i++) {              // hammer it across many ms ticks
        assert.deepStrictEqual(h.store.getCliProfiles(), [{ id: 'shell', name: 'Shell' }]);
      }
    } finally { h.cleanup(); }
  });

  test('a deleted file falls back instead of serving a cached copy', async () => {
    const h = harness();
    try {
      assert.ok(h.store.getApps());
      fs.unlinkSync(path.join(h.cfgDir, 'apps.json'));
      assert.deepStrictEqual(h.store.getApps(), { list: [] });
    } finally { h.cleanup(); }
  });
});

describe('ConfigStore: malformed input', () => {
  test('corrupt config backs up once, serves fallback, and never recurs per read', async () => {
    const h = harness();
    try {
      h.store.getViews();                        // prime the cache with good state
      const file = path.join(h.cfgDir, 'views.json');
      await editExternally(file, '{"not":"closed');
      assert.deepStrictEqual(h.store.read('views.json', {}), {});       // fallback now
      const baks = () => fs.readdirSync(h.cfgDir).filter((f) => f.startsWith('views.json.bak-')).length;
      assert.strictEqual(baks(), 1, 'exactly one backup after corruption');
      assert.deepStrictEqual(h.store.read('views.json', {}), {});
      assert.deepStrictEqual(h.store.read('views.json', {}), {});
      assert.strictEqual(baks(), 1, 'repeated reads must not spam more backups');
      // Fixing the file restores normal service.
      await editExternally(file, '{"fixed":true}');
      assert.deepStrictEqual(h.store.getViews(), { fixed: true });
    } finally { h.cleanup(); }
  });
});

Promise.all(jobs).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
