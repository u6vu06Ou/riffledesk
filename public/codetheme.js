// 程式碼檢視＋經典配色：vendored highlight.js（public/vendor，離線可用，不上 CDN）
// ＋ 8 款手寫主題（CSS 變數）＋ 行號槽 ＋ 換行切換。
// Node 測試可直接 import：DOM／hljs 只在函數裡碰；純函數（extToLang／resolveThemeId／
// planHighlight／tokenizeLine）不碰任何瀏覽器 API。
import { t } from './i18n.js';

export const HL_VERSION = '11.9.0';          // vendored 版本（cdnjs pin，license 標頭保留在原檔）

// ---- 副檔名 → hljs 語言（只對應 vendored 集合；cdnjs 11.9.0 無單獨 toml 檔，
// toml 是 ini 語法的官方 alias，所以 .toml 走 ini） -----------------------------
const EXT_LANG = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.json': 'json', '.py': 'python',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.html': 'xml', '.htm': 'xml', '.xml': 'xml', '.vue': 'xml',
  '.sh': 'bash', '.bash': 'bash', '.ps1': 'powershell', '.sql': 'sql',
  '.yaml': 'yaml', '.yml': 'yaml', '.ini': 'ini', '.cfg': 'ini', '.toml': 'ini',
  '.md': 'markdown', '.markdown': 'markdown',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
  '.cs': 'csharp', '.java': 'java', '.go': 'go', '.rs': 'rust', '.rb': 'ruby',
  '.php': 'php', '.lua': 'lua', '.diff': 'diff', '.dockerfile': 'dockerfile'
};
export function extToLang(ext) { return EXT_LANG[String(ext || '').toLowerCase()] || null; }

// 未知副檔名（kind=code 但表裡沒有）的自動偵測：限定在 vendored 集合內
export const AUTO_SUBSET = ['javascript', 'typescript', 'json', 'python', 'css', 'xml',
  'bash', 'powershell', 'sql', 'yaml', 'ini', 'markdown', 'c', 'cpp', 'csharp', 'java',
  'go', 'rust', 'php', 'ruby', 'lua', 'diff', 'dockerfile'];

// ---- 上色策略門檻（效能是硬需求：文字要先出來，上色隨後補） -------------------
export const SYNC_MAX_BYTES = 200 * 1024;   // 超過這個一律走 worker（非同步）
export const PLAIN_MAX_BYTES = 512 * 1024;  // 超過這個永遠純文字（閱讀器本來也只讀到 512KB）
export const SYNC_BUDGET_MS = 30;           // 同步上色只准在這個預算內
const SAMPLE_BYTES = 16 * 1024;             // 取中段樣本先量速，再決定同步或非同步

// mode: 'plain'（不上色）| 'sync'（直接上，必須 < SYNC_BUDGET_MS）| 'async'（worker）
// byteLen 是 UTF-8 位元組長度：門檻以位元組計（README 對使用者承諾的是 KB＝檔案大小；
// CJK 檔 char≠byte，用 char 數判門檻會讓 512KB 的 CJK 檔只被當 ~170K 而錯過純文字保護）。
// 沒有不外推直通 sync 的捷徑：小檔也照樣量完抽樣、估完 ×1.25 過預算門才准同步。
export function planHighlight(byteLen, estFullMs, { plain = false, hljsReady = true } = {}) {
  if (plain || !hljsReady) return 'plain';
  if (byteLen > PLAIN_MAX_BYTES) return 'plain';
  if (byteLen <= SYNC_MAX_BYTES && estFullMs * 1.25 < SYNC_BUDGET_MS) return 'sync';
  return 'async';
}

// ---- 8 款經典配色（調色盤近似各家官方定義）。跟著介面＝亮→GitHub Light、暗→GitHub Dark
export const THEME_ORDER = ['github-light', 'github-dark', 'one-dark', 'dracula',
  'monokai', 'solarized-light', 'solarized-dark', 'nord'];
export const THEMES = {
  'github-light': { label: 'GitHub Light', dark: false, pal: { bg: '#ffffff', fg: '#24292f', gutter: '#818b98', comment: '#6e7781', keyword: '#cf222e', string: '#0a3069', number: '#0550ae', title: '#8250df', type: '#953800', attr: '#0550ae', punct: '#6e7781', meta: '#0550ae', added: '#116329', deleted: '#82071e' } },
  'github-dark': { label: 'GitHub Dark', dark: true, pal: { bg: '#0d1117', fg: '#c9d1d9', gutter: '#6e7681', comment: '#8b949e', keyword: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', title: '#d2a8ff', type: '#ffa657', attr: '#79c0ff', punct: '#8b949e', meta: '#79c0ff', added: '#7ee787', deleted: '#ffa198' } },
  'one-dark': { label: 'One Dark', dark: true, pal: { bg: '#282c34', fg: '#abb2bf', gutter: '#5c6370', comment: '#5c6370', keyword: '#c678dd', string: '#98c379', number: '#d19a66', title: '#61afef', type: '#e5c07b', attr: '#d19a66', punct: '#abb2bf', meta: '#61afef', added: '#98c379', deleted: '#e06c75' } },
  'dracula': { label: 'Dracula', dark: true, pal: { bg: '#282a36', fg: '#f8f8f2', gutter: '#6272a4', comment: '#6272a4', keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', title: '#50fa7b', type: '#8be9fd', attr: '#50fa7b', punct: '#f8f8f2', meta: '#ff79c6', added: '#50fa7b', deleted: '#ff5555' } },
  'monokai': { label: 'Monokai', dark: true, pal: { bg: '#272822', fg: '#f8f8f2', gutter: '#75715e', comment: '#75715e', keyword: '#f92672', string: '#e6db74', number: '#ae81ff', title: '#a6e22e', type: '#66d9ef', attr: '#a6e22e', punct: '#f8f8f2', meta: '#66d9ef', added: '#a6e22e', deleted: '#f92672' } },
  'solarized-light': { label: 'Solarized Light', dark: false, pal: { bg: '#fdf6e3', fg: '#657b83', gutter: '#93a1a1', comment: '#93a1a1', keyword: '#859900', string: '#2aa198', number: '#d33682', title: '#268bd2', type: '#b58900', attr: '#6c71c4', punct: '#657b83', meta: '#cb4b16', added: '#859900', deleted: '#dc322f' } },
  'solarized-dark': { label: 'Solarized Dark', dark: true, pal: { bg: '#002b36', fg: '#839496', gutter: '#586e75', comment: '#586e75', keyword: '#859900', string: '#2aa198', number: '#d33682', title: '#268bd2', type: '#b58900', attr: '#6c71c4', punct: '#839496', meta: '#cb4b16', added: '#859900', deleted: '#dc322f' } },
  'nord': { label: 'Nord', dark: true, pal: { bg: '#2e3440', fg: '#d8dee9', gutter: '#616e88', comment: '#616e88', keyword: '#81a1c1', string: '#a3be8c', number: '#b48ead', title: '#88c0d0', type: '#8fbcbb', attr: '#8fbcbb', punct: '#81a1c1', meta: '#81a1c1', added: '#a3be8c', deleted: '#bf616a' } }
};

const KEY_THEME = 'riffleCodeTheme';
const KEY_WRAP = 'riffleCodeWrap';

function loadTheme() {
  try { const v = localStorage.getItem(KEY_THEME); if (v === 'follow' || THEMES[v]) return v; } catch (_) {}
  return 'follow';
}
let sel = loadTheme();
let wrapOn = (() => { try { return localStorage.getItem(KEY_WRAP) === '1'; } catch (_) { return false; } })();
// 預設：initCodeTheme 注入前也能用——直接讀 util.js 寫在 <html> 上的 data-theme，
// 再退到系統偏好，最後才是 'dark'（跟 util.js 的 themeName 判定同一套順序）
let uiThemeNow = () => {
  try { const v = document.documentElement?.dataset?.theme; if (v === 'light' || v === 'dark') return v; } catch (_) {}
  try { if (matchMedia('(prefers-color-scheme: light)').matches) return 'light'; } catch (_) {}
  return 'dark';
};
let onChangeCb = null;

// 純函數版（測試用）：id='follow' 時看 ui（'light'→github-light，否則 github-dark）
export function resolveThemeId(id, ui) {
  if (id && id !== 'follow' && THEMES[id]) return id;
  return ui === 'light' ? 'github-light' : 'github-dark';
}
export function codeThemeSel() { return sel; }
export function codeThemeNow() { return resolveThemeId(sel, uiThemeNow()); }
export function currentPalette() { return THEMES[codeThemeNow()].pal; }

// ---- 卡片縮圖用的便宜上色：跑一次 regex 分行挑 keyword/string/comment ----------
// （不走 hljs：一張卡的預算只有 ~2ms，40 行 regex 不到 0.5ms）
const THUMB_RE = new RegExp([
  '"(?:[^"\\\\\\n]|\\\\.)*"',       // "字串"
  "'(?:[^'\\\\\\n]|\\\\.)*'",       // '字串'
  '`(?:[^`\\\\\\n]|\\\\.)*`',       // `樣板字串`
  '\\/\\/[^\\n]*',                  // 行註解
  '\\/\\*[\\s\\S]*?\\*\\/',         // 區塊註解（允許內含 *，如 /* * */）
  '(?:^|(?<=\\s))#[^\\n]*',         // # 註解只認行首或空白後（#ff00aa 顏色碼、C 的 #include 前置不吃虧）
  '\\b(?:const|let|var|function|return|if|else|elif|for|while|do|import|from|export|class|extends|new|try|catch|except|finally|raise|def|lambda|async|await|yield|public|private|protected|static|void|null|true|false|None|int|float|str|bool|fn|mut|struct|impl|use|mod|package|func|go|defer|select|insert|update|delete|where|echo|fi|done|then|esac|namespace|using|switch|case|default|break|continue|this|self|typeof|instanceof|in|of|is|not|and|or|as|with' +
    '|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|INTO|VALUES|SET|CREATE|DROP|ALTER|TABLE|INDEX|VIEW|DISTINCT|UNION|ALL|AND|OR|NOT|NULL)\\b'
].join('|'), 'g');                  // 不用 i flag：FN/FooClass 這類大寫開頭名字不該整顆被當關鍵字
// 回 [{text, kind}] kind: 'code'|'keyword'|'string'|'comment'（測試與縮圖共用）
export function tokenizeLine(line) {
  const out = [];
  let last = 0;
  THUMB_RE.lastIndex = 0;
  for (let m; (m = THUMB_RE.exec(line));) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), kind: 'code' });
    const s = m[0];
    const kind = (s[0] === '"' || s[0] === "'" || s[0] === '`') ? 'string'
      : (s.startsWith('//') || s.startsWith('/*') || s.startsWith('#')) ? 'comment' : 'keyword';
    out.push({ text: s, kind });
    last = m.index + s.length;
  }
  if (last < line.length) out.push({ text: line.slice(last), kind: 'code' });
  return out;
}
export function thumbCodeColors() {
  const p = currentPalette();
  return { bg: p.bg, fg: p.fg, keyword: p.keyword, string: p.string, comment: p.comment };
}

// ---- 瀏覽器端 ---------------------------------------------------------------
const views = new Set();          // 活著的 .codeview（換色時重解析 data-ct）
let worker = null, workerSeq = 0, workerBroken = false;
const pendingHl = new Map();      // id → rec

function ensureCss() {
  if (document.getElementById('codetheme-css')) return;
  let css = '';
  for (const id of THEME_ORDER) {
    const p = THEMES[id].pal;
    css += `[data-ct="${id}"]{--cv-bg:${p.bg};--cv-fg:${p.fg};--cv-gutter:${p.gutter};--cv-comment:${p.comment};--cv-keyword:${p.keyword};--cv-string:${p.string};--cv-number:${p.number};--cv-title:${p.title};--cv-type:${p.type};--cv-attr:${p.attr};--cv-punct:${p.punct};--cv-meta:${p.meta};--cv-added:${p.added};--cv-deleted:${p.deleted};}\n`;
  }
  css += `
#readerBody.code{padding:0;}
#readerBody .codeview{background:var(--cv-bg);color:var(--cv-fg);display:flex;align-items:stretch;
  overflow:auto;height:100%;box-sizing:border-box;
  font:13px/1.6 Consolas,"Cascadia Mono","JetBrains Mono","Courier New",monospace;tab-size:4;}
#readerBody .cv-gutter{flex:none;position:sticky;left:0;z-index:1;padding:10px 10px 10px 14px;
  box-sizing:border-box;background:var(--cv-bg);color:var(--cv-gutter);white-space:pre;
  text-align:right;user-select:none;
  border-right:1px solid rgba(128,128,128,0.35);/* plain-color fallback for old browsers without color-mix */
  border-right:1px solid color-mix(in srgb,var(--cv-gutter) 30%,transparent);}
#readerBody .cv-code{flex:1;margin:0;padding:10px 14px;box-sizing:border-box;white-space:pre;
  min-width:max-content;background:transparent;border:0;border-radius:0;
  font:inherit;line-height:inherit;font-size:inherit;}
#readerBody .codeview.wrap .cv-code{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0;}
#readerBody .codeview.wrap .cv-gutter{display:none;}
#readerBody .codeview code{background:none;padding:0;border-radius:0;font:inherit;}
#readerBody .codeview .hljs-keyword,#readerBody .codeview .hljs-selector-tag,
#readerBody .codeview .hljs-tag,#readerBody .codeview .hljs-doctag,
#readerBody .codeview .hljs-template-tag{color:var(--cv-keyword);}
#readerBody .codeview .hljs-string,#readerBody .codeview .hljs-regexp,
#readerBody .codeview .hljs-char_escape_{color:var(--cv-string);}
#readerBody .codeview .hljs-number,#readerBody .codeview .hljs-literal{color:var(--cv-number);}
#readerBody .codeview .hljs-title,#readerBody .codeview .hljs-title.function_,
#readerBody .codeview .hljs-section{color:var(--cv-title);}
#readerBody .codeview .hljs-title.class_,#readerBody .codeview .hljs-type,
#readerBody .codeview .hljs-name{color:var(--cv-type);}
#readerBody .codeview .hljs-built_in,#readerBody .codeview .hljs-builtin-name{color:var(--cv-type);}
#readerBody .codeview .hljs-attr,#readerBody .codeview .hljs-attribute,
#readerBody .codeview .hljs-variable,#readerBody .codeview .hljs-template-variable,
#readerBody .codeview .hljs-selector-attr,#readerBody .codeview .hljs-selector-class,
#readerBody .codeview .hljs-selector-id,#readerBody .codeview .hljs-selector-pseudo{color:var(--cv-attr);}
#readerBody .codeview .hljs-comment,#readerBody .codeview .hljs-quote{color:var(--cv-comment);font-style:italic;}
#readerBody .codeview .hljs-meta,#readerBody .codeview .hljs-meta .hljs-keyword{color:var(--cv-meta);}
#readerBody .codeview .hljs-symbol,#readerBody .codeview .hljs-bullet,
#readerBody .codeview .hljs-link,#readerBody .codeview .hljs-formula{color:var(--cv-number);}
#readerBody .codeview .hljs-operator,#readerBody .codeview .hljs-punctuation,
#readerBody .codeview .hljs-subst{color:var(--cv-punct);}
#readerBody .codeview .hljs-addition{color:var(--cv-added);}
#readerBody .codeview .hljs-deletion{color:var(--cv-deleted);}
#readerBody .codeview .hljs-emphasis{font-style:italic;}
#readerBody .codeview .hljs-strong{font-weight:700;}
`;
  const el = document.createElement('style');
  el.id = 'codetheme-css';
  el.textContent = css;
  document.head.appendChild(el);
}

function reresolveViews() {
  const id = codeThemeNow();
  for (const v of [...views]) {
    if (!v.isConnected) { views.delete(v); continue; }
    v.dataset.ct = id;
  }
}

function syncControls() {
  const sw = document.getElementById('codeThemeSwatch');
  if (sw) {
    const p = currentPalette();
    sw.style.background = p.bg;
    sw.innerHTML = '';
    for (const [txt, color] of [['fn', p.keyword], ['"str"', p.string], ['42', p.number], [t('ctSwComment'), p.comment]]) {
      const s = document.createElement('span');
      s.style.color = color;
      s.textContent = txt;
      sw.appendChild(s);
    }
  }
  const selEl = document.getElementById('codeThemeSel');
  const miniEl = document.getElementById('codeThemeMini');
  if (selEl && selEl.value !== sel) selEl.value = sel;
  if (miniEl && miniEl.value !== sel) miniEl.value = sel;
  syncWrapBtn();
}
function syncWrapBtn() {
  const b = document.getElementById('btnWrap');
  if (b) { b.classList.toggle('on', wrapOn); }
}

export function setCodeTheme(id) {
  if (id !== 'follow' && !THEMES[id]) return;
  sel = id;
  try { localStorage.setItem(KEY_THEME, id); } catch (_) {}
  reresolveViews();
  syncControls();
  if (onChangeCb) { try { onChangeCb(); } catch (_) {} }
}

export function toggleWrap(force) {
  wrapOn = force === undefined ? !wrapOn : !!force;
  try { wrapOn ? localStorage.setItem(KEY_WRAP, '1') : localStorage.removeItem(KEY_WRAP); } catch (_) {}
  for (const v of [...views]) {
    if (!v.isConnected) { views.delete(v); continue; }
    v.classList.toggle('wrap', wrapOn);
  }
  syncWrapBtn();
}
export function wrapNow() { return wrapOn; }

// 閱讀區 header 的兩個控制（mini 配色 select＋換行鈕）只在程式碼檢視打開時出現
export function setCodeControlsVisible(on) {
  const m = document.getElementById('codeThemeMini');
  const w = document.getElementById('btnWrap');
  if (m) m.hidden = !on;
  if (w) w.hidden = !on;
}

// ---- 實際渲染 ---------------------------------------------------------------
function hljsReady() { const H = globalThis.hljs; return !!(H && H.getLanguage && H.getLanguage('javascript')); }

const SAMPLE_FLOOR_MS = 0.05;   // 計時解析度地板（performance.now 在減精度模式下可回 0）
// UTF-8 位元組長度：reader 有檔案大小就直接用（rec.bytes），沒有才量字串
function utf8Len(s) {
  try {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  } catch (_) {}
  let n = 0;
  for (let i = 0; i < s.length; i++) {                        // 手算退路（極舊環境）
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length ? (i++, 4) : 3);
  }
  return n;
}

function doneHl(rec, language, ms, mode) {
  rec.done = true;
  rec.view.dataset.hl = mode;             // 'done' | 'plain'
  if (language) rec.pre.classList.add('language-' + language);
  if (ms != null) rec.view.dataset.hlMs = String(Math.round(ms));
}

function detectLang(H, text) {
  try {
    const r = H.highlightAuto(text.length > 4000 ? text.slice(0, 4000) : text, AUTO_SUBSET);
    return r.language && H.getLanguage(r.language) ? r.language : null;
  } catch (_) { return null; }
}

function applyHighlight(rec) {
  const H = globalThis.hljs;
  const text = rec.text;
  rec.view.dataset.hl = 'pending';
  let lang = rec.lang;
  if (lang === 'auto') {
    if (!hljsReady()) { doneHl(rec, null, 0, 'plain'); return; }
    lang = detectLang(H, text);            // 偵測不到（null）→ 純文字
    rec.lang = lang || 'plain';
    if (!lang) { doneHl(rec, null, 0, 'plain'); return; }
  } else if (lang && !(hljsReady() && H.getLanguage(lang))) {
    doneHl(rec, null, 0, 'plain'); return;
  } else if (!lang) {
    doneHl(rec, null, 0, 'plain'); return;
  }

  let mode;
  const byteLen = (rec.bytes != null && rec.bytes > 0) ? rec.bytes : utf8Len(text);
  if (byteLen > PLAIN_MAX_BYTES || rec.plain) mode = 'plain';
  else if (byteLen <= SYNC_MAX_BYTES) {
    const sample = text.length > SAMPLE_BYTES
      ? text.slice((text.length >> 1) - (SAMPLE_BYTES >> 1), (text.length >> 1) + (SAMPLE_BYTES >> 1))
      : text;
    const t0 = performance.now();
    try { H.highlight(sample, { language: lang, ignoreIllegals: true }); } catch (_) { doneHl(rec, null, 0, 'plain'); return; }
    const dt = Math.max(performance.now() - t0, SAMPLE_FLOOR_MS);
    const estFull = sample.length ? dt * (text.length / sample.length) : dt;
    mode = planHighlight(byteLen, estFull);
  } else mode = planHighlight(byteLen, Infinity);

  if (mode === 'plain') { doneHl(rec, null, 0, 'plain'); return; }
  if (mode === 'sync') {
    const t0 = performance.now();
    try {
      const r = H.highlight(text, { language: lang, ignoreIllegals: true });
      rec.code.innerHTML = r.value;
      doneHl(rec, r.language || lang, performance.now() - t0, 'done');
    } catch (_) { doneHl(rec, null, 0, 'plain'); }
    return;
  }
  highlightViaWorker(rec, lang);
}

function getWorker() {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker('/vendor/hl-worker.js');
    worker.onmessage = e => {
      const { id, ok, value, language, ms } = e.data || {};
      const rec = pendingHl.get(id);
      pendingHl.delete(id);
      if (!rec) return;
      clearTimeout(rec.jobTimer);
      if (!rec.view.isConnected || rec.cancelled) return;
      if (!ok) { highlightChunked(rec); return; }
      const st = rec.view.scrollTop, sl = rec.view.scrollLeft;
      rec.code.innerHTML = value;
      doneHl(rec, language, ms, 'done');
      rec.view.scrollTop = st; rec.view.scrollLeft = sl;   // 換 HTML 不跳捲動
    };
    worker.onerror = () => { workerBroken = true; worker = null;
      for (const [, rec] of pendingHl) {
        clearTimeout(rec.jobTimer);
        if (rec.view.isConnected && !rec.cancelled) highlightChunked(rec);
      }
      pendingHl.clear();
    };
  } catch (_) { workerBroken = true; return null; }
  return worker;
}

const JOB_TIMEOUT_MS = 30 * 1000;   // worker 不回話（死了/被凍結）的超時：退回分塊閒時上色
function highlightViaWorker(rec, lang) {
  const w = getWorker();
  if (!w) { highlightChunked(rec, lang); return; }
  const id = ++workerSeq;
  rec.jobTimer = setTimeout(() => {
    if (pendingHl.delete(id)) {          // 還沒收到回話才算超時；收到過的已被 onmessage 清掉
      if (rec.view.isConnected && !rec.cancelled) highlightChunked(rec, lang);
    }
  }, JOB_TIMEOUT_MS);
  pendingHl.set(id, rec);
  rec.pendingId = id;
  try {
    w.postMessage({ id, text: rec.text, lang });
  } catch (_) {
    clearTimeout(rec.jobTimer);
    pendingHl.delete(id);
    highlightChunked(rec, lang);
  }
}

// worker 不可用的最後保險：分塊閒時上色（state 在塊界重置，塊界附近顏色可能錯——
// 只影響跨塊的註解／字串，可接受；正常環境走不到這裡）
function highlightChunked(rec, lang) {
  const H = globalThis.hljs;
  lang = lang || rec.lang;
  if (!H || !lang || !H.getLanguage(lang)) { doneHl(rec, null, 0, 'plain'); return; }
  const lines = rec.text.split(/(?<=\n)/);
  const chunks = [];
  for (let i = 0; i < lines.length; i += 400) chunks.push(lines.slice(i, i + 400).join(''));
  const out = [];
  const idle = fn => (globalThis.requestIdleCallback ? requestIdleCallback(fn) : setTimeout(fn, 16));
  const t0 = performance.now();
  const step = () => {
    if (!rec.view.isConnected || rec.cancelled) return;
    const next = out.length;
    try { out.push(H.highlight(chunks[next], { language: lang, ignoreIllegals: true }).value); }
    catch (_) { doneHl(rec, null, 0, 'plain'); return; }
    if (out.length < chunks.length) { idle(step); return; }
    const st = rec.view.scrollTop, sl = rec.view.scrollLeft;
    rec.code.innerHTML = out.join('');
    doneHl(rec, lang, performance.now() - t0, 'done');
    rec.view.scrollTop = st; rec.view.scrollLeft = sl;
  };
  idle(step);
}

// reader 呼叫：把 body 換成「行號槽＋等寬字 codeview」。先塞純文字（立刻可見），
// 上色照 planHighlight 的策略補上。opts: { lang: 'python'|'auto'|null, plain: bool, bytes: 檔案位元組數 }
export function renderCodeView(body, text, opts = {}) {
  ensureCss();
  const t0 = performance.now();
  body.innerHTML = '';
  // 舊的 codeview 已被 innerHTML='' 清掉：順手從 views 剪掉，Set 才不會只進不出
  for (const v of [...views]) if (!v.isConnected) views.delete(v);
  const view = document.createElement('div');
  view.className = 'codeview' + (wrapOn ? ' wrap' : '');
  view.dataset.ct = codeThemeNow();
  view.dataset.ctFollow = sel === 'follow' ? '1' : '0';
  const gutter = document.createElement('div');
  gutter.className = 'cv-gutter';
  const nLines = text.length ? text.replace(/\n$/, '').split('\n').length : 1;
  if (nLines <= 60000) {
    let nums = '';
    for (let i = 1; i <= nLines; i++) nums += i + '\n';
    gutter.textContent = nums.slice(0, -1);
  }                                          // 行數爆多就不編號（現實檔案到不了）
  const pre = document.createElement('pre');
  pre.className = 'cv-code hljs';
  const code = document.createElement('code');
  code.textContent = text;
  pre.appendChild(code);
  view.append(gutter, pre);
  body.appendChild(view);
  views.add(view);
  const rec = { view, pre, code, gutter, text, lang: opts.lang ?? null,
    plain: !!opts.plain, bytes: opts.bytes ?? null, done: false, cancelled: false, jobTimer: null };
  view.dataset.textMs = String(Math.round(performance.now() - t0));
  applyHighlight(rec);
  return rec;
}

// ---- 初始化（⚙ 設定的下拉＋色票、閱讀區 header 的迷你 select＋換行鈕、Alt+Z） -----
export function initCodeTheme({ uiTheme, onChange } = {}) {
  if (typeof document === 'undefined') return;   // Node 測試不跑這段
  if (typeof uiTheme === 'function') uiThemeNow = uiTheme;
  onChangeCb = onChange || null;
  ensureCss();
  const buildOpts = el => {
    if (!el || el.dataset.built) return;
    el.dataset.built = '1';
    el.innerHTML = '';
    const f = document.createElement('option');
    f.value = 'follow';
    f.textContent = t('ctFollow');
    el.appendChild(f);
    for (const id of THEME_ORDER) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = THEMES[id].label;
      el.appendChild(o);
    }
    el.value = sel;
  };
  buildOpts(document.getElementById('codeThemeSel'));
  buildOpts(document.getElementById('codeThemeMini'));
  const onSel = v => setCodeTheme(v);
  const selEl = document.getElementById('codeThemeSel');
  const miniEl = document.getElementById('codeThemeMini');
  if (selEl) selEl.addEventListener('change', () => onSel(selEl.value));
  if (miniEl) miniEl.addEventListener('change', () => onSel(miniEl.value));
  const wrapBtn = document.getElementById('btnWrap');
  if (wrapBtn) wrapBtn.addEventListener('click', () => toggleWrap());
  addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.shiftKey) return;
    if (e.key !== 'z' && e.key !== 'Z') return;
    let any = false;
    for (const v of views) if (v.isConnected) { any = true; break; }
    if (!any) return;
    e.preventDefault();
    toggleWrap();
  });
  // app 亮暗主題翻轉：跟著介面的程式碼檢視一起換（資料只換 data-ct，顏色全在 CSS）
  addEventListener('themechange', () => reresolveViews());
  syncControls();
}
