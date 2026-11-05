import { chromeExecutable } from './chrome-path.mjs';
// tests/wheel-speed-e2e.mjs — 滾輪依滾動量變速：滾一格＝一張；連滾 30 格＝前進 30 張、約 1.5 秒內到；
// 中途不丟格、停下時剛好落在整數張。埠 5190–5199 自挑。
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = chromeExecutable();
const N_CARDS = 120;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const ok = (c, tag, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); if (!c) failed++; };

async function freePort() {
  const { createServer } = await import('node:net');
  for (let p = 5190; p < 5200; p++) {
    const free = await new Promise(res => { const s = createServer(); s.once('error', () => res(false)); s.once('listening', () => s.close(() => res(true))); s.listen(p, '127.0.0.1'); });
    if (free) return p;
  }
  throw new Error('no free port');
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-wheel-'));
const DIR = path.join(TMP, 'root', 'cards');
fs.mkdirSync(DIR, { recursive: true });
const base = Date.now() - N_CARDS * 1000;
for (let i = 1; i <= N_CARDS; i++) {
  const f = path.join(DIR, `card-${String(i).padStart(3, '0')}.md`);
  fs.writeFileSync(f, `# card ${i}\n`);
  const t = new Date(base + i * 1000); fs.utimesSync(f, t, t);
}
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ roots: [path.join(TMP, 'root')], pinned: [] }));

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: path.join(TMP, 'config.json') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
await new Promise((res, rej) => { let out = ''; const to = setTimeout(() => rej(new Error('server timeout ' + out)), 20000); srv.stdout.on('data', d => { out += d; if (out.includes('listening')) { clearTimeout(to); res(); } }); });

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-gpu'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.setItem('riffleTipSeen', '1'); } catch (_) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__dbg && window.__dbg.ready()), null, { timeout: 20000 });
  await page.evaluate(p => __dbg.lockFolder(p), DIR);
  await page.waitForFunction(() => __dbg.stack().phase === 'idle', null, { timeout: 20000 });
  await sleep(800);

  // 送 n 格滾輪（每格 deltaY=100、間隔 gap ms），量走到哪、多久停穩
  const burst = (n, gap) => page.evaluate(async ({ n, gap }) => {
    const cv = document.getElementById('gl');
    const s0 = __dbg.stack().scroll;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      cv.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, gap));
    }
    const tSent = performance.now() - t0;
    await new Promise(res => {
      const loop = () => {
        const s = __dbg.stack();
        if (Math.abs(s.scroll - s.scrollTarget) < 0.01 && performance.now() - t0 > tSent + 200) res();
        else if (performance.now() - t0 > 8000) res();
        else requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    const s = __dbg.stack();
    return { from: s0, to: s.scroll, moved: Math.round(s.scroll - s0), ms: Math.round(performance.now() - t0), sendMs: Math.round(tSent) };
  }, { n, gap });

  const one = await burst(1, 0);
  ok(one.moved === 1, '滾一格＝走一張', one);
  await sleep(400);

  const fast = await burst(30, 15);   // 約半秒內連滾 30 格（滾三圈）
  ok(fast.moved === 30, '連滾 30 格＝前進 30 張（不丟格）', fast);
  ok(fast.ms - fast.sendMs <= 1500, '滾完後 1.5 秒內停穩', fast);
  ok(Number.isInteger(fast.to), '停在整數張', fast);
  await sleep(400);

  const back = await page.evaluate(() => __dbg.stack().scroll);
  const far = await page.evaluate(async () => {   // 一口氣滾 60 格：超過 SCROLL_JUMP 會瞬移再飛入
    const cv = document.getElementById('gl');
    for (let i = 0; i < 60; i++) cv.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    const t0 = performance.now();
    await new Promise(res => { const loop = () => { const s = __dbg.stack(); if (Math.abs(s.scroll - s.scrollTarget) < 0.01 || performance.now() - t0 > 8000) res(); else requestAnimationFrame(loop); }; requestAnimationFrame(loop); });
    return { to: __dbg.stack().scroll, ms: Math.round(performance.now() - t0) };
  });
  ok(Math.round(far.to - back) === 60 || far.to === await page.evaluate(() => __dbg.stack().scrollTarget), '連滾 60 格也全數走完', { back, ...far });
  ok(far.ms <= 2000, '60 格 2 秒內到', far);
  ok(errors.length === 0, 'no page errors', errors);
} finally {
  await browser.close();
  srv.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
