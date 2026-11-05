// tests/raw.test.mjs — /raw/ route: the serving layer behind the reader's
// "run page scripts" mode. Zero dependencies; spawns server.js on port 5189
// against a temp fixture (never touches the repo config).
//
// /raw/ URLs are capability-tokened: /raw/<token>/<encoded abs path>, where the
// token is minted by same-origin-only GET /api/rawopen and scoped to the opened
// file's directory tree plus paths the file:/// rewrite registered for it.
// Usage: node --test tests/raw.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const PORT = 5189;
const BASE = `http://127.0.0.1:${PORT}`;

const require2 = createRequire(import.meta.url);
const srv = require2(path.join(ROOT, 'server.js')); // exports (no listener until start())

// ---------- temp fixture ----------
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-raw-'));
const FIX = path.join(TMP, 'fixture');
fs.mkdirSync(path.join(FIX, 'web'), { recursive: true });
fs.mkdirSync(path.join(FIX, 'lib'), { recursive: true });
fs.mkdirSync(path.join(FIX, 'unrelated'), { recursive: true });

const DEP_ABS = path.join(FIX, 'lib', 'dep.mjs');        // sibling tree of web/ — outside the token's dir
const PAGE_ABS = path.join(FIX, 'web', 'page.html');
const CSS_ABS = path.join(FIX, 'web', 'style.css');
const JSON_ABS = path.join(FIX, 'web', 'data.json');
const PNG_ABS = path.join(FIX, 'web', 'pic.png');
const SECRET_ABS = path.join(FIX, 'unrelated', 'secret.md'); // never referenced by the page

// drives used to build guaranteed-out-of-scope file:/// targets (a drive letter
// that does not exist is never in the allowed scopes)
function nonexistentDrivePath(rel) {
  if (!IS_WIN) return '/no/such/riffle-' + rel;
  for (let i = 90; i >= 68; i--) { // Z .. D
    const letter = String.fromCharCode(i);
    if (!fs.existsSync(letter + ':\\')) return letter + ':\\' + rel.split('/').join('\\');
  }
  throw new Error('expected at least one nonexistent drive letter');
}
const OUTSIDE = nonexistentDrivePath('nope/secret.css');

const fileUrl = p => 'file:///' + p.replace(/\\/g, '/');
const fileUrlBackslash = p => 'file:///' + p; // keep backslashes (Windows form)

fs.writeFileSync(DEP_ABS, 'export const painted = true;\n');
fs.writeFileSync(CSS_ABS, `body { background: url("${fileUrl(PNG_ABS)}"); }\n`);
fs.writeFileSync(JSON_ABS, `{"note":"${fileUrl(DEP_ABS)} must stay verbatim — json is not rewritten"}`);
fs.writeFileSync(PNG_ABS, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
fs.writeFileSync(SECRET_ABS, '# unrelated folder, never referenced\n');
fs.writeFileSync(PAGE_ABS, [
  '<!doctype html>',
  '<meta charset="utf-8">',
  '<link rel="stylesheet" href="./style.css">',
  '<script type="module">',
  `import { painted } from '${fileUrl(DEP_ABS)}';`,
  `import '${fileUrlBackslash(DEP_ABS)}';`,
  `document.title = painted ? 'ran' : 'no';`,
  `// outside scope must NOT be rewritten: ${fileUrl(OUTSIDE)}`,
  '</' + 'script>',
  ''
].join('\n'));

const CONFIG_PATH = path.join(TMP, 'config.json');
fs.writeFileSync(CONFIG_PATH, JSON.stringify({ roots: [FIX], pinned: [] }, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function startServer(extraEnv = {}) {
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: CONFIG_PATH, RIFFLEDESK_INDEX: 'off', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let out = '';
  const startDeadline = Date.now() + 10000;
  const ready = () => out.includes('listening');
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  while (!ready()) {
    if (exited) throw new Error('server exited early: ' + out);
    if (Date.now() > startDeadline) throw new Error('server start timeout: ' + out);
    await sleep(25);
  }
  return proc;
}
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

let proc = null;
after(async () => {
  if (proc) { try { proc.kill(); } catch (_) {} }
  await waitPortFree(PORT);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

let TOKEN = '';                                     // 由 /api/rawopen 拿到的 capability token
const rawUrl = abs => srv.rawUrlFor(abs, TOKEN);    // /raw/<token>/<encoded abs path>

test('raw route', async (t) => {
  proc = await startServer();

  await t.test('rawopen mints a 128-bit hex token for the opened file', async () => {
    const r = await fetch(BASE + '/api/rawopen?path=' + encodeURIComponent(PAGE_ABS));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.match(j.token, /^[0-9a-f]{32}$/);
    assert.ok(j.url.startsWith('/raw/' + j.token + '/'), j.url);
    TOKEN = j.token;
  });

  await t.test('path codec round-trips (windows drive + posix root)', () => {
    const u = rawUrl(PAGE_ABS);
    assert.ok(u.startsWith('/raw/' + TOKEN + '/'), u);
    const tail = u.slice(('/raw/' + TOKEN + '/').length);
    if (IS_WIN) {
      assert.equal(srv.rawPathToAbs(tail).toLowerCase(), PAGE_ABS.toLowerCase());
    } else {
      assert.ok(tail.startsWith('/'), 'posix abs keeps a leading slash: ' + u);
      assert.equal(srv.rawPathToAbs(tail), PAGE_ABS);
    }
  });

  await t.test('missing/wrong/malformed token always answers a plain 404 (no oracle)', async () => {
    // (1) no token at all
    const bare = await fetch(BASE + '/raw/' + srv.rawPathFor(PAGE_ABS));
    assert.equal(bare.status, 404);
    // well-formed but never minted
    const wrong = await fetch(BASE + srv.rawUrlFor(PAGE_ABS, '0'.repeat(32)));
    assert.equal(wrong.status, 404);
    // malformed token shape
    const bad = await fetch(BASE + srv.rawUrlFor(PAGE_ABS, 'abc'));
    assert.equal(bad.status, 404);
    // write with a wrong token is 404 too (capability checked before method)
    const wpost = await fetch(BASE + srv.rawUrlFor(PAGE_ABS, '1'.repeat(32)), { method: 'POST' });
    assert.equal(wpost.status, 404);
  });

  await t.test('token scope: unrelated folder is 404 even with a valid token', async () => {
    // (2) token opened for fixture/web cannot read fixture/unrelated/secret.md
    const r = await fetch(BASE + rawUrl(SECRET_ABS));
    assert.equal(r.status, 404);
    // and the sibling lib dep is not reachable either — until the page's file:///
    // rewrite has registered it (tested below)
    const dep = await fetch(BASE + rawUrl(DEP_ABS));
    assert.equal(dep.status, 404);
  });

  await t.test('html served with text/html + CORS/CORP headers for opaque origins', async () => {
    const r = await fetch(BASE + rawUrl(PAGE_ABS));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/html/);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'cross-origin');
  });

  await t.test('js module served with a JavaScript MIME (module scripts require it)', async () => {
    // fetch the page first so the rewrite registers the dep in this token's allowlist
    await (await fetch(BASE + rawUrl(PAGE_ABS))).text();
    const r = await fetch(BASE + rawUrl(DEP_ABS));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.equal(await r.text(), 'export const painted = true;\n');
  });

  await t.test('binary (png) streamed with image MIME, unmodified bytes', async () => {
    const r = await fetch(BASE + rawUrl(PNG_ABS));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await r.arrayBuffer());
    assert.deepEqual(buf, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  await t.test('file:/// URLs rewritten to tokened /raw/ URLs in html (forward and back slashes)', async () => {
    const body = await (await fetch(BASE + rawUrl(PAGE_ABS))).text();
    assert.ok(body.includes(`from '${rawUrl(DEP_ABS)}'`), 'forward-slash file:/// rewritten:\n' + body);
    assert.ok(body.includes(`import '${rawUrl(DEP_ABS)}'`), 'backslash file:/// rewritten:\n' + body);
    assert.ok(!body.toLowerCase().includes(fileUrl(PAGE_ABS).toLowerCase()));
    // out-of-scope target stays untouched (not in allowed scopes → not rewritten)
    assert.ok(body.includes(fileUrl(OUTSIDE)), 'out-of-scope file:/// left alone');
  });

  await t.test('file:/// URLs rewritten inside css url()', async () => {
    const r = await fetch(BASE + rawUrl(CSS_ABS));
    assert.match(r.headers.get('content-type'), /^text\/css/);
    const body = await r.text();
    assert.ok(body.includes(`url("${rawUrl(PNG_ABS)}")`), body);
  });

  await t.test('non-text types are NOT rewritten (json stays verbatim)', async () => {
    const body = await (await fetch(BASE + rawUrl(JSON_ABS))).text();
    assert.ok(body.includes(fileUrl(DEP_ABS)), body);
  });

  await t.test('scope refusal: paths outside allowed scopes still get 403 with a valid token', async () => {
    const r = await fetch(BASE + rawUrl(nonexistentDrivePath('escape/hax.html')));
    assert.equal(r.status, 403);
    // and /api/file rules still apply the same scope gate for the same path
    const r2 = await fetch(BASE + '/api/file?path=' + encodeURIComponent(nonexistentDrivePath('escape/hax.html')));
    assert.equal(r2.status, 403);
  });

  await t.test('missing file 404 / directory 400 (under a valid token)', async () => {
    const r404 = await fetch(BASE + rawUrl(path.join(FIX, 'web', 'no-such.html')));
    assert.equal(r404.status, 404);
    const r400 = await fetch(BASE + rawUrl(path.join(FIX, 'web')));
    assert.equal(r400.status, 400);
  });

  await t.test('POST to /raw/ is refused (GET-only serving)', async () => {
    const r = await fetch(BASE + rawUrl(PAGE_ABS), { method: 'POST' });
    assert.equal(r.status, 405);
  });

  await t.test('cross-site pages without the token cannot read /api/ either', async () => {
    // the opaque sandbox iframe sends Origin:null + Sec-Fetch-Site: cross-site;
    // that signature must NOT unlock the JSON APIs (they mint tokens!)
    const r = await fetch(BASE + '/api/rawopen?path=' + encodeURIComponent(PAGE_ABS), {
      headers: { 'sec-fetch-site': 'cross-site', origin: 'null' }
    });
    assert.equal(r.status, 403);
    const r2 = await fetch(BASE + '/api/file?path=' + encodeURIComponent(SECRET_ABS), {
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }
    });
    assert.equal(r2.status, 403);
  });

  await t.test('sandboxed page cannot write: POST /api/rename with Origin null → 403', async () => {
    // An opaque-origin iframe (the /raw/ sandbox) sends Origin: null — exactly
    // this header. The write endpoints must reject all three variants.
    const victim = path.join(FIX, 'victim.md');
    fs.writeFileSync(victim, '# victim\n');
    for (const origin of ['null', undefined, 'http://evil.example']) {
      const headers = { 'content-type': 'application/json' };
      if (origin !== undefined) headers.origin = origin;
      const r = await fetch(BASE + '/api/rename', {
        method: 'POST', headers,
        body: JSON.stringify({ path: victim, newName: 'pwned.md' })
      });
      assert.equal(r.status, 403, `origin ${origin}`);
      for (const ep of ['/api/trash', '/api/undo', '/api/index/content']) {
        const r2 = await fetch(BASE + ep, {
          method: 'POST', headers,
          body: JSON.stringify(ep === '/api/trash' ? { path: victim } : {})
        });
        assert.equal(r2.status, 403, `${ep} origin ${origin}`);
      }
    }
    assert.ok(fs.existsSync(victim), 'victim file untouched');
    assert.ok(!fs.existsSync(path.join(FIX, 'pwned.md')), 'no rename happened');
  });
});
