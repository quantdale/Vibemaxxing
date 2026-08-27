#!/usr/bin/env node
// Micro-benchmarks for Tote's hot paths. Not part of CI: run with `npm run bench`
// before/after touching config reads, layout math, or PTY batching.
//
// Everything measured here is a real apples-to-apples pair on this machine:
//   - ConfigStore.read() (cached) vs an explicit fresh disk read+parse of the
//     same file -- the exact work each cached call used to do every time.
//   - TileTree.findLeaf / rectsFor on a synthetic balanced tree -- absolute
//     numbers to catch accidental regressions in layout.js.
//   - makeDataCoalescer throughput vs one-message-per-chunk baseline.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigStore } = require('../src/main/config');
const T = require('../src/renderer/layout.js');
const { makeDataCoalescer } = require('../src/main/ptyManager');

(async function main() {

const fmt = (us) => (us >= 100 ? us.toFixed(0) : us.toFixed(2)) + ' µs/op';
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function timed(fn, iters) {
  const samples = [];
  for (let r = 0; r < 7; r++) {
    const t0 = process.hrtime.bigint();
    fn(iters);
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6 / iters); // ms per op
  }
  return median(samples) * 1000; // µs per op
}

let section = '';
console.log(`Tote micro-benchmarks - node ${process.versions.node}, ${process.platform}/${process.arch}`);

/* ----- ConfigStore read path ------------------------------------------------ */
section = '\n[1] ConfigStore read hot path (32 KB settings payload)';
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-bench-'));
  try {
    const doc = { big: Array.from({ length: 512 }, (_, i) => ({ id: 'item-' + i, note: 'x'.repeat(48) })) };
    const store = new ConfigStore({ getPath: () => root });
    const file = path.join(root, 'config', 'settings.json');
    // Seed via the store's own public contract with a bigger payload.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const raw = JSON.stringify(doc, null, 2);
    fs.writeFileSync(file, raw);
    store.read('settings.json', null);   // prime

    // Baseline: what every read cost before caching -- full stat-free read + parse.
    const freshRead = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    const uncachedUs = timed((n) => { for (let i = 0; i < n; i++) { const v = freshRead(); if (!v.big) throw new Error('!'); } }, 400);
    const cachedUs = timed((n) => { for (let i = 0; i < n; i++) { const v = store.read('settings.json', null); if (!v.big) throw new Error('!'); } }, 20000);

    console.log(section);
    console.log(`      fresh disk read + parse : ${fmt(uncachedUs)}  (${(raw.length / 1024).toFixed(0)} KB file)`);
    console.log(`      store.read() cached     : ${fmt(cachedUs)}`);
    console.log(`      reduction               : ${(uncachedUs / cachedUs).toFixed(1)}x`);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

/* ----- Layout engine --------------------------------------------------------- */
section = '\n[2] TileTree operations (balanced tree)';
{
  // A perfectly balanced binary tree: build(LEVEL) has 2^LEVEL leaves.
  function build(level, tag) {
    if (level === 0) return T.leaf(tag, 'web');
    return T.split('row', 0.5,
      build(level - 1, tag + '-a'),
      build(level - 1, tag + '-b'));
  }
  const tree = build(12, 'n');      // 4096 leaves
  const leafIds = T.leaves(tree).map((l) => l.id);
  const needle = leafIds[leafIds.length - 1];         // worst case: last in DFS order

  const findUs = timed((n) => { for (let i = 0; i < n; i++) { if (!T.findLeaf(tree, needle)) throw new Error('!'); } }, 200);
  const rectsUs = timed((n) => {
    for (let i = 0; i < n; i++) {
      const r = T.rectsFor(tree, { x: 0, y: 0, w: 1600, h: 900 }, { gutter: 6 });
      if (r.size !== leafIds.length) throw new Error('!');
    }
  }, 5);

  console.log(section);
  console.log(`      findLeaf (worst-case id): ${fmt(findUs)}   [${leafIds.length} leaves]`);
  console.log(`      rectsFor (full tree)    : ${fmt(rectsUs)}`);
}

/* ----- PTY batching ----------------------------------------------------------- */
section = '\n[3] pty:data coalescing (production defaults)';
{
  const N = 50000;
  let sentCount = 0;
  let bytes = 0;
  const batch = makeDataCoalescer((d) => { sentCount++; bytes += d.length; }, { delayMs: 4 });
  const t0 = Date.now();
  for (let i = 0; i < N; i++) batch.push(`chunk-${i}:\\r\\x1b[K`);
  await new Promise((r) => setTimeout(r, 30));
  batch.flush();
  const ms = Math.max(Date.now() - t0, 1);
  console.log(section);
  console.log(`      ${N} chunks -> ${sentCount} messages in ${ms} ms (${bytes} bytes delivered)`);
  console.log(`      raw (one message/chunk) would have been  -> ${N} messages`);
}

console.log('\nDone. Numbers are machine-specific medians of repeated runs.');
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });