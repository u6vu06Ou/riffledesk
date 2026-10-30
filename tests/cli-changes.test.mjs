// tests/cli-changes.test.mjs — zero-dependency tests for the `changes`/`wait`
// CLI subcommands (bin/riffledesk.js). Disk only: no server, no browser.
// Usage: node --test tests/cli-changes.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'riffledesk.js');
let TMP;

before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffledesk-changes-')); });
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

let seq = 0;
// A fresh html file per test so the sibling .changes.json never collides.
function makePage() {
  const dir = path.join(TMP, `case-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'page.html');
  fs.writeFileSync(file, '<p>hi</p>\n');
  return file;
}

function listPath(file) { return `${file}.changes.json`; }

function writeList(file, overrides = {}) {
  fs.writeFileSync(listPath(file), JSON.stringify({
    version: 1,
    file,
    createdAt: new Date().toISOString(),
    status: 'pending',
    screenshot: null,
    summary: '把標題改大\n把按鈕右移',
    items: [
      { n: 1, op: 'edit-text', rdId: 'rd-7', selector: '#title', textHint: '舊標題', before: '舊標題', after: '新標題', note: '改大' },
      { n: 2, op: 'move', selector: '.btn', dx: 20, dy: 0 }
    ],
    ...overrides
  }, null, 2));
}

function run(args) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [BIN, ...args], {
      cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, RIFFLEDESK_BROWSER_CMD: 'definitely-not-a-browser' }
    });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    const started = Date.now();
    proc.on('close', code => resolve({ code, out, err, ms: Date.now() - started }));
  });
}

test('help documents both subcommands in English', async () => {
  for (const args of [['--help'], ['changes', '--help'], ['wait', '--help']]) {
    const r = await run(args);
    assert.equal(r.code, 0);
    assert.match(r.out, /--json/);
  }
  const top = await run(['--help']);
  assert.match(top.out, /changes <html>/);
  assert.match(top.out, /--timeout/);
});

test('changes: readable output carries locators, before/after and note', async () => {
  const file = makePage();
  const shot = `${file}.changes.png`;
  fs.writeFileSync(shot, 'png');
  writeList(file, { screenshot: 'page.html.changes.png' });
  const r = await run(['changes', file]);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes(file));
  assert.match(r.out, /status:\s+pending/);
  assert.ok(r.out.includes(shot), 'absolute screenshot path');
  assert.match(r.out, /舊標題/);
  assert.match(r.out, /rdId=rd-7/);
  assert.match(r.out, /selector=\.btn/);
  assert.match(r.out, /before: 舊標題/);
  assert.match(r.out, /after:\s+新標題/);
  assert.match(r.out, /note:\s+改大/);
  assert.match(r.out, /dx=20/);
  assert.doesNotMatch(r.out, /already handled/);
});

test('changes: --json prints the raw list', async () => {
  const file = makePage();
  writeList(file);
  const r = await run(['changes', file, '--json']);
  assert.equal(r.code, 0);
  const data = JSON.parse(r.out);
  assert.equal(data.version, 1);
  assert.equal(data.items.length, 2);
});

test('changes: no list exits 1 with a stderr note', async () => {
  const file = makePage();
  const r = await run(['changes', file]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no revamp list/);
});

test('changes: missing html file exits 2', async () => {
  const r = await run(['changes', path.join(TMP, 'nope.html')]);
  assert.equal(r.code, 2);
  assert.match(r.err, /no such file/);
});

test('changes: broken JSON and unknown version exit 2', async () => {
  const broken = makePage();
  fs.writeFileSync(listPath(broken), '{"version":1,');
  const r1 = await run(['changes', broken]);
  assert.equal(r1.code, 2);
  assert.match(r1.err, /invalid JSON/);

  const old = makePage();
  writeList(old, { version: 7 });
  const r2 = await run(['changes', old]);
  assert.equal(r2.code, 2);
  assert.match(r2.err, /unsupported revamp list version/);
});

test('changes: an already done list prints with a marker and exits 0', async () => {
  const file = makePage();
  writeList(file, { status: 'done' });
  const r = await run(['changes', file]);
  assert.equal(r.code, 0);
  assert.match(r.out.split('\n')[0], /already handled/);
});

test('changes --done flips the status atomically and keeps valid JSON', async () => {
  const file = makePage();
  writeList(file);
  const r = await run(['changes', file, '--done']);
  assert.equal(r.code, 0);
  assert.match(r.out, /marked done/);
  const data = JSON.parse(fs.readFileSync(listPath(file), 'utf8'));
  assert.equal(data.status, 'done');
  assert.equal(data.items.length, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(n => n.startsWith('.rdtmp-')), []);
});

test('changes --done on an already done list stays done', async () => {
  const file = makePage();
  writeList(file, { status: 'done' });
  const r = await run(['changes', file, '--done']);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(listPath(file), 'utf8')).status, 'done');
});

test('changes: --done with --json is rejected', async () => {
  const file = makePage();
  writeList(file);
  const r = await run(['changes', file, '--done', '--json']);
  assert.equal(r.code, 2);
  assert.match(r.err, /cannot be combined/);
});

test('changes: malformed items exit 2 instead of crashing', async () => {
  const nullItem = makePage();
  fs.writeFileSync(listPath(nullItem), JSON.stringify({ version: 1, status: 'pending', items: [null] }));
  const r1 = await run(['changes', nullItem]);
  assert.equal(r1.code, 2);
  assert.match(r1.err, /item 0 is not an object/);

  const notArray = makePage();
  fs.writeFileSync(listPath(notArray), JSON.stringify({ version: 1, status: 'pending', items: {} }));
  const r2 = await run(['changes', notArray]);
  assert.equal(r2.code, 2);
  assert.match(r2.err, /items is not an array/);
});

test('changes: multi-line before/after stay aligned', async () => {
  const file = makePage();
  writeList(file, { items: [{ n: 1, op: 'edit-text', selector: '#a', before: 'one\ntwo', after: 'x\ny' }] });
  const r = await run(['changes', file]);
  assert.equal(r.code, 0);
  assert.match(r.out, /before: one/);
  assert.match(r.out, /before: one\n\s+two/);
  assert.match(r.out, /after:  x\n\s+y/);
});

test('wait: returns a list written after the command started', async () => {
  const file = makePage();
  const pending = run(['wait', file, '--timeout', '10']);
  await new Promise(r => setTimeout(r, 700));
  writeList(file);
  const r = await pending;
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(file));
  assert.match(r.out, /rdId=rd-7/);
});

test('wait: retries a half-written JSON file instead of crashing', async () => {
  const file = makePage();
  const pending = run(['wait', file, '--timeout', '10', '--json']);
  await new Promise(r => setTimeout(r, 500));
  const full = JSON.stringify({ version: 1, file, createdAt: new Date().toISOString(), status: 'pending', screenshot: null, summary: 'x', items: [] });
  fs.writeFileSync(listPath(file), full.slice(0, Math.floor(full.length / 2)));
  await new Promise(r => setTimeout(r, 1500));
  fs.writeFileSync(listPath(file), full);
  const r = await pending;
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).version, 1);
});

test('wait: ignores a stale list and a done list, then times out with 3', async () => {
  const stale = makePage();
  writeList(stale, { createdAt: '2020-01-01T00:00:00.000Z' });
  fs.utimesSync(listPath(stale), new Date('2020-01-01'), new Date('2020-01-01'));
  const r1 = await run(['wait', stale, '--timeout', '2']);
  assert.equal(r1.code, 3);
  assert.match(r1.err, /timed out/);

  const done = makePage();
  const pending = run(['wait', done, '--timeout', '3']);
  await new Promise(r => setTimeout(r, 400));
  writeList(done, { status: 'done' });
  const r2 = await pending;
  assert.equal(r2.code, 3);
});

test('wait: bad usage exits 2', async () => {
  const r = await run(['wait', '--timeout', 'nope', 'x.html']);
  assert.equal(r.code, 2);
  assert.match(r.err, /bad value for --timeout/);
});
