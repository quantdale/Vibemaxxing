#!/usr/bin/env bash
# Tote bootstrap: checks prerequisites, installs deps, launches the app.
set -e
cd "$(dirname "$0")/.."

echo "== Tote setup =="

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node 20+ from https://nodejs.org and re-run."
  exit 1
fi
NODE_MAJOR=$(node -v | sed -E 's/v([0-9]+)\..*/\1/')
if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  echo "Node.js 20+ required. Current version: $(node -v). Please upgrade Node.js."
  exit 1
fi
echo "node $(node -v)  ✓"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found - it ships with Node.js. Reinstall Node and re-run."
  exit 1
fi
echo "npm $(npm -v)  ✓"

# node-pty needs a C++ toolchain on first install
HAS_CXX=false
if command -v g++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1; then
  HAS_CXX=true
fi
if ! command -v make >/dev/null 2>&1 || ! $HAS_CXX || ! command -v python3 >/dev/null 2>&1; then
  echo "warning: make/compiler/python3 not found. node-pty may need build tools:"
  echo "  Debian/Ubuntu: sudo apt install build-essential python3"
  echo "  Fedora:        sudo dnf install gcc-c++ make python3"
  echo "  macOS:         xcode-select --install"
fi

echo "installing dependencies..."
npm install --no-audit --no-fund

echo
echo "Done. Starting Tote (first run opens the setup wizard)..."
# Skip auto-launch in CI or headless environments
if [ -n "$CI" ]; then
  echo "CI detected -- skipping npm start."
elif [ "$(uname)" = "Linux" ] && [ -z "$DISPLAY" ] && [ -z "$WAYLAND_DISPLAY" ]; then
  echo "No display server found -- skipping npm start."
else
  npm start
fi
