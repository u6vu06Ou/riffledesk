// extension/i18n.js — tiny zh/en dictionary for the extension's own UI
// (options page, side panel shell, and the background worker's debug strings
// that surface on the options page). Plain script, no DOM/chrome API at load
// time, so it works in the MV3 service worker (importScripts), the Firefox
// background page (background.scripts), and both HTML pages (<script src>).
// Language: localStorage 'floderLang' (same key the main UI uses) when the
// page has one; otherwise navigator.language, zh* → zh.
(function () {
  const zh = {
    optTitle: 'RiffleDesk Tabs Bridge 設定',
    optIntro: '這個擴充把你 Chrome 開著的網頁清單送到本機的 RiffleDesk（127.0.0.1）顯示成卡片。什麼都不會傳到別的地方。',
    optPortLabel: 'RiffleDesk 伺服器埠號',
    optPortNote: '預設 5177。只有你用別的埠號跑 RiffleDesk 才需要改（例如 PORT=5180）。',
    optSave: '存',
    optIdle: '閒置時自動補拍截圖',
    optIdleNote: '離開電腦 60 秒以上、視窗沒最小化也沒全螢幕時，才依序把缺截圖的網頁各拍一張（你平常切過的網頁本來就會隨手拍，這裡是補沒切過的；沒切過的背景網頁也會先用 DOM 繪圖補一張）。一回來就停，並把網頁與焦點還原成原來的樣子。被 Chrome 休眠的網頁與 chrome:// 頁面不會被驚動。',
    optClearShots: '清除截圖快取',
    optCacheNote: '截圖為了「重開瀏覽器卡片不變空白」存在這個瀏覽器 profile 的本機資料庫（IndexedDB，上限約 300 張／100MB，最舊的先淘汰）。按這裡立刻全部清掉；RiffleDesk 伺服器記憶體裡那一份會在伺服器重開時消失。',
    optDrawer: '自動收合側欄（滑鼠碰視窗邊緣展開）',
    optDrawerNote: '開啟後，滑鼠碰到一般網頁的視窗邊緣停一下就滑出 RiffleDesk 面板；移開就自動收合，標頭 📌 可釘住不收，拖抽屜內緣把手可調整寬度。瀏覽器規定使它不能在 chrome:// 系統頁、Chrome 線上應用程式商店與內建 PDF 檢視器運作；真側邊欄開著時此功能自動停用。需要「存取所有網站資料」權限（Firefox 要在 about:addons 手動開）。',
    optDrawerSide: '抽屜位置',
    optDrawerSideRight: '視窗右邊緣',
    optDrawerSideLeft: '視窗左邊緣',
    optDbgTitle: '除錯：抓網頁文字／代表圖失敗紀錄',
    optClearing: '清除中…', optCleared: '已清除。', optClearFail: '清除失敗。', optClearFailMsg: '清除失敗：{msg}',
    optPortBad: '埠號要是 1–65535 的整數。',
    optSaveFail: '存不進去：{msg}', optSaved: '已存。',
    timeNever: '（還沒連上過）', timeJustNow: '剛剛', timeSecsAgo: '{s} 秒前',
    stPort: '目前埠號：{port}', stLastPush: '最後一次成功推送：{when}',
    stSweepLine: '閒置補拍：{s}',
    stSweepRunning: '正在補拍中', stSweepLast: '上次 {time}，補了 {n} 張',
    stSweepOff: '已關閉', stSweepNever: '還沒跑過（離開電腦 60 秒以上才會開始）',
    stSleeping: '休眠中的網頁：{n} 個（Chrome 省記憶體睡的，刻意不叫醒；切到它就會補文字與截圖）',
    stShotStore: '截圖快取：{n} 張（約 {mb}MB，IndexedDB 本機持久）',
    stLastErr: '最後錯誤：{msg}',
    dbgNone: '（沒有失敗紀錄）',
    sideTitle: 'RiffleDesk 側邊欄', sideFrameTitle: 'RiffleDesk 面板',
    drawerTitle: 'RiffleDesk 面板',
    drawerPinTip: '釘住：留在畫面上不自動收合（再按一次取消）',
    sideDownH: 'RiffleDesk 伺服器還沒啟動',
    sideStep1: '打開 RiffleDesk 的資料夾',
    sideStep2: '雙擊 start.bat（或在資料夾裡跑 npm start）',
    sideStep3: '這裡會自己連上（每 3 秒重試一次）',
    sideRetry: '立即重試',
    sideReconnecting: '連線暫時中斷，正在重試；目前畫面已保留。',
    sideBackNote: '回到完整視窗：<b>Alt+Shift+R</b>（改快捷鍵：chrome://extensions/shortcuts）',
    sideBackNoteFf: '回到完整視窗：<b>Alt+Shift+R</b>（僅 Firefox 有焦點時）。改快捷鍵：about:addons 右上角齒輪 →「管理擴充功能快捷鍵」',
    bgGrabTimeout: 'grab timeout：網頁凍結或無回應',
    bgKindFrozen: '凍結／無回應', bgKindNoPerm: '無權限進入網頁', bgKindClosed: '網頁已關閉', bgKindOther: '其他錯誤',
    bgOgFail: '代表圖下載失敗：',
    bgEmpty: '抓到空內容：頁面可能還在載入',
    bgDrawTimeout: 'draw timeout（網頁凍結或太重）',
    bgDrawShrinkFail: 'DOM 繪圖縮圖失敗', bgDrawFail: 'DOM 繪圖失敗：', bgDrawThrow: 'DOM 繪圖例外：'
  };
  const en = {
    optTitle: 'RiffleDesk Tabs Bridge settings',
    optIntro: 'This extension hands the list of pages you have open in Chrome to the local RiffleDesk (127.0.0.1) so they show up as cards. Nothing leaves this machine.',
    optPortLabel: 'RiffleDesk server port',
    optPortNote: 'Default 5177. Only change this if you run RiffleDesk on another port (e.g. PORT=5180).',
    optSave: 'Save',
    optIdle: 'Backfill screenshots while idle',
    optIdleNote: 'When you have been away for 60+ seconds and the window is neither minimized nor fullscreen, pages missing a screenshot are captured one by one (pages you visit are captured as you go — this covers the ones you never visited; background pages that stayed backgrounded also get a DOM-drawn image first). It stops the moment you come back and restores the original page and focus. Pages Chrome suspended and chrome:// pages are never disturbed.',
    optClearShots: 'Clear screenshot cache',
    optCacheNote: 'Screenshots live in this browser profile’s local database (IndexedDB, about 300 images / 100 MB max, oldest evicted first) so cards are not blank after a browser restart. This button clears them all at once; the copy in the RiffleDesk server’s memory disappears when the server restarts.',
    optDrawer: 'Auto-hide side panel (mouse to the window edge to open)',
    optDrawerNote: 'When on, hovering the window edge of a normal web page for a moment slides the RiffleDesk panel out; moving away folds it back, 📌 in its header pins it open, and dragging its inner edge resizes it. Browser rules keep it off chrome:// pages, the Chrome Web Store and the built-in PDF viewer, and it stands down while the real side panel is open. Needs the “access all sites” permission (in Firefox, grant it by hand in about:addons).',
    optDrawerSide: 'Drawer position',
    optDrawerSideRight: 'right edge',
    optDrawerSideLeft: 'left edge',
    optDbgTitle: 'Debug: failures fetching page text / hero images',
    optClearing: 'Clearing…', optCleared: 'Cleared.', optClearFail: 'Clear failed.', optClearFailMsg: 'Clear failed: {msg}',
    optPortBad: 'The port must be an integer between 1 and 65535.',
    optSaveFail: 'Could not save: {msg}', optSaved: 'Saved.',
    timeNever: '(never connected)', timeJustNow: 'just now', timeSecsAgo: '{s} s ago',
    stPort: 'Current port: {port}', stLastPush: 'Last successful push: {when}',
    stSweepLine: 'Idle backfill: {s}',
    stSweepRunning: 'running now', stSweepLast: 'last at {time}, {n} taken',
    stSweepOff: 'off', stSweepNever: 'not yet (starts after 60 s idle)',
    stSleeping: 'Sleeping pages: {n} (Chrome suspended them to save memory; deliberately not woken — activating one backfills text and a screenshot)',
    stShotStore: 'Screenshot cache: {n} (about {mb} MB, local IndexedDB)',
    stLastErr: 'Last error: {msg}',
    dbgNone: '(no failures recorded)',
    sideTitle: 'RiffleDesk side panel', sideFrameTitle: 'RiffleDesk panel',
    drawerTitle: 'RiffleDesk panel',
    drawerPinTip: 'Pin: keep the panel open (click again to un-pin)',
    sideDownH: 'The RiffleDesk server is not running',
    sideStep1: 'Open the RiffleDesk folder',
    sideStep2: 'Double-click start.bat (or run npm start inside the folder)',
    sideStep3: 'This page connects by itself (retries every 3 s)',
    sideRetry: 'Retry now',
    sideReconnecting: 'Connection interrupted. Retrying; your current view is preserved.',
    sideBackNote: 'Back to the full window: <b>Alt+Shift+R</b> (change it at chrome://extensions/shortcuts)',
    sideBackNoteFf: 'Back to the full window: <b>Alt+Shift+R</b> (only while Firefox is focused). Change it here: about:addons → gear icon → “Manage Extension Shortcuts”',
    bgGrabTimeout: 'grab timeout: page frozen or unresponsive',
    bgKindFrozen: 'frozen or unresponsive', bgKindNoPerm: 'no permission for this page', bgKindClosed: 'page closed', bgKindOther: 'other error',
    bgOgFail: 'hero image download failed: ',
    bgEmpty: 'empty content: the page may still be loading',
    bgDrawTimeout: 'draw timeout (page frozen or too heavy)',
    bgDrawShrinkFail: 'DOM draw: shrink failed', bgDrawFail: 'DOM draw failed: ', bgDrawThrow: 'DOM draw exception: '
  };
  let lang = null;
  function detect() {
    if (lang) return lang;
    try {
      const s = (typeof localStorage !== 'undefined') && localStorage.getItem('floderLang');
      if (s === 'zh' || s === 'en') return (lang = s);
    } catch (_) { /* service worker: no localStorage */ }
    const nl = (typeof navigator !== 'undefined' && navigator.language) || '';
    return (lang = /^zh/i.test(nl) ? 'zh' : 'en');
  }
  function t(key, vars) {
    const L = detect();
    let s = (L === 'en' ? (en[key] !== undefined ? en[key] : zh[key]) : zh[key]);
    if (s === undefined) s = key;
    if (vars) for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
    return s;
  }
  // data-i18n → textContent, data-i18n-title → title, data-i18n-ph → placeholder,
  // data-i18n-label → aria-label, data-i18n-html → innerHTML (only for strings
  // we author here; used where a link/bold inside the copy matters).
  function applyStatic(root) {
    const doc = root || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;
    const h1 = doc.querySelector('[data-i18n-page]');
    if (h1) doc.title = t(h1.getAttribute('data-i18n-page'));
    for (const el of doc.querySelectorAll('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n'));
    for (const el of doc.querySelectorAll('[data-i18n-title]')) el.title = t(el.getAttribute('data-i18n-title'));
    for (const el of doc.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.getAttribute('data-i18n-ph'));
    for (const el of doc.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.getAttribute('data-i18n-label')));
    for (const el of doc.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.getAttribute('data-i18n-html'));
  }
  const RD_I18N = { t, applyStatic, get lang() { return detect(); }, zh, en };
  if (typeof globalThis !== 'undefined') globalThis.RD_I18N = RD_I18N;
})();
