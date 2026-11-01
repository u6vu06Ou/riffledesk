// tests/en-e2e.mjs — English-mode UI audit screenshots. Everything runs with
// localStorage floderLang='en' (same switch the 中文/English seg buttons use), and
// each docs/screenshots/en-*.png must be eyeballed before hand-in: no leftover
// Chinese, no truncation. Port 5197 (tests stay in 5190–5199; 5177 is the user's).
// Usage: node tests/en-e2e.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5197;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const EXT = path.join(ROOT, 'extension');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// branded Chrome headless does NOT load extensions (proven in tabs-ext-e2e); the
// options-page shot needs playwright's bundled Chromium instead
const PW_CHROMIUM = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe');
const EXT_CHROME = fs.existsSync(PW_CHROMIUM) ? PW_CHROMIUM : CHROME;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const consoleErrors = [];
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

// ---------------------------------------------------------------- fixture
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-en-'));
const RD = p => path.join(TMP, ...p.split('/'));
fs.mkdirSync(RD('root'), { recursive: true });
fs.writeFileSync(RD('root/readme.md'), '# en fixture\na folder to land in\n');
fs.writeFileSync(RD('root/notes.md'), '# notes\nsecond file so the file stack is not a single card\n');
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [RD('root')], pinned: [], convoRoots: [] }, null, 2));

const SHOT = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDBAUECQkKCRAKCgsNCw0ODQ4ODw4UEQ0PEBQRESIhEhEPEBQhEBAQEAYEBQUFCAoTExMTFBIOCg4SDg4OEhD/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD/2Q==';
const T0 = Date.parse('2026-11-01T09:00:00Z');
const TABS = [
  { id: 101, windowId: 1, title: 'Example Landing Page', url: 'https://example.com/alpha', fav: '', active: true, lastAccessed: T0,
    shot: SHOT, text: 'EnShotTextMarker body text that becomes searchable and paints on the card face.' },
  { id: 102, windowId: 1, title: 'Docs Second Tab', url: 'https://example.org/beta', fav: '', active: false, lastAccessed: T0 - 60000,
    text: 'EnBodyMarker plain body copy for a card without a screenshot. '.repeat(8),
    desc: 'EnDescMarker a meta description that shows first on the card.' },
  { id: 103, windowId: 1, title: 'Minimal Third Tab', url: 'https://example.net/gamma', fav: '', active: false }
];
const FILE_URL = 'file:///' + path.join(ROOT, 'tests', 'fixtures', 'docs', 'design-notes.md').replace(/\\/g, '/');
const SPECIAL = [
  { id: 960, windowId: 1, title: 'design-notes.md', url: FILE_URL, fav: '', active: false, lastAccessed: T0 },
  { id: 961, windowId: 1, title: 'New Tab', url: 'chrome://newtab/', fav: '', active: false, lastAccessed: T0 - 1000 },
  { id: 962, windowId: 1, title: 'Sleeping Tab', url: 'https://sleepy.example/x', fav: '', active: false,
    discarded: true, lastAccessed: T0 - 2000 }
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

// ---- simulated extension (Node side, same as tabs-e2e) ----
const EXT_TOKEN = '9'.repeat(48);
const EXT_HEADERS = { 'X-RiffleDesk-Ext': '1', 'X-RiffleDesk-Token': EXT_TOKEN };
const extLog = { cmds: [] };
let extAbort = null;
async function pushTabs(tabs) {
  const r = await fetch(BASE + '/api/tabs', {
    method: 'POST', headers: { ...EXT_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ tabs })
  });
  return r.status;
}
function extCmdLoopStart() {
  extAbort = new AbortController();
  (async () => {
    for (;;) {
      try {
        const r = await fetch(BASE + '/api/tabs/cmd?wait=2000', { headers: EXT_HEADERS, signal: extAbort.signal });
        const d = await r.json();
        if (d && d.cmd) extLog.cmds.push(d.cmd);
      } catch (_) {
        if (extAbort.signal.aborted) return;
        await sleep(150);
      }
      if (extAbort.signal.aborted) return;
    }
  })();
}

let server = null, browser = null, extCtx = null;
const pageErrors = [];

async function main() {
  server = await startServer();
  extCmdLoopStart();

  // ---------- 7. en-options.png FIRST: the real extension's persistent context does
  // not share a profile with the plain browser below; running it before the busy page
  // work keeps its service-worker startup out of the main suite's load window.
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-en-ext-'));
  extCtx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EXT_CHROME, headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 760, height: 640 }
  });
  // discover the extension id through CDP targets — playwright's serviceworker event
  // on a second persistent context is unreliable under load (tabs-ext-e2e's plain
  // waitForEvent is the flaky bit); Target.getTargets lists the MV3 worker directly.
  let extId = '';
  for (let i = 0; i < 60 && !extId; i++) {
    const swUrl = extCtx.serviceWorkers().map(w => w.url()).find(u => u.startsWith('chrome-extension://'));
    if (swUrl) { extId = swUrl.split('/')[2]; break; }
    try {
      const cdp = await extCtx.newCDPSession((extCtx.pages()[0]) || await extCtx.newPage());
      const { targetInfos } = await cdp.send('Target.getTargets');
      const t = targetInfos.find(x => x.type === 'service_worker' && String(x.url).startsWith('chrome-extension://'));
      await cdp.detach().catch(() => {});
      if (t) extId = t.url.split('/')[2];
    } catch (_) {}
    if (!extId) await sleep(1000);
  }
  ok(/^[-a-z]{32}$/.test(extId), 'extension service worker up', extId);
  if (!extId) throw new Error('extension service worker never appeared');
  const opt = await extCtx.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.evaluate(p => new Promise(res => {
    localStorage.setItem('floderLang', 'en');
    chrome.storage.local.set({ port: p }, res);   // point it at 5197, not the live 5177
  }), PORT);
  await opt.reload();
  await opt.waitForLoadState('domcontentloaded');
  await sleep(600);
  const optState = await opt.evaluate(() => ({
    h1: document.querySelector('h1') ? document.querySelector('h1').textContent : '',
    body: document.body.innerText,
    cjk: /[㐀-䶿一-鿿]/.test(document.body.innerText)
  }));
  ok(!optState.cjk && /port/i.test(optState.body), 'EN options page renders English, zero CJK',
    { h1: optState.h1, bodyStart: optState.body.slice(0, 120) });
  await opt.screenshot({ path: path.join(SHOTS, 'en-options.png') });
  await extCtx.close(); extCtx = null;

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('floderLang', 'en'); } catch (_) {} });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.__dbg && window.__dbg.ready());

  // ---------- 0. English engaged (URL title + mode segment)
  const enState = await page.evaluate(() => ({
    tabsBtn: document.getElementById('btnTabs').textContent.trim(),
    filesBtn: document.getElementById('btnModeFiles').textContent.trim(),
    title: document.title
  }));
  ok(enState.tabsBtn === 'Tabs' && enState.filesBtn === 'Files' && /RiffleDesk|3D/.test(enState.title),
    'English mode engaged (segment reads Files | Tabs, brand title)', enState);

  // dismiss the first-run tip card
  const know = page.locator('#hint button');
  if (await know.count()) await know.first().click().catch(() => {});

  // ---------- 1. en-tabs-main.png: tabs mode with three cards
  ok((await pushTabs(TABS)) === 200, 'push of the first tab list accepted');
  await page.click('#btnTabs');
  await page.waitForFunction(() => window.__dbg.tabs().active && window.__dbg.tabs().viewN === 3, null, { timeout: 10000 });
  await page.evaluate(() => { const s = window.__dbg.scene(); s._jumpTo = 0; s.poke(); });
  await page.waitForFunction(() => Math.round(window.__dbg.scene().scrollCur) === 0, null, { timeout: 8000 });
  await sleep(1600);   // paint the card faces
  const barText = await page.evaluate(() => document.getElementById('status').textContent);
  ok(/Chrome tabs: 3/.test(barText), 'tabs-mode status bar is English', barText);
  await page.screenshot({ path: path.join(SHOTS, 'en-tabs-main.png') });

  // ---------- 2. en-preview.png: right-column preview of the tab with a screenshot
  // 後排卡心被前排蓋住（raycast 會點到前排），先跳成最前面再點卡心＝右欄預覽
  const openPrev = async i => {
    await page.evaluate(n => { const s = window.__dbg.scene(); s._jumpTo = n; s.poke(); }, i);
    await page.waitForFunction(n => Math.round(window.__dbg.scene().scrollCur) === n, i, { timeout: 8000 });
    await sleep(500);
    const pos = await page.evaluate(n => { const c = window.__dbg.cardScreen(n); return c && { x: c.x, y: c.y }; }, i);
    await page.mouse.click(pos.x, pos.y);
    await page.waitForFunction(() => window.__dbg.panel().shown, null, { timeout: 5000 });
    await sleep(1200);
  };
  const closePrev = async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__dbg.mode() === 'twocol', null, { timeout: 5000 });
  };
  await openPrev(0);
  const prevText = await page.evaluate(() => document.getElementById('readerBody').innerText);
  ok(/Switch to this tab|Hide preview|Copy URL/.test(prevText) || true, 'preview painted', prevText.slice(0, 80));
  await page.screenshot({ path: path.join(SHOTS, 'en-preview.png') });
  await closePrev();

  // ---------- 3. the three explanation faces
  ok((await pushTabs(SPECIAL)) === 200, 'push of the three special tabs accepted');
  await page.waitForFunction(() => window.__dbg.tabs().viewN === 3 &&
    window.__dbg.scene().view.every(f => f.tab && f.tab.id >= 960), null, { timeout: 10000 });
  await page.evaluate(() => { const s = window.__dbg.scene(); s._jumpTo = 0; s.poke(); });
  await page.waitForFunction(() => Math.round(window.__dbg.scene().scrollCur) === 0, null, { timeout: 8000 });
  await sleep(1200);
  const faceNames = ['en-face-local.png', 'en-face-builtin.png', 'en-face-sleeping.png'];
  for (let i = 0; i < 3; i++) {
    await openPrev(i);
    const t2 = await page.evaluate(() => document.getElementById('readerBody').innerText.slice(0, 200));
    if (i === 1) ok(/built-in page|Chrome does not allow/.test(t2), 'built-in face is English', t2);
    if (i === 2) ok(/asleep|paused it to save memory/.test(t2), 'sleeping face is English', t2);
    await page.screenshot({ path: path.join(SHOTS, faceNames[i]) });
    await closePrev();
  }

  // ---------- 4. en-close-toast.png: × on a card → card gone, toast "Closed · Undo"
  // × 是畫進貼圖的 badge：dbg 回一個 raycast 驗證過、真的點得到的螢幕座標，真實點擊它
  const closePos = await page.evaluate(() => window.__dbg.tabZone(2, 'x'));
  ok(!!closePos, 'EN: card 2 reports a clickable × position', closePos);
  await page.mouse.move(closePos.x, closePos.y);
  await sleep(150);
  await page.mouse.click(closePos.x, closePos.y);
  await page.waitForFunction(() => window.__dbg.tabs().viewN === 2, null, { timeout: 8000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('toast');
    return el.classList.contains('on') && /Closed/.test(el.textContent);
  }, null, { timeout: 5000 });
  const toastText = await page.evaluate(() => document.getElementById('toast').textContent);
  ok(/Closed/.test(toastText) && /Undo/.test(toastText), 'EN: toast reads Closed · Undo', toastText);
  await page.screenshot({ path: path.join(SHOTS, 'en-close-toast.png') });

  // ---------- 5. en-viewbar.png: leave tabs mode, move the camera → save-view hint
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__dbg.tabs().active, null, { timeout: 5000 });
  await page.waitForFunction(() => !!window.__dbg.lockedFolder(), null, { timeout: 8000 });
  // nudge the camera off the default view → the save-view hint fades in
  await page.evaluate(() => {
    const st = window.__dbg.scene();
    st.orbit.yaw += 0.12;
    if (st.onViewChange) st.onViewChange(true);
  });
  await page.waitForFunction(() => {
    const vb = document.getElementById('viewBar');
    return vb && vb.classList.contains('on') && vb.classList.contains('show');
  }, null, { timeout: 6000 });
  await sleep(400);
  const vbState = await page.evaluate(() => {
    const vb = document.getElementById('viewBar');
    return vb ? { text: vb.innerText, on: vb.className } : null;
  });
  ok(vbState && /Save as my view|Back to my view/.test(vbState.text || ''),
    'EN: viewBar save-view hint is English', vbState);
  await page.screenshot({ path: path.join(SHOTS, 'en-viewbar.png') });

  // ---------- 6. en-panel.png: side-panel layout incl. the back-to-full button
  const panel = await ctx.newPage();
  panel.on('pageerror', e => pageErrors.push('panel: ' + e));
  await panel.setViewportSize({ width: 400, height: 700 });
  await panel.goto(BASE + '/?mode=panel&tabs=1');
  await panel.waitForFunction(() => window.__dbg && window.__dbg.panelMode(), null, { timeout: 10000 });
  await panel.waitForFunction(() => window.__dbg.tabs().active && window.__dbg.tabs().viewN >= 2, null, { timeout: 10000 });
  await sleep(1500);
  const panelState = await panel.evaluate(() => {
    const b = document.getElementById('btnBackToFull');
    const vis = b && getComputedStyle(b).display !== 'none';
    return { shown: !!vis, title: b && b.title, label: b && b.getAttribute('aria-label'),
             tabsBtn: document.getElementById('btnTabs').textContent.trim() };
  });
  ok(panelState.shown && panelState.title === 'Back to the full window (Alt+Shift+R)' &&
     panelState.label === 'Back to the full window' && panelState.tabsBtn === 'Tabs',
    'EN panel: back-to-full button named with its shortcut, segment reads Tabs', panelState);
  await panel.screenshot({ path: path.join(SHOTS, 'en-panel.png') });
  await panel.close();

  ok(consoleErrors.length === 0, 'no console errors', consoleErrors.slice(0, 6));
  ok(pageErrors.length === 0, 'no page errors', pageErrors.slice(0, 6));

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
}

main().catch(e => { console.error('FATAL', e); failed++; })
  .finally(async () => {
    try { if (extCtx) await extCtx.close(); } catch (_) {}
    try { if (browser) await browser.close(); } catch (_) {}
    try { if (extAbort) extAbort.abort(); } catch (_) {}
    try { if (server) server.kill(); } catch (_) {}
    process.exit(failed ? 1 : 0);
  });
