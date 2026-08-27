#!/usr/bin/env node
// Dependency-free tests for pty:data coalescing (makeDataCoalescer) plus a
// measured report of how far it collapses the IPC message count.
// Run: node scripts/test-ptybatch.js   (exits non-zero on failure)
const assert = require('assert');
const { makeDataCoalescer } = require('../src/main/ptyManager');

let pass = 0, fail = 0;
const describe = (name, fn) => { console.log('\n' + name); fn(); };
const jobs = [];
const test = (name, fn) => {
  jobs.push(Promise.resolve().then(fn).then(
    () => { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); },
    (e) => { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); },
  ));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const collector = () => {
  const sends = [];
  return { sends, send: (d) => sends.push(d), text: () => sends.join('') };
};

// One quiet window is enough for the short flush delay used by these cases;
// being generous keeps timing flakes off the board.
const settle = () => wait(40);

describe('makeDataCoalescer: correctness', () => {
  test('order and content survive batching exactly', async () => {
    const c = collector();
    const batch = makeDataCoalescer(c.send, { delayMs: 4, maxBytes: 1024 });
    const chunks = ['a', 'bc', '', 'def', '\\r\\x1b[2J', 'ghij'];
    for (const ch of chunks) batch.push(ch);
    await settle();
    // The contract is byte-exactness of the concatenated stream; the number
    // of messages is the optimization's business (measured separately).
    assert.strictEqual(c.text(), chunks.join(''));
    assert.ok(c.sends.every((s) => typeof s === 'string' && s.length > 0), 'never sends an empty payload');
  });

  test('pushing nothing never emits', async () => {
    const c = collector();
    const batch = makeDataCoalescer(c.send, { delayMs: 4 });
    batch.push('');
    await settle();
    batch.flush();
    await settle();
    assert.deepStrictEqual(c.sends, []);
  });

  test('flush() drains pending bytes synchronously', async () => {
    const c = collector();
    const batch = makeDataCoalescer(c.send, { delayMs: 1000 }); // would never fire during this test
    batch.push('tail-bytes');
    batch.flush();
    assert.deepStrictEqual(c.sends, ['tail-bytes']);
    await settle();
    assert.strictEqual(c.text(), 'tail-bytes');
  });

  test('byte threshold flushes immediately without waiting for the window', async () => {
    const c = collector();
    const batch = makeDataCoalescer(c.send, { delayMs: 1000, maxBytes: 8 });
    batch.push('1234');                 // under threshold: buffered
    assert.deepStrictEqual(c.sends, []);
    batch.push('567890');               // crosses 8 bytes: emitted at once
    assert.deepStrictEqual(c.sends.length >= 1, true);
    assert.strictEqual(c.text(), '1234567890');
    await settle();
    assert.strictEqual(c.text(), '1234567890'); // no duplicates, no loss
  });

  test('discard() drops the tail silently', async () => {
    const c = collector();
    const batch = makeDataCoalescer(c.send, { delayMs: 1000 });
    batch.push('doomed');
    batch.discard();
    batch.flush();
    assert.deepStrictEqual(c.sends, []);
  });

  test('the flusher stays usable after emitting (single-flight timer resets)', async () => {
    const c = collector();
    const batch = makeDataCoalescer(c.send, { delayMs: 4 });
    batch.push('one');
    await settle();
    batch.push('two');
    await settle();
    assert.strictEqual(c.text(), 'onetwo');
  });
});

describe('pty:data reduction (measured)', () => {
  test('20k small chunks collapse to a handful of IPC messages', async () => {
    const c = collector();
    const batch = makeDataCoalescer(c.send, { delayMs: 4 }); // production defaults
    const N = 20000;
    let input = '';
    for (let i = 0; i < N; i++) {
      const ch = `chunk-${i}:\\r\\n`;
      input += ch;
      batch.push(ch);
      if (i % 5000 === 4999) await wait(6);   // mimic natural turn boundaries
    }
    await settle();
    assert.strictEqual(c.text(), input, 'not one byte may be lost or reordered');
    // Coalesced output should be orders of magnitude below the chunk count.
    assert.ok(c.sends.length < 100, `expected << ${N} messages, got ${c.sends.length}`);
    console.log(`      info: ${N} chunks -> ${c.sends.length} ipc messages (${(N / c.sends.length).toFixed(0)}x fewer)`);
  });
});

Promise.all(jobs).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});