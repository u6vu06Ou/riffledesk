// probe: does Chrome's built-in PDF viewer honor open parameters in the URL fragment?
// Loads the same 6-page PDF via /api/file with different fragments, screenshots the iframe,
// and measures (a) toolbar visible?, (b) thumbnail sidebar open?, (c) page width ratio.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodePng } from './png-pixels.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfprobe-'));
fs.mkdirSync(path.join(TMP, 'root'), { recursive: true });
const PDF_PATH = path.join(TMP, 'root', 'six.pdf');
// 由下方 page.pdf() 產生真正合法的 6 頁 PDF（手刻的最小 PDF pdfium 不肯算）
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [path.join(TMP, 'root')], pinned: [], convoRoots: [] }));

function startServer() {
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: CFG, RIFFLEDESK_INDEX: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  return new Promise((res, rej) => {
    let out = '';
    const to = setTimeout(() => rej(new Error('timeout: ' + out)), 15000);
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) { clearTimeout(to); res(proc); } });
    proc.stderr.on('data', d => { out += d; });
  });
}

// measure iframe content from a screenshot buffer
function analyze(pngBuf, rect) {
  const img = decodePng(pngBuf);
  const at = (x, y) => img.px(Math.round(x), Math.round(y));
  const lum = p => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
  const isBlue = p => p[2] > 150 && p[0] < 150;
  const x0 = rect.x, y0 = rect.y, w = rect.width, h = rect.height;
  // toolbar row: 20px into iframe — light gray chrome vs white page
  let toolbarInk = 0;
  for (let x = x0 + 4; x < x0 + w - 4; x += 6) { if (lum(at(x, y0 + 20)) < 245) toolbarInk++; }
  // find the blue rect's horizontal extent (marks the visible page, sidebar shifts it right)
  const ink = [];
  for (const yy of [y0 + h * 0.35, y0 + h * 0.6, y0 + h * 0.8]) {
    let l = -1, r = -1;
    for (let x = x0 + 2; x < x0 + w - 2; x += 2) {
      if (isBlue(at(x, yy))) { if (l < 0) l = x; r = x; }
    }
    ink.push(l >= 0 ? { left: Math.round(l - x0), width: Math.round(r - l) } : null);
  }
  return { toolbarInk, ink };
}

async function probe(page, frag) {
  // 同源限制：/api/file 擋跨站（Sec-Fetch-Site），所以先進 app 再動態掛 iframe
  await page.evaluate(src => {
    for (const el of [...document.body.children]) el.remove();
    const f = document.createElement('iframe');
    f.src = src;
    f.style.cssText = 'position:fixed;left:0;top:0;width:700px;height:800px;border:0;z-index:99999';
    document.body.appendChild(f);
  }, `${BASE}/api/file?path=${encodeURIComponent(PDF_PATH)}${frag}`);
  await sleep(3000);
  const rect = { x: 0, y: 0, width: 700, height: 800 };
  const shot = await page.screenshot({ clip: rect });
  return { frag: frag || '(none)', ...analyze(shot, rect) };
}

let server = null, browser = null;
try {
  server = await startServer();
  // headless 的 Chrome 不畫 PDF 檢視器（iframe 全白），這個探針要開真視窗才量得到
  browser = await chromium.launch({ executablePath: CHROME, headless: false });
  const ctx = await browser.newContext({ viewport: { width: 760, height: 860 } });
  const page = await ctx.newPage();
  page.on('response', r => { if (r.url().includes('/api/file')) console.log('RESP', r.status(), r.url().slice(0, 90)); });
  page.on('console', m => { if (m.type() === 'error') console.log('PAGE-ERR', m.text().slice(0, 120)); });
  // 先用 Chromium 自己印一份 6 頁 PDF（每頁一個藍色大色塊，位置標記用）
  await page.setContent('<body style="margin:0">' +
    Array.from({ length: 6 }, (_, i) =>
      `<div style="width:180mm;height:270mm;background:#3377dd;page-break-after:always;margin:15mm">Page${i + 1}</div>`
    ).join('') + '</body>');
  const pdfBuf = await page.pdf({ width: '210mm', height: '297mm', printBackground: true });
  fs.writeFileSync(PDF_PATH, pdfBuf);
  await page.goto(BASE + '/');
  const frags = ['', '#navpanes=0', '#zoom=page-width', '#navpanes=0&zoom=page-width', '#view=FitH', '#navpanes=0&view=FitH', '#toolbar=0&navpanes=0&zoom=page-width'];
  for (const f of frags) console.log(JSON.stringify(await probe(page, f)));
  console.log('UA:', await page.evaluate(() => navigator.userAgent));
} catch (e) { console.error('FATAL', e); process.exitCode = 1; }
finally {
  try { if (browser) await browser.close(); } catch (_) {}
  try { if (server) server.kill(); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}
