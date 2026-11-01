// RiffleDesk 側邊欄頁（Chrome side panel 與 Firefox sidebar_action 共用這一份）。
// 職責：
//  1. 內容本體＝本機 RiffleDesk 的 ?mode=panel 頁，用 iframe 載。
//     server 偵測：fetch 輕量的 /manifest.webmanifest，通過就載 iframe；
//     沒在跑就顯示啟動教學並重試（掉線中 3 秒一次、連線中 15 秒一次慢速健檢）。
//     iframe 設了 src 但沒觸發 load（例如被 CSP 擋）也會退回教學頁，不會假裝在線。
//  2. iframe → 背景 worker 的中繼：面板頁點了檔案卡會 postMessage 上來
//     {rifflePanel:'file-opened', path, delivered}（嚴格驗：必須是 iframe 自己、
//     origin 協定/主機/埠全對、形狀對），轉給背景去把完整視窗帶到前景或開新分頁；
//     背景回 ok:true 才回 iframe open-ack——沒 ack 的 700ms 後面板頁自己補開分頁。
const frame = document.getElementById('frame');
const down = document.getElementById('down');
const api = globalThis.browser ?? globalThis.chrome;
if (typeof RD_I18N !== 'undefined') RD_I18N.applyStatic();
const ti = (typeof RD_I18N !== 'undefined' && RD_I18N.t) || (k => k);

// ?drawer=1：被自動收合側欄（右緣抽屜內容腳本）當抽屜內容載入。差兩件事：
//  1. 不連 'riffle-panel' 長連線——那條是「真側邊欄開著」的依據，抽屜不算
//     （連了就變成自己把自己的觸發條停用）。
//  2. Esc 經內容腳本收起抽屜自己（頁面 keydown 攔不到 iframe 裡的按鍵）。
const DRAWER_MODE = /[?&]drawer=1(?:&|$)/.test(location.search);

// 預設埠與 background.js 同源：sidepanel.html 先載 defaults.js（RIFFLE_DEFAULT_PORT）
const DEFAULT_PORT = (typeof RIFFLE_DEFAULT_PORT === 'number' && RIFFLE_DEFAULT_PORT) || 5177;
const RETRY_DOWN_MS = 3000;    // 伺服器沒跑：3 秒試一次
const RETRY_UP_MS = 15000;     // 連線中：15 秒慢速健檢（掉線了退回教學頁）
let port = DEFAULT_PORT;
let up = false;
let retryTimer = null;
let ticking = false;           // 正在跑一輪 tick：再點「立即重試」不會多開一條輪詢鏈
let frameLoaded = false;
let frameSrcAt = 0;

const base = () => `http://127.0.0.1:${port}`;

async function serverUp() {
  try {
    // no-store：別吃快取，否則 server 剛掛掉這裡還以為活著
    const r = await fetch(base() + '/manifest.webmanifest', {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000)
    });
    return r.ok;
  } catch (_) {
    return false;
  }
}

function setDown() {
  up = false;
  if (frame.src && frame.src !== 'about:blank') { try { frame.src = 'about:blank'; } catch (_) { /* 算了 */ } }
  frameLoaded = false;
  frame.style.display = 'none';
  down.style.display = 'block';
}

async function tick() {
  if (ticking) return;          // 前一輪還在飛——不併發（「立即重試」也走這裡）
  ticking = true;
  try {
    let ok = await serverUp();
    if (up && ok && !frameLoaded && frameSrcAt && Date.now() - frameSrcAt > 4000) {
      // server 活著但 iframe 始終沒 load（多半被擋）——當掉線處理，退回教學頁繼續重試
      ok = false;
    }
    if (ok && !up) {
      up = true;
      frameLoaded = false;
      frameSrcAt = Date.now();
      // 「點卡自動開側欄」進來的：一次性帶 ?tabs=1&tabfocus=，讓 RiffleDesk 直接進
      // 分頁模式並捲到那張卡。只認 60 秒內的紀錄，之後手動開側欄不被舊紀錄劫持。
      let focusTab = 0;
      try {
        if (api.storage && api.storage.session) {
          const d = await Promise.resolve(api.storage.session.get({ panelFocus: null }));
          if (d.panelFocus && Date.now() - (d.panelFocus.at || 0) < 60000) {
            focusTab = Math.floor(Number(d.panelFocus.tabId)) || 0;
          }
        }
      } catch (_) { /* 沒有就算了 */ }
      // 抽屜模式：面板頁被任意網頁間接框住，server 只對帶配對 token 的請求放寬 frame-ancestors
      let dk = '';
      if (DRAWER_MODE) {
        try {
          const d = await Promise.resolve(api.storage.local.get({ riffleToken: '' }));
          if (d && typeof d.riffleToken === 'string') dk = d.riffleToken;
        } catch (_) { /* 拿不到就載不出來，跟沒放寬一樣 */ }
      }
      frame.src = base() + '/?mode=panel' + (focusTab > 0 ? `&tabs=1&tabfocus=${focusTab}` : '') + (dk ? `&dk=${encodeURIComponent(dk)}` : '');
      frame.style.display = 'block';
      down.style.display = 'none';
    } else if (!ok && up) {
      setDown();
    } else if (!ok) {
      down.style.display = 'block';
    }
  } finally {
    ticking = false;
    retryTimer = setTimeout(tick, up ? RETRY_UP_MS : RETRY_DOWN_MS);
  }
}

// ---------------------------------------------------------------- 「捲到這張卡」中繼
// 主畫面點卡 → 背景（趁手勢開側欄）→ 這裡 → postMessage 進 iframe，RiffleDesk 分頁模式
// 捲到那張。側欄若剛被開起來、iframe 還沒載好：先記著，載好後連送幾次（RiffleDesk
// 啟動與 SSE 補清單是漸進的，一次訊息可能落在一堆還沒建好的時候）。
let pendingFocusTab = 0;
function focusFrame(tabId) {
  const id = Math.floor(Number(tabId));
  if (!Number.isFinite(id) || id <= 0) return;
  pendingFocusTab = id;
  if (!frameLoaded || !frame.contentWindow) return;
  let tries = 0;
  const poke = () => {    // 12×500ms 補送鏈：頁面端 tabs.js 的 FOCUS_FRESH_MS(6500) 以「涵蓋本鏈」為準，改次數/間隔要連它一起看
    if (pendingFocusTab !== id) return;    // 已換目標
    tries++;
    try { frame.contentWindow.postMessage({ rifflePanel: 'tab-focus', tabId: id }, base()); } catch (_) { return; }
    if (tries < 12) setTimeout(poke, 500);
  };
  poke();
}
if (api.runtime && api.runtime.onMessage) {
  api.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === 'riffle-panel-focus') focusFrame(msg.tabId);
  });
}
// 讓背景知道側欄開著（開著時點卡不必再呼叫 sidePanel.open）。MV3 會閒置回收長連線，
// 斷了 5 秒後重連；側欄一關頁面卸載、連線自然消失。連上後回報所屬視窗（panel-hello），
// 背景據此告訴各分頁的右緣抽屜「本視窗真側邊欄開著，別啟動」——避免一窗兩面板。
function keepPort() {
  let p;
  try { p = api.runtime.connect({ name: 'riffle-panel' }); } catch (_) { setTimeout(keepPort, 5000); return; }
  try {
    Promise.resolve(api.windows && api.windows.getCurrent ? api.windows.getCurrent() : null).then(w => {
      try { p.postMessage({ t: 'panel-hello', win: w && Number.isFinite(w.id) ? w.id : null }); } catch (_) {}
    }, () => {});
  } catch (_) { /* 拿不到視窗就算了：背景當成舊版面板頁，各視窗都算開著 */ }
  p.onDisconnect.addListener(() => setTimeout(keepPort, 5000));
}
if (!DRAWER_MODE) keepPort();

// 抽屜模式：Esc 轉給本體頁的內容腳本收合（iframe 按鍵不會冒泡到主頁）
if (DRAWER_MODE) addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  try {
    Promise.resolve(api.tabs && api.tabs.getCurrent ? api.tabs.getCurrent() : null).then(tab => {
      if (tab && Number.isFinite(tab.id)) {
        Promise.resolve(api.tabs.sendMessage(tab.id, { type: 'riffle-drawer-close' })).catch(() => {});
      }
    }, () => {});
  } catch (_) { /* 主頁收不收無所謂，滑鼠移開也會收 */ }
}, true);

frame.addEventListener('load', () => {
  if (up) {
    frameLoaded = true;
    // iframe 首次載好：背景存在 session 的「待捲目標」（60 秒內）拿出來用
    if (!pendingFocusTab && api.storage && api.storage.session) {
      Promise.resolve(api.storage.session.get({ panelFocus: null })).then(d => {
        if (d.panelFocus && Date.now() - (d.panelFocus.at || 0) < 60000) focusFrame(d.panelFocus.tabId);
      }, () => {});
    } else if (pendingFocusTab) {
      focusFrame(pendingFocusTab);
    }
  }
});

// iframe（http://127.0.0.1:<port> 來源）＝跨域，只認「就是我們那個 iframe」且形狀對的訊息；
// 同台機器別的 127.0.0.1 服務惡搞 postMessage 進不來（source 必須正是 frame.contentWindow）
addEventListener('message', ev => {
  if (!frame.contentWindow || ev.source !== frame.contentWindow) return;
  if (ev.origin !== base()) return;    // 協定＋主機＋埠全比對
  const d = ev && ev.data;
  if (!d || d.rifflePanel !== 'file-opened' || typeof d.path !== 'string') return;
  let sent;
  try {
    sent = api.runtime.sendMessage({
      type: 'riffle-panel-open',
      path: d.path,
      delivered: Number(d.delivered) || 0
    });
  } catch (_) { return; }
  Promise.resolve(sent).then(res => {
    // 背景真的做成了才 ack；ok:false／送不出去都讓面板頁 700ms 逾時後自己補開分頁
    if (!res || res.ok !== true) return;
    try { ev.source.postMessage({ rifflePanel: 'open-ack' }, ev.origin); } catch (_) { /* iframe 已換頁就算了 */ }
  }, () => { /* 背景沒回 → 面板自己補開 */ });
});

document.getElementById('retry').addEventListener('click', () => {
  if (retryTimer) clearTimeout(retryTimer);
  tick();
});

// options 頁改埠後面板馬上跟著換（background.js 那邊本來就有同監聽）
if (api.storage && api.storage.onChanged) {
  api.storage.onChanged.addListener((chg, area) => {
    if (area !== 'local' || !chg.port) return;
    const p = Number(chg.port.newValue === undefined ? DEFAULT_PORT : chg.port.newValue);
    if (Number.isInteger(p) && p >= 1 && p <= 65535 && p !== port) {
      port = p;
      if (up) setDown();     // 舊 iframe 指到舊埠：退回重連流程（會立刻重試到新埠）
      if (retryTimer) clearTimeout(retryTimer);
      tick();
    }
  });
}

// Firefox 裡「chrome://extensions/shortcuts」不存在：教學改成 about:addons 的路
(async () => {
  try {
    if (api.runtime && api.runtime.getBrowserInfo) {
      const info = await Promise.resolve(api.runtime.getBrowserInfo());
      if (info && /firefox/i.test(info.name || '')) {
        const el = document.getElementById('backNote');
        if (el) el.innerHTML = ti('sideBackNoteFf');
      }
    }
  } catch (_) { /* Chrome 沒有 getBrowserInfo，照原先顯示 */ }
})();

(async () => {
  try {
    const d = await Promise.resolve(api.storage.local.get({ port: DEFAULT_PORT }));
    const p = Number(d.port);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) port = p;
  } catch (_) { /* 用預設 */ }
  tick();
})();
