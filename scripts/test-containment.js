// Workspace path containment: renderer-relative paths must never resolve
// outside the real active workspace root — through '..', absolute input, or a
// symlink/junction planted inside the workspace. Pure Node against throwaway
// folders; junctions are used on Windows because they need no elevation.
// Run by `npm test`.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { WorkspaceManager } = require('../src/main/workspace.js');

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

function freshRoot(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-ws-' + tag + '-'));
  return path.join(base, 'ws');
}

// A WorkspaceManager pointed at an explicit folder, with none of Electron.
function managerAt(root, settings = {}) {
  const cfg = {
    getWorkspaces: () => ({ active: 'ws', list: [{ id: 'ws', name: 'WS', path: root }] }),
    getSettings: () => settings,
  };
  return new WorkspaceManager(cfg);
}

// Escape link INSIDE the workspace pointing OUTSIDE it. Junctions on Windows
// (no privilege needed, directories only); symlinks elsewhere.
function plantEscapeLink(insideWs, outsideDir) {
  const link = path.join(insideWs, 'escape');
  try {
    if (process.platform === 'win32') {
      // junction: directory link, unprivileged
      fs.symlinkSync(outsideDir, link, 'junction');
    } else {
      fs.symlinkSync(outsideDir, link, 'directory');
    }
  } catch (e) {
    return null; // caller skips the case; platform truly forbids it
  }
  return link;
}

async function main() {

describe('lexical containment')

await test('.. climbs out and is refused for read and write', async () => {
  const root = freshRoot('dots');
  const m = managerAt(root);
  const outside = path.join(path.dirname(root), 'outside.txt');
  fs.writeFileSync(outside, 'secret');
  let threw = false;
  try { m.readText('../outside.txt'); } catch { threw = true; }
  assert(threw, 'readText(..) must refuse');
  threw = false;
  try { m.writeText('../../pwned.txt', 'x'); } catch { threw = true; }
  assert(threw, 'writeText(..) must refuse');
  assert(!fs.existsSync(path.join(path.dirname(root), 'pwned.txt')), 'nothing written outside');
});

await test('absolute paths are refused', async () => {
  const m = managerAt(freshRoot('abs'));
  for (const rel of ['C:\\Windows\\notepad.exe', '/etc/passwd']) {
    let threw = false;
    try { m.readText(rel); } catch { threw = true; }
    assert(threw, 'absolute input must refuse: ' + rel);
  }
});

await test('nested traversal inside a legal subfolder is still caught', async () => {
  const root = freshRoot('nest');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  const m = managerAt(root);
  let threw = false;
  try { m.readText('sub/../../escape.txt'); } catch { threw = true; }
  assert(threw);
});

await test('the workspace root itself stays addressable', async () => {
  const root = freshRoot('self');
  const m = managerAt(root);
  assert(m.resolveSafe('.') === path.resolve(root));
});

describe('legitimate creation preserved')

await test('creating a nested file that does not exist yet works', async () => {
  const root = freshRoot('create');
  const m = managerAt(root);
  m.createFile('new/deep/file.txt');
  assert(fs.readFileSync(path.join(root, 'new', 'deep', 'file.txt'), 'utf8') === '');
  m.writeText('new/deep/file.txt', 'hello');
  assert(m.readText('new\\deep\\file.txt') === 'hello', 'mixed separators read back');
});

await test('case-insensitive platforms accept casing variants of real files', async () => {
  if (process.platform !== 'win32') return;
  const root = freshRoot('case');
  const m = managerAt(root);
  m.createFile('lower.txt');
  assert(m.readText('LOWER.TXT') === '', 'casing variant resolves to same file');
});

describe('symlink / junction escape')

await test('reads and writes THROUGH an escape link are refused, target untouched', async () => {
  const root = freshRoot('esc1');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not touch');
  fs.mkdirSync(root, { recursive: true });
  const m = managerAt(root);
  if (!plantEscapeLink(root, outside)) return console.log('  (skip: platform refuses link creation)');
  let threw = false;
  try { m.readText('escape/secret.txt'); } catch { threw = true; }
  assert(threw, 'reading through the link must refuse');
  threw = false;
  try { m.writeText('escape/planted.txt', 'x'); } catch { threw = true; }
  assert(threw, 'writing through the link must refuse');
  assert(!fs.existsSync(path.join(outside, 'planted.txt')), 'target got NO new file');
  assert(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8') === 'do not touch');
});

await test('creation through a nonexistent path under an escape link is refused', async () => {
  const root = freshRoot('esc2');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-outside-'));
  fs.mkdirSync(root, { recursive: true });
  const m = managerAt(root);
  if (!plantEscapeLink(root, outside)) return console.log('  (skip: platform refuses link creation)');
  let threw = false;
  try { m.createFolder('escape/newdir'); } catch { threw = true; }
  assert(threw, 'createFolder under escape link must refuse');
  assert(!fs.existsSync(path.join(outside, 'newdir')), 'nothing created at the target');
  threw = false;
  try { m.createFile('escape/newfile.txt'); } catch { threw = true; }
  assert(threw, 'createFile under escape link must refuse');
});

await test('rename across the boundary is refused in both directions', async () => {
  const root = freshRoot('esc3');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-outside-'));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'in.txt'), 'x');
  fs.writeFileSync(path.join(outside, 'out.txt'), 'y');
  const m = managerAt(root);
  if (!plantEscapeLink(root, outside)) return console.log('  (skip: platform refuses link creation)');
  let threw = false;
  try { m.rename('in.txt', 'escape/moved-in.bin'); } catch { threw = true; }
  assert(threw, 'rename INTO the linked tree must refuse');
  threw = false;
  try { m.rename('escape/out.txt', 'smuggled.txt'); } catch { threw = true; }
  assert(threw, 'rename FROM the linked tree must refuse');
});

await test('trash/reveal/open/sendFile go through the same guard', async () => {
  const root = freshRoot('esc4');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-outside-'));
  fs.mkdirSync(root, { recursive: true });
  const m = managerAt(root);
  if (!plantEscapeLink(root, outside)) return console.log('  (skip: platform refuses link creation)');
  for (const rel of ['escape/anything.txt', 'escape/sub/x']) {
    let threw = false;
    try { m.resolveSafe(rel); } catch { threw = true; }
    assert(threw, 'resolveSafe must refuse ' + rel);
  }
});

await test('a link pointing ELSEWHERE INSIDE the workspace stays allowed', async () => {
  const root = freshRoot('inside');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'note.txt'), 'internal');
  const m = managerAt(root);
  const alias = path.join(root, 'alias');
  try {
    if (process.platform === 'win32') fs.symlinkSync(path.join(root, 'docs'), alias, 'junction');
    else fs.symlinkSync(path.join(root, 'docs'), alias, 'directory');
  } catch {
    return console.log('  (skip: platform refuses link creation)');
  }
  assert(m.readText('alias/note.txt') === 'internal', 'internal links remain usable');
});

describe('root behind a symlink')

await test('workspace reached via an aliased path keeps containment semantics', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-rootlink-'));
  const realDir = path.join(base, 'real');
  const alias = path.join(base, 'alias');
  fs.mkdirSync(realDir, { recursive: true });
  try {
    if (process.platform === 'win32') fs.symlinkSync(realDir, alias, 'junction');
    else fs.symlinkSync(realDir, alias, 'directory');
  } catch {
    return console.log('  (skip: platform refuses link creation)');
  }
  fs.writeFileSync(path.join(realDir, 'f.txt'), 'via alias');
  const m = managerAt(alias);
  assert(m.readText('f.txt') === 'via alias', 'ops work through the aliased root');
  let threw = false;
  try { m.readText('../real/../outside.txt'); } catch { threw = true; }
  assert(threw, 'traversal out of the aliased root is refused');
  threw = false;
  try { m.readText('../alias-sibling.txt'); } catch { threw = true; }
  assert(threw);
});

describe('inbox routing hardening')

await test('provider ids cannot contain path separators', async () => {
  const m = managerAt(freshRoot('prov'));
  let threw = false;
  try { m.inboxDir('../evil'); } catch { threw = true; }
  assert(threw, 'separator-bearing provider id must refuse');
  assert(m.inboxDir('kimi').endsWith(path.join('inbox', 'kimi')), 'plain slug ids stay fine');
  assert(m.inboxDir('_desktop').endsWith(path.join('inbox', '_desktop')));
});

}

main().then(() => {
  let pass = 0, fail = 0;
  for (const [status, g, name] of results) {
    if (status === 'ok') { pass++; console.log(`  \x1b[32m✓\x1b[0m ${g} — ${name}`); }
    else { fail++; console.log(`\n  \x1b[31m✗\x1b[0m ${g} — ${name}\n`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
