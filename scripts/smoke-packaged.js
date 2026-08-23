// Packaged-app smoke: launches the UNPACKED build (dist/<plat>-unpacked) in an
// isolated profile and proves the artifact users actually receive boots,
// exposes the preload bridge, answers basic IPC (including the native PTY
// layer from inside the asar unpack), and exits cleanly.
//   npm run pack && npm run smoke:packaged
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');

function packagedExe() {
  const over = process.env.TOTE_PACKED_EXE;
  if (over) return over;
  const candidates = {
    win32: path.join(ROOT, 'dist', 'win-unpacked', 'Tote.exe'),
    linux: path.join(ROOT, 'dist', 'linux-unpacked', 'tote'),
    darwin: (() => {
      const d = path.join(ROOT, 'dist');
      const mac = fs.readdirSync(d).find((n) => n.endsWith('.app'));
      return mac ? path.join(d, mac, 'Contents', 'MacOS', path.basename(mac, '.app')) : null;
    })(),
  };
  return candidates[process.platform] || null;
}

async function main() {
  const exe = packagedExe();
  if (!exe || !fs.existsSync(exe)) {
    console.error('smoke-packaged: no packaged build found - run `npm run pack` first.');
    process.exit(2);
  }
  console.log('smoke-packaged: launching', exe);

  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-pack-smoke-'));
  let profile;
  try { profile = (fs.realpathSync.native || fs.realpathSync)(raw); } catch { profile = raw; }

  // Seed the same safe defaults the E2E harness uses, so the packaged app
  // never touches the developer's real home or workspaces.
  const cfgDir = path.join(profile, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  const wsDir = path.join(profile, 'ws');
  fs.mkdirSync(wsDir, { recursive: true });
  const write = (n, o) => fs.writeFileSync(path.join(cfgDir, n), JSON.stringify(o, null, 2));
  write('workspaces.json', { active: 'global', list: [{ id: 'global', name: 'Global', path: wsDir }] });
  write('settings.json', { bridgeDownloads: false, setupDone: true, scratchRoot: path.join(profile, 'scratch') });
  write('providers.json', []);
  write('views.json', {});
  write('apps.json', { list: [], seeded: true });

  const app = await _electron.launch({
    executablePath: exe,
    args: [],
    env: { ...process.env, TOTE_USER_DATA_DIR: profile },
    timeout: 45000,
  });
  let failed = false;
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('#ws-tabs .ws-tab', { timeout: 20000 });
    console.log('  renderer booted');

    assert(await win.evaluate(() => typeof window.tote === 'object' && !!window.tote.getRoot),
      'preload bridge missing in packaged app');
    console.log('  preload bridge present');

    const root = await win.evaluate(() => tote.getRoot());
    if (norm(root) !== norm(wsDir)) throw new Error('workspace IPC mismatch: ' + root);
    console.log('  basic IPC works (getRoot round-trips the isolated workspace)');

    const pty = await win.evaluate(() => tote.ptyAvailable());
    if (!pty.ok) throw new Error('packaged node-pty unavailable: ' + (pty.hint || pty.error));
    console.log('  node-pty available from the packaged asar unpack');

    await app.close();
    console.log('smoke-packaged: ok - boot, bridge, IPC, PTY, clean exit all verified');
  } catch (e) {
    failed = true;
    try {
      fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
      const win = app.windows()[0];
      if (win) await win.screenshot({ path: path.join(ROOT, 'test-results', 'smoke-packaged.png') });
    } catch {}
    console.error('smoke-packaged FAILED:', e.message);
    try { await app.close(); } catch {}
  }
  process.exit(failed ? 1 : 0);
}

function norm(p) { return String(p || '').replace(/[\\/]+/g, '/').toLowerCase(); }
function assert(c, m) { if (!c) throw new Error(m); }

main().catch((e) => { console.error('smoke-packaged crashed:', e); process.exit(1); });
