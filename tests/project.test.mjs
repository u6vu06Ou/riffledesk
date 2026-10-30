// tests/project.test.mjs — POST /api/project (CLI push-to-open) tests.
// In-process (imports server.js so the SSE hub can be observed directly). Port 5189.
// Covers: 404 for a missing file, 403 for a path outside the allowed scopes, 403 for
// a cross-origin browser request, `delivered` counts, and an actual project event on a
// live SSE connection. Usage: node --test tests/project.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5189;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffledesk-project-'));
const FIX = path.join(TMP, 'fixture');
const OUTSIDE = path.join(TMP, 'outside');
fs.mkdirSync(FIX, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
const TARGET = path.join(FIX, 'note.md');
fs.writeFileSync(TARGET, '# hi\nline two\nline three\n');
const OUTSIDE_FILE = path.join(OUTSIDE, 'out.md');
fs.writeFileSync(OUTSIDE_FILE, 'outside\n');
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
// `headers` are the only difference between a CLI call and a browser call.
function post(body, headers = { 'X-RiffleDesk-CLI': '1' }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/project', method: 'POST',
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

// ---------------------------------------------------------------- tests
test('missing path → 404 and ok:false', async () => {
  const r = await post({ path: path.join(FIX, 'nope.md') });
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
});

test('path outside the allowed scopes → 403', async (t) => {
  // On Windows every existing drive is in scope, so a temp path is always allowed there
  // (server.test.mjs skips the same way).
  if (process.platform === 'win32') return t.skip('POSIX only: the scope is "/" on POSIX');
  const r = await post({ path: OUTSIDE_FILE });
  assert.equal(r.status, 403);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /allowed/);
});

test('a cross-origin browser POST (Origin of another site) is refused', async () => {
  const r = await post({ path: TARGET }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(r.body.ok, false);
});

test('no Origin and no CLI header → 403 (browser-less caller must identify itself)', async () => {
  const r = await post({ path: TARGET, origin: undefined }, {});
  assert.equal(r.status, 403);
});

test('same-origin browser Origin is accepted too', async () => {
  const r = await post({ path: TARGET }, { origin: `http://127.0.0.1:${PORT}` });
  assert.equal(r.status, 200);
});

test('missing / bad body → 4xx', async () => {
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ path: 42 })).status, 400);
  const notJson = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/project', method: 'POST',
      headers: { 'content-type': 'text/plain', 'X-RiffleDesk-CLI': '1' }
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end('nope');
  });
  assert.equal(notJson, 415);
});

test('a directory is not a file → 400', async () => {
  const r = await post({ path: FIX });
  assert.equal(r.status, 400);
});

test('no tab connected → delivered 0', async () => {
  const r = await post({ path: TARGET });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, delivered: 0 });
});

test('one SSE tab connected → delivered 1 and a project event carrying the path', async (t) => {
  const st = await openEvents();
  t.after(() => closeEvents(st));
  const r = await post({ path: TARGET, line: 3, source: 'claude-code' });
  assert.equal(r.status, 200);
  assert.equal(r.body.delivered, 1);
  const ev = await waitEvent(st, 'project', 3000);
  assert.equal(ev.data.path, TARGET);
  assert.equal(ev.data.line, 3);
  assert.equal(ev.data.source, 'claude-code');
  assert.ok(ev.data.at > 0);
});

test('a nonsense line value becomes line null', async (t) => {
  const st = await openEvents();
  t.after(() => closeEvents(st));
  await post({ path: TARGET, line: 'abc' });
  const ev = await waitEvent(st, 'project', 3000);
  assert.equal(ev.data.line, null);
});
