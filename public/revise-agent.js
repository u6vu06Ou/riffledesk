// revise-agent.js — runs INSIDE the sandboxed reader iframe during "✎ 改版" mode.
//
// The iframe is an opaque origin (sandbox without allow-same-origin), so this agent
// cannot use /api/* and cannot touch the parent document. Everything travels by
// postMessage; the parent verifies event.source and owns saving.
//
// The server injects this script into the served HTML, right before </body>, only
// for tokens minted with revise=1 (this file is on that token's allowlist). Page
// scripts are stripped unless the user ticked "▶ run page scripts", so by default
// nothing here can fight with the page's own JS.
//
// THIS FILE IS THE SOURCE OF TRUTH for the change list: it owns the numbering, the
// badges/marks and the undo stack, and mirrors its state to the parent after every
// mutation. The parent renders that state and can ask for `remove(n)`.
//
// Loaded as a CLASSIC script on purpose: `document.currentScript.src` gives the
// /raw/<token>/… base (kept for future asset needs; the screenshot is self-painted).
(function () {
  'use strict';
  const MY_SRC = (document.currentScript && document.currentScript.src) || '';
  const BASE = MY_SRC ? MY_SRC.slice(0, MY_SRC.lastIndexOf('/') + 1) : '';
  const UI = 'data-rd-ui';
  const NUM = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
  const numLabel = n => (n <= NUM.length ? NUM[n - 1] : '(' + n + ')');
  let L = {};             // labels pushed by the parent
  let items = [];         // [{ n, op, el, rdId, selector, textHint, before, after, note, rect, dx, dy, w, h, badge, mark, undo }]
  let sel = null;         // { el, editing }
  let regionMode = false;
  let lastPointer = { x: 0, y: 0 };

  // ---------------------------------------------------------------- styles
  const css = document.createElement('style');
  css.textContent = `
    .rd-hover { outline: 2px dashed #3ba55d !important; outline-offset: 1px !important; cursor: pointer !important; }
    .rd-sel { outline: 2px solid #3ba55d !important; outline-offset: 1px !important; }
    .rd-deleted { opacity: .35 !important; text-decoration: line-through !important; }
    .rd-edit { outline: 2px solid #e8a33d !important; cursor: text !important; }
    .rd-badge { position: absolute; z-index: 2147483000; min-width: 20px; height: 20px; padding: 0 4px;
      border-radius: 10px; background: #d93f3f; color: #fff; font: 700 12px/20px system-ui, sans-serif;
      text-align: center; box-shadow: 0 1px 4px #0006; pointer-events: none; box-sizing: border-box; }
    .rd-mark { position: absolute; z-index: 2147482990; pointer-events: none; border-radius: 3px; box-sizing: border-box; }
    .rd-mark.note { width: 12px; height: 12px; background: #e8a33d; border: 1px solid #7a5300; transform: rotate(45deg); }
    .rd-mark.region { border: 2px solid #d93f3f; background: #d93f3f14; }
    .rd-flash { position: absolute; z-index: 2147482980; pointer-events: none; border: 1px solid #3ba55d; background: #3ba55d22; }
    #rd-tb { position: absolute; z-index: 2147483200; display: none; gap: 2px; padding: 3px; border-radius: 7px;
      background: #22262c; border: 1px solid #4a5058; box-shadow: 0 4px 14px #0007; font: 13px system-ui, sans-serif; box-sizing: border-box; }
    #rd-tb button { border: 0; background: #333941; color: #e8e3d9; border-radius: 5px; padding: 2px 7px;
      height: 26px; cursor: pointer; white-space: nowrap; font: 13px system-ui, sans-serif; }
    #rd-tb button:hover { background: #3ba55d; color: #fff; }
    #rd-tb button.danger:hover { background: #d93f3f; }
    #rd-note { position: absolute; z-index: 2147483100; display: none; width: 220px; box-sizing: border-box; }
    #rd-note textarea { width: 100%; box-sizing: border-box; height: 64px; resize: vertical; border-radius: 7px;
      border: 1px solid #4a5058; background: #22262c; color: #e8e3d9; font: 12px/1.45 system-ui, sans-serif;
      padding: 5px 7px; outline: none; }
    #rd-note .row { display: flex; gap: 4px; margin-top: 3px; }
    #rd-note button { border: 0; border-radius: 5px; padding: 3px 9px; background: #3ba55d; color: #fff;
      font: 12px system-ui, sans-serif; cursor: pointer; }
    #rd-note button.sec { background: #444b54; color: #e8e3d9; }
    #rd-hint { position: fixed; z-index: 2147483300; left: 50%; bottom: 14px; transform: translateX(-50%);
      display: none; padding: 6px 14px; border-radius: 999px; background: #22262ce6; color: #e8e3d9;
      font: 12px system-ui, sans-serif; pointer-events: none; white-space: nowrap; }
    body.rd-region, body.rd-region * { cursor: crosshair !important; user-select: none !important; }
  `;
  (document.head || document.documentElement).appendChild(css);

  // ---------------------------------------------------------------- parent link
  const post = (type, data) => parent.postMessage({ rd: 1, type, ...(data || {}) }, '*');
  const mirror = () => post('state', { items: items.map(publicItem) });
  function publicItem(it) {
    return { n: it.n, op: it.op, rdId: it.rdId, selector: it.selector, textHint: it.textHint,
      before: it.before, after: it.after, note: it.note, rect: it.rect, dx: it.dx, dy: it.dy, w: it.w, h: it.h };
  }

  addEventListener('message', e => {
    if (e.source !== parent) return;
    const d = e.data;
    if (!d || d.rd !== 1) return;
    if (d.type === 'init') { L = d.labels || {}; buildToolbar(); }
    else if (d.type === 'undo') undo();
    else if (d.type === 'remove') removeItem(d.n);
    else if (d.type === 'update-note') updateNote(d.n, d.note);
    else if (d.type === 'region') enableRegion(true);
    else if (d.type === 'screenshot') takeShot(d.id);
    else if (d.type === 'deselect') deselect();
  });

  // ---------------------------------------------------------------- element identity
  function esc(s) { return String(s).replace(/["\\]/g, '\\$&'); }
  function selectorFor(el) {
    if (el.dataset && el.dataset.rdId) return { rdId: el.dataset.rdId, selector: '[data-rd-id="' + esc(el.dataset.rdId) + '"]' };
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const tag = n.tagName.toLowerCase();
      let i = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      parts.unshift(tag + ':nth-of-type(' + i + ')');
      if (parts.length > 12) break;
    }
    return { rdId: null, selector: parts.join(' > ') };
  }
  const hintFor = el => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) || null;
  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  }

  // ---------------------------------------------------------------- selection
  let hoverEl = null;
  const isUi = el => !!(el && el.closest && el.closest('[' + UI + ']'));

  document.addEventListener('mouseover', e => {
    if (regionMode) return;
    const el = e.target;
    if (!el || el.nodeType !== 1 || isUi(el) || el === document.body || el === document.documentElement) return;
    if (hoverEl) hoverEl.classList.remove('rd-hover');
    hoverEl = el;
    if (!(sel && sel.el === el)) el.classList.add('rd-hover');
  }, true);

  document.addEventListener('click', e => {
    if (regionMode) return;
    if (swallowClick) { swallowClick = false; return; }
    if (isUi(e.target)) return;
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    if (sel && sel.editing) return;   // the inline editor owns its own clicks
    if (el === document.body || el === document.documentElement) { deselect(); return; }
    e.preventDefault();
    e.stopPropagation();
    select(el);
  }, true);

  function select(el) {
    if (hoverEl) { hoverEl.classList.remove('rd-hover'); hoverEl = null; }
    if (sel && sel.el === el) { showToolbar(); return; }
    deselect(true);
    el.classList.add('rd-sel');
    sel = { el, editing: false };
    showToolbar();
    const s = selectorFor(el);
    post('select', { info: { rdId: s.rdId, selector: s.selector, textHint: hintFor(el), tag: el.tagName.toLowerCase() } });
  }

  function deselect(keepSel) {
    if (sel && sel.el) {
      sel.el.classList.remove('rd-sel', 'rd-edit');
      sel.el.removeAttribute('contenteditable');
      sel.el.removeAttribute('spellcheck');
    }
    sel = null;
    hideToolbar();
    hideNote();
    if (!keepSel) post('deselect');
  }

  // ---------------------------------------------------------------- toolbar
  let tb = null, tbBuilt = false;
  function buildToolbar() {
    if (tbBuilt) return;
    tbBuilt = true;
    tb = document.createElement('div');
    tb.id = 'rd-tb';
    tb.setAttribute(UI, '');
    const mk = (label, title, fn, cls) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title || label;
      if (cls) b.className = cls;
      b.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); fn(); });
      tb.appendChild(b);
    };
    mk('✎', L.text, startText);
    mk('✥', L.move, startDrag);
    mk('⤡', L.resize, startResize);
    mk('🗑', L.del, markDeleted, 'danger');
    mk('📝', L.note, startNote);
    const hint = document.createElement('div');
    hint.id = 'rd-hint';
    hint.setAttribute(UI, '');
    document.body.appendChild(tb);
    document.body.appendChild(hint);
  }

  function showToolbar() {
    if (!tb || !sel) return;
    const r = sel.el.getBoundingClientRect();
    const h = 34;
    let top = r.top + scrollY - h - 6;
    if (top < scrollY + 2) top = r.bottom + scrollY + 6;
    let left = r.left + scrollX;
    const maxLeft = scrollX + document.documentElement.clientWidth - 260;
    tb.style.left = Math.max(scrollX + 2, Math.min(left, maxLeft)) + 'px';
    tb.style.top = top + 'px';
    tb.style.display = 'flex';
  }
  function hideToolbar() { if (tb) tb.style.display = 'none'; }
  function flash(msg) {
    const h = document.getElementById('rd-hint');
    if (!h) return;
    h.textContent = msg;
    h.style.display = 'block';
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { h.style.display = 'none'; }, 2200);
  }

  // ---------------------------------------------------------------- records
  function push(op, data, undoFn) {
    const s = data.el ? selectorFor(data.el) : { rdId: null, selector: data.selector || '' };
    const item = {
      n: items.length + 1,
      op,
      el: data.el || null,
      rdId: s.rdId,
      selector: s.selector,
      textHint: data.el ? hintFor(data.el) : null,
      before: data.before == null ? null : data.before,
      after: data.after == null ? null : data.after,
      note: data.note == null ? null : data.note,
      rect: data.rect || { x: 0, y: 0, w: 0, h: 0 },
      dx: data.dx == null ? null : data.dx,
      dy: data.dy == null ? null : data.dy,
      w: data.w == null ? null : data.w,
      h: data.h == null ? null : data.h,
      undo: undoFn
    };
    items.push(item);
    item.badge = makeBadge(item.n, item.rect);
    if (data.el) item.mark = makeMark(item);
    layoutBadges();          // owns bx/by: same-element badges are spread out here
    mirror();
  }

  function makeBadge(n, r) {
    const b = document.createElement('div');
    b.className = 'rd-badge';
    b.setAttribute(UI, '');
    b.dataset.n = String(n);
    b.textContent = numLabel(n);
    b.style.left = Math.max(0, r.x - 2) + 'px';
    b.style.top = Math.max(0, r.y - 10) + 'px';
    document.body.appendChild(b);
    return b;
  }

  // Several changes can land on the SAME element (edit + note + delete …). Their badges
  // share a start point, so plain absolute placement stacks them on top of each other.
  // Group by the element OBJECT itself (a selector string can collide, and rdId is per
  // change) and run each group's badges out horizontally instead. bx/by is the final
  // position, kept on the item so the screenshot overlay draws the same spots. Items
  // without an element (region notes) fall back to their own number, i.e. stay alone.
  const badgeKey = it => (it.el || '#' + it.n);
  function layoutBadges() {
    const groups = new Map();
    for (const it of items) {
      if (!it.badge) continue;
      const k = badgeKey(it);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    const maxX = (document.documentElement.clientWidth || innerWidth) - 24;
    const writes = [];
    for (const list of groups.values()) {
      const anchor = list[0].rect;
      const y = Math.max(0, anchor.y - 10);
      let x = Math.max(0, anchor.x - 2);
      // read every width first (one reflow), then write
      const widths = list.map(it => it.badge.offsetWidth || 22);
      for (let i = 0; i < list.length; i++) {
        const bx = Math.min(Math.max(0, x), Math.max(0, maxX));
        writes.push([list[i], bx, y]);
        x += widths[i] + 2;
      }
    }
    for (const [it, bx, by] of writes) {
      it.bx = bx; it.by = by;
      it.badge.style.left = bx + 'px';
      it.badge.style.top = by + 'px';
    }
  }

  function makeMark(item) {
    const m = document.createElement('div');
    m.className = 'rd-mark';
    m.setAttribute(UI, '');
    m.dataset.n = String(item.n);
    document.body.appendChild(m);
    positionMark(m, item);
    return m;
  }

  function positionMark(m, it) {
    if (it.op === 'delete') {
      m.className = 'rd-mark region';
      Object.assign(m.style, { left: it.rect.x + 'px', top: it.rect.y + 'px', width: it.rect.w + 'px', height: it.rect.h + 'px' });
    } else if (it.op === 'note') {
      m.className = 'rd-mark note';
      Object.assign(m.style, { left: (it.rect.x + it.rect.w) + 'px', top: (it.rect.y - 6) + 'px' });
    } else {
      m.className = 'rd-mark region';
      Object.assign(m.style, { left: it.rect.x + 'px', top: it.rect.y + 'px', width: it.rect.w + 'px', height: it.rect.h + 'px' });
    }
  }

  // ---------------------------------------------------------------- ops
  function startText() {
    const el = sel.el;
    if (!el) return;
    sel.editing = true;
    const before = (el.textContent || '').replace(/\s+/g, ' ').trim();
    el.classList.add('rd-edit');
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('spellcheck', 'false');
    hideToolbar();
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    const done = commit => {
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('keydown', onKey);
      el.classList.remove('rd-edit');
      el.removeAttribute('contenteditable');
      el.removeAttribute('spellcheck');
      if (sel) sel.editing = false;
      if (!commit) { el.textContent = before; showToolbar(); return; }
      const after = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (after === before) { showToolbar(); return; }
      push('edit-text', { el, before, after, rect: rectOf(el) }, () => { el.textContent = before; });
      showToolbar();
    };
    const onBlur = () => done(true);
    const onKey = ev => {
      if (ev.key === 'Escape') { ev.preventDefault(); done(false); }
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); done(true); }
    };
    el.addEventListener('blur', onBlur);
    el.addEventListener('keydown', onKey);
  }

  function startDrag() {
    const el = sel.el;
    if (!el) return;
    hideToolbar();
    const box = document.createElement('div');
    box.className = 'rd-flash';
    box.setAttribute(UI, '');
    const r0 = el.getBoundingClientRect();
    Object.assign(box.style, { left: r0.left + scrollX + 'px', top: r0.top + scrollY + 'px', width: r0.width + 'px', height: r0.height + 'px' });
    document.body.appendChild(box);
    const base = el.style.transform || '';
    let sx = null, sy = null;
    let dx = 0, dy = 0, moved = false;
    const onMove = ev => {
      if (sx === null) { sx = ev.clientX; sy = ev.clientY; return; }   // origin = first move
      dx = ev.clientX - sx; dy = ev.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      el.style.transform = base + ' translate(' + dx + 'px,' + dy + 'px)';
      box.style.left = r0.left + scrollX + dx + 'px';
      box.style.top = r0.top + scrollY + dy + 'px';
    };
    const onUp = () => {
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      box.remove();
      el.style.transform = base;
      if (!moved) { showToolbar(); return; }
      el.style.transform = base + ' translate(' + dx + 'px,' + dy + 'px)';
      push('move', { el, dx: Math.round(dx), dy: Math.round(dy), rect: rectOf(el) },
        () => { el.style.transform = base; });
      showToolbar();
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
  }

  function startResize() {
    const el = sel.el;
    if (!el) return;
    hideToolbar();
    const cs = getComputedStyle(el);
    const w0 = el.offsetWidth, h0 = el.offsetHeight;
    const baseW = cs.width, baseH = cs.height;
    let sx = null, sy = null;
    let w = w0, h = h0, moved = false;
    const onMove = ev => {
      if (sx === null) { sx = ev.clientX; sy = ev.clientY; return; }
      w = Math.max(16, w0 + ev.clientX - sx);
      h = Math.max(12, h0 + ev.clientY - sy);
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 2) moved = true;
      el.style.boxSizing = 'border-box';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
    };
    const onUp = () => {
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      if (!moved) { showToolbar(); return; }
      push('resize', { el, w: Math.round(w), h: Math.round(h), rect: rectOf(el) },
        () => { el.style.width = baseW; el.style.height = baseH; });
      showToolbar();
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
  }

  function markDeleted() {
    const el = sel.el;
    if (!el) return;
    el.classList.add('rd-deleted');
    push('delete', { el, rect: rectOf(el), before: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300) },
      () => { el.classList.remove('rd-deleted'); });
    deselect();
  }

  // ---------------------------------------------------------------- note / region
  let noteBox = null;
  function hideNote() { if (noteBox) noteBox.style.display = 'none'; }
  function showNote(left, top, onCommit) {
    if (!noteBox) {
      noteBox = document.createElement('div');
      noteBox.id = 'rd-note';
      noteBox.setAttribute(UI, '');
      noteBox.innerHTML = '<textarea></textarea><div class="row"><button data-act="ok"></button><button class="sec" data-act="cancel"></button></div>';
      document.body.appendChild(noteBox);
      const ta = noteBox.querySelector('textarea');
      noteBox.querySelector('[data-act=ok]').addEventListener('click', () => noteBox._cb && noteBox._cb());
      noteBox.querySelector('[data-act=cancel]').addEventListener('click', () => { hideNote(); noteBox._cb = null; });
      ta.onkeydown = ev => {
        if (ev.key === 'Escape') { ev.stopPropagation(); hideNote(); }
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); noteBox._cb && noteBox._cb(); }
        ev.stopPropagation();
      };
    }
    const ta = noteBox.querySelector('textarea');
    noteBox.querySelector('[data-act=ok]').textContent = L.save || 'OK';
    noteBox.querySelector('[data-act=cancel]').textContent = L.cancel || 'Cancel';
    ta.value = '';
    noteBox.style.left = left + 'px';
    noteBox.style.top = top + 'px';
    noteBox.style.display = 'block';
    noteBox._cb = () => {
      const v = ta.value.trim();
      hideNote();
      if (v) onCommit(v);
    };
    setTimeout(() => ta.focus(), 0);
  }

  function startNote() {
    const el = sel.el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    hideToolbar();
    showNote(Math.min(r.right + scrollX + 8, scrollX + document.documentElement.clientWidth - 236),
      Math.max(scrollY + 4, r.top + scrollY), note => {
        push('note', { el, note, rect: rectOf(el) }, () => {});
      });
  }

  // region selection: armed by the parent's "框選加註" button, then drag here
  let regionBox = null;
  let swallowClick = false;   // the click that follows a region drag must not select
  function enableRegion(turnOn) {
    regionMode = !!turnOn;
    document.body.classList.toggle('rd-region', regionMode);
    if (regionMode) { flash(L.regionHint || 'Drag a box'); hideToolbar(); }
  }

  document.addEventListener('pointerdown', e => {
    if (!regionMode || isUi(e.target)) return;
    e.preventDefault();
    const x0 = e.clientX + scrollX, y0 = e.clientY + scrollY;
    regionBox = document.createElement('div');
    regionBox.className = 'rd-flash';
    regionBox.setAttribute(UI, '');
    Object.assign(regionBox.style, { left: x0 + 'px', top: y0 + 'px', width: '0px', height: '0px' });
    document.body.appendChild(regionBox);
    const onMove = ev => {
      const x1 = ev.clientX + scrollX, y1 = ev.clientY + scrollY;
      Object.assign(regionBox.style, {
        left: Math.min(x0, x1) + 'px', top: Math.min(y0, y1) + 'px',
        width: Math.abs(x1 - x0) + 'px', height: Math.abs(y1 - y0) + 'px'
      });
    };
    const onUp = ev => {
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      const x1 = ev.clientX + scrollX, y1 = ev.clientY + scrollY;
      const rect = { x: Math.round(Math.min(x0, x1)), y: Math.round(Math.min(y0, y1)),
        w: Math.round(Math.abs(x1 - x0)), h: Math.round(Math.abs(y1 - y0)) };
      enableRegion(false);
      swallowClick = true;
      if (regionBox) { regionBox.remove(); regionBox = null; }
      if (rect.w < 8 || rect.h < 8) return;
      showNote(Math.min(rect.x + rect.w + 8, scrollX + document.documentElement.clientWidth - 236),
        Math.max(scrollY + 4, rect.y), note => {
          push('region-note', { selector: '', rect, note }, () => {});
        });
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
  });

  // ---------------------------------------------------------------- undo / list sync
  function renumber() {
    items.forEach((it, i) => {
      it.n = i + 1;
      if (it.badge) {
        it.badge.dataset.n = String(it.n);
        it.badge.textContent = numLabel(it.n);
      }
      if (it.mark) it.mark.dataset.n = String(it.n);
    });
    layoutBadges();
  }

  function removeItem(n) {
    const i = items.findIndex(x => x.n === n);
    if (i < 0) return;
    const it = items.splice(i, 1)[0];
    if (it.badge) it.badge.remove();
    if (it.mark) it.mark.remove();
    try { it.undo(); } catch (_) {}
    if (it.el) {
      it.el.classList.remove('rd-deleted', 'rd-sel', 'rd-edit');
      it.el.removeAttribute('contenteditable');
    }
    renumber();
    mirror();
  }

  function updateNote(n, note) {
    const it = items.find(x => x.n === n);
    if (!it || (it.op !== 'note' && it.op !== 'region-note')) return;
    it.note = note;
    mirror();
  }

  function undo() {
    const it = items.pop();
    if (!it) return;
    if (it.badge) it.badge.remove();
    if (it.mark) it.mark.remove();
    try { it.undo(); } catch (_) {}
    if (it.el) it.el.classList.remove('rd-deleted', 'rd-sel', 'rd-edit');
    deselect();
    layoutBadges();
    mirror();
  }

  // ---------------------------------------------------------------- screenshot
  // This frame is an opaque origin, so no library may touch a nested iframe's
  // document (modern-screenshot and html-to-image both do). We therefore paint it
  // ourselves: serialize the body into an SVG <foreignObject>, draw that into a
  // canvas and read the PNG back. Same-origin CSS is copied as text; images are
  // absolutised so they still resolve from inside the data: URL.
  function pageCss() {
    const out = [];
    for (const s of document.querySelectorAll('style')) out.push(s.textContent || '');
    for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) {
      try {
        const rules = link.sheet && link.sheet.cssRules;
        if (!rules) continue;
        let txt = '';
        for (const r of rules) txt += r.cssText + '\n';
        out.push(txt);
      } catch (_) { /* opaque sheet: skip */ }
    }
    return out.join('\n');
  }

  function buildShotMarkup(width, height) {
    // PRE-CONDITION: takeShot() already swapped every live canvas for an <img>; a bare
    // clone would render canvases empty, so do not call this on its own.
    const clone = document.body.cloneNode(true);
    // canvases were already swapped for <img> by swapCanvases() before this clone
    // relative image sources would resolve against data: — make them absolute
    for (const img of clone.querySelectorAll('img[src]')) {
      try { img.setAttribute('src', new URL(img.getAttribute('src'), document.baseURI).href); } catch (_) {}
    }
    // The clone lands in a <div>, not a <body>, so body's box has to be reproduced on
    // the holder — but as PADDING, not margin: a child's top margin collapses out
    // through an unpositioned parent, so a copied margin would just vanish and the
    // text would ride ~10px high. padding + box-sizing:border-box reproduces the same
    // content width and the same offsets, which is what the recorded page rectangles
    // expect. The overlay nodes are dropped from the clone and re-drawn on the canvas
    // by drawMarks(), so nothing here depends on absolute positioning inside the
    // serialized document.
    const bs = getComputedStyle(document.body);
    for (const n of clone.querySelectorAll('[' + UI + ']')) n.remove();
    const bpad = ['Top', 'Right', 'Bottom', 'Left'].map(s => parseFloat(bs['padding' + s]) + parseFloat(bs['margin' + s]) || 0);
    // line-height must stay RELATIVE: copied as px it would be inherited as a fixed
    // value by headings, which is exactly how a cloned <h1> loses 18px and drags
    // everything below it upward, away from its recorded rectangle.
    const lhRatio = parseFloat(bs.lineHeight) / parseFloat(bs.fontSize);
    clone.setAttribute('style',
      'margin:0;' +
      `font-family:${bs.fontFamily};font-size:${bs.fontSize};font-weight:${bs.fontWeight};` +
      `font-style:${bs.fontStyle};line-height:${lhRatio > 0 ? lhRatio : 'normal'};` +
      `letter-spacing:${bs.letterSpacing};text-align:${bs.textAlign};word-spacing:${bs.wordSpacing};color:${bs.color};`);
    const holder = document.createElement('div');
    holder.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    holder.setAttribute('style',
      'margin:0;position:relative;box-sizing:border-box;' +
      `width:${width}px;height:${height}px;padding:${bpad.map(v => v + 'px').join(' ')};` +
      `border:${bs.borderWidth} ${bs.borderStyle} ${bs.borderColor};` +
      `background:${bs.backgroundColor === 'rgba(0, 0, 0, 0)' ? '#fff' : bs.backgroundColor};`);
    const style = document.createElement('style');
    style.textContent = pageCss();
    holder.append(style, clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
      new XMLSerializer().serializeToString(holder) + '</foreignObject></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  // Overlay is drawn on the bitmap, not in the cloned DOM: page coordinates × scale,
  // straight onto the canvas. Same look as the live badges/marks.
  function drawMarks(ctx, scale) {
    ctx.save();
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const it of items) {
      const r = it.rect;
      const x = r.x * scale, y = r.y * scale, w = r.w * scale, h = r.h * scale;
      ctx.lineWidth = Math.max(1, 2 * scale);
      if (it.op === 'delete' || it.op === 'region-note' || it.op === 'move' || it.op === 'resize') {
        ctx.strokeStyle = 'rgba(217,63,63,.85)';
        ctx.fillStyle = 'rgba(217,63,63,.08)';
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.fill();
        ctx.stroke();
      } else if (it.op === 'note') {                 // diamond at the element's right edge
        const cx = (r.x + r.w) * scale, cy = (r.y - 6) * scale;
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = '#e8a33d';
        ctx.strokeStyle = '#7a5300';
        ctx.beginPath();
        ctx.rect(-6 * scale, -6 * scale, 12 * scale, 12 * scale);
        ctx.fill();
        ctx.stroke();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      // badge — bx/by is the laid-out top-left, so same-element badges sit side by side
      const bx = ((it.bx == null ? Math.max(0, r.x - 2) : it.bx) + 10) * scale;
      const by = ((it.by == null ? Math.max(0, r.y - 10) : it.by) + 10) * scale;
      ctx.beginPath();
      ctx.arc(bx, by, 10 * scale, 0, Math.PI * 2);
      ctx.fillStyle = '#d93f3f';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(numLabel(it.n), bx, by + 0.5 * scale);
    }
    ctx.restore();
  }

  // A canvas keeps its bitmap out of the DOM, so a serialized clone renders it empty.
  // Swap every live canvas for an <img> of its toDataURL bitmap BEFORE cloning, and put
  // the canvases back afterwards. A tainted canvas (cross-origin draw) cannot be read:
  // it becomes a grey "canvas" plate instead of an error. Returns the restore function.
  function swapCanvases() {
    const swapped = [];
    const restore = () => { for (const [c, rep] of swapped) if (rep.parentNode) rep.parentNode.replaceChild(c, rep); };
    try {
      for (const c of document.querySelectorAll('canvas')) {
        if (!c.parentNode) continue;
        const r = c.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width || c.width));
        const h = Math.max(1, Math.round(r.height || c.height));
        let rep;
        try {
          const img = document.createElement('img');
          img.src = c.toDataURL('image/png');
          rep = img;
        } catch (_) {
          // tainted (cross-origin) canvas: a plain grey plate, never an error
          const ph = document.createElement('div');
          ph.textContent = 'canvas';
          ph.style.cssText = 'display:flex;align-items:center;justify-content:center;' +
            'background:#d8d3c8;color:#6b6459;font:12px system-ui,sans-serif;border-radius:4px;';
          rep = ph;
        }
        rep.style.width = w + 'px';
        rep.style.height = h + 'px';
        rep.style.verticalAlign = 'top';
        c.parentNode.replaceChild(rep, c);
        swapped.push([c, rep]);
      }
    } catch (_) { restore(); throw _; }
    return restore;
  }

  let shotBusy = false;   // two overlapping shots would find no <canvas> the second time

  async function takeShot(id) {
    // A second shot while one runs would find no <canvas> (the first swapped them all
    // out) and clone a page mid-swap — wait for the running one instead of bailing.
    while (shotBusy) await new Promise(r => setTimeout(r, 40));
    shotBusy = true;
    if (tb) tb.style.display = 'none';
    if (noteBox) noteBox.style.display = 'none';
    document.querySelectorAll('.rd-sel, .rd-hover').forEach(n => n.classList.remove('rd-sel', 'rd-hover'));
    // no-op default, so an early throw can never leave the page holding the <img> swaps
    let restoreCanvases = () => {};
    try {
      // Width must be the CURRENT viewport, not scrollWidth: the badges/marks are
      // absolutely positioned at the coordinates captured earlier, so laying the
      // clone out any wider reflows the text and pulls the marks off their elements.
      const width = document.documentElement.clientWidth || innerWidth;
      const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const scale = Math.max(0.4, Math.min(2, 1400 / Math.max(1, width), 3000 / Math.max(1, width, height)));
      restoreCanvases = swapCanvases();
      // wait for every replacement <img> to decode, otherwise the serialized clone can
      // still carry an undecoded (blank) image
      await Promise.all([...document.querySelectorAll('img[src^="data:image/"]')].map(i => i.decode().catch(() => {})));
      await new Promise(r => setTimeout(r, 30));
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('svg render'));
        img.src = buildShotMarkup(width, height);
      });
      const cv = document.createElement('canvas');
      cv.width = Math.round(width * scale);
      cv.height = Math.round(height * scale);
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      drawMarks(ctx, scale);
      post('screenshot', { id, dataUrl: cv.toDataURL('image/png') });
    } catch (err) {
      post('screenshot', { id, dataUrl: null, error: String((err && err.stack) || err) });
    } finally {
      restoreCanvases();
      shotBusy = false;
      if (sel) sel.el.classList.add('rd-sel');
    }
  }

  // ---------------------------------------------------------------- boot
  addEventListener('pointerdown', e => { lastPointer.x = e.clientX; lastPointer.y = e.clientY; }, true);

  addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (regionMode) { enableRegion(false); return; }
      if (noteBox && noteBox.style.display === 'block') { hideNote(); return; }
      if (sel && sel.editing) return;   // the inline editor owns Esc
      deselect();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      if (sel && sel.editing) return;
      e.preventDefault();
      undo();
    }
  }, true);

  window.__rdRegion = enableRegion;
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => post('ready'));
  else post('ready');
})();
