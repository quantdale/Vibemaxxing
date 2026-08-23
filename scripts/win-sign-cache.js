// Repair electron-builder's winCodeSign cache on Windows.
//
// Why this exists: on a fresh Windows machine, `electron-builder` (pack/dist)
// downloads winCodeSign-<v>.7z and extracts it with 7za. The archive contains
// two macOS dylib *symlinks* (darwin/10.12/lib/libcrypto.dylib + libssl.dylib)
// that Windows refuses to create without Developer Mode or admin rights. The
// extraction then fails, electron-builder retries forever and packaging dies -
// even though those two symlinks are never used for Windows builds and the
// files Windows actually needs (rcedit-*.exe) extracted fine.
//
// Fix strategy: if the cache holds a usable `winCodeSign-*` directory, do
// nothing. Otherwise reuse the archive a failed attempt left behind (or fetch
// the pinned upstream version), extract it tolerating symlink errors, install
// it under the name electron-builder expects and verify rcedit landed. If any
// of that is impossible, say exactly what to do instead of failing silently.
// Never requires elevation; never touches anything outside the builder cache.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// electron-builder has embedded winCodeSign 2.6.0 since 2019 (still current in
// v25/26). Only used to fetch the archive when no failed-attempt copy exists;
// the result is verified before claiming success.
const WINCODESIGN_VERSION = '2.6.0';
const DOWNLOAD_BASE =
  'https://github.com/electron-userland/electron-builder-binaries/releases/download';

function cacheRoot() {
  const base =
    process.env.ELECTRON_BUILDER_CACHE ||
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'electron-builder',
      'Cache',
    );
  return path.join(base, 'winCodeSign');
}

function dirHasRcedit(dir) {
  return (
    fs.existsSync(path.join(dir, 'rcedit-x64.exe')) ||
    fs.existsSync(path.join(dir, 'rcedit-ia32.exe'))
  );
}

// -> { status: 'ok' | 'repairable' | 'missing', root, finalDir?, archive? }
//    ok:         usable cache already present
//    repairable: an orphaned .7z from a failed attempt can be installed
//    missing:    nothing to work with; caller may download the archive
function classify(root = cacheRoot()) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { status: 'missing', root };
  }
  const finalDir = entries.find(
    (e) => e.isDirectory() && /^winCodeSign-\d+\.\d+\.\d+$/.test(e.name),
  );
  if (finalDir && dirHasRcedit(path.join(root, finalDir.name))) {
    return { status: 'ok', root, finalDir: path.join(root, finalDir.name) };
  }
  const archives = entries
    .filter((e) => e.isFile() && e.name.endsWith('.7z'))
    .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(root, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (archives.length > 0) {
    return { status: 'repairable', root, archive: path.join(root, archives[0].name) };
  }
  return { status: 'missing', root };
}

// Extract `archive` tolerating the two darwin-symlink sub-item errors, then
// move the payload into place as `finalDir`. Returns null on success or a
// human-readable reason.
function installFromArchive(archive, root, finalDirName, sevenZip) {
  const staging = path.join(root, '.repair-' + Date.now());
  fs.mkdirSync(staging, { recursive: true });
  try {
    // -y overwrite; -snld stores links as-is where possible. The two darwin
    // symlinks still fail unprivileged; 7za exits non-zero but every regular
    // file is already on disk, which is all Windows builds consume. We verify
    // content instead of trusting the exit code.
    const { execFileSync } = require('child_process');
    try {
      execFileSync(sevenZip, ['x', '-y', '-snld', archive, '-o' + staging], {
        stdio: 'ignore',
      });
    } catch {
      // expected when symlinks were refused; verified below instead
    }
    if (!dirHasRcedit(staging)) {
      return 'extracted archive has no rcedit binaries - not a winCodeSign payload';
    }
    const finalDir = path.join(root, finalDirName);
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(staging, finalDir);
    return null;
  } catch (e) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {}
    return e.message;
  }
}

module.exports = {
  WINCODESIGN_VERSION,
  DOWNLOAD_BASE,
  cacheRoot,
  classify,
  installFromArchive,
  dirHasRcedit,
};

if (require.main === module) {
  const sevenZip = path.join(
    __dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe',
  );
  if (!fs.existsSync(sevenZip)) {
    console.error('win-sign-cache: 7za not found at ' + sevenZip + ' - run npm install first.');
    process.exit(2);
  }
  if (process.platform !== 'win32') {
    console.log('win-sign-cache: not Windows, nothing to do.');
    process.exit(0);
  }
  const state = classify();
  if (state.status === 'ok') {
    console.log('win-sign-cache: ok (' + state.finalDir + ')');
    process.exit(0);
  }
  fs.mkdirSync(state.root, { recursive: true });
  const finalName = `winCodeSign-${WINCODESIGN_VERSION}`;
  let archive = state.archive;
  if (!archive) {
    archive = path.join(state.root, `${finalName}.7z`);
    const url = `${DOWNLOAD_BASE}/${finalName}/${finalName}.7z`;
    console.log('win-sign-cache: downloading ' + url);
    download(url, archive)
      .then(() => finish(archive, state.root, finalName, sevenZip))
      .catch((e) => {
        console.error('win-sign-cache: download failed: ' + e.message);
        process.exit(1);
      });
    return;
  }
  finish(archive, state.root, finalName, sevenZip);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (u) => {
      const mod = u.startsWith('http://') ? require('http') : require('https');
      const req = mod.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          get(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      });
      req.on('error', reject);
    };
    get(url);
  });
}

function finish(archive, root, finalName, sevenZip) {
  const err = installFromArchive(archive, root, finalName, sevenZip);
  if (err) {
    console.error('win-sign-cache: repair failed: ' + err);
    console.error(
      'Manual fix: enable Windows Developer Mode (Settings > Privacy & security > For developers),\n' +
      'or run one packaging command from an elevated prompt once so the cache is extracted.',
    );
    process.exit(1);
  }
  console.log('win-sign-cache: repaired -> ' + path.join(root, finalName));
}
