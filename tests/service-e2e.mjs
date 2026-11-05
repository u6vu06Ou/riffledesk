import { chromeExecutable } from './chrome-path.mjs';
import { chromium } from 'playwright-core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5191, BASE = `http://127.0.0.1:${PORT}`;
const probe = net.createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(PORT, '127.0.0.1', resolve); });
await new Promise(resolve => probe.close(resolve));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-service-ui-'));
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ roots: [tmp], pinned: [], convoRoots: [] }));
fs.writeFileSync(path.join(tmp, 'readme.md'), '# Background server test');
const env = { ...process.env, RIFFLEDESK_CONFIG: cfg, RIFFLEDESK_INDEX: 'off' };
const exec = promisify(execFile);
const run = args => exec(process.execPath, [path.join(ROOT, 'bin/riffledesk.js'), ...args, '--port', String(PORT)], {
  cwd: ROOT, env, windowsHide: true, timeout: 25000
});
let browser;
try {
  await run(['--no-open']);
  const first = await fetch(`${BASE}/api/service`).then(r => r.json());
  browser = await chromium.launch({ executablePath: chromeExecutable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE);
  await page.waitForFunction(() => window.__dbg?.ready());
  await page.locator('#btnSettings').click();
  await page.locator('#serviceRestart').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('serviceRestart').disabled);
  assert.match(await page.locator('#serviceStatus').innerText(), /0\.3\.0/);
  await page.screenshot({ path: path.join(ROOT, 'docs/screenshots/service-controls.png') });
  await page.locator('#serviceRestart').click();
  await page.waitForEvent('load', { timeout: 25000 });
  await page.waitForFunction(() => window.__dbg?.ready());
  const second = await fetch(`${BASE}/api/service`).then(r => r.json());
  assert.notEqual(second.instanceId, first.instanceId);
  await page.locator('#btnSettings').click();
  await page.waitForFunction(() => !document.getElementById('serviceStop').disabled);
  page.once('dialog', d => d.accept());
  await page.locator('#serviceStop').click();
  await page.waitForFunction(() => /Stopped|已結束/.test(document.getElementById('serviceStatus').textContent));
  await new Promise(resolve => setTimeout(resolve, 500));
  await assert.rejects(fetch(`${BASE}/api/service`));
  assert.deepEqual(errors, []);
  console.log('ALL OK: visible version, restart/reconnect, stop/confirmation, no page errors');
} finally {
  await browser?.close();
  try { await run(['stop']); } catch (_) {}
  fs.rmSync(tmp, { recursive: true, force: true });
}
