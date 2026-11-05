import { chromeExecutable } from './chrome-path.mjs';
// Isolated reader/header, multi-type filtering and embedded-HTML acceptance.
// Optional screenshots: RIFFLEDESK_TEST_OUTPUT=<existing output directory>.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 5195, base = `http://127.0.0.1:${port}`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-reader-'));
const output = process.env.RIFFLEDESK_TEST_OUTPUT;
const report = [];
let server, browser;
function pass(label) { report.push(label); console.log('PASS ' + label); }
async function shot(page, name) { if (output) await page.screenshot({ path: path.join(output, name + '.png') }); }
try {
  await new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
  const md = path.join(temp, 'A-long-document-title-for-the-single-row-header.md');
  fs.writeFileSync(md, '# 文件閱讀驗收\n\n正文保留原樣。\n\n## 下一段\n\n| 名稱 | 說明 |\n|---|---|\n| 文件 | 原稿不改寫 |\n');
  fs.writeFileSync(path.join(temp, 'plain.txt'), 'Plain text fixture');
  fs.writeFileSync(path.join(temp, 'data.json'), '{}');
  const html = path.join(temp, 'A-long-interactive-document-title-for-the-single-row-header.html');
  fs.writeFileSync(html, '<!doctype html><body><h1>Static figure fallback</h1><script>setInterval(()=>parent.postMessage("reader-test-heartbeat","*"),50)</script>');
  const config = path.join(temp, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ roots: [temp, root], pinned: [], convoRoots: [], indexContent: false }));
  server = spawn(process.execPath, ['server.js'], { cwd: root,
    env: { ...process.env, PORT: String(port), RIFFLEDESK_CONFIG: config, RIFFLEDESK_INDEX: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(Error(log || 'start timeout')), 15000);
    server.once('exit', code => { clearTimeout(timer); reject(Error('server exited ' + code + ': ' + log)); });
    server.stdout.on('data', chunk => { log += chunk; if (log.includes('listening')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', chunk => { log += chunk; });
  });
  browser = await chromium.launch({ executablePath: chromeExecutable(), headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { if (window === top) localStorage.setItem('riffleTipSeen', '1'); });
  async function open(file) {
    await page.goto(`${base}/?open=${encodeURIComponent(file)}`);
    await page.waitForFunction(() => window.__dbg?.ready());
    await page.waitForFunction(name => document.querySelector('#readerTitle').textContent === name && document.querySelector('#reader.show'), path.basename(file));
    await page.waitForTimeout(300);
  }
  const geometry = () => page.evaluate(() => {
    const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right }; };
    return { size: rect('btnSize'), close: rect('btnClose'), header: rect('readerHeader'), tools: rect('readerBtns'), title: rect('readerHeadText') };
  });
  await open(html);
  let anchor;
  for (const mode of ['threecol', 'wide', 'full']) {
    await page.evaluate(mode => window.__dbg.setMode(mode), mode);
    const g = await geometry();
    assert.equal(g.header.h, 41, mode + ': one header row');
    assert.ok(g.tools.right <= g.size.x - 4, mode + ': tools do not cover window controls');
    assert.ok(g.title.right <= g.tools.x + 1, mode + ': title does not cover tools');
    if (anchor) for (const key of ['size', 'close']) for (const axis of ['x', 'y']) assert.ok(Math.abs(g[key][axis] - anchor[key][axis]) < 1, `${mode}: stable ${key}.${axis}`);
    anchor = g;
    await shot(page, 'header-' + mode);
  }
  pass('single-row HTML header; size and close stay fixed across all three modes');
  await page.evaluate(() => window.__dbg.setMode('threecol'));
  await page.locator('#btnMore').click();
  await page.locator('#ctxMenu button').filter({ hasText: /原始碼|Source/i }).click();
  await page.waitForFunction(() => document.querySelector('#readerBody pre'));
  pass('narrow-pane Source action remains accessible through More');

  await open(md);
  await page.evaluate(() => window.__dbg.setMode('threecol'));
  await page.waitForSelector('#readerBody.md h1');
  assert.ok((await page.locator('#readerBody').innerText()).includes('原稿不改寫'));
  assert.equal(await page.locator('#readerBody table').count(), 1);
  for (const width of [1400, 1000]) {
    await page.setViewportSize({ width, height: 900 });
    const g = await geometry(); assert.equal(g.header.h, 41);
    assert.ok(g.tools.right <= g.size.x - 4);
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await shot(page, 'markdown-book');
  await page.locator('#btnMore').click();
  await page.locator('#ctxMenu button').filter({ hasText: /編輯|Edit/ }).first().click();
  await page.waitForSelector('#btnCancelEdit:visible');
  assert.equal((await geometry()).header.h, 41);
  await page.locator('#btnMore').click();
  assert.ok(await page.locator('#ctxMenu button').filter({ hasText: /存檔|Save/ }).count());
  await page.keyboard.press('Escape');
  await page.locator('#btnCancelEdit').click();
  assert.equal(fs.readFileSync(md, 'utf8').startsWith('# 文件閱讀驗收'), true);
  pass('Markdown book layout, table content and editor tools remain usable in narrow panes');

  // One menu; ordinary clicks form a union, special choices reset it.
  await page.locator('#chips summary').click();
  await page.locator('[data-chip=md]').click();
  await page.locator('[data-chip=txt]').click();
  assert.deepEqual(await page.evaluate(() => __dbg.chipsOn()), ['md', 'txt']);
  assert.equal(await page.locator('[data-chip=md]').getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('[data-chip=txt]').getAttribute('aria-checked'), 'true');
  assert.match(await page.locator('#chips summary').innerText(), /\.md.*\.txt/);
  await page.waitForTimeout(350);
  const names = await page.evaluate(() => __dbg.fileNames(50));
  assert.ok(names.includes(path.basename(md)) && names.includes('plain.txt'), JSON.stringify(names));
  assert.ok(!names.includes('data.json') && !names.includes(path.basename(html)));
  await page.reload(); await page.waitForFunction(() => window.__dbg?.ready());
  assert.deepEqual(await page.evaluate(() => __dbg.chipsOn()), ['md', 'txt']);
  await page.locator('#chips summary').click();
  await page.locator('[data-chip=readable]').click();
  assert.deepEqual(await page.evaluate(() => __dbg.chipsOn()), ['readable']);
  await shot(page, 'type-menu');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#chips details').getAttribute('open'), null);
  pass('MD + TXT filtering, persisted multi-selection, reset and keyboard dismissal');

  await open(html);
  await page.evaluate(() => { window.heartbeats = 0; addEventListener('message', e => { if(e.data === 'reader-test-heartbeat') window.heartbeats++; }); });
  await page.locator('#btnRun').click();
  await page.waitForSelector('iframe[data-running-html]');
  await page.waitForFunction(() => window.heartbeats > 2);
  await page.locator('#btnClose').click();
  assert.equal(await page.locator('iframe[data-running-html]').count(), 0);
  await page.waitForTimeout(150);
  const stopped = await page.evaluate(() => window.heartbeats);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.heartbeats), stopped);
  pass('closing reader destroys running HTML frame and stops its timers');

  await open(html);
  await page.route('**/api/rawopen?*', async route => {
    await new Promise(resolve => setTimeout(resolve, 400)); await route.continue();
  });
  const pending = page.waitForRequest(request => request.url().includes('/api/rawopen?'));
  await page.locator('#btnRun').click(); await pending;
  await page.locator('#btnClose').click();
  await page.waitForTimeout(650);
  assert.equal(await page.locator('iframe[data-running-html]').count(), 0);
  await page.unroute('**/api/rawopen?*');
  pass('closing during a pending HTML load does not recreate a running frame');

  await open(path.join(root, 'skills/riffledesk/spatial-report.html'));
  await page.evaluate(() => window.__dbg.setMode('threecol'));
  const staticFrame = await (await page.waitForSelector('#readerBody iframe')).contentFrame();
  assert.equal(await staticFrame.locator('#fallback:visible').count(), 1);
  assert.equal(await staticFrame.locator('canvas').count(), 0);
  pass('static 3D preview contains a useful fallback without executing scripts');
  if (!await page.locator('iframe[data-running-html]').count()) await page.locator('#btnRun').click();
  const frameElement = await page.waitForSelector('iframe[data-running-html]');
  const frame = await frameElement.contentFrame();
  await frame.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 20000 });
  assert.equal(await frame.locator('canvas').count(), 1);
  assert.ok(await frame.locator('[data-rd-id=before-figure]').count());
  assert.ok(await frame.locator('[data-rd-id=after-figure]').count());
  await frame.locator('#explode').fill('65');
  assert.equal(await frame.locator('#explodeOut').innerText(), '65%');
  await frame.locator('#reset').scrollIntoViewIfNeeded();
  await frame.locator('#reset').click();
  await frame.waitForFunction(() => document.querySelector('#explodeOut').textContent === '0%', null, { timeout: 5000 });
  assert.equal(await frame.locator('#explodeOut').innerText(), '0%');
  assert.ok(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await shot(page, 'embedded-3d');
  pass('local three.js embedded between document paragraphs; responsive figure, layers and reset');

  await page.setViewportSize({ width: 400, height: 850 });
  await page.goto(`${base}/?mode=panel&open=${encodeURIComponent(md)}`);
  await page.waitForFunction(() => window.__dbg?.ready());
  await page.waitForSelector('#reader.show');
  await page.locator('#btnClose').click();
  await page.locator('#chips summary').click();
  await page.locator('[data-chip=md]').click();
  await page.locator('[data-chip=txt]').click();
  assert.deepEqual(await page.evaluate(() => __dbg.chipsOn()), ['md', 'txt']);
  const panelMenu = await page.locator('#chips .type-choices').boundingBox();
  assert.ok(panelMenu.x >= 0 && panelMenu.x + panelMenu.width <= 400);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot(page, 'type-menu-panel');
  pass('400px side panel uses the same multi-select menu without horizontal overflow');
  assert.deepEqual(errors, []);
  pass('no uncaught page errors');
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
  fs.rmSync(temp, { recursive: true, force: true });
  if (output) fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
}
