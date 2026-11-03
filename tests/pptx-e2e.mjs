// tests/pptx-e2e.mjs — .pptx slides kind 驗收（埠 5192，自起自關）。
// 夾具：tests/fixtures/deck.pptx（由 tests/fixtures/make_pptx_fixture.py 生成，
// 3 張投影片：標題／內文含「閃電小螺絲」／一張小圖）。跑法：node tests/pptx-e2e.mjs
// 驗證：列表出現卡 → 閱讀面板渲染投影片卡（文字＋圖片進 DOM）→ 欄寬變、投影片等比縮放
//       → Ctrl+F 找得到投影片文字 → 類型 chip 篩得出 → 縮圖畫出第一張投影片內容（非空白），
//       fflate 不在時退回通用圖示不報錯。
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5192;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'deck.pptx');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const consoleErrors = [];
const pageErrors = [];
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

// ---------- fixture ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-pptx-'));
const RDIR = path.join(TMP, 'root');
fs.mkdirSync(RDIR, { recursive: true });
const PPTX = path.join(RDIR, 'deck.pptx');
fs.copyFileSync(FIXTURE, PPTX);
fs.writeFileSync(path.join(RDIR, 'note.md'), '# note\nother kind for the chips filter\n');
fs.writeFileSync(path.join(RDIR, 'data.csv'), 'a,b\n1,2\n');
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [RDIR], pinned: [], convoRoots: [] }, null, 2));

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

let server = null;
let browser = null;

async function main() {
  server = await startServer();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto(`${BASE}/?open=${encodeURIComponent(PPTX)}`);
  await page.waitForFunction(() => window.__dbg && window.__dbg.ready(), null, { timeout: 20000 });
  await page.waitForFunction(() => window.__dbg.panel().open && window.__dbg.panel().file === 'deck.pptx', null, { timeout: 15000 });

  // 1. 列表出現 pptx 卡片
  const names0 = await page.evaluate(() => window.__dbg.fileNames(50));
  ok(names0.includes('deck.pptx'), 'list: deck.pptx card appears in the pile', names0);

  // 2. 閱讀面板渲染出投影片卡（3 張）
  await page.waitForFunction(() => document.querySelectorAll('#readerBody .pptx-slide').length === 3, null, { timeout: 10000 });
  const dom = await page.evaluate(() => ({
    slides: document.querySelectorAll('#readerBody .pptx-slide').length,
    text: document.getElementById('readerBody').innerText,
    imgs: document.querySelectorAll('#readerBody .pptx-slide img').length
  }));
  ok(dom.text.includes('閃電小螺絲'), 'render: slide text lands in the DOM (known string found)');
  ok(dom.text.includes('RiffleDesk 投影片驗收'), 'render: slide 1 title lands in the DOM');
  ok(dom.imgs >= 1, 'render: at least one <img> (fixture picture present)', dom.imgs);

  // 2b. parse 層 sanity（與縮圖共用同一段程式）：3 張、第 2 張純文字、>=1 圖
  const parsed = await page.evaluate(async pptxPath => {
    const m = await import('/pptxview.js?' + Date.now());
    const buf = await (await fetch('/api/file?path=' + encodeURIComponent(pptxPath))).arrayBuffer().catch(() => null);
    if (buf) {
      const p = m.parsePptx(buf);
      return { n: p.slides.length, t2: p.slides[1].text, pics: p.slides.reduce((a, s) => a + s.items.filter(i => i.type === 'pic').length, 0) };
    }
    return null;
  }, PPTX);
  ok(parsed && parsed.n === 3 && parsed.t2.includes('閃電小螺絲') && parsed.pics >= 1,
    'parse: parsePptx yields 3 slides, searchable text, >=1 picture', parsed);

  // 3. 欄寬改變 → 投影片等比縮放
  const scaleAt = () => page.evaluate(() => {
    const inner = document.querySelector('#readerBody .pptx-slide-inner');
    const outer = inner && inner.parentElement;
    if (!inner) return null;
    return { sc: +parseFloat((inner.style.transform.match(/scale\(([^)]+)\)/) || [0, '1'])[1]).toFixed(3), ow: outer.clientWidth };
  });
  const s1 = await scaleAt();
  await page.evaluate(() => window.__dbg.setFracs({ tree: 0.5, view: 0, reader: 0.5 }));
  await sleep(300);   // 等 ResizeObserver
  const s2 = await scaleAt();
  ok(s1 && s2 && Math.abs(s2.sc - s1.sc * (s2.ow / s1.ow)) < 0.02 && s2.ow < s1.ow,
    'resize: slide scales proportionally with the column width', { s1, s2 });
  const ratio = await page.evaluate(() => {
    const o = document.querySelector('#readerBody .pptx-slide');
    return +(o.clientWidth / o.clientHeight).toFixed(3);
  });
  ok(Math.abs(ratio - 4 / 3) < 0.05, 'resize: slide keeps 4:3 aspect', ratio);

  // 4. Ctrl+F 找得到投影片內文字
  await page.evaluate(() => document.getElementById('btnFind').click());
  await page.waitForFunction(() => !document.getElementById('findBar').hidden, null, { timeout: 4000 });
  await page.fill('#findBar .fq', '閃電小螺絲');
  await page.waitForFunction(() => document.querySelector('#findBar .fc').textContent.includes('/'), null, { timeout: 5000 });
  const findInfo = await page.evaluate(() => ({
    count: document.querySelector('#findBar .fc').textContent,
    marks: document.querySelectorAll('#readerBody mark.fhit').length
  }));
  ok(!/0/.test(findInfo.count) && findInfo.marks >= 1, 'find: Ctrl+F locates slide text', findInfo);
  await page.evaluate(() => document.querySelector('#findBar .fclose').click());

  // 5. 類型 chip 篩得出 fixture
  await page.evaluate(() => window.__dbg.selectChip('slides'));
  await sleep(500);
  const chipView = await page.evaluate(() => window.__dbg.fileNames(50));
  ok(chipView.includes('deck.pptx') && !chipView.includes('note.md') && !chipView.includes('data.csv'),
    'chips: .pptx filter shows only the deck', chipView);
  await page.evaluate(() => window.__dbg.selectChip('all'));

  // 6. 縮圖：畫出第一張投影片內容（非空白）；fflate 缺席 → 通用圖示不報錯
  const thumb = await page.evaluate(async pptxPath => {
    const m = await import('/thumbs.js?' + Date.now());
    const fake = { path: pptxPath, kind: 'slides', name: 'deck.pptx', ext: '.pptx', size: 48423, mtime: Date.now() };
    const stats = c => {
      const g = c.getContext('2d');
      const d = g.getImageData(0, 100, c.width, c.height - 100).data;   // 跳過檔名列
      const bg = [d[3], d[0], d[1], d[2]];   // 左上＝底色（a,r,g,b 轉回）
      let diff = 0;
      for (let i = 0; i < d.length; i += 64) {   // 抽樣 1/16 像素
        if (Math.abs(d[i + 3] - d[3]) > 8 || Math.abs(d[i] - d[0]) > 12 || Math.abs(d[i + 1] - d[1]) > 12) diff++;
      }
      return diff;
    };
    const c1 = await m.buildThumbCanvas(fake);
    const withLib = stats(c1);
    const F = window.fflate;
    delete window.fflate;                        // 模擬 fflate 沒載到
    let noLibError = null, noLibDiff = -1;
    try {
      const c2 = await m.buildThumbCanvas(fake);
      noLibDiff = stats(c2);
    } catch (e) { noLibError = String(e); }
    window.fflate = F;
    return { withLib, noLibError, noLibDiff };
  }, PPTX);
  ok(thumb.withLib > 20, 'thumb: first-slide content painted into the canvas (not blank)', thumb.withLib);
  ok(thumb.noLibError === null && thumb.noLibDiff > 0, 'thumb: no fflate → generic icon, no error', thumb);

  // 7. 全程無頁面報錯
  ok(pageErrors.length === 0, 'no page errors', pageErrors.slice(0, 3));
  const realConsoleErrs = consoleErrors.filter(e => !/favicon/.test(e));
  ok(realConsoleErrs.length === 0, 'no console errors', realConsoleErrs.slice(0, 3));
}

main()
  .catch(e => { console.error('FATAL', e); failed++; })
  .finally(async () => {
    if (browser) await browser.close();
    if (server) server.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(failed ? `FAIL ${failed}` : 'ALL OK');
    process.exit(failed ? 1 : 0);
  });
