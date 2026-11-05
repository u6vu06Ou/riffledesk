// tests/live.test.mjs — /api/events (SSE) tests, in-process (imports server.js
// directly so hub internals can be asserted). Port 5187. Usage: node --test tests/live.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5187;

// ---------- temp fixture: a watched folder + a fake Claude transcript root ----------
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-live-'));
const FIX = path.join(TMP, 'fixture');
const CLAUDE = path.join(TMP, 'claude-proj');        // kind: claude → <dir>/<slug>/*.jsonl
fs.mkdirSync(FIX, { recursive: true });
fs.mkdirSync(path.join(CLAUDE, 'proj-x'), { recursive: true });
fs.writeFileSync(path.join(FIX, 'seed.md'), 'seed\n');
fs.writeFileSync(path.join(CLAUDE, 'proj-x', 'seed.jsonl'), '{"type":"meta"}\n');
const CONFIG_PATH = path.join(TMP, 'config.json');
fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  roots: [FIX], pinned: [], convoRoots: [{ kind: 'claude', dir: CLAUDE }]
}, null, 2));

// env must be set BEFORE the server module is imported (config path is fixed at import)
process.env.FLODER_CONFIG = CONFIG_PATH;
process.env.RIFFLEDESK_INDEX = 'off';
process.env.RIFFLEDESK_CONVO_POLL_MS = '300';
// note: import() of the CJS server exposes extra keys only via .default
const srv = (await import(pathToFileURL(path.join(ROOT, 'server.js')).href)).default;
const server = srv.start(PORT);
await new Promise((res, rej) => { server.once('listening', res); server.once('error', rej); });

const sleep = ms => new Promise(r => setTimeout(r, ms));

after(() => {
  try { server.closeAllConnections && server.closeAllConnections(); } catch (_) {}
  server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---------- tiny SSE client ----------
function openEvents(qs = '') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/events' + qs }, res => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => reject(Object.assign(new Error('http ' + res.statusCode), { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })));
        return;
      }
      const st = { req, res, events: [], waiters: [], buf: '' };
      res.on('data', c => {
        st.buf += c.toString('utf8');
        let i;
        while ((i = st.buf.indexOf('\n\n')) !== -1) {
          const chunk = st.buf.slice(0, i); st.buf = st.buf.slice(i + 2);
          const m = /event: (\w+)\ndata: (.+)/s.exec(chunk);
          if (m) {
            let data = null;
            try { data = JSON.parse(m[2]); } catch (_) { continue; }
            st.events.push({ type: m[1], data });
            for (const w of st.waiters.splice(0)) w();
          }
        }
      });
      resolve(st);
    });
    req.on('error', reject);
  });
}
async function waitEvent(st, type, timeoutMs, pred) {
  const t0 = Date.now();
  for (;;) {
    const idx = st.events.findIndex(e => e.type === type && (!pred || pred(e)));
    if (idx >= 0) return st.events.splice(idx, 1)[0];
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`timeout waiting for '${type}', got ${JSON.stringify(st.events)}`);
    }
    await new Promise(r => { st.waiters.push(r); setTimeout(r, 60); });
  }
}
function closeEvents(st) { try { st.req.destroy(); } catch (_) {} }

test('dir event: write a file into the watched folder → dir event within 3 s (added names)', async (t) => {
  const st = await openEvents('?path=' + encodeURIComponent(FIX));
  t.after(() => closeEvents(st));
  assert.equal(srv._eventsState().clients, 1);
  assert.equal(srv._eventsState().watchers, 1);

  const fname = 'live-added.md';
  fs.writeFileSync(path.join(FIX, fname), 'written by the test\n');
  const ev = await waitEvent(st, 'dir', 3000, e => (e.data.added || []).includes(fname));
  assert.deepEqual(ev.data.removed || [], []);

  fs.rmSync(path.join(FIX, fname));
  const ev2 = await waitEvent(st, 'dir', 3000, e => (e.data.removed || []).includes(fname));
  assert.deepEqual(ev2.data.added || [], []);
});

test('client disconnect releases the folder watcher', async (t) => {
  const st = await openEvents('?path=' + encodeURIComponent(FIX));
  assert.equal(srv._eventsState().watchers, 1);
  closeEvents(st);
  const t0 = Date.now();
  while (srv._eventsState().watchers !== 0 || srv._eventsState().clients !== 0) {
    if (Date.now() - t0 > 3000) throw new Error('watcher/client not released: ' + JSON.stringify(srv._eventsState()));
    await sleep(50);
  }
});

test('convos event: a new transcript appears → convos event', async (t) => {
  const st = await openEvents();     // no path: convos-only stream
  t.after(() => closeEvents(st));
  await sleep(450);                  // baseline signature is computed at connect
  fs.writeFileSync(path.join(CLAUDE, 'proj-x', 'new-session.jsonl'), '{"type":"meta"}\n');
  const ev = await waitEvent(st, 'convos', 5000);
  assert.ok(ev.data.at > 0);
});

test('client cap: a 9th concurrent client gets 429', async (t) => {
  // previous test's client teardown is async; wait for a clean slate first
  const t0 = Date.now();
  while (srv._eventsState().clients !== 0) {
    if (Date.now() - t0 > 3000) throw new Error('prior clients not released: ' + JSON.stringify(srv._eventsState()));
    await sleep(50);
  }
  const open = [];
  t.after(() => { for (const st of open) closeEvents(st); });
  for (let i = 0; i < 8; i++) open.push(await openEvents());
  assert.equal(srv._eventsState().clients, 8);
  await assert.rejects(openEvents(), e => e.status === 429);
});
