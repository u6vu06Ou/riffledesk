// fileops.js — the write side of RiffleDesk: reveal / open / rename / trash.
// Every op validates scope (isAllowed) and requires an existing FILE (never a dir).
// Trash always goes through the OS recycle bin — nothing is permanently deleted.
// Zero dependencies; child processes are spawned detached with no console window.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// data/document types the open endpoint may hand to the OS default app.
// Anything runnable (exe/bat/cmd/ps1/js/vbs/py/lnk/url/msi/jar/sh/…) is refused:
// double-clicking those on Windows EXECUTES them.
const OPENABLE_EXTS = new Set([
  'md', 'markdown', 'txt', 'log', 'json', 'csv', 'tsv', 'xlsx', 'xls',
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'html', 'htm', 'docx', 'pptx'
]);

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const BAD_NAME_CHARS = /[/\\:*?"<>|]/;

function fail(status, error) { return { status, body: { ok: false, error } }; }
function ok(body) { return { status: 200, body: { ok: true, ...body } }; }

// ---------- save-in-reader (/api/save) ----------
// UTF-8 only (with or without BOM), ≤ 5 MB, text kinds only. The write is
// atomic (temp file in the same dir + rename, with a short EBUSY retry on
// Windows); the temp name always starts with ".rdtmp-" so the live watcher
// never surfaces it. Line endings and the BOM of the ON-DISK edition are
// preserved. Undo keeps the previous bytes in memory, size-capped.
const SAVE_MAX_BYTES = 5 * 1024 * 1024;      // hard refuse above this (content AND on-disk file)
const SAVE_UNDO_KEEP = 2 * 1024 * 1024;      // previous version kept in the undo stack only up to this
const EDIT_KINDS = new Set(['markdown', 'text', 'html', 'json', 'table', 'code']);

function hasBom(buf) { return buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF; }
function strictUtf8(buf) { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
function dominantEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  if (!crlf && !lf) return null;            // no newlines at all → nothing to preserve
  return crlf > lf ? '\r\n' : '\n';
}
let spinWarned = false;
function syncSleepMs(ms) { // writeAtomic retry pause (no async needed inside it)
  // Node 主執行緒一定有 Atomics.wait；這個後備是給建不出 SharedArrayBuffer 的環境
  // （非 crossOriginIsolated 的 renderer）。忙等會吃掉整顆核，記一次讓它可觀測。
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); return; } catch (_) {}
  if (!spinWarned) { spinWarned = true; console.warn('[fileops] Atomics.wait unavailable — retry pauses spin-wait'); }
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

// 寫一個檔：temp 檔放同一個資料夾（同磁碟區，rename 才可能是原子操作）再 rename 蓋過去。
// win32 上目標常被索引器／縮圖讀取／防毒短暫鎖住（剛寫過的檔會進 Defender 掃描佇列），
// 所以 transient 鎖會重試約 2 秒（**這段是同步的，會擋住 event loop 約 2 秒**，寫入端是低頻
// 路徑，換取呼叫端不用全部改成 async）。真的鎖過 2 秒就退回「原地覆寫」：先讀回舊位元組當
// 快照，直接寫目標檔，失敗就寫回快照。這條路不具原子性（並行讀者可能讀到半截），也跟隨
// symlink 覆寫其目標（rename 則是換掉連結本身）；但那比直接回 500、讓編輯白打還好。
// 快照讀不回來（同一個鎖、或檔案剛被刪）就照樣寫，錯誤訊息會講明有沒有快照、還原有沒有成功。
const RENAME_RETRIES = 20;   // × RENAME_RETRY_MS ≈ 2 s
const RENAME_RETRY_MS = 100;
const TRANSIENT_WRITE = new Set(['EBUSY', 'EPERM', 'EACCES']);   // 同一組判斷兼作重試與後備條件
const TMP_RE = /^\.rdtmp-/;
const TMP_STALE_MS = 60 * 60 * 1000;

function writeDurable(p, buf) {   // 寫完 fsync：不然「原子」只擋得住行程死掉，擋不住斷電
  const fd = fs.openSync(p, 'w');
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// 清掉本目錄裡放太久的 .rdtmp-*（只有後備也失敗時才會留下來）。失敗一律忽略。
// 每寫一次都 readdir 太貴（大資料夾），每個目錄最多 10 分鐘掃一次。
const sweepAt = new Map();
function sweepStaleTemps(dir) {
  const now = Date.now();
  const last = sweepAt.get(dir);
  if (last && now - last < 10 * 60 * 1000) return;
  if (sweepAt.size > 200) sweepAt.clear();
  sweepAt.set(dir, now);
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  const cut = now - TMP_STALE_MS;
  for (const n of names) {
    if (!TMP_RE.test(n)) continue;
    const p = path.join(dir, n);
    try { if (fs.statSync(p).mtimeMs < cut) fs.unlinkSync(p); } catch (_) {}
  }
}

function overwriteInPlace(abs, buf, renameErr, tries, tmp) {
  let prev = null, snapErr = null;
  try { prev = fs.readFileSync(abs); } catch (err) { snapErr = err; }
  const note = prev ? `previous ${prev.length} bytes snapshotted`
    : `no snapshot (${snapErr && snapErr.code === 'ENOENT' ? 'target missing' : 'read failed: ' + (snapErr && snapErr.message)})`;
  let writeErr;
  try {
    fs.writeFileSync(abs, buf);
  } catch (err) {
    writeErr = err;
  }
  if (!writeErr) { try { fs.unlinkSync(tmp); } catch (_) {} return; }
  let restored;
  if (!prev) restored = 'nothing to restore';
  else {
    try { fs.writeFileSync(abs, prev); restored = 'previous bytes restored'; }
    catch (err2) { restored = 'RESTORE ALSO FAILED: ' + err2.message; }
  }
  throw new Error('rename into place failed after ' + tries + ' tries: ' + renameErr.message +
    '; in-place write failed: ' + writeErr.message + ' [' + note + ', ' + restored +
    '] (temp with the new content kept at ' + tmp + ')');
}

function writeAtomic(abs, buf) {
  const dir = path.dirname(abs);
  const tmp = path.join(dir, '.rdtmp-' + process.pid.toString(36) + '-' +
    Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.tmp');
  try { writeDurable(tmp, buf); } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw new Error('write temp failed: ' + err.message);
  }
  for (let i = 1; ; i++) {
    try { fs.renameSync(tmp, abs); }
    catch (err) {
      if (!IS_WIN || !TRANSIENT_WRITE.has(err.code)) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw new Error('rename into place failed after ' + i + ' tries: ' + err.message);
      }
      if (i <= RENAME_RETRIES) { syncSleepMs(RENAME_RETRY_MS); continue; }
      overwriteInPlace(abs, buf, err, i, tmp);   // 拋錯時它自己會帶著診斷訊息
    }
    sweepStaleTemps(dir);
    return;
  }
}

function hasControlChar(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 32) return true;
  }
  return false;
}

// plain file name validation for /api/rename (returns an error string or null)
function validateNewName(newName) {
  if (typeof newName !== 'string' || newName.length === 0) return 'newName must be a non-empty file name';
  if (newName.length > 255) return 'newName too long (max 255)';
  if (newName === '.' || newName === '..') return 'newName cannot be . or ..';
  if (BAD_NAME_CHARS.test(newName)) return 'newName contains a character that is not allowed (/ \\ : * ? " < > |)';
  if (hasControlChar(newName)) return 'newName contains a control character';
  if (IS_WIN) {
    if (/[. ]$/.test(newName)) return 'newName cannot end with a dot or space on Windows';
    if (WIN_RESERVED.test(newName)) return 'newName is a reserved Windows device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)';
  }
  return null;
}

// Restore one file from the Windows recycle bin (undo of trash). Matches bin
// items by ORIGINAL full path (case-insensitive) + closest deletion time to
// `deletedAtISO` (items whose deletion time cannot be read score MaxValue —
// they only win when nothing else matches). Never overwrites an existing file —
// callers check the target is free first. Returns null on success, else a
// clear error string (diagnostics carry paths/codes only, never file content).
// Headless: powershell -NoProfile -NonInteractive -WindowStyle Hidden, window hidden.
function restoreFromRecycleBinWin(abs, deletedAtISO) {
  return new Promise((resolve) => {
    const script =
      '$ErrorActionPreference="Continue";' +
      '$t=$env:RIFFLE_RESTORE_TARGET;$when=[DateTime]::Parse($env:RIFFLE_RESTORE_WHEN);' +
      '$sh=New-Object -ComObject Shell.Application;' +
      '$bin=$sh.NameSpace(10);' +
      'if(-not $bin){Write-Output "{""found"":false,""nobin"":true}";exit 4};' +
      '$best=$null;$bs=[double]::MaxValue;' +
      'foreach($it in @($bin.Items())){' +
      '$n=$bin.GetDetailsOf($it,0);$f=$bin.GetDetailsOf($it,1);' +
      'if(-not $n){continue};' +
      'try{$full=[IO.Path]::Combine($f,$n)}catch{continue};' +
      'if($full -ine $t){continue};' +
      '$sc=[double]::MaxValue;' +
      'try{$d=$it.ExtendedProperty("System.Recycle.DateDeleted");if($null -ne $d){$sc=[Math]::Abs((([DateTime]$d)-$when).TotalSeconds)}}catch{};' +
      'if($sc -lt $bs){$bs=$sc;$best=$it}' +
      '};' +
      'if(-not $best){Write-Output "{""found"":false}";exit 4};' +
      // the Restore verb name is LOCALIZED — accept the common variants
      '$v=$null;foreach($vv in @($best.Verbs())){$nm=$vv.Name -replace "&","";' +
      'if($nm -match "^(Restore$|Restore |還原|还原|元に戻す|Wiederherstellen|Restaurer|Restaurar|Ripristina|복원|Восстановить|Herstel)"){$v=$vv;break}};' +
      'if(-not $v){Write-Output "{""found"":true,""restored"":false,""noverb"":true}";exit 5};' +
      '$v.DoIt();Write-Output "{""found"":true,""restored"":true}";';
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      {
        env: { ...process.env, RIFFLE_RESTORE_TARGET: abs, RIFFLE_RESTORE_WHEN: deletedAtISO },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
    let out = '', errOut = '';
    if (child.stdout) child.stdout.on('data', d => { if (out.length < 4096) out += d.toString('utf8'); });
    // stderr carries diagnostics only (paths / PS errors) — never file content
    if (child.stderr) child.stderr.on('data', d => { if (errOut.length < 2048) errOut += d.toString('utf8'); });
    const errSuffix = () => errOut.trim() ? ' — ' + errOut.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
    let settled = false;
    const done = (err) => { if (!settled) { settled = true; clearTimeout(killer); resolve(err); } };
    const killer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      // kill() drops the task but not always its whole process TREE on win32 — taskkill best-effort
      try { spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
      done('recycle bin restore timed out');
    }, 30000);
    child.on('error', err => done('recycle bin helper failed to start: ' + err.message));
    child.on('close', () => {
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split(/\r?\n/).pop()); } catch (_) {}
      if (!parsed) return done('recycle bin helper returned no result' + errSuffix());
      if (!parsed.found) return done(parsed.nobin
        ? 'cannot open the Recycle Bin (Shell.Application failed)' + errSuffix()
        : 'not found in the Recycle Bin (already emptied, or removed by hand?)');
      if (!parsed.restored) return done(parsed.noverb
        ? 'recycle bin item has no Restore verb (unrecognised UI language?)'
        : 'restore failed in the Recycle Bin' + errSuffix());
      done(null);
    });
  });
}

function createFileOps(deps) {
  const { isAllowed, norm, indexer, invalidateDir, KIND } = deps;

  // ---------- undo (Ctrl+Z): in-memory stack of the last 20 ops ----------
  // rename → rename back; trash → restore from the OS recycle bin. Ops sharing
  // one `group` id (batch select+trash) merge into ONE undo step — within a
  // 30-minute window and capped at 500 items per merged entry (a runaway
  // client cannot grow one entry forever). The stack lives in memory only:
  // a server restart forgets it (documented in README).
  const UNDO_MERGE_MS = 30 * 60 * 1000; // same-type same-group ops merge within this window
  const UNDO_GROUP_CAP = 500;           // beyond that a NEW entry starts (bounded memory / undo time)
  const undoLog = []; // [{ type: 'rename'|'trash'|'save', group, at, items: [{ oldAbs, newAbs } | { abs, deletedAt, size } | { abs, prev, mtime, size }] }]
  function logOp(type, group, item) {
    if (typeof group !== 'string' || !group) group = null;
    const now = Date.now();
    const last = undoLog[undoLog.length - 1];
    if (last && group && last.type === type && last.group === group &&
        now - last.at < UNDO_MERGE_MS && last.items.length < UNDO_GROUP_CAP) {
      last.items.push(item);
      last.at = now;
      return;
    }
    undoLog.push({ type, group, at: now, items: [item] });
    if (undoLog.length > 20) undoLog.shift();
  }
  // win32 file names are case-insensitive: norm() folds case for comparisons
  const samePath = (a, b) => norm(a) === norm(b);
  // lstat (does NOT follow symlinks — a dangling symlink still counts as
  // taken). Only ENOENT means "free"; permission/other errors are treated as
  // taken so we never mistake an unreadable path for an empty slot.
  function pathTaken(abs) {
    try { fs.lstatSync(abs); return true; } catch (e) { return !(e && e.code === 'ENOENT'); }
  }
  // loose existence probe for the "is the renamed file still there" check:
  // unreadable (EACCES) counts as present — the rename-back attempt will
  // surface the real OS error instead of a misleading "no longer exists".
  const filePresent = pathTaken;

  // each returns true when it actually restored something, false on failure
  function undoRenameOne(it, out) {
    const name = path.basename(it.newAbs);
    if (it.oldAbs === it.newAbs) { out.restored.push(name); out.paths.push(it.newAbs); return true; }
    if (!isAllowed(it.newAbs) || !isAllowed(it.oldAbs)) { out.failed.push({ name, error: 'path not under allowed scopes' }); return false; }
    if (!filePresent(it.newAbs)) { out.failed.push({ name, error: 'the renamed file no longer exists' }); return false; }
    // pure case-change (foo.txt → FOO.txt): folded-equal paths mean the file at
    // oldAbs IS this same file on a case-insensitive volume — restore the
    // original casing by renaming back, do not treat it as "name taken".
    const caseOnly = samePath(it.oldAbs, it.newAbs);
    if (!caseOnly && pathTaken(it.oldAbs)) { out.failed.push({ name, error: 'the original name is taken — refused to overwrite' }); return false; }
    try { fs.renameSync(it.newAbs, it.oldAbs); } catch (err) { out.failed.push({ name, error: 'rename back failed: ' + err.message }); return false; }
    if (indexer && indexer.available) { try { indexer.renamed(it.newAbs, it.oldAbs); } catch (_) {} }
    invalidateDir(path.dirname(it.oldAbs));
    out.restored.push(path.basename(it.oldAbs));
    out.paths.push(it.oldAbs, it.newAbs);
    return true;
  }

  async function undoTrashOne(it, out) {
    const name = path.basename(it.abs);
    if (!isAllowed(it.abs)) { out.failed.push({ name, error: 'path not under allowed scopes' }); return false; }
    if (!IS_WIN) { out.failed.push({ name, error: 'trash undo is implemented for Windows only (recycle bin restore)' }); return false; }
    if (pathTaken(it.abs)) { out.failed.push({ name, error: 'the original name is taken — refused to overwrite' }); return false; }
    const err = await restoreFromRecycleBinWin(it.abs, it.deletedAt);
    if (err) { out.failed.push({ name, error: err }); return false; }
    // verify the restore actually landed (verb.DoIt() is fire-and-forget),
    // and that what landed is the SAME file we trashed (size recorded at op time)
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (pathTaken(it.abs)) break;
      await new Promise(r => setTimeout(r, 200));
    }
    let st = null;
    try { st = fs.statSync(it.abs); } catch (_) {}
    if (!st) { out.failed.push({ name, error: 'recycle bin restore did not bring the file back' }); return false; }
    if (it.size != null && st.size !== it.size) {
      out.failed.push({ name, error: 'restored file has a different size than the one that was trashed — restored anyway, please check it' });
      out.restored.push(name);
      out.paths.push(it.abs);
      return true; // it IS back where it belongs; the warning is the point
    }
    invalidateDir(path.dirname(it.abs));
    if (indexer && indexer.available) { try { indexer.reindexDir(path.dirname(it.abs)); } catch (_) {} }
    out.restored.push(name);
    out.paths.push(it.abs);
    return true;
  }

  // undo of a reader save: put the previous bytes back (atomic, mtime restored
  // so an editor still open on that file is no longer in conflict with disk)
  function undoSaveOne(it, out) {
    const name = path.basename(it.abs);
    if (!isAllowed(it.abs)) { out.failed.push({ name, error: 'path not under allowed scopes' }); return false; }
    if (!pathTaken(it.abs)) { out.failed.push({ name, error: 'the saved file no longer exists — refusing to resurrect it' }); return false; }
    try { writeAtomic(it.abs, it.prev); } catch (err) { out.failed.push({ name, error: err.message }); return false; }
    if (it.mtime != null) { try { fs.utimesSync(it.abs, new Date(), new Date(it.mtime)); } catch (_) {} }
    invalidateDir(path.dirname(it.abs));
    if (indexer && indexer.available) { try { indexer.reindexDir(path.dirname(it.abs)); } catch (_) {} }
    out.restored.push(name);
    out.paths.push(it.abs);
    return true;
  }

  // in-flight chain: rapid Ctrl+Z presses run serially, each undoing the next
  // entry instead of racing on the same pop
  let undoChain = Promise.resolve();
  function undoLast() {
    const run = undoChain.then(undoLastInner);
    undoChain = run.catch(() => {});
    return run;
  }

  async function undoLastInner() {
    const entry = undoLog.pop();
    if (!entry) return { status: 404, body: { ok: false, error: 'nothing to undo', remaining: 0 } };
    const out = { op: entry.type, restored: [], failed: [], paths: [] };
    const failedItems = [];
    for (let i = entry.items.length - 1; i >= 0; i--) { // LIFO within the op too
      const it = entry.items[i];
      const okIt = entry.type === 'save' ? undoSaveOne(it, out)
        : entry.type === 'rename' ? undoRenameOne(it, out)
        : await undoTrashOne(it, out);
      if (!okIt) failedItems.unshift(it); // keep original order for any retry
    }
    // a failed undo must NOT silently eat the record: all-failed puts the whole
    // entry back, partially-failed puts back just the failed items LIFO-under
    // the rest of the stack so a retry (or manual fix + retry) stays possible
    if (failedItems.length) {
      undoLog.push(failedItems.length === entry.items.length ? entry : { ...entry, items: failedItems });
      if (undoLog.length > 20) undoLog.shift();
    }
    const status = out.failed.length && !out.restored.length ? 409 : 200;
    const body = { ok: status === 200, op: entry.type, restored: out.restored, failed: out.failed, paths: out.paths, remaining: undoLog.length };
    if (out.failed.length && !out.restored.length && entry.items.length === 1) body.error = out.failed[0].error;
    return { status, body };
  }

  function checkTargetFile(p) {
    // shared validation for all four endpoints; returns { abs, st } or a fail()
    if (!p || typeof p !== 'string' || p.includes('\0')) return fail(400, 'missing or bad path');
    const abs = path.resolve(p);
    if (!isAllowed(abs)) return fail(403, 'path not under allowed scopes');
    let st;
    try { st = fs.statSync(abs); } catch (_) { return fail(404, 'not found'); }
    if (!st.isFile()) return fail(400, 'not a file');
    return { abs, st };
  }

  function spawnDetached(cmd, args, extra = {}) {
    const child = spawn(cmd, args, {
      detached: true, stdio: 'ignore', windowsHide: true, ...extra
    });
    child.on('error', () => {}); // missing helper binary must not crash the server
    child.unref();
    return child;
  }

  // show the file, selected, in the OS file manager
  function reveal(p) {
    const t = checkTargetFile(p);
    if (t.status) return t;
    if (IS_WIN) spawnDetached('explorer.exe', [`/select,"${t.abs}"`]);
    else if (IS_MAC) spawnDetached('open', ['-R', t.abs]);
    else spawnDetached('xdg-open', [path.dirname(t.abs)]);
    return ok({});
  }

  // open with the OS default app — data/document extensions only
  function openFile(p) {
    const t = checkTargetFile(p);
    if (t.status) return t;
    const ext = path.extname(t.abs).slice(1).toLowerCase();
    if (!OPENABLE_EXTS.has(ext)) {
      return fail(403, `refusing to open ".${ext || '(none)'}" files — only data/document types can be opened (executables and scripts would run)`);
    }
    if (IS_WIN) spawnDetached('explorer.exe', [t.abs]);
    else if (IS_MAC) spawnDetached('open', [t.abs]);
    else spawnDetached('xdg-open', [t.abs]);
    return ok({});
  }

  function rename(p, newName, group) {
    const t = checkTargetFile(p);
    if (t.status) return t;
    const bad = validateNewName(newName);
    if (bad) return fail(400, bad);
    const dir = path.dirname(t.abs);
    const target = path.join(dir, newName);
    const sameFile = norm(target) === norm(t.abs); // win32 folds case: pure case-change lands here
    if (!sameFile) {
      // target must not already exist; on win32 the check is case-insensitive
      // (the same-file case-change already matched sameFile above)
      let clash = false;
      if (IS_WIN) {
        const want = newName.toLowerCase();
        try {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name.toLowerCase() !== want) continue;
            if (norm(path.join(dir, e.name)) === norm(t.abs)) continue; // same file
            clash = true;
            break;
          }
        } catch (_) {}
      } else {
        clash = fs.existsSync(target);
      }
      if (clash) return fail(409, 'a file with that name already exists');
    }
    if (target !== t.abs) {
      try { fs.renameSync(t.abs, target); } catch (err) { return fail(500, 'rename failed: ' + err.message); }
    }
    let st2;
    try { st2 = fs.statSync(target); } catch (_) { return fail(500, 'rename reported success but the target is missing'); }
    if (indexer && indexer.available) { try { indexer.renamed(t.abs, target); } catch (_) {} }
    invalidateDir(dir);
    logOp('rename', group, { oldAbs: t.abs, newAbs: target });
    const ext = path.extname(newName).toLowerCase();
    return ok({
      file: { name: newName, path: target, size: st2.size, mtime: st2.mtimeMs, ext, kind: KIND[ext] || null }
    });
  }

  function runTrash(abs) {
    return new Promise((resolve) => {
      let child;
      if (IS_WIN) {
        // path travels in an env var — never interpolated into the script text
        const script =
          'Add-Type -AssemblyName Microsoft.VisualBasic;' +
          '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(' +
          "$env:RIFFLE_TRASH_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin');" +
          'if (Test-Path -LiteralPath $env:RIFFLE_TRASH_TARGET) { exit 3 }';
        child = spawn('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
          { env: { ...process.env, RIFFLE_TRASH_TARGET: abs }, windowsHide: true, stdio: 'ignore' });
      } else if (IS_MAC) {
        child = spawn('osascript', [
          '-e', 'on run argv',
          '-e', 'tell application "Finder" to delete POSIX file (item 1 of argv)',
          '-e', 'end run',
          abs
        ], { windowsHide: true, stdio: 'ignore' });
      } else {
        child = spawn('gio', ['trash', abs], { windowsHide: true, stdio: 'ignore' });
      }
      let settled = false;
      const done = (err) => { if (!settled) { settled = true; clearTimeout(killer); resolve(err || null); } };
      const killer = setTimeout(() => { try { child.kill(); } catch (_) {} done(new Error('trash timed out')); }, 30000);
      child.on('error', done);
      child.on('close', (code) => done(code === 0 ? null : new Error('trash helper exited with code ' + code)));
    });
  }

  async function trash(p, group) {
    const t = checkTargetFile(p);
    if (t.status) return t;
    if (process.env.RIFFLEDESK_TRASH_DRYRUN === '1') {
      // automated-test switch: validate everything, touch nothing
      return ok({ dryRun: true });
    }
    const deletedAt = new Date().toISOString(); // recorded BEFORE the bin drop for the undo match
    const err = await runTrash(t.abs);
    if (err) return fail(500, 'trash failed: ' + err.message);
    let stillThere = true;
    try { fs.statSync(t.abs); } catch (_) { stillThere = false; }
    if (stillThere) return fail(500, 'trash failed: the file is still at its path');
    if (indexer && indexer.available) { try { indexer.removed(t.abs); } catch (_) {} }
    invalidateDir(path.dirname(t.abs));
    // undo is recorded ONLY where a restore path exists (Windows recycle bin);
    // on other platforms a trash entry could never be restored and would just
    // burn stack slots and produce 409s (documented in README)
    if (IS_WIN) logOp('trash', group, { abs: t.abs, deletedAt, size: t.st.size });
    return ok({});
  }

  // POST /api/save — write edited text back. content is the WHOLE file (browser
  // editors normalise to \n; we re-apply the disk edition's CRLF + BOM below).
  function saveEdit(p, content, baseMtime, baseSize) {
    const t = checkTargetFile(p);
    if (t.status) return t;
    if (typeof content !== 'string') return fail(400, 'content must be a string');
    if (!Number.isFinite(baseMtime) || !Number.isFinite(baseSize)) return fail(400, 'baseMtime/baseSize (numbers) are required');
    const kind = KIND[path.extname(t.abs).toLowerCase()] || null;
    if (!kind || !EDIT_KINDS.has(kind)) return fail(415, `".${path.extname(t.abs).slice(1) || '(none)'}" files cannot be edited here`);
    if (t.st.size > SAVE_MAX_BYTES) return fail(413, 'file too large to edit here (max 5 MB)');
    const newLen = Buffer.byteLength(content, 'utf8');
    if (newLen > SAVE_MAX_BYTES) return fail(413, 'content too large (max 5 MB)');

    // conflict: disk moved since the editor's base version → hand the disk text back
    if (Math.abs(t.st.mtimeMs - baseMtime) > 2 || t.st.size !== baseSize) {
      let diskContent = null;
      try {
        const raw = fs.readFileSync(t.abs);
        if (raw.length <= SAVE_MAX_BYTES) diskContent = strictUtf8(hasBom(raw) ? raw.subarray(3) : raw);
      } catch (_) {}
      return { status: 409, body: { ok: false, error: 'conflict', size: t.st.size, mtime: t.st.mtimeMs, content: diskContent } };
    }

    // read the disk edition once: encoding guard + BOM/EOL style to preserve
    let diskBuf;
    try { diskBuf = fs.readFileSync(t.abs); } catch (err) { return fail(500, 'read failed: ' + err.message); }
    if (diskBuf.length > SAVE_MAX_BYTES) return fail(413, 'file too large to edit here (max 5 MB)');
    if (diskBuf.includes(0x00)) return fail(415, 'binary file — refused');
    const bom = hasBom(diskBuf);
    let diskText;
    try { diskText = strictUtf8(bom ? diskBuf.subarray(3) : diskBuf); } catch (_) {
      return fail(415, 'file is not valid UTF-8 — other encodings are not editable here');
    }
    const eol = dominantEol(diskText);

    // re-apply the disk edition's line endings + BOM onto the new content
    let outText = content.replace(/\r\n/g, '\n');     // normalise first, then re-expand
    if (eol === '\r\n') outText = outText.replace(/\n/g, '\r\n');
    let outBuf = Buffer.from(outText, 'utf8');
    if (bom) outBuf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), outBuf]);

    try { writeAtomic(t.abs, outBuf); } catch (err) { return fail(500, 'save failed: ' + err.message); }
    let st2;
    try { st2 = fs.statSync(t.abs); } catch (_) { return fail(500, 'save reported success but the file is missing'); }

    // undo: keep the previous bytes (size-capped); the editor toast offers 復原
    let undoable = false;
    if (diskBuf.length <= SAVE_UNDO_KEEP) {
      logOp('save', null, { abs: t.abs, prev: diskBuf, mtime: t.st.mtimeMs, size: t.st.size });
      undoable = true;
    }
    invalidateDir(path.dirname(t.abs));
    if (indexer && indexer.available) { try { indexer.reindexDir(path.dirname(t.abs)); } catch (_) {} }
    return ok({ size: st2.size, mtime: st2.mtimeMs, bom, crlf: eol === '\r\n', undoable });
  }

  return { reveal, openFile, rename, trash, undoLast, saveEdit, undoCount: () => undoLog.length };
}

module.exports = { createFileOps, validateNewName, OPENABLE_EXTS, writeAtomic };
