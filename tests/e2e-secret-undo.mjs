import { chromeExecutable } from './chrome-path.mjs';
// e2e acceptance for Feature A (secret-leak warning) + B (Ctrl+Z undo).
// playwright-core + system Chrome, headless, port 5181 (per ticket).
// Fixture: tests/fixtures/secretdemo (fake keys only). Screenshots go to
// docs/screenshots/secret-*.png and undo-*.png; the test index.db next to
// _test-config-secret.json is deleted at the end (disk cap rule).
// Usage: node tests/e2e-secret-undo.mjs   (starts its own server, kills it at the end)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5181;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const DEMO = path.join(FIX, 'secretdemo');
const CFG_TMP = path.join(FIX, '_test-config-secret.json');
const CHROME = chromeExecutable();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = { consoleErrors: [] };
let failed = 0;
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

async function startServer() {
  fs.writeFileSync(CFG_TMP, JSON.stringify({
    roots: [DEMO], pinned: [DEMO], convoRoots: []
  }, null, 2));
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: CFG_TMP },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let out = '';
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server start timeout: ' + out)), 8000);
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) { clearTimeout(to); res(); } });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', c => rej(new Error('server exited ' + c + ': ' + out)));
  });
  return proc;
}

// same pointer-storm-safe opener as tests/e2e.mjs (copied, trimmed)
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
  let lastPick = null, lastPt = null;
  for (let round = 0; round < 3; round++) {
    const v = await page.evaluate(() => __dbg.viewRect());
    await page.mouse.move(v.x + v.w - 30, v.y + 40, { steps: 6 });
    await sleep(700);
    let pt = await cardAimPoint(page, idx);
    if (!pt) continue;
    for (let aim = 0; aim < 4; aim++) {
      await page.mouse.move(pt.x, pt.y, { steps: 8 });
      await sleep(700);
      const npt = await cardAimPoint(page, idx);
      if (npt) pt = npt;
      const pick = await page.evaluate(p => __dbg.pickAt(p.x, p.y), pt);
      if (pick && pick.fileIdx === idx) break;
    }
    const pick = await page.evaluate(p => __dbg.pickAt(p.x, p.y), pt);
    lastPick = pick; lastPt = pt;
    if (!pick || pick.fileIdx !== idx) continue;
    await page.mouse.down(); await sleep(70); await page.mouse.up();
    try {
      await page.waitForFunction(() => __dbg.stack().extracted != null && __dbg.panel().shown === true,
        null, { timeout: 6000 });
    } catch (e) {
      return { ok: false, reason: 'no-extract-after-click', at: pt };
    }
    return { ok: true, at: pt, rounds: round + 1 };
  }
  return { ok: false, reason: 'pick-mismatch', pick: lastPick, at: lastPt };
}

// Escape peels off one layout layer per press (full → wide → threecol → put back):
// press until the card is home (bounded), instead of assuming a single press suffices
async function escPutBack(page) {
  for (let k = 0; k < 4; k++) {
    const done = await page.evaluate(() => __dbg.mode() === 'twocol' && !__dbg.stack().extracted);
    if (done) break;
    await page.keyboard.press('Escape');
    await sleep(350);
  }
  await page.waitForFunction(() => __dbg.mode() === 'twocol' && !__dbg.stack().extracted,
    null, { timeout: 6000 });
  await sleep(600);
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const oldName = path.join(DEMO, 'rename-me.md');
  const newName = path.join(DEMO, 'rename-me-2.md');
  const server = await startServer();
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--enable-gpu']
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.setItem('floderLang', 'zh'); } catch (_) {} });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') results.consoleErrors.push(m.text()); });
  page.on('pageerror', e => results.consoleErrors.push('pageerror: ' + e.message));
  const shot = async name => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); console.log('shot', name); };

  try {
    // ---------- API level first (cheap, deterministic) ----------
    {
      const r = await (await fetch(BASE + '/api/list?path=' + encodeURIComponent(DEMO) + '&exts=.md')).json();
      const byName = Object.fromEntries(r.files.map(f => [f.name, !!f.secret]));
      ok(byName['keys-note.md'] === true, 'e2e-list-secret-flag', byName);
      ok(byName['prose-note.md'] === false, 'e2e-list-clean-not-flagged');
      const raw = JSON.stringify(r);
      ok(!raw.includes('Sup3rS3cret'), 'e2e-list-no-leak');
    }

    // ---------- UI ----------
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__dbg && __dbg.ready(), null, { timeout: 9000 });
    await sleep(500);
    await page.evaluate(p => __dbg.lockFolder(p), DEMO);
    await page.waitForFunction(() => __dbg.stack().phase === 'idle', null, { timeout: 9000 });
    await sleep(1400); // camera settle + first thumbs (badges render inside the thumbnails)
    ok((await page.evaluate(() => __dbg.stack().files)) === 3, 'e2e-demo-folder-loaded-3files');

    // ⚠ badge visible ON the card: check the secret file's card pixel-cluster around
    // the badge corner — but a pure visual check is what the screenshot is for;
    // here we assert the flag made it into the slot's file payload (drives drawTab).
    ok(await page.evaluate(() => {
      const i = __dbg.fileNames().indexOf('keys-note.md');
      const vis = __dbg.visibleCards().find(c => c.fileIdx === i);
      return !!(vis && __dbg.fileSecret(i) === true);
    }), 'e2e-card-slot-secret-flag');
    await shot('secret-card');

    // open the flagged card → reader warning strip with masked matches
    const keyIdx = await page.evaluate(() => __dbg.fileNames().indexOf('keys-note.md'));
    {
      const res = await realOpenCard(page, keyIdx);
      ok(res.ok, 'e2e-open-flagged-card', res.ok ? undefined : res);
      await sleep(1200);
      await page.waitForFunction(() => {
        const el = document.getElementById('readerSecret');
        return el && el.classList.contains('on') && el.textContent.length > 10;
      }, null, { timeout: 5000 });
      // wait for the masked hits fetch to land (≤ 5 s)
      await page.waitForFunction(() => {
        const el = document.getElementById('readerSecret');
        return el.querySelector('.hits') && el.querySelector('.hits').textContent.includes('第');
      }, null, { timeout: 5000 });
      const txt = await page.evaluate(() => document.getElementById('readerSecret').textContent);
      ok(txt.includes('這個檔案可能含有密碼或金鑰'), 'e2e-reader-warn-line');
      ok(/第\s*\d+\s*行/.test(txt), 'e2e-reader-line-numbers', { has: txt.slice(0, 60) });
      ok(txt.includes('sk-F•') || txt.includes('sk-an'), 'e2e-reader-masked-shows-4');
      ok(!txt.includes('Sup3rS3cret') && !txt.includes('FAKEDEMO0000FAKEDEMO0000'),
        'e2e-reader-no-secret-leak');
      await shot('secret-reader');
      await escPutBack(page);
    }

    // ---------- rename via the UI path, then Ctrl+Z ----------
    const renIdx = await page.evaluate(() => __dbg.fileNames().indexOf('rename-me.md'));
    ok(renIdx >= 0, 'e2e-rename-target-present');
    {
      const res = await realOpenCard(page, renIdx);
      ok(res.ok, 'e2e-open-rename-target', res.ok ? undefined : res);
      await sleep(900);
      await page.click('#btnMore');
      await sleep(300);
      // 重新命名… menu item
      const menuOk = await page.evaluate(() => {
        const it = [...document.querySelectorAll('#ctxMenu .it')].find(d => d.textContent.includes('重新命名'));
        if (it) { it.click(); return true; }
        return false;
      });
      ok(menuOk, 'e2e-rename-menu-click');
      await sleep(300);
      await page.fill('#dlg .inp', 'rename-me-2.md');
      await page.click('#dlg .yes');
      await sleep(900);
      // toast carries the 復原 action link
      const toastTxt = await page.evaluate(() => document.getElementById('toast').textContent);
      ok(toastTxt.includes('完成') && toastTxt.includes('復原'), 'e2e-toast-has-undo-link', { toastTxt });
      ok(fs.existsSync(newName) && !fs.existsSync(oldName), 'e2e-rename-landed-on-disk');
      await shot('undo-rename-toast');
      // put the reader back BEFORE Ctrl+Z (undo of the reader's open file is fine, but keep it simple)
      await escPutBack(page);

      // Ctrl+Z → toast 已復原 + file back on disk
      await page.keyboard.press('Control+z');
      await sleep(1200);
      const toast2 = await page.evaluate(() => document.getElementById('toast').textContent);
      ok(toast2.includes('已復原'), 'e2e-undo-toast', { toast2 });
      ok(fs.existsSync(oldName) && !fs.existsSync(newName), 'e2e-undo-restored-on-disk');
      await shot('undo-rename-restored');
    }
  } finally {
    // cleanup: never leave renamed artefacts or the test index behind
    try { if (fs.existsSync(newName)) fs.renameSync(newName, oldName); } catch (_) {}
    try { await browser.close(); } catch (_) {}
    try { server.kill(); } catch (_) {}
    await Promise.race([new Promise(r => server.once('exit', r)), sleep(3000)]);
    await sleep(300);
    for (const f of [CFG_TMP,
      path.join(FIX, 'index.db'), path.join(FIX, 'index.db-wal'), path.join(FIX, 'index.db-shm'),
      path.join(FIX, 'index.db-journal')]) {
      try { fs.rmSync(f, { force: true }); } catch (_) {}
    }
  }

  ok(results.consoleErrors.length === 0, 'console-errors-zero', results.consoleErrors.slice(0, 4));
  console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nall assertions passed');
  process.exitCode = failed ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
