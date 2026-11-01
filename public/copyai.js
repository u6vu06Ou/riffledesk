// copyai.js — build a compact "page for AI" payload: title, url, visible text, slimmed DOM.
// Pure functions only (no DOM required) so node can test them; the reader wires the button.

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;
const CJK_G = new RegExp(CJK.source, 'g');

// Rough token estimate: one per CJK char, one per 4 other chars (rounded up).
export function estimateTokens(str) {
  const s = String(str == null ? '' : str);
  if (!s) return 0;
  const cjk = (s.match(CJK_G) || []).length;
  const rest = s.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

const KEEP_ATTR = /^(id|class|href|src|alt|title|role|type|name|value|placeholder|aria-[a-z-]+)$/;

function slimTag(m) {
  // m = full tag text; keep the tag name and a whitespace-free attribute whitelist
  const mm = /^<([a-zA-Z][-\w:]*)([\s\S]*?)(\/?)>$/.exec(m);
  if (!mm) return m;
  const name = mm[1];
  const attrs = mm[2];
  const self = mm[3] || '';
  const kept = [];
  const re = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let a;
  while ((a = re.exec(attrs))) {
    const key = a[1].toLowerCase();
    if (!KEEP_ATTR.test(key)) continue;
    const val = a[2] != null ? a[2] : a[3] != null ? a[3] : a[4];
    kept.push(val == null ? key : key + '="' + val.replace(/"/g, '&quot;') + '"');
  }
  return '<' + name + (kept.length ? ' ' + kept.join(' ') : '') + self + '>';
}

// Strip what costs tokens and teaches an AI nothing: script/style bodies, comments,
// data-* and most attributes, whitespace runs. Pure string work — no DOM needed.
export function slimDom(html) {
  let s = String(html == null ? '' : html);
  if (!s) return '';
  const BLOCKS = 'script|style|noscript|template|svg';
  const block = new RegExp('<(' + BLOCKS + ')\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>', 'gi');
  const selfBlock = new RegExp('<(' + BLOCKS + ')\\b[^>]*\\/>', 'gi');
  for (let i = 0; i < 4; i++) {          // nested blocks only fall out one layer at a time
    const before = s;
    s = s.replace(block, '').replace(selfBlock, '').replace(/<!--[\s\S]*?-->/g, '');
    if (s === before) break;
  }
  s = s.replace(/<![^>]*>/g, '');
  s = s.replace(/<[^>]+>/g, slimTag);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// the section headings are the same in both languages (the format is fixed); only the
// truncation note follows the UI language
const NOTE = {
  zh: n => '（已截斷，原本約 ' + n + ' token）',   // zh-scan-ok: buildForAI output text, not a DOM attribute
  en: n => '(truncated, originally ~' + n + ' tokens)'
};

// longest prefix of `s` whose estimate stays within `budget` (per-piece counting is
// conservative, so joined pieces never exceed the budget)
function fitPrefix(s, budget) {
  if (budget <= 0 || !s) return '';
  if (estimateTokens(s) <= budget) return s;
  let lo = 0, hi = Math.min(s.length, budget * 4 + 1);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimateTokens(s.slice(0, mid)) <= budget) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo);
}

export function buildForAI(page, maxTokens) {
  const p = page || {};
  const lang = p.lang === 'en' ? 'en' : 'zh';
  const title = String(p.title || '').replace(/\s+/g, ' ').trim();
  const url = String(p.url || '').trim();
  const text = String(p.text || '').trim();
  const dom = slimDom(p.html);
  const limit = Math.max(1, Math.round(Number(maxTokens)) || 4000);

  const head = '# ' + (title || url || '') + (url ? '\n' + url : '') + '\n\n## 內文';   // zh-scan-ok: payload format, Chinese in both UI languages
  const domHead = '\n\n## DOM（精簡）\n```html\n';   // zh-scan-ok: payload format
  const domTail = '\n```';

  const render = (body, d) =>
    head + '\n' + body + (d ? domHead + d + domTail : '');

  const full = render(text, dom);
  const originalTokens = estimateTokens(full);
  if (originalTokens <= limit) {
    return { text: full, tokens: originalTokens, truncated: false, originalTokens };
  }

  // Over the limit: keep head, then body, then as much DOM tail as fits; note at the end.
  // The body is only cut when even a bare body would blow the budget — and then the DOM
  // still gets a quarter of the room, so the payload always has both sections.
  const note = '\n\n' + NOTE[lang](originalTokens);
  let budget = limit - estimateTokens(head) - estimateTokens(note);
  if (budget < 1) budget = 1;
  const bodyNeeds = estimateTokens(text);
  const domWrappers = dom ? estimateTokens(domHead + domTail) : 0;
  let domBudget = 0;
  if (dom && bodyNeeds > budget) domBudget = Math.floor(budget / 4);
  const bodyBudget = budget - domBudget;
  const body = fitPrefix(text, Math.max(0, bodyBudget - 1));
  budget -= estimateTokens(body) + (body ? 1 : 0);
  if (dom) domBudget = Math.max(domBudget, budget) - domWrappers;
  const kept = dom && domBudget > 0 ? fitPrefix(dom, domBudget) : '';

  const out = render(body, kept) + note;
  return { text: out, tokens: estimateTokens(out), truncated: true, originalTokens };
}

const KEY = 'rd.copyAiMax';
const DEFAULT_MAX = 4000;
const MIN_MAX = 500;
const MAX_MAX = 200000;

export function getMaxTokens() {
  try {
    const v = parseInt(localStorage.getItem(KEY), 10);
    if (Number.isFinite(v) && v >= MIN_MAX && v <= MAX_MAX) return v;
  } catch (_) { /* no storage: fall through to the default */ }
  return DEFAULT_MAX;
}

export function setMaxTokens(n) {
  const v = Math.round(Number(n));
  const clamped = Math.min(MAX_MAX, Math.max(MIN_MAX, Number.isFinite(v) ? v : DEFAULT_MAX));
  try { localStorage.setItem(KEY, String(clamped)); } catch (_) { /* ignore */ }
  return clamped;
}

export { DEFAULT_MAX as COPY_AI_DEFAULT_MAX, MIN_MAX as COPY_AI_MIN_MAX, MAX_MAX as COPY_AI_MAX_MAX, KEY as COPY_AI_KEY };
