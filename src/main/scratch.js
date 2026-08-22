// Pure decisions for temp ("scratch") spaces: naming, collision suffixes,
// containment and expiry. No fs, no electron -- the filesystem work lives in
// WorkspaceManager and the decisions live here, because this is the one
// feature in Tote that deletes user files and it has to be testable.
const path = require('path');

// Folder-safe form of a user-typed name. '' means "nothing usable left", which
// callers must treat as a rejected name rather than a fallback.
function slug(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// scratch-YYYY-MM-DD-N, N being the lowest free integer for that day. Local
// time, not UTC: the name should match the day the user thinks it is.
function defaultName(now, taken) {
  const d = now instanceof Date ? now : new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const day = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const used = new Set(taken || []);
  for (let n = 1; ; n++) {
    const candidate = 'scratch-' + day + '-' + n;
    if (!used.has(candidate)) return candidate;
  }
}

// First free folder name: base, then base-2, base-3, ...
function uniqueDirName(base, exists) {
  if (!exists(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = base + '-' + n;
    if (!exists(candidate)) return candidate;
  }
}

// Strictly inside: the root itself is not inside itself, and a sibling that
// merely shares the prefix (scratch-evil vs scratch) is not inside either.
// Callers pass realpaths -- resolving symlinks is theirs, comparing is ours.
// On Windows (and macOS HFS+), paths are case-insensitive: drive letters and
// segments returned by different APIs can differ in casing, so we normalise
// before comparing.  path.relative handles the separator and prefix logic.
function isInsideRoot(abs, root) {
  const a = path.resolve(abs);
  const r = path.resolve(root);
  // Case-insensitive on Windows; macOS is almost always case-insensitive too,
  // but callers already resolve through realpathSync which normalises casing.
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  const rel = path.relative(ci ? r.toLowerCase() : r, ci ? a.toLowerCase() : a);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// A missing lastUsed never expires, and days <= 0 disables the sweep rather
// than expiring everything: both failure modes must fail towards keeping files.
function isExpired(lastUsed, days, now = Date.now()) {
  if (!Number.isFinite(days) || days <= 0) return false;
  if (!Number.isFinite(lastUsed)) return false;
  return now - lastUsed > days * 86400000;
}

module.exports = { slug, defaultName, uniqueDirName, isInsideRoot, isExpired };
