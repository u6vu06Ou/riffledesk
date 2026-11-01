// tabs.js — 瀏覽器分頁模式：把 Chrome 現在開著的分頁變成卡堆。
// 資料來源是 server 記憶體裡的清單（extension/ 的擴充推上來的），Internet 上一律不碰。
// 進場時由 main.js 記住原本在看什麼（資料夾／對話／一疊），離開時 restore 回去——跟 pile 同一套。
// 擴充沒連上時，卡堆放一張「怎麼安裝」說明卡（kind:'tab', tab.note=true，卡面在 thumbs.js 畫）。
import { t } from './i18n.js';
import { apiJson, shortHash } from './util.js';
import { fileUrlToPath, pathExtOf, extToKind, isBuiltinUrl } from './fileurl.js';
import { tabBadgeAt } from './thumbs.js';

// 外部定位（點卡連動）的「使用者剛接手」新鮮窗：使用者滾／拖過之後這段時間內，
// 遲到的定位指令一律不動卡堆。覆蓋 sidepanel.js 的補送鏈上限（12 次 × 500ms ≈ 6 秒）。
const FOCUS_FRESH_MS = 6500;

export class TabsMode {
  constructor(deps) {
    // stack / statusEl / pathBar 直接用；回到哪裡由 main.js 決定：
    //   getReturn()  → {kind:'folder'|'crow'|'pile', ...} | null
    //   clearCurrent() → 清掉 folder/convo/pile 狀態與樹選取（不還原）
    //   restore(target) → 回到 getReturn 記下的目標
    this.deps = deps;
    this.active = false;
    this.tabs = [];
    this.returnTo = null;
    this.extAlive = false;
    this._refreshTimer = null;
    this._waitTimer = null;
    this._pending = null;
    this._shown = false;
    this._sig = '';
    this._gen = 0;
    this._order = null;              // 一局內的凍結卡序（path 陣列）；null＝下一輪建立
    this.query = '';               // 分頁模式自己的搜尋字（標題／網址／內文）
    this._restoreTabId = null;     // 離開時記住看到哪張卡，回來時跳回同一張（不從頭）
    this._bootFocus = null;        // 開機定位（enterAt 的 tabfocus）：只在使用者還沒滾動前生效
    this._bootSetIdx = 0;          // 開機定位設到的索引（分辨「我們設的」與「使用者滾的」）
    this._lastFocusSetAt = 0;      // 最近一次「外部定位真的套上去」的時間戳（focusTab 風暴判斷用）
    this._scrollStampAtEnter = 0;  // 進場那一刻的 lastUserScrollAt：只認進場後的滾動，進場前在檔案模式的滾動不算接手
    this._parkedNameFilter = null; // 檔案模式的檔名篩選在分頁模式先寄存（會把分頁卡誤濾光）
  }

  // ---- 偽檔案 ----
  pseudoOf(tb) {
    const out = {
      name: tb.title || tb.url || t('tabsEmpty'),
      path: 'tab://' + tb.id,
      size: 0,
      mtime: tb.lastAccessed || 0,
      ext: '.tab',
      kind: 'tab',
      tab: { id: tb.id, windowId: tb.windowId, title: tb.title, url: tb.url, fav: tb.fav, active: !!tb.active,
             discarded: !!tb.discarded,
             hasShot: !!tb.hasShot, shotVer: tb.shotVer || 0, text: tb.text || '',
             desc: tb.desc || '', hasOg: !!tb.hasOg, ogVer: tb.ogVer || 0 }
    };
    // file:// 分頁：擴充故意不讀本機檔，改由 server 的 /api/file 直接畫檔案內容
    // （server 本來就是本機檔案瀏覽器）。路徑不存在／不在允許範圍時 /api/file 會 4xx，
    // 卡面與右欄再退回說明。localKind 也可能是 null（.exe 這類）→ 同樣走說明。
    const localPath = fileUrlToPath(tb.url);
    if (localPath) {
      out.localPath = localPath;
      out.localKind = extToKind(pathExtOf(localPath));
      const base = localPath.split(/[\\/]/).pop();
      try { out.localName = decodeURIComponent(base); } catch (_) { out.localName = base; }
    } else if (isBuiltinUrl(tb.url)) {
      out.builtin = true;   // chrome:// 這類：畫說明卡面（擴充讀不到也拍不到）
    }
    return out;
  }
  noteCard() {
    return {
      name: t('tabsNoExtTitle'),
      path: 'tab://install',
      size: 0, mtime: Date.now(), ext: '.tab', kind: 'tab',
      tab: { id: -1, note: true, title: t('tabsNoExtTitle'), url: '', fav: '', active: false,
             hasShot: false, desc: '', hasOg: false }
    };
  }

  showBar() {
    const pathBar = this.deps.pathBar();
    const crumbs = pathBar.querySelector('.crumbs');
    crumbs.textContent = '';
    const txt = document.createElement('span');
    txt.className = 'seg last';
    txt.textContent = t('tabsBar', { n: this.tabs.length });
    const back = document.createElement('button');
    back.className = 'pile-back';
    back.id = 'tabsBack';
    back.textContent = t('tabsBack');
    back.addEventListener('click', () => this.exit());
    crumbs.append(txt, back);
    pathBar.classList.add('on');
    pathBar.title = '';
    pathBar.querySelector('.copy').style.display = 'none';   // 分頁模式沒有資料夾路徑可複製
  }

  // 兩份清單的「實質內容」是否一樣（id 順序、標題、網址、favicon、截圖版本、文字／摘要／代表圖都算）。
  // 一樣就完全不用動畫面——擴充的標題抖動、無關屬性變動都不該讓卡堆重建。
  // favicon 是 data: URL（可達 24KB）、文字可達 1500 字，全部串成一個大字串太貴，
  // 所以先算成短雜湊。
  static sig(list) {
    let out = '';
    for (const tb of list) {
      out += [tb.id, tb.title, shortHash(tb.url), shortHash(tb.fav), tb.hasShot ? 1 : 0,
        tb.shotVer, shortHash(tb.text), shortHash(tb.desc), tb.hasOg ? 1 : 0, tb.ogVer || 0,
        tb.active ? 1 : 0, tb.discarded ? 1 : 0].join('\u0000') + '\u0001';
    }
    return out;
  }

  async apply() {
    const gen = ++this._gen;
    let d = null, err = false;
    try { d = await apiJson('/api/tabs'); } catch (_) { d = null; err = true; }
    if (gen !== this._gen || !this.active) return;
    // 抓失敗（server 剛斷／重啟）就保留上一次的畫面，不要閃成「沒裝擴充」說明卡
    if (err && this._shown) return;
    const list = (d && Array.isArray(d.tabs)) ? d.tabs : [];
    const extAlive = !!(d && d.extAlive);
    // 擴充擴自己的 runtime id（新版才有）：有它點卡就能直接送給擴充、趁手勢開側欄
    this.extId = (d && typeof d.extId === 'string' && /^[a-p]{32}$/.test(d.extId)) ? d.extId : '';
    const sig = (this.query ? 'q=' + this.query + '\n' : '') + TabsMode.sig(list);
    // 清單內容與擴充死活都沒變 → 一個像素都不動。
    // （只看這兩項：extSeen 每分鐘心跳就變一次，拿它當條件會害 no-op 幾乎永遠不成立。）
    if (sig === this._sig && extAlive === this.extAlive && this._shown) return;
    // 使用者正在滾（含阻尼未停）：先記著，等停下來再套用，不然位置會被拉走
    if (this._shown && this.deps.stack.scrollBusy && this.deps.stack.scrollBusy()) {
      this._pending = { list, extAlive, sig, gen, tries: 0 };
      clearTimeout(this._waitTimer);
      this._waitTimer = setTimeout(() => this._flushPending(), 80);
      return;
    }
    this._applyList(list, extAlive, sig);
  }

  _flushPending() {
    const p = this._pending;
    if (!p) return;
    if (!this.active || p.gen !== this._gen) { this._pending = null; return; }
    // 捲動狀態若卡住不清（殘留速度），限制最多重排 N 次，之後照樣套用，不會無限輪詢
    p.tries = (p.tries || 0) + 1;
    if (this.deps.stack.scrollBusy && this.deps.stack.scrollBusy() && p.tries < 40) {
      this._waitTimer = setTimeout(() => this._flushPending(), 80);
      return;
    }
    this._pending = null;
    this._applyList(p.list, p.extAlive, p.sig);
  }

  // 分頁模式搜尋：比對標題／網址／內文／摘要（不分大小寫）
  _match(tb, q) {
    return String(tb.title || '').toLowerCase().includes(q) ||
      String(tb.url || '').toLowerCase().includes(q) ||
      String(tb.text || '').toLowerCase().includes(q) ||
      String(tb.desc || '').toLowerCase().includes(q);
  }

  _applyList(list, extAlive, sig) {
    this.tabs = list;
    this.extAlive = extAlive;
    this._sig = sig;
    const q = (this.query || '').trim().toLowerCase();
    const hits = q ? list.filter(tb => this._match(tb, q)) : list;
    // _order 管的是「全量清單」的凍結卡序：搜尋命中集／暫時空結果只是顯示層。
    // 若拿濾過的清單更新 _order，清掉搜尋字時被濾掉的卡全變「新卡」重排＝整疊亂跳。
    const allFiles = list.map(tb => this.pseudoOf(tb));
    const allByPath = new Map(allFiles.map(f => [f.path, f]));
    const hitPaths = new Set(hits.map(tb => 'tab://' + tb.id));
    const display = hitPaths.size
      ? allFiles.filter(f => hitPaths.has(f.path))
      : ((!extAlive && !q) ? [this.noteCard()] : []);
    if (!this._shown) {
      // 第一次進場：整堆換掉（順序照當下的排序＝最近使用在前），凍結基準＝
      // 使用者實際看到的順序（setFolder 後的 view）；上次離開若停在某張卡，跳回那張
      this._shown = true;
      this.deps.stack.setFolder('tabs', display);
      this._order = this.deps.stack.view.map(f => f.path);
      if (this._restoreTabId != null) {
        const stack = this.deps.stack;
        const idx = stack.files.findIndex(f => f.tab && f.tab.id === this._restoreTabId);
        if (idx > 0) { stack.scrollCur = idx; stack.scrollTarget = idx; stack.scrollVel = 0; }
        this._restoreTabId = null;
      }
      this._applyBootFocus();   // 開機定位：落地這一刻決定（使用者還沒滾動才套）
    } else {
      // 一局之內凍結順序：已存在的分頁維持原位（lastAccessed／active 翻牌都
      // 不配重排——否則點一張卡它就跳到最前，整疊瞬間亂跳）；關掉的分頁移走，
      // 錨點機制（updateFilesInPlace）讓鄰近卡不跳。新冒出的 id（新開的分頁，
      // 或擴充重推又冒回來的舊分頁）依當前排序插到它的 mtime 該在的位置——
      // 剛開的分頁 mtime 最新＝插最前；已存在的卡彼此相對順序永遠不動。
      // 順序只在下次進場（重新打開側欄／離開再回來）時才整個重排。
      const prev = this._order || [];
      const prevSet = new Set(prev);
      const kept = prev.filter(p => allByPath.has(p));
      const freshFiles = allFiles.filter(f => !prevSet.has(f.path))
        .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      const ordered = kept.slice();
      for (const f of freshFiles) {
        let at = ordered.findIndex(p => (allByPath.get(p).mtime || 0) < (f.mtime || 0));
        if (at < 0) at = ordered.length;
        ordered.splice(at, 0, f.path);
      }
      this._order = ordered;
      // 顯示層：套用搜尋命中，但相對順序照凍結卡序
      const files = hitPaths.size
        ? ordered.filter(p => hitPaths.has(p)).map(p => allByPath.get(p))
        : display;
      // 已經在畫面上：就地更新，位置以「目前最前面那張卡」為錨
      const stack = this.deps.stack;
      const frontIdx = Math.round(stack.scrollCur);
      const anchor = (stack.view[frontIdx] && stack.view[frontIdx].path) || null;
      stack.updateFilesInPlace(files, anchor, { keepOrder: true });
      this._applyBootFocus();   // 首份清單晚到（擴充還沒推）時，開機定位在這裡落地
    }
    this._jumpToFocused();   // 有「點卡聯動捲到這張」待辦的話套用在最新清單上
    this.showBar();
    this.deps.statusEl.textContent = q
      ? t('tabsSearchHit', { n: hits.length, q: this.query.trim() })
      : (this.tabs.length
        ? t('tabsBar', { n: this.tabs.length })
        : (this.extAlive ? t('tabsEmpty') : t('tabsNoExtTitle')));
  }

  async enter() {
    if (this.active) return;
    this.active = true;
    this._shown = false;
    this._sig = '';
    this._scrollStampAtEnter = this.deps.stack.lastUserScrollAt || 0;   // 跨模式滾動（進場前滾檔案）不得抑制分頁定位
    // 檔名篩選是檔案模式的東西：分頁卡（名字＝分頁標題）一濾就全滅。
    // 分頁有自己的 query（標題／網址／內文），回檔案模式時再還原。
    const stack = this.deps.stack;
    this._parkedNameFilter = stack.nameFilter || null;
    if (this._parkedNameFilter) stack.setNameFilter('');
    this.returnTo = this.deps.getReturn();
    this.deps.clearCurrent();
    this.deps.setBtnOn(true);
    await this.apply();
  }

  // 進場帶搜尋字（檔案模式搜到分頁符合 → 帶著同一個字切過來）
  async enterWithQuery(q) {
    if (!this.active) await this.enter();
    this.setQuery(q);
  }

  // 分頁模式自己的搜尋字（檔案模式不受影響——字的去向由 main.js 決定）
  setQuery(q) {
    q = String(q || '');
    if (q === this.query) return;
    this.query = q;
    if (this.active) this.apply();
  }

  // 離開時記住目前最前面是哪張卡（回來時 _applyList 跳回同一張）
  _rememberPos() {
    const stack = this.deps.stack;
    const f = stack.view && stack.view[Math.round(stack.scrollCur)];
    this._restoreTabId = (f && f.tab && !f.tab.note) ? f.tab.id : null;
  }

  _unparkNameFilter() {
    if (this._parkedNameFilter == null) return;
    this.deps.stack.setNameFilter(this._parkedNameFilter);
    this._parkedNameFilter = null;
  }

  exit() {
    if (!this.active) return;
    this._rememberPos();
    this.active = false;
    this._gen++;                     // 飛在空中的 apply() 回來時直接丟
    this._shown = false;
    this._order = null;              // 下次進場照當下排序重排
    this._bootFocus = null; this._bootSetIdx = 0;
    this._lastFocusSetAt = 0;
    clearTimeout(this._refreshTimer);
    clearTimeout(this._waitTimer);
    this._pending = null;
    const back = this.returnTo;
    this.returnTo = null;
    this.deps.setBtnOn(false);
    this._unparkNameFilter();        // 檔案模式的檔名篩選放回去（跟搜尋框裡的字一致）
    this.deps.restore(back);
  }

  // 使用者在分頁模式裡點了別的資料夾／對話／疊：不算「回去」，單純退場（載入由那邊接手）
  drop() {
    if (!this.active) return;
    this._rememberPos();
    this.active = false;
    this._gen++;
    this._shown = false;
    this._order = null;
    this._bootFocus = null; this._bootSetIdx = 0;
    this._lastFocusSetAt = 0;
    clearTimeout(this._refreshTimer);
    clearTimeout(this._waitTimer);
    this._pending = null;
    this.returnTo = null;
    this.deps.setBtnOn(false);
    this._unparkNameFilter();
  }

  // SSE 'tabs' 事件：擴充推了新清單 → 防抖重抓（在分頁模式裡畫面跟著 Chrome 動）
  onServerPush() {
    if (!this.active) return;
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this.apply(), 350);
  }

  // 卡面右上角的 ×／⧉（畫進貼圖裡）命中判定：回 true＝這下點擊已被吃掉（關閉／複製）。
  // uv 是點在卡面上的位置（THREE intersect.uv：x=u、y=v；v=1＝卡頂）；null＝沒打在卡上。
  handleBadgeHit(file, uv) {
    if (!uv || !file || !file.tab || file.tab.note) return false;
    const zone = tabBadgeAt(uv.x, uv.y, { ai: !!this.deps.panel });   // 側邊欄才有 ⧉ 熱區（跟卡面畫的一致）
    if (zone === 'x') { this.closeTab(file.tab).catch(e => this.deps.toast(t('opFail', { msg: String((e && e.message) || e) }))); return true; }
    if (zone === 'ai' && typeof this.deps.copyForAi === 'function') { this.deps.copyForAi(file); return true; }
    return false;
  }

  // 「側欄模式」按鈕（右欄預覽那顆＋完整版工具列 ◫）：趁點擊手勢直送擴充——同一視窗
  // 打開 Chrome 側邊欄（/?mode=panel），帶了 tab 就順便把主視窗切過去。還原＝側欄頂列
  // 「回到完整畫面」或 Alt+Shift+R（擴充端 goFullFromPanel 全包）。
  // 手勢會過期：這裡到 chrome.runtime.sendMessage 之間不能有 await。
  // 擴充不在（Firefox／沒裝）→ _extOp 回 null → 只提示，不拋錯。
  // 擴充真的拒絕（r.ok === false）也當失敗提示，不假裝成功。
  // 回 {ok, panel} 或 null；結果記在 _lastPanelOpen 給測試鉤子。
  enterSidePanel(tab) {
    const tb = tab && Number.isFinite(Number(tab.id)) && Number(tab.id) > 0 ? tab : null;
    const payload = { type: 'riffle-click-tab' };
    if (tb) { payload.tabId = tb.id; payload.windowId = tb.windowId; }
    const p = this._extOp(payload, 1500);
    return Promise.resolve(p).then(r => {
      this._lastPanelOpen = r ? { ...r, tabId: tb ? tb.id : 0 } : { ok: false, panel: 'noext', tabId: tb ? tb.id : 0 };
      if (!r) this.deps.toast(t('tabsSideNoExt'));
      else if (!r.ok) this.deps.toast(t('tabsSideFail') + (r.error ? '：' + r.error : ''));
      return this._lastPanelOpen;
    });
  }

  // 切到這個 Chrome 分頁：只有側邊欄點卡與測試鉤子會走到（經 server 指令柱→擴充 tabs.update）。
  // 完整版點分頁卡＝右欄預覽那張（main.js 的 onClickIntercept），不切分頁、不自動開側欄。
  async activateTab(tab) {
    try {
      await apiJson('/api/tabs/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'activate', tabId: tab.id })
      });
      return (this._lastActivate = { via: 'server', ok: true });
    } catch (e) { this.deps.toast(t('opFail', { msg: e.message })); return (this._lastActivate = { via: 'server', ok: false }); }
  }

  // 通用直送（× 關閉／復原／回完整畫面都走這條；直送吃得到使用者手勢也不拖一輪輪詢）。
  // 回擴充的回應物件；chrome.runtime 不在／沒帶 extId／逾時 → null（叫用端走 server 路徑）。
  _extOp(payload, timeoutMs = 1200) {
    const rt = (typeof chrome !== 'undefined') && chrome.runtime;
    const extId = this.extId || '';
    if (!rt || typeof rt.sendMessage !== 'function' || !extId) return Promise.resolve(null);
    return new Promise(res => {
      let done = false;
      const to = setTimeout(() => fin(null), timeoutMs);
      const fin = v => { if (done) return; done = true; clearTimeout(to); res(v); };
      try {
        const p = rt.sendMessage(extId, payload, r => {
          fin(rt.lastError ? null : (r && typeof r === 'object' ? r : null));
        });
        if (p && typeof p.then === 'function') {
          p.then(r => fin(r && typeof r === 'object' ? r : null), () => fin(null));
        }
      } catch (_) { fin(null); }
    });
  }

  // ---- 卡角 × 鈕：關掉這個網頁 -----------------------------------------
  // 直傳擴充優先（新分頁 id 之外的判斷都在擴充端）；失敗（舊擴充／Firefox）退回
  // server 指令路徑。兩條都成了就本地立刻把卡拿掉（下一次推送本來就會少這個 id），
  // 再秀底部 toast「已關閉 · 復原」（約 6 秒）。復原＝chrome.sessions.restore()。
  async closeTab(tab) {
    let okClose = false;
    const r = await this._extOp({ type: 'riffle-close-tab', tabId: tab.id });
    if (r) okClose = r.ok !== false;             // 擴充說話了就算數
    else {
      try {
        await apiJson('/api/tabs/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'close', tabId: tab.id })
        });
        okClose = true;
      } catch (e) {
        // 404/no such tab：剛好在別處被關掉＝目的已達；503＝擴充不在，真的關不了
        okClose = /no such tab/i.test(String((e && e.message) || e));
      }
    }
    if (!okClose) { this.deps.toast(t('opFail', { msg: 'close' })); return (this._lastClose = { ok: false }); }
    this._lastClose = { ok: true, tabId: tab.id, via: r ? 'ext' : 'server' };
    this._removeLocal(tab.id);
    this.deps.toast(t('tabsClosed'), { label: t('undoLink'), fn: () => this.restoreClosed() });
  }

  async restoreClosed() {
    const r = await this._extOp({ type: 'riffle-restore-tab' });
    this._lastRestore = { via: r ? 'ext' : 'server' };
    if (r) {
      if (!r.ok) this.deps.toast(t('undoFail', { msg: '' }));   // sessions 沒東西可復原／不支援
      return;
    }
    try {
      await apiJson('/api/tabs/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'restore' })
      });
    } catch (e) { this.deps.toast(t('opFail', { msg: e.message })); }
  }

  // 本地立刻把關掉的卡從堆上移走（不動凍結卡序之外的東西；錨點機制讓鄰卡不跳）。
  // 關鍵：套用前重算 sig 成瘦身後清單的——留著舊 sig 的話，之後清單推回來
  // （復原／別處關了又回來）內容字串跟舊 sig 一樣就被 apply() 的 no-op 條件吃掉。
  _removeLocal(tabId) {
    const path = 'tab://' + tabId;
    this.tabs = this.tabs.filter(x => x.id !== tabId);
    if (this._order) this._order = this._order.filter(p => p !== path);
    if (this._shown) {
      const sig = (this.query ? 'q=' + this.query + '\n' : '') + TabsMode.sig(this.tabs);
      this._applyList(this.tabs, this.extAlive, sig);
    }
  }

  // 目前最前面那張卡的分頁 id（側欄用來回報「看到哪裡」；0＝現在沒停在某張分頁卡上）
  frontTabId() {
    const stack = this.deps.stack;
    const f = stack.view && stack.view[Math.round(stack.scrollCur)];
    return (f && f.tab && !f.tab.note) ? f.tab.id : 0;
  }

  // 捲到指定的分頁卡（外部聯動：擴充開側欄時帶 ?tabs=1&tabfocus=，之後點主畫面的卡
  // 也會轉訊息叫側欄捲）。沒在分頁模式就先進去。定位是否真的套上去由 _jumpToFocused
  // 把關：使用者剛滾／拖過時一律忽略（他們的位置優先），沒互動過的第一次才定位。
  focusTab(tabId) {
    const id = Math.floor(Number(tabId));
    if (!Number.isFinite(id) || id <= 0) return;
    this._focusTabId = id;
    if (!this.active) { this.enter(); return; }
    this._jumpToFocused();
  }

  // panel 開機用：直接進分頁模式並捲到某張（開機定位，跟點卡連動的 _focusTabId 不同條：
  // 點卡連動由 _jumpToFocused 把關——使用者剛接手時遲到的補送一律不動；
  // 開機定位只在使用者還沒自己滾動前生效，
  // 清單晚到而使用者已經在翻卡時絕不能把人拉走）
  enterAt(tabId) {
    const id = Math.floor(Number(tabId));
    if (Number.isFinite(id) && id > 0) this._bootFocus = id;
    return this.enter();
  }

  // 開機定位落地：目標卡在清單裡、且使用者進場後一張都還沒滾 → 跳過去，一次定案。
  // 目標卡不在（清單是舊的快照）→ 留到下一輪清單再試；使用者已滾動 → 直接放棄，永不回頭。
  _applyBootFocus() {
    const id = this._bootFocus;
    if (id == null || !this._shown) return;
    const stack = this.deps.stack;
    const idx = stack.view.findIndex(f => f.tab && f.tab.id === id);
    // 「使用者動過」只看位置（拖曳進行中也算）：位置不為開機定位設的那張＝滾／拖過。
    // 不看 wheelUntil——清單還沒來時卡堆是空的（滾不動），那種滾輪不算互動。
    const moved = stack.dragging === true
      || Math.round(stack.scrollTarget) !== (this._bootSetIdx || 0)
      || Math.round(stack.scrollCur) !== (this._bootSetIdx || 0);
    if (idx >= 0) {
      if (!moved && idx > 0) {
        stack.scrollCur = idx; stack.scrollTarget = idx; stack.scrollVel = 0;
        this._bootSetIdx = idx;
      }
      this._bootFocus = null;
    } else if (moved) {
      this._bootFocus = null;
    }
  }

  _jumpToFocused() {
    const id = this._focusTabId;
    if (id == null || !this._shown) return;
    const stack = this.deps.stack;
    const idx = stack.view.findIndex(f => f.tab && f.tab.id === id);
    if (idx < 0) return;   // 清單還沒更新到那張：留著，下一輪 _applyList 再試
    // 使用者最近的滾輪／拖曳 = 已接手：風暴窗內的定位一律忽略（定案一次，之後倒給背景
    // 的補送也自我了斷）。「最近一次」不是看位置——滾在空卡堆上位置不動，但那仍是意圖。
    // 補送風暴來源：sidepanel.js 開側欄後會把同一個 tabId 連送 12 次 × 500ms（iframe 可能
    // 還沒建好），沒趕上開場的 poke 會在使用者滾動之後才到——不擋的話整疊被拉回那張卡
    // （剛被啟用的分頁通常就在第 0 張 →「被迫拉回第一張」）。
    const now = performance.now();
    const lastActRaw = stack.lastUserScrollAt || 0;
    const lastAct = lastActRaw > this._scrollStampAtEnter ? lastActRaw : 0;   // 只算進場之後的滾動
    const userMoved = stack.dragging === true
      || (lastAct > this._lastFocusSetAt && now - lastAct < FOCUS_FRESH_MS);
    if (userMoved) { this._focusTabId = null; return; }   // 使用者意圖優先：這個定位指令作廢
    stack.scrollCur = idx; stack.scrollTarget = idx; stack.scrollVel = 0;
    this._lastFocusSetAt = now;
    this._focusTabId = null;
  }

  // __dbg：e2e 用——用 JS 直接叫，不模擬滑鼠找卡角
  _dbg() {
    return {
      active: this.active,
      tabs: this.tabs.length,
      viewN: (this.deps.stack.view && this.deps.stack.view.length) || 0,
      extAlive: this.extAlive,
      extId: this.extId || '',
      returnKind: (this.returnTo && this.returnTo.kind) || null,
      lastPanelOpen: this._lastPanelOpen || null,
      query: this.query,
      restoreTabId: this._restoreTabId,
      bootFocus: this._bootFocus != null ? this._bootFocus : null,
      focusTabId: this._focusTabId != null ? this._focusTabId : null,
      lastActivate: this._lastActivate || null,
      lastClose: this._lastClose || null,
      lastRestore: this._lastRestore || null,
      focusTab: id => this.focusTab(id),          // 模擬「點卡聯動：側欄捲到這張」
      sidePanel: i => {                           // 模擬「側欄模式」鈕（i 省略＝工具列：不帶分頁）
        const f = (i == null) ? null : this.deps.stack.view[i];
        return this.enterSidePanel(f && f.tab && !f.tab.note ? f.tab : null);
      },
      backToFull: () => this._extOp({ type: 'riffle-back-to-full', tabId: this.frontTabId() }, 1500),
      order: () => (this._order || []).slice(),   // 凍結卡序（e2e：驗點卡後不重排）
      activate: i => {                          // 模擬側欄單擊分頁卡→切分頁
        const f = this.deps.stack.view[i];
        return f && f.tab && !f.tab.note ? this.activateTab(f.tab) : Promise.resolve();
      }
    };
  }

  toggle() { return this.active ? this.exit() : this.enter(); }
}
