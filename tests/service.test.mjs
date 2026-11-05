import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin/riffledesk.js');
const PORT = 5190, BASE = `http://127.0.0.1:${PORT}`;
const exec = promisify(execFile);

test('background server outlives launcher, reuses port, guards lifecycle and restarts with SSE clients', { timeout: 60000 }, async () => {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(PORT, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffle-service-'));
  const cfg = path.join(tmp, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ roots: [tmp], pinned: [], convoRoots: [] }));
  const env = { ...process.env, RIFFLEDESK_CONFIG: cfg, RIFFLEDESK_INDEX: 'off' };
  const run = args => exec(process.execPath, [BIN, ...args, '--port', String(PORT)], {
    cwd: ROOT, env, timeout: 25000, windowsHide: true
  });
  const status = () => fetch(`${BASE}/api/service`).then(r => r.json());
  let events;
  try {
    // execFile resolves only once the launcher has exited and closed its pipes.
    const launched = await run(['--no-open']);
    assert.match(launched.stdout, /background/);
    const first = await status();
    assert.equal(first.name, 'riffledesk');
    assert.notEqual(first.pid, process.pid);
    await run(['--no-open']);
    assert.equal((await status()).instanceId, first.instanceId, 'repeat launch must reuse the server');
    assert.match((await run(['status'])).stdout, /running/);
    const post = (headers, body = { instanceId: first.instanceId }, method = 'POST') => fetch(`${BASE}/api/service/stop`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) })
    });
    assert.equal((await post({})).status, 403);
    assert.equal((await post({ Origin: 'https://example.com', 'X-RiffleDesk-CLI': '1' })).status, 403);
    assert.equal((await post({ Origin: BASE, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post({ 'X-RiffleDesk-CLI': '1' }, { instanceId: 'stale' })).status, 409);
    assert.equal((await post({}, null, 'GET')).status, 405);
    assert.equal((await status()).instanceId, first.instanceId, 'rejected requests must leave server alive');
    await new Promise((resolve, reject) => {
      events = http.get(`${BASE}/api/events?path=${encodeURIComponent(tmp)}`, res => { res.resume(); resolve(); });
      events.on('error', reject);
    });
    await run(['restart']);
    const second = await status();
    assert.notEqual(second.instanceId, first.instanceId);
    assert.notEqual(second.pid, first.pid);
    await run(['stop']);
    await assert.rejects(fetch(`${BASE}/api/service`));
    assert.match((await run(['status'])).stdout, /stopped/);
    // A stopped instance can be started with restart as well.
    await run(['restart']);
    assert.equal((await status()).ok, true);
  } finally {
    events?.destroy();
    try { await run(['stop']); } catch (_) {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
