// revise.js — "✎ 改版" mode for HTML files.
//
// The page is shown in a sandboxed iframe WITHOUT allow-same-origin (opaque
// origin), loaded from /raw/<token>/… with the revise flag: the server then
// injects public/revise-agent.js into the page and the agent talks back over
// postMessage. This module is the parent half: it verifies event.source, renders
// the change list, and does the /api/revise/save call.
//
// The agent owns the numbered change records (it alone can undo DOM mutations),
// so it mirrors its list here after every change; the list buttons post
// remove(n) / update-note back. Everything arriving from the iframe is data.
import { t } from './i18n.js';
import { apiJson } from './util.js';

const NUMS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
const numLabel = n => (n <= NUMS.length ? NUMS[n - 1] : '(' + n + ')');

export class Revise {
  constructor(reader) {
    this.reader = reader;
    this.on = false;
    this.file = null;        // { path, name }
    this.iframe = null;
    this.ready = false;
    this.items = [];
    this.selection = null;
    this.wrap = null;
    this.gen = 0;
    this.shotWait = null;
    addEventListener('message', e => this.onMessage(e));
  }

  labels() {
    return {
      text: t('rvText'), move: t('rvMove'), resize: t('rvResize'), del: t('rvDelete'),
      note: t('rvNote'), save: t('rvOk'), cancel: t('rvCancel'), regionHint: t('rvRegionHint')
    };
  }

  active() { return this.on; }

  async toggle() {
    if (this.on) { this.exit(); return; }
    const f = this.reader.file;
    if (!f || f.kind !== 'html') return;
    await this.enter(f);
  }

  async enter(file) {
    if (this.reader.editor.isActive()) this.reader.editor.exitDomOnly();
    this.on = true;
    this.file = file;
    this.items = [];
    this.selection = null;
    this.ready = false;
    const gen = ++this.gen;
    const runOn = this.reader.htmlRunOn(file);
    let raw;
    try {
      raw = await apiJson('/api/rawopen?path=' + encodeURIComponent(file.path) + '&revise=1' + (runOn ? '&run=1' : ''));
    } catch (err) {
      this.reader.toast(t('rvSaveFail', { msg: String(err.message || err) }));
      this.on = false;
      return;
    }
    if (gen !== this.gen || !raw.ok) return;
    this.render(raw.url);
    this.reader.syncHtmlButtons(this.reader.file);
  }

  exit() {
    if (!this.on) return;
    const f = this.file;
    this.detach();
    if (f && this.reader.file === f) this.reader.open(f).catch(() => {});
  }

  // drop the UI without reopening (called by Reader.open when the file changes)
  detach() {
    this.on = false;
    this.gen++;
    this.items = [];
    this.selection = null;
    this.iframe = null;
    this.ready = false;
    if (this.wrap && this.wrap.isConnected) this.wrap.remove();
    this.wrap = null;
    this.reader.body.classList.remove('revise');
    this.file = null;
  }

  // ---- DOM ----
  render(url) {
    const body = this.reader.body;
    body.classList.add('revise');
    body.textContent = '';
    const wrap = document.createElement('div');
    wrap.id = 'reviseWrap';
    wrap.innerHTML = `
      <div id="reviseBar">
        <button data-rv="region" data-i18n-title="rvRegionTitle">⬚ ${t('rvRegion')}</button>
        <button data-rv="undo" data-i18n-title="rvUndoTitle">↩ ${t('rvUndo')}</button>
        <span id="reviseSel" aria-live="polite"></span>
        <button data-rv="copy" data-i18n-title="rvCopyTitle">📋 ${t('rvCopy')}</button>
        <button data-rv="save" data-i18n-title="rvSaveTitle">💾 ${t('rvSave')}</button>
        <button data-rv="hand" class="primary" data-i18n-title="rvHandTitle">🤖 ${t('rvHand')}</button>
        <button data-rv="exit" data-i18n-title="rvExitTitle">✕ ${t('rvExit')}</button>
      </div>
      <div id="reviseMain">
        <div id="reviseFrameBox"><iframe id="reviseFrame" title="${t('rvFrameTitle')}"
          sandbox="allow-scripts allow-popups allow-modals allow-downloads allow-forms"
          referrerpolicy="no-referrer"></iframe></div>
        <aside id="reviseList" role="region" aria-label="${t('rvListTitle')}">
          <div class="rv-head">${t('rvListTitle')} <span class="n">0</span></div>
          <ol></ol>
          <div class="rv-empty">${t('rvEmpty')}</div>
        </aside>
      </div>`;
    body.appendChild(wrap);
    this.wrap = wrap;
    this.iframe = wrap.querySelector('iframe');
    this.iframe.src = url;
    wrap.querySelector('#reviseBar').addEventListener('click', e => {
      const b = e.target.closest('button[data-rv]');
      if (!b) return;
      const a = b.dataset.rv;
      if (a === 'save') this.save(false);
      else if (a === 'hand') this.save(true);
      else if (a === 'copy') this.copyList();
      else if (a === 'exit') this.exit();
      else this.send(a === 'region' ? 'region' : 'undo');
    });
    const listEl = wrap.querySelector('#reviseList');
    listEl.addEventListener('click', e => {
      const x = e.target.closest('button.del');
      if (!x) return;
      this.send2({ rd: 1, type: 'remove', n: Number(x.closest('li').dataset.n) });
    });
    listEl.addEventListener('change', e => {
      const ta = e.target.closest('textarea[data-note]');
      if (!ta) return;
      this.send2({ rd: 1, type: 'update-note', n: Number(ta.dataset.note), note: ta.value.trim() });
    });
    this.renderList();
  }

  send(type) {
    const msg = { rd: 1, type };
    if (type === 'init') msg.labels = this.labels();
    this.send2(msg);
  }
  send2(msg) { if (this.iframe && this.ready) this.iframe.contentWindow.postMessage(msg, '*'); }

  // ---- messages from the agent ----
  onMessage(e) {
    if (!this.on || !this.iframe || e.source !== this.iframe.contentWindow) return;
    const d = e.data;
    if (!d || d.rd !== 1) return;
    if (d.type === 'ready') {
      this.ready = true;
      this.send('init');
    } else if (d.type === 'state' && Array.isArray(d.items)) {
      this.items = d.items;
      this.renderList();
    } else if (d.type === 'select' && d.info) {
      this.selection = d.info;
      this.showSel();
    } else if (d.type === 'deselect') {
      this.selection = null;
      this.showSel();
    } else if (d.type === 'screenshot' && this.shotWait && d.id === this.shotWait.id) {
      const w = this.shotWait;
      this.shotWait = null;
      w.resolve(typeof d.dataUrl === 'string' ? d.dataUrl : null);
    }
  }

  showSel() {
    const el = this.wrap && this.wrap.querySelector('#reviseSel');
    if (!el) return;
    el.textContent = this.selection ? (this.selection.tag || '') : '';
  }

  renderList() {
    if (!this.wrap) return;
    const ol = this.wrap.querySelector('#reviseList ol');
    const empty = this.wrap.querySelector('#reviseList .rv-empty');
    this.wrap.querySelector('#reviseList .n').textContent = String(this.items.length);
    empty.hidden = this.items.length > 0;
    ol.textContent = '';
    for (const it of this.items) {
      const li = document.createElement('li');
      li.dataset.n = String(it.n);
      li.dataset.op = it.op;
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = numLabel(it.n);
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = this.describe(it);
      li.append(num, desc);
      if (it.op === 'note' || it.op === 'region-note') {
        const ta = document.createElement('textarea');
        ta.className = 'note-edit';
        ta.dataset.note = String(it.n);
        ta.value = it.note || '';
        ta.rows = 2;
        ta.title = t('rvEditNoteTitle');
        li.appendChild(ta);
      }
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.title = t('rvRemoveTitle');
      li.appendChild(del);
      ol.appendChild(li);
    }
  }

  describe(it) {
    const snip = s => (s && s.length > 40 ? s.slice(0, 40) + '…' : (s || ''));
    const label = t('rvOp_' + it.op.replace(/-/g, '_'));
    switch (it.op) {
      case 'edit-text': return `${label}：「${snip(it.before)}」→「${snip(it.after)}」`;
      case 'move': return `${label} (${it.dx}, ${it.dy})`;
      case 'resize': return `${label} (${it.w}×${it.h})`;
      case 'delete': return `${label}：${snip(it.textHint)}`;
      default: return `${label}：${snip(it.note)}`;
    }
  }

  summary() {
    const snip = s => (s && s.length > 60 ? s.slice(0, 60) + '…' : (s || ''));
    return this.items.map(it => {
      const where = it.rdId ? `[data-rd-id=${it.rdId}]` : (it.selector || '');
      switch (it.op) {
        case 'edit-text': return `${numLabel(it.n)} ${t('rvSumEdit', { before: snip(it.before), after: snip(it.after) })}`;
        case 'move': return `${numLabel(it.n)} ${t('rvSumMove', { dx: it.dx, dy: it.dy, where })}`;
        case 'resize': return `${numLabel(it.n)} ${t('rvSumResize', { w: it.w, h: it.h, where })}`;
        case 'delete': return `${numLabel(it.n)} ${t('rvSumDelete', { text: snip(it.textHint) })}`;
        case 'note': return `${numLabel(it.n)} ${t('rvSumNote', { text: snip(it.note), where })}`;
        default: return `${numLabel(it.n)} ${t('rvSumRegion', { text: snip(it.note), x: it.rect.x, y: it.rect.y, w: it.rect.w, h: it.rect.h })}`;
      }
    }).join('\n');
  }

  async copyList() {
    const text = this.summary();
    if (!text) { this.reader.toast(t('rvNone')); return; }
    try {
      await navigator.clipboard.writeText(text);
      this.reader.toast(t('rvCopied'));
    } catch (_) { this.reader.toast(t('rvCopyFail')); }
  }

  screenshot() {
    if (!this.iframe || !this.ready) return Promise.resolve(null);
    const id = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
    return new Promise(resolve => {
      this.shotWait = { id, resolve };
      setTimeout(() => {
        if (this.shotWait && this.shotWait.id === id) { this.shotWait = null; resolve(null); }
      }, 20000);
      this.send2({ rd: 1, type: 'screenshot', id });
    });
  }

  async save(handToAI) {
    if (!this.on || !this.file) return;
    const items = this.items;
    if (!items.length) { this.reader.toast(t('rvNone')); return; }
    const btn = this.wrap.querySelector('button[data-rv="save"]');
    if (btn) btn.disabled = true;
    try {
      const png = await this.screenshot();
      const summary = this.summary();
      const r = await apiJson('/api/revise/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: this.file.path, changes: items, png, summary })
      });
      if (!r.ok) throw new Error(r.error || 'save failed');
      if (handToAI) {
        try { await navigator.clipboard.writeText(summary); } catch (_) {}
        this.reader.toast(t('rvHanded', { name: this.file.name }));
      } else {
        this.reader.toast(t('rvSaved', { name: this.file.name }), { label: t('rvCopy'), fn: () => this.copyList() });
      }
    } catch (err) {
      this.reader.toast(t('rvSaveFail', { msg: String(err.message || err) }));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  undo() { this.send('undo'); }
  deselect() { this.send2({ rd: 1, type: 'deselect' }); }
}
