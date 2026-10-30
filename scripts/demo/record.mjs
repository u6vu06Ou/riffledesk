// record.mjs — drive the demo build with headless Chrome and write the marketing media
// into docs/media/: screenshots (1600x900), short mp4 clips and the README header gif.
//
//   node scripts/demo/make-demo.mjs --force     (build the fake tree first)
//   node scripts/demo/record.mjs
//
// Everything is captured from RIFFLEDESK_DEMO, so no real path, drive, user name or
// transcript can end up in frame. Requires ffmpeg on PATH. Port 5197 (server) / 5198
// (nothing else) — never touches 5177.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 5197;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, 'docs', 'media');
const RAW = path.join(OUT, '_raw');
const DEMO = process.argv.includes('--dir')
  ? path.resolve(process.argv[process.argv.indexOf('--dir') + 1])
  : path.join(os.tmpdir(), 'riffledesk-demo', 'demo-home');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('  ' + new Date().toISOString().slice(11, 19), ...a);

const FAKE_HOME = process.platform === 'win32' ? 'C:\\Users\\demo' : '/home/demo';
const J = (...p) => path.join(FAKE_HOME, ...p);

if (!fs.existsSync(DEMO)) {
  console.error(`no demo tree at ${DEMO} — run: node scripts/demo/make-demo.mjs --force`);
  process.exit(1);
}
fs.mkdirSync(RAW, { recursive: true });

// ---------------------------------------------------------------- server
let server = null;
async function startServer() {
  fs.rmSync(DEMO + '.state', { recursive: true, force: true });
  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), RIFFLEDESK_DEMO: DEMO, RIFFLEDESK_INDEX: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let out = '';
  server.stdout.on('data', d => { out += d; });
  server.stderr.on('data', d => { out += d; });
  const deadline = Date.now() + 15000;
  while (!out.includes('listening')) {
    if (Date.now() > deadline) throw new Error('server start timeout: ' + out);
    await sleep(50);
  }
}
function stopServer() { try { server && server.kill(); } catch (_) {} }

// ---------------------------------------------------------------- page helpers
async function bootPage(browser, opts = {}) {
  const width = opts.width || 1600, height = opts.height || 900;
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    ...(opts.video ? { recordVideo: { dir: RAW, size: { width, height } } } : {})
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('floderLang', 'en');
      localStorage.setItem('riffleTipSeen', '1');
      localStorage.setItem('riffleConvoAuto', '0');
      localStorage.setItem('riffleHtmlRun', '0');
      localStorage.setItem('riffleHideEmpty', '0');
      sessionStorage.setItem('riffleSeenRevise', '1');
    } catch (_) {}
  });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('  console error:', m.text()); });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__dbg && window.__dbg.ready()), null, { timeout: 20000 });
  return { ctx, page };
}

const pickChips = async (page, ids) => {
  await page.evaluate(list => {
    for (const on of window.__dbg.chipsOn()) if (!list.includes(on)) window.__dbg.selectChip(on);
    for (const id of list) if (!window.__dbg.chipsOn().includes(id)) window.__dbg.selectChip(id);
  }, ids);
};
const lockTo = async (page, dir) => {
  await page.evaluate(p => window.__dbg.lockFolder(p), dir);
  await sleep(700);
};
// smooth synthetic scroll over the stack (real wheel events hit the canvas)
async function wheel(page, dy, steps = 18, gap = 60) {
  await page.mouse.move(1100, 520);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy / steps);
    await sleep(gap);
  }
}

// ---------------------------------------------------------------- screenshots
async function shots(browser) {
  const { ctx, page } = await bootPage(browser);
  const shot = async (name) => { log('shot', name); await page.screenshot({ path: path.join(OUT, name) }); };

  // 1. overview, three columns (a reader open on a report)
  await pickChips(page, ['md']);
  await lockTo(page, J('Documents', 'aurora-labs', 'reports'));
  await sleep(900);
  await page.evaluate(() => window.__dbg.openFileByName('q3-rollout-notes.md'));
  await sleep(1500);
  await shot('01-overview.png');

  // 2. the card stack mid-scroll, no reader
  await page.evaluate(() => window.__dbg.closeReader());
  await lockTo(page, J('Documents', 'aurora-labs'));
  await page.evaluate(() => { window.__dbg.selectChip('all'); });
  await sleep(900);
  await page.mouse.move(1120, 480);
  await wheel(page, -900, 20, 55);
  await sleep(500);
  await shot('02-stack.png');

  // 3. reading a markdown report
  await lockTo(page, J('Documents', 'aurora-labs', 'reports'));
  await sleep(500);
  await page.evaluate(() => window.__dbg.openFileByName('onboarding-audit.md'));
  await sleep(1400);
  await shot('03-reader-md.png');

  // 4. full-text search results
  await page.evaluate(() => window.__dbg.closeReader());
  await lockTo(page, J('Documents', 'aurora-labs'));
  await sleep(400);
  await page.fill('#searchBox', 'seat');
  await page.press('#searchBox', 'Enter');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('seat') &&
    !document.getElementById('status').textContent.includes('…'), null, { timeout: 15000 }).catch(() => {});
  await sleep(1600);
  await shot('04-search.png');

  // 5. revamp mode: a page edited, items numbered in the list
  await page.fill('#searchBox', '');
  await page.press('#searchBox', 'Escape').catch(() => {});
  await page.evaluate(() => window.__dbg.selectChip('html'));
  await lockTo(page, J('Documents', 'aurora-labs', 'website'));
  await sleep(600);
  log('open pricing', await page.evaluate(() => window.__dbg.openFileByName('pricing.html')));
  await sleep(1500);
  await page.keyboard.press('Control+Shift+e');
  await page.waitForFunction(() => window.__dbg.revise().frame, null, { timeout: 20000 });
  const frame = await (await page.$('#reviseFrame')).contentFrame();
  await frame.waitForSelector('h1', { timeout: 20000 });
  log('revise ready');
  await sleep(700);
  // rewrite the headline, bold the lede, add a note on the middle plan
  await frame.click('h1');
  await frame.waitForSelector('#rd-tb', { state: 'visible' });
  await frame.locator('#rd-tb button').nth(0).click();
  await sleep(200);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Plans that fit');
  await page.keyboard.press('Enter');
  await sleep(400);
  await frame.click('p.lede');
  await frame.waitForSelector('#rd-tb', { state: 'visible' });
  await frame.locator('#rd-tb button').nth(4).click();
  await frame.waitForSelector('#rd-note', { state: 'visible' });
  await frame.fill('#rd-note textarea', 'Say how long the trial takes.');
  await frame.click('#rd-note button[data-act=ok]');
  await sleep(1600);
  await shot('05-revamp.png');

  // 6. AI projection notification (background tab + stubbed Notification)
  await pickChips(page, ['md']);
  await lockTo(page, J('Documents', 'aurora-labs', 'reports'));
  await sleep(900);
  await page.evaluate(() => window.__dbg.projHidden(true));           // background tab
  await page.evaluate(p => window.__dbg.project({ path: p, line: 6, source: 'claude-code' }),
    J('Documents', 'aurora-labs', 'reports', 'q3-rollout-notes.md'));
  await sleep(500);
  await shot('06-projection-notice.png');                             // the held-back state
  await page.evaluate(() => { window.__dbg.projHidden(false); window.__dbg.projClickNotif(); });
  await sleep(2200);
  await shot('06-projection.png');

  // 7. multi-select batch bar (dark theme)
  await page.keyboard.press('Escape');
  await sleep(400);
  await page.evaluate(() => window.__dbg.setTheme('dark'));
  await pickChips(page, ['md']);                                       // the html chips are still on
  await lockTo(page, J('Documents', 'aurora-labs', 'reports'));
  await sleep(900);
  await page.mouse.move(1120, 470);
  await sleep(300);
  await page.evaluate(() => {
    for (let i = 0; i < 3 && i < window.__dbg.fileNames(5).length; i++) window.__dbg.selClick(i, false);
  });
  await sleep(900);
  await shot('07-selection-dark.png');

  await ctx.close();
}

// ---------------------------------------------------------------- videos
async function video(browser, name, seconds, body) {
  const { ctx, page } = await bootPage(browser, { video: true, width: 1280, height: 720 });
  const video = page.video();
  const t0 = Date.now();
  await body(page);
  // pad to the wanted length so clips feel deliberate, never cut mid-animation
  const left = seconds * 1000 - (Date.now() - t0);
  if (left > 0) await sleep(left);
  await ctx.close();                       // closing the context finalises the file
  const raw = await video.path();
  const mp4 = path.join(OUT, name + '.mp4');
  execFileSync('ffmpeg', ['-y', '-i', raw, '-an', '-vf', 'fps=30,scale=1280:-2',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: 'ignore' });
  const kb = fs.statSync(mp4).size / 1024;
  console.log(`  ${name}.mp4 — ${Math.round(kb)} KB`);
  if (kb > 5 * 1024) console.log(`  ! ${name}.mp4 is over 5 MB`);
  fs.rmSync(raw, { force: true });
  return mp4;
}

async function videoBrowse(browser) {
  await video(browser, 'browse', 17, async (page) => {
    await pickChips(page, ['all']);
    await lockTo(page, J('Documents', 'aurora-labs'));
    await page.mouse.move(1100, 500);
    await sleep(800);
    await wheel(page, -1500, 26, 70);
    await sleep(400);
    await wheel(page, 700, 12, 70);
    // search the whole project
    await page.click('#searchBox');
    await page.keyboard.type('seat', { delay: 90 });
    await sleep(600);
    await page.press('#searchBox', 'Enter');
    await sleep(2200);
    // open the first hit
    await page.evaluate(() => window.__dbg.openFileByName('q3-rollout-notes.md'));
    await sleep(2600);
    await page.evaluate(() => window.__dbg.closeReader());
    await sleep(900);
  });
}

async function videoProjection(browser) {
  const target = J('Documents', 'aurora-labs', 'reports', 'q3-rollout-notes.md');
  await video(browser, 'projection', 15, async (page) => {
    await pickChips(page, ['md']);
    await lockTo(page, J('Documents', 'aurora-labs', 'reports'));
    await sleep(900);
    // exactly what `riffledesk open` sends over HTTP
    await fetch(BASE + '/api/project', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-RiffleDesk-CLI': '1' },
      body: JSON.stringify({ path: target, line: 6, source: 'claude-code' })
    });
    await sleep(3600);
    // the CLI is a real subprocess too — run it so the terminal side is honest.
    // It stats the path itself, so it needs the real one; the demo server turns it
    // back into the fake home before anything reaches the screen.
    execFileSync(process.execPath, ['bin/riffledesk.js', 'open', path.join(DEMO, 'Documents', 'aurora-labs', 'reports', 'release-notes-0-9.md'), '--port', String(PORT)],
      { cwd: ROOT, env: { ...process.env, RIFFLEDESK_DEMO: DEMO }, stdio: 'ignore' });
    await sleep(3800);
  });
}

async function videoRevamp(browser) {
  const mp4 = await video(browser, 'revamp', 20, async (page) => {
    await pickChips(page, ['html']);
    await lockTo(page, J('Documents', 'aurora-labs', 'website'));
    await sleep(700);
    log('open pricing', await page.evaluate(() => window.__dbg.openFileByName('pricing.html')));
    await sleep(1800);
    await page.keyboard.press('Control+Shift+e');
    await page.waitForFunction(() => window.__dbg.revise().frame, null, { timeout: 20000 });
    const frame = await (await page.$('#reviseFrame')).contentFrame();
    await frame.waitForSelector('h1', { timeout: 20000 });
    log('revise ready');
    await sleep(900);
    await frame.click('h1');
    await frame.waitForSelector('#rd-tb', { state: 'visible' });
    await frame.locator('#rd-tb button').nth(0).click();
    await sleep(250);
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Plans that fit', { delay: 70 });
    await page.keyboard.press('Enter');
    await sleep(800);
    await frame.click('.plan.hot h2');
    await frame.waitForSelector('#rd-tb', { state: 'visible' });
    await frame.locator('#rd-tb button').nth(4).click();
    await frame.waitForSelector('#rd-note', { state: 'visible' });
    await frame.fill('#rd-note textarea', 'Make the middle plan stand out a little less.');
    await frame.click('#rd-note button[data-act=ok]');
    await sleep(1200);
    // "hand to AI" writes the list next to the page
    await page.click('#reviseBar button[data-rv="hand"]');
    await sleep(2600);
  });
  return mp4;
}

// ---------------------------------------------------------------- gif
function makeGif(mp4) {
  const gif = path.join(OUT, 'demo.gif');
  execFileSync('ffmpeg', ['-y', '-i', mp4, '-vf',
    'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    '-loop', '0', gif], { stdio: 'ignore' });
  const mb = fs.statSync(gif).size / (1024 * 1024);
  console.log(`  demo.gif — ${mb.toFixed(1)} MB`);
  if (mb > 8) console.log('  ! demo.gif is over 8 MB');
}

// ---------------------------------------------------------------- main
(async () => {
  try {
    await startServer();
    const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--allow-pre-commit-input', '--hide-scrollbars'] });
    console.log('screenshots…');
    await shots(browser);
    console.log('videos…');
    await videoBrowse(browser);
    await videoProjection(browser);
    const revamp = await videoRevamp(browser);
    console.log('gif…');
    makeGif(revamp);
    await browser.close();
    // the raw .webm files are scaffolding; Chrome can let go of the last handle a
    // moment after close, so retry once instead of failing the whole run over it
    try {
      fs.rmSync(RAW, { recursive: true, force: true });
    } catch (_) {
      await sleep(1500);
      fs.rmSync(RAW, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    console.log('done — docs/media/');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    stopServer();
  }
})();
