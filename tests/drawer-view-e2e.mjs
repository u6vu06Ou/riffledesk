import { extensionChrome } from './chrome-path.mjs';
// tests/drawer-view-e2e.mjs — REAL Chrome-family + the real unpacked extension/. 驗收
// 右緣抽屜的兩個新行為：
//  (a) 在一般網頁拉出抽屜 → 直接進「網頁（分頁）模式」，且卡堆停在宿主分頁那張卡
//      （sidepanel.js 抽屜模式用 chrome.tabs.getCurrent() 取得宿主分頁 id，
//       iframe 帶 ?mode=panel&tabs=1&tabfocus=<id> 開機）。
//  (b) 抽屜的開機視角＝「★ 我的視角」；沒存過就看最近一次實際在用的視角。
//      抽屜面板頁是第三方 iframe，localStorage 被 Chrome 按站台切開（測試用
//      localhost 夾具站 vs 127.0.0.1 的 RiffleDesk，保證不同站台），共享視角
//      走 server 的 /api/prefs（prefs.json）。
//  (b2) 清掉我的視角後，抽屜改成落在「最後在用的視角」（完整 App 轉過相機，
//       沒存就收尾持久化——去抖 1.5s）。
//  (c) 使用者滾動後不被拉回宿主那張（_bootFocus/_jumpToFocused 的使用者優先閘）。
// 埠：RiffleDesk server 5195、fixture page localhost:5194（5190–5199 內；避開
// 同伴在用的 5192/5193）。不動 5177。headless。
// Usage: node tests/drawer-view-e2e.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const PORT = 5195;          // RiffleDesk server (127.0.0.1)
const FIX_PORT = 5194;      // fixture pages (localhost → 與 server 不同站台)
const BASE = `http://127.0.0.1:${PORT}`;
const FIX = `http://localhost:${FIX_PORT}`;
// 同 tabs-ext/drawer-e2e：品牌版 Chrome headless 不載擴充，優先用 playwright 自帶 Chromium
const CHROME = extensionChrome();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-drawerview-'));
fs.mkdirSync(path.join(TMP, 'root'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'root', 'readme.md'), '# drawer-view fixture\n');
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [path.join(TMP, 'root')], pinned: [], convoRoots: [] }, null, 2));
const PROFILE = path.join(TMP, 'profile');

function startFixtureServer() {
  const srv = http.createServer((req, res) => {
    const m = /^\/(p1|p2|p3)$/.exec(req.url || '');
    if (m) {
      const tag = { p1: 'DrFix-A', p2: 'DrFix-B', p3: 'DrFix-C' }[m[1]];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${tag}</title></head>` +
        `<body style="margin:0;font-family:sans-serif"><div style="height:60px;background:#3a6ea5;color:#fff;display:flex;align-items:center;padding:0 16px">${tag}</div>` +
        `<main style="padding:16px"><h1>${tag} fixture</h1><p>ExtDrawerViewMarker 右緣抽屜驗收頁（不同站台＝localStorage 被切開）。</p></main></body></html>`);
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

const drawerState = page => page.evaluate(() => {
  const h = document.getElementById('riffle-drawer-host');
  if (!h || !h.shadowRoot) return null;
  const d = h.shadowRoot.querySelector('.d');
  return { open: d ? d.dataset.open : null };
});
const edgeOpen = async page => {                  // 碰右緣中線，守候留＋滑入
  await page.mouse.move(200, 420); await sleep(120);
  await page.mouse.move(1279, 420, { steps: 4 });
  await sleep(120 + 150 + 250);
};
// 拉出抽屜並等到面板頁真的載進來；回 panel frame
async function openDrawerPanel(page) {
  await edgeOpen(page);
  const st = await drawerState(page);
  ok(st && st.open === '1', 'drawer opened on fixture page', st);
  let frame = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    frame = page.frames().find(f => /\/\?mode=panel/.test(f.url()));
    if (frame && frame.url().startsWith(BASE)) break;
    frame = null;
    await sleep(400);
  }
  ok(!!frame, 'drawer panel frame loaded (?mode=panel on test server)', frame ? frame.url() : page.frames().map(f => f.url()));
  if (!frame) return null;
  await frame.waitForFunction(() => window.__dbg && typeof window.__dbg.camera === 'function', null, { timeout: 30000 }).catch(() => {});
  return frame;
}
// 卡堆中指定分頁卡的位置與目前焦點
const cardPos = (frame, tabId) => frame.evaluate(id => {
  const sc = window.__dbg.scene();
  if (!sc || !sc.view) return null;
  const idx = sc.view.findIndex(f => f.tab && f.tab.id === id);
  return { idx, cur: Math.round(sc.scrollCur || 0), active: window.__dbg.tabs().active, viewN: sc.view.length };
}, tabId).catch(() => null);
async function tabIdByTitle(sw, titleRe) {
  const tabs = await sw.evaluate(() => chrome.tabs.query({}).then(ts => ts.map(t => ({ id: t.id, title: t.title || '' }))));
  const hit = tabs.find(t => titleRe.test(t.title));
  return hit ? hit.id : 0;
}

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
  ok(/^[-a-z]{32}$/.test(extId), 'extension service worker is running');

  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.waitForLoadState('domcontentloaded');
  await opt.evaluate(p => new Promise(res => {
    chrome.storage.local.set({ port: p, autoHideDrawer: true }, () => res(true));
  }), PORT);
  // 配對 token（抽屜面板要靠 dk= 才放寬 frame-ancestors）
  let paired = false;
  for (let i = 0; i < 60 && !paired; i++) {
    try { paired = !!(await (await fetch(`${BASE}/api/tabs?meta=1`)).json()).extAlive; } catch (_) {}
    if (!paired) await sleep(250);
  }
  ok(paired, 'extension paired with the test server (token)');

  // ================= (a) 抽屜開機＝分頁模式＋宿主分頁卡在前面 =================
  const pageA = await ctx.newPage();
  await pageA.goto(FIX + '/p1');
  await pageA.waitForLoadState('domcontentloaded');
  const idA = await tabIdByTitle(sw, /DrFix-A/);
  ok(idA > 0, 'fixture page A has a chrome tab id', idA);

  const panelA = await openDrawerPanel(pageA);
  if (panelA) {
    const is3d = await panelA.evaluate(() => {
      try { const c = window.__dbg.camera(); return !!(c && c.orbit && Number.isFinite(c.orbit.yaw)); } catch (_) { return false; }
    });
    ok(is3d, '3D card stack up inside the drawer panel (WebGL available)');
    // 等到進分頁模式且焦點落在宿主分頁那張卡（清單來得有先後）
    let pos = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      pos = await cardPos(panelA, idA);
      if (pos && pos.active && pos.idx >= 0 && pos.cur === pos.idx) break;
      await sleep(400);
    }
    ok(pos && pos.active === true, 'drawer boots into tabs (網頁) mode', pos);
    ok(pos && pos.idx >= 0 && pos.cur === pos.idx, 'drawer boots focused on the host tab card', pos);
  }

  // ================= (b) 完整 App 存「我的視角」→ 抽屜拿得到（共享 prefs） =================
  const FAV = { yaw: 14, pitch: 50, zoom: 1.25 };
  const app = await ctx.newPage();
  await app.goto(BASE + '/');
  await app.waitForFunction(() => window.__dbg && typeof window.__dbg.saveFavView === 'function', null, { timeout: 20000 });
  await app.evaluate(() => { window.__dbg.setOrbit(14, 50, 1.25); window.__dbg.saveFavView(); });
  let prefs = null;
  for (let i = 0; i < 40; i++) {
    prefs = await app.evaluate(() => fetch('/api/prefs').then(r => r.json()).then(d => d.prefs).catch(() => null));
    if (prefs && prefs.favView && Math.abs(prefs.favView.yaw - FAV.yaw) < 0.001) break;
    await sleep(250);
  }
  ok(prefs && prefs.favView && Math.abs(prefs.favView.yaw - FAV.yaw) < 0.001,
    'full app save 我的視角 reaches server-shared prefs', prefs);

  const pageB = await ctx.newPage();
  await pageB.goto(FIX + '/p2');
  await pageB.waitForLoadState('domcontentloaded');
  const panelB = await openDrawerPanel(pageB);
  if (panelB) {
    const camB = await panelB.evaluate(() => window.__dbg.camera()).catch(() => null);
    ok(camB && Math.abs(camB.orbit.yaw - FAV.yaw) < 0.01 && Math.abs(camB.orbit.pitch - FAV.pitch) < 0.01 &&
       Math.abs(camB.orbit.zoom - FAV.zoom) < 0.01,
      'drawer on another site boots at the saved 我的視角', camB && camB.orbit);
    const iprefs = await panelB.evaluate(() => fetch('/api/prefs').then(r => r.json()).then(d => d.prefs).catch(() => null));
    ok(iprefs && iprefs.favView && Math.abs(iprefs.favView.yaw - FAV.yaw) < 0.001,
      'drawer frame itself can read shared prefs via server', iprefs && iprefs.favView);
    console.log('INFO drawer localStorage floderMyView =',
      await panelB.evaluate(() => localStorage.getItem('floderMyView')));
  }

  // ================= (b2) 沒存我的視角 → 落在最後在用的視角 =================
  const LAST = { yaw: -15, pitch: 30, zoom: 0.9 };
  await app.bringToFront();
  await app.evaluate(() => { window.__dbg.clearFavView(); window.__dbg.setOrbit(-15, 30, 0.9); });
  for (let i = 0; i < 40; i++) {
    prefs = await app.evaluate(() => fetch('/api/prefs').then(r => r.json()).then(d => d.prefs).catch(() => null));
    if (prefs && !prefs.favView && prefs.lastView && Math.abs(prefs.lastView.yaw - LAST.yaw) < 0.001) break;
    await sleep(250);
  }
  ok(prefs && !prefs.favView && prefs.lastView && Math.abs(prefs.lastView.yaw - LAST.yaw) < 0.001,
    'last used view persisted (fav cleared)', prefs);

  const pageC = await ctx.newPage();
  await pageC.goto(FIX + '/p3');
  await pageC.waitForLoadState('domcontentloaded');
  const panelC = await openDrawerPanel(pageC);
  if (panelC) {
    const camC = await panelC.evaluate(() => window.__dbg.camera()).catch(() => null);
    ok(camC && Math.abs(camC.orbit.yaw - LAST.yaw) < 0.01 && Math.abs(camC.orbit.pitch - LAST.pitch) < 0.01 &&
       Math.abs(camC.orbit.zoom - LAST.zoom) < 0.01,
      'drawer with no favView boots at the last used view', camC && camC.orbit);
  }

  // ================= (c) 使用者滾動後不被拉回宿主那張 =================
  await pageA.bringToFront();
  await pageA.mouse.move(640, 420); await sleep(400 + 150 + 400);   // 先讓它收合
  await edgeOpen(pageA);
  let hostPos = null;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      hostPos = await cardPos(pageA.frames().find(f => /\/\?mode=panel/.test(f.url())), idA);
      if (hostPos && hostPos.idx >= 0) break;
      await sleep(300);
    }
  }
  if (!hostPos || hostPos.idx < 0) { ok(false, '(c) host tab card found in drawer list', hostPos); return; }
  // 使用者在抽屜卡堆上滾幾輪（離開宿主卡）
  await pageA.mouse.move(1100, 500);
  for (let i = 0; i < 3; i++) { await pageA.mouse.wheel(0, 300); await sleep(150); }
  let userPos = null;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      userPos = await cardPos(pageA.frames().find(f => /\/\?mode=panel/.test(f.url())), idA);
      if (userPos && userPos.cur !== hostPos.idx) break;
      await pageA.mouse.wheel(0, 300);
      await sleep(300);
    }
  }
  ok(userPos && userPos.cur !== hostPos.idx, 'user scroll in drawer moves the front card', userPos);
  // 等過風暴視窗，順便製造一輪「遲到的分頁清單推送」（開關一個分頁）
  const pageD = await ctx.newPage();
  await pageD.goto(FIX + '/p1');
  await sleep(1400);
  await pageD.close();
  await sleep(2000);
  const after = await cardPos(pageA.frames().find(f => /\/\?mode=panel/.test(f.url())), idA);
  ok(after && userPos && after.cur === userPos.cur,
    'user scroll after open is not yanked back to the host card', { user: userPos && userPos.cur, after: after && after.cur, hostIdx: hostPos.idx });
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
