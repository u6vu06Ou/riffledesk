// extension/drawer.js — 自動收合側欄（視窗邊緣抽屜）內容腳本。
// 注入時機：manifest content_scripts，document_idle，只對 http/https、只掛頂層框架。
//
// 為什麼這是內容腳本而不是真側邊欄：Chrome 沒有 API 能把真側邊欄收成一條，
// 而且 sidePanel.open 需要使用者手勢（滑鼠懸停不算）。所以「碰視窗邊緣展開」只能
// 用頁面覆疊的方式自己做——一個 shadow-DOM host：12px 隱形觸發條貼在視口邊緣
// （預設右緣，設定可改左緣），滑鼠停上去約 120ms（按住按鈕／拖曳中不算）抽屜滑入
// （150ms transform），覆在頁面上（不改版面寬度）。內容是本擴充頁的 iframe
// （sidepanel.html?drawer=1，已列 web_accessible_resources，頁面 CSP 擋不了
// chrome-extension:// 框架）；iframe 第一次打開才建、之後用 transform 藏起來不拆掉，
// 重開是即時的。
// 傳統（非覆疊）直捲軸的死區：觸發條對齊的是「版面視口」邊緣，版面視口不含捲軸——
// Windows 傳統捲軸佔掉最外側 15~17px，滑鼠撞到螢幕最邊其實停在捲軸上，事件永遠
// 不落在觸發條上（舊版 6px 條＋無 fallback 的組合就叫不出抽屜）。但 Chrome 仍把
// 「停在捲軸上的 mousemove」派給 document（clientX 會超過 documentElement
// .clientWidth），所以 window 層再補盯一個「已到版面視口邊緣」的條件走同一套 dwell。
// 離開抽屜 400ms 或 Esc 收合；標頭 📌 釘住不收。寬度拖抽屜內緣把手調、存 storage.local。
// 真 Chrome 側邊欄在本視窗開著時抽屜自動停用（背景用 riffle-panel 長連線的
// panel-hello 記每個視窗開沒開，狀態變化廣播給各分頁），避免一窗兩面板。
// chrome://、線上應用程式商店、內建 PDF 檢視器進不去（瀏覽器不讓內容腳本跑）。
(function () {
  'use strict';
  if (window.top !== window) return;                 // 只有頂層頁面掛抽屜
  const HOST_ID = 'riffle-drawer-host';
  // 防重複旗標：活體才擋。擴充重載／更新後舊腳本變孤兒（runtime 已死、事件監聽全啞），
  // 但它蓋的 shadow host 遺體還留在頁面上——探到死實體就拆掉舊 host、換新實體接管；
  // 探到活實體（同頁重複注入，例如背景補種）直接跳過，不準雙掛。
  // 更舊版只放布林 true：帶布林旗標的腳本必然是舊版，新腳本能跑到這行時它已成孤兒，
  // 一律當死處理（拆掉它的 host 才能復活）。
  // 先確認「我們自己」是活的（有 runtime id）才准動 page 上的遺體：
  // 孤兒腳本先動手會留下「沒抽屜、旗標又活著」的死狀態。
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api || !api.runtime || !api.storage || !api.storage.local) return;
  try { if (!api.runtime.id) return; } catch (_) { return; }   // 孤兒腳本（擴充已重載）
  {
    const prev = window.__rdDrawerInit;
    if (prev) {
      let alive = false;
      if (typeof prev === 'object' && typeof prev.alive === 'function') {
        try { alive = !!prev.alive(); } catch (_) { alive = false; }
      }
      if (alive) return;                             // 活實體在：重複注入，跳過
      try { document.querySelectorAll('#' + HOST_ID).forEach(h => h.remove()); } catch (_) {}
    }
  }
  window.__rdDrawerInit = {                          // 先佔旗標再往下跑：後到的注入馬上被擋
    alive: () => { try { return !!api.runtime.id; } catch (_) { return false; } }
  };

  const ti = (typeof RD_I18N !== 'undefined' && RD_I18N.t) || (k => k);
  const DWELL_MS = 120;      // 碰到邊緣停這麼久才展開
  const CLOSE_MS = 400;      // 離開抽屜這麼久才收合
  const SLIDE_MS = 150;      // 滑入／滑出動畫
  const DEF_W = 420, MIN_W = 280, MAX_W = 900;
  const TRIGGER_W = 12;      // 觸發條寬（6px 太細，全螢幕撞邊常滑過去沒停到）

  let enabled = false;       // options 開關（預設關）
  let skipSelf = false;      // RiffleDesk 自家頁（本體／mode=panel）：不掛，免得面板套面板
  let panelOpen = false;     // 本視窗真側邊欄開著（背景廣播／查詢得知）
  let host = null, shadow = null, els = null;
  let isOpen = false, pinned = false, width = DEF_W;
  let dwellT = 0, closeT = 0, lingerT = 0, lastButtons = 0, mouseDown = false;
  let reopenGate = false;    // Esc 收合後：指標還停在觸發條上時不準立刻重開
  let drag = null;           // {x0, w0} 把手拖曳中
  let lastX = -1e9, lastY = -1e9;   // 最近一次 mousemove 的座標（徘徊收合做幾何判定）
  const LINGER_MS = 1500;    // 開啟後指標一直不在抽屜範圍，這麼久就轉自動收合
  let side = 'right';        // 'right' | 'left'（options 可切，預設右）
  let rtl = false;           // 根元素 direction:rtl（傳統捲軸會跑到左邊）
  let edgeHot = false;       // 視窗層補盯：指標目前在「邊緣區」內
  let lastEdgeChk = 0;       // 邊緣區判定的節流時間戳（mousemove 太密）

  function clampW(w) {
    const cap = Math.min(MAX_W, Math.max(240, Math.round((window.innerWidth || 1280) * 0.9)));
    const min = Math.min(MIN_W, cap);
    return Math.max(min, Math.min(cap, Math.round(w)));
  }

  // ---------------------------------------------------------------- shadow UI
  // 右邊：觸發條/抽屜 right:0、從右滑入（translateX(+105%) 藏）、把手在抽屜左緣；
  // 左邊：全部鏡像（left:0、-105%、把手在右緣、陰影換邊）。
  function cssFor(s) {
    const onRight = s !== 'left';
    const edge = onRight ? 'right' : 'left';
    return [
      ':host{all:initial}',
      `.t{position:fixed;top:0;${edge}:0;width:${TRIGGER_W}px;height:100vh;z-index:2147483647;background:rgba(0,0,0,0)}`,
      `.d{position:fixed;top:0;${edge}:0;height:100vh;z-index:2147483647;display:flex;flex-direction:column;` +
        `background:#17191d;box-shadow:${onRight ? '-' : ''}6px 0 24px rgba(0,0,0,.45);` +
        `transform:translateX(${onRight ? '' : '-'}105%);` +
        `transition:transform ${SLIDE_MS}ms ease-out;will-change:transform;font:12px/1.5 system-ui,sans-serif;color:#cfd6de}`,
      '.d[data-open="1"]{transform:translateX(0)}',
      '.hd{flex:0 0 26px;display:flex;align-items:center;gap:6px;padding:0 4px 0 8px;background:#20242a;' +
        'user-select:none;-webkit-user-select:none;cursor:default}',
      '.ic{width:14px;height:14px;flex:0 0 auto}',
      '.hd-t{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;opacity:.75}',
      '.pin{border:0;background:transparent;color:inherit;cursor:pointer;font-size:13px;line-height:1;' +
        'padding:3px 5px;border-radius:4px;opacity:.5}',
      '.pin:hover{background:#2c3138;opacity:.9}',
      '.pin[data-on="1"]{opacity:1}',
      '.f{flex:1 1 auto;min-height:0;width:100%;border:0;background:#121417}',
      `.g{position:absolute;${onRight ? 'left' : 'right'}:0;top:0;bottom:0;width:7px;cursor:col-resize;z-index:2}`
    ].join('\n');
  }

  function buildUI() {
    if (host) return;
    try { rtl = getComputedStyle(document.documentElement).direction === 'rtl'; } catch (_) {}
    host = document.createElement('div');
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: 'open' });
    // adoptedStyleSheets 不吃頁面 CSP 的 style-src（嚴格 CSP 網站也能有樣式）；
    // 老引擎不支援就退回 <style> 元素
    let style = null;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssFor(side));
      shadow.adoptedStyleSheets = [sheet];
    } catch (_) {
      style = document.createElement('style');
      style.textContent = cssFor(side);
    }
    const trigger = document.createElement('div');
    trigger.className = 't';
    const drawer = document.createElement('div');
    drawer.className = 'd';
    drawer.dataset.open = '0';
    const hd = document.createElement('div');
    hd.className = 'hd';
    const icon = document.createElement('img');
    icon.className = 'ic';
    icon.alt = '';
    // icons/icon-32.png 已列 web_accessible_resources
    try { icon.src = api.runtime.getURL('icons/icon-32.png'); } catch (e) { noteApiError(e); }
    if (!host) return;                               // getURL 丟 invalidated：孤兒已在善後，停手
    const ttl = document.createElement('span');
    ttl.className = 'hd-t';
    ttl.textContent = ti('drawerTitle');
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'pin';
    pin.dataset.on = pinned ? '1' : '0';
    pin.textContent = '📌';
    pin.title = ti('drawerPinTip');
    hd.append(icon, ttl, pin);
    const grip = document.createElement('div');
    grip.className = 'g';
    drawer.append(hd, grip);
    if (style) shadow.appendChild(style);
    shadow.append(trigger, drawer);
    (document.documentElement || document.body || document.head).appendChild(host);
    els = { trigger, drawer, pin, grip, frame: null };
    applyWidth();
    swallowZoomGestures(drawer);                     // 只蓋抽屜殼；觸發條（常駐）不攔
    wire();
  }

  function teardownUI() {
    clearTimeout(dwellT); clearTimeout(closeT); clearTimeout(lingerT);
    if (host) host.remove();
    host = shadow = els = null;
    isOpen = false;
    edgeHot = false;
  }

  // 孤兒善後：擴充重載／移除後內容腳本變孤兒，擴充 API 一碰就丟
  // 「Extension context invalidated」。留著 UI 會變成叫不出內容的死殼——拆掉 UI、
  // 清掉 __rdDrawerInit 旗標（清成 null＝沒人佔），背景的補種機制才探得到、重建活體。
  function noteApiError(err) {
    if (err && /invalidated/i.test(String((err && err.message) || err))) dieOrphan();
  }
  let dying = false;                                 // teardown 途中的 API 錯誤不再遞迴善後
  function dieOrphan() {
    if (dying) return;
    dying = true;
    try {
      enabled = false;                               // 孤兒不再自癒，等背景補種換新實體
      teardownUI();
      try { window.__rdDrawerInit = null; } catch (_) {}
    } finally { dying = false; }
  }

  function applyWidth() {
    if (els) els.drawer.style.width = width + 'px';
  }

  function mountFrame() {
    let url = null;
    // ?drawer=1：面板殼知道自己是抽屜——不報「真側邊欄開著」、Esc 回傳主頁收合
    try { url = api.runtime.getURL('sidepanel.html?drawer=1'); }
    catch (e) { noteApiError(e); return; }           // 孤兒：dieOrphan 已拆 UI，別再往下蓋
    if (!els) return;
    const f = document.createElement('iframe');
    f.className = 'f';
    f.title = ti('sideFrameTitle');
    f.setAttribute('allow', 'clipboard-read; clipboard-write');
    f.src = url;
    els.drawer.appendChild(f);
    els.frame = f;
  }

  // ---------------------------------------------------------------- 開合
  function setOpen(v) {
    if (!els) return;
    if (v && (!enabled || panelOpen)) v = false;      // 真側邊欄開著／功能關著就不准開
    if (v && !els.frame) {
      mountFrame();
      if (!els) return;                             // mountFrame 偵測到孤兒已把 UI 拆掉
    }
    isOpen = v;
    els.drawer.dataset.open = v ? '1' : '0';
    if (v) {
      // 徘徊收合：從傳統捲軸上叫開時指標落在抽屜外（捲軸凸出版面視口，抽屜只對齊
      // 版面視口邊緣、蓋不到捲軸）——滑鼠永遠不 mouseenter 抽屜，就等不到
      // mouseleave 的 armClose，會常駐死開。獨立計時器（不能用 closeT：指標在邊緣
      // 熱區抖一下就把 closeT 清了）：緩衝期到後拿「最近一次指標座標」對抽屜矩形
      // 做幾何判定，還在範圍內（含滑入蓋到靜止指標的正常情境）就不收。
      clearTimeout(lingerT);
      lingerT = setTimeout(() => {
        lingerT = 0;
        if (!isOpen || pinned || drag || !els) return;
        const r = els.drawer.getBoundingClientRect();
        if (lastX >= r.left && lastX <= r.right && lastY >= r.top && lastY <= r.bottom) return;
        armClose();
      }, LINGER_MS);
    }
  }

  function startDwell() {
    clearTimeout(dwellT);
    if (!enabled || panelOpen || mouseDown || isOpen || reopenGate) return;
    dwellT = setTimeout(() => {
      dwellT = 0;
      if (!enabled || panelOpen || isOpen || reopenGate) return;
      if (mouseDown || lastButtons) return;           // 按住／拖曳／圈選文字中不展開
      setOpen(true);
    }, DWELL_MS);
  }

  function armClose() {
    if (drag) return;                                  // 拖著把手時不收
    clearTimeout(closeT);
    closeT = setTimeout(() => { closeT = 0; if (isOpen && !pinned && !drag) setOpen(false); }, CLOSE_MS);
  }

  // -------------------------------------------------- 本機吞掉瀏覽器縮放手勢
  // 目標：指標在抽屜上 Ctrl+滾輪（觸控板捏合也是 ctrlKey wheel）不准縮放「主頁」。
  // 舊做法是指標進出時用 tabs.setZoomSettings 把本分頁的 zoom mode 暫扣成 disabled
  // ——動 mode/scope 會重設分頁縮放級別（per-origin ≠100% 的網站會跳回 100%），
  // 每次進出都重排版面並彈出 Chrome 縮放氣泡，已廢棄。現在改本機擋：
  // ctrl+wheel 只在「事件沒被取消」時才觸發整頁縮放，preventDefault 掉就沒氣泡、
  // 也不碰縮放級別；事件照樣往下路由——巢狀 iframe（OOPIF）裡的滾輪不浮到本文件，
  // 那一層由面板頁自己的 non-passive handler 擋（stack.js 畫布＝相機遠近、main.js
  // 其餘處＝介面縮放，兩邊都 preventDefault），所以這裡只蓋抽屜殼外露的部分
  // （頂列、把手）。掛在 .d 不掛 host：觸發條常駐可見，抽屜收著時條上的
  // ctrl+滾輪要照常縮放頁面。縮放快捷鍵同理：焦點落在抽屜殼內時 Ctrl/Cmd ＋ -/=/0
  // 在這裡擋——按 e.code 比實體鍵，不隨鍵盤佈局漂移；焦點在 iframe 內的由
  // sidepanel.js（drawer 模式）與面板頁各擋各的。
  const ZOOM_KEY_CODES = new Set(['Equal', 'Minus', 'Digit0', 'Numpad0', 'NumpadAdd', 'NumpadSubtract']);
  function swallowZoomGestures(root) {
    root.addEventListener('wheel', e => {
      if (e.ctrlKey) e.preventDefault();             // 被取消的 ctrl+wheel 不做整頁縮放
    }, { capture: true, passive: false });
    root.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && ZOOM_KEY_CODES.has(e.code)) e.preventDefault();
    }, { capture: true });
  }

  // -------------------------------------------- 傳統捲軸死區的視窗層補盯
  // 觸發條對齊「版面視口」邊緣，版面視口不含傳統直捲軸；滑鼠停在捲軸上時事件不落在
  // 條上，但 document 仍收得到 mousemove（clientX 超出 clientWidth）——用同一套
  // dwell 邏輯在這裡補盯邊緣。按住按鈕（正在拖捲軸）時 startDwell 自己會拒絕。
  function inEdgeZone(x) {
    const de = document.documentElement;
    const iw = window.innerWidth || 0;
    const cw = de.clientWidth || iw;
    if (side === 'right') {
      // LTR：內容 [0,cw]、捲軸 [cw,iw]——cw-2 起涵蓋觸發條剩餘＋整條捲軸。
      // RTL（捲軸在左邊）：右緣就是物理右緣。
      return x >= (rtl ? iw - 2 : cw - 2);
    }
    // 左邊模式：LTR 左緣是物理左緣；RTL 左緣外側是捲軸
    return x <= (rtl ? (iw - cw) + 2 : 2);
  }
  function edgeCheck(e) {
    if (!host || !enabled || panelOpen) return;
    const now = performance.now();
    if (now - lastEdgeChk < 40) return;              // 節流 ~25Hz（mousemove 可達每秒百次）
    lastEdgeChk = now;
    if (inEdgeZone(e.clientX)) {
      edgeHot = true;
      if (!isOpen) startDwell();                     // 內部先 clearTimeout，重複呼叫無害
    } else if (edgeHot) {
      edgeHot = false;
      clearTimeout(dwellT); dwellT = 0;
      reopenGate = false;                            // 離開邊緣區＝可再次觸發（同觸發條 mouseleave）
    }
  }

  function wire() {
    const { trigger, drawer, pin, grip } = els;
    trigger.addEventListener('mouseenter', e => { lastButtons = e.buttons; startDwell(); });
    trigger.addEventListener('mousemove', e => { lastButtons = e.buttons; if (!isOpen) startDwell(); });
    trigger.addEventListener('mouseleave', () => {
      clearTimeout(dwellT); dwellT = 0;
      reopenGate = false;                              // 指標離開觸發條＝可以再次觸發
    });
    trigger.addEventListener('mousedown', () => {
      // 使用者要在條子的位置點「底下的東西」（頁面內容；有傳統捲軸時條子貼著捲軸
      // 內緣，點偏一點就落在條上）：按下時讓條子自廢武功，不攔這次操作。
      // （條子對齊版面視口邊緣，「滑鼠在捲軸上」的點擊本來就打不到它——
      //  捲軸上的懸停改由視窗層的 edgeCheck 補盯。）
      trigger.style.pointerEvents = 'none';
    });
    drawer.addEventListener('mouseenter', () => {
      clearTimeout(closeT); closeT = 0; clearTimeout(dwellT);
    });
    drawer.addEventListener('mouseleave', () => {
      if (!pinned) armClose();
    });
    pin.addEventListener('click', () => {
      pinned = !pinned;
      pin.dataset.on = pinned ? '1' : '0';
      pin.title = ti('drawerPinTip');
      if (pinned) clearTimeout(closeT);
      else if (isOpen) armClose();                    // 取消釘住＝恢復自動收合
    });
    grip.addEventListener('mousedown', e => {
      drag = { x0: e.clientX, w0: width };
      clearTimeout(closeT); closeT = 0;               // 拖曳過程不算「離開抽屜」
      if (els.frame) els.frame.style.pointerEvents = 'none';   // 拖曳途經 iframe 不截走 mousemove
      e.preventDefault();
      e.stopPropagation();
    });
  }

  // 全域滑鼠狀態：按鈕按住不展開；拖曳把手在這裡走；傳統捲軸死區由 edgeCheck 補
  window.addEventListener('mousedown', () => { mouseDown = true; }, true);
  window.addEventListener('mouseup', () => {
    mouseDown = false;
    if (els && els.trigger) els.trigger.style.pointerEvents = '';   // 還原觸發條
    if (drag) {
      drag = null;
      if (els && els.frame) els.frame.style.pointerEvents = '';
      try { Promise.resolve(api.storage.local.set({ drawerWidth: width })).catch(noteApiError); }
      catch (e) { noteApiError(e); }
    }
  }, true);
  window.addEventListener('mousemove', e => {
    lastButtons = e.buttons;
    lastX = e.clientX; lastY = e.clientY;
    if (drag) {
      // 右邊模式：把手在抽屜左緣，往左拖變寬；左邊模式鏡像（把手在右緣，往右拖變寬）
      width = clampW(drag.w0 + (side === 'right' ? drag.x0 - e.clientX : e.clientX - drag.x0));
      applyWidth();
      e.preventDefault();
      return;
    }
    edgeCheck(e);
    if (isOpen && els) {
      // 幾何式收合：進出 iframe（OOPIF）時 mouseenter/leave 在某些環境（如 headless）
      // 不會點燃，只靠 drawer 的 mouseleave 會漏收。指標在主頁有動靜時，直接拿座標
      // 對「抽屜外接矩形∪邊緣熱區」判定：在裡面取消收合；出了熱區照一般 400ms 收。
      // （邊緣熱區含傳統捲軸這一段——從捲軸上叫開後指標還停在邊上，不能馬上被收掉；
      //  完全沒動靜的死開由 setOpen 的徘徊收合處理。）
      const r = els.drawer.getBoundingClientRect();
      const over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (over || inEdgeZone(e.clientX)) {
        clearTimeout(closeT); closeT = 0;
      } else if (!pinned) {
        armClose();
      }
    }
  }, true);
  window.addEventListener('keydown', e => {
    // Esc 收合（不擋頁面自己的 Esc）；收合後到指標離開觸發條之前不準立刻重開
    if (e.key === 'Escape' && isOpen) { setOpen(false); reopenGate = true; }
  }, true);
  window.addEventListener('resize', () => {           // 視窗變窄時重夾寬度
    try { rtl = getComputedStyle(document.documentElement).direction === 'rtl'; } catch (_) {}
    if (!els) return;
    const c = clampW(width);
    if (c !== width) { width = c; applyWidth(); }
  }, { passive: true });

  // ---------------------------------------------------------------- 狀態來源
  // 背景：真側邊欄在本視窗開/關（廣播）；開著立刻收合且觸發條失效
  function requeryPanelState() {
    // bfсache 還原／分頁從 discard 醒來時廣播可能漏掉，回到可見時主動重查一次
    try {
      Promise.resolve(api.runtime.sendMessage({ type: 'riffle-drawer-panel-state?' })).then(r => {
        if (!r) return;
        panelOpen = !!r.open;
        if (panelOpen && isOpen) setOpen(false);
      }, noteApiError);
    } catch (e) { noteApiError(e); }
  }
  try {
    api.runtime.onMessage.addListener(msg => {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'riffle-drawer-panel-state') {
        panelOpen = !!msg.open;
        if (panelOpen && isOpen) setOpen(false);
      } else if (msg.type === 'riffle-drawer-close') {  // 面板殼（drawer 模式）轉來的 Esc
        if (isOpen) setOpen(false);
      }
    });
  } catch (e) { noteApiError(e); }   // 孤兒腳本：收不到狀態，觸發條照設定走
  requeryPanelState();
  window.addEventListener('pageshow', requeryPanelState);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requeryPanelState();
  });

  function setEnabled(v) {
    enabled = v;
    if (enabled && !skipSelf && !host) buildUI();
    else if (!enabled && host) teardownUI();
  }

  // 抽屜待在左邊或右邊（options 可切）：觸發條／滑出方向／把手都是 side 決定的，
  // 已掛上的 UI 整包拆掉重建最乾淨；開著就先記住、重建後復原開啟態。
  function setSide(v) {
    const s = v === 'left' ? 'left' : 'right';
    if (s === side) return;
    side = s;
    if (!host) return;                               // 還沒建：之後 buildUI 直接用新邊
    const wasOpen = isOpen;
    teardownUI();
    buildUI();
    if (wasOpen) setOpen(true);
  }

  api.storage.onChanged.addListener((chg, area) => {
    if (area !== 'local') return;
    if (chg.autoHideDrawer) setEnabled(chg.autoHideDrawer.newValue === true);
    if (chg.drawerSide) setSide(chg.drawerSide.newValue);
    if (chg.drawerWidth && els) {
      width = clampW(Number(chg.drawerWidth.newValue) || DEF_W);
      applyWidth();
    }
  });

  (async () => {
    try {
      // 自家頁不掛：RiffleDesk 本體／?mode=panel 的頁面再疊一個面板沒意義（還會面板套面板）
      if (/[?&]mode=panel(?:&|$)/.test(location.search)) skipSelf = true;
      const DEF_PORT = (typeof RIFFLE_DEFAULT_PORT === 'number' && RIFFLE_DEFAULT_PORT) || 5177;
      const d = await Promise.resolve(api.storage.local.get({
        autoHideDrawer: false, drawerWidth: DEF_W, drawerSide: 'right', port: DEF_PORT }));
      if ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') &&
          String(location.port || '80') === String(d.port)) skipSelf = true;
      width = clampW(Number(d.drawerWidth) || DEF_W);
      setSide(d.drawerSide);
      setEnabled(d.autoHideDrawer === true);
    } catch (e) { noteApiError(e); }                 // 讀不到就維持關；孤兒就善後
  })();
})();
