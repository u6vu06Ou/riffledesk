// extension/drawer.js — 自動收合側欄（右緣抽屜）內容腳本。
// 注入時機：manifest content_scripts，document_idle，只對 http/https、只掛頂層框架。
//
// 為什麼這是內容腳本而不是真側邊欄：Chrome 沒有 API 能把真側邊欄收成一條，
// 而且 sidePanel.open 需要使用者手勢（滑鼠懸停不算）。所以「碰右邊緣展開」只能
// 用頁面覆疊的方式自己做——一個 shadow-DOM host：6px 隱形觸發條貼在視口右緣，
// 滑鼠停上去約 120ms（按住按鈕／拖曳中不算）抽屜從右邊滑入（150ms transform），
// 覆在頁面上（不改版面寬度）。內容是本擴充頁的 iframe（sidepanel.html?drawer=1，
// 已列 web_accessible_resources，頁面 CSP 擋不了 chrome-extension:// 框架）；
// iframe 第一次打開才建、之後用 transform 藏起來不拆掉，重開是即時的。
// 離開抽屜 400ms 或 Esc 收合；標頭 📌 釘住不收。寬度拖左緣調、存 storage.local。
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
  let resurrected = false;
  {
    const prev = window.__rdDrawerInit;
    if (prev) {
      let alive = false;
      if (typeof prev === 'object' && typeof prev.alive === 'function') {
        try { alive = !!prev.alive(); } catch (_) { alive = false; }
      }
      if (alive) return;                             // 活實體在：重複注入，跳過
      try { document.querySelectorAll('#' + HOST_ID).forEach(h => h.remove()); } catch (_) {}
      resurrected = true;
    }
  }
  window.__rdDrawerInit = {                          // 先佔旗標再往下跑：後到的注入馬上被擋
    alive: () => { try { return !!api.runtime.id; } catch (_) { return false; } }
  };
  if (resurrected) {
    // 前一代死前若正把本分頁扣在瀏覽器縮放 disabled（指標停在遺體上就被重載），還原它
    try {
      Promise.resolve(api.runtime.sendMessage({ type: 'riffle-drawer-zoom', on: false })).catch(() => {});
    } catch (_) { /* 送不出去就算了 */ }
  }

  const ti = (typeof RD_I18N !== 'undefined' && RD_I18N.t) || (k => k);
  const DWELL_MS = 120;      // 碰到右緣停這麼久才展開
  const CLOSE_MS = 400;      // 離開抽屜這麼久才收合
  const SLIDE_MS = 150;      // 滑入／滑出動畫
  const DEF_W = 420, MIN_W = 280, MAX_W = 900;

  let enabled = false;       // options 開關（預設關）
  let skipSelf = false;      // RiffleDesk 自家頁（本體／mode=panel）：不掛，免得面板套面板
  let panelOpen = false;     // 本視窗真側邊欄開著（背景廣播／查詢得知）
  let host = null, shadow = null, els = null;
  let isOpen = false, pinned = false, width = DEF_W;
  let dwellT = 0, closeT = 0, lastButtons = 0, mouseDown = false;
  let reopenGate = false;    // Esc 收合後：指標還停在觸發條上時不準立刻重開
  let drag = null;           // {x0, w0} 左緣拖曳中

  function clampW(w) {
    const cap = Math.min(MAX_W, Math.max(240, Math.round((window.innerWidth || 1280) * 0.9)));
    const min = Math.min(MIN_W, cap);
    return Math.max(min, Math.min(cap, Math.round(w)));
  }

  // ---------------------------------------------------------------- shadow UI
  const CSS = [
    ':host{all:initial}',
    `.t{position:fixed;top:0;right:0;width:6px;height:100vh;z-index:2147483647;background:rgba(0,0,0,0)}`,
    '.d{position:fixed;top:0;right:0;height:100vh;z-index:2147483647;display:flex;flex-direction:column;' +
      'background:#17191d;box-shadow:-6px 0 24px rgba(0,0,0,.45);transform:translateX(105%);' +
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
    '.g{position:absolute;left:0;top:0;bottom:0;width:7px;cursor:col-resize;z-index:2}'
  ].join('\n');

  function buildUI() {
    if (host) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: 'open' });
    // adoptedStyleSheets 不吃頁面 CSP 的 style-src（嚴格 CSP 網站也能有樣式）；
    // 老引擎不支援就退回 <style> 元素
    let style = null;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch (_) {
      style = document.createElement('style');
      style.textContent = CSS;
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
    try { icon.src = api.runtime.getURL('icons/icon-32.png'); } catch (_) { /* 圖壞了就算了 */ }
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
    wire();
  }

  function teardownUI() {
    clearTimeout(dwellT); clearTimeout(closeT);
    zoomGuard(false);                                // host 移除時 mouseleave 不一定補送
    if (host) host.remove();
    host = shadow = els = null;
    isOpen = false;
  }

  function applyWidth() {
    if (els) els.drawer.style.width = width + 'px';
  }

  function mountFrame() {
    const f = document.createElement('iframe');
    f.className = 'f';
    f.title = ti('sideFrameTitle');
    f.setAttribute('allow', 'clipboard-read; clipboard-write');
    // ?drawer=1：面板殼知道自己是抽屜——不報「真側邊欄開著」、Esc 回傳主頁收合
    f.src = api.runtime.getURL('sidepanel.html?drawer=1');
    els.drawer.appendChild(f);
    els.frame = f;
  }

  // ---------------------------------------------------------------- 開合
  function setOpen(v) {
    if (!els) return;
    if (v && (!enabled || panelOpen)) v = false;      // 真側邊欄開著／功能關著就不准開
    if (v) { if (!els.frame) mountFrame(); }
    isOpen = v;
    els.drawer.dataset.open = v ? '1' : '0';
    if (!v) zoomGuard(false);   // 收合後指標可能還停在原處（mouseleave 沒再補），別留著關縮放
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

  // -------------------------------------------------- Ctrl+滾輪護欄（瀏覽器縮放）
  // Chrome 定性：指標停在跨程序 iframe 上時，Ctrl+滾輪在瀏覽器程序就被當成
  // 「整頁縮放」手勢吃掉，去縮放「主頁」——抽屜裡的面板頁巢在「網頁 → 擴充頁 →
  // 本機 http」兩層 OOPIF 深處，面板自己的 preventDefault（stack.js 畫布、main.js
  // 介面縮放）攔不到瀏覽器層的手勢，所以卡堆的相機拉近拉遠完全不動，主頁反而被縮放。
  // （真側邊欄是獨立 view、沒有可縮放的主頁，所以同一份面板頁在那裡沒這個病。）
  // 網頁端程式碼關不掉這個手勢——事件根本到不了頁面層；擴充可以：
  // 指標進抽屜就把本分頁的縮放模式暫時切成 disabled（per-tab）。手勢不存在了，
  // Ctrl+滾輪照一般 wheel 路由送進巢狀 iframe：畫布上＝相機遠近、面板其餘處＝介面
  // 縮放，主頁也不再被縮放。指標一離開立刻還原 automatic——抽屜外的頁面照常縮放。
  function zoomGuard(on) {
    try {
      Promise.resolve(api.runtime.sendMessage({ type: 'riffle-drawer-zoom', on: !!on })).catch(() => {});
    } catch (_) { /* 孤兒腳本：送不出去就算了 */ }
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
      // 觸發條在視口最右邊（蓋到傳統捲軸的外緣）：按下時自廢武功，不攔這次操作
      trigger.style.pointerEvents = 'none';
    });
    drawer.addEventListener('mouseenter', () => {
      clearTimeout(closeT); closeT = 0; clearTimeout(dwellT);
      zoomGuard(true);                               // 指標進抽屜：關掉主頁的瀏覽器縮放手勢
    });
    drawer.addEventListener('mouseleave', () => {
      zoomGuard(false);                              // 離開馬上還原：抽屜外的頁面照常縮放
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

  // 全域滑鼠狀態：按鈕按住不展開；拖曳把手在這裡走
  window.addEventListener('mousedown', () => { mouseDown = true; }, true);
  window.addEventListener('mouseup', () => {
    mouseDown = false;
    if (els && els.trigger) els.trigger.style.pointerEvents = '';   // 還原觸發條
    if (drag) {
      drag = null;
      if (els && els.frame) els.frame.style.pointerEvents = '';
      try { Promise.resolve(api.storage.local.set({ drawerWidth: width })).catch(() => {}); } catch (_) {}
    }
  }, true);
  window.addEventListener('mousemove', e => {
    lastButtons = e.buttons;
    if (!drag) return;
    width = clampW(drag.w0 + (drag.x0 - e.clientX));
    applyWidth();
    e.preventDefault();
  }, true);
  window.addEventListener('keydown', e => {
    // Esc 收合（不擋頁面自己的 Esc）；收合後到指標離開觸發條之前不準立刻重開
    if (e.key === 'Escape' && isOpen) { setOpen(false); reopenGate = true; }
  }, true);
  window.addEventListener('resize', () => {           // 視窗變窄時重夾寬度
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
      }, () => {});
    } catch (_) { /* 孤兒腳本 */ }
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
  } catch (_) { /* 孤兒腳本：收不到狀態，觸發條照設定走 */ }
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

  api.storage.onChanged.addListener((chg, area) => {
    if (area !== 'local') return;
    if (chg.autoHideDrawer) setEnabled(chg.autoHideDrawer.newValue === true);
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
      const d = await Promise.resolve(api.storage.local.get({ autoHideDrawer: false, drawerWidth: DEF_W, port: DEF_PORT }));
      if ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') &&
          String(location.port || '80') === String(d.port)) skipSelf = true;
      width = clampW(Number(d.drawerWidth) || DEF_W);
      setEnabled(d.autoHideDrawer === true);
    } catch (_) { /* 讀不到就維持關 */ }
  })();
})();
