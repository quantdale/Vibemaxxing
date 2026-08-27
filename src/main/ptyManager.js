// PTY manager: spawns CLI agents (Claude Code, Kimi CLI, ...) in real
// pseudo-terminals so their TUIs render correctly in xterm.js.
const { classifyPtyProblem } = require('./syscheck');

let pty = null;
let ptyLoadError = null;
try {
  pty = require('node-pty');
} catch (e) {
  ptyLoadError = e.message;
}

// Single-quote a word for the shell: end the quote, escape the quote, reopen.
function shq(word) {
  return `'${String(word).replace(/'/g, `'\\''`)}'`;
}

/* ----- pty:data coalescing ------------------------------------------------
 * node-pty emits onData per read() -- often a few bytes at a time -- and every
 * emission used to cross into the renderer as its own IPC message. A busy TUI
 * repaint or `cat` of a large file produces thousands of messages per second,
 * each paying object allocation, serialization, and a renderer dispatch.
 * Coalescing appends chunks into one buffer per session and flushes it once
 * per short window: xterm.js paints on animation frames anyway, so a few
 * milliseconds of batching is invisible to the eye while collapsing the
 * message count by orders of magnitude. Order is preserved exactly --
 * concatenation of the same chunks in the same sequence. The pure piece lives
 * here so scripts/test-ptybatch.js can exercise it without a real PTY. */
const FLUSH_DELAY_MS = 4;         // well under a frame; typing echo stays instant to feel
const FLUSH_MAX_BYTES = 256 * 1024; // bound memory when output outruns the flush window

// Build a chunk sink whose send() is called with batched data.
//   send(data)    -- called with coalesced chunks, in order, never empty.
// Returns { push(chunk), flush(), discard() }.
function makeDataCoalescer(send, opts) {
  const delay = (opts && opts.delayMs) !== undefined ? opts.delayMs : FLUSH_DELAY_MS;
  const maxBytes = (opts && opts.maxBytes) !== undefined ? opts.maxBytes : FLUSH_MAX_BYTES;
  let pending = '';
  let timer = null;

  const emit = () => {
    if (!pending) { if (timer) { clearTimeout(timer); timer = null; } return; }
    const data = pending;
    pending = '';
    if (timer) { clearTimeout(timer); timer = null; }
    send(data);
  };

  return {
    push(chunk) {
      pending += chunk;
      if (pending.length >= maxBytes) return emit();  // keep memory bounded under gushes
      if (timer === null && delay > 0) timer = setTimeout(emit, delay);
      else if (delay <= 0) queueMicrotask(emit);
    },
    flush: emit,
    // Stop batching without sending what remains -- used only where nothing
    // should arrive afterwards.
    discard() {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = '';
    },
  };
}

// What to actually hand pty.spawn() for a CLI profile.
//
// A GUI-launched app inherits a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin on
// macOS), so exec'ing `codex` or `claude` directly fails with posix_spawnp on
// every install that puts its binaries behind a version manager (fnm, nvm,
// asdf, volta) or in ~/.local/bin. Going through a login shell gives each
// terminal the same environment the user's own terminal has. It has to be
// resolved per terminal rather than captured once, because setups like fnm
// build their bin dir per shell and can switch node version by directory.
function shellCommand(profile) {
  const args = profile.args || [];
  // Windows has no login-shell concept; run CLI profiles via cmd.exe /c so .cmd/.bat
  // (npm, claude, kimi, codex, etc.) resolve properly on PATH, or powershell if no command.
  if (process.platform === 'win32') {
    if (!profile.command) return { file: 'powershell.exe', args };
    const comspec = process.env.COMSPEC || 'cmd.exe';
    return { file: comspec, args: ['/c', profile.command, ...args] };
  }
  const shell = process.env.SHELL || '/bin/bash';
  // -l for the profile files, -i so the interactive rc file (where fnm/nvm/asdf
  // hook in) is sourced too.
  if (!profile.command) return { file: shell, args: ['-l', '-i'] }; // "user's default shell"
  // exec replaces the shell, so the agent ends up owning the PTY directly:
  // signals, exit code and TUI repaint behave exactly as before, and no prompt
  // is ever drawn.
  const line = 'exec ' + [profile.command, ...args].map(shq).join(' ');
  return { file: shell, args: ['-l', '-i', '-c', line] };
}

class PtyManager {
  constructor() {
    this.sessions = new Map();
    this.flushers = new Map();   // id -> coalescer for that session's output
    this.nextId = 1;
  }

  available() {
    // Classified so the wizard can say WHY terminals are down (package
    // missing vs wrong ABI vs toolchain) instead of a bare "unavailable".
    const ok = !!pty;
    const cls = classifyPtyProblem(ok ? '' : ptyLoadError);
    return { ok, error: ptyLoadError, kind: cls.kind, label: cls.label, hint: cls.hint };
  }

  spawn(profile, cwd, cols, rows, sender) {
    if (!pty) {
      throw new Error('node-pty failed to load: ' + ptyLoadError);
    }
    const { file, args } = shellCommand(profile);
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env: process.env,
    });
    const id = this.nextId++;
    this.sessions.set(id, proc);

    // Output arrives per read; batch it (see makeDataCoalescer) so a chatty
    // TUI costs dozens of IPC messages a second instead of thousands.
    const batch = makeDataCoalescer((data) => {
      try {
        sender.send('pty:data', { id, data });
      } catch {}
    });
    this.flushers.set(id, batch);   // kill() must be able to drain the tail
    proc.onData((chunk) => batch.push(chunk));
    const exit = ({ exitCode }) => {
      // Drain whatever is still buffered so no output dies in flight.
      this.flushers.delete(id);
      batch.flush();
      this.sessions.delete(id);
      try {
        sender.send('pty:exit', { id, exitCode });
      } catch {}
    };
    proc.onExit(exit);
    // If the renderer reloads or is destroyed, kill the PTY so agent
    // processes don't run forever without a UI attached.
    if (sender.once) sender.once('destroyed', () => this.kill(id));
    return id;
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (s) s.write(data);
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (s) {
      try {
        s.resize(cols, rows);
      } catch {}
    }
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (s) {
      try {
        s.kill();
      } catch {}
      this.sessions.delete(id);
      // The process is going away; push out any buffered bytes before the
      // onExit drain, so the tail never waits for a timer it will beat.
      const batch = this.flushers.get(id);
      if (batch) { this.flushers.delete(id); batch.flush(); }
    }
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}

module.exports = { PtyManager, makeDataCoalescer };
