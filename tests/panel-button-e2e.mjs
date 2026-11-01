// tests/panel-button-e2e.mjs — REAL Chrome + the real unpacked extension/.
// Reproduces the owner's bug: in the full 3-column app, clicking the right-column
// 「側欄模式」 button opens the side panel on the previewed tab — but right after it
// opens, wheeling feels stuck and the stack gets yanked back to the first card.
//
// Headless Chrome refuses sidePanel.open, so after the (real) button click we open
// chrome-extension://<id>/sidepanel.html as a normal tab — the same page the real
// side panel runs, including its storage session read and its 12×500ms tab-focus
// poke chain. instrument: every scrollTarget change carries a reason (wheel /
// drag / boot-focus / tab-focus-jump / setFolder / list-inplace) from the JS stack.
//
// Usage: node tests/panel-button-e2e.mjs   (failures print the full event log)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const PW_CHROMIUM = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe');
const CHROME = fs.existsSync(PW_CHROMIUM) ? PW_CHROMIUM : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

async function freePort(from, except) {
  for (let p = from; p <= 5199; p++) {
    if (p === except) continue;
    const okP = await new Promise(res => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(p, '127.0.0.1', () => s.close(() => res(true)));
    });
    if (okP) return p;
  }
  throw new Error('no free port in 5190–5199 from ' + from);
}

let PORT, FIX_PORT, BASE, FIX;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-panelbtn-'));
fs.mkdirSync(path.join(TMP, 'root'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'root', 'readme.md'), '# panel-button fixture\n');
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [path.join(TMP, 'root')], pinned: [], convoRoots: [] }, null, 2));
const PROFILE = path.join(TMP, 'profile');

function fixturePage(k) {
  const inner = `<h1>Fixture ${k}</h1><p>BtnBodyMarker-${k} ${'第 ' + k + ' 頁的主內容文字。'.repeat(20)}</p>`;
  const body = `<main>${inner}</main>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>BtnFixture ${k}</title></head><body>${body}</body></html>`;
}
function startFixtureServer() {
  const srv = http.createServer((req, res) => {
    const m = /^\/p(\d+)$/.exec(req.url || '');
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 9) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fixturePage(Number(m[1])));
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
    const to = setTimeout(() => { proc.kill(); rej(new Error('server start timeout: ' + out)); }, 15000);
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) { clearTimeout(to); res(proc); } });
    proc.stderr.on('data', d => { out += d; });
  });
}
async function serverTabs() {
  try {
    const r = await fetch(BASE + '/api/tabs');
    const d = await r.json();
    return d && Array.isArray(d.tabs) ? d : null;
  } catch (_) { return null; }
}

let server = null, ctx = null, fix = null;

// ---- frame instrumentation (runs INSIDE the ?mode=panel iframe) -------------
// Logs every scrollTarget change with a reason derived from the JS call stack,
// every setFolder, every updateFilesInPlace, and every tab-focus postMessage.
function instrumentFrame() {
  if (window.__ev) return true;
  if (!window.__dbg || !window.__dbg.scene) return false;
  const log = [];
  window.__ev = log;
  const ts = () => Math.round(performance.now());
  window.__evAbsolute0 = Date.now() - ts();          // frame-relative → Date.now()
  addEventListener('message', ev => {
    const d = ev && ev.data;
    if (d && d.rifflePanel === 'tab-focus') log.push({ t: ts(), ev: 'msg:tab-focus', tabId: d.tabId });
  });
  const arm = () => {
    const s = window.__dbg.scene();
    if (!s) return false;
    if (s.__btnWrapped) return true;
    s.__btnWrapped = true;
    let v = s.scrollTarget;
    Object.defineProperty(s, 'scrollTarget', {
      configurable: true,
      get() { return v; },
      set(nv) {
        const from = v; v = nv;
        let reason = 'other';
        const st = (new Error()).stack || '';
        if (st.includes('_jumpToFocused')) reason = 'tab-focus-jump';
        else if (st.includes('_applyBootFocus')) reason = 'boot-focus';
        else if (st.includes('setFolder')) reason = 'setFolder';
        else if (st.includes('updateFilesInPlace')) reason = 'list-inplace';
        else if (st.includes('wheel')) reason = 'wheel';
        else if (st.includes('pointermove')) reason = 'drag';
        else if (st.includes('tick')) reason = 'tick-snap';
        log.push({ t: ts(), ev: 'scrollTarget', from: +(+from).toFixed(2), to: +(+nv).toFixed(2), reason });
      }
    });
    const of = s.setFolder.bind(s);
    s.setFolder = (...a) => { log.push({ t: ts(), ev: 'setFolder', name: a[0], n: (a[1] || []).length }); return of(...a); };
    const oi = s.updateFilesInPlace.bind(s);
    s.updateFilesInPlace = (...a) => { log.push({ t: ts(), ev: 'list-inplace', n: (a[0] || []).length, anchor: a[1] }); return oi(...a); };
    return true;
  };
  const iv = setInterval(() => { if (arm()) clearInterval(iv); }, 40);
  return true;
}

function wheelBurstCall(args) {
  // 在 iframe 內執行（playwright 序列化整支函式）：真實滾輪事件打在卡堆 canvas 上。
  const { n, dy, gapMs } = args;
  const cv = document.getElementById('gl');
  if (!cv) return false;
  window.__wheelAt = (window.__wheelAt || []).concat([Math.round(performance.now())]);
  let i = 0;
  const one = () => {
    if (i++ >= n) return;
    cv.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true }));
    setTimeout(one, gapMs);
  };
  one();
  return true;
}

function probe() {
  const s = window.__dbg.scene();
  const idx = Math.round(s.scrollCur);
  const f = s.view && s.view[idx];
  return {
    t: Math.round(performance.now()),
    cur: +(+s.scrollCur).toFixed(3),
    target: +(+s.scrollTarget).toFixed(3),
    frontId: (f && f.tab && !f.tab.note) ? f.tab.id : null,
    frontIdx: idx,
    viewN: (s.view && s.view.length) || 0,
    dragging: s.dragging === true,
    lastUserScrollAt: Math.round(s.lastUserScrollAt || 0)
  };
}

async function main() {
  PORT = await freePort(5190);
  FIX_PORT = await freePort(5190, PORT);
  BASE = `http://127.0.0.1:${PORT}`;
  FIX = `http://127.0.0.1:${FIX_PORT}`;
  console.log(`# ports: server=${PORT} fixture=${FIX_PORT}`);
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
  ok(portSet === true, 'options page set the extension port');

  for (let k = 1; k <= 8; k++) { const p = await ctx.newPage(); await p.goto(`${FIX}/p${k}`); }
  ok(true, 'opened 8 fixture tabs (p1–p8)');
  let list = null;
  // 8 個 fixture 分頁是「推」上去的：擴充剛啟動時可能還在抓第一批，偶爾要 20 秒以上。
  // 這裡是純等待，跟產品行為無關，給到 45 秒免得慢一次就整支紅。
  for (let i = 0; i < 45 && !(list && list.tabs && list.tabs.length >= 8); i++) { await sleep(1000); list = await serverTabs(); }
  ok(!!(list && list.tabs && list.tabs.length >= 8), 'server carries the pushed tab list', list && { n: list.tabs && list.tabs.length });

  // ---- full app + real 「側欄模式」 button click -------------------------------
  const rd = await ctx.newPage();
  await rd.goto(`${BASE}/`);
  await rd.waitForFunction(() => window.__dbg && window.__dbg.ready());
  await rd.evaluate(() => window.__dbg.tabsEnter());
  let armed = false;
  for (let i = 0; i < 30 && !armed; i++) {
    await sleep(500);
    armed = await rd.evaluate(() => { const d = window.__dbg.tabs(); return !!(d.extId && d.viewN > 0); }).catch(() => false);
  }
  ok(armed, 'full app tabs mode armed (list + extId)');

  const dump = await rd.evaluate(() =>
    window.__dbg.scene().view.map(f => (f.tab ? { id: f.tab.id, active: f.tab.active, url: f.tab.url } : null)));
  // 挑索引 2~4 之間的非前景夾具卡：位置夠深，滾動可看出方向；不在裡面就退而求其次
  let targetIdx = dump.findIndex((v, i) => v && !v.active && /\/p\d+$/.test(v.url || '') && i >= 2 && i <= 4);
  if (targetIdx < 0) targetIdx = dump.findIndex(v => v && !v.active && /\/p\d+$/.test(v.url || ''));
  ok(targetIdx >= 0, 'picked a preview target card', { idx: targetIdx, id: dump[targetIdx] && dump[targetIdx].id });
  if (targetIdx < 0) throw new Error('no usable fixture tab card — aborting (see FAIL above)');
  const targetTabId = dump[targetIdx].id;

  await rd.evaluate(i => window.__dbg.tabsPreview(i), targetIdx);
  const btnFound = await rd.evaluate(() => !!document.querySelector('#readerBody .tabact.sidepanel'));
  ok(btnFound, 'right-column preview shows the 「側欄模式」 button');
  const clickAt = Date.now();
  await rd.evaluate(() => document.querySelector('#readerBody .tabact.sidepanel').click());
  ok(true, 'clicked the real 「側欄模式」 button', { clickAt });
  const panelMsg = await rd.evaluate(() => new Promise(res => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const r = window.__dbg.tabs().lastPanelOpen;
      if (r || Date.now() - t0 > 2500) { clearInterval(iv); res(r || null); }
    }, 100);
  }));
  ok(!!panelMsg && panelMsg.ok === true && panelMsg.tabId === targetTabId,
    'extension accepted the click (panel may be refused headless — activation+focus still fire)', panelMsg);

  // Chrome 切到被預覽的那個分頁（背景端 tabs.update active:true 一定執行）
  let actOk = false, actDiag = null;
  const actTrace = [];
  for (let i = 0; i < 20 && !actOk; i++) {
    await sleep(300);
    const st = await opt.evaluate(id => new Promise(res => chrome.tabs.query({}, ts => {
      res({
        active: ts.filter(t => t.active).map(t => t.id),
        targetActive: ts.some(t => t.id === id && t.active)
      });
    })), targetTabId);
    actOk = st.targetActive;
    if (i % 3 === 0) actTrace.push(st.active.join(','));
    if (!actOk && i % 6 === 5) {
      actDiag = await opt.evaluate(id => new Promise(res => chrome.tabs.query({}, ts => res({
        target: (ts.find(t => t.id === id) || {}),
        active: ts.filter(t => t.active).map(t => ({ id: t.id, w: t.windowId, url: (t.url || '').slice(-24) })),
        all: ts.map(t => ({ id: t.id, w: t.windowId, active: !!t.active, url: (t.url || '').slice(-20) }))
      }))), targetTabId);
      actDiag.sweep = await opt.evaluate(() => new Promise(res => {
        const t = setTimeout(() => res({ timeout: true }), 3000);
        chrome.runtime.sendMessage({ type: 'riffle-status' }, r => { clearTimeout(t); res(r || { noReply: true }); });
      }));
      actDiag.idle = await opt.evaluate(() => new Promise(res =>
        chrome.idle.queryState(60, s => res(s))));
    }
  }
  ok(actOk, 'background activated the previewed tab', actDiag ? { targetTabId, actTrace, actDiag } : { targetTabId, actTrace });

  // ---- 側欄(分頁模擬)開啟 -----------------------------------------------------
  // headless 擋 sidePanel.open 的 UI，但 panelFocus 已寫進 storage.session——
  // 直接開 sidepanel.html（跟真側欄同一頁、同一段程式、同一條 12×500ms 補送鏈）。
  const panelPg = await ctx.newPage();
  const panelOpenAt = Date.now();
  await panelPg.goto(`chrome-extension://${extId}/sidepanel.html`);
  const frameReady = await panelPg.waitForFunction(() => {
    const fr = document.getElementById('frame');
    return !!(fr && /mode=panel/.test(fr.src || '') && fr.contentWindow);
  }, null, { timeout: 20000 }).catch(() => null);
  ok(!!frameReady, 'sidepanel.html iframe src set to ?mode=panel…');
  const frameSrc = await panelPg.evaluate(() => document.getElementById('frame').src);
  ok(frameSrc.includes(`tabfocus=${targetTabId}`), 'panel iframe carries tabs=1&tabfocus=<clicked tab>', frameSrc);
  let frame = null;
  for (let i = 0; i < 100 && !frame; i++) {           // frame 物件是非同步掛上的，要輪詢
    frame = panelPg.frames().find(f => /mode=panel/.test(f.url()));
    if (!frame) await sleep(50);
  }
  ok(!!frame, 'panel app iframe present', frame && frame.url());

  // 儀器要搶在卡堆建立前裝好：一直重試到 __dbg 出現
  let instOk = false;
  for (let i = 0; i < 100 && !instOk; i++) {
    instOk = await frame.evaluate(instrumentFrame).catch(() => false);
    if (!instOk) await sleep(50);
  }
  ok(instOk, 'frame instrumented (scrollTarget reason log armed)');
  const frameLoadedAt = Date.now();

  // 等卡片真的在卡堆上（第一次 setFolder('tabs', …) → viewN>0）
  let cardsAt = 0, view0 = null;
  for (let i = 0; i < 60 && !cardsAt; i++) {
    await sleep(100);
    view0 = await frame.evaluate(probe).catch(() => null);
    if (view0 && view0.viewN > 0) cardsAt = Date.now();
  }
  ok(!!cardsAt, 'panel stack shows the tab cards', { clickToCardsMs: cardsAt ? cardsAt - clickAt : null });

  // 定位落地（開機定位或補送定位）：前面那張要是被點的卡（在使用者動手之前）
  let focusAt = 0, focusProbe = null;
  for (let i = 0; i < 40 && !focusAt; i++) {
    await sleep(100);
    const pr = await frame.evaluate(probe).catch(() => null);
    if (pr && pr.frontId === targetTabId) { focusAt = Date.now(); focusProbe = pr; }
  }
  ok(!!focusAt, 'initial position = the previewed tab (decided once before user input)',
    focusProbe && { idx: focusProbe.frontIdx, clickToFocusMs: focusAt - clickAt });

  // ---- 使用者開始滾（框架載入後很快；這裡以定位落地為準 + 200ms）----------------
  // 先小滾一下（模擬手剛放上去），再以更大一手推到清楚的使用者位置。
  await sleep(200);
  const wheelStartAt = Date.now();
  const w1 = await frame.evaluate(wheelBurstCall, { n: 4, dy: 120, gapMs: 40 });
  ok(w1 === true, 'wheel burst #1 dispatched at +200ms after positioning');

  // 滾動要在 300ms 內讓位置動起來（互動時限）
  let movedIn = 0, mProbe = null;
  for (let i = 0; i < 30 && !movedIn; i++) {
    await sleep(100);
    const pr = await frame.evaluate(probe).catch(() => null);
    if (pr && (Math.abs(pr.cur - focusProbe.cur) > 0.02 || pr.target !== focusProbe.target)) {
      movedIn = Date.now() - wheelStartAt; mProbe = pr;
    }
  }
  ok(!!movedIn && movedIn <= 300 + 100 /*取樣間隔*/, 'wheel moves the stack within ~300ms', { ms: movedIn, from: focusProbe, to: mProbe });

  // 轉到一個明確的深度位置（離第 0 張、離目標卡都夠遠）
  await frame.evaluate(wheelBurstCall, { n: 6, dy: 120, gapMs: 40 });
  // 等阻尼真的停穩再記「使用者位置」。不能只睡固定 1200ms：面板分頁在背景，
  // rAF 被 Chrome 降頻，阻尼尾巴（差不到一張）會拖上一兩秒才收完；固定睡眠常常
  // 在「還在往目標滑」的半途取樣，接著觀察窗就把這段動畫當成「卡片被移走」。
  // 停穩的判準＝連續兩次 cur 一模一樣、且 cur 已經等於 target、且沒在拖。
  let settle = null, stable = false, prev = null;
  for (let i = 0; i < 80 && !stable; i++) {
    await sleep(150);
    const pr = await frame.evaluate(probe).catch(() => null);
    if (!pr) { prev = null; continue; }               // 取樣失敗：別跨缺口比，重新開始
    // cur/target 都是整數（分頁卡一個位置一張、停手後 tick 會吸到整數），
    // 收斂判定直接比相等；再要求跟前一次一模一樣才算「動畫真的結束」。
    stable = !pr.dragging && pr.cur === pr.target && prev && prev.cur === pr.cur;
    prev = pr; settle = pr;
  }
  ok(!!settle, 'settle probe succeeded');
  if (!settle) throw new Error('no probe result during settle wait — aborting (see FAIL above)');
  ok(stable, 'stack settled after the wheel burst (animation done, not just a fixed sleep)', settle);
  const userId = settle.frontId;
  ok(settle.frontIdx >= 2, 'user settled deep in the stack (not card 0)', settle);
  ok(userId !== targetTabId, 'user position is NOT the clicked tab anymore',
    { userIdx: settle.frontIdx, userId, targetTabId });

  // ---- 觀察窗：3 秒，期間背景自然補送 + 強制多一份清單推送 + 強制 tab-focus --------
  const observeAt = Date.now();
  const samples = [];
  const sampler = (async () => {
    while (Date.now() - observeAt < 3000) {
      const s = await frame.evaluate(probe).catch(() => null);
      if (s) samples.push({ wallMs: s.t - 0, ...s, at: Date.now() - observeAt });
      await sleep(100);
    }
  })();
  await sleep(500);
  // 強制清單推送：開一個背景分頁（new-tab-at-front 插入路徑），不改前景
  const newTabId = await opt.evaluate(u => new Promise(res =>
    chrome.tabs.create({ url: u, active: false }, t => res(t && t.id))), `${FIX}/p9`);
  ok(Number.isFinite(newTabId), 'forced an extra list push (background tab create p9)', newTabId);
  await sleep(600);
  // 強制 tab-focus：背景 → sidepanel.js focusFrame → 12×500ms postMessage 風暴
  await panelPg.evaluate(id => { try { focusFrame(id); return true; } catch (_) { return false; } }, targetTabId);
  ok(true, 'forced an out-of-band tab-focus for the clicked tab', targetTabId);
  await sampler;

  // ---- 斷言 -------------------------------------------------------------------
  const bad = samples.filter(s => s.frontId !== userId || s.frontIdx === 0);
  ok(bad.length === 0, 'over 3s: focused card never leaves the user position, never card 0',
    { n: samples.length, bad: bad.slice(0, 6) });

  // 事件日誌：使用者接手之後不得再有任何程式定位（tab-focus-jump / boot-focus / setFolder）
  // 只算「真的把位置動了」的：定位事件若 from === to 就是空轉（常見於補送鏈晚到、剛好
  // 打在使用者開始滾的那一兩幀——位置本來就停在目標上，跳了等於沒跳），不該算成被拉走。
  // 收窄成「兩欄都在且相等才忽略」：事件形狀若回歸成沒有 from/to，不能連真正的定位一起吞掉。
  const noop = e => e.ev === 'scrollTarget' && e.from !== undefined && e.to !== undefined && e.from === e.to;
  const evlog = await frame.evaluate(() => window.__ev || []);
  const wheelAt = await frame.evaluate(() => (window.__wheelAt || [0])[0]);
  const progAfter = evlog.filter(e =>
    e.t >= (wheelAt - 20) &&
    (e.ev === 'setFolder' ||
      (e.ev === 'scrollTarget' && ['tab-focus-jump', 'boot-focus'].includes(e.reason) && !noop(e))));
  ok(progAfter.length === 0, 'after the user wheeled: zero programmatic repositioning events',
    { wheelAt, progAfter: progAfter.slice(0, 8) });

  const focusMsgs = evlog.filter(e => e.ev === 'msg:tab-focus');
  ok(focusMsgs.length >= 1, 'tab-focus messages actually arrived (the storm is real)',
    { count: focusMsgs.length, ts: focusMsgs.map(e => e.t) });

  // ---- 報表 ---------------------------------------------------------------------
  console.log('\n---- measurements ----');
  console.log(JSON.stringify({
    clickToIframeLoadMs: frameLoadedAt - clickAt,
    clickToCardsMs: cardsAt - clickAt,
    clickToFocusMs: focusAt ? focusAt - clickAt : null,
    wheelToMoveMs: movedIn,
    targetIdx, targetTabId, userIdx: settle.frontIdx, userId,
    targetIsCard0: focusProbe ? focusProbe.frontIdx === 0 : null
  }));
  console.log('---- event log (frame-relative ms) ----');
  for (const e of evlog) console.log(JSON.stringify(e));
  console.log('---- samples after user settled (every 100ms, 3s) ----');
  for (const s of samples) console.log(JSON.stringify(s));

  await rd.close().catch(() => {});
  await panelPg.close().catch(() => {});
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
