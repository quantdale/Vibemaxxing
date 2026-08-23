// E2E harness: launches the REAL Electron app (playwright-core's _electron
// driver) against an isolated throwaway profile. Nothing here can touch the
// developer's real Tote state: userData is redirected via TOTE_USER_DATA_DIR
// (a main-process test hook with zero effect on normal launches), the Global
// workspace is pointed inside the sandbox, and the only provider is the local
// fixture server.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron } = require('playwright-core');
const { startFixture } = require('./fixture.js');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULTS = path.join(ROOT, 'config');

// Seed an isolated profile directory (idempotent): userData config that keeps
// every path Tote might write to inside the sandbox next to it.
function makeProfile(profileDir, fixtureUrl) {
  const cfgDir = path.join(profileDir, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });

  const globalWs = path.join(path.dirname(profileDir), 'global-ws');
  fs.mkdirSync(globalWs, { recursive: true });
  fs.mkdirSync(path.join(globalWs, 'inbox'), { recursive: true });

  const seed = (name, obj) => {
    const p = path.join(cfgDir, name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  };

  seed('providers.json', [
    { id: 'fixture', name: 'Fixture', url: fixtureUrl, color: '#4ade80' },
  ]);
  seed('workspaces.json', {
    active: 'global',
    list: [{ id: 'global', name: 'Global', path: globalWs }],
  });
  seed('settings.json', {
    bridgeDownloads: false,
    setupDone: true,
    scratchRoot: path.join(path.dirname(profileDir), 'scratch'),
    scratchDays: 7,
  });
  seed('views.json', {});
  seed('apps.json', { list: [], seeded: true });
  const profiles = path.join(cfgDir, 'cli-profiles.json');
  if (!fs.existsSync(profiles)) {
    fs.copyFileSync(path.join(DEFAULTS, 'cli-profiles.json'), profiles);
  }
  return { profile: profileDir, globalWs };
}

async function launchTote(opts = {}) {
  // realpath(.native): on Windows os.tmpdir() can hand back an 8.3 short path
  // (MICHAE~1) while shells print the long form — canonicalize once here.
  const rawSandbox = opts.sandbox || fs.mkdtempSync(path.join(os.tmpdir(), 'tote-e2e-'));
  let sandbox;
  try { sandbox = (fs.realpathSync.native || fs.realpathSync)(rawSandbox); } catch { sandbox = rawSandbox; }
  const ownsFixture = !opts.fixture;
  const fixture = opts.fixture || (await startFixture());
  const seeded = makeProfile(opts.profile || path.join(sandbox, 'profile'), fixture.url);
  // Tests may tweak config between makeProfile and launch (e.g. corrupt it).
  if (opts.beforeLaunch) opts.beforeLaunch(seeded);

  const app = await _electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: {
      ...process.env,
      TOTE_USER_DATA_DIR: seeded.profile,
      ...(opts.extraEnv || {}),
    },
    timeout: opts.timeout || 45000,
  });

  const win = await app.firstWindow();
  win.on('pageerror', (err) => {
    app.__pageErrors = app.__pageErrors || [];
    app.__pageErrors.push(String(err));
  });

  return {
    app,
    win,
    fixture,
    profile: seeded.profile,
    globalWs: seeded.globalWs,
    sandbox,
    async close() {
      try { await app.close(); } catch {}
      if (ownsFixture) { try { await fixture.close(); } catch {} }
    },
  };
}

// Wait until the workspace strip has rendered — the renderer finished booting.
async function waitBoot(win) {
  await win.waitForSelector('#ws-tabs .ws-tab', { timeout: 20000 });
}

// Install event taps in the page so tests can assert on IPC traffic.
async function tapEvents(win) {
  await win.evaluate(() => {
    window.__dl = [];
    window.__ptyData = '';
    window.__ptyExits = [];
    tote.onDownloadDone((m) => window.__dl.push(m));
    tote.onPtyData((id, d) => { window.__ptyData += d; });
    tote.onPtyExit((id) => window.__ptyExits.push(id));
  });
}

/* ----- tiny assertion helpers (same style as the other suites) ----- */
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error((msg || 'not equal') + `\n  got:  ${ja}\n  want: ${jb}`);
}

const normPath = (p) => String(p || '').replace(/[\\/]+/g, '/').toLowerCase();

module.exports = { launchTote, waitBoot, tapEvents, assert, eq, normPath, REPORT_BYTES: require('./fixture.js').REPORT_BYTES };
