// scripts/scan-hardcoded-zh.mjs — find hardcoded Chinese text that would show in the UI
// without going through i18n. Scans public/*.js, public/*.html, extension/*.js,
// extension/*.html. Comments never count. Exit code 1 when anything is found.
//
// Rules:
//   JS  — every string literal ('…', "…", `…`) containing CJK is a hit,
//         except lines whose code touches console.* (log noise is not UI) and
//         except lines carrying a `zh-scan-ok` marker comment (with a reason),
//         and except lines marked `zh-scan-ok` before the string starts.
//         Regex literals are recognized (heuristic, like the parser's) so a
//         quote character inside /[']/ does not open a fake string.
//   HTML — CJK in text nodes / title|placeholder|aria-label|aria-description
//         attributes is a hit, unless the containing element carries
//         data-i18n* (fallback text replaced at runtime) or the line carries
//         `zh-scan-ok`.
//
// Allowlist (deliberate, keep short — each entry needs a reason):
//   public/i18n.js     — the dictionary itself
//   public/mirror.js   — deliberately bilingual (zh + en inline) sr-only mirror,
//                        written for AI agents / screen readers, not a single-locale UI
//   public/fonts.js    — 'Microsoft JhengHei' & friends are proper-noun font stack names
//   public/pose-lab.*  — internal camera-pose lab opened by hand; not linked from the
//                        product UI and not part of the shipped surface
//   extension/i18n.js  — the extension dictionary itself
//   */manifest*.json   — Chrome Web Store copy pinned by tests/tabs-ext-e2e.mjs (the
//                        action title / command description are asserted verbatim)
// Usage: node scripts/scan-hardcoded-zh.mjs [--verbose]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CJK = /[㐀-䶿一-鿿豈-﫿]/;   // .compat range must start at 豈 U+F900 — a lower start swallows the surrogate block and every emoji matches
const ALLOW_FILES = new Set([
  'public/i18n.js', 'public/mirror.js', 'public/fonts.js',
  'public/pose-lab.js', 'public/pose-lab.html',
  'extension/i18n.js'
]);
const VERBOSE = process.argv.includes('--verbose');

function list(dir, ext) {
  return fs.readdirSync(path.join(ROOT, dir))
    .filter(f => ext.includes(path.extname(f)))
    .map(f => dir + '/' + f)
    .filter(f => !ALLOW_FILES.has(f) && !/manifest.*\.json$/.test(f));
}

// ---------------------------------------------------------------- JS scanner
// Single pass over the source, tracking line/block comments, the three string
// forms and regex literals. Template ${…} nesting is balanced so `a${'中'}b`
// still reports both the outer template's CJK and the inner string.
function scanJs(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const lines = src.split('\n');
  const hits = [];
  let line = 1, i = 0;
  const n = src.length;
  let state = 'code';            // code | line | block | ' | " | ` | regex
  let strStart = 0, strLine = 0, strHasCJK = false;
  const tplDepth = [];           // brace depth stack for ${ } inside templates
  let braces = 0;
  let inClass = false;           // inside regex […] char class
  const flush = (end) => {
    if (strHasCJK) {
      const lineText = lines[strLine - 1] || '';
      if (!/console\.(log|warn|error|info|debug)/.test(lineText) && !/zh-scan-ok/.test(lineText)) {
        hits.push({ line: strLine, text: src.slice(strStart, end).replace(/\s+/g, ' ').slice(0, 80) });
      }
    }
  };
  // last significant code character (for the regex-vs-divide heuristic)
  let prevCh = '', prevWord = '';
  const isRegexCtx = () => {
    if (!prevCh) return true;
    if ('(,[{:;=!&|?+-*%^~<>'.includes(prevCh)) return true;
    if (prevWord && /^(return|typeof|case|in|of|new|delete|void|do|else|instanceof|yield|await)$/.test(prevWord)) return true;
    return false;
  };
  let wordBuf = '';
  while (i < n) {
    const c = src[i], nx = src[i + 1];
    if (c === '\n') line++;
    if (state === 'line') { if (c === '\n') state = 'code'; i++; continue; }
    if (state === 'block') { if (c === '*' && nx === '/') { state = 'code'; i += 2; } else i++; continue; }
    if (state === 'regex') {
      if (c === '\\') { i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { state = 'code'; prevCh = '/'; prevWord = ''; wordBuf = ''; }
      else if (c === '\n') { state = 'code'; }   // unterminated: bail to code
      i++; continue;
    }
    if (state === "'" || state === '"' || state === '`') {
      if (c === '\\') { i += 2; continue; }
      if (CJK.test(c)) strHasCJK = true;
      if (state === '`' && c === '$' && nx === '{') { tplDepth.push(braces); braces = 0; i += 2; continue; }
      if (state === '`' && c === '}' && tplDepth.length && braces === tplDepth[tplDepth.length - 1]) {
        tplDepth.pop(); braces = tplDepth.length ? tplDepth[tplDepth.length - 1] + 1 : 0; i++; continue;
      }
      if (c === state) { flush(i + 1); state = 'code'; prevCh = state; prevWord = ''; wordBuf = ''; i++; continue; }
      i++; continue;
    }
    // code
    if (c === '/' && nx === '/') { state = 'line'; i += 2; continue; }
    if (c === '/' && nx === '*') { state = 'block'; i += 2; continue; }
    if (c === '/' && isRegexCtx()) { state = 'regex'; inClass = false; i++; continue; }   // regex literal (division has an operand on the left)
    if (c === "'" || c === '"' || c === '`') {
      state = c; strStart = i; strLine = line; strHasCJK = false; braces = 0; i++; continue;
    }
    if (/[A-Za-z_$]/.test(c)) { wordBuf += c; if (c !== ' ') prevCh = c; i++; continue; }
    if (wordBuf) { prevWord = wordBuf; wordBuf = ''; }
    if (c === '{') braces++;
    else if (c === '}') braces = Math.max(0, braces - 1);
    if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') { prevCh = c; prevWord = ''; }
    i++;
  }
  return hits;
}

// ---------------------------------------------------------------- HTML scanner
// Strip comments/<style>/<script> in place (replace with spaces, keep length and
// newlines) so indexes into the stripped text stay valid line numbers in `src`.
function scanHtml(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const lines = src.split('\n');
  const blankKeepNL = m => m.replace(/[^\n]/g, ' ');
  const clean = src
    .replace(/<!--[\s\S]*?-->/g, blankKeepNL)
    .replace(/<style[\s\S]*?<\/style>/gi, blankKeepNL)
    .replace(/<script[\s\S]*?<\/script>/gi, blankKeepNL);
  const lineOf = p => { let n = 1; for (let k = 0; k < p; k++) if (src[k] === '\n') n++; return n; };
  const hits = [];
  let i = 0;
  // stack of open elements so `<li data-i18n>雙擊 <code>…</code>（或…）</li>` is
  // still recognized as runtime-replaced after the inner element closes
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const stack = [];
  // data-i18n / data-i18n-page / data-i18n-html all replace this element's CONTENT
  // at runtime → fallback copy inside is allowed; data-i18n-title/-ph/-label don't
  const contentI18n = /\bdata-i18n(=|\s|>|-page=|-html=)/;
  while (i < clean.length) {
    if (clean[i] === '<') {
      const end = clean.indexOf('>', i);
      if (end < 0) break;
      const tag = clean.slice(i, end + 1);
      const ln = lineOf(i);
      const allowMarked = /zh-scan-ok/.test(lines[ln - 1] || '');
      const hasI18nText = /\bdata-i18n(=|\s|>)/.test(tag);
      for (const m of tag.matchAll(/\b(title|placeholder|aria-label|aria-description)\s*=\s*"([^"]*)"/g)) {
        const attr = m[1], val = m[2];
        if (!CJK.test(val)) continue;
        const ok = hasI18nText || allowMarked ||
          (attr === 'title' && /\bdata-i18n-title\b/.test(tag)) ||
          (attr === 'aria-label' && /\bdata-i18n-label\b/.test(tag)) ||
          (attr === 'placeholder' && /\bdata-i18n-ph\b/.test(tag));
        if (!ok) hits.push({ line: ln, text: `${attr}="${val.slice(0, 60)}"` });
      }
      const mName = tag.match(/^<\/?\s*([a-zA-Z0-9-]+)/);
      const name = mName ? mName[1].toLowerCase() : '';
      if (tag.startsWith('</')) {
        for (let k = stack.length - 1; k >= 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      } else if (name && !VOID.has(name) && !/\/>$/.test(tag)) {
        stack.push({ name, hasI18n: contentI18n.test(tag) });
      }
      i = end + 1;
      continue;
    }
    const end = clean.indexOf('<', i);
    const seg = clean.slice(i, end < 0 ? clean.length : end);
    if (CJK.test(seg)) {
      const ln = lineOf(i);
      const lineText = lines[ln - 1] || '';
      // text inside an element (at any depth) whose opening tag carries
      // data-i18n/-page/-html is runtime-replaced fallback copy → allowed
      const tagHasI18n = stack.some(e => e.hasI18n);
      if (!tagHasI18n && !/zh-scan-ok/.test(lineText)) {
        hits.push({ line: ln, text: seg.trim().replace(/\s+/g, ' ').slice(0, 80) });
      }
    }
    i = end < 0 ? clean.length : end;
  }
  return hits;
}

// ---------------------------------------------------------------- run
let total = 0;
for (const rel of [...list('public', ['.js']), ...list('extension', ['.js'])]) {
  const hits = scanJs(rel);
  if (hits.length) {
    total += hits.length;
    console.log(`\n${rel} (${hits.length})`);
    for (const h of hits) console.log(`  ${h.line}: ${h.text}`);
  } else if (VERBOSE) console.log(`${rel}: clean`);
}
for (const rel of [...list('public', ['.html']), ...list('extension', ['.html'])]) {
  const hits = scanHtml(rel);
  if (hits.length) {
    total += hits.length;
    console.log(`\n${rel} (${hits.length})`);
    for (const h of hits) console.log(`  ${h.line}: ${h.text}`);
  } else if (VERBOSE) console.log(`${rel}: clean`);
}
console.log(total ? `\n${total} hardcoded Chinese UI string(s) found` : '\nscan clean: 0 hardcoded Chinese UI strings');
process.exit(total ? 1 : 0);
