# Tote bootstrap for Windows. Equivalent of scripts/install.sh.
# Checks prerequisites, installs dependencies from the lockfile, repairs the
# electron-builder cache if needed, sanity-checks the terminal layer and
# optionally launches the app.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -NoLaunch
#
# Safe to re-run (idempotent). Never elevates; never installs toolchains.
#Requires -Version 5.1
param(
  [switch]$NoLaunch = $false
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$script:hadFailure = $false

function Write-Step($msg)   { Write-Host "== $msg" -ForegroundColor Cyan }
function Write-Ok($msg)     { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Skip($msg)   { Write-Host "  --  $msg" -ForegroundColor Yellow }
function Write-Bad($msg) {
  Write-Host "  !!  $msg" -ForegroundColor Red
  $script:hadFailure = $true
}

Write-Step "Tote setup (Windows)"

# --- supported environment -------------------------------------------------
if ($env:OS -ne 'Windows_NT') {
  Write-Bad "This script targets Windows. On Linux/macOS run: ./scripts/install.sh"
  exit 1
}

# --- Node.js ----------------------------------------------------------------
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Bad "Node.js not found. Install Node.js 20+ LTS from https://nodejs.org (the MSI adds it to PATH), then re-run."
  exit 1
}
$nodeVer = (& node -v).Trim()
$nodeMajor = 0
if ($nodeVer -match '^v(\d+)') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 20) {
  Write-Bad "Node.js 20+ required, found $nodeVer. Upgrade from https://nodejs.org, then re-run."
  exit 1
}
Write-Ok "node $nodeVer"

# --- npm --------------------------------------------------------------------
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  Write-Bad "npm not found - it ships with Node.js. Reinstall Node.js and reopen this window."
  exit 1
}
$npmVer = (& npm.cmd -v).Trim()
Write-Ok "npm $npmVer"

# --- git (warning only: the app runs without it) -----------------------------
if (Get-Command git.exe -ErrorAction SilentlyContinue) {
  Write-Ok "git $((& git --version).Trim() -replace '^git ','')"
} else {
  Write-Skip "git not found - Tote runs without it, but project workspaces and most CLI agents expect it. Install from https://git-scm.com."
}

# --- writable home ----------------------------------------------------------
$probe = Join-Path $env:USERPROFILE '.tote-write-test'
try {
  Set-Content -LiteralPath $probe -Value 'x' -Encoding Ascii
  Remove-Item -LiteralPath $probe -Force
  Write-Ok "home folder writable ($env:USERPROFILE)"
} catch {
  Write-Bad "home folder not writable: $($_.Exception.Message)"
}

# --- dependencies ------------------------------------------------------------
Write-Step "installing dependencies (npm ci, from package-lock.json)"
& npm.cmd ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
  Write-Bad "npm ci failed (exit $LASTEXITCODE). Check your network/proxy and re-run; delete node_modules first if the tree looks broken."
  exit 1
}
Write-Ok "dependencies installed"

# --- vendored renderer assets (postinstall should have made these) ----------
foreach ($f in @('xterm.js', 'xterm.css', 'addon-fit.js')) {
  $p = Join-Path $repoRoot "src\renderer\vendor\$f"
  if (Test-Path $p) { Write-Ok "vendored $f" } else { Write-Bad "missing src\renderer\vendor\$f - run: node scripts/copy-vendor.js" }
}

# --- electron-builder winCodeSign cache (packaging only) ---------------------
# The stock archive contains two macOS symlinks whose extraction fails without
# Developer Mode/admin; this repair makes pack/dist:win work anyway.
$devMode = $false
try {
  $k = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue
  $devMode = ($k.AllowDevelopmentWithoutDevLicense -eq 1)
} catch {}
if (-not $devMode) {
  Write-Skip "Windows Developer Mode is off - fine for running Tote; enable it (Settings > Privacy & security > For developers) if packaging ever complains about symbolic links."
}
Write-Step "checking electron-builder sign-tool cache"
node scripts\win-sign-cache.js
if ($LASTEXITCODE -ne 0) { Write-Skip "sign-cache repair failed; packaging may need Developer Mode or one elevated run." }

# --- native terminal layer (node-pty) ----------------------------------------
Write-Step "sanity-checking node-pty under Node"
$ptyCheck = @'
const path = require('path');
try {
  const pty = require(path.join(process.argv[2], 'node_modules', 'node-pty'));
  const p = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'echo tote-pty-ok'], {
    name: 'xterm', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
  });
  let d = '';
  p.onData(function (c) { d += c; });
  p.onExit(function () {
    if (d.indexOf('tote-pty-ok') >= 0) { console.log('ok'); process.exit(0); }
    console.error('pty produced no output'); process.exit(1);
  });
  setTimeout(function () { console.error('timeout'); process.exit(1); }, 15000);
} catch (e) { console.error(e.message); process.exit(1); }
'@
$ptyProbe = Join-Path $env:TEMP 'tote-pty-check.js'
Set-Content -LiteralPath $ptyProbe -Value $ptyCheck -Encoding Ascii
try {
  & node.exe $ptyProbe $repoRoot
  if ($LASTEXITCODE -eq 0) {
    Write-Ok "node-pty spawns a real Windows PTY"
  } else {
    Write-Bad "node-pty smoke test failed. Re-run 'npm.cmd ci'; if it persists, run 'npm run doctor' and follow its native-module section."
  }
} finally {
  Remove-Item -LiteralPath $ptyProbe -Force -ErrorAction SilentlyContinue
}

# --- summary / launch ---------------------------------------------------------
if ($script:hadFailure) {
  Write-Host ""
  Write-Host "Setup finished with problems (marked !! above). Fix them, then re-run this script or 'npm run doctor'." -ForegroundColor Yellow
  exit 1
}

Write-Host ""
Write-Host "Done. Start Tote with: npm start   (first run opens the setup wizard)" -ForegroundColor Cyan
if (-not $NoLaunch -and -not $env:CI) {
  Write-Host "Launching Tote..."
  & npm.cmd start
} elseif ($NoLaunch) {
  Write-Host "-NoLaunch given: skipping start."
} else {
  Write-Host "CI detected: skipping start."
}
