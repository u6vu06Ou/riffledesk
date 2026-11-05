// tests/names.test.mjs — GET /api/names: global FILE-NAME search.
// A name typed while looking at one folder must be found anywhere in the indexed
// scope. Port 5196 (unit), 5197 for the index-off variant. Both temp-based.
// Usage: node --test tests/names.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5196;
const OFF_PORT = 5197;
const BASE = `http://127.0.0.1:${PORT}`;
const OFF_BASE = `http://127.0.0.1:${OFF_PORT}`;

const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-names-test-'));
const FIX = path.join(TMP, 'fixture');
const OUT = path.join(TMP, 'outside');
const mkdir = (...p) => fs.mkdirSync(path.join(FIX, ...p), { recursive: true });
const write = (rel, text) => fs.writeFileSync(path.join(FIX, ...rel.split('/')), text);

// folder A is what the user is "looking at"; the wanted file lives in B.
mkdir('A');
mkdir('B');
write('A/notes.md', 'a note\n');
write('B/radar-index.md', 'radar index\n');
write('B/other-radar.md', 'another\n');
write('B/old-radar.md', 'older\n');
write('B/Radar.md', 'exact name, newer case\n');
write('B/noise.txt', 'nothing\n');
write('B/radar-shot.png', 'png\n');
mkdir('B', 'deep');
write('B/deep/radar-in-deep.md', 'deep\n');
// outside the indexed roots (must not leak through the scope check)
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'radar-outside.md'), 'x\n');

const CONFIG_PATH = path.join(TMP, 'config.json');
const CONFIG_OFF_PATH = path.join(TMP, 'config-off.json');
fs.writeFileSync(CONFIG_PATH, JSON.stringify({ roots: [FIX], pinned: [] }, null, 2));
fs.writeFileSync(CONFIG_OFF_PATH, JSON.stringify({ roots: [FIX], pinned: [] }, null, 2));

const DRIVES = [TMP, process.env.RIFFLEDESK_TEST_DRIVES].filter(Boolean).join(path.delimiter);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function start(port, cfg, extraEnv) {
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: 'test', RIFFLEDESK_TEST_DRIVES: DRIVES,
      PORT: String(port), FLODER_CONFIG: cfg, ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  proc.out = '';
  proc.stdout.on('data', d => { proc.out += d; });
  proc.stderr.on('data', d => { proc.out += d; });
  return proc;
}

async function waitListening(proc, base) {
  const t0 = Date.now();
  while (!proc.out.includes('listening')) {
    if (proc.exitCode !== null) throw new Error('server exited early: ' + proc.out);
    if (Date.now() - t0 > 15000) throw new Error('server start timeout: ' + proc.out);
    await sleep(25);
  }
  return base;
}

const proc = start(PORT, CONFIG_PATH, {});
const offProc = start(OFF_PORT, CONFIG_OFF_PATH, { RIFFLEDESK_INDEX: 'off' });

async function getJson(base, p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
}

async function waitCrawled(maxMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const { body } = await getJson(BASE, '/api/index/status');
    if (body.ok && body.available && body.lastCrawlAt && !body.crawling && body.files > 0) return body;
    if (Date.now() - t0 > maxMs) throw new Error('index never finished crawling: ' + JSON.stringify(body) + ' / ' + proc.out);
    await sleep(100);
  }
}

after(async () => {
  for (const p of [proc, offProc]) { try { p.kill(); } catch (_) {} }
  await sleep(600);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('names suite', async (t) => {
  await waitListening(proc, BASE);
  await waitListening(offProc, OFF_BASE);
  await waitCrawled();

  await t.test('finds a name in another folder (the actual bug)', async () => {
    const { status, body } = await getJson(BASE, '/api/names?q=radar-index');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.indexed, true);
    const hit = body.files.find(f => f.name === 'radar-index.md');
    assert.ok(hit, 'radar-index.md must be found: ' + JSON.stringify(body.files));
    assert.equal(hit.path, path.join(FIX, 'B', 'radar-index.md'));
    assert.equal(hit.dir, path.join(FIX, 'B'));
    for (const k of ['name', 'path', 'dir', 'mtime', 'size', 'ext']) assert.ok(k in hit, 'missing ' + k);
  });

  await t.test('case-insensitive substring', async () => {
    const { body } = await getJson(BASE, '/api/names?q=RADAR-INDEX');
    assert.ok(body.files.some(f => f.name === 'radar-index.md'));
  });

  await t.test('ranking: exact name > starts-with > contains, newest first inside a bucket', async () => {
    const { body } = await getJson(BASE, '/api/names?q=radar');
    assert.ok(body.files.length >= 4);
    assert.equal(body.files[0].name.toLowerCase(), 'radar.md', 'exact name first');
    const starts = body.files.map(f => f.name.toLowerCase().startsWith('radar'));
    // every starts-with hit must precede every contains-only hit
    const lastStart = starts.lastIndexOf(true);
    const firstContains = starts.indexOf(false);
    assert.ok(firstContains === -1 || lastStart < firstContains, 'starts-with before contains: ' + JSON.stringify(body.files.map(f => f.name)));
    const containsOnly = body.files.filter(f => !f.name.toLowerCase().startsWith('radar')).map(f => f.name);
    assert.deepEqual(containsOnly.sort(), ['old-radar.md', 'other-radar.md']);
  });

  await t.test('limit is honoured and capped', async () => {
    const two = await getJson(BASE, '/api/names?q=radar&limit=2');
    assert.equal(two.body.files.length, 2);
    const huge = await getJson(BASE, '/api/names?q=radar&limit=9999');
    assert.ok(huge.body.files.length <= 200);
  });

  await t.test('bad input', async () => {
    assert.equal((await getJson(BASE, '/api/names?q=')).status, 400);
    assert.equal((await getJson(BASE, '/api/names?q=' + 'x'.repeat(201))).status, 400);
  });

  await t.test('scope: only allowed roots are returned', async () => {
    // OUT is browsable on Windows only when its drive is allowed; keep the
    // fixture's own roots the assertion in either case: everything returned
    // must live under FIX.
    const { body } = await getJson(BASE, '/api/names?q=radar');
    for (const f of body.files) {
      assert.ok(f.path.startsWith(FIX), 'unexpected path ' + f.path);
      assert.ok(!f.path.startsWith(OUT), 'outside path leaked ' + f.path);
    }
  });

  await t.test('exts filter: only the listed extensions', async () => {
    const { body } = await getJson(BASE, '/api/names?q=radar&exts=.md');
    assert.ok(body.files.length >= 4, JSON.stringify(body.files));
    assert.ok(body.files.every(f => f.ext.toLowerCase() === '.md'), JSON.stringify(body.files.map(f => f.name)));
    assert.ok(!body.files.some(f => f.name.endsWith('.png')));
    // the filter is case-insensitive on the extension too
    const up = await getJson(BASE, '/api/names?q=radar&exts=.MD');
    assert.ok(up.body.files.every(f => f.ext.toLowerCase() === '.md'));
    // several extensions at once
    const both = await getJson(BASE, '/api/names?q=radar&exts=.md,.png');
    assert.ok(both.body.files.some(f => f.name.endsWith('.png')), 'png kept when listed');
  });

  await t.test('exts absent or empty means all', async () => {
    const none = await getJson(BASE, '/api/names?q=radar');
    const empty = await getJson(BASE, '/api/names?q=radar&exts=');
    assert.ok(none.body.files.some(f => f.name.endsWith('.png')));
    assert.deepEqual(empty.body.files.map(f => f.name).sort(), none.body.files.map(f => f.name).sort());
  });

  await t.test('exts=all and readable behave like the rest of the API', async () => {
    const all = await getJson(BASE, '/api/names?q=radar&exts=all');
    assert.ok(all.body.files.some(f => f.name.endsWith('.png')));
    // 'readable' = the known kinds; images are readable too, so it must not be empty
    const readable = await getJson(BASE, '/api/names?q=radar&exts=readable');
    assert.ok(readable.body.files.some(f => f.name.endsWith('.md')));
  });

  await t.test('index unavailable → ok:true, empty, indexed:false', async () => {
    const { status, body } = await getJson(OFF_BASE, '/api/names?q=radar');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.files, []);
    assert.equal(body.indexed, false);
    assert.equal(typeof body.ms, 'number');
  });

  await t.test('reports ms', async () => {
    const { body } = await getJson(BASE, '/api/names?q=radar');
    assert.equal(typeof body.ms, 'number');
    assert.ok(body.ms < 1000, 'ms=' + body.ms);
  });
});
