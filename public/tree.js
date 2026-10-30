// DOM folder tree (Finder/Explorer style sidebar): quick access + local drives.
import { apiJson } from './util.js';
import { t } from './i18n.js';

const HOVER_MS = 250;
const FOLDER_ICON = '📁';
const FOLDER_ICON_OPEN = '📂';

export class FolderTree {
  constructor(el, hooks) {
    this.el = el;
    this.hooks = hooks;           // { onPreview(sel), onLock(sel), onPinChanged() }
                                  // sel = { kind:'folder', path } | { kind:'crow', meta }（偽資料夾＝對話／今天／最近 7 天）
    this.exts = '';               // current exts param (affects counts)
    this.nodes = new Map();       // normPath -> node（最後建的那一列）
    this.twins = new Map();       // normPath -> [node…]：同一資料夾可能同時出現在「快速存取」和「本機」兩處，數字要一起更新
    this.rowNode = new WeakMap(); // row element -> node：方向鍵要走「畫面上那一列」，twins 不能只靠 nodes 查
    this.lockedSel = null;        // 唯一的「目前選取」：真資料夾或偽資料夾；hover 離開的還原、方向鍵、live 更新、麵包屑都認這一個
    this.previewSel = null;       // hover 預覽中的選取（不動鎖定）
    this.crowRows = new Map();    // 'crow:'+crowKey -> row：對話區的列是 main.js 建的，hover/高亮靠 attachCrow 登記進來
    this.hoverTimer = null;
    this.hoverRow = null;
    // 「只看有檔案的資料夾」開關：預設開。整棵子樹（含子資料夾）都沒有目前類型的檔案 → 藏起來
    try { this.hideEmpty = localStorage.getItem('riffleHideEmpty') !== '0'; } catch (_) { this.hideEmpty = true; }
    el.addEventListener('pointerleave', () => {
      this.clearHoverTimer();
      // 離開整個左欄 → 回到「鎖定」的選取：鎖的是資料夾回資料夾，鎖的是對話回對話
      if (this.previewSel && this.lockedSel && selKey(this.previewSel) !== selKey(this.lockedSel)) {
        this.setPreviewSel(null);
        this.hooks.onPreview(this.lockedSel);
      }
    });
  }

  // 相容層：只想知道「鎖定的是哪個真資料夾」的舊呼叫（isEmptyTree；偽資料夾鎖定時回 null）
  get lockedPath() { return this.lockedSel && this.lockedSel.kind === 'folder' ? this.lockedSel.path : null; }

  async boot() {
    const d = await apiJson('/api/drives');
    this.drives = d.drives;
    this.roots = d.roots;
    this.pinned = d.pinned;
    this.el.innerHTML = '';
    this.nodes.clear();
    this.twins.clear();

    // ---- 開關列（樹最上面，捲動時固定）
    const bar = document.createElement('label');
    bar.id = 'treeBar';
    bar.title = t('hideEmptyTitle');
    bar.innerHTML = `<input type="checkbox"> <span></span>`;
    const cb = bar.querySelector('input');
    bar.querySelector('span').textContent = t('hideEmpty');
    cb.checked = this.hideEmpty;
    cb.addEventListener('change', () => {
      this.hideEmpty = cb.checked;
      try { localStorage.setItem('riffleHideEmpty', cb.checked ? '1' : '0'); } catch (_) {}
      for (const arr of this.twins.values()) for (const n of arr) this.applyHide(n);
    });
    this.el.appendChild(bar);

    // ---- quick access: pinned folders + detected AI projects under roots
    this.secQuick = this.addSection(t('secQuick'));
    this.quickBody = document.createElement('div');
    this.el.appendChild(this.quickBody);
    this.secQuick.appendChild(this.quickBody);
    const aiProjects = [];
    for (const root of this.roots) {
      try {
        const r = await apiJson('/api/list?path=' + encodeURIComponent(root) +
          '&nofiles=1&exts=' + encodeURIComponent(this.exts || 'readable'));
        for (const dir of r.dirs) if (dir.ai) aiProjects.push(dir);
      } catch (_) {}
    }
    const quickEntries = [
      ...this.pinned.map(p => ({ path: p, name: baseName(p), pin: true })),
      ...aiProjects.filter(a => !this.pinned.some(p => samePath(p, a.path)))
        .map(a => ({ path: a.path, name: a.name, pin: false, ai: true, count: a.fileCount, deep: a.deepCount, subs: a.hasSubdirs }))
    ];
    if (!quickEntries.length) {
      const d = document.createElement('div');
      d.id = 'treeHint';
      d.textContent = t('treeEmpty');
      this.quickBody.appendChild(d);
    }
    for (const q of quickEntries) this.addNode(this.quickBody, q.path, q.name, 0, { quick: true, ai: !!q.ai, count: q.count, deep: q.deep, subs: q.subs });

    // ---- local: drives + config roots
    const secLocal = this.addSection(t('secLocal'));
    this.localBody = document.createElement('div');
    secLocal.appendChild(this.localBody);
    const rootNorms = new Set(this.roots.map(p => norm(p)));
    for (const drv of this.drives) this.addNode(this.localBody, drv.path, /^[A-Za-z]:[\\/]?$/.test(drv.path) ? t('driveLabel', { d: drv.path.slice(0, 2) }) : drv.path, 0, { drive: true });
    for (const r of this.roots) {
      if (isCoveredByDrive(r, this.drives) && !rootNorms.has(norm(r))) continue;
      this.addNode(this.localBody, r, baseName(r) + t('rootSuffix'), 0, { root: true });
    }
    this.refreshTopCounts(true);
    return d;
  }

  addSection(title) {
    const sec = document.createElement('div');
    const h = document.createElement('div');
    h.className = 'sec';
    h.textContent = title;
    sec.appendChild(h);
    this.el.appendChild(sec);
    return sec;
  }

  addNode(parentEl, path, label, depth, opts = {}) {
    const row = document.createElement('div');
    row.className = 'trow';
    row.dataset.path = path;
    row.style.paddingLeft = (6 + depth * 14) + 'px';
    row.innerHTML =
      `<span class="tw leaf">▶</span>` +
      `<span class="fico">${FOLDER_ICON}</span>` +
      `<span class="nm" title="${escapeAttr(path)}">${escapeHtml(label)}</span>` +
      (opts.ai ? `<span class="ai">AI</span>` : '') +
      `<span class="cnt"></span>` +
      `<span class="star${opts.quick && this.isPinned(path) ? ' on' : ''}" title="${t('pinTitle')}">★</span>`;
    const kidsBox = document.createElement('div');
    kidsBox.className = 'tkids';   // 結構標記：方向鍵 ←（回父層）靠它認「這列是誰的子層」
    kidsBox.style.display = 'none';
    parentEl.appendChild(row);
    parentEl.appendChild(kidsBox);

    const node = {
      path, row, kidsBox, depth, opts,
      expanded: false, loaded: false, loading: false,
      tw: row.querySelector('.tw'), cnt: row.querySelector('.cnt'),
      star: row.querySelector('.star'), fico: row.querySelector('.fico')
    };
    this.nodes.set(norm(path), node);
    this.rowNode.set(row, node);
    { const k = norm(path); const arr = this.twins.get(k) || []; arr.push(node); this.twins.set(k, arr); }
    node.count = opts.count == null ? null : opts.count;
    node.deep = opts.deep; node.subs = opts.subs;
    this.showCount(node);

    node.tw.addEventListener('click', e => { e.stopPropagation(); this.toggle(node); });
    row.addEventListener('click', e => {
      if (e.target === node.star) return;
      this.lock(path);
    });
    node.star.addEventListener('click', async e => {
      e.stopPropagation();
      await this.togglePin(node);
    });
    row.addEventListener('pointerenter', () => {
      this.hoverRow = row;
      // 切類型後樹會重排（空資料夾藏起來），滑鼠沒動、底下卻換成別的資料夾 → 不算「指到」，
      // 否則會自動預覽那個資料夾，看起來像「盯不住原本的資料夾」。要真的動一下滑鼠才算。
      if (this.freezeHover) return;
      this.clearHoverTimer();
      this.hoverTimer = setTimeout(() => {
        this.hoverTimer = null;
        const sel = { kind: 'folder', path };
        if (this.lockedSel && selKey(this.lockedSel) === selKey(sel)) return;   // 已鎖這列：不用再預覽
        this.setPreviewSel(sel);
        this.hooks.onPreview(sel);
      }, HOVER_MS);
    });
    row.addEventListener('pointerleave', () => {
      if (this.hoverRow === row) { this.clearHoverTimer(); this.hoverRow = null; }
    });
    // discover lazily whether the node has children only when first hovered/expanded;
    // chevron starts hidden for drives? Drives always show chevron.
    if (opts.drive || opts.quick || opts.root) node.tw.classList.remove('leaf');
    return node;
  }

  clearHoverTimer() { if (this.hoverTimer) { clearTimeout(this.hoverTimer); this.hoverTimer = null; } }

  isPinned(path) { return this.pinned.some(p => samePath(p, path)); }

  async toggle(node) {
    if (node.expanded) {
      node.expanded = false;
      node.kidsBox.style.display = 'none';
      node.tw.textContent = '▶';
      node.fico.textContent = FOLDER_ICON;
      return;
    }
    node.expanded = true;
    node.kidsBox.style.display = '';
    node.tw.textContent = '▼';
    node.fico.textContent = FOLDER_ICON_OPEN;
    if (!node.loaded && !node.loading) await this.loadChildren(node);
  }

  async loadChildren(node) {
    node.loading = true;
    if (!node.loaded) node.cnt.textContent = '…';
    try {
      const r = await apiJson('/api/list?path=' + encodeURIComponent(node.path) +
        '&nofiles=1&exts=' + encodeURIComponent(this.exts || 'readable'));
      node.kidsBox.innerHTML = '';
      for (const dir of r.dirs) {
        const child = this.addNode(node.kidsBox, dir.path, dir.name, node.depth + 1,
          { ai: dir.ai, pinned: dir.pinned });
        if (dir.hasSubdirs) child.tw.classList.remove('leaf');
        child.count = dir.fileCount; child.deep = dir.deepCount; child.subs = !!dir.hasSubdirs;
        this.showCount(child);
      }
      node.loaded = true;
      this.showCount(node);
      if (!r.dirs.length) node.tw.classList.add('leaf');
    } catch (err) {
      node.cnt.textContent = '!';
    }
    node.loading = false;
  }

  // 資料夾名稱後面的數字：這一層（不含子資料夾）符合目前檔案類型（chips）的檔案數
  // 這個資料夾「整棵子樹」是否確定沒有目前類型的檔案（有索引就看 deep；沒有就只在「沒檔案也沒子資料夾」時才確定）
  isEmptyTree(node) {
    if (node.opts.drive || node.opts.root || this.isPinned(node.path)) return false;
    if (this.lockedPath && (norm(this.lockedPath) === norm(node.path) || norm(this.lockedPath).startsWith(norm(node.path) + '\\') || norm(this.lockedPath).startsWith(norm(node.path) + '/'))) return false;   // 正在看的資料夾和它的上層永遠不藏
    if (node.deep != null) return node.deep === 0;
    return node.count === 0 && node.subs === false;
  }
  applyHide(node) {
    const hide = this.hideEmpty && this.isEmptyTree(node);
    node.row.style.display = hide ? 'none' : '';
    if (hide) node.kidsBox.style.display = 'none';
    else if (node.expanded) node.kidsBox.style.display = '';
  }
  showCount(node) {
    const n = node.count, d = node.deep;
    if (n === 0 && d > 0) {
      node.cnt.textContent = '↳' + d;
      node.cnt.classList.remove('zero');
      node.cnt.classList.add('deep');
      node.cnt.title = t('countDeepTitle', { d });
    } else {
      node.cnt.textContent = n == null ? '' : String(n);
      node.cnt.classList.remove('deep');
      node.cnt.classList.toggle('zero', n === 0);
      node.cnt.title = n == null ? '' : (d != null && d > n ? t('countBothTitle', { n, d }) : t('countTitle', { n }));
    }
    this.applyHide(node);
  }
  // 最上層（快速存取、磁碟、roots）沒有父層清單可帶數字，自己查一次
  async refreshTopCounts(onlyMissing) {
    const exts = this.exts || 'readable';
    const jobs = [];
    // 快速存取的數字：直接列一次「根目錄」就全部拿到（以前是每個專案各列一次，十幾個請求）
    const quickUnder = new Set();
    for (const root of this.roots || []) {
      jobs.push(apiJson('/api/list?path=' + encodeURIComponent(root) + '&nofiles=1&exts=' + encodeURIComponent(exts))
        .then(r => {
          if (exts !== (this.exts || 'readable')) return;
          for (const dir of r.dirs) {
            this.setCounts(dir);
          }
        }).catch(() => {}));
    }
    for (const n of this.nodes.values()) {
      if (n.depth !== 0 || (onlyMissing && n.count != null)) continue;
      // 磁碟根目錄不數（C:\ 這層幾乎沒檔案，G: 雲端硬碟列一次要好幾秒，會拖慢整個伺服器）；
      // 快速存取的專案由上面的根目錄清單帶數字
      if (n.opts.drive || (n.opts.quick && (this.roots || []).some(r => isDirectChild(r, n.path)))) continue;
      jobs.push(apiJson('/api/list?path=' + encodeURIComponent(n.path) + '&exts=' + encodeURIComponent(exts))
        .then(r => { if (exts === (this.exts || 'readable')) this.setCounts({ path: n.path, fileCount: (r.files || []).length, deepCount: r.deepCount, hasSubdirs: (r.dirs || []).length > 0 }); })
        .catch(() => {}));
    }
    await Promise.all(jobs);
  }

  // 對話／「今天・最近 7 天」列（main.js 建的 DOM）接進同一套 hover 機器：
  // 同 HOVER_MS、同 freezeHover 規則；快速掃過不發請求（計時器還沒到就被清掉）。
  // 點擊不歸這裡管——main 的 openConvo/openRecent 走 lockCrow 鎖定。
  attachCrow(row, meta) {
    const key = 'crow:' + crowKey(meta);
    this.crowRows.set(key, row);
    row.dataset.crow = key;
    row.addEventListener('pointerenter', () => {
      this.hoverRow = row;
      // 同資料夾列：切類型重排後滑鼠沒動卻「指到」換位的列，不算指到
      if (this.freezeHover) return;
      this.clearHoverTimer();
      this.hoverTimer = setTimeout(() => {
        this.hoverTimer = null;
        if (this.lockedSel && selKey(this.lockedSel) === key) return;   // 已鎖這列
        this.setPreviewSel({ kind: 'crow', meta });
        this.hooks.onPreview({ kind: 'crow', meta });
      }, HOVER_MS);
    });
    row.addEventListener('pointerleave', () => {
      if (this.hoverRow === row) { this.clearHoverTimer(); this.hoverRow = null; }
    });
  }

  // 選取 → 畫面上的那一列：資料夾查 nodes；偽資料夾查 crowRows（區塊重建後舊列 isConnected=false）
  selRow(sel) {
    if (!sel) return null;
    if (sel.kind === 'crow') {
      const r = this.crowRows.get(selKey(sel));
      return r && r.isConnected ? r : null;
    }
    const n = this.nodes.get(norm(sel.path));
    return n ? n.row : null;
  }

  // hover 預覽高亮（空心框）；null＝清掉
  setPreviewSel(sel) {
    if (this.previewSel) {
      const old = this.selRow(this.previewSel);
      if (old) old.classList.remove('preview');
    }
    this.previewSel = sel;
    if (!sel) return;
    const r = this.selRow(sel);
    const lr = this.selRow(this.lockedSel);
    if (r && r !== lr) r.classList.add('preview');
  }

  // node 在樹上的「父節點」（同一資料夾的不同 twin 各自獨立）：往上一層是它的 kidsBox 容器，
  // 容器前一個兄弟就是父節點自己的 row。最上層（磁碟／快速存取）直接掛在區塊裡 → 沒父節點
  parentOf(node) {
    const kb = node.row.parentElement;
    if (!kb || !kb.classList.contains('tkids')) return null;
    const prow = kb.previousElementSibling;
    return (prow && this.rowNode.get(prow)) || null;
  }

  lock(path, node) {
    // 「同時最多一個實心選取」鐵律：不清只記得的上一個，直接掃整棵樹的 .sel
    // （boot 或其他路徑殘留的 sel 也一併清掉），再標到新的鎖定節點上
    for (const r of this.el.querySelectorAll('.trow.sel')) r.classList.remove('sel');
    this.setPreviewSel(null);
    this.lockedSel = { kind: 'folder', path };
    const n = node || this.nodes.get(norm(path));
    if (n) n.row.classList.add('sel');
    return this.hooks.onLock(this.lockedSel);   // 回傳 onLock 的 Promise：呼叫方要等檔案載完才做下一步
  }

  // 鎖定一列偽資料夾（對話／今天／最近 7 天）：main 的 openConvo/openRecent 叫。
  // 只負責「鎖定選取」狀態＋高亮；載檔案由 main 自己做。
  lockCrow(meta, row) {
    for (const r of this.el.querySelectorAll('.trow.sel')) r.classList.remove('sel');
    this.setPreviewSel(null);
    this.lockedSel = { kind: 'crow', meta };
    if (row) row.classList.add('sel');
  }

  async togglePin(node) {
    const want = !this.isPinned(node.path);
    node.star.classList.toggle('on', want);
    try {
      const r = await apiJson('/api/pin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: node.path, pinned: want })
      });
      this.pinned = r.pinned;
      await this.hooks.onPinChanged();
    } catch (_) {
      node.star.classList.toggle('on', !want); // revert
    }
  }

  // chips changed → counts are stale; refresh every loaded node
  async setExts(exts) {
    if (exts === this.exts) return;
    this.exts = exts;
    this.clearHoverTimer();
    this.freezeHover = true;
    const unfreeze = e => {
      if (Math.abs(e.movementX) + Math.abs(e.movementY) < 2) return;
      this.freezeHover = false; this.el.removeEventListener('pointermove', unfreeze);
    };
    this.el.addEventListener('pointermove', unfreeze);
    const jobs = [];
    // 已展開的資料夾：只更新子資料夾的數字（不重建 DOM——重建會把展開狀態收掉、數字先變「…」再跳）
    for (const arr of this.twins.values()) for (const n of arr) if (n.loaded && n.row.isConnected) jobs.push(this.refreshChildCounts(n));
    jobs.push(this.refreshTopCounts(false));
    await Promise.all(jobs);
  }
  async refreshChildCounts(node) {
    const exts = this.exts || 'readable';
    try {
      const r = await apiJson('/api/list?path=' + encodeURIComponent(node.path) + '&nofiles=1&exts=' + encodeURIComponent(exts));
      if (exts !== (this.exts || 'readable')) return;              // 期間又切了別的類型：丟掉舊結果
      for (const dir of r.dirs) this.setCounts(dir);
    } catch (_) {}
  }
  // 同一個資料夾的每一列（快速存取＋本機樹）一起更新數字
  setCounts(dir) {
    for (const c of this.twins.get(norm(dir.path)) || []) {
      c.count = dir.fileCount; c.deep = dir.deepCount; c.subs = !!dir.hasSubdirs;
      this.showCount(c);
    }
  }
}

function isDirectChild(root, p) {
  const r = norm(root), q = norm(p);
  if (!q.startsWith(r + '\\') && !q.startsWith(r + '/')) return false;
  return !/[\\/]/.test(q.slice(r.length + 1));
}

function baseName(p) {
  const s = String(p).replace(/[/\\]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}
function norm(p) { return String(p).replace(/[/\\]+$/, '').toLowerCase(); }
function samePath(a, b) { return norm(a) === norm(b); }
// 選取 key：真資料夾認路徑（大小寫不敏感）；偽資料夾認種類＋id（recent<hours> / convo:<id>）
function crowKey(meta) {
  if (meta && meta.pile) return 'pile:' + meta.id;
  return meta && meta.hours != null ? 'recent' + Number(meta.hours) : 'convo:' + (meta && meta.id);
}
function selKey(sel) { return !sel ? '' : (sel.kind === 'crow' ? 'crow:' + crowKey(sel.meta) : 'folder:' + norm(sel.path)); }
function isCoveredByDrive() { return false; } // roots listed even when on a drive (they are scoped favourites)
function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }
