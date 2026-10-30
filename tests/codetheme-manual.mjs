// tests/codetheme-manual.mjs — 程式碼配色的「親眼看」工具：起 5184（不碰 5177/5178/5179），
// 用暫存 fixture＋真實 public/main.js 開啟各語言程式碼檢視，對 8 款主題各截一張圖
// （docs/screenshots/codetheme-*.png），同時把 textMs/hlMs 時量印出來給人力回報。
// 不寫斷言（人看圖為準），但任何一步逾時就退出非零。用法：node tests/codetheme-manual.mjs
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffle-codetheme-'));
const RD = p => path.join(TMP, ...p.split('/'));

const timings = [];

function buildFixtures() {
  fs.mkdirSync(RD('root/code'), { recursive: true });
  const w = (rel, s) => fs.writeFileSync(RD(rel), s);
  w('root/code/demo.py', `# demo module\nimport sys, json\nfrom pathlib import Path\n\nMAX_RETRIES = 3\n\ndef load_config(path: str) -> dict:\n    """Read a JSON config file."""\n    p = Path(path)\n    if not p.exists():\n        raise FileNotFoundError(f"missing: {p}")\n    with p.open(encoding="utf-8") as fh:\n        data = json.load(fh)\n    return data  # keep it simple\n\nclass Runner:\n    def __init__(self, name, retries=MAX_RETRIES):\n        self.name = name\n        self.retries = retries\n\n    def run(self, cmd):\n        for attempt in range(1, self.retries + 1):\n            try:\n                print(f"[{self.name}] run {cmd!r} (try {attempt})")\n                return True\n            except Exception as exc:\n                print("failed:", exc)\n        return False\n\nif __name__ == "__main__":\n    runner = Runner("main")\n    ok = runner.run(sys.argv[1:])\n    print("done", ok)\n`);
  w('root/code/demo.js', `// demo es module\nimport { readdir } from 'node:fs/promises';\n\nconst DEFAULT_ROOT = '/tmp';\nconst CACHE = new Map();\n\n/**\n * List names under dir, cached.\n * @param {string} dir\n * @returns {Promise<string[]>}\n */\nexport async function listNames(dir = DEFAULT_ROOT) {\n  const key = dir.toLowerCase();\n  if (CACHE.has(key)) return CACHE.get(key);\n  const names = (await readdir(dir)).filter(n => !n.startsWith('.'));\n  CACHE.set(key, names);\n  console.log(\`listed \${names.length} entries in "\${dir}"\`);\n  return names;\n}\n\nexport const VERSION = '2.1.0';\nconst timeoutMs = 2500;\nlet cancelled = false;\n\nexport function sleep(ms = 0) {\n  return new Promise(resolve => setTimeout(resolve, ms));\n}\n`);
  w('root/code/demo.css', `/* demo stylesheet */\n:root {\n  --bg: #ffffff;\n  --accent: hsl(210 80% 45%);\n}\n\n.card, .card--ghost {\n  display: grid;\n  grid-template-columns: 1fr 2fr;\n  gap: 12px;\n  background: var(--bg);\n  border: 1px solid rgb(0 0 0 / 0.12);\n}\n\n.card > h2:first-child {\n  font: 600 1.25rem/1.4 "Segoe UI", sans-serif;\n  color: var(--accent) !important;\n}\n\n@media (max-width: 720px) {\n  .card { grid-template-columns: 1fr; }\n}\n`);
  w('root/code/demo.json', JSON.stringify({
    name: 'riffle-desk', version: '2.0.0', private: true,
    scripts: { start: 'node server.js', test: "node --test 'tests/*.test.mjs'" },
    engines: { node: '>=22.5' }, ports: [5177, 5178, 5179], flags: { dev: false, stable: true }
  }, null, 2) + '\n');
  w('root/code/demo.sql', `-- demo query\nSELECT o.id, c.name, SUM(o.total) AS spent\nFROM orders AS o\nJOIN customers AS c ON c.id = o.customer_id\nWHERE o.created_at >= DATE '2026-01-01'\n  AND o.status IN ('paid', 'shipped')\nGROUP BY o.id, c.name\nHAVING SUM(o.total) > 100.0\nORDER BY spent DESC\nLIMIT 20;\n`);
  w('root/code/demo.ps1', `# demo powershell\nparam([string]$Root = "C:\\data", [switch]$Recurse)\n\n$items = Get-ChildItem -Path $Root -Recurse:$Recurse -File |\n  Where-Object { $_.Length -gt 1MB } |\n  Sort-Object Length -Descending |\n  Select-Object -First 10\n\nforeach ($it in $items) {\n  Write-Host ("{0,10:N0}  {1}" -f $it.Length, $it.FullName)\n}\n`);
  w('root/code/demo.rs', `// demo rust\nuse std::collections::HashMap;\n\n#[derive(Debug, Default)]\nstruct Counter {\n    hits: HashMap<String, u64>,\n}\n\nimpl Counter {\n    fn bump(&mut self, key: &str) -> u64 {\n        let e = self.hits.entry(key.to_owned()).or_insert(0);\n        *e += 1;\n        *e\n    }\n}\n\nfn main() {\n    let mut c = Counter::default();\n    for word in ["aa", "bb", "aa", "cc", "bb", "aa"] {\n        c.bump(word);\n    }\n    println!("counts: {:?}", c);\n}\n`);
  w('root/code/demo.html', [
    '<!doctype html>', '<html lang="zh">', '<head>',
    '  <meta charset="utf-8">', '  <title>demo page</title>',
    '  <style>body { font-family: sans-serif; margin: 2rem; } .hi { color: #c7254e; }</style>',
    '</head>', '<body>',
    '  <h1 class="hi">哈囉</h1>', '  <p id="msg">waiting…</p>',
    '  <script>document.getElementById("msg").textContent = "ready " + new Date().toISOString();</' + 'script>',
    '</body>', '</html>', ''
  ].join('\n'));
  // 300KB .js（走 worker 非同步路徑）
  {
    let s = '';
    for (let i = 0; s.length < 300 * 1024; i++)
      s += `// chunk ${i}\nfunction fib${i}(n) { return n < 2 ? n : fib${i}(n - 1) + fib${i}(n - 2); }\n` +
        `const NAME_${i} = "value-${i}";\nexport { fib${i}, NAME_${i} };\n`;
    w('root/code/big.js', s);
  }
  // ~450KB 有效 .json（閱讀區會 pretty-print 再上色）
  {
    const rows = [];
    let len = 2;
    for (let i = 0; len < 440 * 1024; i++) {
      const row = { id: i, name: `item-${i}`, tags: ['alpha', 'beta', 'gamma'],
        flags: [i % 2 === 0, null], price: 12.34 + i,
        meta: { desc: 'synthesized row for highlighting perf measurement', rev: i * 7 } };
      len += JSON.stringify(row).length + 1;
      rows.push(row);
    }
    w('root/code/big.json', JSON.stringify(rows));
  }
}

async function startServer() {
  const cfgPath = path.join(TMP, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ roots: [RD('root'), path.join(ROOT, 'public')] }, null, 2));
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: cfgPath },
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

const THEME_IDS = ['github-light', 'github-dark', 'one-dark', 'dracula',
  'monokai', 'solarized-light', 'solarized-dark', 'nord'];

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  buildFixtures();
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'zh-TW' });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('riffleTipSeen', '1');
        localStorage.setItem('floderLang', 'zh');
      } catch (_) {}
    });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__dbg && __dbg.ready(), null, { timeout: 15000 });
    await page.evaluate(() => __dbg.ready2 && __dbg.ready2());
    for (const p of ['root', 'root/code']) await page.evaluate(x => __dbg.expandTreeNode(x), RD(p));

    const shot = async name => {
      const p = path.join(SHOTS, 'codetheme-' + name + '.png');
      await page.screenshot({ path: p });
      console.log('shot ' + p);
    };
    const setTheme = id => page.evaluate(v => {
      const s = document.getElementById('codeThemeSel');
      s.value = v; s.dispatchEvent(new Event('change', { bubbles: true }));
    }, id);
    const openAndTime = async (name, timeout = 30000) => {
      const idx = await page.evaluate(n => __dbg.fileNames().indexOf(n), name);
      if (idx < 0) throw new Error('card not found: ' + name);
      await page.evaluate(i => __dbg.openReader(i), idx);
      await page.waitForSelector('#readerBody .codeview', { timeout });
      const atShow = await page.evaluate(() => {
        const cv = document.querySelector('#readerBody .codeview');
        return { textMs: +(cv.dataset.textMs || 0), hlAtShow: cv.dataset.hl,
          len: cv.querySelector('.cv-code').textContent.length, ct: cv.dataset.ct };
      });
      await page.waitForFunction(() => {
        const cv = document.querySelector('#readerBody .codeview');
        return cv && (cv.dataset.hl === 'done' || cv.dataset.hl === 'plain');
      }, null, { timeout });
      const done = await page.evaluate(() => {
        const cv = document.querySelector('#readerBody .codeview');
        return { hl: cv.dataset.hl, hlMs: cv.dataset.hlMs ? +cv.dataset.hlMs : null,
          spans: cv.querySelectorAll('.cv-code span[class^="hljs"]').length };
      });
      const rec = { file: name, ...atShow, ...done };
      timings.push(rec);
      console.log('timing ' + JSON.stringify(rec));
      return rec;
    };
    const closeReader = () => page.evaluate(() => __dbg.closeReader());

    // ---------------- 主題巡禮：demo.py × 8 主題 ----------------
    await page.evaluate(([f, id]) => { __dbg.lockFolder(f); __dbg.selectChip(id); },
      [RD('root/code'), 'code']);
    await page.waitForFunction(() => __dbg.fileNames().includes('demo.py'), null, { timeout: 10000 });
    await sleep(700);
    await openAndTime('demo.py');
    for (const id of THEME_IDS) {
      await setTheme(id);
      await sleep(250);   // CSS 變數即換，等一幀繪製
      await shot(id);
    }

    // ---------------- 各語言各挑一個主題截圖（code chip：js/sql/ps1/rs/css） ----------------
    for (const [file, theme, shotName] of [
      ['demo.js', 'one-dark', 'js-one-dark'],
      ['demo.sql', 'github-light', 'sql-github-light'],
      ['demo.ps1', 'monokai', 'ps1-monokai'],
      ['demo.rs', 'dracula', 'rs-dracula'],
      ['demo.css', 'nord', 'css-nord']
    ]) {
      await closeReader();
      await sleep(250);
      await setTheme(theme);
      await openAndTime(file);
      await shot(shotName);
    }

    // ---------------- 大檔：300KB js（worker 非同步路徑） ----------------
    await setTheme('nord');
    {
      await closeReader();
      await sleep(200);
      const t0 = Date.now();
      const rec = await openAndTime('big.js', 60000);
      rec.wallMs = Date.now() - t0;
      console.log('big ' + JSON.stringify(rec));
      await shot('big-js');
    }

    // ---------------- 長行換行鈕 ----------------
    await closeReader();
    await sleep(200);
    await openAndTime('demo.js');
    await page.click('#btnWrap');
    await sleep(300);
    await shot('wrap-on');
    await page.click('#btnWrap');
    await sleep(150);
    await closeReader();

    // ---------------- readable chip：pretty JSON 上色／450KB json ----------------
    await page.evaluate(id => __dbg.selectChip(id), 'readable');
    await page.waitForFunction(() => __dbg.fileNames().includes('demo.json'), null, { timeout: 10000 });
    await sleep(500);
    await setTheme('solarized-dark');
    await openAndTime('demo.json');
    await shot('json-solarized-dark');
    {
      await closeReader();
      await sleep(200);
      const t0 = Date.now();
      const rec = await openAndTime('big.json', 60000);
      rec.wallMs = Date.now() - t0;
      console.log('big ' + JSON.stringify(rec));
      await shot('big-json');
    }

    // ---------------- HTML 原始碼檢視（＜/＞ 按鈕） ----------------
    await page.evaluate(id => __dbg.selectChip(id), 'html');
    await page.waitForFunction(() => __dbg.fileNames().includes('demo.html'), null, { timeout: 10000 });
    await sleep(500);
    await openAndTimeHtmlLike(page, timings, errors);
    await shot('html-preview');
    await page.click('#btnSource');
    await page.waitForSelector('#readerBody .codeview', { timeout: 10000 });
    await page.waitForFunction(() => {
      const cv = document.querySelector('#readerBody .codeview');
      return cv && cv.dataset.hl === 'done';
    }, null, { timeout: 15000 });
    await setTheme('github-dark');
    await sleep(250);
    await shot('html-src-github-dark');
    await closeReader();

    // ---------------- 真實檔 public/main.js（58KB） ----------------
    await page.evaluate(([f, id]) => { __dbg.lockFolder(f); __dbg.selectChip(id); },
      [path.join(ROOT, 'public'), 'code']);
    await page.waitForFunction(() => __dbg.fileNames().includes('main.js'), null, { timeout: 10000 });
    await sleep(700);
    await setTheme('one-dark');
    await openAndTime('main.js');
    await shot('mainjs-one-dark');

    console.log('TIMINGS ' + JSON.stringify(timings, null, 1));
    if (errors.length) console.log('CONSOLE-ERRORS ' + JSON.stringify(errors.slice(0, 10), null, 1));

    // ---------------- ⚙ 設定面板：程式碼配色下拉＋即時色票 ----------------
    await page.click('#btnSettings');
    await sleep(400);
    await shot('settings');
    await page.click('#btnSettings');
    await sleep(200);
  } finally {
    await browser.close();
    server.kill();
  }
}

// html 檔讀出來先走預覽 iframe；這裡只記錄它開起來了，細節看截圖
async function openAndTimeHtmlLike(page, timings) {
  const idx = await page.evaluate(() => __dbg.fileNames().indexOf('demo.html'));
  await page.evaluate(i => __dbg.openReader(i), idx);
  await page.waitForSelector('#readerBody iframe, #readerBody .codeview', { timeout: 15000 });
  await new Promise(r => setTimeout(r, 800));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
