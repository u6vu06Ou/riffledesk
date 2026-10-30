// tests/fileops.test.mjs — write endpoints: /api/reveal /api/open /api/rename /api/trash.
// Spawns server.js on port 5181 with RIFFLEDESK_TRASH_DRYRUN=1 (touching the real
// Recycle Bin is verified separately, once, by hand). Successful reveal/open calls
// would pop visible windows, so only their guard/rejection paths are tested here.
// Usage: node --test tests/fileops.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const PORT = 5181;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// ---------- temp fixture ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffledesk-ops-test-'));
const FIX = path.join(TMP, 'fixture');
fs.mkdirSync(path.join(FIX, 'subdir'), { recursive: true });
fs.writeFileSync(path.join(FIX, 'a.txt'), 'hello world\n');
fs.writeFileSync(path.join(FIX, 'dup.txt'), 'occupied name\n');
fs.writeFileSync(path.join(FIX, 'trashme.txt'), 'to the bin (dry-run only)\n');
fs.writeFileSync(path.join(FIX, 'script.js'), 'console.log(1);\n');
fs.writeFileSync(path.join(FIX, 'run.exe'), 'MZ not really an exe\n');

const CONFIG_PATH = path.join(TMP, 'config.json');
fs.writeFileSync(CONFIG_PATH, JSON.stringify({ roots: [FIX], pinned: [] }, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));

const proc = spawn('node', ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: CONFIG_PATH, RIFFLEDESK_TRASH_DRYRUN: '1' },
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

async function post(endpoint, payload, headers = {}) {
  const res = await fetch(BASE + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(payload)
  });
  return { status: res.status, body: await res.json() };
}

after(async () => {
  try { proc.kill(); } catch (_) {}
  await Promise.race([new Promise(r => proc.once('exit', r)), sleep(3000)]);
  await sleep(200);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('fileops suite', async (t) => {
  await waitListening();
  const A = path.join(FIX, 'a.txt');

  await t.test('write endpoints reject missing Origin', async () => {
    for (const ep of ['/api/reveal', '/api/open', '/api/rename', '/api/trash']) {
      const res = await fetch(BASE + ep, {
        method: 'POST',
        headers: { 'content-type': 'application/json' }, // no Origin on purpose
        body: JSON.stringify({ path: A, newName: 'x.txt' })
      });
      assert.equal(res.status, 403, `${ep} without Origin must be 403`);
    }
  });

  await t.test('write endpoints reject a foreign Origin', async () => {
    const r = await post('/api/rename', { path: A, newName: 'x.txt' }, { origin: 'http://evil.example:9999' });
    assert.equal(r.status, 403);
  });

  await t.test('write endpoints reject non-JSON content type', async () => {
    const res = await fetch(BASE + '/api/rename', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: ORIGIN },
      body: 'path=x'
    });
    assert.equal(res.status, 415);
  });

  await t.test('write endpoints are POST only', async () => {
    const res = await fetch(BASE + '/api/trash', { headers: { origin: ORIGIN } });
    assert.equal(res.status, 405);
  });

  await t.test('rename: rejects every bad newName', async () => {
    const bad = ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'x'.repeat(256)];
    if (IS_WIN) bad.push('name.', 'name ', 'CON', 'con.txt', 'Com1', 'lpt9.log');
    for (const newName of bad) {
      const r = await post('/api/rename', { path: A, newName });
      assert.equal(r.status, 400, `newName=${JSON.stringify(newName)}: got ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.ok, false);
    }
    assert.ok(fs.existsSync(A), 'the source file must be untouched');
  });

  await t.test('rename: 409 when the target name is taken', async () => {
    const r = await post('/api/rename', { path: A, newName: 'dup.txt' });
    assert.equal(r.status, 409);
    if (IS_WIN) {
      const r2 = await post('/api/rename', { path: A, newName: 'DUP.TXT' }); // case-insensitive clash
      assert.equal(r2.status, 409);
    }
  });

  await t.test('rename: 404 missing file, 400 for a directory, 403 outside scope', async () => {
    assert.equal((await post('/api/rename', { path: path.join(FIX, 'nope.txt'), newName: 'x.txt' })).status, 404);
    assert.equal((await post('/api/rename', { path: path.join(FIX, 'subdir'), newName: 'x' })).status, 400);
    if (IS_WIN) {
      let outside = null;
      for (let i = 90; i >= 68 && !outside; i--) {
        const letter = String.fromCharCode(i);
        if (!fs.existsSync(letter + ':\\')) outside = letter + ':\\riffle-nope-9x\\f.txt';
      }
      assert.equal((await post('/api/rename', { path: outside, newName: 'x.txt' })).status, 403);
    }
  });

  await t.test('rename: a good rename returns the new file-info', async () => {
    const r = await post('/api/rename', { path: A, newName: 'renamed.txt' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.file.name, 'renamed.txt');
    assert.equal(r.body.file.path, path.join(FIX, 'renamed.txt'));
    assert.equal(r.body.file.ext, '.txt');
    assert.equal(r.body.file.kind, 'text');
    assert.equal(typeof r.body.file.size, 'number');
    assert.equal(typeof r.body.file.mtime, 'number');
    assert.ok(!fs.existsSync(A));
    assert.ok(fs.existsSync(path.join(FIX, 'renamed.txt')));
  });

  if (IS_WIN) {
    await t.test('rename: pure case-change of the same file is allowed on win32', async () => {
      const src = path.join(FIX, 'renamed.txt');
      const r = await post('/api/rename', { path: src, newName: 'RENAMED.TXT' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.file.name, 'RENAMED.TXT');
      const names = fs.readdirSync(FIX);
      assert.ok(names.includes('RENAMED.TXT'));
      assert.ok(!names.includes('renamed.txt'));
    });
  }

  await t.test('trash: dry-run validates but touches nothing', async () => {
    const target = path.join(FIX, 'trashme.txt');
    const r = await post('/api/trash', { path: target });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.dryRun, true);
    assert.ok(fs.existsSync(target), 'dry-run must not move the file');
  });

  await t.test('trash: rejects directories and missing files', async () => {
    assert.equal((await post('/api/trash', { path: path.join(FIX, 'subdir') })).status, 400);
    assert.equal((await post('/api/trash', { path: path.join(FIX, 'ghost.txt') })).status, 404);
  });

  await t.test('open: runnable/script types are refused with 403', async () => {
    for (const f of ['script.js', 'run.exe']) {
      const r = await post('/api/open', { path: path.join(FIX, f) });
      assert.equal(r.status, 403, `${f} must be refused`);
      assert.match(r.body.error, /refusing to open/i);
    }
  });

  await t.test('open/reveal: 404 for missing files, 400 for directories, 403 outside scope', async () => {
    assert.equal((await post('/api/open', { path: path.join(FIX, 'ghost.md') })).status, 404);
    assert.equal((await post('/api/reveal', { path: path.join(FIX, 'ghost.md') })).status, 404);
    assert.equal((await post('/api/reveal', { path: path.join(FIX, 'subdir') })).status, 400);
    if (IS_WIN) {
      let outside = null;
      for (let i = 90; i >= 68 && !outside; i--) {
        const letter = String.fromCharCode(i);
        if (!fs.existsSync(letter + ':\\')) outside = letter + ':\\riffle-nope-9x\\f.txt';
      }
      assert.equal((await post('/api/open', { path: outside })).status, 403);
      assert.equal((await post('/api/reveal', { path: outside })).status, 403);
    }
  });
});
