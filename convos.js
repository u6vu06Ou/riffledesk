// convos.js — scan AI coding-agent transcripts (Claude Code / Codex) and report which files
// each conversation wrote. Zero dependencies, Node built-ins only.
//
// Claude Code: <home>/.claude/projects/<project-slug>/*.jsonl — one JSON object per line;
//   assistant messages carry tool_use blocks ({"name":"Write|Edit|MultiEdit","input":{"file_path":…}}
//   or NotebookEdit with {"notebook_path":…}); user messages give the conversation title.
// Codex: <home>/.codex*/sessions/**/*.jsonl (any ~/.codex* home) — lines are
//   {type, payload, timestamp}; apply_patch calls contain "*** Add File: <path>" /
//   "*** Update File: <path>" markers; relative paths resolve against session_meta cwd.
//   exec-wrapped patches arrive as a JS string literal whose newlines are two-char "\n"
//   sequences — only n/t/r escapes are unfolded (paths keep single backslashes; a "\\n"
//   sequence in patch CONTENT must NOT become a line break, or ghost Add File lines appear).
//
// Transcripts are tens of MB: files are streamed line by line, only lines carrying the
// file_path / patch markers (plus structurally interesting meta/user lines) are JSON.parsed,
// and results are cached per file by (size, mtime) so warm scans cost one directory walk.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const IS_WIN = process.platform === 'win32';
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_TITLE = 80;
const MAX_TITLE_PARSE = 8 * 1024 * 1024; // first messages often carry pasted screenshots (base64)      // a user line longer than this and without markers is never a title
const MAX_LINE_BUF = 8 * 1024 * 1024; // one pathological mega-line may not eat unbounded memory
const FILECACHE_MAX = 4000;         // bound on cached transcripts (FIFO eviction)
const RE_PATCH_FILE = /^\*\*\* (?:Add|Update) File:[ \t]+(.+?)[ \t]*$/gm;
const RE_MOVE_TO = /^\*\*\* Move to:[ \t]+(.+?)[ \t]*$/gm;

function normKey(p) {
  const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return IS_WIN ? s.toLowerCase() : s;
}

// ---------------------------------------------------------------- roots
function defaultRoots(home = os.homedir()) {
  const roots = [{ kind: 'claude', dir: path.join(home, '.claude', 'projects') }];
  let ents = [];
  try { ents = fs.readdirSync(home, { withFileTypes: true }); } catch (_) {}
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith('.codex')) continue;             // .codex, .codex-*, .codex2 …
    const dir = path.join(home, e.name, 'sessions');
    try { if (fs.statSync(dir).isDirectory()) roots.push({ kind: 'codex', dir }); } catch (_) {}
  }
  return roots;
}

// config accepts plain strings (".../.claude/projects") or objects ({kind, dir})
function normalizeRoots(roots) {
  if (!Array.isArray(roots)) return defaultRoots();   // unset → platform defaults; [] → scan nothing
  const out = [];
  for (const r of roots) {
    const ro = typeof r === 'string'
      ? { kind: /claude/i.test(r) ? 'claude' : 'codex', dir: r }
      : (r && r.dir ? { kind: r.kind === 'codex' ? 'codex' : 'claude', dir: r.dir } : null);
    if (!ro) continue;
    try { if (fs.statSync(ro.dir).isDirectory()) out.push(ro); } catch (_) {}
  }
  return out;
}

// ---------------------------------------------------------------- title cleaning
function cleanTitle(s) {
  s = String(s == null ? '' : s)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')   // control chars (ANSI CSI starts with \x1b)
    .replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.startsWith('<')) return '';                                // <command-…>, <system-reminder>, <INSTRUCTIONS> …
  if (s.startsWith('Caveat:')) return '';                          // post-compaction caveat wrapper
  if (s.startsWith('This session is being continued')) return '';  // compaction summary
  if (s.startsWith('# AGENTS.md')) return '';                      // codex injects project instructions as a user msg
  if (s.startsWith('〔')) return '';                                // hook-injected notes (e.g. compaction appendix)
  s = s.replace(/^(\[Image[^\]]*\]\s*)+/, '').trim();          // leading pasted-image placeholders
  if (!s) return '';
  if (s.length > MAX_TITLE) s = s.slice(0, MAX_TITLE - 1) + '…';
  return s;
}

// ---------------------------------------------------------------- streaming line scanner
function scanLines(file, onLine) {
  return new Promise((resolve) => {
    const dec = new StringDecoder('utf8');
    let buf = '';
    const rs = fs.createReadStream(file, { highWaterMark: 512 * 1024 });
    rs.on('data', chunk => {
      buf += dec.write(chunk);
      let start = 0, idx;
      while ((idx = buf.indexOf('\n', start)) !== -1) {
        onLine(buf.slice(start, idx));
        start = idx + 1;
      }
      buf = buf.slice(start);
      if (buf.length > MAX_LINE_BUF) { onLine(buf); buf = ''; }  // pathological single-line file
    });
    rs.on('end', () => {
      buf += dec.end();
      if (buf) onLine(buf);
      resolve();
    });
    rs.on('error', () => resolve()); // unreadable transcript: treat as empty, never kill the scan
  });
}

// ---------------------------------------------------------------- per-file parsers
function isAbsLike(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
}

class Acc {
  constructor(agent, id, project) {
    this.agent = agent; this.id = id; this.project = project;
    this.cwd = '';                  // session cwd, base for relative file paths
    this.title = '';
    this.auto = false;              // started by a program (claude -p / sdk, codex dispatched by another agent), not typed by a person
    this.started = 0; this.updated = 0;
    this.files = new Map(); // normKey -> { path, firstAt, lastAt, writes }
  }
  ts(t) {
    if (!t) return;
    if (!this.started || t < this.started) this.started = t;
    if (t > this.updated) this.updated = t;
  }
  // base: session cwd for relative paths. forbid: resolved-path prefix that never counts.
  addFile(rawPath, t, base, forbid) {
    if (!rawPath || typeof rawPath !== 'string') return false;
    let p = rawPath.trim().replace(/^["'`]+|["'`]+$/g, '');
    if (!p || p.includes('\0')) return false;
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
    try { p = path.resolve(base || '', p); } catch (_) { return false; }
    const k = normKey(p);
    if (forbid && k.startsWith(forbid)) return false;   // checked on the RESOLVED path
    const cur = this.files.get(k);
    if (cur) { cur.writes++; if (t && (!cur.firstAt || t < cur.firstAt)) cur.firstAt = t; if (t > cur.lastAt) cur.lastAt = t; }
    else this.files.set(k, { path: p, firstAt: t || 0, lastAt: t || 0, writes: 1 });
    return true;
  }
}

async function parseClaude(abs, projectsDir) {
  const forbid = normKey(projectsDir) + '/'; // memory/ and the transcripts themselves never count
  const fallbackId = path.basename(abs, '.jsonl');
  const slug = path.basename(path.dirname(abs));
  const convos = new Map();     // sessionId -> Acc
  const needTitle = new Set();  // sessionIds still missing a title (per-session, not per-file)
  let sawSession = false;       // before the first session is seen every user line is a title candidate
  const accOf = d => {
    const id = typeof d.sessionId === 'string' && d.sessionId ? d.sessionId : fallbackId;
    let c = convos.get(id);
    if (!c) { c = new Acc('claude', id, slug); convos.set(id, c); needTitle.add(id); sawSession = true; }
    return c;
  };
  await scanLines(abs, line => {
    if (line.charCodeAt(0) !== 123) return; // '{'
    const hasTool = (line.includes('file_path') || line.includes('notebook_path')) &&
      (line.includes('"Write"') || line.includes('"Edit"') ||
       line.includes('"MultiEdit"') || line.includes('"NotebookEdit"'));
    if (!hasTool) {
      if (sawSession && needTitle.size === 0) return;
      if (!line.includes('"type":"user"')) return;
      if (line.includes('"tool_result"') || line.length > MAX_TITLE_PARSE) return;
    }
    let d;
    try { d = JSON.parse(line); } catch (_) { return; }
    if (hasTool) {
      if (d.type !== 'assistant' || !d.message || !Array.isArray(d.message.content)) return;
      const c = accOf(d);
      if (d.cwd) { c.project = d.cwd; if (!c.cwd) c.cwd = d.cwd; }
      if (d.entrypoint) c.auto = d.entrypoint !== 'cli';
      const tc = Date.parse(d.timestamp || '') || 0;
      let wrote = false;
      for (const b of d.message.content) {
        if (!b || b.type !== 'tool_use' || !WRITE_TOOLS.has(b.name)) continue;
        const fp = b.input && (b.input.file_path || b.input.notebook_path);
        if (typeof fp !== 'string' || !fp) continue;
        if (c.addFile(fp, tc, c.cwd, forbid)) wrote = true;
      }
      if (wrote) c.ts(tc);  // writes filtered out (memory/transcripts) must not bump `updated`
      return;
    }
    // first genuine user text = title
    if (d.type !== 'user' || !d.message || d.isMeta) return;
    const c = accOf(d);
    if (d.entrypoint) c.auto = d.entrypoint !== 'cli';
    if (d.cwd) { c.project = d.cwd; if (!c.cwd) c.cwd = d.cwd; }
    const tc = Date.parse(d.timestamp || '') || 0;
    if (!c.started && tc) c.started = tc;
    if (c.title) return;
    let text = null;
    if (typeof d.message.content === 'string') text = d.message.content;
    else if (Array.isArray(d.message.content)) {
      text = d.message.content.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
    }
    const tt = cleanTitle(text);
    if (tt) { c.title = tt; needTitle.delete(c.id); }
  });
  return [...convos.values()];
}

// exec-wrapped apply_patch is a JS string literal: unfold ONLY the whitespace escapes real
// harness output uses. Unknown escapes keep both chars — post-JSON.parse paths carry single
// backslashes ("D:\workspace"), and eating them would corrupt every Windows path. A three-char
// \\n in patch CONTENT stays as-is (no fake line break → no ghost '*** Add File:' capture).
function unfoldPatchText(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length) {       // backslash
      const c = s[i + 1];
      if (c === 'n') { out += '\n'; i++; continue; }
      if (c === 't') { out += '\t'; i++; continue; }
      if (c === 'r') { out += '\r'; i++; continue; }
      out += '\\' + c; i++; continue;   // unknown escape: keep both chars (paths D:\w, \", \\)
    }
    out += s[i];
  }
  return out;
}

// Patch text sources on a codex payload. JSON-parsed payloads (arg.patch) are already fully
// decoded and must NOT be touched. pl.input (and shell command arrays) need unfolding even
// when they contain real newlines elsewhere — real transcripts mix both inside one string.
function codexPatchTexts(pl, out) {
  if (typeof pl.input === 'string') out.push({ text: pl.input, decode: true });
  if (typeof pl.patch === 'string') out.push({ text: pl.patch, decode: false });
  if (typeof pl.arguments === 'string') {
    let arg = null;
    try { arg = JSON.parse(pl.arguments); } catch (_) {}
    if (arg && typeof arg.patch === 'string') out.push({ text: arg.patch, decode: false });
    else if (arg && Array.isArray(arg.command)) {
      out.push({ text: arg.command.filter(x => typeof x === 'string').join(' '), decode: true });
    } else out.push({ text: pl.arguments, decode: !pl.arguments.includes('\n') });
  }
}

function codexCollect(entry, forbid, addRel, acc, ts) {
  const text = entry.decode ? unfoldPatchText(entry.text) : entry.text;
  const take = (re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const p = m[1].trim().replace(/^["'`]+|["'`]+$/g, '');
      if (!p) continue;
      if (isAbsLike(p)) acc.addFile(p, ts, null, forbid);
      else addRel.push({ p, ts });   // resolve once the session cwd is known (end of file)
    }
  };
  take(RE_PATCH_FILE);
  take(RE_MOVE_TO);
}

async function parseCodex(abs, sessionsDir) {
  const forbid = normKey(sessionsDir) + '/';
  const fallbackId = path.basename(abs, '.jsonl');
  const acc = new Acc('codex', fallbackId, '');
  let titleDone = false;
  const addRel = [];              // relative Add/Update paths; resolved after the whole file
  const texts = [];
  await scanLines(abs, line => {
    if (line.charCodeAt(0) !== 123) return;
    const hasPatch = line.includes('Add File') || line.includes('Update File') || line.includes('Move to');
    const isMeta = !hasPatch && line.includes('session_meta');
    const isUserMsg = !hasPatch && !isMeta && !titleDone && line.includes('"role":"user"');
    if (!hasPatch && !isMeta && !isUserMsg) return;
    let d;
    try { d = JSON.parse(line); } catch (_) { return; }
    const ts = Date.parse(d.timestamp || '') || 0;
    acc.ts(ts);
    const pl = d.payload;
    if (!pl) return;
    if (d.type === 'session_meta') {
      if (pl.id || pl.session_id) acc.id = pl.id || pl.session_id;
      if (pl.cwd) { acc.cwd = pl.cwd; acc.project = pl.cwd; }
      acc.auto = !(pl.source === 'cli' || /tui/i.test(String(pl.originator || '')));
      return;
    }
    if (isUserMsg && pl.type === 'message' && pl.role === 'user' && !acc.title) {
      const text = (Array.isArray(pl.content) ? pl.content : [])
        .filter(b => b && (b.type === 'input_text' || b.type === 'text'))
        .map(b => b.text).join('\n');
      const tt = cleanTitle(text);
      if (tt) { acc.title = tt; titleDone = true; }
      return;
    }
    if (!hasPatch) return;
    texts.length = 0;
    codexPatchTexts(pl, texts);
    for (const tx of texts) {
      if (!tx.text.includes('***')) continue;
      codexCollect(tx, forbid, addRel, acc, ts);
    }
  });
  // `base` falls back to the transcript's own folder when session_meta never gave a cwd
  for (const { p, ts } of addRel) acc.addFile(p, ts, acc.cwd || path.dirname(abs), forbid);
  return [acc];
}

// finalize: exists flags + fileCount + mtime-floor for updated (a transcript's mtime is a
// safe upper bound for "when was anything last written in this conversation"). exists is a
// snapshot at scan time — a file deleted afterwards shows present until its transcript's
// (size, mtime) changes. stat is pooled-async so one slow drive can't stall the event loop.
async function finalize(c, fileMtimeMs) {
  const files = [...c.files.values()];
  let n = 0, i = 0;
  const STAT_POOL = 8;
  await Promise.all(Array.from({ length: Math.min(STAT_POOL, files.length) || 1 }, async () => {
    while (i < files.length) {
      const f = files[i++];
      let exists = false;
      try { exists = (await fs.promises.stat(f.path)).isFile(); } catch (_) {}
      f.exists = exists;
      if (exists) n++;   // safe: increments are synchronous between awaits
      if (!f.lastAt && f.firstAt) f.lastAt = f.firstAt;
    }
  }));
  files.sort((a, b) => (a.firstAt || 0) - (b.firstAt || 0));
  return {
    id: c.id, agent: c.agent, title: c.title, project: c.project, auto: !!c.auto,
    started: c.started || fileMtimeMs || 0,
    updated: Math.max(c.updated, fileMtimeMs || 0),
    files, fileCount: n
  };
}

// ---------------------------------------------------------------- discovery + cache
// Bounded (FILECACHE_MAX, FIFO). Deliberately NOT pruned to each scan's discovery set:
// /api/convos?days=N and /api/convo (cutoff 0) use different windows and share this cache.
const fileCache = new Map(); // normKey(transcript) -> { size, mtimeMs, convos }

function discover(root, cutoffMs, out) {
  const pushFile = (abs, slugDir) => {
    let st;
    try { st = fs.statSync(abs); } catch (_) { return; }
    if (!st.isFile()) return;
    if (st.mtimeMs < cutoffMs) return;
    out.push({ abs, kind: root.kind, rootDir: root.dir, slugDir, size: st.size, mtimeMs: st.mtimeMs });
  };
  if (root.kind === 'claude') {
    let slugs;
    try { slugs = fs.readdirSync(root.dir, { withFileTypes: true }); } catch (_) { return; }
    for (const s of slugs) {
      if (!s.isDirectory()) continue;
      const sub = path.join(root.dir, s.name);
      let files;
      try { files = fs.readdirSync(sub, { withFileTypes: true }); } catch (_) { continue; }
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        pushFile(path.join(sub, f.name), sub);
      }
    }
  } else {
    const walk = (dir, depth) => {
      if (depth > 8) return;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) pushFile(full, dir);
      }
    };
    walk(root.dir, 0);
  }
}

async function convosForFile(f) {
  const key = normKey(f.abs);
  const hit = fileCache.get(key);
  if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs) return hit.convos;
  let parsed;
  try {
    parsed = f.kind === 'claude' ? await parseClaude(f.abs, f.rootDir) : await parseCodex(f.abs, f.rootDir);
  } catch (_) {
    return [];   // do NOT cache failures — a half-parsed transcript must be retried on the next scan
  }
  const convos = [];
  for (const c of parsed) convos.push(await finalize(c, f.mtimeMs));
  while (fileCache.size >= FILECACHE_MAX) fileCache.delete(fileCache.keys().next().value);
  fileCache.set(key, { size: f.size, mtimeMs: f.mtimeMs, convos });
  return convos;
}

// scan({ roots, minUpdatedMs }) -> { convos, transcripts, ms }
async function scan(opts = {}) {
  const t0 = Date.now();
  const roots = normalizeRoots(opts.roots);
  const cutoff = Math.max(0, Number(opts.minUpdatedMs) || 0);
  const found = [];
  for (const r of roots) discover(r, cutoff, found);
  // parse with a small pool: transcripts are CPU/IO heavy, 4 at a time is plenty for a desktop
  const lists = new Array(found.length);
  let i = 0;
  const POOL = 4;
  await Promise.all(Array.from({ length: Math.min(POOL, found.length) || 1 }, async () => {
    while (i < found.length) {
      const idx = i++;
      lists[idx] = await convosForFile(found[idx]);
    }
  }));
  // merge per-file results by agent:id (also collapses duplicates from overlapping roots —
  // the same transcript discovered twice yields the same id and merges here)
  const byId = new Map();
  for (const arr of lists) {
    if (!arr) continue;
    for (const c of arr) {
      const k = c.agent + ':' + c.id;
      const cur = byId.get(k);
      if (!cur) { byId.set(k, c); continue; }
      const seen = new Set(cur.files.map(f => normKey(f.path)));
      for (const f of c.files) if (!seen.has(normKey(f.path))) cur.files.push(f);
      cur.fileCount = cur.files.reduce((n, f) => n + (f.exists ? 1 : 0), 0);
      cur.files.sort((a, b) => (a.firstAt || 0) - (b.firstAt || 0));
      if (!cur.title && c.title) cur.title = c.title;
      if (!c.auto) cur.auto = false;
      if (c.started && (!cur.started || c.started < cur.started)) cur.started = c.started;
      if (c.updated > cur.updated) cur.updated = c.updated;
    }
  }
  const convos = [...byId.values()].filter(c => c.updated >= cutoff && c.files.length > 0);
  return { convos, transcripts: found.length, ms: Date.now() - t0 };
}

function mergeId(c) { return c.agent + ':' + c.id; }

// convenience for /api/whichconvo: conversations that wrote `absPath` (case-folded on win32)
function wroteFile(c, absPath) {
  const k = normKey(path.resolve(absPath));
  return c.files.some(f => normKey(f.path) === k);
}

function clearCache() { fileCache.clear(); }

module.exports = { scan, defaultRoots, normalizeRoots, normKey, mergeId, wroteFile, clearCache };
