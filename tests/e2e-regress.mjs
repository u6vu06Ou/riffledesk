// tests/e2e-regress.mjs — permanent regression suite (ported from the lead's
// ad-hoc manual checks cnt/conv/scrub/img2/hide + secret/undo). Fully
// self-contained: builds its own fixture tree + fake Claude transcripts under
// os.tmpdir(), starts server.js on port 5186 with a temp config (temp index.db
// lives next to it), runs headless Chrome, shuts everything down, exit 0/1.
// Never touches the repo's config.json/index.db or the user's real folders.
// Usage: node tests/e2e-regress.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png-pixels.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5186;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const IMAGE_EXTS = '.png,.jpg,.jpeg,.gif,.webp,.svg';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const consoleErrors = [];
function ok(cond, tag, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + tag + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  if (!cond) failed++;
}

// ---------------------------------------------------------------- fixture tree
//  TMP/
//    config.json  index.db…          (temp config; index db next to it)
//    root/                           browse root
//      plain/     a.md b.txt c.json d.html data.csv main.py   (chip-cycling target)
//        nested/sunny/            more mixed files            (nested folder rows)
//      images/    5× .png         photo-a…e                    (image cards)
//      noimg/     only-a-note.md  (0 direct images)
//        pics/    p1.png p2.png   (parent shows ↳2, stays visible; also pinned)
//      nv/        p1.md                 (arrow-key nav fixture)
//        a-first/  f1.md f2.md
//        b-empty/                        (truly empty: must be skipped)
//        c-wrap/                         (0 direct files → descended, not landed)
//          c1-deep/ d1.md
//        d-last/   l1.md
//      big/       45 × card-NN.md (scrubber, ≥ SCRUB_MIN 30)
//      live/      live-a.md live-b.md   (2 more written during the live check)
//      secret/    keys-note.md (fake keys) prose-note.md (clean) rename-me.md
//    claude-proj/slug-x/*.jsonl   fake transcripts (cli + sdk automated)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-regress-'));
const RD = p => path.join(TMP, ...p.split('/'));            // root-tree path builder
const T = min => new Date(Date.now() - min * 60000).toISOString();
// 1×1 transparent PNG (α corner pixels green so the card is not invisible)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const SECRET_NOTE = `# demo (every key below is fake)
openai = "sk-FAKE00000000000000000000000000"
anthropic = "sk-ant-api03-FAKEFAKEFAKEFAKE"
password = "Sup3rS3cret!demo"
`;
const PROSE_NOTE = '# clean notes\n\npassword = "xxxxxx" and api_key: <your-key-here> are placeholders — not real leaks.\n';

function writeClaudeSession(file, sessionId, entrypoint, userText, writtenFiles) {
  const lines = [];
  lines.push(JSON.stringify({
    type: 'user', sessionId, entrypoint, cwd: RD('root'),
    timestamp: T(30),
    message: { role: 'user', content: userText }
  }));
  writtenFiles.forEach((f, i) => {
    lines.push(JSON.stringify({
      type: 'assistant', sessionId, entrypoint, cwd: RD('root'),
      timestamp: T(28 - i * 2),
      message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Write', input: { file_path: f } }
      ] }
    }));
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

const CLI_WROTE = [RD('root/plain/ai-note-1.md'), RD('root/plain/ai-note-2.md')];
function buildFixtures() {
  fs.mkdirSync(RD('root/plain/nested/sunny'), { recursive: true });
  fs.mkdirSync(RD('root/images'), { recursive: true });
  fs.mkdirSync(RD('root/noimg/pics'), { recursive: true });
  fs.mkdirSync(RD('root/big'), { recursive: true });
  fs.mkdirSync(RD('root/live'), { recursive: true });
  fs.mkdirSync(RD('root/secret'), { recursive: true });

  const plain = {
    'a.md': '# Alpha\nchip cycling fixture\n', 'b.txt': 'plain text fixture\n',
    'c.json': '{"ok":true}\n', 'd.html': '<!doctype html><title>d</title><p>d</p>\n',
    'data.csv': 'a,b\n1,2\n',
    // 程式碼配色檢查用：python＋js 各一個小檔（要有 keyword/string/comment），
    // 外加一個 300KB 的大 js（走非同步 worker 上色路徑）
    'main.py': '# demo comment\nimport sys\n\ndef main():\n    print("hi", sys.argv[1:])\n\nif __name__ == "__main__":\n    main()\n',
    'app.js': '// demo app\nconst greeting = "hello";\nfunction add(a, b) { return a + b; }\nconsole.log(greeting, add(1, 2));\n',
    'big.js': (() => {
      let s = '';
      for (let i = 0; s.length < 300 * 1024; i++)
        s += `// chunk ${i}\nfunction fib${i}(n) { return n < 2 ? n : fib${i}(n - 1) + fib${i}(n - 2); }\n` +
          `const NAME_${i} = "value-${i}";\nexport { fib${i}, NAME_${i} };\n`;
      return s;
    })()
  };
  for (const [n, c] of Object.entries(plain)) fs.writeFileSync(RD('root/plain/' + n), c);
  fs.writeFileSync(RD('root/plain/nested/n1.md'), '# nested one\n');
  fs.writeFileSync(RD('root/plain/nested/nested-note.txt'), 'nested text\n');
  fs.writeFileSync(RD('root/plain/nested/sunny/s1.md'), '# sunny md\n');
  fs.writeFileSync(RD('root/plain/nested/sunny/s2.html'), '<!doctype html><title>s2</title>\n');

  const png = Buffer.from(PNG_B64, 'base64');
  for (const n of ['photo-a.png', 'photo-b.png', 'photo-c.png', 'photo-d.png', 'photo-e.png'])
    fs.writeFileSync(RD('root/images/' + n), png);
  fs.writeFileSync(RD('root/noimg/only-a-note.md'), '# no images here directly\n');
  fs.writeFileSync(RD('root/noimg/pics/p1.png'), png);
  fs.writeFileSync(RD('root/noimg/pics/p2.png'), png);

  for (let i = 1; i <= 45; i++)
    fs.writeFileSync(RD(`root/big/card-${String(i).padStart(2, '0')}.md`), `# card ${i}\nscrubber fixture\n`);

  // 分頁夾具：360 個 md（> /api/list 第一頁 300）— mtime 越大越新
  fs.mkdirSync(RD('root/pg'), { recursive: true });
  {
    const base = Date.now() - 400000;
    for (let i = 1; i <= 360; i++) {
      const f = RD(`root/pg/p${String(i).padStart(3, '0')}.md`);
      fs.writeFileSync(f, `# p${i}\npagination fixture\n`);
      const t = new Date(base + i * 1000);
      fs.utimesSync(f, t, t);
    }
  }

  fs.writeFileSync(RD('root/live/live-a.md'), '# live a\n');
  fs.writeFileSync(RD('root/live/live-b.md'), '# live b\n');

  fs.writeFileSync(RD('root/secret/keys-note.md'), SECRET_NOTE);
  fs.writeFileSync(RD('root/secret/prose-note.md'), PROSE_NOTE);
  fs.writeFileSync(RD('root/secret/rename-me.md'), '# rename me\n');

  // run-page-scripts fixture: an HTML whose only content is painted by a module
  // script that imports a sibling lib via an ABSOLUTE file:/// URL (the real-world
  // case that motivated the feature), plus a victim file the page tries to rename
  // through /api/rename — from the opaque sandbox that must fail (green corner =
  // rejected, red = renamed; the run-mode checks read the pixels off a screenshot)
  fs.mkdirSync(RD('root/htmlrun'), { recursive: true });
  fs.writeFileSync(RD('root/htmlrun/victim.md'), '# victim\n');
  fs.writeFileSync(RD('root/htmlrun/paint-lib.js'), [
    'export function paint(cv) {',
    "  const ctx = cv.getContext('2d');",
    "  ctx.fillStyle = '#ff8800';",
    '  ctx.fillRect(0, 0, cv.width, cv.height);',
    '}',
    ''
  ].join('\n'));
  const LIB_URL = 'file:///' + RD('root/htmlrun/paint-lib.js').replace(/\\/g, '/');
  const VICTIM = JSON.stringify(RD('root/htmlrun/victim.md'));
  fs.writeFileSync(RD('root/htmlrun/paint.html'), [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<style>html,body{margin:0;padding:0;background:#000}</style>',
    '<canvas id="c" width="240" height="240"></canvas>',
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
    '} catch { rejected = true; }   // CORS preflight refused from an opaque origin = also safe',
    "ctx.fillStyle = rejected ? '#00c000' : '#ff0000';",
    'ctx.fillRect(0, 0, 40, 40);',
    // 告訴負責看畫面的人：跑到這裡代表腳本真的執行了
    '</scr' + 'ipt>',
    ''
  ].join('\n'));

  // arrow-key navigation: parent with files, then (in DFS listing order) a folder
  // with files, a truly empty one, a wrapper folder with files only below it, and
  // a last folder with files
  fs.mkdirSync(RD('root/nv/a-first'), { recursive: true });
  fs.mkdirSync(RD('root/nv/b-empty'), { recursive: true });
  fs.mkdirSync(RD('root/nv/c-wrap/c1-deep'), { recursive: true });
  fs.mkdirSync(RD('root/nv/d-last'), { recursive: true });
  fs.writeFileSync(RD('root/nv/p1.md'), '# nv parent note\n');
  fs.writeFileSync(RD('root/nv/a-first/f1.md'), '# f1\n');
  fs.writeFileSync(RD('root/nv/a-first/f2.md'), '# f2\n');
  fs.writeFileSync(RD('root/nv/c-wrap/c1-deep/d1.md'), '# d1\n');
  fs.writeFileSync(RD('root/nv/d-last/l1.md'), '# l1\n');
  // /api/list 目錄排序＝mtime 新→舊（再來才是名字）；靠建立順序會得到反順序。
  // 固定 mtime 讓顯示順序恆為 a-first → b-empty → c-wrap → d-last（測試斷言依賴這個）
  {
    const base = Date.now() - 60000;
    ['d-last', 'c-wrap', 'b-empty', 'a-first'].forEach((d, i) => {
      const t = new Date(base + i * 1000);
      fs.utimesSync(RD('root/nv/' + d), t, t);
    });
  }

  for (const f of CLI_WROTE) fs.writeFileSync(f, '# written by fake session\n');
  fs.mkdirSync(path.join(TMP, 'claude-proj', 'slug-x'), { recursive: true });
  writeClaudeSession(path.join(TMP, 'claude-proj', 'slug-x', 'ses-cli.jsonl'),
    'ses-cli', 'cli', '迴歸測試假對話：寫兩個檔', CLI_WROTE);
  writeClaudeSession(path.join(TMP, 'claude-proj', 'slug-x', 'ses-auto.jsonl'),
    'ses-auto', 'sdk', 'auto batch ticket writes', [RD('root/plain/ai-auto.md')]);
  fs.writeFileSync(RD('root/plain/ai-auto.md'), '# written by automated session\n');
}

const CFG_PATH = path.join(TMP, 'config.json');
async function startServer() {
  fs.writeFileSync(CFG_PATH, JSON.stringify({
    roots: [RD('root')],
    pinned: [RD('root/noimg')],
    convoRoots: [{ kind: 'claude', dir: path.join(TMP, 'claude-proj') }]
  }, null, 2));
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: CFG_PATH },
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

async function waitCrawlDone(deadlineMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const d = await (await fetch(BASE + '/api/index/status')).json();
      if (d.available && !d.crawling && d.roots && d.roots.length && d.lastCrawlMs != null) return d;
    } catch (_) {}
    if (Date.now() - t0 > deadlineMs) return null;
    await sleep(500);
  }
}

// ---- pointer-storm-safe card opener (same approach as tests/e2e.mjs) ----
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
  for (let round = 0; round < 3; round++) {
    const v = await page.evaluate(() => __dbg.viewRect());
    await page.mouse.move(v.x + v.w - 30, v.y + 40, { steps: 6 });
    await sleep(600);
    let pt = await cardAimPoint(page, idx);
    if (!pt) continue;
    for (let aim = 0; aim < 4; aim++) {
      await page.mouse.move(pt.x, pt.y, { steps: 8 });
      await sleep(600);
      const npt = await cardAimPoint(page, idx);
      if (npt) pt = npt;
      const pick = await page.evaluate(p => __dbg.pickAt(p.x, p.y), pt);
      if (pick && pick.fileIdx === idx) break;
    }
    const pick = await page.evaluate(p => __dbg.pickAt(p.x, p.y), pt);
    if (!pick || pick.fileIdx !== idx) continue;
    await page.mouse.down(); await sleep(70); await page.mouse.up();
    try {
      await page.waitForFunction(() => __dbg.stack().extracted != null && __dbg.panel().shown === true,
        null, { timeout: 6000 });
      return { ok: true };
    } catch (e) { return { ok: false, reason: 'no-extract-after-click' }; }
  }
  return { ok: false, reason: 'pick-mismatch' };
}
async function escPutBack(page) {
  for (let k = 0; k < 4; k++) {
    const done = await page.evaluate(() => __dbg.mode() === 'twocol' && !__dbg.stack().extracted);
    if (done) break;
    await page.keyboard.press('Escape');
    await sleep(350);
  }
  await page.waitForFunction(() => __dbg.mode() === 'twocol' && !__dbg.stack().extracted,
    null, { timeout: 6000 });
  await sleep(500);
}

async function waitIdle(page, ms = 300) {
  await page.waitForFunction(() => __dbg.stack().phase === 'idle', null, { timeout: 12000 });
  await sleep(ms);
}

// ---------------------------------------------------------------- main
async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  buildFixtures();
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-gpu'] });
  const shot = async (pg, name) => {
    const p = path.join(SHOTS, 'regress-' + name + '.png');
    await pg.screenshot({ path: p });
    console.log('shot ' + p);
  };

  try {
    // Wait for the index crawler before opening the page: deepCount drives the
    // hide-empty check, and the server must not be mid-crawl when it runs.
    const crawl = await waitCrawlDone();
    ok(!!crawl, 'index-crawl-finished', crawl && { files: crawl.files, ms: crawl.lastCrawlMs });

    const ctx = await browser.newContext({
      viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, locale: 'zh-TW'
    });
    await ctx.addInitScript(() => {
      try {
        // 探針靠 performance resource entries 追 /api/list；Chrome 預設只留 250 筆，
        // chips 循環會超過（實測 ~276），滿了就丟新條目 → 探針永遠看不到 → 假 FAIL。
        performance.setResourceTimingBufferSize(4096);
        localStorage.setItem('riffleTipSeen', '1');
        localStorage.setItem('floderLang', 'zh');
        localStorage.setItem('riffleHideEmpty', '0');   // hide-empty starts OFF; the check ticks it on
        localStorage.setItem('riffleConvoAuto', '0');   // automated sessions start folded
      } catch (_) {}
    });
    const page = await ctx.newPage();
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const txt = m.text();
      if (txt.includes('/api/events') && txt.includes('ERR_ABORTED')) return;  // EventSource abort on reload
      // htmlrun 探針故意從不透明 origin POST /api/rename——「被 CORS 擋下」正是要驗證的行為
      if (m.location() && /\/api\/rename$/.test(m.location().url || '')) return;
      if (txt.includes("/api/rename'") && txt.includes('CORS')) return;
      consoleErrors.push(txt.slice(0, 300));
    });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    // playwright 的 string-eval 路徑在這個 CSP 下對「window.__dbg && 裸 __dbg」混用會炸；
    // 全部用 window. 前綴（或不碰 __dbg）的寫法
    await page.waitForFunction(() => !!(window.__dbg && window.__dbg.ready()), null, { timeout: 15000 });
    // make every fixture folder row visible in the local tree
    for (const p of ['root', 'root/plain', 'root/plain/nested', 'root/noimg'])
      await page.evaluate(x => __dbg.expandTreeNode(x), RD(p));
    await page.evaluate(x => __dbg.lockFolder(x), RD('root/plain'));
    await waitIdle(page, 900);

    // ------------------------------------------------ check 1: chip cycling
    // The page's own exts param comes from the latest /api/list resource entry for the
    // locked folder (no 'nofiles'). Poll until tree counts + stack agree with the API
    // for that exts — chip switches are async, so fixed sleeps would flake.
    const measure = t0 => page.evaluate(async (t) => {
      const lists = performance.getEntriesByType('resource')
        .filter(e => e.name.includes('/api/list') && !e.name.includes('nofiles') && e.startTime >= t);
      const last = lists[lists.length - 1];
      if (!last) return null;
      const u = new URL(last.name.slice(last.name.indexOf('/api/list')), location.origin);
      const exts = u.searchParams.get('exts') || '';
      const rows = [...document.querySelectorAll('.trow')]
        .filter(r => r.offsetParent && r.dataset.path && r.querySelector('.cnt').textContent !== '');
      const wrong = [];
      let pending = false;
      for (const r of rows) {
        const shown = r.querySelector('.cnt').textContent;
        if (shown === '…') { pending = true; continue; }
        if (shown.startsWith('↳')) continue;
        const d = await fetch('/api/list?path=' + encodeURIComponent(r.dataset.path) +
          '&exts=' + encodeURIComponent(exts)).then(x => x.json()).catch(() => null);
        if (!d || !d.files) continue;
        const real = d.total != null ? d.total : d.files.length; // 分頁後 files 只有首頁；比總數
        if (String(real) !== shown)
          wrong.push(r.dataset.path + ' shown=' + shown + ' real=' + real);
      }
      const locked = __dbg.lockedFolder();
      let stackOk = false, stackFiles = __dbg.stack().total != null ? __dbg.stack().total : __dbg.stack().files, apiN = null;
      if (locked) {
        const d = await fetch('/api/list?path=' + encodeURIComponent(locked) +
          '&exts=' + encodeURIComponent(exts)).then(x => x.json()).catch(() => null);
        if (d && d.files) { apiN = d.total != null ? d.total : d.files.length; stackOk = apiN === stackFiles; }
      }
      return { exts, checked: rows.length, wrong, pending, locked, stackFiles, apiN, stackOk,
               idle: __dbg.stack().phase === 'idle' };
    }, t0);
    for (const chip of ['md', 'txt', 'json', 'html', 'table', 'code', 'image', 'readable', 'all']) {
      // clicking the already-selected chip is a no-op (no fetch) — any past entry is current then
      const already = await page.evaluate(id =>
        __dbg.chipsOn().length === 1 && __dbg.chipsOn()[0] === id, chip);
      const t0 = await page.evaluate(id => {
        const t = performance.now(); __dbg.selectChip(id); return t;
      }, chip);
      let res = null, settled = false;
      for (let i = 0; i < 60 && !settled; i++) {
        await sleep(300);
        const m = await measure(already ? 0 : t0 - 2);
        if (m) res = m;
        settled = !!m && m.idle && !m.pending && m.wrong.length === 0 && m.stackOk && m.checked >= 5;
      }
      ok(settled && res, `chips-${chip}-counts-match-api`,
        res && { checked: res.checked, exts: res.exts, wrong: res.wrong.slice(0, 4),
                 stack: res.stackFiles, api: res.apiN });
    }
    await page.evaluate(id => __dbg.selectChip(id), 'md');   // restore for later checks
    await waitIdle(page, 400);
    await shot(page, 'chips');

    // ------------------------------------------------ check 2: images
    {
      await page.evaluate(([f, id]) => { __dbg.selectChip(id); __dbg.lockFolder(f); },
        [RD('root/images'), 'image']);
      // thumbs draw on a frame budget; wait until every visible slot's texture
      // source name matches its file name
      const texOK = await page.waitForFunction(() => {
        const st = __dbg.slotTex();
        return st.length > 0 && st.every(s => s.texName === s.name);
      }, null, { timeout: 15000 }).then(() => true).catch(() => false);
      ok(texOK, 'images-texture-names-match-files');
      ok((await page.evaluate(() => __dbg.stack().files)) === 5, 'images-stack-5');
      await shot(page, 'images');
      const res = await realOpenCard(page, 0);
      ok(res.ok, 'images-open-card', res.ok ? undefined : res);
      const imgOK = await page.waitForFunction(() => {
        const img = document.querySelector('#readerBody img.reader-img');
        return img && img.complete && img.naturalWidth > 0;
      }, null, { timeout: 8000 }).then(() => true).catch(() => false);
      ok(imgOK, 'images-reader-img-loaded');
      const errsNow = consoleErrors.length;
      ok(errsNow === 0, 'images-no-console-errors', consoleErrors.slice(0, 3));
      await sleep(1000);                    // let the layout/carded flight settle before the shot
      await shot(page, 'images-reader');
      await escPutBack(page);
    }

    // ------------------------------------------------ check 3: hide-empty
    {
      await page.evaluate(([f, id]) => { __dbg.selectChip(id); __dbg.lockFolder(f); },
        [RD('root'), 'image']);
      await waitIdle(page, 600);
      const rowsOf = async () => page.evaluate(root => {
        const out = [];
        for (const r of document.querySelectorAll('.trow')) {
          const p = r.dataset.path || '';
          if (p === root || !p.toLowerCase().startsWith(root.toLowerCase())) continue;
          out.push({ p, hidden: r.offsetParent === null, cnt: r.querySelector('.cnt').textContent });
        }
        return out;
      }, RD('root'));
      // API truth: deepCount per subdir for the image exts (index crawled by now)
      const deepOf = async dir => page.evaluate(async ([d, e]) => {
        const r = await fetch('/api/list?path=' + encodeURIComponent(d) + '&exts=' + encodeURIComponent(e));
        const j = await r.json();
        return Object.fromEntries((j.dirs || []).map(x => [x.path, x.deepCount]));
      }, [dir, IMAGE_EXTS]);

      const deepRoot = await deepOf(RD('root'));
      const deepPlain = await deepOf(RD('root/plain'));
      const deepNested = await deepOf(RD('root/plain/nested'));
      const deepMap = { ...deepRoot, ...deepPlain, ...deepNested };
      ok(Object.values(deepMap).every(v => v != null), 'hide-deepcounts-known', deepMap);

      const off = await rowsOf();
      ok(off.every(r => !r.hidden), 'hide-off-all-visible', { rows: off.length });

      await page.click('#treeBar input');      // tick hide-empty ON
      await sleep(700);
      const on = await rowsOf();
      const wrongHidden = on.filter(r => r.hidden && (deepMap[r.p] ?? 0) !== 0)
        .map(r => r.p + ' deep=' + deepMap[r.p]);
      const missedHide = on.filter(r => !r.hidden && (deepMap[r.p] ?? null) === 0)
        .map(r => r.p);
      ok(wrongHidden.length === 0 && missedHide.length === 0, 'hide-on-exactly-deep0-hidden',
        { wrongHidden, missedHide });
      const parent = on.find(r => r.p === RD('root/noimg'));
      ok(parent && !parent.hidden && parent.cnt === '↳2', 'hide-parent-zero-direct-kept',
        parent && { cnt: parent.cnt });
      await shot(page, 'hide-on');

      await page.click('#treeBar input');      // untick → everything back
      await sleep(700);
      const off2 = await rowsOf();
      ok(off2.length === off.length && off2.every(r => !r.hidden), 'hide-off-again-all-visible');

      // pinned row (quick access) shows the subtree total and is never hidden
      const pinned = await page.evaluate(p => {
        const r = [...document.querySelectorAll('.trow')].find(x => x.dataset.path === p);
        return r ? { cnt: r.querySelector('.cnt').textContent, hidden: r.offsetParent === null } : null;
      }, RD('root/noimg'));
      ok(pinned && pinned.cnt === '↳2', 'hide-pinned-subtree-total', pinned);
      await shot(page, 'hide-pinned');
    }

    // ------------------------------------------------ check 4: conversations
    {
      // conversation counts follow the chips filter — use md so the .md writes count
      await page.evaluate(id => __dbg.selectChip(id), 'md');
      // titles under the 對話 section; the auto session folded behind the toggle row
      await page.waitForFunction(() =>
        [...document.querySelectorAll('#convos .crow')].some(r => r.textContent.includes('迴歸測試假對話')),
        null, { timeout: 10000 });
      const list = await page.evaluate(() =>
        [...document.querySelectorAll('#convos .crow')].map(r => ({
          text: r.textContent.trim().slice(0, 60)
        })));
      const titled = list.some(r => r.text.includes('迴歸測試假對話：寫兩個檔'));
      ok(titled, 'convos-title-listed', list.map(r => r.text).slice(0, 8));
      const autoVisible = await page.evaluate(() =>
        [...document.querySelectorAll('#convos .crow')].some(r => r.textContent.includes('auto batch ticket')));
      ok(!autoVisible, 'convos-auto-folded-by-default');
      await shot(page, 'convos-list');

      // click the cli conversation → stack shows exactly its two files
      await page.waitForFunction(() => {
        const r = [...document.querySelectorAll('#convos .crow')]
          .find(x => x.textContent.includes('迴歸測試假對話：寫兩個檔'));
        return r && r.querySelector('.cnt').textContent === '2';
      }, null, { timeout: 10000 });
      await page.evaluate(() => {
        const r = [...document.querySelectorAll('#convos .crow')]
          .find(x => x.textContent.includes('迴歸測試假對話：寫兩個檔'));
        r.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await waitIdle(page, 600);
      const convo = await page.evaluate(() => ({
        files: __dbg.stack().files, names: __dbg.fileNames(),
        path: document.getElementById('pathBar').innerText
      }));
      const wantNames = ['ai-note-1.md', 'ai-note-2.md'];
      ok(convo.files === 2 && wantNames.every(n => convo.names.includes(n)),
        'convos-click-loads-exact-files', { names: convo.names, path: convo.path.trim() });
      await shot(page, 'convos-open');

      // card context menu carries the "which conversation" item
      const c = await page.evaluate(() => __dbg.cardScreen(Math.round(__dbg.stack().scroll)));
      if (!c) ok(false, 'convos-menu-whichconvo', 'cardScreen null (stack empty)');
      else {
        await page.mouse.click(c.x, c.y, { button: 'right' });
        await sleep(400);
        const menu = await page.evaluate(() =>
          [...document.querySelectorAll('#ctxMenu .it')].map(e => e.textContent));
        ok(menu.some(m => m.includes('是哪則對話做的') || m.includes('Which conversation')),
          'convos-menu-whichconvo', menu.slice(0, 8));
      }
      await shot(page, 'convos-menu');
      await page.keyboard.press('Escape');
      await sleep(300);

      // fold-out: toggle row reveals the automated session
      const autoN = await page.evaluate(() => {
        const tog = [...document.querySelectorAll('#convos .crow')]
          .find(x => x.textContent.includes('自動跑的工作') || /Automated runs/.test(x.textContent));
        if (tog) tog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return !!tog;
      });
      ok(autoN, 'convos-auto-toggle-present');
      await page.waitForFunction(() =>
        [...document.querySelectorAll('#convos .crow')].some(r => r.textContent.includes('auto batch ticket')),
        null, { timeout: 8000 }).catch(() => {});
      const autoVisible2 = await page.evaluate(() =>
        [...document.querySelectorAll('#convos .crow')].some(r => r.textContent.includes('auto batch ticket')));
      ok(autoVisible2, 'convos-auto-revealed-after-toggle');
      await shot(page, 'convos-auto');
    }

    // ------------------------------------------------ check 4b: crow hover 預覽＋統一「目前選取」還原
    // 對話／今天列跟資料夾同一套 hover（HOVER_MS 後預覽，點擊鎖定）；離開左欄還原到
    // 「鎖定的那個」——鎖資料夾回資料夾、鎖對話回對話。快速掃過不發請求。
    {
      const low2 = p => String(p == null ? '' : p).replace(/\\/g, '/').toLowerCase();
      // 先鎖一個看得見的真資料夾。用 root/plain（不是 noimg）：後面 treenav 的
      // 「按住 ↓ 只載一次」檢查靠 noimg 不在 dirCache 才算得出網路請求
      const folderP = RD('root/plain');
      await page.evaluate(p => window.__dbg.lockFolder(p), folderP);
      await waitIdle(page, 700);
      const folderFiles = await page.evaluate(() => window.__dbg.stack().files);
      ok(folderFiles > 0, 'crowhover-folder-baseline', { folderFiles });

      const rect = await page.evaluate(() => window.__dbg.crowRect('迴歸測試假對話'));
      ok(!!rect, 'crowhover-row-visible');
      if (rect && folderFiles > 0) {
        // hover 對話列：計時器到點後卡堆預覽它的檔；鎖定（.sel）仍是資料夾
        await page.mouse.move(Math.max(6, rect.x - 240), rect.y, { steps: 4 });
        await page.mouse.move(rect.x, rect.y, { steps: 4 });
        await sleep(750);
        const h = await page.evaluate(() => ({
          files: window.__dbg.stack().files, names: window.__dbg.fileNames(),
          locked: window.__dbg.lockedSel(),
          selPath: (() => { const r = document.querySelector('.trow.sel'); return r ? (r.dataset.path || 'crow') : null; })(),
          crowPreview: document.querySelectorAll('#convos .crow.preview').length
        }));
        ok(h.files === 2 && h.names.includes('ai-note-1.md') && h.names.includes('ai-note-2.md'),
          'crowhover-previews-files', { files: h.files, names: h.names });
        ok(low2(h.selPath) === low2(folderP) && low2(h.locked) === low2(folderP) && h.crowPreview === 1,
          'crowhover-lock-untouched', { sel: h.selPath, locked: h.locked, crowPreview: h.crowPreview });
        await shot(page, 'crowhover-preview');

        // 滑出左欄 → 還原到鎖定的資料夾（預覽框消失）
        await page.mouse.move(1200, 450, { steps: 6 });
        await sleep(900);
        const back = await page.evaluate(() => ({
          files: window.__dbg.stack().files, locked: window.__dbg.lockedSel(),
          crowPreview: document.querySelectorAll('#convos .crow.preview').length
        }));
        ok(back.files === folderFiles && low2(back.locked) === low2(folderP) && back.crowPreview === 0,
          'crowhover-leave-reverts-to-folder', back);

        // 點對話列＝鎖定它；hover 資料夾預覽資料夾，.sel 留在對話列；滑出 → 回對話
        await page.mouse.move(rect.x, rect.y, { steps: 4 });
        await page.mouse.click(rect.x, rect.y);
        await waitIdle(page, 800);
        const lc = await page.evaluate(() => ({
          files: window.__dbg.stack().files, locked: window.__dbg.lockedSel(),
          crowSel: !!document.querySelector('#convos .crow.sel')
        }));
        ok(lc.files === 2 && String(lc.locked).startsWith('crow:convo:') && lc.crowSel,
          'crowlock-click-locks-convo', lc);
        const fr = await page.evaluate(p => {
          const r = [...document.querySelectorAll('.trow')].find(x => x.dataset.path === p);
          if (!r || r.offsetParent === null) return null;
          r.scrollIntoView({ block: 'nearest' });   // 樹可能被之前的檢查捲走
          const b = r.getBoundingClientRect();
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        }, folderP);
        ok(!!fr, 'crowlock-folder-row-visible');
        if (fr) {
          await page.mouse.move(fr.x, fr.y, { steps: 4 });
          await sleep(750);
          const mid = await page.evaluate(() => ({
            files: window.__dbg.stack().files,
            crowSel: !!document.querySelector('#convos .crow.sel'),
            prevN: document.querySelectorAll('.trow.preview').length
          }));
          ok(mid.files === folderFiles && mid.crowSel && mid.prevN === 1,
            'crowlock-folderhover-previews-folder', mid);
          await page.mouse.move(1200, 450, { steps: 6 });
          await sleep(900);
          const back2 = await page.evaluate(() => ({
            files: window.__dbg.stack().files, locked: window.__dbg.lockedSel(),
            prevN: document.querySelectorAll('.trow.preview').length
          }));
          ok(back2.files === 2 && String(back2.locked).startsWith('crow:convo:') && back2.prevN === 0,
            'crowlock-leave-reverts-to-convo', back2);
        }

        // 快速掃過 14 列（每列 < HOVER_MS）：一個 list/convo/recent 請求都不該發
        await page.evaluate(() => performance.clearResourceTimings());
        const pts = await page.evaluate(() =>
          [...document.querySelectorAll('#tree .trow')]
            .filter(r => r.offsetParent)
            .slice(0, 14)
            .map(r => { const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }));
        for (const p of pts) { await page.mouse.move(p.x, p.y); await sleep(35); }
        const reqs = await page.evaluate(() => performance.getEntriesByType('resource')
          .filter(e => /\/api\/(list|convo|recent)/.test(e.name)).length);
        ok(reqs === 0, 'crowhover-rapid-no-requests', { reqs, rows: pts.length });
        await page.mouse.move(1200, 450);   // 收尾：滑出左欄
        await sleep(500);
      }
    }


    // ------------------------------------------------ check 5: scrubber
    {
      await page.evaluate(([f, id]) => { __dbg.selectChip(id); __dbg.lockFolder(f); },
        [RD('root/big'), 'md']);
      await waitIdle(page, 900);
      const shown = await page.waitForFunction(() => {
        const el = document.getElementById('scrub');
        return el && getComputedStyle(el).display !== 'none';
      }, null, { timeout: 8000 }).then(() => true).catch(() => false);
      ok(shown, 'scrub-track-appears');
      const box = await page.locator('#scrub .track').boundingBox();
      ok(!!box, 'scrub-track-box');
      if (box) {
        const files = await page.evaluate(() => __dbg.stack().files);
        const want = Math.round(0.6 * (files - 1));   // scrubber jumps to scrollMax fraction
        await page.mouse.move(box.x + 7, box.y + 5);
        await page.mouse.down();
        await page.mouse.move(box.x + 7, box.y + box.height * 0.6, { steps: 8 });
        const tip = await page.textContent('#scrub .tip');
        await page.mouse.up();
        await page.waitForFunction(w =>
          Math.abs(__dbg.stack().scroll - w) <= 1 && Math.abs(__dbg.stack().scrollVel) < 0.05,
          want, { timeout: 8000 }).catch(() => {});
        const scroll = await page.evaluate(() => __dbg.stack().scroll);
        ok(Math.abs(scroll - want) <= 1, 'scrub-drag-60pct-index', { want, got: scroll, tip });
        await shot(page, 'scrub');
      }
    }

    // ------------------------------------------------ check 6: live update
    {
      await page.evaluate(f => __dbg.lockFolder(f), RD('root/live'));
      // live.js polls the target every 800 ms, then resetPill() ignores dir events for
      // another 1.5 s grace window — writes must land after ~2.3 s or they are ignored.
      await waitIdle(page, 3000);
      const before = await page.evaluate(() => __dbg.stack().files);
      fs.writeFileSync(RD('root/live/live-c.md'), '# live c\n');
      fs.writeFileSync(RD('root/live/live-d.md'), '# live d\n');
      const pillShown = await page.waitForFunction(() => {
        const el = document.getElementById('livePill');
        return el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 50;
      }, null, { timeout: 8000 }).then(() => true).catch(() => false);
      ok(pillShown, 'live-pill-shows-on-new-files');
      await shot(page, 'live-pill');
      if (pillShown) {
        await page.click('#livePill');
        await page.waitForFunction(b => __dbg.stack().files === b + 2, before, { timeout: 8000 })
          .catch(() => {});
        const after = await page.evaluate(() => __dbg.stack().files);
        ok(after === before + 2, 'live-pill-click-loads-files', { before, after });
      } else {
        ok(false, 'live-pill-click-loads-files', 'pill never appeared');
      }
    }

    // ------------------------------------------------ check 7: secret warning
    {
      await page.evaluate(f => __dbg.lockFolder(f), RD('root/secret'));
      await waitIdle(page, 900);
      ok((await page.evaluate(() => __dbg.stack().files)) === 3, 'secret-folder-3-files');
      const flagged = await page.evaluate(() =>
        Object.fromEntries(__dbg.fileNames().map((n, i) => [n, __dbg.fileSecret(i)])));
      ok(flagged['keys-note.md'] === true && flagged['prose-note.md'] === false,
        'secret-flag-on-keys-not-prose', flagged);
      await sleep(1200);   // thumbnails (badge is drawn into them)
      await shot(page, 'secret-card');
      const keyIdx = await page.evaluate(() => __dbg.fileNames().indexOf('keys-note.md'));
      const res = await realOpenCard(page, keyIdx);
      ok(res.ok, 'secret-open-flagged-card', res.ok ? undefined : res);
      await page.waitForFunction(() => {
        const el = document.getElementById('readerSecret');
        return el && el.classList.contains('on') &&
          el.querySelector('.hits') && el.querySelector('.hits').textContent.length > 4;
      }, null, { timeout: 6000 });
      const txt = await page.evaluate(() => document.getElementById('readerSecret').textContent);
      ok(/可能含有密碼或金鑰|password or API key/.test(txt), 'secret-reader-warn-strip');
      ok(/第\s*\d+\s*行|line \d+/.test(txt), 'secret-reader-line-numbers');
      ok(txt.includes('sk-F'), 'secret-reader-masked-prefix');
      ok(!txt.includes('Sup3rS3cret') && !txt.includes('FAKE0000000000'),
        'secret-reader-no-leak');
      await sleep(1000);                    // settle the flight animation before the shot
      await shot(page, 'secret-reader');
      await escPutBack(page);
    }

    // ------------------------------------------------ check 8: rename + Ctrl+Z
    {
      const oldP = RD('root/secret/rename-me.md');
      const newP = RD('root/secret/rename-me-2.md');
      const renIdx = await page.evaluate(() => __dbg.fileNames().indexOf('rename-me.md'));
      ok(renIdx >= 0, 'undo-rename-target-present');
      const res = await realOpenCard(page, renIdx);
      ok(res.ok, 'undo-open-rename-target', res.ok ? undefined : res);
      await sleep(800);
      await page.click('#btnMore');
      await sleep(300);
      const menuOk = await page.evaluate(() => {
        const it = [...document.querySelectorAll('#ctxMenu .it')]
          .find(d => d.textContent.includes('重新命名') || d.textContent.includes('Rename'));
        if (it) { it.click(); return true; }
        return false;
      });
      ok(menuOk, 'undo-rename-menu-click');
      await sleep(300);
      await page.fill('#dlg .inp', 'rename-me-2.md');
      await page.click('#dlg .yes');
      await sleep(900);
      ok(fs.existsSync(newP) && !fs.existsSync(oldP), 'undo-rename-landed');
      await shot(page, 'undo-renamed');
      await escPutBack(page);
      await page.keyboard.press('Control+z');
      await page.waitForFunction(() =>
        document.getElementById('toast').textContent.includes('已復原') ||
        /restored|undone/i.test(document.getElementById('toast').textContent),
        null, { timeout: 6000 }).catch(() => {});
      await sleep(800);
      ok(fs.existsSync(oldP) && !fs.existsSync(newP), 'undo-ctrlz-restored');
      await shot(page, 'undo-restored');
      try { if (fs.existsSync(newP)) fs.renameSync(newP, oldP); } catch (_) {}
    }

    // ------------------------------------------------ check 9: reader open/close must not slide the stack
    // The column change applies instantly; sample across frames and require the
    // viewport rect + camera fit to be at their final values from the start.
    {
      await page.evaluate(f => __dbg.lockFolder(f), RD('root/big'));
      await waitIdle(page, 900);
      const openSamples = await page.evaluate(() => new Promise(resolve => {
        const out = [];
        __dbg.openReader(0);
        const t0 = performance.now();
        const loop = () => {
          const d = __dbg.stack(), v = __dbg.viewRect();
          out.push({ x: v.x, w: v.w, d: d.fitDist, dt: d.fitDistT, t: performance.now() - t0 });
          if (performance.now() - t0 < 450) requestAnimationFrame(loop); else resolve(out);
        };
        requestAnimationFrame(loop);
      }));
      const finO = openSamples[openSamples.length - 1];
      const viewOff = openSamples.slice(1).filter(s => Math.abs(s.w - finO.w) > 2 || Math.abs(s.x - finO.x) > 2);
      const fitOff = openSamples.slice(1).filter(s => Math.abs(s.d - s.dt) > 0.02);
      ok(openSamples.length >= 8 && viewOff.length <= 1, 'noslide-open-view-in-one-frame',
        { n: openSamples.length, off: viewOff.length });
      ok(fitOff.length === 0, 'noslide-open-fit-in-one-frame', { off: fitOff.length });
      ok((await page.evaluate(() => __dbg.mode())) === 'threecol'
        && (await page.evaluate(() => __dbg.panel().shown)) === true, 'noslide-reader-opened');
      const nearFit = await page.evaluate(() => __dbg.fitGap());
      ok(nearFit < 0.02, 'noslide-open-fitgap', { fitGap: nearFit });

      const closeSamples = await page.evaluate(() => new Promise(resolve => {
        const out = [];
        __dbg.closeReader();
        const t0 = performance.now();
        const loop = () => {
          const v = __dbg.viewRect();
          out.push({ x: v.x, w: v.w, t: performance.now() - t0 });
          if (performance.now() - t0 < 450) requestAnimationFrame(loop); else resolve(out);
        };
        requestAnimationFrame(loop);
      }));
      const finC = closeSamples[closeSamples.length - 1];
      const closeOff = closeSamples.slice(1).filter(s => Math.abs(s.w - finC.w) > 2 || Math.abs(s.x - finC.x) > 2);
      ok(closeSamples.length >= 8 && closeOff.length <= 1, 'noslide-close-view-in-one-frame',
        { n: closeSamples.length, off: closeOff.length });
      ok((await page.evaluate(() => __dbg.mode())) === 'twocol'
        && (await page.evaluate(() => !__dbg.stack().extracted)), 'noslide-close-twocol');
      await shot(page, 'noslide');
      await waitIdle(page, 400);
    }

    // ------------------------------------------------ check 10: arrow keys walk the LEFT TREE
    // ↑↓ = move the tree highlight one VISIBLE row at a time (rows hidden by the
    // "only folders with these files" filter are skipped); the folder loads ~120ms
    // after you stop; → expands (or descends to the first child), ← collapses (or
    // goes to the parent), Home/End jump to the ends, Enter/Space open the front
    // card in the reader. The card stack itself stays wheel-only.
    {
      const same = (a, b) => String(a).replace(/[/\\]+$/, '').replace(/\\/g, '/').toLowerCase()
        === String(b).replace(/[/\\]+$/, '').replace(/\\/g, '/').toLowerCase();
      const low = p => String(p).replace(/\\/g, '/').toLowerCase();
      const nav = () => page.evaluate(() => ({
        files: __dbg.stack().files, locked: __dbg.lockedFolder(),
        sel: __dbg.selRows(), rows: __dbg.navRows(),
        mode: __dbg.mode(), readerFile: __dbg.panel().file
      }));
      const navShot = async name => {
        const p = path.join(SHOTS, name + '.png');
        await page.screenshot({ path: p });
        console.log('shot ' + p);
      };
      const waitLock = async p => {
        await page.waitForFunction(
          ph => __dbg.lockedFolder() &&
            __dbg.lockedFolder().replace(/\\/g, '/').toLowerCase() === ph.replace(/\\/g, '/').toLowerCase(),
          p, { timeout: 9000 });
        await waitIdle(page, 350);
      };
      const selIs = async p => (await nav()).sel.some(x => same(x, p));
      const setHide = on => page.evaluate(v => {   // 不用 page.click：會把焦點留在 checkbox 上，方向鍵就不通了
        const cb = document.querySelector('#treeBar input');
        if (!!cb.checked !== v) { cb.checked = v; cb.dispatchEvent(new Event('change', { bubbles: true })); }
      }, on);
      const ensureMdChip = () => page.evaluate(() => {
        if (!__dbg.chipsOn().includes('md')) __dbg.selectChip('md');
      });

      await ensureMdChip();
      await page.evaluate(f => __dbg.lockFolder(f), RD('root/nv'));
      await waitIdle(page, 700);
      await page.evaluate(x => __dbg.expandTreeNode(x), RD('root/nv'));   // children rows must exist to walk onto
      await waitIdle(page, 500);
      let s = await nav();
      ok(s.files === 1 && same(s.locked, RD('root/nv')), 'treenav-start-at-parent', s);

      await page.keyboard.press('ArrowDown');        // highlight moves instantly, load follows ~120ms later
      await sleep(60);
      ok(await selIs(RD('root/nv/a-first')), 'treenav-down-highlights-next-row');
      await waitLock(RD('root/nv/a-first'));
      s = await nav();
      ok(s.files === 2 && same(s.locked, RD('root/nv/a-first')), 'treenav-down-loads-highlighted-row', s);
      await navShot('treenav-1-down-loads');

      await page.keyboard.press('ArrowDown');        // b-empty is a stop while the filter is OFF
      await sleep(60);
      ok(await selIs(RD('root/nv/b-empty')), 'treenav-empty-row-is-stop-when-filter-off');
      await waitLock(RD('root/nv/b-empty'));
      s = await nav();
      ok(s.files === 0 && same(s.locked, RD('root/nv/b-empty')), 'treenav-empty-row-loads', s);

      await page.keyboard.press('ArrowUp');          // back onto a-first, then turn the filter ON
      await waitLock(RD('root/nv/a-first'));
      await setHide(true);
      await sleep(500);
      const bHidden = await page.evaluate(p => {
        const r = [...document.querySelectorAll('.trow')].find(x => x.dataset.path === p);
        return r ? (r.offsetParent === null || r.style.display === 'none') : null;
      }, RD('root/nv/b-empty'));
      ok(bHidden === true, 'treenav-empty-row-hidden-when-filter-on');

      await page.keyboard.press('ArrowDown');        // must skip the hidden b-empty → land c-wrap
      await sleep(60);
      ok(await selIs(RD('root/nv/c-wrap')), 'treenav-down-skips-hidden-row');
      await waitLock(RD('root/nv/c-wrap'));
      s = await nav();
      ok(same(s.locked, RD('root/nv/c-wrap')) && s.files === 0, 'treenav-skip-lands-on-wrapper', s);
      await navShot('treenav-2-skip-hidden');

      await page.keyboard.press('ArrowRight');       // expand c-wrap → c1-deep row appears
      await page.waitForFunction(ph => __dbg.navRows().some(x =>
        String(x).replace(/\\/g, '/').toLowerCase() === ph),
        low(RD('root/nv/c-wrap/c1-deep')), { timeout: 6000 });
      await page.keyboard.press('ArrowRight');       // already expanded → descend to first child
      await sleep(60);
      ok(await selIs(RD('root/nv/c-wrap/c1-deep')), 'treenav-right-descends-to-child');
      await waitLock(RD('root/nv/c-wrap/c1-deep'));
      s = await nav();
      ok(s.files === 1 && same(s.locked, RD('root/nv/c-wrap/c1-deep')), 'treenav-child-loads', s);
      await navShot('treenav-3-expand-descend');

      await page.keyboard.press('ArrowLeft');        // leaf child → highlight the parent
      await sleep(60);
      ok(await selIs(RD('root/nv/c-wrap')), 'treenav-left-to-parent');
      await page.keyboard.press('ArrowLeft');        // expanded parent → collapse it
      await sleep(300);
      const kidGone = await page.evaluate(ph => !__dbg.navRows().some(x =>
        String(x).replace(/\\/g, '/').toLowerCase() === ph),
        low(RD('root/nv/c-wrap/c1-deep')));
      ok(kidGone, 'treenav-left-collapses-parent');

      // holding ↓ glides: 7 rapid presses = exactly ONE real folder load (the final row)
      await page.evaluate(x => __dbg.lockFolder(x), RD('root/nv'));
      await waitIdle(page, 600);
      await page.evaluate(() => performance.clearResourceTimings());
      const rowsPre = await page.evaluate(() => __dbg.navRows());
      const startIdx = rowsPre.findIndex(x => same(x, RD('root/nv')));
      // fewer than 7 rows below → the glide clamps at the last row (that IS the target)
      const target = rowsPre[Math.min(startIdx + 7, rowsPre.length - 1)];
      ok(startIdx >= 0 && !!target && !String(target).startsWith('crow:'),
        'treenav-hold-target-exists', { startIdx, target });
      for (let i = 0; i < 7; i++) { await page.keyboard.press('ArrowDown'); await sleep(30); }
      await sleep(600);                              // debounce (120ms) + load
      const loads = await page.evaluate(() => performance.getEntriesByType('resource')
        .filter(e => e.name.includes('/api/list') && !e.name.includes('nofiles')).length);
      s = await nav();
      ok(loads === 1, 'treenav-hold-one-load', { loads, target });
      ok(s.sel.length === 1 && same(s.sel[0], target) && same(s.locked, target),
        'treenav-hold-lands-on-final-row', { target, sel: s.sel, locked: s.locked });

      // Home/End: instant highlight at the ends (inside the debounce window — nothing loads)
      const rowsNow = await page.evaluate(() => __dbg.navRows());
      await page.keyboard.press('End');
      const endSel = await page.evaluate(() => __dbg.selRows());
      ok(endSel.length === 1 && same(endSel[0], rowsNow[rowsNow.length - 1]),
        'treenav-end-last-row', { endSel, last: rowsNow[rowsNow.length - 1] });
      await page.keyboard.press('Home');             // first row = AI 對話區「今天」列
      const home = await page.evaluate(() => {
        const r = document.querySelector('.trow.sel');
        return r ? { crow: r.classList.contains('crow'), text: r.innerText } : null;
      });
      ok(home && home.crow && /今天|Today/.test(home.text), 'treenav-home-first-row',
        home && { text: home.text.slice(0, 40) });

      // Enter opens the front card in the reader (Space does the same when not reading)
      await page.evaluate(x => __dbg.lockFolder(x), RD('root/big'));
      await waitIdle(page, 800);
      const front = await page.evaluate(() => __dbg.fileNames()[0]);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => __dbg.panel().shown === true, null, { timeout: 8000 });
      s = await nav();
      ok(s.mode !== 'twocol' && s.readerFile === front, 'treenav-enter-opens-front-card',
        { front, readerFile: s.readerFile, mode: s.mode });
      await navShot('treenav-4-enter-reader');
      await escPutBack(page);

      // 在搜尋框打字時方向鍵一律不吃（高亮、鎖定都不動）
      const beforeType = await nav();
      await page.click('#searchBox');
      await page.keyboard.type('zz');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowUp');
      await sleep(300);
      s = await nav();
      ok(same(s.locked, beforeType.locked) && JSON.stringify(s.sel) === JSON.stringify(beforeType.sel),
        'treenav-arrows-ignored-while-typing', { sel: s.sel, locked: s.locked });
      await page.evaluate(() => {
        const b = document.getElementById('searchBox');
        b.value = ''; b.dispatchEvent(new Event('input', { bubbles: true })); b.blur();
      });
      await waitIdle(page, 500);

      // help list (settings panel + first-run tip share ul.help) documents the new keys
      const help = await page.evaluate(() =>
        [...document.querySelectorAll('#settings ul.help li')].map(li => li.textContent));
      ok(help.length >= 10 && help.some(x => x.includes('↑')) && help.some(x => /Home/.test(x))
        && help.some(x => /空白|Space/.test(x)), 'treenav-help-items-listed', { n: help.length });

      // ---------------- 分頁：360 檔資料夾首頁 300＋總數，捲近尾端自動續頁
      await page.evaluate(([f, id]) => { __dbg.selectChip(id); __dbg.lockFolder(f); },
        [RD('root/pg'), 'md']);
      await waitIdle(page, 900);
      let pg = await page.evaluate(() => ({
        loaded: window.__dbg.stack().files, total: window.__dbg.stack().total, hasMore: window.__dbg.stack().hasMore }));
      ok(pg.total === 360 && pg.loaded === 300 && pg.hasMore === true, 'pg-first-page-300-of-360', pg);
      if (pg.loaded === 300) {
        // 拖捲軸到 ~95% → 夾在已載入尾端 → 觸發續頁（不用一格一格滾 60 張）
        const me = await page.evaluate(() => {
          const tr = document.querySelector('#scrub .track');
          const r = tr.getBoundingClientRect();
          return { x: r.left + r.width / 2, yTop: r.top, h: r.height };
        });
        await page.mouse.move(me.x, me.yTop + me.h * 0.95);
        await page.mouse.down();
        await page.mouse.move(me.x, me.yTop + me.h * 0.98, { steps: 5 });
        await page.mouse.up();
        await page.waitForFunction(() => window.__dbg.stack().files > 300, null, { timeout: 8000 });
        pg = await page.evaluate(() => ({
          loaded: window.__dbg.stack().files, total: window.__dbg.stack().total, hasMore: window.__dbg.stack().hasMore }));
        ok(pg.loaded === 360 && pg.total === 360 && pg.hasMore === false, 'pg-lazy-append-to-total', pg);
        // 伺服器切頁順序 = mtime 新→舊：第一張是 p360，page 2 開頭 p060，最後 p001
        const ends = await page.evaluate(() => { const n = window.__dbg.fileNames(360); return [n[0], n[299] || null, n[300] || null, n[n.length - 1]]; });
        ok(ends[0] === 'p360.md' && ends[2] === 'p060.md' && ends[3] === 'p001.md', 'pg-page-order-newest-first', { ends });
      } else {
        ok(false, 'pg-lazy-append-to-total', pg);
        ok(false, 'pg-page-order-newest-first', pg);
      }
    }

    // ------------------------------------------------ check 11: run page scripts
    // paint.html's canvas is painted by a module script that imports a sibling
    // lib through an absolute file:/// URL. Scripts OFF → blank canvas + hint
    // strip; click ▶ → iframe reloads from /raw/ in an opaque sandbox, the
    // rewrite makes the import resolve, canvas turns orange. The page also
    // tries POST /api/rename from that opaque origin: it must be rejected
    // (green corner; red would mean the write went through).
    {
      await page.evaluate(([f, id]) => { __dbg.selectChip(id); __dbg.lockFolder(f); },
        [RD('root/htmlrun'), 'html']);
      await waitIdle(page, 900);
      const paintIdx = await page.evaluate(() => __dbg.fileNames().indexOf('paint.html'));
      ok(paintIdx >= 0, 'htmlrun-card-present');
      const res = paintIdx >= 0 ? await realOpenCard(page, paintIdx) : { ok: false, reason: 'no-card' };
      ok(res.ok, 'htmlrun-open-card', res.ok ? undefined : res);

      // scripts OFF: hint strip on, iframe is a sandboxed srcdoc (no /raw/ src),
      // canvas unpainted (parent can read it — safe mode keeps allow-same-origin)
      const off = await page.waitForFunction(() => {
        const ifr = document.querySelector('#readerBody iframe');
        const hint = document.getElementById('readerScriptHint');
        if (!ifr || !hint) return false;
        let black = null;
        try {
          const cv = ifr.contentDocument && ifr.contentDocument.querySelector('canvas');
          if (!cv) return false;
          const d = cv.getContext('2d').getImageData(120, 120, 1, 1).data;
          black = d[0] === 0 && d[1] === 0 && d[2] === 0;
        } catch (_) { return false; }
        return { hint: hint.classList.contains('on'), hintText: hint.textContent,
          srcdoc: !!ifr.getAttribute('srcdoc'), src: ifr.getAttribute('src') || '', black };
      }, null, { timeout: 8000 }).then(h => h.jsonValue()).catch(() => null);
      ok(off && off.hint === true && /按 ▶|press ▶/.test(off.hintText || ''),
        'htmlrun-hint-visible-when-off', off && { hint: off.hint, hintText: (off.hintText || '').slice(0, 40) });
      ok(off && off.srcdoc === true && off.black === true && !off.src.startsWith('/raw/'),
        'htmlrun-off-blank-canvas', off);

      // settings checkbox exists and a run button is present for this html file
      const uiBits = await page.evaluate(() => ({
        checkbox: !!document.getElementById('htmlRun'),
        btnVisible: !document.getElementById('btnRun').hidden
      }));
      ok(uiBits.checkbox && uiBits.btnVisible, 'htmlrun-ui-controls', uiBits);
      await shot(page, 'htmlrun-off');

      // click ▶ → iframe reloads from /raw/ with the script-running sandbox
      await page.click('#btnRun');
      const ran = await page.waitForFunction(() => {
        const ifr = document.querySelector('#readerBody iframe');
        return ifr && (ifr.getAttribute('src') || '').startsWith('/raw/') &&
          !ifr.getAttribute('sandbox').includes('allow-same-origin') &&
          ifr.getAttribute('sandbox').includes('allow-scripts');
      }, null, { timeout: 8000 }).then(() => true).catch(() => false);
      ok(ran, 'htmlrun-run-mode-raw-sandbox');
      await sleep(2000);   // module fetch(es) + paint + the rename attempt round-trip
      await shot(page, 'htmlrun-on');

      const box = await page.evaluate(() => {
        const ifr = document.querySelector('#readerBody iframe');
        if (!ifr) return null;
        const r = ifr.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      ok(!!box && box.w > 260 && box.h > 260, 'htmlrun-iframe-box', box);
      if (box) {
        const buf = await page.screenshot({ clip: { x: box.x + 42, y: box.y + 42, width: 170, height: 170 } });
        const img = decodePng(buf);
        let orange = 0, total = 0;
        for (let y = 0; y < img.height; y += 4) for (let x = 0; x < img.width; x += 4) {
          total++;
          const [r, g, b] = img.px(x, y);
          if (r > 200 && g > 90 && g < 190 && b < 90) orange++;
        }
        ok(total > 0 && orange / total > 0.5, 'htmlrun-canvas-painted-after-run', { orange, total });
        // corner (iframe doc coords 0..40): green = /api/rename rejected the opaque origin
        const cornerBuf = await page.screenshot({ clip: { x: box.x + 3, y: box.y + 3, width: 30, height: 30 } });
        const cimg = decodePng(cornerBuf);
        const [cr, cg, cb] = cimg.px(15, 15);
        ok(cg > 140 && cr < 100 && cb < 100, 'htmlrun-rename-rejected-green', { rgb: [cr, cg, cb] });
      }
      ok(fs.existsSync(RD('root/htmlrun/victim.md')) &&
        !fs.existsSync(RD('root/htmlrun/renamed-by-script.md')),
        'htmlrun-victim-not-renamed');
      await escPutBack(page);
    }

    // ------------------------------------------------ check 12: 程式碼配色（codetheme）
    // 小 .py/.js：同步上色＋行號槽＋換主題換底色；300KB .js：100ms 內先見純文字、上色隨後到
    {
      // chip 點擊會重載「目前鎖定的資料夾」，與 lockFolder 的載入誰後到誰贏（無世代防護）——
      // 所以順序要反過來：先 lock（舊 chip=html 之下 root/plain 只剩 d.html 可辨識），
      // 再切 chip（最後一次載入一定是它發的，不會有回應後到覆蓋）
      await page.evaluate(f => __dbg.lockFolder(f), RD('root/plain'));
      await page.waitForFunction(() => {
        const ns = __dbg.fileNames();
        return ns.includes('d.html') ? ns : false;
      }, null, { timeout: 10000 }).catch(() => null);
      await page.evaluate(id => __dbg.selectChip(id), 'code');
      let names = [];
      try {
        names = await page.waitForFunction(() => {
          const ns = __dbg.fileNames();
          return (ns.includes('main.py') && ns.includes('app.js') && ns.includes('big.js')
            && !ns.includes('d.html')) ? ns : false;
        }, null, { timeout: 10000 }).then(h => h.jsonValue());
      } catch (_) {
        names = await page.evaluate(() => __dbg.fileNames());
      }
      const pyIdx = names.indexOf('main.py'), jsIdx = names.indexOf('app.js'), bigIdx = names.indexOf('big.js');
      ok(pyIdx >= 0 && jsIdx >= 0 && bigIdx >= 0, 'ct-fixture-cards', names);
      ok(await page.evaluate(() => !!(window.hljs && window.hljs.getLanguage)),
        'ct-hljs-loaded', (await page.evaluate(() => window.hljs && window.hljs.versionString)) || false);
      await waitIdle(page, 900);

      // --- 小 .py：token span＋行號槽
      let res = await realOpenCard(page, pyIdx);
      if (!res.ok) {
        const diag = await page.evaluate(i => ({
          phase: __dbg.stack().phase, screen: __dbg.cardScreen(i),
          names: __dbg.fileNames(), n: __dbg.stack().files
        }), pyIdx);
        res = Object.assign(res, { diag });
      }
      ok(res.ok, 'ct-open-py', res.ok ? undefined : res);
      const pyOk = await page.waitForFunction(() => {
        const cv = document.querySelector('#readerBody .codeview');
        if (!cv || cv.dataset.hl !== 'done') return false;
        return true;
      }, null, { timeout: 8000 }).then(() => true).catch(() => false);
      ok(pyOk, 'ct-py-highlight-done');
      const pyBits = await page.evaluate(() => ({
        gutter: !!document.querySelector('#readerBody .cv-gutter'),
        gutterNums: (document.querySelector('#readerBody .cv-gutter') || {}).textContent || '',
        hasKeyword: !!document.querySelector('#readerBody .codeview .hljs-keyword'),
        hasString: !!document.querySelector('#readerBody .codeview .hljs-string'),
        hasComment: !!document.querySelector('#readerBody .codeview .hljs-comment'),
        miniShown: !document.getElementById('codeThemeMini').hidden,
        wrapShown: !document.getElementById('btnWrap').hidden
      }));
      ok(pyBits.gutter && /^1\n2\n/.test(pyBits.gutterNums), 'ct-py-gutter-numbers', { g0: pyBits.gutterNums.slice(0, 12) });
      ok(pyBits.hasKeyword && pyBits.hasString && pyBits.hasComment, 'ct-py-token-spans', pyBits);
      ok(pyBits.miniShown && pyBits.wrapShown, 'ct-header-controls-visible');

      // --- ⚙ 換主題 → 程式碼面板底色跟著變（不換檔、不重上色）
      const bgOf = () => page.evaluate(() =>
        getComputedStyle(document.querySelector('#readerBody .codeview')).backgroundColor);
      const bgBefore = await bgOf();
      await page.evaluate(() => {
        const s = document.getElementById('codeThemeSel');
        s.value = 'nord';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await sleep(150);
      const bgAfter = await bgOf();
      ok(bgBefore !== bgAfter && bgAfter === 'rgb(46, 52, 64)', 'ct-theme-switch-changes-bg',
        { before: bgBefore, after: bgAfter });
      const persisted = await page.evaluate(() => ({
        ls: localStorage.getItem('riffleCodeTheme'),
        mini: document.getElementById('codeThemeMini').value,
        ct: document.querySelector('#readerBody .codeview').dataset.ct
      }));
      ok(persisted.ls === 'nord' && persisted.mini === 'nord' && persisted.ct === 'nord',
        'ct-theme-persisted-and-synced', persisted);

      // --- 換行鈕＋Alt+Z：.wrap 切換、行號槽藏起來
      await page.click('#btnWrap');
      await sleep(120);
      const wrapOn = await page.evaluate(() => ({
        wrap: !!document.querySelector('#readerBody .codeview.wrap'),
        gutterGone: getComputedStyle(document.querySelector('#readerBody .cv-gutter')).display === 'none',
        btnOn: document.getElementById('btnWrap').classList.contains('on')
      }));
      ok(wrapOn.wrap && wrapOn.gutterGone && wrapOn.btnOn, 'ct-wrap-button-on', wrapOn);
      await page.keyboard.press('Alt+z');
      await sleep(120);
      const wrapOff = await page.evaluate(() => ({
        wrap: !!document.querySelector('#readerBody .codeview.wrap'),
        ls: localStorage.getItem('riffleCodeWrap')
      }));
      ok(!wrapOff.wrap && !wrapOff.ls, 'ct-altz-wrap-off', wrapOff);
      await shot(page, 'codetheme-nord');
      await escPutBack(page);

      // --- 小 .js：一樣有上色
      res = await realOpenCard(page, jsIdx);
      ok(res.ok, 'ct-open-js', res.ok ? undefined : res);
      const jsOk = await page.waitForFunction(() => {
        const cv = document.querySelector('#readerBody .codeview');
        return cv && cv.dataset.hl === 'done' &&
          document.querySelector('#readerBody .codeview .hljs-keyword') &&
          document.querySelector('#readerBody .codeview .hljs-string');
      }, null, { timeout: 8000 }).then(() => true).catch(() => false);
      ok(jsOk, 'ct-js-token-spans');
      await escPutBack(page);

      // --- 300KB .js：點開 100ms 內純文字已在，上色稍後到，全程無捲動跳動
      const bigRes = await page.evaluate(async idx => {
        const t0 = performance.now();
        __dbg.openReader(idx);
        const tText = await new Promise(res => {
          const iv = setInterval(() => {
            const el = document.querySelector('#readerBody .codeview .cv-code');
            if (el && el.textContent.length > 200000) { clearInterval(iv); res(performance.now()); }
          }, 2);
          setTimeout(() => { clearInterval(iv); res(null); }, 5000);
        });
        if (tText == null) return { fail: 'text never appeared' };
        const cv = document.querySelector('#readerBody .codeview');
        const scroll0 = cv.scrollTop;
        const textMs = Math.round(tText - t0);
        const hlAtText = cv.dataset.hl;
        await new Promise(res => {
          const iv = setInterval(() => {
            if (cv.dataset.hl === 'done' || cv.dataset.hl === 'plain') { clearInterval(iv); res(); }
          }, 10);
          setTimeout(() => { clearInterval(iv); res(); }, 20000);
        });
        return { textMs, hlAtText, hl: cv.dataset.hl, hlMs: cv.dataset.hlMs || null,
          scrollKept: cv.scrollTop === scroll0,
          spans: document.querySelectorAll('#readerBody .codeview .hljs-keyword').length };
      }, bigIdx);
      ok(!bigRes.fail && bigRes.textMs < 100, 'ct-bigtext-under-100ms', bigRes);
      ok(bigRes.hlAtText === 'pending', 'ct-bigtext-highlight-pending-at-show', { hlAtText: bigRes.hlAtText });
      ok(bigRes.hl === 'done' && bigRes.spans > 1000, 'ct-bigtext-highlight-arrived', { hl: bigRes.hl, spans: bigRes.spans, hlMs: bigRes.hlMs });
      ok(bigRes.scrollKept !== false, 'ct-bigtext-no-scroll-jump');
      await shot(page, 'codetheme-big');
      await escPutBack(page);
      await page.evaluate(() => {   // 清掉本次檢查改的設定，別影響別的檢查
        localStorage.removeItem('riffleCodeTheme');
        localStorage.removeItem('riffleCodeWrap');
      });
    }

    // ------------------------------------------------ check 13: 全選是切換鈕
    // 全選 → 卡片全選＋按鈕按下態；再按一次 → 清空；部分選取再按 → 全選；
    // Ctrl+A 同樣切換；編輯器裡的 Ctrl+A 只選文字、不動卡片選取。
    {
      await page.evaluate(f => __dbg.lockFolder(f), RD('root/plain'));
      await page.waitForFunction(() => __dbg.stack().files >= 3, null, { timeout: 10000 });
      await waitIdle(page, 400);
      const nFiles = await page.evaluate(() => __dbg.stack().files);
      const empty = () => page.evaluate(() => __dbg.selCount() === 0);
      const state = () => page.evaluate(() => __dbg.selAllState());
      const clickAll = () => page.evaluate(() => document.getElementById('btnSelAll').click());

      ok(await empty(), 'selectall-starts-empty', { nFiles });
      await clickAll(); await sleep(120);
      const s1 = await state();
      ok(await page.evaluate(() => __dbg.selCount()) === nFiles, 'selectall-selects-everything', { nFiles });
      ok(s1.pressed === 'true' && s1.on === true, 'selectall-button-pressed-state', s1);
      ok(/取消全選|Deselect all/.test(s1.title) && /取消全選|Deselect all/.test(s1.barLabel),
        'selectall-label-switches', s1);
      await page.screenshot({ path: path.join(SHOTS, 'selectall-toggle.png') });
      console.log('shot ' + path.join(SHOTS, 'selectall-toggle.png'));

      await clickAll(); await sleep(120);
      const s2 = await state();
      ok(await empty(), 'selectall-second-click-clears');
      ok(s2.pressed === 'false' && s2.on === false, 'selectall-button-released-state', s2);
      ok(/全選|Select all/.test(s2.title) && /^全選$|^Select all$/.test(s2.barLabel.trim()),
        'selectall-label-restored', s2);

      // 部分選取（1 張）→ 按全選 → 變全選
      await page.evaluate(() => __dbg.selClick(0, false)); await sleep(80);
      ok(await page.evaluate(() => __dbg.selCount()) === 1, 'selectall-partial-one');
      const sPartial = await state();
      ok(sPartial.pressed === 'false', 'selectall-partial-not-pressed', sPartial);
      await clickAll(); await sleep(120);
      ok(await page.evaluate(() => __dbg.selCount()) === nFiles, 'selectall-partial-becomes-all');
      ok((await state()).pressed === 'true', 'selectall-partial-button-pressed');

      // Ctrl+A 兩次：第一次全選、第二次取消
      await page.evaluate(() => __dbg.selClear());
      await page.evaluate(() => document.body.focus());
      await page.keyboard.press('Control+a'); await sleep(150);
      ok(await page.evaluate(() => __dbg.selCount()) === nFiles, 'selectall-ctrl-a-selects-all');
      ok((await state()).pressed === 'true', 'selectall-ctrl-a-button-pressed');
      await page.keyboard.press('Control+a'); await sleep(150);
      ok(await empty(), 'selectall-ctrl-a-second-clears');
      ok((await state()).pressed === 'false', 'selectall-ctrl-a-button-released');

      // 換資料夾（回 root/plain 以外的清單）：按鈕狀態要跟著清單重算
      await page.evaluate(() => { __dbg.selAll(); });
      ok((await state()).pressed === 'true', 'selectall-all-before-folder-change');
      await page.evaluate(f => __dbg.lockFolder(f), RD('root/secret'));
      await page.waitForFunction(f => __dbg.lockedFolder() === f && __dbg.stack().phase === 'idle',
        RD('root/secret'), { timeout: 10000 });
      await sleep(200);
      ok((await state()).pressed === 'false' && await empty(), 'selectall-folder-change-resets');

      // 編輯器裡的 Ctrl+A 只選文字，不動卡片選取（先刻意選一張卡，才證明卡片選取沒被改）
      await page.evaluate(f => __dbg.lockFolder(f), RD('root/plain'));
      await page.waitForFunction(() => __dbg.stack().files >= 3, null, { timeout: 10000 });
      await waitIdle(page, 400);
      await page.evaluate(() => __dbg.selClick(0, false)); await sleep(80);
      ok(await page.evaluate(() => __dbg.selCount()) === 1, 'selectall-editor-setup-one-card');
      await page.evaluate(() => __dbg.openReader(1));
      await page.waitForFunction(() => __dbg.panel().shown === true, null, { timeout: 8000 });
      await page.evaluate(() => document.getElementById('btnEdit').click());
      await page.waitForFunction(() => !!document.querySelector('#readerBody .ev-editor'), null, { timeout: 8000 });
      await page.evaluate(() => document.querySelector('#readerBody .ev-editor').focus());
      await page.keyboard.press('Control+a'); await sleep(150);
      ok(await page.evaluate(() => __dbg.selCount()) === 1, 'selectall-editor-ctrl-a-leaves-cards');
      const textSel = await page.evaluate(() => {
        const s = getSelection();
        if (!s || !s.rangeCount) return -1;
        const inEditor = document.querySelector('#readerBody .ev-editor').contains(s.anchorNode);
        return inEditor ? s.toString().length : -2;
      });
      ok(textSel > 0, 'selectall-editor-text-selection-used', { textSel });
      await page.evaluate(() => document.getElementById('btnCancelEdit').click());
      await escPutBack(page);
      await page.evaluate(() => __dbg.selClear());
    }
  } finally {
    try { await browser.close(); } catch (_) {}
    try { server.kill(); } catch (_) {}
    await Promise.race([new Promise(r => server.once('exit', r)), sleep(3000)]);
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 6, retryDelay: 500 }); } catch (_) {}
  }

  ok(consoleErrors.length === 0, 'console-errors-zero', consoleErrors.slice(0, 5));
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exitCode = failed ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
