import { chromeExecutable } from './chrome-path.mjs';
// tests/proj-wide-browse-e2e.mjs — 歐哥 2026-11-02 回報「AI 投影網頁後介面卡住」的修法驗收：
//  投影單檔 → 閱讀欄整個畫面（卡堆藏起來）。此時點左欄樹的資料夾原是「零可見回饋」
//  （mode 停著、卡堆不現形、reader 不動，看起來像整個卡住）。
//  修法：wide／full 下使用者點樹＝要逛檔案 → 回三欄讓卡堆露臉。
//  投影本身（tree.lock 也走 onLock）不能被彈回：projectOpen 最後仍自己定案版面。
//  （2026-11-05 起單檔投影落在 full 而不是 wide——見 tests/deliver-layout-e2e.mjs。）
// 用法：node tests/proj-wide-browse-e2e.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5197;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = chromeExecutable();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pageErrors = [];
let failed = 0;
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-projwide-'));
const RD = p => path.join(TMP, ...p.split('/'));
fs.mkdirSync(RD('root/proj'), { recursive: true });
fs.mkdirSync(RD('root/other'), { recursive: true });
fs.writeFileSync(RD('root/proj/a.html'),
  '<!doctype html><meta charset="utf-8"><h1>AAA 投影頁</h1><script>1+1</script>');
fs.writeFileSync(RD('root/proj/b.md'), '# BBB 筆記\n點我要切過來\n');
fs.writeFileSync(RD('root/other/c.md'), '# CCC 另一個資料夾\n');
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [RD('root')], pinned: [], convoRoots: [] }, null, 2));

function startServer() {
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: CFG, RIFFLEDESK_INDEX: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  return new Promise((res, rej) => {
    let out = '';
    const to = setTimeout(() => rej(new Error('server start timeout: ' + out)), 15000);
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) { clearTimeout(to); res(proc); } });
    proc.stderr.on('data', d => { out += d; });
  });
}

let page = null;
const readerText = () => page.evaluate(() => document.getElementById('readerBody').textContent.slice(0, 60));
const mode = () => page.evaluate(() => window.__dbg.mode());

// 點樹上的資料夾（可能要先展開父層）：找不到就把看得見的列逐個展開再試
async function clickFolder(name, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const row = page.locator('#tree .trow:visible', { hasText: name }).first();
    if (await row.count()) { await row.click(); return true; }
    const t = await page.locator('#tree .trow .tw').all();
    if (!t.length) return false;
    await t[t.length - 1].click();
    await sleep(400);
  }
  const row = page.locator('#tree .trow', { hasText: name }).first();
  if (await row.count()) { await row.click(); return true; }
  return false;
}

let server = null, browser = null;
try {
  server = await startServer();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.__dbg && window.__dbg.ready());
  await sleep(600);

  // --- A. 模擬 AI CLI 推 a.html → wide＋右欄內容到位 ---
  const st = await fetch(BASE + '/api/project', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-RiffleDesk-CLI': '1' },
    body: JSON.stringify({ path: RD('root/proj/a.html'), source: 'probe' })
  }).then(r => r.status);
  ok(st === 200, '模擬 CLI 投影 a.html', st);
  await page.waitForFunction(() => document.getElementById('readerBody').textContent.includes('AAA'), null, { timeout: 8000 });
  await sleep(600);
  ok(await mode() === 'full', '投影後進全幅閱讀版面');

  // --- B. 全幅下點樹上的別的資料夾 → 回三欄（修補點：以前是零回饋卡住） ---
  // 全幅藏了樹：Esc 退回 wide 再點（第一下 Esc 先收掉新手說明）
  await page.keyboard.press('Escape'); await sleep(300); if (await mode() === 'full') await page.keyboard.press('Escape'); await sleep(1200);
  ok(await mode() === 'wide', 'Esc → wide（樹出現）', { mode: await mode() });
  ok(await clickFolder('other'), '樹上點到 other 資料夾');
  await sleep(800);
  ok(await mode() === 'threecol', 'wide 下點樹 → 回三欄（卡堆露出來）', { mode: await mode() });
  const st1 = await page.evaluate(() => window.__dbg.fracs());
  ok(st1.view > 0.1, '三欄下卡堆有可見寬度', st1);

  // --- C. 三欄再點 proj → 留在三欄，不該彈回 wide ---
  ok(await clickFolder('proj'), '樹上點到 proj 資料夾');
  await sleep(800);
  ok(await mode() === 'threecol', '三欄下點樹 → 維持三欄', { mode: await mode() });

  // --- D. 投影清單列（剛投影給我的）點回去 → reader 換回 a.html、進全幅 ---
  await page.locator('#tree .proj-row', { hasText: 'a.html' }).first().click();
  await page.waitForFunction(() => document.getElementById('readerBody').textContent.includes('AAA'), null, { timeout: 8000 });
  await sleep(500);
  ok(await mode() === 'full', '點投影清單 → 回全幅閱讀看投影檔', { mode: await mode() });

  // --- E. 跑起來（執行網頁程式）後再點樹：iframe 內容要留著、版面照樣回三欄 ---
  const btnRun = page.locator('#btnRun');
  if (await btnRun.isVisible()) {
    await btnRun.click();
    await sleep(1000);
    ok(await page.evaluate(() => !!document.querySelector('#readerBody iframe')), '執行網頁程式 → iframe 出現');
    await page.mouse.click(5, 5); await page.keyboard.press('Escape'); await sleep(300); if (await mode() === 'full') await page.keyboard.press('Escape'); await sleep(1000);   // 全幅藏了樹：先退回 wide
    ok(await clickFolder('other'), '執行中點樹 other');
    await sleep(800);
    ok(await mode() === 'threecol', '執行中點樹 → 也回三欄', { mode: await mode() });
    ok(await page.evaluate(() => !!document.querySelector('#readerBody iframe')), '切完 reader 的執行中頁面還在');
  } else ok(false, 'btnRun 不可見（a.html 該有腳本）');

  ok(pageErrors.length === 0, '頁面無 JS 錯誤', pageErrors.slice(0, 3));
} catch (e) { console.error('FATAL', e); failed = 1; }
finally {
  try { if (browser) await browser.close(); } catch (_) {}
  try { if (server) server.kill(); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(failed ? `\n== ${failed} FAIL ==` : '\n== ALL PASS ==');
  process.exit(failed ? 1 : 0);
}
