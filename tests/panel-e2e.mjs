// tests/panel-e2e.mjs — acceptance for the side-panel quick-flip mode (?mode=panel) plus the
// PWA installability plumbing (manifest/icons/service-worker) and the framing policy.
// Port 5195 (tests stay in 5190–5199; 5177 is the user's live instance).
// Drives headless Chrome sized like a Chrome side panel (400px wide), simulates the
// tabs extension from Node like tabs-e2e.mjs does, and writes
// docs/screenshots/panel-mode.png. Usage: node tests/panel-e2e.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5195;
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
// A plain folder root (fallback view) + one fake Claude transcript that pretends it just
// wrote handoff.md (so "AI recently handed me: today" is non-empty and the panel boots
// into it by default).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-panel-'));
const RD = p => path.join(TMP, ...p.split('/'));
const handoffPath = RD('root/handoff.md');
fs.mkdirSync(RD('root'), { recursive: true });
fs.mkdirSync(RD('convos'), { recursive: true });
fs.writeFileSync(handoffPath, '# handoff\n新鮮出爐的交接文件，側邊欄一開就該看到它。\n');
fs.writeFileSync(RD('root/readme.md'), '# panel fixture\n只是讓根目錄不為空\n');
const nowIso = new Date().toISOString();
fs.writeFileSync(RD('convos/fake.jsonl'), [
  JSON.stringify({ type: 'user', sessionId: 's1', cwd: RD('root'), timestamp: nowIso, message: { content: '幫我寫交接文件' } }),
  JSON.stringify({ type: 'assistant', sessionId: 's1', cwd: RD('root'), timestamp: nowIso, message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: handoffPath } }] } })
].join('\n') + '\n');
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [RD('root')], pinned: [], convoRoots: [RD('convos')] }, null, 2));

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

// ---- simulated extension (same shape as tabs-e2e.mjs) ----
const EXT_TOKEN = 'e'.repeat(48);
const EXT_HEADERS = { 'X-RiffleDesk-Ext': '1', 'X-RiffleDesk-Token': EXT_TOKEN };  // no Origin, like a service worker
const extLog = { cmds: [] };
let extAbort = null;
function extCmdLoopStart() {
  extAbort = new AbortController();
  (async () => {
    for (;;) {
      try {
        const r = await fetch(BASE + '/api/tabs/cmd?wait=2000', { headers: EXT_HEADERS, signal: extAbort.signal });
        const d = await r.json();
        if (d && d.cmd) {
          extLog.cmds.push(d.cmd);
          // 「複製給 AI」會即時要一次內容（op:'read'）：假裝擴充回一份固定假文
          if (d.cmd.op === 'read') {
            const tb = TABS.find(x => x.id === d.cmd.tabId) || TABS[0];
            await fetch(BASE + '/api/tabs/result', {
              method: 'POST', headers: { ...EXT_HEADERS, 'content-type': 'application/json' },
              body: JSON.stringify({ ok: true, reqId: d.cmd.reqId, title: tb.title, url: tb.url,
                text: '面板測試分頁的假內文 panel fake body text', textTruncated: false,
                html: '<main><article><p>fake dom body</p></article></main>', htmlTruncated: false })
            }).catch(() => {});
          }
        }
      } catch (_) {
        if (extAbort.signal.aborted) return;
        await sleep(150);
      }
      if (extAbort.signal.aborted) return;
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
const TABS = [
  { id: 201, windowId: 1, title: '面板測試分頁 Panel Test', url: 'https://panel.example/one', fav: '', active: true, lastAccessed: Date.now() },
  { id: 202, windowId: 1, title: 'Second Panel Tab', url: 'https://panel.example/two', fav: '', active: false, lastAccessed: Date.now() - 60000 }
];
async function pushTabs(tabs) {
  const r = await fetch(BASE + '/api/tabs', {
    method: 'POST', headers: { ...EXT_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ tabs })
  });
  return r.status;
}

let server = null;
let browser = null;
const pageErrors = [];

async function main() {
  server = await startServer();
  // ---------- server-side headers / PWA plumbing (pure HTTP, no browser needed)
  const mR = await fetch(BASE + '/manifest.webmanifest');
  const mCt = mR.headers.get('content-type') || '';
  const mJson = await mR.json();
  ok(mR.status === 200 && mCt.includes('application/manifest+json'), 'manifest.webmanifest served with the right MIME', mCt);
  ok(mJson.name && mJson.short_name && mJson.display === 'standalone' &&
     Array.isArray(mJson.icons) && mJson.icons.some(i => i.sizes === '192x192') && mJson.icons.some(i => i.sizes === '512x512'),
     'manifest has name/short_name/standalone/icons', { name: mJson.name, short: mJson.short_name });
  const i192 = await fetch(BASE + '/icons/icon-192.png');
  const i512 = await fetch(BASE + '/icons/icon-512.png');
  ok(i192.status === 200 && (i192.headers.get('content-type') || '').startsWith('image/png'), 'icon-192.png fetchable as image/png');
  ok(i512.status === 200, 'icon-512.png fetchable');
  const swR = await fetch(BASE + '/sw.js');
  ok(swR.status === 200 && (swR.headers.get('content-type') || '').includes('javascript'), 'sw.js served as JavaScript', swR.headers.get('content-type'));
  const root = await fetch(BASE + '/');
  const csp = root.headers.get('content-security-policy') || '';
  const xfo = root.headers.get('x-frame-options');
  ok(csp.includes("frame-ancestors 'self' chrome-extension://* moz-extension://*"),
     'CSP frame-ancestors allows self + chrome/moz extensions only', csp);
  ok(!xfo, 'no X-Frame-Options header (any value would break the side panel)', xfo);

  // ---------- browser: 400px wide, like a Chrome side panel
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 400, height: 700 } });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(BASE + '/?mode=panel');
  await page.waitForFunction(() => window.__dbg && window.__dbg.ready());
  await page.waitForFunction(() => window.__dbg.scene().files.length > 0, null, { timeout: 8000 });

  // ---------- 1. layout at 400px: two toolbar rows — search row on top, 類型 dropdown +
  // 檔案|分頁 segment below; no overlap, nothing truncated past the panel edge.
  const layout = await page.evaluate(() => {
    const vis = el => !!el && getComputedStyle(el).display !== 'none';
    const r = id => { const e2 = document.getElementById(id); return e2 && e2.getBoundingClientRect(); };
    const box = x => x ? { l: +x.left.toFixed(1), t: +x.top.toFixed(1), r: +x.right.toFixed(1), b: +x.bottom.toFixed(1) } : null;
    const modeSeg = document.getElementById('modeSeg');
    return {
      panelClass: document.body.classList.contains('panel-mode'),
      panelMode: window.__dbg.panelMode(),
      tree: vis(document.getElementById('tree')), reader: vis(document.getElementById('reader')),
      settings: vis(document.getElementById('settings')), splitter: vis(document.getElementById('splitter')),
      viewBar: vis(document.getElementById('viewBar')),
      search: box(r('searchBox')), chipSel: box(r('chipSel')), chips: vis(document.getElementById('chips')),
      sortSel: vis(document.getElementById('sortSel')),
      seg: modeSeg && box(modeSeg.getBoundingClientRect()),
      btnModeFiles: box(r('btnModeFiles')), btnTabs: box(r('btnTabs')),
      b2f: box(r('btnBackToFull')), b2fVis: vis(document.getElementById('btnBackToFull')),
      toolbarH: (r('toolbar') || { bottom: 0 }).bottom,
      glTop: +getComputedStyle(document.getElementById('gl')).top.replace('px', ''),
      viewW: window.__dbg.viewRect().w, innerW: innerWidth,
      tabsActive: window.__dbg.tabs().active,
      docScrollW: document.documentElement.scrollWidth
    };
  });
  ok(layout.panelClass && layout.panelMode, '?mode=panel engaged (body class + __dbg)', layout);
  ok(!layout.tree && !layout.reader && !layout.settings && !layout.splitter,
     'panel hides the folder tree, reader, settings and splitters', layout);
  ok(layout.search && layout.chipSel && layout.seg && layout.btnModeFiles && layout.btnTabs,
     'B: search box, 類型 dropdown and the 檔案|分頁 segment are all rendered', layout);
  ok(layout.chips === false && layout.sortSel === false, 'B: raw chips row and sort select are out of the panel toolbar',
     { chips: layout.chips, sortSel: layout.sortSel });
  ok(layout.search && layout.search.l <= 9 && layout.search.r >= layout.innerW - 9,
     'B: search box spans the full first row', layout.search);
  ok(layout.toolbarH === 82 && layout.glTop === 82, 'B: toolbar is the two-row 82px and the canvas starts under it',
     { toolbarH: layout.toolbarH, glTop: layout.glTop });
  if (layout.search && layout.chipSel && layout.seg) {
    ok(layout.chipSel.t >= layout.search.b - 1 && layout.seg.t >= layout.search.b - 1,
       'B: dropdown and segment sit on the second row, below the search box',
       { searchB: layout.search.b, selT: layout.chipSel.t, segT: layout.seg.t });
    ok(Math.abs(layout.chipSel.t - layout.seg.t) < 4, 'B: dropdown and segment share one row, no wrap',
       { selT: layout.chipSel.t, segT: layout.seg.t });
    ok(layout.chipSel.r <= layout.seg.l + 1 && layout.seg.r <= layout.innerW + 1,
       'B: no overlap between dropdown and segment, nothing past the right edge',
       { selR: layout.chipSel.r, segL: layout.seg.l, segR: layout.seg.r, w: layout.innerW });
    ok(layout.btnModeFiles && layout.btnTabs && layout.btnTabs.l >= layout.btnModeFiles.r - 1,
       'B: 檔案|分頁 segment has both halves side by side', { f: layout.btnModeFiles, t: layout.btnTabs });
  }
  ok(layout.docScrollW <= layout.innerW, 'B: no horizontal page scroll at 400px',
     { scrollW: layout.docScrollW, w: layout.innerW });
  ok(Math.abs(layout.viewW - layout.innerW) < 8, 'card stack takes the full narrow width', { viewW: layout.viewW, innerW: layout.innerW });
  ok(!layout.tabsActive, 'panel defaults to files, not tabs mode', layout);

  // ---------- 1b. 回到完整畫面 button lives on the second toolbar row (panel only)
  const b2f = await page.evaluate(() => {
    const b = document.getElementById('btnBackToFull');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { title: b.title, label: b.getAttribute('aria-label'), text: b.textContent.trim(),
             visible: getComputedStyle(b).display !== 'none',
             l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1) };
  });
  ok(b2f && b2f.visible && b2f.title.includes('Alt+Shift+R') && b2f.label === '回到完整畫面' &&
     /回到完整畫面/.test(b2f.title),
    'panel toolbar: 回到完整畫面 button shows and its title names Alt+Shift+R', b2f);
  if (b2f && layout.seg && layout.search) {
    ok(Math.abs(b2f.t - layout.seg.t) < 4 && b2f.t >= layout.search.b - 1,
       '回到完整畫面 shares the second toolbar row with the mode segment', { b2f, seg: layout.seg });
    ok(b2f.l >= layout.seg.r - 1 && b2f.r <= layout.innerW + 1,
       '回到完整畫面 sits right of the segment, past nothing over the edge', { b2f, segR: layout.seg.r, w: layout.innerW });
  }

  // ---------- 2. default content is "AI recently handed me: today"
  const names = await page.evaluate(() => window.__dbg.fileNames());
  ok(names.includes('handoff.md'), 'panel boots into recent AI handoffs (handoff.md present)', names);

  // ---------- 3. screenshot for the docs (someone must actually look at it)
  await page.evaluate(() => window.__dbg.setTheme('dark'));
  await sleep(600);   // let card thumbs paint
  // 窄欄取景：焦點卡幾乎填滿欄寬（左右各留 ~12px），卡內字在 400px 下才讀得到
  const cardFit = await page.evaluate(() => {
    const b = window.__dbg.cardBounds(0);
    const v = window.__dbg.viewRect();
    return b ? { cardW: Math.round(b.w), viewW: Math.round(v.w), ratio: +(b.w / v.w).toFixed(3) } : null;
  });
  ok(cardFit && cardFit.ratio >= 0.85, 'panel: front card nearly fills the narrow column (≥85% of width)', cardFit);
  await page.screenshot({ path: path.join(SHOTS, 'panel-mode.png') });

  // ---------- 4. tab cards: click sends activate, the page itself never moves
  extCmdLoopStart();
  const pushR = await fetch(BASE + '/api/tabs', {
    method: 'POST', headers: { ...EXT_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ tabs: TABS })
  });
  ok(pushR.status === 200, 'extension push accepted', pushR.status);
  await page.click('#btnTabs');
  await page.waitForFunction(() => window.__dbg.tabs().active && window.__dbg.tabs().tabs === 2, null, { timeout: 8000 });
  await page.evaluate(() => { const s = window.__dbg.scene(); s._jumpTo = 0; s.poke(); });
  await page.waitForFunction(() => Math.round(window.__dbg.scene().scrollCur) === 0, null, { timeout: 8000 });
  await sleep(300);   // damping/settle before the click (tabs-e2e does the same)
  // most recently used tab = 201 is the front card; click dead center on it
  const cardPos = await page.evaluate(() => {
    const st = window.__dbg.scene();
    const slot = (st.slots || []).find(s => s.file && s.file.tab && s.file.tab.id === 201);
    return slot ? window.__dbg.cardScreen(slot.fileIdx) : null;
  });
  ok(cardPos && cardPos.x != null, 'front tab card has screen coordinates', cardPos);
  const urlBefore = page.url();
  await page.mouse.click(cardPos.x, cardPos.y);
  const act = await extWaitCmd('activate');
  ok(act && act.tabId === 201, 'clicking a tab card sends activate to the extension', act && { tabId: act.tabId });
  ok(page.url() === urlBefore, 'panel page did not navigate away', { before: urlBefore, after: page.url() });
  ok(await page.evaluate(() => window.__dbg.tabs().active), 'tabs mode still on after the click');

  // ---------- 4b. C/E in the panel: tabs mode drops the 類型 dropdown (nothing usable left
  // beside the segment), and Alt+1/Alt+2 are the same switch as the segment buttons.
  const panelC = await page.evaluate(() => ({
    chipSel: getComputedStyle(document.getElementById('chipSel')).display,
    filesOn: document.getElementById('btnModeFiles').classList.contains('on'),
    tabsOn: document.getElementById('btnTabs').classList.contains('on'),
    segVisible: getComputedStyle(document.getElementById('modeSeg')).display !== 'none'
  }));
  ok(panelC.chipSel === 'none' && !panelC.filesOn && panelC.tabsOn && panelC.segVisible,
     'C(panel): tabs mode removes the type dropdown; segment shows 分頁 active', panelC);
  await page.keyboard.press('Alt+1');
  await page.waitForFunction(() => !window.__dbg.tabs().active, null, { timeout: 5000 });
  const backC = await page.evaluate(() => ({
    chipSel: getComputedStyle(document.getElementById('chipSel')).display,
    filesOn: document.getElementById('btnModeFiles').classList.contains('on')
  }));
  ok(backC.chipSel !== 'none' && backC.filesOn, 'C/E(panel): Alt+1 back to files, dropdown visible again', backC);
  await page.keyboard.press('Alt+2');
  await page.waitForFunction(() => window.__dbg.tabs().active, null, { timeout: 5000 });
  ok(true, 'E(panel): Alt+2 enters tabs mode again');

  // ---------- 4c. × close works in the side panel too: card 202 leaves the stack,
  // front card 201 does not jump, no stray tab activation, toast offers 復原.
  {
    await page.waitForFunction(() => window.__dbg.tabs().viewN === 2 &&
      window.__dbg.scene().view[1] && window.__dbg.scene().view[1].tab &&
      window.__dbg.scene().view[1].tab.id === 202, null, { timeout: 10000 });
    await page.evaluate(() => { const s = window.__dbg.scene(); s._jumpTo = 0; s.poke(); });
    await page.waitForFunction(() => Math.round(window.__dbg.scene().scrollCur) === 0, null, { timeout: 8000 });
    // E(panel)：× 畫在卡面貼圖裡，不 hover 也每張都有；點第二張（202）× 的投影座標＝關掉它
    await page.mouse.move(8, 600);
    const panelXs = await page.evaluate(() => window.__dbg.tabBadges('x').length);
    ok(panelXs >= 2, 'panel close: every visible tab card reports a × without any hover', panelXs);
    const closePos = await page.evaluate(() => window.__dbg.tabZone(1, 'x'));
    ok(closePos && typeof closePos.x === 'number',
      'panel close: the × of the second card (tab 202) projects to screen coordinates', closePos);
    extLog.cmds.length = 0;
    await page.mouse.click(closePos.x, closePos.y);
    const closeCmd = await extWaitCmd('close');
    ok(closeCmd && closeCmd.tabId === 202, 'panel close: close op reaches the extension with tabId 202', closeCmd);
    ok(!extLog.cmds.some(c => c.op === 'activate'),
      'panel close: the × click did not trigger a tab activation', extLog.cmds);
    await page.waitForFunction(() => window.__dbg.tabs().viewN === 1, null, { timeout: 8000 });
    const after = await page.evaluate(() => ({
      viewN: window.__dbg.tabs().viewN,
      scroll: Math.round(window.__dbg.scene().scrollCur),
      frontId: window.__dbg.scene().view[0] && window.__dbg.scene().view[0].tab && window.__dbg.scene().view[0].tab.id,
      lastClose: window.__dbg.tabs().lastClose
    }));
    ok(after.viewN === 1 && after.frontId === 201 && after.scroll === 0,
      'panel close: card 202 gone, front card 201 unmoved', after);
    const toastState = await page.evaluate(() => {
      const el = document.getElementById('toast');
      const a = el.querySelector('a');
      return { on: el.classList.contains('on'), text: el.textContent, link: a ? a.textContent : '' };
    });
    ok(toastState.on && /已關閉/.test(toastState.text) && toastState.link === '復原',
      'panel close: toast shows 已關閉 · 復原', toastState);
    extLog.cmds.length = 0;
    await page.click('#toast a');
    const restoreCmd = await extWaitCmd('restore');
    ok(restoreCmd !== null, 'panel restore: restore op reaches the extension', restoreCmd);
    ok((await pushTabs(TABS)) === 200, 'panel restore: extension re-pushes the full list');
    await page.waitForFunction(() => window.__dbg.tabs().viewN === 2, null, { timeout: 10000 });
    const back = await page.evaluate(() => {
      const v = window.__dbg.scene().view;
      return { viewN: v.length, endId: v[v.length - 1] && v[v.length - 1].tab && v[v.length - 1].tab.id };
    });
    ok(back.viewN === 2 && back.endId === 202, 'panel restore: card 202 is back at the tail', back);
  }

  // ---------- 5. B: file card click reads INSIDE the panel (full-width overlay), ← 返回 / Esc
  await page.click('#btnTabs');   // 4c left us in tabs mode — back to the file stack
  await page.waitForFunction(() => !window.__dbg.tabs().active, null, { timeout: 5000 });
  await page.waitForFunction(() => window.__dbg.scene().view.some(f => f.name === 'handoff.md'), null, { timeout: 8000 });
  const front0 = await page.evaluate(() => Math.round(window.__dbg.scene().scrollCur));
  ok(await page.evaluate(() => !window.__dbg.panel().open), 'B: no reader overlay before the click');
  ok(await page.evaluate(() => window.__dbg.openFileByName('handoff.md')), 'B: handoff.md card found for clicking');
  await page.waitForFunction(() => window.__dbg.panel().open && window.__dbg.panel().file === 'handoff.md', null, { timeout: 8000 });
  const rd = await page.evaluate(() => {
    const el = document.getElementById('reader');
    const r = el.getBoundingClientRect();
    const back = document.getElementById('btnPanelBack');
    const br = back.getBoundingClientRect();
    return { shown: el.classList.contains('show'),
      full: r.top <= 1 && r.left <= 1 && Math.abs(r.width - innerWidth) < 2 && Math.abs(r.bottom - innerHeight) < 2,
      backVisible: getComputedStyle(back).display !== 'none' && br.width > 0 && br.top >= 0 && br.bottom <= r.top + 60,
      backText: back.textContent.trim() };
  });
  ok(rd.shown && rd.full, 'B: reader overlay covers the whole panel', rd);
  ok(rd.backVisible && rd.backText.includes('返回'), 'B: ← 返回 button sits at the top of the overlay', rd);
  await page.waitForFunction(() => document.getElementById('readerBody').textContent.includes('新鮮出爐'), null, { timeout: 8000 })
    .catch(() => {});
  ok(await page.evaluate(() => document.getElementById('readerBody').textContent.includes('新鮮出爐')),
     'B: file content rendered inside the panel');
  ok(await page.evaluate(() => Math.round(window.__dbg.scene().scrollCur)) === front0,
     'B: opening the overlay did not move the stack front index', front0);
  await page.screenshot({ path: path.join(SHOTS, 'panel-file-reader.png') });
  await page.click('#btnPanelBack');
  await page.waitForFunction(() => !window.__dbg.panel().open, null, { timeout: 5000 });
  ok(await page.evaluate(() => Math.round(window.__dbg.scene().scrollCur)) === front0,
     'B: ← 返回 closes the overlay; the stack front index is unchanged', front0);
  // Esc closes it the same way
  await page.evaluate(() => window.__dbg.openFileByName('handoff.md'));
  await page.waitForFunction(() => window.__dbg.panel().open, null, { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__dbg.panel().open, null, { timeout: 5000 });
  ok(true, 'B: Esc also closes the overlay');

  // ---------- 5b. ⧉ 複製給 AI on the panel's tab cards (× has a left neighbor; full window has none)
  await page.click('#btnTabs');   // 201/202 are still pushed since 4c — back to tabs mode
  await page.waitForFunction(() => window.__dbg.tabs().active && window.__dbg.tabs().viewN === 2, null, { timeout: 8000 });
  await page.evaluate(() => { const s = window.__dbg.scene(); s._jumpTo = 0; s.poke(); });
  await page.waitForFunction(() => Math.round(window.__dbg.scene().scrollCur) === 0, null, { timeout: 8000 });
  await sleep(400);   // settle before projecting zones
  const zones = await page.evaluate(() => ({
    ai: window.__dbg.tabZone(0, 'ai'), x: window.__dbg.tabZone(0, 'x'),
    hit: window.__dbg.badgeZone(0.868, 0.93), hitX: window.__dbg.badgeZone(0.95, 0.93),
    miss: window.__dbg.badgeZone(0.5, 0.5)
  }));
  ok(zones.ai && zones.x && zones.ai.x < zones.x.x && Math.abs(zones.ai.y - zones.x.y) < 24,
     '⧉ projects to the left of × on the same header row', zones);
  ok(zones.hit === 'ai' && zones.hitX === 'x' && zones.miss === null,
     'uv hit-testing knows ⧉ (panel only)', { hit: zones.hit, hitX: zones.hitX, miss: zones.miss });
  await page.screenshot({ path: path.join(SHOTS, 'panel-card-copy.png') });
  await page.evaluate(() => {
    window.__copiedAI = [];
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: tx => { window.__copiedAI.push(String(tx)); return Promise.resolve(); }
      } });
    } catch (e) { window.__clipStubErr = String(e); }
  });
  const cmdBase = extLog.cmds.length;
  await page.mouse.click(zones.ai.x, zones.ai.y);
  await page.waitForFunction(() => (window.__copiedAI || []).length > 0, null, { timeout: 8000 });
  const copied = await page.evaluate(() => window.__copiedAI[0] || '');
  ok(copied.includes('Panel Test') && copied.includes('panel.example/one') && copied.includes('面板測試分頁的假內文'),
     '⧉ click copies the AI payload (title + url + fresh body)', { len: copied.length });
  const cpToast = await page.evaluate(() => {
    const el = document.getElementById('toast');
    return { on: el.classList.contains('on'), text: el.textContent };
  });
  ok(cpToast.on && /已複製（約 \d+ token）/.test(cpToast.text), 'toast says 已複製（約 N token）', cpToast);
  const newOps = extLog.cmds.slice(cmdBase).map(c => c.op);
  ok(!newOps.includes('activate') && !newOps.includes('close') && newOps.includes('read'),
     '⧉ copies without switching or closing the tab', newOps);
  ok(await page.evaluate(() => !window.__dbg.panel().open), '⧉ did not open the reader overlay');

  // full window: no ⧉ zone at all (the right-column preview has the button instead)
  const fullAi = await ctx.newPage();
  fullAi.on('pageerror', e => pageErrors.push('full2: ' + e));
  await fullAi.goto(BASE + '/');
  await fullAi.waitForFunction(() => window.__dbg && window.__dbg.ready());
  const fullZones = await fullAi.evaluate(() => ({
    ai: window.__dbg.badgeZone(0.868, 0.93), x: window.__dbg.badgeZone(0.95, 0.93)
  }));
  ok(fullZones.ai === null && fullZones.x === 'x', 'full window has no ⧉ hit zone, × stays', fullZones);
  await fullAi.close();

  // ---------- 5c. D: Ctrl+wheel — canvas = camera zoom, chrome = UI zoom, Ctrl+0 resets
  await page.click('#btnTabs');   // back to files for a clean zoom pass
  await page.waitForFunction(() => !window.__dbg.tabs().active, null, { timeout: 5000 });
  const z0 = await page.evaluate(() => window.__dbg.uiZoom());
  ok(z0 === 1, 'D: panel UI zoom starts at 1');
  await page.mouse.move(200, 20);   // over the toolbar (above the canvas)
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await sleep(300);
  const z1 = await page.evaluate(() => window.__dbg.uiZoom());
  ok(z1 > 1.05 && z1 <= 1.6, 'D: Ctrl+wheel over the toolbar zooms the UI in', z0 + ' → ' + z1);
  const chromeZoom = await page.evaluate(() => ({
    tb: +getComputedStyle(document.getElementById('toolbar')).zoom || 1,
    glTop: document.getElementById('gl').getBoundingClientRect().top,
    stored: localStorage.getItem('rd.panelZoom')
  }));
  ok(Math.abs(chromeZoom.tb - z1) < 0.01 && Math.abs(chromeZoom.glTop - 82 * z1) < 2 &&
     parseFloat(chromeZoom.stored) === z1,
     'D: toolbar zooms, canvas top follows (82×z), zoom persists to localStorage', chromeZoom);
  const cam0 = await page.evaluate(() => window.__dbg.camera().orbit.zoom);
  await page.mouse.move(200, 420);   // over the card-stack canvas
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await sleep(400);
  const afterZoom = await page.evaluate(() => ({
    cam: window.__dbg.camera().orbit.zoom,
    z: window.__dbg.uiZoom()
  }));
  ok(Math.abs(afterZoom.cam - cam0) > 0.01 && afterZoom.z === z1,
     'D: Ctrl+wheel on the canvas moves the camera; UI zoom untouched', { cam0, ...afterZoom });
  await page.keyboard.down('Control');
  await page.keyboard.press('0');
  await page.keyboard.up('Control');
  ok(await page.evaluate(() => window.__dbg.uiZoom()) === 1, 'D: Ctrl+0 restores 100%');

  // ---------- 6. panel-open lag fence: 21 tabs with real screenshots, 560×900 ----------
  // Ticket targets: first wheel moves a card within 300ms of open; no long task >100ms
  // in the first 3s after the tab cards land. Long tasks are recorded from navigation.
  const shotJpg = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1280; c.height = 800;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1280, 800);
    g.addColorStop(0, '#28457a'); g.addColorStop(0.5, '#7a4528'); g.addColorStop(1, '#287a57');
    x.fillStyle = g; x.fillRect(0, 0, 1280, 800);
    for (let i = 0; i < 40; i++) {
      x.fillStyle = `hsl(${i * 23 % 360} 45% ${30 + (i % 5) * 10}%)`;
      x.fillRect(0, i * 20, 1280, 12);
    }
    x.fillStyle = '#f2f2f2'; x.font = '28px sans-serif';
    for (let i = 0; i < 20; i++) x.fillText('RiffleDesk 分頁測試行 tab perf line ' + i, 40, 40 + i * 37);
    return c.toDataURL('image/jpeg', 0.82);
  });
  ok(typeof shotJpg === 'string' && shotJpg.length > 50000, 'realistic 1280x800 jpeg shot made', { kb: Math.round(shotJpg.length / 1024) });
  const BASE_T = Date.now();
  const mkTab = (id, i, over) => ({
    id, windowId: 1,
    title: '效能測試分頁 Perf Tab ' + (i + 1) + '　有些標題會長一點讓省略號迴圈有活幹',
    url: 'https://perf' + i + '.example.com/some/page?i=' + i,
    fav: '', active: i === 0, lastAccessed: BASE_T - i * 60000, shot: shotJpg, ...(over || {})
  });
  const T21 = Array.from({ length: 21 }, (_, i) => mkTab(700 + i, i));
  ok(await pushTabs(T21) === 200, '21 shot tabs pushed');

  const ctx2 = await browser.newContext({ viewport: { width: 560, height: 900 } });
  const page2 = await ctx2.newPage();
  page2.on('console', m => { if (m.type() === 'error') consoleErrors.push('page2: ' + m.text()); });
  page2.on('pageerror', e => pageErrors.push('page2: ' + e));
  await page2.addInitScript(() => {
    window.__lt = [];
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) window.__lt.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
      }).observe({ entryTypes: ['longtask'] });
    } catch (_) { window.__ltUnsupported = true; }
  });
  await page2.goto(BASE + '/?mode=panel&tabs=1');   // the real side-panel entry URL when clicking a card
  // 注意：不能等 __dbg.ready()——進分頁模式會 clearCurrent() 清掉 lockedFolder，
  // ready（定義＝有鎖定資料夾）在 tabs 開局永遠是 false。「開啟完成」＝分頁卡落地。
  await page2.waitForFunction(() => window.__dbg && window.__dbg.tabs().active && window.__dbg.scene().view.length === 21, null, { timeout: 15000 });
  const perf = await page2.evaluate(async () => {
    const st = window.__dbg.scene();
    const t0 = performance.now();           // cards just landed — this is "panel opened"
    const cv = document.getElementById('gl');
    cv.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }));
    let firstMoveMs = null;
    for (let i = 0; i < 400; i++) {
      await new Promise(r => setTimeout(r, 15));
      if (Math.abs(st.scrollCur) > 0.003) { firstMoveMs = Math.round(performance.now() - t0); break; }
    }
    await new Promise(r => setTimeout(r, 3000));
    const win = (window.__lt || []).filter(e => e.start >= t0 - 200 && e.start <= t0 + 3000);
    return { firstMoveMs, longtasks: win, all: window.__lt, unsupported: !!window.__ltUnsupported };
  });
  console.log('perf numbers:', JSON.stringify(perf));
  ok(!perf.unsupported, 'longtask observer supported');
  ok(perf.firstMoveMs != null && perf.firstMoveMs <= 300, 'first wheel response ≤300ms after open', { firstMoveMs: perf.firstMoveMs });
  ok(!perf.longtasks.some(e => e.dur > 100), 'no long task >100ms in the first 3s after open', perf.longtasks);

  // ---------- 7. order freeze: clicking a tab must not reshuffle the stack ----------
  await page2.evaluate(() => { const s = window.__dbg.scene(); s._jumpTo = 4; s.poke(); });
  await page2.waitForFunction(() => Math.round(window.__dbg.scene().scrollCur) === 4, null, { timeout: 8000 });
  await sleep(400);   // let the flip settle before snapshotting
  const snap0 = await page2.evaluate(() => ({
    ids: window.__dbg.scene().view.map(f => f.tab.id),
    front: Math.round(window.__dbg.scene().scrollCur)
  }));
  ok(snap0.ids.length === 21 && snap0.front === 4 && snap0.ids[4] === 704, 'frozen-order baseline: 5th card is tab 704', snap0);

  // extension re-push after the click: 704 becomes active with the newest lastAccessed
  ok(await pushTabs(T21.map(tb => tb.id === 704
    ? { ...tb, active: true, lastAccessed: Date.now() }
    : { ...tb, active: false })) === 200, 'post-click push accepted');
  await page2.waitForFunction(() => {
    const v = window.__dbg.scene().view;
    return v.length === 21 && v[4].tab.id === 704 && v[4].tab.active === true;
  }, null, { timeout: 8000 });
  const snap1 = await page2.evaluate(() => ({
    ids: window.__dbg.scene().view.map(f => f.tab.id),
    front: Math.round(window.__dbg.scene().scrollCur)
  }));
  ok(JSON.stringify(snap1.ids) === JSON.stringify(snap0.ids) && snap1.front === 4,
     'lastAccessed/active churn keeps card order and the front index', snap1);

  // a brand-new tab lands at the front; every existing card keeps its relative order
  ok(await pushTabs([mkTab(799, 99, { active: false, lastAccessed: Date.now() }), ...T21.map(tb =>
    ({ ...tb, active: tb.id === 704 }))]) === 200, 'new-tab push accepted');
  await page2.waitForFunction(() => window.__dbg.scene().view.length === 22, null, { timeout: 8000 });
  await sleep(300);
  const snap2 = await page2.evaluate(() => ({
    ids: window.__dbg.scene().view.map(f => f.tab.id),
    front: Math.round(window.__dbg.scene().scrollCur),
    frontId: window.__dbg.scene().view[Math.round(window.__dbg.scene().scrollCur)].tab.id
  }));
  const rest2 = snap2.ids.slice(1);
  ok(snap2.ids[0] === 799 && JSON.stringify(rest2) === JSON.stringify(snap0.ids) && snap2.frontId === 704,
     'new tab inserted at front, existing order intact, front card still 704', snap2);

  // closing a tab removes it without the front card jumping
  ok(await pushTabs(snap2.ids.filter(id => id !== 702).map((id, i) => {
    const src = id === 799 ? mkTab(799, 99) : T21.find(tb => tb.id === id);
    return { ...src, active: id === 704, lastAccessed: Date.now() - i * 30000 };
  })) === 200, 'close-tab push accepted');
  await page2.waitForFunction(() => {
    const v = window.__dbg.scene().view;
    return v.length === 21 && !v.some(f => f.tab.id === 702);
  }, null, { timeout: 8000 });
  await sleep(300);
  const snap3 = await page2.evaluate(() => ({
    ids: window.__dbg.scene().view.map(f => f.tab.id),
    front: Math.round(window.__dbg.scene().scrollCur),
    frontId: window.__dbg.scene().view[Math.round(window.__dbg.scene().scrollCur)].tab.id
  }));
  const expect3 = snap2.ids.filter(id => id !== 702);
  ok(JSON.stringify(snap3.ids) === JSON.stringify(expect3) && snap3.frontId === 704,
     'closing a tab removes it; neighbors and the front card do not jump', snap3);

  // 搜尋只是顯示層：收窄再放寬，凍結卡序一張都不能動（否則清掉搜尋字＝整疊亂跳）
  await page2.evaluate(() => {
    const sb = document.getElementById('searchBox');
    sb.value = 'perf tab 1';
    sb.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page2.waitForFunction(() => {
    const v = window.__dbg.scene().view;
    return v.length > 0 && v.length < 21 && v.every(f => f.tab);
  }, null, { timeout: 8000 });
  const snap4 = await page2.evaluate(() => window.__dbg.scene().view.map(f => f.tab.id));
  const relOk = JSON.stringify(snap3.ids.filter(id => snap4.includes(id))) === JSON.stringify(snap4);
  ok(relOk && snap4.every(id => snap3.ids.includes(id)),
     'narrowed by search, the view keeps the frozen relative order', snap4);
  await page2.evaluate(() => {
    const sb = document.getElementById('searchBox');
    sb.value = '';
    sb.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page2.waitForFunction(() => window.__dbg.scene().view.length === 21, null, { timeout: 8000 });
  const snap5 = await page2.evaluate(() => window.__dbg.scene().view.map(f => f.tab.id));
  ok(JSON.stringify(snap5) === JSON.stringify(snap3.ids),
     'clearing the search restores the exact frozen order', { before: snap3.ids.slice(0, 6), after: snap5.slice(0, 6) });
  await ctx2.close();

  // ---------- console hygiene
  const realErrors = consoleErrors.filter(x =>
    !x.includes('ERR_INTERNET_DISCONNECTED') && !x.includes('favicon'));
  ok(realErrors.length === 0 && pageErrors.length === 0, 'no console/page errors', realErrors.concat(pageErrors).slice(0, 5));
}

main().then(async () => {
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall panel checks passed');
}).catch(e => {
  console.error('FATAL', e);
  failed++;
}).finally(async () => {
  try { if (extAbort) extAbort.abort(); } catch (_) {}
  try { if (browser) await browser.close(); } catch (_) {}
  try { if (server) server.kill(); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed ? 1 : 0);
});
