// riffledesk hook — an opt-in Claude Code Stop hook that nudges an agent which
// is about to finish after writing deliverable files (report, page, sheet…)
// without handing them over via `riffledesk open` / `riffledesk show`.
//
// The pieces are split out of bin/riffledesk.js so tests can drive the
// analysis directly instead of only through a spawned process.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Matches our installed command in any form (bare shim, .cmd, node + abs path).
// Bounded on both sides so foreign commands like `xriffledesk hook checkpoint`
// are not mistaken for the hook.
const HOOK_CMD_RE = /\briffledesk(\.cmd|\.js)?["']?\s+hook\s+check\b(?![\w-])/;
// A Bash/PowerShell call that already handed files to the user.
const SHOWN_RE = /riffledesk(\.cmd|\.js)?["']?\s+(open|show)\b/;

const DELIVERABLE_EXTS = new Set(
  ['.md', '.html', '.htm', '.svg', '.pdf', '.csv', '.png', '.jpg', '.jpeg', '.docx', '.xlsx', '.pptx']
);
// Rule files and changelogs are written for the repo, not handed to the user.
const SKIP_BASENAMES = new Set(['agents.md', 'claude.md', 'memory.md', 'gemini.md', 'changelog.md']);

// Only the tail of a transcript matters (what happened since the last user
// message). 2 MB ≈ many thousand entries; parsing stays in single-digit ms.
const TAIL_BYTES = 2 * 1024 * 1024;

function defaultSettingsPath() {
  // Claude Code reads CLAUDE_CONFIG_DIR instead of ~/.claude when it is set
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

// Always the absolute node path: on Windows the bare `riffledesk` shim is a
// POSIX sh script whose forks trip EDR (see skills/riffledesk/SKILL.md), and
// elsewhere the absolute path works just the same.
function hookCommand(binPath) {
  return `node "${binPath}" hook check`;
}

// ---------- settings.json ----------

function invalidJson(file) {
  const err = new Error(`${file} is not valid JSON — fix it by hand first (nothing was written)`);
  err.settingsError = true;
  return err;
}

function refusedShape(file, what) {
  const err = new Error(`${file}: ${what} has an unexpected shape — refusing to touch the file`);
  err.settingsError = true;
  return err;
}

// Missing file → fresh {}, existed:false. Anything unparsable or not a plain
// object refuses the merge instead of clobbering the user's file.
function readSettings(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT') return { data: {}, existed: false };
    throw err;
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // tolerate a UTF-8 BOM
  let data;
  try { data = JSON.parse(text); } catch (_) { throw invalidJson(file); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidJson(file);
  return { data, existed: true };
}

// Dotfiles setups often point ~/.claude/settings.json at a repo file; rename
// would replace the symlink itself, so writes go to the real target.
function resolveSymlink(file) {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return fs.realpathSync(file);
  } catch (_) {}
  return file;
}

// The hooks.Stop array, creating the containers on demand. A present-but-
// wrongly-shaped hooks or Stop refuses rather than being silently replaced.
function stopGroups(data, file) {
  if (data.hooks === undefined) data.hooks = {};
  if (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks)) {
    throw refusedShape(file, '"hooks"');
  }
  if (data.hooks.Stop === undefined) data.hooks.Stop = [];
  if (!Array.isArray(data.hooks.Stop)) throw refusedShape(file, '"hooks.Stop"');
  return data.hooks.Stop;
}

function hasOurEntry(groups) {
  for (const g of groups) {
    if (!g || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) {
      if (h && typeof h.command === 'string' && HOOK_CMD_RE.test(h.command)) return true;
    }
  }
  return false;
}

// Windows hands out EPERM/EBUSY on a rename while a scanner holds the file;
// EACCES nearly never clears on its own, so it is not retried.
function renameWithRetry(from, to, attempts = 5) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); }
    catch (err) {
      const transient = err.code === 'EPERM' || err.code === 'EBUSY';
      if (!transient || i === attempts - 1) throw err;
      const until = Date.now() + 40 * (i + 1);
      while (Date.now() < until) { /* brief spin */ }
    }
  }
}

// Temp file + fsync + rename: a crash mid-write leaves the old settings in
// place, and the temp file keeps the original file's permission bits so a
// 0600 settings.json (it can hold env API keys) is not silently loosened to
// the umask default.
function writeSettings(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = null;
  try { mode = fs.statSync(file).mode & 0o777; } catch (_) {}
  const tmp = `${file}.rdtmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (mode !== null) { try { fs.chmodSync(tmp, mode); } catch (_) {} }
    renameWithRetry(tmp, file);
    try { const dfd = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch (_) {}
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw err;
  }
}

// First backup wins: an install → uninstall cycle must not overwrite the
// pre-install .bak with the hooked state.
function backupOnce(file) {
  if (!fs.existsSync(`${file}.bak`)) fs.copyFileSync(file, `${file}.bak`);
}

function install(file, binPath) {
  file = resolveSymlink(file);
  const { data, existed } = readSettings(file);
  const groups = stopGroups(data, file);
  if (hasOurEntry(groups)) {
    return { changed: false, file, message: `already installed in ${file} — nothing changed` };
  }
  if (existed) backupOnce(file);
  groups.push({ matcher: '', hooks: [{ type: 'command', command: hookCommand(binPath) }] });
  writeSettings(file, data);
  return {
    changed: true, file,
    message: `installed Claude Code Stop hook into ${file}\n  command: ${hookCommand(binPath)}\n  backup: ${existed ? `${file}.bak` : '(none — the file did not exist before)'}`
  };
}

function uninstall(file) {
  file = resolveSymlink(file);
  const { data, existed } = readSettings(file);
  if (!existed) return { changed: false, file, message: `not installed (no settings file): ${file}` };
  if (data.hooks === undefined) return { changed: false, file, message: 'not installed — nothing removed' };
  const groups = stopGroups(data, file);
  let removed = 0;
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    if (!g || !Array.isArray(g.hooks)) continue;
    for (let hi = g.hooks.length - 1; hi >= 0; hi--) {
      const h = g.hooks[hi];
      if (h && typeof h.command === 'string' && HOOK_CMD_RE.test(h.command)) {
        g.hooks.splice(hi, 1);
        removed++;
      }
    }
    // an emptied group that only ever held hooks/matcher does nothing — drop it
    if (g.hooks.length === 0 && Object.keys(g).every(k => k === 'hooks' || k === 'matcher')) {
      groups.splice(gi, 1);
    }
  }
  if (!removed) return { changed: false, file, message: 'not installed — nothing removed' };
  backupOnce(file);
  writeSettings(file, data);
  return { changed: true, file, message: `removed the riffledesk Stop hook from ${file}` };
}

// Lenient on purpose: a broken settings file reads as "not installed" with a
// warning instead of an error, so `status` is safe to run anywhere.
function status(file) {
  try {
    const { data } = readSettings(file);
    const groups = data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks) &&
      Array.isArray(data.hooks.Stop) ? data.hooks.Stop : [];
    return { installed: hasOurEntry(groups), file };
  } catch (err) {
    return { installed: false, file, warning: err.message };
  }
}

// ---------- transcript analysis ----------

// Read the last TAIL_BYTES without loading the whole file. A mid-line cut is
// dropped by slicing to the first newline.
function readTail(file, max = TAIL_BYTES) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (_) { return null; }
  try {
    const st = fs.fstatSync(fd);
    const size = Math.min(st.size, max);
    const start = st.size - size;
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = fs.readSync(fd, buf, off, size - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    let text = buf.slice(0, off).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl < 0 ? '' : text.slice(nl + 1);
    }
    return text;
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

// A genuine user turn: typed text, not a tool_result stitched in by the
// harness, not a meta entry (slash-command wrappers, local-command stdout).
function isGenuineUser(entry) {
  if (!entry || entry.type !== 'user' || entry.isMeta === true) return false;
  const c = entry.message && entry.message.content;
  if (typeof c === 'string') {
    const t = c.trim();
    return t.length > 0 && !t.startsWith('<');
  }
  if (Array.isArray(c)) {
    return c.some(b => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0);
  }
  return false;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// Walk the entries after the last genuine user message: collect the files the
// write-family tools touched, and whether a Bash/PowerShell call already ran
// `riffledesk open|show`. If no genuine user message appears in the tail, the
// turn simply started before the 2 MB window, so the whole tail is in scope.
function analyzeTail(text) {
  const entries = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch (_) { /* skip half-written lines */ }
  }
  let startIdx = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isGenuineUser(entries[i])) { startIdx = i + 1; break; }
  }
  const files = [];
  let shown = false;
  for (let i = startIdx; i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.type !== 'assistant') continue;
    const content = e.message && e.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use') continue;
      const input = block.input || {};
      if (WRITE_TOOLS.has(block.name)) {
        // NotebookEdit calls it notebook_path; the others file_path
        const fp = typeof input.file_path === 'string' && input.file_path ? input.file_path
          : typeof input.notebook_path === 'string' && input.notebook_path ? input.notebook_path : null;
        if (fp) files.push(fp);
      } else if (SHELL_TOOLS.has(block.name)) {
        if (typeof input.command === 'string' && SHOWN_RE.test(input.command)) shown = true;
      }
    }
  }
  return { files, shown };
}

function isUnderDir(abs, dir) {
  let a = path.resolve(abs);
  let d = path.resolve(dir);
  // macOS volumes are case-insensitive by default, like Windows
  if (process.platform === 'win32' || process.platform === 'darwin') {
    a = a.toLowerCase();
    d = d.toLowerCase();
  }
  return a === d || a.startsWith(d + path.sep);
}

// Keep only files that look like user-facing deliverables and still exist
// (a regular file — a directory named x.md does not count).
function isRegularFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function deliverableFiles(files, { claudeDir = path.join(os.homedir(), '.claude'), exists = isRegularFile } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of files) {
    let abs;
    try { abs = path.resolve(raw); } catch (_) { continue; }
    const key = process.platform === 'win32' || process.platform === 'darwin' ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!DELIVERABLE_EXTS.has(path.extname(abs).toLowerCase())) continue;
    const base = path.basename(abs).toLowerCase();
    if (SKIP_BASENAMES.has(base)) continue;
    if (base.startsWith('readme') && base.endsWith('.md')) continue;
    const segs = abs.split(/[\\/]+/).map(s => s.toLowerCase());
    if (segs.includes('.git') || segs.includes('node_modules')) continue;
    if (isUnderDir(abs, claudeDir)) continue;
    let there = false;
    try { there = !!exists(abs); } catch (_) { there = false; }
    if (!there) continue;
    out.push(abs);
  }
  return out;
}

function blockReason(files) {
  const quote = f => `"${f.replace(/"/g, '\\"')}"`;
  const shown = files.slice(0, 5);
  const quoted = shown.map(quote);
  const extra = files.length > shown.length ? ` (+${files.length - shown.length} more)` : '';
  const cmd = files.length === 1
    ? `riffledesk open ${quoted[0]}`
    : `riffledesk show ${quoted.join(' ')} --title "Deliverables"`;
  return `You wrote file(s) the user has not seen yet: ${quoted.join(', ')}${extra}. ` +
    `Before finishing, hand them over with the riffledesk CLI: \`${cmd}\` ` +
    `(one file: riffledesk open; several: riffledesk show). ` +
    `這是交付提醒：寫完要給使用者看的報告／網頁，先 open/show 再收尾。` +
    `If these are not deliverables for the user (scratch, test or internal files), just reply normally.`;
}

module.exports = {
  HOOK_CMD_RE,
  SHOWN_RE,
  DELIVERABLE_EXTS,
  TAIL_BYTES,
  defaultSettingsPath,
  hookCommand,
  install,
  uninstall,
  status,
  readTail,
  analyzeTail,
  deliverableFiles,
  blockReason
};
