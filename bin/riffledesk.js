#!/usr/bin/env node
// riffledesk launcher + agent CLI.
//
//   riffledesk                       start the server and open the browser
//   riffledesk open <file> [--line N] push a file to open browser tabs
//   riffledesk show <file...>        hand the user a shortlist of files as one stack
//   riffledesk search "<text>"       full-text search from the shell
//   riffledesk changes <html>        read the browser's HTML revamp list (disk only)
//   riffledesk wait <html>           block until a fresh revamp list appears
//   riffledesk install-skill         copy the bundled agent skill to a skills dir
//   riffledesk hook install          add the opt-in Claude Code Stop-hook reminder
//
// Zero dependencies (node builtins only) so agents can shell out to it anywhere.
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { startBackground, logFileFor } = require('./background');
const hooklib = require('./hook');

const ROOT = path.resolve(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));
const HOST = '127.0.0.1';
const DEFAULT_PORT = 5177;
const MAX_PILE = 500;   // mirrors the server's PILE_MAX
const STDIN_FIRST_MS = 10000;   // quiet window before the first byte (a cold server costs seconds)
const STDIN_IDLE_MS = 2000;     // quiet window between bytes: a long stream keeps resetting it
const STDIN_CAP = 2 * 1024 * 1024;

// RIFFLEDESK_PORT wins over the generic PORT so several agents can point at
// their own instance without every other tool in the shell following them.
// Plain digits only, matching how a --port value is validated; a malformed
// value is skipped with a note on stderr instead of silently changing target.
function defaultPort() {
  for (const name of ['RIFFLEDESK_PORT', 'PORT']) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') continue;
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (n > 0 && n <= 65535) return n;
    }
    console.error(`riffledesk: ignoring ${name}=${JSON.stringify(raw)} (not a port number)`);
  }
  return DEFAULT_PORT;
}

// ---------- usage ----------

function usageText() {
  return `${PKG.name} — local 3D file browser with full-text search

usage:
  riffledesk [--port N] [--no-open]        start the server and open the browser
  riffledesk status [--port N]            show the running server version
  riffledesk stop [--port N]              stop the local server
  riffledesk restart [--port N]           restart the local server
  riffledesk open <file> [options]         open a file in the running browser
  riffledesk show <file...> [options]      show a shortlist of files as one stack (or read paths on stdin)
  riffledesk search "<text>" [options]     full-text search from this shell
  riffledesk changes <html> [options]      read the browser's revamp list for an HTML file
  riffledesk wait <html> [options]         block until the user hands over a fresh revamp list
  riffledesk install-skill [options]       copy the bundled agent skill to a skills directory
  riffledesk hook <sub> [options]          manage the opt-in Claude Code Stop-hook reminder
  riffledesk --help | -h                   show this help

start options:
  --port N        port to listen on (default ${DEFAULT_PORT}, or $RIFFLEDESK_PORT / $PORT)
  --no-open       do not open the browser
  --foreground    keep the server in this terminal (Ctrl+C to stop)

open options:
  --line N        line to reveal
  --port N        server port (default ${DEFAULT_PORT}, or $RIFFLEDESK_PORT / $PORT)
  --print-url     always print the URL instead of launching a browser

search options:
  --in <dir>      directory to search (default: current directory)
  --ext .md,.txt  restrict to these extensions
  --limit N       maximum files (server default 200, max 1000)
  --json          machine-readable JSON array on stdout
  --port N        server port (default ${DEFAULT_PORT}, or $RIFFLEDESK_PORT / $PORT)

show options:
  --title "text"  heading shown above the stack
  --stdin         read paths from stdin (also on by default when stdin is piped)
  --json          print the pile id and kept/dropped paths as JSON
  --port N        server port (default ${DEFAULT_PORT}, or $RIFFLEDESK_PORT / $PORT)
  --print-url     print the URL instead of launching a browser

changes / wait options (both read the disk; no server needed):
  --json          print the raw revamp JSON instead of the readable form
  --done          (changes only) mark the list status "done"
  --timeout S     (wait only) seconds to wait (default 1800)

install-skill options:
  --claude        install into ~/.claude/skills/riffledesk (default)
  --dest <dir>    install into <dir>/riffledesk instead
  An identical copy is left alone; a differing one is swapped in and the old
  copy kept as ../skills-backup/riffledesk-<time>/ (outside the skills folder,
  so Claude Code does not load the backup as a second skill). A symlinked
  target is refused rather than flattened.

The launcher exits after starting a windowless background server. Closing the
terminal or coding assistant does not stop it. Use stop or Settings to end it.
If no server is listening on the port, open/search start one in the background
(log file in the temp directory) and wait for it to come up.

environment:
  RIFFLEDESK_PORT          default port (wins over PORT)
  PORT                     default port
  RIFFLEDESK_SOURCE        label sent with "open" (default: cli)
  RIFFLEDESK_BROWSER_CMD   executable used to open a URL instead of the default
  RIFFLEDESK_CONFIG        config file path (read for the "browser" setting)

exit codes: 0 ok · 1 no results, no revamp list, or request failed · 2 bad usage, missing path, or an unreadable revamp list · 3 wait timed out`;
}

function usage() {
  console.log(usageText());
}

const USAGE = {
  start: 'usage: riffledesk [--port N] [--no-open] [--foreground]',
  open: `usage: riffledesk open <file> [--line N] [--port N] [--print-url]

Open <file> in every browser tab currently showing riffledesk. Starts the
server in the background first when none is running. If no tab is connected,
opens a new browser page at /?open=<path> instead.

  --line N     line to reveal in the reader
  --port N     server port (default ${DEFAULT_PORT}, or $RIFFLEDESK_PORT / $PORT)
  --print-url  print the URL instead of launching a browser

exit codes: 0 ok · 1 request failed · 2 bad usage or missing path`,
  show: `usage: riffledesk show <file...> [--title "text"] [--json] [--port N] [--print-url]
       riffledesk search "text" --json | riffledesk show --title "text"

Hand the user ONE card stack holding exactly these files, so nothing unrelated shows
up beside them. Paths may come as arguments or on stdin (a JSON array as printed by
"search --json", or one path per line; "-" means stdin). Duplicates collapse; paths
that do not exist (or fall outside the browsed scopes) are listed on stderr and the
rest still go. At most ${MAX_PILE} files.

With a tab connected the pile is pushed there (a notification, no screen steal).
With none, this opens a page at /?pile=<id>. --print-url prints that URL instead.

  --title "text"  heading above the stack (default: the first file's name)
  --stdin         read paths from stdin ("-" does the same; implied when piped)
  --json          print {ok, id, count, delivered, url, dropped}; opens no browser
  --port N        server port (default ${DEFAULT_PORT}, or $RIFFLEDESK_PORT / $PORT)
  --print-url     print the URL as well, instead of launching a browser

exit codes: 0 ok · 1 request failed · 2 bad usage, no usable file, or missing path`,
  search: `usage: riffledesk search "<text>" [--in <dir>] [--ext .md,.txt] [--limit N] [--json] [--port N]

Recursive full-text + file-name search through the server's /api/search.
Prints one result per line (path, modification time); --json prints an array.
All output is English so scripts can parse it. Exits 1 when nothing matched.

  --in <dir>       directory to search (default: current directory)
  --ext .md,.txt   restrict to these extensions
  --limit N        maximum files (default 200, max 1000)
  --json           machine-readable JSON array on stdout
  --port N         server port (default ${DEFAULT_PORT}, or $RIFFLEDESK_PORT / $PORT)
  --print-url      print nothing but the server URL (useful to check the port)

exit codes: 0 ok · 1 no results or request failed · 2 bad usage or missing path`,
  changes: `usage: riffledesk changes <html-file> [--json | --done]

Print the revamp list the browser's HTML revamp mode wrote next to <html-file>
(<file>.changes.json), straight from disk — no server involved.

Readable output: file path, creation time, status, screenshot path (when one
exists), the plain-language summary, then every item with its locator (n, op,
rdId or selector, textHint, before -> after, note). --json prints the raw JSON.
A list already marked "done" still prints, prefixed with "(already handled)".
--json and --done are mutually exclusive.

  --json   raw JSON on stdout
  --done   mark the list status "done" (atomic temp file + rename), then exit

exit codes: 0 ok · 1 no revamp list · 2 bad usage, missing file, or a broken
list (bad JSON or an unknown version)`,
  wait: `usage: riffledesk wait <html-file> [--timeout S] [--json]

Block until a fresh revamp list appears for <html-file> (status "pending" and
createdAt — or the file mtime — later than the moment this command started),
then print it like "changes" and exit 0. Polls every second with an fs.watch
kicker; a half-written JSON file is retried, never fatal.

  --timeout S   seconds to wait (default 1800)
  --json        raw JSON on stdout

exit codes: 0 ok · 2 bad usage or missing file · 3 timed out`,
  installSkill: `usage: riffledesk install-skill [--claude] [--dest <dir>]

Copy the skill bundled with this package (skills/riffledesk: SKILL.md and
AGENTS-snippet.md) into a skills directory so an agent can read it.

  --claude       install into ~/.claude/skills (default)
  --dest <dir>   install into <dir>/riffledesk instead (~ is expanded)

Targets the folder riffledesk inside the destination. An identical copy is
reported and left alone; a differing one is swapped in and the previous copy
kept in a partner "skills-backup" folder next to the skills directory
(skills-backup/riffledesk-<YYYYMMDD-HHMMSS>/). That folder sits outside the
skills directory on purpose: a backup inside it would be loaded as a second
skill. A symlinked target is refused. Nothing else is touched.

exit codes: 0 ok · 1 no bundled skill or copy failed · 2 bad usage`,
  hook: `usage: riffledesk hook install [--settings <path>]    add the Claude Code Stop-hook reminder
       riffledesk hook uninstall [--settings <path>]  remove exactly that reminder
       riffledesk hook status [--settings <path>]     print installed / not installed
       riffledesk hook check                          the hook itself (Claude Code runs it on Stop)

Opt-in nudge: when a Claude Code agent stops, "hook check" scans the end of the
session transcript. If the agent wrote deliverable files (.md, .html, .svg,
.pdf, .csv, .png, .jpg, .docx, .xlsx, .pptx…) without handing them over via
"riffledesk open" / "riffledesk show", it is reminded once with the exact
command. It never loops (stop_hook_active), and any error — a missing or
half-written transcript, garbage input — exits silently so the nudge can never
block the agent.

  --settings <path>   settings file (default $CLAUDE_CONFIG_DIR/settings.json or
                      ~/.claude/settings.json; ~ expands)

install merges into the existing file: other hooks and keys stay untouched, a
<settings>.bak copy is written first, and a second run changes nothing. A
settings file that is not valid JSON is refused (exit 2), never overwritten.
The hook command calls node with the absolute riffledesk.js path — the bare
Windows shim is a POSIX sh script whose forks trip EDR. uninstall removes only
the riffledesk entry; other hooks stay. status exits 0 installed / 1 not.

exit codes: 0 ok · 1 status: not installed · 2 bad usage or a settings file that
is not valid JSON`
};

// Bad input always carries the matching usage block, on stderr.
function fail(msg, code = 2, usageText = null) {
  console.error(`${PKG.name}: ${msg}`);
  if (usageText) console.error(`\n${usageText}`);
  process.exit(code);
}

// ---------- options ----------

function intArg(raw, name, usageText, min = 1, max = 65535) {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isInteger(n) || n < min || n > max) {
    fail(`bad value for ${name}: ${raw === undefined ? '(missing)' : raw}`, 2, usageText);
  }
  return n;
}

// A value-taking flag with no value: `--in --json` must not swallow the next flag.
function valueArg(argv, i, name, usageText) {
  const v = argv[i + 1];
  if (v === undefined || (v.startsWith('-') && v !== '-')) fail(`missing value for ${name}`, 2, usageText);
  return v;
}

function parseStart(argv) {
  const opts = { port: defaultPort(), open: true, foreground: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { for (const rest of argv.slice(i + 1)) if (/^\d+$/.test(rest)) opts.port = intArg(rest, 'port', USAGE.start); else fail(`unexpected argument: ${rest}`, 2, USAGE.start); break; }
    if (a === '--no-open') opts.open = false;
    else if (a === '--foreground') opts.foreground = true;
    else if (a === '--port') opts.port = intArg(argv[++i], '--port', USAGE.start);
    else if (a.startsWith('--port=')) opts.port = intArg(a.slice(7), '--port', USAGE.start);
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('-') && a !== '-') fail(`unknown option: ${a}`, 2, USAGE.start);
    else if (/^\d+$/.test(a)) opts.port = intArg(a, 'port', USAGE.start);
    else fail(`unknown option: ${a}`, 2, USAGE.start);
  }
  return opts;
}

function parseOpen(argv) {
  const opts = { file: null, line: null, port: defaultPort(), printUrl: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { for (const rest of argv.slice(i + 1)) { if (opts.file === null) opts.file = rest; else fail(`unexpected argument: ${rest}`, 2, USAGE.open); } break; }
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--line') opts.line = intArg(argv[++i], '--line', USAGE.open, 0, 10000000);
    else if (a.startsWith('--line=')) opts.line = intArg(a.slice(7), '--line', USAGE.open, 0, 10000000);
    else if (a === '--port') opts.port = intArg(argv[++i], '--port', USAGE.open);
    else if (a.startsWith('--port=')) opts.port = intArg(a.slice(7), '--port', USAGE.open);
    else if (a === '--print-url') opts.printUrl = true;
    else if (a.startsWith('-') && a !== '-') fail(`unknown option: ${a}`, 2, USAGE.open);
    else if (opts.file === null) opts.file = a;
    else fail(`unexpected argument: ${a}`, 2, USAGE.open);
  }
  return opts;
}

function parseSearch(argv) {
  const opts = { q: null, in: null, exts: null, limit: null, json: false, printUrl: false, port: defaultPort(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { for (const rest of argv.slice(i + 1)) { if (opts.q === null) opts.q = rest; else fail(`unexpected argument: ${rest}`, 2, USAGE.search); } break; }
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--in') opts.in = valueArg(argv, i++, '--in', USAGE.search);
    else if (a.startsWith('--in=')) opts.in = a.slice(5);
    else if (a === '--ext') opts.exts = valueArg(argv, i++, '--ext', USAGE.search);
    else if (a.startsWith('--ext=')) opts.exts = a.slice(6);
    else if (a === '--limit') opts.limit = intArg(argv[++i], '--limit', USAGE.search, 1, 1000);
    else if (a.startsWith('--limit=')) opts.limit = intArg(a.slice(8), '--limit', USAGE.search, 1, 1000);
    else if (a === '--json') opts.json = true;
    else if (a === '--print-url') opts.printUrl = true;
    else if (a === '--port') opts.port = intArg(argv[++i], '--port', USAGE.search);
    else if (a.startsWith('--port=')) opts.port = intArg(a.slice(7), '--port', USAGE.search);
    else if (a.startsWith('-') && a !== '-') fail(`unknown option: ${a}`, 2, USAGE.search);
    else if (opts.q === null) opts.q = a;
    else fail(`unexpected argument: ${a}`, 2, USAGE.search);
  }
  return opts;
}

function parseShow(argv) {
  const opts = { files: [], title: null, stdin: false, json: false, printUrl: false, port: defaultPort(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { for (const rest of argv.slice(i + 1)) opts.files.push(rest); break; }
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--title') opts.title = valueArg(argv, i++, '--title', USAGE.show);
    else if (a.startsWith('--title=')) opts.title = a.slice(8);
    else if (a === '--stdin') opts.stdin = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--print-url') opts.printUrl = true;
    else if (a === '--port') opts.port = intArg(argv[++i], '--port', USAGE.show);
    else if (a.startsWith('--port=')) opts.port = intArg(a.slice(7), '--port', USAGE.show);
    else if (a.startsWith('-') && a !== '-') fail(`unknown option: ${a}`, 2, USAGE.show);
    else opts.files.push(a);
  }
  return opts;
}

function parseChanges(argv) {
  const opts = { file: null, json: false, done: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { for (const rest of argv.slice(i + 1)) { if (opts.file === null) opts.file = rest; else fail(`unexpected argument: ${rest}`, 2, USAGE.changes); } break; }
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--done') opts.done = true;
    else if (a.startsWith('-') && a !== '-') fail(`unknown option: ${a}`, 2, USAGE.changes);
    else if (opts.file === null) opts.file = a;
    else fail(`unexpected argument: ${a}`, 2, USAGE.changes);
  }
  return opts;
}

function parseWait(argv) {
  const opts = { file: null, timeout: 1800, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { for (const rest of argv.slice(i + 1)) { if (opts.file === null) opts.file = rest; else fail(`unexpected argument: ${rest}`, 2, USAGE.wait); } break; }
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--timeout') opts.timeout = intArg(argv[++i], '--timeout', USAGE.wait, 1, 86400);
    else if (a.startsWith('--timeout=')) opts.timeout = intArg(a.slice(10), '--timeout', USAGE.wait, 1, 86400);
    else if (a.startsWith('-') && a !== '-') fail(`unknown option: ${a}`, 2, USAGE.wait);
    else if (opts.file === null) opts.file = a;
    else fail(`unexpected argument: ${a}`, 2, USAGE.wait);
  }
  return opts;
}

function parseInstallSkill(argv) {
  const opts = { dest: null, mode: null, help: false };
  const both = () => fail('--dest and --claude both given — pick one (they select the destination)', 2, USAGE.installSkill);
  const setDest = (v, where) => {
    if (v === undefined || v === '') fail(`empty value for ${where} — give a directory`, 2, USAGE.installSkill);
    if (opts.mode === 'claude') both();
    opts.dest = v;
    opts.mode = 'dest';
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // after --, bare words are diredestination values, exactly like the other
    // subcommands treat a bare argument
    if (a === '--') { for (const rest of argv.slice(i + 1)) setDest(rest, '--'); break; }
    if (a === '-h' || a === '--help') { opts.help = true; continue; }
    if (a === '--claude') {
      if (opts.mode === 'dest') both();
      opts.dest = null;
      opts.mode = 'claude';
    } else if (a === '--dest') setDest(valueArg(argv, i++, '--dest', USAGE.installSkill), '--dest');
    else if (a.startsWith('--dest=')) setDest(a.slice(7), '--dest=');
    else fail(`unknown option: ${a}`, 2, USAGE.installSkill);
  }
  return opts;
}

// ---------- browser ----------
function isWsl() {
  if (process.platform !== 'linux') return false;
  return os.release().toLowerCase().includes('microsoft') || !!process.env.WSL_DISTRO_NAME;
}

function hasDesktop() {
  if (process.platform === 'linux' && !isWsl()) {
    // Linux/WSL genuinely need a display; on Windows/macOS a remote shell still
    // has the local desktop, so SSH alone is not a reason to skip the browser.
    return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  }
  return !process.env.SSH_CONNECTION;
}

function configPath() {
  const env = process.env.RIFFLEDESK_CONFIG || process.env.FLODER_CONFIG;
  return env ? path.resolve(env) : path.join(ROOT, 'config.json');
}

function configuredBrowser() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return typeof cfg.browser === 'string' && cfg.browser.trim() ? cfg.browser.trim() : null;
  } catch (_) { return null; }
}

// detach + hidden + unref: no console window, browser keeps this process free
function openBrowser(url) {
  try {
    const custom = process.env.RIFFLEDESK_BROWSER_CMD || configuredBrowser();
    if (custom) {
      const c = spawn(custom, [url], { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
      c.on('error', () => {});
      c.unref();
      return true;
    }
    if (process.platform === 'win32') {
      // the empty title arg is required, otherwise start treats the quoted URL as a title
      const c = spawn('cmd.exe', ['/d', '/c', 'start', '""', url],
        { detached: true, stdio: 'ignore', windowsHide: true });
      c.on('error', () => {});
      c.unref();
      return true;
    }
    if (process.platform === 'darwin') {
      const c = spawn('open', [url], { detached: true, stdio: 'ignore' });
      c.on('error', () => {});
      c.unref();
      return true;
    }
    if (isWsl()) {
      // prefer wslview (wslu); fall back to cmd.exe /c start on the Windows side
      try {
        const r = spawnSync('wslview', [url], { stdio: 'ignore' });
        if (!r.error) return true;
      } catch (_) {}
      try {
        const c = spawn('cmd.exe', ['/c', 'start', '""', url],
          { detached: true, stdio: 'ignore', windowsHide: true });
        c.on('error', () => {});
        c.unref();
        return true;
      } catch (_) { return false; }
    }
    const c = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    c.on('error', () => {});
    c.unref();
    return true;
  } catch (_) {
    return false;
  }
}

// Show the URL, or hand it to a browser. `alwaysPrint` is --print-url (tests).
function showUrl(url, alwaysPrint) {
  if (alwaysPrint || !hasDesktop()) {
    console.log(url);
    return;
  }
  if (!openBrowser(url)) console.log(url);
}

// ---------- server probing / background start ----------

function request(port, method, pathname, { body = null, timeout = 1500, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const hdrs = { ...headers };
    if (payload) { hdrs['content-type'] = 'application/json'; hdrs['content-length'] = payload.length; }
    const req = http.request({ host: HOST, port, method, path: pathname, headers: hdrs, timeout }, res => {
      const chunks = [];
      res.on('error', reject);
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, data, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function isUp(port) {
  try {
    const r = await request(port, 'GET', '/api/drives', { timeout: 1200 });
    const d = r.data;
    return r.status === 200 && !!d && d.ok === true &&
      Array.isArray(d.drives) && Array.isArray(d.roots) && Array.isArray(d.pinned);
  } catch (_) { return false; }
}

async function ensureServer(port) {
  if (await isUp(port)) return;
  const logPath = startBackground(port);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    if (await isUp(port)) return;
  }
  fail(`server did not come up on port ${port} within 10s — see ${logPath}`, 1);
}

function pageUrl(port, file) {
  return `http://${HOST}:${port}/?open=${encodeURIComponent(file)}`;
}

// ---------- subcommands ----------

async function cmdOpen(argv) {
  const opts = parseOpen(argv);
  if (opts.help) { console.log(USAGE.open); process.exit(0); }
  if (!opts.file) { console.error(USAGE.open); process.exit(2); }
  const abs = path.resolve(opts.file);
  let st = null;
  try { st = fs.statSync(abs); } catch (_) {}
  if (!st) fail(`no such file: ${abs}`, 2, USAGE.open);
  if (!st.isFile()) fail(`not a file: ${abs}`, 2, USAGE.open);

  await ensureServer(opts.port);

  let delivered = 0;
  let fallback = null;                                   // why we are not using the tabs
  const body = { path: abs, source: process.env.RIFFLEDESK_SOURCE || 'cli' };
  if (opts.line !== null) body.line = opts.line;
  let r = null;
  try {
    r = await request(opts.port, 'POST', '/api/project', {
      body,
      timeout: 5000,
      headers: { 'X-RiffleDesk-CLI': '1' }
    });
  } catch (err) {
    fallback = `push failed (${err.message})`;
  }
  if (r) {
    const ok = r.status >= 200 && r.status < 300;
    if (r.status === 404) fallback = 'server has no /api/project (old version)';
    else if (ok && r.data && r.data.ok) delivered = Number(r.data.delivered) || 0;
    else if (ok) fallback = 'server sent an unreadable answer';
    else fail(`server answered ${r.status}${r.data && r.data.error ? ': ' + r.data.error : ''}`, 1);
  }

  if (delivered > 0) {
    console.log(`pushed to ${delivered} tab(s) — ${abs}`);
    return;
  }
  if (fallback) console.error(`not pushing to a tab: ${fallback}`);
  else console.error('no browser tab connected — opening a new page');
  showUrl(pageUrl(opts.port, abs), opts.printUrl);
}

async function cmdSearch(argv) {
  const opts = parseSearch(argv);
  if (opts.help) { console.log(USAGE.search); process.exit(0); }
  if (!opts.q || !opts.q.trim()) { console.error(USAGE.search); process.exit(2); }
  const q = opts.q.trim();
  const dir = path.resolve(opts.in || process.cwd());
  let st = null;
  try { st = fs.statSync(dir); } catch (_) {}
  if (!st) fail(`no such directory: ${dir}`, 2, USAGE.search);
  if (!st.isDirectory()) fail(`not a directory: ${dir}`, 2, USAGE.search);

  await ensureServer(opts.port);
  if (opts.printUrl) { console.log(`http://${HOST}:${opts.port}/`); return; }

  const params = new URLSearchParams({ path: dir, q });
  if (opts.exts) params.set('exts', opts.exts.split(',').map(s => s.trim()).filter(Boolean).join(','));
  if (opts.limit) params.set('limit', String(opts.limit));

  let r;
  try {
    r = await request(opts.port, 'GET', `/api/search?${params}`, { timeout: 60000 });
  } catch (err) {
    fail(`search request failed: ${err.message}`, 1);
  }
  if (r.status !== 200 || !r.data || !r.data.ok) {
    fail(`server answered ${r.status}${r.data && r.data.error ? ': ' + r.data.error : ''}`, 1);
  }
  const files = Array.isArray(r.data.files) ? r.data.files : [];

  if (opts.json) {
    console.log(JSON.stringify(files.map(f => ({
      path: f.path, mtime: f.mtime, size: f.size, hits: f.hits, snippet: f.snippet
    })), null, 2));
  } else {
    for (const f of files) {
      const when = f.mtime ? new Date(f.mtime).toISOString() : '-';
      console.log(`${when}  ${f.path}`);
      if (f.snippet) console.log(`    ${f.snippet}`);
    }
    if (r.data.truncated) console.error('results truncated by the server budget');
  }
  if (!files.length) {
    if (!opts.json) console.error('no matches');
    process.exit(1);
  }
}

// ---------- show ----------
//
// Paths come from the arguments and/or stdin. The stdin form exists so a search can
// be piped straight in: either the JSON array "search --json" prints (only the path
// member is taken) or one plain path per line. Piped input is read to the end (a
// producer first has to start the server, so the first byte can take seconds); only
// the quiet time is bounded, and the bound is renewed by every chunk. A console that
// was inherited without --stdin is abandoned after the first-byte window.

function readStdin(tty) {
  // a terminal user types slower than a pipe writes: give them more quiet time
  return new Promise(resolve => {
    let data = '';
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { process.stdin.pause(); } catch (_) {}
      resolve(data);
    };
    const arm = ms => { clearTimeout(timer); timer = setTimeout(finish, ms); };
    arm(STDIN_FIRST_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => {
      data += c;
      if (data.length > STDIN_CAP) { data = data.slice(0, STDIN_CAP); finish(); return; }
      arm(tty ? 5000 : STDIN_IDLE_MS);
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

function pathsFromStdin(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed = null;
    try { parsed = JSON.parse(trimmed); } catch (_) { parsed = null; }
    if (parsed !== null) {
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const out = [];
      for (const r of rows) {
        const p = r && typeof r === 'object' ? r.path : r;
        if (typeof p === 'string' && p.trim()) out.push(p.trim());
      }
      return out;
    }
    // not JSON after all (a path may legitimately start with "[" or "{"): fall through
  }
  return trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

function writeUrl(port, id) {
  return `http://${HOST}:${port}/?pile=${encodeURIComponent(id)}`;
}

async function cmdShow(argv) {
  const opts = parseShow(argv);
  if (opts.help) { console.log(USAGE.show); process.exit(0); }
  if (opts.title !== null && !opts.title.trim()) fail('empty value for --title', 2, USAGE.show);

  let stdinPaths = [];
  const fromStdin = opts.stdin || opts.files.includes('-') || !process.stdin.isTTY;
  opts.files = opts.files.filter(f => f !== '-');
  if (fromStdin) {
    const text = await readStdin(!!process.stdin.isTTY);
    stdinPaths = pathsFromStdin(text);
  }

  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const raw of [...opts.files, ...stdinPaths]) {
    const given = expandHome(raw);
    let abs = null;
    try { abs = fs.realpathSync(path.resolve(given)); } catch (_) { abs = path.resolve(given); }
    // case-fold on every platform: macOS volumes are case-insensitive by default
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let st = null;
    try { st = fs.statSync(abs); } catch (err) {
      dropped.push({ path: raw, reason: err && err.code === 'ENOENT' ? 'missing' : 'unreadable' });
      continue;
    }
    if (!st.isFile()) { dropped.push({ path: raw, reason: 'not a file' }); continue; }
    kept.push(abs);
  }
  for (const d of dropped) console.error(`riffledesk: skipped (${d.reason}): ${d.path}`);
  if (!kept.length) fail('no usable file given (arguments or stdin)', 2, USAGE.show);
  if (kept.length > MAX_PILE) {
    const over = kept.splice(MAX_PILE);
    for (const p of over) {
      console.error(`riffledesk: over the ${MAX_PILE}-file cap, dropped: ${p}`);
      dropped.push({ path: p, reason: `over the ${MAX_PILE}-file cap` });
    }
  }

  await ensureServer(opts.port);
  const body = { paths: kept, source: process.env.RIFFLEDESK_SOURCE || 'cli' };
  if (opts.title !== null) body.title = opts.title.trim();
  let r = null;
  try {
    r = await request(opts.port, 'POST', '/api/pile', {
      body,
      timeout: 30000,
      headers: { 'X-RiffleDesk-CLI': '1' }
    });
  } catch (err) {
    fail(`pile request failed: ${err.message}`, 1);
  }
  const ok = r.status >= 200 && r.status < 300;
  if (!ok || !r.data || !r.data.ok || typeof r.data.id !== 'string' || !r.data.id) {
    fail(`server answered ${r.status}${r.data && r.data.error ? ': ' + r.data.error : ''}`, 1);
  }
  const id = r.data.id;
  const delivered = Math.max(0, Number(r.data.delivered) || 0);
  const url = writeUrl(opts.port, id);
  for (const d of r.data.dropped || []) {
    // the server scopes paths to the browsed roots; a path that escaped it was never shown
    console.error(`riffledesk: server dropped (outside the browsed scope or gone): ${d}`);
    dropped.push({ path: d, reason: 'rejected by the server' });
  }
  const count = Math.max(0, Number(r.data.count) || kept.length);

  if (opts.json) {
    // machine mode: no browser launch, and always the URL so a caller can act on it
    console.log(JSON.stringify({ ok: true, id, count, delivered, url, dropped }));
    return;
  }
  if (delivered > 0) {
    console.log(`showing ${count} file(s) in ${delivered} tab(s) — pile ${id}`);
    if (opts.printUrl) console.log(url);
    return;
  }
  console.error('no browser tab connected — opening a new page');
  showUrl(url, opts.printUrl);
}

// ---------- revamp lists (browser HTML revamp mode) ----------
//
// The browser writes <file>.changes.json (+ optional .changes.png) next to the
// HTML file when the user presses "hand to AI". This side lives purely on disk.

function changesFileFor(file) {
  return `${file}.changes.json`;
}

function listFailure(msg, code) {
  const err = new Error(msg);
  err.exitCode = code;
  return err;
}

// Reads and validates a list. Returns null when it does not exist; throws a
// tagged error (exitCode 2) on unreadable JSON, an unknown version, or items
// that are not objects.
function loadList(listPath) {
  let text;
  try { text = fs.readFileSync(listPath, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw listFailure(`cannot read ${listPath}: ${err.message}`, 2); }
  let data;
  try { data = JSON.parse(text); }
  catch (err) { throw listFailure(`broken revamp list (invalid JSON): ${listPath}`, 2); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw listFailure(`broken revamp list (not an object): ${listPath}`, 2);
  if (data.version !== 1) throw listFailure(`unsupported revamp list version ${JSON.stringify(data.version)}: ${listPath}`, 2);
  if (data.items !== undefined && !Array.isArray(data.items)) throw listFailure(`broken revamp list (items is not an array): ${listPath}`, 2);
  if (Array.isArray(data.items)) {
    const bad = data.items.findIndex(it => !it || typeof it !== 'object' || Array.isArray(it));
    if (bad >= 0) throw listFailure(`broken revamp list (item ${bad} is not an object): ${listPath}`, 2);
  }
  return data;
}

// Multi-line field values stay readable: later lines align under the value.
function fieldLines(label, value) {
  const rows = String(value).split(/\r?\n/);
  return [`    ${label} ${rows[0]}`, ...rows.slice(1).map(r => `    ${' '.repeat(label.length)} ${r}`)];
}

function printList(file, data, json) {
  if (json) { console.log(JSON.stringify(data, null, 2)); return; }
  const lines = [];
  if (data.status === 'done') lines.push('(already handled)');
  lines.push(`file:      ${file}`);
  lines.push(`createdAt: ${data.createdAt || '-'}`);
  lines.push(`status:    ${data.status || '-'}`);
  const shot = typeof data.screenshot === 'string' && data.screenshot
    ? path.resolve(path.dirname(file), data.screenshot) : null;
  lines.push(`screenshot: ${shot ? (fs.existsSync(shot) ? shot : `${shot} (missing)`) : '-'}`);
  lines.push('');
  lines.push('summary:');
  for (const line of String(data.summary || '').split(/\r?\n/)) lines.push(`  ${line}`);
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) lines.push('', 'items: (none)');
  else {
    lines.push('', `items (${items.length}):`);
    for (const it of items) {
      const locator = it.rdId ? `rdId=${it.rdId}` : it.selector ? `selector=${it.selector}` : 'locator=-';
      lines.push(`  - n=${it.n} op=${it.op} ${locator}${it.textHint ? ` textHint=${JSON.stringify(it.textHint)}` : ''}`);
      if (it.before !== undefined || it.after !== undefined) lines.push(...fieldLines('before:', it.before === undefined ? '-' : it.before));
      if (it.after !== undefined) lines.push(...fieldLines('after: ', it.after));
      if (it.rect && typeof it.rect === 'object') lines.push(`    rect:   ${it.rect.x},${it.rect.y} ${it.rect.w}x${it.rect.h}`);
      if (it.dx !== undefined || it.dy !== undefined) lines.push(`    move:   dx=${it.dx} dy=${it.dy}`);
      if (it.w !== undefined || it.h !== undefined) lines.push(`    size:   w=${it.w} h=${it.h}`);
      if (it.note) lines.push(...fieldLines('note:  ', it.note));
    }
  }
  console.log(lines.join('\n'));
}

function resolveHtml(raw, usageText) {
  const abs = path.resolve(raw);
  let st = null;
  try { st = fs.statSync(abs); }
  catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') fail(`cannot read: ${abs}`, 2, usageText);
    fail(`no such file: ${abs}`, 2, usageText);
  }
  if (!st.isFile()) fail(`not a file: ${abs}`, 2, usageText);
  return abs;
}

// Marks the list done without clobbering a newer one the browser may have
// written in the meantime: re-read, write a temp file, re-check createdAt
// right before the rename, retry a few times.
function markDone(listPath) {
  const dir = path.dirname(listPath);
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = loadList(listPath);
    if (!current) throw new Error('the list disappeared');
    const seenStatus = current.status;
    const seenCreated = current.createdAt;
    current.status = 'done';
    const tmp = path.join(dir, `.rdtmp-changes-${process.pid}-${attempt}-${Date.now().toString(36)}`);
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`);
      let unchanged = false;
      try {
        const onDisk = loadList(listPath);
        unchanged = !!onDisk && onDisk.createdAt === seenCreated && onDisk.status === seenStatus;
      } catch (_) { unchanged = false; }            // half-written: retry
      if (!unchanged) { fs.rmSync(tmp, { force: true }); continue; }
      fs.renameSync(tmp, listPath);
      console.log(`marked done: ${listPath}`);
      return;
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
      throw err;
    }
  }
  throw new Error('the list kept changing — rerun once the browser finished writing');
}

async function cmdChanges(argv) {
  const opts = parseChanges(argv);
  if (opts.help) { console.log(USAGE.changes); process.exit(0); }
  if (!opts.file) { console.error(USAGE.changes); process.exit(2); }
  if (opts.done && opts.json) fail('--done and --json cannot be combined (use one at a time)', 2, USAGE.changes);
  const file = resolveHtml(opts.file, USAGE.changes);
  const listPath = changesFileFor(file);

  let data;
  try { data = loadList(listPath); }
  catch (err) { fail(err.message, err.exitCode || 2); }
  if (!data) fail(`no revamp list for ${file} (expected ${listPath})`, 1);

  if (opts.done) {
    try { markDone(listPath); }
    catch (err) { fail(`cannot write ${listPath}: ${err.message}`, 2); }
    return;
  }
  printList(file, data, opts.json);
}

function createdAtMs(data, listPath) {
  const parsed = Date.parse(data.createdAt || '');
  if (Number.isFinite(parsed)) return parsed;
  try { return fs.statSync(listPath).mtimeMs; } catch (_) { return 0; }
}

function isFresh(data, listPath, startedAt) {
  if (data.status !== 'pending') return false;
  if (createdAtMs(data, listPath) > startedAt) return true;
  try { return fs.statSync(listPath).mtimeMs > startedAt; } catch (_) { return false; }
}

async function cmdWait(argv) {
  const opts = parseWait(argv);
  if (opts.help) { console.log(USAGE.wait); process.exit(0); }
  if (!opts.file) { console.error(USAGE.wait); process.exit(2); }
  const file = resolveHtml(opts.file, USAGE.wait);
  const listPath = changesFileFor(file);
  const startedAt = Date.now();
  const deadline = startedAt + opts.timeout * 1000;

  let watcher = null;
  let kick = () => {};
  try { watcher = fs.watch(path.dirname(file), () => kick()); } catch (_) { watcher = null; }

  let timer = null;
  const waiter = new Promise(resolve => {
    let finished = false;
    timer = setInterval(check, 1000);
    kick = check;

    function finish(value) {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (watcher) { try { watcher.close(); } catch (_) {} }
      resolve(value);
    }

    function check() {
      if (finished) return;
      let data = null;
      try { data = loadList(listPath); } catch (_) { data = null; }   // half-written JSON: retry
      if (data && isFresh(data, listPath, startedAt)) return finish({ data });
      if (Date.now() >= deadline) return finish({ timeout: true });
    }

    process.on('SIGINT', () => { if (watcher) { try { watcher.close(); } catch (_) {} } process.exit(130); });
    check();
  });

  const res = await waiter;
  if (res.timeout) {
    console.error(`timed out after ${opts.timeout}s waiting for a fresh revamp list: ${listPath}`);
    process.exit(3);
  }
  printList(file, res.data, opts.json);
}

// ---------- install-skill ----------
//
// Copies every file of skills/riffledesk into a skills folder. Identical copy:
// say so, touch nothing. Different copy: keep the old one under a partner
// "skills-backup" directory BESIDE the skills folder (a *.bak next to the skill
// would be loaded by Claude Code as a second skill), then swap a freshly written
// temp folder into place, so a failure mid-copy never leaves the target missing.
// User files a previous version left behind in the target are not carried over —
// the target mirrors the bundled skill.

function bundledSkillDir() {
  return path.join(ROOT, 'skills', 'riffledesk');
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

// Everything the package ships with; the source directory is the single truth,
// so a file added later is picked up without touching this command.
function bundledFiles() {
  return fs.readdirSync(bundledSkillDir(), { withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => d.name)
    .sort();
}

function sameContents(srcDir, dstDir, names) {
  for (const name of names) {
    if (readIfExists(path.join(dstDir, name)) !== readIfExists(path.join(srcDir, name))) return false;
  }
  return true;
}

function copySkill(srcDir, dstDir, names) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const name of names) fs.copyFileSync(path.join(srcDir, name), path.join(dstDir, name));
}

// Windows hands out EPERM/EBUSY on a rename while a scanner or indexer still
// holds the folder; a short retry clears it. Other errors surface at once.
function renameWithRetry(from, to, attempts = 5) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); }
    catch (err) {
      const transient = err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES';
      if (!transient || i === attempts - 1) throw err;
      const until = Date.now() + 40 * (i + 1);
      while (Date.now() < until) { /* brief spin: a sync sleep keeps this simple */ }
    }
  }
}

// skills-backup/riffledesk-<stamp>/ beside the skills folder; a same-second repeat
// gets a -2, -3… suffix instead of overwriting the earlier copy. The parent is
// created here so a first-ever run cannot fail on a missing directory, and only
// the newest BACKUP_KEEP copies are left (a timestamped series never cleans itself).
const BACKUP_KEEP = 10;

function backupDirFor(base) {
  const parent = path.join(path.dirname(path.resolve(base)), 'skills-backup');
  fs.mkdirSync(parent, { recursive: true });
  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const candidate = path.join(parent, `riffledesk-${stamp}`);
  let dir = candidate;
  for (let i = 2; ; i++) {
    try { fs.mkdirSync(dir); return dir; }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      dir = `${candidate}-${i}`;
    }
  }
}

function pruneBackups(base) {
  const parent = path.join(path.dirname(path.resolve(base)), 'skills-backup');
  let names;
  try { names = fs.readdirSync(parent).filter(n => n.startsWith('riffledesk-')).sort(); } catch (_) { return; }
  for (const n of names.slice(0, Math.max(0, names.length - BACKUP_KEEP))) {
    try { fs.rmSync(path.join(parent, n), { recursive: true, force: true }); } catch (_) {}
  }
}

async function cmdInstallSkill(argv) {
  const opts = parseInstallSkill(argv);
  if (opts.help) { console.log(USAGE.installSkill); process.exit(0); }

  const srcDir = bundledSkillDir();
  const names = fs.existsSync(path.join(srcDir, 'SKILL.md')) ? bundledFiles() : [];
  if (!names.length) fail(`no bundled skill at ${srcDir}`, 1, USAGE.installSkill);

  const base = opts.dest
    ? path.resolve(expandHome(opts.dest))
    : path.join(os.homedir(), '.claude', 'skills');
  const target = path.join(base, 'riffledesk');

  // an older release kept its backup at skills/riffledesk.bak, right where Claude
  // Code loads a second skill from: move it out before anything else
  const legacy = path.join(base, 'riffledesk.bak');
  if (fs.existsSync(legacy)) {
    try {
      fs.cpSync(legacy, backupDirFor(base), { recursive: true, verbatimSymlinks: true });
      fs.rmSync(legacy, { recursive: true, force: true });
      console.log(`moved the old ${legacy} out of the skills folder`);
    } catch (err) {
      console.error(`could not move ${legacy} (${err.message}); it may load as a second skill`);
    }
  }

  // lstat, not stat: a symlinked target is reported instead of being silently
  // flattened into a copy of whatever it points at.
  let entry = null;
  try { entry = fs.lstatSync(target); } catch (_) {}
  if (entry && entry.isSymbolicLink()) {
    fail(`${target} is a symbolic link — replace it with a real folder first`, 1, USAGE.installSkill);
  }
  const existed = !!entry && entry.isDirectory();
  if (existed && sameContents(srcDir, target, names)) {
    pruneBackups(base);
    console.log(`already up to date: ${target}`);
    return;
  }

  const tmp = path.join(base, `.riffledesk-tmp-${process.pid}-${Date.now().toString(36)}`);
  let backup = null;
  try {
    copySkill(srcDir, tmp, names);
    if (entry && !existed) fs.rmSync(target, { force: true });   // a plain file sat there
    if (existed) {
      backup = backupDirFor(base);
      fs.cpSync(target, backup, { recursive: true, verbatimSymlinks: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
    renameWithRetry(tmp, target);
    pruneBackups(base);
    console.log(existed
      ? `replaced differing copy — previous one kept at ${backup}`
      : `installed: ${target}`);
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    const kept = existed ? ` (previous copy still at ${backup || target})` : '';
    fail(`cannot install into ${target}: ${err.message}${kept}`, 1);
  }
}

// ---------- hook (Claude Code Stop-hook reminder) ----------
//
// Opt-in: `hook install` merges one Stop-hook entry into the settings file,
// `hook check` is what Claude Code then runs when an agent stops. `check` gets
// the hook payload on stdin ({session_id, transcript_path, stop_hook_active})
// and must never block wrongly: stop_hook_active (a block already fired this
// stop), a missing transcript and every read/parse error all exit 0 silently.

function parseHookArgs(argv) {
  const opts = { settings: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { for (const rest of argv.slice(i + 1)) fail(`unexpected argument: ${rest}`, 2, USAGE.hook); break; }
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--settings') opts.settings = valueArg(argv, i++, '--settings', USAGE.hook);
    else if (a.startsWith('--settings=')) {
      opts.settings = a.slice(11);
      if (!opts.settings) fail('empty value for --settings — give a file path', 2, USAGE.hook);
    }
    else fail(`unknown option: ${a}`, 2, USAGE.hook);
  }
  return opts;
}

// Bounded stdin read: a hook always gets a small JSON payload then EOF, but a
// stuck or terminal stdin must not hang the agent's stop.
function readHookStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { process.stdin.pause(); } catch (_) {}
      resolve(data);
    };
    const timer = setTimeout(finish, 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => {
      data += c;
      if (data.length > 1024 * 1024) { data = data.slice(0, 1024 * 1024); finish(); }
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    try { process.stdin.resume(); } catch (_) {}
  });
}

function cmdHookCheck() {
  return readHookStdin().then(raw => {
    try {
      let input;
      try { input = JSON.parse(raw); } catch (_) { return; }
      if (!input || typeof input !== 'object') return;
      if (input.stop_hook_active === true) return;              // never loop
      const tp = input.transcript_path;
      if (typeof tp !== 'string' || !tp) return;
      const tail = hooklib.readTail(tp);
      if (tail === null) return;
      const { files, shown } = hooklib.analyzeTail(tail);
      if (!files.length || shown) return;
      const kept = hooklib.deliverableFiles(files);
      if (!kept.length) return;
      console.log(JSON.stringify({ decision: 'block', reason: hooklib.blockReason(kept) }));
    } catch (_) {
      // a broken nudge must never block the agent
    }
    process.exit(0);
  });
}

function cmdHook(argv) {
  const sub = argv[0];
  if (sub === 'check') return cmdHookCheck();
  if (sub === '-h' || sub === '--help') { console.log(USAGE.hook); process.exit(0); }
  if (sub === undefined) { console.error(USAGE.hook); process.exit(2); }
  if (sub !== 'install' && sub !== 'uninstall' && sub !== 'status') {
    fail(`unknown hook command: ${sub}`, 2, USAGE.hook);
  }
  const opts = parseHookArgs(argv.slice(1));
  if (opts.help) { console.log(USAGE.hook); process.exit(0); }
  const settingsPath = path.resolve(expandHome(opts.settings || hooklib.defaultSettingsPath()));

  if (sub === 'status') {
    const s = hooklib.status(settingsPath);
    if (s.warning) console.error(`${PKG.name}: warning — ${s.warning}`);
    console.log(s.installed ? `installed (${settingsPath})` : `not installed (${settingsPath})`);
    process.exitCode = s.installed ? 0 : 1;
    return;
  }
  const run = sub === 'install'
    ? () => hooklib.install(settingsPath, __filename)
    : () => hooklib.uninstall(settingsPath);
  let res;
  try { res = run(); }
  catch (err) {
    fail(err.settingsError ? err.message : `cannot ${sub} the hook: ${err.message}`, err.settingsError ? 2 : 1, USAGE.hook);
  }
  console.log(res.message);
}

async function cmdStart(argv) {
  const opts = parseStart(argv);
  if (opts.help) { usage(); process.exit(0); }
  if (!opts.foreground) {
    await ensureServer(opts.port);
    const url = `http://${HOST}:${opts.port}/`;
    console.log(`${PKG.name} running in background at ${url}`);
    if (opts.open && !openBrowser(url)) console.log(`open ${url} in your browser`);
    return;
  }
  let server, port;
  try {
    ({ server, port } = await listenWithRetry(opts.port));
  } catch (err) {
    console.error(`${PKG.name}: cannot start — ${err.message}`);
    process.exit(1);
  }
  const url = `http://${HOST}:${port}/`;
  if (port !== opts.port) console.log(`port ${opts.port} was busy — using ${port}`);
  console.log(`${PKG.name} v${PKG.version} listening on ${url} (Ctrl+C to stop)`);
  if (opts.open) {
    if (!openBrowser(url)) console.log(`open ${url} in your browser`);
  }
  // keep the process alive around the in-process server; Ctrl+C ends it
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdService(action, argv) {
  const opts = parseStart(argv);
  if (opts.help) { usage(); return; }
  let current;
  try { current = await request(opts.port, 'GET', '/api/service', { timeout: 1500 }); }
  catch (err) {
    if (err.code !== 'ECONNREFUSED') throw err;
    if (action === 'restart') return cmdStart(['--port', String(opts.port), '--no-open']);
    console.log('riffledesk is stopped'); return;
  }
  const service = current.data;
  if (current.status !== 200 || service?.name !== PKG.name || !service.instanceId) {
    fail(`port ${opts.port} has an older or unrelated server; stop that instance manually first`, 1);
  }
  if (action === 'status') {
    console.log(`${PKG.name} v${service.version} running at http://${HOST}:${opts.port}/ (pid ${service.pid})`);
    return;
  }
  const r = await request(opts.port, 'POST', `/api/service/${action}`, {
    body: { instanceId: service.instanceId },
    headers: { 'X-RiffleDesk-CLI': '1' }
  });
  if (r.status !== 200 || !r.data?.ok) fail(r.data?.error || `server answered ${r.status}`, 1);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 150));
    try {
      const next = await request(opts.port, 'GET', '/api/service', { timeout: 1000 });
      if (action === 'restart' && next.data?.instanceId && next.data.instanceId !== service.instanceId) {
        console.log(`${PKG.name} v${next.data.version} restarted`); return;
      }
    } catch (err) {
      if (action === 'stop' && err.code === 'ECONNREFUSED') { console.log('riffledesk stopped'); return; }
    }
  }
  fail(`${action} did not complete — see ${logFileFor(opts.port)}`, 1);
}

function listenWithRetry(basePort) {
  const { start } = require(path.join(ROOT, 'server.js'));
  return new Promise((resolve, reject) => {
    let port = basePort;
    const maxPort = basePort + 10;
    const attempt = () => {
      let server;
      try { server = start(port); } catch (err) { return reject(err); }
      server.on('error', err => {
        if (err.code === 'EADDRINUSE' && port < maxPort) { port++; attempt(); return; }
        reject(err);
      });
      server.on('listening', () => resolve({ server, port }));
    };
    attempt();
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (first === '-h' || first === '--help') { usage(); return; }
  if (first === 'help') { usage(); return; }
  if (first === 'open') return cmdOpen(argv.slice(1));
  if (first === 'show') return cmdShow(argv.slice(1));
  if (first === 'search') return cmdSearch(argv.slice(1));
  if (first === 'changes') return cmdChanges(argv.slice(1));
  if (first === 'wait') return cmdWait(argv.slice(1));
  if (first === 'install-skill') return cmdInstallSkill(argv.slice(1));
  if (first === 'hook') return cmdHook(argv.slice(1));
  if (['status', 'stop', 'restart'].includes(first)) return cmdService(first, argv.slice(1));
  if (first && !first.startsWith('-') && !/^\d+$/.test(first)) fail(`unknown command: ${first}`, 2, usageText());
  return cmdStart(argv);
}

main().catch(err => {
  console.error(`${PKG.name}: ${err && err.message || err}`);
  process.exit(1);
});
