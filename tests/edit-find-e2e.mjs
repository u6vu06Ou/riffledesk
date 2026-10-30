// tests/edit-find-e2e.mjs — acceptance for edit-in-reader + find/replace-in-reader.
// Port 5184 (never 5177/5178/5179). Builds its own throwaway fixture tree, drives
// headless Chrome, writes docs/screenshots/{edit-mode,find-bar,conflict}.png
// (conflict shot is taken in the dark theme; the other two in the light theme).
// Usage: node tests/edit-find-e2e.mjs
// CSP note: waitForFunction predicates must go through window.__dbg (string-eval path trips).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5184;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const consoleErrors = [];
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

// ---------------------------------------------------------------- fixture
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-editfind-'));
const RD = p => path.join(TMP, ...p.split('/'));
const MD_PATH = RD('root/note.md');
const ORIGINAL = '# 原始標題\r\n\r\n第一行原本內容。\r\n\r\nneedle one, needle two, NEEDLE three.\r\n\r\n最後一行。\r\n';
function buildFixtures() {
  fs.mkdirSync(RD('root'), { recursive: true });
  fs.writeFileSync(MD_PATH, ORIGINAL);                 // deliberately CRLF: EOL must survive a save
  fs.writeFileSync(RD('root/other.md'), '# 別的檔\n');
}
const CFG = path.join(TMP, 'config.json');

function startServer() {
  fs.writeFileSync(CFG, JSON.stringify({ roots: [RD('root')], pinned: [], convoRoots: [] }, null, 2));
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: CFG, RIFFLEDESK_INDEX: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  return new Promise((res, rej) => {
    let out = '';
    const to = setTimeout(() => rej(new Error('server start timeout: ' + out)), 12000);
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) { clearTimeout(to); res(proc); } });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', c => rej(new Error('server exited ' + c + ': ' + out)));
  });
}

// card aim / real click: the stack is WebGL, so probe pickAt until the click lands on the card
async function cardAimPoint(page, idx) {
  return page.evaluate(i => {
    const c = window.__dbg.cardScreen(i);
    if (!c || c.mode !== 'home') return null;
    const b = window.__dbg.cardBounds(i);
    if (!b) return { x: c.x, y: c.y };
    const probe = (x, y) => { const p = window.__dbg.pickAt(x, y); return p && p.fileIdx === i; };
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
  for (let round = 0; round < 3; round++) {
    const v = await page.evaluate(() => window.__dbg.viewRect());
    await page.mouse.move(v.x + v.w - 30, v.y + 40, { steps: 6 });
    await sleep(600);
    let pt = await cardAimPoint(page, idx);
    if (!pt) continue;
    for (let aim = 0; aim < 4; aim++) {
      await page.mouse.move(pt.x, pt.y, { steps: 8 });
      await sleep(600);
      const npt = await cardAimPoint(page, idx);
      if (npt) pt = npt;
      const pick = await page.evaluate(p => window.__dbg.pickAt(p.x, p.y), pt);
      if (pick && pick.fileIdx === idx) break;
    }
    const pick = await page.evaluate(p => window.__dbg.pickAt(p.x, p.y), pt);
    if (!pick || pick.fileIdx !== idx) continue;
    await page.mouse.down(); await sleep(70); await page.mouse.up();
    try {
      await page.waitForFunction(
        () => window.__dbg.stack().extracted != null && window.__dbg.panel().shown === true,
        null, { timeout: 6000 });
      return { ok: true };
    } catch (e) { /* retry */ }
  }
  return null;
}
const waitIdle = page => page.waitForFunction(
  () => window.__dbg.stack().phase === 'idle', null, { timeout: 12000 });
const editorFocused = page => page.evaluate(() =>
  document.querySelector('#readerBody .editview .ev-editor').focus());

async function main() {
  buildFixtures();
  fs.mkdirSync(SHOTS, { recursive: true });
  const proc = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--allow-pre-commit-input'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('riffleTipSeen', '1');
      localStorage.setItem('floderLang', 'zh');
      localStorage.setItem('riffleConvoAuto', '0');
    } catch (_) {}
  });
  const page = await ctx.newPage();
  // the deliberate 409 (conflict probe) shows up as a failed-resource line: not a bug
  page.on('console', m => {
    if (m.type() === 'error' && !/409 \(Conflict\)/.test(m.text())) consoleErrors.push(m.text());
  });
  page.on('pageerror', e => consoleErrors.push(String(e.stack || e)));
  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.__dbg && window.__dbg.ready()), null, { timeout: 15000 });
    await page.evaluate(p => window.__dbg.lockFolder(p), RD('root'));
    await waitIdle(page);
    await page.evaluate(() => window.__dbg.selectChip('md'));
    await page.waitForFunction(() => window.__dbg.fileNames(20).includes('note.md'), null, { timeout: 8000 });
    const idx = await page.evaluate(() => window.__dbg.fileNames(50).indexOf('note.md'));
    ok(await realOpenCard(page, idx), 'open-note');

    // ---- visible edit button (with a shortcut in its tooltip) ----
    const editBtn = await page.evaluate(() => {
      const b = document.getElementById('btnEdit');
      return b && !b.hidden && b.offsetParent !== null && b.title;
    });
    ok(editBtn, 'edit-btn-visible', editBtn);

    // ---- enter edit mode, type, save with Ctrl+S ----
    await page.evaluate(() => document.getElementById('btnEdit').click());
    await page.waitForFunction(() => !!document.querySelector('#readerBody .editview'), null, { timeout: 5000 });
    await editorFocused(page);
    await page.keyboard.press('End');
    await page.keyboard.type('（新增的尾巴）');
    await sleep(250);
    ok(await page.evaluate(() => document.getElementById('readerTitle').classList.contains('dirty')), 'dirty-indicator');
    await page.screenshot({ path: path.join(SHOTS, 'edit-mode.png') });
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('已存檔'), null, { timeout: 5000 });
    const saved = fs.readFileSync(MD_PATH, 'utf8');
    ok(saved.includes('（新增的尾巴）'), 'ctrl-s-writes-disk');
    ok(saved.includes('\r\n') && !/[^\r]\n/.test(saved.replace(/\r\n/g, '\r\r')), 'crlf-preserved');

    // ---- Ctrl+Z on the ↶ button restores the previous bytes ----
    await page.evaluate(() => document.getElementById('btnUndoTop').click());
    await page.waitForFunction(() => !document.getElementById('toast').textContent.includes('已存檔') , null, { timeout: 5000 }).catch(() => {});
    await sleep(900);
    const undone = fs.readFileSync(MD_PATH, 'utf8');
    ok(undone === ORIGINAL, 'undo-restores-original', undone.slice(0, 20));

    // ---- conflict: external write, then save must ask and must NOT clobber ----
    fs.writeFileSync(MD_PATH, '# AI 改過\r\n\r\n外部寫入。\r\n');
    await editorFocused(page);
    await page.keyboard.type('X');
    await sleep(200);
    await page.evaluate(() => window.__dbg.setTheme && window.__dbg.setTheme('dark'));
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.getElementById('editConflict').classList.contains('on'), null, { timeout: 5000 });
    ok(fs.readFileSync(MD_PATH, 'utf8').startsWith('# AI 改過'), 'conflict-disk-untouched');
    await page.screenshot({ path: path.join(SHOTS, 'conflict.png') });
    const btns = await page.evaluate(() => [...document.querySelectorAll('#editConflict button')].map(b => b.textContent.trim()));
    ok(btns.length >= 3, 'conflict-has-3-choices', btns);
    await page.evaluate(() => document.querySelector('#editConflict [data-c="diff"]').click());
    await page.waitForFunction(() => !!document.querySelector('#editConflict .diff.on'), null, { timeout: 5000 });
    await page.evaluate(() => document.querySelector('#editConflict [data-c="overwrite"]').click());
    await page.waitForFunction(() => !document.getElementById('editConflict').classList.contains('on'), null, { timeout: 5000 });
    await sleep(600);
    ok(fs.readFileSync(MD_PATH, 'utf8').includes('X'), 'overwrite-wins');

    // ---- find: N matches, next, replace all ----
    await editorFocused(page);
    await page.keyboard.press('Control+f');
    await page.waitForFunction(() => !document.getElementById('findBar').hidden, null, { timeout: 4000 });
    await page.fill('#findBar .fq', 'needle');
    await page.waitForFunction(() => /\/ 3/.test(document.querySelector('#findBar .fc').textContent), null, { timeout: 5000 });
    const navigated = await page.evaluate(() => document.querySelector('#findBar .fc').textContent);
    await page.click('#findBar .fdown');
    await sleep(250);
    ok(await page.evaluate(() => document.querySelector('#findBar .fc').textContent) !== navigated, 'find-next-moves');
    await page.waitForFunction(() => !!document.querySelector('#readerBody mark.fhit.cur'), null, { timeout: 5000 });
    await page.screenshot({ path: path.join(SHOTS, 'find-bar.png') });
    await page.fill('#findBar .frep', 'PIN');
    await page.evaluate(() => document.querySelector('#findBar .frepall').click());
    await sleep(400);
    ok(await page.evaluate(() => document.querySelectorAll('#readerBody mark.fhit').length) === 0, 'replace-all-clears-marks');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('已存檔'), null, { timeout: 8000 });
    await sleep(400);
    const rep = fs.readFileSync(MD_PATH, 'utf8');
    ok(rep.includes('PIN one, PIN two, PIN three.'), 'replace-all-written', rep.slice(0, 80));
    ok(!/needle/i.test(rep), 'replace-all-case-insensitive');

    // ---- unsaved-leave guard is in-page, not an alert ----
    await page.keyboard.press('Escape');           // close the find bar
    await sleep(200);
    await editorFocused(page);
    await page.keyboard.type('!!');
    await sleep(200);
    await page.evaluate(() => document.getElementById('btnClose').click());
    await page.waitForFunction(() => document.getElementById('editGuard').classList.contains('on'), null, { timeout: 4000 });
    ok(await page.evaluate(() => !!document.querySelector('#editGuard [data-c="drop"]')), 'guard-in-page');
    await page.evaluate(() => document.querySelector('#editGuard [data-c="drop"]').click());
    await sleep(500);
    ok(await page.evaluate(() => window.__dbg.mode() === 'twocol'), 'guard-drop-leaves');

    ok(consoleErrors.length === 0, 'console-errors-zero', consoleErrors.slice(0, 5));
  } finally {
    await browser.close();
    try { proc.kill(); } catch (_) {}
    await sleep(400);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error('FATAL', err); process.exit(2); });
