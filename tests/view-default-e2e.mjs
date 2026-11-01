// tests/view-default-e2e.mjs — startup view + the conditional "save / back to my
// view" prompt bar. Covers:
//   * no saved view -> default view on load, and no view bar
//   * turning the camera -> the save button appears
//   * pressing save -> the bar goes away
//   * reload -> the camera is the saved view
//   * turn again without saving, reload -> still the saved view
//   * the toolbar default-view button -> back to the default camera, bar appears
// Port 5197 (never 5177/5179/5189/5190-5192). Own throwaway fixtures; headless.
// Usage: node tests/view-default-e2e.mjs
// CSP note: predicates go through window.__dbg.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5197;
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-viewdefault-'));
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

// wait until the damped camera has arrived and things are quiet
async function settle(page, ms = 1200) {
  await sleep(60);
  await page.waitForFunction(() => window.__dbg.fitGap() < 0.01, null, { timeout: 6000 }).catch(() => {});
  await sleep(ms);
}
const cam = page => page.evaluate(() => window.__dbg.camera());
const viewState = page => page.evaluate(() => window.__dbg.viewState());
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const orbitNear = (o, want, eps = 0.6) =>
  near(o.yaw, want.yaw, eps) && near(o.pitch, want.pitch, eps) && near(o.zoom, want.zoom, 0.02);

async function boot(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__dbg && window.__dbg.ready()), null, { timeout: 15000 });
  await page.evaluate(x => window.__dbg.lockFolder(x), RD('root'));
  await page.waitForFunction(() => window.__dbg.stack().phase === 'idle', null, { timeout: 12000 });
  await settle(page, 700);
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

    // ---------------- A. no saved view: default camera, no bar ----------------
    await boot(page);
    ok((await page.evaluate(() => window.__dbg.stack().files)) === 6, 'fixture-loaded');
    ok(!(await viewState(page)).hasFav, 'no-saved-view');
    ok(orbitNear((await cam(page)).orbit, DEFAULT_ORBIT, 0.2), 'load-uses-default-view', (await cam(page)).orbit);
    let st = await viewState(page);
    ok(st.bar === false && st.differs === false, 'no-bar-at-rest', st);
    // the default-view button now lives in the toolbar (not the bottom bar)
    ok(await page.evaluate(() => {
      const b = document.getElementById('btnViewHome');
      return !!b && b.closest('#toolbar') !== null && getComputedStyle(b).display !== 'none';
    }), 'default-view-button-in-toolbar');
    ok(await page.evaluate(() => /預設視角/.test(document.getElementById('btnViewHome').title)
      && /雙擊/.test(document.getElementById('btnViewHome').title)), 'default-view-button-title');
    ok(await page.evaluate(() => getComputedStyle(document.getElementById('viewBar')).display === 'none'
      || !document.getElementById('viewBar').classList.contains('show')), 'bar-hidden-at-rest');

    // ---------------- B. turning the camera surfaces the save button ----------------
    await page.evaluate(() => window.__dbg.setOrbit(13, 54, 1.3));
    await settle(page, 400);
    await page.waitForFunction(() => window.__dbg.viewState().bar === true, null, { timeout: 4000 }).catch(() => {});
    st = await viewState(page);
    ok(st.differs === true, 'turned-view-differs');
    ok(st.bar === true, 'bar-shown-after-turn');
    ok(st.saveShown === true, 'save-button-shown');
    ok(st.favShown === false, 'no-back-button-without-saved-view', st);
    await page.screenshot({ path: path.join(SHOTS, 'view-save-prompt.png') });
    console.log('shot ' + path.join(SHOTS, 'view-save-prompt.png'));

    // ---------------- C. save -> bar goes away ----------------
    await page.click('#btnViewSave');
    await page.waitForFunction(() => window.__dbg.viewState().bar === false, null, { timeout: 4000 }).catch(() => {});
    await sleep(350);
    st = await viewState(page);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('floderMyView')));
    ok(near(saved.yaw, 13, 0.01) && near(saved.zoom, 1.3, 0.01), 'view-saved', saved);
    ok(st.bar === false && st.differs === false, 'bar-hidden-after-save', st);
    ok(await page.evaluate(() => {
      const vb = document.getElementById('viewBar');
      return getComputedStyle(vb).display === 'none' || !vb.classList.contains('show');
    }), 'bar-fully-faded-after-save');

    // ---------------- D. reload -> the saved view comes back ----------------
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.__dbg && window.__dbg.ready()), null, { timeout: 15000 });
    await page.evaluate(x => window.__dbg.lockFolder(x), RD('root'));
    await page.waitForFunction(() => window.__dbg.stack().phase === 'idle', null, { timeout: 12000 });
    await settle(page, 800);
    ok(orbitNear((await cam(page)).orbit, saved, 0.2), 'reload-uses-saved-view', (await cam(page)).orbit);
    st = await viewState(page);
    ok(st.bar === false, 'no-bar-at-rest-with-saved-view', st);
    ok(st.hasFav === true, 'saved-view-persisted');

    // ---------------- E. turn without saving, reload -> still the saved view ----------------
    await page.evaluate(() => window.__dbg.setOrbit(-21, 30, 0.8));
    await settle(page, 400);
    await page.waitForFunction(() => window.__dbg.viewState().bar === true, null, { timeout: 4000 }).catch(() => {});
    st = await viewState(page);
    ok(st.saveShown === true && st.favShown === true, 'both-buttons-with-saved-view', st);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.__dbg && window.__dbg.ready()), null, { timeout: 15000 });
    await page.evaluate(x => window.__dbg.lockFolder(x), RD('root'));
    await page.waitForFunction(() => window.__dbg.stack().phase === 'idle', null, { timeout: 12000 });
    await settle(page, 800);
    ok(orbitNear((await cam(page)).orbit, saved, 0.2), 'unsaved-turn-discarded-on-reload', (await cam(page)).orbit);

    // ---------------- F. toolbar default view: camera resets, bar reappears ----------------
    await page.click('#btnViewHome');
    await settle(page, 400);
    ok(orbitNear((await cam(page)).orbit, DEFAULT_ORBIT, 0.2), 'toolbar-button-gives-default-view');
    await page.waitForFunction(() => window.__dbg.viewState().bar === true, null, { timeout: 4000 }).catch(() => {});
    st = await viewState(page);
    ok(st.differs === true && st.bar === true && st.favShown === true, 'bar-shown-after-default-view', st);
    // and the back button returns to the saved view
    await page.click('#btnViewFav');
    await settle(page, 400);
    ok(orbitNear((await cam(page)).orbit, saved, 0.2), 'back-button-returns-to-saved');
    await page.waitForFunction(() => window.__dbg.viewState().bar === false, null, { timeout: 4000 }).catch(() => {});
    ok((await viewState(page)).bar === false, 'bar-hidden-after-back');

    // ---------------- G. small tolerance: a hair off the saved view keeps the bar hidden ----------------
    await page.evaluate(() => window.__dbg.setOrbit(13.4, 54.4, 1.302));
    await settle(page, 500);
    ok((await viewState(page)).differs === false, 'tiny-offset-within-tolerance');
    await page.evaluate(() => window.__dbg.setOrbit(19, 54, 1.3));
    await settle(page, 500);
    ok((await viewState(page)).differs === true, 'clear-offset-outside-tolerance');

    ok(consoleErrors.length === 0, 'no-console-errors', consoleErrors.slice(0, 4));
  } finally {
    try { await browser.close(); } catch (_) {}
    try { server.kill(); } catch (_) {}
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exitCode = failed ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
