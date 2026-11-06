import { chromeExecutable } from './chrome-path.mjs';
// tests/deliver-layout-e2e.mjs — what a delivery from AI must look like.
//
// 歐哥's spec (2026-11-05): 當 AI 由產物丟出來給人看的時候,預設不管是什麼類型的檔案都要
// 跳出來可以看,而且不應該出現三分之二的畫面,如果是同一有給一疊的話,應該要出現三個欄位的
// 那一種,然後整疊都要在中間。
//
// The "two-thirds screen" state before this: a projection switched to the `wide` layout
// (tree | reader, the card stack hidden behind the reader at 0 width) so the left third
// was dead, and a pile left the stack squeezed into the left half of the right third with
// the whole thing off-centre. The type chips could also hide the delivered file.
//
// Pinned here, at 1920x1080 and 1440x900, with an md-only type filter preset in
// localStorage (so a delivered .png would be hidden by the chips without the fix):
//  1. a projected .png opens READABLE in the reader — and shows up in the card stack
//     as a card too, even though the type filter excludes it;
//  2. a delivered pile of [md, png, json] lands on the three-column layout, all three
//     cards are present, the stack's bounding box is horizontally centred in the
//     middle column (within 5%), fully inside it, and the reader shows the front card.
// Port 5197. Writes docs/screenshots/deliver-single.png and deliver-pile.png.
// Usage: node tests/deliver-layout-e2e.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5197;
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
// A real (decodable) 320x240 PNG, so "is it shown" means a real image in the reader.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-deliver-'));
const RD = p => path.join(TMP, ...p.split('/'));
function makePng(w, h, rgb) {
  const tbl = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tbl[n] = c >>> 0; }
  const crc = b => { let c = 0xffffffff; for (const x of b) c = tbl[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}
const SOURCE = RD('root/source.md');
const SHOT = RD('root/zebra-shot.png');
const DATA = RD('root/data.json');
const NOTE = RD('root/note.md');
fs.mkdirSync(RD('root'), { recursive: true });
fs.writeFileSync(SOURCE, '# source\n\nthe one type the filter allows\n');
fs.writeFileSync(NOTE, '# note\n\nbody\n');
fs.writeFileSync(DATA, '{"a": 1}\n');
fs.writeFileSync(SHOT, makePng(320, 240, [204, 96, 64]));
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [RD('root')], pinned: [], convoRoots: [] }, null, 2));

function startServer() {
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: CFG, RIFFLEDESK_INDEX: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  return new Promise((res, rej) => {
    let out = '';
    const to = setTimeout(() => rej(new Error('server start timeout: ' + out)), 15000);
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) { clearTimeout(to); res(proc); } });
    proc.stderr.on('data', d => { out += d; });
  });
}

function post(page, url, body) {
  // exactly what the CLI does: loopback JSON + the CLI header
  return page.evaluate(async ([u, b]) => {
    const r = await fetch(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-RiffleDesk-CLI': '1' },
      body: JSON.stringify(b)
    });
    return { status: r.status, body: await r.json() };
  }, [url, body]);
}

// The stack's drawn bounding box vs the middle column it has to sit in.
const geometry = page => page.evaluate(() => {
  const b = window.__dbg.cornerBounds();
  const v = window.__dbg.viewRect();
  return {
    mode: window.__dbg.mode(),
    bounds: b,
    view: v,
    cardCenter: b ? (b.minX + b.maxX) / 2 : null,
    viewCenter: v.x + v.w / 2,
    inside: !!b && b.minX >= v.x - 1 && b.maxX <= v.x + v.w + 1 && b.minY >= v.y - 1 && b.maxY <= v.y + v.h + 1
  };
});

let server = null;
let browser = null;

async function run(width, height, shotSuffix) {
  const tag = width + 'x' + height;
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'zh-TW' });
  // the type filter the user had before the delivery: .md only — the png must still show
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('floderChips2', JSON.stringify(['md']));
      localStorage.setItem('floderViewFrac', '0.82');   // a deliberately lopsided split
    } catch (_) {}
  });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(tag + ': ' + m.text()); });
  page.on('pageerror', e => pageErrors.push(tag + ': ' + String(e)));
  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.__dbg && window.__dbg.ready());
  await sleep(1200);                     // SSE stream attaches after the target poll
  const know = page.locator('#hint button');
  if (await know.count()) await know.first().click().catch(() => {});
  ok(await page.evaluate(() => JSON.stringify(window.__dbg.chipsOn())) === '["md"]', tag + ' preset type filter is .md only');

  // ---------- 1. a single delivered .png (the filter excludes .png) ----------
  const r1 = await post(page, '/api/project', { path: SHOT, source: 'claude-code' });
  ok(r1.status === 200 && r1.body.delivered === 1, tag + ' projection accepted', r1);
  await page.waitForFunction(() => window.__dbg.panel().open && window.__dbg.panel().file === 'zebra-shot.png', null, { timeZoneCheck: 0, timeout: 8000 });
  ok(true, tag + ' the delivered png is open in the reader');
  // a readable preview, not an empty body (give the image its decode time first)
  await page.waitForFunction(() => { const i = document.querySelector('#readerBody img.reader-img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 8000 }).catch(() => {});
  const img = await page.evaluate(() => {
    const i = document.querySelector('#readerBody img.reader-img');
    return i ? { w: i.naturalWidth, shown: i.getBoundingClientRect().height > 40 } : null;
  });
  ok(!!img && img.w === 320 && img.shown, tag + ' the reader shows the actual image', img);
  // the type chips must not hide it from the stack either
  const names = await page.evaluate(() => window.__dbg.fileNames(20));
  ok(names.includes('zebra-shot.png'), tag + ' the delivered png is a card in the stack, not hidden by the chips', names);
  // and no dead third: the reader fills the screen instead of a 2/3 split
  const single = await page.evaluate(() => {
    const r = document.getElementById('reader').getBoundingClientRect();
    return { mode: window.__dbg.mode(), w: r.width, vw: innerWidth };
  });
  ok(single.mode === 'full', tag + ' a single delivery takes the whole view, not the wide 2/3 layout', single);
  ok(single.w > single.vw * 0.95, tag + ' the reader pane is essentially full width', single);
  const nameFilter = await page.evaluate(() => document.getElementById('searchBox').value);
  ok(nameFilter === '', tag + ' the name filter is cleared for the delivery', nameFilter);
  await page.screenshot({ path: path.join(SHOTS, 'deliver-single' + shotSuffix + '.png') });

  // ---------- 2. a delivered pile of mixed types ----------
  const r2 = await post(page, '/api/pile', {
    paths: [NOTE, SHOT, DATA], title: 'Mixed delivery', source: 'claude-code'
  });
  ok(r2.status === 200 && r2.body.ok === true && r2.body.count === 3, tag + ' pile POST kept all three files', r2.body);
  // foreground tab: the pile waits for the toast; clicking it is the delivery opening
  await page.waitForFunction(() => document.getElementById('toast').classList.contains('on'), null, { timeout: 8000 });
  await page.evaluate(() => window.__dbg.pileClickToast());
  await page.waitForFunction(() => window.__dbg.pileState(), null, { timeout: 8000 });
  await page.waitForFunction(() => window.__dbg.panel().open, null, { timeout: 8000 });
  await sleep(900);                       // let the fit settle before measuring

  const g = await geometry(page);
  ok(g.mode === 'threecol', tag + ' a delivered pile switches to the three-column layout', g.mode);
  ok(await page.evaluate(() => document.body.classList.contains('mode-threecol')), tag + ' body carries the threecol class');
  const pileNames = await page.evaluate(() => window.__dbg.fileNames(20));
  ok(['note.md', 'zebra-shot.png', 'data.json'].every(n => pileNames.includes(n)), tag + ' all three delivered cards are in the stack', pileNames);
  ok(!!g.bounds, tag + ' the stack has a measurable bounding box');
  ok(g.view.w > 0, tag + ' the middle column has a real width', g.view);
  ok(Math.abs(g.cardCenter - g.viewCenter) <= g.view.w * 0.05, tag + ' the stack is centred in the middle column (within 5%)',
    { cardCenter: g.cardCenter, viewCenter: g.viewCenter, width: g.view.w });
  ok(g.inside, tag + ' the whole stack fits inside the middle column', { bounds: g.bounds, view: g.view });
  ok(g.bounds.w > g.view.w * 0.5, tag + ' the stack uses most of the column, not a squeezed corner', { w: g.bounds.w, col: g.view.w });
  // the reader shows the card at the front of the stack
  const front = await page.evaluate(() => {
    const c = window.__dbg.visibleCards()[0];
    return { card: c && c.name, open: window.__dbg.panel().file };
  });
  ok(front.card && front.card === front.open, tag + ' the reader shows the front card of the pile', front);
  await page.screenshot({ path: path.join(SHOTS, 'deliver-pile' + shotSuffix + '.png') });

  await ctx.close();
}

async function main() {
  server = await startServer();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  await run(1920, 1080, '');
  await run(1440, 900, '-1440');
  ok(consoleErrors.length === 0, 'no console errors', consoleErrors);
  ok(pageErrors.length === 0, 'no page errors', pageErrors);
}

try {
  await main();
} catch (e) {
  console.log('FAIL crashed: ' + (e && e.stack || e));
  failed++;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
