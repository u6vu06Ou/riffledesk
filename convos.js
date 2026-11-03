// convos.js — scan AI coding-agent transcripts (Claude Code / Codex / Gemini CLI /
// Cline family / Pi / Grok Build) and report which files each conversation wrote.
// Zero dependencies, Node built-ins only. Record formats verified 2026-11-01,
// per-tool details + sources in docs/ai-sources.md.
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
// Gemini CLI: <gemhome>/tmp/<project-id>/chats/**/*.jsonl (+legacy single .json) — first
//   line may be metadata {sessionId, directories:[cwd], kind:'main'|'subagent'}; records of
//   type 'gemini' carry toolCalls ({name:'write_file'|'replace', args:{file_path}}).
// Cline / Roo Code / Kilo Code (legacy): <editor>/User/globalStorage/<extId>/tasks/<id>/
//   api_conversation_history.json — a whole-file Anthropic message array; tool_use blocks
//   named write_to_file/replace_in_file/apply_diff/insert_content/apply_patch/edit_file
//   with input.path. (Parsed whole-file, 64 MB cap — these files are JSON, not JSONL.)
// Pi (badlogic/pi-mono): ~/.pi/agent/sessions/--<path>--/<ts>_<id>.jsonl — first line
//   {"type":"session","cwd":…}; session_info.name is the title; assistant toolCall blocks
//   carry names write/edit (multi_edit tolerated as an alias) with arguments.path.
// Grok Build (xAI): ~/.grok/sessions/<encoded-cwd>/<session-id>/updates.jsonl — ACP
//   session/update lines; tool_call updates identify the tool via _meta["x.ai/tool"].name
//   (write/search_replace/edit/hashline_edit/apply_patch); sibling summary.json has the
//   title. Only absolute paths count (the encoded-cwd dir name is not invertible).
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

// ---------------- per-tool registries (formats verified 2026-11-01; docs/ai-sources.md) ----------------
// kind = internal id used in Acc.agent / mergeId prefixes; label = UI tag for public/main.js.
const KIND_LABEL = {
  claude: 'Claude', codex: 'Codex', gemini: 'Gemini',
  cline: 'Cline', roo: 'Roo Code', kilo: 'Kilo Code',
  pi: 'Pi', grok: 'Grok Build'
};
const KNOWN_KINDS = new Set(Object.keys(KIND_LABEL));
// tool names that count as "the AI wrote this file", per kind
const WRITE_GEMINI = new Set(['write_file', 'replace']);
const WRITE_CLINE = new Set(['write_to_file', 'replace_in_file', 'apply_diff', 'insert_content', 'apply_patch', 'edit_file']);
const WRITE_PI = new Set(['write', 'edit', 'multi_edit']);
const WRITE_GROK = new Set(['write', 'search_replace', 'edit', 'hashline_edit', 'apply_patch']);
// VS Code-family editors whose globalStorage may hold Cline-family task dirs
const VSCODE_EDITORS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'];
const CLINE_FAMILY_EXT_TASKS = [
  ['saoudrizwan.claude-dev', 'cline'],
  ['rooveterinaryinc.roo-cline', 'roo'],
  ['kilocode.kilo-code', 'kilo']
];
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
  // Gemini CLI: GEMINI_CLI_HOME replaces the ~/.gemini base; sessions under <base>/tmp/<id>/chats/
  const gemHome = (process.env.GEMINI_CLI_HOME || '').trim() || path.join(home, '.gemini');
  // stat-checked pushes only: a machine without the tool must not walk 18 dead dirs per scan
  const pushIfDir = (kind, dir) => {
    try { if (fs.statSync(dir).isDirectory()) roots.push({ kind, dir }); } catch (_) {}
  };
  pushIfDir('gemini', path.join(gemHome, 'tmp'));
  // Pi (badlogic/pi-mono)
  pushIfDir('pi', (process.env.PI_CODING_AGENT_SESSION_DIR || '').trim() || path.join(home, '.pi', 'agent', 'sessions'));
  // Grok Build (xAI)
  const grokHome = (process.env.GROK_HOME || '').trim() || path.join(home, '.grok');
  pushIfDir('grok', path.join(grokHome, 'sessions'));
  // Cline family (VS Code editors' globalStorage)
  const vscBase = IS_WIN
    ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  for (const ed of VSCODE_EDITORS) {
    const gs = path.join(vscBase, ed, 'User', 'globalStorage');
    for (const [extId, kind] of CLINE_FAMILY_EXT_TASKS) {
      pushIfDir(kind, path.join(gs, extId, 'tasks'));
    }
  }
  return roots;
}

// best-effort kind guess for plain-string config roots; explicit {kind,dir} objects win.
// Anchor on the real marker segments — a bare /cline/i would eat Roo's extension id
// (rooveterinaryinc.roo-cline) and bare /grok/i would eat a random "grokify" checkout.
function stringKind(s) {
  if (/codex/i.test(s)) return 'codex';
  if (/roo-cline|rooveterinaryinc/i.test(s)) return 'roo';
  if (/kilo-code|kilocode/i.test(s)) return 'kilo';
  if (/cline|claude-dev/i.test(s)) return 'cline';
  if (/[\\/]\.?gemini[-\\/]/i.test(s)) return 'gemini';      // .gemini/, gemini-cli/, gemini-home/
  if (/[\\/]\.pi[\\/]|pi[\\/]agent[\\/]sessions/i.test(s)) return 'pi';
  if (/[\\/]\.?grok[-\\/]/i.test(s)) return 'grok';          // .grok/, grok-build… but not "grokify"
  return /claude/i.test(s) ? 'claude' : 'codex';   // legacy default for unknown strings
}

// config accepts plain strings (".../.claude/projects") or objects ({kind, dir})
function normalizeRoots(roots) {
  if (!Array.isArray(roots)) return defaultRoots();   // unset → platform defaults; [] → scan nothing
  const out = [];
  for (const r of roots) {
    let ro = null;
    if (typeof r === 'string') ro = { kind: stringKind(r), dir: r };
    else if (r && r.dir) {
      const k = String(r.kind || '').trim().toLowerCase();
      ro = { kind: KNOWN_KINDS.has(k) ? k : stringKind(r.dir), dir: r.dir };
    }
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
    let head = true;
    rs.on('data', chunk => {
      buf += dec.write(chunk);
      if (head) { head = false; if (buf.charCodeAt(0) === 0xFEFF) buf = buf.slice(1); }  // UTF-8 BOM would blank the metadata line
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
    this.firstPrompt = '';
    this.sessionTitle = '';
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
  const nativeTitles = new Map();
  let sawSession = false;       // before the first session is seen every user line is a title candidate
  const accOf = d => {
    const id = typeof d.sessionId === 'string' && d.sessionId ? d.sessionId : fallbackId;
    let c = convos.get(id);
    if (!c) { c = new Acc('claude', id, slug); convos.set(id, c); needTitle.add(id); sawSession = true; }
    return c;
  };
  await scanLines(abs, line => {
    if (line.charCodeAt(0) !== 123) return; // '{'
    if (line.length <= MAX_TITLE_PARSE && line.includes('"custom-title"')) {
      try {
        const d = JSON.parse(line);
        if (d.type === 'custom-title' && typeof d.sessionId === 'string') {
          const title = cleanTitle(d.customTitle);
          if (title) nativeTitles.set(d.sessionId, title);
        }
      } catch (_) {}
      return;
    }
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
  for (const c of convos.values()) {
    c.firstPrompt = c.title;
    if (nativeTitles.has(c.id)) c.title = c.sessionTitle = nativeTitles.get(c.id);
  }
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

// ---------------- Gemini CLI ----------------
// One message per record: {id, timestamp, type:'user'|'gemini'|…, content:[{text}]};
// 'gemini' records carry toolCalls:[{name, args:{file_path}}]. The first line may be a
// metadata record {sessionId, projectHash, directories:[cwd], kind:'main'|'subagent'}
// (no `type` field). Legacy sessions are one whole .json object with a messages[] array.
const gemMetaSeen = new WeakSet();  // only the first metadata record may fix id/cwd; later $set rewrites must not
function geminiRecord(acc, d, rel, forbid) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return;
  // metadata record: no `type`, carries sessionId (+ $set-merged rewrites look the same)
  if (!d.type && typeof d.sessionId === 'string') {
    if (!gemMetaSeen.has(acc)) {
      gemMetaSeen.add(acc);
      acc.id = d.sessionId;
      if (Array.isArray(d.directories) && d.directories[0] && isAbsLike(d.directories[0])) {
        acc.cwd = d.directories[0]; acc.project = d.directories[0];
      }
    }
    if (d.kind === 'subagent') acc.auto = true;
    const t = Date.parse(d.startTime || '') || Date.parse(d.lastUpdated || '') || 0;
    if (t) acc.ts(t);
    return;
  }
  const ts = Date.parse(d.timestamp || '') || 0;
  if (ts) acc.ts(ts);
  if (d.kind === 'subagent') acc.auto = true;
  if (Array.isArray(d.directories) && d.directories[0] && isAbsLike(d.directories[0]) && !acc.cwd) {
    acc.cwd = d.directories[0]; acc.project = d.directories[0];
  }
  if (Array.isArray(d.toolCalls)) {
    for (const tc of d.toolCalls) {
      if (!tc || !WRITE_GEMINI.has(tc.name)) continue;
      const fp = tc.args && tc.args.file_path;
      if (typeof fp !== 'string' || !fp) continue;
      const t = Date.parse(tc.timestamp || '') || ts;
      if (isAbsLike(fp)) acc.addFile(fp, t, acc.cwd, forbid);
      else rel.push({ p: fp, ts: t });
    }
    return;
  }
  if (d.type === 'user' && !acc.title) {
    const c = d.content;
    const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.map(b => (b && b.text) || '').join('\n') : '');
    const tt = cleanTitle(text);
    if (tt) acc.title = tt;
  }
}

async function parseGeminiJsonl(abs, tmpDir) {
  const forbid = normKey(tmpDir) + '/';
  const acc = new Acc('gemini', path.basename(abs).replace(/\.jsonl$/i, ''), '');
  const rel = [];
  await scanLines(abs, line => {
    if (line.charCodeAt(0) !== 123) return;
    const isTool = line.includes('"toolCalls"');
    if (!isTool) {
      const isMeta = line.includes('"sessionId"');
      if (!isMeta) {
        if (!line.includes('"type":"user"')) return;
        if (acc.title || line.length > MAX_TITLE_PARSE) return;
      }
    }
    let d;
    try { d = JSON.parse(line); } catch (_) { return; }
    geminiRecord(acc, d, rel, forbid);
  });
  for (const { p, ts } of rel) acc.addFile(p, ts, acc.cwd || path.dirname(abs), forbid);
  return [acc];
}

async function parseGeminiJson(abs, tmpDir) {
  const forbid = normKey(tmpDir) + '/';
  const acc = new Acc('gemini', path.basename(abs).replace(/\.json$/i, ''), '');
  let st;
  try { st = fs.statSync(abs); } catch (_) { return [acc]; }
  if (st.size > 64 * 1024 * 1024) return [acc];   // legacy single-object sessions: cap the one-shot parse
  let d;
  try { d = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (_) { return [acc]; }
  if (!d || typeof d !== 'object') return [acc];
  const rel = [];
  geminiRecord(acc, d, rel, forbid);                                     // top-level metadata
  for (const m of Array.isArray(d.messages) ? d.messages : []) geminiRecord(acc, m, rel, forbid);
  for (const { p, ts } of rel) acc.addFile(p, ts, acc.cwd || path.dirname(abs), forbid);
  return [acc];
}

function parseGemini(abs, tmpDir) {
  return /\.json$/i.test(abs) ? parseGeminiJson(abs, tmpDir) : parseGeminiJsonl(abs, tmpDir);
}

// ---------------- Cline / Roo Code / Kilo Code (legacy layout) ----------------
// <globalStorage>/<extId>/tasks/<taskId>/api_conversation_history.json — a whole-file
// Anthropic message array; messages may carry `ts` (ms). Write tools use input.path.
// The file has no cwd, so relative paths resolve against the tasks dir (harmless: they
// simply never `exists`).
async function parseCline(abs, tasksDir, agent) {
  const forbid = normKey(tasksDir) + '/';
  const bn = path.basename(abs);
  const id = /^api_conversation_history\.json$/i.test(bn)
    ? path.basename(path.dirname(abs))
    : bn.replace(/\.json$/i, '');
  const acc = new Acc(agent, id, '');
  let st;
  try { st = fs.statSync(abs); } catch (_) { return [acc]; }
  if (st.size > 64 * 1024 * 1024) return [acc];  // whole-file parse cap (JSON, not JSONL) — one JSON.parse of this size already stalls the loop for ~a second
  let d;
  try { d = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (_) { return [acc]; }
  const msgs = Array.isArray(d) ? d : (d && Array.isArray(d.messages) ? d.messages : []);
  const rel = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const ts = typeof m.ts === 'number' ? m.ts : (Date.parse(m.timestamp || '') || 0);
    if (ts) acc.ts(ts);
    const c = m.content;
    if (m.role === 'user') {
      if (!acc.title) {
        const text = typeof c === 'string' ? c
          : (Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : '');
        const tt = cleanTitle(text);
        if (tt) acc.title = tt;
      }
      continue;
    }
    if (m.role !== 'assistant' || !Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || b.type !== 'tool_use') continue;
      const name = String(b.name || '');
      if (!WRITE_CLINE.has(name)) continue;
      const input = b.input || {};
      const fp = input.path || input.file_path || input.target_file;
      if (typeof fp === 'string' && fp) {
        if (isAbsLike(fp)) acc.addFile(fp, ts, null, forbid); else rel.push({ p: fp, ts });
      }
      if (name === 'apply_patch' && typeof input.patch === 'string') {
        RE_PATCH_FILE.lastIndex = 0;
        let m2;
        while ((m2 = RE_PATCH_FILE.exec(input.patch))) {
          const p = m2[1].trim().replace(/^["'`]+|["'`]+$/g, '');
          if (!p) continue;
          if (isAbsLike(p)) acc.addFile(p, ts, null, forbid); else rel.push({ p, ts });
        }
      }
    }
  }
  for (const { p, ts } of rel) acc.addFile(p, ts, path.dirname(abs), forbid);
  return [acc];
}

// ---------------- Pi (badlogic/pi-mono) ----------------
// First line: {"type":"session","version":3,"id","timestamp","cwd"}; session_info carries
// the title in `name`; assistant toolCall blocks use names write/edit (multi_edit tolerated) with arguments.path.
async function parsePi(abs, sessionsDir) {
  const forbid = normKey(sessionsDir) + '/';
  const acc = new Acc('pi', path.basename(abs, '.jsonl'), '');
  const rel = [];
  await scanLines(abs, line => {
    if (line.charCodeAt(0) !== 123) return;
    const hasCall = line.includes('"toolCall"');
    if (!hasCall) {
      const metaish = line.includes('"type":"session"') || line.includes('"session_info"');
      if (!metaish && !(line.includes('"role":"user"') && !acc.title && line.length <= MAX_TITLE_PARSE)) return;
    }
    let d;
    try { d = JSON.parse(line); } catch (_) { return; }
    const ts = Date.parse(d.timestamp || '') || 0;
    if (d.type === 'session') {
      if (typeof d.id === 'string' && d.id) acc.id = d.id;
      if (typeof d.cwd === 'string' && d.cwd) { acc.cwd = d.cwd; acc.project = d.cwd; }
      if (ts) acc.ts(ts);
      return;
    }
    if (d.type === 'session_info') {
      if (typeof d.name === 'string') { const tt = cleanTitle(d.name); if (tt) acc.sessionTitle = tt; }
      return;
    }
    const m = d.message;
    if (!m || typeof m !== 'object') return;
    if (ts) acc.ts(ts);
    if (m.role === 'user') {
      if (acc.title) return;
      const c = m.content;
      const text = typeof c === 'string' ? c
        : (Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : '');
      const tt = cleanTitle(text);
      if (tt) acc.title = tt;
      return;
    }
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (!b || b.type !== 'toolCall' || !WRITE_PI.has(b.name)) continue;
      const fp = b.arguments && (b.arguments.path || b.arguments.file_path);
      if (typeof fp !== 'string' || !fp) continue;
      if (isAbsLike(fp)) acc.addFile(fp, ts, acc.cwd, forbid); else rel.push({ p: fp, ts });
    }
  });
  for (const { p, ts } of rel) acc.addFile(p, ts, acc.cwd || path.dirname(abs), forbid);
  return [acc];
}

// ---------------- Grok Build (xAI) ----------------
// <encoded-cwd>/<session-id>/updates.jsonl: ACP session/update lines. Tool identity lives
// in update._meta["x.ai/tool"].name (title says e.g. "write" too); timestamps are unix
// seconds. summary.json next to updates.jsonl carries the generated title.
async function parseGrok(abs, sessionsRoot) {
  const forbid = normKey(sessionsRoot) + '/';
  const sidDir = path.dirname(abs);
  const acc = new Acc('grok', path.basename(sidDir), '');
  try {
    const s = JSON.parse(fs.readFileSync(path.join(sidDir, 'summary.json'), 'utf8'));
    if (s && typeof s.title === 'string') { const tt = cleanTitle(s.title); if (tt) acc.sessionTitle = tt; }
  } catch (_) {}
  await scanLines(abs, line => {
    if (line.charCodeAt(0) !== 123) return;
    const isTool = line.includes('"tool_call"') && line.includes('x.ai/tool');
    if (!isTool && !(line.includes('"user_message_chunk"') && !acc.title && line.length <= MAX_TITLE_PARSE)) return;
    let d;
    try { d = JSON.parse(line); } catch (_) { return; }
    const ts = typeof d.timestamp === 'number' ? Math.round(d.timestamp * 1000) : 0;
    if (ts) acc.ts(ts);
    const params = d.params;
    const up = params && params.update;
    if (!up || typeof up !== 'object') return;
    if (params.sessionId && typeof params.sessionId === 'string') acc.id = params.sessionId;
    if (up.sessionUpdate === 'user_message_chunk') {
      if (acc.title) return;
      const c = up.content;
      const text = typeof c === 'string' ? c : (c && typeof c.text === 'string' ? c.text : '');
      const tt = cleanTitle(text);
      if (tt) acc.title = tt;
      return;
    }
    if (up.sessionUpdate !== 'tool_call') return;
    const meta = up._meta && up._meta['x.ai/tool'];
    const name = (meta && meta.name) || up.title;
    if (!WRITE_GROK.has(name)) return;
    const ri = up.rawInput || {};
    const fp = ri.file_path || ri.path;
    if (typeof fp === 'string' && fp && isAbsLike(fp)) { acc.addFile(fp, ts, null, forbid); }
    // apply_patch style rawInput bodies: scan patch-ish string fields (but NOT `content`,
    // whose text may legitimately contain "*** Add File:" lines — cf. codex ghost guard)
    if (name === 'apply_patch') {
      for (const k of ['patch', 'diff', 'input']) {
        const v = ri[k];
        if (typeof v !== 'string') continue;
        RE_PATCH_FILE.lastIndex = 0;
        let m2;
        while ((m2 = RE_PATCH_FILE.exec(v))) {
          const p = m2[1].trim().replace(/^["'`]+|["'`]+$/g, '');
          if (p && isAbsLike(p)) acc.addFile(p, ts, null, forbid);
        }
      }
    }
    // cwd is not decodable from the encoded dir name: relative paths are dropped
  });
  return [acc];
}

const PARSERS = {
  claude: parseClaude,
  codex: parseCodex,
  gemini: parseGemini,
  cline: (abs, root) => parseCline(abs, root, 'cline'),
  roo: (abs, root) => parseCline(abs, root, 'roo'),
  kilo: (abs, root) => parseCline(abs, root, 'kilo'),
  pi: parsePi,
  grok: parseGrok
};

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
    id: c.id, agent: c.agent, title: c.sessionTitle || c.title, firstPrompt: c.firstPrompt || c.title,
    sessionTitle: c.sessionTitle || '', project: c.project, auto: !!c.auto,
    started: c.started || fileMtimeMs || 0,
    updated: Math.max(c.updated, fileMtimeMs || 0),
    files, fileCount: n
  };
}

// ---------------------------------------------------------------- discovery + cache
// Bounded (FILECACHE_MAX, FIFO). Deliberately NOT pruned to each scan's discovery set:
// /api/convos?days=N and /api/convo (cutoff 0) use different windows and share this cache.
const fileCache = new Map(); // normKey(transcript) -> { size, mtimeMs, convos }

function walkExt(dir, depth, onFile, re, maxDepth = 8) {
  if (depth > maxDepth) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkExt(full, depth + 1, onFile, re, maxDepth);
    else if (e.isFile() && re.test(full)) onFile(full);
  }
}

function discover(root, cutoffMs, out) {
  const pushFile = (abs, slugDir) => {
    let st;
    try { st = fs.statSync(abs); } catch (_) { return; }
    if (!st.isFile()) return;
    if (st.mtimeMs < cutoffMs) return;
    out.push({ abs, kind: root.kind, rootDir: root.dir, slugDir, size: st.size, mtimeMs: st.mtimeMs });
  };
  switch (root.kind) {
    case 'claude': {
      // <root>/<project-slug>/<sid>.jsonl — one level of project dirs, flat .jsonl files
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
      return;
    }
    case 'gemini': {
      // <tmp>/<project-id>/chats/**/*.jsonl|.json — only the chats subtree (logs etc. skipped)
      let ids;
      try { ids = fs.readdirSync(root.dir, { withFileTypes: true }); } catch (_) { return; }
      for (const it of ids) {
        if (!it.isDirectory()) continue;
        walkExt(path.join(root.dir, it.name, 'chats'), 0, abs => pushFile(abs, root.dir), /\.(jsonl|json)$/i);
      }
      return;
    }
    case 'cline':
    case 'roo':
    case 'kilo': {
      // <tasks>/<taskId>/api_conversation_history.json, plus legacy <tasks>/<taskId>.json
      let ents;
      try { ents = fs.readdirSync(root.dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        if (e.isFile() && e.name.endsWith('.json')) { pushFile(path.join(root.dir, e.name), root.dir); continue; }
        if (!e.isDirectory()) continue;
        const f = path.join(root.dir, e.name, 'api_conversation_history.json');
        try { if (fs.statSync(f).isFile()) pushFile(f, root.dir); } catch (_) {}
      }
      return;
    }
    case 'grok':
      // <sessions>/<encoded-cwd>/<session-id>/updates.jsonl (chat_history.jsonl skipped)
      walkExt(root.dir, 0, abs => pushFile(abs, root.dir), /(^|[\\/])updates\.jsonl$/i);
      return;
    default: // codex, pi: recursive .jsonl
      walkExt(root.dir, 0, abs => pushFile(abs, root.dir), /\.jsonl$/i);
  }
}

// for server.js's transcript-signature poller: the same file set scan() would parse
function discoverFiles(root, cutoffMs = 0) {
  const out = [];
  discover(root, cutoffMs, out);
  return out;
}

async function convosForFile(f) {
  const key = normKey(f.abs);
  const hit = fileCache.get(key);
  let metadataSig = '';
  if (f.kind === 'grok') {
    try { const s = fs.statSync(path.join(path.dirname(f.abs), 'summary.json')); metadataSig = s.size + ':' + s.mtimeMs; } catch (_) {}
  }
  if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs && hit.metadataSig === metadataSig) return hit.convos;
  const parser = PARSERS[f.kind];
  if (!parser) return [];
  let parsed;
  try {
    parsed = await parser(f.abs, f.rootDir);
  } catch (_) {
    return [];   // do NOT cache failures — a half-parsed transcript must be retried on the next scan
  }
  const convos = [];
  for (const c of parsed) convos.push({ ...await finalize(c, f.mtimeMs), transcriptPaths: [f.abs] });
  while (fileCache.size >= FILECACHE_MAX) fileCache.delete(fileCache.keys().next().value);
  fileCache.set(key, { size: f.size, mtimeMs: f.mtimeMs, metadataSig, convos });
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
      if (!cur) { byId.set(k, { ...c, files: c.files.slice(), transcriptPaths: c.transcriptPaths.slice() }); continue; }
      cur.transcriptPaths = [...new Set([...cur.transcriptPaths, ...c.transcriptPaths])];
      const seen = new Set(cur.files.map(f => normKey(f.path)));
      for (const f of c.files) if (!seen.has(normKey(f.path))) cur.files.push(f);
      cur.fileCount = cur.files.reduce((n, f) => n + (f.exists ? 1 : 0), 0);
      cur.files.sort((a, b) => (a.firstAt || 0) - (b.firstAt || 0));
      if (!cur.title && c.title) cur.title = c.title;
      if (!cur.firstPrompt && c.firstPrompt) cur.firstPrompt = c.firstPrompt;
      if (c.sessionTitle && (!cur.sessionTitle || c.updated >= cur.updated)) cur.title = cur.sessionTitle = c.sessionTitle;
      if (!c.auto) cur.auto = false;
      if (c.started && (!cur.started || c.started < cur.started)) cur.started = c.started;
      if (c.updated > cur.updated) cur.updated = c.updated;
    }
  }
  const convos = [...byId.values()].filter(c => c.updated >= cutoff && c.files.length > 0);
  // The session name index changes independently of transcript files. Read it once per root.
  for (const r of roots.filter(r => r.kind === 'codex')) {
    const names = await codexNames(path.join(path.dirname(r.dir), 'session_index.jsonl'));
    const prefix = normKey(r.dir) + '/';
    for (const c of convos) {
      if (c.agent !== 'codex' || !c.transcriptPaths.some(p => normKey(p).startsWith(prefix))) continue;
      if (names.has(c.id)) c.title = c.sessionTitle = names.get(c.id);
    }
  }
  // Claude's optional native index provides short session summaries without an LLM call.
  const claudeIndexes = new Set(found.filter(f => f.kind === 'claude').map(f => path.join(path.dirname(f.abs), 'sessions-index.json')));
  for (const abs of claudeIndexes) {
    try {
      if (fs.statSync(abs).size > 5 * 1024 * 1024) continue;
      const index = JSON.parse(await fs.promises.readFile(abs, 'utf8'));
      for (const e of Array.isArray(index.entries) ? index.entries : []) {
        const c = byId.get('claude:' + e.sessionId);
        if (!c || c.sessionTitle || !c.transcriptPaths.some(p => normKey(path.dirname(p)) === normKey(path.dirname(abs)))) continue;
        const title = cleanTitle(e.summary);
        if (title) c.title = c.sessionTitle = title;
      }
    } catch (_) {} // optional metadata must never block the transcript itself
  }
  return { convos, transcripts: found.length, ms: Date.now() - t0 };
}

function metadataFiles(root, found = discoverFiles(root)) {
  if (root.kind === 'codex') return [path.join(path.dirname(root.dir), 'session_index.jsonl')];
  if (root.kind === 'claude') return [...new Set(found.map(f => path.join(path.dirname(f.abs), 'sessions-index.json')))];
  if (root.kind === 'grok') return found.map(f => path.join(path.dirname(f.abs), 'summary.json'));
  return [];
}

const nameCache = new Map();
async function codexNames(abs) {
  let st;
  try { st = fs.statSync(abs); } catch (_) { return new Map(); }
  const hit = nameCache.get(abs);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.names;
  const names = new Map();
  try { await scanLines(abs, line => {
    if (line.length > MAX_TITLE_PARSE) return;
    try {
      const d = JSON.parse(line), title = cleanTitle(d.thread_name);
      if (typeof d.id === 'string' && title) names.set(d.id, title);
    } catch (_) {}
  }); } catch (_) { return new Map(); }
  if (nameCache.size >= 32) nameCache.delete(nameCache.keys().next().value);
  nameCache.set(abs, { size: st.size, mtimeMs: st.mtimeMs, names });
  return names;
}

function mergeId(c) { return c.agent + ':' + c.id; }

// convenience for /api/whichconvo: conversations that wrote `absPath` (case-folded on win32)
function wroteFile(c, absPath) {
  const k = normKey(path.resolve(absPath));
  return c.files.some(f => normKey(f.path) === k);
}

function clearCache() { fileCache.clear(); nameCache.clear(); }

module.exports = { scan, defaultRoots, normalizeRoots, normKey, mergeId, wroteFile, clearCache, discoverFiles, metadataFiles, KIND_LABEL };
