// tests/revise.test.mjs — POST /api/revise/save + the revise injection in /raw/.
// Spawns server.js on its own port against a temp fixture (never the repo config).
// Usage: node --test tests/revise.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5191;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffledesk-revise-'));
const FIX = path.join(TMP, 'fixture');
// a nonexistent drive letter is never in the allowed scopes (TEMP lives under the home dir)
const IS_WIN = process.platform === 'win32';
function outsideDir(rel) {
  if (!IS_WIN) return path.join('/no/such/riffle', rel);
  for (let i = 90; i >= 68; i--) {
    const letter = String.fromCharCode(i);
    if (!fs.existsSync(letter + ':/')) return letter + ':/' + rel;
  }
  throw new Error('no free drive letter');
}
const OUTSIDE = outsideDir('outdir');
fs.mkdirSync(FIX, { recursive: true });
try { fs.mkdirSync(OUTSIDE, { recursive: true }); } catch (_) {}
const OUT_PAGE = path.join(OUTSIDE, 'out.html');
try { fs.writeFileSync(OUT_PAGE, '<p>out</p>'); } catch (_) {}
const PAGE = path.join(FIX, 'page.html');
const MD = path.join(FIX, 'note.md');
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PAGE_HTML = '<!doctype html><html><head><title>t</title></head><body><h1 data-rd-id="h">Hi</h1><p>para</p><canvas id="c" width="40" height="20"></canvas><script>window.RAN=1;</script></body></html>';
fs.writeFileSync(PAGE, PAGE_HTML);
fs.writeFileSync(MD, '# not html\n');

const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [FIX], pinned: [], convoRoots: [] }, null, 2));

// Browsable scope: on POSIX it is home + mounts and os.tmpdir() is outside it,
// while on Windows the temp dir just happens to sit on an allowed drive. The
// server therefore gets TMP and the repo (for the public/ revise agent the
// token points at) as extra "drives" through the test-only RIFFLEDESK_TEST_DRIVES
// hook (collectDrives in server.js). OUTSIDE keeps pointing at a path on no
// drive at all, so the out-of-scope test below stays meaningful, and FIX remains
// the only indexed root.
const DRIVES = [TMP, ROOT, process.env.RIFFLEDESK_TEST_DRIVES].filter(Boolean).join(path.delimiter);

let proc;
function startServer() {
  proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', RIFFLEDESK_TEST_DRIVES: DRIVES, PORT: String(PORT), FLODER_CONFIG: CFG, RIFFLEDESK_INDEX: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const to = setTimeout(() => reject(new Error('server start timeout: ' + out)), 20000);
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) { clearTimeout(to); resolve(); } });
    proc.stderr.on('data', d => { out += d; });
  });
}

function request(method, p, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length, origin: ORIGIN } : {}),
        ...(headers || {})
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, body: json, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

const save = (body, headers) => request('POST', '/api/revise/save', { body, headers });

function baseChanges() {
  return [
    { op: 'edit-text', rdId: 'h', selector: '[data-rd-id="h"]', textHint: 'Hi', before: 'Hi', after: 'Hello', rect: { x: 1, y: 2, w: 30, h: 12 }, dx: null, dy: null, w: null, h: null, note: null },
    { op: 'move', rdId: null, selector: 'body > p:nth-of-type(1)', textHint: 'para', dx: 12, dy: -4, rect: { x: 3, y: 20, w: 40, h: 10 } },
    { op: 'delete', rdId: null, selector: 'body > p:nth-of-type(1)', textHint: 'para', rect: { x: 3, y: 20, w: 40, h: 10 } },
    { op: 'note', rdId: 'h', selector: '[data-rd-id="h"]', textHint: 'Hi', note: 'make it blue', rect: { x: 1, y: 2, w: 30, h: 12 } },
    { op: 'region-note', rdId: null, selector: '', note: 'redraw the canvas', rect: { x: 5, y: 40, w: 60, h: 30 } }
  ];
}

await startServer();

function cleanupOutputs() {
  for (const p of [PAGE + '.changes.json', PAGE + '.changes.png', PAGE + '.changes.prev.json']) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
}

test('saves a change list with every contract field and the screenshot', async () => {
  cleanupOutputs();
  const summary = '① 把「Hi」改成「Hello」\n② 移動段落\n③ 刪除段落\n④ 加註：make it blue\n⑤ 框選：redraw the canvas';
  const r = await save({ path: PAGE, changes: baseChanges(), png: 'data:image/png;base64,' + PNG_1PX, summary });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.json, PAGE + '.changes.json');

  const doc = JSON.parse(fs.readFileSync(PAGE + '.changes.json', 'utf8'));
  assert.equal(doc.version, 1);
  assert.equal(doc.file, PAGE);
  assert.equal(typeof doc.createdAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(doc.createdAt)));
  assert.equal(doc.status, 'pending');
  assert.equal(doc.screenshot, 'page.html.changes.png');
  assert.equal(doc.summary, summary);
  assert.equal(doc.items.length, 5);
  const keys = ['n', 'op', 'rdId', 'selector', 'textHint', 'before', 'after', 'note', 'rect', 'dx', 'dy', 'w', 'h'];
  doc.items.forEach((it, i) => {
    assert.deepEqual(Object.keys(it).sort(), [...keys].sort(), 'item ' + i + ' has exactly the contract fields');
    assert.equal(it.n, i + 1);
    assert.ok(['edit-text', 'move', 'resize', 'delete', 'note', 'region-note'].includes(it.op));
    assert.equal(typeof it.rect.x, 'number');
    assert.ok(it.rect && ['x', 'y', 'w', 'h'].every(k => typeof it.rect[k] === 'number'));
  });
  assert.equal(doc.items[0].op, 'edit-text');
  assert.equal(doc.items[4].op, 'region-note');
  assert.equal(doc.items[1].dx, 12);
  assert.equal(doc.items[1].dy, -4);

  // screenshot really landed as a PNG
  assert.equal(r.body.png, PAGE + '.changes.png');
  const png = fs.readFileSync(PAGE + '.changes.png');
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('a second save keeps exactly one .changes.prev.json generation', async () => {
  cleanupOutputs();
  const first = await save({ path: PAGE, changes: baseChanges(), png: null, summary: 'first' });
  assert.equal(first.status, 200, first.text);
  assert.equal(fs.existsSync(PAGE + '.changes.prev.json'), false, 'no backup on the first save');

  const second = await save({ path: PAGE, changes: [{ op: 'delete', selector: 'x', rect: { x: 0, y: 0, w: 1, h: 1 } }], png: null, summary: 'second' });
  assert.equal(second.status, 200, second.text);
  const prev = JSON.parse(fs.readFileSync(PAGE + '.changes.prev.json', 'utf8'));
  assert.equal(prev.summary, 'first');
  const cur = JSON.parse(fs.readFileSync(PAGE + '.changes.json', 'utf8'));
  assert.equal(cur.summary, 'second');
  assert.equal(cur.screenshot, null);

  const third = await save({ path: PAGE, changes: [{ op: 'delete', selector: 'x', rect: { x: 0, y: 0, w: 1, h: 1 } }], png: null, summary: 'third' });
  assert.equal(third.status, 200, third.text);
  assert.equal(JSON.parse(fs.readFileSync(PAGE + '.changes.prev.json', 'utf8')).summary, 'second', 'only one generation is kept');
});

test('png:null stores screenshot null and no png file', async () => {
  cleanupOutputs();
  const r = await save({ path: PAGE, changes: baseChanges(), png: null, summary: 's' });
  assert.equal(r.status, 200);
  assert.equal(r.body.png, null);
  assert.equal(fs.existsSync(PAGE + '.changes.png'), false);
  assert.equal(JSON.parse(fs.readFileSync(PAGE + '.changes.json', 'utf8')).screenshot, null);
});

test('refuses a non-html target', async () => {
  const r = await save({ path: MD, changes: baseChanges(), png: null });
  assert.equal(r.status, 415);
  assert.equal(r.body.ok, false);
});

test('refuses a path outside the allowed scopes', async () => {
  const r = await save({ path: OUT_PAGE, changes: baseChanges(), png: null });
  assert.equal(r.status, 403, JSON.stringify(r.body));
});

test('refuses a missing file', async () => {
  const r = await save({ path: path.join(FIX, 'nope.html'), changes: baseChanges(), png: null });
  assert.equal(r.status, 404);
});

test('refuses a cross-site Origin', async () => {
  cleanupOutputs();
  const r = await save({ path: PAGE, changes: baseChanges(), png: null }, { origin: 'http://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(fs.existsSync(PAGE + '.changes.json'), false);
});

test('refuses a non-json content type', async () => {
  const buf = Buffer.from(JSON.stringify({ path: PAGE, changes: baseChanges() }));
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/revise/save', method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': buf.length, origin: ORIGIN } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end(buf);
  });
  assert.equal(r.status, 415);
});

test('refuses an oversized body', async () => {
  const r = await save({ path: PAGE, changes: baseChanges(), png: 'data:image/png;base64,' + 'A'.repeat(26 * 1024 * 1024) });
  assert.equal(r.status, 413);
});

test('refuses a list with no valid items', async () => {
  const r = await save({ path: PAGE, changes: [{ op: 'bogus', selector: 'x' }], png: null });
  assert.equal(r.status, 400);
});

test('clamps an oversized png to null instead of failing the save', async () => {
  cleanupOutputs();
  const big = 'data:image/png;base64,' + Buffer.alloc(9 * 1024 * 1024, 1).toString('base64');
  const r = await save({ path: PAGE, changes: baseChanges(), png: big, summary: 'big' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.png, null);
  assert.equal(fs.existsSync(PAGE + '.changes.png'), false);
});

test('/raw/ with revise=1 injects the agent right before </body> and keeps the page', async () => {
  const mint = await request('GET', '/api/rawopen?path=' + encodeURIComponent(PAGE) + '&revise=1');
  assert.equal(mint.status, 200);
  const url = mint.body.url;
  assert.match(url, /\?revise=1$/);
  const page = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: url }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    }).on('error', reject);
  });
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1 data-rd-id="h">Hi<\/h1>/);
  const injectAt = page.text.indexOf('/public/revise-agent.js');
  assert.ok(injectAt > 0, 'agent script is injected');
  assert.ok(page.text.indexOf('revise-agent.js') < page.text.indexOf('</body>'), 'injected before </body>');
  // page scripts are stripped by default
  assert.ok(!/window\.RAN/.test(page.text) || !/<script>window/.test(page.text), 'no inline page script');

  // the agent itself is reachable through the same token
  const agentUrl = page.text.match(/src="([^"]*revise-agent\.js[^"]*)"/)[1];
  const agent = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: agentUrl.replace(/&amp;/g, '&') }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
  assert.equal(agent.status, 200);
  assert.match(agent.text, /postMessage/);
});

test('/raw/ with revise=1&run=1 keeps the page scripts', async () => {
  const mint = await request('GET', '/api/rawopen?path=' + encodeURIComponent(PAGE) + '&revise=1&run=1');
  const url = mint.body.url;
  const page = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: url }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
  assert.match(page, /window\.RAN=1/);
  assert.match(page, /revise-agent\.js/);
});

test('/raw/ without revise does not inject the agent', async () => {
  const mint = await request('GET', '/api/rawopen?path=' + encodeURIComponent(PAGE));
  const page = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: mint.body.url }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
  assert.ok(!page.includes('revise-agent.js'));
});

after(() => {
  try { proc && proc.kill(); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

