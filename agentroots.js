// agentroots.js — discover the folders where AI agents actually work, so the full-text
// index can include them automatically ("find the files your agents made").
//
// Cheap by design: bounded directory scans and small file heads/tails, never a drive walk.
// Delivered files (piles, projections) are mapped up to the nearest project folder by
// marker file. Everything is filtered: drive roots, the home directory itself, missing
// paths, out-of-scope paths, and anything already inside another root all drop out;
// nested candidates collapse to the outermost one.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';
const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 128 * 1024;
const JSON_BYTES = 512 * 1024;
const MAX_FILES = 200;          // paths whose contents are read, per source
const MAX_SCAN_ENTRIES = 2000;  // metadata work is bounded too; keep newest MAX_FILES
const PER_SLUG = 3;             // newest sessions read per Claude project slug
const MAX_WALK_UP = 16;
const MAX_ROOTS = 50;           // bound on how broad the auto-index may get
const VSCODE_APPS = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'Antigravity', 'Antigravity IDE', 'VSCodium'];

function normKey(p) { return IS_WIN ? String(p).toLowerCase() : String(p); }

function isFsRoot(p) {
  return IS_WIN ? /^[a-z]:[\\/]?$/i.test(p) : p === path.sep;
}

function readText(abs, cap = HEAD_BYTES, tail = false) {
  let fd;
  try {
    // Do not open a FIFO/device supplied by a malformed session tree.
    if (!fs.statSync(abs).isFile()) return '';
    fd = fs.openSync(abs, 'r');
    const size = fs.fstatSync(fd).size;
    if (!fs.fstatSync(fd).isFile()) return '';
    const start = tail ? Math.max(0, size - cap) : 0;
    const buf = Buffer.alloc(Math.min(cap, Math.max(0, size - start)));
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, start + n);
      if (!got) break;
      n += got;
    }
    let text = buf.subarray(0, n).toString('utf8').replace(/^﻿/, '');
    if (tail && start > 0) {
      const previous = Buffer.alloc(1);
      fs.readSync(fd, previous, 0, 1, start - 1);
      if (previous[0] !== 10) { // only discard a genuinely cut first record
        const newline = text.indexOf('\n');
        text = newline < 0 ? '' : text.slice(newline + 1);
      }
    }
    return text;
  } catch (_) { return ''; } finally { try { if (fd !== undefined) fs.closeSync(fd); } catch (_) {} }
}

// first HEAD_BYTES of a file, split into lines. A cut final JSON record simply does not
// parse; a complete final line without a trailing newline remains usable.
function readHead(abs) {
  const text = readText(abs);
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

function firstLine(abs) { return readText(abs).split(/\r?\n/, 1)[0].trim(); }
function readJson(abs) { try { return JSON.parse(readText(abs, JSON_BYTES)); } catch (_) { return null; } }

// a line's requested path field, if any. Codex keeps cwd inside session_meta payload.
function pathFieldOf(line, field = 'cwd') {
  if (!line || line.indexOf(field) === -1) return null;
  let d;
  try { d = JSON.parse(line); } catch (_) { return null; }
  const c = d && (d[field] || (field === 'cwd' && d.payload && d.payload.cwd));
  return typeof c === 'string' && c ? c : null;
}

function cwdOf(line) { return pathFieldOf(line, 'cwd'); }

function newestFiles(dir, filter, limit) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of ents.slice(0, MAX_SCAN_ENTRIES)) {
    if (!e.isFile() || !filter(e.name)) continue;
    const abs = path.join(dir, e.name);
    try { out.push({ abs, mtime: fs.statSync(abs).mtimeMs }); } catch (_) {}
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit).map(f => f.abs);
}

function childDirs(dir, limit = MAX_FILES) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of ents.slice(0, MAX_SCAN_ENTRIES)) {
    if (!e.isDirectory()) continue;
    const abs = path.join(dir, e.name);
    let mtime = 0;
    try { mtime = fs.statSync(abs).mtimeMs; } catch (_) {}
    out.push({ abs, name: e.name, mtime });
  }
  out.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  return out.slice(0, limit);
}

function walkFiles(dir, filter, depth, out, cap = MAX_SCAN_ENTRIES) {
  if (out.length >= cap || depth > 8) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    if (out.length >= cap) return;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(abs, filter, depth + 1, out, cap);
    else if (e.isFile() && filter(e.name)) {
      let mtime = 0;
      try { mtime = fs.statSync(abs).mtimeMs; } catch (_) { continue; }
      out.push({ abs, mtime });
    }
  }
}

function treeFiles(dir, filter, cap = MAX_SCAN_ENTRIES) {
  const found = [];
  walkFiles(dir, filter, 0, found, cap);
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, Math.min(cap, MAX_FILES)).map(f => f.abs);
}

function cleanPath(value) {
  if (typeof value !== 'string') return null;
  let p = value.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1);
  if (!p) return null;
  if (/^file:/i.test(p)) {
    try {
      const u = new URL(p);
      // Session files are untrusted paths: never turn a record into network I/O.
      if (u.hostname && u.hostname.toLowerCase() !== 'localhost') return null;
      p = decodeURIComponent(u.pathname);
      if (/^\/[a-z]:\//i.test(p)) p = p.slice(1);
    } catch (_) { return null; }
  }
  if (/[\u0000-\u001f]/.test(p) || p.startsWith('\\\\') || p.startsWith('//') || !path.isAbsolute(p)) return null;
  return p;
}

function fieldsOf(value, fields, out, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4 || out.length >= MAX_FILES) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_SCAN_ENTRIES)) fieldsOf(item, fields, out, depth + 1);
    return;
  }
  for (const field of fields) {
    if (typeof value[field] === 'string' && value[field] && out.length < MAX_FILES) out.push(value[field]);
  }
}

// Claude Code + Codex session heads → distinct cwds
function legacySessionCwds(home) {
  const cwds = [];
  // Claude: <home>/.claude/projects/<slug>/*.jsonl
  const claudeDir = path.join(home, '.claude', 'projects');
  const slugs = childDirs(claudeDir);
  let budget = MAX_FILES;
  for (const s of slugs) {
    if (budget <= 0) break;
    const files = newestFiles(s.abs, n => n.endsWith('.jsonl'), Math.min(PER_SLUG, budget));
    budget -= files.length;
    for (const abs of files) {
      for (const line of readHead(abs)) {
        const c = cwdOf(line);
        if (c) { cwds.push(c); break; }
      }
    }
  }
  // Codex: <home>/.codex*/sessions/**/*.jsonl — newest first, capped
  let homeEnts = [];
  try { homeEnts = fs.readdirSync(home, { withFileTypes: true }); } catch (_) {}
  for (const e of homeEnts) {
    if (!e.isDirectory() || !e.name.startsWith('.codex')) continue;
    for (const abs of treeFiles(path.join(home, e.name, 'sessions'), n => n.endsWith('.jsonl'))) {
      for (const line of readHead(abs)) {
        if (line.indexOf('session_meta') === -1) continue;
        const c = cwdOf(line);
        if (c) { cwds.push(c); break; }
      }
    }
  }
  return cwds;
}

function jsonlCwds(abs, field) {
  const out = [];
  // The newest records are at the tail; only that bounded tail is decoded.
  const lines = readText(abs, TAIL_BYTES, true).split('\n').reverse();
  for (const line of lines.slice(0, MAX_FILES)) {
    const c = pathFieldOf(line, field);
    if (c) out.push(c);
  }
  return out;
}

function firstRecordCwds(files, field = 'cwd') {
  const out = [];
  for (const abs of files) {
    const c = pathFieldOf(readText(abs).split('\n', 1)[0], field);
    if (c) out.push(c);
  }
  return out;
}

function agentBase(home, envName, relative) {
  return path.resolve(process.env[envName] || path.join(home, relative));
}

function appDataDir(home) {
  if (process.env.RIFFLEDESK_AGENT_APPDATA) return path.resolve(process.env.RIFFLEDESK_AGENT_APPDATA);
  // A fake agent home must never fall through to the real machine's editor data.
  if (process.env.RIFFLEDESK_AGENT_HOME) {
    if (IS_WIN) return path.join(home, 'AppData', 'Roaming');
    if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support');
    return path.join(home, '.config');
  }
  if (IS_WIN) return process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(home, '.config');
}

// One row per cheap source. `watch` names existing parents to watch; any event reruns
// only that adapter. Adding another file format later should not require watcher changes.
const SOURCE_ADAPTERS = [
  {
    name: 'gemini',
    watch(home) {
      const base = agentBase(home, 'GEMINI_CLI_HOME', '.gemini');
      return [path.join(base, 'tmp'), path.join(base, 'history')];
    },
    read(home) {
      const out = [];
      for (const dir of this.watch(home)) {
        for (const s of childDirs(dir)) {
          if (['tmp', 'temp', 'user', 'default', 'unknown'].includes(s.name.toLowerCase())) continue;
          const c = firstLine(path.join(s.abs, '.project_root'));
          if (c) out.push(c);
        }
      }
      return out;
    }
  },
  {
    name: 'antigravity-cli',
    watch(home) { return [path.join(agentBase(home, 'GEMINI_CLI_HOME', '.gemini'), 'antigravity-cli')]; },
    read(home) { return jsonlCwds(path.join(this.watch(home)[0], 'history.jsonl'), 'workspace'); }
  },
  {
    name: 'grok',
    watch(home) { return [path.join(agentBase(home, 'GROK_HOME', '.grok'), 'sessions')]; },
    read(home) {
      const out = [];
      for (const group of childDirs(this.watch(home)[0])) {
        const marker = firstLine(path.join(group.abs, '.cwd'));
        if (marker) { out.push(marker); continue; }
        try { out.push(decodeURIComponent(group.name)); } catch (_) {}
      }
      return out;
    }
  },
  {
    name: 'copilot',
    watch(home) { return [path.join(agentBase(home, 'COPILOT_HOME', '.copilot'), 'session-state')]; },
    read(home) {
      const out = [];
      for (const session of childDirs(this.watch(home)[0])) {
        const text = readText(path.join(session.abs, 'workspace.yaml'));
        const match = text.match(/^\s*cwd\s*:\s*(.+?)\s*$/m);
        if (match) out.push(match[1]);
      }
      return out;
    }
  },
  {
    name: 'factory-droid',
    watch(home) { return [path.join(agentBase(home, 'FACTORY_HOME_OVERRIDE', '.factory'), 'sessions')]; },
    read(home) { return firstRecordCwds(treeFiles(this.watch(home)[0], n => n.endsWith('.jsonl'))); }
  },
  {
    name: 'qwen-code',
    watch(home) { return [path.join(home, '.qwen', 'projects')]; },
    read(home) { return firstRecordCwds(treeFiles(this.watch(home)[0], n => n.endsWith('.jsonl'))); }
  },
  {
    name: 'continue',
    watch(home) { return [path.join(agentBase(home, 'CONTINUE_GLOBAL_DIR', '.continue'), 'sessions')]; },
    read(home) {
      const data = readJson(path.join(this.watch(home)[0], 'sessions.json'));
      const out = [];
      if (Array.isArray(data)) fieldsOf(data, ['workspaceDirectory'], out);
      return out;
    }
  },
  {
    name: 'amp',
    watch(home) { return [path.join(home, '.local', 'share', 'amp')]; },
    read(home) { return jsonlCwds(path.join(this.watch(home)[0], 'history.jsonl'), 'cwd'); }
  },
  {
    name: 'cline-cli',
    watch(home) { return [agentBase(home, 'CLINE_DATA_DIR', path.join('.cline', 'data'))]; },
    read(home) {
      const out = [];
      for (const abs of treeFiles(this.watch(home)[0], n => n.endsWith('.json'), 40)) {
        const data = readJson(abs);
        if (data && !Array.isArray(data) && typeof data.cwd === 'string') out.push(data.cwd);
      }
      return out;
    }
  },
  {
    name: 'vscode-roo-cline',
    watch(home) {
      const appdata = appDataDir(home);
      return VSCODE_APPS.map(app => path.join(appdata, app, 'User', 'globalStorage'));
    },
    read(home) {
      const out = [];
      for (const storage of this.watch(home)) {
        const roo = readJson(path.join(storage, 'rooveterinaryinc.roo-cline', 'tasks', '_index.json'));
        if (roo && Array.isArray(roo.entries)) fieldsOf(roo.entries, ['workspace'], out);
        const cline = path.join(storage, 'saoudrizwan.claude-dev');
        for (const rel of ['taskHistory.json', path.join('tasks', 'taskHistory.json')]) {
          const history = readJson(path.join(cline, rel));
          if (Array.isArray(history)) fieldsOf(history, ['cwd', 'workspace', 'cwdOnTaskInitialization'], out);
        }
        for (const abs of treeFiles(path.join(cline, 'sessions'), n => n.endsWith('.json'), 40)) {
          const data = readJson(abs);
          if (data && !Array.isArray(data)) fieldsOf(data, ['cwd', 'workspace', 'workspace_root'], out);
        }
      }
      return out;
    }
  }
];

// a delivered file → the nearest ancestor folder that looks like a project; its own
// folder when no marker is found all the way up
const MARKERS = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.git'];
function projectFolderOf(fileAbs) {
  const dir = path.dirname(path.resolve(fileAbs));
  let cur = dir;
  for (let i = 0; i < MAX_WALK_UP; i++) {
    for (const m of MARKERS) {
      try { if (fs.existsSync(path.join(cur, m))) return cur; } catch (_) {}
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return dir;
}

function coveredBy(candidate, roots) {
  const n = normKey(candidate);
  for (const r of roots) {
    const rn = normKey(String(r).replace(/[\\/]+$/, ''));
    if (n === rn) return true;
    if (n.startsWith(rn + path.sep)) return true;
  }
  return false;
}

// watcher on the session folders. Legacy transcripts keep their one-file-head fast path;
// other adapters rerun their own bounded read on a debounced directory event.
// Returns null when no folder could be watched (caller then falls back to a daily rescan).
function watchSessions(opts = {}) {
  const home = path.resolve(opts.home || process.env.RIFFLEDESK_AGENT_HOME || os.homedir());
  const onCwd = typeof opts.onCwd === 'function' ? opts.onCwd : () => {};
  const watchers = [];
  const deep = typeof opts.recursive === 'boolean' ? opts.recursive : true;
  const pending = new Map();
  const seenSize = new Map();
  const armedDirs = new Set();

  const handleFile = abs => {
    if (!abs || !abs.toLowerCase().endsWith('.jsonl')) return;
    let size = 0;
    try { size = fs.statSync(abs).size; } catch (_) { return; }
    if (seenSize.get(abs) === size) return;
    clearTimeout(pending.get(abs));
    pending.set(abs, setTimeout(() => {
      pending.delete(abs);
      seenSize.set(abs, size);
      for (const line of readHead(abs)) {
        const c = cwdOf(line);
        if (c) { onCwd(cleanPath(c)); return; }
      }
    }, 2000));
    if (pending.get(abs).unref) pending.get(abs).unref();
  };

  const arm = (dir, depth, onEvent) => {
    const key = normKey(dir) + '|' + (onEvent ? 'adapter' : 'legacy');
    if (armedDirs.has(key)) return true;
    let w;
    try { w = fs.watch(dir, { recursive: depth }, onEvent || ((_ev, name) => {
      if (!name) return;
      const rel = String(name);
      const abs = path.isAbsolute(rel) ? rel : path.join(dir, rel);
      if (!deep) {
        try { if (fs.statSync(abs).isDirectory()) { for (const n of fs.readdirSync(abs)) handleFile(path.join(abs, n)); } } catch (_) {}
        return;
      }
      handleFile(abs);
    })); } catch (_) { return false; }
    w.on('error', () => { try { w.close(); } catch (_) {} });
    if (w.unref) w.unref();
    watchers.push(w);
    armedDirs.add(key);
    return true;
  };

  const claudeDir = path.join(home, '.claude', 'projects');
  let armed = 0;
  if (arm(claudeDir, deep)) armed++;
  else if (fs.existsSync(claudeDir)) {
    for (const s of childDirs(claudeDir)) if (arm(s.abs, false)) armed++;
  }
  try {
    for (const e of fs.readdirSync(home, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('.codex')) continue;
      const dir = path.join(home, e.name, 'sessions');
      if (fs.existsSync(dir) && arm(dir, deep)) armed++;
    }
  } catch (_) {}

  for (const source of SOURCE_ADAPTERS) {
    const rerun = () => {
      const key = 'source:' + source.name;
      clearTimeout(pending.get(key));
      pending.set(key, setTimeout(() => {
        pending.delete(key);
        let cwds = [];
        try { cwds = source.read(home); } catch (_) {}
        for (const cwd of cwds) { const cleaned = cleanPath(cwd); if (cleaned) onCwd(cleaned); }
      }, 2000));
      if (pending.get(key).unref) pending.get(key).unref();
    };
    for (const dir of source.watch(home)) if (arm(dir, deep, rerun)) armed++;
  }

  if (!armed) return null;
  return {
    stop() {
      for (const t of pending.values()) clearTimeout(t);
      for (const w of watchers) { try { w.close(); } catch (_) {} }
      watchers.length = 0;
    }
  };
}

// discover({ home?, isAllowed?, existingRoots?, deliveredFiles?, cwds? }) -> string[]
function discover(opts = {}) {
  const home = path.resolve(opts.home || process.env.RIFFLEDESK_AGENT_HOME || os.homedir());
  const isAllowed = typeof opts.isAllowed === 'function' ? opts.isAllowed : () => true;
  const existing = (opts.existingRoots || []).map(String);
  const candidates = [];

  if (opts.cwds) candidates.push(...opts.cwds);
  else {
    candidates.push(...legacySessionCwds(home));
    for (const source of SOURCE_ADAPTERS) {
      try { candidates.push(...source.read(home)); } catch (_) {}
    }
  }
  for (const f of opts.deliveredFiles || []) {
    if (typeof f !== 'string' || !f) continue;
    candidates.push(projectFolderOf(f));
  }

  return select(candidates.map(cleanPath).filter(Boolean), { home, isAllowed, existingRoots: existing });
}

// filter + collapse a candidate list (discover() and the session watcher share it)
// Agents also run in system and scratch folders (a session started in
// System32, a test harness in %TEMP%) — those are not workspaces anyone browses,
// and indexing them would crawl OS files or churn on throwaway temp trees.
function isSystemOrTemp(abs, home) {
  const n = normKey(abs);
  const under = p => { if (!p) return false; const k = normKey(path.resolve(p)); return n === k || n.startsWith(k + path.sep); };
  const sys = process.platform === 'win32'
    ? [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles, process.env['ProgramFiles(x86)'],
       process.env.ProgramData, path.join(home, 'AppData')]
    : ['/tmp', '/var', '/private', '/usr', '/bin', '/sbin', '/etc', '/opt', '/System', '/Library',
       '/Applications', path.join(home, 'Library')];
  let tmp = null; try { tmp = os.tmpdir(); } catch (_) {}
  // test fixtures live in the temp dir; only there is temp a legitimate workspace
  return sys.some(under) || (process.env.NODE_ENV !== 'test' && under(tmp)) || isCloudSync(abs);
}

// Cloud-synced folders (Google Drive, OneDrive, Dropbox, iCloud) stream files on demand:
// crawling them for content would download the user's whole drive. Never auto-index them.
const CLOUD_RE = /(^|[\\/])(my drive|我的雲端硬碟|shared drives|共用雲端硬碟|onedrive( - [^\\/]*)?|dropbox|icloud ?drive|google ?drive|cloudstorage|mobile documents)([\\/]|$)/i;
function isCloudSync(abs) {
  if (CLOUD_RE.test(abs)) return true;
  try { return CLOUD_RE.test(fs.realpathSync.native(abs)); } catch (_) { return false; }
}

function select(candidates, opts = {}) {
  const home = path.resolve(opts.home || process.env.RIFFLEDESK_AGENT_HOME || os.homedir());
  const isAllowed = typeof opts.isAllowed === 'function' ? opts.isAllowed : () => true;
  const existing = (opts.existingRoots || []).map(String);
  // The agent transcript homes themselves are never workspaces.
  const homes = [
    path.join(home, '.claude'), path.join(home, '.gemini'), path.join(home, '.grok'),
    path.join(home, '.copilot'), path.join(home, '.factory'), path.join(home, '.qwen'),
    path.join(home, '.continue'), path.join(home, '.cline'), path.join(home, '.local', 'share', 'amp'),
    ...['COPILOT_HOME', 'FACTORY_HOME_OVERRIDE', 'CLINE_DATA_DIR', 'GROK_HOME', 'CONTINUE_GLOBAL_DIR', 'GEMINI_CLI_HOME']
      .filter(k => process.env[k]).map(k => path.resolve(process.env[k]))
  ];
  try {
    for (const e of fs.readdirSync(home, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith('.codex')) homes.push(path.join(home, e.name));
    }
  } catch (_) {}
  const isAgentHome = abs => homes.some(h => normKey(abs) === normKey(h) || normKey(abs).startsWith(normKey(h) + path.sep));
  const seen = new Set();
  const kept = [];
  for (const original of candidates) {
    const raw = cleanPath(original);
    if (!raw) continue;
    let abs;
    try { abs = path.resolve(raw); } catch (_) { continue; }
    const n = normKey(abs);
    if (seen.has(n)) continue;
    seen.add(n);
    if (isFsRoot(abs)) continue;
    if (n === normKey(home)) continue;
    if (isAgentHome(abs)) continue;
    if (isSystemOrTemp(abs, home)) continue;
    let st;
    try { st = fs.statSync(abs); } catch (_) { continue; }
    if (!st.isDirectory()) continue;
    if (existing.length && coveredBy(abs, existing)) continue;
    try { if (!isAllowed(abs)) continue; } catch (_) { continue; }
    kept.push(abs);
  }

  // collapse nesting: shortest first, drop anything already inside a kept root
  // many sibling workspaces (benchmark runs, one folder per task) → one root at
  // their parent, unless that parent is a drive root / home / system folder
  const byParent = new Map();
  for (const c of kept) { const p = path.dirname(c); byParent.set(p, (byParent.get(p) || 0) + 1); }
  for (const [p, cnt] of byParent) {
    if (cnt >= 3 && !isFsRoot(p) && normKey(p) !== normKey(home) && !isAgentHome(p) && !isSystemOrTemp(p, home)) kept.push(p);
  }
  kept.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const out = [];
  for (const c of kept) { if (out.length >= MAX_ROOTS) break; if (!coveredBy(c, out)) out.push(c); }
  return out;
}

module.exports = { discover, select, projectFolderOf, watchSessions };
