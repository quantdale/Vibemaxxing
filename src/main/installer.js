// Setup & connection helpers for the first-run wizard.
// System checks, CLI install status, and wiring external apps
// (Claude Desktop, any MCP client) to the active workspace.
//
// Everything that touches other processes here is ASYNC: this module is
// consumed by Electron's main process (the setup wizard runs inside the app),
// and the old execSync probes parked that process for up to 8s per command
// -- with the npm and git checks serialized on top of each other. The same
// results now arrive in parallel via child_process.execFile callbacks.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function cmdVersion(cmd) {
  return new Promise((resolve) => {
    // On POSIX a plain execFile cannot run PATH shims like `npm` (a shell
    // script), so it goes through /bin/sh as before; on Windows cmd resolves
    // the .cmd shim, matching the old shell-free spawn semantics.
    execFile(
      cmd,
      ['--version'],
      {
        timeout: 8000,
        shell: process.platform === 'win32' ? undefined : '/bin/sh',
      },
      (err, stdout) => resolve(err ? null : String(stdout).trim()),
    );
  });
}

async function systemCheck(ptys) {
  let homeWritable = true;
  const probe = path.join(os.homedir(), '.tote-write-test');
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
  } catch {
    homeWritable = false;
  }
  const [avail, npm, git] = await Promise.all([
    Promise.resolve(ptys.available()),   // cheap and local, but kept in the fan-out
    cmdVersion('npm'),
    cmdVersion('git'),
  ]);
  return {
    node: process.versions.node,
    npm,
    git,
    pty: avail,
    homeWritable,
    platform: process.platform,
  };
}

/* ----- Claude Desktop binding ----- */

function claudeConfigPath() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
  }
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function claudeStatus() {
  const cfgPath = claudeConfigPath();
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const entry = cfg.mcpServers && (cfg.mcpServers['tote-workspace'] || cfg.mcpServers['omnihub-workspace']);
    const bound = !!entry;
    const boundTo = bound ? (entry.args || []).slice(-1)[0] : null;
    return { configExists: true, bound, boundTo, cfgPath };
  } catch {
    return { configExists: fs.existsSync(cfgPath), bound: false, boundTo: null, cfgPath };
  }
}

// Merge an MCP filesystem server for the workspace into Claude Desktop's
// config (timestamped .bak first). Takes effect on next Claude Desktop start.
function bindClaudeToWorkspace(rootPath) {
  const cfgPath = claudeConfigPath();
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {}
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  if (fs.existsSync(cfgPath)) {
    fs.copyFileSync(cfgPath, cfgPath + '.bak-' + Date.now());
  }
  cfg.mcpServers = cfg.mcpServers || {};
  delete cfg.mcpServers['omnihub-workspace']; // pre-rename key
  cfg.mcpServers['tote-workspace'] = {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', rootPath],
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}

// Generic snippet for any MCP-capable app (Cursor, Cherry Studio, Kimi Code
// via /mcp-config, ...) to mount the workspace.
function mcpSnippet(rootPath) {
  return JSON.stringify(
    {
      mcpServers: {
        'tote-workspace': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', rootPath],
        },
      },
    },
    null,
    2,
  );
}

module.exports = { systemCheck, claudeStatus, bindClaudeToWorkspace, mcpSnippet };
