// tests/view-restore-e2e.mjs — closing the reader (or otherwise growing the card
// column back) must land the camera on the user's saved "My view", falling back
// to the default view when none is saved. Covers: reader close, left-column
// collapse + expand, fullscreen in/out and window resize, and checks the move is
// damped (several frames) rather than a jump.
// Port 5193 (never 5177/5179/5189/5190-5192). Own throwaway fixtures; headless.
// Usage: node tests/view-restore-e2e.mjs
// CSP note: waitForFunction predicates go through window.__dbg.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5193;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// default view (stack.js POSE_PITCH / orbit defaults)
const DEFAULT_ORBIT = { yaw: 0, pitch: 41.03, zoom: 1 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const consoleErrors = [];
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-viewrestore-'));
const RD = p => path.join(TMP, ...p.split('/'));
function buildFixtures() {
  fs.mkdirSync(RD('root'), { recursive: true });
  for (let i = 0; i < 6; i++) fs.writeFileSync(RD(`root/note-${i}.md`), `# note ${i}\n\nbody\n`);
}
const CFG = path.join(TMP, 'config.json');

function startServer() {
  fs.writeFileSync(CFG, JSON.stringify({ roots: [RD('root')], pinned: [], convoRoots: [] }, null, 2));
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: CFG, RIFFLEDESK_INDEX: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  return new Promise((res, rej) => {
    let out = '';
    const to = setTimeout(() => rej(new Error('server start timeout: ' + out)), 12000);
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) { clearTimeout(to); res(proc); } });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', c => rej(new Error('server exited ' + c + ': ' + out)));
  });
}

// wait until the damped camera has arrived (fitCur == fitTarget) and is still
async function settle(page, ms = 1500) {
  await sleep(60);
  await page.waitForFunction(() => window.__dbg.fitGap() < 0.01, null, { timeout: 6000 })
    .catch(() => {});
  await sleep(ms);
}
const cam = page => page.evaluate(() => window.__dbg.camera());
const near = (a, b, eps) => Math.abs(a - b) <= eps;
function orbitNear(o, want, eps = 0.6) {
  return near(o.yaw, want.yaw, eps) && near(o.pitch, want.pitch, eps) && near(o.zoom, want.zoom, 0.02);
}
// camera must sit on the same place/target as a recorded reference (fit is stable
// in a settled layout, so a few hundredths of a world unit is noise)
function fitNear(a, b) {
  return near(a.dist, b.dist, 0.08)
    && a.target.every((v, i) => near(v, b.target[i], 0.08));
}

async function main() {
  buildFixtures();
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-gpu'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1, locale: 'zh-TW' });
    await ctx.addInitScript(() => {
      try { localStorage.setItem('riffleTipSeen', '1'); localStorage.setItem('floderLang', 'zh'); } catch (_) {}
    });
    const page = await ctx.newPage();
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const txt = m.text();
      if (txt.includes('/api/events') && txt.includes('ERR_ABORTED')) return;
      consoleErrors.push(txt.slice(0, 300));
    });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.__dbg && window.__dbg.ready()), null, { timeout: 15000 });
    await page.evaluate(x => window.__dbg.lockFolder(x), RD('root'));
    await page.waitForFunction(() => window.__dbg.stack().phase === 'idle', null, { timeout: 12000 });
    await sleep(700);
    ok((await page.evaluate(() => window.__dbg.stack().files)) === 6, 'fixture-loaded');

    // ---------------- A. saved My view is the landing spot ----------------
    // save a distinctive view through the real button
    await page.evaluate(() => window.__dbg.setOrbit(14, 55, 1.35));
    await settle(page, 500);
    await page.click('#btnViewSave');
    const fav = await page.evaluate(() => JSON.parse(localStorage.getItem('floderMyView')));
    ok(!!fav && near(fav.yaw, 14, 0.01) && near(fav.zoom, 1.35, 0.01), 'fav-saved', fav);

    // record where "My view" actually puts the camera in the closed (twocol) layout
    await page.evaluate(() => window.__dbg.setOrbit(0, 30, 0.8));
    await settle(page, 400);
    await page.click('#btnViewFav');
    await settle(page);
    const ref = await cam(page);
    ok(orbitNear(ref.orbit, fav, 0.01), 'fav-button-lands-orbit', ref.orbit);
    ok(ref.fit.dist > 0, 'fav-button-lands-camera');

    // mess the view up, open the reader (three columns), then close it
    await page.evaluate(() => window.__dbg.setOrbit(-22, 28, 0.75));
    await settle(page, 400);
    const wild = await cam(page);
    await page.evaluate(() => window.__dbg.openReader(0));
    await page.waitForFunction(() => window.__dbg.panel().shown === true, null, { timeout: 6000 });
    await settle(page, 700);
    ok((await page.evaluate(() => window.__dbg.mode())) === 'threecol', 'reader-opened-threecol');
    // opening the reader keeps the angle the user had at that moment
    ok(orbitNear((await cam(page)).orbit, wild.orbit, 0.6), 'open-reader-keeps-view');

    // close: sample the DAMPED camera every frame to prove the return glides, not snaps
    // (orbit itself is assigned at once; fitCur is what actually moves the camera)
    const frames = await page.evaluate(() => new Promise(resolve => {
      const out = [];
      window.__dbg.closeReader();
      const t0 = performance.now();
      const loop = () => {
        const c = window.__dbg.camera();
        out.push({ yaw: c.fit.yaw, dist: c.fit.dist, t: performance.now() - t0 });
        if (performance.now() - t0 < 1400) requestAnimationFrame(loop); else resolve(out);
      };
      requestAnimationFrame(loop);
    }));
    ok((await page.evaluate(() => window.__dbg.mode())) === 'twocol', 'reader-closed-twocol');
    await settle(page, 900);
    const after = await cam(page);
    ok(orbitNear(after.orbit, fav, 0.2), 'close-reader-restores-my-view', after.orbit);
    ok(fitNear(after.fit, ref.fit), 'close-reader-restores-camera', { after: after.fit, ref: ref.fit });
    const lo = Math.min(fav.yaw, wild.orbit.yaw), hi = Math.max(fav.yaw, wild.orbit.yaw);
    const intermediate = frames.filter(f => f.yaw > lo + 0.3 && f.yaw < hi - 0.3).length;
    ok(intermediate >= 3, 'close-reader-transition-is-damped', { frames: frames.length, intermediate });
    await page.screenshot({ path: path.join(SHOTS, 'view-after-close.png') });
    console.log('shot ' + path.join(SHOTS, 'view-after-close.png'));

    // ---------------- B. left column collapse + expand ----------------
    await page.evaluate(() => window.__dbg.setOrbit(-20, 27, 0.8));
    await settle(page, 400);
    await page.evaluate(() => window.__dbg.setTreeCollapsed(true));
    await settle(page);
    ok((await page.evaluate(() => window.__dbg.treeCollapsed())) === true, 'tree-collapsed');
    ok(orbitNear((await cam(page)).orbit, fav, 0.2), 'collapse-tree-restores-my-view');
    // collapsed tree is really hidden from focus/AT, and the toggle button says so
    ok(await page.evaluate(() => document.getElementById('tree').inert === true
      && document.getElementById('tree').getAttribute('aria-hidden') === 'true'), 'tree-collapsed-hidden-from-at');
    ok(await page.evaluate(() => document.getElementById('btnTree').getAttribute('aria-expanded') === 'false'),
      'tree-btn-aria-expanded-false');
    ok(await page.evaluate(() => document.getElementById('tree').style.display === 'none'),
      'tree-collapsed-not-rendered');
    // the mode class survives the body class juggling
    ok(await page.evaluate(() => document.body.classList.contains('mode-twocol')
      && document.body.classList.contains('tree-collapsed')), 'body-classes-kept');
    await page.evaluate(() => window.__dbg.setOrbit(-20, 27, 0.8));
    await settle(page, 400);
    await page.evaluate(() => window.__dbg.setTreeCollapsed(false));
    await settle(page);
    ok(orbitNear((await cam(page)).orbit, fav, 0.2), 'expand-tree-restores-my-view');
    ok(fitNear((await cam(page)).fit, ref.fit), 'expand-tree-restores-camera');
    ok(await page.evaluate(() => document.getElementById('tree').inert === false
      && document.getElementById('tree').getAttribute('aria-hidden') === 'false'), 'tree-expanded-visible-again');
    ok(await page.evaluate(() => document.body.classList.contains('mode-twocol')
      && !document.body.classList.contains('tree-collapsed')), 'body-classes-clean-after-expand');
    // expanding restores the width the user had before collapsing (not the default)
    const widthNow = await page.evaluate(() => document.getElementById('tree').getBoundingClientRect().width);
    ok(Math.abs(widthNow - 1500 / 3) < 40, 'expand-restores-previous-width', { widthNow });

    // collapse state persists across a reload
    await page.evaluate(() => window.__dbg.setTreeCollapsed(true));
    await sleep(200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.__dbg && window.__dbg.ready()), null, { timeout: 15000 });
    await sleep(400);
    ok((await page.evaluate(() => window.__dbg.treeCollapsed())) === true, 'collapse-persisted-after-reload');
    await page.evaluate(() => window.__dbg.setTreeCollapsed(false));
    await page.evaluate(x => window.__dbg.lockFolder(x), RD('root'));
    await settle(page, 900);

    // ---------------- C. fullscreen in / out ----------------
    await page.evaluate(() => window.__dbg.openReader(0));
    await page.waitForFunction(() => window.__dbg.panel().shown === true, null, { timeout: 6000 });
    await sleep(400);
    await page.evaluate(() => window.__dbg.setMode('full'));
    await settle(page, 500);
    ok((await page.evaluate(() => window.__dbg.mode())) === 'full', 'fullscreen-mode');
    await page.evaluate(() => window.__dbg.setMode('wide'));
    await settle(page, 400);
    await page.evaluate(() => window.__dbg.setOrbit(-24, 32, 0.9));
    await settle(page, 400);
    await page.keyboard.press('Escape');             // threecol
    await settle(page, 400);
    ok((await page.evaluate(() => window.__dbg.mode())) === 'threecol', 'fullscreen-back-threecol');
    await page.keyboard.press('Escape');             // put the reader away -> twocol
    await page.waitForFunction(() => window.__dbg.mode() === 'twocol', null, { timeout: 6000 });
    await settle(page, 900);
    ok(orbitNear((await cam(page)).orbit, fav, 0.2), 'leave-fullscreen-restores-my-view');

    // ---------------- D. window resize in a reader-less layout ----------------
    await page.evaluate(() => window.__dbg.setOrbit(-18, 29, 0.85));
    await settle(page, 400);
    await page.setViewportSize({ width: 1280, height: 820 });
    await settle(page, 1000);
    ok(orbitNear((await cam(page)).orbit, fav, 0.2), 'resize-restores-my-view');
    const resizedRef = await cam(page);
    ok(resizedRef.fit.dist > 0 && Math.abs(resizedRef.fit.dist - ref.fit.dist) > 0.01,
      'resize-refits-camera', { dist: resizedRef.fit.dist, before: ref.fit.dist });
    await page.setViewportSize({ width: 1500, height: 900 });
    await settle(page, 1000);

    // ---------------- E. no saved My view -> default view ----------------
    await page.evaluate(() => window.__dbg.clearFavView());
    await page.evaluate(() => window.__dbg.setOrbit(-20, 28, 0.78));
    await settle(page, 400);
    await page.evaluate(() => window.__dbg.openReader(0));
    await page.waitForFunction(() => window.__dbg.panel().shown === true, null, { timeout: 6000 });
    await sleep(400);
    await page.evaluate(() => window.__dbg.setOrbit(-26, 60, 1.6));
    await settle(page, 400);
    await page.evaluate(() => window.__dbg.closeReader());
    await settle(page, 900);
    const dflt = await cam(page);
    ok(orbitNear(dflt.orbit, DEFAULT_ORBIT, 0.2), 'no-fav-falls-back-to-default-view', dflt.orbit);

    ok(consoleErrors.length === 0, 'no-console-errors', consoleErrors.slice(0, 4));
  } finally {
    try { await browser.close(); } catch (_) {}
    try { server.kill(); } catch (_) {}
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exitCode = failed ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
