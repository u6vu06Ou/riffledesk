// tests/cli-show.test.mjs — tests for `riffledesk show` (bin/riffledesk.js).
// A fake in-process server stands in for the real one; no browser is launched
// (--print-url prints the URL instead). Port is random.
// Usage: node --test tests/cli-show.test.mjs
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
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-show-'));
const A = path.join(TMP, 'a.md');
const B = path.join(TMP, 'b.md');
fs.writeFileSync(A, '# a\n');
fs.writeFileSync(B, '# b\n');

let server;
let port;
const hits = [];          // {method, url, headers, body}
let pileReply = () => ({ status: 200, data: { ok: true, delivered: 0, id: 'abc123', count: 2 } });

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
      if (u.pathname === '/api/pile' && req.method === 'POST') {
        const r = pileReply(JSON.parse(raw));
        return json(res, r.status, r.data);
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

function run(args, stdin = null) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [BIN, ...args], {
      cwd: TMP,
      env: { ...process.env, PORT: String(port), RIFFLEDESK_BROWSER_CMD: 'definitely-not-a-browser' },
      stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    if (stdin !== null) { proc.stdin.end(stdin); }
    proc.on('close', code => resolve({ code, out, err }));
  });
}

const lastPile = () => [...hits].reverse().find(h => h.url.startsWith('/api/pile'));

test('help documents show and its flags', async () => {
  const top = await run(['--help']);
  assert.equal(top.code, 0);
  assert.match(top.out, /show <file\.\.\.>/);
  assert.match(top.out, /--title/);
  const own = await run(['show', '--help']);
  assert.equal(own.code, 0);
  assert.match(own.out, /usage: riffledesk show/);
  assert.match(own.out, /stdin/);
});

test('two files are posted as one pile with the CLI header', async () => {
  pileReply = () => ({ status: 200, data: { ok: true, delivered: 2, id: 'p1', count: 2 } });
  const r = await run(['show', A, B, '--title', 'Two notes', '--print-url']);
  assert.equal(r.code, 0);
  assert.match(r.out, /showing 2 file\(s\) in 2 tab/);
  const p = lastPile();
  assert.equal(p.method, 'POST');
  assert.equal(p.headers['x-riffledesk-cli'], '1');
  const body = JSON.parse(p.body);
  assert.deepEqual(body.paths, [A, B]);
  assert.equal(body.title, 'Two notes');
  assert.equal(body.source, 'cli');
});

test('RIFFLEDESK_SOURCE labels the pile', async () => {
  pileReply = () => ({ status: 200, data: { ok: true, delivered: 1, id: 'p2', count: 1 } });
  const r = await run(['show', A], null);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(lastPile().body).source, 'cli');
});

test('duplicates collapse before anything is sent', async () => {
  pileReply = () => ({ status: 200, data: { ok: true, delivered: 1, id: 'p3', count: 1 } });
  const r = await run(['show', A, A, path.join(TMP, '.', 'a.md')]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(lastPile().body).paths, [A]);
});

test('a missing path is reported on stderr but the rest still go', async () => {
  pileReply = () => ({ status: 200, data: { ok: true, delivered: 1, id: 'p4', count: 1 } });
  const gone = path.join(TMP, 'nope.md');
  const r = await run(['show', gone, A]);
  assert.equal(r.code, 0);
  assert.match(r.err, /skipped \(missing\)/);
  assert.deepEqual(JSON.parse(lastPile().body).paths, [A]);
});

test('a directory is skipped too', async () => {
  pileReply = () => ({ status: 200, data: { ok: true, delivered: 1, id: 'p5', count: 1 } });
  const r = await run(['show', TMP, A]);
  assert.equal(r.code, 0);
  assert.match(r.err, /skipped/);
  assert.deepEqual(JSON.parse(lastPile().body).paths, [A]);
});

test('no usable file exits 2 without calling the API', async () => {
  const before = hits.length;
  const r = await run(['show', path.join(TMP, 'nope.md')]);
  assert.equal(r.code, 2);
  assert.match(r.err, /no usable file/);
  assert.match(r.err, /usage: riffledesk show/);
  assert.equal(hits.length, before);
});

test('a bare show with no arguments exits 2', async () => {
  const r = await run(['show']);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: riffledesk show/);
});

test('over 500 files: the first 500 are sent, the rest reported', async () => {
  pileReply = b => ({ status: 200, data: { ok: true, delivered: 1, id: 'p6', count: b.paths.length } });
  // 502 paths do not fit in a Windows command line: feed them on stdin instead
  const dir = path.join(TMP, 'many');
  fs.mkdirSync(dir, { recursive: true });
  const names = Array.from({ length: 502 }, (_, i) => {
    const f = path.join(dir, `f${i}.md`);
    fs.writeFileSync(f, 'x\n');
    return f;
  });
  const r = await run(['show'], names.join('\n') + '\n');
  assert.equal(r.code, 0);
  const sent = JSON.parse(lastPile().body).paths;
  assert.equal(sent.length, 500);
  assert.deepEqual(sent, names.slice(0, 500));
  assert.match(r.err, /over the 500-file cap/);
  assert.match(r.err, /f500\.md/);
  assert.match(r.err, /f501\.md/);
});

test('stdin: one path per line', async () => {
  pileReply = () => ({ status: 200, data: { ok: true, delivered: 1, id: 'p7', count: 2 } });
  const r = await run(['show'], `${A}\n${B}\n`);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(lastPile().body).paths, [A, B]);
});

test('stdin: a JSON array from "search --json" is understood', async () => {
  pileReply = () => ({ status: 200, data: { ok: true, delivered: 1, id: 'p8', count: 2 } });
  const payload = JSON.stringify([{ path: A, mtime: 1, size: 2, hits: 1 }, { path: B, mtime: 1, size: 2, hits: 1 }]);
  const r = await run(['show', '--json'], payload);
  assert.equal(r.code, 0);
  const body = JSON.parse(lastPile().body);
  assert.deepEqual(body.paths, [A, B]);
  assert.equal(body.title, undefined, 'no title sent unless asked');
  const printed = JSON.parse(r.out);
  assert.equal(printed.ok, true);
  assert.equal(printed.id, 'p8');
  assert.equal(printed.count, 2);
});

test('stdin and arguments are merged, arguments first', async () => {
  pileReply = () => ({ status: 200, data: { ok: true, delivered: 1, id: 'p9', count: 2 } });
  const r = await run(['show', B], `${A}\n`);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(lastPile().body).paths, [B, A]);
});

test('--stdin waits when stdin is a terminal-like empty pipe', async () => {
  const r = await run(['show', '--stdin', A], '');
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(lastPile().body).paths, [A]);
});

test('delivered 0 prints the /?pile= URL', async () => {
  pileReply = () => ({ status: 200, data: { ok: true, delivered: 0, id: 'pz', count: 1 } });
  const r = await run(['show', A, '--print-url']);
  assert.equal(r.code, 0);
  const want = `http://127.0.0.1:${port}/?pile=pz`;
  assert.ok(r.out.includes(want), `expected ${want} in ${r.out}`);
  assert.match(r.err, /no browser tab connected/);
});

test('a server error exits 1 with the server message', async () => {
  pileReply = () => ({ status: 403, data: { ok: false, error: 'nope' } });
  const r = await run(['show', A]);
  assert.equal(r.code, 1);
  assert.match(r.err, /server answered 403: nope/);
});

test('an empty --title is a usage error', async () => {
  const r = await run(['show', A, '--title', '']);
  assert.equal(r.code, 2);
  assert.match(r.err, /empty value for --title/);
});

test('unknown options exit 2 with the show usage', async () => {
  const r = await run(['show', A, '--wat']);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown option: --wat/);
  assert.match(r.err, /usage: riffledesk show/);
});

test('--json with no tab launches nothing and carries the URL', async () => {
  pileReply = () => ({ status: 200, data: { ok: true, delivered: 0, id: 'pj', count: 1 } });
  const r = await run(['show', A, '--json']);
  assert.equal(r.code, 0);
  const printed = JSON.parse(r.out);   // one JSON line, nothing appended after it
  assert.equal(printed.id, 'pj');
  assert.equal(printed.delivered, 0);
  assert.equal(printed.url, `http://127.0.0.1:${port}/?pile=pj`);
});

test('--json lists what was dropped, with a reason', async () => {
  pileReply = () => ({ status: 200, data: { ok: true, delivered: 1, id: 'pd', count: 1 } });
  const r = await run(['show', A, path.join(TMP, 'gone.md'), '--json']);
  assert.equal(r.code, 0);
  const printed = JSON.parse(r.out);
  assert.equal(printed.dropped.length, 1);
  assert.match(printed.dropped[0].reason, /missing/);
});

test('paths the server rejects are reported, not silently lost', async () => {
  const outside = path.join(TMP, '..', 'outside.md');
  pileReply = () => ({
    status: 200,
    data: { ok: true, delivered: 1, id: 'ps', count: 1, dropped: [outside] }
  });
  const r = await run(['show', A, '--json']);
  assert.equal(r.code, 0);
  assert.match(r.err, /server dropped/);
  assert.equal(JSON.parse(r.out).dropped[0].path, outside);
});

test('"-" reads stdin like --stdin', async () => {
  pileReply = () => ({ status: 200, data: { ok: true, delivered: 1, id: 'pm', count: 2 } });
  const r = await run(['show', '-'], `${A}\n${B}\n`);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(lastPile().body).paths, [A, B]);
});

test('a path that only starts like JSON is still read as a path', async () => {
  const odd = path.join(TMP, '[draft] notes.md');
  fs.writeFileSync(odd, 'x\n');
  pileReply = () => ({ status: 200, data: { ok: true, delivered: 1, id: 'pb', count: 1 } });
  const r = await run(['show'], `${odd}\n`);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(lastPile().body).paths, [fs.realpathSync(odd)]);
});
