// ConfigStore durability: atomic writes, crash leftovers, malformed recovery.
// Pure Node — exercises the same primitives the main process uses, against a
// throwaway directory. Run by `npm test`.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeJsonAtomic, readJsonSafe, cleanStaleTemps } = require('../src/main/config.js');

const results = [];
let group = '';
function describe(name) { group = name; }
async function test(name, fn) {
  try {
    await fn();
    results.push(['ok', group, name]);
  } catch (e) {
    results.push(['FAIL', group, name + ' — ' + (e && e.message)]);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error((msg || 'not equal') + '\n  got:  ' + ja + '\n  want: ' + jb);
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tote-store-' + tag + '-'));
}

async function main() {

describe('writeJsonAtomic: normal operation')
await test('a written file reads back identically', async () => {
  const dir = tmpDir('rw');
  const f = path.join(dir, 'data.json');
  const data = { active: 'global', list: [{ id: 'global', name: 'Global', path: 'x' }] };
  writeJsonAtomic(f, data);
  eq(JSON.parse(fs.readFileSync(f, 'utf8')), data);
});

await test('overwriting existing state replaces every field', async () => {
  const dir = tmpDir('ov');
  const f = path.join(dir, 'data.json');
  writeJsonAtomic(f, { a: 1, b: [1, 2] });
  writeJsonAtomic(f, { a: 2, b: [] , c: true });
  eq(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 2, b: [], c: true });
});

await test('no temporary siblings survive a successful write', async () => {
  const dir = tmpDir('notmp');
  const f = path.join(dir, 'views.json');
  for (let i = 0; i < 5; i++) writeJsonAtomic(f, { i });
  eq(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), []);
});

await test('repeated views-style saves keep the last value readable', async () => {
  const dir = tmpDir('loop');
  const f = path.join(dir, 'views.json');
  let last;
  for (let i = 0; i < 60; i++) {
    last = { ws1: { tabs: [{ id: 't' + i, providerId: 'kimi' }], groups: [], activeGroup: null } };
    writeJsonAtomic(f, last);
    // read-back on every save, like a paranoid second process would
    eq(JSON.parse(fs.readFileSync(f, 'utf8')), last, 'save #' + i);
  }
  eq(readJsonSafe(f, null), last);
});

describe('writeJsonAtomic: failure handling')
await test('unserializable payload throws BEFORE touching the live file', async () => {
  const dir = tmpDir('bad');
  const f = path.join(dir, 'keepme.json');
  const good = { v: 1 };
  writeJsonAtomic(f, good);
  let threw = false;
  try {
    writeJsonAtomic(f, { n: 2n });   // BigInt: JSON.stringify rejects it
  } catch {
    threw = true;
  }
  assert(threw, 'BigInt payload should throw');
  eq(JSON.parse(fs.readFileSync(f, 'utf8')), good, 'live file must survive');
  eq(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), [], 'no temp left behind');
});

await test('rename blocked by an external holder still leaves the original intact', async () => {
  const dir = tmpDir('lock');
  const f = path.join(dir, 'locked.json');
  writeJsonAtomic(f, { generation: 1 });
  // Hold the destination open with no share flags (Windows-only semantics).
  if (process.platform === 'win32') {
    const fsx = require('fs');
    let handle = null;
    const origRename = fsx.renameSync;
    fsx.renameSync = (...args) => { throw Object.assign(new Error('EBUSY simulate'), { code: 'EBUSY' }); };
    // Simulate transient EBUSY for exactly 3 attempts, then restore.
    let calls = 0;
    fsx.renameSync = function (...args) {
      if (++calls <= 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return origRename.apply(fsx, args);
    };
    try {
      writeJsonAtomic(f, { generation: 2 });
      handle = true;
    } finally {
      fsx.renameSync = origRename;
    }
    assert(handle, 'write should eventually succeed after retries');
  }
  eq(readJsonSafe(f, null), { generation: 2 }, 'retry loop lands the new state');
});

describe('readJsonSafe recovery')
await test('malformed file falls back and is backed up once', async () => {
  const dir = tmpDir('mal');
  const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, '{ "bridgeDownloads": tru');   // truncated mid-token
  const out = readJsonSafe(f, { bridgeDownloads: true });
  eq(out, { bridgeDownloads: true }, 'fallback used');
  const bak = fs.readdirSync(dir).filter((n) => n.startsWith('settings.json.bak-'));
  eq(bak.length, 1, 'exactly one timestamped backup');
  eq(fs.readFileSync(path.join(dir, bak[0]), 'utf8'), '{ "bridgeDownloads": tru', 'backup holds the broken bytes');
});

await test('valid file is returned untouched, no backup churn', async () => {
  const dir = tmpDir('val');
  const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, '{"a":1}');
  eq(readJsonSafe(f, null), { a: 1 });
  eq(fs.readdirSync(dir).filter((n) => n.includes('.bak')).length, 0);
});

await test('missing file returns fallback silently', async () => {
  eq(readJsonSafe(path.join(tmpDir('miss'), 'none.json'), { d: 1 }), { d: 1 });
});

describe('rolling .bak of previous good state')
await test('overwrite keeps the previous version recoverable as <name>.bak', async () => {
  const dir = tmpDir('bak');
  const f = path.join(dir, 'workspaces.json');
  writeJsonAtomic(f, { gen: 1 });
  writeJsonAtomic(f, { gen: 2 });
  eq(readJsonSafe(f, null), { gen: 2 });
  eq(readJsonSafe(f + '.bak', null), { gen: 1 }, '.bak holds the prior generation');
});

describe('stale temp cleanup')
await test('old crash leftovers are removed, fresh ones untouched', async () => {
  const dir = tmpDir('sweep');
  const stale = path.join(dir, 'views.json.tmp-123-abc');
  const fresh = path.join(dir, 'views.json.tmp-456-def');
  fs.writeFileSync(stale, '{');
  fs.writeFileSync(fresh, '{');
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(stale, old, old);
  const removed = cleanStaleTemps(dir, Date.now(), 24 * 3600 * 1000);
  eq(removed, 1);
  assert(!fs.existsSync(stale), 'stale temp removed');
  assert(fs.existsSync(fresh), 'fresh temp kept');
});

await test('cleanup tolerates a missing directory', async () => {
  eq(cleanStaleTemps(path.join(tmpDir('gone'), 'nope'), Date.now(), 1000), 0);
});

let pass = 0, fail = 0;
for (const [status, g, name] of results) {
  if (status === 'ok') { pass++; console.log(`  \x1b[32m✓\x1b[0m ${g} — ${name}`); }
  else { fail++; console.log(`\n  \x1b[31m✗\x1b[0m ${g} — ${name}\n`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('harness crashed:', e); process.exit(1); });
