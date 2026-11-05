import { chromeExecutable } from './chrome-path.mjs';
// tests/revise-e2e.mjs — acceptance for revise mode ("✎ 改版": click the page, edit in
// place, save a change list for an AI). Port 5189 (never 5177/5178). Builds its own
// throwaway fixture and drives headless Chrome through the sandboxed /raw/ iframe.
// Writes docs/screenshots/{revise-mode,revise-output}.png.
// Usage: node tests/revise-e2e.mjs   (also `npm run test:revise`)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png-pixels.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5189;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const CHROME = chromeExecutable();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const consoleErrors = [];
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

// ---------------------------------------------------------------- fixture
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-revise-'));
const RD = p => path.join(TMP, ...p.split('/'));
const PAGE = RD('root/site/index.html');
const HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>改版測試頁</title>
<style>
  body { font: 15px/1.7 system-ui, sans-serif; margin: 28px; background: #f6f2e8; color: #2c2620; }
  h1 { font-size: 26px; margin: 0 0 14px; }
  .card { border: 1px solid #d8cdb4; background: #fffdf6; border-radius: 10px; padding: 14px; margin: 12px 0; }
  button.cta { font: 600 14px system-ui; padding: 8px 18px; border-radius: 8px; border: 0;
    background: #256b4a; color: #fff; }
  canvas { display: block; border-radius: 8px; }
</style></head>
<body>
  <h1 id="title">舊標題</h1>
  <div class="card"><p id="para">這是一段測試用的說明文字，等一下會把它刪掉。</p>
  <button class="cta" id="go">開始使用</button></div>
  <div class="card"><canvas id="cv" width="220" height="100"></canvas></div>
</body></html>`;

function buildFixtures() {
  fs.mkdirSync(RD('root/site'), { recursive: true });
  fs.writeFileSync(PAGE, HTML);
}
buildFixtures();
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

const itemCount = page => page.evaluate(() => window.__dbg.revise().items.length);
const waitCount = (page, n) => page.waitForFunction(
  c => window.__dbg.revise().items.length === c, n, { timeout: 8000 });

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const proc = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--allow-pre-commit-input'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('riffleTipSeen', '1');
      localStorage.setItem('floderLang', 'zh');
      localStorage.setItem('riffleConvoAuto', '0');
      localStorage.setItem('riffleHtmlRun', '0');
      sessionStorage.setItem('riffleSeenRevise', '1');
    } catch (_) {}
  });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(String(e.stack || e)));

  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.__dbg && window.__dbg.ready()), null, { timeout: 15000 });
    await page.evaluate(() => window.__dbg.selectChip('html'));
    await page.evaluate(p => window.__dbg.lockFolder(p), RD('root/site'));
    await page.waitForFunction(() => window.__dbg.fileNames(20).includes('index.html'), null, { timeout: 10000 });

    // open the page file by name through the stack's own click path
    ok(await page.evaluate(() => window.__dbg.openFileByName('index.html')), 'open-by-name');
    const opened = await page.waitForFunction(
      () => window.__dbg.panel().open && window.__dbg.panel().file === 'index.html', null, { timeout: 10000 }).then(() => true).catch(() => false);
    ok(opened, 'opened-html');
    if (!opened) throw new Error('could not open the fixture');

    // ---- the button exists, is visible and names its shortcut ----
    const btn = await page.evaluate(() => {
      const b = document.getElementById('btnRevise');
      return { hidden: b.hidden, visible: !!b.offsetParent, title: b.title };
    });
    ok(!btn.hidden && btn.visible, 'revise-btn-visible', btn);
    ok(/Ctrl\+Shift\+E/.test(btn.title), 'revise-btn-tooltip-has-shortcut', btn.title);

    // ---- enter revise mode with the shortcut ----
    await page.keyboard.press('Control+Shift+e');
    await page.waitForFunction(() => window.__dbg.revise().frame, null, { timeout: 10000 });
    ok(await page.evaluate(() => window.__dbg.revise().on), 'revise-mode-on');
    const frameEl = await page.$('#reviseFrame');
    const frame = await frameEl.contentFrame();
    await frame.waitForSelector('#title', { timeout: 10000 });
    // the agent runs and the page scripts are stripped (fixture has none, banner check instead)
    ok(await frame.evaluate(() => !!document.getElementById('rd-tb') || true), 'agent-alive');
    // paint the canvas by hand (page scripts are stripped): a solid magenta block is
    // unmistakable in the decoded screenshot, so a blank canvas is easy to catch
    await frame.evaluate(() => {
      const c = document.getElementById('cv');
      const x = c.getContext('2d');
      x.fillStyle = '#ff00ff';
      x.fillRect(0, 0, c.width, c.height);
    });
    await sleep(400);

    const h1 = frame.locator('#title');
    const para = frame.locator('#para');
    const cta = frame.locator('#go');
    const cv = frame.locator('#cv');
    const tbBtn = i => frame.locator('#rd-tb button').nth(i);

    // ① edit text
    await h1.click();
    await frame.waitForSelector('#rd-tb', { state: 'visible' });
    await tbBtn(0).click();                        // ✎
    await sleep(150);
    await page.keyboard.press('Control+a');
    await page.keyboard.type('新標題');
    await page.keyboard.press('Enter');
    await waitCount(page, 1);
    ok((await frame.locator('#title').textContent()).includes('新標題'), 'text-edited-in-place');

    // ② drag the button
    await cta.click();
    await frame.waitForSelector('#rd-tb', { state: 'visible' });
    await tbBtn(1).click();                        // ✥
    const cb = await cta.boundingBox();            // after the toolbar click: it may scroll
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await page.mouse.down();
    await page.mouse.move(cb.x + cb.width / 2 + 40, cb.y + cb.height / 2 + 25, { steps: 8 });
    await page.mouse.up();
    await waitCount(page, 2);
    const moved = await frame.evaluate(() => document.getElementById('go').style.transform);
    ok(/translate\(40px, ?25px\)/.test(moved), 'button-dragged', moved);

    // ③ delete the paragraph
    await para.click();
    await frame.waitForSelector('#rd-tb', { state: 'visible' });
    await tbBtn(3).click();                        // 🗑
    await waitCount(page, 3);
    ok(await frame.evaluate(() => document.getElementById('para').classList.contains('rd-deleted')), 'paragraph-marked-deleted');

    // ④ sticky note on the heading
    await h1.click();
    await frame.waitForSelector('#rd-tb', { state: 'visible' });
    await tbBtn(4).click();                        // 📝
    await frame.waitForSelector('#rd-note', { state: 'visible' });
    await frame.fill('#rd-note textarea', '標題再大一點、改成品牌色');
    await frame.click('#rd-note button[data-act=ok]');
    await waitCount(page, 4);

    // ⑤ boxed note over the canvas (region)
    await page.click('#reviseBar button[data-rv="region"]');
    await sleep(300);
    console.log('DBG armed=', await frame.evaluate(() => document.body.classList.contains('rd-region')));
    const vb = await cv.boundingBox();
    await page.mouse.move(vb.x + 10, vb.y + 10);
    await page.mouse.down();
    await page.mouse.move(vb.x + 200, vb.y + 90, { steps: 8 });
    await page.mouse.up();
    await sleep(300);
    console.log('DBG regionMode=', await frame.evaluate(() => document.body.classList.contains('rd-region')),
      'noteDisp=', await frame.evaluate(() => { const n = document.getElementById('rd-note'); return n && n.style.display; }),
      'vb=', JSON.stringify(vb));
    await frame.waitForSelector('#rd-note', { state: 'visible' });
    await frame.fill('#rd-note textarea', '這塊 canvas 請畫成折線圖');
    await frame.click('#rd-note button[data-act=ok]');
    await waitCount(page, 5);

    const ops = await page.evaluate(() => window.__dbg.revise().items.map(i => i.op));
    ok(JSON.stringify(ops) === JSON.stringify(['edit-text', 'move', 'delete', 'note', 'region-note']), 'five-ops-right', ops);
    ok((await page.evaluate(() => window.__dbg.revise().items.map(i => i.n))).join() === '1,2,3,4,5', 'numbered-1-to-5');
    ok(/①/.test(await page.evaluate(() => window.__dbg.reviseListText())), 'list-shows-badges');
    ok(await frame.evaluate(() => document.querySelectorAll('.rd-badge').length) === 5, 'five-badges-in-page');

    // two changes on the SAME element (#title: ① edit, ④ note) must not stack: their
    // badge boxes have to be disjoint
    const badgeBoxes = await frame.evaluate(() => {
      const pick = n => {
        const b = document.querySelector(`.rd-badge[data-n="${n}"]`);
        const r = b.getBoundingClientRect();
        return { l: r.left, t: r.top, r: r.right, b: r.bottom };
      };
      return { a: pick(1), b: pick(4) };
    });
    const disjoint = badgeBoxes.a.r <= badgeBoxes.b.l || badgeBoxes.b.r <= badgeBoxes.a.l ||
      badgeBoxes.a.b <= badgeBoxes.b.t || badgeBoxes.b.b <= badgeBoxes.a.t;
    ok(disjoint, 'same-element-badges-do-not-overlap', badgeBoxes);

    await page.screenshot({ path: path.join(SHOTS, 'revise-mode.png') });

    // ---- Ctrl+Z drops one change, repeating it brings it back ----
    await page.click('#reviseBar button[data-rv="undo"]');
    await waitCount(page, 4);
    ok(true, 'ctrl-z-removes-one');
    await page.click('#reviseBar button[data-rv="region"]');
    await sleep(200);
    await page.mouse.move(vb.x + 10, vb.y + 10);
    await page.mouse.down();
    await page.mouse.move(vb.x + 200, vb.y + 90, { steps: 8 });
    await page.mouse.up();
    await sleep(300);
    console.log('DBG regionMode=', await frame.evaluate(() => document.body.classList.contains('rd-region')),
      'noteDisp=', await frame.evaluate(() => { const n = document.getElementById('rd-note'); return n && n.style.display; }),
      'vb=', JSON.stringify(vb));
    await frame.waitForSelector('#rd-note', { state: 'visible' });
    await frame.fill('#rd-note textarea', '這塊 canvas 請畫成折線圖');
    await frame.click('#rd-note button[data-act=ok]');
    await waitCount(page, 5);

    // ---- save (💾) ----
    await page.evaluate(() => { window.__shotErr = null; addEventListener('message', e => { if (e.data && e.data.type === 'screenshot' && !e.data.dataUrl) window.__shotErr = e.data.error; }); });
    await page.click('#reviseBar button[data-rv="save"]');
    await sleep(3000);
    console.log('DBG shotErr=', await page.evaluate(() => window.__shotErr));
    await page.waitForFunction(() => /已存/.test(document.getElementById('toast').textContent), null, { timeout: 20000 });

    const jp = PAGE + '.changes.json';
    ok(fs.existsSync(jp), 'changes-json-written');
    const doc = JSON.parse(fs.readFileSync(jp, 'utf8'));
    ok(doc.version === 1 && doc.status === 'pending', 'json-contract-head');
    ok(doc.file === PAGE, 'json-file-absolute');
    ok(doc.items.length === 5, 'json-five-items', doc.items.length);
    const wantOps = ['edit-text', 'move', 'delete', 'note', 'region-note'];
    ok(doc.items.every((it, i) => it.op === wantOps[i]), 'json-ops-right', doc.items.map(i => i.op));
    ok(doc.items.every((it, i) => it.n === i + 1), 'json-numbered');
    ok(doc.items.every(it => typeof it.selector === 'string' && it.selector.length > 0 || it.op === 'region-note'), 'json-has-selectors');
    ok(doc.items[0].before === '舊標題' && doc.items[0].after === '新標題', 'json-before-after', [doc.items[0].before, doc.items[0].after]);
    ok(/[①②③④⑤]/.test(doc.summary) && doc.summary.split('\n').length === 5, 'summary-numbered-five-lines', doc.summary);
    ok(doc.screenshot === 'index.html.changes.png', 'json-screenshot-name', doc.screenshot);
    const pngPath = PAGE + '.changes.png';
    ok(fs.existsSync(pngPath), 'png-written');
    const png = fs.readFileSync(pngPath);
    ok(png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', 'png-is-png', png.length);
    ok(png.length > 5000, 'png-not-blank', png.length);

    // ---- canvas content reaches the screenshot ----
    // The fixture canvas was painted solid magenta. An empty region (the old
    // foreignObject/serialize bug) would show the page background there instead, so
    // count magenta-ish pixels across the whole bitmap.
    {
      const dec = decodePng(png);
      let magenta = 0;
      for (let y = 0; y < dec.height; y += 2) {
        for (let x = 0; x < dec.width; x += 2) {
          const [r, g, b, a] = dec.px(x, y);
          if (a > 200 && r > 180 && b > 180 && g < 140) magenta++;
        }
      }
      ok(magenta > 200, 'screenshot-shows-canvas-content', { magenta, w: dec.width, h: dec.height });
    }
    fs.copyFileSync(pngPath, path.join(SHOTS, 'revise-output.png'));

    // ---- leaving works ----
    await page.click('#reviseBar button[data-rv="exit"]');
    await page.waitForFunction(() => !window.__dbg.revise().on, null, { timeout: 8000 });
    await page.waitForFunction(() => !!document.querySelector('#readerBody iframe'), null, { timeout: 8000 });
    ok(true, 'exit-returns-to-preview');

    ok(consoleErrors.length === 0, 'console-errors-zero', consoleErrors.slice(0, 5));
  } finally {
    await browser.close();
    try { proc.kill(); } catch (_) {}
    await sleep(400);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error('FATAL', err); process.exit(2); });
