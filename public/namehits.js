// namehits.js — the "other places" panel under the search box.
//
// Why: the box filters only the folder on screen. Someone looking at folder A
// typed the name of a file in folder B, saw nothing, and concluded the file did
// not exist. While typing we therefore ALSO ask /api/names (index-wide name
// match) and list up to 20 hits from other folders. Local filtering is left
// exactly as it was — this panel never removes or reorders a card.
//
// Rules:
//  - debounce ~150 ms, min 2 chars; every keystroke aborts the previous fetch
//    (typing must never queue up behind a slow query)
//  - files already visible in the current view are dropped (no duplicates)
//  - ↑/↓ move, Enter opens the highlighted one, Esc closes — while the panel is
//    open those keys belong to it (main.js asks keydown() first and returns)
//  - plain Enter with nothing highlighted falls through to the old behaviour
//    (content search)
import { t } from './i18n.js';
import { fmtDate } from './util.js';

const DEBOUNCE_MS = 150;
const MIN_CHARS = 2;
const LIMIT = 20;

let deps = null;      // { box, openPath(path), getVisible(): Set<norm path> }
let el = null;
let items = [];
let sel = -1;
let timer = null;
let ctrl = null;
let seq = 0;
let exts = '';        // 目前類型篩選（',.md,.html'）；空字串＝全部

const normPath = p => String(p).replace(/[/\\]+$/, '').toLowerCase();

export function initNameHits(d) {
  deps = d;
  el = document.getElementById('nameHits');
  if (!el) return;
  // #toolbar 有 backdrop-filter，fixed 子元素會被它變成「相對工具列」並裁在它的框裡；
  // 掛到 body 底下才是真正相對視窗的浮層。
  document.body.appendChild(el);
  el.addEventListener('mousedown', e => {
    // mousedown (not click): the search box would blur first and close us
    const row = e.target.closest('.nh-row');
    if (!row) return;
    e.preventDefault();
    pick(Number(row.dataset.i));
  });
  addEventListener('resize', place);
  addEventListener('scroll', place, true);
  document.addEventListener('mousedown', e => {
    if (e.target === deps.box || el.contains(e.target)) return;
    close();
  });
}

function place() {
  if (!el || el.hidden) return;
  const r = deps.box.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8)) + 'px';
  el.style.top = (r.bottom + 4) + 'px';
}

export function isOpen() { return !!el && !el.hidden; }

function close() {
  clearTimeout(timer);
  timer = null;
  if (ctrl) { ctrl.abort(); ctrl = null; }
  if (!el || el.hidden) return;
  el.hidden = true;
  el.textContent = '';
  items = [];
  sel = -1;
}

function header() {
  const h = document.createElement('div');
  h.className = 'nh-head';
  const labels = exts === 'readable' ? [t('chipReadable')]
    : exts.split(',').filter(Boolean);
  h.textContent = labels.length ? t('nameOtherType', { exts: labels.join(' ') }) : t('nameOther');
  if (labels.length) h.title = t('nameOtherTypeTitle');
  return h;
}

// 類型篩選改了：面板開著就照新條件重跑，關著就等下次輸入
export function setExts(v) {
  // 「全部」＝完全不帶條件（不帶 exts 參數）
  const next = v === 'all' || !v ? '' : String(v);
  if (next === exts) return;
  exts = next;
  if (!isOpen()) return;
  const q = deps.box.value.trim().toLowerCase();
  if (q.length < MIN_CHARS) return close();
  clearTimeout(timer);
  timer = setTimeout(() => query(q), DEBOUNCE_MS);
}

function row(f, i) {
  const q = deps.box.value.trim().toLowerCase();
  const d = document.createElement('div');
  d.className = 'nh-row' + (i === sel ? ' sel' : '');
  d.dataset.i = String(i);
  d.setAttribute('role', 'option');
  d.setAttribute('aria-selected', i === sel ? 'true' : 'false');
  const name = document.createElement('span');
  name.className = 'nh-name';
  const at = f.name.toLowerCase().indexOf(q);
  if (at < 0) name.textContent = f.name;
  else {
    name.append(f.name.slice(0, at));
    const b = document.createElement('b');
    b.textContent = f.name.slice(at, at + q.length);
    name.append(b, f.name.slice(at + q.length));
  }
  const sub = document.createElement('span');
  sub.className = 'nh-sub';
  const dir = document.createElement('span');
  dir.className = 'nh-dir';
  // 路徑從左邊截：尾巴（真正的資料夾名）比磁碟機代號有用
  dir.textContent = f.dir.length > 46 ? '…' + f.dir.slice(-45) : f.dir;
  dir.title = f.dir;
  const date = document.createElement('span');
  date.className = 'nh-date';
  date.textContent = fmtDate(f.mtime);
  sub.append(dir, date);
  d.title = f.path;
  d.append(name, sub);
  // an agent handed this one over (pile / recent projection) — the files people hunt for
  if (f.delivered) {
    const tag = document.createElement('span');
    tag.className = 'nh-deliv';
    tag.textContent = t('nameDelivered');
    name.append(' ', tag);
  }
  return d;
}

function render() {
  el.hidden = false;
  el.textContent = '';
  if (!items.length) {
    const h = header();
    const none = document.createElement('div');
    none.className = 'nh-head';
    none.textContent = t('nameNone');
    el.append(h, none);
    place();
    return;
  }
  el.append(header());
  items.forEach((f, i) => el.appendChild(row(f, i)));
  place();
}

async function query(q) {
  const my = ++seq;
  if (ctrl) ctrl.abort();
  ctrl = new AbortController();
  let d;
  try {
    const r = await fetch('/api/names?q=' + encodeURIComponent(q) + '&limit=' + LIMIT +
      (exts ? '&exts=' + encodeURIComponent(exts) : ''), { signal: ctrl.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    d = await r.json();
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    d = null;
  }
  if (my !== seq) return;                                  // a newer keystroke won
  if (deps.box.value.trim().toLowerCase() !== q) return;
  if (!d || !d.ok || !Array.isArray(d.files)) { close(); return; }
  const visible = deps.getVisible ? deps.getVisible() : new Set();
  items = d.files.filter(f => !visible.has(normPath(f.path))).slice(0, LIMIT);
  sel = items.length ? 0 : -1;
  render();
}

export function onQuery(raw) {
  const q = String(raw || '').trim();
  if (q.length < MIN_CHARS) return close();
  clearTimeout(timer);
  timer = setTimeout(() => query(q.toLowerCase()), DEBOUNCE_MS);
}

function pick(i) {
  const f = items[i];
  if (!f) return;
  close();
  deps.openPath(f.path);
}

// true = the key was consumed by the panel (main.js must not handle it)
export function keydown(e) {
  if (!isOpen()) return false;
  if (e.key === 'ArrowDown') {
    sel = items.length ? (sel + 1) % items.length : -1;
    render();
    return true;
  }
  if (e.key === 'ArrowUp') {
    sel = items.length ? (sel <= 0 ? items.length - 1 : sel - 1) : -1;
    render();
    return true;
  }
  if (e.key === 'Escape') { close(); return true; }
  if (e.key === 'Enter') {
    // nothing highlighted → keep the old Enter (content search), just get out of the way
    if (sel >= 0) pick(sel); else close();
    return sel >= 0;
  }
  return false;
}
