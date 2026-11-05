// tests/cli.test.mjs — zero-dependency tests for bin/riffledesk.js.
// Usage: node --test tests/cli.test.mjs
// Every case runs against a fake in-process server on a random port; no real
// server is spawned and no browser is launched (--print-url prints instead).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'riffledesk.js');
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-cli-'));
const FILE = path.join(TMP, 'note.md');
fs.writeFileSync(FILE, '# hello\n');

let server;
let port;
const hits = [];          // {method, url, headers, body}
let projectReply = { status: 200, data: { ok: true, delivered: 0 } };

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/api/drives') return json(res, 200, { ok: true, drives: [], roots: [], pinned: [] });
      if (u.pathname === '/api/project' && req.method === 'POST') return json(res, projectReply.status, projectReply.data);
      if (u.pathname === '/api/search') {
        const q = u.searchParams.get('q');
        const files = q === 'magic'
          ? [{ path: path.join(TMP, 'a.md'), mtime: 1700000000000, size: 12, hits: 2, snippet: 'magic here' },
             { path: path.join(TMP, 'b.md'), mtime: 1700000001000, size: 20, hits: 1, snippet: 'magic too' }]
          : [];
        return json(res, 200, { ok: true, path: u.searchParams.get('path'), q, files, scanned: 3, truncated: false, ms: 1, indexed: false });
      }
      return json(res, 404, { ok: false, error: 'unknown api' });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => {
  await new Promise(r => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

function run(args, env = {}) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [BIN, ...args], {
      cwd: TMP,
      env: { ...process.env, PORT: String(port), RIFFLEDESK_BROWSER_CMD: 'definitely-not-a-browser', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => resolve({ code, out, err }));
  });
}

const lastProject = () => [...hits].reverse().find(h => h.url.startsWith('/api/project'));

test('help is complete and exits 0', async () => {
  const top = await run(['--help']);
  assert.equal(top.code, 0);
  for (const word of ['open', 'search', '--line', '--limit', '--json', 'exit codes']) assert.match(top.out, new RegExp(word));
  const open = await run(['open', '--help']);
  assert.equal(open.code, 0);
  assert.match(open.out, /--print-url/);
  const search = await run(['search', '--help']);
  assert.equal(search.code, 0);
  assert.match(search.out, /--json/);
});

test('unknown subcommand and junk options print usage on stderr', async () => {
  const bad = await run(['frobnicate']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /unknown command/);
  assert.match(bad.err, /usage:/);
  const badOpt = await run(['open', FILE, '--wat']);
  assert.equal(badOpt.code, 2);
  assert.match(badOpt.err, /unknown option/);
  assert.match(badOpt.err, /usage: riffledesk open/);
  const badPort = await run(['search', 'x', '--port', 'many']);
  assert.equal(badPort.code, 2);
  assert.match(badPort.err, /bad value for --port/);
  const missingValue = await run(['search', 'x', '--in', '--json']);
  assert.equal(missingValue.code, 2);
  assert.match(missingValue.err, /missing value for --in/);
  const badLimit = await run(['search', 'x', '--limit', '5000']);
  assert.equal(badLimit.code, 2);
  assert.match(badLimit.err, /bad value for --limit/);
  const dashP = await run(['search', 'x', '-p', '5000']);
  assert.equal(dashP.code, 2);
  assert.match(dashP.err, /unknown option: -p/);
});

test('open: delivered>0 prints the count and does not open a browser', async () => {
  projectReply = { status: 200, data: { ok: true, delivered: 2 } };
  const r = await run(['open', FILE, '--line', '3', '--print-url'], { RIFFLEDESK_SOURCE: 'test-agent' });
  assert.equal(r.code, 0);
  assert.match(r.out, /pushed to 2 tab/);
  assert.doesNotMatch(r.out, /http:\/\/127\.0\.0\.1/);
  const p = lastProject();
  assert.equal(p.method, 'POST');
  assert.equal(p.headers['x-riffledesk-cli'], '1');
  assert.match(p.headers['content-type'], /application\/json/);
  const body = JSON.parse(p.body);
  assert.equal(body.path, FILE);
  assert.equal(body.line, 3);
  assert.equal(body.source, 'test-agent');
});

test('open: --line 0 is accepted (first line)', async () => {
  projectReply = { status: 200, data: { ok: true, delivered: 1 } };
  const r = await run(['open', FILE, '--line', '0', '--print-url']);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(lastProject().body).line, 0);
});

test('open: delivered 0 prints the /?open= URL', async () => {
  projectReply = { status: 200, data: { ok: true, delivered: 0 } };
  const r = await run(['open', FILE, '--print-url']);
  assert.equal(r.code, 0);
  const want = `http://127.0.0.1:${port}/?open=${encodeURIComponent(FILE)}`;
  assert.ok(r.out.includes(want), `expected ${want} in ${r.out}`);
});

test('open: 404 from an old server falls back to the URL', async () => {
  projectReply = { status: 404, data: { ok: false, error: 'unknown api' } };
  const r = await run(['open', FILE, '--print-url']);
  assert.equal(r.code, 0);
  assert.match(r.out, /\/\?open=/);
});

test('open: missing file exits 2 without calling the API', async () => {
  const before = hits.length;
  const r = await run(['open', path.join(TMP, 'nope.md'), '--print-url']);
  assert.equal(r.code, 2);
  assert.match(r.err, /no such file/);
  assert.equal(hits.length, before);
});

test('search: human output lists paths and mtimes', async () => {
  const r = await run(['search', 'magic']);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('a.md'));
  assert.ok(r.out.includes('b.md'));
  assert.match(r.out, /2023-11-14/);
});

test('search: --json emits a machine-readable array', async () => {
  const r = await run(['search', 'magic', '--json', '--in', TMP, '--ext', '.md', '--limit', '5']);
  assert.equal(r.code, 0);
  const arr = JSON.parse(r.out);
  assert.equal(arr.length, 2);
  assert.equal(arr[0].path, path.join(TMP, 'a.md'));
  const req = [...hits].reverse().find(h => h.url.startsWith('/api/search'));
  const u = new URL(req.url, 'http://x');
  assert.equal(u.searchParams.get('exts'), '.md');
  assert.equal(u.searchParams.get('limit'), '5');
  assert.equal(u.searchParams.get('path'), TMP);
});

test('search: -- terminates option parsing', async () => {
  const r = await run(['search', '--', '--weird']);
  assert.equal(r.code, 1); // fake server knows only "magic"
  const u = new URL([...hits].reverse().find(h => h.url.startsWith('/api/search')).url, 'http://x');
  assert.equal(u.searchParams.get('q'), '--weird');
});

test('search: --print-url prints only the URL', async () => {
  const r = await run(['search', 'magic', '--print-url']);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), `http://127.0.0.1:${port}/`);
});

test('search: no match exits 1', async () => {
  const txt = await run(['search', 'nothing-here']);
  assert.equal(txt.code, 1);
  const json = await run(['search', 'nothing-here', '--json']);
  assert.equal(json.code, 1);
  assert.deepEqual(JSON.parse(json.out), []);
});

test('search: missing query exits 2 with usage', async () => {
  const r = await run(['search']);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage:/);
});

test('RIFFLEDESK_PORT is honoured and wins over PORT', async () => {
  const viaOwn = await run(['search', 'magic', '--print-url'], { RIFFLEDESK_PORT: String(port), PORT: '1' });
  assert.equal(viaOwn.code, 0);
  assert.equal(viaOwn.out.trim(), `http://127.0.0.1:${port}/`, 'RIFFLEDESK_PORT must beat PORT');

  const viaPort = await run(['search', 'magic', '--print-url'], { RIFFLEDESK_PORT: '', PORT: String(port) });
  assert.equal(viaPort.code, 0);
  assert.equal(viaPort.out.trim(), `http://127.0.0.1:${port}/`, 'empty RIFFLEDESK_PORT falls back to PORT');
});

test('--port still beats both env vars', async () => {
  const r = await run(['search', 'magic', '--print-url', '--port', String(port)], { RIFFLEDESK_PORT: '1', PORT: '2' });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), `http://127.0.0.1:${port}/`);
});

test('help mentions RIFFLEDESK_PORT', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /RIFFLEDESK_PORT/);
});
