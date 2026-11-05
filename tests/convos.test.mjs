// tests/convos.test.mjs — AI-transcript conversation endpoints (/api/convos, /api/convo,
// /api/recent, /api/whichconvo) against tiny fixture transcripts.
// Usage: node --test tests/convos.test.mjs  (spawns server.js on port 5182; never touches repo config)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const PORT = 5182;
const BASE = `http://127.0.0.1:${PORT}`;
const TMPL_DIR = path.join(ROOT, 'tests', 'fixtures', 'convos');

// ---------- sandbox: temp home with fake transcript roots + real written files ----------
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-convos-'));
const WRITTEN = path.join(TMP, 'written');
fs.mkdirSync(path.join(WRITTEN, 'notes'), { recursive: true });
const F_ALPHA = path.join(WRITTEN, 'alpha.md');
const F_BETA = path.join(WRITTEN, 'beta.md');
const F_BETA_UP = path.join(WRITTEN, 'BETA.MD');   // win32: same file as beta.md → dedupe target
const F_GONE = path.join(WRITTEN, 'gone.md');      // never created → exists:false, dropped from views
const F_SORT = path.join(WRITTEN, 'sort.py');
const F_REL = path.join(WRITTEN, 'notes', 'rel.md');
const F_QUOTES = path.join(WRITTEN, 'quotes.js');     // written via exec patch with escape traps
const F_GHOST = path.join(WRITTEN, 'ghost.md');       // named only INSIDE quotes.js content — no one wrote it
fs.writeFileSync(F_ALPHA, '# Alpha\nhello\n');
fs.writeFileSync(F_BETA, '# Beta\nworld\n');
// macOS default APFS is case-INSENSITIVE: BETA.MD then resolves to beta.md, so the
// transcript's case-variant write counts as an existing file even on "POSIX"
const FS_CI = !IS_WIN && fs.existsSync(F_BETA_UP);
fs.writeFileSync(F_SORT, "print('sorted')\n");
fs.writeFileSync(F_REL, 'new\n');
fs.writeFileSync(F_QUOTES, 'const s = "\\n*** Add File: ghost.md";\n');

const CLAUDE_PROJ = path.join(TMP, 'claude-root', 'projects');
const CODEX_SESS = path.join(TMP, 'codex-root', 'sessions', '2026', '10', '28');
fs.mkdirSync(path.join(CLAUDE_PROJ, 'D--fix-proj'), { recursive: true });
fs.mkdirSync(CODEX_SESS, { recursive: true });

const T = m => new Date(Date.now() - m * 60000).toISOString(); // minutes ago
const esc = p => JSON.stringify(p).slice(1, -1);               // embed a path inside a JSON string
// exec-wrapped and function_call patch lines carry the patch in a string INSIDE the line's
// JSON string, so paths live two escape levels deep: real transcripts put four backslashes
// per separator at file level (C:\\\\workspace). Single-escaping here would silently change
// \r/\n/\t sequences in the tmp path (…\Temp\riffledesk-…) into control chars after decode.
const esc2 = p => JSON.stringify(esc(p)).slice(1, -1);
const fill = tmpl => fs.readFileSync(path.join(TMPL_DIR, tmpl), 'utf8')
  .replaceAll('@@CWD@@', esc(WRITTEN))
  .replaceAll('@@FILE1@@', esc(F_ALPHA))
  .replaceAll('@@FILE2@@', esc(F_BETA))
  .replaceAll('@@FILE2UP@@', esc(F_BETA_UP))
  .replaceAll('@@MEMO@@', esc(path.join(CLAUDE_PROJ, 'D--fix-proj', 'memory', 'notes.md')))
  .replaceAll('@@FILEGONE@@', esc(F_GONE))
  .replaceAll('@@FILE4@@', esc2(F_SORT))      // appears only in exec/function_call (2-level) lines
  .replaceAll('@@FILE5@@', esc2(F_QUOTES))    // exec line with the escape trap
  .replaceAll('@@T1@@', T(40)).replaceAll('@@T2@@', T(35)).replaceAll('@@T3@@', T(30))
  .replaceAll('@@T4@@', T(25)).replaceAll('@@T5@@', T(20)).replaceAll('@@T6@@', T(15))
  .replaceAll('@@T7@@', T(10));
const CLAUDE_JSONL = path.join(CLAUDE_PROJ, 'D--fix-proj', 'ses-a.jsonl');
const CODEX_JSONL = path.join(CODEX_SESS, 'rollout-test.jsonl');
fs.writeFileSync(CLAUDE_JSONL, fill('claude-session.jsonl.tmpl'));
fs.writeFileSync(CODEX_JSONL, fill('codex-session.jsonl.tmpl'));

const CONFIG_PATH = path.join(TMP, 'config.json');
fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  roots: [WRITTEN], pinned: [],
  convoRoots: [
    { kind: 'claude', dir: CLAUDE_PROJ },
    { kind: 'codex', dir: path.join(TMP, 'codex-root', 'sessions') }
  ]
}, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let proc = null;
after(() => {
  if (proc) { try { proc.kill(); } catch (_) {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});
async function getJson(p) {
  const res = await fetch(BASE + p);
  const body = await res.json();
  return { status: res.status, body };
}

test('convos endpoints', async (t) => {
  proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: CONFIG_PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  const deadline = Date.now() + 10000;
  while (!out.includes('listening')) {
    if (Date.now() > deadline) throw new Error('server start timeout: ' + out);
    await sleep(25);
  }

  await t.test('GET /api/convos?days=30 lists both conversations with titles and counts', async () => {
    const { status, body } = await getJson('/api/convos?days=30');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.convos.length, 2, JSON.stringify(body.convos));
    // newest (updated) first: codex transcript mtime = fixture write time (now) vs claude written
    // in the same instant — order by updated desc is not guaranteed here, so compare as sets
    const byId = new Map(body.convos.map(c => [c.id, c]));
    const cl = byId.get('claude:ses-a');
    const cx = byId.get('codex:cod-1');
    assert.ok(cl, 'claude conversation present');
    assert.ok(cx, 'codex conversation present');
    assert.equal(cl.title, '幫我修一下登入頁的按鈕');   // <command-…> and tool_result lines skipped
    assert.equal(cx.title, '寫一個排序腳本');           // "# AGENTS.md …" instruction dump skipped
    // win32 folds case (BETA.MD dedupes into beta.md); case-sensitive POSIX drops
    // BETA.MD (never existed); case-insensitive POSIX (default APFS) keeps it as an
    // existing entry of its own
    const betaFiles = IS_WIN ? 2 : (FS_CI ? 3 : 2);
    assert.equal(cl.fileCount, betaFiles);            // alpha+beta exist; gone.md excluded
    assert.equal(cx.fileCount, 3, JSON.stringify(byId.get('codex:cod-1')));  // sort.py (exec + function_call), rel.md, quotes.js; ghost.md never a write
    for (const c of body.convos) {
      for (const k of ['id', 'agent', 'title', 'project', 'started', 'updated', 'fileCount']) {
        assert.ok(k in c, `missing field ${k}`);
      }
      assert.ok(!('files' in c), 'list endpoint must not carry file lists');
    }
  });

  await t.test('GET /api/convo returns /api/list-shaped files in creation order', async () => {
    const { status, body } = await getJson('/api/convo?id=' + encodeURIComponent('claude:ses-a'));
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const names = body.files.map(f => f.name);
    // sidechain Edit merged: beta.md present; memory write and gone.md excluded from view
    assert.ok(!names.includes('notes.md'), 'memory dir writes never show');
    assert.ok(!names.includes('gone.md'), 'non-existing files dropped from the view');
    if (IS_WIN) {
      assert.equal(body.files.length, 2, 'BETA.MD (case variant) dedupes into beta.md');
    } else {
      // case-insensitive POSIX (default APFS): BETA.MD exists → 3 entries;
      // case-sensitive POSIX: BETA.MD never existed, filtered out → 2 entries
      assert.equal(body.files.length, FS_CI ? 3 : 2, `posix + case-insensitive=${FS_CI}`);
    }
    for (const f of body.files) {
      for (const k of ['name', 'path', 'size', 'mtime', 'ext', 'kind']) assert.ok(k in f, `missing ${k}`);
    }
    const alpha = body.files.find(f => f.name === 'alpha.md');
    assert.equal(alpha.kind, 'markdown');
    // creation order (firstAt): alpha written before beta
    assert.ok(names.indexOf('alpha.md') < names.indexOf('beta.md'));
    const bad = await getJson('/api/convo');
    assert.equal(bad.status, 400);
    const miss = await getJson('/api/convo?id=nope');
    assert.equal(miss.status, 404);
  });

  await t.test('GET /api/convo codex: exec-wrapped patch and relative path resolved', async () => {
    const { status, body } = await getJson('/api/convo?id=' + encodeURIComponent('codex:cod-1'));
    assert.equal(status, 200);
    const paths = body.files.map(f => f.path);
    assert.ok(paths.some(p => /sort\.py$/i.test(p)), 'Add File absolute path recorded; got ' + JSON.stringify(paths));
    assert.ok(paths.some(p => /rel\.md$/i.test(p)), 'relative Update File resolved against cwd');
    assert.ok(paths.some(p => /quotes\.js$/i.test(p)), 'trap-laden exec patch still records its file');
    const rel = body.files.find(f => /rel\.md$/i.test(f.path));
    assert.equal(rel.path.toLowerCase(), F_REL.toLowerCase());
  });

  await t.test('escape trap: "\\n" inside patch content must NOT unfold (no ghost attribution)', async () => {
    // quotes.js content holds the 3-char sequence \\n followed by "*** Add File: ghost.md".
    // A naive /\\n/→newline unfold would break the line and record a fake write to ghost.md;
    // correct decoding keeps it two chars on the same line — so ghost.md was never written.
    const { body } = await getJson('/api/convo?id=' + encodeURIComponent('codex:cod-1'));
    assert.ok(!body.files.some(f => /ghost\.md$/i.test(f.path)), 'no ghost file in the conversation view');
    const hit = await getJson('/api/whichconvo?path=' + encodeURIComponent(F_GHOST));
    assert.equal(hit.status, 200);
    assert.equal(hit.body.convos.length, 0, 'whichconvo must not attribute ghost.md to anyone');
  });

  await t.test('GET /api/recent merges conversations, respects exts, newest first', async () => {
    const all = await getJson('/api/recent?hours=1');
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.ok(all.body.files.length >= 3);
    assert.ok(!all.body.files.some(f => f.name === 'gone.md'));
    for (const f of all.body.files) {
      assert.ok(f.convoId && 'convoTitle' in f, 'each recent file carries its conversation');
    }
    const md = await getJson('/api/recent?hours=1&exts=.md');
    assert.equal(md.status, 200);
    assert.ok(md.body.files.length > 0);
    assert.ok(md.body.files.every(f => f.ext === '.md'));
    const lastAts = md.body.files.map(f => f.lastAt);
    assert.deepEqual([...lastAts].sort((a, b) => b - a), lastAts, 'sorted newest first');
  });

  await t.test('GET /api/whichconvo finds the writer (win: case-folded query)', async () => {
    const hit = await getJson('/api/whichconvo?path=' + encodeURIComponent(F_ALPHA));
    assert.equal(hit.status, 200);
    assert.equal(hit.body.convos.length, 1);
    assert.equal(hit.body.convos[0].id, 'claude:ses-a');
    if (IS_WIN) {
      const lo = await getJson('/api/whichconvo?path=' + encodeURIComponent(F_ALPHA.toUpperCase()));
      assert.equal(lo.body.convos.length, 1, 'uppercased query still matches on win32');
    }
    const none = await getJson('/api/whichconvo?path=' + encodeURIComponent(path.join(TMP, 'never.txt')));
    assert.equal(none.body.convos.length, 0);
    const bad = await getJson('/api/whichconvo');
    assert.equal(bad.status, 400);
  });
});
