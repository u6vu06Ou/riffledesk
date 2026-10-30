// find.js — 閱讀區的「🔍 查找」（Ctrl+F）：標亮全部命中＋第 k/共 N 筆走位。
// 三種目標：
//   rendered — body DOM 的文字節點（程式碼檢視／markdown／表格／純文字都行；行號槽不算）
//   buffer   — 編輯器：命中只算偏移清單，上色由編輯器的高亮器注入 <mark class="fhit">
//   iframe   — srcdoc 安全預覽的 document（同源才能搜）；執行中的網頁是 opaque origin，
//              外層碰不到 → 顯示提示，不搜
// 大檔不卡：命中清單分片算（8ms 時間片讓出主執行緒），標亮的 DOM 節點數有上限。
import { t } from './i18n.js';

const MARK_CAP = 2000;      // DOM 標亮／導航的命中上限；超出顯示「共 2000+ 筆」
const TIME_SLICE_MS = 8;    // 每個工作片最多跑這麼久就讓出一幀
const TEXT_BAG_CAP = 12 * 1024 * 1024;

export class FindBar {
  // reader 提供：body 元素、getTarget()、onDirtyRequest()（編輯中換字要重搜）
  constructor(reader) {
    this.reader = reader;
    this.el = document.getElementById('findBar');
    this.q = this.el.querySelector('.fq');
    this.countEl = this.el.querySelector('.fc');
    this.btnCase = this.el.querySelector('.fcase');
    this.btnPrev = this.el.querySelector('.fup');
    this.btnNext = this.el.querySelector('.fdown');
    this.btnClose = this.el.querySelector('.fclose');
    this.repRow = this.el.querySelector('.frep-row');
    this.rep = this.el.querySelector('.frep');
    this.btnRep1 = this.el.querySelector('.frep1');
    this.btnRepAll = this.el.querySelector('.frepall');

    this.isOpen = false;
    this.caseOn = false;
    this.hits = [];        // { off, len } ＝文字偏移；rendered 模式下外加 node 對映
    this.marks = [];       // 已標亮的 <mark>（rendered/iframe）
    this.cur = -1;
    this.total = 0;        // 完整命中數（可能 > MARK_CAP）
    this.truncated = false;
    this.bag = '';         // 目標全文（rendered/iframe 模式由各文字節點串成）
    this.gen = 0;          // 非同步作廢號：換查詢／換檔時舊分片結果直接丟

    this.q.addEventListener('input', () => this.schedule());
    this.q.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) this.prev(); else this.next(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
    });
    this.rep.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.replaceOne(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
    });
    this.btnCase.addEventListener('click', () => {
      this.caseOn = !this.caseOn;
      this.btnCase.classList.toggle('on', this.caseOn);
      this.schedule();
    });
    this.btnPrev.addEventListener('click', () => this.prev());
    this.btnNext.addEventListener('click', () => this.next());
    this.btnClose.addEventListener('click', () => this.close());
    this.btnRep1.addEventListener('click', () => this.replaceOne());
    this.btnRepAll.addEventListener('click', () => this.replaceAll());
  }

  open() {
    if (this.isOpen) { this.q.focus(); this.q.select(); return; }
    this.isOpen = true;
    this.el.hidden = false;
    this.syncReplaceRow();
    this.q.focus(); this.q.select();
    if (this.q.value) this.run();
    else this.setCount(0, 0);
  }
  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.hidden = true;
    this.gen++;                       // 作廢進行中的分片
    this.clearMarks();
    this.hits = []; this.marks = []; this.cur = -1; this.total = 0;
    this.reader.findClosed?.();
    // 焦點還給內文（編輯中就回編輯器）
    (this.reader.activeEditorEl() || this.reader.body).focus?.();
  }

  syncReplaceRow() {                 // 取代列只在編輯模式出現
    this.repRow.hidden = !this.reader.editing();
  }

  schedule() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.run(), 180);
  }

  // ---------- 主流程 ----------
  async run() {
    const gen = ++this.gen;
    this.clearMarks();
    this.hits = []; this.marks = []; this.cur = -1; this.total = 0; this.truncated = false;
    const q = this.q.value;
    if (!q || !this.isOpen) { this.setCount(0, 0); this.reader.marksChanged?.([]); return; }
    const tgt = this.reader.findTarget();
    if (!tgt || tgt.type === 'none') { this.setCount(0, 0); return; }
    if (tgt.type === 'run-blocked') { this.countEl.textContent = t('findRunBlocks'); return; }

    const buf = tgt.type === 'buffer' ? tgt.text() : this.bagFromDom(tgt.doc);
    const cs = this.caseOn;

    if (tgt.type === 'buffer') {
      // 編輯器：只算偏移，<mark> 由編輯器高亮器畫
      const offs = await this.scanOffsets(buf, q, cs, gen);
      if (gen !== this.gen) return;
      this.hits = offs.hits; this.total = offs.total; this.truncated = offs.truncated;
      this.reader.marksChanged?.(this.hits);
      this.cur = this.hits.length ? 0 : -1;
      this.setCount(this.cur, this.total);
      if (this.cur >= 0) this.scrollToHit(this.cur);
      return;
    }

    // rendered / iframe：標亮要走 DOM；命中清單照樣分片算
    const offs = await this.scanOffsets(buf, q, cs, gen);
    if (gen !== this.gen) return;
    this.hits = offs.hits; this.total = offs.total; this.truncated = offs.truncated;
    await this.markDom(tgt.doc, offs.hits, q, gen);
    if (gen !== this.gen) return;
    this.cur = this.marks.length ? 0 : -1;
    this.setCount(this.cur, this.total);
    if (this.cur >= 0) this.revealCur();
  }

  // 依偏移把 DOM 文字節點切開包 <mark class="fhit">；分片跑，時間到就讓一幀
  async markDom(root, hits, q, gen) {
    if (!hits.length) return;
    const doc = root.ownerDocument || root;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement && n.parentElement.closest('.cv-gutter'))
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    let hi = 0, base = 0, t0 = performance.now();
    const nlen = q.length;
    for (const node of nodes) {
      if (gen !== this.gen) return;
      const len = node.nodeValue.length;
      const lo = base, hiEnd = base + len;
      const frags = [];
      while (hi < hits.length && hits[hi].off < hiEnd) {
        const h = hits[hi];
        const s = Math.max(h.off, lo) - lo, e = Math.min(h.off + h.len, hiEnd) - lo;
        if (s < e) frags.push([s, e]);
        if (h.off + h.len > hiEnd) break;   // 命中跨節點（極少見）：後段留給下一個節點
        hi++;
      }
      if (frags.length) {
        const text = node.nodeValue;
        const frag = doc.createDocumentFragment();
        let last = 0;
        for (const [s, e] of frags) {
          if (s > last) frag.appendChild(doc.createTextNode(text.slice(last, s)));
          const m = doc.createElement('mark');
          m.className = 'fhit';
          m.textContent = text.slice(s, e);
          frag.appendChild(m);
          this.marks.push(m);
          last = e;
        }
        if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
      }
      base = hiEnd;
      if (hi >= hits.length) break;
      if (performance.now() - t0 > TIME_SLICE_MS) {   // 讓出一幀，大檔不卡
        await new Promise(r => requestAnimationFrame(r));
        t0 = performance.now();
      }
    }
  }

  // 全文掃出命中偏移（分片＋時間片）；回 { hits, total, truncated }
  scanOffsets(buf, q, cs, gen) {
    return new Promise(resolve => {
      const hits = [];
      const n = buf.length;
      if (!n || !q) return resolve({ hits, total: 0, truncated: false });
      const hay = cs ? buf : buf.toLowerCase();
      const needle = cs ? q : q.toLowerCase();
      let i = 0, total = 0, truncated = false, t0 = performance.now();
      const step = () => {
        if (gen !== this.gen) return resolve({ hits, total, truncated });
        while (i < n) {
          const j = hay.indexOf(needle, i);
          if (j < 0) { i = n; break; }
          total++;
          if (hits.length < MARK_CAP) hits.push({ off: j, len: needle.length });
          else truncated = true;
          i = j + Math.max(needle.length, 1);
          if (performance.now() - t0 > TIME_SLICE_MS) {
            t0 = performance.now();
            return void requestAnimationFrame(step);
          }
        }
        resolve({ hits, total, truncated });
      };
      step();
    });
  }

  // rendered/iframe：目標全文＝各文字節點直接相接（span 邊界的命中也算）
  bagFromDom(root) {
    const owner = root.ownerDocument || root;
    const walker = owner.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement && n.parentElement.closest('.cv-gutter'))
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    const parts = [];
    let size = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      parts.push(n.nodeValue);
      size += n.nodeValue.length;
      if (size > TEXT_BAG_CAP) break;
    }
    return parts.join('');
  }

  clearMarks() {
    for (const m of this.marks) m.replaceWith(...m.childNodes);
    this.marks = [];
    const root = this.reader.findTarget()?.doc;
    // 把切開的文字節點縮回去（下一次標亮色才不會比對到碎節點）
    try { root?.normalize(); } catch (_) {}
    this.reader.marksChanged?.(null);     // null＝關閉標亮（編輯器恢復語法色）
  }

  // ---------- 走位 ----------
  next() { if (this.markedCount()) this.go((this.cur + 1) % this.markedCount()); }
  prev() { if (this.markedCount()) this.go((this.cur - 1 + this.markedCount()) % this.markedCount()); }
  markedCount() {
    return this.reader.editing() ? this.hits.length : this.marks.length;
  }
  go(i) {
    this.cur = i;
    this.setCount(this.cur, this.total);
    this.revealCur();
  }
  revealCur() {
    const tgt = this.reader.findTarget();
    if (tgt && tgt.type === 'buffer') { this.scrollToHit(this.cur); return; }
    this.marks.forEach((m, i) => m.classList.toggle('cur', i === this.cur));
    const m = this.marks[this.cur];
    if (m) m.scrollIntoView({ block: 'center', behavior: 'instant' in Element.prototype ? 'instant' : 'auto' });
  }
  scrollToHit(i) { this.reader.scrollToEditorHit?.(i, this.hits); this.updateCurClassInEditor(); }
  updateCurClassInEditor() { this.reader.markCurChanged?.(this.cur); }

  // ---------- 取代（編輯模式才有這列） ----------
  replaceOne() {
    if (!this.reader.editing() || !this.hits.length || this.cur < 0) return;
    const n = this.reader.replaceHit?.(this.hits[this.cur], this.rep.value);
    if (n == null) return;
    this.adjustAfterReplace(n);
    this.run();
  }
  replaceAll() {
    if (!this.reader.editing() || !this.q.value) return;
    this.reader.replaceAllHits?.(this.q.value, this.rep.value, this.caseOn);
    this.run();
  }
  adjustAfterReplace(_n) { /* 偏移由 run() 重算，這裡沒事 */ }

  setCount(curIdx, total) {
    if (!this.q.value) { this.countEl.textContent = ''; return; }
    const t2 = this.truncated ? `${MARK_CAP}+` : String(total);
    this.countEl.textContent = total === 0 ? t('findNone') : t('findCount', { k: curIdx + 1, n: t2 });
  }
}
