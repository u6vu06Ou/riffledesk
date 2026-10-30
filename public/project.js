// project.js — push-to-open ("projection"): the AI CLI posts a file to /api/project,
// the server broadcasts a `project` SSE event, and every open tab reacts.
//
// Also holds the pile side (POST /api/pile): the AI hands over a whole shortlist and
// the tab must NOT take the screen over — it notifies, and the left column's pile
// section or the notification click is what switches the card stack.
//
// Rules (the user's spec):
//  - never steal the screen: no window.focus() unless the "always jump to the front"
//    setting is on; a foreground tab just follows the file.
//  - a background tab holds the file back, shows a system notification (needs the
//    permission to be granted once from ⚙), and opens it when the tab is focused again
//    (or when the notification itself is clicked).
//  - a burst within MERGE_MS collapses into ONE notification ("AI opened N files"),
//    one tag so a later burst replaces the earlier toast; the click opens the newest,
//    the rest land in the left column's "just projected" list.
//  - the chime is its own switch, synthesized with WebAudio (no asset) and throttled
//    to one beep per SOUND_GAP_MS; later notifications stay silent.
//  - settings + notification state persist per browser (localStorage, try/catch).
import { t } from './i18n.js';

const MERGE_MS = 3000;
const SOUND_GAP_MS = 10000;
const MAX_RECENT = 20;
const MAX_PENDING = 50;
const NOTIFY_KEY = 'riffleProjectNotify';
const SOUND_KEY = 'riffleProjectSound';
const FRONT_KEY = 'riffleProjectFront';

const lsGet = (k, dflt) => { try { const v = localStorage.getItem(k); return v === null ? dflt : v === '1'; } catch (_) { return dflt; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, '1') : localStorage.removeItem(k); } catch (_) {} };

let notifyOn = lsGet(NOTIFY_KEY, true);
let soundOn = lsGet(SOUND_KEY, false);
let frontOn = lsGet(FRONT_KEY, false);

let deps = null;                 // { openPath(path, line), openPile(pile) } — main.js owns the UI work
let pending = [];                // background-held projections (newest last)
let mergeTimer = null;
let lastBeep = 0;
let audioCtx = null;
let notif = null;                // last shown Notification (kept so a click keeps working)
let recent = [];                 // [{ path, name, line, source, at }] newest first
let piles = [];                  // [{ id, title, count, at }] newest first (left column)

// ------------------------------------------------------------------ settings API
export const settings = {
  notify: () => notifyOn,
  sound: () => soundOn,
  front: () => frontOn,
  setNotify(v) { notifyOn = !!v; lsSet(NOTIFY_KEY, notifyOn); },
  setSound(v) { soundOn = !!v; lsSet(SOUND_KEY, soundOn); },
  setFront(v) { frontOn = !!v; lsSet(FRONT_KEY, frontOn); },
  permission: () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission),
  async askPermission() {
    if (typeof Notification === 'undefined') return 'unsupported';
    try { return await Notification.requestPermission(); } catch (_) { return 'denied'; }
  }
};

// ------------------------------------------------------------------ chime
// An AudioContext created before any user gesture starts suspended, so the first
// projection would be silent. Any first pointer/key press unlocks it in advance.
function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) { /* no audio: the rest still works */ }
}
addEventListener('pointerdown', unlockAudio, { once: true });
addEventListener('keydown', unlockAudio, { once: true });

function beep() {
  if (!soundOn) return;
  const now = Date.now();
  if (now - lastBeep < SOUND_GAP_MS) return;
  lastBeep = now;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const at = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, at);
    osc.frequency.exponentialRampToValueAtTime(660, at + 0.12);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.12, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(at);
    osc.stop(at + 0.18);
  } catch (_) { /* audio is decoration */ }
}

// ------------------------------------------------------------------ left column list
let listEl = null;
function mountRecent() {
  const treeEl = document.getElementById('tree');
  if (!treeEl) return;
  if (!listEl) {
    listEl = document.createElement('div');
    listEl.id = 'projRecent';
  }
  // sits at the very top of the AI region: above the conversations block
  const anchor = document.getElementById('convos');
  if (anchor) { if (anchor.previousSibling !== listEl) treeEl.insertBefore(listEl, anchor); }
  else {
    const bar = document.getElementById('treeBar');
    if (listEl.previousSibling !== bar) treeEl.insertBefore(listEl, bar ? bar.nextSibling : treeEl.firstChild);
  }
  renderRecent();
}
function renderRecent() {
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!recent.length) return;
  const sec = document.createElement('div');
  sec.className = 'sec';
  sec.textContent = t('projSec');
  listEl.appendChild(sec);
  for (const r of recent) {
    const row = document.createElement('div');
    row.className = 'trow crow proj-row';
    row.title = r.source ? r.path + '  (' + r.source + ')' : r.path;
    const icon = document.createElement('span');
    icon.className = 'fico';
    icon.textContent = '📌';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = r.name + (r.line ? ':' + r.line : '');
    row.append(icon, nm);
    row.addEventListener('click', () => openPath(r.path, r.line));
    listEl.appendChild(row);
  }
}
function pushRecent(rec) {
  recent = [rec, ...recent.filter(r => r.path !== rec.path)].slice(0, MAX_RECENT);
  mountRecent();
}
// tree.boot() wipes the tree DOM; main calls this afterwards to put the list back.
export function restoreRecent() { if (listEl) mountRecent(); }

// ------------------------------------------------------------------ pile list
// "AI 整理的疊": the shortlists the AI handed over, newest first. Kept in the module
// (not localStorage) — it is small, and a reload refetches it from /api/piles.
let pileEl = null;
function mountPiles() {
  const treeEl = document.getElementById('tree');
  if (!treeEl) return;
  if (!pileEl) {
    pileEl = document.createElement('div');
    pileEl.id = 'projPiles';
  }
  // right after the "just projected" list, above the conversations block
  const convos = document.getElementById('convos');
  const anchor = convos || document.getElementById('treeBar');
  if (anchor && pileEl.previousSibling !== anchor.previousSibling) {
    treeEl.insertBefore(pileEl, anchor);
  }
  renderPiles();
}
function fmtPileTime(at) {
  const d = new Date(at || 0);
  const p2 = n => String(n).padStart(2, '0');
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
}
function renderPiles() {
  if (!pileEl) return;
  pileEl.innerHTML = '';
  if (!piles.length) return;
  const sec = document.createElement('div');
  sec.className = 'sec';
  sec.textContent = t('pileSec');
  pileEl.appendChild(sec);
  for (const p of piles) {
    const row = document.createElement('div');
    row.className = 'trow crow pile-row';
    row.title = p.title;
    row.dataset.pile = p.id;
    const icon = document.createElement('span');
    icon.className = 'fico';
    icon.textContent = '🗂';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.title;
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = String(p.count);
    const when = document.createElement('span');
    when.className = 'pile-when';
    when.textContent = fmtPileTime(p.at);
    row.append(icon, nm, cnt, when);
    row.addEventListener('click', () => openPile(p.id, row));
    if (deps && deps.attachPileRow) deps.attachPileRow(row, p.id);
    pileEl.appendChild(row);
  }
}
function pushPile(rec) {
  piles = [rec, ...piles.filter(p => p.id !== rec.id)].slice(0, MAX_RECENT);
  mountPiles();
}
export function restorePiles() { if (pileEl) mountPiles(); }

async function fetchPiles() {
  try {
    const r = await fetch('/api/piles', { cache: 'no-store' });
    const d = await r.json();
    if (d && d.ok && Array.isArray(d.piles)) {
      piles = d.piles.slice(0, MAX_RECENT).map(p => ({ id: p.id, title: p.title, count: p.count, at: p.createdAt }));
      mountPiles();
    }
  } catch (_) { /* the list is a convenience; the push path still works */ }
}

// A pile row / notification click: main.js loads it into the card stack.
async function openPile(id, row) {
  if (!deps) return false;
  return (await deps.openPile(id, row || null)) === true;
}

// ------------------------------------------------------------------ opening
// Resolves true when the file opened, false when it could not (the caller shows its own
// message if it wants one).
async function openPath(path, line) {
  if (!deps) return false;
  return (await deps.openPath(path, line)) === true;
}

// A projection that arrived as a URL (?open=…&line=N): the CLI opens such a page when no
// tab is connected. It goes into the recent list like any other projection, but it always
// opens right away — a page the user asked for must not be held back as if the tab were
// merely in the background. Several can queue up (a slow open must not abandon the next).
const urlQueue = [];               // [{ path, line, resolve }] waiting for deps / the previous one
let urlBusy = false;
export function requestUrlOpen(path, line) {
  return new Promise(resolve => {
    urlQueue.push({ path, line, resolve });
    drainUrlQueue();
  });
}
function drainUrlQueue() {
  if (urlBusy || !deps) return;
  const r = urlQueue.shift();
  if (!r) return;
  urlBusy = true;
  const rec = {
    path: r.path,
    name: String(r.path).split(/[\\/]/).pop(),
    line: Number.isFinite(r.line) && r.line > 0 ? Math.floor(r.line) : null,
    source: 'url',
    at: Date.now()
  };
  Promise.resolve()
    .then(() => openPath(rec.path, rec.line))
    .catch(() => false)
    .then(opened => {
      if (opened) pushRecent(rec);   // a dead path leaves no dead row behind
      r.resolve(opened);
      urlBusy = false;
      drainUrlQueue();
    });   // errors surface as `false`, never as an unhandled rejection
}

function pageVisible() {
  if (hiddenForTest !== null) return !hiddenForTest;
  return document.visibilityState === 'visible';
}
let hiddenForTest = null;
// e2e hook: background/foreground is unreliable in headless Chrome (a second tab may
// not change visibilityState), so the test drives it explicitly.
export function setHiddenForTest(v) {
  hiddenForTest = !!v;
  if (!hiddenForTest) onForeground();
}

// ------------------------------------------------------------------ notification
// The system toast has one short line of body space: show "parent/file.md" (or
// "file.md:12" when a line was requested) instead of the whole path. The full path
// still lives in the opened reader, and the left-column row's title keeps it too.
export function notifBody(rec) {
  const segs = String(rec.path || '').split(/[\\/]+/).filter(Boolean);
  const name = segs[segs.length - 1] || rec.name || String(rec.path || '');
  const parent = segs.slice(-2, -1)[0];
  const short = parent ? parent + '/' + name : name;
  return rec.line != null ? short + ':' + rec.line : short;
}

function showNotification() {
  if (pageVisible()) return;                               // foreground: no toast shadowing the file
  if (!notifyOn) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const n = pending.length;
  const last = pending[pending.length - 1];
  const title = n > 1 ? t('projNotifMany', { n }) : t('projNotifOne', { name: last.name });
  const body = notifBody(last);
  try {
    if (notif) { try { notif.close(); } catch (_) {} }
    notif = new Notification(title, { body, tag: 'riffle-project', renotify: true, silent: true });
    notif.onclick = () => {
      try { window.focus(); } catch (_) {}
      if (deps && pending.length) {
        const top = pending[pending.length - 1];
        pending = [];
        openPath(top.path, top.line);
      }
      try { notif.close(); } catch (_) {}
      notif = null;
    };
  } catch (_) { /* notification constructor can throw on some platforms */ }
}

// ------------------------------------------------------------------ merge window
function scheduleFlush() {
  clearTimeout(mergeTimer);
  mergeTimer = setTimeout(() => {
    mergeTimer = null;
    if (!pending.length) return;
    showNotification();
    beep();                       // throttled inside
  }, MERGE_MS);
}

function onForeground() {
  clearTimeout(mergeTimer);
  mergeTimer = null;
  if (pilePending) {
    // a pile waited in the background: greet with the in-page toast, still no auto-switch
    showPileNotification();
    pilePending = null;
  }
  if (!pending.length) return;
  const last = pending[pending.length - 1];
  pending = [];
  if (notif) { try { notif.close(); } catch (_) {} notif = null; }
  openPath(last.path, last.line);
}

// ------------------------------------------------------------------ event entry point
export function handleProject(data) {
  // the broadcast channel is not the server: validate the shape here too
  if (!data || typeof data.path !== 'string' || !data.path) return;
  const rec = {
    path: data.path,
    name: String(data.path).split(/[\\/]/).pop(),
    line: Number.isFinite(data.line) && data.line > 0 ? Math.floor(data.line) : null,
    source: data.source || null,
    at: data.at || Date.now()
  };
  pushRecent(rec);
  if (pageVisible()) {
    pending = [];
    clearTimeout(mergeTimer); mergeTimer = null;
    if (frontOn) { try { window.focus(); } catch (_) {} }
    openPath(rec.path, rec.line);
    return;
  }
  pending.push(rec);
  if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
  scheduleFlush();
}

document.addEventListener('visibilitychange', () => {
  if (pageVisible()) onForeground();
});

// ------------------------------------------------------------------ pile events
// A pile never opens itself, not even in a foreground tab: it is a shortlist the user
// decides to look at. It gets the same toast/merge/chime treatment as a projection,
// plus a row in the left column.
let pilePending = null;          // { id, title, count, at } — newest pile not yet shown
function showPileNotification() {
  if (!notifyOn) return;
  if (!pageVisible()) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  }
  const p = pilePending;
  if (!p) return;
  const title = t('pileNotif', { n: p.count });
  const body = p.title;
  if (!pageVisible()) {
    try {
      if (notif) { try { notif.close(); } catch (_) {} }
      notif = new Notification(title, { body, tag: 'riffle-pile', renotify: true, silent: true });
      notif.onclick = () => {
        try { window.focus(); } catch (_) {}
        const cur = pilePending;
        pilePending = null;
        if (cur) openPile(cur.id, null);
        try { notif.close(); } catch (_) {}
        notif = null;
      };
      return;
    } catch (_) { /* fall through to the in-page toast */ }
  }
  // foreground: a quiet in-page toast (same words), clicking it switches the stack
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = `${title} — ${body}`;
  el.classList.remove('act');
  const a = document.createElement('a');
  a.textContent = t('pileOpen');
  a.href = '#';
  a.addEventListener('click', e => {
    e.preventDefault();
    el.classList.remove('on');
    const cur = pilePending;
    pilePending = null;
    if (cur) openPile(cur.id, null);
  });
  el.classList.add('act', 'on');
  el.appendChild(a);
}

export function handlePile(data) {
  if (!data || typeof data.id !== 'string' || !data.id) return;
  const rec = {
    id: data.id,
    title: typeof data.title === 'string' && data.title ? data.title : t('pileNoTitle'),
    count: Number(data.count) || 0,
    at: data.at || Date.now()
  };
  pushPile(rec);
  pilePending = rec;
  // reuse the projection merge window: a burst of piles collapses into one notice
  scheduleFlushPile();
}

function scheduleFlushPile() {
  clearTimeout(mergeTimer);
  mergeTimer = setTimeout(() => {
    mergeTimer = null;
    showPileNotification();
    beep();                       // throttled inside
  }, MERGE_MS);
}

// e2e hook: click the live notification the way a user would
export function clickPileToast() {
  const el = document.getElementById('toast');
  const a = el && el.querySelector('a');
  if (a) { a.click(); return true; }
  return false;
}

// ------------------------------------------------------------------ settings wiring (⚙)
export function initProjectSettings() {
  const cbNotify = document.getElementById('projNotify');
  const cbSound = document.getElementById('projSound');
  const cbFront = document.getElementById('projFront');
  const btnPerm = document.getElementById('projPerm');
  const note = document.getElementById('projPermNote');

  const syncPerm = () => {
    const p = settings.permission();
    if (!btnPerm || !note) return;
    btnPerm.disabled = p === 'granted' || p === 'unsupported';
    note.textContent = p === 'granted' ? t('projPermGranted')
      : p === 'unsupported' ? t('projPermUnsupported')
      : p === 'denied' ? t('projPermDenied') : t('projPermAsk');
  };

  if (cbNotify) {
    cbNotify.checked = notifyOn;
    cbNotify.addEventListener('change', () => {
      settings.setNotify(cbNotify.checked);
      if (cbNotify.checked && settings.permission() === 'default') {
        settings.askPermission().then(syncPerm);
      }
    });
  }
  if (cbSound) {
    cbSound.checked = soundOn;
    cbSound.addEventListener('change', () => {
      settings.setSound(cbSound.checked);
      if (cbSound.checked) { lastBeep = 0; beep(); }      // audible confirmation
    });
  }
  if (cbFront) {
    cbFront.checked = frontOn;
    cbFront.addEventListener('change', () => settings.setFront(cbFront.checked));
  }
  if (btnPerm) {
    btnPerm.addEventListener('click', async () => {
      await settings.askPermission();
      syncPerm();
    });
  }
  syncPerm();
}

// e2e hook: click the live notification the way a user would
export function clickNotification() {
  if (notif && notif.onclick) notif.onclick();
  return !!notif;
}

export function initProject(d) {
  deps = d;
  mountRecent();
  fetchPiles();         // the latest shortlists from earlier sessions
  drainUrlQueue();      // a ?open= URL that asked before the UI was wired up
}
