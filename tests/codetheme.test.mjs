// tests/codetheme.test.mjs — codetheme.js 純函數＋vendored highlight.js 健康檢查（零伺服器、零瀏覽器）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extToLang, THEMES, THEME_ORDER, resolveThemeId, planHighlight, tokenizeLine,
  thumbCodeColors, AUTO_SUBSET, SYNC_MAX_BYTES, PLAIN_MAX_BYTES, SYNC_BUDGET_MS, HL_VERSION
} from '../public/codetheme.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadVendorHljs() {
  const dir = path.join(ROOT, 'public', 'vendor');
  for (const f of ['highlight.min.js', 'languages-powershell.min.js', 'languages-dockerfile.min.js'])
    (0, eval)(fs.readFileSync(path.join(dir, f), 'utf8'));
  return globalThis.hljs;
}

test('ext→lang：常見副檔名對到 vendored 語言，未知回 null', () => {
  assert.equal(extToLang('.js'), 'javascript');
  assert.equal(extToLang('.TS'), 'typescript');   // 大小寫不敏感
  assert.equal(extToLang('.py'), 'python');
  assert.equal(extToLang('.ps1'), 'powershell');
  assert.equal(extToLang('.toml'), 'ini');        // cdnjs 11.9.0 無獨立 toml 檔；ini 語法官方 alias=toml
  assert.equal(extToLang('.dockerfile'), 'dockerfile');
  assert.equal(extToLang('.xyz'), null);
  assert.equal(extToLang(''), null);
});

test('8 款主題調色盤欄位齊全（#rrggbb）', () => {
  assert.equal(THEME_ORDER.length, 8);
  const KEYS = ['bg', 'fg', 'gutter', 'comment', 'keyword', 'string', 'number', 'title',
    'type', 'attr', 'punct', 'meta', 'added', 'deleted'];
  for (const id of THEME_ORDER) {
    const th = THEMES[id];
    assert.ok(th && th.label, id + ' label');
    for (const k of KEYS) assert.match(th.pal[k], /^#[0-9a-f]{6}$/i, `${id}.${k}`);
  }
});

test('resolveThemeId：跟著介面 → 亮 GitHub Light／暗 GitHub Dark；明指定就用明指定', () => {
  assert.equal(resolveThemeId('follow', 'light'), 'github-light');
  assert.equal(resolveThemeId('follow', 'dark'), 'github-dark');
  assert.equal(resolveThemeId(null, 'dark'), 'github-dark');
  assert.equal(resolveThemeId('nord', 'light'), 'nord');
  assert.equal(resolveThemeId('garbage', 'light'), 'github-light');
});

test('planHighlight：超大永遠純文字；門檻以位元組計；小檔也要過預算門才同步；>200KB 走非同步', () => {
  assert.equal(planHighlight(1000, 999, { plain: true }), 'plain');
  assert.equal(planHighlight(1000, 1, { hljsReady: false }), 'plain');
  assert.equal(planHighlight(PLAIN_MAX_BYTES + 1, 1), 'plain');
  assert.equal(planHighlight(8 * 1024, 0.1), 'sync');                        // 小檔量得起來 → 同步
  assert.equal(planHighlight(8 * 1024, 9999), 'async');                      // 小檔但量出來慢 → 也不同步
  assert.equal(planHighlight(64 * 1024, 10), 'sync');                        // 10×1.25 < 30
  assert.equal(planHighlight(200 * 1024, 40), 'async');                      // 40×1.25 ≥ 30
  assert.equal(planHighlight(300 * 1024, 1), 'async');                       // >200KB 一律非同步
  assert.ok(SYNC_MAX_BYTES < PLAIN_MAX_BYTES && SYNC_BUDGET_MS > 0);
});

test('tokenizeLine：卡片縮圖用的便宜挑色（keyword/string/comment）', () => {
  const spans = tokenizeLine('const s = "hi"; // note');
  const joined = spans.map(s => s.text).join('');
  assert.equal(joined, 'const s = "hi"; // note');           // 不丟字元
  assert.ok(spans.some(s => s.kind === 'keyword' && s.text === 'const'));
  assert.ok(spans.some(s => s.kind === 'string' && s.text === '"hi"'));
  assert.ok(spans.some(s => s.kind === 'comment' && s.text === '// note'));
  assert.equal(tokenizeLine('').length, 0);
  assert.equal(tokenizeLine('plain text').every(s => s.kind === 'code'), true);
  // # 註解只認行首或空白後；黏在字元後的不算（a#b、路徑片段）
  assert.ok(tokenizeLine('# comment').some(s => s.kind === 'comment'));
  assert.ok(tokenizeLine('  # comment').some(s => s.kind === 'comment'));
  assert.ok(tokenizeLine('a#b').every(s => s.kind !== 'comment'));
  // 區塊註解允許內含 *；大寫 SQL 關鍵字也挑得出來（不用 i flag，半大寫不中）
  assert.ok(tokenizeLine('/* * */ x').some(s => s.kind === 'comment' && s.text === '/* * */'));
  assert.ok(tokenizeLine('SELECT x FROM t').some(s => s.kind === 'keyword' && s.text === 'SELECT'));
  assert.ok(tokenizeLine('Select x').every(s => s.kind === 'code'));
});

test('thumbCodeColors 不需要瀏覽器也能取到預設配色', () => {
  const c = thumbCodeColors();
  assert.match(c.bg, /^#/); assert.match(c.keyword, /^#/);
});

test('vendored highlight.js：版本固定、授權標頭在、需求語言全註冊', () => {
  const core = fs.readFileSync(path.join(ROOT, 'public', 'vendor', 'highlight.min.js'), 'utf8');
  assert.match(core, /^\/\*!\s*\n\s*Highlight\.js/);          // BSD-3 授權標頭留在檔頭
  assert.match(core, /BSD-?3-Clause/i);
  const hljs = loadVendorHljs();
  assert.equal(hljs.versionString, HL_VERSION);
  assert.deepEqual(hljs.getLanguage('ini').aliases, ['toml']);
  for (const lang of AUTO_SUBSET) assert.ok(hljs.getLanguage(lang), 'missing ' + lang);
  // 每個 EXT_LANG 值都必須真的存在於 vendored 集合
  for (const ext of ['.js', '.ts', '.json', '.py', '.css', '.html', '.sh', '.ps1', '.sql',
    '.yaml', '.ini', '.toml', '.md', '.c', '.cpp', '.cs', '.java', '.go', '.rs', '.php',
    '.rb', '.lua', '.diff', '.dockerfile'])
    assert.ok(hljs.getLanguage(extToLang(ext)), ext);
});

test('vendored highlight.js：上色輸出確實有 token span', () => {
  const hljs = loadVendorHljs();
  const js = hljs.highlight('const greeting = "hi"; // c\n', { language: 'javascript', ignoreIllegals: true });
  assert.match(js.value, /hljs-keyword/);
  assert.match(js.value, /hljs-string/);
  const py = hljs.highlight('import sys\nprint("x")\n', { language: 'python', ignoreIllegals: true });
  assert.match(py.value, /hljs-keyword/);
  const ps = hljs.highlight('Get-ChildItem $home -Force\n', { language: 'powershell', ignoreIllegals: true });
  assert.ok(ps.value.length > 20);
});

test('vendored highlight.js：輸出永遠跳脫 HTML（innerHTML 上色是 XSS 安全的）', () => {
  const hljs = loadVendorHljs();
  for (const lang of ['xml', 'javascript', 'python']) {
    const r = hljs.highlight('<script>alert(1)</script>', { language: lang, ignoreIllegals: true });
    assert.match(r.value, /&lt;/, lang);                    // < 有跳脫（可能被 span 包開，不連續）
    assert.ok(!r.value.includes('<script>'), lang + ' 有未跳脫的 <script>');
  }
});
