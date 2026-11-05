// tests/indexer.test.mjs — the persistent full-text index (node:sqlite FTS5 trigram).
// Spawns server.js on port 5180 against a temp fixture dir (index.db lives next to the
// temp config, never in the repo). Usage: node --test tests/indexer.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5180;
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- temp fixture ----------
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-idx-test-'));
const FIX = path.join(TMP, 'fixture');
const OUT = path.join(TMP, 'outside'); // outside the indexed roots on purpose
const mkdir = (...p) => fs.mkdirSync(path.join(FIX, ...p), { recursive: true });
const write = (rel, text) => fs.writeFileSync(path.join(FIX, ...rel.split('/')), text);

mkdir('notes');
write('notes/keep.md', 'the blorp token lives here and stays\n');
write('notes/lose.md', 'the zqxunique token will be deleted soon\n');
write('notes/quote.md', 'he said "quoted words" out loud\n');
write('short.txt', 'ab cd ab\n');
write('ab-name.txt', 'no marker token in this content at all\n');
// >64 KB: only the first 64 KB are indexed — a head token is found, a tail token is not
write('big.txt', 'captokxx in the head\n' + 'z'.repeat(300000) + '\nbigwordtail marker lives in the tail\n');
// generated/data dirs are not indexed (default indexSkipDirs)
mkdir('data');
write('data/secretfile.txt', 'skipmeword must not be indexed\n');
mkdir('logs');
write('logs/app.log', 'logtokenword must not be indexed\n');
mkdir('pix', 'nested');
write('pix/readme.md', 'just words\n');
fs.writeFileSync(path.join(FIX, 'pix', 'nested', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
mkdir('nopix');
write('nopix/note.md', 'plain note without pictures\n');

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'out-note.md'), 'the outsideword only exists out here\n');

const CONFIG_PATH = path.join(TMP, 'config.json');
fs.writeFileSync(CONFIG_PATH, JSON.stringify({ roots: [FIX], pinned: [] }, null, 2));

// Browse scope vs. index scope: on POSIX the allowed scope is home + mounted
// volumes, and os.tmpdir() (macOS /var/folders/…) is NOT part of it, whereas on
// Windows the temp dir sits on an allowed drive. So the servers below declare
// TMP as a "drive" through the test-only RIFFLEDESK_TEST_DRIVES hook (see
// collectDrives in server.js). TMP is then browsable but is still NOT an
// indexed root — which is exactly what the deepCount/outside-scope tests need.
// An outer RIFFLEDESK_TEST_DRIVES value is appended, so a run can still force
// the narrow POSIX scope on a Windows box (the temp dir alone is the only
// "drive" here; the rest of C: stays out).
const DRIVES = [TMP, process.env.RIFFLEDESK_TEST_DRIVES].filter(Boolean).join(path.delimiter);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const REL = p => p.split('/').join(path.sep);

async function getJson(p) {
  const res = await fetch(BASE + p);
  const body = await res.json();
  return { status: res.status, body };
}

const proc = spawn('node', ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: 'test', RIFFLEDESK_TEST_DRIVES: DRIVES, PORT: String(PORT), FLODER_CONFIG: CONFIG_PATH },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
let serverOut = '';
proc.stdout.on('data', d => { serverOut += d; });
proc.stderr.on('data', d => { serverOut += d; });

async function waitListening() {
  const t0 = Date.now();
  while (!serverOut.includes('listening')) {
    if (proc.exitCode !== null) throw new Error('server exited early: ' + serverOut);
    if (Date.now() - t0 > 10000) throw new Error('server start timeout: ' + serverOut);
    await sleep(25);
  }
}

async function waitCrawled(maxMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const { body } = await getJson('/api/index/status');
    if (body.ok && body.available && body.lastCrawlAt && !body.crawling && body.files > 0) return body;
    if (Date.now() - t0 > maxMs) throw new Error('index never finished crawling: ' + JSON.stringify(body) + ' / log: ' + serverOut);
    await sleep(100);
  }
}

after(async () => {
  try { proc.kill(); } catch (_) {}
  await Promise.race([new Promise(r => proc.once('exit', r)), sleep(3000)]);
  await sleep(200); // let the OS release index.db (Windows file locks)
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// all tests share one server; run them in order inside a single parent test
test('index suite', async (t) => {
  await waitListening();
  const status0 = await waitCrawled();

  await t.test('status endpoint shape after the first crawl', () => {
    assert.equal(status0.ok, true);
    assert.equal(status0.available, true);
    assert.ok(status0.files >= 5, `files=${status0.files}`);
    assert.ok(Array.isArray(status0.roots));
    assert.ok(status0.roots.map(r => path.resolve(r)).includes(FIX));
    assert.equal(typeof status0.crawling, 'boolean');
    assert.equal(typeof status0.lastCrawlMs, 'number');
    assert.equal(typeof status0.lastCrawlAt, 'number');
  });

  await t.test('search (3+ chars) is answered from the index', async () => {
    const { status, body } = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=blorp`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.indexed, true);
    assert.equal(body.truncated, false);
    const byRel = new Map(body.files.map(f => [f.rel, f]));
    const keep = byRel.get(REL('notes/keep.md'));
    assert.ok(keep, 'notes/keep.md must match; got ' + [...byRel.keys()].join(', '));
    assert.equal(keep.hits, 1);
    assert.ok(keep.snippet.includes('blorp'));
    assert.ok(!keep.snippet.includes('\n'));
    for (const k of ['name', 'path', 'size', 'mtime', 'ext', 'kind', 'hits', 'snippet', 'rel']) {
      assert.ok(k in keep, `missing field ${k}`);
    }
  });

  await t.test('search: case-insensitive from the index', async () => {
    const { body } = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=BLORP`);
    assert.equal(body.indexed, true);
    assert.ok(body.files.some(f => f.rel === REL('notes/keep.md')));
  });

  await t.test('search: 1–2 char queries are name-only (contentless index has no LIKE)', async () => {
    const two = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=ab`);
    assert.equal(two.status, 200, JSON.stringify(two.body));
    assert.equal(two.body.indexed, true);
    assert.ok(!two.body.files.some(f => f.rel === 'short.txt'), '2-char content match must NOT fire (trigram needs 3+, no stored text for LIKE)');
    assert.ok(two.body.files.some(f => f.rel === 'ab-name.txt'), '2-char name match still works');
    const one = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=ke`);
    assert.equal(one.body.indexed, true);
    assert.ok(one.body.files.some(f => f.rel === REL('notes/keep.md')), 'name match for q=ke');
  });

  await t.test('search: only the first 64 KB of a large file is indexed', async () => {
    const head = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=captokxx`);
    assert.equal(head.status, 200, JSON.stringify(head.body));
    assert.equal(head.body.indexed, true);
    const hits = head.body.files.filter(f => f.rel === 'big.txt');
    assert.equal(hits.length, 1, 'the head token of a >64 KB file is found');
    assert.ok(hits[0].snippet.includes('captokxx'));
    const tail = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=bigwordtail`);
    assert.equal(tail.body.indexed, true);
    assert.ok(!tail.body.files.some(f => f.rel === 'big.txt'), 'content past 64 KB is not indexed');
  });

  await t.test('crawl: generated/data dirs are not indexed', async () => {
    for (const q of ['skipmeword', 'logtokenword']) {
      const { body } = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=${q}`);
      assert.equal(body.indexed, true);
      assert.ok(!body.files.some(f => f.rel.startsWith('data' + path.sep) || f.rel.startsWith('logs' + path.sep)),
        `q=${q} must not hit ${q === 'skipmeword' ? 'data/' : 'logs/'}; got ` + JSON.stringify(body.files.map(f => f.rel)));
    }
    // metadata count also excludes those dirs: fixture = 10 files - 2 skipped
    const st = (await getJson('/api/index/status')).body;
    assert.ok(st.files <= 12, `files=${st.files}`);
  });

  await t.test('search: a q containing a double quote does not break FTS', async () => {
    const q = 'said "quoted';
    const { status, body } = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=${encodeURIComponent(q)}`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.indexed, true);
    assert.ok(body.files.some(f => f.rel === REL('notes/quote.md')), JSON.stringify(body.files.map(f => f.rel)));
  });

  await t.test('search: file edited after indexing — match removed → not found; match kept → found', async () => {
    // lose the match entirely (different length so the size guard fires)
    fs.writeFileSync(path.join(FIX, 'notes', 'lose.md'), 'this note is now boring and says nothing special at all\n');
    const gone = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=zqxunique`);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(gone.body.indexed, true);
    assert.ok(!gone.body.files.some(f => f.rel === REL('notes/lose.md')), 'edited file must not come back');

    // keep the match but change the file (size changes → stat guard re-reads)
    fs.writeFileSync(path.join(FIX, 'notes', 'keep.md'), 'the blorp token lives here and stays — longer tail added\n');
    const kept = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=blorp`);
    assert.ok(kept.body.files.some(f => f.rel === REL('notes/keep.md')), 'edited file with the match intact must be found');
    const rec = kept.body.files.find(f => f.rel === REL('notes/keep.md'));
    assert.equal(rec.hits, 1);
    assert.ok(rec.snippet.includes('longer tail') || rec.snippet.includes('blorp'));
  });

  await t.test('/api/list deepCount: recursive per-subdir counts from the index', async () => {
    const { status, body } = await getJson(`/api/list?path=${encodeURIComponent(FIX)}&exts=.png`);
    assert.equal(status, 200, JSON.stringify(body));
    const byName = new Map(body.dirs.map(d => [d.name, d]));
    assert.equal(byName.get('pix').deepCount, 1, 'pix has 0 direct .png but a nested one');
    assert.equal(byName.get('nopix').deepCount, 0, 'nopix has no .png anywhere');
    assert.equal(byName.get('notes').deepCount, 0);
    // a never-indexed subtree reports null: TMP holds both FIX (crawled) and OUT (not yet)
    const { body: tmpList } = await getJson(`/api/list?path=${encodeURIComponent(TMP)}&exts=.png&nofiles=1`);
    assert.equal(tmpList.ok, true, JSON.stringify(tmpList).slice(0, 300));
    const tmpByName = new Map(tmpList.dirs.map(d => [d.name, d]));
    assert.equal(tmpByName.get('fixture').deepCount, 1, 'the covered subtree still gets a real count');
    assert.equal(tmpByName.get('outside').deepCount, null, 'not yet crawled → null');
  });

  await t.test('search outside the indexed scope: live scan first, indexed next time', async () => {
    const first = await getJson(`/api/search?path=${encodeURIComponent(OUT)}&q=outsideword`);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.indexed, false, 'first search on an unknown root is a live scan');
    assert.ok(first.body.files.some(f => f.rel === 'out-note.md'));

    // the path gets remembered and crawled in the background; poll until indexed
    const t0 = Date.now();
    let body = null;
    while (Date.now() - t0 < 20000) {
      await sleep(150);
      body = (await getJson(`/api/search?path=${encodeURIComponent(OUT)}&q=outsideword`)).body;
      if (body.indexed === true) break;
    }
    assert.equal(body.indexed, true, 'second search should come from the index');
    assert.ok(body.files.some(f => f.rel === 'out-note.md'));
    const st = (await getJson('/api/index/status')).body;
    assert.ok(st.roots.map(r => path.resolve(r)).includes(path.resolve(OUT)), 'extra root remembered in status');
  });

  await t.test('/api/list-triggered reindex picks up a new match in that dir', async () => {
    // a brand-new content match that the index cannot know about yet
    fs.writeFileSync(path.join(FIX, 'nopix', 'fresh.md'), 'freshword appears for the first time\n');
    await getJson(`/api/list?path=${encodeURIComponent(path.join(FIX, 'nopix'))}&exts=.md`); // triggers background reindex of that dir
    const t0 = Date.now();
    let found = false;
    while (Date.now() - t0 < 10000) {
      await sleep(150);
      const { body } = await getJson(`/api/search?path=${encodeURIComponent(FIX)}&q=freshword`);
      if (body.indexed && body.files.some(f => f.rel === REL('nopix/fresh.md'))) { found = true; break; }
    }
    assert.ok(found, 'the /api/list reindex should make the new match searchable');
  });
});

// the DB size budget: indexMaxMB <= 0 forces the cap immediately, so only
// metadata is indexed and status reports capped
test('index size cap: metadata-only once indexMaxMB is exceeded', async (t) => {
  const TMP2 = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-idx-cap-'));
  const FIX2 = path.join(TMP2, 'fixture');
  fs.mkdirSync(FIX2, { recursive: true });
  fs.writeFileSync(path.join(FIX2, 'cappedname.md'), 'capcontentword lives inside here\n');
  const CONFIG2 = path.join(TMP2, 'config.json');
  fs.writeFileSync(CONFIG2, JSON.stringify({ roots: [FIX2], pinned: [], indexMaxMB: 0 }, null, 2));
  const PORT2 = 5185;
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  const proc2 = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT2), FLODER_CONFIG: CONFIG2 },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let out2 = '';
  proc2.stdout.on('data', d => { out2 += d; });
  proc2.stderr.on('data', d => { out2 += d; });
  try {
    const t0 = Date.now();
    while (!out2.includes('listening')) {
      if (proc2.exitCode !== null) throw new Error('cap server exited early: ' + out2);
      if (Date.now() - t0 > 10000) throw new Error('cap server start timeout: ' + out2);
      await sleep(25);
    }
    let st = null;
    const t1 = Date.now();
    for (;;) {
      st = (await (await fetch(BASE2 + '/api/index/status')).json());
      if (st.ok && st.available && st.lastCrawlAt && !st.crawling && st.files > 0) break;
      if (Date.now() - t1 > 30000) throw new Error('cap crawl never finished: ' + JSON.stringify(st));
      await sleep(100);
    }
    assert.equal(st.capped, true, 'status.capped must be true once the cap fires');
    assert.equal(st.files >= 1, true);
    assert.equal(st.filesWithContent, 0, 'no content rows under the cap');
    const enc = encodeURIComponent(FIX2);
    const byName = await (await fetch(`${BASE2}/api/search?path=${enc}&q=cappedname`)).json();
    assert.equal(byName.indexed, true);
    assert.ok(byName.files.some(f => f.rel === 'cappedname.md'), 'name search works under the cap');
    const byContent = await (await fetch(`${BASE2}/api/search?path=${enc}&q=capcontentword`)).json();
    assert.equal(byContent.indexed, true);
    assert.ok(!byContent.files.some(f => f.rel === 'cappedname.md'), 'content not indexed under the cap');
  } finally {
    try { proc2.kill(); } catch (_) {}
    await Promise.race([new Promise(r => proc2.once('exit', r)), sleep(3000)]);
    await sleep(200);
    try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch (_) {}
  }
});

// two-layer index: config indexContent / POST /api/index/content toggles the
// content (FTS) layer; the metadata layer (names, deepCount) stays on either way
test('index content layer toggle: off → live scan; on → indexed again', async () => {
  const TMP3 = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-idx-toggle-'));
  const FIX3 = path.join(TMP3, 'fixture');
  fs.mkdirSync(FIX3, { recursive: true });
  fs.writeFileSync(path.join(FIX3, 'togglename.md'), 'togglemarkword lives in this body\n');
  const CONFIG3 = path.join(TMP3, 'config.json');
  fs.writeFileSync(CONFIG3, JSON.stringify({ roots: [FIX3], pinned: [], indexContent: false }, null, 2));
  const PORT3 = 5188;
  const BASE3 = `http://127.0.0.1:${PORT3}`;
  const proc3 = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT3), FLODER_CONFIG: CONFIG3 },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let out3 = '';
  proc3.stdout.on('data', d => { out3 += d; });
  proc3.stderr.on('data', d => { out3 += d; });
  const post = (body, headers) => fetch(BASE3 + '/api/index/content', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE3, ...(headers || {}) },
    body: JSON.stringify(body)
  });
  const search = async (q) => (await (await fetch(`${BASE3}/api/search?path=${encodeURIComponent(FIX3)}&q=${q}`)).json());
  const waitCrawl = async (ok, label) => {
    const t0 = Date.now();
    for (;;) {
      const st = (await (await fetch(BASE3 + '/api/index/status')).json());
      if (st.ok && st.available && st.lastCrawlAt && !st.crawling && st.files > 0 && ok(st)) return st;
      if (Date.now() - t0 > 30000) throw new Error(label + ' timeout: ' + JSON.stringify(st) + '\n' + out3);
      await sleep(100);
    }
  };
  try {
    const t0 = Date.now();
    while (!out3.includes('listening')) {
      if (proc3.exitCode !== null) throw new Error('toggle server exited early: ' + out3);
      if (Date.now() - t0 > 10000) throw new Error('toggle server start timeout: ' + out3);
      await sleep(25);
    }
    // off from boot: metadata crawls, but content search is the live scan
    let st = await waitCrawl(s => s.contentEnabled === false, 'initial metadata-only crawl');
    assert.equal(st.files >= 1, true);
    let r = await search('togglemarkword');
    assert.equal(r.indexed, false, 'content off → live scan fallback');
    assert.ok(r.files.some(f => f.rel === 'togglename.md'), 'live scan still finds the content hit');
    // write guards: same rules as the other POSTs
    let bad = await fetch(BASE3 + '/api/index/content', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"on":true}' });
    assert.equal(bad.status, 403, 'missing Origin refused');
    bad = await fetch(BASE3 + '/api/index/content', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{"on":true}' });
    assert.equal(bad.status, 403, 'foreign Origin refused');
    bad = await fetch(BASE3 + '/api/index/content', { method: 'POST', headers: { 'content-type': 'text/plain', origin: BASE3 }, body: '{"on":true}' });
    assert.equal(bad.status, 415, 'non-JSON content-type refused');
    // on: content attaches on the next crawl pass
    const before = st.lastCrawlAt;
    let res = await (await post({ on: true })).json();
    assert.equal(res.ok, true); assert.equal(res.contentEnabled, true);
    st = await waitCrawl(s => s.contentEnabled === true && s.lastCrawlAt !== before && s.filesWithContent > 0, 're-crawl after enabling content');
    r = await search('togglemarkword');
    assert.equal(r.indexed, true, 'content on → indexed search');
    assert.ok(r.files.some(f => f.rel === 'togglename.md'));
    const persisted = JSON.parse(fs.readFileSync(CONFIG3, 'utf8'));
    assert.equal(persisted.indexContent, true, 'toggle persisted to config.json');
    // off again: the FTS tables are really dropped, search is live again
    res = await (await post({ on: false })).json();
    assert.equal(res.ok, true); assert.equal(res.contentEnabled, false);
    await waitCrawl(s => s.contentEnabled === false, 'status after disabling content');
    r = await search('togglemarkword');
    assert.equal(r.indexed, false, 'content off again → live scan');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(TMP3, 'index.db'), { readOnly: true });
    const tab = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('content_fts', 'ftsmap')").all();
    db.close();
    assert.deepEqual(tab, [], 'content tables dropped (and DB vacuumed)');
  } finally {
    try { proc3.kill(); } catch (_) {}
    await Promise.race([new Promise(r2 => proc3.once('exit', r2)), sleep(3000)]);
    await sleep(200);
    try { fs.rmSync(TMP3, { recursive: true, force: true }); } catch (_) {}
  }
});
