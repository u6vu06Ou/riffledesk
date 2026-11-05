import { chromeExecutable } from './chrome-path.mjs';
// tests/select-scroll-e2e.mjs — 點卡＋滾動：卡堆上不再有任何框線、卡片位置一路連續（歐哥 2026-10-30）
//
// 症狀（舊版）：點一張卡以後出現虛線框，滾動時框留在原本那張卡上、那張卡一直閃，隔壁卡也跟著跳。
// 現在的設計：卡堆上完全不畫框，選取只用「整張卡染一點選取色」表示；
// 點卡／閱讀都不得改變卡片在堆疊中的位置、高度、大小。
// 這個檔逐幀（requestAnimationFrame）取樣，斷言：
//   1. 點下去：閱讀區開的是點的那個檔，卡的位置與大小沒有因為「被點」而位移
//   2. 滾動中：每張追蹤中的卡只有一個方向的位移、單幀位移有上限、縮放只隨弧線位置平滑變化
//   3. 滾動中：卡堆上不存在框線物件
//   4. 多選的染色記號（sel）全程不掉
//   5. 停手後：閱讀區仍是當初點的檔（滾動不改閱讀內容）
//   6. 一屏看得到五張卡的檔名（弧線是往下墜的拋物線，焦點卡在弧頂），
//      4、5 的檔名列在焦點卡標題列之上、整個視區之內，頂端的「有新檔案」藥丸沒被卡蓋住
//
// 自帶夾具＋臨時 config，起 5196 埠的伺服器，跑完關掉。不碰 repo 的 config.json/index.db。
// 用法：node tests/select-scroll-e2e.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_PORT = Number(process.env.PORT || 0);   // 0＝自己挑一個空的（5190 起）
const CHROME = chromeExecutable();
const N_CARDS = 60;
const ARC_W = 680;                                 // 驗收指定的卡堆欄寬（閱讀欄開著）
const sleep = ms => new Promise(r => setTimeout(r, ms));
let PORT = BASE_PORT, BASE = '';

// 前面跑掛的測試可能把伺服器留在埠上 → 逐一試，遇到 busy 就換下一個
async function freePort(start) {
  const { createServer } = await import('node:net');
  for (let p = start || 5190; p < (start ? start + 1 : 5200); p++) {
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

let failed = 0;
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-select-'));
const DIR = path.join(TMP, 'root', 'cards');

function buildFixtures() {
  fs.mkdirSync(DIR, { recursive: true });
  // mtime 一定要各不相同：預設排序是「新的在前」，全部同一時間的話排序會在兩次載入之間
  // 任意變動，索引對不上檔名，測試就假 FAIL
  const base = Date.now() - N_CARDS * 1000;
  for (let i = 1; i <= N_CARDS; i++) {
    const f = path.join(DIR, `card-${String(i).padStart(2, '0')}.md`);
    fs.writeFileSync(f, `# card ${i}\n\nbody\n`);
    const t = new Date(base + i * 1000);
    fs.utimesSync(f, t, t);
  }
  fs.writeFileSync(path.join(TMP, 'config.json'),
    JSON.stringify({ roots: [path.join(TMP, 'root')], pinned: [] }));
  // 第二個資料夾：換過去以後，原本在讀的檔就不在卡堆裡了
  const other = path.join(TMP, 'root', 'other');
  fs.mkdirSync(other, { recursive: true });
  for (let i = 1; i <= 10; i++) fs.writeFileSync(path.join(other, `other-${String(i).padStart(2, '0')}.md`), `# other ${i}\n`);
}

async function startServer() {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: path.join(TMP, 'config.json') },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let out = '';
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server timeout: ' + out)), 20000);
    srv.stdout.on('data', d => { out += d; if (out.includes('listening')) { clearTimeout(to); res(); } });
    srv.stderr.on('data', d => { out += d; });
  });
  return srv;
}

// 一輪取樣：每幀記錄每張卡的螢幕座標與縮放。滾輪用真的 WheelEvent 打在 canvas 上。
const SAMPLE = async (page, { deltaY, ms }) => page.evaluate(async ({ deltaY, ms }) => {
  const cv = document.getElementById('gl');
  const rows = [];
  let timer = null;
  const t0 = performance.now();
  await new Promise(res => {
    const loop = () => {
      const p = __dbg.selProbe();
      rows.push({
        t: Math.round(performance.now() - t0), sc: p.scroll,
        y: Object.fromEntries(p.cards.map(c => [c.p, c.y])),
        z: Object.fromEntries(p.cards.map(c => [c.p, c.sc])),
        sel: p.cards.filter(c => c.sel).map(c => c.p)
      });
      if (performance.now() - t0 < ms) requestAnimationFrame(loop);
      else { if (timer) clearInterval(timer); res(); }
    };
    if (deltaY) timer = setInterval(() => cv.dispatchEvent(
      new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })), 110);
    requestAnimationFrame(loop);
  });
  return rows;
}, { deltaY, ms });

// 卡片是疊起來的：靜止時只有最前面那張的底部露出來，其他都被蓋住。
// 所以先滾到中段、讓目標變成焦點卡，再從它露出的底部（由下往上）找一個 raycast 打得到的點。
async function aimAt(page, idx) {
  return page.evaluate(i => {
    const b = __dbg.cardBounds(i);
    if (!b) return null;
    const hit = (x, y) => { const p = __dbg.pickAt(x, y); return !!p && p.fileIdx === i; };
    for (let fy = 0.92; fy >= 0.05; fy -= 0.05) {
      for (let fx = 0.5; fx <= 0.9; fx += 0.13) {
        for (const x of [b.minX + b.w * fx, b.minX + b.w * (1 - fx)]) {
          const y = b.minY + b.h * fy;
          if (hit(x, y)) return { x, y };
        }
      }
    }
    return null;
  }, idx);
}

async function clickAt(page, idx, ctrl) {
  for (let round = 0; round < 3; round++) {
    const v = await page.evaluate(() => __dbg.viewRect());
    await page.mouse.move(v.x + v.w - 20, v.y + 30, { steps: 5 });
    await sleep(450);
    const pt = await aimAt(page, idx);
    if (!pt) continue;
    await page.mouse.move(pt.x, pt.y, { steps: 6 });
    await sleep(400);
    const again = await aimAt(page, idx);
    const p = again || pt;
    const pick = await page.evaluate(q => __dbg.pickAt(q.x, q.y), p);
    if (!pick || pick.fileIdx !== idx) continue;
    if (ctrl) await page.keyboard.down('Control');
    await page.mouse.down(); await sleep(60); await page.mouse.up();
    if (ctrl) await page.keyboard.up('Control');
    return true;
  }
  return false;
}

// 把卡堆欄固定成驗收寬度（680px）並開閱讀欄：直接寫欄寬＋立即重取景，
// 不走 setMode 的比例配置（那個跟螢幕寬度連動，量到的寬度不固定）。
async function forceArcWidth(page) {
  // 走真正的 applyFracs（而不是只改幾條行內寬度）：只有這樣卡堆視區、canvas 視埠、
  // 取景與閱讀欄才會一起到定位，量到的座標才是使用者真的看到的版面。
  await page.evaluate((w) => {
    if (__dbg.mode() !== 'threecol') __dbg.setMode('threecol');
    const W = innerWidth, tree = 200;
    __dbg.setFracs({ tree: tree / W, view: w / W, reader: Math.max(0, (W - tree - w - 18) / W) });
  }, ARC_W);
  await sleep(600);
  return page.evaluate(() => Math.round(__dbg.viewRect().w));
}

async function main() {
  PORT = await freePort(BASE_PORT);
  BASE = `http://127.0.0.1:${PORT}`;
  buildFixtures();
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-gpu'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, locale: 'zh-TW' });
    await ctx.addInitScript(() => { try { localStorage.setItem('riffleTipSeen', '1'); } catch (_) {} });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.__dbg && window.__dbg.ready()), null, { timeout: 20000 });
    await page.evaluate(p => __dbg.lockFolder(p), DIR);
    await page.waitForFunction(() => __dbg.stack().phase === 'idle', null, { timeout: 20000 });
    await sleep(1200);
    // 首次開啟的說明浮層會蓋住卡片（吃掉真滑鼠點擊）
    await page.evaluate(() => { const h = document.getElementById('hint'); if (h) h.style.cssText = 'display:none!important'; });

    // ---------------------------------------------------------------- 1. 點中間一張卡
    // 卡片是「新的在前」排序，索引跟檔名不對應：一律用 fileNames 取名字對答案
    const names = await page.evaluate(() => __dbg.fileNames(80));
    const paths = await page.evaluate(() => __dbg.filePaths(80));
    ok(names.length >= 12, 'fixture-loaded', { n: names.length });
    const idx = Math.min(4, names.length - 6);            // 前面還有鄰居、後面還很長
    // 先滾到中段：靜止時只有焦點卡露得出來，其他都被蓋住點不到
    await page.evaluate(i => {
      const s = __dbg.scene();
      s.scrollTarget = i; s.scrollCur = i; s.poke();
    }, idx);
    await page.waitForFunction(() => __dbg.stack().phase === 'idle', null, { timeout: 12000 });
    await sleep(900);
    const okClick = await clickAt(page, idx);
    ok(okClick, 'click-aim-reachable', { idx });
    await page.waitForFunction(() => __dbg.panel().shown === true, null, { timeout: 8000 });
    await sleep(900);

    const want = names[idx];
    const clicked = await page.evaluate(() => __dbg.panel().file);
    ok(clicked === want, 'click-opens-clicked-card-in-reader', { clicked, want });

    // 卡堆上不畫框：整個池子裡沒有任何 slot 掛著 frame 物件
    const anyFrame = await page.evaluate(() => {
      const st = __dbg.scene();
      return st.slots.filter(s => s.frame).length;
    });
    ok(anyFrame === 0, 'no-frame-object-in-stack', { n: anyFrame });

    // 滑鼠移開卡片區，避免 hover 影響；滾輪事件直接打 canvas
    const v = await page.evaluate(() => __dbg.viewRect());
    await page.mouse.move(v.x + v.w - 20, v.y + 30, { steps: 4 });
    await sleep(550);

    // 1b. 點卡本身不能讓卡片在堆疊中位移（舊版會墊高 → 翻走時對不上鄰卡而互彈）。
    // 第一次點卡會開閱讀欄、版面當場變寬，位置一律重取景，跟前一次不能比；
    // 所以在閱讀欄已經開著的版面下點「第二張」，只比較點擊前後同一版面的位置。
    const idx2 = idx + 1;
    const preClick = await page.evaluate(() => __dbg.selProbe());
    ok(await clickAt(page, idx2), 'second-click-aim-reachable', { idx: idx2 });
    await sleep(700);
    const postClick = await page.evaluate(() => __dbg.selProbe());
    const second = names[idx2];
    const secondPath = paths[idx2];
    const wasClicked = postClick.cards.find(c => c.p === secondPath);
    const before = preClick.cards.find(c => c.p === secondPath);
    ok(!!wasClicked && !!before, 'clicked-card-still-in-stack', { second });
    if (wasClicked && before) {
      ok(Math.abs(wasClicked.y - before.y) <= 3, 'click-does-not-move-the-card',
        { dy: +(wasClicked.y - before.y).toFixed(2) });
      ok(wasClicked.sc === before.sc, 'click-does-not-rescale-the-card',
        { before: before.sc, after: wasClicked.sc });
    }
    ok((await page.evaluate(() => __dbg.panel().file)) === second, 'reader-follows-second-click',
      { reader: await page.evaluate(() => __dbg.panel().file), second });
    const reading = secondPath;   // 之後「正在讀的檔」就是第二張

    // 鄰居＝列表順序上點的那張前後各一張（用路徑認，slot 換綁不會搞混）
    const track = [paths[idx], paths[idx + 2]].filter(Boolean);
    ok(track.length === 2, 'neighbours-identified', { track });

    // ---------------------------------------------------------------- 2. 多選染色記號
    // Ctrl+點後面兩張（第二張剛才已選起來，這裡再 Ctrl+點它一次會取消，
    // 所以改成 Ctrl+點 idx−1、idx+2 兩張新卡（後面第三張在舊弧線上疊太緊點不到），之後滾動時染色不能掉
    let multiSel = [];
    for (const i of [idx - 1, idx + 2]) {
      await clickAt(page, i, true);
      await sleep(250);
    }
    multiSel = await page.evaluate(() => __dbg.selProbe().cards.filter(c => c.sel).map(c => c.p));
    ok(multiSel.length >= 2, 'multiselect-marked', { multiSel });
    await page.evaluate(() => {
      // 清掉 hover 殘留，讓量測只看滾動
      __dbg.hoverNow(null);
    });
    await sleep(400);

    // ---------------------------------------------------------------- 3. 滾動取樣
    const fwd = await SAMPLE(page, { deltaY: 100, ms: 1600 });
    const back = await SAMPLE(page, { deltaY: -100, ms: 1400 });
    const rows = [...fwd, ...back];
    ok(rows.length >= 120, 'sampled-frames', { n: rows.length });

    // 3a. 追蹤中的卡：位移一路連續（單幀位移有上限）＋幾乎不反向
    const checkMove = (name) => {
      let maxJump = 0, rev = 0, prevD = null, samples = 0;
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1].y[name], b = rows[i].y[name];
        if (a == null || b == null) { prevD = null; continue; }
        const d = b - a;
        samples++;
        maxJump = Math.max(maxJump, Math.abs(d));
        if (prevD != null && d !== 0 && prevD !== 0 && Math.sign(d) !== Math.sign(prevD)) rev++;
        if (d !== 0) prevD = d;
      }
      return { name, maxJump: +maxJump.toFixed(1), rev, samples };
    };
    const moves = [reading, ...track].map(checkMove);
    for (const m of moves) {
      ok(m.maxJump <= 45, 'no-jump:' + m.name, m);
      ok(m.rev <= 3, 'no-reverse:' + m.name, m);
    }

    // 3b. 縮放只隨「在弧線上的位置」平滑變化（沒有單幀跳動）
    const scaleJump = (name) => {
      let m = 0;
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1].z[name], b = rows[i].z[name];
        if (a == null || b == null) continue;
        m = Math.max(m, Math.abs(b - a));
      }
      return +m.toFixed(4);
    };
    for (const n of [reading, ...track]) {
      ok(scaleJump(n) <= 0.06, 'scale-changes-smoothly:' + n, { maxJump: scaleJump(n) });
    }

    // 3c. 全程都沒有框線物件冒出來
    const framesSeen = await page.evaluate(() => __dbg.scene().slots.filter(s => s.frame).length);
    ok(framesSeen === 0, 'still-no-frame-object-after-scroll', { n: framesSeen });

    // 3d. 多選染色全程不掉
    const selDrops = rows.filter(r => multiSel.some(n => !r.sel.includes(n))).length;
    ok(multiSel.every(n => rows.every(r => r.y[n] == null || r.sel.includes(n))), 'multiselect-marks-stable',
      { drops: selDrops, multiSel });

    // ---------------------------------------------------------------- 4. 停手後
    await page.waitForFunction(() => Math.abs(__dbg.stack().scroll - __dbg.stack().scrollTarget) < 0.01,
      null, { timeout: 8000 });
    await sleep(500);
    ok((await page.evaluate(() => __dbg.panel().file)) === second, 'reader-keeps-clicked-file',
      { reader: await page.evaluate(() => __dbg.panel().file), second });
    ok(errors.length === 0, 'no-page-errors', errors.slice(0, 3));

    // ---------------------------------------------------------------- 6. 讀的檔不在這一疊時也一樣沒有框
    await page.evaluate(p => __dbg.lockFolder(p), path.join(TMP, 'root', 'other'));
    // phase 可能還是舊的 idle，要等「view 真的換成新資料夾」再驗（不是等 phase）
    await page.waitForFunction(() => __dbg.fileNames(3).some(n => n.startsWith('other-')), null, { timeout: 15000 });
    await page.waitForFunction(() => __dbg.stack().phase === 'idle', null, { timeout: 15000 });
    await sleep(900);
    const elsewhere = await page.evaluate(() => ({
      frames: __dbg.scene().slots.filter(s => s.frame).length,
      reader: __dbg.panel().file
    }));
    ok(elsewhere.frames === 0, 'no-frame-when-reading-file-not-in-stack', elsewhere);
    ok(elsewhere.reader === second, 'reader-survives-folder-switch', elsewhere);
  } finally {
    await browser.close();
    server.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
