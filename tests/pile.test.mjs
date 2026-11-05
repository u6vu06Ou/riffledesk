// tests/pile.test.mjs — POST /api/pile, GET /api/pile, GET /api/piles.
// In-process (imports server.js so the SSE hub can be observed directly). Port 5190.
// Covers the write guards, path filtering, the 500 cap, the 20-pile retention and the
// broadcast, plus the on-disk copy beside config.json.
// Usage: node --test tests/pile.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5190;

const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-pile-'));
const FIX = path.join(TMP, 'fixture');
fs.mkdirSync(FIX, { recursive: true });
const A = path.join(FIX, 'a.md');
const B = path.join(FIX, 'b.md');
const C = path.join(FIX, 'c.md');
for (const f of [A, B, C]) fs.writeFileSync(f, '# ' + path.basename(f) + '\n');
const CONFIG_PATH = path.join(TMP, 'config.json');
fs.writeFileSync(CONFIG_PATH, JSON.stringify({ roots: [FIX], pinned: [], convoRoots: [] }, null, 2));

process.env.FLODER_CONFIG = CONFIG_PATH;
process.env.RIFFLEDESK_INDEX = 'off';
const srv = (await import(pathToFileURL(path.join(ROOT, 'server.js')).href)).default;
const server = srv.start(PORT);
await new Promise((res, rej) => { server.once('listening', res); server.once('error', rej); });

after(() => {
  try { server.closeAllConnections && server.closeAllConnections(); } catch (_) {}
  server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------- helpers
function post(body, headers = { 'X-RiffleDesk-CLI': '1' }, raw = null) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(raw === null ? JSON.stringify(body) : raw);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/pile', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length, ...headers }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
  });
}

function openEvents() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/events' }, res => {
      if (res.statusCode !== 200) { reject(new Error('http ' + res.statusCode)); return; }
      const st = { req, events: [], waiters: [], buf: '' };
      res.on('data', c => {
        st.buf += c.toString('utf8');
        let i;
        while ((i = st.buf.indexOf('\n\n')) !== -1) {
          const chunk = st.buf.slice(0, i); st.buf = st.buf.slice(i + 2);
          const m = /event: (\w+)\ndata: (.+)/s.exec(chunk);
          if (!m) continue;
          let data = null;
          try { data = JSON.parse(m[2]); } catch (_) {}
          st.events.push({ type: m[1], data });
          for (const w of st.waiters.splice(0)) w();
        }
      });
      resolve(st);
    });
    req.on('error', reject);
  });
}
async function waitEvent(st, type, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const idx = st.events.findIndex(e => e.type === type);
    if (idx >= 0) return st.events.splice(idx, 1)[0];
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for '${type}'`);
    await new Promise(r => { st.waiters.push(r); setTimeout(r, 60); });
  }
}
const closeEvents = st => { try { st.req.destroy(); } catch (_) {} };

// ---------------------------------------------------------------- guards
test('GET /api/pile without id → 400, unknown id → 404', async () => {
  assert.equal((await get('/api/pile')).status, 400);
  const miss = await get('/api/pile?id=nope');
  assert.equal(miss.status, 404);
  assert.equal(miss.body.ok, false);
});

test('no Origin and no CLI header → 403', async () => {
  const r = await post({ paths: [A] }, {});
  assert.equal(r.status, 403);
  assert.equal(r.body.ok, false);
});

test('a cross-origin browser POST is refused', async () => {
  const r = await post({ paths: [A] }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('same-origin browser Origin is accepted', async () => {
  const r = await post({ paths: [A] }, { origin: `http://127.0.0.1:${PORT}` });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('non-JSON content type → 415, bad JSON → 400, missing paths → 400', async () => {
  const notJson = await post(null, { 'X-RiffleDesk-CLI': '1', 'content-type': 'text/plain' }, 'x');
  assert.equal(notJson.status, 415);
  const bad = await post(null, { 'X-RiffleDesk-CLI': '1' }, '{oops');
  assert.equal(bad.status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ paths: [] })).status, 400);
  assert.equal((await post({ paths: 'a.md' })).status, 400);
});

// ---------------------------------------------------------------- content
test('a valid pile comes back with an id and count, and is readable again', async () => {
  const r = await post({ paths: [A, B], title: 'Two notes' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.count, 2);
  assert.match(r.body.id, /^[0-9a-f]{18}$/);

  const got = await get('/api/pile?id=' + r.body.id);
  assert.equal(got.status, 200);
  assert.equal(got.body.title, 'Two notes');
  assert.deepEqual(got.body.files.map(f => f.name).sort(), ['a.md', 'b.md']);
  // same shape as /api/list entries, so the card stack eats them directly
  for (const f of got.body.files) {
    for (const k of ['name', 'path', 'size', 'mtime', 'ext']) assert.ok(k in f, k);
  }
});

test('duplicates collapse and the first occurrence wins', async () => {
  const r = await post({ paths: [A, A, path.join(FIX, '.', 'a.md'), B] });
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 2);
});

test('missing paths are dropped but the rest still go, listed in `dropped`', async () => {
  const gone = path.join(FIX, 'nope.md');
  const dir = FIX;                      // a directory is not a file
  const r = await post({ paths: [A, gone, dir, B] });
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 2);
  assert.equal(r.body.dropped.length, 2);
});

test('a title-less pile is named after its first file', async () => {
  const r = await post({ paths: [C] });
  assert.equal(r.status, 200);
  const got = await get('/api/pile?id=' + r.body.id);
  assert.equal(got.body.title, 'c.md');
});

test('a blank title falls back to the file name too', async () => {
  const r = await post({ paths: [C], title: '   ' });
  const got = await get('/api/pile?id=' + r.body.id);
  assert.equal(got.body.title, 'c.md');
});

test('all paths unusable → 400', async () => {
  const r = await post({ paths: [path.join(FIX, 'nope.md')] });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
});

test('over 500 paths → 400', async () => {
  const many = Array.from({ length: 501 }, () => A);
  const r = await post({ paths: many });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /500/);
});

test('a pile where a listed file was deleted later reports it as missing', async () => {
  const tmpFile = path.join(FIX, 'temp.md');
  fs.writeFileSync(tmpFile, 'x\n');
  const r = await post({ paths: [A, tmpFile] });
  fs.rmSync(tmpFile);
  const got = await get('/api/pile?id=' + r.body.id);
  assert.equal(got.status, 200);
  assert.equal(got.body.files.length, 1);
  assert.equal(got.body.missing, 1);
});

// ---------------------------------------------------------------- SSE + retention
test('a pile is broadcast to a connected tab and listed by /api/piles', async (t) => {
  const st = await openEvents();
  t.after(() => closeEvents(st));
  const r = await post({ paths: [A], title: 'Broadcast me', source: 'agent' });
  assert.equal(r.status, 200);
  assert.equal(r.body.delivered, 1);
  const ev = await waitEvent(st, 'pile', 3000);
  assert.equal(ev.data.id, r.body.id);
  assert.equal(ev.data.title, 'Broadcast me');
  assert.equal(ev.data.count, 1);
  assert.equal(ev.data.source, 'agent');
  assert.ok(ev.data.createdAt > 0);

  const list = await get('/api/piles');
  assert.equal(list.status, 200);
  assert.ok(list.body.piles.length > 0);
  assert.ok(list.body.piles.some(p => p.id === r.body.id));
  assert.equal(list.body.piles[0].id, r.body.id, 'newest first');
});

test('only the newest 20 piles survive, in memory and on disk', async () => {
  const ids = [];
  for (let i = 0; i < 25; i++) {
    const r = await post({ paths: [A], title: 'k' + i });
    assert.equal(r.status, 200);
    ids.push(r.body.id);
  }
  const list = await get('/api/piles');
  assert.equal(list.body.piles.length, 20);
  assert.equal(list.body.piles[0].id, ids[24]);
  assert.ok(!list.body.piles.some(p => p.id === ids[0]), 'the oldest fell off');

  const disk = JSON.parse(fs.readFileSync(path.join(TMP, 'piles.json'), 'utf8'));
  assert.equal(disk.length, 20);
  assert.equal(disk[19].id, ids[24]);
  assert.ok(!disk.some(p => p.id === ids[0]));

  // an evicted pile really is gone
  assert.equal((await get('/api/pile?id=' + ids[0])).status, 404);
});
