import { chromeExecutable } from './chrome-path.mjs';
// tests/pile-type-filter-e2e.mjs — the type button inside a pile, and the name panel.
//
// Two things the user found confusing/broken:
//  - inside a pile the type button showed a phrase ("整疊都顯示") instead of a type
//    label, because the pile ignored the filter. Now a pile has its OWN selection
//    (starts at All), the button reads "Type: All", narrowing hides delivered files,
//    and leaving the pile restores the folder's selection untouched.
//  - the "names elsewhere" panel ignored the type filter. It must now only list
//    names matching the active selection.
// Port 5196. Writes docs/screenshots/pile-type-filter.png
// Usage: node tests/pile-type-filter-e2e.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5196;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const CHROME = chromeExecutable();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const consoleErrors = [];
const pageErrors = [];
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

// ---------------------------------------------------------------- fixture
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-piletype-'));
const A = path.join(TMP, 'alpha');
const B = path.join(TMP, 'beta');
const RD = p => path.join(TMP, ...p.split('/'));
for (const p of ['alpha/one.md', 'alpha/two.md', 'alpha/card.png', 'alpha/other-a.md',
  'beta/three.md', 'beta/pic.png']) {
  fs.mkdirSync(path.dirname(RD(p)), { recursive: true });
  fs.writeFileSync(RD(p), p.endsWith('.png') ? 'png\n' : `# ${path.basename(p)}\nbody\n`);
}
// names in another folder for the "other places" panel
fs.writeFileSync(path.join(B, 'zebra-note.md'), '# zebra\n');
fs.writeFileSync(path.join(B, 'zebra-shot.png'), 'png\n');
const CONFIG_PATH = path.join(TMP, 'config.json');
// index needed for /api/names
fs.writeFileSync(CONFIG_PATH, JSON.stringify({ roots: [A, B], pinned: [] }, null, 2));
const DRIVES = [TMP, process.env.RIFFLEDESK_TEST_DRIVES].filter(Boolean).join(path.delimiter);

function startServer() {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', RIFFLEDESK_TEST_DRIVES: DRIVES, PORT: String(PORT), RIFFLEDESK_CONFIG: CONFIG_PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server start timeout: ' + out)), 15000);
    const iv = setInterval(() => {
      if (out.includes('listening')) { clearInterval(iv); clearTimeout(to); res(proc); }
      else if (proc.exitCode !== null) { clearInterval(iv); clearTimeout(to); rej(new Error('server exited: ' + out)); }
    }, 25);
  });
}

async function post(page, body) {
  return page.evaluate(async b => {
    const r = await fetch('/api/pile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-RiffleDesk-CLI': '1' },
      body: JSON.stringify(b)
    });
    return { status: r.status, body: await r.json() };
  }, body);
}

const names = page => page.evaluate(() => window.__dbg.fileNames(50));
const summaryText = page => page.evaluate(() => document.querySelector('#chips summary')?.textContent || '');
const panelRows = page => page.$$eval('#nameHits .nh-row', els => els.map(e => ({
  name: e.querySelector('.nh-name')?.textContent, title: e.title
})));

let server = null;
let browser = null;

async function main() {
  try {
    server = await startServer();
    const t0 = Date.now();
    for (;;) {
      const r = await fetch(BASE + '/api/index/status').then(x => x.json()).catch(() => null);
      if (r && r.available && r.lastCrawlAt && !r.crawling && r.files > 0) break;
      if (Date.now() - t0 > 30000) throw new Error('index never crawled: ' + JSON.stringify(r));
      await sleep(100);
    }

    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, reducedMotion: 'reduce', locale: 'zh-TW' });  // assertions read the zh-TW labels; CI runners default to en
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.addInitScript(() => {
      if (window === top) { localStorage.setItem('riffleTipSeen', '1'); localStorage.setItem('floderChips2', JSON.stringify(['md'])); }
    });

    await page.goto(`${BASE}/?open=${encodeURIComponent(path.join(A, 'one.md'))}`);
    await page.waitForFunction(() => window.__dbg && window.__dbg.ready(), null, { timeout: 20000 });
    await sleep(600);

    // folder selection = md, remembered for the restore check
    await page.evaluate(() => window.__dbg.selectChip('md'));
    await sleep(400);
    const folderChips = await page.evaluate(() => window.__dbg.chipsOn());
    const folderSummary = await summaryText(page);
    ok(folderSummary.startsWith('類型: '), 'folder type button shows a type label', folderSummary);

    // make a pile with an md and a png, then open it
    const r = await post(page, { paths: [RD('alpha/two.md'), RD('alpha/card.png')], title: 'Two files' });
    ok(r.status === 200 && r.body.ok === true, 'pile created', r);
    await page.evaluate(id => window.__dbg.pileOpen(id), r.body.id);
    await page.waitForFunction(() => !!window.__dbg.pileState(), null, { timeout: 10000 });
    await sleep(500);

    // ---------- 1. the type button inside a pile
    const pileSummary = await summaryText(page);
    ok(pileSummary === '類型: 全部', 'pile type button reads "Type: All", not the old phrase', pileSummary);
    const pileAll = await names(page);
    ok(pileAll.length === 2, 'both delivered files are shown by default', pileAll);

    // ---------- 2. narrowing hides the png
    await page.evaluate(() => window.__dbg.selectChip('md'));
    await sleep(400);
    const narrowed = await names(page);
    ok(narrowed.length === 1 && narrowed[0] === 'two.md', 'narrowing to md hides the delivered .png', narrowed);
    ok((await summaryText(page)).includes('.md'), 'pile button now shows the narrowed type');

    // ---------- 3. the card stack screenshot
    await page.screenshot({ path: path.join(SHOTS, 'pile-type-filter.png') });

    // ---------- 4. the name panel follows the type filter
    await page.fill('#searchBox', 'zebra');
    await page.waitForSelector('#nameHits:not([hidden])', { timeout: 8000 });
    const rows = await panelRows(page);
    ok(rows.length >= 1, 'panel lists matching names', rows);
    ok(rows.some(x => x.name === 'zebra-note.md'), 'the md match is listed', rows);
    ok(!rows.some(x => x.name === 'zebra-shot.png'), 'the png match is filtered out', rows);
    const head = await page.$eval('#nameHits .nh-head', e => e.textContent);
    ok(head.includes('md'), 'panel header names the active type', head);

    // widening re-runs the query and brings the png back
    await page.evaluate(() => window.__dbg.selectChip('all'));
    await sleep(500);
    const rowsAll = await panelRows(page);
    ok(rowsAll.some(x => x.name === 'zebra-shot.png'), 'widening to All brings the png back', rowsAll);
    await page.fill('#searchBox', '');
    await page.keyboard.press('Escape');
    await sleep(200);
    await page.evaluate(() => window.__dbg.selectChip('md'));
    await sleep(300);

    // ---------- 5. leaving the pile restores the folder's selection untouched
    await page.evaluate(() => window.__dbg.pileClose());
    await page.waitForFunction(() => !window.__dbg.pileState(), null, { timeout: 10000 });
    await sleep(600);
    ok(JSON.stringify(await page.evaluate(() => window.__dbg.chipsOn())) === JSON.stringify(folderChips),
      'folder type selection is unchanged after leaving the pile', await page.evaluate(() => window.__dbg.chipsOn()));
    ok((await summaryText(page)) === folderSummary, 'folder button shows its own label again', await summaryText(page));

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
