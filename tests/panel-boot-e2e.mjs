// tests/panel-boot-e2e.mjs — the side-panel open must not stutter or yank the stack.
// Bug (owner report): switching to side-panel mode stutters for 1–2 s, the 3D cards
// don't answer the wheel, and then the stack is force-pulled back to the first card.
// Root causes fixed: (1) panel boot with ?tabs=1 used to paint "today's AI files" first
// (setFolder #1) and then swap to the tab stack (setFolder #2 → scroll reset to 0),
// (2) the ?tabfocus= jump stayed pending past the user's first scroll, so a late
// extension push re-applied it and snapped the user to the front.
// Port 5197 (tests stay in 5190–5199; 5177 is the user's live instance).
// Usage: node tests/panel-boot-e2e.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5197;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const pageErrors = [];
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

// ---------------------------------------------------------------- fixture
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-pboot-'));
const RD = p => path.join(TMP, ...p.split('/'));
const handoffPath = RD('root/handoff.md');
fs.mkdirSync(RD('root'), { recursive: true });
fs.mkdirSync(RD('convos'), { recursive: true });
fs.writeFileSync(handoffPath, '# handoff\n側欄開局落點測試：今天 AI 給的檔。\n');
fs.writeFileSync(RD('root/readme.md'), '# boot fixture\n只是讓根目錄不為空\n');
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

// ---- simulated extension ----
const EXT_TOKEN = 'e'.repeat(48);
const EXT_HEADERS = { 'X-RiffleDesk-Ext': '1', 'X-RiffleDesk-Token': EXT_TOKEN };
async function pushTabs(tabs) {
  const r = await fetch(BASE + '/api/tabs', {
    method: 'POST', headers: { ...EXT_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ tabs })
  });
  return r.status;
}

const BASE_T = Date.now();
const mkTab = (id, i, over) => ({
  id, windowId: 1,
  title: '開局測試分頁 Boot Tab ' + (i + 1),
  url: 'https://boot' + i + '.example.com/page?i=' + i,
  fav: '', active: false, lastAccessed: BASE_T - i * 60000 - 60000, ...(over || {})
});
// 21 tabs; active flag on the newest one. ids 700..720 (+ 799 for the late-arrival test)
const T21 = Array.from({ length: 21 }, (_, i) => mkTab(700 + i, i, i === 0 ? { active: true, lastAccessed: BASE_T - 30000 } : {}));

let server = null;
let browser = null;

// sample scrollCur for `ms` and report the rounded positions seen — used to prove the
// stack never gets yanked back to 0 after a push.
async function samplePositions(page, ms) {
  return page.evaluate(async dur => {
    const st = window.__dbg.scene();
    const seen = new Set(); const front = new Set();
    const t0 = performance.now();
    while (performance.now() - t0 < dur) {
      seen.add(Math.round(st.scrollCur));
      const f = st.view[Math.round(st.scrollCur)];
      if (f && f.tab) front.add(f.tab.id);
      await new Promise(r => setTimeout(r, 40));
    }
    return { positions: [...seen].sort((a, b) => a - b), frontIds: [...front] };
  }, ms);
}

async function settle(page) {
  await page.waitForFunction(() => {
    const st = window.__dbg.scene();
    return Math.abs(st.scrollTarget - st.scrollCur) < 0.01 && Math.abs(st.scrollVel) < 0.05;
  }, null, { timeout: 10000 });
}

async function wheelTo(page, target) {
  for (let i = 0; i < target + 6; i++) {
    const cur = await page.evaluate(() => Math.round(window.__dbg.scene().scrollTarget));
    if (cur >= target) break;
    await page.evaluate(() => document.getElementById('gl')
      .dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })));
    await sleep(140);
  }
  await page.waitForFunction(t => Math.round(window.__dbg.scene().scrollCur) === t, target, { timeout: 10000 });
  await settle(page);
}

async function newPanelPage(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.addInitScript(() => {
    window.__lt = [];
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) window.__lt.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
      }).observe({ entryTypes: ['longtask'] });
    } catch (_) { window.__ltUnsupported = true; }
  });
  await page.goto(url);
  return { ctx, page };
}

async function main() {
  server = await startServer();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  ok(await pushTabs(T21) === 200, 'fixture: 21 tabs pushed before any panel opens');

  // ---------- 1. tabs boot is immediate: cards first, wheel answers, no file stack first
  {
    const { ctx, page } = await newPanelPage(browser, BASE + '/?mode=panel&tabs=1');
    // 開局錄影：每 25ms 記一次「卡堆現在是什麼」——old bug 會先看到檔案堆再換分頁堆
    await page.evaluate(() => {
      window.__bootFolders = [];
      const t0 = performance.now();
      const tick = () => {
        if (performance.now() - t0 > 4000) return;
        try {
          const d = window.__dbg.stack();
          window.__bootFolders.push({ ms: Math.round(performance.now()), folder: d.folder, files: d.files });
        } catch (_) {}
        setTimeout(tick, 25);
      };
      tick();
    });
    await page.waitForFunction(() => window.__dbg && window.__dbg.tabs().active && window.__dbg.stack().files === 21,
      null, { timeout: 15000 });
    const landing = await page.evaluate(() => {
      const b = window.__bootFolders.filter(x => x.files > 0);
      return { firstNonEmpty: b[0] || null, all: b.slice(0, 8) };
    });
    ok(landing.firstNonEmpty && landing.firstNonEmpty.folder === 'tabs',
      'the first non-empty stack IS the tab stack (no file-stack detour)', landing.firstNonEmpty);

    // 從 +200ms 起連續滾輪（真使用者會一路滾）：第一次可見移動要早、卡堆在就要 300ms 內動
    const inter = await page.evaluate(async () => {
      const st = window.__dbg.scene();
      const t0 = performance.now();
      let firstMoveMs = null;      // 從第一個滾輪事件算起，第一次看到移動
      const moves = [];
      while (performance.now() - t0 < 200 && !(st.view.length > 0)) await new Promise(r => setTimeout(r, 10));
      // +200ms 開始滾（若卡已上就直接滾）
      let wheels = 0;
      while (firstMoveMs == null && performance.now() - t0 < 4000) {
        const tW = performance.now();
        document.getElementById('gl').dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
        wheels++;
        // 等這個滾輪的反應（最多 120ms 再看下一個事件）
        const pre = st.scrollCur;
        let reacted = null;
        for (let i = 0; i < 24; i++) {
          await new Promise(r => setTimeout(r, 10));
          if (Math.abs(st.scrollCur - pre) > 0.003 || Math.abs(st.scrollCur) > 0.003) { reacted = Math.round(performance.now() - tW); break; }
        }
        if (st.view.length > 0 && reacted != null) {
          moves.push(reacted);
          if (firstMoveMs == null) firstMoveMs = Math.round(performance.now() - t0);
        }
      }
      const lt = (window.__lt || []).filter(e => e.start < 2000);
      return { firstMoveMs, moves, wheels, cardsAt200: st.view.length, longtasks: lt,
               unsupported: !!window.__ltUnsupported };
    });
    console.log('interactivity numbers:', JSON.stringify(inter));
    ok(!inter.unsupported, 'longtask observer supported');
    ok(inter.firstMoveMs != null && inter.firstMoveMs <= 500,
      'started wheeling at +200ms; the stack moved within 300ms of that wheel', { firstMoveMs: inter.firstMoveMs });
    ok(!inter.moves.some(m => m > 300), 'every wheel after the cards landed moves the stack within 300ms', inter.moves);
    ok(!inter.longtasks.some(e => e.dur > 100), 'no long task >100ms in the first 2s', inter.longtasks);

    // 落點（背景補課）：今天的 AI 檔或第一個根——重點是「算好了一個落點」；
    // 哪一列取決於對話掃描結果（fixture 的假對話在 /api/recent 可能回空）
    await page.waitForFunction(() => window.__dbg && window.__dbg.tabs().returnKind != null,
      null, { timeout: 10000 }).catch(() => {});
    const rk = await page.evaluate(() => window.__dbg.tabs().returnKind);
    ok(rk === 'crow' || rk === 'folder', 'background landing ready: exit target is decided', rk);

    // ---------- 2. after the user scrolled, a fresh list push must not move the front card
    await wheelTo(page, 8);
    const at8 = await page.evaluate(() => {
      const st = window.__dbg.scene();
      const i = Math.round(st.scrollCur);
      return { idx: i, id: st.view[i].tab.id };
    });
    ok(at8.idx === 8, 'wheeling reached card 8', at8);
    const pushR = await pushTabs(T21.map(tb => tb.id === at8.id
      ? { ...tb, title: tb.title + '（標題改了 title changed）' } : tb));
    ok(pushR === 200, 'sig-changing push accepted');
    await page.waitForFunction(() => window.__dbg.scene().view.some(f => f.tab && f.tab.id === 708 &&
      /title changed/.test(f.tab.title)), null, { timeout: 8000 }).catch(() => {});
    const during = await samplePositions(page, 1600);
    const after = await page.evaluate(() => {
      const st = window.__dbg.scene();
      const i = Math.round(st.scrollCur);
      return { idx: i, id: st.view[i] && st.view[i].tab && st.view[i].tab.id };
    });
    ok(after.idx === 8 && after.id === at8.id, 'fresh list push: front card kept (same tab id)', after);
    ok(!during.positions.includes(0), 'the stack never snapped back to card 0 after user scroll', during);
    await ctx.close();
  }

  // ---------- 3. delayed first list, tabfocus present, user could NOT scroll yet → jump once
  {
    ok(await pushTabs([]) === 200, 'server list cleared (extension alive, zero tabs)');
    const { ctx, page } = await newPanelPage(browser, BASE + '/?mode=panel&tabs=1&tabfocus=710');
    await sleep(700);   // 清單還沒有：這段時間滾輪沒東西可滾（不算互動）
    const landed = await page.evaluate(() => {
      document.getElementById('gl').dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true, cancelable: true }));
      return Math.round(window.__dbg.scene().scrollTarget);
    });
    ok(landed === 0, 'wheeling the empty pre-list stack can not move anything', landed);
    // 清單姍姍來遲（800ms 後才推）：tabfocus 710 在裡面，使用者沒滾走 → 定到 710 那張
    setTimeout(() => pushTabs(T21).catch(() => {}), 800);
    await page.waitForFunction(() => window.__dbg && window.__dbg.tabs().bootFocus == null && window.__dbg.stack().files === 21,
      null, { timeout: 15000 });
    await settle(page);
    const pos = await page.evaluate(() => {
      const st = window.__dbg.scene();
      const i = Math.round(st.scrollCur);
      return { idx: i, id: st.view[i] && st.view[i].tab && st.view[i].tab.id, bootFocus: window.__dbg.tabs().bootFocus };
    });
    ok(pos.id === 710 && pos.bootFocus == null,
      'delayed first list with tabfocus: lands on the focused tab exactly once', pos);
    // 再推一次（內容真的變了 → 真的會重套用清單）→ 定好的位置不能再跳
    ok(await pushTabs(T21.map(tb => tb.id === 710 ? { ...tb, title: tb.title + ' v2' } : tb)) === 200,
      'second push with real content change accepted');
    await page.waitForFunction(() => window.__dbg.scene().view.some(f => f.tab && / v2$/.test(f.tab.title)),
      null, { timeout: 8000 }).catch(() => {});
    const again = await samplePositions(page, 1200).then(async s => ({
      s, a: await page.evaluate(() => {
        const st = window.__dbg.scene();
        const i = Math.round(st.scrollCur);
        return { idx: i, id: st.view[i].tab.id };
      })
    }));
    ok(again.a.id === 710, 'a later push keeps the boot-focused card', again.a);
    await ctx.close();
  }

  // ---------- 4. THE bug: tabfocus not in the first list; user scrolls; tab arrives later
  {
    ok(await pushTabs(T21) === 200, 'fixture restored: 21 tabs, no 799 yet');
    const { ctx, page } = await newPanelPage(browser, BASE + '/?mode=panel&tabs=1&tabfocus=799');
    await page.waitForFunction(() => window.__dbg && window.__dbg.stack().files === 21, null, { timeout: 15000 });
    // 使用者卡在 799 還沒進清單前就開始翻（舊碼會在 799 晚到時把他拉回第一張）
    await wheelTo(page, 6);
    const at6 = await page.evaluate(() => {
      const st = window.__dbg.scene();
      const i = Math.round(st.scrollCur);
      return { idx: i, id: st.view[i].tab.id };
    });
    // 799 此刻才進清單（新分頁、最新 mtime → 插到最前面）
    ok(await pushTabs([mkTab(799, -1, { active: true, lastAccessed: Date.now() }), ...T21]) === 200,
      '799 arrives late (new tab push)');
    await page.waitForFunction(() => window.__dbg && window.__dbg.stack().files === 22, null, { timeout: 10000 });
    const during = await samplePositions(page, 1600);
    const after = await page.evaluate(() => {
      const st = window.__dbg.scene();
      const i = Math.round(st.scrollCur);
      return { idx: i, id: st.view[i] && st.view[i].tab && st.view[i].tab.id,
               firstId: st.view[0] && st.view[0].tab && st.view[0].tab.id,
               bootFocus: window.__dbg.tabs().bootFocus };
    });
    ok(after.firstId === 799, '799 inserted at the front of the frozen order', after);
    ok(after.id === at6.id && after.idx >= 5, 'late tabfocus after user scroll: front card kept, NO snap to 0', after);
    ok(after.bootFocus == null, 'boot focus dropped once the user scrolled', after);
    ok(!during.positions.includes(0), 'never returned to card 0 while 799 landed', during);
    await ctx.close();
  }

  ok(pageErrors.length === 0, 'no page errors', pageErrors.slice(0, 5));
}

main().then(() => {
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall panel-boot checks passed');
}).catch(e => {
  console.error('FATAL', e);
  failed++;
}).finally(async () => {
  try { if (browser) await browser.close(); } catch (_) {}
  try { if (server) server.kill(); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed ? 1 : 0);
});
