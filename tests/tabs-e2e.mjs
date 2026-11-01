// tests/tabs-e2e.mjs — acceptance for the browser-tabs mode (extension/ pushes Chrome's
// open tabs to the server; the UI shows them as cards). Port 5193 (5190–5199 only).
// The "extension" is simulated from Node: plain fetch with the X-RiffleDesk-Ext header
// and no Origin (exactly what a service-worker fetch sends), plus a long-poll command
// loop that answers 'read' with fake content. Drives headless Chrome, writes
// docs/screenshots/tabs-mode.png. Usage: node tests/tabs-e2e.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png-pixels.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5193;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const consoleErrors = [];
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

// ---------------------------------------------------------------- fixture
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-tabs-'));
const RD = p => path.join(TMP, ...p.split('/'));
fs.mkdirSync(RD('root'), { recursive: true });
fs.writeFileSync(RD('root/readme.md'), '# tabs fixture\njust a folder to return to\n');
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [RD('root')], pinned: [], convoRoots: [] }, null, 2));

// A real (tiny) decodable jpeg as a fake screenshot, and a 1x1 png favicon
const SHOT = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDBAUECQkKCRAKCgsNCw0ODQ4ODw4UEQ0PEBQRESIhEhEPEBQhEBAQEAYEBQUFCAoTExMTFBIOCg4SDg4OEhD/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD/2Q==';
const FAV = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const FAKE_TEXT = 'RiffleDeskTabTextMarker 全文內容測試，讀得到才算數。';
const FAKE_HTML = '<html><head><title>fake</title></head><body><div id="domMarkerEl">HolaMundoDomMarker</div></body></html>';
// 卡片上的可見文字（沒截圖的卡要有內容可讀，不能只有一個字母圓圈）
const LONG_TEXT = 'RiffleDeskCardBodyMarker 這是一段假的可見文字，用來驗證沒有截圖的分頁卡會把文字排在卡身上，'
  + '而不是只畫一個大圓圈和標題。文字要夠長，足以鋪滿卡面好幾行，讓像素取樣抓得到字。'
  + '再補一些字讓它更長：檔案瀏覽器的卡片是有內容的，分頁卡也該一樣。';
// meta description 摘要：卡面上應優先於主內容雜字（字體較大較粗、排在前面）
const LONG_DESC = 'RiffleDeskCardSummaryMarker 這是第二個分頁的 meta description 摘要，應該優先顯示在卡身上、排在內文前面。';

// realistic lastAccessed stamps: epoch 3000 would legitimately read as 1970 and blur the
// "no lastAccessed → no date" check below. 103 carries none at all.
const T0 = Date.parse('2026-10-20T09:00:00Z');
const TABS = [
  { id: 101, windowId: 1, title: '範例頁 Example Page', url: 'https://example.com/alpha', fav: FAV, active: true, lastAccessed: T0, shot: SHOT },
  { id: 102, windowId: 1, title: 'Second Tab', url: 'https://example.org/beta', fav: '', active: false, lastAccessed: T0 - 60000, text: LONG_TEXT, desc: LONG_DESC },
  { id: 103, windowId: 1, title: 'Third Tab', url: 'https://example.net/gamma', fav: '', active: false }
];

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

// ---- simulated Chrome extension (Node side) -------------------------
// per-install token, exactly like extension/background.js generates (48 hex)
const EXT_TOKEN = 'f'.repeat(48);
const BAD_TOKEN = 'a'.repeat(48);
const EXT_HEADERS = { 'X-RiffleDesk-Ext': '1', 'X-RiffleDesk-Token': EXT_TOKEN };  // no Origin, like a service-worker fetch
const extLog = { cmds: [] };
let extAbort = null;
async function extPushTabs(tabs) {
  const r = await fetch(BASE + '/api/tabs', {
    method: 'POST',
    headers: { ...EXT_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ tabs })
  });
  return r.status;
}
function extCmdLoopStart() {
  extAbort = new AbortController();
  (async () => {
    for (;;) {
      try {
        const r = await fetch(BASE + '/api/tabs/cmd?wait=2000', {
          headers: EXT_HEADERS, signal: extAbort.signal
        });
        const d = await r.json();
        const cmd = d && d.cmd;
        if (!cmd) continue;
        extLog.cmds.push(cmd);
        if (cmd.op === 'read') {
          const tab = TABS.find(t => t.id === cmd.tabId) || TABS[0];
          await fetch(BASE + '/api/tabs/result', {
            method: 'POST',
            headers: { ...EXT_HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify({
              ok: true, reqId: cmd.reqId, title: tab.title, url: tab.url,
              text: FAKE_TEXT, textTruncated: false, html: FAKE_HTML, htmlTruncated: false
            })
          });
        }
      } catch (_) {
        if (extAbort && extAbort.signal.aborted) return;
        await sleep(150);
      }
      if (extAbort && extAbort.signal.aborted) return;
    }
  })();
}
async function extWaitCmd(op, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const c = extLog.cmds.find(c => c.op === op);
    if (c) return c;
    await sleep(80);
  }
  return null;
}

// ---- page-side helpers ----
const dbg = (page, expr) => page.evaluate(new Function('return (' + expr + ')()'));

let server = null;
let browser = null;
const pageErrors = [];

async function main() {
  server = await startServer();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.__dbg && window.__dbg.ready());
  await sleep(1000);      // let SSE attach
  // dismiss the first-run tip card so it does not swallow the card clicks
  const know = page.locator('#hint button');
  if (await know.count()) await know.first().click().catch(() => {});

  // ---------- 0. the button sits right of the sort select, same toolbar row
  const btnPos = await page.evaluate(() => {
    const sel = document.getElementById('sortSel');
    const btn = document.getElementById('btnTabs');
    if (!sel || !btn) return null;
    return { sameRow: Math.abs(sel.offsetTop - btn.offsetTop) < 4, rightOf: btn.offsetLeft > sel.offsetLeft };
  });
  ok(btnPos && btnPos.sameRow && btnPos.rightOf, '「網頁」按鈕在排序選單右邊同一列', btnPos);
  const tabsBtnText = await page.evaluate(() => document.getElementById('btnTabs').textContent.trim());
  ok(tabsBtnText === '網頁', 'mode segment right half reads 「網頁」', tabsBtnText);

  // ---------- 1. security: cross-site / missing-header callers are refused
  const s1 = await fetch(BASE + '/api/tabs', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ tabs: [] })
  });
  ok(s1.status === 403, 'cross-site POST /api/tabs without the ext header → 403', s1.status);
  const s2 = await fetch(BASE + '/api/tabs/cmd?wait=1');
  ok(s2.status === 403, 'GET /api/tabs/cmd without the ext header → 403', s2.status);
  const s3 = await fetch(BASE + '/api/tabs/result', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  ok(s3.status === 403, 'POST /api/tabs/result without the ext header → 403', s3.status);
  // (run from Node with a same-origin Origin header — doing it in the page logs a 503 console error)
  const s4 = await fetch(BASE + '/api/tabs/action', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ op: 'read', tabId: 999 })
  });
  const s4b = await s4.json();
  ok(s4.status === 503 && /extension not connected/.test(s4b.error || ''), 'no extension → action answers 503', { status: s4.status, body: s4b });
  // ext header present but NO per-install token → 403 (pairing has not happened yet)
  const s5 = await fetch(BASE + '/api/tabs', {
    method: 'POST', headers: { 'X-RiffleDesk-Ext': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ tabs: [] })
  });
  ok(s5.status === 403, 'ext header without the token → 403', s5.status);

  // ---------- 2. no extension yet → one install-instruction card
  await page.click('#btnTabs');
  await page.waitForFunction(() => window.__dbg && window.__dbg.tabs && window.__dbg.tabs().active);
  // the fixture folder ALSO has exactly one file, so wait for the note card itself, not just the count
  await page.waitForFunction(() => {
    const st = window.__dbg.scene();
    return st.view.length === 1 && st.view[0].tab && st.view[0].tab.note;
  }, null, { timeout: 8000 });
  const noteOnly = await page.evaluate(() => {
    const st = window.__dbg.scene();
    return { len: st.view.length, note: !!(st.view[0] && st.view[0].tab && st.view[0].tab.note), extAlive: window.__dbg.tabs().extAlive };
  });
  ok(noteOnly.len === 1 && noteOnly.note && !noteOnly.extAlive, 'extension absent → install card is the only card', noteOnly);

  // clicking the install card opens the reader with the steps (note card is the exception)
  const noteRect = await page.evaluate(() => {
    const cards = window.__dbg.selProbe().cards;
    const c = cards.find(c => c.p === 'tab://install');
    return c && c.x != null ? { x: c.x, y: c.y } : null;
  });
  ok(!!noteRect, 'install card has screen coordinates', noteRect);
  if (noteRect) {
    await page.mouse.click(noteRect.x, noteRect.y);
    await page.waitForFunction(() => window.__dbg.panel().shown, null, { timeout: 5000 });
    const noteText = await page.evaluate(() => document.getElementById('readerBody').innerText);
    ok(/chrome:\/\/extensions/.test(noteText), 'install card opens reader with the install steps');
    // 安裝說明卡（note）不給「側欄模式」：擴充根本沒連上，按了也只會說開不了
    const noteSide = await page.evaluate(() => {
      const b = document.querySelector('#readerBody .tabact.sidepanel');
      return b ? { present: true, disabled: b.disabled } : { present: false };
    });
    ok(!noteSide.present || noteSide.disabled, 'install card has no (or a disabled) side-panel button', noteSide);
    // Esc closes the reader (reader has no edit state here)
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__dbg.panel().shown && window.__dbg.mode() === 'twocol', null, { timeout: 5000 });
  }

  // ---------- 3. extension comes online (SSE pushes the list into the open mode)
  extCmdLoopStart();
  ok((await extPushTabs(TABS)) === 200, 'extension push accepted (token paired)');
  // after pairing, a different token must bounce off (and must NOT clobber the list)
  const s6 = await fetch(BASE + '/api/tabs', {
    method: 'POST',
    headers: { 'X-RiffleDesk-Ext': '1', 'X-RiffleDesk-Token': BAD_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ tabs: [] })
  });
  ok(s6.status === 403, 'token mismatch after pairing → 403', s6.status);
  await page.waitForFunction(() => window.__dbg.tabs().tabs === 3, null, { timeout: 8000 });
  const afterPush = await page.evaluate(() => {
    const st = window.__dbg.scene();
    return { len: st.view.length, kinds: st.view.map(f => f.kind), firstId: st.view[0] && st.view[0].tab && st.view[0].tab.id };
  });
  ok(afterPush.len === 3 && afterPush.kinds.every(k => k === 'tab'), 'tab list becomes 3 cards', afterPush);
  ok(afterPush.firstId === 101, 'most recently used tab is the front card', afterPush.firstId);
  ok(await page.evaluate(() => window.__dbg.tabs().extAlive), 'server considers the extension alive');

  // ---------- 4. cards WITHOUT a screenshot must still have a real face, and the
  // docs screenshot is taken with such a card in front (dark theme, preview button visible)
  await page.evaluate(() => window.__dbg.setTheme('dark'));
  const idxOf = id => page.evaluate(i => window.__dbg.scene().view.findIndex(f => f.tab && f.tab.id === i), id);
  const fallbackIdx = await idxOf(102);         // 102 has no shot
  ok(fallbackIdx > 0, 'a tab without a screenshot is in the stack', fallbackIdx);
  // jump (no damping wait) so the screenshot-less card is the front one
  await page.evaluate(i => { const s = window.__dbg.scene(); s._jumpTo = i; s.poke(); }, fallbackIdx);
  await page.waitForFunction(() => Math.round(window.__dbg.scene().scrollCur) === 1, null, { timeout: 8000 });
  let shot = false;
  for (const ms of [700, 1200, 2000, 3000]) {   // thumbs paint async; wait until no slot is a placeholder
    await sleep(ms);
    shot = await page.evaluate(() => {
      const s = window.__dbg.scene();
      return s.slotTex().length >= 3 && s.slotTex().every(x => x.name === x.texName || (x.texName || '').length > 0);
    });
    if (shot) break;
  }
  ok(shot, 'tab card thumbnails painted');
  // the card face of the screenshot-less tab is not one flat colour (icon + title + url),
  // and it carries near-white title pixels — a blank dark face would fail both.
  const faceBox = await page.evaluate(() => window.__dbg.cardBounds(1));
  const shotBuf = await page.screenshot({ path: path.join(SHOTS, 'tabs-mode.png') });
  const img = decodePng(shotBuf);
  const face = (() => {
    if (!faceBox) return null;
    // body only: skip the header band (top 96/800 of the card) and the outer 6% border
    const x0 = Math.round(faceBox.minX + faceBox.w * 0.10), x1 = Math.round(faceBox.maxX - faceBox.w * 0.10);
    const y0 = Math.round(faceBox.minY + faceBox.h * 0.16), y1 = Math.round(faceBox.maxY - faceBox.h * 0.06);
    const colors = new Set();
    let bright = 0, n = 0;
    for (let y = y0; y < y1; y += 3) {
      for (let x = x0; x < x1; x += 3) {
        const [r, g, b] = img.px(x, y);
        colors.add((r >> 3) + ',' + (g >> 3) + ',' + (b >> 3));
        if (r > 170 && g > 170 && b > 160) bright++;
        n++;
      }
    }
    return { colors: colors.size, bright, n };
  })();
  ok(!!face && face.colors >= 6, 'screenshot-less card face is not a single flat colour', face);
  ok(!!face && face.bright / face.n > 0.004, 'card face actually has light title/url pixels', face);

  // a missing / zero lastAccessed must not print 1970 in the card header line
  const meta = await page.evaluate(async stamp => {
    const m = await import('/thumbs.js');
    return {
      none: m.tabMetaText({ tab: { url: 'https://example.net/gamma' }, mtime: 0, name: 'x' }),
      dated: m.tabMetaText({ tab: { url: 'https://example.com/a' }, mtime: stamp, name: 'x' })
    };
  }, T0);
  ok(!/1970/.test(meta.none) && /example\.net/.test(meta.none), 'no lastAccessed → no 1970 date on the card', meta.none);
  ok(/\d{4}-\d{2}-\d{2}/.test(meta.dated), 'a real lastAccessed still shows the date', meta.dated);

  // back to the first card (steps below click/preview the front card = 101)
  await page.evaluate(() => { const s = window.__dbg.scene(); s._jumpTo = 0; s.poke(); });
  await page.waitForFunction(() => Math.round(window.__dbg.scene().scrollCur) === 0, null, { timeout: 8000 });
  // ---------- 5. A：單擊分頁卡＝右欄出現那張的預覽（不切分頁、不發 activate、不自動開側欄）
  const frontRect = await page.evaluate(() => {
    const cards = window.__dbg.selProbe().cards;
    const c = cards.find(c => c.p === 'tab://101');
    return c && c.x != null ? { x: c.x, y: c.y } : null;
  });
  ok(!!frontRect, 'front tab card has screen coordinates');
  extLog.cmds.length = 0;
  await page.mouse.click(frontRect.x, frontRect.y);
  await page.waitForFunction(() => window.__dbg.panel().shown, null, { timeout: 5000 });
  ok(true, 'single click opened the right-column preview');
  const prevInfo = await page.evaluate(() => ({
    file: window.__dbg.panel().file,
    mode: window.__dbg.mode(),
    meta: document.querySelector('#readerBody .tabshot') ? 'shot' : 'no-shot'
  }));
  ok(prevInfo.file === '範例頁 Example Page' && prevInfo.mode !== 'twocol', 'preview shows the tab (three-column)', prevInfo);
  ok(prevInfo.meta === 'shot', 'preview shows the tab screenshot', prevInfo.meta);
  await sleep(300);
  ok(!extLog.cmds.some(c => c.op === 'activate' || c.op === 'side-panel'),
    'single click sent NO activate/open-panel command to the extension', extLog.cmds);

  // ---------- 6. content round-trip: text arrives, DOM toggle shows the raw html
  const readCmd = await extWaitCmd('read');
  ok(readCmd && readCmd.tabId === 101, 'reader asked the extension to read the tab', readCmd);
  await page.waitForFunction(() => {
    const t = document.querySelector('#readerBody .tabtext');
    return t && t.textContent.includes('RiffleDeskTabTextMarker');
  }, null, { timeout: 8000 });
  ok(true, 'reader shows the fetched text');
  await page.locator('#readerBody .tabseg').nth(1).click();
  await page.waitForFunction(() => {
    const cv = document.querySelector('#readerBody .codeview');
    return cv && cv.textContent.includes('HolaMundoDomMarker');
  }, null, { timeout: 8000 });
  ok(true, 'DOM 原始碼 toggle shows the raw html (escaped, highlighted)');
  const segState = await page.evaluate(() => ({
    domOn: document.querySelectorAll('#readerBody .tabseg')[1].classList.contains('on')
  }));
  ok(segState.domOn, 'DOM segment is the active one after the click');

  // the reader keeps its own 切到這個網頁 button
  extLog.cmds.length = 0;
  await page.locator('#readerBody .tabact').first().click();
  const actCmd2 = await extWaitCmd('activate');
  ok(actCmd2 && actCmd2.tabId === 101, 'reader 切到這個網頁 sends activate too', actCmd2);

  // ---------- 6b. 預覽列第四顆「側欄模式」：瀏覽器端沒有 chrome.runtime（擴充只是 server 模擬）
  // → 不拋錯、不發 server 指令，結果標記 noext；工具列 ◫ 鈕（meta 報 extAlive）應看得見
  const sideBtn = await page.$('#readerBody .tabact.sidepanel');
  ok(!!sideBtn && (await sideBtn.textContent()).trim().length > 0, 'tab preview has the i18n 側欄模式 button');
  extLog.cmds.length = 0;
  await page.evaluate(() => document.querySelector('#readerBody .tabact.sidepanel').click());
  await page.waitForFunction(() => {
    const d = window.__dbg.tabs().lastPanelOpen;
    return d && d.panel === 'noext';
  }, null, { timeout: 5000 });
  ok(!extLog.cmds.length, '側欄模式 with no ext runtime: no server command, no throw (toasted instead)');
  // 工具列鈕要等 /api/tabs?meta=1 回來才現身（30 秒輪詢；SSE 推播也會補一次）→ 輪詢等到 10 秒
  let toolbarShown = false;
  for (let i = 0; i < 20 && !toolbarShown; i++) {
    toolbarShown = await page.evaluate(() => {
      const b = document.getElementById('btnSidePanel');
      return !!(b && !b.hidden);
    }).catch(() => false);
    if (!toolbarShown) await sleep(500);
  }
  ok(toolbarShown, 'toolbar ◫ button is visible while the (mock) extension reports alive');

  // ---------- 7. right-click menu on a tab card
  await page.keyboard.press('Escape');   // put the preview back (threecol → twocol)
  await page.waitForFunction(() => window.__dbg.mode() === 'twocol', null, { timeout: 5000 });
  await page.mouse.click(frontRect.x, frontRect.y, { button: 'right' });
  await sleep(300);
  const menuText = await page.evaluate(() => {
    const m = document.getElementById('ctxMenu');
    return m && m.classList.contains('on') ? m.innerText : '';
  });
  ok(/切到這個網頁/.test(menuText) && /複製網址/.test(menuText) && !/丟到垃圾桶/.test(menuText),
    'tab card menu has tab actions, no file actions', menuText.replace(/\n/g, '|'));
  await page.keyboard.press('Escape');

  // ---------- 7.5 the list keeps being pushed while the user scrolls (was: every push
  // rebuilt the stack and yanked the view back to card 1)
  const MANY = Array.from({ length: 20 }, (_, i) => ({
    id: 200 + i, windowId: 1, title: 'Tab ' + (i + 1), url: 'https://site' + i + '.example/p', fav: '',
    active: i === 0, lastAccessed: T0 - i * 1000 - 500
  }));
  const frontTabId = () => page.evaluate(() => {
    const st = window.__dbg.scene();
    const f = st.view[Math.round(st.scrollCur)];
    return f && f.tab && f.tab.id;
  });
  await extPushTabs(MANY);
  await page.waitForFunction(() => window.__dbg.tabs().tabs === 20, null, { timeout: 8000 });
  // wheel down to the 8th card (index 7) over the stack column
  const vp = await page.evaluate(() => window.__dbg.viewRect());
  await page.mouse.move(vp.x + vp.w / 2, vp.y + vp.h / 2);
  for (let i = 0; i < 80; i++) {
    const n = await page.evaluate(() => Math.round(window.__dbg.scene().scrollTarget));
    if (n === 7) break;
    await page.mouse.wheel(0, n > 7 ? -100 : 100);
    await sleep(60);
  }
  await page.waitForFunction(() => {
    const st = window.__dbg.scene();
    return Math.round(st.scrollCur) === 7 && Math.abs(st.scrollTarget - st.scrollCur) < 0.5;
  }, null, { timeout: 10000 });
  const anchorId = await frontTabId();
  ok(anchorId === 207, 'wheel scrolled to the 8th card', { anchorId });

  // an unchanged push must not rebuild the stack at all
  const switchMsBefore = await page.evaluate(() => window.__dbg.scene().lastFolderSwitchMs);
  await extPushTabs(MANY);
  await sleep(700);
  ok(await page.evaluate(m => window.__dbg.scene().lastFolderSwitchMs === m, switchMsBefore),
    'identical push does not rebuild the stack');
  ok((await frontTabId()) === anchorId, 'identical push keeps the position');

  // 5 consecutive pushes of "a card's title changed" — the view must stay on the same tab
  for (let i = 0; i < 5; i++) {
    const mutated = MANY.map(tb => (tb.id === 203 ? { ...tb, title: 'Tab 4 (title churn ' + i + ')' } : tb));
    await extPushTabs(mutated);
    await sleep(200);
  }
  await sleep(900);
  const afterChurn = await page.evaluate(() => {
    const st = window.__dbg.scene();
    const f = st.view[Math.round(st.scrollCur)];
    const churned = st.view.find(x => x.tab && x.tab.id === 203);
    return {
      id: f && f.tab && f.tab.id, scroll: +st.scrollCur.toFixed(2), target: +st.scrollTarget.toFixed(2),
      churnedTitle: churned && churned.tab.title
    };
  });
  ok(afterChurn.id === anchorId && afterChurn.scroll === 7,
    '5 title-churn pushes keep the same front tab at the same index', afterChurn);
  ok(/title churn 4/.test(String(afterChurn.churnedTitle)), 'the churned card title did reach the card', afterChurn.churnedTitle);

  // the anchored tab disappears → stay at the same index, not back to card 1
  await extPushTabs(MANY.filter(tb => tb.id !== 207));
  await sleep(1200);
  const afterRemove = await page.evaluate(() => {
    const st = window.__dbg.scene();
    return { scroll: +st.scrollCur.toFixed(2), frontId: (st.view[Math.round(st.scrollCur)] || {}).tab?.id, len: st.view.length };
  });
  ok(afterRemove.len === 19 && afterRemove.scroll === 7 && afterRemove.frontId !== 207,
    'removing the anchored tab stays at the same index (no jump back to card 1)', afterRemove);

  // ---------- 7.6 a card without a screenshot shows its page text on the card body
  await extPushTabs([{ ...MANY[1], text: LONG_TEXT }].concat(MANY.slice(2)));
  await page.waitForFunction(() => window.__dbg.tabs().tabs === 19, null, { timeout: 8000 });
  await page.evaluate(() => { const s = window.__dbg.scene(); s._jumpTo = 0; s.poke(); });
  await page.waitForFunction(() => Math.round(window.__dbg.scene().scrollCur) === 0, null, { timeout: 8000 });
  await sleep(1200);   // let the card texture paint
  const textBox = await page.evaluate(() => window.__dbg.cardBounds(0));
  const shotText = await page.screenshot();
  const textImg = decodePng(shotText);
  const bodyPx = (() => {
    if (!textBox) return null;
    const x0 = Math.round(textBox.minX + textBox.w * 0.10), x1 = Math.round(textBox.maxX - textBox.w * 0.10);
    const y0 = Math.round(textBox.minY + textBox.h * 0.22), y1 = Math.round(textBox.maxY - textBox.h * 0.06);
    let light = 0, dark = 0, n = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const [r, g, b] = textImg.px(x, y);
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (l > 150) light++; else if (l < 90) dark++;
        n++;
      }
    }
    return { light, dark, n };
  })();
  ok(!!bodyPx && bodyPx.n > 0 && bodyPx.light / bodyPx.n > 0.01 && bodyPx.dark / bodyPx.n > 0.01,
    'screenshot-less card body renders page text (both text and background pixels present)', bodyPx);

  // ---------- 7.7 screenshots stay sharp: a 1280px capture survives the server unshrunk
  // (the extension used to send 480px and the card blew it up to 1280 → blurry)
  const shotWidth = await page.evaluate(async stamp => {
    const cv = document.createElement('canvas');
    cv.width = 1280; cv.height = 720;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#2b4b7a'; cx.fillRect(0, 0, 1280, 720);
    cx.fillStyle = '#ffffff'; cx.fillRect(0, 300, 1280, 120);
    const shot = cv.toDataURL('image/jpeg', 0.85);
    await fetch('/api/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tabs: [{
        id: 901, windowId: 1, title: 'sharp shot', url: 'https://sharp.example/', fav: '',
        active: false, lastAccessed: stamp, shot
      }] })
    });
    const im = new Image();
    im.src = '/api/tabs/shot?id=901';
    try { await im.decode(); } catch (_) { return 0; }
    return im.naturalWidth;
  }, T0);
  ok(shotWidth >= 1000, 'served screenshot keeps ≥1000px width', shotWidth);

  // ---------- 7.8 og:image＋摘要卡面：優先序 截圖 > og 大圖 > 文字；摘要優先於內文
  // 兩張純色 JPEG 當圖（藍＝截圖、橘＝og 代表圖），之後用像素斷言誰被畫上去
  const duo = await page.evaluate(() => {
    const mk = hex => {
      const c = document.createElement('canvas'); c.width = 800; c.height = 420;
      const x = c.getContext('2d'); x.fillStyle = hex; x.fillRect(0, 0, 800, 420);
      return c.toDataURL('image/jpeg', 0.85);
    };
    return { blue: mk('#2b62c4'), orange: mk('#d2691e') };
  });
  const DESC_950 = 'DescMarker950 兩者都有的卡：截圖應蓋過 og 圖。';
  const DESC_951 = 'DescMarker951 og 卡的摘要。';
  const DESC_952 = 'DescMarker952 純文字卡的摘要，應優先於內文雜字。';
  ok((await extPushTabs([
    { id: 950, windowId: 1, title: 'both shot+og', url: 'https://cards.example/both', fav: '', active: false,
      lastAccessed: T0, shot: duo.blue, og: duo.orange, desc: DESC_950, text: LONG_TEXT },
    { id: 951, windowId: 1, title: 'og only', url: 'https://cards.example/og', fav: '', active: false,
      lastAccessed: T0 - 1000, og: duo.orange, desc: DESC_951, text: LONG_TEXT },
    { id: 952, windowId: 1, title: 'text only', url: 'https://cards.example/text', fav: '', active: false,
      lastAccessed: T0 - 2000, desc: DESC_952, text: LONG_TEXT }
  ])) === 200, 'push tabs carrying og image + description accepted');
  const ogResp = await fetch(BASE + '/api/tabs/og?id=951');
  const ogBytes = ogResp.status === 200 ? (await ogResp.arrayBuffer()).byteLength : 0;
  ok(ogResp.status === 200 && (ogResp.headers.get('content-type') || '').includes('image/jpeg') && ogBytes > 500,
    'og image stored and served at /api/tabs/og as jpeg', { status: ogResp.status, bytes: ogBytes });

  const prio = await page.evaluate(async () => {
    const m = await import('/thumbs.js');
    const list = (await (await fetch('/api/tabs')).json()).tabs;
    const T = id => list.find(t => t.id === id);
    const f = t => ({ name: t.title, path: 'tab://' + t.id, size: 0, ext: '.tab', kind: 'tab',
                      mtime: t.lastAccessed || 1, tab: { ...t } });
    const models = [950, 951, 952].map(id => m.tabCardModel(f(T(id))));
    // 真的畫出卡片 canvas 再取像素（卡身頂＝檔名列(高~130px)底下；卡身底＝H-30）
    const px = async (id, y) => {
      const c = await m.buildThumbCanvas(f(T(id)));
      return [...c.getContext('2d').getImageData(c.width / 2, y, 1, 1).data].slice(0, 3);
    };
    return { models,
             bothTop: await px(950, 160), bothBot: await px(950, 770),
             ogTop: await px(951, 160), ogBot: await px(951, 770) };
  });
  ok(prio.models[0].mode === 'shot' && prio.models[1].mode === 'og' && prio.models[2].mode === 'text',
    'card face model priority: shot > og > text', prio.models.map(x => x.mode));
  ok(prio.models[2].summary === DESC_952 && prio.models[2].body.includes('RiffleDeskCardBodyMarker'),
    'meta description is the card summary (body stays secondary)', prio.models[2]);
  const isBlue = p => p[2] - p[0] > 80, isOrange = p => p[0] - p[2] > 120;
  ok(isBlue(prio.bothTop) && isBlue(prio.bothBot), 'when both exist the screenshot covers the whole card (og ignored)',
    { top: prio.bothTop, bot: prio.bothBot });
  ok(isOrange(prio.ogTop), 'og-only card paints the og image big on the upper body', prio.ogTop);
  ok(!isOrange(prio.ogBot), 'below the og image the card shows summary+text, not more image', prio.ogBot);

  // ---------- 7.9 C：分頁模式下類型 chips 與排序選單藏起來；E：兩段式切換＋提示有快捷鍵
  {
    // 7.8 的推送是 SSE→350ms 防抖才套進卡堆；先等 950–952 真的出現在畫面上，
    // 才能往下跳第 3 張（不然會在舊的 19 張清單上「假裝」跳到 index 2）
    await page.waitForFunction(() => {
      const d = window.__dbg && window.__dbg.tabs && window.__dbg.tabs();
      const st = window.__dbg.scene();
      return !!(d && d.active && d.viewN === 3 && st.view.length === 3 &&
                st.view.every(f => f.tab && f.tab.id >= 950));
    }, null, { timeout: 10000 });

    const cState = await page.evaluate(() => {
      const cs = id => { const e2 = document.getElementById(id); return e2 ? getComputedStyle(e2).display : null; };
      return {
        chips: cs('chips'), sort: cs('sortSel'),
        bodyTabs: document.body.classList.contains('tabs-on'),
        filesOn: document.getElementById('btnModeFiles').classList.contains('on'),
        tabsOn: document.getElementById('btnTabs').classList.contains('on'),
        filesTitle: document.getElementById('btnModeFiles').title,
        tabsTitle: document.getElementById('btnTabs').title
      };
    });
    ok(cState.chips === 'none' && cState.sort === 'none' && cState.bodyTabs &&
       !cState.filesOn && cState.tabsOn, 'C: tabs mode hides chips+sort and lights the 分頁 segment', cState);
    ok(/Alt\+1/.test(cState.filesTitle) && /Alt\+2/.test(cState.tabsTitle),
      'E: segment buttons show their shortcuts in the tooltip', { f: cState.filesTitle, t: cState.tabsTitle });

    // E：分頁模式記住滾到哪張——離開再回來要跳回同一張（不是彈回第 1 張）
    await page.evaluate(() => { const s = window.__dbg.scene(); s._jumpTo = 2; s.poke(); });
    await page.waitForFunction(() => Math.round(window.__dbg.scene().scrollCur) === 2, null, { timeout: 8000 });
    await page.keyboard.press('Escape');   // 回檔案模式
    await page.waitForFunction(() => !window.__dbg.tabs().active && !!window.__dbg.lockedFolder(), null, { timeout: 8000 });
    const cOff = await page.evaluate(() => ({
      chips: getComputedStyle(document.getElementById('chips')).display,
      sort: getComputedStyle(document.getElementById('sortSel')).display,
      filesOn: document.getElementById('btnModeFiles').classList.contains('on')
    }));
    ok(cOff.chips !== 'none' && cOff.sort !== 'none' && cOff.filesOn, 'C: leaving tabs mode brings chips+sort back', cOff);

    // 重進分頁：等到「真的套用完而且還停在 952 那張」才算數（view 長度 3 可能是離開前的殘影，
    // 直接讀 scroll 會搶在 apply() 落地前）
    const exitSnap = await page.evaluate(() => ({ restoreTabId: window.__dbg.tabs().restoreTabId, scroll: window.__dbg.scene().scrollCur }));
    ok(exitSnap.restoreTabId === 952, 'E: leaving tabs mode remembered the front card (952)', exitSnap);
    await page.click('#btnTabs');
    const back952 = await page.waitForFunction(() => {
      if (!window.__dbg.tabs().active) return false;
      const st = window.__dbg.scene();
      const f = st.view[Math.round(st.scrollCur)];
      return st.view.length === 3 && Math.round(st.scrollCur) === 2 && !!(f && f.tab) && f.tab.id === 952;
    }, null, { timeout: 8000 }).then(() => true).catch(() => false);
    const backSnap = await page.evaluate(() => {
      const st = window.__dbg.scene();
      const f = st.view[Math.round(st.scrollCur)];
      return { id: f && f.tab && f.tab.id, scroll: Math.round(st.scrollCur), len: st.view.length };
    });
    ok(back952, 'E: re-entering tabs mode restores the card you were on (no jump to card 1)', backSnap);

    // E：檔案模式搜「cards.example」→ 「分頁符合 N 個 → 看分頁」條出現；點了帶著同一個字切進分頁模式
    await page.click('#btnModeFiles');
    await page.waitForFunction(() => !window.__dbg.tabs().active, null, { timeout: 5000 });
    await page.fill('#searchBox', 'cards.example');
    await page.waitForFunction(() => {
      const s = document.getElementById('tabStrip');
      return s && !s.hidden;
    }, null, { timeout: 8000 });
    const stripTxt = await page.evaluate(() => document.getElementById('tabStrip').textContent);
    ok(/3/.test(stripTxt), 'E: file-mode search shows the “tabs also match” strip', stripTxt);
    await page.click('#tabStrip');
    const stripOk = await page.waitForFunction(
      () => window.__dbg.tabs().active && window.__dbg.tabs().query === 'cards.example' &&
        window.__dbg.tabs().viewN === 3, null, { timeout: 8000 }).then(() => true).catch(() => false);
    ok(stripOk, 'E: strip click switches to tabs mode with the query, 3 cards match',
      await page.evaluate(() => ({ q: window.__dbg.tabs().query, n: window.__dbg.tabs().viewN })));
    ok(await page.evaluate(() => !!document.getElementById('tabStrip').hidden), 'E: strip hides after entering tabs mode');

    // E：分頁模式搜尋比對標題／網址／內文（不只檔名）
    await page.fill('#searchBox', 'zzznope');
    const noHit = await page.waitForFunction(() => window.__dbg.tabs().viewN === 0, null, { timeout: 5000 })
      .then(() => true).catch(() => false);
    ok(noHit, 'E: no-match query empties the tabs view');
    await page.press('#searchBox', 'Escape');   // 清空＋blur
    const backAll = await page.waitForFunction(() => window.__dbg.tabs().viewN === 3, null, { timeout: 5000 })
      .then(() => true).catch(() => false);
    ok(backAll, 'E: clearing the query brings all tabs back');

    // E：在分頁模式點左樹資料夾＝自動切回檔案模式並打開
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#tree .trow')];
      const r = rows.find(x => /\\root$/.test(x.dataset.path || ''));
      if (r) r.click();
    });
    await page.waitForFunction(() => !window.__dbg.tabs().active && !!window.__dbg.lockedFolder() &&
      String(window.__dbg.lockedFolder()).toLowerCase().endsWith('root'), null, { timeout: 8000 });
    ok(true, 'E: clicking a tree folder in tabs mode auto-switches to file mode and opens it');

    // E：Alt+2 進分頁、Alt+1 回檔案（跟兩段鈕同一件事）
    await page.click('#searchBox');   // 讓焦點落在輸入框內也照吃（規格點名輸入框裡可用）
    await page.keyboard.press('Alt+2');
    await page.waitForFunction(() => window.__dbg.tabs().active && window.__dbg.tabs().viewN === 3, null, { timeout: 8000 });
    ok(true, 'E: Alt+2 enters tabs mode (works even while the search box is focused)');
    // E：閱讀面板在切模式時不被強制關掉（A：點卡即右欄預覽——直接點最前面那張）
    const acec0 = await page.evaluate(() => { const c = window.__dbg.cardScreen(0); return c && { x: c.x, y: c.y }; });
    await page.mouse.click(acec0.x, acec0.y);
    await page.waitForFunction(() => window.__dbg.panel().shown, null, { timeout: 5000 });
    await page.keyboard.press('Alt+1');
    await page.waitForFunction(() => !window.__dbg.tabs().active, null, { timeout: 5000 });
    ok(await page.evaluate(() => window.__dbg.panel().shown),
      'E: switching mode does NOT force-close the reader');
    // 焦點在搜尋框時 Esc 只會被輸入框吃掉（清字/失焦），先移焦再 Esc 才收回閱讀面板
    await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__dbg.mode() === 'twocol' && !window.__dbg.panel().shown &&
      !window.__dbg.tabs().active, null, { timeout: 5000 });

    // 回到分頁模式給後面第 8/9 步用
    await page.click('#btnTabs');
    await page.waitForFunction(() => window.__dbg.tabs().active, null, { timeout: 5000 });
  }

  // ---------- 7.10 special card faces: a file:// tab shows the file, built-in pages and
  // discarded tabs explain themselves instead of staying blank
  const FILE_URL = 'file:///' + path.join(ROOT, 'tests', 'fixtures', 'docs', 'design-notes.md').replace(/\\/g, '/');
  const SPECIAL = [
    { id: 960, windowId: 1, title: '設計筆記.md', url: FILE_URL, fav: '', active: false, lastAccessed: T0 },
    { id: 961, windowId: 1, title: '新增分頁', url: 'chrome://newtab/', fav: '', active: false, lastAccessed: T0 - 1000 },
    { id: 962, windowId: 1, title: 'Sleeping Tab', url: 'https://sleepy.example/x', fav: '', active: false,
      discarded: true, lastAccessed: T0 - 2000 }
  ];
  ok((await extPushTabs(SPECIAL)) === 200, 'push of the three special tabs accepted');
  await page.waitForFunction(() => {
    const st = window.__dbg.scene();
    return window.__dbg.tabs().active && st.view.length === 3 && st.view.every(f => f.tab && f.tab.id >= 960);
  }, null, { timeout: 10000 });
  await page.evaluate(() => { const s = window.__dbg.scene(); s._jumpTo = 0; s.poke(); });
  await page.waitForFunction(() => Math.round(window.__dbg.scene().scrollCur) === 0, null, { timeout: 8000 });
  await sleep(1500);   // let the three card textures paint

  // canvas-level: each card picks the intended painter and its body carries real ink
  // (a blank face is a flat paper colour — the ink ratio check fails on that)
  const faces = await page.evaluate(async ({ urls }) => {
    const m = await import('/thumbs.js');
    const fu = await import('/fileurl.js');
    const st = (await (await fetch('/api/tabs')).json()).tabs;
    const out = [];
    for (const id of [960, 961, 962]) {
      const tb = st.find(x => x.id === id);
      const f = { name: tb.title, path: 'tab://' + id, size: 0, mtime: tb.lastAccessed || 0, ext: '.tab',
                  kind: 'tab', tab: { ...tb } };
      const lp = fu.fileUrlToPath(tb.url);
      if (lp) {
        f.localPath = lp; f.localKind = fu.extToKind(fu.pathExtOf(lp));
        f.localName = lp.split(/[\\/]/).pop();
      }
      else if (fu.isBuiltinUrl(tb.url)) f.builtin = true;
      const c = await m.buildThumbCanvas(f);
      const d = c.getContext('2d').getImageData(0, Math.round(c.height * 0.2), c.width,
        Math.round(c.height * 0.68)).data;
      let dark = 0, light = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 7) {
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        if (l < 110) dark++; else if (l > 150) light++;
        n++;
      }
      out.push({ id, mode: m.tabCardModel(f).mode, dark, light, n,
                 data: c.toDataURL('image/png') });
    }
    return out;
  }, { urls: SPECIAL.map(t => t.url) });
  const modeOf = id => (faces.find(f => f.id === id) || {}).mode;
  ok(modeOf(960) === 'local', 'file:// tab uses the local-file card face', modeOf(960));
  ok(modeOf(961) === 'builtin', 'chrome:// tab uses the built-in explain face', modeOf(961));
  ok(modeOf(962) === 'sleeping', 'discarded tab with no shot/text uses the sleeping face', modeOf(962));
  for (const f of faces) {
    ok(f.dark / f.n > 0.01, `card ${f.id} (${f.mode}) body has ink, not a blank face`,
      { ratio: +(f.dark / f.n).toFixed(4), light: f.light });
  }

  // the live stack shows the same three cards; screenshot them side by side for review
  await page.evaluate(async list => {
    const wrap = document.createElement('div');
    wrap.id = 'faceStrip';
    Object.assign(wrap.style, { position: 'fixed', inset: '0', zIndex: '40', background: '#0b0d10',
      display: 'flex', gap: '14px', padding: '24px', alignItems: 'flex-start',
      justifyContent: 'center', font: '600 13px system-ui, sans-serif', color: '#cfd4dc' });
    for (const d of list) {
      const col = document.createElement('div');
      Object.assign(col.style, { display: 'flex', flexDirection: 'column', gap: '8px' });
      const cap = document.createElement('div');
      cap.textContent = d.caption;
      const im = new Image();
      im.src = d.data;
      im.style.width = '440px';
      im.style.borderRadius = '6px';
      col.append(cap, im);
      wrap.appendChild(col);
    }
    document.body.appendChild(wrap);
  }, faces.map((f, i) => ({ ...f, caption: ['file:// 分頁 → 檔案內容',
    'chrome:// 內建頁 → 說明', '休眠分頁 → 說明'][i] })));
  await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, 'tabs-special-faces.png') });
  await page.evaluate(() => document.getElementById('faceStrip').remove());

  // reader preview of each special tab must also explain itself
  // 後排卡的卡心被前排卡蓋住，raycast 點下去是前排卡——先把它跳成最前面再點卡心
  const openPreviewAt = async i => {
    await page.evaluate(n => { const s = window.__dbg.scene(); s._jumpTo = n; s.poke(); }, i);
    await page.waitForFunction(n => Math.round(window.__dbg.scene().scrollCur) === n, i, { timeout: 8000 });
    await sleep(500);
    const pos = await page.evaluate(n => { const c = window.__dbg.cardScreen(n); return c && { x: c.x, y: c.y }; }, i);
    await page.mouse.click(pos.x, pos.y);               // A：點卡即右欄預覽（避開右上角 × 熱區的中央點）
    await page.waitForFunction(() => window.__dbg.panel().shown, null, { timeout: 5000 });
  };
  await openPreviewAt(0);
  const localText = await page.waitForFunction(() => {
    const b = document.getElementById('readerBody');
    return b && /設計筆記/.test(b.innerText) && /卡片/.test(b.innerText) ? b.innerText : false;
  }, null, { timeout: 8000 }).then(h => h.jsonValue()).catch(async () =>
    page.evaluate(() => document.getElementById('readerBody').innerText));
  ok(/設計筆記/.test(localText) && /卡片/.test(localText),
    'file:// preview shows the real file content', String(localText).replace(/\n/g, '|').slice(0, 160));
  // 原始碼切換：只有文字類才有這顆鈕，而且點了真的換成檔案原文
  await page.locator('#readerBody .tabseg').nth(1).click();
  const srcText = await page.waitForFunction(() => {
    const p = document.querySelector('#readerBody pre.tabtext');
    return p && !p.hidden && /設計筆記/.test(p.textContent) ? p.textContent : false;
  }, null, { timeout: 8000 }).then(h => h.jsonValue()).catch(() => '');
  ok(/# 設計筆記/.test(srcText), 'source toggle shows the raw markdown',
    String(srcText).slice(0, 60));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__dbg.mode() === 'twocol', null, { timeout: 5000 });

  await openPreviewAt(1);
  const builtinText = await page.evaluate(() => {
    const b = document.getElementById('readerBody');
    return b ? b.innerText : '';
  });
  ok(/瀏覽器內建頁面/.test(builtinText) && /不允許擴充功能/.test(builtinText),
    'chrome:// preview shows the built-in explanation', builtinText.replace(/\n/g, '|').slice(0, 120));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__dbg.mode() === 'twocol', null, { timeout: 5000 });

  await openPreviewAt(2);
  const sleepText = await page.evaluate(() => {
    const b = document.getElementById('readerBody');
    return b ? b.innerText : '';
  });
  ok(/這個網頁正在休眠/.test(sleepText) && /點一下切過去/.test(sleepText),
    'discarded preview shows the sleeping explanation', sleepText.replace(/\n/g, '|').slice(0, 120));
  // 說明叫使用者「點一下切過去」→ 右欄就得有一顆真的按得下去的鈕
  extLog.cmds.length = 0;
  await page.locator('#readerBody .tabact').first().click();
  const sleepAct = await extWaitCmd('activate');
  ok(sleepAct && sleepAct.tabId === 962, 'sleeping explanation offers a working 切到這個網頁 button', sleepAct);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__dbg.mode() === 'twocol', null, { timeout: 5000 });

  // ---------- 7.11 × close button on the card corner: card leaves the stack,
  // the front card does not jump, the click never activates the tab, and the
  // toast's 復原 action asks the extension for sessions.restore()
  {
    // front card is 960（預覽步驟跳過卡，先停回第 0 張）；close the non-front card 962
    await page.evaluate(() => { const s = window.__dbg.scene(); s._jumpTo = 0; s.poke(); });
    await page.waitForFunction(() => Math.round(window.__dbg.scene().scrollCur) === 0, null, { timeout: 8000 });
    const prep = await page.evaluate(() => ({
      scroll: Math.round(window.__dbg.stack().scroll),
      viewN: window.__dbg.tabs().viewN,
      frontId: window.__dbg.scene().view[Math.round(window.__dbg.scene().scrollCur)].tab.id
    }));
    ok(prep.scroll === 0 && prep.viewN === 3 && prep.frontId === 960,
      'close: preset state — front card 960, three cards showing', prep);
    // E：× 畫進卡面貼圖（不再有 hover 浮鈕）——滑鼠停在旁邊（不 hover），
    // 每張看得見的分頁卡都回得出自己 × 的螢幕座標，且落在自己卡頭右上範圍內
    await page.mouse.move(8, 420);
    const everyX = await page.evaluate(() => window.__dbg.tabBadges('x').map(p => {
      const b = window.__dbg.cardBounds(p.fileIdx);
      const onCard = !!(b && p.x >= b.minX - 3 && p.x <= b.maxX + 3 && p.y >= b.minY - 3 && p.y <= b.maxY + 3);
      const topRight = !!(b && p.x >= b.maxX - b.w * 0.3 - 3 && p.y <= b.minY + b.h * 0.3 + 3);
      return { fileIdx: p.fileIdx, onCard, topRight };
    }));
    ok(everyX.length >= 3 && everyX.every(p => p.onCard && p.topRight),
      'close: without any hover, every visible tab card reports its × in its own top-right header corner', everyX.length);
    // 歐哥 11-01：指到 × 不要再跳紅色覆疊，點畫在卡上的 × 就好
    ok(!(await page.evaluate(() => typeof window.__dbg.tabBadgeHover === 'function')), 'close: the hover recolor overlay is gone', null);
    // 點「非前排那張（tab 962）」× 的投影座標＝關掉它（不能切分頁、不能開閱讀）
    const closePos = await page.evaluate(() => {
      const p = window.__dbg.tabZone(2, 'x');
      const card = window.__dbg.cardBounds(2);
      if (!p || !card) return null;
      return { x: p.x, y: p.y, cardMaxX: card.maxX, cardMinY: card.minY, cardW: card.w, cardH: card.h };
    });
    ok(closePos && closePos.x <= Math.round(closePos.cardMaxX) + 3 &&
       closePos.x >= Math.round(closePos.cardMaxX - closePos.cardW * 0.3) &&
       closePos.y >= Math.round(closePos.cardMinY) - 3 && closePos.y < Math.round(closePos.cardMinY + closePos.cardH * 0.3),
      'close: × is projected onto the card top-right corner (in the texture, moves with the card)', closePos);
    extLog.cmds.length = 0;
    await page.mouse.click(closePos.x, closePos.y);
    const closeCmd = await extWaitCmd('close');
    ok(closeCmd && closeCmd.tabId === 962, 'close finishes the close command at the extension with tabId 962', closeCmd);
    ok(!extLog.cmds.some(c => c.op === 'activate'),
      'close: the × click never reaches the extension as a tab activation', extLog.cmds);
    await page.waitForFunction(() => window.__dbg.tabs().viewN === 2, null, { timeout: 8000 });
    const after = await page.evaluate(() => ({
      viewN: window.__dbg.tabs().viewN,
      scroll: Math.round(window.__dbg.stack().scroll),
      frontId: window.__dbg.scene().view[Math.round(window.__dbg.scene().scrollCur)].tab.id,
      lastClose: window.__dbg.tabs().lastClose
    }));
    ok(after.frontId === 960 && after.scroll === 0 && after.viewN === 2,
      'close: card 962 left the stack and the front card did not jump', after);
    ok(after.lastClose && after.lastClose.ok && after.lastClose.tabId === 962 && after.lastClose.via === 'server',
      'close: page logged the close as server-fallback (no extension in page context)', after.lastClose);
    // toast「已關閉 · 復原」~6s with a clickable action link
    const toastState = await page.evaluate(() => {
      const el = document.getElementById('toast');
      const a = el.querySelector('a');
      return { on: el.classList.contains('on'), act: el.classList.contains('act'),
               text: el.textContent, link: a ? a.textContent : '' };
    });
    ok(toastState.on && toastState.act && /已關閉/.test(toastState.text) && toastState.link === '復原',
      'close: bottom toast shows 已關閉 with a 復原 action', toastState);
    // 復原 → restore op through the server queue (extension would call sessions.restore)
    extLog.cmds.length = 0;
    await page.click('#toast a');
    const restoreCmd = await extWaitCmd('restore');
    ok(restoreCmd !== null, 'restore reaches the extension as a sessions.restore op', restoreCmd);
    // the simulated extension "restores" it → pushes the full list back
    ok((await extPushTabs(SPECIAL)) === 200, 'restore: extension re-pushes the list with the tab back');
    await page.waitForFunction(() => window.__dbg.tabs().viewN === 3, null, { timeout: 10000 });
    const back = await page.evaluate(() => {
      const v = window.__dbg.scene().view;
      return { viewN: v.length, endId: v[v.length - 1] && v[v.length - 1].tab && v[v.length - 1].tab.id,
               order: window.__dbg.tabs().order() };
    });
    ok(back.viewN === 3 && back.endId === 962 && back.order[back.order.length - 1] === 'tab://962',
      'restore: card 962 is back in the frozen order at its old tail slot', back);
  }

  // ---------- 8. leave tabs mode → back to the fixture folder
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__dbg.tabs().active, null, { timeout: 5000 });
  await page.waitForFunction(() => !!window.__dbg.lockedFolder(), null, { timeout: 8000 });
  const backTo = await page.evaluate(() => window.__dbg.lockedFolder());
  ok(String(backTo).toLowerCase().endsWith('root'), 'Esc leaves tabs mode and restores the folder', backTo);

  // ---------- 8. reader is resized to three right-column widths (360/600/900) for the
  // tab-preview header check below, then back to the default layout
  await page.click('#btnTabs');
  await page.waitForFunction(() => window.__dbg.tabs().active && window.__dbg.tabs().viewN === 3, null, { timeout: 8000 });
  const LONG_TITLE = '(60) 這是一個超級長的 YouTube 影片標題，長到足以把整個標題列塞爆——'
    + 'How to Build a 3D File Browser with three.js in One Afternoon (Full Tutorial)';
  const LONG_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghijklmnopqrstuvwxyz0123456789'
    + '&index=42&t=1234s&feature=share&si=VeryLongQueryStringValueHereToForceOverflow';
  const LONGER = Array.from({ length: 20 }, (_, i) => ({
    id: 300 + i, windowId: 1, title: 'Tab ' + (i + 1), url: 'https://site' + i + '.example/p', fav: '',
    active: i === 0, lastAccessed: T0 - i * 1000 - 500
  }));
  LONGER[0] = { ...LONGER[0], id: 300, title: LONG_TITLE, url: LONG_URL, shot: SHOT, active: true };
  await extPushTabs(LONGER);
  await page.waitForFunction(() => window.__dbg.tabs().tabs === 20, null, { timeout: 8000 });
  await page.evaluate(() => { const s = window.__dbg.scene(); s._jumpTo = 0; s.poke(); });
  await page.waitForFunction(() => Math.round(window.__dbg.scene().scrollCur) === 0, null, { timeout: 8000 });
  const ltc0 = await page.evaluate(() => { const c = window.__dbg.cardScreen(0); return c && { x: c.x, y: c.y }; });
  await page.mouse.click(ltc0.x, ltc0.y);
  await page.waitForFunction(() => window.__dbg.panel().shown, null, { timeout: 5000 });
  await page.waitForFunction(t => document.getElementById('readerTitle').textContent === t,
    LONG_TITLE, { timeout: 8000 });
  await page.waitForFunction(() => !!document.querySelector('#readerBody .tabview-bar'), null, { timeout: 8000 });

  // expected labels straight from the page's own dictionary — no hard-coded strings or counts
  const LBL = await page.evaluate(async () => {
    const m = await import('/i18n.js');
    return { act: m.t('tabsActivate'), open: m.t('tabsOpenNew'), ai: m.t('copyAiBtn'), side: m.t('tabsSidePanel') };
  });

  for (const colW of [360, 600, 900]) {
    await page.setViewportSize({ width: 1400, height: 900 });   // full width first, so the reader never exceeds the window
    await page.evaluate(w => {
      const r = document.getElementById('reader');
      // keep it inside the window: reader sits at the right edge with a 6px gap
      r.style.left = Math.max(0, innerWidth - w - 6) + 'px';
      r.style.width = w + 'px';
    }, colW);
    await sleep(350);   // let the flight/layout settle
    const geo = await page.evaluate(L => {
      const has = (list, label) => list.some(b => (b.textContent || '').trim() === label);      const r = document.getElementById('reader');
      const rr = r.getBoundingClientRect();
      const hdr = document.getElementById('readerHeader');
      const title = document.getElementById('readerTitle');
      const urlEl = document.querySelector('#readerBody .tabact') && document.querySelector('#readerMeta .taburl');
      const btns = [...document.querySelectorAll('#readerBody .tabact')];
      const segs = [...document.querySelectorAll('#readerBody .tabseg')];
      const inReader = e => {
        const b = e.getBoundingClientRect();
        return b.left >= rr.left - 1 && b.right <= rr.right + 1 &&
               b.top >= rr.top - 1 && b.bottom <= rr.bottom + 1 && b.width > 0 && b.height > 0;
      };
      const overlap = (a, b) => {
        const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
        return x.left < y.right - 1 && y.left < x.right - 1 && x.top < y.bottom - 1 && y.top < x.bottom - 1;
      };
      const tb = title.getBoundingClientRect();
      return {
        readerW: rr.width,
        titleText: title.textContent,
        // title must show real words, not just an ellipsis: the rendered box is wide and
        // the visible (client) width is meaningfully larger than the ellipsis stub
        titleVisible: tb.width > 60 && title.clientWidth > 60,
        titleLines: (() => {
          const lh = parseFloat(getComputedStyle(title).lineHeight) || parseFloat(getComputedStyle(title).fontSize) * 1.5;
          return Math.round(tb.height / lh);
        })(),
        titleInReader: inReader(title),
        urlOverflow: !!urlEl && urlEl.scrollWidth > urlEl.clientWidth + 1,
        urlEllipsis: !!urlEl && getComputedStyle(urlEl).textOverflow === 'ellipsis',
        urlTitle: urlEl && urlEl.title,
        urlInReader: !!urlEl && inReader(urlEl),
        domW: (() => { const d = document.querySelector('#readerMeta .tabdomain'); return d ? d.clientWidth : 0; })(),
        // the action row must hold the three base actions plus the side-panel one, all
        // inside the column — checked by class/label, not a brittle hard-coded count
        hasBaseBtns: has(btns, L.act) && has(btns, L.open) && has(btns, L.ai),
        hasSidePanelBtn: has(btns, L.side) && btns.some(b => b.classList.contains('sidepanel')),
        btnsInReader: btns.every(inReader),
        segsInReader: segs.length === 2 && segs.every(inReader),
        btnsOverlap: btns.some((a, i) => btns.some((b, j) => j > i && overlap(a, b))),
        // header text must not run under the top-right icon buttons
        headerOverlapBtns: (() => {
          const hb = document.getElementById('readerBtns').getBoundingClientRect();
          return tb.right > hb.left - 1 && tb.left < hb.right + 1 &&
                 tb.top < hb.bottom - 1 && hb.top < tb.bottom - 1;
        })(),
        hScroll: document.getElementById('readerBody').scrollWidth >
                 document.getElementById('readerBody').clientWidth + 1,
        btnsRect: btns.map(b => { const b2 = b.getBoundingClientRect(); return [Math.round(b2.left), Math.round(b2.right)]; }),
        rr: [Math.round(rr.left), Math.round(rr.right)]
      };
    }, LBL);
    ok(geo.titleVisible && !/…$/.test(geo.titleText.trim().slice(0, 3)) && geo.titleLines <= 2,
      `[${colW}px] 標題可見且最多 2 行（不是只剩省略號）`, geo);
    ok(geo.titleInReader, `[${colW}px] 標題不超出右欄`);
    ok(geo.urlOverflow && geo.urlEllipsis && geo.urlTitle === LONG_URL,
      `[${colW}px] 長網址溢出時有 ellipsis 且 title 帶完整網址`, geo);
    ok(geo.urlInReader, `[${colW}px] 網址不超出右欄`);
    ok(geo.domW > 40, `[${colW}px] 網域沒有被擠成碎片`, geo.domW);
    ok(geo.btnsInReader && geo.segsInReader && geo.hasBaseBtns && geo.hasSidePanelBtn,
      `[${colW}px] 切換鈕與三顆基準動作鈕＋側欄模式完全落在右欄內`, geo);
    ok(!geo.btnsOverlap, `[${colW}px] 動作鈕互不重疊`, geo.btnsRect);
    ok(!geo.headerOverlapBtns, `[${colW}px] 標題不壓到右上角圖示按鈕`);
    ok(!geo.hScroll, `[${colW}px] 右欄沒有橫向捲軸`, geo);

    if (colW === 600) {
      await page.evaluate(() => {
        const r = document.getElementById('reader');
        r.style.left = Math.max(0, innerWidth - 600 - 6) + 'px';
        r.style.width = '600px';
      });
      await sleep(250);
      await page.screenshot({ path: path.join(SHOTS, 'tab-preview-header.png') });
    }
  }

  // leaving the header check: restore the default three-column layout
  await page.evaluate(() => {
    const r = document.getElementById('reader');
    r.style.left = '';
    r.style.width = '';
  });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__dbg.mode() === 'twocol', null, { timeout: 5000 });
  // the header check ran inside tabs mode: leave it so step 9 starts from file mode
  if (await page.evaluate(() => window.__dbg.tabs().active)) {
    await page.evaluate(() => document.getElementById('btnModeFiles').click());
    await page.waitForFunction(() => !window.__dbg.tabs().active, null, { timeout: 5000 });
  }

  // ---------- 9. extension dies → the install card comes back
  extAbort.abort();   // the 90 s alive window is server-side; simulate absence by pushing nothing…
  // (extAlive only flips after 90 s without contact — instead verify the empty-list path via a fresh push of [])
  extLog.cmds.length = 0;
  await extPushTabs([]);
  await page.click('#btnTabs');
  await page.waitForFunction(() => window.__dbg.tabs().active, null, { timeout: 5000 });
  await sleep(600);
  const emptyState = await page.evaluate(() => ({
    n: window.__dbg.tabs().tabs, len: window.__dbg.scene().view.length
  }));
  ok(emptyState.n === 0 && emptyState.len === 0, 'extension alive but zero tabs → empty stack, no install card', emptyState);
  await page.keyboard.press('Escape');
}

main()
  .then(async () => {
    ok(pageErrors.length === 0, 'no page errors', pageErrors);
    ok(consoleErrors.length === 0, 'no console errors', consoleErrors);
  })
  .catch(async e => {
    console.log('FAIL harness ' + e.stack);
    failed++;
    try {
      const dump = await browser.contexts()[0].pages()[0].evaluate(() => ({
        panel: window.__dbg && window.__dbg.panel ? window.__dbg.panel() : null,
        tabs: window.__dbg && window.__dbg.tabs ? window.__dbg.tabs() : null,
        mode: window.__dbg && window.__dbg.mode ? window.__dbg.mode() : null,
        body: document.getElementById('readerBody') ? document.getElementById('readerBody').innerText.slice(0, 200) : null
      }));
      console.log('DBGDUMP', JSON.stringify(dump));
    } catch (_) {}
  })
  .finally(async () => {
    try { extAbort && extAbort.abort(); } catch (_) {}
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
    process.exit(failed ? 1 : 0);
  });
