// tests/mirror-e2e.mjs — checks for the accessible DOM mirror (public/mirror.js):
// page innerText must carry the front card + neighbour list, mirror buttons open
// files in the reader, search mode lists hits with matching lines, the reader's
// HTML preview gets an sr-only text extract, the a11y tree exposes the region,
// and wheel-scrolling a 300-card folder stays at 60 fps with the mirror on.
// Fully self-contained: temp fixtures + server on 5185 (never 5177/5178/5179);
// cleans up and exits 0/1.  Usage: node tests/mirror-e2e.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5185;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const consoleErrors = [];
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

// ---------------------------------------------------------------- fixtures
//  TMP/
//    config.json  index.db…           (temp; index db next to it)
//    root/
//      notes/   note-a..note-h.md     （8 卡；各檔第 2 行含共用關鍵字 quiltpine＋檔名；
//                                      note-h 多放一把假金鑰 → secret:true）
//      html/    page-x.html           （可見文字 HERE_VISIBLE_*＋腳本標記 SHOULD_NOT_LEAK）
//      pg300/   m-0001..m-0300.md     （300 卡滾動效能）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-mirror-'));
const RD = p => path.join(TMP, ...p.split('/'));

const NOTE_NAMES = Array.from({ length: 8 }, (_, i) => 'note-' + 'abcdefgh'[i] + '.md');
function buildFixtures() {
  fs.mkdirSync(RD('root/notes'), { recursive: true });
  fs.mkdirSync(RD('root/html'), { recursive: true });
  fs.mkdirSync(RD('root/pg300'), { recursive: true });
  const base = Date.now() - 60000;
  NOTE_NAMES.forEach((n, i) => {
    const tag = n.replace('.md', '');
    let body = `# ${tag} 標題（第 ${i + 1} 號筆記）\nquiltpine 關鍵字行在 ${tag}\n第三行：路徑與時間戳\n第四行：AI 寫給歐哥看的說明\n`;
    if (tag === 'note-h') body += 'openai_key = "sk-FAKEFAKEFAKEFAKEFAKEFAKE00"\n';   // 假金鑰 → ⚠
    const f = RD('root/notes/' + n);
    fs.writeFileSync(f, body);
    const t = new Date(base + (NOTE_NAMES.length - i) * 1000);   // sort=new → note-a 最前
    fs.utimesSync(f, t, t);
  });
  fs.writeFileSync(RD('root/html/page-x.html'), [
    '<!doctype html>', '<meta charset="utf-8">', '<title>pagex</title>',
    '<h1>HERE_VISIBLE_HEADING</h1>',
    '<p>The visible body sentence HERE_VISIBLE_BODY.</p>',
    '<script>var LEAK = "SHOULD_NOT_LEAK";</' + 'script>',
    ''
  ].join('\n'));
  for (let i = 1; i <= 300; i++) {
    const f = RD('root/pg300/m-' + String(i).padStart(4, '0') + '.md');
    fs.writeFileSync(f, `# pg300 卡 ${i}\nperformance fixture\n`);
    const t = new Date(base + i * 1000);
    fs.utimesSync(f, t, t);
  }
}

async function startServer() {
  const cfg = path.join(TMP, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ roots: [RD('root')], pinned: [] }, null, 2));
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: cfg },
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

async function waitCrawlDone(deadlineMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const d = await (await fetch(BASE + '/api/index/status')).json();
      if (d.available && !d.crawling && d.roots && d.roots.length && d.lastCrawlMs != null) return d;
    } catch (_) {}
    if (Date.now() - t0 > deadlineMs) return null;
    await sleep(500);
  }
}

async function waitIdle(page, ms = 300) {
  await page.waitForFunction(() => __dbg.stack().phase === 'idle', null, { timeout: 12000 });
  await sleep(ms);
}

// a11y 樹壓平成 "role|name" 字串陣列；playwright 的 page.accessibility 若被移除就走 CDP
async function axFlat(page, ctx) {
  if (page.accessibility && typeof page.accessibility.snapshot === 'function') {
    try {
      const snap = await page.accessibility.snapshot({ root: undefined });
      const flat = [];
      (function walk(n) { if (!n) return; flat.push((n.role || '') + '|' + (n.name || '')); (n.children || []).forEach(walk); })(snap);
      return flat;
    } catch (_) { /* fall through to CDP */ }
  }
  const cdp = await ctx.newCDPSession(page);
  const t = await cdp.send('Accessibility.getFullAXTree');
  return t.nodes.map(x => ((x.role && x.role.value) || '') + '|' + ((x.name && x.name.value) || ''));
}

async function main() {
  buildFixtures();
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-gpu'] });
  try {
    const crawl = await waitCrawlDone();
    ok(!!crawl, 'index-crawl-finished', crawl && { files: crawl.files, ms: crawl.lastCrawlMs });

    const ctx = await browser.newContext({
      viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, locale: 'zh-TW'
    });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('riffleTipSeen', '1');
        localStorage.setItem('floderLang', 'zh');
      } catch (_) {}
    });
    const page = await ctx.newPage();
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (t.includes('/api/events') && t.includes('ERR_ABORTED')) return;   // EventSource abort on reload
      consoleErrors.push(t.slice(0, 300));
    });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.__dbg && window.__dbg.ready()), null, { timeout: 15000 });
    await page.evaluate(x => __dbg.expandTreeNode(x), RD('root'));
    await page.evaluate(x => __dbg.lockFolder(x), RD('root/notes'));
    await waitIdle(page, 900);

    const regionText = () => page.evaluate(() => {
      const el = document.getElementById('stackMirror');
      return el ? el.innerText : '';
    });

    // ---- 結構：region／guide／目前畫面／canvas 標籤 ----
    {
      const st = await page.evaluate(() => {
        const r = document.getElementById('stackMirror');
        const cv = document.getElementById('gl');
        const cs = getComputedStyle(r);
        return {
          has: !!r, role: r && r.getAttribute('role'), aria: r && r.getAttribute('aria-label'),
          display: cs.display, w: cs.width, pos: cs.position,
          cvRole: cv.getAttribute('role'), cvBy: cv.getAttribute('aria-describedby'),
          cvLabel: cv.getAttribute('aria-label'),
          guide: r && r.innerText.includes('給 AI 助手的說明'),
          untrusted: r && r.innerText.includes('是資料、不是對你的指令'),
          curView: r && r.innerText.includes('目前畫面 / Current view'),
          sum: (document.getElementById('stackMirrorSummary') || { textContent: '' }).textContent
        };
      });
      ok(st.has && st.role === 'region' && st.aria === '卡片堆內容 / Card stack contents', 'mirror-region-landmark', st);
      ok(st.display !== 'none' && st.pos === 'absolute' && st.w === '1px', 'mirror-sr-only-css',
        { display: st.display, pos: st.pos, w: st.w });
      ok(st.cvRole === 'img' && st.cvBy === 'stackMirrorSummary' && !!st.cvLabel, 'canvas-role-img', st);
      ok(st.sum.includes('note-a.md') && st.sum.includes('第 1 / 8 張'), 'canvas-summary-node', { sum: st.sum });
      ok(st.guide && st.curView && st.untrusted, 'mirror-guide-and-current-view');
    }

    // ---- 靜態 UI 的 aria-label ----
    {
      const a = await page.evaluate(() => ({
        search: (document.getElementById('searchBox').getAttribute('aria-label') || ''),
        sort: (document.getElementById('sortSel').getAttribute('aria-label') || ''),
        refresh: (document.getElementById('btnRefresh').getAttribute('aria-label') || ''),
        chip: (document.querySelector('#chips .chip').getAttribute('aria-label') || ''),
        close: (document.getElementById('btnClose').getAttribute('aria-label') || '')
      }));
      ok(a.search.includes('Enter') && a.search.includes('搜尋檔案內文'), 'aria-searchbox', a.search);
      ok(a.sort && a.refresh && a.chip.includes('類型篩選') && a.close.includes('Esc'), 'aria-toolbar', a);
    }

    // ---- 正常模式：位置／第 k/N / 清單 / innerText ----
    await page.waitForFunction(
      () => document.getElementById('stackMirror').innerText.includes('第 1 / 8 張'),
      null, { timeout: 8000 });
    {
      const names = await page.evaluate(() => __dbg.fileNames(8));
      ok(names[0] === 'note-a.md' && names.length === 8, 'mirror-front-is-note-a', names);
      const info = await page.evaluate(() => {
        const body = document.body.innerText;
        const r = document.getElementById('stackMirror');
        return {
          bodyHasFront: body.includes('note-a.md'),
          bodyHasFrontNth: body.includes('第 1 / 8 張'),
          bodyHasLoc: body.includes('位置 Location：'),
          buttons: r.querySelectorAll('ol button').length,
          secretBadge: r.innerText.includes('⚠'),
          noMore: true
        };
      });
      ok(info.bodyHasFront && info.bodyHasFrontNth && info.bodyHasLoc, 'body-innertext-carries-mirror', info);
      ok(info.buttons === 8, 'mirror-buttons-8');
    }

    // ---- 檔頭預覽行：等縮圖把檔頭抓回來，mirror 補上前幾行 ----
    const headOK = await page.waitForFunction(
      () => document.getElementById('stackMirror').innerText.includes('quiltpine 關鍵字行在 note-a'),
      null, { timeout: 15000 }).then(() => true).catch(() => false);
    ok(headOK, 'mirror-head-preview-lines');

    // ---- ⚠ 密鑰標記進鏡像 ----
    {
      const sec = await page.evaluate(() => document.getElementById('stackMirror').innerText.includes('⚠ 疑似含有密碼或金鑰'));
      ok(sec, 'mirror-secret-badge');
    }

    // ---- 樹列 aria-label ----
    {
      const lab = await page.evaluate(() => {
        for (const r of document.querySelectorAll('.trow'))
          if (r.dataset.path && /notes$/.test(r.dataset.path)) return { label: r.getAttribute('aria-label'), role: r.getAttribute('role') };
        return null;
      });
      ok(lab && lab.role === 'button' && lab.label && lab.label.includes('資料夾 notes') && lab.label.includes('8 個'),
        'tree-row-aria-label', lab);
    }

    // ---- 捲動：鏡像跟著換「第 k / N 張」----
    {
      const fr = await page.evaluate(() => __dbg.fracs());
      const vp = page.viewportSize();
      await page.mouse.move(Math.round((fr.tree + fr.view / 2) * vp.width), 420);
      for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 240); await sleep(90); }
      await waitIdle(page, 600);
      const frontIdx = await page.evaluate(() => __dbg.focusIdx());
      ok(frontIdx >= 2, 'mirror-scrolled-front', { frontIdx });
      const moved = await page.waitForFunction(i =>
        document.getElementById('stackMirror').innerText.includes(`第 ${i + 1} / 8 張`),
        frontIdx, { timeout: 5000 }).then(() => true).catch(() => false);
      ok(moved, 'mirror-updates-after-scroll', { frontIdx });
    }

    // ---- 點鏡像按鈕＝檔案開進閱讀面板 ----
    {
      const idx = await page.evaluate(() => __dbg.fileNames(8).indexOf('note-d.md'));
      const clicked = await page.evaluate(i => {
        const b = document.querySelector(`#stackMirror ol button[data-mi="${i}"]`);
        const label = b && b.getAttribute('aria-label');
        if (b) b.click();
        return { found: !!b, label };
      }, idx);
      ok(clicked.found && /開啟 note-d\.md/.test(clicked.label), 'mirror-button-aria', clicked);
      const opened = await page.waitForFunction(
        () => __dbg.panel().file === 'note-d.md' && __dbg.mode() === 'threecol',
        null, { timeout: 8000 }).then(() => true).catch(() => false);
      ok(opened, 'mirror-button-opens-reader');
      const rd = await page.waitForFunction(
        () => document.getElementById('stackMirror').innerText.includes('閱讀面板 Reader：note-d.md'),
        null, { timeout: 5000 }).then(() => true).catch(() => false);
      ok(rd, 'mirror-shows-reading-file');
      await page.evaluate(() => __dbg.closeReader());
      await waitIdle(page, 300);
    }

    // ---- 內文搜尋模式：清單含每個命中的路徑＋命中行（帶行號）＋snippet ----
    {
      await page.fill('#searchBox', 'quiltpine');
      await page.press('#searchBox', 'Enter');
      const inSearch = await page.waitForFunction(
        () => document.getElementById('stackMirror').innerText.includes('搜尋「quiltpine」：找到 8 個檔'),
        null, { timeout: 10000 }).then(() => true).catch(() => false);
      ok(inSearch, 'mirror-content-search-banner');
      const sr = await page.evaluate(() => {
        const t = document.getElementById('stackMirror').innerText;
        return {
          lineHit: t.includes('第 2 行 / line 2：quiltpine 關鍵字行在 note-a'),
          snippet: t.includes('摘錄 snippet：'),
          bodyHas: document.body.innerText.includes('note-f.md')
        };
      }).catch(() => null);
      const region = await regionText();
      const sepVariants = n => NOTE_NAMES.every(x => region.includes('notes\\' + x) || region.includes('notes/' + x) || region.includes(x));
      ok(sepVariants(), 'mirror-search-lists-all-hits', region.split('\n').filter(l => l.includes('note')).slice(0, 3));
      ok(sr && sr.lineHit && sr.snippet, 'mirror-search-match-lines', sr);
      // 清空搜尋 → 回到資料夾視圖
      await page.fill('#searchBox', '');
      const back = await page.waitForFunction(
        () => document.getElementById('stackMirror').innerText.includes('位置 Location：'),
        null, { timeout: 8000 }).then(() => true).catch(() => false);
      ok(back, 'mirror-back-to-folder-after-search');
    }

    // ---- 檔名過濾模式 ----
    {
      await page.fill('#searchBox', 'note-b');
      await sleep(700);   // 等鏡像 250ms 輪詢＋防抖
      const nf = await page.waitForFunction(
        () => document.getElementById('stackMirror').innerText.includes('檔名過濾「note-b」：顯示 1 / 8 個檔案'),
        null, { timeout: 6000 }).then(() => true).catch(() => false);
      ok(nf, 'mirror-name-filter-mode');
      await page.fill('#searchBox', '');
      await page.waitForFunction(
        () => document.getElementById('stackMirror').innerText.includes('第 1 / 8 張'),
        null, { timeout: 6000 }).catch(() => {});
      await waitIdle(page, 200);
    }

    // ---- 閱讀面板 HTML 預覽：sr-only 可見文字摘錄（腳本剔除）----
    {
      await page.evaluate(() => __dbg.selectChip('html'));
      await page.evaluate(x => __dbg.lockFolder(x), RD('root/html'));
      await page.waitForFunction(
        () => __dbg.fileNames().includes('page-x.html') && __dbg.stack().phase === 'idle',
        null, { timeout: 10000 });
      const idx = await page.evaluate(() => __dbg.fileNames().indexOf('page-x.html'));
      await page.evaluate(i => __dbg.openReader(i), idx);
      const got = await page.waitForFunction(() =>
        document.querySelector('#readerBody .mirror-html-text') &&
        document.getElementById('stackMirror').innerText.includes('page-x.html'),
        null, { timeout: 10000 }).then(() => true).catch(() => false);
      ok(got, 'html-extract-attached');
      const ex = await page.evaluate(() => {
        const el = document.querySelector('#readerBody .mirror-html-text');
        return {
          len: el.textContent.length,
          visible: el.textContent.includes('HERE_VISIBLE_HEADING') && el.textContent.includes('HERE_VISIBLE_BODY'),
          noScript: !el.textContent.includes('SHOULD_NOT_LEAK'),
          iframe: !!document.querySelector('#readerBody iframe'),
          panelFile: __dbg.panel().file
        };
      });
      ok(ex.visible && ex.noScript && ex.iframe && ex.len < 20480 && ex.panelFile === 'page-x.html',
        'html-extract-content', ex);
      await page.evaluate(() => __dbg.closeReader());
      await page.evaluate(() => __dbg.selectChip('md'));
      await waitIdle(page, 300);
    }

    // ---- 效能：300 卡滾輪連滾，FPS ≥55 且鏡像單次重描 <2ms ----
    {
      await page.evaluate(x => __dbg.lockFolder(x), RD('root/pg300'));
      await waitIdle(page, 900);
      await page.evaluate(() => { __dbg.resetFps(); window.__mirror.maxMs = 0; window.__mirror.samples = []; });
      const fr = await page.evaluate(() => __dbg.fracs());
      const vp = page.viewportSize();
      await page.mouse.move(Math.round((fr.tree + fr.view / 2) * vp.width), 420);
      // keep scrolling until the mirror has rendered at least 20 times, so the median
      // below rests on real samples rather than a handful; generous cap for slow CI
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        await page.mouse.wheel(0, 240 + (Date.now() % 3) * 60);
        await sleep(40);
        if (await page.evaluate(() => window.__mirror.samples.length) >= 20) break;
      }
      const perf = await page.evaluate(() => ({
        fps: __dbg.avgFps(), mirrorLast: window.__mirror.lastMs, mirrorMax: window.__mirror.maxMs,
        samples: window.__mirror.samples.slice(),
        total: __dbg.stack().total, front: __dbg.focusIdx()
      }));
      ok(perf.total === 300 && perf.front > 3, 'perf-stack-300-scrolled', perf);
      ok(perf.fps >= 55, 'perf-60fps-with-mirror', { fps: perf.fps });
      // judge on the MEDIAN of ≥20 redraws; a single slow frame (GC, busy machine) must
      // not fail the run — the max is printed for reference only
      ok(perf.samples.length >= 20, 'perf-mirror-samples-collected', perf.samples.length);
      const sorted = perf.samples.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : null;
      ok(median != null && median < 2, 'perf-mirror-update-under-2ms',
        { median, samples: sorted.length, max: perf.mirrorMax });
      const cnt = await page.waitForFunction(() =>
        document.getElementById('stackMirror').innerText.includes('個，捲動卡堆可看到'),
        null, { timeout: 5000 }).then(() => true).catch(() => false);
      ok(cnt, 'mirror-shows-more-count-note');
    }

    // ---- 無障礙樹：region 與檔案按鈕、樹列都在 ----
    {
      const flat = await axFlat(page, ctx);
      const hasRegion = flat.some(x => x.startsWith('region|') && x.includes('卡片堆內容'));
      const hasFileBtn = flat.some(x => x.startsWith('button|') && /開啟 m-\d+\.md/.test(x));
      const hasTreeRow = flat.some(x => x.startsWith('button|') && x.includes('資料夾 notes'));
      ok(hasRegion && hasFileBtn && hasTreeRow, 'a11y-tree-region-buttons-treerow',
        { hasRegion, hasFileBtn, hasTreeRow, nodes: flat.length });
      console.log('--- a11y excerpt (first 40 of ' + flat.length + ') ---');
      console.log(flat.slice(0, 40).join('\n'));
    }

    // ---- 交接用：印出資料夾視圖的完整鏡像文字 ----
    {
      await page.evaluate(x => __dbg.lockFolder(x), RD('root/notes'));
      await waitIdle(page, 400);
      await page.waitForFunction(
        () => document.getElementById('stackMirror').innerText.includes('quiltpine 關鍵字行在 note-a'),
        null, { timeout: 10000 }).catch(() => {});
      const sample = await regionText();
      console.log('--- mirror sample text (notes folder, ' + sample.length + ' chars) ---');
      console.log(sample);
      ok(sample.includes('給 AI 助手的說明') && sample.includes('第 1 / 8 張') && sample.includes('quiltpine'),
        'mirror-sample-text-complete', { chars: sample.length });
    }
  } finally {
    try { await browser.close(); } catch (_) {}
    try { server.kill(); } catch (_) {}
    await Promise.race([new Promise(r => server.once('exit', r)), sleep(3000)]);
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 6, retryDelay: 500 }); } catch (_) {}
  }

  ok(consoleErrors.length === 0, 'console-errors-zero', consoleErrors.slice(0, 5));
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exitCode = failed ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
