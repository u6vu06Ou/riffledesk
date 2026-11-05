import { chromeExecutable } from './chrome-path.mjs';
// e2e acceptance for 3jsfloder v4 — playwright-core + system Chrome, port 5178.
// 規格重點（v4 取景規則改版）：
//  1. 以寬度為主：前排卡投影寬 ≥ 堆視區寬 38%（v5 密排弱透視：frontWidth=0.38，以密換可見張數），水平置中 <3% 誤差。
//  2. 不再強制全塞：只顯示放得下且可讀的張數——1920 20檔 ≥6、1366 ≥5（實測 7），深堆上緣錨定貼近視區上緣；其餘虛擬捲動＋末排淡出。
//  3. WebGL viewport 左緣 = 分隔線右緣（±2px），可見卡包圍盒（含 hover 撥開極限）在視區內。
//  4. 真實滑鼠座標：hover/click/滾輪一律 page.mouse 對投影算出的像素位置。
//  5. 片數 3 / 20 / 40 × 視窗 1920×1030 / 1366×768 全測；樹同時最多一個實心選取。
// Usage: node tests/e2e.mjs   (starts its own server, shuts it down at the end)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5178;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const FIX = path.join(ROOT, 'tests', 'fixtures');
// S7 用的「大資料夾」：優先用 $RIFFLE_EXTRA_ROOT，其次任何本機的真實資料夾，
// 都沒有就退回夾具 size40（40 個 .md）——這樣沒有個人資料夾也能跑完整套。
const REAL_DIR = process.env.RIFFLE_EXTRA_ROOT || 'D:\\workspace\\cae';
const CAE = fs.existsSync(REAL_DIR) ? REAL_DIR : path.join(FIX, 'size40');
const CHROME = chromeExecutable();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = { consoleErrors: [], asserts: [], perf: {} };
let failed = 0;

function ok(cond, tag, extra) {
  results.asserts.push({ tag, pass: !!cond, ...(extra ? { extra } : {}) });
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

async function startServer() {
  // own config path (never touch the repo's config.json — the user's pins live there)
  const roots = [FIX];
  if (fs.existsSync(CAE)) roots.push(CAE);      // 真實資料夾截圖＋中段重複卡斷言用
  const cfgPath = path.join(FIX, '_test-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    roots,
    pinned: [path.join(FIX, 'size3'), path.join(FIX, 'size20'), path.join(FIX, 'size40'), path.join(FIX, 'docs'),
             ...(fs.existsSync(CAE) ? [CAE] : [])],
    convoRoots: []   // e2e fixture: no transcript scanning on boot
  }, null, 2));
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: cfgPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server start timeout: ' + out)), 8000);
    proc.stdout.on('data', d => {
      out += d;
      if (out.includes('listening')) { clearTimeout(to); res(); }
    });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', c => rej(new Error('server exited ' + c + ': ' + out)));
  });
  return proc;
}

// ---- v4 取景斷言（每個 視窗×檔案數 配置都跑）----
// 前卡投影寬 ≥ 38% 視區寬（v5 定版 frontWidth=0.38，實際 0.38~0.44 隨可見張數取整浮動）；水平置中 <3%；全可見卡包圍盒在視區內；
// WebGL viewport 左緣 = 分隔線右緣 ±2px；可見張數 ≥ minVis（1920 20/40 檔 ≥6、1366 ≥5）。
async function assertFraming(page, tag, minVis = 3) {
  const m = await page.evaluate(() => {
    const v = __dbg.viewRect();
    const corner = __dbg.cornerBounds();
    const st = __dbg.stack();
    const frontIdx = Math.round(st.scroll);
    const front = __dbg.cardBounds(Math.min(frontIdx, st.files - 1));
    const split = document.getElementById('splitter').getBoundingClientRect();
    const g = __dbg.viewGL();
    return {
      v, corner, front, nVisible: __dbg.visibleCards().length,
      visShown: st.visShown, splitRight: split.right, glX: g.x
    };
  });
  if (!m.corner || !m.front) { ok(false, tag + ' (no cards)'); return null; }
  const inX = m.corner.minX >= m.v.x - 2 && m.corner.maxX <= m.v.x + m.v.w + 2;
  const inY = m.corner.minY >= m.v.y - 2 && m.corner.maxY <= m.v.y + m.v.h + 2;
  ok(inX && inY, tag + '-bounds', !inX || !inY ? {
    b: Object.fromEntries(Object.entries(m.corner).map(([k, x]) => [k, Math.round(x)])), v: m.v } : undefined);
  const ratio = m.front.w / m.v.w;
  ok(ratio >= 0.38, tag + '-frontwidth>=38%', { ratio: +ratio.toFixed(3), visShown: m.visShown });
  const centerErr = Math.abs((m.corner.minX + m.corner.maxX) / 2 - (m.v.x + m.v.w / 2)) / m.v.w;
  ok(centerErr < 0.03, tag + '-hcenter<3%', { err: +(centerErr * 100).toFixed(2) + '%' });
  ok(Math.abs(m.glX - m.splitRight) <= 2, tag + '-gl-aligns-splitter',
    { glX: +m.glX.toFixed(1), splitRight: +m.splitRight.toFixed(1) });
  ok(m.nVisible >= minVis, `${tag}-visible>=${minVis}`, { n: m.nVisible });
  return m;
}

// 三欄閱讀模式取景斷言：被抽出的卡已由閱讀面板接管（slot 離開 home 佇列），
// 所以「前卡」改用剩餘 home 卡的最前一張；其餘同 assertFraming。
async function assertThreecolFraming(page, tag) {
  const m = await page.evaluate(() => {
    const v = __dbg.viewRect();
    const corner = __dbg.cornerBounds();
    const vis = __dbg.visibleCards().filter(c => c.mode === 'home');
    const front = vis.length ? __dbg.cardBounds(vis[0].fileIdx) : null;
    return { v, corner, front, nVisible: vis.length };
  });
  if (!m.corner) { ok(false, tag + '-bounds (stack hidden)'); return; }
  const inX = m.corner.minX >= m.v.x - 2 && m.corner.maxX <= m.v.x + m.v.w + 2;
  const inY = m.corner.minY >= m.v.y - 2 && m.corner.maxY <= m.v.y + m.v.h + 2;
  ok(inX && inY, tag + '-bounds', !inX || !inY ? {
    b: Object.fromEntries(Object.entries(m.corner).map(([k, x]) => [k, Math.round(x)])), v: m.v } : undefined);
  ok(m.nVisible >= 1, tag + '-remaining-visible', { n: m.nVisible });
  if (m.front) {
    const ratio = m.front.w / m.v.w;
    ok(ratio >= 0.38, tag + '-frontwidth>=38%', { ratio: +ratio.toFixed(3) });
    const centerErr = Math.abs((m.corner.minX + m.corner.maxX) / 2 - (m.v.x + m.v.w / 2)) / m.v.w;
    ok(centerErr < 0.03, tag + '-hcenter<3%', { err: +(centerErr * 100).toFixed(2) + '%' });
  }
}
// 深堆裡後面的卡常被前卡遮住中心/上緣，真人會點「露出來的那條」——
// 所以瞄準點用投影網格掃描：在卡的 bounding box 裡找一個 pick 命中自己的像素。
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
async function realOpenCard(page, idx) {
  // hover 波有回饋不穩定（游標帶著舊波移過來 → 前卡可能把目標蓋回去 → pick 翻掉）。
  // 真人會先把手移開、看卡堆平靜後直接指向露出的卡——測試照做：
  // 每輪先把滑鼠移到中性空白沉澱（無波 baseline 幾何＝確定性），掃描瞄準後直達目標點；
  // 到點當下的 pointermove 在 baseline 上 pick 到目標 → hover 鎖定目標 → 波把目標抽更高（更穩）。
  let lastPick = null, lastPt = null;
  for (let round = 0; round < 3; round++) {
    const v = await page.evaluate(() => __dbg.viewRect());
    await page.mouse.move(v.x + v.w - 30, v.y + 40, { steps: 6 });
    await sleep(700);                            // 中性空白沉澱：波歸零
    let pt = await cardAimPoint(page, idx);
    if (!pt) continue;                           // 卡此刻沒有可點像素：沉澱後重掃
    for (let aim = 0; aim < 4; aim++) {
      await page.mouse.move(pt.x, pt.y, { steps: 8 });
      await sleep(700);                          // 抽高/推開動畫沉澱
      const npt = await cardAimPoint(page, idx);
      if (npt) pt = npt;
      const pick = await page.evaluate(p => __dbg.pickAt(p.x, p.y), pt);
      if (pick && pick.fileIdx === idx) break;   // 指標點投影正好命中這張卡
    }
    const pick = await page.evaluate(p => __dbg.pickAt(p.x, p.y), pt);
    lastPick = pick; lastPt = pt;
    if (!pick || pick.fileIdx !== idx) continue; // mismatch → 下一輪重沉澱重掃
    await page.mouse.down();
    await sleep(70);
    await page.mouse.up();
    try {
      await page.waitForFunction(
        () => __dbg.stack().extracted != null && __dbg.panel().shown === true, null, { timeout: 6000 });
    } catch (e) {
      return { ok: false, reason: 'no-extract-after-click', at: pt };
    }
    const st = await page.evaluate(() => ({ extracted: __dbg.stack().extracted, mode: __dbg.mode() }));
    return { ok: st.extracted != null, extracted: st.extracted, mode: st.mode, at: pt, rounds: round + 1 };
  }
  return { ok: false, reason: 'pick-mismatch', pick: lastPick, at: lastPt };
}

async function escPutBack(page) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => __dbg.mode() === 'twocol' && !__dbg.stack().extracted, null, { timeout: 6000 });
  await sleep(850);
}
async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    // 不再強制 scale factor：各 context 用 deviceScaleFactor 覆 DPR 1/1.15/1.25/1.5
    args: ['--enable-gpu', '--js-flags=--expose-gc']
  });
  const mainCtx = await browser.newContext({ viewport: { width: 1920, height: 1030 }, deviceScaleFactor: 1 });
  const page = await mainCtx.newPage();
  const watchPage = pg => {
    pg.on('console', m => { if (m.type() === 'error') results.consoleErrors.push(m.text()); });
    pg.on('pageerror', e => results.consoleErrors.push('pageerror: ' + e.message));
  };
  watchPage(page);

  const shot = async (name, pg = page) => {
    await pg.screenshot({ path: path.join(SHOTS, name + '.png') });
    console.log('shot', name);
  };
  const P = {
    size3: path.join(FIX, 'size3'),
    size20: path.join(FIX, 'size20'),
    size40: path.join(FIX, 'size40'),
    docs: path.join(FIX, 'docs')
  };
  const wf = (fn, arg, timeout = 9000) => page.waitForFunction(fn, arg, { timeout });
  const lockFolderIdle = async (p, pg = page) => {
    await pg.evaluate(ph => __dbg.lockFolder(ph), p);
    await pg.waitForFunction(() => __dbg.stack().phase === 'idle', null, { timeout: 9000 });
    await sleep(900);                            // 相機取景 damp 沉澱 + 首批縮圖
  };
  // hover 撥開（真實滑鼠上前排卡）後整個包圍盒仍要在視區內
  const assertHoverPart = async tag => {
    const vc = await page.evaluate(() => {
      const v0 = __dbg.visibleCards().find(c => c.fileIdx === Math.round(__dbg.stack().scroll));
      return v0 || __dbg.visibleCards()[0] || null;
    });
    if (!vc) { ok(false, tag + ' (no card to hover)'); return; }
    await page.mouse.move(vc.x, vc.y, { steps: 5 });
    await sleep(1250);                           // 550ms hover 意圖延遲 + 抽高＋翻平＋相機重取景沉澱
    const h = await page.evaluate(() => {
      const v = __dbg.viewRect();
      const b = __dbg.cornerBounds();
      return b ? { ok: b.minX >= v.x - 2 && b.maxX <= v.x + v.w + 2 &&
                       b.minY >= v.y - 2 && b.maxY <= v.y + v.h + 2,
                   b, v } : null;
    });
    ok(h && h.ok, tag + '-hover-bounds', h && !h.ok ? {
      b: Object.fromEntries(Object.entries(h.b).map(([k, x]) => [k, Math.round(x)])),
      v: { x: Math.round(h.v.x), w: Math.round(h.v.w), h: h.v.h } } : undefined);
    await page.mouse.move((await page.evaluate(() => __dbg.viewRect())).x + 30, 130, { steps: 4 });
    await sleep(450);
  };

  try {
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await wf(() => window.__dbg && __dbg.ready(), null);
    await sleep(600);

    // 樹選取語意：開機後同時只能有一個實心選取
    ok((await page.evaluate(() => __dbg.selRows().length)) === 1, 'tree-single-sel-boot');

    // ============ S1：1920×1030 / size3 —— 取景 + 真實點擊每張卡 ============
    await lockFolderIdle(P.size3);
    ok((await page.evaluate(() => __dbg.chipsOn())).join() === 'readable', 'chips-default-readable');
    await assertFraming(page, 'f-1920-3files');
    await assertHoverPart('f-1920-3files');
    await shot('v4-01-1920-3files');

    for (let i = 0; i < 3; i++) {
      const res = await realOpenCard(page, i);
      ok(res.ok && res.mode === 'threecol', `real-click-card-${i}-1920`, res);
      if (i === 0) {
        await sleep(1100);                       // 飛行 + 面板就位
        await shot('v4-02-1920-read-threecol');
        // 三欄狀態下剩餘卡堆也要完整落在中間 1/3 視區（被抽出的卡由面板接管）
        await assertThreecolFraming(page, 'f-threecol-3files');
        // 2 ⇦⇨ 2/3、全螢幕來回切，回三欄後再驗一次（重新取景）
        await page.keyboard.press('2'); await wf(() => __dbg.mode() === 'wide', null, 4000);
        await page.keyboard.press('2'); await wf(() => __dbg.mode() === 'threecol', null, 4000);
        await sleep(700);
        await assertThreecolFraming(page, 'f-after-wide-toggle');
        // 追加 B：點 ✕ 放回 → 該卡回到原位、mesh.visible===true、畫面上看得到
        {
          const nm = await page.evaluate(() => __dbg.stack().extracted);
          const idx = await page.evaluate(n => __dbg.fileNames().indexOf(n), nm);
          await page.click('#btnClose');
          await wf(() => __dbg.mode() === 'twocol' && !__dbg.stack().extracted, null, 6000);
          await sleep(900);
          ok(await page.evaluate(i => __dbg.meshVisible(i), idx) === true,
            'X-close-mesh-visible', { idx });
          ok(!!(await cardAimPoint(page, idx)), 'X-close-card-onscreen', { idx });
        }
      }
      await escPutBack(page);
    }
    ok((await page.evaluate(() => __dbg.selRows().length)) === 1, 'tree-single-sel-after-clicks');
    await shot('v4-03-1920-3files-after-clicks');

    // ============ S2：1920×1030 / size20 ============
    await lockFolderIdle(P.size20);
    ok((await page.evaluate(() => __dbg.stack().files)) === 20, 'size20-loaded');
    await assertFraming(page, 'f-1920-20files', 6);
    await shot('v4-04-1920-20files');
    await assertHoverPart('f-1920-20files');
    await shot('v4-05-1920-20files-hover');

    // hover 意圖延遲（預設 120ms，可調參）：路過不翻、停住才翻；滾輪捲動中不觸發
    {
      const v = await page.evaluate(() => __dbg.viewRect());
      await page.mouse.move(v.x + 30, 130, { steps: 3 });          // 中性空白：歸零
      await sleep(700);
      const vc = await page.evaluate(() => __dbg.visibleCards()[0]);
      await page.mouse.move(vc.x, vc.y, { steps: 4 });
      await sleep(60);                                             // < 120ms 閾值
      const quick = await page.evaluate(() => __dbg.stack().hoverD);
      ok(quick == null, 'hover-intent-quickpass-no-flip', { hoverD: quick });
      await sleep(280);                                            // 累計 ~340ms > 120ms
      const dwelt = await page.evaluate(() => __dbg.stack().hoverD);
      ok(dwelt != null, 'hover-intent-dwell-flips', { hoverD: dwelt });
      // 滾輪捲動中不觸發 hover：游標停在卡面上連撥滾輪，捲動期間 hoverD 必須是 null
      await page.mouse.move(v.x + 30, 130, { steps: 3 });
      await sleep(500);
      await page.mouse.move(v.x + v.w / 2, v.y + v.h / 2, { steps: 4 });
      await sleep(300);                                            // 捲動前 hover 可能已成立
      await page.mouse.wheel(0, 240);
      await sleep(60);
      const duringWheel = await page.evaluate(() => __dbg.stack().hoverD);
      ok(duringWheel == null, 'hover-suppressed-while-wheel', { hoverD: duringWheel });
      await page.mouse.wheel(0, -240);
      await page.mouse.move(v.x + 30, 130, { steps: 3 });
      await sleep(600);
    }

    // ---- 點 A 開 B 的正式斷言在 S7（真實資料夾 cae）做：只有夠多張、夠密的卡才會穩定重現
    //      「撥開後 raycast 打到別張」。


    // ============ S3：1920×1030 / size40 —— 虛擬捲動 + 滾到底點開最後一張 ============
    await lockFolderIdle(P.size40);
    await assertFraming(page, 'f-1920-40files', 6);
    await shot('v4-06-1920-40files');
    {
      // 只點「有可見像素會 pick 到自己」的卡（和 realOpenCard 同一套網格掃描），取前 3 張
      const cands = await page.evaluate(() => {
        return __dbg.visibleCards().map(c => {
          const b = __dbg.cardBounds(c.fileIdx);
          if (!b) return null;
          for (let fy = 0.04; fy <= 0.96; fy += 0.09) for (const fx of [0.3, 0.5, 0.7]) {
            const p = __dbg.pickAt(b.minX + b.w * fx, b.minY + b.h * fy);
            if (p && p.fileIdx === c.fileIdx) return c.fileIdx;
          }
          return null;
        }).filter(v => v != null).slice(0, 3);
      });
      ok(cands.length >= 3, 'size40-clickable-cards', { n: cands.length });
      for (const idx of cands) {
        const res = await realOpenCard(page, idx);
        ok(res.ok, `real-click-file${idx}-40files`, res.ok ? undefined : res);
        if (!res.ok) break;
        await escPutBack(page);
      }
    }
    // 滾輪翻到底（真實 wheel 事件），最後一張也要能真實點開
    {
      const st = await page.evaluate(() => ({ max: __dbg.stack().scrollMax, files: __dbg.stack().files }));
      const v = await page.evaluate(() => __dbg.viewRect());
      await page.mouse.move(v.x + v.w / 2, v.y + v.h / 2);
      for (let i = 0; i < 30; i++) {
        await page.mouse.wheel(0, 240);
        await sleep(60);
      }
      await wf(m => Math.abs(__dbg.stack().scroll - __dbg.stack().scrollMax) < 0.05, null);
      await sleep(900);
      const st2 = await page.evaluate(() => ({ scroll: __dbg.stack().scroll, max: __dbg.stack().scrollMax }));
      ok(Math.abs(st2.scroll - st.max) < 0.2 && st.max > 0, 'wheel-scrolled-to-end', st2);
      const last = await page.evaluate(() => __dbg.stack().files - 1);
      const res = await realOpenCard(page, last);
      ok(res.ok, 'real-click-last-card-after-scroll', res.ok ? { extracted: res.extracted } : res);
      if (res.ok) {
        await sleep(900);
        await shot('v4-07-1920-scrolled-last-read');
        await escPutBack(page);
      }
      // 滾回頂，讓後面 perf 用前排卡
      await page.mouse.move(1410, 130, { steps: 3 });
      for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, -240); await sleep(40); }
      await page.evaluate(() => { /* settle */ });
      await sleep(700);
    }

    // ---- perf A：5 秒滑鼠掃動 FPS（spec ≥55）
    {
      const fr = await page.evaluate(() => __dbg.fracs());
      const vp = page.viewportSize();
      const cx = (fr.tree + fr.view / 2) * vp.width;
      await page.mouse.move(cx, 150);
      await sleep(300);
      const sweepT0 = Date.now();
      let low = false;
      while (Date.now() - sweepT0 < 5000) {
        await page.mouse.move(cx, low ? 160 : 780, { steps: 12 });
        low = !low;
      }
      const fps = await page.evaluate(() => __dbg.avgFps());
      results.perf.sweepFpsAvg = fps;
      ok(fps >= 55, 'fps-sweep-55', { fps });
    }

    // ---- perf B：20 次開關循環 → heap/texture 不成長爆掉
    {
      await page.evaluate(() => { if (window.gc) window.gc(); });
      await sleep(300);
      const before = await page.evaluate(() => ({ heap: __dbg.heap(), tex: __dbg.stack().textures }));
      for (let i = 0; i < 20; i++) {
        const cs = await page.evaluate(() => {
          const c = __dbg.cardScreen(Math.round(__dbg.stack().scroll));
          return c && c.mode === 'home' ? c : null;
        });
        if (!cs) break;
        // 撥開波動畫中途點擊會落空（點在剛打開的縫裡）：先 close 到位再重取座標點
        await page.mouse.move(cs.x, cs.y);
        await sleep(150);
        await page.waitForFunction(() => !__dbg.stack().rafRunning, null, { timeout: 4000 }).catch(() => {});
        const cs2 = await page.evaluate(() => __dbg.cardScreen(Math.round(__dbg.stack().scroll)));
        if (cs2) await page.mouse.move(cs2.x, cs2.y, { steps: 2 });
        await page.mouse.down(); await sleep(60); await page.mouse.up();
        let shown = await wf(() => __dbg.panel().shown, null, 1200).then(() => true, () => false);
        if (!shown) {   // 一次性重試（掀縫時機命）
          const cs3 = await page.evaluate(() => __dbg.cardScreen(Math.round(__dbg.stack().scroll)));
          if (cs3) {
            await page.mouse.move(cs3.x, cs3.y, { steps: 3 });
            await page.waitForFunction(() => !__dbg.stack().rafRunning, null, { timeout: 4000 }).catch(() => {});
            await page.mouse.down(); await sleep(60); await page.mouse.up();
            shown = await wf(() => __dbg.panel().shown, null, 2500).then(() => true, () => false);
          }
        }
        if (!shown) { ok(false, `cycle-open-${i}`, { i }); break; }
        await page.keyboard.press('Escape');
        await wf(() => __dbg.mode() === 'twocol' && !__dbg.stack().extracted, null, 4000);
        await sleep(40);
      }
      await sleep(800);
      await page.evaluate(() => { if (window.gc) window.gc(); });
      await sleep(400);
      await page.evaluate(() => { if (window.gc) window.gc(); });
      await sleep(200);
      const after = await page.evaluate(() => ({ heap: __dbg.heap(), tex: __dbg.stack().textures }));
      results.perf.memCycles = { before, after };
      ok(after.tex - before.tex < 25, 'textures-stable-after-cycles', { before, after });
    }

    // ============ S4：chip 單選語意（真實滑鼠 + 修飾鍵，1920 寬窗下工具列不裁切）============
    const chipRect = id => page.evaluate(cid => {
      const b = document.querySelector(`[data-chip="${cid}"]`);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, id);
    const clickChip = async (id, mod) => {
      const rc = await chipRect(id);
      if (!rc) throw new Error('chip missing ' + id);
      if (mod) await page.keyboard.down(mod);
      await page.mouse.click(rc.x, rc.y);
      if (mod) await page.keyboard.up(mod);
      await sleep(150);
    };
    const chips = () => page.evaluate(() => __dbg.chipsOn());

    await clickChip('txt');
    ok((await chips()).join() === 'txt', 'chip-plain-click-single');
    await clickChip('json');
    ok((await chips()).join() === 'json', 'chip-plain-click-switches');
    await clickChip('md', 'Control');
    ok((await chips()).sort().join() === 'json,md', 'chip-ctrl-adds');
    await clickChip('table', 'Shift');
    ok((await chips()).sort().join() === 'json,md,table', 'chip-shift-adds');
    await clickChip('table', 'Shift');
    ok((await chips()).sort().join() === 'json,md', 'chip-shift-removes');
    await clickChip('json', 'Control');
    ok((await chips()).join() === 'md', 'chip-ctrl-removes');
    await clickChip('md', 'Control');            // 最後一個取消不掉
    ok((await chips()).join() === 'md', 'chip-never-empty');
    // localStorage 相容：仍是 id 陣列
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('floderChips2') || 'null'));
    ok(Array.isArray(saved) && saved.join() === 'md', 'chip-localstorage-compatible', saved);
    await sleep(600);                       // 晶片切換動畫沉澱後再拍，否則截到中途縮小的堆
    await shot('v4-08-chips');

    // 檔名搜尋期間放寬 chips：chips=[md] 下 docs 只載 6 個 .md；
    // 打 'plain' 應把 plain.txt 也載進來並被名字過濾命中；清空即還原
    {
      await lockFolderIdle(P.docs);
      const mdOnly = await page.evaluate(() => __dbg.stack().files);
      ok(mdOnly === 6, 'search-broaden-baseline-md-only', { files: mdOnly });
      await page.fill('#searchBox', 'plain');
      await sleep(1400);                   // 250ms debounce + 目錄重載 + 取景沉澱
      const during = await page.evaluate(() => ({
        files: __dbg.stack().files,
        names: __dbg.visibleCards().map(c => c.name)
      }));
      ok(during.names.length === 1 && during.names[0] === 'plain.txt', 'search-broadens-chips', during);
      await shot('v4-14-search-broadens-chips');   // chips=[md] 淡化＋搜尋命中 plain.txt 的證據
      await page.fill('#searchBox', '');
      await sleep(1400);
      const after = await page.evaluate(() => __dbg.stack().files);
      ok(after === mdOnly, 'search-clear-restores-chips', { files: after, before: mdOnly });
    }
    // 參數存檔帶版本號（舊版無 __v → 下次載入整組重置）
    const pv = await page.evaluate(() => JSON.parse(localStorage.getItem('floderParams2') || '{}').__v);
    ok(pv === undefined || pv === 6, 'params-version-field', { pv });
    await sleep(900);

    // ============ S5：1366×768 —— 重取景 + 3 / 20 / 40 檔 ============
    await page.setViewportSize({ width: 1366, height: 768 });
    await sleep(1100);                           // resize → fracs/damp 沉澱
    await lockFolderIdle(P.size3);
    await assertFraming(page, 'f-1366-3files');
    await shot('v4-09-1366-3files');
    {
      const res = await realOpenCard(page, 1);
      ok(res.ok && res.mode === 'threecol', 'real-click-card-1-1366', res);
      await sleep(1000);
      await shot('v4-10-1366-read-threecol');
      await escPutBack(page);
    }
    await lockFolderIdle(P.size20);
    await assertFraming(page, 'f-1366-20files', 5);
    await shot('v4-11-1366-20files');
    await lockFolderIdle(P.size40);
    await assertFraming(page, 'f-1366-40files', 5);
    await shot('v4-12-1366-40files');
    await assertHoverPart('f-1366-40files');
    {
      const res = await realOpenCard(page, 1);
      ok(res.ok, 'real-click-file1-40files-1366', res.ok ? undefined : res);
      if (res.ok) await escPutBack(page);
    }
    // 樹選取：整輪操作後仍然只有一個實心
    ok((await page.evaluate(() => __dbg.selRows().length)) === 1, 'tree-single-sel-final');

    // ============ S6：DPR 矩陣（1 / 1.15 / 1.25 / 1.5 × 1670×777 / size20）============
    // 斷言：① GPU 實際 viewport（gl.getParameter(VIEWPORT)/pixelRatio）左緣 = 分隔線右緣
    //       ② 真實滑鼠移到 cardScreen/網格掃描算出的像素 → 畫面 raycast 命中同一張
    //       ③ 高度 ≥700 → 可見 ≥6 張；後排每張露出 ≥ 檔名列+2 行（曝光比 ≥0.16）
    //       ④ 翻到中段停穩後：每張可見卡「貼圖來源檔名」=「綁定檔名」（重複/錯貼卡斷言）
    const evalDprMetrics = pg => pg.evaluate(() => {
      const v = __dbg.viewRect();
      const st = __dbg.stack();
      const split = document.getElementById('splitter').getBoundingClientRect();
      const raw = __dbg.viewGLRaw();
      const cards = __dbg.visibleCards().filter(c => c.mode === 'home');
      const bs = cards.map(c => __dbg.cardBounds(c.fileIdx)).filter(b => b && b.h > 10)
        .sort((a, b) => a.minY - b.minY);
      const exp = [];
      for (let k = 1; k < bs.length; k++) {
        const d = bs[k].minY - bs[k - 1].minY;
        if (d > 1) exp.push(d / bs[k].h);
      }
      const cb = __dbg.cornerBounds();
      const front = bs.length ? bs[bs.length - 1] : null;   // 畫面最下 = 最前排
      return {
        v, raw, splitRight: split.right, visShown: st.visShown, nCards: cards.length,
        frontRatio: front ? front.w / v.w : 0,
        minExp: exp.length ? Math.min(...exp) : 1,
        fillBot: cb ? (v.y + v.h - cb.maxY) / v.h : 1,
        fillTop: cb ? (cb.minY - v.y) / v.h : 1,
        centerErr: cb ? Math.abs((cb.minX + cb.maxX) / 2 - (v.x + v.w / 2)) / v.w : 1,
        bounds: cb ? { minX: cb.minX, maxX: cb.maxX, minY: cb.minY, maxY: cb.maxY } : null
      };
    });

    for (const dsf of [1, 1.15, 1.25, 1.5]) {
      const tag = `dpr${dsf}`;
      const ctx2 = await browser.newContext({
        viewport: { width: 1670, height: 777 }, deviceScaleFactor: dsf });
      const pg = await ctx2.newPage();
      watchPage(pg);
      await pg.goto(BASE + '/', { waitUntil: 'networkidle' });
      await pg.waitForFunction(() => window.__dbg && __dbg.ready(), null, { timeout: 9000 });
      await sleep(500);
      await lockFolderIdle(P.size20, pg);
      const m = await evalDprMetrics(pg);
      ok(Math.abs(m.raw.x - m.splitRight) <= 2, `${tag}-rawgl-left-eq-splitter`,
        { rawX: +m.raw.x.toFixed(2), splitRight: +m.splitRight.toFixed(2), dpr: m.raw.dpr });
      ok(Math.abs(m.raw.w - (m.v.w)) <= 2, `${tag}-rawgl-width-eq-view`,
        { rawW: +m.raw.w.toFixed(2), viewW: m.v.w });
      ok(m.bounds && m.bounds.minX >= m.v.x - 2 && m.bounds.maxX <= m.v.x + m.v.w + 2 &&
         m.bounds.minY >= m.v.y - 2 && m.bounds.maxY <= m.v.y + m.v.h + 2,
        `${tag}-bounds-in-view`);
      // coordinator 追加 §2 覆寫原「≥6 卡」：高度放不下就減少可見張數，寬度優先填滿 → 門檻降為 ≥3
      ok(m.nCards >= 3, `${tag}-visible>=3@733h`, { n: m.nCards, vis: m.visShown });
      ok(m.frontRatio >= 0.80 && m.frontRatio <= 0.90, `${tag}-frontwidth-band85±5`,
        { ratio: +m.frontRatio.toFixed(3) });
      ok(m.centerErr < 0.03, `${tag}-hcenter<3%`, { err: +(m.centerErr * 100).toFixed(2) + '%' });
      ok(m.fillBot <= 0.15, `${tag}-stack-fills-bottom`, { fillBot: +(m.fillBot).toFixed(3) });
      ok(m.minExp >= 0.13, `${tag}-rear-exposure`, { minExp: +m.minExp.toFixed(3) });

      // 命中一致性：每張可見卡，真實滑鼠移到掃描出的像素 → pickAt 回同一張
      {
        const v = await pg.evaluate(() => __dbg.viewRect());
        const idxs = await pg.evaluate(() => __dbg.visibleCards()
          .filter(c => c.mode === 'home').map(c => c.fileIdx).slice(0, 6));
        for (const idx of idxs) {
          // 每張卡前都先回中性空白沉澱：上一張卡的停留累積會觸發 hover 波，
          // 波會把其他卡推開/壓下，瞄準掃描到的幾何就不是靜止基線 → pick 翻掉。
          await pg.mouse.move(v.x + 20, v.y + 30, { steps: 3 });
          await sleep(650);
          const pt = await cardAimPoint(pg, idx);
          if (!pt) continue;                       // 完全被遮住的後排卡
          await pg.mouse.move(pt.x, pt.y, { steps: 5 });
          await sleep(70);                         // < hoverDelay：不引入撥開波干擾
          const pick = await pg.evaluate(p => __dbg.pickAt(p.x, p.y), pt);
          ok(pick && pick.fileIdx === idx, `${tag}-mouse-pick-match-${idx}`,
            pick ? { want: idx, got: pick.fileIdx, name: pick.name } : { want: idx, got: null, pt });
        }
      }

      // 翻到中段停穩：每張可見卡貼圖來源檔名 = 綁定檔名；畫面檔名不重複
      {
        const mid = await pg.evaluate(() => Math.floor(__dbg.stack().scrollMax / 2));
        const v = await pg.evaluate(() => __dbg.viewRect());
        await pg.mouse.move(v.x + v.w / 2, v.y + v.h / 2);
        for (let i = 0; i < 40; i++) {
          const cur = await pg.evaluate(() => __dbg.stack().scroll);
          if (cur >= mid - 0.6) break;
          await pg.mouse.wheel(0, 320);
          await sleep(60);
        }
        // 一格 wheel ≈ 3 個 index、scrollCur 落後 scrollTarget：只能粗略送到中段，
        // 落點在 35%~65% 即算「中段」（重點是中段停穩後的貼圖身分，不是精確點位）
        await pg.waitForFunction(
          () => { const s = __dbg.stack(); return s.scroll > s.scrollMax * 0.3 && s.scroll < s.scrollMax * 0.7; },
          null, { timeout: 9000 });
        await pg.waitForFunction(() => !__dbg.stack().rafRunning, null, { timeout: 9000 });
        await sleep(400);
        const slots = await pg.evaluate(() => __dbg.slotTex());
        const mism = slots.filter(s => s.texName && s.texName !== s.name);
        ok(mism.length === 0, `${tag}-midsroll-tex-identity`, mism.slice(0, 3));
        const names = slots.map(s => s.name);
        ok(new Set(names).size === names.length, `${tag}-midsroll-no-dup-names`, { names });

        // 逐張點開前 2 張可點的卡：畫面檔名 = 閱讀面板標題
        let opened = 0;
        for (const sc of slots) {
          if (opened >= 2) break;
          const res = await realOpenCard(pg, sc.fileIdx);
          if (!res.ok) continue;
          const panelFile = await pg.evaluate(() => __dbg.panel().file);
          ok(panelFile === sc.name, `${tag}-open-shows-same-file-${sc.fileIdx}`,
            { card: sc.name, panel: panelFile });
          opened++;
          await pg.screenshot({ path: path.join(SHOTS, `v5-dpr${String(dsf).replace('.', '')}-open.png`) });
          await escPutBack(pg);
        }
        ok(opened >= 1, `${tag}-open-clickable`, { opened });
      }
      await ctx2.close();
    }

    // ============ S8：八尺寸取景矩陣（coordinator 追加 §3）============
    // 每種尺寸斷言：① 前排卡寬 = 右區 85%±5%（帶 0.80~0.90，寬度尺理應精準落在 0.85）
    //   ② 整疊不切邊（rest 與 hover 撥開後）③ 置中 <3%
    //   ④ 真實滑鼠 hover 中段卡：撥開後該卡可見面積 ≥ 半張（exposedRatio≥0.5）、命中正確
    //   ⑤ resize 後平滑重新取景仍落帶內   ⑥ 每尺寸 v6-<tag>.png ＋ v6-<tag>-hover.png 截圖
    const S8 = [
      ['1280x720',        1280, 720,  1],
      ['1366x768',        1366, 768,  1],
      ['1670x777-d115',   1670, 777,  1.15],
      ['1920x1080',       1920, 1080, 1],
      ['2560x1440-d125',  2560, 1440, 1.25],
      ['3840x2160-d15',   3840, 2160, 1.5],
      ['3440x1440',       3440, 1440, 1],
      ['1080x1920',       1080, 1920, 1]
    ];
    for (const [tag8, w8, h8, dsf8] of S8) {
      const ctx8 = await browser.newContext({
        viewport: { width: w8, height: h8 }, deviceScaleFactor: dsf8 });
      const pg = await ctx8.newPage();
      watchPage(pg);
      await pg.goto(BASE + '/', { waitUntil: 'networkidle' });
      await pg.waitForFunction(() => window.__dbg && __dbg.ready(), null, { timeout: 9000 });
      await sleep(500);
      await lockFolderIdle(P.size20, pg);
      const m = await evalDprMetrics(pg);
      ok(m.frontRatio >= 0.80 && m.frontRatio <= 0.90, `s8-${tag8}-frontwidth-band`,
        { fw: +m.frontRatio.toFixed(3) });
      ok(m.bounds && m.bounds.minX >= m.v.x - 2 && m.bounds.maxX <= m.v.x + m.v.w + 2 &&
         m.bounds.minY >= m.v.y - 2 && m.bounds.maxY <= m.v.y + m.v.h + 2,
        `s8-${tag8}-rest-noclip`, m.bounds ? {
          b: Object.fromEntries(Object.entries(m.bounds).map(([k, x]) => [k, Math.round(x)])),
          v: { x: Math.round(m.v.x), y: m.v.y, w: Math.round(m.v.w), h: m.v.h } } : { bounds: null });
      ok(m.centerErr < 0.03, `s8-${tag8}-hcenter<3pct`, { err: +(m.centerErr * 100).toFixed(2) + '%' });
      await shot('v6-' + tag8, pg);

      // 真實滑鼠 hover 中段卡 → 撥開曝光 + 不切邊 + 命中
      const cards8 = await pg.evaluate(() => __dbg.visibleCards().filter(c => c.mode === 'home'));
      ok(cards8.length >= 3, `s8-${tag8}-cards>=3`, { n: cards8.length, vis: m.visShown });
      if (cards8.length >= 3) {
        const aim8 = cards8[Math.floor(cards8.length / 2)];
        const pt8 = await cardAimPoint(pg, aim8.fileIdx);
        if (!pt8) {
          ok(false, `s8-${tag8}-hover-aim-found`, { fileIdx: aim8.fileIdx });
        } else {
          await pg.mouse.move(pt8.x, pt8.y, { steps: 5 });
          await sleep(1400);                    // hoverDelay + 撥開波 + 相機重取景沉澱
          const hr = await pg.evaluate(f => {
            const v = __dbg.viewRect();
            const b = __dbg.cornerBounds();
            return {
              exp: __dbg.exposedRatio(f),
              inView: b.minX >= v.x - 2 && b.maxX <= v.x + v.w + 2 &&
                      b.minY >= v.y - 2 && b.maxY <= v.y + v.h + 2,
              hoverD: __dbg.stack().hoverD,
              b: { minX: Math.round(b.minX), maxX: Math.round(b.maxX),
                   minY: Math.round(b.minY), maxY: Math.round(b.maxY) },
              v: { x: Math.round(v.x), y: v.y, w: Math.round(v.w), h: v.h }
            };
          }, aim8.fileIdx);
          ok(hr.exp != null && hr.exp >= 0.5, `s8-${tag8}-hover-exposed>=half`,
            { exp: hr.exp == null ? null : +hr.exp.toFixed(3), hoverD: hr.hoverD });
          ok(hr.inView, `s8-${tag8}-hover-noclip`, { b: hr.b, v: hr.v });
          const pick8 = await pg.evaluate(p => __dbg.pickAt(p.x, p.y), pt8);
          ok(pick8 && pick8.fileIdx === aim8.fileIdx, `s8-${tag8}-hover-pick-match`,
            pick8 ? { want: aim8.fileIdx, got: pick8.fileIdx } : { want: aim8.fileIdx, got: null });
          await shot('v6-' + tag8 + '-hover', pg);
          const v8r = await pg.evaluate(() => __dbg.viewRect());
          await pg.mouse.move(v8r.x + 24, v8r.y + 34, { steps: 3 });
          await sleep(600);
        }
      }

      // resize 平滑重新取景：縮到 70%×85%，沉澱後仍要在寬度帶且不切邊
      await pg.setViewportSize({ width: Math.round(w8 * 0.7), height: Math.round(h8 * 0.85) });
      await sleep(1600);
      const m2 = await evalDprMetrics(pg);
      ok(m2.frontRatio >= 0.80 && m2.frontRatio <= 0.90, `s8-${tag8}-resize-frontwidth-band`,
        { fw: +m2.frontRatio.toFixed(3) });
      ok(m2.bounds && m2.bounds.minX >= m2.v.x - 2 && m2.bounds.maxX <= m2.v.x + m2.v.w + 2 &&
         m2.bounds.minY >= m2.v.y - 2 && m2.bounds.maxY <= m2.v.y + m2.v.h + 2,
        `s8-${tag8}-resize-noclip`);
      await ctx8.close();
    }

    // ============ S7：真實資料夾 cae @ DPR 1.15 / 1670×777（v5 截圖）============
    if (fs.existsSync(CAE)) {
      const ctxC = await browser.newContext({
        viewport: { width: 1670, height: 777 }, deviceScaleFactor: 1.15 });
      const pg = await ctxC.newPage();
      watchPage(pg);
      await pg.goto(BASE + '/', { waitUntil: 'networkidle' });
      await pg.waitForFunction(() => window.__dbg && __dbg.ready(), null, { timeout: 9000 });
      await sleep(400);
      await lockFolderIdle(CAE, pg);
      const nFiles = await pg.evaluate(() => __dbg.stack().files);
      ok(nFiles >= 10, 'cae-md-loaded', { nFiles });
      await sleep(600);                                    // 首屏縮圖多畫幾張
      await shot('v5-01-cae-initial-1670x777-dpr115', pg);

      // 翻到中段停穩（當時出重複卡的位置）
      {
        const mid = await pg.evaluate(() => Math.floor(__dbg.stack().scrollMax * 0.45));
        const v = await pg.evaluate(() => __dbg.viewRect());
        await pg.mouse.move(v.x + v.w / 2, v.y + v.h / 2);
        for (let i = 0; i < 40; i++) {
          const cur = await pg.evaluate(() => __dbg.stack().scroll);
          if (cur >= mid - 0.6) break;
          await pg.mouse.wheel(0, 320);
          await sleep(60);
        }
        await pg.waitForFunction(
          () => { const s = __dbg.stack(); return s.scroll > s.scrollMax * 0.3 && s.scroll < s.scrollMax * 0.7; },
          null, { timeout: 9000 });
        await pg.waitForFunction(() => !__dbg.stack().rafRunning, null, { timeout: 9000 });
        await sleep(500);
        const slots = await pg.evaluate(() => __dbg.slotTex());
        const mism = slots.filter(s => s.texName && s.texName !== s.name);
        ok(mism.length === 0, 'cae-midscroll-tex-identity', mism.slice(0, 3));
        const names = slots.map(s => s.name);
        ok(new Set(names).size === names.length, 'cae-midscroll-no-dup-names', { names });
        await shot('v5-02-cae-midscroll-settled', pg);
      }

      // hover 撥開（120ms 延遲）＋FPS
      {
        const vc = await pg.evaluate(() => {
          const c = __dbg.visibleCards().find(x => x.fileIdx === Math.round(__dbg.stack().scroll));
          return c || __dbg.visibleCards()[0];
        });
        await pg.mouse.move(vc.x, vc.y, { steps: 6 });
        await sleep(300);                                // 讓第一個 hover 波起跑
        await pg.evaluate(() => __dbg.resetFps());       // 清 ring：只量這段互動，不含前面的靜止空檔
        const t0 = Date.now();
        let lo = false;
        while (Date.now() - t0 < 2000) {                  // 順便測 DPR1.15 下的 FPS
          await pg.mouse.move(vc.x + (lo ? 30 : -30), vc.y + (lo ? 20 : -20), { steps: 2 });
          lo = !lo;
          // 節流 ≈60Hz：真實滑鼠回報率（rAF 也不同步更多）。不睡時 Playwright 一圈噴 ~400+ 次
          // pointermove，每次都 raycast + 排程重繪 → 主執行緒被餵飽而掉幀（量到 ~48）。
          await sleep(17);
        }
        // fps 要在波浪還在燒的當下讀：fpsRing 是「最近 3 秒內的幀時間戳」，
        // 之後的 sleep/點開面板/截圖空檔（raf 停走）會被算進分母把值灌水稀釋（曾量到 48）。
        // 這裡緊跟抖動迴圈立刻讀＝互動期間的真實幀率。
        const fpsC = await pg.evaluate(() => __dbg.avgFps());
        results.perf.caeHoverFps = fpsC;
        ok(fpsC >= 55, 'cae-fps-55', { fps: fpsC });
        await pg.evaluate(p => __dbg.pickAt(p.x, p.y), vc);  // poke
        await sleep(800);
        const hd = await pg.evaluate(() => __dbg.stack().hoverD);
        ok(hd != null, 'cae-hover-parts', { hoverD: hd });
        await shot('v5-03-cae-hover-parted', pg);
        const v2 = await pg.evaluate(() => __dbg.viewRect());
        await pg.mouse.move(v2.x + 20, v2.y + 30, { steps: 4 });
        await sleep(500);
      }

      // 點 A 開 B（真實重現點）：卡被撥開抽高、上半部往後彎、前卡被推開後，游標停在
      // 某張卡上直接左鍵 → 必須開「被撥開的那張」，不是 raycast 打未變形平面命中的前一張。
      {
        const v = await pg.evaluate(() => __dbg.viewRect());
        await pg.mouse.move(v.x + 20, v.y + 30, { steps: 4 });
        await sleep(700);
        const list = await pg.evaluate(() => __dbg.visibleCards().filter(c => c.mode === 'home'));
        ok(list.length >= 4, 'pickA-openB-cards-visible', { n: list.length });
        let done = false;
        for (let k = 1; k < Math.min(list.length - 1, 6) && !done; k++) {
          const c = list[k];
          await pg.mouse.move(v.x + 20, v.y + 30, { steps: 4 });
          await sleep(650);
          await pg.mouse.move(c.x, c.y, { steps: 8 });
          let active = true;
          try {
            await pg.waitForFunction(() => __dbg.stack().hoverD != null, null, { timeout: 4000 });
          } catch (_) { active = false; }
          await sleep(400);                        // 等撥開動畫把命中區拉離指標
          const st = await pg.evaluate(a => {
            const s = __dbg.stack(), nm = __dbg.fileNames();
            const i = s.hoverD == null ? -1 : Math.round(s.scroll + s.hoverD);
            const pick = __dbg.pickAt(a.x, a.y);
            return { hoverName: i < 0 ? null : nm[i], pickName: pick && pick.name, i };
          }, c);
          if (!active || st.hoverName == null) continue;
          ok(true, 'hover-then-click-hover-active', st);
          await pg.mouse.down();
          await sleep(70);
          await pg.mouse.up();
          try {
            await pg.waitForFunction(() => __dbg.panel().shown === true, null, { timeout: 6000 });
            const title = await pg.evaluate(() => document.getElementById('readerTitle').textContent);
            ok(title === st.hoverName, 'click-opens-hovered-card',
               { hoverName: st.hoverName, title, raycastName: st.pickName });
          } finally {
            if (await pg.evaluate(() => __dbg.panel().shown === true)) await escPutBack(pg);
            done = true;
          }
        }
      }

      // 點開三欄：畫面檔名 = 面板標題
      {
        const fr = await pg.evaluate(() => Math.round(__dbg.stack().scroll));
        const name = await pg.evaluate(i => {
          const c = __dbg.visibleCards().find(x => x.fileIdx === i);
          return c ? c.name : null;
        }, fr);
        const res = await realOpenCard(pg, fr);
        ok(res.ok, 'cae-open-front-card', res.ok ? undefined : res);
        if (res.ok) {
          await sleep(1100);
          const panelFile = await pg.evaluate(() => __dbg.panel().file);
          ok(panelFile === name, 'cae-open-shows-same-file', { card: name, panel: panelFile });
          await shot('v5-04-cae-threecol-read', pg);
          await escPutBack(pg);
        }
      }
      await ctxC.close();
    } else {
      console.log('skip S7: ' + CAE + ' not found');
    }
    // ============ S9：雙分隔線（coordinator 追加 C）============
    // ① twocol 拖 splitter1 改樹寬（GL 對齊、樹最小 ~200px、dblclick 回預設 0.15）
    // ② 三欄拖 splitter2 即時兩欄連動＋卡堆重新置中＋前排寬帶重算，拖動中禁止選取
    // ③ 卡堆欄最小 ~200px（1366 下不會到 90% → 維持三欄）  ④ ↺ 還原使用者上次比例
    // ⑤ dblclick splitter2 回預設各半  ⑥ 比例存 localStorage，重整後沿用
    {
      const ctx9 = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
      const pg = await ctx9.newPage();
      watchPage(pg);
      await pg.goto(BASE + '/', { waitUntil: 'networkidle' });
      await pg.waitForFunction(() => window.__dbg && __dbg.ready(), null, { timeout: 9000 });
      await sleep(400);
      await lockFolderIdle(P.size20, pg);

      ok((await pg.evaluate(() => getComputedStyle(document.getElementById('splitter2')).display)) === 'none',
        's9-splitter2-hidden-twocol');
      ok((await pg.evaluate(() => getComputedStyle(document.getElementById('splitter2')).cursor)) === 'col-resize',
        's9-splitter2-cursor');

      const y9 = 400;
      const sp1 = await pg.locator('#splitter').boundingBox();
      ok(!!sp1, 's9-splitter1-visible');
      if (sp1) {
        const t0f = (await pg.evaluate(() => __dbg.fracs())).tree;
        await pg.mouse.move(sp1.x + 3, y9);
        await pg.mouse.down();
        await pg.mouse.move(sp1.x + 103, y9, { steps: 8 });
        const usDrag = await pg.evaluate(() => getComputedStyle(document.body).userSelect);
        await pg.mouse.up();
        await sleep(350);
        const t1f = (await pg.evaluate(() => __dbg.fracs())).tree;
        ok(Math.abs(t1f - t0f) > 0.02, 's9-splitter1-drag-resizes', { from: t0f, to: t1f });
        ok(usDrag === 'none', 's9-drag-user-select-none', { userSelect: usDrag });
        const al = await pg.evaluate(() => ({
          gl: Math.round(__dbg.viewGL().x),
          sp: Math.round(document.getElementById('splitter').getBoundingClientRect().right) }));
        ok(Math.abs(al.gl - al.sp) <= 3, 's9-splitter1-gl-aligns', al);
        // 樹最小 ~200px：重新取框再拖（板上釘釘對準分隔線，不用舊座標）
        const sp1b = await pg.locator('#splitter').boundingBox();
        await pg.mouse.move(sp1b.x + 3, y9);
        await pg.mouse.down();
        await pg.mouse.move(30, y9, { steps: 6 });
        await pg.mouse.up();
        await sleep(250);
        const tw9 = await pg.evaluate(() => __dbg.fracs().tree * innerWidth);
        ok(tw9 >= 190 && tw9 <= 232, 's9-tree-min-200px', { treePx: Math.round(tw9) });
        // dblclick → 回預設 0.15（同樣重新取框）
        const sp1c = await pg.locator('#splitter').boundingBox();
        await pg.mouse.dblclick(sp1c.x + 3, y9);
        await sleep(350);
        const td = await pg.evaluate(() => __dbg.fracs().tree);
        ok(Math.abs(td - 0.15) < 0.02, 's9-splitter1-dblclick-default', { tree: +td.toFixed(3) });
        // 防呆：前述拖動若誤觸樹列預覽換了資料夾，重新鎖回 size20 再進三欄段
        await lockFolderIdle(P.size20, pg);
      }

      // 進三欄 → splitter2 出現
      const res9 = await realOpenCard(pg, 0);
      ok(res9.ok && res9.mode === 'threecol', 's9-open-threecol', res9.ok ? undefined : res9);
      await sleep(900);
      ok((await pg.evaluate(() => getComputedStyle(document.getElementById('splitter2')).display)) !== 'none',
        's9-splitter2-visible-threecol');
      const sp2 = await pg.locator('#splitter2').boundingBox();
      ok(!!sp2, 's9-splitter2-bbox');
      if (sp2) {
        const fr0 = await pg.evaluate(() => __dbg.fracs());
        // 拖右 120px：閱讀面板變窄、卡堆變寬
        await pg.mouse.move(sp2.x + 3, y9);
        await pg.mouse.down();
        await pg.mouse.move(sp2.x + 123, y9, { steps: 10 });
        await pg.mouse.up();
        await sleep(500);
        const fr1 = await pg.evaluate(() => __dbg.fracs());
        ok(fr1.view > fr0.view + 0.03 && fr1.reader < fr0.reader - 0.03, 's9-splitter2-drag-rebalance',
          { v0: +fr0.view.toFixed(3), v1: +fr1.view.toFixed(3), r0: +fr0.reader.toFixed(3), r1: +fr1.reader.toFixed(3) });
        await assertThreecolFraming(pg, 's9-after-drag2');
        const mm9 = await evalDprMetrics(pg);
        ok(mm9.frontRatio >= 0.80 && mm9.frontRatio <= 0.90, 's9-frontwidth-after-drag2',
          { fw: +mm9.frontRatio.toFixed(3) });

        // 拖到卡堆欄最小 ~200px：1366 右區 ~910px → 閱讀面板 ~78% < 90% → 仍三欄
        const sp2b = await pg.locator('#splitter2').boundingBox();
        await pg.mouse.move(sp2b.x + 3, y9);
        await pg.mouse.down();
        await pg.mouse.move(sp2b.x - 700, y9, { steps: 10 });
        await pg.mouse.up();
        await sleep(500);
        const fr2 = await pg.evaluate(() => __dbg.fracs());
        const mode9 = await pg.evaluate(() => __dbg.mode());
        ok(mode9 === 'threecol' && fr2.view * 1366 >= 198, 's9-view-min-200px',
          { mode: mode9, viewPx: Math.round(fr2.view * 1366), readerPx: Math.round(fr2.reader * 1366) });

        // ↺ 還原使用者上次比例（剛拖到最小的那個，已存 localStorage）
        await pg.evaluate(() => __dbg.setMode('threecol')); // btnThree 已廢（1a50c24 單鈕輪切），等價動作
        await pg.waitForFunction(() => __dbg.mode() === 'threecol', null, 6000);
        await sleep(700);
        const fr2b = await pg.evaluate(() => __dbg.fracs());
        ok(Math.abs(fr2b.view - fr2.view) < 0.02, 's9-restore-keeps-user-frac',
          { view: +fr2.view.toFixed(3), restored: +fr2b.view.toFixed(3) });

        // dblclick splitter2 → 回預設各半
        const sp2c = await pg.locator('#splitter2').boundingBox();
        await pg.mouse.dblclick(sp2c.x + 3, y9);
        await sleep(500);
        const fr3 = await pg.evaluate(() => __dbg.fracs());
        ok(Math.abs(fr3.view - (1 - fr3.tree) / 2) < 0.015, 's9-dblclick-default-split',
          { view: +fr3.view.toFixed(3), expectHalf: +(((1 - fr3.tree) / 2)).toFixed(3) });

        // 比例存 localStorage：拖一個非預設比例 → 重整 → 再開卡仍是它
        const sp2d = await pg.locator('#splitter2').boundingBox();
        await pg.mouse.move(sp2d.x + 3, y9);
        await pg.mouse.down();
        await pg.mouse.move(sp2d.x + 93, y9, { steps: 8 });
        await pg.mouse.up();
        await sleep(500);
        const kept = (await pg.evaluate(() => __dbg.fracs())).view;
        await escPutBack(pg);
        await pg.reload({ waitUntil: 'networkidle' });
        await pg.waitForFunction(() => window.__dbg && __dbg.ready(), null, { timeout: 9000 });
        await sleep(400);
        await lockFolderIdle(P.size20, pg);
        const res9b = await realOpenCard(pg, 0);
        ok(res9b.ok, 's9-reopen-after-reload', res9b.ok ? undefined : res9b);
        await pg.waitForFunction(() => __dbg.mode() === 'threecol', null, 6000);
        await sleep(900);
        const fr4 = await pg.evaluate(() => __dbg.fracs());
        ok(Math.abs(fr4.view - kept) < 0.02, 's9-ratio-persists-reload',
          { saved: +kept.toFixed(3), after: +fr4.view.toFixed(3) });
        await escPutBack(pg);
      }
      await ctx9.close();
    }

    // 3440×1440 超寬：閱讀面板拖到 ≥右區 90% → 視同 2/3 模式（檔案堆隱藏），↺ 可回
    {
      const ctx9w = await browser.newContext({ viewport: { width: 3440, height: 1440 }, deviceScaleFactor: 1 });
      const pg = await ctx9w.newPage();
      watchPage(pg);
      await pg.goto(BASE + '/', { waitUntil: 'networkidle' });
      await pg.waitForFunction(() => window.__dbg && __dbg.ready(), null, { timeout: 9000 });
      await sleep(400);
      await lockFolderIdle(P.size20, pg);
      const res9w = await realOpenCard(pg, 0);
      ok(res9w.ok, 's9w-open-threecol', res9w.ok ? undefined : res9w);
      await sleep(900);
      const sp2w = await pg.locator('#splitter2').boundingBox();
      ok(!!sp2w, 's9w-splitter2-bbox');
      if (sp2w) {
        const yw = 700;
        await pg.mouse.move(sp2w.x + 3, yw);
        await pg.mouse.down();
        // 拖到樹緣：卡堆欄被夾 200px，右區 ~2293px → 閱讀面板 ~91% ≥ 90% → wide
        await pg.mouse.move(sp2w.x - 2200, yw, { steps: 12 });
        await sleep(350);
        await pg.mouse.up();
        await sleep(600);
        const mw = await pg.evaluate(() => ({ mode: __dbg.mode(), fr: __dbg.fracs() }));
        ok(mw.mode === 'wide' && mw.fr.view === 0, 's9w-90pct-goes-wide',
          { mode: mw.mode, view: +mw.fr.view.toFixed(3), reader: +mw.fr.reader.toFixed(3) });
        ok((await pg.evaluate(() => getComputedStyle(document.getElementById('splitter2')).display)) === 'none',
          's9w-splitter2-hidden-wide');
        await shot('v6-3440-drag-to-wide', pg);
        // ↺ 回三欄（使用者上次比例）
        await pg.evaluate(() => __dbg.setMode('threecol')); // btnThree 已廢（1a50c24 單鈕輪切），等價動作
        await pg.waitForFunction(() => __dbg.mode() === 'threecol', null, 6000);
        await sleep(700);
        ok((await pg.evaluate(() => __dbg.fracs())).view > 0.001, 's9w-restore-back-threecol');
        await escPutBack(pg);
      }
      await ctx9w.close();
    }
  } catch (err) {
    results.fatal = String((err && err.stack) || err);
    failed++;
  } finally {
    await browser.close();
    server.kill();
    try { fs.rmSync(path.join(FIX, '_test-config.json'), { force: true }); } catch (_) {}
  }

  ok(results.consoleErrors.length === 0, 'zero-console-errors', results.consoleErrors.slice(0, 5));
  console.log('\n==== RESULT ====');
  console.log(JSON.stringify(results, null, 2));
  process.exit((results.fatal || failed > 0) ? 1 : 0);
}

main();
