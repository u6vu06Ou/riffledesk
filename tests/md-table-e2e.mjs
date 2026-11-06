import { chromeExecutable } from './chrome-path.mjs';
// tests/md-table-e2e.mjs — acceptance for wide Markdown tables in the reader.
// The real-world pain (wiki/github-radar/radar-index.md): five equal columns squeeze the
// long-text column into a ~10-char strip. After render, short columns must be one line and
// the long column must keep a readable width, while the table may use the whole pane.
// Port 5193. Writes docs/screenshots/md-table-wide.png (before and after in one image pair:
// md-table-wide-before.png / md-table-wide.png). Usage: node tests/md-table-e2e.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5193;
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-mdtable-'));
const DOC = path.join(TMP, 'wide-table.md');
const XWIDE = path.join(TMP, 'extra-wide-table.md');
fs.copyFileSync(path.join(ROOT, 'tests', 'fixtures', 'md-table-wide.md'), DOC);
fs.copyFileSync(path.join(ROOT, 'tests', 'fixtures', 'md-table-xwide.md'), XWIDE);
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [TMP], pinned: [], convoRoots: [], indexContent: false }, null, 2));

function startServer() {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), RIFFLEDESK_CONFIG: CFG, RIFFLEDESK_INDEX: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  return new Promise((res, rej) => {
    let out = '';
    const to = setTimeout(() => { proc.kill(); rej(new Error('server start timeout: ' + out)); }, 15000);
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) { clearTimeout(to); res(proc); } });
    proc.stderr.on('data', d => { out += d; });
  });
}

// The pre-fix stylesheet, injected on top of the shipped one so both states come from the
// same DOM (and the same real column widths) instead of a stale checkout.
const OLD_CSS = `
  #readerBody.md .md-table-wrap { margin: 0; border: 0; border-radius: 0; background: none; overflow-x: auto; }
  #readerBody.md table { display: block; max-width: 100%; }
  #readerBody.md td, #readerBody.md th { padding: 12px 16px; min-width: 110px; white-space: normal;
    border-bottom: 0; position: static; }
  #readerBody.md .md-cell-short { white-space: normal; }
  #readerBody.md .md-cell-long { min-width: 0; }
`;

let server, browser, page;
async function main() {
  try {
  server = await startServer();
  browser = await chromium.launch({ executablePath: CHROME, headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1920, height: 900 }, reducedMotion: 'reduce' });
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.addInitScript(() => { if (window === top) localStorage.setItem('riffleTipSeen', '1'); });

  async function open(file, name) {
    await page.goto(`${BASE}/?open=${encodeURIComponent(file)}`);
    await page.waitForFunction(() => window.__dbg && window.__dbg.ready(), null, { timeout: 20000 });
    await page.waitForFunction(n => document.querySelector('#reader.show')
      && document.querySelector('#readerTitle').textContent === n, name, { timeout: 15000 });
    await page.waitForSelector('#readerBody.md .md-table-wrap table', { timeout: 10000 });
    await page.waitForTimeout(200);
  }
  await open(DOC, 'wide-table.md');

  const measure = () => page.evaluate(() => {
    const table = document.querySelector('#readerBody.md table');
    const wrap = table.closest('.md-table-wrap');
    const rows = [...table.rows];
    const colBox = c => rows.map(r => r.cells[c]).filter(Boolean)
      .map(cell => { const r = cell.getBoundingClientRect(); return { w: r.width, h: r.height, ws: getComputedStyle(cell).whiteSpace }; });
    // 欄內文字的行數（Range 的 client rect 數）；td 的 height 會被同列長文撐高，不能直接看
    const lines = c => rows.map(r => r.cells[c]).filter(Boolean).map(cell => {
      const range = document.createRange(); range.selectNodeContents(cell);
      return new Set([...range.getClientRects()].map(r => Math.round(r.top))).size;
    });
    const long = colBox(4), date = colBox(3), dateLines = lines(3);
    return {
      pane: document.getElementById('readerBody').getBoundingClientRect().width,
      tableW: table.getBoundingClientRect().width,
      tableH: table.getBoundingClientRect().height,
      wrapW: wrap.getBoundingClientRect().width,
      longMin: Math.min(...long.map(x => x.w)),
      longMax: Math.max(...long.map(x => x.w)),
      dateMaxH: Math.max(...date.map(x => x.h)),
      dateMaxLines: Math.max(...dateLines),
      dateWhiteSpace: date[0] && date[0].ws,
      shortMarked: document.querySelectorAll('#readerBody.md .md-cell-short').length,
      longMarked: document.querySelectorAll('#readerBody.md .md-cell-long').length,
      scrollable: wrap.scrollWidth > wrap.clientWidth,
      wrapScrollLeft: wrap.scrollLeft,
      tall: wrap.classList.contains('md-table-tall'),
      wrapScrollTop: wrap.scrollTop,
      wrapOverflowX: getComputedStyle(wrap).overflowX
    };
  });

  // ---------- before: old rules on top
  const oldStyle = await page.addStyleTag({ content: OLD_CSS });
  await page.waitForTimeout(150);
  const before = await measure();
  await page.screenshot({ path: path.join(SHOTS, 'md-table-wide-before.png') });
  await page.evaluate(el => el.remove(), oldStyle);
  await page.waitForTimeout(150);

  // ---------- after
  const after = await measure();
  await page.screenshot({ path: path.join(SHOTS, 'md-table-wide.png') });

  console.log('before ' + JSON.stringify(before));
  console.log('after  ' + JSON.stringify(after));

  ok(after.longMarked > 0, 'long column marked .md-cell-long', after.longMarked);
  ok(after.shortMarked > 0, 'short columns marked .md-cell-short', after.shortMarked);
  ok(after.dateWhiteSpace === 'nowrap', 'date cells are nowrap', after.dateWhiteSpace);
  ok(after.dateMaxLines === 1, 'date cells stay on one line', { lines: after.dateMaxLines, before: before.dateMaxLines });
  ok(after.tableH < before.tableH * 0.8, 'the table got markedly shorter', { before: before.tableH, after: after.tableH });
  ok(after.longMin >= 300, 'long column keeps a readable width', { w: after.longMin, before: before.longMin });
  ok(after.longMin > before.longMin, 'long column wider than before', { after: after.longMin, before: before.longMin });
  ok(after.tableW > 760, 'table breaks out of the 760px prose measure', after.tableW);
  ok(after.tableW <= after.wrapW + 1 || after.wrapOverflowX === 'auto',
    'table fits the pane or scrolls inside its wrapper', { tableW: after.tableW, wrapW: after.wrapW });
  ok(after.wrapW <= after.pane + 1, 'wrapper stays inside the reader pane', { wrapW: after.wrapW, pane: after.pane });
  ok(after.wrapScrollLeft === 0, 'a fitting table does not scroll');
  ok(after.tall, 'a tall table scrolls inside its own frame', after.tall);
  // 引言裡的表：不包框、不出引言框
  const bq = await page.evaluate(() => {
    const box = document.querySelector('#readerBody.md blockquote');
    const t = box && box.querySelector('table');
    if (!box || !t) return null;
    const br = box.getBoundingClientRect(), tr = t.getBoundingClientRect();
    return { wrapped: !!t.closest('.md-table-wrap'), left: tr.left, right: tr.right,
      boxLeft: br.left, boxRight: br.right };
  });
  ok(bq && !bq.wrapped, 'table inside a blockquote is not wrapped (no breakout)', bq);
  ok(bq && bq.left >= bq.boxLeft - 1 && bq.right <= bq.boxRight + 1,
    'table inside a blockquote stays inside the blockquote box', bq);
  // 捲框時表頭要釘住，不能跟著跑掉
  const stick = await page.evaluate(() => {
    const wrap = document.querySelector('#readerBody.md .md-table-wrap');
    const th = wrap.querySelector('th');
    const top0 = th.getBoundingClientRect().top;
    wrap.scrollTop = 300;
    return { top0, top1: th.getBoundingClientRect().top, scrolled: wrap.scrollTop,
      wrapTop: wrap.getBoundingClientRect().top };
  });
  ok(stick.scrolled > 0 && Math.abs(stick.top1 - stick.wrapTop) < 3,
    'the sticky header stays at the top of the frame while scrolling', stick);
  await page.evaluate(() => { document.querySelector('#readerBody.md .md-table-wrap').scrollTop = 0; });

  // ---------- 10 columns: must scroll inside the wrapper, not push the page wide
  // deliveries open full-width now, so give the 10-column table a pane it cannot fit
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(XWIDE, 'extra-wide-table.md');
  const xw = await page.evaluate(() => {
    const wrap = document.querySelector('#readerBody.md .md-table-wrap');
    const body = document.getElementById('readerBody');
    wrap.scrollLeft = 99999;
    const out = {
      scrollable: wrap.scrollWidth > wrap.clientWidth,
      wrapScrollLeft: wrap.scrollLeft,
      tall: wrap.classList.contains('md-table-tall'),
      wrapScrollTop: wrap.scrollTop,
      scrolled: wrap.scrollLeft,
      overflowX: getComputedStyle(wrap).overflowX,
      wrapRight: wrap.getBoundingClientRect().right,
      paneRight: body.getBoundingClientRect().right,
      bodyScrollW: body.scrollWidth, bodyClientW: body.clientWidth
    };
    // sticky header check: scroll the pane down and read the header cell's top offset
    body.scrollTop = 400;
    const th = document.querySelector('#readerBody.md th');
    const wr = wrap.getBoundingClientRect();
    out.thTop = th.getBoundingClientRect().top;
    out.wrapTop = wr.top;
    out.sticky = getComputedStyle(th).position;
    return out;
  });
  ok(xw.overflowX === 'auto' && xw.scrollable, 'very wide table scrolls inside its wrapper', xw);
  ok(xw.scrolled > 0, 'wrapper actually scrolls horizontally', xw.scrolled);
  ok(xw.wrapRight <= xw.paneRight + 1 && xw.bodyScrollW <= xw.bodyClientW + 1,
    'wide table does not make the page scroll sideways', xw);
  ok(xw.sticky === 'sticky' && Math.abs(xw.thTop - xw.wrapTop) < 3, 'header row stays stuck while scrolling', xw);
  await page.evaluate(() => { document.getElementById('readerBody').scrollTop = 0; });
  await page.screenshot({ path: path.join(SHOTS, 'md-table-wide-scroll.png') });
  await open(DOC, 'wide-table.md');

  // ---------- narrow window: still no page-wide scrolling
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(200);
  const narrow = await page.evaluate(() => {
    const wrap = document.querySelector('#readerBody.md .md-table-wrap');
    const body = document.getElementById('readerBody');
    const long = [...document.querySelectorAll('#readerBody.md td:nth-child(5)')]
      .filter(c => c.tagName === 'TD').map(c => c.getBoundingClientRect().width);
    return { scrollable: wrap.scrollWidth > wrap.clientWidth + 1, overflowX: getComputedStyle(wrap).overflowX,
      longMin: Math.min(...long), bodyScrollW: body.scrollWidth, bodyClientW: body.clientWidth };
  });
  ok(narrow.longMin >= 300, 'narrow window: long column still readable', narrow);
  ok(narrow.overflowX === 'auto', 'narrow window: wrapper can still scroll if needed', narrow.overflowX);
  ok(narrow.bodyScrollW <= narrow.bodyClientW + 1, 'narrow window: no sideways page scroll', narrow);
  await page.screenshot({ path: path.join(SHOTS, 'md-table-wide-narrow.png') });
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.waitForTimeout(150);

  // ---------- both themes still read (the defaults follow the OS, so pin each one)
  for (const theme of ['light', 'dark']) {
    await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    await page.waitForTimeout(120);
    const m = await measure();
    ok(m.longMin >= 300, `${theme} theme: long column still readable`, m.longMin);
    ok(m.dateMaxLines === 1, `${theme} theme: date cells still one line`, m.dateMaxLines);
    await page.screenshot({ path: path.join(SHOTS, `md-table-wide-${theme}.png`) });
  }
  } finally {   // 逾時／出錯也要收掉子進程與瀏覽器
    if (browser) await browser.close().catch(() => {});
    browser = null;
    if (server) { server.kill(); server = null; }
  }
}

main()
  .then(() => {
    ok(consoleErrors.length === 0, 'no console errors', consoleErrors);
    ok(pageErrors.length === 0, 'no page errors', pageErrors);
  })
  .catch(e => { console.log('FAIL harness ' + e.stack); failed++; })
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
    process.exit(failed ? 1 : 0);
  });
