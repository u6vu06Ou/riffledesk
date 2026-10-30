// tests/browsers-e2e.mjs — 三瀏覽器相容（Chromium / Firefox / WebKit）＋沒有 WebGL 的說明卡驗收
//
// A. 每家瀏覽器跑同一條核心流程：
//    首頁零 console error → 展開樹 → 卡堆出現、滾輪捲動 → 點卡開閱讀面板（md 有渲染）
//    → 檔名搜尋 → 全文搜尋 → 編輯 Ctrl+S 存檔 → 關閉閱讀回到兩欄
// B. 沒有 3D 的三種情況（只用 Chromium）：
//    B1. --disable-webgl：WebGL 建不起來
//    B2. 擋掉 three.js CDN：3D 引擎載入失敗
//    B3. 跑到一半用 WEBGL_lose_context 弄掉 context（顯卡驅動重置）
//    B1／B2 都要：中間欄出現說明卡（含 get.webgl.org 連結）、沒有 page error／console error
//    （瀏覽器自己報的三點載入失敗除外）、點左欄樹的資料夾仍列得出檔案、
//    點清單裡的檔案仍能在閱讀欄讀。B1 順便截 docs/screenshots/no-webgl.png
//    B3 要：說明卡只蓋卡片欄（左欄沒被蓋）、有重新載入按鈕、檔案照樣開得起來。
//
// 瀏覽器沒裝 → 先 npx playwright-core install（進使用者快取）；真的裝不了那家記 SKIP，不假裝過。
//
// 自帶暫存夾具＋臨時 config，起 5192 起的空埠，跑完關掉。不碰 repo 的 config.json/index.db。
// 用法：node tests/browsers-e2e.mjs   （或 npm run test:browsers）
import { chromium, firefox, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const N_CARDS = 12;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failed = 0, skipped = 0;
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}
function skip(tag, why) { console.log('SKIP ' + tag + ' — ' + why); skipped++; }

async function freePort(start) {
  const { createServer } = await import('node:net');
  for (let p = start; p < start + 8; p++) {
    const free = await new Promise(res => {
      const s = createServer();
      s.once('error', () => res(false));
      s.once('listening', () => s.close(() => res(true)));
      s.listen(p, '127.0.0.1');
    });
    if (free) return p;
  }
  throw new Error('no free port');
}

// ------------------------------------------------------------ 夾具
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-browsers-'));
const ROOTDIR = path.join(TMP, 'root');
const CARDS = path.join(ROOTDIR, 'cards');
const SCRATCH = path.join(CARDS, 'scratch.md');
const SCRATCH_ORIG = '# scratch\n\noriginal line\n';

function buildFixtures() {
  const base = Date.now() - 1000 * 1000;
  fs.mkdirSync(path.join(CARDS, 'sub'), { recursive: true });
  for (let i = 1; i <= N_CARDS; i++) {
    const f = path.join(CARDS, `card-${String(i).padStart(2, '0')}.md`);
    const tok = i === 3 ? '\n\nUNIQTOKEN42 hidden body token\n' : '';
    fs.writeFileSync(f, `# card ${i}\n\nbody ${i}\n${tok}`);
    const tt = new Date(base + i * 3000);
    fs.utimesSync(f, tt, tt);   // mtime 全不同：預設排序是新的在前
  }
  fs.writeFileSync(path.join(CARDS, 'zebra-note.md'), '# zebra\n\nunique name for filter test\n');
  fs.writeFileSync(SCRATCH, SCRATCH_ORIG);
  fs.writeFileSync(path.join(CARDS, 'sub', 'inner-1.md'), '# inner 1\n');
  fs.writeFileSync(path.join(CARDS, 'sub', 'inner-2.md'), '# inner 2\n');
  fs.writeFileSync(path.join(TMP, 'config.json'),
    JSON.stringify({ roots: [ROOTDIR], pinned: [] }));
}

function startServer(port) {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), FLODER_CONFIG: path.join(TMP, 'config.json') },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let out = '';
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server timeout: ' + out)), 20000);
    srv.stdout.on('data', d => { out += d; if (out.includes('listening')) { clearTimeout(to); res(srv); } });
    srv.stderr.on('data', d => { out += d; });
  });
}

// ------------------------------------------------------------ 頁面小幫手
function watchConsole(page, { allowRe } = {}) {
  const errors = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const txt = m.text();
    if (/favicon/.test(txt)) return;
    // WebKit 把「跳轉時取消在途中的同源 /api fetch」直接當 console error 印
    // （"… /api/recent … due to access control checks"）；同源 API 沒有真 CORS 問題，這類一律不算錯
    if (/\/api\//.test(txt) && /access control|Load request cancelled|NS_BINDING_ABORTED/i.test(txt)) return;
    if (allowRe && allowRe.test(txt)) return;
    errors.push(txt);
  });
  page.on('pageerror', e => {
    const txt = String(e && e.message || e);
    // 同上：跳轉把在途中的 fetch 取消，app 端沒 catch 的 promise 變 unhandled rejection（屬跳轉噪音）
    if (/\/api\//.test(txt) && /access control|Load request cancelled|NS_BINDING_ABORTED|abort|cancelled/i.test(txt)) return;
    if (allowRe && allowRe.test(txt)) return;
    errors.push(txt);
  });
  page.on('requestfailed', r => {
    const u = r.url();
    if (u.endsWith('/favicon.ico')) return;
    // /api/events 是長掛的 SSE，頁面跳轉／關閉時本來就會被截斷，三家錯誤文都不同
    // （Chromium net::ERR_ABORTED、Firefox NS_ERROR_ABORT、WebKit "Load request cancelled"），不算錯
    if (u.includes('/api/events')) return;
    // 同理：跳轉那一瞬間還在途中的縮圖 fetch（/api/file?…&head=8192）被瀏覽器取消，也不算錯
    if (/[?&]head=\d+/.test(u) && /abort|cancelled/i.test((r.failure() || {}).errorText || '')) return;
    // 同理：?open= 測試中途 page.goto 換網址，舊頁面在途中的 /api/* fetch 全部被判 abort
    // （Firefox NS_BINDING_ABORTED、WebKit "Load request cancelled"/"access control checks"）
    if (u.includes('/api/') && /abort|cancelled|access control/i.test((r.failure() || {}).errorText || '')) return;
    if (allowRe && allowRe.test(u)) return;
    errors.push('requestfailed: ' + u + ' ' + (r.failure() || {}).errorText);
  });
  return errors;
}

async function newCtxPage(browser) {
  // viewport 要在 newContext 給：playwright firefox 的 page.setViewportSize 會整個掛住（無回應）
  const ctx = await browser.newContext({ viewport: { width: 1365, height: 860 } });
  // 第一次使用的提示卡會疊在卡堆正中間把點擊吃掉 → 預設標記已看過
  await ctx.addInitScript(() => { try { localStorage.setItem('riffleTipSeen', '1'); } catch (_) {} });
  const page = await ctx.newPage();
  return { ctx, page };
}

async function boot(page, base, { urlSuffix = '' } = {}) {
  await page.goto(base + '/' + urlSuffix, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__dbg, null, { timeout: 20000 });
}

async function lockCards(page) {
  await page.evaluate(p => __dbg.lockFolder(p), CARDS);
  await page.waitForFunction(() => window.__dbg && __dbg.ready() && __dbg.stack().files > 0, null, { timeout: 15000 });
}

const isNo3d = page => page.evaluate(() => !!__dbg.stack().no3d);

// 點卡（3D）：照抄 e2e.mjs 的可靠法——深堆後卡中心常被前卡蓋住，
// 要在 bounding box 裡掃出一個 pick 真的命中目標的像素，hover 波沉澱後再點下去。
async function cardAimPoint(page, idx) {
  return page.evaluate(i => {
    const c = __dbg.cardScreen(i);
    if (!c || c.mode !== 'home') return null;
    const b = __dbg.cardBounds(i);
    if (!b) return { x: c.x, y: c.y };
    const probe = (x, y) => { const p = __dbg.pickAt(x, y); return p && p.fileIdx === i; };
    if (probe(c.x, c.y)) return { x: c.x, y: c.y };
    for (let fy = 0.04; fy <= 0.96; fy += 0.07) {
      for (let fx = 0.5; fx <= 0.9; fx += 0.2) {
        const x = b.minX + b.w * fx, y = b.minY + b.h * fy;
        if (probe(x, y)) return { x, y };
        const xl = b.minX + b.w * (1 - fx);
        if (probe(xl, y)) return { x: xl, y };
      }
    }
    return null;
  }, idx);
}
async function realClickCard(page) {
  const idx = 0;   // 捲回頂後最前面的焦點卡
  for (let round = 0; round < 3; round++) {
    const v = await page.evaluate(() => __dbg.viewRect());
    await page.mouse.move(v.x + v.w - 30, v.y + 40, { steps: 6 });
    await sleep(700);                            // 中性空白沉澱：hover 波歸零
    let pt = await cardAimPoint(page, idx);
    if (!pt) continue;
    for (let aim = 0; aim < 4; aim++) {
      await page.mouse.move(pt.x, pt.y, { steps: 8 });
      await sleep(700);                          // 抽高/推開動畫沉澱
      const npt = await cardAimPoint(page, idx);
      if (npt) pt = npt;
      const pick = await page.evaluate(p => __dbg.pickAt(p.x, p.y), pt);
      if (pick && pick.fileIdx === idx) break;
    }
    const pick = await page.evaluate(p => __dbg.pickAt(p.x, p.y), pt);
    if (!pick || pick.fileIdx !== idx) continue;
    await page.mouse.down();
    await sleep(70);
    await page.mouse.up();
    const shown = await page.waitForFunction(
      () => __dbg.stack().extracted != null && __dbg.panel().shown === true, null, { timeout: 6000 })
      .then(() => true, () => false);
    if (shown) return true;
  }
  return false;
}

// ------------------------------------------------------------ 核心流程（3D 或平面都跑同一套）
async function coreFlow(page, base, tag, { allowRe = null } = {}) {
  const errors = watchConsole(page, { allowRe });
  await boot(page, base);

  // 1) 展開樹：root → cards 出現，cards 下的 sub 子資料夾也展得開
  await page.evaluate(p => __dbg.expandTreeNode(p), ROOTDIR);
  await sleep(300);
  await page.evaluate(p => __dbg.expandTreeNode(p), CARDS);
  await sleep(300);
  const rows = (await page.evaluate(() => __dbg.treeRows())).map(x => String(x).toLowerCase());
  ok(rows.some(r => r.replace(/\\/g, '/').endsWith('/cards/sub')), `${tag} tree expand`);

  // 2) 鎖定資料夾 → 卡片出現
  await lockCards(page);
  const st0 = await page.evaluate(() => __dbg.stack());
  ok(st0.files >= N_CARDS, `${tag} stack files`, { files: st0.files });

  // 3) 滾輪捲動：scrollCur 真的動了
  const s0 = st0.scroll;
  const box = await page.evaluate(() => { const v = __dbg.viewRect(); return { x: v.x + v.w / 2, y: v.y + 200 }; });
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel(0, 500);
  await sleep(500);
  await page.mouse.wheel(0, 500);
  await sleep(700);
  const s1 = await page.evaluate(() => __dbg.stack().scroll);
  ok(s1 > s0 + 0.1, `${tag} wheel scroll`, { before: s0, after: s1 });

  // 4) 點卡 → 閱讀面板開、md 有渲染
  // 滾回頂不能用 wheel：卡堆滾動有阻尼，大 delta 要等好幾秒才沉澱。直接 _jumpTo（scrub 跳轉走的同一條路）
  await page.evaluate(() => { const s = __dbg.scene(); s._jumpTo = 0; s.poke(); });
  await page.waitForFunction(() => __dbg.stack().scroll < 0.6, null, { timeout: 8000 });
  await sleep(800);
  const clicked = await realClickCard(page);
  ok(clicked, `${tag} real card click`);
  if (clicked) {
    await page.waitForFunction(() => __dbg.panel().shown === true, null, { timeout: 6000 });
    await page.waitForFunction(() => !!document.querySelector('#readerBody h1'), null, { timeout: 6000 });
    ok(true, `${tag} reader opens + md renders`);
  } else {
    ok(false, `${tag} reader opens + md renders`, 'skipped: click failed');
  }

  // 5) API 路徑也驗一次（AI/CLI 走的 onCardClick）
  await page.evaluate(() => __dbg.openFileByName('zebra-note.md'));
  await sleep(400);
  const panelFile = await page.evaluate(() => __dbg.panel().file);
  ok(panelFile === 'zebra-note.md', `${tag} openFileByName`, { panelFile });

  // 6) 檔名搜尋：zebra → 1 張；清空 → 回 13 張
  await page.fill('#searchBox', 'zebra');
  await page.waitForFunction(() => __dbg.stack().files === 1, null, { timeout: 6000 });
  ok(true, `${tag} name filter → 1`);
  await page.fill('#searchBox', '');
  await page.waitForFunction(n => __dbg.stack().files >= n, N_CARDS, { timeout: 8000 });
  ok(true, `${tag} name filter cleared`);

  // 7) 全文搜尋：Enter → 🔍 資料夾只有含 token 的那一張；Esc 還原
  await page.fill('#searchBox', 'UNIQTOKEN42');
  await page.press('#searchBox', 'Enter');
  await page.waitForFunction(() => __dbg.stack().folder.startsWith('🔍') && __dbg.stack().files === 1,
    null, { timeout: 10000 });
  ok(true, `${tag} content search → 1`);
  await page.press('#searchBox', 'Escape');
  await page.waitForFunction(n => !__dbg.stack().folder.startsWith('🔍') && __dbg.stack().files >= n,
    N_CARDS, { timeout: 8000 });
  ok(true, `${tag} search restored`);

  // 8) 編輯＋Ctrl+S 存檔（驗到磁碟）
  await page.evaluate(() => __dbg.openFileByName('scratch.md'));
  await page.waitForFunction(() => __dbg.panel().shown === true && __dbg.panel().file === 'scratch.md', null, { timeout: 6000 });
  await page.click('#btnEdit');
  await page.waitForSelector('#readerBody .ev-editor', { timeout: 6000 });
  // WebKit 的 CodeJar 聚焦會慢半拍：typed 文字偶爾整串丟失。打完先驗編輯器內容，
  // 沒進去就重點重打一次（有界重試，不掩蓋真 bug——兩次都丟才 FAIL）
  const WANT = '# scratch\n\nEDITED-LINE cross-browser\n';
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.click('#readerBody .ev-editor');
    await page.keyboard.press('Control+a');
    await page.keyboard.type(WANT);
    const got = await page.evaluate(() => document.querySelector('#readerBody .ev-editor').textContent);
    if (got.includes('EDITED-LINE cross-browser')) break;
  }
  page.on('response', async r => {   // 存檔失敗時把伺服器回的原因印出來，別只剩一句超時
    if (!/\/api\/save/.test(r.url()) || r.status() === 200) return;
    console.log('# SAVE res', r.status(), (await r.text().catch(() => '')).slice(0, 160));
  });
  await page.keyboard.press('Control+s');
  let saved = '';
  for (let i = 0; i < 25; i++) {          // Node 這邊輪詢磁碟（存檔是非同步 fetch POST）
    await sleep(200);
    saved = fs.readFileSync(SCRATCH, 'utf8');
    if (saved.includes('EDITED-LINE cross-browser')) break;
  }
  // Playwright WebKit（Windows port）的 POST 回應偶爾慢到 5–13 秒才落地（隔離測試證明
  // 連線本身正常；真 Safari 沒這問題）：第一段 5 秒沒看到就再寬限 10 秒
  if (!saved.includes('EDITED-LINE cross-browser')) {
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      saved = fs.readFileSync(SCRATCH, 'utf8');
      if (saved.includes('EDITED-LINE cross-browser')) break;
    }
  }
  ok(saved.includes('EDITED-LINE cross-browser'), `${tag} edit+save`,
    saved.includes('EDITED-LINE cross-browser') ? undefined : {
      editorText: (await page.evaluate(() => (document.querySelector('#readerBody .ev-editor') || {}).textContent || '')).slice(0, 70),
      conflictDlg: await page.evaluate(() => !!document.querySelector('#editConflict.on')),
      panel: await page.evaluate(() => __dbg.panel())
    });
  fs.writeFileSync(SCRATCH, SCRATCH_ORIG);   // 復原夾具

  // 9) 關閉閱讀 → 回到兩欄
  await page.click('#btnClose');
  await page.waitForFunction(() => __dbg.panel().open === false, null, { timeout: 6000 });
  ok(true, `${tag} close reader → twocol`);

  // 10) 全程零 console error
  ok(errors.length === 0, `${tag} zero console errors`, errors.slice(0, 4));
}

// ------------------------------------------------------------ 沒有 3D 的說明卡
// 兩種情況都要：說明卡看得見（含 get.webgl.org 連結）、點樹仍列得出檔案、
// 點清單裡的檔案仍讀得到、全程沒有 page error／console error（瀏覽器自己的載入失敗除外）。
async function no3dCase(browser, base, tag, { shot = false } = {}) {
  const errors = [];
  const { ctx, page } = await newCtxPage(browser);
  try {
    watchConsoleInto(page, errors, /WebGL context could not be created|Error creating WebGL context|GroupMarkerNotSet|SwiftShader|three\.module\.js|ERR_FAILED|Failed to fetch|dynamically import/i);
    await boot(page, base);
    await page.waitForSelector('#noview .ncard', { timeout: 15000 });
    ok(await isNo3d(page), `${tag} is no-3d`);
    const card = await page.evaluate(() => {
      const el = document.querySelector('#noview .ncard');
      const r = el.getBoundingClientRect();
      const a = el.querySelector('a.nlink');
      return {
        visible: r.width > 200 && r.height > 100 && getComputedStyle(el).display !== 'none',
        title: el.querySelector('h2').textContent,
        fixes: [...el.querySelectorAll('.nfix li')].map(x => x.textContent).length,
        link: a && a.href,
        glHidden: getComputedStyle(document.getElementById('gl')).display === 'none',
        bodyCls: document.body.classList.contains('no3d-mode')
      };
    });
    ok(card.visible, `${tag} notice visible`, card);
    ok(card.fixes === 3, `${tag} notice lists causes/fixes`, { fixes: card.fixes });
    ok(/get\.webgl\.org/.test(card.link || ''), `${tag} webgl help link`, { link: card.link });
    ok(card.glHidden && card.bodyCls, `${tag} canvas hidden`, { glHidden: card.glHidden, bodyCls: card.bodyCls });

    // 樹照常展得開、鎖資料夾列得出檔案，點下去讀得到
    await page.evaluate(p => __dbg.expandTreeNode(p), ROOTDIR);
    await sleep(200);
    await lockCards(page);
    const rows = await page.locator('#noview .nrow').count();
    ok(rows >= N_CARDS, `${tag} list rows`, { rows });
    await page.locator('#noview .nrow', { hasText: 'zebra-note.md' }).click();
    const opened = await page.waitForFunction(
      () => __dbg.panel().shown === true && __dbg.panel().file === 'zebra-note.md',
      null, { timeout: 10000 }).then(() => true, () => false);
    ok(opened, `${tag} row click opens reader`);
    ok(await page.waitForFunction(() => !!document.querySelector('#readerBody h1'), null, { timeout: 6000 })
      .then(() => true, () => false), `${tag} reader renders md`);

    // 沒有 3D 也編輯得起來（README 說「樹、搜尋、閱讀仍可用」），存檔真的落到磁碟
    await page.evaluate(() => __dbg.openFileByName('scratch.md'));
    await page.waitForFunction(() => __dbg.panel().file === 'scratch.md', null, { timeout: 6000 });
    await page.click('#btnEdit');
    const WANT = '# scratch\n\nEDITED-NO3D\n';
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.click('#readerBody .ev-editor');
      await page.keyboard.press('Control+a');
      await page.keyboard.type(WANT);
      if ((await page.evaluate(() => document.querySelector('#readerBody .ev-editor').textContent))
        .includes('EDITED-NO3D')) break;
    }
    await page.keyboard.press('Control+s');
    let saved = '';
    for (let i = 0; i < 25; i++) {
      await sleep(200);
      saved = fs.readFileSync(SCRATCH, 'utf8');
      if (saved.includes('EDITED-NO3D')) break;
    }
    ok(saved.includes('EDITED-NO3D'), `${tag} editing + save still work`);
    fs.writeFileSync(SCRATCH, SCRATCH_ORIG);
    await page.evaluate(() => __dbg.closeReader());

    if (shot) {
      await page.evaluate(() => { __dbg.closeReader(); document.getElementById('toast').classList.remove('on'); });
      await sleep(2500);   // 等縮圖排程畫完一批
      await page.screenshot({ path: path.join(ROOT, 'docs', 'screenshots', 'no-webgl.png') });
      console.log('# screenshot → docs/screenshots/no-webgl.png');
    }
    ok(errors.length === 0, `${tag} zero console errors`, errors.slice(0, 4));
  } finally { await ctx.close(); }
}
// B3. 3D 跑到一半失去 WebGL context（顯卡驅動重置）：說明卡蓋在卡片欄，樹和閱讀區照用。
// 真的把 context 弄掉（WEBGL_lose_context），不是假裝。
async function contextLostCase(browser, base, tag) {
  const errors = [];
  const { ctx, page } = await newCtxPage(browser);
  try {
    watchConsoleInto(page, errors, /WebGL context could not be created|Error creating WebGL context|GroupMarkerNotSet|SwiftShader|three\.module\.js|ERR_FAILED|Failed to fetch|dynamically import|CONTEXT_LOST_WEBGL/i);
    await boot(page, base);
    await page.waitForFunction(() => window.__dbg && __dbg.stack && !__dbg.stack().no3d, null, { timeout: 15000 });
    await page.evaluate(() => document.getElementById('hint').classList.remove('on'));
    const lost = await page.evaluate(() => {
      const c = document.getElementById('gl');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_lose_context');
      if (!ext) return false;
      ext.loseContext();
      return true;
    });
    ok(lost, `${tag} context can be lost here`);
    await page.waitForSelector('#glnotice .ncard', { timeout: 8000 });
    const shown = await page.evaluate(() => {
      const o = document.getElementById('glnotice');
      const r = o.getBoundingClientRect();
      const card = o.querySelector('.ncard').getBoundingClientRect();
      return {
        visible: r.height > 100 && getComputedStyle(o).display !== 'none',
        inCardColumn: r.left > 100 && r.width < innerWidth,   // 只蓋卡片欄，沒蓋掉左欄
        title: o.querySelector('h2').textContent,
        reload: !!o.querySelector('.nreload'),
        cardInside: card.height > 100
      };
    });
    ok(shown.visible && shown.cardInside, `${tag} notice covers the card column`, shown);
    ok(shown.inCardColumn, `${tag} notice leaves the tree column alone`, { left: shown.inCardColumn });
    ok(shown.reload, `${tag} offers a reload button`);

    // 樹照常列檔案、閱讀區讀得到（3D 沒了不影響）。這一格沒有 #noview 清單，
    // 所以是用樹／openFileByName 開檔，不是點列。
    await page.evaluate(p => __dbg.expandTreeNode(p), ROOTDIR);
    await sleep(200);
    await lockCards(page);
    await page.evaluate(() => __dbg.openFileByName('zebra-note.md'));
    ok(await page.waitForFunction(() => __dbg.panel().shown === true && __dbg.panel().file === 'zebra-note.md',
      null, { timeout: 10000 }).then(() => true, () => false), `${tag} still opens files in the reader`);
    ok(errors.length === 0, `${tag} zero console errors`, errors.slice(0, 4));
  } finally { await ctx.close(); }
}

function watchConsoleInto(page, errors, allowRe) {
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const txt = m.text();
    if (/favicon/.test(txt) || allowRe.test(txt)) return;
    errors.push(txt);
  });
  page.on('pageerror', e => {
    const txt = String(e && e.message || e);
    if (allowRe.test(txt)) return;
    errors.push(txt);
  });
  page.on('requestfailed', r => {
    const u = r.url();
    if (u.endsWith('/favicon.ico') || u.includes('/api/events')) return;
    if (allowRe.test(u) || allowRe.test((r.failure() || {}).errorText || '')) return;
    errors.push('requestfailed: ' + u + ' ' + (r.failure() || {}).errorText);
  });
}

// ------------------------------------------------------------ 主流程
async function tryLaunch(kind, opts = {}) {
  const eng = { chromium, firefox, webkit }[kind];
  if (kind === 'chromium' && fs.existsSync(CHROME)) {
    try { return await eng.launch({ executablePath: CHROME, headless: true, timeout: 60000, ...opts }); } catch (e) { console.log('# system chrome failed, falling back to bundled chromium:', String(e && e.message || e).split('\n')[0]); }
  }
  console.log('# launching ' + kind + ' …');
  const b = await eng.launch({ headless: true, timeout: 60000, ...opts });
  console.log('# ' + kind + ' launched');
  return b;
}

async function main() {
  // 分段跑（看門狗建議：每段 3 分鐘內）：node tests/browsers-e2e.mjs [chromium|firefox|webkit|no3d|all]
  const ONLY = (process.argv[2] || 'all').toLowerCase();
  buildFixtures();
  const PORT = await freePort(5192);
  const base = `http://127.0.0.1:${PORT}`;
  const srv = await startServer(PORT);
  console.log('# server on ' + base + '  fixtures: ' + TMP + '  segment: ' + ONLY);
  try {
    // A. 三家瀏覽器核心流程（能 3D 就 3D；WebGL 起不來 app 自動轉平面，也接受）
    for (const kind of ['chromium', 'firefox', 'webkit'].filter(k => ONLY === 'all' || ONLY === k)) {
      let browser;
      try { browser = await tryLaunch(kind); }
      catch (err) {
        skip(`${kind} core flow`, 'browser launch failed: ' + String(err && err.message || err).split('\n')[0]);
        continue;
      }
      try {
        const { ctx, page } = await newCtxPage(browser);
        console.log('# ' + kind + ' page ready, starting core flow');
        await coreFlow(page, base, kind.startsWith('chrom') ? 'chromium' : kind);
        await ctx.close();
      } catch (err) {
        ok(false, `${kind} core flow crashed`, String(err && err.message || err).split('\n').slice(0, 12).join(' | '));
      }
      await browser.close();
    }

    // B. 沒有 3D 的兩種情況（Chromium）
    // B1. --disable-webgl：WebGL 建不起來 → 說明卡（含截圖）
    if (ONLY === 'all' || ONLY === 'no3d' || ONLY === 'no3d-webgl') {
      let browser;
      try { browser = await tryLaunch('chromium', { args: ['--disable-webgl'] }); }
      catch (err) { skip('chromium no-webgl', String(err && err.message || err).split('\n')[0]); }
      if (browser) {
        try { await no3dCase(browser, base, 'chromium-nowebgl', { shot: true }); }
        catch (err) { ok(false, 'chromium-nowebgl crashed', String(err && err.message || err).split('\n').slice(0, 12).join(' | ')); }
        await browser.close();
      }
    }

    // B2. 擋掉 three.js CDN：3D 引擎載入失敗 → 說明卡
    if (ONLY === 'all' || ONLY === 'no3d' || ONLY === 'no3d-cdn') {
      let browser;
      try {
        browser = await tryLaunch('chromium');
      } catch (err) { skip('chromium cdn-fail', String(err && err.message || err).split('\n')[0]); }
      if (browser) {
        try {
          const { ctx, page } = await newCtxPage(browser);
          await page.route('**/three.module.js', r => r.abort());
          const errors = [];
          watchConsoleInto(page, errors, /WebGL context could not be created|Error creating WebGL context|three\.module\.js|ERR_FAILED|Failed to fetch|dynamically import/i);
          await boot(page, base);
          await page.waitForSelector('#noview .ncard', { timeout: 15000 });
          ok(await isNo3d(page), 'chromium cdn-fail → notice');
          await lockCards(page);
          ok(await page.locator('#noview .nrow').count() >= N_CARDS, 'chromium cdn-fail list renders');
          ok(errors.length === 0, 'chromium cdn-fail zero other errors', errors.slice(0, 3));
          await ctx.close();
        } catch (err) {
          ok(false, 'chromium cdn-fail crashed', String(err && err.message || err).split('\n').slice(0, 12).join(' | '));
        }
        await browser.close();
      }
    }
    // B3. 3D 跑到一半掉 context
    if (ONLY === 'all' || ONLY === 'no3d' || ONLY === 'no3d-lost') {
      let browser;
      try { browser = await tryLaunch('chromium'); }
      catch (err) { skip('chromium context-lost', String(err && err.message || err).split('\n')[0]); }
      if (browser) {
        try { await contextLostCase(browser, base, 'chromium-context-lost'); }
        catch (err) { ok(false, 'chromium-context-lost crashed', String(err && err.message || err).split('\n').slice(0, 12).join(' | ')); }
        await browser.close();
      }
    }
  } finally {
    srv.kill();
  }  console.log(`\n# browsers-e2e done: ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error('HARNESS CRASH', err); process.exit(2); });
