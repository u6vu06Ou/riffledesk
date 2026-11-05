import { chromeExecutable } from './chrome-path.mjs';
// tests/project-e2e.mjs — acceptance for projection (AI CLI pushes a file into the open UI).
// Port 5188 (never 5177/5178/5179). Builds its own throwaway fixture, drives headless
// Chrome, and stubs two platform APIs before the page loads:
//   window.Notification  → counts toasts, records tags, keeps onclick so it can be clicked
//   window.AudioContext  → counts synthesized chimes
// Background/foreground is driven via __dbg.projHidden() because visibilityState is
// unreliable in headless Chrome. Writes docs/screenshots/{project-settings,project-opened}.png
// (dark theme). Usage: node --test / npm run test:project
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5188;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const CHROME = chromeExecutable();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const consoleErrors = [];
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

// ---------------------------------------------------------------- fixture
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-project-'));
const RD = p => path.join(TMP, ...p.split('/'));
const FILES = ['one.md', 'two.md', 'three.md'];
const SINGLE = RD('root/single.md');
const NESTED = RD('root/reports/plan.md');
const LINES = 200;
function buildFixtures() {
  fs.mkdirSync(RD('root'), { recursive: true });
  fs.mkdirSync(RD('root/reports'), { recursive: true });
  fs.writeFileSync(NESTED, '# plan\nnested body\n');
  for (const f of FILES) fs.writeFileSync(RD('root/' + f), `# ${f}\nbody of ${f}\n`);
  fs.writeFileSync(SINGLE, Array.from({ length: LINES }, (_, i) => `line ${i + 1} of the projected file`).join('\n') + '\n');
}
buildFixtures();
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [RD('root')], pinned: [], convoRoots: [] }, null, 2));

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

function post(page, body) {
  // exactly what the CLI does: loopback JSON + the CLI header, no Origin (the browser
  // adds its own same-origin Origin here, which the server accepts as well)
  return page.evaluate(async b => {
    const r = await fetch('/api/project', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-RiffleDesk-CLI': '1' },
      body: JSON.stringify(b)
    });
    return { status: r.status, body: await r.json() };
  }, body);
}

const STUBS = () => {
  window.__notifs = [];
  window.__beeps = 0;
  class FakeNotification {
    constructor(title, opts = {}) {
      this.title = title; this.body = opts.body; this.tag = opts.tag;
      window.__notifs.push({ title, body: opts.body, tag: opts.tag });
      this.closed = false;
    }
    close() { this.closed = true; }
  }
  FakeNotification.permission = 'granted';
  FakeNotification.requestPermission = async () => 'granted';
  window.Notification = FakeNotification;
  window.AudioContext = class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() {}
    createOscillator() {
      window.__beeps++;
      return {
        type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() { return { connect() {} }; }, start() {}, stop() {}
      };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return { connect() {} }; } };
    }
  };
};

let server = null;
let browser = null;
const pageErrors = [];

async function main() {
  server = await startServer();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(STUBS);
  // sound on from the start, notification permission granted
  await ctx.addInitScript(() => {
    try { localStorage.setItem('riffleProjectSound', '1'); } catch (_) {}
  });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.__dbg && window.__dbg.ready());
  await sleep(1200);      // SSE stream attaches after the target poll
  // dismiss the first-run tip card so it does not sit over the screenshots
  const know = page.locator('#hint button');
  if (await know.count()) await know.first().click().catch(() => {});

  // ---------- 1. a foreground projection opens the file, at the requested line
  const r1 = await post(page, { path: SINGLE, line: 150, source: 'claude-code' });
  ok(r1.status === 200 && r1.body.delivered === 1, 'POST accepted and delivered to 1 tab', r1);
  await page.waitForFunction(() => window.__dbg.panel().open && window.__dbg.panel().file === 'single.md');
  ok(true, 'reader opened the projected file');
  ok(await page.evaluate(() => document.body.classList.contains('mode-wide')), 'projection switched to the wide (2/3) layout');
  ok((await page.evaluate(() => window.__dbg.mode())) === 'wide', 'layout state machine reports wide');
  const dbgScroll = await page.evaluate(async () => {
    const b = document.getElementById('readerBody');
    const before = b.scrollTop;
    b.scrollTop = 1200;
    const mid = b.scrollTop;
    await new Promise(r => requestAnimationFrame(r));
    return { before, mid, after: b.scrollTop, h: b.scrollHeight, ch: b.clientHeight, cls: b.className, lf: window.__dbg.lockedFolder() };
  });
  console.log('DBG', JSON.stringify(dbgScroll));
  ok(dbgScroll.mid > 0 && dbgScroll.after > 0, 'reader scrolled down to the requested line', dbgScroll);
  ok(String(await page.evaluate(() => window.__dbg.lockedFolder())).toLowerCase().endsWith('root'), 'tree switched to the file folder');
  ok((await page.evaluate(() => window.__dbg.projRecent()))[0].startsWith('single.md'), 'left column lists the projected file');
  ok((await page.evaluate(() => window.__notifs.length)) === 0, 'foreground projection raises no notification');

  // ---------- 2. screenshot: the opened projection (dark theme)
  await page.evaluate(() => window.__dbg.setTheme('dark'));
  await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, 'project-opened.png') });

  // ---------- 3. background: 3 quick pushes → exactly ONE merged notification
  await page.evaluate(() => window.__dbg.projHidden(true));
  for (const f of FILES) {
    await post(page, { path: RD('root/' + f) });
    await sleep(150);
  }
  await sleep(3400);      // past the 3 s merge window
  const notifs = await page.evaluate(() => window.__notifs);
  ok(notifs.length === 1, 'three pushes in the merge window → 1 notification', notifs.length);
  ok(notifs[0] && /3/.test(notifs[0].title), 'the merged notification names the count', notifs[0]);
  ok(notifs[0] && notifs[0].tag === 'riffle-project', 'the notification reuses one tag (replaces itself)');
  // body must be short: parent folder + file name, never the full absolute path
  ok(notifs[0] && notifs[0].body === 'root/three.md', 'notification body is parent/file only', notifs[0] && notifs[0].body);
  ok((await page.evaluate(() => window.__dbg.panel().file)) === 'single.md', 'background pushes did not open anything yet');

  // nested file + line: body stays parent/file:line, and the title names the file only
  await post(page, { path: NESTED, line: 7 });
  await sleep(3400);
  const n2 = await page.evaluate(() => window.__notifs[window.__notifs.length - 1]);
  ok(n2 && n2.body === 'reports/plan.md:7', 'nested notification body is parent/file:line', n2 && n2.body);
  ok(n2 && !n2.title.includes(TMP), 'notification title carries no absolute path', n2 && n2.title);

  // sound throttling: first burst beeped once, a second burst 3 s later stays silent
  const beeps1 = await page.evaluate(() => window.__beeps);
  ok(beeps1 === 1, 'first notification burst beeps once', beeps1);
  await post(page, { path: RD('root/one.md') });
  await sleep(3400);
  const beeps2 = await page.evaluate(() => window.__beeps);
  ok(beeps2 === 1, 'a burst 3 s later is silent (10 s throttle)', beeps2);
  ok((await page.evaluate(() => window.__notifs.length)) === 3, 'the later burst still raises a notification');
  // past the throttle window → sound again
  await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 11000; });
  await post(page, { path: RD('root/two.md') });
  await sleep(3400);
  ok((await page.evaluate(() => window.__beeps)) === 2, 'sound returns after the 10 s throttle');

  // ---------- 4. clicking the notification opens ALL held files as one pile (not just the newest)
  await post(page, { path: RD('root/three.md') });
  await sleep(500);
  await page.evaluate(() => window.__dbg.projClickNotif());
  await page.waitForFunction(() => window.__dbg.fileNames(50).includes('plan.md'), null, { timeout: 8000 }).catch(() => {});
  await sleep(600);
  const pileNames = await page.evaluate(() => window.__dbg.fileNames(50));
  const want = ['single.md', 'three.md', 'plan.md', 'one.md', 'two.md'].filter(n => pileNames.includes(n));
  ok(pileNames.includes('three.md') && pileNames.includes('plan.md') && pileNames.includes('one.md') && pileNames.includes('two.md'),
    'clicking the notification opens every held file together (pile)', pileNames);
  ok(new Set(pileNames).size === pileNames.length && pileNames.length === want.length,
    'the pile holds only the held files, no duplicates, nothing else from the folder', pileNames);
  // the merge pile is self-made: no extra "new pile" toast/notification for it
  const pileNotifs = await page.evaluate(() => (window.__notifs || []).filter(n => n.tag === 'riffle-pile').length);
  ok(pileNotifs === 0, 'self-made merge pile raises no second notification', pileNotifs);
  // leave the pile so the next steps see the normal folder again
  await page.keyboard.press('Escape');
  await sleep(400);
  await page.keyboard.press('Escape');
  await sleep(600);

  // ---------- 4b. coming back to the foreground opens the newest held file
  await page.evaluate(() => window.__dbg.projHidden(true));
  await post(page, { path: RD('root/one.md') });
  await sleep(400);
  await page.evaluate(() => window.__dbg.projHidden(false));
  await sleep(800);
  ok((await page.evaluate(() => window.__dbg.panel().file)) === 'one.md', 'returning to the foreground opens the newest held file');

  // ---------- 5. screenshot: the new ⚙ options
  await page.evaluate(() => window.__dbg.setTheme('dark'));
  await page.click('#btnSettings');
  await sleep(300);
  const grp = await page.evaluateHandle(() => {
    const n = document.querySelector('#projNotify');
    return n && n.closest('.sgrp');
  });
  if (grp) await grp.scrollIntoViewIfNeeded();
  await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, 'project-settings.png') });
  ok(await page.isVisible('#projSound'), 'settings show the sound switch');
  ok(await page.isVisible('#projFront'), 'settings show the jump-to-front switch');
  ok(await page.isVisible('#projPerm'), 'settings show the permission button');

  // ---------- 5b. path splitting keeps the root separator (dir must stay absolute)
  const splits = await page.evaluate(() => ['C:\\a.md', '/a.md', 'D:\\x\\y.md'].map(p => window.__dbg.projSplit(p)));
  ok(splits[0].dir === 'C:\\' && splits[0].name === 'a.md', 'drive-root file keeps "C:\\"', splits[0]);
  ok(splits[1].dir === '/' && splits[1].name === 'a.md', 'posix-root file keeps "/"', splits[1]);
  ok(splits[2].dir === 'D:\\x' && splits[2].name === 'y.md', 'nested file splits normally', splits[2]);

  // ---------- 6. always-jump-to-front setting persists
  await page.evaluate(() => window.__dbg.setTheme('light'));
  await page.click('#projFront');
  ok((await page.evaluate(() => localStorage.getItem('riffleProjectFront'))) === '1', 'front setting persists');

  // ---------- 7. i18n: the new settings follow the interface language
  const zhLabel = await page.textContent('#projSound + span, label:has(#projSound) span');
  await page.evaluate(() => { try { localStorage.setItem('floderLang', 'en'); } catch (_) {} });
  await page.reload();
  await page.waitForFunction(() => window.__dbg && window.__dbg.ready());
  await page.click('#btnSettings');
  const enLabel = await page.textContent('label:has(#projSound) span');
  ok(zhLabel !== enLabel && /sound/i.test(enLabel), 'labels are translated (en after switch)', { zhLabel, enLabel });
  await page.evaluate(() => window.__dbg.setTheme('dark'));

  // ---------- 8. URL projection: /?open=<path>&line=N opens it, then drops the params
  const urlFile = encodeURIComponent(SINGLE);
  await page.goto(`${BASE}/?open=${urlFile}&line=20&keepme=1`);
  await page.waitForFunction(() => window.__dbg && window.__dbg.ready(), null, { timeout: 20000 });
  await page.waitForFunction(() => window.__dbg.panel().open && window.__dbg.panel().file === 'single.md', null, { timeout: 15000 });
  ok(true, 'url projection opened the reader');
  ok(await page.evaluate(() => document.body.classList.contains('mode-wide')), 'url projection also lands on the wide layout');
  ok((await page.evaluate(() => window.__dbg.mode())) === 'wide', 'url projection sets the state machine to wide');
  await page.waitForFunction(() => window.__dbg.projLine() != null, null, { timeout: 5000 }).catch(() => {});
  const urlLine = await page.evaluate(() => window.__dbg.projLine());
  ok(urlLine != null && urlLine > 0, 'url projection scrolled to the line', urlLine);
  await page.waitForFunction(() => !/[?&]open=/.test(location.search), null, { timeout: 5000 }).catch(() => {});
  const urlSearch = await page.evaluate(() => location.search);
  ok(!/[?&]open=/.test(urlSearch) && !/[?&]line=/.test(urlSearch), 'open/line removed from the url', urlSearch);
  ok(/keepme=1/.test(urlSearch), 'other url params survive', urlSearch);
  ok((await page.evaluate(() => window.__dbg.projRecent()))[0].startsWith('single.md'), 'url projection lands in the recent list');
  await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, 'project-url-open.png') });

  // ---------- 8b. URL projection without a line just opens the file
  await page.goto(`${BASE}/?open=${urlFile}`);
  await page.waitForFunction(() => window.__dbg && window.__dbg.ready(), null, { timeout: 20000 });
  await page.waitForFunction(() => window.__dbg.panel().open && window.__dbg.panel().file === 'single.md', null, { timeout: 15000 });
  ok(true, 'url projection without a line still opens the file');
  ok(await page.evaluate(() => document.body.classList.contains('mode-wide')), 'still wide without a line');
  ok(!/[?&]open=/.test(await page.evaluate(() => location.search)), 'url without a line is cleared too');

  // ---------- 9. URL projection of a missing path → in-page toast, no errors, no params
  const gone = encodeURIComponent(RD('root/no-such-file.md'));
  await page.goto(`${BASE}/?open=${gone}&line=3`);
  await page.waitForFunction(() => window.__dbg && window.__dbg.ready(), null, { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('toast').classList.contains('on'), null, { timeout: 15000 });
  const toastText = await page.textContent('#toast');
  ok(/no-such-file\.md/.test(toastText), 'missing file shows a toast', toastText);
  await page.waitForFunction(() => !/[?&]open=/.test(location.search), null, { timeout: 5000 }).catch(() => {});
  ok(!/[?&]open=/.test(await page.evaluate(() => location.search)), 'missing file still clears the url');
  ok(!(await page.evaluate(() => window.__dbg.projRecent())).some(r => r.startsWith('no-such-file')), 'a dead url path leaves no row in the recent list');
}

main()
  .then(async () => {
    ok(pageErrors.length === 0, 'no page errors', pageErrors);
    ok(consoleErrors.length === 0, 'no console errors', consoleErrors);
  })
  .catch(e => { console.log('FAIL harness ' + e.stack); failed++; })
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
    process.exit(failed ? 1 : 0);
  });
