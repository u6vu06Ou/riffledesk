// tests/indexer-tune.test.mjs — index cadence, watch fallback, and search
// freshness while a crawl runs. One server on port 5198 (5197 is demo.test.mjs,
// which runs concurrently). The second fixture
// root is marked "unwatchable" through the test-only RIFFLEDESK_WATCH_FAIL_FOR
// worker hook (a portable stand-in for network drives / unsupported FS where
// fs.watch cannot be armed at all).
// Usage: node --test tests/indexer-tune.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveRecrawlMs, resolveBootStaleMs } = require('../indexer.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5198;
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- pure helpers ----------
test('recrawl cadence resolution (pure)', () => {
  assert.equal(resolveRecrawlMs({}, null), 24 * 3600000, 'default is 24 h');
  assert.equal(resolveRecrawlMs({}, { recrawlHours: 2 }), 2 * 3600000, 'config hours honored');
  assert.equal(resolveRecrawlMs({ RIFFLEDESK_RECRAWL_MS: '5000' }, { recrawlHours: 2 }), 5000, 'env override wins');
  assert.equal(resolveRecrawlMs({ RIFFLEDESK_RECRAWL_MS: '0' }, { recrawlHours: 3 }), 3 * 3600000, 'env 0 falls back to config');
  assert.equal(resolveRecrawlMs({}, { recrawlHours: -5 }), 24 * 3600000, 'invalid config falls back to 24 h');
  assert.equal(resolveBootStaleMs({}, { recrawlHours: 4 }), 4 * 3600000, 'boot staleness follows the cadence');
  assert.equal(resolveBootStaleMs({ RIFFLEDESK_BOOT_STALE_MS: '1234' }, { recrawlHours: 4 }), 1234, 'boot env override wins');
});

// ---------- fixture + server ----------
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-tune-test-'));
const FIX = path.join(TMP, 'fixture');
const BROKE = path.join(TMP, 'unwatchable-root'); // exists, but its watcher "cannot be armed"
fs.mkdirSync(path.join(FIX, 'notes'), { recursive: true });
fs.writeFileSync(path.join(FIX, 'notes', 'base.md'), 'baseline token stays here\n');
// heavy subdir: 40 x ~48 KB text → the BOOT crawl does 40 full-cap content
// inserts (~seconds even with pacing off), a reliable window where
// crawling === true; later recrawls see unchanged rows and finish in ms.
fs.mkdirSync(path.join(FIX, 'heavy'), { recursive: true });
for (let i = 0; i < 40; i++) {
  let s = `heavydoc number ${i}\n`;
  while (s.length < 48000) s += 'padding content for the index row zzzq ';
  fs.writeFileSync(path.join(FIX, 'heavy', `h${i}.txt`), s);
}
fs.mkdirSync(BROKE, { recursive: true });
fs.writeFileSync(path.join(BROKE, 'appeared.md'), 'the qzappeared token lives here\n');

const CONFIG_PATH = path.join(TMP, 'config.json');
fs.writeFileSync(CONFIG_PATH, JSON.stringify({ roots: [FIX, BROKE], pinned: [] }, null, 2));
const EMPTY_HOME = path.join(TMP, 'empty-home');
fs.mkdirSync(EMPTY_HOME, { recursive: true });
const DRIVES = [TMP, process.env.RIFFLEDESK_TEST_DRIVES].filter(Boolean).join(path.delimiter);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(p) {
  const res = await fetch(BASE + p);
  return { status: res.status, body: await res.json() };
}

const proc = spawn('node', ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env, NODE_ENV: 'test', RIFFLEDESK_TEST_DRIVES: DRIVES,
    PORT: String(PORT), FLODER_CONFIG: CONFIG_PATH, RIFFLEDESK_AGENT_HOME: EMPTY_HOME,
    RIFFLEDESK_RECRAWL_MS: '5000',           // crawls recur but leave idle gaps (a crawl is seconds only at boot)
    RIFFLEDESK_UNWATCH_RESCAN_MS: '300',     // fast unwatchable-root fallback for the test
    RIFFLEDESK_WATCH_FAIL_FOR: 'unwatchable-root', // simulate fs.watch arm failure for BROKE (worker hook)
    RIFFLEDESK_CRAWL_PACE: '0'               // pacing is exercised by tests/cpu-budget.mjs, not here
  },
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

async function waitCrawled(maxMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    const { body } = await getJson('/api/index/status');
    if (body.ok && body.available && body.lastCrawlAt && !body.crawling && body.files > 0) return body;
    if (Date.now() - t0 > maxMs) throw new Error('index never finished crawling: ' + JSON.stringify(body));
    await sleep(150);
  }
}

after(async () => {
  try { proc.kill(); } catch (_) {}
  await Promise.race([new Promise(r => proc.once('exit', r)), sleep(3000)]);
  await sleep(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

async function searchFix(q) {
  return (await getJson('/api/search?path=' + encodeURIComponent(FIX) + '&q=' + q + '&limit=10')).body;
}

async function searchIn(dir, q) {
  return (await getJson('/api/search?path=' + encodeURIComponent(dir) + '&q=' + q + '&limit=10')).body;
}

test('index tune suite', async (t) => {
  await waitListening();

  await t.test('a file written mid-crawl / inside the watch debounce is found immediately', async () => {
    // Backstop for prod timing: the watch flush lands 1.5 s after a write, and
    // is deferred entirely while a crawl runs — before the freshness pass, a
    // search in that window missed the file. Each attempt writes a NEW token
    // and searches while the file is <1.2 s old, so an indexed hit can only
    // come from the fresh pass (or a crawler walk that genuinely already
    // passed over the new file — equally correct).
    const searchWritten = async () => {
      const token = 'zzfresh' + Math.random().toString(36).slice(2, 10);
      const wroteAt = Date.now();
      fs.writeFileSync(path.join(FIX, 'notes', token + '.md'), 'the ' + token + ' marker lives here\n');
      await sleep(300); // give the fs.watch event time to land — still < 1.5 s debounce
      const r = await searchFix(token);
      return { token, r, ageMs: Date.now() - wroteAt };
    };
    let win = null;
    // phase 1: try to catch the (long) boot crawl with crawling === true
    const crawlDeadline = Date.now() + 8000;
    let sawCrawling = false;
    while (!win && Date.now() < crawlDeadline) {
      const st = (await getJson('/api/index/status')).body;
      if (st.crawling) {
        sawCrawling = true;
        const a = await searchWritten();
        if (a.ageMs < 1200 && a.r.indexed === true && a.r.files.some(f => f.name.includes(a.token))) win = a;
      } else if (st.lastCrawlAt) break; // boot crawl over — phase 2
      await sleep(80);
    }
    // phase 2 (flake safety if the boot crawl was missed): between crawls, the
    // pending watcher dir alone must trigger the fresh pass
    for (let i = 0; !win && i < 8; i++) {
      const a = await searchWritten();
      if (a.ageMs < 1200 && a.r.indexed === true && a.r.files.some(f => f.name.includes(a.token))) { win = a; break; }
      await sleep(300);
    }
    assert.ok(win, `fresh file never found (sawCrawling=${sawCrawling})`);
    assert.equal(win.r.indexed, true);
  });

  await t.test('a brand-new dir (no DB row) written mid-crawl is found from the real filesystem', async () => {
    // The searched folder itself has never been indexed, so no dirs row, no
    // pending watcher dir and no candidate rows exist — only a live walk from
    // the searched path can answer. Token is unique per attempt and the search
    // runs while the file is fresh, so a hit can only come from the fresh pass
    // (or a crawler walk that already passed it — equally correct).
    const attempt = async () => {
      const token = 'zznewdir' + Math.random().toString(36).slice(2, 10);
      const dir = path.join(FIX, 'brandnew-' + token);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.md'), 'the ' + token + ' marker lives here\n');
      await sleep(250); // let the watch event land
      const r = await searchIn(dir, token);
      return { token, dir, r };
    };
    let win = null;
    const crawlDeadline = Date.now() + 8000;
    while (!win && Date.now() < crawlDeadline) {
      const st = (await getJson('/api/index/status')).body;
      if (st.crawling) {
        const a = await attempt();
        if (a.r.indexed === true && a.r.files.some(f => f.name === 'a.md')) win = a;
      } else if (st.lastCrawlAt) break;
      await sleep(80);
    }
    // idle safety net: between crawls the same must hold with the watcher pending
    for (let i = 0; !win && i < 6; i++) {
      const a = await attempt();
      if (a.r.indexed === true && a.r.files.some(f => f.name === 'a.md')) { win = a; break; }
      await sleep(300);
    }
    assert.ok(win, 'brand-new dir never became searchable');
    assert.equal(win.r.indexed, true);
    assert.ok(win.r.files[0].snippet.includes(win.token), 'snippet must come from the file body');
  });

  await t.test('nested brand-new dirs (new/a/b/file.md) are found while idle and while crawling', async () => {
    const attempt = async () => {
      const token = 'zznest' + Math.random().toString(36).slice(2, 10);
      const top = path.join(FIX, 'nest-' + token);
      const deep = path.join(top, 'a', 'b');
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(deep, 'deep.md'), 'nested ' + token + ' marker\n');
      await sleep(250);
      const r = await searchIn(top, token);
      return { token, top, r };
    };
    let win = null;
    const crawlDeadline = Date.now() + 8000;
    while (!win && Date.now() < crawlDeadline) {
      const st = (await getJson('/api/index/status')).body;
      if (st.crawling) {
        const a = await attempt();
        if (a.r.indexed === true && a.r.files.some(f => f.name === 'deep.md')) win = a;
      } else if (st.lastCrawlAt) break;
      await sleep(80);
    }
    for (let i = 0; !win && i < 6; i++) {
      const a = await attempt();
      if (a.r.indexed === true && a.r.files.some(f => f.name === 'deep.md')) { win = a; break; }
      await sleep(300);
    }
    assert.ok(win, 'nested brand-new dirs never became searchable');
    assert.equal(win.r.files[0].rel, path.join('a', 'b', 'deep.md'));
  });

  await t.test('unwatchable root: logged, and the periodic rescan keeps it current without a watcher', async () => {
    assert.ok(serverOut.includes('watch unavailable'), 'missing watch-unavailable log line\n' + serverOut.slice(-800));
    assert.ok(serverOut.includes('min instead'), 'missing fallback wording in the log');
    // BROKE never gets a live watcher; its 300 ms rescan is a full paced crawl
    // of the root, so appeared.md must become indexed-searchable shortly
    const t0 = Date.now();
    let hit = null;
    while (Date.now() - t0 < 20000) {
      const r = (await getJson('/api/search?path=' + encodeURIComponent(BROKE) + '&q=qzappeared&limit=10')).body;
      if (r.indexed === true && r.files.some(f => f.name === 'appeared.md')) { hit = r; break; }
      await sleep(400);
    }
    assert.ok(hit, 'unwatchable root never became searchable from the index');
  });

  await t.test('full recrawl repeats on the (test-shortened) interval', async () => {
    const status1 = await waitCrawled();
    assert.ok(status1.files >= 43, `files=${status1.files}`);
    const before = (serverOut.match(/crawl done/g) || []).length;
    await sleep(9000); // one+ recrawl of RIFFLEDESK_RECRAWL_MS=5000 must land in this window
    const afterN = (serverOut.match(/crawl done/g) || []).length;
    assert.ok(afterN - before >= 1, `expected a periodic recrawl, got ${afterN - before} in 9 s`);
  });

  await t.test('server log sanity', () => {
    assert.ok(!/worker job error/i.test(serverOut), 'unexpected worker error in log');
  });
});
