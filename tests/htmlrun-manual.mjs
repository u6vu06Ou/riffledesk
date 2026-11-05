import { chromeExecutable } from './chrome-path.mjs';
// tests/htmlrun-manual.mjs — manual acceptance harness for the "run page scripts"
// feature. Builds a temp fixture (canvas painted by a module script that imports a
// sibling lib via an absolute file:/// URL + a rename-attempt victim file), starts
// server.js on PORT 5183 with a temp config, drives headless Chrome, and writes
// docs/screenshots/htmlrun-*.png — look at those pictures with your own eyes.
// Usage: node tests/htmlrun-manual.mjs   (cleans up its temp dir; exit 0/1)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png-pixels.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5183;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const CHROME = chromeExecutable();

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const ok = (cond, tag, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-htmlrun-manual-'));
const RD = p => path.join(TMP, ...p.split('/'));

function buildFixtures() {
  fs.mkdirSync(RD('root/htmlrun'), { recursive: true });
  fs.writeFileSync(RD('root/htmlrun/victim.md'), '# victim\n');
  fs.writeFileSync(RD('root/htmlrun/notes.md'), '# 說明\n這個資料夾是 htmlrun 手動驗收夾具。\n');
  fs.writeFileSync(RD('root/htmlrun/paint-lib.js'), [
    'export function paint(cv) {',
    "  const ctx = cv.getContext('2d');",
    "  const grad = ctx.createLinearGradient(0, 0, cv.width, cv.height);",
    "  grad.addColorStop(0, '#ff8800'); grad.addColorStop(1, '#c040ff');",
    '  ctx.fillStyle = grad;',
    '  ctx.fillRect(0, 0, cv.width, cv.height);',
    "  ctx.fillStyle = '#102030';",
    "  ctx.font = '700 28px system-ui';",
    "  ctx.fillText('module script ran', 40, 130);",
    '}',
    ''
  ].join('\n'));
  const LIB_URL = 'file:///' + RD('root/htmlrun/paint-lib.js').replace(/\\/g, '/');
  const VICTIM = JSON.stringify(RD('root/htmlrun/victim.md'));
  fs.writeFileSync(RD('root/htmlrun/paint.html'), [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<style>html,body{margin:0;padding:0;background:#000}</style>',
    '<canvas id="c" width="520" height="300"></canvas>',
    '<scr' + 'ipt type="module">',
    `import { paint } from '${LIB_URL}';`,
    "const cv = document.getElementById('c');",
    "const ctx = cv.getContext('2d');",
    "ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);",
    'paint(cv);',
    `const victim = ${VICTIM};`,
    'let rejected = false;',
    'try {',
    "  const r = await fetch('/api/rename', { method: 'POST',",
    "    headers: { 'content-type': 'application/json' },",
    "    body: JSON.stringify({ path: victim, newName: 'renamed-by-script.md' }) });",
    '  rejected = !r.ok;',
    '} catch { rejected = true; }',
    "ctx.fillStyle = rejected ? '#00c000' : '#ff0000';",
    "ctx.font = '700 22px system-ui';",
    'ctx.fillText(rejected ? \'/api/rename REJECTED (good)\' : \'/api/rename WENT THROUGH (bad)\', 40, 180);',
    '</scr' + 'ipt>',
    ''
  ].join('\n'));
}

async function startServer() {
  fs.writeFileSync(RD('config.json'), JSON.stringify({ roots: [RD('root')], pinned: [] }, null, 2));
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: RD('config.json'), RIFFLEDESK_INDEX: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let out = '';
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server start timeout: ' + out)), 12000);
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) { clearTimeout(to); res(); } });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', c => rej(new Error('server exited ' + c + ': ' + out)));
  });
  return proc;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  buildFixtures();
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-gpu'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'zh-TW' });
    await ctx.addInitScript(() => {
      try { localStorage.setItem('riffleTipSeen', '1'); localStorage.setItem('floderLang', 'zh'); } catch (_) {}
    });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', m => {
      if (m.type() !== 'error') return;
      // 探針故意從不透明 origin POST /api/rename——被 CORS 擋下正是要驗證的行為
      if (m.location() && /\/api\/rename$/.test(m.location().url || '')) return;
      if (m.text().includes("/api/rename'") && m.text().includes('CORS')) return;
      consoleErrors.push(m.text().slice(0, 200));
    });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__dbg && __dbg.ready(), null, { timeout: 15000 });
    await page.evaluate(([f, id]) => { __dbg.selectChip(id); __dbg.lockFolder(f); },
      [RD('root/htmlrun'), 'html']);
    await page.waitForFunction(() => __dbg.stack().phase === 'idle', null, { timeout: 12000 });
    await sleep(800);
    const idx = await page.evaluate(() => __dbg.fileNames().indexOf('paint.html'));
    ok(idx >= 0, 'card-present', { idx });
    await page.evaluate(i => __dbg.openReader(i), idx);
    await page.waitForFunction(() => __dbg.panel().shown === true, null, { timeout: 8000 });

    // scripts OFF: hint strip + blank canvas
    const off = await page.waitForFunction(() => {
      const ifr = document.querySelector('#readerBody iframe');
      const hint = document.getElementById('readerScriptHint');
      if (!ifr || !hint) return false;
      try {
        const cv = ifr.contentDocument && ifr.contentDocument.querySelector('canvas');
        if (!cv) return false;
        const d = cv.getContext('2d').getImageData(260, 150, 1, 1).data;
        return { hint: hint.classList.contains('on'), hintText: hint.textContent,
          srcdoc: !!ifr.getAttribute('srcdoc'), black: d[0] === 0 && d[1] === 0 && d[2] === 0 };
      } catch (_) { return false; }
    }, null, { timeout: 8000 }).then(h => h.jsonValue()).catch(() => null);
    ok(off && off.hint && off.black && off.srcdoc, 'off-state', off);
    await sleep(800);
    await page.screenshot({ path: path.join(SHOTS, 'htmlrun-01-off.png') });
    console.log('shot ' + path.join(SHOTS, 'htmlrun-01-off.png'));

    // click ▶
    await page.click('#btnRun');
    await page.waitForFunction(() => {
      const ifr = document.querySelector('#readerBody iframe');
      return ifr && (ifr.getAttribute('src') || '').startsWith('/raw/');
    }, null, { timeout: 8000 });
    await sleep(2500);
    await page.screenshot({ path: path.join(SHOTS, 'htmlrun-02-on.png') });
    console.log('shot ' + path.join(SHOTS, 'htmlrun-02-on.png'));

    // objective pixel proof (also what the screenshots show)
    const box = await page.evaluate(() => {
      const ifr = document.querySelector('#readerBody iframe');
      const r = ifr.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const buf = await page.screenshot({ clip: { x: box.x + 60, y: box.y + 60, width: 200, height: 120 } });
    const img = decodePng(buf);
    let colorful = 0, total = 0;
    for (let y = 0; y < img.height; y += 3) for (let x = 0; x < img.width; x += 3) {
      total++;
      const [r, g, b] = img.px(x, y);
      if (r > 120 && g < 200 && b > 40) colorful++;   // 漸層橙~紫都算
    }
    ok(total > 0 && colorful / total > 0.4, 'painted-pixels', { colorful, total });
    await sleep(800);
    ok(fs.existsSync(RD('root/htmlrun/victim.md')) && !fs.existsSync(RD('root/htmlrun/renamed-by-script.md')),
      'victim-not-renamed');
    ok(consoleErrors.length === 0, 'console-errors-zero', consoleErrors.slice(0, 5));
  } finally {
    try { await browser.close(); } catch (_) {}
    try { server.kill(); } catch (_) {}
    await Promise.race([new Promise(r => server.once('exit', r)), sleep(3000)]);
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 6, retryDelay: 500 }); } catch (_) {}
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nmanual checks passed');
  process.exitCode = failed ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
