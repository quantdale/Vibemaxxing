// Tote E2E: drives the REAL Electron app (renderer → preload → IPC → main →
// filesystem / PTY / webviews → persistence) against an isolated profile and a
// local fixture provider. No live LLM site, no external network.
//   npm run test:e2e
// Failure artifacts: test-results/<test-name>.png
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFixture, REPORT_BYTES } = require('./e2e/fixture.js');
const { launchTote, waitBoot, tapEvents, assert, eq, normPath } = require('./e2e/harness.js');

const results = [];
let group = '';
let currentCtx = null;

function describe(name) { group = name; }
async function test(name, fn) {
  const t0 = Date.now();
  currentCtx = null;
  try {
    await fn();
    results.push(['ok', group, name, Date.now() - t0]);
  } catch (e) {
    let extra = '';
    if (currentCtx && currentCtx.app.__pageErrors && currentCtx.app.__pageErrors.length) {
      extra = '\n    page errors: ' + currentCtx.app.__pageErrors.join(' | ').slice(0, 500);
      await screenshot(currentCtx, name);
    } else if (currentCtx) {
      await screenshot(currentCtx, name);
    }
    results.push(['FAIL', group, name + ' — ' + (e && e.message) + extra, Date.now() - t0]);
  } finally {
    currentCtx = null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, label, timeoutMs = 15000, step = 120) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = await fn(); } catch {}   // transient (page navigating, element mid-swap)
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error('timeout: ' + label);
    await sleep(step);
  }
}

async function screenshot(ctx, name) {
  try {
    fs.mkdirSync(path.join(__dirname, '..', 'test-results'), { recursive: true });
    const win = ctx.app.windows()[0];
    if (win) {
      await win.screenshot({ path: path.join(__dirname, '..', 'test-results', name.replace(/[^\w-]+/g, '_') + '.png') });
    }
  } catch {}
}

/* ----- shared UI helpers ----- */

async function openFixturePane(win) {
  await win.click('#btn-add-tab');
  await win.click('#tab-add-menu .term-menu-item');   // seeded profile has exactly one provider
  await until(async () => {
    const t = await win.evaluate(() => {
      const wv = document.querySelector('webview');
      return wv ? wv.getTitle() : '';
    });
    return t.includes('Fixture Home');
  }, 'fixture page loaded in webview');
}

async function spawnPlainShell(win) {
  await win.click('#btn-new-term');
  await until(async () =>
    win.evaluate(() => [...document.querySelectorAll('#term-menu .term-menu-item')]
      .some((i) => i.textContent.includes('Plain Shell'))),
    'term menu populated');
  await win.evaluate(() => {
    const item = [...document.querySelectorAll('#term-menu .term-menu-item')]
      .find((i) => i.textContent.includes('Plain Shell'));
    item.click();
  });
  await until(async () => win.evaluate(() =>
    [...document.querySelectorAll('.pane')].some((p) => p.title && p.title.includes('cwd'))),
    'terminal pane reports its cwd',
  );
}

async function switchAndWait(win, toteFn, expectFragment, label) {
  await win.evaluate(toteFn);
  await until(async () => normPath(await win.evaluate(() => tote.getRoot())).includes(expectFragment), label);
}

const CWD_CMD = process.platform === 'win32' ? 'cd\r' : 'pwd\r';

// Workspace chips carry a glyph span; strip it for name comparisons.
const chipNames = (win) => win.evaluate(() =>
  [...document.querySelectorAll('#ws-tabs .ws-tab')].map((t) =>
    t.textContent.replace(/[◈◇◌]/g, '').trim()));

// Type the cwd command until its answer shows up in the PTY stream. Retrying
// covers the spawn race where keystrokes land between pane-title being set and
// term.onData being wired (they would otherwise vanish unheard).
async function typeUntilEchoed(win, root, label) {
  await until(async () => {
    await win.click('.xterm-screen');
    await win.keyboard.type(CWD_CMD);
    const data = await win.evaluate(() => window.__ptyData || '');
    return normPath(data).includes(normPath(root));
  }, label, 20000, 400);
}

async function main() {

describe('boot & persistence')

await test('fresh isolated profile boots to a usable renderer with seeded config', async () => {
  const ctx = currentCtx = await launchTote();
  try {
    await waitBoot(ctx.win);
    const chips = await ctx.win.evaluate(() =>
      [...document.querySelectorAll('#ws-tabs .ws-tab')].map((t) => ({
        name: t.textContent.replace(/[◈◇◌]/g, '').trim(), active: t.classList.contains('active'),
      })));
    eq(chips, [{ name: 'Global', active: true }]);
    for (const f of ['providers.json', 'workspaces.json', 'settings.json', 'views.json']) {
      assert(fs.existsSync(path.join(ctx.profile, 'config', f)), 'seeded: ' + f);
    }
    assert(await ctx.win.evaluate(() => typeof window.tote.getRoot === 'function'), 'window.tote bridge present');
    eq(normPath(await ctx.win.evaluate(() => tote.getRoot())), normPath(ctx.globalWs), 'basic IPC round-trip');
  } finally {
    await ctx.close();
  }
});

await test('restart restores durable state: tabs, groups and layout come back', async () => {
  const fixture = await startFixture();
  const first = currentCtx = await launchTote({ fixture });
  const profile = first.profile;
  try {
    await waitBoot(first.win);
    await tapEvents(first.win);
    await openFixturePane(first.win);
    await first.win.click('#btn-add-group');
    eq(await first.win.evaluate(() => document.querySelectorAll('.group-chip').length), 2,
      'two group chips after add');
    // addGroup activates the new (empty) group — switch back to the one that
    // holds the web pane so the restart has something to remount.
    await first.win.evaluate(() => {
      [...document.querySelectorAll('.group-chip')]
        .find((c) => c.textContent.trim() === '1').click();
    });
    // NO grace sleep: quit while the debounced save is still pending. The
    // beforeunload flush must land the state anyway.
  } finally {
    await first.app.close();   // keep the fixture alive for the relaunch
    await sleep(400);
  }

  const second = currentCtx = await launchTote({ fixture, profile });
  try {
    await waitBoot(second.win);
    const views = JSON.parse(fs.readFileSync(path.join(profile, 'config', 'views.json'), 'utf8'));
    const g = views.global;
    assert(g && g.tabs && g.tabs.length === 1, 'persisted web tab instance');
    assert(g.groups.length === 2, 'persisted two groups');
    await until(async () =>
      (await second.win.evaluate(() => document.querySelectorAll('.group-chip').length)) === 2,
      'group chips restored in UI');
    await until(async () => second.win.evaluate(() => !!document.querySelector('webview')),
      'webview remounted after restart');
  } finally {
    await second.close();
  }
});

await test('malformed views.json fails safe: boots with defaults and keeps a backup', async () => {
  const ctx = currentCtx = await launchTote({
    beforeLaunch: ({ profile }) => {
      fs.writeFileSync(path.join(profile, 'config', 'views.json'), '{"global": {"tabs": [ TRUNCATED');
    },
  });
  try {
    await waitBoot(ctx.win);   // boot survived the corruption
    const cfgDir = path.join(ctx.profile, 'config');
    assert(fs.readdirSync(cfgDir).some((n) => n.startsWith('views.json.bak-')), 'broken file backed up');
    eq(await ctx.win.evaluate(() => document.querySelectorAll('#ws-tabs .ws-tab').length), 1,
      'default workspace restored');
  } finally {
    await ctx.close();
  }
});

describe('workspace routing')

await test('temp workspace creation switches the active root and back again restores it', async () => {
  const ctx = currentCtx = await launchTote();
  try {
    await waitBoot(ctx.win);
    await tapEvents(ctx.win);
    await ctx.win.click('#btn-add-temp');
    await ctx.win.fill('#input-field', 'route-test');
    await ctx.win.click('#input-ok');
    await until(async () => (await chipNames(ctx.win)).includes('route-test'),
      'temp workspace chip appears');

    const bRoot = normPath(await ctx.win.evaluate(() => tote.getRoot()));
    assert(bRoot.includes('/scratch/route-test'), 'active root moved into scratch: ' + bRoot);

    // file ops apply to the ACTIVE workspace root
    await ctx.win.evaluate(() => tote.createFile('made-in-b.txt'));
    assert(fs.existsSync(path.join(bRoot, 'made-in-b.txt')), 'file landed in the active ws');

    // back to Global: root restores and B's files are not in Global's tree
    await ctx.win.evaluate(() => tote.setActiveWorkspace('global'));
    await until(async () =>
      normPath(await ctx.win.evaluate(() => tote.getRoot())) === normPath(ctx.globalWs),
      'root back on global');
    eq(await ctx.win.evaluate(() => tote.tree().then((t) => t.some((n) => n.name === 'made-in-b.txt'))),
      false, "B's files are not in Global's tree");
  } finally {
    await ctx.close();
  }
});

describe('real terminal path')

await test('PTY runs in the active workspace: input echoes, output returns, cwd matches, exit cleans up', async () => {
  const ctx = currentCtx = await launchTote();
  try {
    await waitBoot(ctx.win);
    await tapEvents(ctx.win);
    await spawnPlainShell(ctx.win);
    await ctx.win.click('.xterm-screen');
    await typeUntilEchoed(ctx.win, ctx.globalWs,
      'shell echoed a cwd matching the active workspace');

    const title = await ctx.win.evaluate(() =>
      [...document.querySelectorAll('.pane')].find((p) => p.title.includes('cwd')).title);
    assert(normPath(title).includes(normPath(ctx.globalWs)),
      'pane title shows the workspace cwd: ' + title);

    await ctx.win.keyboard.type('exit\r');
    await until(async () => (await ctx.win.evaluate(() => window.__ptyExits)).length >= 1,
      'pty exit event received');
  } finally {
    await ctx.close();
  }
});

await test('a terminal spawned after switching spaces uses the NEW root', async () => {
  const ctx = currentCtx = await launchTote();
  try {
    await waitBoot(ctx.win);
    await tapEvents(ctx.win);
    await switchAndWait(ctx.win,
      () => tote.wsAddTemp('term-b'), '/scratch/term-b', 'switched to term-b space');
    await spawnPlainShell(ctx.win);
    const bRoot = normPath(await ctx.win.evaluate(() => tote.getRoot()));
    await typeUntilEchoed(ctx.win, bRoot,
      'new terminal lives in the switched-to workspace');
  } finally {
    await ctx.close();
  }
});

describe('webview lifecycle & layout invariant')

await test('webview loads the fixture, updates the title, and keeps long-lived state', async () => {
  const ctx = currentCtx = await launchTote();
  try {
    await waitBoot(ctx.win);
    await openFixturePane(ctx.win);
    await until(async () => {
      const titles = await ctx.win.evaluate(() =>
        [...document.querySelectorAll('.pane-title')].map((t) => t.textContent));
      return titles.includes('Fixture Home');
    }, 'page title reached the pane header');

    await ctx.win.evaluate(() =>
      document.querySelector('webview').executeJavaScript(
        "localStorage.setItem('tote-e2e','survives'); 'ok'"));
    await ctx.win.evaluate(() =>
      document.querySelector('webview').executeJavaScript("location.href = '/two'"));
    await until(async () =>
      (await ctx.win.evaluate(() => document.querySelector('webview').getTitle())) === 'Fixture Page Two',
      'guest navigated to page two');
    eq(await ctx.win.evaluate(() =>
      document.querySelector('webview').executeJavaScript("localStorage.getItem('tote-e2e')")),
      'survives', 'guest localStorage persisted across navigation');
  } finally {
    await ctx.close();
  }
});

await test('the webview element is NEVER recreated by layout churn (no reparenting)', async () => {
  const ctx = currentCtx = await launchTote();
  try {
    await waitBoot(ctx.win);
    await tapEvents(ctx.win);
    await openFixturePane(ctx.win);
    await ctx.win.evaluate(() => {
      const wv = document.querySelector('webview');
      wv.dataset.e2e = 'keepme';
      window.__keptWv = wv;
    });

    // 1. split the surface with a terminal next to the web pane
    await spawnPlainShell(ctx.win);
    // 2. drag the divider between them
    const div = await ctx.win.evaluate(() => {
      const d = document.querySelector('.divider');
      if (!d) return null;
      const r = d.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    assert(div, 'a divider exists between the two panes');
    await ctx.win.mouse.move(div.x, div.y);
    await ctx.win.mouse.down();
    for (let i = 1; i <= 6; i++) await ctx.win.mouse.move(div.x - i * 18, div.y);
    await ctx.win.mouse.up();
    // 3. zoom + unzoom the focused pane
    const mod = process.platform === 'darwin' ? ['Meta', 'Alt'] : ['Control', 'Alt'];
    await ctx.win.keyboard.press(mod.concat(['f']).join('+'));
    await ctx.win.keyboard.press(mod.concat(['f']).join('+'));
    // 4. move focus left
    await ctx.win.keyboard.press(mod.concat(['ArrowLeft']).join('+'));
    // 5. the strongest churn: switch workspace away and back
    await switchAndWait(ctx.win, () => tote.wsAddTemp('churn'), '/churn', 'switched away');
    await ctx.win.evaluate(() => tote.setActiveWorkspace('global'));
    await until(async () => normPath(await ctx.win.evaluate(() => tote.getRoot())) === normPath(ctx.globalWs),
      'switched back');

    const verdict = await ctx.win.evaluate(() => {
      const cur = document.querySelector('webview[data-e2e="keepme"]');
      return { found: !!cur, sameElement: cur === window.__keptWv };
    });
    assert(verdict.found && verdict.sameElement,
      'webview must be the SAME element after split/drag/zoom/focus/workspace churn');
    const state1 = await ctx.win.evaluate(() =>
      document.querySelector('webview[data-e2e="keepme"]').executeJavaScript(
        "localStorage.getItem('tote-e2e') || (localStorage.setItem('tote-e2e','first-run'),'first-run')"));
    eq(state1, 'first-run', 'guest was never torn down and reloaded');
  } finally {
    await ctx.close();
  }
});

describe('download routing')

await test('a real download lands in <ACTIVE workspace>/inbox/<provider>/ resolved at event time', async () => {
  const ctx = currentCtx = await launchTote();
  try {
    await waitBoot(ctx.win);
    await tapEvents(ctx.win);
    await openFixturePane(ctx.win);

    // activate a SECOND space right before triggering the download: routing
    // must resolve at event time, not pane-creation time
    await switchAndWait(ctx.win, () => tote.wsAddTemp('dl-target'), '/dl-target',
      'second space is active');
    const bRoot = normPath(await ctx.win.evaluate(() => tote.getRoot()));

    await ctx.win.evaluate(() =>
      document.querySelector('webview').executeJavaScript(
        'document.getElementById("dl").click()'));
    await until(async () => {
      const dl = await ctx.win.evaluate(() => window.__dl);
      return dl.length && dl[0].state === 'completed';
    }, 'download:done(completed) received');
    const msg = (await ctx.win.evaluate(() => window.__dl))[0];
    assert(normPath(msg.path).includes('/inbox/fixture/report.bin'),
      'landed under inbox/<provider>/: ' + msg.path);
    assert(normPath(msg.path).startsWith(bRoot), 'landed in the space ACTIVE AT EVENT TIME');
    assert(fs.readFileSync(msg.path).equals(REPORT_BYTES), 'exact bytes arrived');
  } finally {
    await ctx.close();
  }
});

describe('upload & popup paths')

await test('file upload input works inside the guest', async () => {
  const ctx = currentCtx = await launchTote();
  try {
    await waitBoot(ctx.win);
    await openFixturePane(ctx.win);
    const name = await ctx.win.evaluate(() => {
      const wv = document.querySelector('webview');
      return wv.executeJavaScript(`(async () => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([1,2,3,4])], 'e2e-upload.bin'));
        const input = document.getElementById('file-input');
        input.files = dt.files;
        return input.files[0].name;
      })()`);
    });
    eq(name, 'e2e-upload.bin', 'file attached to the upload input');
    await ctx.win.evaluate(() =>
      document.querySelector('webview').executeJavaScript('document.getElementById("up").submit()'));
    await until(async () =>
      (await ctx.win.evaluate(() => document.querySelector('webview').getTitle())) === 'Upload OK',
      'upload round-tripped through the fixture server');
    await until(async () => ctx.fixture.uploads().includes('e2e-upload.bin'),
      'server recorded the upload');
  } finally {
    await ctx.close();
  }
});

describe('setup & system health')

await test('setup:systemCheck reaches syscheck through the real bridge without exceptions', async () => {
  const ctx = currentCtx = await launchTote();
  try {
    await waitBoot(ctx.win);
    const check = await ctx.win.evaluate(() => tote.systemCheck());
    assert(check && check.pty, 'systemCheck returned a pty section');
    eq(check.pty.ok, true, 'node-pty reported available in-app');
    assert(typeof check.node === 'string' && check.homeWritable === true, 'sane system payload');
  } finally {
    await ctx.close();
  }
});

await test('first-run profile opens the setup wizard and renders system rows', async () => {
  const ctx = currentCtx = await launchTote({
    beforeLaunch: ({ profile }) => {
      const f = path.join(profile, 'config', 'settings.json');
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      s.setupDone = false;
      fs.writeFileSync(f, JSON.stringify(s, null, 2));
    },
  });
  try {
    await waitBoot(ctx.win);
    await until(async () =>
      !(await ctx.win.evaluate(() => document.getElementById('wizard-modal').classList.contains('hidden'))),
      'wizard auto-opened on first run');
    await until(async () =>
      (await ctx.win.evaluate(() => document.getElementById('wz-system').children.length)) > 0,
      'system rows rendered');
    const text = await ctx.win.evaluate(() =>
      document.getElementById('wz-system').textContent.toLowerCase());
    assert(text.includes('node'), 'system rows mention node: ' + text.slice(0, 120));
  } finally {
    await ctx.close();
  }
});

}

main().then(finish, (e) => { console.error('E2E harness crashed:', e); process.exit(1); });

function finish() {
  let pass = 0, fail = 0;
  for (const [status, g, name, ms] of results) {
    if (status === 'ok') { pass++; console.log(`  \x1b[32m✓\x1b[0m ${g} — ${name} (${ms}ms)`); }
    else { fail++; console.log(`\n  \x1b[31m✗\x1b[0m ${g} — ${name}\n`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
