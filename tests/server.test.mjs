// tests/server.test.mjs — zero-dependency HTTP tests for server.js.
// Usage: node --test tests/server.test.mjs
// Spawns server.js on port 5179 against a temp fixture dir (never touches the repo config).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const PORT = 5179;
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- temp fixture ----------
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-test-'));
const FIX = path.join(TMP, 'fixture');
const mkdir = (...p) => fs.mkdirSync(path.join(FIX, ...p), { recursive: true });
const write = (rel, text) => fs.writeFileSync(path.join(FIX, ...rel.split('/')), text);

mkdir('notes', 'deep');
mkdir('code');
mkdir('.hidden');
mkdir('node_modules', 'pkg');
mkdir('CaseDir');
write('notes/deep/inner.md', 'nothing here\nBUT the magicword hides inside this note\n');
write('code/app.js', '// the magicword appears in js too\nconsole.log(1);\n');
write('zz-magicword-name.md', 'plain note, no content match\n'); // name match only
write('.hidden/secret.md', 'magicword must NOT be found from a dot-dir\n');
write('node_modules/pkg/dep.md', 'magicword must NOT be found from node_modules\n');
write('CaseDir/upper.md', 'case sensitivity test content\n');
// case behaviour of the FIXTURE's filesystem, probed live: macOS default APFS is
// case-insensitive (so a case-mangled path resolves), most Linux filesystems are not
const CI_PROBE = path.join(FIX, 'CaseProbe.SeNtInEl');
fs.writeFileSync(CI_PROBE, '');
const FIXTURE_CI = fs.existsSync(path.join(FIX, 'caseprobe.sentinel'));
fs.rmSync(CI_PROBE, { force: true });
fs.writeFileSync(path.join(FIX, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
fs.writeFileSync(path.join(FIX, 'clip.mp4'), Buffer.alloc(64, 7));   // 假影片：只測 HTTP 行為，不解碼
fs.writeFileSync(path.join(FIX, 'deck.pptx'), Buffer.from('PK\x03\x04 fake pptx bytes'));   // 假 pptx：只測 kind/容量，不解 ZIP
fs.writeFileSync(path.join(FIX, 'query.xyz'), 'unknown ext\n');
fs.writeFileSync(path.join(FIX, 'huge.pptx'), Buffer.alloc(21 * 1024 * 1024, 3));           // 超過 sheet cap → 413

const CONFIG_PATH = path.join(TMP, 'config.json');
fs.writeFileSync(CONFIG_PATH, JSON.stringify({ roots: [FIX], pinned: [] }, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// POSIX browse scope is home + mounts, so the temp fixture is out of scope there
// (on Windows it merely happens to sit on an allowed drive). Declare TMP as a
// "drive" via the test-only RIFFLEDESK_TEST_DRIVES hook (see collectDrives).
// An outer value is appended so a Windows run can still be forced narrow. On a
// plain Windows run the override stays off ('' → hook inactive), which keeps
// the real drive-letter assertion in the /api/drives test meaningful.
const DRIVES = (process.env.RIFFLEDESK_TEST_DRIVES || !IS_WIN)
  ? [TMP, process.env.RIFFLEDESK_TEST_DRIVES].filter(Boolean).join(path.delimiter)
  : '';

async function startServer(extraEnv = {}) {
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', RIFFLEDESK_TEST_DRIVES: DRIVES, PORT: String(PORT), FLODER_CONFIG: CONFIG_PATH, RIFFLEDESK_INDEX: 'off', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let out = '';
  const startDeadline = Date.now() + 10000;
  const ready = () => out.includes('listening');
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  while (!ready()) {
    if (exited) throw new Error('server exited early: ' + out);
    if (Date.now() > startDeadline) throw new Error('server start timeout: ' + out);
    await sleep(25);
  }
  return proc;
}

async function getJson(p) {
  const res = await fetch(BASE + p);
  const body = await res.json();
  return { status: res.status, body };
}

async function getRaw(p, headers = {}) {
  const res = await fetch(BASE + p, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body: buf };
}

function waitPortFree(port) {
  let tries = 0;
  return new Promise((resolve) => {
    const attempt = () => {
      const s = net.createConnection(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        if (++tries > 100) return resolve(); // give up anyway; safest fallback
        setTimeout(attempt, 50);
      });
      s.once('error', () => resolve());
    };
    attempt();
  });
}

const procs = [];
after(() => {
  for (const p of procs) { try { p.kill(); } catch (_) {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---------- unit checks via exports (no server needed) ----------
// Missing paths must be judged by the real location of their nearest EXISTING
// ancestor: a missing file under a symlinked allowed dir is 404, not 403.
// (macOS os.tmpdir() is /var/folders/…, a symlink to /private/var/folders/….)
// Scope is narrowed to TMP via the test-only drive hook, so "outside" is real.
test('unit: missing file under a symlinked allowed dir stays in scope', (t) => {
  process.env.NODE_ENV = 'test';
  process.env.RIFFLEDESK_TEST_DRIVES = TMP;
  // empty roots: the temp tree is then the ONLY scope, so "outside" is real
  process.env.FLODER_CONFIG = path.join(TMP, 'unit-config.json');
  fs.writeFileSync(process.env.FLODER_CONFIG, JSON.stringify({ roots: [], pinned: [] }));
  const require2 = createRequire(import.meta.url);
  const srv = require2(path.join(ROOT, 'server.js'));
  const IN = path.join(TMP, 'real-in');
  const OUT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-outside-'));
  const LINK = path.join(TMP, 'link-in');
  const ESC = path.join(TMP, 'link-out');
  fs.mkdirSync(IN);
  try {
    fs.symlinkSync(IN, LINK, IS_WIN ? 'junction' : 'dir');
    fs.symlinkSync(OUT, ESC, IS_WIN ? 'junction' : 'dir');
  } catch (err) {
    t.skip(`symlink creation failed: ${err.message}`);
    return;
  }
  try {
    fs.writeFileSync(path.join(IN, 'real.txt'), 'x\n');
    assert.equal(srv.isAllowed(path.join(IN, 'real.txt')), true);
    // the regression: ancestor realpath must resolve, so a missing file is in scope
    assert.equal(srv.isAllowed(path.join(LINK, 'missing.txt')), true);
    assert.equal(srv.isAllowed(path.join(LINK, 'missing-dir', 'deep.txt')), true);
    // still fails closed: a symlink pointing outside the scope stays 403 even
    // for a path that does not exist
    assert.equal(srv.isAllowed(path.join(ESC, 'missing.txt')), false);
    assert.equal(srv.isAllowed(path.join(OUT, 'missing.txt')), false);
    // a DANGLING link exists but resolves nowhere: appending its target literally
    // would lie about the real location, so it must fail closed too
    const DANGLE = path.join(TMP, 'link-dangle');
    try { fs.symlinkSync(path.join(TMP, 'gone', 'nowhere'), DANGLE, IS_WIN ? 'junction' : 'dir'); } catch (_) {}
    if (fs.lstatSync(DANGLE, { throwIfNoEntry: false })) {
      assert.equal(srv.isAllowed(path.join(DANGLE, 'x.txt')), false);
    }
    // bad input never throws
    assert.equal(srv.isAllowed(''), false);
  } finally {
    fs.rmSync(LINK, { recursive: true, force: true });
    fs.rmSync(ESC, { recursive: true, force: true });
    fs.rmSync(IN, { recursive: true, force: true });
    fs.rmSync(OUT, { recursive: true, force: true });
    process.env.RIFFLEDESK_TEST_DRIVES = DRIVES;
  }
});

test('unit: norm folds case only on Windows', () => {
  process.env.FLODER_CONFIG = path.join(TMP, 'unit-config.json'); // keep cfg writes in TMP
  const require2 = createRequire(import.meta.url);
  const srv = require2(path.join(ROOT, 'server.js'));
  assert.equal(typeof srv.start, 'function');
  if (IS_WIN) {
    assert.equal(srv.norm('D:\\WorkSpace'), srv.norm('d:\\workspace'));
  } else {
    assert.notEqual(srv.norm('/A/B'), srv.norm('/a/b'));
    assert.equal(srv.norm('/'), '/');
  }
});

// ---------- truncated-budget behaviour (own server, same port, runs before main suite) ----------
const REL = p => p.split('/').join(path.sep);

test('search: truncated when the file budget is tiny', async () => {
  const proc = await startServer({ FLODER_SEARCH_MAX_FILES: '1' });
  procs.push(proc);
  try {
    const { status, body } = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=magicword`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.truncated, true);
    assert.ok(body.scanned <= 3, `scanned ${body.scanned} should stop at the tiny budget`);
  } finally {
    proc.kill();
    await waitPortFree(PORT); // port must be released before the main suite binds it again
  }
});

// ---------- main API suite ----------
test('api suite', async (t) => {
  const proc = await startServer();
  procs.push(proc);
  const teardown = () => { try { proc.kill(); } catch (_) {} };

  try {
    await t.test('GET /api/drives returns {path,label} with label === path', async () => {
      const { status, body } = await getJson('/api/drives');
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.drives) && body.drives.length > 0);
      for (const d of body.drives) {
        assert.equal(typeof d.path, 'string');
        assert.equal(d.label, d.path); // server no longer sends localized Chinese labels
      }
      if (DRIVES) {
        // test-only override (see RIFFLEDESK_TEST_DRIVES in collectDrives): the
        // harness simulates a scope, so assert against that instead of the host
        assert.ok(body.drives.length > 0);
      } else if (IS_WIN) {
        assert.ok(body.drives.some(d => /^[A-Za-z]:[\\/]$/.test(d.path)));
      } else {
        // POSIX: drives = the user's home + mounted volumes ("/" is deliberately not offered)
        assert.ok(body.drives.some(d => d.path === os.homedir()), 'expected the user home in drives');
      }
      assert.ok(Array.isArray(body.roots));
    });

    await t.test('GET /api/list on the fixture', async () => {
      const { status, body } = await getJson(`/api/list?path=${encodeURIComponent(FIX)}&exts=.md`);
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      const dirNames = body.dirs.map(d => d.name);
      assert.ok(dirNames.includes('notes') && dirNames.includes('code'));
      const fileNames = body.files.map(f => f.name);
      assert.ok(fileNames.includes('zz-magicword-name.md'));
      assert.ok(!fileNames.includes('img.png'), 'exts=.md must filter out the png');
      assert.ok(body.files.every(f => f.ext === '.md'));
    });

    await t.test('search: finds a word inside a nested .md, counts + snippet', async () => {
      const { status, body } = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=magicword`);
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.ok, true);
      assert.equal(body.q, 'magicword');
      assert.equal(body.truncated, false);
      assert.equal(typeof body.ms, 'number');
      // scanned＝實際讀內容的候選文字檔數（副檔名不符、二進位、跳過的目錄都不算）
      assert.ok(body.scanned >= 3, `scanned=${body.scanned}`);
      const byRel = new Map(body.files.map(f => [f.rel, f]));
      const inner = byRel.get(REL('notes/deep/inner.md'));
      assert.ok(inner, 'nested .md must be found; got ' + [...byRel.keys()].join(', '));
      assert.equal(inner.hits, 1);
      assert.ok(inner.snippet.includes('magicword'));
      assert.ok(!inner.snippet.includes('\n'), 'snippet must be single-line');
      assert.ok(byRel.has(REL('code/app.js')), 'code files are searchable');
      assert.equal(byRel.get(REL('code/app.js')).kind, 'code');
      // name match counts as 1 hit, with an empty snippet (no content match)
      const byName = byRel.get('zz-magicword-name.md');
      assert.ok(byName, 'name match counts');
      assert.equal(byName.hits, 1);
      assert.equal(byName.snippet, '');
      // every result carries the /api/list file-info fields plus search extras
      for (const f of body.files) {
        for (const k of ['name', 'path', 'size', 'mtime', 'ext', 'kind', 'hits', 'snippet', 'rel']) {
          assert.ok(k in f, `missing field ${k}`);
        }
      }
      // sorted by mtime desc
      const mtimes = body.files.map(f => f.mtime);
      assert.deepEqual([...mtimes].sort((a, b) => b - a), mtimes);
    });

    await t.test('video: /api/file streams mp4 with kind/accept-ranges', async () => {
      const r = await getRaw(`/api/file?path=${encodeURIComponent(path.join(FIX, 'clip.mp4'))}`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'video/mp4');
      assert.equal(r.headers.get('x-file-kind'), 'video');
      assert.equal(r.headers.get('accept-ranges'), 'bytes');
      assert.equal(r.body.length, 64);
    });

    await t.test('video: Range bytes=0-9 → 206 partial, suffix range, 416 overflow', async () => {
      const r = await getRaw(`/api/file?path=${encodeURIComponent(path.join(FIX, 'clip.mp4'))}`, { Range: 'bytes=0-9' });
      assert.equal(r.status, 206);
      assert.equal(r.headers.get('content-range'), 'bytes 0-9/64');
      assert.equal(r.body.length, 10);
      const tail = await getRaw(`/api/file?path=${encodeURIComponent(path.join(FIX, 'clip.mp4'))}`, { Range: 'bytes=-8' });
      assert.equal(tail.status, 206);
      assert.equal(tail.headers.get('content-range'), 'bytes 56-63/64');
      assert.equal(tail.body.length, 8);
      const bad = await getRaw(`/api/file?path=${encodeURIComponent(path.join(FIX, 'clip.mp4'))}`, { Range: 'bytes=100-200' });
      assert.equal(bad.status, 416);
    });

    await t.test('slides: /api/list marks .pptx as kind slides', async () => {
      const { status, body } = await getJson(`/api/list?path=${encodeURIComponent(FIX)}&exts=.pptx`);
      assert.equal(status, 200);
      const deck = body.files.find(f => f.name === 'deck.pptx');
      assert.ok(deck, 'deck.pptx must be listed');
      assert.equal(deck.kind, 'slides');
    });

    await t.test('slides: /api/file serves .pptx raw bytes with pptx MIME', async () => {
      const r = await getRaw(`/api/file?path=${encodeURIComponent(path.join(FIX, 'deck.pptx'))}`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('x-file-kind'), 'slides');
      assert.equal(r.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      assert.equal(r.body.length, 20);
      assert.equal(r.body.subarray(0, 2).toString('utf8'), 'PK');
    });

    await t.test('slides: over the sheet cap is rejected with 413 (no silent truncation)', async () => {
      const r = await getRaw(`/api/file?path=${encodeURIComponent(path.join(FIX, 'huge.pptx'))}`);
      assert.equal(r.status, 413);
    });

    await t.test('unknown extension still 415', async () => {
      const r = await getRaw(`/api/file?path=${encodeURIComponent(path.join(FIX, 'query.xyz'))}`);
      assert.equal(r.status, 415);
    });

    await t.test('missing file 404s, also under a symlinked dir inside the scope', async (t2) => {
      const r = await getRaw(`/api/file?path=${encodeURIComponent(path.join(FIX, 'ghost.txt'))}`);
      assert.equal(r.status, 404);
      const LINK = path.join(FIX, 'nested-link');
      try { fs.symlinkSync(path.join(FIX, 'notes'), LINK, IS_WIN ? 'junction' : 'dir'); }
      catch (err) { t2.skip(`symlink creation failed: ${err.message}`); return; }
      const via = await getRaw(`/api/file?path=${encodeURIComponent(path.join(LINK, 'ghost.txt'))}`);
      assert.equal(via.status, 404, 'missing file under a symlinked allowed dir must be 404, not 403');
    });

    await t.test('search: case-insensitive', async () => {
      const lo =(await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=magicword`)).body;
      const up = (await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=MAGICWORD`)).body;
      assert.equal(lo.files.length, up.files.length);
      assert.ok(up.files.length > 0);
    });

    await t.test('search: skips node_modules and dot-dirs, ignores binaries', async () => {
      const { body } = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=magicword`);
      const rels = body.files.map(f => f.rel);
      assert.ok(!rels.some(r => r.split(path.sep).includes('node_modules')));
      assert.ok(!rels.some(r => r.split(path.sep).includes('.hidden')));
      assert.ok(!rels.some(r => r === 'img.png'));
    });

    await t.test('search: respects the exts filter like /api/list', async () => {
      const md = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=magicword&exts=.md`);
      assert.equal(md.status, 200);
      assert.ok(md.body.files.length > 0);
      assert.ok(md.body.files.every(f => f.ext === '.md'));
      const js = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=magicword&exts=.js`);
      assert.equal(js.status, 200);
      assert.deepEqual(js.body.files.map(f => f.rel), [REL('code/app.js')]);
    });

    await t.test('search: 400 on empty q', async () => {
      const a = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=`);
      assert.equal(a.status, 400);
      const b = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=${encodeURIComponent('   ')}`);
      assert.equal(b.status, 400);
      const c = await getJson(`/api/search?path=${encodeURIComponent(FIX)}`);
      assert.equal(c.status, 400);
    });

    await t.test('search: limit caps the files array', async () => {
      const { body } = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=magicword&limit=1`);
      assert.equal(body.files.length, 1);
    });

    await t.test('Host guard still active on the bound port (421 for non-loopback Host)', async () => {
      const status = await new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/drives', headers: { Host: `evil.example:${PORT}` } },
          res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
      });
      assert.equal(status, 421);
    });
  } finally {
    teardown();
  }
});

// ---------- outside-scope 403 (cross-platform since the POSIX drives list shrank
// from "/" to home + mounts: /no/such/… is out of scope everywhere) ----------
test('search: 403 outside allowed scopes', async () => {
  const proc = await startServer();
  procs.push(proc);
  try {
    let outside = null;
    if (IS_WIN) {
      // pick a drive letter that does not exist
      for (let i = 90; i >= 68 && !outside; i--) { // Z..D
        const letter = String.fromCharCode(i);
        if (!fs.existsSync(letter + ':\\')) outside = letter + ':\\riffle-no-such-root-9x';
      }
    } else {
      outside = '/no/such/riffle-root-9x';
    }
    assert.ok(outside, 'expected an out-of-scope path for this platform');
    const { status, body } = await getJson(`/api/search?path=${encodeURIComponent(outside)}&q=magicword`);
    assert.equal(status, 403, JSON.stringify(body));
  } finally {
    proc.kill();
  }
});

if (IS_WIN) {
  test('list: case-folded path still resolves (win32 folding rule)', async () => {
    const proc = await startServer();
    procs.push(proc);
    try {
      // try the fixture path with opposite case: must resolve on Windows
      const folded = FIX.split('').map(c => c >= 'a' && c <= 'z' ? c.toUpperCase() : c).join('');
      const { status, body } = await getJson(`/api/list?path=${encodeURIComponent(folded)}&exts=.md`);
      assert.equal(status, 200, JSON.stringify(body));
    } finally {
      proc.kill();
    }
  });
} else {
  test('list: case-mangled path resolves iff the fixture filesystem is case-insensitive', async () => {
    const proc = await startServer();
    procs.push(proc);
    try {
      // mangle only the LEAF ('CaseDir' → 'CASEDIR') so the path stays inside the
      // fixture scope regardless of the platform's drives; the filesystem decides
      const mangled = path.join(FIX, 'CASEDIR');
      const { status } = await getJson(`/api/list?path=${encodeURIComponent(mangled)}&exts=.md`);
      // case-sensitive FS (most Linux): only the exact-case path resolves → 404;
      // case-insensitive FS (macOS default APFS): 'CASEDIR' opens 'CaseDir' → 200
      assert.equal(status, FIXTURE_CI ? 200 : 404, `fixture case-insensitive=${FIXTURE_CI}`);
    } finally {
      proc.kill();
    }
  });
}
