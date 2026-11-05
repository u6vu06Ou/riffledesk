// tests/demo.test.mjs — demo mode (RIFFLEDESK_DEMO): one folder, no drives, fake home,
// transcripts read from inside the tree, every path translated both ways.
// Usage: node --test tests/demo.test.mjs   (port 5197)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const PORT = 5197;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- fixture ----------
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-demo-'));
const DEMO = path.join(TMP, 'demo-home');            // the tree IS the fake home
const w = (rel, text) => {
  const abs = path.join(DEMO, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};
w('Documents/aurora-labs/note.md', '# Note\n\nPlan: retry budget lives in the queue config.\n');
w('Documents/aurora-labs/page.html', '<!doctype html><meta charset="utf-8"><title>t</title><h1>hi</h1>\n');
w('.claude/projects/-Users-demo-Documents-aurora-labs/s1.jsonl', [
  { type: 'user', sessionId: 's1', cwd: path.join(DEMO, 'Documents', 'aurora-labs'), message: { role: 'user', content: 'Write the note' }, timestamp: new Date().toISOString() },
  { type: 'assistant', sessionId: 's1', cwd: path.join(DEMO, 'Documents', 'aurora-labs'), timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: path.join(DEMO, 'Documents', 'aurora-labs', 'note.md') } }] } }
].map(o => JSON.stringify(o)).join('\n') + '\n');

const procs = [];
after(() => {
  for (const p of procs) { try { p.kill(); } catch (_) {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(DEMO + '.state', { recursive: true, force: true }); } catch (_) {}
});

function waitPortFree(port) {
  let tries = 0;
  return new Promise((resolve) => {
    const attempt = () => {
      const s = net.createConnection(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        if (++tries > 100) return resolve();
        setTimeout(attempt, 50);
      });
      s.once('error', () => resolve());
    };
    attempt();
  });
}

async function startDemo() {
  await waitPortFree(PORT);
  // deliberately NO RIFFLEDESK_CONFIG: the demo must not read the caller's own config
  const env = { ...process.env, PORT: String(PORT), RIFFLEDESK_DEMO: DEMO, RIFFLEDESK_INDEX: 'off' };
  delete env.FLODER_CONFIG;
  delete env.RIFFLEDESK_CONFIG;
  const proc = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  procs.push(proc);
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  const deadline = Date.now() + 10000;
  while (!out.includes('listening')) {
    if (Date.now() > deadline) throw new Error('server start timeout: ' + out);
    await sleep(25);
  }
  return proc;
}

const getJson = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json() }; };

// ---------- tests ----------
test('demo: no drives, fake root only, nothing outside the tree', async () => {
  await startDemo();
  const { status, body } = await getJson('/api/drives');
  assert.equal(status, 200);
  assert.deepEqual(body.drives, [], 'the demo never lists real drives');
  assert.equal(body.roots[0], IS_WIN ? 'C:\\Users\\demo' : '/home/demo', 'fake root first');
  assert.ok(body.pinned.includes(IS_WIN ? 'C:\\Users\\demo\\Documents\\aurora-labs' : '/home/demo/Documents/aurora-labs'));
  // the real temp path must never surface
  assert.ok(!JSON.stringify(body).includes(TMP), JSON.stringify(body));
});

test('demo: real paths are translated to the fake home on the way out', async () => {
  const fake = IS_WIN ? 'C:\\Users\\demo\\Documents\\aurora-labs' : '/home/demo/Documents/aurora-labs';
  const { status, body } = await getJson('/api/list?path=' + encodeURIComponent(fake));
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.files.map(f => f.name).sort(), ['note.md', 'page.html']);
  for (const f of body.files) assert.ok(f.path.startsWith(IS_WIN ? 'C:\\Users\\demo' : '/home/demo'), f.path);
  assert.ok(!JSON.stringify(body).includes(TMP));

  const file = body.files.find(f => f.name === 'note.md');
  const r = await fetch(BASE + '/api/file?path=' + encodeURIComponent(file.path));
  assert.equal(r.status, 200);
  assert.match(await r.text(), /retry budget/);
});

test('demo: search and transcripts stay inside the tree', async () => {
  const fake = IS_WIN ? 'C:\\Users\\demo' : '/home/demo';
  const s = await getJson('/api/search?path=' + encodeURIComponent(fake) + '&q=budget');
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual(s.body.files.map(f => f.name), ['note.md']);
  assert.ok(!JSON.stringify(s.body).includes(TMP));

  const c = await getJson('/api/convos?days=30');
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.convos.length, 1, JSON.stringify(c.body));
  assert.equal(c.body.convos[0].title, 'Write the note');
  assert.ok(!JSON.stringify(c.body).includes(TMP));
});

test('demo: a projected fake path resolves to the real file', async () => {
  const fake = IS_WIN ? 'C:\\Users\\demo\\Documents\\aurora-labs\\note.md' : '/home/demo/Documents/aurora-labs/note.md';
  const r = await fetch(BASE + '/api/project', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-RiffleDesk-CLI': '1' },
    body: JSON.stringify({ path: fake })
  });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  assert.equal(JSON.parse(text).ok, true);
});

test('demo: a real path works too (CLI callers may send either)', async () => {
  const real = path.join(DEMO, 'Documents', 'aurora-labs', 'note.md');
  const r = await fetch(BASE + '/api/project', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-RiffleDesk-CLI': '1' },
    body: JSON.stringify({ path: real })
  });
  assert.equal(r.status, 200, await r.text());
});
