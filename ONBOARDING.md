# Fresh-machine onboarding

This is the canonical bootstrap entry point for a new workstation or a fresh coding-agent environment. Complete this document before implementation work. The objective is a reproducible machine that can build, test, inspect, and operate this repository without rediscovering tooling mid-campaign.

## 1. Preflight rule

1. Clone the repository and enter its root.
2. Confirm the intended repository/branch and fetch current `origin/main`.
3. Read the repository control-plane documents before changing code: `AGENTS.md`, `CLAUDE.md`, `README.md`, `.agent/`, current docs/state.
4. Install/verify the machine prerequisites below.
5. Enable the committed agent integrations and repository-local skills.
6. Restore dependencies from lockfiles/pins; do not casually upgrade them during bootstrap.
7. Run the baseline validation commands.
8. Only then begin a development campaign. If a prerequisite cannot be satisfied, record it as an environment blocker rather than weakening a gate.

Credentials, API keys, signing material, account logins, licensed assets, and other secrets are machine/user responsibilities. Never commit them.

## 2. Supported host and prerequisites

**Primary host:** Windows/Linux/macOS Electron application; Windows and Linux have the strongest current CI/packaging evidence.

**Required machine tools**
- Git
- Node.js >=20 + npm
- Electron dependencies from the lockfile
- a working native PTY environment

**Task-dependent / optional tools**
- Visual Studio Build Tools on Windows only if `node-pty` cannot use its prebuild
- build-essential + Python 3 on Linux if native rebuild is required
- installed vendor agent CLIs when testing Tote's real CLI integrations


## 3. Agent setup

- Load repository instructions before acting. Prefer committed repository state over chat history.
- Repository-local skills: `goal`.
- Discover and use committed agent adapter/config directories in-place; do not duplicate them globally unless the harness cannot load repository-local configuration.
- Relevant committed agent surfaces: `.agent/`, `.agents/`, `.claude/`, `.kimi-code/`, `.opencode/`.
- MCP policy: No root `.mcp.json` is committed. Tote itself manages workspace/CLI/MCP integrations as product functionality; do not conflate the product's user bindings with development-agent MCP authority.
- Keep diagnostic/documentation MCPs narrow. An MCP does not grant architecture, publishing, production, or gate-bypass authority.
- Authenticate GitHub and coding-agent CLIs separately on the machine. Never store tokens in tracked files.

## 4. Bootstrap

```bash
npm ci
npm run doctor -- --ci
npm run smoke:pty
```

The setup wizard can provision supported CLI agents for Tote users, but development bootstrap should not silently install/login to vendor CLIs unless the current test scope requires them.


## 5. Editor/LSP baseline

Use JavaScript/Node/Electron language diagnostics and keep main/renderer boundary APIs explicit. Native `node-pty` failures are environment/toolchain problems, not a reason to bypass PTY tests.

The editor is optional; reliable language diagnostics are not.

## 6. Baseline verification

```bash
npm test
npm run doctor -- --ci
npm run smoke:pty
npm run test:e2e
npm run smoke:packaged
```

A fresh machine is **development-ready** when all applicable non-external gates pass. Hardware/device/signing/account gates may remain explicitly blocked when repository state already classifies them that way.

## 7. Fresh-agent instruction

> Read `ONBOARDING.md` first. Set up every applicable prerequisite, repository-local skill, MCP/plugin, dependency, browser/device/runtime tool, and validation gate described there. Then read the repository's durable agent state and only start implementation after preflight is green or a genuine environment blocker is recorded. Do not replace pinned tooling, skip gates, or invent work to compensate for a missing machine capability.
