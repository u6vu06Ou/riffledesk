// tests/secrets-undo.test.mjs — Feature A (secret-leak warning) + Feature B (Ctrl+Z undo).
// Server on port 5184 with RIFFLEDESK_INDEX=off so /api/list secret flags come from the
// on-demand fallback (the index path is covered by indexer-secret.test.mjs).
// Trash→undo uses the REAL recycle bin on Windows with uniquely-named temp files.
// All fixture "keys" are fake; assertions also check the full values never leak.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { scanText, hasSecrets, maskValue, looksBinary } = require('../secrets.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const PORT = 5184;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// ---------- pure detector (no server needed) ----------
test('secrets.js: structural key shapes all match', () => {
  const cases = [
    ['sk-FAKE00000000000000000000000000', 'openai style'],
    ['sk-ant-api03-FAKEFAKEFAKEFAKE', 'anthropic style'],
    ['AKIAFAKEDEMO0000K0Q0', 'aws access key id'],
    ['ghp_FAKEDEMO0000FAKEDEMO0000FAKEDEMO', 'github classic pat'],
    ['github_pat_11FAKE000_Fak00000000000000000000000', 'github fine-grained'],
    ['AIzaSyFAKEDEMOFAKEDEMOFAKEDEMOFAKEDEMO0', 'google api key'],
    ['xoxb-1111-2222-abcdefghijkl', 'slack bot token'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----', 'private key block'],
    ['-----BEGIN RSA PRIVATE KEY BLOCK-----', 'pem private key block']
  ];
  for (const [sample, label] of cases) {
    const hits = scanText(`var tok = "${sample}";`);
    assert.ok(hits.length >= 1, `${label} not detected: ${sample.slice(0, 12)}…`);
  }
});

test('secrets.js: generic password/api_key rules with placeholder rejection', () => {
  // real-looking values → hit
  assert.equal(hasSecrets('password = "Sup3rS3cret!demo"'), true);
  assert.equal(hasSecrets("password: hunter2-is-fake"), true);
  assert.equal(hasSecrets('api_key = asldkfj209fjwoeifjv0w9'), true);
  assert.equal(hasSecrets('api-key: Zx8Qm2Lp4RtYs6Wv'), true);
  // obvious placeholders → NO hit (false positives must stay low)
  for (const line of [
    'password = "xxxxxx"',
    'password: <your-key>',
    'password = ******',
    'api_key = "example"',
    'password: changeme',
    'password = your_api_key_here',
    'api_key: foo111good',          // starts with doc placeholder word
    'password = abcdef'.replace('abcdef', 'aaaaaa'), // all-same-char run
    'password = "..."'.replace('...', '...…'.slice(0, 1)), // '< 6 after clean
    'password field is required',    // no : or =
    'password: forgot?'
  ]) {
    assert.equal(hasSecrets(line), false, 'false positive on: ' + line);
  }
  // a clean note with all of the above stays clean
  const clean = fs.readFileSync(path.join(ROOT, 'tests/fixtures/secretdemo/prose-note.md'), 'utf8');
  assert.equal(hasSecrets(clean), false, 'prose-note.md falsely flagged');
  // the fake-key demo note flags (and each hit carries a 1-based line number)
  const demo = fs.readFileSync(path.join(ROOT, 'tests/fixtures/secretdemo/keys-note.md'), 'utf8');
  const hits = scanText(demo);
  assert.ok(hits.length >= 8, 'expected >= 8 hits, got ' + hits.length);
  assert.ok(hits.every(h => Number.isInteger(h.line) && h.line >= 1));
  assert.ok(hits.some(h => h.line === 3), 'line-3 openai key hit missing');
});

test('secrets.js: maskValue shows at most the first 4 chars', () => {
  const v = 'sk-FAKE00000000000000000000000000';
  const m = maskValue(v);
  assert.ok(m.startsWith('sk-F'));
  assert.ok(!m.includes('FAK'), 'mask leaked beyond char 4');
  assert.ok(!m.includes('000000'), 'mask leaked the tail');
  // short secrets must not leak through the mask itself (len/3 rule)
  assert.equal(maskValue('ab'), '••••••••');
  assert.equal(maskValue('abcd'), 'a••••••••');       // len 4 → show 1
  assert.equal(maskValue('hunter22'), 'hu••••••••');  // len 8 → show 2
  assert.ok(!maskValue('hunter22').includes('unter'), 'mask leaked the middle');
});

test('secrets.js: looksBinary sniff', () => {
  assert.equal(looksBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])), true); // zip-ish NUL
  assert.equal(looksBinary(Buffer.from('plain text ✓', 'utf8')), false);
});

// ---------- server integration ----------
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-undo-test-'));
const FIX = path.join(TMP, 'fixture');
fs.mkdirSync(FIX, { recursive: true });
fs.writeFileSync(path.join(FIX, 'ren-a.txt'), 'rename me\n');
const DEMO = path.join(ROOT, 'tests/fixtures/secretdemo');

const CONFIG_PATH = path.join(TMP, 'config.json');
fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  roots: [FIX, DEMO], pinned: [], secretScan: true, secretScanSkipDirs: ['skipme']
}, null, 2));

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
async function postApi(endpoint, payload, headers = {}) {
  const res = await fetch(BASE + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(payload || {})
  });
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { status: res.status, body };
}
async function getApi(endpoint) {
  const res = await fetch(BASE + endpoint, { headers: { origin: ORIGIN } });
  return { status: res.status, body: await res.text() };
}

after(async () => {
  try { proc.kill(); } catch (_) {}
  await Promise.race([new Promise(r => proc.once('exit', r)), sleep(3000)]);
  await sleep(200);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('secrets + undo suite', async (t) => {
  await waitListening();

  await t.test('/api/list marks the fake-key file (on-demand fallback, index off)', async () => {
    const r = await getApi('/api/list?path=' + encodeURIComponent(DEMO) + '&exts=.md');
    const d = JSON.parse(r.body);
    assert.equal(d.ok, true);
    const byName = Object.fromEntries(d.files.map(f => [f.name, !!f.secret]));
    assert.equal(byName['keys-note.md'], true);
    assert.equal(byName['prose-note.md'], false, 'prose-note.md falsely flagged');
    assert.equal(byName['rename-me.md'], false);
    // skipme/ dir is in secretScanSkipDirs: its file must NOT flag
    const r2 = await getApi('/api/list?path=' + encodeURIComponent(path.join(DEMO, 'skipme')) + '&exts=.md');
    const d2 = JSON.parse(r2.body);
    assert.equal(d2.ok, true);
    assert.equal(d2.files.every(f => !f.secret), true);
    // the secret key itself is nowhere in the list payload
    assert.ok(!r.body.includes('Sup3rS3cret'), 'list payload leaked a secret value');
  });

  await t.test('/api/secretscan returns masked matches with line numbers', async () => {
    const r = await getApi('/api/secretscan?path=' + encodeURIComponent(path.join(DEMO, 'keys-note.md')));
    const d = JSON.parse(r.body);
    assert.equal(d.ok, true);
    assert.equal(d.secret, true);
    assert.ok(d.matches.length >= 8, 'expected >= 8 matches');
    assert.ok(d.matches.some(m => m.line === 3 && m.masked.startsWith('sk-F')));
    for (const m of d.matches) {
      assert.ok(Number.isInteger(m.line) && m.line >= 1);
      assert.ok(m.masked.includes('•'), 'match not masked: ' + m.masked);
    }
    assert.ok(!r.body.includes('Sup3rS3cret'), 'payload leaked the password');
    assert.ok(!r.body.includes('FAKEDEMO0000FAKEDEMO0000'), 'payload leaked key tail');
    // clean file → secret:false; binary-ish / absent guard
    const r2 = await getApi('/api/secretscan?path=' + encodeURIComponent(path.join(DEMO, 'prose-note.md')));
    assert.equal(JSON.parse(r2.body).secret, false);
    // skipped dir returns clean without scanning
    const r3 = await getApi('/api/secretscan?path=' + encodeURIComponent(path.join(DEMO, 'skipme', 'keys-hidden.md')));
    assert.equal(JSON.parse(r3.body).secret, false);
  });

  await t.test('/api/undo needs the same-origin guard', async () => {
    const res = await fetch(BASE + '/api/undo', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(res.status, 403);
  });

  await t.test('rename → undo restores the old name', async () => {
    const a = path.join(FIX, 'ren-a.txt');
    const b = path.join(FIX, 'ren-b.txt');
    let r = await postApi('/api/rename', { path: a, newName: 'ren-b.txt' });
    assert.equal(r.status, 200);
    assert.equal(fs.existsSync(b), true);
    assert.equal(fs.existsSync(a), false);
    r = await postApi('/api/undo', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.restored, ['ren-a.txt']);
    assert.equal(fs.existsSync(a), true);
    assert.equal(fs.existsSync(b), false);
    // stack now empty → 404 with a clear message
    r = await postApi('/api/undo', {});
    assert.equal(r.status, 404);
  });

  await t.test('undo rename fails cleanly when the renamed file is gone', async () => {
    const a = path.join(FIX, 'ren-c.txt');
    const b = path.join(FIX, 'ren-d.txt');
    fs.writeFileSync(a, 'c\n');
    await postApi('/api/rename', { path: a, newName: 'ren-d.txt' });
    fs.unlinkSync(b); // someone deleted the renamed file out of band
    const r = await postApi('/api/undo', {});
    assert.equal(r.status, 409);
    assert.ok(/no longer exists/.test(r.body.error || r.body.failed[0].error));
    assert.equal(fs.existsSync(a), false); // nothing half-restored
  });

  await t.test('undo rename refuses to overwrite a taken old name', async () => {
    const a = path.join(FIX, 'ren-e.txt');
    const b = path.join(FIX, 'ren-f.txt');
    fs.writeFileSync(a, 'e\n');
    await postApi('/api/rename', { path: a, newName: 'ren-f.txt' });
    fs.writeFileSync(a, 'occupied by something else\n'); // old name taken again
    const r = await postApi('/api/undo', {});
    assert.equal(r.status, 409);
    assert.ok(/taken/.test(r.body.error || r.body.failed[0].error));
    assert.equal(fs.readFileSync(a, 'utf8'), 'occupied by something else\n');
    assert.equal(fs.existsSync(b), true);
  });

  await t.test('LIFO: two renames undo newest first', async () => {
    const a = path.join(FIX, 'lifo-1.txt');
    fs.writeFileSync(a, 'x\n');
    await postApi('/api/rename', { path: a, newName: 'lifo-2.txt' });
    await postApi('/api/rename', { path: path.join(FIX, 'lifo-2.txt'), newName: 'lifo-3.txt' });
    let r = await postApi('/api/undo', {});
    assert.equal(r.status, 200);
    assert.equal(fs.existsSync(path.join(FIX, 'lifo-2.txt')), true, 'newest rename undone first');
    r = await postApi('/api/undo', {});
    assert.equal(r.status, 200);
    assert.equal(fs.existsSync(a), true, 'second undo restores the very first name');
  });

  // (t.test.skip is not a TestContext method; the { skip } option is the supported API)
  const binTest = IS_WIN ? (n, f) => t.test(n, f) : (n, f) => t.test(n, { skip: 'Windows recycle bin only' }, f);
  await binTest('trash → undo restores from the real recycle bin', async () => {
    const name = `riffle-trashundo-${process.pid}-${Date.now()}.txt`;
    const p = path.join(FIX, name);
    fs.writeFileSync(p, 'recycle me please\n');
    let r = await postApi('/api/trash', { path: p });
    assert.equal(r.status, 200);
    assert.equal(fs.existsSync(p), false, 'file still on disk after trash');
    r = await postApi('/api/undo', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(fs.existsSync(p), true, 'undo did not restore from recycle bin');
    assert.equal(fs.readFileSync(p, 'utf8'), 'recycle me please\n');
  });

  await binTest('batch trash (same group) undoes as one step', async () => {
    const n1 = `riffle-batch-${process.pid}-${Date.now()}-1.txt`;
    const n2 = `riffle-batch-${process.pid}-${Date.now()}-2.txt`;
    const p1 = path.join(FIX, n1), p2 = path.join(FIX, n2);
    fs.writeFileSync(p1, 'one\n');
    fs.writeFileSync(p2, 'two\n');
    await postApi('/api/trash', { path: p1, group: 'g-batch-test' });
    await postApi('/api/trash', { path: p2, group: 'g-batch-test' });
    assert.equal(fs.existsSync(p1), false);
    assert.equal(fs.existsSync(p2), false);
    const r = await postApi('/api/undo', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.restored.length, 2, 'both grouped items restored in one undo');
    assert.equal(fs.existsSync(p1), true);
    assert.equal(fs.existsSync(p2), true);
  });

  await binTest('case-only rename undoes back to the original casing (win32)', async () => {
    const a = path.join(FIX, 'casespelling-orig.txt');
    fs.writeFileSync(a, 'case me\n');
    let r = await postApi('/api/rename', { path: a, newName: 'CaseSpelling-ORIG.txt' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await postApi('/api/undo', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // read the directory listing: the exact original spelling must be back
    const names = fs.readdirSync(FIX);
    assert.ok(names.includes('casespelling-orig.txt'),
      'casing not restored; dir has: ' + names.filter(n => /casespelling/i.test(n)).join(','));
  });
});
