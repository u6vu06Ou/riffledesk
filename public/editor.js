// editor.js — 閱讀區的「✎ 編輯」：CodeJar（vendored MIT）＋ highlight.js＝輕量程式碼編輯器。
// 原則：
//  · 可見控制：標題列的 💾 存檔（Ctrl+S）／取消（Esc）只在編輯中出現；md 有 預覽|編輯 分段鈕
//  · 大檔（>96 KB）不下語法色（每鍵重亮會卡），查找的 <mark> 仍照常
//  · 行號槽是自己的 div（CodeJar v4 沒有內建行號）；Tab＝縮排；游標/捲動位置留住
//  · 存檔走 POST /api/save；409 → 三路對話框（看差異／蓋過／放棄）；外部改過會被擋下
import { CodeJar } from './vendor/codejar.js';
import { t } from './i18n.js';

const HL_MAX_BYTES = 96 * 1024;   // 編輯器語法色上限（唯讀檢視是 200 KB：一次亮完 vs. 每鍵都亮）

export class EditorSession {
  // reader 提供 anchor（body）、檔案資訊、以及 hooks{ ask, toast, onDirty, onSaved, syncHeader }
  constructor(reader, hooks) {
    this.reader = reader;
    this.hooks = hooks;
    this.active = false;
    this.jar = null;
    this.dirty = false;
    this.file = null;
    this.baseMtime = 0;
    this.baseSize = 0;
    this.text0 = '';          // 進編輯時的原文（放棄修改就回它）
    this.marks = null;        // find 傳進來的命中偏移（null＝不標）
    this.markCur = -1;
    this._markEls = [];
    this.wrapEl = null;
    this.gutterEl = null;
  }

  isActive() { return this.active; }
  el() { return this.wrapEl && this.wrapEl.querySelector('.ev-editor'); }

  // ---- 進入編輯 ----
  // text：reader 已讀到的全文（JSON 用「原始檔」不是 pretty 版）；file 帶 size/mtime 當比對基準
  enter(file, text) {
    this.exitDomOnly();
    this.active = true;
    this.dirty = false;
    this.file = file;
    this.text0 = text;
    this.baseMtime = file.mtime;
    this.baseSize = file.size;

    const body = this.reader.body;
    const savedScroll = body.scrollTop;
    body.className = 'edit';
    body.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'editview';
    const gutter = document.createElement('div');
    gutter.className = 'ev-gutter';
    const ed = document.createElement('div');
    ed.className = 'ev-editor hljs';   // hljs 類名＝背景/色票沿用 codetheme 主題
    ed.setAttribute('aria-label', t('editAria'));
    wrap.appendChild(gutter);
    wrap.appendChild(ed);
    body.appendChild(wrap);
    this.wrapEl = wrap; this.gutterEl = gutter;

    const bytes = file.size || 0;
    const useHl = bytes <= HL_MAX_BYTES && typeof hljs !== 'undefined';
    const lang = langOf(file);
    const me = this;

    this.jar = CodeJar(ed, () => me.render(), { tab: '  ', catchTab: true, history: true });
    this._useHl = useHl; this._lang = lang;
    this.jar.updateCode(text);
    this.jar.onUpdate(() => {
      if (!this.dirty) { this.dirty = true; this.hooks.onDirty(true); }
      this.syncGutterSoon();
    });
    this.syncGutter();
    body.scrollTop = savedScroll;

    // 行號槽跟著捲
    ed.addEventListener('scroll', () => { gutter.scrollTop = ed.scrollTop; }, { passive: true });
    this.hooks.syncHeader();
    return this;
  }

  // 高亮總管：離開位 withLineNumbers 沒有，所以行號自己算；
  // find 開著時跳過語法色，只插 <mark class="fhit">（偏移對文字節點位置是穩的）
  render() {
    const ed = this.el();
    if (!ed) return;
    const txt = this.jar.toString();
    if (this.marks === null && this._useHl && this._lang) {
      try {
        const hl = hljs.highlight(txt, { language: this._lang, ignoreIllegals: true }).value;
        if (new DOMParser && false) {} // （保留：CSP 不准 innerHTML 寫非信任串；hljs 輸出是信任內容）
        ed.innerHTML = hl;
      } catch (_) { ed.textContent = txt; }
    } else {
      ed.innerHTML = markHtml(txt, this.marks || []);
    }
    this.collectMarkEls();
    this.syncGutter();
  }

  collectMarkEls() {
    const ed = this.el();
    this._markEls = ed ? [...ed.querySelectorAll('mark.fhit')] : [];
    this._markEls.forEach((m, i) => m.classList.toggle('cur', i === this.markCur));
  }

  setMarks(hits, cur) {           // hits=null → 關查找標亮（回語法色）
    if (!this.active) return;
    this.marks = hits;
    if (cur !== undefined) this.markCur = cur;
    // 標亮切換＝整份重畫（CodeJar 會守住游標）
    this.render();
  }
  setMarkCur(cur) {
    this.markCur = cur;
    this._markEls.forEach((m, i) => m.classList.toggle('cur', i === cur));
  }

  syncGutterSoon() {
    if (this._gz) return;
    this._gz = requestAnimationFrame(() => { this._gz = null; this.syncGutter(); });
  }
  syncGutter() {
    if (!this.gutterEl || !this.active) return;
    const n = this.jar ? (this.jar.toString().match(/\n/g) || []).length + 1 : 1;
    if (n === this._gutterN) return;
    this._gutterN = n;
    let s = '';
    for (let i = 1; i <= n; i++) s += i + '\n';
    this.gutterEl.textContent = s;
  }

  text() { return this.jar ? this.jar.toString() : ''; }
  focusEditor() { this.el()?.focus(); }

  // find 在編輯器內走位：捲到第 i 個命中
  scrollToHit(i, hits) {
    const m = this._markEls[i];
    if (m) { m.scrollIntoView({ block: 'center' }); return; }
    // mark 元素還沒畫出（hits 剛更新）：直接按行號捲
    const h = hits && hits[i];
    if (!h) return;
    const line = (this.text().slice(0, h.off).match(/\n/g) || []).length;
    const ed = this.el();
    if (ed) ed.scrollTop = Math.max(0, line * 21 - ed.clientHeight / 2);
  }

  // 取代：改 buffer（jar.updateCode 會守住游標附近的畫面）
  replaceHit(hit, rep) {
    if (!this.active) return null;
    const cur = this.text();
    const next = cur.slice(0, hit.off) + rep + cur.slice(hit.off + hit.len);
    this.jar.updateCode(next);
    return rep.length - hit.len;   // 位移量（後續偏移由 find.run() 重算）
  }
  replaceAll(q, rep, caseOn) {
    if (!this.active || !q) return 0;
    const cur = this.text();
    const re = new RegExp(escapeRe(q), caseOn ? 'g' : 'gi');
    if (!re.test(cur)) { re.lastIndex = 0; return 0; }
    re.lastIndex = 0;
    this.jar.updateCode(cur.replace(re, rep));
    return 1;
  }

  // ---- 存檔 ----
  async save() {
    if (!this.active) return;
    const file = this.file;
    try {
      const r = await fetch('/api/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: file.path, content: this.text(),
          baseMtime: this.baseMtime, baseSize: this.baseSize
        })
      });
      const d = await r.json().catch(() => null);
      if (r.ok && d && d.ok) {
        this.baseMtime = d.mtime; this.baseSize = d.size;
        this.dirty = false;
        this.hooks.onDirty(false);
        this.hooks.onSaved(file, { ...d }, d.undoable !== false);
        return true;
      }
      if (r.status === 409 && d) { this.showConflict(d); return false; }
      this.hooks.toast(t('opFail', { msg: (d && d.error) || ('http ' + r.status) }));
      return false;
    } catch (err) {
      this.hooks.toast(t('opFail', { msg: String(err && err.message || err) }));
      return false;
    }
  }

  // ---- 衝突對話框：看差異／用我的版本蓋過／放棄我的修改 ----
  showConflict(d) {
    const dlg = document.getElementById('editConflict');
    dlg.querySelector('.ttl').textContent = t('conflictTitle', { name: this.file.name });
    const diffBox = dlg.querySelector('.diff');
    diffBox.classList.remove('on');
    diffBox.innerHTML = '';
    dlg.classList.add('on');
    const close = () => dlg.classList.remove('on');

    const mine = this.text();
    const disk = typeof d.content === 'string' ? d.content : null;

    dlg.querySelector('[data-c="diff"]').onclick = () => {
      if (disk == null) { diffBox.innerHTML = `<p class="msg-dim">${escapeHtml(t('conflictNoDisk'))}</p>`; diffBox.classList.add('on'); return; }
      diffBox.innerHTML = diffHtml(mine, disk);
      diffBox.classList.add('on');
    };
    dlg.querySelector('[data-c="overwrite"]').onclick = async () => {
      // 伺服器回的新 mtime/size 當基準再送一次＝明確蓋過
      this.baseMtime = d.mtime; this.baseSize = d.size;
      close();
      await this.save();
    };
    dlg.querySelector('[data-c="drop"]').onclick = () => {
      close();
      if (disk != null) {
        this.jar.updateCode(disk);
        this.baseMtime = d.mtime; this.baseSize = d.size;   // 跟磁碟站齊：不再是髒的
        this.dirty = false;
        this.hooks.onDirty(false);
      }
      this.hooks.onDropped?.();
    };
    dlg.onclick = e => { if (e.target === dlg) close(); };
  }

  // ---- 離開編輯（dirtyGuard 在 reader.js 攔） ----
  exitDomOnly() {
    if (this.jar) { try { this.jar.destroy(); } catch (_) {} }
    this.jar = null;
    this.wrapEl = null; this.gutterEl = null; this._markEls = [];
    this.active = false;
    this.dirty = false;
    this._gutterN = 0;
  }
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
// 純轉義文字＋命中段包 mark；換行就是 \n（white-space: pre 排版）
function markHtml(txt, marks) {
  if (!marks || !marks.length) return escapeHtml(txt);
  let out = '', last = 0;
  for (const h of marks) {
    if (h.off < last) continue;             // 保險：不切重疊
    out += escapeHtml(txt.slice(last, h.off));
    out += '<mark class="fhit">' + escapeHtml(txt.slice(h.off, h.off + h.len)) + '</mark>';
    last = h.off + h.len;
  }
  return out + escapeHtml(txt.slice(last));
}
// 與 kindOf 對齊的語言對映（編輯器用；json 編輯的是原始檔不是 pretty 版）
function langOf(file) {
  const k = file.kind;
  if (k === 'json') return 'json';
  if (k === 'html') return 'xml';
  if (k === 'markdown') return 'markdown';
  if (k === 'code') {
    const e = (file.ext || '').toLowerCase();
    const MAP = {
      '.js': 'javascript', '.mjs': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
      '.py': 'python', '.css': 'css', '.scss': 'scss', '.less': 'less', '.html': 'xml', '.xml': 'xml',
      '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'ini', '.ini': 'ini', '.cfg': 'ini',
      '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp', '.cs': 'csharp', '.java': 'java',
      '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php', '.sh': 'bash', '.bash': 'bash',
      '.bat': 'dos', '.ps1': 'powershell', '.sql': 'sql', '.lua': 'lua', '.vue': 'xml', '.md': 'markdown'
    };
    return MAP[e] || null;
  }
  return null;   // text/table：無語言 → 不亮語法（但表格檔其實是 csv 純文字）
}

// ---- 極簡行差異（LCS；>2000 行直接放棄，免得對話框卡死） ----
function diffHtml(mine, disk) {
  const A = disk.split('\n'), B = mine.split('\n');
  if (A.length > 2000 || B.length > 2000) {
    return `<p class="msg-dim">${escapeHtml(t('conflictDiffTooBig'))}</p>`;
  }
  const rows = lcsDiff(A, B);
  let html = `<div class="df-col df-old"><div class="df-head">${escapeHtml(t('conflictDisk'))}</div>`;
  let added = 0, removed = 0;
  for (const r of rows) if (r.t === '-') removed++; else if (r.t === '+') added++;
  html = `<div class="df-stat">−${removed} / +${added}</div>`;
  for (const r of rows) {
    if (r.t === ' ') continue;                 // 相同的行不列出（太多）
    html += `<div class="df-l ${r.t === '+' ? 'add' : 'del'}">${r.t === '+' ? '+' : '−'} ${escapeHtml(r.s)}</div>`;
  }
  return html;
}
function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', s: a[i] }); i++; }
    else { out.push({ t: '+', s: b[j] }); j++; }
  }
  while (i < n) out.push({ t: '-', s: a[i++] });
  while (j < m) out.push({ t: '+', s: b[j++] });
  return out;
}
