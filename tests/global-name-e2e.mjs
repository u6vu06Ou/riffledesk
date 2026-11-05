import { chromeExecutable } from './chrome-path.mjs';
// tests/global-name-e2e.mjs — the "other places" name panel under the search box.
// The bug: looking at folder A, typing the name of a file in folder B showed
// nothing, so the user concluded the file did not exist. Typing must now list the
// hit from B; ArrowDown + Enter opens it in the reader.
// Port 5195. Writes docs/screenshots/global-name-search.png
// Usage: node tests/global-name-e2e.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5195;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const CHROME = chromeExecutable();
let failed = 0;
const consoleErrors = [];
const pageErrors = [];
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-names-e2e-'));
const A = path.join(TMP, 'folder-a');
const B = path.join(TMP, 'folder-b');
fs.mkdirSync(A, { recursive: true });
fs.mkdirSync(B, { recursive: true });
fs.writeFileSync(path.join(A, 'notes.md'), '# Notes\n\nnothing interesting here\n');
fs.writeFileSync(path.join(A, 'alpha.md'), '# Alpha\n\nsecond file\n');
fs.writeFileSync(path.join(A, 'beta.md'), '# Beta\n\nthird file\n');
const WANTED = path.join(B, 'zebra-index.md');
fs.writeFileSync(WANTED, '# Zebra index\n\nThe file that lives somewhere else.\n');
fs.writeFileSync(path.join(B, 'other.md'), '# Other\n\nx\n');
// extra names so the panel shows a real list, not a single row
for (const n of ['zebra-notes.md', 'old-zebra.md', 'zebra-photo.md']) fs.writeFileSync(path.join(B, n), '# ' + n + '\n');
fs.mkdirSync(path.join(B, 'deeper'), { recursive: true });
fs.writeFileSync(path.join(B, 'deeper', 'zebra-nested.md'), '# nested\n');

const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [TMP], pinned: [] }, null, 2));
const DRIVES = [TMP, process.env.RIFFLEDESK_TEST_DRIVES].filter(Boolean).join(path.delimiter);

function startServer() {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', RIFFLEDESK_TEST_DRIVES: DRIVES, PORT: String(PORT), RIFFLEDESK_CONFIG: CFG },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  return new Promise((res, rej) => {
    const to = setTimeout(() => { proc.kill(); rej(new Error('server start timeout: ' + out)); }, 15000);
    const iv = setInterval(() => {
      if (out.includes('listening')) { clearInterval(iv); clearTimeout(to); res(proc); }
      else if (proc.exitCode !== null) { clearInterval(iv); clearTimeout(to); rej(new Error('server exited: ' + out)); }
    }, 25);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

let server, browser, page;
async function main() {
  try {
    server = await startServer();
    // wait for the first crawl so /api/names has rows
    const t0 = Date.now();
    for (;;) {
      const r = await fetch(BASE + '/api/index/status').then(x => x.json()).catch(() => null);
      if (r && r.available && r.lastCrawlAt && !r.crawling && r.files > 0) break;
      if (Date.now() - t0 > 30000) throw new Error('index never crawled: ' + JSON.stringify(r));
      await sleep(100);
    }

    browser = await chromium.launch({ executablePath: CHROME, headless: true,
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
    page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.addInitScript(() => { if (window === top) localStorage.setItem('riffleTipSeen', '1'); });

    // open folder A (via the projection-style ?open= so the tree lands there)
    await page.goto(`${BASE}/?open=${encodeURIComponent(path.join(A, 'notes.md'))}`);
    await page.waitForFunction(() => window.__dbg && window.__dbg.ready(), null, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('#reader.show'), null, { timeout: 15000 });
    await page.waitForTimeout(300);

    const localCount = await page.evaluate(() => document.querySelectorAll('#searchBox').length);
    ok(localCount === 1, 'search box present');

    // zero local matches — the panel must appear on its own
    await page.fill('#searchBox', 'zebra');
    await page.waitForSelector('#nameHits:not([hidden])', { timeout: 8000 });
    const rows = await page.$$eval('#nameHits .nh-row', els => els.map(e => ({
      name: e.querySelector('.nh-name').textContent,
      dir: e.querySelector('.nh-dir').textContent,
      title: e.title
    })));
    ok(rows.length >= 1, 'panel lists the file from the other folder', rows);
    ok(rows.some(r => r.name === 'zebra-index.md'), 'the wanted name is listed', rows);
    ok(rows.every(r => !r.dir.startsWith(A.replace(/\\/g, '\\'))), 'only files OUTSIDE the current folder', rows);
    const head = await page.$eval('#nameHits .nh-head', e => e.textContent);
    ok(head.length > 0, 'panel has a header', head);
    // name is bold where the query matches
    const bold = await page.$eval('#nameHits .nh-row b', e => e.textContent).catch(() => '');
    ok(bold.toLowerCase() === 'zebra', 'matched part of the name is bolded', bold);

    ok(rows.length >= 4, 'several matches listed', rows.length);
    // highlight the second row for the screenshot (shows the keyboard-selected state)
    await page.focus('#searchBox');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(SHOTS, 'global-name-search.png') });

    // ArrowDown then Enter opens it in the reader
    const selIdx = await page.$$eval('#nameHits .nh-row', els => els.findIndex(e => e.classList.contains('sel')));
    ok(selIdx >= 0, 'a row is highlighted', selIdx);
    // walk down to the wanted row with the keyboard, then Enter
    const wantIdx = rows.findIndex(r => r.name === 'zebra-index.md');
    for (let i = selIdx; i < wantIdx; i++) await page.keyboard.press('ArrowDown');
    const selName = await page.$eval('#nameHits .nh-row.sel .nh-name', e => e.textContent);
    ok(selName === 'zebra-index.md', 'arrow keys moved the highlight to the wanted row', selName);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const t = document.querySelector('#readerTitle');
      return t && t.textContent === 'zebra-index.md';
    }, null, { timeout: 15000 });
    ok(true, 'reader shows the file from the other folder');
    await page.waitForFunction(() => document.getElementById('readerBody').textContent.includes('lives somewhere else'), null, { timeout: 10000 }).catch(() => {});
    const shown = await page.evaluate(() => ({
      hidden: document.getElementById('nameHits').hidden,
      body: document.getElementById('readerBody').textContent.includes('lives somewhere else')
    }));
    ok(shown.hidden, 'panel closes after opening');
    ok(shown.body, 'reader has the file content');
    await sleep(200);
    ok(consoleErrors.length === 0, 'no console errors', consoleErrors);
    ok(pageErrors.length === 0, 'no page errors', pageErrors);
  } finally {
    if (browser) await browser.close().catch(() => {});
    browser = null;
    if (server) { server.kill(); server = null; }
  }
}

main()
  .catch(e => { console.log('FAIL harness ' + e.stack); failed++; })
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
    process.exit(failed ? 1 : 0);
  });
