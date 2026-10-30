// live.js — Server-Sent Events (/api/events) glue for the UI:
//  1. dir events on the open folder → a small pill over the card stack
//     ("N new files — click to load"); clicking reloads, nothing moves on its own.
//  2. convos events → refresh the AI conversation counts; in a conversation
//     pseudo-folder the same pill appears.
//  3. manual refresh: toolbar ⟳ button and the R key.
//  4. ⚙ settings: full-text index (content layer) on/off switch + note line.
// main.js passes everything this module needs via initLive(deps).
import { t } from './i18n.js';
import { apiJson, fmtSize } from './util.js';
import { handleProject, handlePile } from './project.js';

let deps = null;
let es = null;               // current EventSource
let watchPath = '';          // path the current stream is attached to (raw form)
const norm = p => String(p || '').replace(/[/\\]+$/, '').toLowerCase();

// pending pill state: names seen added/removed since the last reload
const addedSet = new Set();
const removedSet = new Set();
let convoDirty = false;
let ignoreUntil = 0;         // grace window after our own reload (server events race it)

function initPill() {
  const pill = document.createElement('button');
  pill.id = 'livePill';
  pill.style.display = 'none';
  document.body.appendChild(pill);
  pill.addEventListener('click', () => { resetPill(); deps.reload(); });
  return pill;
}
let pillEl = null;

let placer = null;
function placePill() {
  if (!pillEl) return;
  const v = deps.stack.viewCss;                 // follow the card-stack viewport
  pillEl.style.left = Math.round(v.x + v.w / 2) + 'px';
}
function showPill() {
  if (!pillEl) pillEl = initPill();
  if (!convoDirty && !addedSet.size && !removedSet.size) { hidePill(); return; } // e.g. rename then undo: nets out to nothing
  if (convoDirty && !addedSet.size && !removedSet.size) {
    pillEl.textContent = t('liveConvo');
  } else if (addedSet.size && removedSet.size) {
    pillEl.textContent = t('liveMixed', { a: addedSet.size, r: removedSet.size });
  } else if (addedSet.size) {
    pillEl.textContent = t('liveAdded', { n: addedSet.size });
  } else {
    pillEl.textContent = t('liveRemoved', { n: removedSet.size });
  }
  pillEl.style.display = '';
  placePill();
  if (!placer) placer = setInterval(placePill, 250);   // layout animates: keep up, cheaply
}
function hidePill() {
  if (pillEl) pillEl.style.display = 'none';
  if (placer) { clearInterval(placer); placer = null; }
}
function resetPill() {
  addedSet.clear(); removedSet.clear(); convoDirty = false;
  ignoreUntil = Date.now() + 1500;
  hidePill();
}

// --------------------------------------------------------------- event stream
function openStream(path) {
  if (es) { try { es.close(); } catch (_) {} es = null; }
  watchPath = path || '';
  const qs = watchPath ? '?path=' + encodeURIComponent(watchPath) : '';
  try { es = new EventSource('/api/events' + qs); } catch (_) { es = null; return; }
  es.addEventListener('dir', ev => {
    if (Date.now() < ignoreUntil) return;
    let d;
    try { d = JSON.parse(ev.data); } catch (_) { return; }
    if (norm(d.path) !== norm(watchPath) || norm(d.path) !== norm(deps.currentTarget())) return;
    for (const n of d.added || []) { if (!removedSet.delete(n)) addedSet.add(n); }
    for (const n of d.removed || []) { if (!addedSet.delete(n)) removedSet.add(n); }
    showPill();
  });
  es.addEventListener('convos', () => {
    deps.refreshConvos();
    if (deps.isPseudo()) { convoDirty = true; showPill(); }
  });
  // an AI CLI pushed a file (POST /api/project) → the projection module decides
  // between "open now" and a held-back notification
  es.addEventListener('project', ev => {
    let d;
    try { d = JSON.parse(ev.data); } catch (_) { return; }
    handleProject(d);
  });
  // an AI CLI handed over a shortlist (POST /api/pile) → notify only, never switch
  es.addEventListener('pile', ev => {
    let d;
    try { d = JSON.parse(ev.data); } catch (_) { return; }
    handlePile(d);
  });
  // EventSource reconnects by itself on drops; onerror is silently ignored.
}

// folder changes are noticed by polling the funnel (lockedFolder / convoState) —
// main.js reloads through its own paths (lock / hover-preview / pseudo), and any
// of the call sites changing the target would each need a hook instead.
let lastTarget = undefined;
setInterval(() => {
  if (!deps) return;   // main.js 動態載入卡堆期間還沒 initLive：沒目標可看，直接跳過
  const cur = norm(deps.currentTarget());
  if (cur === lastTarget) return;
  if (lastTarget === undefined) { lastTarget = cur; openStream(deps.currentTarget()); return; }
  lastTarget = cur;
  resetPill();
  openStream(deps.currentTarget());
}, 800);

// ------------------------------------------------------------------- refresh
function manualRefresh() {
  resetPill();
  deps.reload();
  deps.refreshTree();
  deps.refreshConvos();
}

function initRefreshControls() {
  const btn = document.getElementById('btnRefresh');
  if (btn) btn.addEventListener('click', manualRefresh);
  addEventListener('keydown', e => {
    if (e.key !== 'r' && e.key !== 'R') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;   // Ctrl+R stays the browser reload
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    manualRefresh();
  });
}

// ------------------------------------------------ settings: full-text index
const idxToggle = () => document.getElementById('idxContent');
const idxNoteEl = () => document.getElementById('idxNote');
let idxBusy = false;

async function refreshIndexStatus() {
  const tg = idxToggle(), note = idxNoteEl();
  if (!tg || !note) return;
  try {
    const d = await apiJson('/api/index/status');
    if (!d.available) {
      tg.checked = false; tg.disabled = true;
      note.textContent = t('idxNoteUnavailable');
      return;
    }
    tg.disabled = idxBusy;
    tg.checked = d.contentEnabled !== false;
    note.textContent = tg.checked
      ? t('idxNoteOn', { size: d.dbBytes != null ? fmtSize(d.dbBytes) : '—' })
      : t('idxNoteOff');
  } catch (e) {
    tg.disabled = true;
    note.textContent = t('idxNoteFail', { msg: e.message });
  }
}

async function toggleIndex() {
  const tg = idxToggle(), note = idxNoteEl();
  if (!tg || idxBusy) return;
  const want = tg.checked;
  idxBusy = true; tg.disabled = true;
  if (note) note.textContent = t('idxNoteBusy');
  try {
    await apiJson('/api/index/content', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: want })
    });
  } catch (e) {
    if (note) note.textContent = t('idxNoteFail', { msg: e.message });
    tg.checked = !want;                             // revert the switch on failure
  }
  idxBusy = false;
  await refreshIndexStatus();
}

function initIndexSwitch() {
  const tg = idxToggle();
  if (tg) tg.addEventListener('change', toggleIndex);
  const btnSettings = document.getElementById('btnSettings');
  if (btnSettings) btnSettings.addEventListener('click', () => {
    // main.js's own listener (registered first) just toggled the panel open
    if (document.getElementById('settings').classList.contains('on')) refreshIndexStatus();
  });
}

export function initLive(d) {
  deps = d;
  initRefreshControls();
  initIndexSwitch();
  // stream opens on the first target poll (~0.8 s) once the folder is known
}
