import { chromeExecutable } from './chrome-path.mjs';
// tests/pile-e2e.mjs — acceptance for piles (AI hands over a shortlist as one stack).
// Port 5191 (never 5177/5178/5179). Own throwaway fixture, headless Chrome, the same
// Notification/AudioContext stubs as project-e2e. Anything of ours on screen is checked
// by DOM/card name, and docs/screenshots/pile.png is captured for a human look.
// Usage: npm run test:pile
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5191;
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-pile-'));
const RD = p => path.join(TMP, ...p.split('/'));
// two folders; the stack must only ever show the three picked files, never the others
const PICKED = ['alpha/one.md', 'alpha/two.md', 'beta/three.md'];
const OTHERS = ['alpha/other-a.md', 'beta/other-b.md', 'beta/other-c.md'];
for (const p of [...PICKED, ...OTHERS]) {
  fs.mkdirSync(path.dirname(RD(p)), { recursive: true });
  fs.writeFileSync(RD(p), `# ${path.basename(p)}\nbody\n`);
}
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ roots: [RD('alpha'), RD('beta')], pinned: [], convoRoots: [] }, null, 2));

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
  return page.evaluate(async b => {
    const r = await fetch('/api/pile', {
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
const names = page => page.evaluate(() => window.__dbg.fileNames(50));
const cardNames = async page => new Set(await names(page));

async function main() {
  server = await startServer();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(STUBS);
  await ctx.addInitScript(() => { try { localStorage.setItem('riffleProjectSound', '1'); } catch (_) {} });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.__dbg && window.__dbg.ready());
  await sleep(1200);      // the SSE stream attaches after the target poll
  const know = page.locator('#hint button');
  if (await know.count()) await know.first().click().catch(() => {});
  await page.evaluate(() => window.__dbg.setTheme('dark'));

  const beforeFolder = await page.evaluate(() => window.__dbg.lockedFolder());

  // ---------- 1. a pile in the foreground: a toast, no screen switch, no card change
  const before = await names(page);
  const r1 = await post(page, { paths: PICKED.map(RD), title: 'Three notes', source: 'claude-code' });
  ok(r1.status === 200 && r1.body.ok === true, 'POST accepted', r1);
  ok(r1.body.delivered === 1, 'delivered to the one open tab', r1.body);
  ok(r1.body.count === 3, 'server kept all three files', r1.body.count);
  // past the merge window; the toast is the foreground equivalent of the notification
  await page.waitForFunction(() => document.getElementById('toast').classList.contains('on'), null, { timeout: 8000 });
  const toastText = await page.evaluate(() => document.getElementById('toast').textContent);
  ok(/3/.test(toastText) && toastText.includes('Three notes'), 'foreground shows a "3 files / Three notes" toast', toastText);
  ok(await page.isVisible('#toast a'), 'the toast carries an "open the pile" link', toastText);
  ok((await page.evaluate(() => window.__dbg.fileNames(50))).join() === before.join(), 'the card stack did not change');
  ok((await page.evaluate(() => window.__dbg.lockedFolder())).toLowerCase() === beforeFolder.toLowerCase(),
    'the locked folder did not change');
  ok((await page.evaluate(() => window.__dbg.pileState())) === null, 'no pile is being shown yet');
  // the left column lists it
  const rows = await page.evaluate(() => window.__dbg.pileRows());
  ok(rows.length === 1, 'the pile appears in the left column', rows);

  // ---------- 2. clicking the toast opens the pile, puts the stack aside and opens the first file
  await page.evaluate(() => window.__dbg.pileClickToast());
  await page.waitForFunction(() => window.__dbg.pileState());
  await page.waitForFunction(() => window.__dbg.panel().open, null, { timeout: 8000 });
  await sleep(500);
  ok(await page.evaluate(() => document.body.classList.contains('mode-threecol')), 'opening a pile moves to the side-by-side layout');
  ok((await page.evaluate(() => window.__dbg.mode())) === 'threecol', 'layout state machine says threecol');
  ok((await page.evaluate(() => window.__dbg.panel().file)) === 'one.md', 'the first pile file is open in the reader');
  ok((await page.evaluate(() => window.__dbg.pileBar())).includes('Three notes'), 'the pile bar is still there with the reader open');

  // ---------- 2b. Esc leaves the pile and takes the auto-opened reader with it, back to twocol
  await page.keyboard.press('Escape');
  await sleep(800);
  ok((await page.evaluate(() => window.__dbg.pileState())) === null, 'Esc closes the pile');
  ok(!(await page.evaluate(() => window.__dbg.panel().open)), 'the auto-opened reader is closed too');
  ok((await page.evaluate(() => window.__dbg.mode())) === 'twocol', 'the layout goes back to twocol');
  ok((await page.evaluate(() => window.__dbg.lockedFolder())).toLowerCase() === beforeFolder.toLowerCase(), 'back to the folder we came from');

  // reopen for the rest of the run
  await page.evaluate(id => window.__dbg.pileOpen(id), rows[0]);
  await page.waitForFunction(() => window.__dbg.pileState());
  await sleep(600);

  // ---------- 3. only the three picked cards, across the two folders
  const shown = await cardNames(page);
  ok(shown.size === 3, 'exactly three cards', [...shown]);
  for (const p of PICKED) ok(shown.has(path.basename(p)), 'picked file shown: ' + path.basename(p));
  for (const p of OTHERS) ok(!shown.has(path.basename(p)), 'unrelated file hidden: ' + path.basename(p));

  // ---------- 4. the bar names the pile and offers the way back
  const bar = await page.evaluate(() => window.__dbg.pileBar());
  ok(bar.includes('Three notes') && bar.includes('3'), 'bar text names the title and count', bar);
  ok(bar.includes('Esc'), 'the back button hint mentions Esc', bar);
  ok(await page.isVisible('#pathBar .pile-back'), 'the back button is visible');
  const selRow = await page.evaluate(() => document.querySelector('#projPiles .pile-row.sel') !== null);
  ok(selRow, 'the pile row is the selected row in the left column');

  // ---------- 5. folder type choices never hide AI handoff files.
  await page.evaluate(() => window.__dbg.selectChip('image'));
  await sleep(500);
  ok((await cardNames(page)).size === 3, 'image-only folder filter keeps all three delivered notes');
  ok(/整疊都顯示|All files in this pile/.test(await page.locator('#chips summary').innerText()), 'type control explains that piles show everything');
  ok(await page.locator('#projPiles .pile-row.sel .cnt').innerText() === '3', 'pile count stays independent of folder filters');
  await page.locator('#pathBar .pile-back').click();
  await sleep(500);
  ok((await names(page)).length === 0, 'leaving a pile restores the image-only folder filter');
  ok(!/整疊都顯示|All files in this pile/.test(await page.locator('#chips summary').innerText()), 'folder type label returns after leaving a pile');
  await page.evaluate(id => window.__dbg.pileOpen(id), rows[0]);
  await page.waitForFunction(() => window.__dbg.pileState());
  ok((await cardNames(page)).size === 3, 'entering a pile with an existing image filter still shows every delivered note');
  await page.evaluate(() => window.__dbg.selectChip('md'));
  await sleep(500);
  ok((await cardNames(page)).size === 3, 'a markdown chip brings the three back');

  // ---------- 6. reading one of them works from the pile
  await page.evaluate(() => window.__dbg.openFileByName('two.md'));
  await sleep(800);
  ok((await page.evaluate(() => window.__dbg.panel().file)) === 'two.md', 'a pile card opens in the reader');
  ok((await page.evaluate(() => window.__dbg.pileState())).n === 3, 'reading keeps the pile');
  // ---------- 6b. a file the user opened themselves is NOT swept away by leaving the pile
  await page.keyboard.press('Escape');
  await sleep(800);
  ok((await page.evaluate(() => window.__dbg.pileState())) === null, 'Esc still closes the pile');
  ok((await page.evaluate(() => window.__dbg.panel().file)) === 'two.md', 'the self-chosen file stays open');
  ok((await page.evaluate(() => window.__dbg.panel().open)), 'the reader the user filled stays open');
  await page.evaluate(() => window.__dbg.closeReader());
  await sleep(400);
  // back into the pile for the screenshot
  await page.evaluate(id => window.__dbg.pileOpen(id), rows[0]);
  await page.waitForFunction(() => window.__dbg.pileState());
  await page.waitForFunction(() => window.__dbg.panel().open, null, { timeout: 8000 });
  await sleep(600);

  // ---------- 7. screenshot for a human look
  await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, 'pile.png') });

  // ---------- 8. ✕ goes back to the folder the pile was entered from
  await page.click('#pathBar .pile-back');
  await sleep(1200);
  ok((await page.evaluate(() => window.__dbg.pileState())) === null, 'the pile is closed');
  const backFolder = await page.evaluate(() => window.__dbg.lockedFolder());
  ok(backFolder && backFolder.toLowerCase() === beforeFolder.toLowerCase(), 'back to the folder we came from', backFolder);
  ok(!(await page.evaluate(() => window.__dbg.pileBar())).includes('Three notes'), 'the pile bar is gone');
  ok((await names(page)).includes('other-a.md'), 'the folder cards are back');

  // ---------- 9. Esc closes a pile too
  await page.evaluate(id => window.__dbg.pileOpen(id), rows[0]);
  await page.waitForFunction(() => window.__dbg.pileState());
  await sleep(600);
  ok((await page.evaluate(() => window.__dbg.pileState())) !== null, 'reopened from the left column');
  await page.keyboard.press('Escape');
  await sleep(1000);
  ok((await page.evaluate(() => window.__dbg.pileState())) === null, 'Esc leaves the pile');

  // ---------- 9b. opening a real folder drops the pile and its bar
  await page.evaluate(id => window.__dbg.pileOpen(id), rows[0]);
  await page.waitForFunction(() => window.__dbg.pileState());
  await sleep(500);
  await page.evaluate(p => window.__dbg.lockFolder(p), RD('beta'));
  await page.waitForFunction(() => window.__dbg.pileState() === null);
  await sleep(600);
  ok(!(await page.evaluate(() => window.__dbg.pileBar())).includes('Three notes'), 'locking a folder clears the pile bar');
  ok((await names(page)).includes('other-b.md'), 'the locked folder cards show');

  // ---------- 10. ?pile=<id> opens it directly
  const r2 = await post(page, { paths: PICKED.map(RD), title: 'Direct pile' });
  await page.goto(`${BASE}/?pile=${r2.body.id}`);
  await page.waitForFunction(() => window.__dbg && window.__dbg.ready(), null, { timeout: 20000 });
  await page.waitForFunction(() => window.__dbg.pileState(), null, { timeout: 15000 });
  await sleep(800);
  const direct = await cardNames(page);
  ok(direct.size === 3, '?pile= shows the three files', [...direct]);
  const directBar = await page.evaluate(() => window.__dbg.pileBar());
  ok(directBar.includes('Direct pile'), '?pile= names the title', directBar);
  ok(!/[?&]pile=/.test(await page.evaluate(() => location.search)), 'the pile param is dropped from the url');
  // leaving a ?pile= page still returns to the boot folder, not a dead end
  await page.keyboard.press('Escape');
  await sleep(1000);
  ok((await page.evaluate(() => window.__dbg.pileState())) === null, 'Esc works on a ?pile= page too');
  ok((await page.evaluate(() => window.__dbg.lockedFolder())) !== null, 'back to a real folder');

  // ---------- 11. a pile of dead paths / an unknown id
  const gonePage = await ctx.newPage();
  await gonePage.goto(`${BASE}/?pile=nosuchid`);
  await gonePage.waitForFunction(() => window.__dbg && window.__dbg.ready(), null, { timeout: 20000 });
  await sleep(1200);
  const goneToast = await gonePage.evaluate(() => document.getElementById('toast').textContent);
  ok(/不在了|left/.test(goneToast), 'an unknown pile id shows a toast', goneToast);
  await gonePage.close();

  // ---------- 12. the list survives a reload (it comes back from /api/piles)
  await page.reload();
  await page.waitForFunction(() => window.__dbg && window.__dbg.ready(), null, { timeout: 20000 });
  await sleep(1200);
  ok((await page.evaluate(() => window.__dbg.pileRows())).length === 2, 'both piles are listed after a reload');

  // ---------- 13. a ONE-file pile behaves like a projection: no toast, opens the file wide
  await page.evaluate(() => { const t = document.getElementById('toast'); t.classList.remove('on'); });
  const r3 = await post(page, { paths: [RD('alpha/one.md')], title: 'Just one', source: 'claude-code' });
  ok(r3.status === 200 && r3.body.count === 1, 'one-file pile accepted', r3.body);
  await page.waitForFunction(() => window.__dbg.panel().open && window.__dbg.panel().file === 'one.md', null, { timeout: 15000 });
  ok(true, 'a one-file pile opens the reader on that file');
  ok(await page.evaluate(() => document.body.classList.contains('mode-wide')), 'a one-file pile lands on the wide layout');
  ok((await page.evaluate(() => window.__dbg.mode())) === 'wide', 'layout state machine says wide');
  await sleep(3400);      // past the merge window: a toast would have appeared by now
  ok(!(await page.evaluate(() => document.getElementById('toast').classList.contains('on'))), 'a one-file pile raises no toast');
  ok((await page.evaluate(() => window.__dbg.pileState())) === null, 'a one-file pile does not switch the card stack');
  ok(String(await page.evaluate(() => window.__dbg.lockedFolder())).toLowerCase().endsWith('alpha'), 'it still locks to the file folder');

  // ---------- 14. a TWO-file pile keeps the old behaviour: a toast, nothing opens by itself
  const r4 = await post(page, { paths: [RD('alpha/two.md'), RD('beta/three.md')], title: 'Two notes', source: 'claude-code' });
  ok(r4.status === 200 && r4.body.count === 2, 'two-file pile accepted', r4.body);
  await page.waitForFunction(() => document.getElementById('toast').classList.contains('on'), null, { timeout: 8000 });
  const t2 = await page.evaluate(() => document.getElementById('toast').textContent);
  ok(/2/.test(t2) && t2.includes('Two notes'), 'a two-file pile still shows its toast', t2);
  ok(await page.isVisible('#toast a'), 'the two-file toast still carries the open link');
  ok((await page.evaluate(() => window.__dbg.pileState())) === null, 'a two-file pile does not open itself');
  ok((await page.evaluate(() => window.__dbg.panel().file)) === 'one.md', 'the reader kept the previous file');

  // ---------- 15. ?pile= of a ONE-file pile also opens the file wide (no pile view)
  const onePage = await ctx.newPage();
  await onePage.goto(`${BASE}/?pile=${r3.body.id}`);
  await onePage.waitForFunction(() => window.__dbg && window.__dbg.ready(), null, { timeout: 20000 });
  await onePage.waitForFunction(() => window.__dbg.panel().open && window.__dbg.panel().file === 'one.md', null, { timeout: 15000 });
  ok(true, '?pile= with one file opens the reader');
  ok(await onePage.evaluate(() => document.body.classList.contains('mode-wide')), '?pile= with one file lands on the wide layout');
  ok((await onePage.evaluate(() => window.__dbg.pileState())) === null, '?pile= with one file does not show the pile stack');
  await onePage.close();

  // Missing files affect counts; folder filters do not. No fixture escapes TMP.
  fs.unlinkSync(RD('alpha/two.md'));
  let listed = await (await fetch(BASE + '/api/piles')).json();
  ok(listed.piles.find(p => p.id === r4.body.id).count === 1, 'list count excludes a removed delivered file');
  fs.unlinkSync(RD('beta/three.md'));
  listed = await (await fetch(BASE + '/api/piles')).json();
  ok(listed.piles.find(p => p.id === r4.body.id).count === 0, 'list count becomes zero when every delivered file is gone');
  await page.reload();
  await page.waitForFunction(() => window.__dbg?.ready());
  const emptyCount = page.locator(`[data-pile="${r4.body.id}"] .cnt`);
  await page.waitForFunction(id => document.querySelector(`[data-pile="${id}"] .cnt`)?.textContent === '0', r4.body.id);
  ok(await emptyCount.evaluate(el => el.classList.contains('zero')), 'only an empty pile count is muted');
  ok(/不在了|left/.test(await emptyCount.getAttribute('title')), 'empty count explains the missing files');
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
