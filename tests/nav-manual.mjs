import { chromeExecutable } from './chrome-path.mjs';
// tests/nav-manual.mjs — headless visual check for the arrow-key TREE navigation.
// Builds a small fixture tree under os.tmpdir(), serves it on port 5182 (never
// 5177/5178/5179), drives headless Chrome with the real keyboard, and writes
// screenshots to docs/screenshots/treenav-manual-*.png for review.
// Usage: node tests/nav-manual.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5182;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const CHROME = chromeExecutable();

const sleep = ms => new Promise(r => setTimeout(r, ms));

// fixture:
//   mroot/
//     first/   one.md two.md three.md
//     gap/                      (empty — hidden by the default filter, must be skipped)
//     second/  wrap/nested.md   (second has no direct files — only the wrapper does)
//     third/   last.md
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-navman-'));
const RD = p => path.join(TMP, ...p.split('/'));

function buildFixtures() {
  fs.mkdirSync(RD('mroot/first'), { recursive: true });
  fs.mkdirSync(RD('mroot/gap'), { recursive: true });
  fs.mkdirSync(RD('mroot/second/wrap'), { recursive: true });
  fs.mkdirSync(RD('mroot/third'), { recursive: true });
  for (const n of ['one', 'two', 'three'])
    fs.writeFileSync(RD(`mroot/first/${n}.md`), `# ${n}\n\narrow nav fixture for ${n}.\n`);
  fs.writeFileSync(RD('mroot/second/wrap/nested.md'), '# nested\n\nfiles only below the wrapper folder.\n');
  fs.writeFileSync(RD('mroot/third/last.md'), '# last\n\nfinal folder.\n');
  // /api/list 排序＝mtime 新→舊；固定 mtime 讓顯示順序 deterministic（斷言與截圖依賴）
  const base = Date.now() - 60000;
  const pin = (rel, i) => { const t = new Date(base + i * 1000); fs.utimesSync(RD(rel), t, t); };
  ['mroot/third', 'mroot/second', 'mroot/gap', 'mroot/first'].forEach((rel, i) => pin(rel, i));
}

async function startServer() {
  const cfg = path.join(TMP, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ roots: [RD('mroot')], pinned: [] }, null, 2));
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: cfg, RIFFLEDESK_INDEX: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let out = '';
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server start timeout: ' + out)), 12000);
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) { clearTimeout(to); res(); } });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', c => rej(new Error('server exited ' + c + ': ' + out)));
  });
  return proc;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  buildFixtures();
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-gpu'] });
  const shot = async (page, name) => {
    const p = path.join(SHOTS, name + '.png');
    await page.screenshot({ path: p });
    console.log('shot ' + p);
  };
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, locale: 'zh-TW'
    });
    await ctx.addInitScript(() => {
      try { localStorage.setItem('riffleTipSeen', '1'); localStorage.setItem('floderLang', 'zh'); } catch (_) {}
    });
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    // CSP 下 waitForFunction 別寫「window.__dbg && 裸 __dbg」混用；全程 window. 前綴
    await page.waitForFunction(() => !!(window.__dbg && window.__dbg.ready()), null, { timeout: 15000 });

    await page.evaluate(x => __dbg.lockFolder(x), RD('mroot'));
    await page.evaluate(x => __dbg.expandTreeNode(x), RD('mroot'));
    await page.waitForFunction(() => window.__dbg.stack().phase === 'idle', null, { timeout: 9000 });
    await sleep(600);
    await shot(page, 'treenav-manual-0-start');

    await page.keyboard.press('ArrowDown');        // highlight → first/, loads its 3 cards
    await page.waitForFunction(() => /first/.test(window.__dbg.lockedFolder() || ''), null, { timeout: 9000 });
    await sleep(800);
    await shot(page, 'treenav-manual-1-down-loads');

    await page.keyboard.press('ArrowDown');        // gap/ hidden by the filter → lands second/
    await page.waitForFunction(() => /second/.test(window.__dbg.lockedFolder() || ''), null, { timeout: 9000 });
    await sleep(600);
    await shot(page, 'treenav-manual-2-skip-hidden');

    await page.keyboard.press('ArrowRight');       // expand second/ → wrap row appears
    await page.waitForFunction(() =>
      window.__dbg.navRows().some(x => /wrap/.test(String(x))), null, { timeout: 6000 });
    await page.keyboard.press('ArrowRight');       // descend into wrap/
    await page.waitForFunction(() => /wrap/.test(window.__dbg.lockedFolder() || ''), null, { timeout: 9000 });
    await sleep(600);
    await shot(page, 'treenav-manual-3-expand-descend');

    await page.keyboard.press('ArrowDown');        // next visible row → third/
    await page.waitForFunction(() => /third/.test(window.__dbg.lockedFolder() || ''), null, { timeout: 9000 });
    await sleep(600);

    await page.keyboard.press('Enter');            // open the front card (last.md) in the reader
    await page.waitForFunction(() => window.__dbg.panel().shown === true, null, { timeout: 9000 });
    await sleep(800);
    await shot(page, 'treenav-manual-4-enter-reader');

    await page.keyboard.press('Escape');           // reader back
    await sleep(600);
    await page.keyboard.press('Home');             // highlight jumps to the first row instantly
    await sleep(120);
    await page.keyboard.press('End');              // …and to the last row
    await sleep(200);
    await shot(page, 'treenav-manual-5-home-end');

    await page.click('#btnSettings');              // help list with the new key items
    await sleep(500);
    await shot(page, 'treenav-manual-6-help');

    console.log('done');
  } finally {
    try { await browser.close(); } catch (_) {}
    try { server.kill(); } catch (_) {}
    await Promise.race([new Promise(r => server.once('exit', r)), sleep(3000)]);
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 6, retryDelay: 500 }); } catch (_) {}
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
