// live-check.mjs — playwright-core (system Chrome, headless) acceptance for the live features:
// /api/events pill flow, ⟳ button, R key, ⚙ full-text index switch.
// Starts its own server on port 5182 with a temp fixture (never touches the repo config).
// Usage: node tests/live-check.mjs    (prints asserts, exits non-zero on failure)
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
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffledesk-livecheck-'));
const FIX = path.join(TMP, 'fixture');
fs.mkdirSync(FIX, { recursive: true });
for (const n of ['one.md', 'two.md', 'three.md']) fs.writeFileSync(path.join(FIX, n), '# ' + n + '\n');
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [FIX], pinned: [], convoRoots: [] }, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

async function startServer() {
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: CFG },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let out = '';
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server start timeout: ' + out)), 10000);
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) { clearTimeout(to); res(); } });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', c => rej(new Error('server exited ' + c + ': ' + out)));
  });
  return proc;
}

const apiStatus = () => fetch(BASE + '/api/index/status').then(r => r.json());

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-gpu'] });
  const pageErrors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    // deterministic language so pill wording is assertable
    await ctx.addInitScript(() => { try { localStorage.setItem('floderLang', 'en'); localStorage.setItem('riffleTipSeen', '1'); } catch (_) {} });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });
    page.on('pageerror', e => pageErrors.push('pageerror: ' + e.message));
    const shot = n => page.screenshot({ path: path.join(SHOTS, n + '.png') }).then(() => console.log('shot', n));
    const cardCount = () => page.evaluate(() => __dbg.stack().files);

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__dbg && __dbg.ready(), null, { timeout: 15000 });
    await sleep(1800);                       // live.js target poll fires → EventSource attached
    ok((await cardCount()) === 3, 'boot-card-count-3', { n: await cardCount() });

    // ----- folder change pill -----
    fs.writeFileSync(path.join(FIX, 'fresh-a.md'), '# a\n');
    fs.writeFileSync(path.join(FIX, 'fresh-b.md'), '# b\n');
    await page.waitForFunction(() => {
      const p = document.getElementById('livePill');
      return p && getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().width > 50;
    }, null, { timeout: 7000 }).catch(() => {});
    const pillText = await page.evaluate(() => (document.getElementById('livePill') || {}).textContent || '');
    ok(/2/.test(pillText) && /new/i.test(pillText), 'pill-shows-2-new', { pillText });
    ok((await cardCount()) === 3, 'pill-did-not-shuffle', { n: await cardCount() });
    await shot('live-01-pill');

    await page.click('#livePill');
    await page.waitForFunction(() => __dbg.stack().files === 5, null, { timeout: 7000 }).catch(() => {});
    ok((await cardCount()) === 5, 'pill-click-loads-2', { n: await cardCount() });
    const pillGone = await page.evaluate(() => getComputedStyle(document.getElementById('livePill')).display === 'none');
    ok(pillGone, 'pill-hides-after-click');
    await shot('live-02-loaded');

    // ----- R key -----
    fs.writeFileSync(path.join(FIX, 'fresh-c.md'), '# c\n');
    await page.mouse.move(800, 200); await page.mouse.down(); await page.mouse.up();   // make sure focus is not in an input
    await page.keyboard.press('r');
    await page.waitForFunction(() => __dbg.stack().files === 6, null, { timeout: 7000 }).catch(() => {});
    ok((await cardCount()) === 6, 'r-key-reloads', { n: await cardCount() });

    // ----- ⟳ button -----
    fs.writeFileSync(path.join(FIX, 'fresh-d.md'), '# d\n');
    await page.click('#btnRefresh');
    await page.waitForFunction(() => __dbg.stack().files === 7, null, { timeout: 7000 }).catch(() => {});
    ok((await cardCount()) === 7, 'refresh-button-reloads', { n: await cardCount() });

    // ----- settings: full-text index switch -----
    const st0 = await apiStatus();
    ok(st0.available === true, 'index-available-in-check', { available: st0.available });
    await page.click('#btnSettings');
    await page.waitForFunction(() => (document.getElementById('idxNote') || {}).textContent.length > 5, null, { timeout: 7000 }).catch(() => {});
    const box0 = await page.evaluate(() => ({ checked: document.getElementById('idxContent').checked, note: document.getElementById('idxNote').textContent }));
    ok(box0.checked === (st0.contentEnabled !== false), 'switch-reflects-status', { status: st0.contentEnabled, box: box0 });
    await shot('live-03-settings');

    // flip off → status follows
    const want = !(st0.contentEnabled !== false);
    await page.click('#idxContent');
    const t0 = Date.now();
    let st1 = st0;
    while (Date.now() - t0 < 15000) { st1 = await apiStatus(); if ((st1.contentEnabled !== false) === want) break; await sleep(400); }
    ok((st1.contentEnabled !== false) === want, 'switch-flips-status', { want, got: st1.contentEnabled });
    await sleep(700);   // note line refreshes async
    ok(await page.evaluate(() => document.getElementById('idxContent').checked) === want, 'switch-ui-after-flip');
    const note1 = await page.evaluate(() => document.getElementById('idxNote').textContent);
    ok(note1.length > 5, 'index-note-text', { note: note1 });
    await shot('live-04-settings-toggled');

    // flip back so a re-run starts clean
    await page.click('#idxContent');
    const t1 = Date.now();
    while (Date.now() - t1 < 15000) { const s = await apiStatus(); if ((s.contentEnabled !== false) === !want) break; await sleep(400); }

    ok(pageErrors.length === 0, 'no-console-errors', pageErrors.length ? pageErrors.slice(0, 4) : undefined);
  } finally {
    await browser.close().catch(() => {});
    server.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL LIVE CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('fatal:', e); process.exit(2); });
