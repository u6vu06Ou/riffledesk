// no3d.js — 沒有 WebGL 時的中間欄：一張說明卡＋一份簡單檔案清單。
// 3D 卡堆是 RiffleDesk 的賣點，所以不做「平面卡片格」；這裡只提供最低限度可用的清單，
// 左欄樹與閱讀面板照常運作。不 import three.js（CDN 掛掉也要載得到）。
// 對 main.js/scrub.js/mirror.js 實作跟 StackScene 同一組鴨式 API（見 flat.js 當年的那組），
// 只是沒有 3D 的東西；用不到的給安全空殼。
import { clamp } from './util.js';
import { t } from './i18n.js';
import { requestThumb, cancelThumb, pumpThumbs, thumbQueueSize } from './thumbs.js';

const ROW_THUMB_MAX = 60;      // 清單小縮圖快取上限（path → canvas）
const ROW_H = 52;              // 每列高度（CSS 同值；scrub／張數指示器用「第幾張」計）
const WEBGL_HELP = 'https://get.webgl.org/';

// 說明卡本體：沒有 3D 時的中間欄用它，跑 3D 途中顯卡驅動重置（context lost）時也拿它當浮層。
// reload=true 時多一顆「重新載入」，因為那個情境重載就會回到 3D。
export function buildNotice({ reload = false } = {}) {
  const card = document.createElement('div');
  card.className = 'ncard';
  card.setAttribute('role', 'status');
  card.innerHTML = `
        <div class="nicon" aria-hidden="true">🖥️</div>
        <h2></h2>
        <p class="nbody"></p>
        <div class="nfix">
          <b></b>
          <ul><li></li><li></li><li></li></ul>
        </div>
        <a class="nlink" target="_blank" rel="noopener noreferrer"></a>
        <p class="nhint"></p>`;
  const q = s => card.querySelector(s);
  q('h2').textContent = reload ? t('no3dLostTitle') : t('no3dTitle');
  q('.nbody').textContent = t('no3dBody');
  q('.nfix b').textContent = t('no3dFixTitle');
  const lis = card.querySelectorAll('.nfix li');
  lis[0].textContent = t('no3dFix1');
  lis[1].textContent = t('no3dFix2');
  lis[2].textContent = t('no3dFix3');
  const link = q('.nlink');
  link.href = WEBGL_HELP;
  link.textContent = t('no3dLink');
  q('.nhint').textContent = reload ? t('no3dLostHint') : t('no3dListHint');
  if (reload) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nreload';
    b.textContent = t('no3dReload');
    b.addEventListener('click', () => location.reload());
    q('.nhint').after(b);
  }
  return card;
}

export class No3DView {
  constructor() {
    this.no3d = true;
    this.el = document.createElement('div');
    this.el.id = 'noview';
    this.el.appendChild(buildNotice());
    this.listEl = document.createElement('div');
    this.listEl.className = 'nlist';
    this.listEl.setAttribute('role', 'list');
    this.listEl.dataset.empty = t('no3dEmpty');
    this.el.appendChild(this.listEl);
    document.body.appendChild(this.el);

    // ---- 跟 StackScene 同名的狀態 ----
    this.files = [];
    this.view = [];
    this.nameFilter = '';
    this.folderLabel = '';
    this.sortMode = 'new';
    this.total = null;
    this.hasMore = false;
    this.moreLoader = null;
    this.loadingMore = false;
    this.selected = new Set();
    this._selAnchor = null;
    this.extracted = null;
    this.extractedFile = null;
    this.readingPath = null;
    this.scrollTarget = 0;
    this.scrollCur = 0;
    this.scrollVel = 0;
    this.phase = 'idle';
    this.viewCss = { x: 0, w: 1 };
    this.lastFolderSwitchMs = 0;
    this.onCardClick = null;
    this.onCardMenu = null;
    this.onSelection = null;
    this.readerOpen = null;
    this.getReaderRect = null;
    // __dbg.camera() 要這些形狀（toArray／distanceTo）：沒有 3D 就給常數
    this.orbit = { yaw: 0, pitch: 0, zoom: 1 };
    const v3 = { toArray: () => [0, 0, 0], distanceTo: () => 0 };
    this.fitCur = { target: v3, dist: 0, pitch: 0, yaw: 0 };
    this.fitTarget = { target: v3, dist: 0, pitch: 0, yaw: 0 };

    this._rows = new Map();        // fileIdx -> row
    this._rowCache = new Map();    // path -> canvas
    this._thumbRaf = null;

    this.el.addEventListener('scroll', () => this._onScroll(), { passive: true });
    this.listEl.addEventListener('click', e => this._onClick(e));
    this.listEl.addEventListener('contextmenu', e => this._onCtx(e));
    addEventListener('themechange', () => { this._rowCache.clear(); this._render(true); });
  }

  // ------------------------------------------------------------- 版面
  setViewportNow(x, w) {
    if (!isFinite(x) || !isFinite(w)) return;
    this.viewCss = { x, w };
    this.el.style.left = Math.round(x) + 'px';
    this.el.style.width = Math.max(0, Math.round(w)) + 'px';
    this._updateCount();
  }
  setViewportTarget(x, w) { this.setViewportNow(x, w); }
  scrollMax() { return Math.max(0, this.view.length - 1); }

  _onScroll() {
    this.scrollCur = clamp(this.el.scrollTop / ROW_H, 0, this.scrollMax());
    this.scrollTarget = this.scrollCur;
    if (this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < this.el.clientHeight) {
      this.maybeRequestMore();
    }
    this._updateCount();
  }

  poke() {
    // scrub.js 的快速跳轉：_jumpTo = 第幾張 → 移到那一列
    if (this._jumpTo != null) {
      const i = clamp(Math.round(this._jumpTo), 0, this.scrollMax());
      this._jumpTo = null;
      this.el.scrollTop = i * ROW_H;
      this._onScroll();
    }
    this._markVisible();
    this._updateCount();
  }

  // ------------------------------------------------------------- 檔案資料
  setFolder(label, files, page) {
    const t0 = performance.now();
    this.folderLabel = label;
    if (this.extracted) this.returnExtracted();
    this.files = Array.isArray(files) ? files.slice() : [];
    this.view = this.applyNameFilter(this.files);
    this.total = page && typeof page.total === 'number' ? page.total : this.files.length;
    this.hasMore = !!(page && page.hasMore && page.fetchMore);
    this.moreLoader = page ? page.fetchMore : null;
    this.loadingMore = false;
    this.selected.clear(); this._selAnchor = null;
    this.el.scrollTop = 0;
    this.scrollCur = this.scrollTarget = 0;
    this._render(true);
    this.lastFolderSwitchMs = Math.round(performance.now() - t0);
    this._updateCount();
    this.notifySelection();
  }

  // 使用者正在捲（分頁模式的推送要避開這段時間）
  scrollBusy() { return false; }

  // 清單就地更新：不重置捲動位置——以最前面那張為錨，它不見了就停在原索引
  updateFilesInPlace(files, anchorPath) {
    const oldFocus = Math.round(this.scrollCur);
    this.files = Array.isArray(files) ? files.slice() : [];
    this.view = this.applyNameFilter(this.files);
    this.total = this.files.length;
    this.hasMore = false;
    this.moreLoader = null;
    this.loadingMore = false;
    const at = anchorPath ? this.view.findIndex(f => f.path === anchorPath) : -1;
    const idx = at >= 0 ? at : Math.min(oldFocus, Math.max(0, this.view.length - 1));
    this.scrollCur = this.scrollTarget = idx;
    this.el.scrollTop = idx * ROW_H;
    this._render(false);
    this._updateCount();
    this.notifySelection();
    return [];
  }

  maybeRequestMore() {
    if (!this.hasMore || this.loadingMore || !this.moreLoader) return;
    if (this.nameFilter && this.nameFilter.trim()) return;
    if (this.files.length - this.view.length > 60) return;
    this.loadingMore = true;
    let p;
    try { p = this.moreLoader(); } catch (_) { this.loadingMore = false; return; }
    Promise.resolve(p).then(r => {
      if (r && typeof r.fetchMore === 'function') this.moreLoader = r.fetchMore;
      if (!r || !r.files || !r.files.length) { this.hasMore = false; return; }
      const seen = new Set(this.files.map(f => f.path));
      this.files = this.files.concat(r.files.filter(f => f && !seen.has(f.path)));
      this.total = typeof r.total === 'number' ? r.total : this.files.length;
      this.hasMore = !!r.hasMore;
      this.view = this.applyNameFilter(this.files);
      this._render(true);
      this._updateCount();
      this.notifySelection();
    }, () => {}).finally(() => { this.loadingMore = false; });
  }

  sorted(files) {
    const m = this.sortMode || 'new', a = files.slice();
    const coll = this._coll || (this._coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }));
    if (m === 'new') a.sort((x, y) => (y.mtime || 0) - (x.mtime || 0));
    else if (m === 'old') a.sort((x, y) => (x.mtime || 0) - (y.mtime || 0));
    else if (m === 'big') a.sort((x, y) => (y.size || 0) - (x.size || 0));
    else if (m === 'small') a.sort((x, y) => (x.size || 0) - (y.size || 0));
    else if (m === 'name') a.sort((x, y) => coll.compare(x.name || '', y.name || ''));
    return a;
  }
  applyNameFilter(files) {
    const q = String(this.nameFilter || '').trim().toLowerCase();
    return this.sorted(q ? files.filter(f => String(f.name || '').toLowerCase().includes(q)) : files);
  }
  setNameFilter(q) {
    this.nameFilter = String(q == null ? '' : q);
    this.view = this.applyNameFilter(this.files);
    this.el.scrollTop = 0;
    this.scrollCur = this.scrollTarget = 0;
    this._render(true);
    this._updateCount();
    this.notifySelection();
  }
  setSort(mode) {
    this.sortMode = mode;
    this.view = this.applyNameFilter(this.files);
    this.el.scrollTop = 0;
    this.scrollCur = this.scrollTarget = 0;
    this._render(true);
    this._updateCount();
  }

  // ------------------------------------------------------------- 多選
  selectClick(idx, range) {
    const f = this.view[idx];
    if (!f) return;
    if (range && this._selAnchor != null) {
      const a = Math.min(this._selAnchor, idx), b = Math.max(this._selAnchor, idx);
      for (let i = a; i <= b; i++) { const g = this.view[i]; if (g) this.selected.add(g.path); }
    } else {
      if (this.selected.has(f.path)) this.selected.delete(f.path); else this.selected.add(f.path);
      this._selAnchor = idx;
    }
    this.selChanged();
  }
  allSelected() { const v = this.view; return v.length > 0 && v.every(f => this.selected.has(f.path)); }
  selectAll() { for (const f of this.view) this.selected.add(f.path); this.selChanged(); }
  toggleSelectAll() { if (!this.view.length) return; if (this.allSelected()) this.clearSelection(); else this.selectAll(); }
  clearSelection() { if (!this.selected.size && this._selAnchor == null) return; this.selected.clear(); this._selAnchor = null; this.selChanged(); }
  selectedFiles() { return this.view.filter(f => this.selected.has(f.path)); }
  selChanged() { this._markVisible(); this.notifySelection(); }
  notifySelection() { if (this.onSelection) this.onSelection(this.selectedFiles()); }

  // ------------------------------------------------------------- 點列開閱讀
  _onClick(e) {
    const row = e.target && e.target.closest ? e.target.closest('.nrow') : null;
    if (!row || !this.el.contains(row)) return;
    const idx = row._idx;
    if (e.ctrlKey || e.metaKey || e.shiftKey) { this.selectClick(idx, e.shiftKey); return; }
    if (this.readerOpen && this.readerOpen()) this.switchReading(idx);
    else this.extractFile(idx, this.getReaderRect ? this.getReaderRect() : null);
  }
  _onCtx(e) {
    const row = e.target && e.target.closest ? e.target.closest('.nrow') : null;
    if (!row || !this.el.contains(row)) return;
    e.preventDefault();
    const f = this.view[row._idx];
    if (f && this.onCardMenu) this.onCardMenu(f, e.clientX, e.clientY);
  }
  extractFile(fileIdx) {
    const f = this.view[fileIdx];
    if (!f) return null;
    this.extracted = { file: f, fileIdx };
    this.extractedFile = f;
    if (this.onCardClick) this.onCardClick(f);
    this._markVisible();
    return f;
  }
  switchReading(idx) { return this.extractFile(idx); }
  returnExtracted() {
    this.extracted = null;
    this.extractedFile = null;
    this._markVisible();
  }
  restage() {}

  // ------------------------------------------------------------- 清單渲染
  _render(force) {
    const n = this.view.length;
    if (force) {
      for (const row of this._rows.values()) this._recycle(row);
      this._rows.clear();
    }
    // 只補缺的列：重新綁定換檔的列（序號當鍵，排序／過濾後同一列可能是別的檔）
    for (let i = 0; i < n; i++) {
      const f = this.view[i];
      let row = this._rows.get(i);
      if (row && row._file === f) { row._idx = i; continue; }
      if (!row) {
        row = this._makeRow();
        this._rows.set(i, row);
        this.listEl.appendChild(row);
      }
      this._bind(row, f, i);
    }
    for (const [i, row] of [...this._rows]) {
      if (i >= n) { this._recycle(row); this._rows.delete(i); }
    }
    this.listEl.classList.toggle('empty', n === 0);
    this._markVisible();
  }

  _recycle(row) {
    if (row._thumbReq) { cancelThumb(row._thumbReq.path, row._thumbReq.cb); row._thumbReq = null; }
    row.remove();
  }

  _makeRow() {
    const row = document.createElement('div');
    row.className = 'nrow';
    row.setAttribute('role', 'listitem');
    row.innerHTML = '<canvas class="nthumb" width="128" height="80"></canvas><span class="nname"></span><span class="nmeta"></span>';
    return row;
  }

  _bind(row, f, idx) {
    if (row._thumbReq) { cancelThumb(row._thumbReq.path, row._thumbReq.cb); row._thumbReq = null; }
    row._file = f;
    row._idx = idx;
    row.dataset.path = f.path;
    row.title = f.path;
    row.classList.toggle('binary', !f.kind);
    row.querySelector('.nname').textContent = f.name || '';
    const d = f.mtime ? new Date(f.mtime) : null;
    row.querySelector('.nmeta').textContent = d
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      : '';
    const cv = row.querySelector('.nthumb');
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    // 縮圖只畫真縮圖：1280×800 的骨架卡縮到 48×30 只剩一片白，還不如留底色（檔名在列上就有）
    const hit = this._rowCache.get(f.path);
    if (hit) { ctx.drawImage(hit, 0, 0, 128, 80); return; }
    if (!f.kind) return;
    const onThumb = tc => {
      if (tc) this._cacheThumb(f.path, tc);
      if (row._thumbReq && row._thumbReq.cb === onThumb) row._thumbReq = null;
      if (row._file !== f || !tc) return;
      const c = row.querySelector('.nthumb').getContext('2d');
      if (c) c.drawImage(tc, 0, 0, 128, 80);
    };
    row._thumbReq = { path: f.path, cb: onThumb };
    requestThumb(f, onThumb);
    this._pumpSoon();
  }

  _cacheThumb(path, c) {
    this._rowCache.delete(path);
    this._rowCache.set(path, c);
    if (this._rowCache.size > ROW_THUMB_MAX) this._rowCache.delete(this._rowCache.keys().next().value);
  }
  _pumpSoon() {
    if (this._thumbRaf != null) return;
    this._thumbRaf = requestAnimationFrame(() => {
      this._thumbRaf = null;
      pumpThumbs();
      if (thumbQueueSize() > 0) this._pumpSoon();
    });
  }

  _markVisible() {
    for (const row of this._rows.values()) {
      const f = row._file;
      row.classList.toggle('sel', !!f && this.selected.has(f.path));
      row.classList.toggle('reading', !!f && f.path === this.readingPath);
    }
  }

  _updateCount() {
    const n = this.view.length;
    let txt = '';
    if (n) {
      const a = clamp(Math.round(this.scrollCur) + 1, 1, n);
      txt = t('cardCount', { a, n });
    }
    if (txt !== this._countText) {
      this._countText = txt;
      let el = this._countEl;
      if (!el) el = this._countEl = document.getElementById('stackCount');
      if (el) {
        el.textContent = txt;
        el.style.display = txt ? '' : 'none';
      }
    }
    const el = this._countEl;
    if (el && txt) el.style.left = Math.round(this.viewCss.x + this.viewCss.w - 14) + 'px';
    const pb = this.pathBarEl;
    if (pb) {
      pb.style.left = Math.round(this.viewCss.x + 14) + 'px';
      pb.style.maxWidth = Math.max(120, Math.round(this.viewCss.w - 130)) + 'px';
    }
    const tip = document.getElementById('hint');
    if (tip) tip.style.left = Math.round(this.viewCss.x + this.viewCss.w / 2) + 'px';
  }

  // ------------------------------------------------------------- 3D 專用空殼
  resetView() {}
  favView() { return null; }
  saveFavView() { return null; }
  goFavView() { return false; }
  viewDiffers() { return false; }
  notifyView() {}
  avgFps() { return 0; }
  resetFps() {}
  slotTex() { return []; }
  pickAtCss() { return null; }
  cornerBoundsCss() { return null; }
  cardBoundsCss() { return null; }
  cardEdgeWidthsCss() { return null; }
  glViewportCss() { return { x: this.viewCss.x, y: 44, w: this.viewCss.w, h: innerHeight - 44 }; }
  glViewportRaw() { return { ...this.glViewportCss(), dpr: devicePixelRatio || 1, pixelRatio: devicePixelRatio || 1 }; }
  cardMeshVisible() { return null; }
  exposedRatio() { return null; }
  setFitOverride() {}
  hoverFileIdx() { return -1; }
  visibleCards() { return []; }
  cardScreen() { return null; }

  dbg() {
    return {
      files: this.view.length, phase: 'idle', folder: this.folderLabel,
      scroll: Math.round(this.scrollCur), scrollMax: this.scrollMax(),
      total: this.total != null ? this.total : this.view.length, hasMore: !!this.hasMore,
      sel: this.selectedFiles().length, allSel: this.allSelected(),
      extracted: this.extractedFile ? this.extractedFile.name : null,
      lastFolderSwitchMs: this.lastFolderSwitchMs,
      scrollTarget: Math.round(this.scrollTarget), scrollVel: 0,
      no3d: true, rows: this._rows.size
    };
  }
}

