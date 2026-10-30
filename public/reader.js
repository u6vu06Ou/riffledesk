// reader panel: DOM content renderers for all supported kinds.
import { fmtSize, fmtDate, api, apiJson, KIND_LABEL, kindOf, kindColor, theme } from './util.js';
import { t } from './i18n.js';
import { renderCodeView, setCodeControlsVisible, extToLang, codeThemeNow } from './codetheme.js';
import { htmlVisibleText } from './mirror.js';
import { EditorSession } from './editor.js';
import { FindBar } from './find.js';
import { Revise } from './revise.js';

// 可以直接編輯的檔案類型（伺服器 /api/save 只收這些；md 另有 編輯/預覽 切換）
const EDIT_KINDS = new Set(['markdown', 'text', 'html', 'json', 'table', 'code']);

export class Reader {
  constructor() {
    this.el = document.getElementById('reader');
    this.kind = document.getElementById('readerKind');
    this.title = document.getElementById('readerTitle');
    this.meta = document.getElementById('readerMeta');
    this.secretEl = document.getElementById('readerSecret');
    this.scriptHintEl = document.getElementById('readerScriptHint');
    this.btnRun = document.getElementById('btnRun');
    this.btnSource = document.getElementById('btnSource');
    this.btnRevise = document.getElementById('btnRevise');
    this.btnUndo = document.getElementById('btnUndoTop');   // 復原鈕在工具列（全域看得見）
    this.btnFind = document.getElementById('btnFind');
    this.btnEdit = document.getElementById('btnEdit');
    this.btnSave = document.getElementById('btnSave');
    this.btnSaveExit = document.getElementById('btnSaveExit');
    this.btnCancelEdit = document.getElementById('btnCancelEdit');
    this.btnMdPreview = document.getElementById('btnMdPreview');
    this.btnClose = document.getElementById('btnClose');
    this.btnWrap = document.getElementById('btnWrap');
    this.guardEl = document.getElementById('editGuard');
    this.body = document.getElementById('readerBody');
    this.rawText = null;            // 這個檔的原始文字（編輯器進去時用；JSON 是原始檔不是 pretty 版）
    this.toast = () => {};
    this.undoAction = null;
    this.leaveCb = null;            // 未存擋下時，按「存檔並離開」後要跑的事
    this.mdPreview = true;          // md 編輯中：true＝預覽、false＝編輯
    this.file = null;
    this.openGen = 0;               // open() 世代號：連按 ▶／原始碼時，慢的那次結果直接丟掉
    this.vaultCache = new Map();    // 資料夾路徑（小寫）→ vault 根目錄 | null（本次 session 快取）
    this.linkCache = new Map();     // 起點資料夾+目標檔名（小寫）→ 解析到的路徑 | null
    // HTML 預覽的兩個逐檔切換（key＝路徑小寫，只活這個 session）：是否執行程式、是否看原始碼
    this.runPref = new Map();
    this.srcPref = new Map();
    // wikilink 用事件委派（body 內容每次重繪）
    this.body.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('a.obs-wikilink');
      if (!a) return;
      e.preventDefault();
      this.openWikilink(a).catch(err => console.warn('wikilink resolve failed:', err));
    });
    // ▶ 執行網頁程式：只切這個檔、這個 session；再按一次關掉回安全預覽
    this.btnRun.addEventListener('click', () => {
      if (!this.file || this.file.kind !== 'html') return;
      const k = pathKey(this.file.path);
      this.runPref.set(k, !this.htmlRunOn(this.file));
      this.open(this.file).catch(err => console.warn('html rerun failed:', err));
    });
    // ＜/＞ 原始碼 / 回到預覽
    this.btnSource.addEventListener('click', () => {
      if (!this.file || this.file.kind !== 'html') return;
      const k = pathKey(this.file.path);
      this.srcPref.set(k, !(this.srcPref.get(k) === true));
      this.open(this.file).catch(err => console.warn('html source view failed:', err));
    });
    // ✎ 改版：在畫面上直接點元素改（iframe 內由 revise-agent 接手）
    this.revise = new Revise(this);
    this.btnRevise.addEventListener('click', () => this.revise.toggle());

    // ---- 編輯／查找的控制（每顆都有快捷鍵，也都有按鈕） ----
    this.editor = new EditorSession(this, {
      toast: m => this.toast(m),
      onDirty: d => this.title.classList.toggle('dirty', d),
      onSaved: (file, info) => {
        this.toast(t('editSaved', { name: file.name }), this.undoAction ? this.undoAction() : null);
        this.syncEditButtons();
      },
      syncHeader: () => this.syncEditButtons()
    });
    this.find = new FindBar(this);
    this.btnFind.addEventListener('click', () => this.find.open());
    this.btnEdit.addEventListener('click', () => this.toggleEdit());
    this.btnSave.addEventListener('click', () => this.editor.save());
    this.btnSaveExit.addEventListener('click', async () => {
      if (await this.editor.save()) await this.exitEdit({ skipGuard: true });
    });
    this.btnCancelEdit.addEventListener('click', () => this.exitEdit({ force: true }));
    this.btnMdPreview.addEventListener('click', () => this.toggleMdPreview());
    this.guardEl.addEventListener('click', e => {
      const b = e.target.closest('button[data-c]');
      if (!b) return;
      const c = b.dataset.c;
      if (c === 'stay') { this.guardEl.classList.remove('on'); this.leaveCb = null; }
      else if (c === 'drop') { const cb = this.leaveCb; this.leaveCb = null; this.guardEl.classList.remove('on'); this.forceLeave(cb); }
      else if (c === 'save') {
        this.editor.save().then(ok => {
          if (!ok) return;
          const cb = this.leaveCb; this.leaveCb = null; this.guardEl.classList.remove('on');
          this.forceLeave(cb);
        });
      }
    });
    // 自己的存檔成功後：live 的「有新檔案」藥丸不該為自己跳（SSE 會晚一步才來）
    this.onOwnSave = null;
    // 介面主題翻轉：編輯器的配色跟著換（沿用 codetheme 的 data-ct 機制）
    addEventListener('themechange', () => {
      if (this.editor.isActive()) this.body.dataset.ct = codeThemeNow();
    });
  }

  // ---- 對外的小介面（find.js 會叫） ----
  editing() { return this.editor.isActive(); }
  activeEditorEl() { return this.editor.el(); }
  findTarget() {
    if (this.editor.isActive()) return { type: 'buffer', text: () => this.editor.text() };
    const f = this.file;
    if (!f) return { type: 'none' };
    const ifr = this.body.querySelector('iframe');
    if (ifr) {
      try {
        const d = ifr.contentDocument;
        if (!d || !d.body) return { type: 'run-blocked' };
        return { type: 'iframe', doc: d.body };
      } catch (_) { return { type: 'run-blocked' }; }
    }
    return { type: 'rendered', doc: this.body };
  }
  marksChanged(hits) {
    if (!this.editor.isActive()) return;
    this.editor.setMarks(hits === null ? null : hits, undefined);
  }
  markCurChanged(cur) { this.editor.setMarkCur(cur); }
  scrollToEditorHit(i, hits) { this.editor.scrollToHit(i, hits); }
  replaceHit(hit, rep) { return this.editor.replaceHit(hit, rep); }
  replaceAllHits(q, rep, cs) { return this.editor.replaceAll(q, rep, cs); }
  findClosed() {
    this.editor.setMarks(null);   // 關查找＝編輯器恢復語法色
  }

  // ---- 編輯 ----
  canEdit(file) {
    const f = file || this.file;
    return !!f && EDIT_KINDS.has(f.kind) && f.size <= 5 * 1024 * 1024;
  }
  syncEditButtons() {
    const on = this.editor.isActive();
    const editable = this.canEdit();
    this.btnEdit.hidden = !editable || on;
    this.btnEdit.disabled = !editable;
    this.btnSave.hidden = !on;
    this.btnSaveExit.hidden = !on;
    this.btnCancelEdit.hidden = !on;
    const md = on && this.file && this.file.kind === 'markdown';
    this.btnMdPreview.hidden = !md;
    if (md) {
      this.btnMdPreview.textContent = this.mdPreview ? '✎' : '👁';
      this.btnMdPreview.classList.toggle('on', !this.mdPreview);
    }
    this.btnFind.disabled = !this.file || this.file.kind === 'image' || this.file.kind === 'pdf' || this.file.kind === 'sheet';
    // 編輯中：把不相關的鈕收起來，讓檔名與存檔鈕有空間
    document.getElementById('btnMore').hidden = on;
    document.getElementById('btnSize').hidden = on;
    if (on) { this.btnRun.hidden = true; this.btnSource.hidden = true; this.btnWrap.hidden = true; this.btnRevise.hidden = true; }
  }

  async toggleEdit() {
    if (this.editor.isActive()) {
      if (await this.editor.save()) await this.exitEdit({ skipGuard: true });
      return;
    }
    await this.startEdit();
  }

  async startEdit() {
    const f = this.file;
    if (!f || !this.canEdit(f)) return;
    if (this.revise.active()) this.revise.detach();
    let text = this.rawText;
    if (text == null) {
      const r = await api('/api/file?path=' + encodeURIComponent(f.path));
      text = await r.text();
      if (this.file !== f) return;
    }
    this.rawText = text;
    // 編輯器配色沿用目前的程式碼配色（data-ct → codetheme 注入的 --cv-* 變數）
    this.body.dataset.ct = codeThemeNow();
    this.mdPreview = false;
    this.editor.enter(f, text);
    this.find.syncReplaceRow();
    this.syncEditButtons();
    this.editor.focusEditor();
  }

  toggleMdPreview() {
    if (!this.editor.isActive() || !this.file || this.file.kind !== 'markdown') return;
    this.mdPreview = !this.mdPreview;
    if (this.mdPreview) this.showEditPreview();
    else { this.body.className = 'edit'; this.body.innerHTML = ''; this.body.appendChild(this.editor.wrapEl); this.editor.focusEditor(); }
    this.syncEditButtons();
  }

  // md 預覽：把編輯器內容現渲染成 md（不寫檔）
  showEditPreview() {
    if (!this.file) return;
    const text = this.editor.text();
    if (typeof marked === 'undefined') { this.body.className = 'md'; this.body.innerHTML = '<pre></pre>'; this.body.querySelector('pre').textContent = text; return; }
    const { fm, body: mdBody } = splitFrontmatter(text);
    const prepped = mapOutsideCode(mdBody, seg => obsidianInline(seg, this.file.path));
    const raw = marked.parse(prepped);
    const purify = typeof DOMPurify !== 'undefined';
    this.body.className = 'md';
    this.body.innerHTML = purify ? DOMPurify.sanitize(raw) : '';
    if (!purify) { this.body.innerHTML = '<pre></pre>'; this.body.querySelector('pre').textContent = mdBody; }
    if (fm && fm.length) {
      const box = frontmatterHtml(fm);
      this.body.insertAdjacentHTML('afterbegin', purify ? DOMPurify.sanitize(box) : box);
    }
    this.styleCallouts();
    this.tagify();
  }

  // force=true：無條件離開；否則有未存就跳頁內提示
  async exitEdit({ force = false, skipGuard = false } = {}) {
    if (!this.editor.isActive()) return true;
    if (!force && !skipGuard && this.editor.dirty) { this.showGuard(); return false; }
    const f = this.file;
    this.editor.exitDomOnly();
    this.guardEl.classList.remove('on');
    if (this.find.isOpen) this.find.close();
    this.body.style.cssText = '';
    delete this.body.dataset.ct;
    this.mdPreview = false;
    if (f) await this.open({ ...f, mtime: f.mtime });
    else this.syncEditButtons();
    return true;
  }

  // 有未存時的頁內提示（不用原生 confirm）
  showGuard() {
    this.guardEl.querySelector('.g').textContent = t('guardMsg', { name: this.file ? this.file.name : '' });
    this.guardEl.classList.add('on');
  }
  forceLeave(cb) {
    this.exitEdit({ force: true }).then(() => { if (cb) cb(); });
  }

  // 離開閱讀前問一句：有髒就擋（main.js 的 putBack 會先問）
  async tryLeave(proceed) {
    if (!this.editor.isActive()) return proceed();
    if (!this.editor.dirty) { await this.exitEdit({ force: true }); return proceed(); }
    this.leaveCb = async () => { await this.exitEdit({ force: true }); proceed(); };
    this.showGuard();
    return false;
  }

  // ⚙ 設定的「HTML 預設執行網頁程式」（localStorage，每次打開當場讀，切了馬上生效）
  htmlRunDefault() {
    try { return localStorage.getItem('riffleHtmlRun') === '1'; } catch (_) { return false; }
  }
  htmlRunOn(file) {
    const k = pathKey(file.path);
    return this.runPref.has(k) ? this.runPref.get(k) : this.htmlRunDefault();
  }
  syncHtmlButtons(file) {
    // 改版模式有自己的一整條工具列；標題列只留「離開改版」
    const revising = this.revise && this.revise.active() && this.revise.file && this.revise.file.path === file.path;
    if (file.kind !== 'html' || revising) {
      this.btnRun.hidden = true;
      this.btnSource.hidden = true;
      this.btnRevise.hidden = file.kind !== 'html';
      this.btnRevise.classList.toggle('on', !!revising);
      this.btnRevise.textContent = revising ? t('reviseExit') : t('revise');
      this.btnRevise.title = revising ? t('reviseExitTitle') : t('reviseTitle');
      return;
    }
    this.btnRevise.hidden = false;
    this.btnRevise.textContent = t('revise');
    this.btnRevise.title = t('reviseTitle');
    this.btnRevise.classList.remove('on');
    const srcOn = this.srcPref.get(pathKey(file.path)) === true;
    this.btnSource.hidden = false;
    this.btnSource.textContent = srcOn ? t('viewPreview') : t('viewSource');
    this.btnSource.title = srcOn ? t('viewPreviewTitle') : t('viewSourceTitle');
    this.btnSource.classList.toggle('on', srcOn);
    const runOn = this.htmlRunOn(file);
    this.btnRun.hidden = srcOn;    // 看原始碼時沒有「執行」可談
    this.btnRun.textContent = runOn ? t('stopScripts') : t('runScripts');
    this.btnRun.title = runOn ? t('stopScriptsTitle') : t('runScriptsTitle');
    this.btnRun.classList.toggle('on', runOn);
  }
  showScriptHint(on) {
    this.scriptHintEl.textContent = on ? '💡 ' + t('scriptHint') : '';
    this.scriptHintEl.classList.toggle('on', !!on);
  }

  // ⚙ 設定切了「HTML 預設執行網頁程式」→ 正在看的 HTML 立刻跟著切；
  // 但使用者對這個檔按過 ▶（逐檔覆寫）時不動它
  htmlRunMaybeChanged() {
    const f = this.file;
    if (!f || f.kind !== 'html') return;
    if (this.runPref.has(pathKey(f.path))) return;
    this.open(f).catch(err => console.warn('html rerun failed:', err));
  }

  // bounds in window css px (for the flight target)
  targetRect(frac, W, H) {
    return {
      x: Math.round(W * (1 - frac)), y: 54,
      w: Math.round(W * frac) - 12, h: H - 54 - 16
    };
  }

  setOpen(on) {
    const had = this.el.classList.contains('open');
    this.el.classList.toggle('open', on);
    if (on && !had) {
      // .open (display) and .show (opacity) must not land in the same frame,
      // or the fade-in never runs — flush, then apply .show next frame
      if (this.el.classList.contains('show')) {
        this.el.classList.remove('show');
        void this.el.offsetHeight;
        this.el.classList.add('show');
      }
    }
    if (!on) this.el.classList.remove('show');
  }
  show() { this.el.classList.add('show'); }
  hide() { this.el.classList.remove('show'); this.clearLineMark(); }
  clearLineMark() {
    const m = this.body.querySelector('.proj-line');
    if (m) m.remove();
  }

  // warning strip for files flagged `secret: true` — values arrive MASKED from
  // the server (at most 4 leading chars visible); the raw key never crosses the wire
  async showSecretWarning(file) {
    const el = this.secretEl;
    el.textContent = '⚠ ' + t('secretWarn');
    el.classList.add('on');
    try {
      const d = await apiJson('/api/secretscan?path=' + encodeURIComponent(file.path));
      if (this.file !== file) return; // 已經換檔，丟掉舊結果
      if (!d || !Array.isArray(d.matches) || !d.matches.length) return;
      const hits = document.createElement('div');
      hits.className = 'hits';
      hits.textContent = d.matches.slice(0, 30).map(m => t('secretHit', m)).join('　');
      el.appendChild(hits);
    } catch (_) { /* warning line already shown; details are best-effort */ }
  }

  // loads the file body; resolves once the content is in the DOM
  async open(file) {
    // 換檔時把改版模式收掉（改版中的畫面由 revise.js 自己重畫）
    if (this.revise && this.revise.active() && (!this.revise.file || this.revise.file.path !== file.path)) {
      this.revise.detach();
    }
    this.file = file;
    this.rawText = null;
    if (this.editor.isActive()) { this.editor.exitDomOnly(); this.guardEl.classList.remove('on'); }
    if (this.find.isOpen && this.find.q.value !== undefined) { /* 換檔保留查找字，重新搜 */ }
    this.body.style.cssText = '';
    delete this.body.dataset.ct;
    this.title.classList.remove('dirty');
    const gen = ++this.openGen;
    const stale = () => gen !== this.openGen || this.file !== file;
    const hl = this.highlight;
    this.kind.textContent = KIND_LABEL[kindOf(file)] || file.ext || '?';
    this.kind.style.background = kindColor(kindOf(file));
    this.kind.style.color = theme().tabText;
    this.title.textContent = file.name;
    this.title.title = file.path;
    this.meta.textContent = `${fmtSize(file.size)} · ${fmtDate(file.mtime)}`;
    this.body.className = '';
    this.body.textContent = '';
    setCodeControlsVisible(false);   // 預設藏起來；setCode() 打開程式碼檢視時才亮出
    // secret warning strip (reads masked matches from /api/secretscan)
    this.secretEl.classList.remove('on');
    this.secretEl.textContent = '';
    this.showScriptHint(false);
    this.syncHtmlButtons(file);
    this.syncEditButtons();
    if (file.secret) this.showSecretWarning(file);
    if (!file.kind) {
      this.body.innerHTML =
        `<p class="msg-dim">${t('noPreviewType')}</p>` +
        `<pre></pre>`;
      this.body.querySelector('pre').textContent =
        t('fileMeta', { path: file.path, size: fmtSize(file.size), date: fmtDate(file.mtime) });
      return;
    }
    const url = '/api/file?path=' + encodeURIComponent(file.path);
    try {
      if (file.kind === 'image') {
        this.body.innerHTML = `<img class="reader-img" src="${url}" alt="">`;
      } else if (file.kind === 'pdf') {
        this.body.innerHTML = `<iframe src="${url}" title="pdf"></iframe>`;
      } else if (file.kind === 'html') {
        const runOn = this.htmlRunOn(file);
        const srcOn = this.srcPref.get(pathKey(file.path)) === true;
        if (srcOn) {
          // ＜/＞ 原始碼：整份當純文字看（程式碼檢視＝xml 語法上色＋行號）
          const text = await (await api(url)).text();
          if (stale()) return;
          this.setCode(text, 'xml', file);
        } else if (runOn) {
          // 執行網頁程式：先向同源 /api/rawopen 拿一組 capability token，整頁從
          // /raw/<token>/… 載入（相對路徑自然解析）。iframe 沙箱不給
          // allow-same-origin → 不透明 origin：跑起來的程式碰不到 RiffleDesk 的
          // 寫入 API（寫入端點要求同源 Origin），也拿不出 token 以外的任何檔案
          // （token 只服務這個檔案所在目錄樹＋頁面 file:/// 引用到的檔）。
          const raw = await apiJson('/api/rawopen?path=' + encodeURIComponent(file.path));
          if (stale() || !raw.ok) return;
          this.body.innerHTML = '';
          const ifr = document.createElement('iframe');
          ifr.setAttribute('sandbox', 'allow-scripts allow-popups allow-modals allow-downloads');
          ifr.title = t('viewPreviewTitle');
          // 不把本機檔案路徑（iframe 自己的網址）洩給頁面抓的外部資源
          ifr.setAttribute('referrerpolicy', 'no-referrer');
          ifr.src = raw.url;
          this.body.appendChild(ifr);
        } else {
          const text = await (await api(url)).text();
          if (stale()) return;
          // 檔案裡有 <script> 但現在是關的 → 提示列告訴使用者內容可能要執行才看得到
          const hasScript = /<script[\s>]/i.test(text);
          this.showScriptHint(hasScript);
          // 沒有任何程式的網頁：按 ▶ 不會有差別，乾脆不顯示這顆鈕，免得以為壞掉
          if (!hasScript) this.btnRun.hidden = true;
          const html = await rewriteHtml(text, file.path);
          if (stale()) return;
          this.body.innerHTML = '';
          const ifr = document.createElement('iframe');
          // 不給 allow-scripts：網頁裡的程式一律不跑。allow-same-origin 只是讓外層能接手「點連結」
          ifr.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
          ifr.srcdoc = html;
          ifr.addEventListener('load', () => this.wireLinks(ifr, file));
          this.body.appendChild(ifr);
          // sr-only 純文字摘錄（腳本已剔除）：side-panel agent／文字抽取器常跳過
          // iframe，把這頁的可見文字平放在旁邊它們才讀得到；上限 20KB
          const mtext = htmlVisibleText(text);
          if (mtext) {
            const pre = document.createElement('pre');
            pre.className = 'mirror-html-text';
            pre.setAttribute('aria-label', '此頁面的可見文字摘錄 / Plain-text extract of this page');
            pre.textContent = mtext;
            this.body.appendChild(pre);
          }
        }
      } else if (file.kind === 'sheet') {
        const buf = await (await api(url)).arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
        this.body.innerHTML = rowsToTable(rows.slice(0, 300));
      } else {
        const text = await (await api(url)).text();
        if (this.canEdit(file)) this.rawText = text;   // 編輯器進場用（原始檔，不是 pretty 版）
        if (file.kind === 'markdown') {
          this.body.className = 'md';
          if (typeof marked !== 'undefined') {
            const { fm, body: mdBody } = splitFrontmatter(text);
            const prepped = mapOutsideCode(mdBody, seg => obsidianInline(seg, file.path));
            const raw = marked.parse(prepped);
            const purify = typeof DOMPurify !== 'undefined';
            if (purify) this.body.innerHTML = DOMPurify.sanitize(raw);
            else { this.body.innerHTML = '<pre></pre>'; this.body.querySelector('pre').textContent = mdBody; }
            if (fm && fm.length) {
              const box = frontmatterHtml(fm);   // 內容已全部 escape；有 DOMPurify 就再過一層
              this.body.insertAdjacentHTML('afterbegin', purify ? DOMPurify.sanitize(box) : box);
            }
            this.styleCallouts();
            this.tagify();
            this.wireEmbeds(file);
          } else { this.body.innerHTML = '<pre></pre>'; this.body.querySelector('pre').textContent = text; }
        } else if (file.kind === 'json') {
          let pretty = text;
          try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
          this.setCode(pretty, 'json', file);
        } else if (file.kind === 'table') {
          const delim = file.ext === '.tsv' ? '\t' : ',';
          const rows = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 500).map(l => l.split(delim));
          this.body.innerHTML = rowsToTable(rows);
        } else if (file.kind === 'code') {
          this.setCode(text, extToLang(file.ext) || 'auto', file);
        } else {
          this.setPre(text);
        }
      }
      if (hl) markText(this.body, hl);
    } catch (err) {
      this.body.innerHTML = `<p class="msg-err">${escapeHtml(t('readFail', { msg: String(err.message || err) }))}</p>`;
    }
  }

  // HTML 裡的超連結：#錨點＝頁內捲動；http(s)/mailto＝開新分頁；本機相對路徑＝在閱讀區打開那個檔
  wireLinks(ifr, file) {
    let doc;
    try { doc = ifr.contentDocument; } catch (_) { return; }
    if (!doc) return;
    doc.addEventListener('click', async e => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href') || '';
      e.preventDefault();
      if (href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1));
        const el = doc.getElementById(id) || doc.querySelector(`[name="${CSS.escape(id)}"]`);
        if (el) el.scrollIntoView({ block: 'start' });
        return;
      }
      if (/^(https?:|mailto:)/i.test(href)) { window.open(href, '_blank', 'noopener'); return; }
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) return;   // javascript: 等其他協定一律不理
      const target = resolveLocal(file.path, href);
      if (!target) return;
      if (this.onOpenPath) this.onOpenPath(target.path, target.hash);
    }, true);
  }

  setPre(text) {
    this.body.innerHTML = '<pre></pre>';
    this.body.querySelector('pre').textContent = text;
  }

  // 程式碼檢視（codetheme.js）：行號槽＋等寬字＋經典配色上色；超過 512KB 的檔維持純文字
  setCode(text, lang, file) {
    this.body.className = 'code';
    setCodeControlsVisible(true);
    renderCodeView(this.body, text, {
      lang,
      plain: !!(file && file.size > 512 * 1024),
      // 檔案位元組數給效能門檻用（門檻以 byte 計，CJK 檔 char≠byte）；
      // pretty JSON 是重排過的新字串，位元組數≠file.size，就留空讓 codetheme 自量
      bytes: (file && file.kind !== 'json' && typeof file.size === 'number') ? file.size : undefined
    });
  }

  // ---- Obsidian 風格（callout / #tag / 嵌入圖 / wikilink 點擊） ----

  // > [!note] Title：第一個文字節點開頭是 [!type] 的 blockquote 才換裝，普通引言不動
  styleCallouts() {
    for (const bq of this.body.querySelectorAll('blockquote')) {
      const walker = document.createTreeWalker(bq, NodeFilter.SHOW_TEXT);
      let tn = walker.nextNode();
      // marked 會在 blockquote 開頭塞純換行節點；巢狀時只認「最近的 blockquote 是自己」的節點
      while (tn && (!/\S/.test(tn.nodeValue) || tn.parentElement.closest('blockquote') !== bq)) tn = walker.nextNode();
      if (!tn) continue;
      const m = tn.nodeValue.match(/^\s*\[!([A-Za-z][\w-]*)\][+-]?[ \t]*/);
      if (!m) continue;
      bq.classList.add('obs-callout', 'obs-callout-' + m[1].toLowerCase());
      const rest = tn.nodeValue.slice(m[0].length);
      const nl = rest.indexOf('\n');
      const titleText = (nl >= 0 ? rest.slice(0, nl) : rest).trim();
      tn.nodeValue = nl >= 0 ? rest.slice(nl + 1) : '';
      const title = document.createElement('div');
      title.className = 'obs-callout-title';
      title.textContent = titleText || m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      bq.insertBefore(title, bq.firstChild);
    }
  }

  // #tag → 暗淡小膠囊（不做連結）；不進 code/pre/標題/連結/frontmatter 盒
  tagify() {
    const SKIP = new Set(['PRE', 'CODE', 'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
    const RE = /(^|[^\p{L}\p{N}_/&#])#([\p{L}\p{N}_][\p{L}\p{N}_-]*(?:\/[\p{L}\p{N}_-]+)*)/gu;
    const walker = document.createTreeWalker(this.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!/#[\p{L}\p{N}_]/u.test(n.nodeValue)) continue;   // 快篩（與主 regex 的字首條件一致）
      let bad = false;
      for (let p = n.parentElement; p && p !== this.body; p = p.parentElement) {
        if (SKIP.has(p.tagName) || p.closest('.obs-fm') || p.classList.contains('obs-callout-title')) { bad = true; break; }
      }
      if (!bad) nodes.push(n);
    }
    for (const node of nodes) {
      const text = node.nodeValue;
      RE.lastIndex = 0;
      let m, frag = null, last = 0;
      while ((m = RE.exec(text))) {
        if (!/[\p{L}_-]/u.test(m[2])) continue;        // 純數字（#123）不算 tag
        if (!frag) frag = document.createDocumentFragment();
        const start = m.index + m[1].length;
        frag.appendChild(document.createTextNode(text.slice(last, start)));
        const pill = document.createElement('span');
        pill.className = 'obs-tag';
        pill.textContent = '#' + m[2];
        frag.appendChild(pill);
        last = start + 1 + m[2].length;
      }
      if (frag) {
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
      }
    }
  }

  // 嵌入圖：同資料夾猜不到就等 error 再全域找（不擋渲染）；若掛監聽前就已失敗，手動補跑一次
  wireEmbeds(file) {
    for (const img of this.body.querySelectorAll('img.obs-embed')) {
      const fallback = async () => {
        if (img.dataset.obsTried) return;
        img.dataset.obsTried = '1';
        const found = await this.resolveAsset(img.dataset.obsSrc, dirOf(file.path));
        if (found) img.src = fileUrl(found);
        else { img.style.display = 'none'; this.showMissing(img, img.dataset.obsSrc); }
      };
      img.addEventListener('error', () => { fallback().catch(err => console.warn('embed resolve failed:', err)); });
      if (img.complete && img.naturalWidth === 0 && img.dataset.obsSrc) {
        fallback().catch(err => console.warn('embed resolve failed:', err));
      }
    }
  }

  // 投影（project.js）跳到指定行。程式碼／純文字用真正的行高精準換算；md 這種渲染後
  // 行數對不上的就用一般行高估計（仍比停在最上面有用），並畫一條提示線。
  scrollToLine(line) {
    const n = Math.floor(Number(line));
    if (!Number.isFinite(n) || n < 1) return false;
    const host = this.body.querySelector('.codeview .cv-code') || this.body.querySelector('pre') || this.body;
    const cs = getComputedStyle(host);
    let lh = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lh) || lh <= 0) lh = (parseFloat(cs.fontSize) || 15) * 1.7;
    const top = (n - 1) * lh;
    this.body.scrollTop = Math.max(0, top - lh * 3);
    this.clearLineMark();
    const mark = document.createElement('div');
    mark.className = 'proj-line';
    // 絕對定位的子元素跟著內容一起捲，所以位移用「內容座標」而不是減掉 scrollTop
    mark.style.top = Math.round(top) + 'px';
    this.body.appendChild(mark);
    return true;
  }

  async openWikilink(a) {
    const name = a.dataset.wl || '';
    const hash = a.dataset.wlh || '';
    if (!name || !this.file) return;
    const baseDir = dirOf(this.file.path);   // 解析是 async，先把當下位置記住（用完過程中可能換檔）
    a.classList.add('obs-resolving');
    try {
      const target = await this.resolveNote(name, baseDir);
      if (target) { if (this.onOpenPath) this.onOpenPath(target, hash); }
      else this.showMissing(a, name);
    } finally { a.classList.remove('obs-resolving'); }
  }

  showMissing(el, name) {
    if (!name) return;
    if (el.nextElementSibling && el.nextElementSibling.classList.contains('obs-missing')) return;
    const s = document.createElement('span');
    s.className = 'obs-missing';
    s.textContent = t('obsMissing', { name });
    el.after(s);
  }

  // [[Note]] → Note.md：同資料夾 → vault 根 → 全 vault 精確檔名（search，失敗再 BFS）
  resolveNote(name, startDir) {
    return this.resolveAsset(name.replace(/\.md$/i, '') + '.md', startDir, '.md');
  }

  async resolveAsset(fileName, startDir, exts) {
    const cacheKey = (startDir + '\n' + fileName).toLowerCase();
    if (this.linkCache.has(cacheKey)) return this.linkCache.get(cacheKey);
    const found = await this._resolveAssetUncached(fileName, startDir, exts);
    this.linkCache.set(cacheKey, found);
    return found;
  }

  async _resolveAssetUncached(fileName, startDir, exts) {
    const same = await findFileIn(startDir, fileName);   // 同資料夾
    if (same) return same;
    const root = await this.detectVaultRoot(startDir);
    if (!root) return null;
    if (fileName.includes('/') || fileName.includes('\\')) {
      // [[folder/Note]] 這種帶路徑的：Obsidian 是對 vault 根算
      const rel = await fileExists(joinPath(root, fileName));
      if (rel) return rel;
    }
    const found = await searchVault(root, fileName, exts || pathExtOf(fileName));
    if (found) return found;
    return bfsFind(root, fileName, 300);
  }

  // 從筆記所在資料夾往上找「含 .obsidian 的資料夾」當 vault 根；找不到回 null
  // 快取 key 一律小寫；途中 API 出錯（暫時性）不做負向快取，下次重試
  async detectVaultRoot(startDir) {
    let dir = startDir;
    const seen = [];
    const done = root => { for (const s of seen) this.vaultCache.set(s.toLowerCase(), root); return root; };
    for (let i = 0; i < 25 && dir; i++) {
      const k = dir.toLowerCase();
      if (this.vaultCache.has(k)) return done(this.vaultCache.get(k));
      seen.push(dir);
      let d;
      try { d = await apiJson('/api/list?path=' + encodeURIComponent(dir) + '&nofiles=1'); }
      catch (_) { return null; }   // 暫時性錯誤：什麼都不記
      if ((d.dirs || []).some(x => x.name === '.obsidian')) return done(dir);
      const parent = parentDir(dir);
      if (!parent || parent === dir) break;
      dir = parent;
    }
    return done(null);
  }
}

function rowsToTable(rows) {
  if (!rows.length) return `<p class="msg-dim">${t('noData')}</p>`;
  let html = '<table>';
  rows.forEach((r, i) => {
    html += '<tr>' + r.map(c => (i === 0 ? `<th>${escapeHtml(c)}</th>` : `<td>${escapeHtml(c)}</td>`)).join('') + '</tr>';
  });
  return html + '</table>';
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// 內文搜尋結果打開時：把搜尋字標黃（不分大小寫），捲到第一個；行號槽的數字不標
function markText(root, q) {
  const needle = q.toLowerCase();
  if (!needle) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.parentElement && n.parentElement.closest('.cv-gutter')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  const hits = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue.toLowerCase().includes(needle)) hits.push(n);
    if (hits.length > 300) break;
  }
  let first = null;
  for (const node of hits) {
    const text = node.nodeValue, low = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let i = 0, j;
    while ((j = low.indexOf(needle, i)) >= 0) {
      if (j > i) frag.appendChild(document.createTextNode(text.slice(i, j)));
      const m = document.createElement('mark');
      m.textContent = text.slice(j, j + needle.length);
      frag.appendChild(m);
      if (!first) first = m;
      i = j + needle.length;
    }
    if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
    node.parentNode.replaceChild(frag, node);
  }
  if (first) requestAnimationFrame(() => first.scrollIntoView({ block: 'center' }));
}

// ---- HTML 預覽：把相對路徑的圖片、樣式表接到本機伺服器（srcdoc 沒有「所在資料夾」可以相對）
const pathKey = p => String(p).toLowerCase();   // 逐檔切換狀態的 key（Windows 大小寫不分）
function dirOf(p) { return p.replace(/[\\/][^\\/]*$/, ''); }
function joinPath(base, rel) {
  const sep = base.includes('\\') ? '\\' : '/';
  const parts = base.split(/[\\/]/);
  for (const seg of rel.split(/[\\/]/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (parts.length > 1) parts.pop(); } else parts.push(seg);
  }
  return parts.join(sep);
}
// 本機連結 → { path, hash }；外部網址回 null
function resolveLocal(filePath, href) {
  let h = href.trim();
  if (!h || /^(https?:|mailto:|data:|blob:|javascript:)/i.test(h)) return null;
  let hash = '';
  const hi = h.indexOf('#'); if (hi >= 0) { hash = h.slice(hi + 1); h = h.slice(0, hi); }
  const qi = h.indexOf('?'); if (qi >= 0) h = h.slice(0, qi);
  if (!h) return null;
  try { h = decodeURIComponent(h); } catch (_) {}
  if (/^file:/i.test(h)) {
    h = h.replace(/^file:\/*/i, '');
    if (!/^[a-z]:/i.test(h)) h = '/' + h;          // file:///home/x → /home/x
    return { path: h.replace(/\//g, /^[a-z]:/i.test(h) ? '\\' : '/'), hash };
  }
  if (/^[a-z]:[\\/]/i.test(h) || h.startsWith('/') && !filePath.includes('\\')) return { path: h, hash };
  return { path: joinPath(dirOf(filePath), h), hash };
}
const fileUrl = p => '/api/file?path=' + encodeURIComponent(p);

// ---- Obsidian 風格 markdown：全部在「純文字前處理 → 產出仍過 DOMPurify」框架內完成 ----

const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif', '.ico'];
function pathExtOf(p) { const m = /\.[^.\\/]+$/.exec(p || ''); return m ? m[0].toLowerCase() : ''; }
const isImageName = n => IMG_EXTS.includes(pathExtOf(n));

// YAML frontmatter（檔案開頭的 --- 區塊）：拆出來做成屬性盒，不當本文渲染
function splitFrontmatter(text) {
  const head = text.match(/^\uFEFF?---[ \t]*\r?\n/);   // BOM 可有可無
  if (!head) return { fm: null, body: text };
  const rest = text.slice(head[0].length);
  const end = rest.match(/(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/);   // 允許空的 frontmatter（---\n---）
  if (!end) return { fm: null, body: text };
  return {
    fm: parseSimpleYaml(rest.slice(0, end.index)),
    body: rest.slice(end.index + end[0].length)
  };
}

// 只認「平鋪 key: value」＋「- 列表項」＋「[a, b] 行內列表」，巢狀結構不強解
function parseSimpleYaml(src) {
  const rows = [];
  let cur = null;
  for (const line of src.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const li = line.match(/^\s*-\s+(.*)$/);   // YAML 清單項可以不縮排（與 key 同欄）
    if (li && cur) { cur.values.push(unquoteYaml(li[1].trim())); continue; }
    const kv = line.match(/^([A-Za-z_][\w .-]*?)\s*:\s*(.*)$/);
    if (!kv) { cur = null; continue; }
    cur = { key: kv[1], values: [] };
    const v = kv[2].trim();
    if (v) {
      cur.values = v.startsWith('[') && v.endsWith(']')
        ? v.slice(1, -1).split(',').map(s => unquoteYaml(s.trim())).filter(Boolean)
        : [unquoteYaml(v)];
    }
    rows.push(cur);
  }
  return rows;
}
function unquoteYaml(s) {
  return s.length > 1 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) ? s.slice(1, -1) : s;
}

// 屬性盒：tags 一排小膠囊；超過 6 個 key 收成一行 <details>
function frontmatterHtml(rows) {
  const inner = rows.map(r => {
    const isTags = /^tags?$/i.test(r.key.trim());
    const vals = r.values.map(v =>
      `<span class="${isTags ? 'obs-fm-pill' : 'obs-fm-val'}">${escapeHtml(v)}</span>`).join(' ');
    return `<div class="obs-fm-row"><span class="obs-fm-key">${escapeHtml(r.key)}</span>` +
      `<span class="obs-fm-vals">${vals}</span></div>`;
  }).join('');
  if (rows.length > 6) {
    return `<details class="obs-fm"><summary>${escapeHtml(t('fmProps', { n: rows.length }))}</summary>${inner}</details>`;
  }
  return `<div class="obs-fm">${inner}</div>`;
}

// 只對「不在 fenced code block、不在 inline code」的片段套 fn
// 逐行狀態機：CRLF 可、結束 fence 可比開頭長（同符號 ≥3）、未關閉的 fence 吃到檔尾（CommonMark 語意）
function mapOutsideCode(text, fn) {
  const lines = text.split(/(?<=\n)/);
  const out = [];
  let inFence = false, fenceCh = '', fenceLen = 0, buf = [];
  const flush = apply => {
    if (!buf.length) return;
    const seg = buf.join('');
    out.push(apply ? mapOutsideInline(seg, fn) : seg);
    buf = [];
  };
  for (const line of lines) {
    if (!inFence) {
      const m = line.match(/^[ \t]*(`{3,}|~{3,})/);
      if (m) { flush(true); inFence = true; fenceCh = m[1][0]; fenceLen = m[1].length; buf.push(line); continue; }
      buf.push(line);
    } else {
      buf.push(line);
      const c = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*\r?\n?$/);   // JS 的 $ 無 /m 時不吃結尾換行，要自己寫 \n?
      if (c && c[1][0] === fenceCh && c[1].length >= fenceLen) { flush(false); inFence = false; }
    }
  }
  flush(!inFence);
  return out.join('');
}
function mapOutsideInline(seg, fn) {
  const CODE = /(`+)[^`]*?\1/g;
  let out = '', last = 0;
  for (const m of seg.matchAll(CODE)) {
    out += fn(seg.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(seg.slice(last));
}

// [[Note]] / [[Note#標題]] / [[Note|別名]] / ![[圖.png|300]]；![[Note]] 當普通連結（不做嵌入全篇）
function obsidianInline(seg, basePath) {
  const LINK = (m, target, hash, alias) =>
    wikilinkHtml(target.trim(), (hash || '').replace(/^#/, ''), alias ? alias.trim() : '');
  seg = seg.replace(/!\[\[([^\[\]|#]+)(#[^\[\]|]*)?(?:\|([^\[\]]*))?\]\]/g, (m, target, hash, alias) =>
    isImageName(target.trim())
      ? embedImgHtml(target.trim(), alias ? alias.trim() : '', basePath)   // 圖片的 # 片段不拼進檔名
      : LINK(m, target, hash, alias));
  seg = seg.replace(/\[\[([^\[\]|#]+)(#[^\[\]|]*)?(?:\|([^\[\]]*))?\]\]/g, LINK);
  return seg;
}
function wikilinkHtml(name, hash, alias) {
  const label = alias || (name + (hash ? ' ❯ ' + hash : ''));
  return `<a href="#" class="obs-wikilink" data-wl="${escapeHtml(name)}" data-wlh="${escapeHtml(hash)}">${escapeHtml(label)}</a>`;
}
function embedImgHtml(target, alias, basePath) {
  const dim = /^(\d+)(?:x(\d+))?$/.exec(alias);   // |300 或 |300x200，寬高吃法同 Obsidian
  const size = dim ? ` width="${dim[1]}"` + (dim[2] ? ` height="${dim[2]}"` : '') : '';
  const cap = alias && !dim ? alias : '';
  return `<img class="obs-embed" src="${escapeHtml(fileUrl(joinPath(dirOf(basePath), target)))}" ` +
    `data-obs-src="${escapeHtml(target)}" alt="${escapeHtml(cap || target)}"${size}>`;
}

// ---- wikilink/嵌入圖的路徑解析（全部在點擊或圖片失敗時才跑，不擋渲染） ----
function parentDir(p) {
  const d = dirOf(p);
  if (d === p) return null;
  if (/^[a-z]:$/i.test(d)) return d + '\\';   // D:\foo 的上一層是 D:\
  return d || null;
}

async function findFileIn(dir, fileName) {
  try {
    const d = await apiJson('/api/list?path=' + encodeURIComponent(dir));
    const hit = (d.files || []).find(f => f.name.toLowerCase() === fileName.toLowerCase());
    return hit ? hit.path : null;
  } catch (_) { return null; }
}

// 確認某個完整路徑存在（head=1 只取 1 byte，不整檔抓）；存在回 path，否則 null
async function fileExists(p) {
  try {
    const r = await fetch('/api/file?path=' + encodeURIComponent(p) + '&head=1');
    return r.ok ? p : null;
  } catch (_) { return null; }
}

// /api/search 是內文＋檔名搜尋：只收「檔名完全相等」且在根目錄底下的結果
async function searchVault(root, fileName, exts) {
  try {
    const d = await apiJson('/api/search?path=' + encodeURIComponent(root) +
      '&q=' + encodeURIComponent(fileName) + '&exts=' + encodeURIComponent(exts || '') + '&limit=50');
    const norm = s => s.toLowerCase().replace(/\\/g, '/');
    const rootN = norm(root).replace(/\/$/, '') + '/';
    const hits = (d.files || []).filter(f => f.name.toLowerCase() === fileName.toLowerCase() && norm(f.path).startsWith(rootN));
    return hits.length ? hits[0].path : null;
  } catch (_) { return null; }
}

// search 找不到時的保險：BFS 走 /api/list（最多 maxDirs 個資料夾，跳過 .開頭的隱藏夾）
async function bfsFind(root, fileName, maxDirs) {
  const queue = [root], seen = new Set([root.toLowerCase()]);
  for (let n = 0; queue.length && n < maxDirs; n++) {
    const dir = queue.shift();
    let d;
    try { d = await apiJson('/api/list?path=' + encodeURIComponent(dir)); } catch (_) { continue; }
    const hit = (d.files || []).find(f => f.name.toLowerCase() === fileName.toLowerCase());
    if (hit) return hit.path;
    for (const sub of d.dirs || []) {
      if (sub.name.startsWith('.')) continue;
      const k = sub.path.toLowerCase();
      if (!seen.has(k)) { seen.add(k); queue.push(sub.path); }
    }
  }
  return null;
}
async function rewriteHtml(text, filePath) {
  let doc;
  try { doc = new DOMParser().parseFromString(text, 'text/html'); } catch (_) { return text; }
  const base = filePath;
  for (const img of doc.querySelectorAll('img[src], source[src], video[src], audio[src]')) {
    const r = resolveLocal(base, img.getAttribute('src'));
    if (r) img.setAttribute('src', fileUrl(r.path));
  }
  for (const img of doc.querySelectorAll('img[srcset], source[srcset]')) img.removeAttribute('srcset');
  // 樣式表：伺服器把文字檔都當純文字送，瀏覽器不會套用 → 抓回來直接塞成 <style>，裡面的 url() 也改成本機路徑
  for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
    const r = resolveLocal(base, link.getAttribute('href'));
    if (!r) continue;
    try {
      let css = await (await fetch(fileUrl(r.path))).text();
      css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
        // 只接圖片；字型等伺服器不提供的檔改成空網址（不發請求、不噴錯），外部網址照舊
        const rr = /\.(png|jpe?g|gif|webp|svg)$/i.test(u.split(/[?#]/)[0]) ? resolveLocal(r.path, u) : null;
        return rr ? `url("${fileUrl(rr.path)}")` : (/^(https?:|data:)/i.test(u) ? m : 'url("")');
      });
      const st = doc.createElement('style');
      st.textContent = css;
      link.replaceWith(st);
    } catch (_) {}
  }
  for (const sc of doc.querySelectorAll('script')) sc.remove();   // 反正不會跑，拿掉免得洗版錯誤
  return '<!doctype html>' + doc.documentElement.outerHTML;
}
