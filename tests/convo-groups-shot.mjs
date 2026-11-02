// 驗收截圖：左欄對話區改成「24 小時內／更早」兩個摺疊群組
// 用法：node shot.mjs  （自起 5190 伺服器，跑完關掉）
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'D:/workspace/3jsfloder';
const OUT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5190;

const srv = spawn(process.execPath, [path.join(REPO, 'server.js'), String(PORT)], { stdio: 'ignore' });
process.on('exit', () => srv.kill());
await new Promise(r => setTimeout(r, 1200));

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// 1) 預設：24 小時內展開、更早收起
await page.screenshot({ path: path.join(OUT, 'shot-1-default.png') });

// 2) 展開「更早」（第一次會觸發全歷史掃描，等它回來，上限 120 秒）
const t0 = Date.now();
await page.click('#convos .gsec:nth-of-type(2)').catch(async () => {
  // gsec 可能不是 nth-of-type 目標，用文字找
  await page.locator('#convos .gsec:has-text("更早")').click();
});
await page.waitForFunction(
  () => !document.querySelector('#convos .crow-empty') ||
        ![...document.querySelectorAll('#convos .crow-empty')].some(e => e.textContent.includes('載入中')),
  null, { timeout: 120000 });
await page.waitForTimeout(800);
console.log('deep scan ms:', Date.now() - t0);
await page.screenshot({ path: path.join(OUT, 'shot-2-earlier-open.png') });

// 3) 收合「24 小時內」，只剩更早開著
await page.locator('#convos .gsec:has-text("24 小時內")').click();
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, 'shot-3-only-earlier.png') });

await browser.close();
srv.kill();
console.log('DONE');
