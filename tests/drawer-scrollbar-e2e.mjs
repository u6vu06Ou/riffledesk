// tests/drawer-scrollbar-e2e.mjs — REAL Chromium + 真 unpacked extension/。
// 驗收三件事：
//  (1) 傳統捲軸死區修正：觸發條對齊「版面視口」邊緣，有傳統直捲軸時滑鼠停在
//      捲軸上（clientX >= documentElement.clientWidth）事件不落條上——
//      由 window 層 mousemove 補盯（clientX>=clientWidth-2）走同一套 dwell。
//      ⚠ headless Chromium 實測（scrollbar-probe*）：不論 --disable-features=
//      OverlayScrollbar 或 ::-webkit-scrollbar 強制寬度，headless 的捲軸都不
//      佔版面（innerWidth == clientWidth），真捲軸幾何無法在 headless 復現；
//      所以「滑鼠在捲軸上」用合成 mousemove（clientX > clientWidth）驗證
//      補盯路徑，實體 Windows 傳統捲軸的 live 驗證請看 CHANGELOG/report。
//      也驗「按住按鈕（拖捲軸）不觸發」。
//  (2) drawerSide 設定：撥成 'left' 後觸發條在左、由左滑出、把手在右緣且
//      往右拖加寬；開著的分頁即時生效（不重整）。
//  (3) 孤兒善後：把內容腳本所在隔離世界的 chrome.runtime.sendMessage 換成
//      丟「Extension context invalidated」的樁 → 觸發一次狀態重查 → 抽屜 UI
//      拆除＋旗標清空；還原樁後叫背景補種 → 新 host 長回、邊緣可開。
// 埠：RiffleDesk server 5197、fixture page 5196（5190–5199 內）。headless。
// Usage: node tests/drawer-scrollbar-e2e.mjs
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
const PORT = 5197;          // RiffleDesk server
const FIX_PORT = 5196;      // fixture page 127.0.0.1:5196（自家頁 skipSelf 只看 5197）
const BASE = `http://127.0.0.1:${PORT}`;
const FIX = `http://127.0.0.1:${FIX_PORT}`;
// 同 drawer-e2e：品牌版 Chrome headless 不載擴充，用 playwright 自帶 Chromium
const PW_CHROMIUM = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe');
const CHROME = fs.existsSync(PW_CHROMIUM) ? PW_CHROMIUM : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const pageErrors = [];
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-drawer-sb-'));
fs.mkdirSync(path.join(TMP, 'root'), { recursive: true });
for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(TMP, 'root', `sb-${i}.md`), `# scrollbar fixture ${i}\n`);
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [path.join(TMP, 'root')], pinned: [], convoRoots: [] }, null, 2));
const PROFILE = path.join(TMP, 'profile');

// 長內容頁：document 可捲動（邏輯上有直捲軸；headless 捲軸不佔版面、截圖看不見）
const LONG_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>ScrollFixture</title>' +
  '<style>body{margin:0;font-family:sans-serif}.bar{position:sticky;top:0;height:56px;background:#26532f;color:#fff;' +
  'display:flex;align-items:center;padding:0 16px}main{padding:16px;line-height:2}</style></head>' +
  `<body><div class="bar">ScrollFixtureBar</div><main><h1>有直捲軸的長頁</h1>${
  Array.from({ length: 120 }, (_, i) => `<p>scroll filler line ${i} —— 內容夠長才有直捲軸。</p>`).join('')
  }</main></body></html>`;
function startFixture() {
  const srv = http.createServer((req, res) => {
    if (req.url === '/long') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(LONG_HTML);
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
  const t = h.shadowRoot.querySelector('.t');
  const dr = d.getBoundingClientRect();
  const tr = t.getBoundingClientRect();
  return {
    open: d.dataset.open,
    width: Math.round(dr.width),
    dLeft: Math.round(dr.left), tLeft: Math.round(tr.left),
    // 藏起來時的位移方向：+105% ＝往右躲（右邊模式）、-105% ＝往左躲（左邊模式）
    hiddenTx: d.dataset.open === '1' ? 0 : Math.round(new DOMMatrix(getComputedStyle(d).transform).m41),
    flag: !!window.__rdDrawerInit
  };
});
// 合成「滑鼠在傳統捲軸上」的 mousemove：clientX 超出版面視口（headless 無法真擺捲軸）
const synthMove = (page, x, buttons) => page.evaluate(([cx, btns]) => {
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: 400, buttons: btns, bubbles: true }));
}, [x, buttons || 0]);

async function main() {
  server = await startServer();
  fix = await startFixture();
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME, headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           '--disable-features=OverlayScrollbar'],
    viewport: { width: 1280, height: 800 }
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  ok(/^[-a-z]{32}$/.test(extId), 'extension service worker is running', sw.url());

  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.waitForLoadState('domcontentloaded');

  // options 頁的「抽屜待在」切換存在且預設右邊（看得到的控制項）
  const sideCtl = await opt.evaluate(() => {
    const s = document.getElementById('drawerSide');
    return s ? { tag: s.tagName, value: s.value, opts: Array.from(s.options).map(o => o.value) } : null;
  });
  ok(sideCtl && sideCtl.tag === 'SELECT' && sideCtl.value === 'right' &&
     sideCtl.opts.join(',') === 'right,left', 'options page has a visible drawer-side selector, default right', sideCtl);

  await opt.evaluate(p => new Promise(res => chrome.storage.local.set(
    { port: p, autoHideDrawer: true }, res)), PORT);
  // 等擴充跟 server 配對（不然抽屜 iframe 不放寬框入，截圖會是錯誤頁）
  let paired = false;
  for (let i = 0; i < 60 && !paired; i++) {
    try { paired = !!(await (await fetch(`${BASE}/api/tabs?meta=1`)).json()).extAlive; } catch (_) {}
    if (!paired) await sleep(250);
  }
  ok(paired, 'extension paired with the test server');

  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
  await page.goto(FIX + '/long');
  await page.waitForLoadState('domcontentloaded');
  await sleep(900);
  const scrollable = await page.evaluate(() => ({
    canScroll: document.documentElement.scrollHeight > window.innerHeight,
    sbW: window.innerWidth - document.documentElement.clientWidth,
    cw: document.documentElement.clientWidth, iw: window.innerWidth
  }));
  ok(scrollable.canScroll, 'fixture page is scrollable (long content)', scrollable);

  let st = await drawerState(page);
  ok(st && st.open === '0', 'drawer host installed, closed, right side', st);
  ok(st && st.tLeft >= st.cw ? true : st && st.tLeft >= scrollable.cw - 13, 'trigger strip sits at the right edge', st);

  // (1a) 按住按鈕停在「捲軸區」不觸發（拖捲軸情境）
  await page.mouse.move(640, 420); await sleep(400);   // 先把指標泊到中間、清 edgeHot
  await synthMove(page, scrollable.cw + 9, 1);          // clientX > clientWidth、按住左鍵
  await sleep(120);
  await synthMove(page, scrollable.cw + 11, 1);         // 過節流再補一發
  await sleep(120 + 150 + 350);
  st = await drawerState(page);
  ok(st && st.open === '0', 'pointer on scrollbar WITH button held: drawer stays closed', st);
  await synthMove(page, 640, 0); await sleep(80);       // 放開按鈕、離開邊緣區

  // (1b) 滑鼠停在傳統捲軸上（無按鍵）→ dwell → 抽屜展開
  await synthMove(page, scrollable.cw + 9, 0);
  await sleep(120);
  await synthMove(page, scrollable.cw + 10, 0);         // 過 40ms 節流的第二發（真正觸發 dwell 的）
  await sleep(120 + 150 + 350);
  st = await drawerState(page);
  ok(st && st.open === '1', 'pointer resting on classic scrollbar: drawer opens (dead-zone fix)', st);

  // 面板真的載進來（截圖要有內容）
  let panelFrame = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    panelFrame = page.frames().find(f => /\/\?mode=panel/.test(f.url()));
    if (panelFrame && panelFrame.url().startsWith(BASE)) break;
    panelFrame = null;
    await sleep(500);
  }
  ok(!!panelFrame, 'drawer iframe loaded the panel page', panelFrame ? panelFrame.url() : null);

  // 徘徊收合：指標自始沒進抽屜（真實滑鼠一直泊在 (640,420)）→ LINGER 後自動收合
  await sleep(1500 + 400 + 150 + 500);
  st = await drawerState(page);
  ok(st && st.open === '0', 'pointer never entered: linger auto-close (no stuck-open from scrollbar open)', st);

  // 真滑鼠在物理右緣（觸發條上）也照常工作；滑入後指標在抽屜上 → 不停留徘徊收合
  await page.mouse.move(1279, 420, { steps: 4 });
  await sleep(120 + 150 + 350);
  st = await drawerState(page);
  ok(st && st.open === '1', 'real mouse slammed to physical right edge still works', st);
  await sleep(1500 + 400 + 150 + 200);                  // 超過徘徊期，要還開著（指標在抽屜上）
  st = await drawerState(page);
  ok(st && st.open === '1', 'pointer INSIDE the open drawer: linger does NOT close it', st);
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, 'drawer-scrollbar-open.png') });

  // 移開 → 一般 400ms 收合
  await page.mouse.move(640, 420, { steps: 3 });
  await sleep(400 + 150 + 350);
  st = await drawerState(page);
  ok(st && st.open === '0', 'mouse left the drawer: collapsed after ~400 ms', st);

  // (2) 撥成左邊：開著的分頁即時重建（不重整）；觸發條在左、由左滑出
  await page.mouse.move(640, 420, { steps: 3 });
  await sleep(400 + 150 + 350);
  await opt.evaluate(() => new Promise(res => chrome.storage.local.set({ drawerSide: 'left' }, res)));
  await sleep(500);
  st = await drawerState(page);
  ok(!!st, 'left flip: host rebuilt on the live tab (no reload)', st);
  ok(st && st.tLeft <= 1, 'left mode: trigger strip sits at x=0', st && { tLeft: st.tLeft });
  ok(st && st.dLeft <= -st.width + 1, 'left mode: drawer hides to the LEFT (translateX(-105%))', st && { dLeft: st.dLeft, w: st.width });
  const w0 = st ? st.width : 420;
  await page.mouse.move(40, 420, { steps: 3 });         // 泊在距左緣 40px（不碰觸發條）
  await sleep(400);
  await page.mouse.move(0, 420, { steps: 4 });          // 撞物理左緣
  await sleep(120 + 150 + 350);
  st = await drawerState(page);
  ok(st && st.open === '1' && st.dLeft <= 1, 'left mode: mouse to left edge opens drawer at x=0', st);
  await sleep(1200);                                    // 等 iframe 重連一下再拍
  await page.screenshot({ path: path.join(SHOTS, 'drawer-left-open.png') });

  // 左邊模式的把手在抽屜右緣，往右拖加寬
  const grip = await page.evaluate(() => {
    const h = document.getElementById('riffle-drawer-host');
    const g = h.shadowRoot.querySelector('.g').getBoundingClientRect();
    return { x: g.x + 3, y: g.y + 400, right: g.right };
  });
  const dRight = await page.evaluate(() => {
    const h = document.getElementById('riffle-drawer-host');
    return h.shadowRoot.querySelector('.d').getBoundingClientRect().right;
  });
  ok(Math.abs(grip.x - dRight) < 9, 'left mode: grip is on the drawer\'s RIGHT edge', { grip: grip.x, dRight });
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + 60, grip.y, { steps: 6 });
  await page.mouse.up();
  await sleep(300);
  st = await drawerState(page);
  ok(st && st.width === w0 + 60, 'left mode: dragging the grip RIGHT widens the drawer', { before: w0, after: st && st.width });

  // 撥回右邊（乾淨收尾，也驗來回切）
  await page.mouse.move(640, 420, { steps: 3 });
  await sleep(400 + 150 + 350);
  await opt.evaluate(() => new Promise(res => chrome.storage.local.set({ drawerSide: 'right' }, res)));
  await sleep(500);
  st = await drawerState(page);
  ok(st && st.tLeft >= scrollable.cw - 13, 'flip back to right: strip at right edge again', st && { tLeft: st.tLeft });

  // (3) 孤兒善後：sendMessage 丟「Extension context invalidated」→ UI 拆除＋旗標清空
  const tabId = await opt.evaluate(u => chrome.tabs.query({ url: u }).then(ts => ts[0] && ts[0].id), FIX + '/long');
  const patched = await opt.evaluate(id => chrome.scripting.executeScript({
    target: { tabId: id }, world: 'ISOLATED',
    func: () => {
      const rt = chrome.runtime;
      const orig = rt.sendMessage;
      rt.sendMessage = () => { throw new Error('Extension context invalidated'); };
      return rt.sendMessage !== orig;                       // false＝屬性不可寫，退求其次
    }
  }), tabId);
  patchOK: {
    const took = patched && patched[0] && patched[0].result === true;
    ok(took, 'orphan simulation: sendMessage stub installed in the isolated world', patched && patched[0]);
    if (!took) break patchOK;                               // 打不上樁就不能驗後面（照實報告）
    const errsBefore = pageErrors.length;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));  // 觸發重查 → 踩到樁
    await sleep(600);
    st = await drawerState(page);
    ok(st === null, 'invalidated context: drawer UI torn down (no dead shell)', pageErrors.slice(errsBefore));
    // 旗標在「隔離世界」裡（page.evaluate 的 main world 永遠看不到），用 scripting 探
    const flagProbe = await opt.evaluate(id => chrome.scripting.executeScript({
      target: { tabId: id }, world: 'ISOLATED',
      func: () => !window.__rdDrawerInit
    }), tabId);
    ok(flagProbe && flagProbe[0] && flagProbe[0].result === true, 'invalidated context: occupancy flag cleared');
    ok(pageErrors.length === errsBefore, 'no uncaught page error during orphan teardown', pageErrors.slice(errsBefore));

    // 還原樁 → 背景補種 → 活體重建
    await opt.evaluate(id => chrome.scripting.executeScript({
      target: { tabId: id }, world: 'ISOLATED',
      func: () => {
        delete chrome.runtime.sendMessage;                  // 刪掉 own property，還原原 API
        return typeof chrome.runtime.sendMessage === 'function';
      }
    }), tabId);
    const inj0 = await sw.evaluate(() => testStats.drawerInjects);
    await sw.evaluate(() => globalThis.injectDrawerScripts());
    let fresh = false;
    for (let i = 0; i < 40 && !fresh; i++) { await sleep(250); fresh = !!(await drawerState(page)); }
    ok(fresh, 'after teardown: background re-seed rebuilds a live drawer host', { before: inj0, after: await sw.evaluate(() => testStats.drawerInjects) });
    await synthMove(page, scrollable.cw + 9, 0);
    await sleep(120);
    await synthMove(page, scrollable.cw + 10, 0);
    await sleep(120 + 150 + 350);
    st = await drawerState(page);
    ok(st && st.open === '1', 'revived drawer opens via the scrollbar fallback path', st);
  }
}

main()
  .catch(e => { console.log('FAIL harness ' + e.stack); failed++; })
  .finally(async () => {
    if (pageErrors.length) console.log('pageerrors:', JSON.stringify(pageErrors.slice(0, 5)));
    if (ctx) await ctx.close().catch(() => {});
    if (server) server.kill();
    if (fix) fix.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
    process.exit(failed ? 1 : 0);
  });
