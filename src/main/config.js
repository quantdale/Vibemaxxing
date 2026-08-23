// Config store: seeds defaults into userData on first run, so users can
// edit providers / CLI profiles / workspaces / apps without touching source.
//
// Every write is transactional: the payload is serialized first (a bad value
// fails before any IO), written + fsynced to a sibling temporary file, and
// only then renamed over the live file — so a crash mid-write can never leave
// truncated JSON where valid state used to be. The previous good version is
// kept as <name>.bak, and stale temporaries from crashed runs are swept.
const fs = require('fs');
const path = require('path');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config');
const FILES = ['providers.json', 'cli-profiles.json', 'workspaces.json', 'apps.json', 'settings.json', 'views.json'];
const TMP_SUFFIX = '.tmp-';
const STALE_TMP_MS = 24 * 3600 * 1000;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Read a JSON file, falling back on any error. A file that exists but does not
// PARSE is user state worth keeping around, so it is backed up once (timestamped
// so repeated failures never overwrite each other) before the fallback is used.
function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e instanceof SyntaxError && fs.existsSync(file)) {
      const bak = file + '.bak-' + Date.now();
      try { fs.copyFileSync(file, bak); } catch {}
      console.error('[tote] malformed JSON in', file, '— backed up to', bak, '; using defaults.');
    }
    return fallback;
  }
}

// Remove <name>.tmp-* siblings left behind by a crash between tmp creation and
// rename. Only files older than maxAge are touched — a concurrent writer's
// brand-new temp must not be pulled out from under it. Returns count removed.
function cleanStaleTemps(dir, now = Date.now(), maxAge = STALE_TMP_MS) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.includes(TMP_SUFFIX)) continue;
    const p = path.join(dir, name);
    try {
      if (now - fs.statSync(p).mtimeMs > maxAge) {
        fs.rmSync(p, { force: true });
        removed++;
      }
    } catch {} // raced with another sweeper or already gone
  }
  return removed;
}

// Durable JSON write. Throws on unserializable input WITHOUT touching the
// destination; otherwise the destination is replaced only after a complete,
// flushed temporary file exists. Retries the rename briefly — Windows AV and
// indexers hold files open for fractions of a second.
function writeJsonAtomic(file, data, opts = {}) {
  const json = JSON.stringify(data, null, 2);   // may throw: no IO has happened yet
  const tmp = `${file}${TMP_SUFFIX}${process.pid}-${Math.random().toString(36).slice(2)}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!opts.noBackup) {
    try { fs.copyFileSync(file, file + '.bak'); } catch {}   // first write: no previous copy
  }
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return file;
    } catch (e) {
      lastErr = e;
      sleepSync(25 * (attempt + 1));
    }
  }
  try { fs.rmSync(tmp, { force: true }); } catch {}
  throw lastErr;
}

class ConfigStore {
  constructor(app) {
    this.dir = path.join(app.getPath('userData'), 'config');
    fs.mkdirSync(this.dir, { recursive: true });
    cleanStaleTemps(this.dir);
    for (const name of FILES) {
      const target = path.join(this.dir, name);
      if (!fs.existsSync(target)) {
        fs.copyFileSync(path.join(DEFAULTS_DIR, name), target);
      }
    }
  }

  getDir() {
    return this.dir;
  }

  read(name, fallback) {
    return readJsonSafe(path.join(this.dir, name), fallback);
  }

  write(name, data) {
    writeJsonAtomic(path.join(this.dir, name), data);
  }

  getProviders() { return this.read('providers.json', []); }
  saveProviders(list) { this.write('providers.json', list); }

  getCliProfiles() { return this.read('cli-profiles.json', []); }
  saveCliProfiles(list) { this.write('cli-profiles.json', list); }

  getWorkspaces() { return this.read('workspaces.json', { active: 'global', list: [] }); }
  saveWorkspaces(data) { this.write('workspaces.json', data); }

  getApps() { return this.read('apps.json', { list: [] }); }
  saveApps(data) { this.write('apps.json', data); }

  getSettings() { return this.read('settings.json', { bridgeDownloads: true }); }
  saveSettings(data) { this.write('settings.json', data); }

  // Per-workspace open views: { [wsId]: { tabs: [{id, providerId}],
  // groups: [{ id, name, tree, focus, zoom }], activeGroup, filesRatio } }
  getViews() { return this.read('views.json', {}); }
  saveViews(data) { this.write('views.json', data); }
}

module.exports = { ConfigStore, writeJsonAtomic, readJsonSafe, cleanStaleTemps };
