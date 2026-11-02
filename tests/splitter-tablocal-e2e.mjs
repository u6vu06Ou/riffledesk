// tests/splitter-tablocal-e2e.mjs — 兩個 UI 修補的驗收（歐哥 2026-11-02 回報）：
//   1. 三欄模式下「樹｜卡堆」分隔線（#splitter）藏起來拖不到 → 改為 full 以外都能拖
//   2. file:// 分頁的本地 PDF 在閱讀欄不吃滿（iframe 的 height:100% 落在未定高的
//      .tabfile-body 上塌掉）→ tablocal 版面改 flex column，內容盒吃滿剩餘高度
// 自帶夾具＋臨時 config，5198 起伺服器，模擬擴充推一個 file:// PDF 分頁，跑完關掉。
// 用法：node tests/splitter-tablocal-e2e.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5198;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const pageErrors = [];
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

// ---------------------------------------------------------------- fixture
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-splpdf-'));
const RD = p => path.join(TMP, ...p.split('/'));
fs.mkdirSync(RD('root'), { recursive: true });
for (let i = 1; i <= 6; i++) {
  fs.writeFileSync(RD(`root/note${i}.md`), `# note ${i}\nsplitter fixture\n`);
}
const JSON_PATH = RD('root/data.json');
fs.writeFileSync(JSON_PATH, '{"alpha": 1, "beta": "two", "gamma": [3, 4]}\n');
// 最小合法 PDF：只要 /api/file 以 application/pdf 送出、Chrome 內建檢視器肯接就行
const PDF_BODY = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj',
  'xref', '0 4',
  '0000000000 65535 f ',
  'trailer<</Size 4/Root 1 0 R>>',
  'startxref', '0', '%%EOF'
].join('\n');
const PDF_PATH = RD('root/fix.pdf');
fs.writeFileSync(PDF_PATH, PDF_BODY);
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [RD('root')], pinned: [], convoRoots: [] }, null, 2));

const SHOT = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD/2Q==';
const EXT_TOKEN = 'e'.repeat(48);
const EXT_HEADERS = { 'X-RiffleDesk-Ext': '1', 'X-RiffleDesk-Token': EXT_TOKEN };

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

async function extPushTabs(tabs) {
  const r = await fetch(BASE + '/api/tabs', {
    method: 'POST',
    headers: { ...EXT_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ tabs })
  });
  return r.status;
}

let server = null;
let browser = null;

async function main() {
  server = await startServer();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.__dbg && window.__dbg.ready());
  await sleep(800);
  const know = page.locator('#hint button');
  if (await know.count()) await know.first().click().catch(() => {});

  // ---------- A. 三欄模式下的「樹｜卡堆」分隔線 ----------
  // A1. twocol（開檔前）本來就能看到、能拖 —— 行為不得改變
  const twocolSplit = await page.evaluate(() => {
    const s = document.getElementById('splitter');
    return { mode: window.__dbg.mode(), display: getComputedStyle(s).display };
  });
  ok(twocolSplit.mode === 'twocol' && twocolSplit.display !== 'none', 'twocol：#splitter 可見（原有行為）', twocolSplit);

  // A2. 開檔 → 三欄；#splitter 必須可見（這是這次的修補點）
  ok(await page.evaluate(() => window.__dbg.openFileByName('note1.md')), '開 note1.md 進閱讀欄');
  await page.waitForFunction(() => window.__dbg.mode() === 'threecol', null, { timeout: 5000 });
  const triSplit = await page.evaluate(() => ({
    mode: window.__dbg.mode(), display: getComputedStyle(document.getElementById('splitter')).display
  }));
  ok(triSplit.display !== 'none', 'threecol：#splitter 可見（修補前是 display:none）', triSplit);

  // A3. 真拖：往右 150px，樹要變寬同樣多；模式維持三欄
  const before = await page.evaluate(() => ({ tree: document.getElementById('tree').getBoundingClientRect().width, frac: window.__dbg.fracs().tree }));
  const sRect = await page.evaluate(() => {
    const r = document.getElementById('splitter').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(sRect.x, sRect.y);
  await page.mouse.down();
  for (let d = 30; d <= 150; d += 30) { await page.mouse.move(sRect.x + d, sRect.y); await sleep(30); }
  await page.mouse.up();
  await sleep(200);
  const after = await page.evaluate(() => ({ tree: document.getElementById('tree').getBoundingClientRect().width, frac: window.__dbg.fracs().tree, mode: window.__dbg.mode() }));
  ok(Math.abs((after.tree - before.tree) - 150) < 6, 'threecol：拖 #splitter 往右 150px → 樹寬 +150', { before, after });

  // A4. 雙擊回預設 0.15（拖完分隔線已移位，要重取座標）
  const sRect2 = await page.evaluate(() => {
    const r = document.getElementById('splitter').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.dblclick(sRect2.x, sRect2.y);
  await sleep(200);
  const dbl = await page.evaluate(() => window.__dbg.fracs().tree);
  ok(Math.abs(dbl - 0.15) < 0.01, 'threecol：雙擊 #splitter 回預設 0.15', dbl);

  // ---------- B. file:// PDF 分頁在閱讀欄吃滿 ----------
  // 模擬擴充推一個本機 PDF 分頁（含截圖，跟使用者實況一樣 bar＋截圖＋PDF 三段式）
  const pdfUrl = 'file:///' + PDF_PATH.replace(/\\/g, '/');
  const st = await extPushTabs([{ id: 201, windowId: 1, title: 'fix.pdf', url: pdfUrl, fav: '', active: true, lastAccessed: Date.now(), shot: SHOT }]);
  ok(st === 200, '模擬擴充推 file:// PDF 分頁', st);

  await page.click('#btnTabs');
  await page.waitForFunction(() => {
    const s = window.__dbg.scene();
    return s.view.length === 1 && s.view[0].tab && !s.view[0].tab.note;
  }, null, { timeout: 8000 });
  ok(await page.evaluate(() => window.__dbg.openFileByName('fix.pdf')), '點開 PDF 分頁卡');
  await page.waitForFunction(() => {
    const b = document.getElementById('readerBody');
    return b && b.querySelector('.tabfile-body iframe');
  }, null, { timeout: 8000 });
  await sleep(400);

  const fill = await page.evaluate(() => {
    const body = document.getElementById('readerBody');
    const kids = [...body.children].map(c => (c.className || '').split(' ')[0]);
    const box = body.querySelector('.tabfile-body');
    const ifr = box.querySelector('iframe');
    const shot = body.querySelector('.tabshot');
    const bar = body.querySelector('.tabview-bar');
    const ifrRect = ifr.getBoundingClientRect();
    return {
      tablocal: body.classList.contains('tablocal'),
      boxFlex: getComputedStyle(box).flexGrow,
      kids,
      boxIdx: kids.indexOf('tabfile-body'),
      shotIdx: (shot && shot.parentElement === body) ? kids.indexOf('tabshot') : -1,
      ifrSrc: ifr.src.slice(0, 60),
      barBottom: Math.round(bar.getBoundingClientRect().bottom),
      ifrTop: Math.round(ifrRect.top),
      ifrH: Math.round(ifrRect.height),
      bodyH: Math.round(body.getBoundingClientRect().height)
    };
  });
  ok(fill.tablocal, '閱讀區掛上 tablocal（flex 填滿版面）', fill);
  ok(fill.boxIdx === 1 && fill.shotIdx === -1, 'PDF 本體排在按鈕列之後、截圖整張不顯示', fill);
  ok(fill.ifrTop - fill.barBottom < 24, 'PDF iframe 緊接在操作列下方（首屏直接看）', fill);
  ok(fill.ifrH > fill.bodyH * 0.7, 'PDF iframe 高度佔閱讀區七成以上（近乎全版面）', fill);

  // iframe 指向的 /api/file 真的要回 200 application/pdf
  const pdfApi = await page.evaluate(async () => {
    const ifr = document.querySelector('#readerBody .tabfile-body iframe');
    const r = await fetch(ifr.src, { method: 'HEAD' }).catch(() => null);
    return r ? { status: r.status, type: r.headers.get('content-type') } : null;
  });
  ok(pdfApi && pdfApi.status === 200 && /pdf/.test(pdfApi.type || ''), 'iframe 來源 /api/file 回 200 application/pdf', pdfApi);

  // ---------- C. PDF iframe 預設收側欄＋適寬（#navpanes=0&zoom=page-width）----------
  const fragSrc = await page.evaluate(() => document.querySelector('#readerBody .tabfile-body iframe').src);
  ok(/#navpanes=0&zoom=page-width$/.test(fragSrc), 'PDF iframe 帶 navpanes=0&zoom=page-width（收側欄＋依寬縮放）', fragSrc.slice(-60));

  // ---------- D. 檔案／分頁切換鈕釘在搜尋框右邊（切模式不左右跳）----------
  // 目前停在大分頁（tabs-on）。記下 modeSeg 左緣，切回檔案再量一次。
  const segTabs = await page.evaluate(() => document.getElementById('modeSeg').getBoundingClientRect().left);
  await page.click('#btnModeFiles');
  await sleep(300);
  const segFiles = await page.evaluate(() => document.getElementById('modeSeg').getBoundingClientRect().left);
  ok(Math.abs(segTabs - segFiles) < 2, '檔案／分頁模式切換時 modeSeg 左緣不動', { segTabs: Math.round(segTabs), segFiles: Math.round(segFiles) });
  // 而且就貼在搜尋框右邊（間距 = toolbar gap 8px，寬限 24px）
  const segAfterSearch = await page.evaluate(() => {
    const s = document.getElementById('searchBox').getBoundingClientRect();
    const m = document.getElementById('modeSeg').getBoundingClientRect();
    return Math.round(m.left - s.right);
  });
  ok(segAfterSearch >= 0 && segAfterSearch < 24, 'modeSeg 緊鄰搜尋框右側', segAfterSearch);

  // ---------- E. 無快照網頁分頁（如 Google 試算表）顯示說明而非默默空白 ----------
  const st2 = await extPushTabs([
    { id: 201, windowId: 1, title: 'fix.pdf', url: pdfUrl, fav: '', active: false, lastAccessed: Date.now(), shot: SHOT },
    { id: 202, windowId: 1, title: 'Sheet', url: 'https://docs.google.com/spreadsheets/d/abc/edit', fav: '', active: true, lastAccessed: Date.now() + 1 }
    // 沒有 shot：模擬 canvas 類頁面（截圖還沒拍到也不到）
  ]);
  ok(st2 === 200, '模擬擴充推無快照的網頁分頁', st2);
  await page.click('#btnTabs');
  await sleep(600);
  ok(await page.evaluate(() => window.__dbg.openFileByName('Sheet')), '點開無快照網頁分頁卡');
  await sleep(400);
  const noShotNote = await page.evaluate(() => {
    const b = document.getElementById('readerBody');
    return { hasImg: !!b.querySelector('.tabshot'), notes: [...b.querySelectorAll('.tabstat')].map(n => n.textContent.slice(0, 20)) };
  });
  ok(!noShotNote.hasImg && noShotNote.notes.some(s => s.length > 8 && !/^(抓不到|failed)/i.test(s)),
    '無快照分頁出現說明文字（不讓人以為壞掉）', noShotNote);

  // ---------- F. JSON 卡片縮圖跟隨程式碼配色主題（歐哥 2026-11-02：One Dark 沒套用到卡片）----------
  const themeCheck = await page.evaluate(async (jpath) => {
    const ct = await import('./codetheme.js');
    const th = await import('./thumbs.js');
    ct.setCodeTheme('one-dark');
    const f = { name: 'data.json', path: jpath, ext: '.json', kind: 'json', size: 64, mtime: Date.now() };
    const c = await th.buildThumbCanvas(f);
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(100, 500, 1, 1).data;   // 卡身中段（標題列 96px 以下）
    ct.setCodeTheme('follow');
    return { r: d[0], g: d[1], b: d[2] };
  }, JSON_PATH);
  // One Dark 底色 #282c34：修好前這裡是 UI 淺色卡身（theme() 的底色）
  ok(themeCheck.r === 0x28 && themeCheck.g === 0x2c && themeCheck.b === 0x34,
    'JSON 卡縮圖底色跟隨 One Dark（#282c34）', themeCheck);

  ok(pageErrors.length === 0, '頁面無 JS 錯誤', pageErrors.slice(0, 3));
}

main().catch(e => { console.error('FATAL', e); failed = 1; })
  .finally(async () => {
    try { if (browser) await browser.close(); } catch (_) {}
    try { if (server) server.kill(); } catch (_) {}
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(failed ? `\n== ${failed} FAIL ==` : '\n== ALL PASS ==');
    process.exit(failed ? 1 : 0);
  });
