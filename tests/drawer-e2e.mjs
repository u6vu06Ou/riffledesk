// tests/drawer-e2e.mjs — REAL Chrome + the real unpacked extension/. 驗收
// 「自動收合側欄（右緣抽屜）」：設定關→頁面沒有 host；開→滑鼠碰右緣停 120ms
// 抽屜滑出且 iframe 載入面板頁；移開 400ms 收合；Esc 收合；📌 釘住不收；
// 寬度拖左緣調且重整後記得；版面寬度不變；真側邊欄開著（假 port 模擬
// panel-hello 廣播）→ 觸發條失效；關掉設定→host 整個消失。
// 埠：RiffleDesk server 5193、fixture page 5192（全部落在 5190–5199）。
// Usage: node tests/drawer-e2e.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const PORT = 5193;          // RiffleDesk server
const FIX_PORT = 5192;      // fixture page
const BASE = `http://127.0.0.1:${PORT}`;
const FIX = `http://127.0.0.1:${FIX_PORT}`;
// 同 tabs-ext-e2e：品牌版 Chrome headless 不載擴充，優先用 playwright 自帶 Chromium
const PW_CHROMIUM = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe');
const CHROME = fs.existsSync(PW_CHROMIUM) ? PW_CHROMIUM : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-drawer-'));
fs.mkdirSync(path.join(TMP, 'root'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'root', 'readme.md'), '# drawer fixture\n');
// 多放幾張卡：滾輪驗收（scrollTarget 要動）需要卡堆有得捲
for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(TMP, 'root', `note-${i}.md`), `# drawer fixture ${i}\n`);
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [path.join(TMP, 'root')], pinned: [], convoRoots: [] }, null, 2));
const PROFILE = path.join(TMP, 'profile');

// 要讓「版面寬度不變」有意義：頁面右緣放一條 marker，內容滿寬
const FIX_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>DrawerFixture</title>' +
  '<style>body{margin:0;font-family:sans-serif}.bar{height:60px;background:#3a6ea5;color:#fff;' +
  'display:flex;align-items:center;padding:0 16px}main{padding:16px}</style></head>' +
  '<body><div class="bar">DrawerFixtureBar</div><main><h1>DrawerFixture Page</h1>' +
  '<p>ExtDrawerMarker 這頁給右緣抽屜驗收用：內容滿寬、寬度 100%，抽屜應該覆蓋上來而不是把它推窄。</p></main></body></html>';
function startFixtureServer() {
  const srv = http.createServer((req, res) => {
    if (req.url === '/p1') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(FIX_HTML);
    }
    res.writeHead(404); res.end('nope');
  });
  return new Promise(res => srv.listen(FIX_PORT, '127.0.0.1', () => res(srv)));
}
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

let server = null, ctx = null, fix = null;

// shadow 內狀態一把抓（host 不在＝null）
const drawerState = page => page.evaluate(() => {
  const h = document.getElementById('riffle-drawer-host');
  if (!h || !h.shadowRoot) return null;
  const d = h.shadowRoot.querySelector('.d');
  const pin = h.shadowRoot.querySelector('.pin');
  const f = h.shadowRoot.querySelector('iframe.f');
  return {
    open: d ? d.dataset.open : null,
    width: d ? Math.round(d.getBoundingClientRect().width) : 0,
    pinned: pin ? pin.dataset.on : null,
    frameSrc: f ? f.src : null
  };
});
const edgeOpen = async page => {                  // 碰右緣中線，守候留＋滑入
  await page.mouse.move(200, 420); await sleep(80);
  await page.mouse.move(1279, 420, { steps: 4 });
  await sleep(120 + 150 + 250);
};

async function main() {
  server = await startServer();
  fix = await startFixtureServer();
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 1280, height: 800 }
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  ok(/^[-a-z]{32}$/.test(extId), 'extension service worker is running', sw.url());

  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.waitForLoadState('domcontentloaded');
  const portSet = await opt.evaluate(p => new Promise(res => {
    chrome.storage.local.set({ port: p }, () => chrome.storage.local.get({ port: 0 }, d => res(d.port === p)));
  }), PORT);
  ok(portSet === true, 'options page set the port to 5193');
  // 抽屜面板只在擴充已跟 server 配對 token 後才放寬框入：等擴充第一次推清單（配對）
  let paired = false;
  for (let i = 0; i < 60 && !paired; i++) {
    try { paired = !!(await (await fetch(`${BASE}/api/tabs?meta=1`)).json()).extAlive; } catch (_) {}
    if (!paired) await sleep(250);
  }
  ok(paired, 'extension paired with the test server (token) before opening the drawer');

  // content script 有註冊進 manifest、面板頁有 web_accessible_resources（SW 側讀 manifest）
  const mfeat = await sw.evaluate(async () => {
    const m = await (await fetch(chrome.runtime.getURL('manifest.json'))).json();
    return {
      cs: !!(m.content_scripts && m.content_scripts[0] && m.content_scripts[0].js.includes('drawer.js')),
      war: !!(m.web_accessible_resources && m.web_accessible_resources[0] &&
              m.web_accessible_resources[0].resources.includes('sidepanel.html'))
    };
  });
  ok(mfeat.cs && mfeat.war, 'manifest: drawer.js content script + sidepanel.html web-accessible', mfeat);

  const page = await ctx.newPage();
  await page.goto(FIX + '/p1');
  await page.waitForLoadState('domcontentloaded');
  const width0 = await page.evaluate(() => document.documentElement.clientWidth);
  await sleep(700);
  ok((await drawerState(page)) === null, 'setting OFF (default): no host element on the page');

  // 打開設定（即時套用到已開分頁，不用重整）
  await opt.evaluate(() => new Promise(res => chrome.storage.local.set({ autoHideDrawer: true }, res)));
  let st = null;
  for (let i = 0; i < 30 && !st; i++) { await sleep(200); st = await drawerState(page); }
  ok(!!st, 'setting ON: drawer host installed live (no reload)', st);

  // 碰右緣 → 停 120ms → 滑出；第一次開才建 iframe（sidepanel.html?drawer=1）
  await edgeOpen(page);
  st = await drawerState(page);
  ok(st && st.open === '1', 'mouse dwell on right edge: drawer opened', st);
  ok(st && /sidepanel\.html\?drawer=1/.test(st.frameSrc || ''), 'drawer iframe = extension sidepanel.html?drawer=1', st && st.frameSrc);

  // 面板真的載進來了：找到 frame 樹裡的 ?mode=panel（server 在 5193 跑著）
  let panelFrame = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    panelFrame = page.frames().find(f => /\/\?mode=panel/.test(f.url()));
    if (panelFrame && panelFrame.url().startsWith(BASE)) break;
    panelFrame = null;
    await sleep(500);
  }
  ok(!!panelFrame, 'drawer iframe loaded the real panel page (?mode=panel on the server)', panelFrame ? panelFrame.url() : page.frames().map(f => f.url()));

  // ---- Ctrl+滾輪：畫布上＝相機縮放、面板其餘處＝介面縮放、主頁不准瀏覽器縮放 ----
  // 機制斷言（新版）：護欄改為「本機 preventDefault 吞掉縮放手勢」，永遠不碰分頁的
  // zoom mode/scope/級別——指標進出抽屜全程 getZoomSettings/getZoom 保持原值
  // （舊版進出各改一次 mode，連帶重設縮放級別並觸發 Chrome 縮放氣泡，已回歸測到）。
  let cardN = 0;
  for (let i = 0; i < 40 && !cardN; i++) {
    cardN = await panelFrame.evaluate(() => (window.__dbg && window.__dbg.scene().view.length) || 0).catch(() => 0);
    if (!cardN) await sleep(250);
  }
  ok(cardN > 0, 'panel stack has cards to wheel over', cardN);
  // 頂層分頁的完整縮放狀態（mode/scope/級別），用來斷言「指標進出抽屜前後沒被動過」
  const getFixZoom = () => opt.evaluate(u => chrome.tabs.query({ url: u }).then(async ts => {
    if (!ts || !ts[0]) return null;
    const zs = await chrome.tabs.getZoomSettings(ts[0].id);
    const z = await chrome.tabs.getZoom(ts[0].id);
    return { mode: zs.mode, scope: zs.scope, zoom: z };
  }), FIX + '/p1');
  const sameZoom = (a, b) => !!a && !!b && a.mode === b.mode && a.scope === b.scope && a.zoom === b.zoom;
  const zoomBefore = await getFixZoom();
  const frameRect = await page.evaluate(() => {
    const h = document.getElementById('riffle-drawer-host');
    const r = h.shadowRoot.querySelector('iframe.f').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const tbBottom = await panelFrame.evaluate(() =>
    document.getElementById('toolbar').getBoundingClientRect().bottom).catch(() => 82);
  const dpr0 = await page.evaluate(() => devicePixelRatio);
  // 指標移上卡片畫布（面板 iframe 內頂列之下）；等 mouseenter → 背景關縮放落地
  const canvasPt = { x: Math.round(frameRect.x + frameRect.w / 2), y: Math.round(frameRect.y + tbBottom + 60) };
  await page.mouse.move(canvasPt.x, canvasPt.y);
  await sleep(500);
  let zs = await getFixZoom();
  ok(sameZoom(zoomBefore, zs),
     'hovering the drawer: host tab zoom settings + level untouched (no zoom-settings dance, no bubble)',
     { before: zoomBefore, whileHover: zs });

  // 合成 ctrl+wheel 派到抽屜殼（非 iframe 部分）：內容腳本的本機攔截應 preventDefault
  const shellBlocked = await page.evaluate(() => {
    const h = document.getElementById('riffle-drawer-host');
    const hd = h && h.shadowRoot && h.shadowRoot.querySelector('.hd');
    if (!hd) return null;
    // 註：建構式造的事件 composed 預設 false 過不了 shadow 邊界；瀏覽器真實 wheel
    // 是 composed:true——這裡照真實事件設，驗 capture 攔截鏈
    const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, ctrlKey: true, deltaY: -120 });
    hd.dispatchEvent(ev);
    return ev.defaultPrevented === true;
  });
  ok(shellBlocked === true, 'ctrl+wheel dispatched over the drawer shell is defaultPrevented', shellBlocked);

  // Ctrl+滾輪（畫布上）→ 相機 zoom 變、介面 zoom 不變
  const cam0 = await panelFrame.evaluate(() => window.__dbg.camera().orbit.zoom);
  const uiZ0 = await panelFrame.evaluate(() => window.__dbg.uiZoom());
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await sleep(400);
  const afterCam = await panelFrame.evaluate(() => ({ cam: window.__dbg.camera().orbit.zoom, z: window.__dbg.uiZoom() }));
  ok(Math.abs(afterCam.cam - cam0) > 0.01, 'Ctrl+wheel over the drawer canvas zooms the camera', { cam0, cam: afterCam.cam });
  ok(afterCam.z === uiZ0, 'camera zoom did not touch the UI zoom', { uiZ0, z: afterCam.z });
  ok(await page.evaluate(() => devicePixelRatio) === dpr0,
     'host page did NOT browser-zoom while ctrl+wheel over the drawer', { dpr0 });

  // 普通滾輪照常走卡
  const sc0 = await panelFrame.evaluate(() => window.__dbg.scene().scrollTarget);
  await page.mouse.wheel(0, 240);
  await sleep(300);
  const sc1 = await panelFrame.evaluate(() => window.__dbg.scene().scrollTarget);
  ok(sc1 !== sc0, 'plain wheel still advances the cards in the drawer', { sc0, sc1 });

  // Ctrl+滾輪（面板頂列搜尋框上，非畫布）→ 介面縮放、相機不動
  const sb = await panelFrame.evaluate(() => {
    const r = document.getElementById('searchBox').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(Math.round(frameRect.x + sb.x), Math.round(frameRect.y + sb.y));
  await sleep(400);
  // 注意：相機在介面縮放後會落回我的視角（setPanelZoom 派發 resize → settleViewFor），
  // 真側邊欄同款行為，此處只驗介面縮放確實動了
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await sleep(400);
  const afterUi = await panelFrame.evaluate(() => ({ z: window.__dbg.uiZoom(), cam: window.__dbg.camera().orbit.zoom }));
  ok(afterUi.z !== uiZ0, 'Ctrl+wheel over the panel toolbar zooms the UI', { uiZ0, z: afterUi.z });
  await panelFrame.evaluate(() => window.__dbg.setUiZoom(1));   // 還原，免得影響後面量測

  // 指標離開抽屜：縮放狀態依然原封不動（整個進出循環沒有碰過 zoom settings/級別；
  // 舊版就是在進出時各 setZoomSettings 一次，把 per-origin ≠100% 的網站打回 100%）
  await page.mouse.move(640, 420, { steps: 4 });
  await sleep(600);
  zs = await getFixZoom();
  ok(sameZoom(zoomBefore, zs),
     'pointer left the drawer: host tab zoom settings + level still untouched', { before: zoomBefore, after: zs });

  fs.mkdirSync(SHOTS, { recursive: true });
  await sleep(1500);   // 面板渲染一下再拍
  await page.screenshot({ path: path.join(SHOTS, 'drawer-open.png') });

  // 版面寬度不變（抽屜是覆蓋，不推擠）
  const width1 = await page.evaluate(() => document.documentElement.clientWidth);
  ok(width1 === width0, 'page layout width unchanged (overlay, not resize)', { before: width0, after: width1 });

  // 移開 → 400ms 後收合
  await page.mouse.move(640, 420, { steps: 4 });
  await sleep(400 + 150 + 350);
  st = await drawerState(page);
  ok(st && st.open === '0', 'mouse left the drawer: collapsed after ~400 ms', st);
  ok(st && st.frameSrc !== null, 'iframe kept alive while collapsed (transform hide)');

  // Esc 收合
  await edgeOpen(page);
  st = await drawerState(page);
  ok(st && st.open === '1', 're-open for Esc test', st);
  await page.keyboard.press('Escape');
  await sleep(300);
  st = await drawerState(page);
  ok(st && st.open === '0', 'Esc closes the drawer', st);

  // 📌 釘住：移開不收；取消釘住＝恢復自動收合
  await edgeOpen(page);
  const pinBox = await page.evaluate(() => {
    const h = document.getElementById('riffle-drawer-host');
    const b = h.shadowRoot.querySelector('.pin').getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await page.mouse.click(pinBox.x, pinBox.y);
  st = await drawerState(page);
  ok(st && st.pinned === '1', 'pin button pins the drawer', st);
  await page.mouse.move(640, 420, { steps: 4 });
  await sleep(400 + 150 + 400);
  st = await drawerState(page);
  ok(st && st.open === '1', 'pinned: moving away does NOT collapse', st);
  // 取消釘住後等延遲收合（移回再移開，重計 400ms）
  await page.mouse.click(pinBox.x, pinBox.y);
  await page.mouse.move(1000, 420, { steps: 3 });
  await page.mouse.move(640, 420, { steps: 3 });
  await sleep(400 + 150 + 400);
  st = await drawerState(page);
  ok(st && st.open === '0', 'un-pin: auto-hide works again', st);

  // 拖左緣把手調寬（往左拖 +80px）→ storage 記住 → 重整後仍是新寬度
  await edgeOpen(page);
  st = await drawerState(page);
  const w0 = st ? st.width : 420;
  const grip = await page.evaluate(() => {
    const h = document.getElementById('riffle-drawer-host');
    const g = h.shadowRoot.querySelector('.g').getBoundingClientRect();
    return { x: g.x + 3, y: g.y + 400 };
  });
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x - 80, grip.y, { steps: 6 });
  await page.mouse.up();
  await sleep(300);
  st = await drawerState(page);
  ok(st && st.width === w0 + 80, 'drag left edge: width 420 → 500', { before: w0, after: st && st.width });
  const savedW = await opt.evaluate(() => new Promise(res =>
    chrome.storage.local.get({ drawerWidth: 0 }, d => res(d.drawerWidth))));
  ok(savedW === (w0 + 80), 'drawerWidth persisted to chrome.storage.local', savedW);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  for (let i = 0; i < 30; i++) {         // 等內容腳本讀完 storage 把 host 裝回來
    if (await drawerState(page)) break;
    await sleep(200);
  }
  await edgeOpen(page);
  st = await drawerState(page);
  ok(st && st.open === '1' && st.width === w0 + 80, 'after reload: remembered width applied', st);

  // 真側邊欄開著（假 riffle-panel port＋panel-hello 模擬）→ 觸發條失效
  const winId = await sw.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true })
    .then(ts => ts[0] && ts[0].windowId));
  await opt.evaluate(w => {
    window.__fakePanel = chrome.runtime.connect({ name: 'riffle-panel' });
    window.__fakePanel.postMessage({ t: 'panel-hello', win: w });
  }, winId);
  await sleep(600);
  await page.mouse.move(640, 420);             // 先確保關著
  await sleep(600);
  await page.mouse.move(1279, 420, { steps: 4 });
  await sleep(120 + 150 + 350);
  st = await drawerState(page);
  ok(st && st.open === '0', 'real side panel open in this window: drawer suppressed', st);
  await opt.evaluate(() => { window.__fakePanel.disconnect(); });
  await sleep(600);
  await edgeOpen(page);
  st = await drawerState(page);
  ok(st && st.open === '1', 'side panel closed again: drawer back to life', st);

  // 關掉設定 → host 整個移除
  await opt.evaluate(() => new Promise(res => chrome.storage.local.set({ autoHideDrawer: false }, res)));
  let gone = false;
  for (let i = 0; i < 25 && !gone; i++) { await sleep(200); gone = (await drawerState(page)) === null; }
  ok(gone, 'setting OFF again: host element removed live');

  // ---- 既有分頁補種＋孤兒復活（不重整頁面）----
  // 無頭 Playwright 裡 chrome.runtime.reload() 會讓擴充整個死掉（SW 不重開、
  // extension 頁導航被永久擋），不能用真 reload 模擬；改為直接驗兩個機制：
  //  (a) 撥 ON → 背景 injectDrawerScripts 對既開分頁 executeScript（計數器為證），
  //      活實體的旗標擋下重複注入——host 仍恰好一個；
  //  (b) 模擬孤兒：把旗標換成「死實體」、留著舊 host 遺體 → 直接呼叫背景的
  //      injectDrawerScripts()（top-level 函式，worker 全域可達）→ 新腳本拆遺體重建。
  const inj = () => sw.evaluate(() => testStats.drawerInjects);   // const 在 worker 全域語彙環境，用裸識別符
  const hostCount = async () => page.evaluate(() => document.querySelectorAll('#riffle-drawer-host').length);

  // (a) 撥 ON：補種要跑過（drawerInjects 增加）且 host 不重複
  const inj0 = await inj();
  await opt.evaluate(() => new Promise(res => chrome.storage.local.set({ autoHideDrawer: true }, res)));
  let st3 = null;
  for (let i = 0; i < 30 && !st3; i++) { await sleep(200); st3 = await drawerState(page); }
  ok(!!st3, 'flip ON: drawer back (setting listener and/or background re-seed)', st3);
  ok((await inj()) > inj0, 'flip ON: background injected drawer.js into existing tabs', { before: inj0, after: await inj() });
  ok((await hostCount()) === 1, 'flip ON re-seed over a live instance: still exactly one host', await hostCount());

  // (b) 孤兒復活：真孤兒＝擴充重載後舊內容腳本的 chrome.runtime 已死、DOM 遺體留著。
  //      用 ISOLATED world 注入（與內容腳本同一世界）把旗標換成「死實體」並標記遺體
  //      （page.evaluate 是 MAIN world 碰不到隔離世界的旗標），再叫背景補種：
  //      新腳本要拆掉遺體重建無標記的新 host、恰好一個、而且能用。
  await page.mouse.move(640, 420, { steps: 4 });   // 先收合，等等「開得起來」才算數
  await sleep(400 + 150 + 350);
  let closedSt = await drawerState(page);
  ok(closedSt && closedSt.open === '0', 'resurrection setup: drawer collapsed, pointer parked away', closedSt);
  const tabId = await opt.evaluate(u => chrome.tabs.query({ url: u }).then(ts => ts[0] && ts[0].id), FIX + '/p1');
  await opt.evaluate(id => chrome.scripting.executeScript({
    target: { tabId: id }, world: 'ISOLATED',
    func: () => {
      const h = document.getElementById('riffle-drawer-host');
      if (h) h.dataset.corpse = '1';               // 標記舊遺體：復活後要看不到這個標記
      window.__rdDrawerInit = { alive: () => false };   // 模擬「舊腳本上下文已死」
    }
  }), tabId);
  const inj1 = await inj();
  await sw.evaluate(() => globalThis.injectDrawerScripts());
  let fresh = false;
  for (let i = 0; i < 40 && !fresh; i++) {
    await sleep(250);
    fresh = await page.evaluate(() => {
      const h = document.getElementById('riffle-drawer-host');
      return !!h && !h.dataset.corpse;             // 新 host 沒有遺體標記
    });
  }
  ok(fresh, 'orphan flag + corpse: re-seed builds a FRESH host without a page reload');
  ok((await inj()) > inj1, 'manual re-seed actually ran executeScript', { before: inj1, after: await inj() });
  ok((await hostCount()) === 1, 'resurrection removed the orphan corpse: exactly one host', await hostCount());
  await edgeOpen(page);
  st3 = await drawerState(page);
  ok(st3 && st3.open === '1', 'resurrected drawer opens on edge dwell', st3);
  await page.mouse.move(640, 420, { steps: 4 });   // 收合，讓下一步在乾淨狀態
  await sleep(400 + 150 + 350);

  // 第二次補種：現在旗標是活實體 → 擋下，不雙掛
  await sw.evaluate(() => globalThis.injectDrawerScripts());
  await sleep(800);
  ok((await hostCount()) === 1, 'second re-seed over the resurrected (live) instance: one host', await hostCount());
}

main()
  .catch(e => { console.log('FAIL harness ' + e.stack); failed++; })
  .finally(async () => {
    if (ctx) await ctx.close().catch(() => {});
    if (server) server.kill();
    if (fix) fix.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
    process.exit(failed ? 1 : 0);
  });
