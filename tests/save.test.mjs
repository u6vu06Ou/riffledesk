// tests/save.test.mjs — /api/save from the reader-edit feature.
// CRLF+BOM preservation, conflict 409, non-UTF-8 refusal, out-of-scope refusal,
// undo-restores-previous-content, and the mandatory-Origin guard.
// Usage: node --test tests/save.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5190;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// ---------- temp fixture ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffledesk-save-test-'));
const FIX = path.join(TMP, 'fixture');
fs.mkdirSync(FIX, { recursive: true });

const CRLF_BOM = path.join(FIX, 'crlfbom.md');
fs.writeFileSync(CRLF_BOM, Buffer.concat([
  Buffer.from([0xEF, 0xBB, 0xBF]),
  Buffer.from('# 標題\r\n\r\n第一行\r\n第二行\r\n', 'utf8')
]));
const PLAIN = path.join(FIX, 'plain.txt');
fs.writeFileSync(PLAIN, 'alpha\nbeta\ngamma\n');
const CONFLICT = path.join(FIX, 'conflict.txt');
fs.writeFileSync(CONFLICT, 'before\n');
const BIG5 = path.join(FIX, 'big5.txt');
fs.writeFileSync(BIG5, Buffer.from([0xA4, 0x41, 0xA4, 0xE5, 0x0A])); // 中文 in Big5-ish bytes — invalid UTF-8
const SHEET = path.join(FIX, 'data.xlsx');
fs.writeFileSync(SHEET, 'not really a sheet but binary-ish\n');

const CONFIG_PATH = path.join(TMP, 'config.json');
fs.writeFileSync(CONFIG_PATH, JSON.stringify({ roots: [FIX], pinned: [] }, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const proc = spawn('node', ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: CONFIG_PATH, RIFFLEDESK_INDEX: 'off' },
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
  return { status: res.status, body: await res.json().catch(() => null) };
}
const baseOf = p => { const st = fs.statSync(p); return { baseMtime: st.mtimeMs, baseSize: st.size }; };

after(async () => {
  try { proc.kill(); } catch (_) {}
  await Promise.race([new Promise(r => proc.once('exit', r)), sleep(3000)]);
  await sleep(200);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('save suite', async (t) => {
  await waitListening();

  await t.test('happy path preserves CRLF and BOM', async () => {
    const b = baseOf(CRLF_BOM);
    const r = await post('/api/save', {
      path: CRLF_BOM,
      content: '# 新標題\n\n改過的第一行\n第二行\n加第三行\n',   // editor always sends LF
      ...b
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.crlf, true);
    assert.equal(r.body.bom, true);
    assert.equal(r.body.undoable, true);
    const disk = fs.readFileSync(CRLF_BOM);
    assert.deepEqual([disk[0], disk[1], disk[2]], [0xEF, 0xBB, 0xBF], 'BOM kept');
    const text = disk.subarray(3).toString('utf8');
    assert.ok(text.includes('\r\n'), 'CRLF kept');
    assert.ok(!/[^\r]\n/.test(text), 'no stray LF');
    assert.ok(text.startsWith('# 新標題\r\n'));
  });

  await t.test('plain LF file stays LF and BOM-less', async () => {
    const b = baseOf(PLAIN);
    const r = await post('/api/save', { path: PLAIN, content: 'alpha\nBETA\ngamma\n', ...b });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const disk = fs.readFileSync(PLAIN).toString('utf8');
    assert.equal(disk, 'alpha\nBETA\ngamma\n');
  });

  await t.test('undo restores the previous bytes (CRLF+BOM intact)', async () => {
    // crlfbom currently holds the SAVED content; undo should bring back the original
    const r1 = await post('/api/save', {
      path: CRLF_BOM, content: '# 再一次\n', ...baseOf(CRLF_BOM)
    });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(fs.readFileSync(CRLF_BOM).subarray(3).toString('utf8'), '# 再一次\r\n');
    const u = await post('/api/undo', {});
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(u.body.op, 'save');
    assert.equal(typeof u.body.remaining, 'number');
    const disk = fs.readFileSync(CRLF_BOM);
    assert.deepEqual([disk[0], disk[1], disk[2]], [0xEF, 0xBB, 0xBF]);
    const text = disk.subarray(3).toString('utf8');
    assert.equal(text, '# 新標題\r\n\r\n改過的第一行\r\n第二行\r\n加第三行\r\n');
  });

  await t.test('conflict → 409 with the disk version', async () => {
    const b = baseOf(CONFLICT);
    await sleep(20);
    fs.writeFileSync(CONFLICT, 'changed by someone else\n');   // external (AI) write
    const r = await post('/api/save', { path: CONFLICT, content: 'my edit\n', ...b });
    assert.equal(r.status, 409);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, 'conflict');
    assert.equal(r.body.content, 'changed by someone else\n');
    assert.equal(typeof r.body.mtime, 'number');
    assert.equal(typeof r.body.size, 'number');
    // disk untouched
    assert.equal(fs.readFileSync(CONFLICT, 'utf8'), 'changed by someone else\n');
  });

  await t.test('non-UTF-8 file refused', async () => {
    const r = await post('/api/save', { path: BIG5, content: 'whatever\n', ...baseOf(BIG5) });
    assert.equal(r.status, 415, JSON.stringify(r.body));
    assert.match(r.body.error, /UTF-8/);
  });

  await t.test('outside allowed scope refused', async () => {
    // a path that is outside every allowed scope on any OS: on Windows any
    // non-existent drive letter; on POSIX the drives list is home + mounts
    // only, so /no/such/… never qualifies (the repo may well live under home)
    let outside = null;
    if (process.platform === 'win32') {
      for (const letter of 'ZYXWVUTSRQPONMLKJIHG') {
        if (!fs.existsSync(letter + ':\\')) { outside = letter + ':\\riffle-nope-9x\\f.txt'; break; }
      }
    } else {
      outside = '/no/such/riffle-nope-9x/f.txt';
    }
    assert.ok(outside, 'no out-of-scope path available for the scope test');
    const r = await post('/api/save', { path: outside, content: 'y\n', baseMtime: 1, baseSize: 1 });
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });

  await t.test('no Origin header refused', async () => {
    const res = await fetch(BASE + '/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },   // no origin on purpose
      body: JSON.stringify({ path: PLAIN, content: 'z\n', baseMtime: 0, baseSize: 0 })
    });
    assert.equal(res.status, 403);
  });

  await t.test('non-text kind refused (xlsx)', async () => {
    const r = await post('/api/save', { path: SHEET, content: 'x\n', ...baseOf(SHEET) });
    assert.equal(r.status, 415, JSON.stringify(r.body));
  });

  await t.test('bad base params refused', async () => {
    const r = await post('/api/save', { path: PLAIN, content: 'x\n' });
    assert.equal(r.status, 400);
  });

  await t.test('remaining: 0 after undo drains the stack', async () => {
    // one save, one undo → remaining must be 0 (and eventually 404 with remaining 0)
    await post('/api/save', { path: PLAIN, content: 'one more\n', ...baseOf(PLAIN) });
    let guard = 0; let last = null;
    while (guard++ < 30) {
      last = await post('/api/undo', {});
      if (last.status === 404) break;
    }
    assert.equal(last.status, 404);
    assert.equal(last.body.remaining, 0);
  });
});
