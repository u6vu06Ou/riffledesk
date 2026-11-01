// tests/tabs-ext-e2e.mjs — REAL Chrome + the real unpacked extension/ (no HTTP mock).
// Launches a persistent context with --load-extension, sets the extension's port to
// 5194 via its options page (chrome.storage.local), and waits for the service worker
// to push the real tab list to the server (the generated per-install token pairs
// with the server on first contact); then exercises 'activate' through the
// server. Port 5194 (5190–5199 only). Usage: node tests/tabs-ext-e2e.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const PORT = 5194;
const BASE = `http://127.0.0.1:${PORT}`;
// 擴充在品牌版 Chrome 的 headless 不會載入（實測）；用 playwright 自帶的 Chromium，
// 找不到才退回品牌版（那時這支測試會在「service worker 沒起來」上 FAIL，代表環境不支援）
const PW_CHROMIUM = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe');
const CHROME = fs.existsSync(PW_CHROMIUM) ? PW_CHROMIUM : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-tabs-ext-'));
fs.mkdirSync(path.join(TMP, 'root'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'root', 'readme.md'), '# ext fixture\n');
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [path.join(TMP, 'root')], pinned: [], convoRoots: [] }, null, 2));
const PROFILE = path.join(TMP, 'profile');

// ---------------------------------------------------------------- fixture pages
// 13 個真的本機 http 頁（p1–p13）：p1–p4 帶 og:image（p1 用相對路徑，驗相對→絕對）
// 與 meta description；p12 沒有 <main>／<article>，驗主內容退回 body；
// p13 是 SPA 延遲渲染（2.5 秒後才把內容塞進 <main>），驗「抓到空字串→之後重抓」的補救路徑。
const FIX_PORT = 5198;
const FIX = `http://127.0.0.1:${FIX_PORT}`;
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h, r, g, b) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;   // 8-bit RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))
  ]);
}
const OG_COLORS = { 1: [210, 105, 30], 2: [43, 98, 196], 3: [60, 160, 80], 4: [160, 60, 160] };
function fixturePage(k) {
  const desc = k <= 4 ? `<meta name="description" content="ExtDescMarker-${k} 這是第 ${k} 頁的摘要">` : '';
  const og = k <= 4 ? `<meta property="og:image" content="${k === 1 ? 'og1.png' : '/og' + k + '.png'}">` : '';
  const inner = `<h1>Fixture ${k}</h1><p>ExtBodyMarker-${k} ${'第 ' + k + ' 頁的主內容文字。'.repeat(20)}</p>`;
  // p14：DOM 繪圖驗收頁——色帶＋大標＋綠色塊，「看起來畫對沒有」一眼能判
  if (k === 14) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>ExtFixture 14 DrawMe</title>` +
      `<style>body{margin:0;background:#10233a;color:#fff;font-family:sans-serif}` +
      `.band{height:110px;background:linear-gradient(90deg,#e74c3c,#f1c40f,#2ecc71)}` +
      `h1{font-size:46px;margin:26px}p{font-size:19px;margin:14px 26px;line-height:1.7}` +
      `.chip{background:#2ecc71;color:#04160b;display:inline-block;padding:8px 18px;border-radius:8px;font-weight:700}</style></head>` +
      `<body><div class="band"></div><h1>DrawnFace 繪圖驗收頁</h1>` +
      `<p>ExtDrawMarker-14 這頁刻意不切前景，等背景 DOM 繪圖把卡面畫出來。</p>` +
      `<p><span class="chip">GREEN BLOCK 77</span></p></body></html>`;
  }
  // p13：SPA 晚到 —— 首屏 <main> 全空（連佔位字都沒有），2.5 秒後 JS 才把內容塞進來
  if (k === 13) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>ExtFixture 13</title></head>` +
      `<body><main id="app"></main>` +
      `<script>setTimeout(()=>{ document.getElementById('app').innerHTML = ${JSON.stringify(inner)}; }, 2500);</script>` +
      `</body></html>`;
  }
  const body = k === 12 ? `<div>${inner}</div>` : `<main>${inner}</main>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>ExtFixture ${k}</title>${desc}${og}</head><body>${body}</body></html>`;
}
function startFixtureServer() {
  const srv = http.createServer((req, res) => {
    const m = /^\/p(\d+)$/.exec(req.url || '');
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 14) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fixturePage(Number(m[1])));
    }
    const g = /^\/og(\d)\.png$/.exec(req.url || '');
    if (g && OG_COLORS[g[1]]) {
      const [r, gg, b] = OG_COLORS[g[1]];
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(makePng(400, 210, r, gg, b));
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

async function serverTabs() {
  try {
    const r = await fetch(BASE + '/api/tabs');
    const d = await r.json();
    return d && Array.isArray(d.tabs) ? d : null;
  } catch (_) { return null; }
}

let server = null;
let ctx = null;
let fix = null;

async function main() {
  server = await startServer();
  fix = await startFixtureServer();
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: true,                       // Chrome ≥132: --headless 就是新模式，擴充會跑
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 1280, height: 800 }
  });

  // extension service worker → id → options page (has chrome.* access) to set the port
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  let extId = sw.url().split('/')[2];
  ok(/^[-a-z]{32}$/.test(extId), 'extension service worker is running', sw.url());

  const opt = await ctx.newPage();
  let optPage = opt;        // runtime.reload() 後舊 options 頁會被拆掉，這裡換新的
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.waitForLoadState('domcontentloaded');
  const portSet = await opt.evaluate(p => new Promise(res => {
    chrome.storage.local.set({ port: p }, () => chrome.storage.local.get({ port: 0 }, d => res(d.port === p)));
  }), PORT);
  ok(portSet === true, 'options page set the port to 5194');

  // ---------- background text/meta refill: open ≥10 real local http pages (mostly
  // background tabs — only the last one is focused). The extension's independent
  // refill loop must eventually grab text for ALL of them, not just the first 8.
  for (let k = 1; k <= 13; k++) {
    const p = await ctx.newPage();
    await p.goto(`${FIX}/p${k}`);
  }
  ok(true, 'opened 13 local fixture tabs (p1–p13, background tabs included; p13 renders late)');

  // wait for the real push (the first push went to the default 5177; retry beats in ≤8 s)
  let list = null;
  for (let i = 0; i < 45 && !(list && list.tabs && list.tabs.length); i++) { await sleep(1000); list = await serverTabs(); }
  ok(!!(list && list.tabs.length), 'server received a tab list from the REAL extension',
    list ? { n: list.tabs.length, ext: list.extAlive } : null);
  if (list && list.tabs.length) {
    ok(list.tabs.every(tb => typeof tb.title === 'string' && typeof tb.url === 'string'),
      'pushed tabs carry title/url');
    ok(list.tabs.some(tb => /chrome-extension:\/\//.test(tb.url) || /chrome:/.test(tb.url) || /^https?:/.test(tb.url)),
      'tab urls look real', list.tabs.map(t => t.url).slice(0, 4));
  }

  // activate: ask the server to switch to an inactive tab, then ask the SW who is active
  if (list && list.tabs.length) {
    const inactive = list.tabs.find(t => !t.active) || list.tabs[0];
    const r = await fetch(BASE + '/api/tabs/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ op: 'activate', tabId: inactive.id })
    });
    ok(r.status === 200, 'server queued activate for a real tab', r.status);
    const t0 = Date.now();
    let activeId = null;
    while (Date.now() - t0 < 10000) {
      await sleep(500);
      try {
        const act = await sw.evaluate(() => chrome.tabs.query({ active: true }).then(ts => ts.length ? ts[0].id : null));
        if (act === inactive.id) { activeId = act; break; }
      } catch (_) { /* worker restarted mid-call; keep polling */ }
    }
    ok(activeId === inactive.id, 'extension executed activate (tab switched)', { wanted: inactive.id, got: activeId });
  }

  // ---------- side panel + one-key-return command (real extension, verified in the SW)
  // What CAN be verified: the sidePanel API exists, background.js flipped
  // openPanelOnActionClick on, and the focus-riffledesk command is registered.
  // What CANNOT be verified headless: actually opening the side panel UI, and Chrome
  // accepting the suggested Alt+Shift+R binding (chrome://extensions/shortcuts state is
  // user-gated by design) — those stay manual checks, noted in extension/README.md.
  const feat = await sw.evaluate(async () => {
    const out = { hasSidePanelApi: !!chrome.sidePanel };
    if (out.hasSidePanelApi) {
      try { const b = await chrome.sidePanel.getPanelBehavior(); out.behavior = b && b.openPanelOnActionClick; }
      catch (e) { out.behaviorErr = String(e); }
    }
    const cmds = await chrome.commands.getAll();
    const c = cmds.find(x => x.name === 'focus-riffledesk');
    out.cmdRegistered = !!c;
    out.cmdShortcut = c ? c.shortcut : null;
    const m = await (await fetch(chrome.runtime.getURL('manifest.json'))).json();
    out.sidePanelPath = m.side_panel && m.side_panel.default_path;
    out.suggested = m.commands && m.commands['focus-riffledesk'] && m.commands['focus-riffledesk'].suggested_key;
    out.global = !!(m.commands && m.commands['focus-riffledesk'] && m.commands['focus-riffledesk'].global);
    out.actionTitle = m.action && m.action.default_title;
    return out;
  });
  ok(feat.hasSidePanelApi && feat.behavior === true, 'sidePanel API present; click-to-toggle behavior on', feat);
  ok(feat.sidePanelPath === 'sidepanel.html', 'side_panel.default_path is sidepanel.html', feat.sidePanelPath);
  ok(feat.cmdRegistered, 'focus-riffledesk command registered', { shortcut: feat.cmdShortcut });
  ok(feat.suggested && feat.suggested.default === 'Alt+Shift+R' && feat.global,
     'manifest suggests Alt+Shift+R globally (actual binding is user-gated)', { suggested: feat.suggested, global: feat.global, live: feat.cmdShortcut });
  ok(feat.actionTitle === '開關 RiffleDesk 側邊欄（回到完整視窗：Alt+Shift+R）', 'toolbar icon title documents the shortcut', feat.actionTitle);

  // side panel page ships the server-down instructions and points at ?mode=panel
  const spSrc = await sw.evaluate(async () => {
    const html = await (await fetch(chrome.runtime.getURL('sidepanel.html'))).text();
    const js = await (await fetch(chrome.runtime.getURL('sidepanel.js'))).text();
    return { htmlHasDownUi: html.includes('id="down"') && html.includes('retry'),
             jsFramesPanel: js.includes('?mode=panel'),
             jsRetries: js.includes('manifest.webmanifest') && js.includes('RETRY_DOWN_MS'),
             jsAck: js.includes('open-ack') && js.includes('riffle-panel-open') };
  });
  ok(spSrc.htmlHasDownUi && spSrc.jsFramesPanel && spSrc.jsRetries && spSrc.jsAck,
     'sidepanel.html/js: iframe → ?mode=panel, server-down instructions + retry, message relay', spSrc);

  const status = await opt.evaluate(() => new Promise(res => {
    chrome.runtime.sendMessage({ type: 'riffle-status' }, d => res(d));
  }));
  ok(!!(status && status.port === PORT && status.lastPushOk > 0 && !status.lastError),
    'extension status: port ok, last push ok, no error', status);
  ok(status && Array.isArray(status.grabFails), 'status reply carries the grab-fail debug list',
    status && { grabFails: Array.isArray(status.grabFails) ? status.grabFails.length : null });

  // ---------- helpers for the sections below（走 options 頁，SW 被重啟過也吃得下）----------
  const statsNow = () => optPage.evaluate(() => new Promise(res =>
    chrome.runtime.sendMessage({ type: 'riffle-status' }, r => res(r)))).catch(() => null);
  const activeTabNow = () => optPage.evaluate(() => new Promise(res =>
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, ts => res(ts && ts[0] && ts[0].id)))).catch(() => null);

  // ---------- background refill loop outcome: every fixture tab gets text+meta, og ones get images
  let fx = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const d = await serverTabs();
    const fxTabs = ((d && d.tabs) || []).filter(t => /:5198\/p\d+$/.test(t.url || ''));
    const withText = fxTabs.filter(t => (t.text || '').includes('ExtBodyMarker'));
    const ogTabs = fxTabs.filter(t => /\/p[1-4]$/.test(t.url));
    const ogReady = ogTabs.length === 4 && ogTabs.every(t => t.hasOg && (t.desc || '').includes('ExtDescMarker'));
    if (fxTabs.length >= 10 && withText.length === fxTabs.length && ogReady) {
      fx = { n: fxTabs.length, withText: withText.length, tabs: fxTabs };
      break;
    }
    await sleep(1000);
  }
  ok(!!fx, 'refill loop: ≥10 fixture tabs ALL carry text (not just the first 8)',
    fx ? { tabs: fx.n, withText: fx.withText } : null);
  if (fx) {
    const ogTabs = fx.tabs.filter(t => /\/p[1-4]$/.test(t.url));
    ok(ogTabs.every(t => t.hasOg && (t.desc || '').includes('ExtDescMarker')),
      'p1–p4: og:image (p1 relative) + meta description captured and pushed',
      ogTabs.map(t => ({ url: t.url.split(':5198')[1], hasOg: t.hasOg, desc: (t.desc || '').slice(0, 22) })));
    if (ogTabs.length) {
      const ogR = await fetch(`${BASE}/api/tabs/og?id=${ogTabs[0].id}&v=${ogTabs[0].ogVer}`);
      const ogBuf = ogR.status === 200 ? await ogR.arrayBuffer() : null;
      ok(ogR.status === 200 && ogBuf && ogBuf.byteLength > 500 &&
         (ogR.headers.get('content-type') || '').includes('image/jpeg'),
        'og image downloadable from /api/tabs/og as jpeg', { status: ogR.status, bytes: ogBuf && ogBuf.byteLength });
    }
    const p12 = fx.tabs.find(t => /\/p12$/.test(t.url));
    ok(p12 && (p12.text || '').includes('ExtBodyMarker-12'), 'page without <main> falls back to body text');
    const p13 = fx.tabs.find(t => /\/p13$/.test(t.url));
    ok(p13 && (p13.text || '').includes('ExtBodyMarker-13'),
      'SPA delayed render (2.5s): text backfilled by the wantText retry, not stuck empty',
      p13 && { len: (p13.text || '').length });
  }

  // ---------- idle sweep (A2): inject the idle state with the test hook; every http tab
  // must end up with a screenshot, the original foreground tab/window must be restored,
  // and saying "user is back" mid-sweep must stop it immediately (≤1 shot late).
  if (fx) {
    // options 頁的「閒置時自動補拍截圖」預設開（沒動過設定也是開）
    const idleDefault = await opt.evaluate(() => {
      const el = document.getElementById('idleSweep');
      return el ? el.checked : null;
    });
    ok(idleDefault === true, 'options: 閒置時自動補拍截圖 default ON', idleDefault);

    const orig = await sw.evaluate(async () => {
      const [act] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return { tabId: act && act.id, winId: act && act.windowId };
    });
    const hook = st => opt.evaluate(s => new Promise(res =>
      chrome.runtime.sendMessage({ type: 'riffle-test-idle', state: s }, r => res(r))), st);
    const sweepStatus = () => opt.evaluate(() => new Promise(res =>
      chrome.runtime.sendMessage({ type: 'riffle-status' }, res)));
    const activeTab = async () => {
      try {
        return await sw.evaluate(async () => {
          const [a] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          return a && a.id;
        });
      } catch (_) { return null; }   // worker 可能在重啟；下一輪再問
    };

    const tIdle = Date.now();
    await hook('idle');
    let st0 = null;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      st0 = await sweepStatus();
      // 只掃一兩張時整輪在 500ms 輪詢間隔內就跑完——running 會漏看；
      // 「這次 idle hook 有啟動掃描」改用 running 或「lastAt 落在 hook 之後」判定
      if (st0 && st0.sweep && (st0.sweep.running || st0.sweep.lastAt >= tIdle - 1500)) break;
    }
    ok(st0 && st0.sweep && (st0.sweep.running || st0.sweep.lastAt >= tIdle - 1500),
      'idle hook starts the sweep', st0 && st0.sweep);

    // 使用者回來（hook 說 active）→ 立刻停，前景分頁要還原
    await hook('active');
    let stopped = false, restoredMid = null;
    for (let i = 0; i < 25; i++) {
      await sleep(400);
      const s = await sweepStatus();
      if (s && s.sweep && !s.sweep.running) { stopped = true; restoredMid = await activeTab(); break; }
    }
    ok(stopped, 'active hook aborts the running sweep', stopped);
    ok(restoredMid === orig.tabId, 'abort restores the original foreground tab', { orig: orig.tabId, now: restoredMid });

    // 再次閒置 → 把剩下的補完；整輪結束後每個 http 夾具分頁都要有截圖。
    // 注意：第一段（被中止的）掃描也會寫 lastAt，所以「掃完了」改成用「running 落下來且截圖全到」判斷。
    await hook('idle');
    let sawRunning = false;
    let fin = null, fx2 = [];
    const tSweep = Date.now();
    while (Date.now() - tSweep < 90000) {
      await sleep(1000);
      const s = await sweepStatus();
      if (s && s.sweep) { fin = s.sweep; if (s.sweep.running) { sawRunning = true; continue; } }
      const d2 = await serverTabs();
      fx2 = ((d2 && d2.tabs) || []).filter(t => /:5198\/p\d+$/.test(t.url || ''));
      if (fx2.length >= 13 && fx2.every(t => t.hasShot)) break;
    }
    ok(sawRunning || (fin && fin.lastAt > 0), 'sweep actually ran (idle hook driven)',
      { sawRunning, lastAt: fin && fin.lastAt, lastN: fin && fin.lastN });
    const shots = fx2.filter(t => t.hasShot).length;
    ok(fx2.length >= 13 && shots === fx2.length, 'after the sweep every http fixture tab has a screenshot',
      { shots, tabs: fx2.length,
        missing: fx2.filter(t => !t.hasShot).map(t => t.url),
        trail: fin && fin.trail });
    const restoredEnd = await activeTab();
    ok(restoredEnd === orig.tabId, 'finished sweep restored the original foreground tab',
      { orig: orig.tabId, now: restoredEnd });
    ok(await hook(null) !== undefined, 'release the idle test override');

    // 整趟下來 sw 不該留下任何錯誤（最後狀態也要乾淨）
    const stEnd = await sweepStatus();
    ok(!!(stEnd && !stEnd.lastError), 'extension has no lastError after the whole run',
      stEnd && stEnd.lastError);
  }

  // ================= 新任務驗收區（截圖持久化／DOM 繪圖／點卡開側欄）=================
  // ---------- (b) 背景 DOM 繪圖：p14 用 chrome.tabs.create({active:false}) 開成「從不切前景」
  // 的背景分頁（連「載完隨手拍前景」都吃不到它），擴充該用 html-to-image 直接把卡面畫出來
  // （shotKind 'drawn'），全程 0 次 onActivated、前景分頁不動。
  let drawnTab = null;
  {
    const statsA = await statsNow();
    const fg0 = await activeTabNow();
    const p14id = await optPage.evaluate(u => new Promise(res =>
      chrome.tabs.create({ url: u, active: false }, t => res(t && t.id))), `${FIX}/p14`);
    ok(Number.isFinite(p14id), 'p14 created as a background tab (active:false)', p14id);
    const tDraw = Date.now();
    while (Date.now() - tDraw < 45000 && !drawnTab) {
      await sleep(1000);
      const d = await serverTabs();
      const rows = ((d && d.tabs) || []).filter(t => /:5198\/p14$/.test(t.url || ''));
      if (rows.length && rows[0].hasShot) drawnTab = rows[0];
    }
    ok(!!drawnTab && drawnTab.shotKind === 'drawn',
      'never-foregrounded tab got its card face via DOM drawing (shotKind drawn)',
      drawnTab ? { shotKind: drawnTab.shotKind, shotVer: drawnTab.shotVer } : null);
    const statsB = await statsNow();
    ok(!!(statsA && statsB && statsA.testStats && statsB.testStats &&
        statsB.testStats.activatedEvents === statsA.testStats.activatedEvents),
      'DOM drawing caused zero onActivated events',
      { before: statsA && statsA.testStats && statsA.testStats.activatedEvents,
        after: statsB && statsB.testStats && statsB.testStats.activatedEvents });
    const fg1 = await activeTabNow();
    ok(!!(fg1 != null && fg1 === fg0), 'foreground tab unchanged while DOM drawing', { before: fg0, after: fg1 });
    ok(!!(statsB && statsA && statsB.testStats && statsA.testStats &&
        statsB.testStats.drawn > statsA.testStats.drawn),
      'extension drawn counter advanced',
      { before: statsA && statsA.testStats && statsA.testStats.drawn,
        after: statsB && statsB.testStats && statsB.testStats.drawn });
  }

  // ---------- (a) 截圖持久化：整個瀏覽器重開（擴充 SW 跟著重開；順便重開 server），
  // 同一個 profile 的 IndexedDB 截圖快取要立刻補臉——不重畫（drawn 計數不動）、
  // 不重拍（從不切前景）。註：runtime.reload() 在這支 headless Chromium 會把擴充
  // 永遠拆掉（實測 options 頁再也開不了），所以用「同 profile 關掉再開」這個更強的重啟。
  if (drawnTab) {
    const shot0 = await fetch(`${BASE}/api/tabs/shot?id=${drawnTab.id}&v=${drawnTab.shotVer}`);
    ok(shot0.status === 200, 'drawn shot downloadable before the restart', shot0.status);

    await ctx.close();                 // 整個瀏覽器關掉（SW 消失；profile 目錄留著 IDB/storage）
    ctx = null;
    server.kill();
    await sleep(1500);
    server = await startServer();

    ctx = await chromium.launchPersistentContext(PROFILE, {
      executablePath: CHROME, headless: true,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
      viewport: { width: 1280, height: 800 }
    });
    sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    extId = sw.url().split('/')[2];
    ok(/^[-a-z]{32}$/.test(extId), 'browser+SW restarted on the SAME profile (extension back)', extId);
    optPage = await ctx.newPage();
    await optPage.goto(`chrome-extension://${extId}/options.html`);
    await optPage.waitForLoadState('domcontentloaded');
    ok(true, 'options page re-opened on the new browser (port/token persisted in storage)');

    // 擴充要先回 5194 推過清單，再開 p14 背景分頁——補臉該直接來自 IndexedDB 快取
    const statsA2 = await statsNow();
    const p14b = await optPage.evaluate(u => new Promise(res =>
      chrome.tabs.create({ url: u, active: false }, t => res(t && t.id))), `${FIX}/p14`);
    ok(Number.isFinite(p14b), 'p14 re-created as a background tab after the restart', p14b);

    let back = null;
    const tP = Date.now();
    while (Date.now() - tP < 45000 && !back) {
      await sleep(1000);
      const dd = await serverTabs();
      const rows = ((dd && dd.tabs) || []).filter(t => /:5198\/p14$/.test(t.url || ''));
      if (rows.length && rows[0].hasShot) back = rows[0];
    }
    ok(!!back && back.shotKind === 'drawn',
      'browser+server restart: shot comes back from the IndexedDB cache, kind kept',
      back ? { shotKind: back.shotKind, shotVer: back.shotVer } : null);
    const statsB2 = await statsNow();
    ok(!!(back && statsA2 && statsB2 && statsA2.testStats && statsB2.testStats &&
        statsB2.testStats.drawn === statsA2.testStats.drawn),
      'face came from the cache, not re-drawn (drawn counter did not move)',
      { before: statsA2 && statsA2.testStats && statsA2.testStats.drawn,
        after: statsB2 && statsB2.testStats && statsB2.testStats.drawn });

    // 視覺證據：把那張 DOM 畫出來的卡面存成 PNG（給人看一眼）
    if (back) {
      const shotJ = await fetch(`${BASE}/api/tabs/shot?id=${back.id}&v=${back.shotVer}`);
      if (shotJ.status === 200) {
        const buf = Buffer.from(await shotJ.arrayBuffer());
        const dataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
        const pg = await ctx.newPage();
        await pg.setViewportSize({ width: 660, height: 500 });
        await pg.setContent(`<body style="margin:0;background:#222"><img src="${dataUrl}" style="width:100%">`);
        fs.mkdirSync(path.join(ROOT, 'docs', 'screenshots'), { recursive: true });
        await pg.screenshot({ path: path.join(ROOT, 'docs', 'screenshots', 'tabs-drawn-face.png') });
        await pg.close();
        ok(fs.existsSync(path.join(ROOT, 'docs', 'screenshots', 'tabs-drawn-face.png')),
          'saved docs/screenshots/tabs-drawn-face.png', { jpegBytes: buf.length });
      } else {
        ok(false, 'fetch drawn shot for the screenshot artifact', shotJ.status);
      }
    }
  }

  // ---------- (c) dbg activate → 走 server 指令柱，擴充收到 activate 並把目標分頁切到前景。
  // （設計已改：完整版點卡＝右欄預覽，不再直送擴充、不再同步 sidePanel.open；
  //   只有側欄點卡與這個 dbg 鉤子會啟用分頁。所以這裡驗的是 server 路徑吃得通。）
  {
    const rd = await ctx.newPage();
    await rd.goto(`${BASE}/`);
    await rd.waitForFunction(() => window.__dbg && window.__dbg.ready());
    await rd.evaluate(() => window.__dbg.tabsEnter());
    let readyList = false;
    for (let i = 0; i < 30 && !readyList; i++) {
      await sleep(500);
      readyList = await rd.evaluate(() => {
        const d = window.__dbg.tabs();
        return !!(d.extId && d.viewN > 0);
      }).catch(() => false);
    }
    ok(readyList, 'RiffleDesk page has the tab list AND the extension id (direct path armed)');
    const viewDump = await rd.evaluate(() =>
      window.__dbg.scene().view.map(f => (f.tab ? { id: f.tab.id, active: f.tab.active, url: f.tab.url } : null)));
    const targetIdx = viewDump.findIndex(v => v && !v.active && /:5198\/p\d+$/.test(v.url || ''));
    ok(targetIdx >= 0, 'found a non-foreground fixture card to click', targetIdx);
    const targetTabId = targetIdx >= 0 ? viewDump[targetIdx].id : -1;

    const statsC0 = await statsNow();
    const res = await rd.evaluate(i => window.__dbg.tabs().activate(i), targetIdx);
    ok(!!(res && res.via === 'server' && res.ok === true),
      'activate goes through the server command channel (no direct ext path anymore)', res);

    let statsC = null, actNow = null;
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      statsC = await statsNow();
      actNow = await activeTabNow();
      if (statsC && statsC.testStats && actNow === targetTabId) break;
    }
    ok(!!(statsC && statsC.testStats && statsC0 && statsC0.testStats &&
        statsC.testStats.extClicks === statsC0.testStats.extClicks &&
        statsC.testStats.panelOpenCalls === statsC0.testStats.panelOpenCalls),
      'extension counters: NO direct click and NO sidePanel.open (full version no longer auto-opens the panel)',
      { before: statsC0 && statsC0.testStats, after: statsC && statsC.testStats });
    ok(actNow === targetTabId, 'the clicked tab became the active tab', { wanted: targetTabId, got: actNow });
    await rd.close().catch(() => {});
  }

  // ---------- (d) 「側欄模式」鈕趁手勢直送擴充：同一訊息開側欄＋切分頁。
  // sidePanel.open 在 headless 不一定開得出 UI，但 background.js 的計數器
  // （panelOpenCalls）與 tabs.update 一定會動；那兩個就是可觀測的驗收點。
  // 還原路徑：riffle-back-to-full 要把既有的 RiffleDesk 完整版分頁帶到前景。
  {
    const rd = await ctx.newPage();
    await rd.goto(`${BASE}/`);
    await rd.waitForFunction(() => window.__dbg && window.__dbg.ready());
    await rd.evaluate(() => window.__dbg.tabsEnter());
    let readyList = false;
    for (let i = 0; i < 30 && !readyList; i++) {
      await sleep(500);
      readyList = await rd.evaluate(() => {
        const d = window.__dbg.tabs();
        return !!(d.extId && d.viewN > 0);
      }).catch(() => false);
    }
    ok(readyList, '(d) RiffleDesk page armed with the extension id');
    const viewDump = await rd.evaluate(() =>
      window.__dbg.scene().view.map(f => (f.tab ? { id: f.tab.id, active: f.tab.active, url: f.tab.url } : null)));
    // (a) 的整台瀏覽器重開把 p1–p13 收掉了，只剩重開後補建的 p14 → 找「任何 5198 夾具卡」，
    //     優先挑不是前景的那張（沒有就退回 p14 本身）
    let targetIdx = viewDump.findIndex(v => v && !v.active && /:5198\/p\d+$/.test(v.url || ''));
    if (targetIdx < 0) targetIdx = viewDump.findIndex(v => v && /:5198\/p\d+$/.test(v.url || ''));
    ok(targetIdx >= 0, '(d) found a fixture card for the side-panel switch',
      { idx: targetIdx, urls: viewDump.filter(Boolean).map(v => v.url) });
    const targetTabId = targetIdx >= 0 ? viewDump[targetIdx].id : -1;

    // 右欄預覽 → 列上要有第四顆「側欄模式」鈕；工具列 ◫ 等 meta 報 alive 後要現身
    const prevOk = targetIdx >= 0 && await rd.evaluate(i => window.__dbg.tabsPreview(i), targetIdx);
    ok(prevOk === true, '(d) tab preview opened via dbg hook');
    await rd.waitForFunction(() => window.__dbg.panel().shown, null, { timeout: 5000 }).catch(() => {});
    const hasSideBtn = await rd.evaluate(() => {
      const b = document.querySelector('#readerBody .tabact.sidepanel');
      return b ? (b.textContent || '').trim() : null;
    });
    ok(!!hasSideBtn, '(d) preview action bar has the side-panel button', hasSideBtn);
    let toolbarVisible = false;
    for (let i = 0; i < 16 && !toolbarVisible; i++) {
      await sleep(500);
      toolbarVisible = await rd.evaluate(() => {
        const b = document.getElementById('btnSidePanel');
        return !!(b && !b.hidden);
      }).catch(() => false);
    }
    ok(toolbarVisible, '(d) toolbar ◫ button appears once the extension reports alive');

    const statsD0 = await statsNow();
    const r1 = targetIdx >= 0 && await rd.evaluate(i => window.__dbg.tabs().sidePanel(i), targetIdx);
    ok(!!(r1 && r1.ok === true && (r1.panel === 'opened' || r1.panel === 'already' || r1.panel === 'failed')),
      '(d) enterSidePanel reached the extension (panel may be refused headless)', r1);
    let statsD = null, actD = null;
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      statsD = await statsNow();
      actD = await activeTabNow();
      if (statsD && statsD.testStats && statsD0 && statsD0.testStats &&
          statsD.testStats.extClicks > statsD0.testStats.extClicks &&
          statsD.testStats.panelOpenCalls > statsD0.testStats.panelOpenCalls) break;
    }
    ok(!!(statsD && statsD0 && statsD.testStats.extClicks > statsD0.testStats.extClicks &&
        statsD.testStats.panelOpenCalls > statsD0.testStats.panelOpenCalls),
      '(d) extension got the click: extClicks++ AND sidePanel.open attempted (panelOpenCalls++)',
      { before: statsD0 && statsD0.testStats, after: statsD && statsD.testStats });
    ok(actD === targetTabId, '(d) Chrome switched to the previewed tab', { wanted: targetTabId, got: actD });

    // 工具列鈕（右欄還在預覽 p2 → 應帶同一個 tabId；不要求再開一次面板，僅要求訊息到達）
    if (toolbarVisible) {
      const statsE0 = await statsNow();
      await rd.evaluate(() => document.getElementById('btnSidePanel').click());
      let statsE = null;
      for (let i = 0; i < 15; i++) {
        await sleep(400);
        statsE = await statsNow();
        if (statsE && statsE0 && statsE.testStats.extClicks > statsE0.testStats.extClicks) break;
      }
      ok(!!(statsE && statsE0 && statsE.testStats.extClicks > statsE0.testStats.extClicks),
        '(d) toolbar ◫ click also reaches the extension (direct message, gesture preserved)',
        { before: statsE0 && statsE0.testStats, after: statsE && statsE.testStats });
    }

    // 還原：riffle-back-to-full → 既有 RiffleDesk 分頁帶到前景（rd 是此時唯一符合的）
    const statsF0 = await statsNow();
    await rd.evaluate(() => window.__dbg.tabs().backToFull());
    let backOk = false, statsF = null;
    const rdTabs = await optPage.evaluate(b => new Promise(res =>
      chrome.tabs.query({}, ts => res(ts.filter(t => typeof t.url === 'string' && t.url.startsWith(b)).map(t => t.id)))), BASE + '/');
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      statsF = await statsNow();
      const act = await activeTabNow();
      if (rdTabs.includes(act) && statsF && statsF0 && statsF.testStats.backToFull > statsF0.testStats.backToFull) { backOk = true; break; }
    }
    ok(backOk, '(d) back-to-full: extension counter bumped AND a full RiffleDesk tab got focused',
      { rdTabs, before: statsF0 && statsF0.testStats, after: statsF && statsF.testStats });
    await rd.close().catch(() => {});
  }
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
