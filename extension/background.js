// RiffleDesk Tabs Bridge — MV3 service worker.
// 職責：
//  1. 分頁有變動（開/關/更新/切換/拖曳）就把整份清單推到本機 RiffleDesk server
//     POST /api/tabs（帶 X-RiffleDesk-Ext: 1 ＋ X-RiffleDesk-Token: <per-install>）。
//     server 連不上就每 8 秒安靜重試（迴圈），不噴錯；每分鐘另有一次心跳補推。
//  2. 長輪詢 GET /api/tabs/cmd?wait=15000 拿指令：
//       read     → scripting.executeScript 抓該分頁標題＋可讀文字＋DOM 原始碼，POST /api/tabs/result 回去
//       activate → 把那個分頁切到前景（tabs.update active + windows.update focused）
//       open     → 開新分頁（只收 http/https）
//  3. 每個視窗「目前顯示中的分頁」順手截圖（captureVisibleTab 只能拍這些），
//     縮到 480px 寬 JPEG 品質 0.6 一起送；同視窗分到同一張卡就用快取，
//     該分頁重新載入完才重拍。
//  4. 獨立的背景補抓循環（metaFillLoop）：不切分頁，逐輪把每個分頁的主內容文字、
//     meta description 摘要、og:image 代表圖（縮 ≤800px JPEG、只存記憶體）補齊，
//     補到全部都有或確定失敗（連敗退避）為止；抓到新內容才再推送。
//     每次 executeScript 都有逾時（凍結／記憶體節省分頁可能永不回應），拖不住整批；
//     失敗原因（權限／凍結／錯誤訊息）記進 storage.session，options 頁除錯區可見。
// 埠號在 options 頁改（api.storage.local，留在本機不同步），預設 5177。
// token 是第一次啟動時產生的隨機 48 hex，存在 api.storage.local；server 記住
// 第一次看到的 token 之後就只認它（server 只活記憶體，重開 server＝重新配對）。

// Chrome MV3 是 service worker，defaults.js 得用 importScripts 拉進來；
// Firefox MV3 是背景頁（manifest 的 background.scripts 已經先把 defaults.js 跑掉），
// 那裡沒有 importScripts，叫了會丟錯——所以用功能偵測，同一份程式兩邊都跑。
if (typeof importScripts === 'function') {
  // 缺檔也不該把 worker 整個殺掉，落回寫死的預設埠
  try { importScripts('defaults.js'); } catch (_) { /* 用下面的 fallback */ }
  // 除錯訊息的中英對照表（options 除錯區可見）；缺檔就留 key 原樣，可讀性仍在
  try { importScripts('i18n.js'); } catch (_) { /* ti() fallback 代打 */ }
}
const DEFAULT_PORT = (typeof RIFFLE_DEFAULT_PORT === 'number' && RIFFLE_DEFAULT_PORT) || 5177;
const ti = (typeof RD_I18N !== 'undefined' && RD_I18N.t) || (k => k);

// Firefox 的 chrome.* 是 callback 風格（不回 Promise），browser.* 才回 Promise；
// Chrome 只有 chrome.*。兩個瀏覽器都用同一份程式，靠這一行取到對的命名空間。
const api = globalThis.browser ?? globalThis.chrome;

const SHOT_W = 1280;
const SHOT_Q = 0.85;
const SHOT_CACHE_MAX = 80;
const TEXT_MAX = 200 * 1024;      // innerText 上限（server 端也會再卡一次）
const PREVIEW_TEXT_MAX = 1500;    // 卡片上「沒來得及截圖」時給人讀的可見文字
const PUSH_DEBOUNCE_MS = 500;     // onUpdated 很吵（標題常變）→ 合併成一次推送
const HTML_MAX = 2 * 1024 * 1024; // outerHTML 上限，超過截斷＋標 truncated
const FAV_CACHE_MAX = 200;
const TEXT_CACHE_MAX = 300;
const PUSH_MAX_WAIT_MS = 1500;    // debounce 再怎麼被重置，最多等這麼久就送一次
const FETCH_TIMEOUT_MS = 15000;
const GRAB_TIMEOUT_MS = 9000;        // 單次 executeScript 逾時：凍結／記憶體節省分頁可能永不回應
const META_BATCH = 8;                // 背景補抓循環每輪同時抓幾個分頁
const META_ROUND_PAUSE_MS = 1200;    // 輪與輪之間喘一下，不連發
const META_MAX_ROUNDS = 90;          // 循環上限輪數（SW 被回收也沒關係，下次推送會重踢）
const META_FAIL_RETRY_MS = 30000;    // 抓失敗後再試間隔（前幾次）
const META_MAX_FAILS = 3;            // 連敗這麼多次＝確定抓不到（無權限／凍結），退到長間隔
const META_GIVEUP_MS = 10 * 60 * 1000; // 確定失敗後隔這麼久才再碰一次（分頁可能後來解凍）
const META_HARD_FAILS = 12;          // 連敗這麼多次就完全停手（真的沒文字的頁不要永遠補）
const META_DESC_MAX = 500;           // 送給 server 的摘要上限（server 端同樣會再截一次）
const OG_MAX_DIM = 800;              // og:image 代表圖：縮到最長邊 ≤800px 的 JPEG，只存記憶體
const OG_Q = 0.8;
const OG_BYTES_MAX = 5 * 1024 * 1024;
const OG_PIXELS_MAX = 4096 * 4096;   // 解碼後像素上限：擋「小檔案超大畫布」的解壓縮炸彈
const OG_CACHE_MAX = 60;             // 代表圖 dataURL 快取上限（每張常 100–300KB base64）
const FAIL_LOG_MAX = 20;             // options 頁除錯區顯示的最近失敗紀錄數
const SHOT_IDLE_MIN_AGE = 30 * 60 * 1000; // 閒置補拍只碰：沒有截圖、或截圖超過這麼久且 url 變了
const IDLE_DETECT_S = 60;            // chrome.idle 偵測閒置的秒數
const CAP_GAP_MS = 560;              // captureVisibleTab 上限每秒 2 次，節拍留餘量
const SWEEP_LOAD_WAIT_MS = 10000;    // 目標分頁還在載入時最多等這麼久
const SWEEP_PAINT_MS = 450;          // 載入完再等多一下讓首屏繪製
const SHOT_FRESH_MS = 30 * 60 * 1000; // 同網址且截圖未滿這麼久＝夠新，不重拍
const DRAW_W = 1280;                 // 背景分頁 DOM 繪圖的可視範圍上限
const DRAW_H = 800;
const DRAW_TIMEOUT_MS = 3000;        // 單一分頁 DOM 繪圖逾時：放棄並記住（同網址不再重試）
const DRAW_GAP_MS = 1000;            // 每次繪圖至少間隔，一次只畫一個分頁
const DRAW_MAX_ROUNDS = 40;          // 每輪循環最多畫幾個（每次 pushNow 重踢）
const PERSIST_MAX_KEYS = 300;        // IndexedDB 截圖快取上限（張）
const PERSIST_MAX_BYTES = 100 * 1024 * 1024; // 與張數上限一到就 LRU 淘汰最舊
const PERSIST_ADOPT_MS = 7 * 24 * 60 * 60 * 1000; // 認領上限：放超過一週的臉不要了
// DOM 繪圖黑名單：太重／容易噴錯的頁面先跳過（常數陣列，要加就加這裡）
const DRAW_BLACKLIST = [
  /^https?:\/\/(docs|mail|drive|calendar|meet)\.google\.com\//i,
  /^https?:\/\/app\.slack\.com\//i,
  /^https?:\/\/([^/]*\.)?figma\.com\//i
];

let port = DEFAULT_PORT;
const base = () => `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------- identity
// per-install token：擋「猜中靜態標頭就當擴充」的本機冒名者（server 端驗證）
let tokenCache = null;
async function getToken() {
  if (tokenCache) return tokenCache;
  const d = await api.storage.local.get({ riffleToken: null });
  if (typeof d.riffleToken === 'string' && /^[0-9a-f]{48}$/.test(d.riffleToken)) {
    tokenCache = d.riffleToken;
    return tokenCache;
  }
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  const tok = Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
  try { await api.storage.local.set({ riffleToken: tok }); } catch (_) { /* 存不了也照跑 */ }
  tokenCache = tok;
  return tok;
}

async function headers(isJson) {
  const h = { 'X-RiffleDesk-Ext': '1', 'X-RiffleDesk-Token': await getToken() };
  if (isJson) h['content-type'] = 'application/json';
  return h;
}

// ---------------------------------------------------------------- state → storage.session
// MV3 worker 會被回收，記憶體狀態一丟 options 頁就誤顯「還沒連上過」；
// 存 storage.session（仍在本機、瀏覽器關了就沒）給狀態列用。
let lastPushOk = 0;
let lastError = '';
function noteStatus() {
  lastPushOkRef = lastPushOk; lastErrorRef = lastError;
  try {
    if (api.storage && api.storage.session) {
      // 失敗也吞掉（Promise 版被拒會變 unhandled rejection）
      Promise.resolve(api.storage.session.set({ lastPushOk, lastError })).catch(() => {});
    }
  } catch (_) { /* storage.session 沒有就算了 */ }
}
let lastPushOkRef = 0, lastErrorRef = '';

// e2e 計數器（riffle-status 回應帶出）：直達點卡訊息、側欄開啟嘗試、DOM 繪圖、分頁活化事件
const testStats = { extClicks: 0, panelOpenCalls: 0, panelOpenOk: 0, panelOpenFail: 0,
                    drawn: 0, drawFail: 0, activatedEvents: 0,
                    closed: 0, restored: 0, backToFull: 0,
                    drawerZoomOff: 0, drawerZoomOn: 0, drawerInjects: 0 };

// ---------------------------------------------------------------- helpers
const sleep = ms => new Promise(r => setTimeout(r, ms));

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(fr.error || new Error('read fail'));
    fr.readAsDataURL(blob);
  });
}

// favicon 直接給 URL 的話 RiffleDesk 頁面不能畫（跨域畫布會污染、WebGL 貼圖會炸），
// 擴充有 host 權限，抓回來轉成 data: URL。只快取成功（暫時性失敗不讓圖示整個 session 空白）；
// 只收真 image/* content-type，減少頁面控制的 favicon URL 亂指內網的 SSRF 雜訊。
const favCache = new Map(); // url -> dataUrl（成功的才進來）
async function favAsData(u) {
  if (!u) return '';
  if (u.startsWith('data:')) return u;
  if (!/^https?:\/\//i.test(u)) return '';
  if (favCache.has(u)) return favCache.get(u);
  let out = '';
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    const ct = String(r.headers.get('content-type') || '').toLowerCase();
    if (r.ok && (ct.startsWith('image/') || ct === 'application/octet-stream')) {
      const b = await r.blob();
      if (b.size && b.size < 64 * 1024 && b.type.startsWith('image/')) out = await blobToDataUrl(b);
    }
  } catch (_) { /* 抓不到就留空，不快取失敗 */ }
  if (out) {
    if (favCache.size >= FAV_CACHE_MAX) favCache.delete(favCache.keys().next().value);
    favCache.set(u, out);
  }
  return out;
}

// data: URL → Blob：不能用 fetch(dataUrl)！MV3 service worker 裡 fetch 一律把
// data: 當成失敗（TypeError "Failed to fetch"，而且就算 catch 住，失敗本身仍會被
// Chrome 記進擴充錯誤頁那條黃色項目）——所以手動解 base64。
function dataUrlToBlob(dataUrl) {
  // ;base64 不一定在第一個參數（data:image/png;charset=utf-8;base64,… 也是合法的）
  const m = /^data:([^;,]+)?((?:;[^;,]*)*),([\s\S]*)$/.exec(String(dataUrl));
  if (!m) return null;
  if (/;base64/i.test(m[2] || '')) {
    let bin;
    try { bin = atob(m[3]); } catch (_) { return null; }
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: m[1] || 'image/jpeg' });
  }
  try { return new Blob([decodeURIComponent(m[3])], { type: m[1] || 'text/plain' }); } catch (_) { return null; }
}

async function shrinkShot(dataUrl) {
  try {
    const blob = dataUrlToBlob(dataUrl);
    if (!blob) return null;
    const bmp = await createImageBitmap(blob);
    const h = Math.max(1, Math.round(bmp.height * (SHOT_W / bmp.width)));
    const c = new OffscreenCanvas(SHOT_W, h);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, SHOT_W, h);
    bmp.close();
    const out = await c.convertToBlob({ type: 'image/jpeg', quality: SHOT_Q });
    return await blobToDataUrl(out);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- push tabs
let pushTimer = null;
let retryTimer = null;

// 截圖快取：key = tabId。分頁一被切到前景（onActivated）就拍一張存起來，
// 用久了大部分分頁都有圖；分頁關掉、或它自己重新載入完就丟掉重拍。
// （舊做法 key 是 windowId:activeTabId，切走就沒了 → 卡片大部分時間是空白面。）
const shotCache = new Map();      // tabId -> {shot, url, at}（Map 插入序當 LRU：get 時刪掉重插）
// 已經推給 server 的那一張（值＝shot 字串）。只推新拍的，不每輪重送 15–40MB。
const shotSent = new Map();
// og:image 代表圖同一套：只推「跟上次不一樣」的那張，server 端同截圖跨推送保留
const ogSent = new Map();
function shotCacheGet(tabId) {
  const v = shotCache.get(tabId);
  if (v === undefined) return undefined;
  shotCache.delete(tabId); shotCache.set(tabId, v);
  return v;
}
function shotCachePut(tabId, shot, url, kind) {
  kind = kind || 'shot';
  const prev = shotCache.get(tabId);
  // drawn 只是暫代圖：絕不蓋掉已經存在的真截圖（真截圖蓋 drawn 是正常流向）
  if (kind === 'drawn' && prev && prev.kind === 'shot') return;
  shotCache.delete(tabId);
  shotCache.set(tabId, { shot, url: String(url || ''), at: Date.now(), kind });
  while (shotCache.size > SHOT_CACHE_MAX) shotCache.delete(shotCache.keys().next().value);
  persistShot(url, shot, kind || 'shot');   // 同步進 IndexedDB（async 背景寫，節流序列化）
}
// 同一網址、30 分鐘內拍過的真截圖＝夠新不重拍。drawn（DOM 繪圖暫代圖）不算「拍過」：
// 之後的真截圖（captureVisibleTab）一律要蓋掉它。
function shotIsFresh(ent, url) {
  return !!ent && ent.kind !== 'drawn' && ent.url === String(url || '') &&
    (Date.now() - ent.at) < SHOT_FRESH_MS;
}

// ---------------------------------------------------------------- 截圖持久化（IndexedDB）
// key＝網址去掉 # 的 href（同網址的分頁共用一張）；值＝{shot, kind, at, bytes}。
// SW 啟動時整份讀進 urlShotMem；collectTabs 遇到沒截圖的分頁就按網址認領——
// 擴充重開、SW 被回收、甚至 Chrome 重開，卡片都立刻有畫面，不用等切前景。
const IDB_NAME = 'riffle-tabs-shots';
const IDB_STORE = 'shots';
const urlShotMem = new Map();      // urlKey -> {shot, kind, at, bytes}（插入序＝年齡序）
let idbReady = null;               // Promise<IDBDatabase|null>
let idbChain = Promise.resolve();  // 寫入序列化，避免 put/delete 交錯

function shotUrlKey(u) {
  try {
    const x = new URL(String(u || ''));
    if (!/^https?:$/.test(x.protocol)) return '';
    x.hash = '';
    return x.href;
  } catch (_) { return ''; }
}
function idbOpen() {
  if (idbReady) return idbReady;
  idbReady = new Promise(res => {
    let req;
    try { req = indexedDB.open(IDB_NAME, 1); } catch (_) { idbReady = null; return res(null); }
    req.onupgradeneeded = () => { try { req.result.createObjectStore(IDB_STORE); } catch (_) { /* 已存在 */ } };
    req.onsuccess = () => res(req.result);
    // 失敗／被擋：別把 null 永遠快取在 idbReady——重設讓下次呼叫重試，不然這個 SW
    // 生命週期內持久化會靜默整個關掉。
    req.onerror = () => { idbReady = null; res(null); };
    req.onblocked = () => { idbReady = null; res(null); };
  });
  return idbReady;
}
function idbWrite(cb) {
  const job = idbChain.then(async () => {
    const db = await idbOpen();
    if (!db) return;
    try {
      await new Promise(res => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        cb(tx.objectStore(IDB_STORE));
        tx.oncomplete = tx.onerror = tx.onabort = () => res();
      });
    } catch (_) { /* 寫不進就算了 */ }
  });
  idbChain = job.catch(() => {});
  return job;
}
function persistTrim() {
  let total = 0;
  for (const v of urlShotMem.values()) total += v.bytes || 0;
  while (urlShotMem.size && (urlShotMem.size > PERSIST_MAX_KEYS || total > PERSIST_MAX_BYTES)) {
    const k = urlShotMem.keys().next().value;
    const v = urlShotMem.get(k);
    urlShotMem.delete(k);
    total -= v ? (v.bytes || 0) : 0;
    idbWrite(st => st.delete(k));
  }
}
function persistShot(url, shot, kind) {
  const k = shotUrlKey(url);
  if (!k || typeof shot !== 'string') return;
  urlShotMem.delete(k);
  // bytes 抓近似值：data URL ≈ base64，乘 0.75 接近實際位元組（上限寬鬆、誤差無妨）
  const rec = { shot, kind: kind || 'shot', at: Date.now(), bytes: Math.round(shot.length * 0.75) };
  urlShotMem.set(k, rec);
  idbWrite(st => st.put(rec, k));
  persistTrim();
}
async function idbLoadAll() {
  const db = await idbOpen();
  if (!db) return;
  try {
    await new Promise(res => {
      const rows = [];
      const cur = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) {
          rows.sort((a, b) => a.at - b.at);   // 舊→新插入，插入序＝年齡序
          for (const r of rows) urlShotMem.set(r.k, r.v);
          persistTrim();
          return res();
        }
        const v = c.value;
        if (v && typeof v.shot === 'string' && v.shot.startsWith('data:image/')) {
          rows.push({ k: String(c.key), v: { shot: v.shot, kind: v.kind === 'drawn' ? 'drawn' : 'shot', at: +v.at || 0, bytes: +v.bytes || v.shot.length } });
        }
        c.continue();
      };
      cur.onerror = () => res();
    });
  } catch (_) { /* 讀不了就用記憶體照跑 */ }
}
async function persistClearAll() {
  urlShotMem.clear();
  // 清空也要排進同一條寫入佇列：先前排進來的 put/delete 落地後才輪到 clear，
  // 不然「清除」可能被還在飛的舊寫入蓋回去。
  await idbWrite(st => st.clear());
}
// 分頁頁面資訊快取：key = tabId，值帶 url，同一個 url 不重抓。
// 失敗記 fails/why/failAt：頭幾次隔 30 秒再試；連敗 META_MAX_FAILS 次＝確定抓不到
// （無權限／凍結／特殊頁），之後每 10 分鐘才再碰一次，不會每輪空轉。
const metaCache = new Map();      // tabId -> {url, text, desc, ogUrl, ogData, fails, failAt, why}
function metaCacheSet(id, val) {   // 容量修剪集中一處：成功／失敗路徑都不會爆上限
  metaCache.delete(id);
  metaCache.set(id, val);
  while (metaCache.size > TEXT_CACHE_MAX) metaCache.delete(metaCache.keys().next().value);
}
function previewable(tb) {
  const u = String(tb && (tb.url || tb.pendingUrl) || '');
  // http/https 才抓：file:// 要另外勾「允許存取檔案網址」才打得進去，而且本機檔案
  // 內容會跟著送到 server（純本機，但仍是把檔案內容複製了一份），先不收。
  return /^https?:\/\//i.test(u);
}

// 在目標分頁裡跑（executeScript 的 func，必須是自含的頂層函式）：
// 主內容文字（優先 article/main/[role=main]，找不到才 body）＋ meta description 摘要
// ＋ og:image/twitter:image 代表圖網址（相對路徑轉絕對）。
function grabPageMetaInTab(textMax) {
  const meta = sels => {
    for (const s of sels) {
      const el = document.querySelector(s);
      const c = el && (el.getAttribute('content') || '').trim();
      if (c) return c;
    }
    return '';
  };
  let og = '';
  try {
    og = meta(['meta[property="og:image"]', 'meta[name="og:image"]',
               'meta[property="twitter:image"]', 'meta[name="twitter:image"]']);
    if (og) og = new URL(og, location.href).href;   // 相對轉絕對；爛網址丟掉
  } catch (_) { /* 抓不到代表圖就算了 */ }
  const desc = meta(['meta[name="description"]', 'meta[property="og:description"]',
                     'meta[name="twitter:description"]']);
  // 主內容容器與 body 各量一次，取較長的：SPA 常常 <main> 殼還是空的、字在 body 其他地方
  // （舊版只取 article/main，空的 main 會贏過有內容的 body → 卡片永遠沒文字）
  let text = '';
  for (const root of [document.querySelector('article, main, [role="main"]'), document.body]) {
    const t2 = String((root && root.innerText) || '').replace(/\s+/g, ' ').trim();
    if (t2.length > text.length) text = t2;
  }
  return { text: text.slice(0, textMax), desc, og };
}

// executeScript 在凍結／記憶體節省分頁上可能永遠不回來——每個呼叫都加逾時，
// 超時算這輪失敗，不讓一個死分頁拖住整批。
async function grabPageMeta(tabId) {
  try {
    const p = api.scripting.executeScript({
      target: { tabId }, func: grabPageMetaInTab, args: [PREVIEW_TEXT_MAX]
    });
    p.catch(() => {});   // 逾時之後才落地的 rejection 不許變 unhandled
    let timer = null;
    try {
      const [r] = await Promise.race([p, new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(ti('bgGrabTimeout'))), GRAB_TIMEOUT_MS);
      })]);
      return (r && r.result) || { text: '', desc: '', og: '' };
    } finally { if (timer) clearTimeout(timer); }
  } catch (e) { return { error: String((e && e.message) || e) }; }   // 被丟棄、還在載、沒權限
}

// og:image 代表圖：抓回來縮成 ≤800px JPEG，只存記憶體（跟截圖同套快取／版本號機制）。
// 只抓 http/https、有大小上限、失敗略過（不進快取；重抓節奏由 metaStale 的失敗計次把關）。
// 私網／本機位址：只有「分頁本身就在同一個 host」才准抓——公開頁面宣告內網 og 一律擋。
function isPrivateHost(h) {
  h = String(h || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '[::1]' || h === '0.0.0.0') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254);
}
const ogUrlCache = new Map();   // url -> dataUrl（成功的才進來；插入序 LRU：命中時重插）
const ogInflight = new Map();   // url -> Promise<dataUrl>（兩個分頁共用同圖只抓一次）
async function ogAsData(u) {
  if (!u || !/^https?:\/\//i.test(u)) return '';
  const hit = ogUrlCache.get(u);
  if (hit !== undefined) { ogUrlCache.delete(u); ogUrlCache.set(u, hit); return hit; }
  if (ogInflight.has(u)) return ogInflight.get(u);
  const job = (async () => {
    let out = '';
    try {
      const r = await fetch(u, {
        signal: AbortSignal.timeout(10000),
        referrerPolicy: 'no-referrer', credentials: 'omit'
      });
      const ct = String(r.headers.get('content-type') || '').toLowerCase();
      const cl = +(r.headers.get('content-length') || 0);
      // content-length 先看再讀 body（有的 server 不給，那就讀完再量 b.size）
      if (r.ok && ct.startsWith('image/') && (!cl || cl <= OG_BYTES_MAX)) {
        const b = await r.blob();
        if (b.size && b.size <= OG_BYTES_MAX && b.type.startsWith('image/')) {
          const bmp = await createImageBitmap(b);
          // 解碼後像素封頂：擋「1KB 檔案解出 1GB 點陣圖」的解壓縮炸彈
          if (bmp.width * bmp.height <= OG_PIXELS_MAX) {
            const sc = Math.min(1, OG_MAX_DIM / Math.max(bmp.width, bmp.height));
            const w = Math.max(1, Math.round(bmp.width * sc));
            const h = Math.max(1, Math.round(bmp.height * sc));
            const c = new OffscreenCanvas(w, h);
            const cx = c.getContext('2d');
            cx.fillStyle = '#fff';   // 透明 PNG/WebP 轉 JPEG 先鋪白底，不然變黑底
            cx.fillRect(0, 0, w, h);
            cx.drawImage(bmp, 0, 0, w, h);
            out = await blobToDataUrl(await c.convertToBlob({ type: 'image/jpeg', quality: OG_Q }));
          }
          bmp.close();
        }
      }
    } catch (_) { /* 抓不到就留空，不快取失敗 */ }
    if (out) {
      while (ogUrlCache.size >= OG_CACHE_MAX) ogUrlCache.delete(ogUrlCache.keys().next().value);
      ogUrlCache.set(u, out);
    }
    return out;
  })();
  ogInflight.set(u, job);
  try { return await job; } finally { ogInflight.delete(u); }
}

// options 頁除錯區：最近抓文字失敗的分頁與原因（權限／凍結／錯誤訊息）
const grabFails = [];
function classifyGrab(why) {
  const m = String(why);
  if (/timeout|frozen|逾時|凍結/i.test(m)) return ti('bgKindFrozen');
  if (/cannot access|permission|權限/i.test(m)) return ti('bgKindNoPerm');
  if (/no tab with|no window/i.test(m)) return ti('bgKindClosed');
  return ti('bgKindOther');
}
function logGrabFail(tb, why, fails) {
  grabFails.unshift({
    t: Date.now(), kind: classifyGrab(why), msg: String(why).slice(0, 160),
    title: String((tb && tb.title) || '').slice(0, 80), url: String((tb && tb.url) || '').slice(0, 160), fails
  });
  if (grabFails.length > FAIL_LOG_MAX) grabFails.length = FAIL_LOG_MAX;
  grabFailsDirty = true;   // 寫入 storage 集中在 flush，每輪最多一次（一次批量 8 個失敗不會重寫 8 次）
}
let grabFailsDirty = false;
function flushGrabFails() {
  if (!grabFailsDirty) return;
  grabFailsDirty = false;
  try {
    if (api.storage && api.storage.session) Promise.resolve(api.storage.session.set({ grabFails })).catch(() => {});
  } catch (_) { /* 存不了就算了 */ }
}

// 這個分頁現在需不需要（重新）抓頁面資訊
function metaStale(tb) {
  if (!tb || tb.discarded || !previewable(tb)) return false;
  const cur = metaCache.get(tb.id);
  if (!cur) return true;
  if (cur.url !== (tb.url || '')) return true;
  const backoff = n => (n || 1) >= META_MAX_FAILS ? META_GIVEUP_MS : META_FAIL_RETRY_MS;
  // 抓到內容但還沒有內文（SPA 慢渲染）：退避補抓；連敗滿 META_HARD_FAILS 認定這頁真沒文字
  if (cur.wantText && (cur.fails || 0) < META_HARD_FAILS &&
      Date.now() - (cur.failAt || 0) > backoff(cur.fails)) return true;
  // 代表圖下載失敗：跟內文補抓各自獨立的退避（一樣有連敗升級＋停手上限，不無限重試）
  if (cur.ogWhy && (cur.ogFails || 0) < META_HARD_FAILS &&
      Date.now() - (cur.ogFailAt || 0) > backoff(cur.ogFails)) return true;
  if (!cur.why) return false;
  return Date.now() - (cur.failAt || 0) > backoff(cur.fails);
}
// 抓一個分頁的主內容文字＋摘要＋代表圖。回 true＝內容有變（值得推一輪給 server）。
async function refreshTabMeta(tb) {
  const url = tb.url || '';
  const prev = metaCache.get(tb.id);
  const same = prev && prev.url === url;
  // opts: {dirty, skipLog, ogWhy, ogFailAt, ogFails} —— og 三欄沒給就沿用同網址的舊值
  const fail = (why, opts) => {
    opts = opts || {};
    const fails = (same ? prev.fails || 0 : 0) + 1;
    if (!opts.skipLog) logGrabFail(tb, why, fails);
    metaCacheSet(tb.id, {
      url,
      text: same ? prev.text : null, desc: same ? prev.desc : '',
      ogUrl: same ? prev.ogUrl : '', ogData: same ? prev.ogData : '',
      fails, failAt: Date.now(), why,
      ogWhy: opts.ogWhy != null ? opts.ogWhy : (same ? (prev.ogWhy || '') : ''),
      ogFailAt: opts.ogFailAt != null ? opts.ogFailAt : (same ? (prev.ogFailAt || 0) : 0),
      ogFails: opts.ogFails != null ? opts.ogFails : (same ? (prev.ogFails || 0) : 0)
    });
    return !!opts.dirty;
  };
  const g = await grabPageMeta(tb.id);
  if (g.error) return fail(g.error);
  const text = g.text || '';
  const desc = String(g.desc || '').slice(0, META_DESC_MAX);
  let ogUrl = g.og || '';
  // 私網／本機位址的代表圖：只有分頁自己也在同一個 host 才准抓（本地開發頁抓本地圖 OK；
  // 公開頁面宣告指向內網的 og image 一律丟掉，擋 SSRF／內網探測）
  if (ogUrl) {
    try {
      const oh = new URL(ogUrl).hostname, th = new URL(url).hostname;
      if (isPrivateHost(oh) && oh !== th) ogUrl = '';
    } catch (_) { ogUrl = ''; }
  }
  // 代表圖：同頁同圖就沿用之前抓好的；新的才下載。下載失敗不拖垮整筆——
  // 文字／摘要照存（舊版這裡整筆判死、連剛抓到的文字一起丟，og 一時抓不到就全部消失），
  // 只記 ogWhy＋連敗計次讓 metaStale 之後退避重試這一項。
  let ogData = (same && prev.ogUrl === ogUrl) ? (prev.ogData || '') : '';
  let ogWhy = '', ogFailAt = 0;
  let ogFails = (same && prev.ogUrl === ogUrl) ? (prev.ogFails || 0) : 0;
  if (ogUrl && !ogData) {
    ogData = await ogAsData(ogUrl);
    if (!ogData) {
      ogWhy = ti('bgOgFail') + ogUrl.slice(0, 80);
      ogFailAt = Date.now();
      ogFails++;
      // 除錯清單只在第一次失敗記一筆；之後退避重試不再灌同一條
      if (ogFails === 1) logGrabFail(tb, ogWhy, ogFails);
    } else {
      ogFails = 0;
    }
  }
  // 載入到一半抓到全空：不算成功，記一次失敗讓退避重試把關（SPA 稍後補內容才抓得到）。
  // og 剛失敗已記過就不重複記（同一輪不清單洗版）；og 狀態併入這筆失敗，不被丟掉。
  if (!text && !desc && !ogData) {
    return fail(ti('bgEmpty'), { skipLog: ogFails > 0, ogWhy, ogFailAt, ogFails });
  }
  // 摘要／代表圖有了但內文還是空 = 多半 SPA 還沒渲染完：標 wantText，隔一段再補，
  // 補到文字出現為止；連敗滿 META_HARD_FAILS 認定這頁真的沒文字（canvas 應用之類），收手。
  const wantText0 = !text && !tb.discarded;
  const fails = wantText0 ? (same ? (prev.fails || 0) + 1 : 1) : 0;
  const wantText = wantText0 && fails <= META_HARD_FAILS;
  const failAt = wantText ? Date.now() : 0;
  // 只有真的跟上次不一樣才回報「有新內容」，免得每次重抓都白白推一輪
  const changed = !prev || prev.url !== url || prev.why || prev.ogWhy !== ogWhy ||
    (prev.text || '') !== text || (prev.desc || '') !== desc ||
    (prev.ogUrl || '') !== ogUrl || (prev.ogData || '') !== ogData;
  metaCacheSet(tb.id, { url, text, desc, ogUrl, ogData, fails, failAt, why: '', ogWhy, ogFailAt, ogFails, wantText });
  return changed;
}

// 獨立的背景補抓循環：跟「推清單」脫鉤——清單不變就不推，但補抓照跑；
// 一輪一輪補到「全部都有、或確定失敗（連敗逾上限→長退避）」為止，抓到新內容才推送。
// SW 被 Chrome 回收也沒關係：狀態全在快取裡，下一次 pushNow 會重踢這個循環。
let metaLoopRunning = false;
async function metaFillLoop() {
  if (metaLoopRunning) return;
  metaLoopRunning = true;
  try {
    for (let round = 0; round < META_MAX_ROUNDS; round++) {
      let tabs = [];
      try { tabs = await api.tabs.query({ windowType: 'normal' }); } catch (_) { break; }
      const due = tabs.filter(metaStale).slice(0, META_BATCH);
      if (!due.length) break;
      // 逐分頁各自 catch：一個爆炸不許中止整輪
      const got = await Promise.all(due.map(tb => refreshTabMeta(tb).catch(() => false)));
      flushGrabFails();
      if (got.some(Boolean)) pushSoon(0);   // 抓到新內容才推送
      await sleep(META_ROUND_PAUSE_MS);
    }
  } finally { metaLoopRunning = false; flushGrabFails(); }
}
// 拍一張並存起來。captureVisibleTab 抓的是「那個視窗現在顯示的東西」，
// 是非同步的：按下去之後頁面可能已經換了，所以拍完要回頭確認該分頁還是同一個視窗的
// 前景分頁，不是就丟掉。錯的圖會被永久快取，舊機制靠每輪重拍自我修正、新機制沒有。
let lastCapWhy = '';                  // captureTab 最近一次失敗的原因（給閒置補拍的除錯清單用）
async function captureTab(tabId, windowId) {
  lastCapWhy = '';
  // 先查再拍：同網址 30 分鐘內的真截圖夠新就直接收工，不浪費 captureVisibleTab 的
  // 每秒配額（補拍那頭另有 shotNeedsRefresh 把關）。拍完 async 期間分頁可能已換，
  // 所以結尾還是要再驗一次「還是同視窗前景」。
  const pre = await api.tabs.get(tabId).catch(() => null);
  if (!pre || !pre.active || pre.windowId !== windowId) {
    lastCapWhy = !pre ? 'tab gone' : (!pre.active ? 'not foreground' : 'moved window');
    return false;
  }
  if (shotIsFresh(shotCache.get(tabId), pre.url)) { lastCapWhy = 'still fresh'; return false; }
  let raw = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      raw = await api.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 90 });
      break;
    } catch (e) {
      lastCapWhy = 'captureVisibleTab: ' + ((e && e.message) || e || '?');
      // 每秒兩張的配額撞上（例如使用者連按 Ctrl+Tab）就等一下重試一次，再不成就放棄
      if (attempt === 0 && /MAX_CAPTURE/.test(lastCapWhy)) { await sleep(700); continue; }
      return false;
    }
  }
  if (!raw) return false;
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.active || tab.windowId !== windowId) {
    lastCapWhy = !tab ? 'tab gone' : (!tab.active ? 'no longer foreground' : 'moved window');
    return false;
  }
  // 拍完了才發現 30 分鐘內已經有人拍了同網址的真截圖（onActivated 連發等）：丟掉這張。
  if (shotIsFresh(shotCache.get(tabId), tab.url)) { lastCapWhy = 'still fresh'; return false; }
  const shot = await shrinkShot(raw);
  if (!shot) { lastCapWhy = 'shrink failed'; return false; }
  shotCachePut(tabId, shot, tab.url);
  return true;
}

// 閒置補拍每個分頁的結果（給除錯／e2e 看；只留最後一輪）
const sweepTrail = [];

// ---------------------------------------------------------------- 背景分頁 DOM 繪圖
// 對「還沒有任何截圖」的背景 http(s) 分頁（非前景、非休眠）：注入打包在擴充裡的
// extension/vendor/html-to-image.js（html-to-image v1.11.11，MIT），把可視範圍
// （≤DRAW_W×DRAW_H）直接畫成 JPEG——不切分頁、畫面不閃。結果走同一套 shrink／
// shotCache／推送，標 kind:'drawn'；使用者之後切過去，真截圖一律覆蓋它。
// 一次只畫一個分頁、間隔 ≥DRAW_GAP_MS；單頁超過 DRAW_TIMEOUT_MS 放棄，
// 同網址記住失敗不再重試（網址變了才解除）。畫不動的重頁面在 DRAW_BLACKLIST 先排除。
// 同一個分頁的同網址畫失敗就停手（分頁的網址變了才解除）。onRemoved 會清掉對應項目；
// 再補一個數量上限，避免分頁 id 重用或長期累積讓它無界長大。
const drawFails = new Map();      // tabId -> {url}
const DRAW_FAILS_MAX = 200;
function drawFailSet(tabId, url) {
  drawFails.delete(tabId);
  drawFails.set(tabId, { url: String(url || '') });
  while (drawFails.size > DRAW_FAILS_MAX) drawFails.delete(drawFails.keys().next().value);
}
let drawRunning = false;

// 在目標分頁裡跑（executeScript 的 func，必須自含頂層函式）：
// vendor 檔已先於 func 注入同一分頁（executeScript files 先跑），直接用 globalThis.htmlToImage。
function drawVisibleAreaInTab(maxW, maxH) {
  try {
    const lib = globalThis.htmlToImage;
    if (!lib || typeof lib.toJpeg !== 'function') return { error: 'htmlToImage missing' };
    // 0×0（隱藏／prerender 中的分頁）畫不出東西，回報讓呼叫端記住，別靜默用預設尺寸亂畫
    if (!window.innerWidth || !window.innerHeight) return { error: 'viewport hidden（0×0）' };
    const w = Math.max(1, Math.min(window.innerWidth, maxW));
    const h = Math.max(1, Math.min(window.innerHeight, maxH));
    return lib.toJpeg(document.documentElement, {
      backgroundColor: '#ffffff', width: w, height: h, pixelRatio: 1,
      skipFonts: true, quality: 0.92, fetchRequestInit: { cache: 'force-cache' }
    }).then(img => ({ ok: true, img }))
      .catch(e => ({ error: String((e && e.message) || e || 'toJpeg failed').slice(0, 200) }));
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 200) };
  }
}

function drawBlacklisted(url) {
  const u = String(url || '');
  return DRAW_BLACKLIST.some(re => re.test(u));
}

async function drawTabShot(tabId) {
  const work = (async () => {
    await api.scripting.executeScript({ target: { tabId }, files: ['vendor/html-to-image.js'] });
    const [r] = await api.scripting.executeScript({
      target: { tabId }, func: drawVisibleAreaInTab, args: [DRAW_W, DRAW_H]
    });
    return (r && r.result) || { error: 'no result' };
  })();
  work.catch(() => {});   // 逾時落地後的 rejection 不許變 unhandled
  let timer = null;
  try {
    return await Promise.race([work, new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(ti('bgDrawTimeout'))), DRAW_TIMEOUT_MS);
    })]);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  } finally { if (timer) clearTimeout(timer); }
}

function drawCandidate(tb) {
  if (!tb || tb.discarded || tb.active || tb.status !== 'complete') return false;
  if (!previewable(tb) || drawBlacklisted(tb.url)) return false;
  if (shotCache.has(tb.id)) return false;               // 有圖（含 drawn）就不用畫
  const f = drawFails.get(tb.id);
  if (f && f.url === (tb.url || '')) return false;      // 同網址失敗過：網址變了才再試
  return true;
}

async function drawFillLoop() {
  if (drawRunning) return;
  if (sweepCtl && sweepCtl.running) return;   // 閒置補拍正在切分頁拍真的，繪圖讓路
  drawRunning = true;
  let drewAny = false;
  try {
    for (let round = 0; round < DRAW_MAX_ROUNDS; round++) {
      let tabs = [];
      try { tabs = await api.tabs.query({ windowType: 'normal' }); } catch (_) { break; }
      const next = tabs.find(drawCandidate);
      if (!next) break;
      // async 期間分頁可能已變（前景／休眠／轉址／補拍），複查一次再畫
      const cur = await api.tabs.get(next.id).catch(() => null);
      if (!cur || !drawCandidate(cur)) continue;
      // 一個分頁出錯不許炸掉整輪（shrink 丟錯、tabs.get 丟錯都各自隔離）
      try {
        const g = await drawTabShot(cur.id);
        if (g && g.ok && typeof g.img === 'string') {
          let shot = null;
          try { shot = await shrinkShot(g.img); } catch (_) { shot = null; }
          const tb2 = await api.tabs.get(cur.id).catch(() => null);
          if (!shot) {
            // 縮圖失敗多半是暫時性的（OffscreenCanvas 資源被佔等）：不記終身失敗，下輪再試
            testStats.drawFail++;
            logGrabFail(cur, ti('bgDrawShrinkFail'), 1);
          } else if (tb2 && (tb2.url || '') === (cur.url || '') && !shotCache.has(cur.id)) {
            shotCachePut(cur.id, shot, cur.url, 'drawn');
            testStats.drawn++;
            drewAny = true;
          }
          // shot 有了但分頁轉址／已有真截圖：靜默丟棄，不算失敗
        } else {
          testStats.drawFail++;
          drawFailSet(cur.id, cur.url);
          logGrabFail(cur, ti('bgDrawFail') + String((g && g.error) || '?').slice(0, 120), 1);
        }
      } catch (e) {
        testStats.drawFail++;
        logGrabFail(cur, ti('bgDrawThrow') + String((e && e.message) || e).slice(0, 120), 1);
      }
      await sleep(DRAW_GAP_MS);
    }
  } finally {
    drawRunning = false;
    if (drewAny) pushSoon(0);   // 整輪合併推一次：不讓 40 張各自觸發完整推送
  }
}

// ---------------------------------------------------------------- 閒置靜音補拍
// 使用者離開（chrome.idle 偵測 60 秒無操作）且視窗看得到（非最小化／非全螢幕）時，
// 依序把「沒截圖、或截圖 >30 分鐘且網址變了」的分頁切前景、等渲染、各拍一張，
// 拍完立刻還原原本的前景分頁與焦點視窗。使用者一動（active）立刻中止，
// 最多晚一張。被丟棄的分頁不碰（不喚醒）；chrome:// 不碰（previewable 已擋）。
// options 頁可關（storage.local.idleSweep，預設開）。
let sweepCtl = null;               // {running, cancel}
let lastCapAt = 0;
let idlePref = true;               // options 開關的快取值
let testIdleOverride = null;       // e2e 測試注入：'idle'|'active'|'locked'|null
const sweepStats = { running: false, lastAt: 0, lastN: 0 };

async function idleState() {
  if (testIdleOverride) return testIdleOverride;
  try { return await api.idle.queryState(IDLE_DETECT_S); } catch (_) { return 'active'; }
}
// 補拍是不是把「人家要的分頁」搶走了：那個視窗的前景已經不是補拍自己最後切過去的那張。
// ctl.touched 在開跑時就用原始前景播種，之後只由補拍自己改寫——所以在補拍還沒碰過的
// 視窗裡，使用者現在看到的就是原始前景，比不到就等於「沒被接手」，不算誤判。
// 純 best-effort：查詢失敗／查不到前景都當成沒接手（照常繼續掃），因為寧可漏擋一次，
// 也不要讓一次暫時性的查詢失敗把整輪補拍卡死。
async function takenOver(ctl, windowId) {
  const want = ctl.touched.get(windowId);
  if (want == null) return false;                       // 不在本輪名單的視窗：沒得比
  const ts = await api.tabs.query({ windowId, active: true }).catch(() => []);
  const cur = ts && ts[0] && ts[0].id;
  return cur != null && cur !== want;
}

function shotNeedsRefresh(tb) {
  const c = shotCache.get(tb.id);
  if (!c) return true;
  // drawn 是 DOM 繪圖的暫代圖：閒置補拍有機會就換成真截圖
  if (c.kind === 'drawn') return true;
  return Date.now() - c.at > SHOT_IDLE_MIN_AGE && c.url !== (tb.url || '');
}
async function paceCapture() {
  const gap = Date.now() - lastCapAt;
  if (gap < CAP_GAP_MS) await sleep(CAP_GAP_MS - gap);
  lastCapAt = Date.now();
}
async function waitTabReady(tabId, msCap, shouldAbort) {
  const t0 = Date.now();
  while (Date.now() - t0 < msCap) {
    if (shouldAbort && shouldAbort()) return false;   // 使用者回來時不要拖滿整個等待
    const tb = await api.tabs.get(tabId).catch(() => null);
    if (!tb) return false;
    if (tb.status === 'complete') return true;
    await sleep(250);
  }
  return false;
}
// 閒置補拍永遠拍不到的分頁（例如一直 activation 失敗）：同分頁連敗幾次後這輪先放過，
// 半小時後再給它機會，不要每次補拍都徒勞地 activate→fail 閃畫面又吃截圖配額。
const sweepTabFails = new Map();      // tabId -> {n, at}
const SWEEP_TAB_FAIL_SKIP = 3;
async function startIdleSweep() {
  if (sweepCtl && sweepCtl.running) return;
  if (!idlePref) return;
  // 旗標要在第一個 await 之前就佔好：idle 事件與心跳自檢可能同時進來，
  // 晚設會開出兩個並行補拍，搶截圖配額又互相蓋。
  const ctl = { running: true, cancel: false, touched: new Map() };
  sweepCtl = ctl;
  sweepStats.running = true;
  let done = 0, userBack = false, orig = [], focusedWin = null;
  try {
    if ((await idleState()) !== 'idle') return;
    let wins = [];
    try { wins = await api.windows.getAll({ populate: true, windowTypes: ['normal'] }); } catch (_) { return; }
    // 只看「看得到」的視窗：最小化／全螢幕不碰；前景分頁在播音的視窗也不碰
    wins = wins.filter(w => (w.state === 'normal' || w.state === 'maximized') &&
      !(w.tabs || []).some(t => t.active && t.audible));
    if (!wins.length) return;
    const due = [];
    for (const w of wins) {
      for (const t of w.tabs || []) {
        if (!previewable(t) || t.discarded || !shotNeedsRefresh(t)) continue;
        const sf = sweepTabFails.get(t.id);
        if (sf && sf.n >= SWEEP_TAB_FAIL_SKIP && Date.now() - sf.at < SHOT_IDLE_MIN_AGE) continue;
        due.push(t);
      }
    }
    if (!due.length) return;
    orig = wins.map(w => ({ winId: w.id, tabId: ((w.tabs || []).find(t => t.active) || {}).id }));
    // 用原始前景播種「這一輪動過的前景」：補拍還沒碰過的視窗也有基準可比，
    // 使用者一在別的視窗切分頁就偵測得到（否則那座視窗等同不設防）。
    for (const o of orig) if (o.tabId != null) ctl.touched.set(o.winId, o.tabId);
    const fw = wins.find(w => w.focused);   // 只看 normal 視窗，popup/devtools 會搶不到焦點
    focusedWin = fw ? fw.id : null;
    sweepTrail.length = 0;
    for (const tb of due) {
      if (ctl.cancel) { sweepTrail.push({ id: tb.id, ok: false, why: 'aborted' }); break; }
      if ((await idleState()) !== 'idle') { userBack = true; sweepTrail.push({ id: tb.id, ok: false, why: 'user back' }); break; } // 每拍一張前都查一次：使用者回來立刻停
      // 前景已經不是我們上一張切過去的那個（被使用者／側欄按鈕／server 指令切走）＝有人接手，
      // 立刻收手。沒有這道，補拍會硬把人家剛切到的分頁再切走，一輪一輪蓋過去。
      // 整個 due 迴圈一起停（不是只跳過這個視窗）：接手通常代表使用者在用畫面，
      // 這時再切別的視窗一樣會閃，剩下的下一輪 idle 再補。
      if (await takenOver(ctl, tb.windowId)) { sweepTrail.push({ id: tb.id, ok: false, why: 'taken over' }); break; }
      try { await api.tabs.update(tb.id, { active: true }); } catch (_) { sweepTrail.push({ id: tb.id, ok: false, why: 'activate failed' }); continue; }
      ctl.touched.set(tb.windowId, tb.id);
      await waitTabReady(tb.id, SWEEP_LOAD_WAIT_MS, () => ctl.cancel);
      await sleep(SWEEP_PAINT_MS);
      if (ctl.cancel) { sweepTrail.push({ id: tb.id, ok: false, why: 'aborted' }); break; }
      if ((await idleState()) !== 'idle') { userBack = true; sweepTrail.push({ id: tb.id, ok: false, why: 'user back' }); break; }
      await paceCapture();
      if (await captureTab(tb.id, tb.windowId)) {
        sweepTrail.push({ id: tb.id, ok: true });
        sweepTabFails.delete(tb.id);
        done++;
        // 難得醒著（且被丟棄的沒被喚醒），順手補文字／代表圖；一個炸了不拖整批。
        // 重新取一份分頁快照再抓：等渲染這段時間分頁可能已經轉址。
        const fresh = await api.tabs.get(tb.id).catch(() => null);
        if (fresh) await refreshTabMeta(fresh).catch(() => false);
      } else {
        sweepTrail.push({ id: tb.id, ok: false, why: lastCapWhy || 'captureTab false' });
        const sf = sweepTabFails.get(tb.id) || { n: 0, at: 0 };
        sweepTabFails.set(tb.id, { n: sf.n + 1, at: Date.now() });
      }
    }
  } finally {
    // 還原原本前景。判斷標準改了：只有「現在前景還是補拍自己切過去的那張」才還原。
    // 現任分頁既不是原位、也不是我們切的＝別人（使用者、側欄按鈕、server 指令）在補拍
    // 期間切過分頁，那是他的意圖，收尾不准蓋掉。舊做法只看 cancel/userBack，補拍一直
    // 沒收到「使用者回來」（無頭瀏覽器沒有輸入事件，chrome.idle 永遠是 idle）時，
    // 收尾會把剛被按鈕切過去的分頁硬拉回原位——使用者看到的就是「按了卻沒切」。
    // 收尾驗的是「使用者是不是自己還停在原位」：原位已經回來就不動；被別人切走就
    // 留給人家；只有「被補拍切走、使用者沒接手」才還原（touched 是唯一線索，
    // 使用者切回原位的那種情況反正也等於原位＝不動作）。
    // 條件也不看 windows.update：視窗焦點只在真的有「把分頁切回去」時才補，
    // 且整窗有人接手時就不搶，免得使用者已經在別的視窗了還被拉回來。
    let restoredAny = false;
    for (const o of orig) {
      try {
        if (o.tabId == null) continue;
        const wt = await api.tabs.query({ windowId: o.winId, active: true }).catch(() => []);
        const curId = wt && wt[0] && wt[0].id;
        if (curId == null) { restoredAny = true; continue; }   // 視窗沒了
        if (curId === o.tabId) { restoredAny = true; continue; }   // 已經回原位
        if (curId !== ctl.touched.get(o.winId)) { restoredAny = true; continue; }  // 別人切的，留給人家
        await api.tabs.update(o.tabId, { active: true });
        restoredAny = true;
      } catch (_) {}
    }
    if (focusedWin != null && restoredAny && !userBack && !ctl.cancel) {
      try { await api.windows.update(focusedWin, { focused: true }); } catch (_) {}
    }
    if (sweepCtl === ctl) sweepCtl.running = false;
    sweepStats.running = false;
    sweepStats.lastAt = Date.now();
    sweepStats.lastN = done;
    noteSweep();
    if (done) pushSoon(0);
  }
}
function abortIdleSweep() { if (sweepCtl && sweepCtl.running) sweepCtl.cancel = true; }

function noteSweep() {
  try {
    if (api.storage && api.storage.session) {
      Promise.resolve(api.storage.session.set({ lastSweepAt: sweepStats.lastAt, lastSweepN: sweepStats.lastN })).catch(() => {});
    }
  } catch (_) { /* 沒有 session 儲存就算了 */ }
}

// idle 事件：idle → 開掃；active → 立刻停（locked 也停；locked 不該掃）
if (api.idle && api.idle.onStateChanged) {
  try { api.idle.setDetectionInterval(IDLE_DETECT_S); } catch (_) { /* Firefox 下限不同也沒關係 */ }
  api.idle.onStateChanged.addListener(st => {
    if (testIdleOverride) return;   // 測試注入期間以注入值為準
    if (st === 'idle') startIdleSweep().catch(() => {});
    else abortIdleSweep();
  });
}

async function collectTabs() {
  const tabs = await api.tabs.query({});
  const wins = await api.windows.getAll({ windowTypes: ['normal'] });
  const normalWin = new Set(wins.map(w => w.id));
  // 持久化認領：IndexedDB 裡同網址（去 #）有截圖的分頁直接補上——
  // 擴充重開／SW 被回收／Chrome 重開後，卡片不用等切前景立刻有畫面。
  // 超過 7 天的不認（頁面早變了，與其放錯的臉不如等重拍）；認領算使用，刷新 LRU 年齡序。
  for (const tb of tabs) {
    if (shotCache.has(tb.id)) continue;
    const k = shotUrlKey(tb.url);
    const ent = k && urlShotMem.get(k);
    if (ent && (Date.now() - ent.at) < PERSIST_ADOPT_MS) {
      urlShotMem.delete(k); urlShotMem.set(k, ent);   // 認領＝使用，排到最新
      shotCache.delete(tb.id);
      shotCache.set(tb.id, { shot: ent.shot, url: String(tb.url || ''), at: ent.at, kind: ent.kind || 'shot' });
    }
  }
  // 沒有快取又正好在前景的分頁（第一次啟動、或快取被驅逐）才即時拍；其餘靠 onActivated 累積。
  // 閒置補拍正在跑就整段讓路：補拍自己照順序拍，這裡再拍會撞 captureVisibleTab 每秒配額。
  const sweepOn = sweepCtl && sweepCtl.running;
  await Promise.all(tabs.map(async tb => {
    if (sweepOn || !tb.active || !normalWin.has(tb.windowId) || shotCache.has(tb.id)) return;
    await captureTab(tb.id, tb.windowId);
  }));
  // map callback 回傳、事後 filter：保留 api.tabs.query 的原序（視窗→index），
  // 不讓 favicon 抓取快慢決定清單順序（直接 out.push 會讓卡片每推一次重排一次）
  const rows = await Promise.all(tabs.map(async tb => {
    if (!normalWin.has(tb.windowId)) return null;   // devtools / popup 視窗不算
    const fav = await favAsData(tb.favIconUrl || '');
    const meta = metaCache.get(tb.id);
    const hasMeta = meta && meta.url === (tb.url || '');
    const shotEnt = shotCacheGet(tb.id);
    return {
      id: tb.id,
      windowId: tb.windowId,
      index: tb.index,
      title: tb.title || '',
      url: tb.url || '',
      fav,
      active: !!tb.active,
      discarded: !!tb.discarded,
      lastAccessed: tb.lastAccessed || 0,
      shot: (shotEnt && shotEnt.shot) || null,
      shotKind: shotEnt ? (shotEnt.kind || 'shot') : null,
      text: hasMeta ? (meta.text || '') : '',
      desc: hasMeta ? (meta.desc || '') : '',
      // 代表圖跟截圖同套：只送「跟上次推的不一樣」的，server 端跨推送保留
      og: (hasMeta && meta.ogData && ogSent.get(tb.id) !== meta.ogData) ? meta.ogData : null,
      // 確定這頁沒有 og:image → 叫 server 把上一頁留下的舊圖丟掉（導航後不殘留）
      ogClear: !!(hasMeta && !meta.why && !meta.ogUrl)
    };
  }));
  return rows.filter(Boolean);
}

let pushing = false;   // pushNow 重入保護：補抓循環的 pushSoon(0) 可能撞上還在推的那一輪
async function pushNow() {
  // 文字／代表圖的補抓跟推送脫鉤（獨立循環在背景跑到補完為止）；
  // 這裡只在進來時順手踢一腳，循環自己會在「抓到新內容」時 pushSoon 回來。
  Promise.resolve(metaFillLoop()).catch(() => {});
  // 背景分頁 DOM 繪圖同一套：沒截圖的分頁直接畫一張（不切分頁、不閃）
  Promise.resolve(drawFillLoop()).catch(() => {});
  if (pushing) { pushSoon(500); return; }
  pushing = true;
  try {
    const tabs = await collectTabs();
    // 截圖只送「跟上次推的不一樣」的那幾張：一次推送通常 0–1 張，
    // 不再每輪把十幾 MB 的 base64 重送一遍（server 端沒收到就沿用舊圖）。
    for (const tb of tabs) {
      if (!tb.shot) continue;
      if (shotSent.get(tb.id) === tb.shot) tb.shot = null;
    }
    const r = await fetch(base() + '/api/tabs', {
      method: 'POST',
      headers: await headers(true),
      body: JSON.stringify({ tabs, extId: (api.runtime && api.runtime.id) || '' }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!r.ok) throw new Error('http ' + r.status);
    for (const tb of tabs) if (tb.shot) shotSent.set(tb.id, tb.shot);
    for (const tb of tabs) if (tb.og) ogSent.set(tb.id, tb.og);
    // server 說還缺哪幾張（它重開過、記憶體空了）：把「送過了」的記錄作廢再推一輪補回去。
    // 沒作廢過就不重推，避免兩邊互推成迴圈。
    const reply = await r.json().catch(() => null);
    let resend = false;
    if (reply && Array.isArray(reply.needShot)) {
      for (const id of reply.needShot) if (shotSent.delete(id)) resend = true;
    }
    if (reply && Array.isArray(reply.needOg)) {
      for (const id of reply.needOg) if (ogSent.delete(id)) resend = true;
    }
    // 送出後清掉已離線分頁的記錄，map 不會無限長
    if (shotSent.size > SHOT_CACHE_MAX) {
      for (const k of shotSent.keys()) if (!shotCache.has(k)) shotSent.delete(k);
    }
    if (ogSent.size > TEXT_CACHE_MAX) {   // og 圖活在 metaCache 裡，修剪門檻跟著 metaCache
      for (const k of ogSent.keys()) if (!metaCache.has(k)) ogSent.delete(k);
    }
    lastPushOk = Date.now();
    lastError = '';
    noteStatus();
    // 有幾張是「server 手上沒有、而我們以為送過了」→ 再推一次補齊（補完 needShot 就空，不會迴圈）
    if (resend) pushSoon(300);
  } catch (e) {
    lastError = String((e && e.message) || e);
    noteStatus();
    // server 不在（或還沒配對成功）：安靜等 8 秒再試，迴圈到成功為止
    if (!retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; pushNow(); }, 8000);
    }
  } finally { pushing = false; }
}

function pushSoon(ms) {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; pushDeadline = 0; pushNow(); }, ms == null ? 250 : ms);
}

api.tabs.onCreated.addListener(() => pushSoon());
api.tabs.onRemoved.addListener(id => { shotCache.delete(id); shotSent.delete(id); ogSent.delete(id); metaCache.delete(id); drawFails.delete(id); pushSoon(); });
// 持續變動的頁面（標題一直跳）會讓 debounce 一直被重置、永遠不推 → 逾期就強制送一次
let pushDeadline = 0;
api.tabs.onUpdated.addListener((id, info) => {
  // 只在意真的會改變卡片的三件事；其餘（音量、audible、未變的屬性）不值得推
  const relevant = info.status === 'complete' || info.title != null || info.url != null || info.favIconUrl != null;
  if (!relevant) return;
  if (info.status === 'complete') {
    shotCache.delete(id);      // 重新載入完的頁面，舊截圖過期了
    shotSent.delete(id);
    metaCache.delete(id);
  } else if (info.url != null) {
    metaCache.delete(id);      // 換網址了，文字／摘要／代表圖一定不同
  }
  // 標題／favicon 常常連跳好幾次 → 合併成一次；但最多等 MAX 就送
  const now = Date.now();
  // 休眠分頁被切過去＝Chrome 重新載入它，載完（complete）就是補拍的時機。
  // 走 queueCapture 同一個節流佇列（每秒 2 張、只拍前景），不干擾使用者打字／捲動。
  if (info.status === 'complete') queueCapture(id, null);
  if (!pushDeadline) pushDeadline = now + PUSH_MAX_WAIT_MS;
  pushSoon(Math.max(0, Math.min(PUSH_DEBOUNCE_MS, pushDeadline - now)));
});
// 切到前景＝快拍一張並存起來（截圖只能拍前景；存起來後切走也還在）。
// 連按 Ctrl+Tab 會連續觸發，所以排隊拍：一次只有一個 captureVisibleTab 在跑
// （它本身也有每秒配額），後到的覆蓋前一個待拍目標。
let capBusy = false, capWanted = null;
function queueCapture(tabId, windowId) {
  if (sweepCtl && sweepCtl.running) return;   // 補拍自己會拍，onActivated 的隨手拍先讓路
  capWanted = { tabId, windowId };
  if (capBusy) return;
  capBusy = true;
  (async () => {
    try {
      while (capWanted) {
        const w = capWanted; capWanted = null;
        // onUpdated 只知道 tabId：現在才查 windowId（分頁可能已經被搬到別的視窗）
        let wid = w.windowId;
        if (wid == null) {
          const tb = await api.tabs.get(w.tabId).catch(() => null);
          if (!tb) continue;
          // 背景分頁載完也拍不到（captureVisibleTab 只能拍前景）→ 直接跳過，不吃配額
          if (!tb.active) continue;
          wid = tb.windowId;
        }
        await paceCapture();          // captureVisibleTab 每秒 2 張的配額，一律先在這裡排隊
        // 排隊可能等掉半秒，使用者早就切走了：拍之前複查還是前景，否則這張會拍成別人的畫面
        // （captureTab 拍完也會再驗一次，那道留著——兩邊都便宜）
        if (w.windowId == null) {
          const tb2 = await api.tabs.get(w.tabId).catch(() => null);
          if (!tb2 || !tb2.active || tb2.windowId !== wid) continue;
        }
        await captureTab(w.tabId, wid);
      }
    } finally {
      // paceCapture／captureTab 一 reject 就整個 session 不再拍照（佇列死掉），一律解鎖
      capBusy = false;
    }
  })();
}
api.tabs.onActivated.addListener(({ tabId, windowId }) => { testStats.activatedEvents++; queueCapture(tabId, windowId); pushSoon(); });
api.tabs.onMoved.addListener(() => pushSoon());
api.tabs.onAttached.addListener(() => pushSoon());
api.tabs.onDetached.addListener(() => pushSoon());
api.windows.onCreated.addListener(() => pushSoon());
api.windows.onRemoved.addListener(() => pushSoon());
// 補丁心跳：事件漏掉（罕見）或 MV3 worker 被喚醒錯過 timer 時每分鐘也補推一次
// Firefox 的 alarms.create 回 Promise（Chrome 回 undefined），統一吞掉可能的 rejection
Promise.resolve(api.alarms.create('riffle-tabs-heartbeat', { periodInMinutes: 1 })).catch(() => {});
api.alarms.onAlarm.addListener(a => {
  if (a.name !== 'riffle-tabs-heartbeat') return;
  pushNow();
  // SW 若在「已經 idle」期間被回收，onStateChanged 不會再丟 idle 轉換 → 心跳時自查一次
  if (idlePref && !testIdleOverride) {
    idleState().then(st => { if (st === 'idle') return startIdleSweep(); }).catch(() => {});
  }
});

// ---------------------------------------------------------------- commands
// 在目標分頁裡跑（executeScript 的 func）：只讀、一字不漏回傳
function grabTabContent(textMax, htmlMax) {
  // 截斷不能切斷代理對（surrogate pair）：尾巴是孤單的高位代理就丟掉，不然顯示亂碼
  function truncStr(s, max) {
    if (s.length <= max) return [s, false];
    let cut = s.slice(0, max);
    const c = cut.charCodeAt(cut.length - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut = cut.slice(0, -1);
    return [cut, true];
  }
  const out = { title: document.title || '', url: location.href, text: '', textTruncated: false, html: '', htmlTruncated: false };
  try {
    const [text, truncated] = truncStr((document.body && document.body.innerText) || '', textMax);
    out.text = text;
    out.textTruncated = truncated;
  } catch (_) { /* 無 body（如 PDF viewer） */ }
  try {
    const [html, truncated] = truncStr((document.documentElement && document.documentElement.outerHTML) || '', htmlMax);
    out.html = html;
    out.htmlTruncated = truncated;
  } catch (_) { /* 不該發生，但丟了也算 */ }
  return out;
}

async function postResult(reqId, payload) {
  try {
    await fetch(base() + '/api/tabs/result', {
      method: 'POST', headers: await headers(true), body: JSON.stringify({ reqId, ...payload }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch (_) { /* server 收的時候不在就算了 */ }
}

async function runCmd(cmd) {
  if (!cmd || !cmd.op) return;
  if (cmd.op === 'read') {
    try {
      const [r] = await api.scripting.executeScript({
        target: { tabId: cmd.tabId },
        func: grabTabContent,
        args: [TEXT_MAX, HTML_MAX]
      });
      if (!r || !r.result) throw new Error('no result');
      await postResult(cmd.reqId, { ok: true, ...r.result });
    } catch (e) {
      await postResult(cmd.reqId, { ok: false, error: String((e && e.message) || e) });
    }
  } else if (cmd.op === 'activate') {
    try {
      await api.tabs.update(cmd.tabId, { active: true });
      if (cmd.windowId != null) await api.windows.update(cmd.windowId, { focused: true });
    } catch (_) { /* 分頁已關 */ }
  } else if (cmd.op === 'open') {
    try {
      // server 端已卡過 http/https，這裡再卡一次當底線
      if (/^https?:\/\//i.test(String(cmd.url))) await api.tabs.create({ url: cmd.url });
    } catch (_) { /* 開不了就算了 */ }
  } else if (cmd.op === 'close') {
    try { await api.tabs.remove(cmd.tabId); testStats.closed++; } catch (_) { /* 分頁已關 */ }
    // 清單由 tabs.onRemoved → pushSoon 補推
  } else if (cmd.op === 'restore') {
    await restoreLastClosed();   // chrome.sessions；不支援／沒東西可復原就靜默
  }
}

// 卡片 × 鈕的「復原」：chrome.sessions.restore()（不帶參數＝最近關掉的那一個）。
// 舊版 Firefox／沒權限就 quiet no-op（頁面端本來就不該顯示復原鈕，這是底線保險）。
async function restoreLastClosed() {
  if (!api.sessions || typeof api.sessions.restore !== 'function') return false;
  try {
    const r = await api.sessions.restore();
    testStats.restored++;
    const tab = r && (r.tab || (r.window && r.window.tabs && r.window.tabs[0]));
    if (tab && tab.id != null) {
      try { await api.tabs.update(tab.id, { active: true }); } catch (_) {}
      if (tab.windowId != null) {
        try { await api.windows.update(tab.windowId, { focused: true }); } catch (_) {}
      }
    }
    return true;
  } catch (_) { return false; }
}

// 長輪詢：server 最多 hold 15 秒。持續的 in-flight fetch 讓 MV3 worker 維持活著；
// server 掛了或拒絕（http != 200）就等 5 秒再試；回 200 但沒指令也歇 300ms 再問。
async function cmdLoop() {
  for (;;) {
    try {
      const r = await fetch(base() + '/api/tabs/cmd?wait=15000', {
        headers: await headers(false),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS + 10000)
      });
      if (!r.ok) throw new Error('http ' + r.status);
      const d = await r.json();
      lastError = '';
      noteStatus();
      if (d && d.cmd) await runCmd(d.cmd);   // 跑完馬上再問（佇列可能還有）
      else await sleep(300);                  // 沒事做就喘一下，不零退避空轉
    } catch (e) {
      lastError = String((e && e.message) || e);
      noteStatus();
      await sleep(5000);
    }
  }
}

// ---------------------------------------------------------------- options 狀態
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 右緣抽屜內容腳本啟動時查一次：本視窗真側邊欄開著嗎（之後靠廣播更新）
  if (msg && msg.type === 'riffle-drawer-panel-state?') {
    const w = _sender && _sender.tab && _sender.tab.windowId;
    sendResponse({ open: Number.isFinite(w) ? panelOpenInWindow(w) : panelPorts.size > 0 });
    return;
  }
  if (msg && msg.type === 'riffle-drawer-zoom') {
    // 抽屜內容腳本：指標進抽屜→on:true（暫停本分頁瀏覽器縮放）、離開→on:false（還原）
    const id = _sender && _sender.tab && _sender.tab.id;
    if (!(id > 0)) { sendResponse({ ok: false }); return; }
    setDrawerZoomMode(id, msg.on === true)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;                                     // 非同步回覆
  }
  if (msg && msg.type === 'riffle-test-idle') {
    // e2e 測試注入閒置狀態（不要等真的 60 秒）：'idle' → 開始補拍；'active' → 中止並還原
    testIdleOverride = ['idle', 'active', 'locked'].includes(msg.state) ? msg.state : null;
    if (testIdleOverride === 'idle') startIdleSweep().catch(() => {});
    else if (testIdleOverride) abortIdleSweep();
    sendResponse({ ok: true, state: testIdleOverride });
    return;
  }
  if (msg && msg.type === 'riffle-clear-shots') {
    // options 頁「清除截圖快取」：記憶體＋IndexedDB 一起清
    (async () => {
      shotCache.clear();
      shotSent.clear();
      await persistClearAll();
      sendResponse({ ok: true });
    })();
    return true;   // 非同步回應
  }
  if (!msg || msg.type !== 'riffle-status') return;
  (async () => {
    let sess = {};
    try {
      if (api.storage.session) sess = await api.storage.session.get({});
    } catch (_) { /* 沒有 session 儲存就用記憶體值 */ }
    // 被丟棄（休眠）的可抓分頁數：這些分頁刻意不去碰，給 options 除錯區當解釋
    let sleeping = 0;
    try {
      const tabs = await api.tabs.query({ windowType: 'normal' });
      sleeping = tabs.filter(t => t.discarded && previewable(t)).length;
    } catch (_) { /* 查不到就 0 */ }
    sendResponse({
      port,
      lastPushOk: sess.lastPushOk || lastPushOkRef || 0,
      lastError: sess.lastError != null ? sess.lastError : lastErrorRef,
      // 除錯區：最近抓文字失敗的分頁與原因（session 優先，worker 剛重啟就用記憶體值）
      grabFails: Array.isArray(sess.grabFails) ? sess.grabFails : grabFails.slice(),
      idleSweep: idlePref,
      sleeping,
      sweep: {
        running: sweepStats.running,
        lastAt: sess.lastSweepAt || sweepStats.lastAt || 0,
        lastN: sess.lastSweepN != null ? sess.lastSweepN : sweepStats.lastN,
        trail: sweepTrail.slice()        // 最近一輪每個分頁的結果（含失敗原因）
      },
      // 截圖持久化快取現況＋e2e 計數器
      shotStore: { n: urlShotMem.size,
        mb: Math.round([...urlShotMem.values()].reduce((s, v) => s + (v.bytes || 0), 0) / 104857.6) / 10 },
      testStats: { ...testStats, panelPorts: panelPorts.size }
    });
  })();
  return true;   // 非同步回應：Chrome 靠這個 true 把通道留著，Firefox 也吃同一種寫法
});

// ---------------------------------------------------------------- port 設定（本機 storage.local）
api.storage.onChanged.addListener((chg, area) => {
  if (area !== 'local') return;
  if (chg.idleSweep) {
    idlePref = chg.idleSweep.newValue !== false;
    if (!idlePref) abortIdleSweep();       // 關掉當下立刻停
  }
  // 抽屜開關撥成 ON：趁使用者剛表達「我要用它」，把內容腳本補進所有既開分頁
  // （manifest 注入只覆蓋之後載入的頁；活著的實體會被 drawer.js 旗標擋下，重複無害）
  if (chg.autoHideDrawer && chg.autoHideDrawer.newValue === true && chg.autoHideDrawer.oldValue !== true) {
    injectDrawerScripts().catch(() => {});
  }
  if (!chg.port) return;
  if (chg.port.newValue === undefined) { port = DEFAULT_PORT; return; }   // 被清掉＝回預設
  const p = Number(chg.port.newValue);
  if (Number.isInteger(p) && p >= 1 && p <= 65535) port = p;
});

(async () => {
  try {
    const d = await api.storage.local.get({ port: DEFAULT_PORT, idleSweep: true });
    const p = Number(d.port);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) port = p;
    idlePref = d.idleSweep !== false;
    await getToken();
  } catch (_) { /* 用預設照跑 */ }
  // 持久化的截圖放進記憶體後再推一輪：擴充／瀏覽器重開，卡片立刻有畫面
  idbLoadAll().then(() => pushSoon(0)).catch(() => {});
  pushSoon();
  cmdLoop();
})();

// ---------------------------------------------------------------- 側邊欄＋快捷鍵
// Chrome：點工具列圖示＝開/關側邊欄（精簡快翻模式）。Firefox 靠 manifest 的
// sidebar_action，這裡偵測不到 API 就安靜跳過（兩邊同一份程式）。
if (api.sidePanel && api.sidePanel.setPanelBehavior) {
  Promise.resolve(api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })).catch(() => {});
}

// ---------------------------------------------------------------- 直接點卡（頁面 → 擴充）
// RiffleDesk 頁面（http://127.0.0.1|localhost:<port>）點分頁卡時經
// chrome.runtime.sendMessage(extId, …) 直接送來（manifest externally_connectable 只放
// 本機位址），不走 server 輪詢——「幫忙開側欄」必須吃到使用者手勢，輪詢會把手勢弄丟。
// 手勢會過期：sidePanel.open 要在這個 handler 裡、任何 await 之前同步呼叫。
// Firefox 沒有 onMessageExternal／sidePanel：頁面端送不出去，自動退回 server 輪詢路徑。
const panelPorts = new Set();   // 側欄頁連進來的長連線（有連線＝側欄開著）
// 右緣抽屜（自動收合側欄）要知道本視窗真側邊欄開沒開——開著就讓抽屜休眠，避免一窗兩面板。
// panel-hello 之後 p._rdWin＝側欄所在視窗；null＝舊版面板頁還沒回報，保守當成各視窗都算開。
function panelOpenInWindow(w) {
  for (const p of panelPorts) if (p._rdWin == null || p._rdWin === w) return true;
  return false;
}
// 側欄開合有變化時通知相關分頁的內容腳本（w 給定＝那個視窗的分頁；null＝全部重算一遍）
function broadcastPanelState(w) {
  const apply = tabs => {
    for (const t of (tabs || [])) {
      try {
        Promise.resolve(api.tabs.sendMessage(t.id, { type: 'riffle-drawer-panel-state', open: panelOpenInWindow(t.windowId) })).catch(() => {});
      } catch (_) { /* 該分頁沒內容腳本（chrome:// 等）就算了 */ }
    }
  };
  try {
    if (Number.isFinite(w)) Promise.resolve(api.tabs.query({ windowId: w })).then(apply, () => {});
    else Promise.resolve(api.tabs.query({})).then(apply, () => {});
  } catch (_) { /* tabs 查詢失敗就不廣播 */ }
}
if (api.runtime && api.runtime.onConnect) {
  api.runtime.onConnect.addListener(p => {
    if (!p || p.name !== 'riffle-panel') return;
    p._rdWin = null;
    panelPorts.add(p);
    p.onMessage.addListener(m => {
      if (m && m.t === 'panel-hello') {
        p._rdWin = Number.isFinite(m.win) ? m.win : null;
        broadcastPanelState(p._rdWin);
      }
    });
    p.onDisconnect.addListener(() => {
      const w = p._rdWin;
      panelPorts.delete(p);
      broadcastPanelState(w);
    });
  });
}

// ---------------------------------------------------------- 抽屜 Ctrl+滾輪護欄
// 背景（機制細節見 drawer.js 的註解）：指標停在抽屜上時把該分頁的 zoom mode 暫時設成
// disabled——Ctrl+滾輪不再是「整頁縮放」手勢，事件照一般 wheel 路由送進巢狀 iframe
// （畫布＝相機遠近、面板其餘處＝介面縮放），主頁也不會被瀏覽器縮放；離開即還原。
// per-tab scope：不污染同網站其他分頁的固有縮放設定。
const drawerZoomTabs = new Set();        // 目前被我們扣在 disabled 的分頁（記憶體層）
const drawerZoomQueue = new Map();       // tabId → 進行中的切換 promise：同分頁操作序列化
const ZOOM_SNAP_KEY = 'drawerZoomSnap';  // storage.session 持久層：SW 被回收後仍能還原
async function zoomSnaps() {
  try { const o = await api.storage.session.get(ZOOM_SNAP_KEY); return o[ZOOM_SNAP_KEY] || {}; } catch (_) { return {}; }
}
async function zoomSnapsSave(all) {
  try { await api.storage.session.set({ [ZOOM_SNAP_KEY]: all }); } catch (_) {}
}
// 停用前先快照該分頁原本的 mode/scope、還原時回填——不硬寫 automatic/per-tab，
// 免得把使用者自己設的 manual 或 per-origin 縮放設定洗掉。也只還原「我們停用過」
// 的分頁（有快照或記憶體有記錄），沒追蹤過的一概不碰。setZoomSettings 失敗就往外
// 拋、不記錄，狀態才不會跟瀏覽器脫節。
async function applyDrawerZoomMode(tabId, off) {
  if (!api.tabs || typeof api.tabs.setZoomSettings !== 'function') return;
  const key = String(tabId);
  if (off) {
    if (drawerZoomTabs.has(tabId)) return;                       // 冪等：已停用
    let snap = { mode: 'automatic', scope: 'per-tab' };
    try {
      const s = await api.tabs.getZoomSettings(tabId);
      if (s && s.mode) snap = { mode: s.mode, scope: s.scope || 'per-tab' };
    } catch (_) {}
    await api.tabs.setZoomSettings(tabId, { mode: 'disabled', scope: 'per-tab' });
    drawerZoomTabs.add(tabId);
    const all = await zoomSnaps(); all[key] = snap; await zoomSnapsSave(all);
    testStats.drawerZoomOff++;
    return;
  }
  const all = await zoomSnaps();
  const snap = all[key] || null;
  if (!snap && !drawerZoomTabs.has(tabId)) return;               // 沒追蹤過：不動使用者設定
  try {
    await api.tabs.setZoomSettings(tabId, snap ? { mode: snap.mode, scope: snap.scope }
                                               : { mode: 'automatic', scope: 'per-tab' });
  } catch (_) { /* 分頁可能已關 */ }
  drawerZoomTabs.delete(tabId);
  if (snap) { delete all[key]; await zoomSnapsSave(all); }
  testStats.drawerZoomOn++;
}
function setDrawerZoomMode(tabId, off) {
  if (!(tabId > 0)) return Promise.resolve();
  // 同分頁先到先做：enter/leave、onUpdated、SW 喚醒掃描併發時也不會亂序
  const prev = drawerZoomQueue.get(tabId) || Promise.resolve();
  const job = prev.catch(() => {}).then(() => applyDrawerZoomMode(tabId, off));
  drawerZoomQueue.set(tabId, job);
  job.finally(() => { if (drawerZoomQueue.get(tabId) === job) drawerZoomQueue.delete(tabId); });
  return job;
}
// 還原保險：分頁轉址／關閉時若還扣著 disabled，走同一條佇列照快照還原，
// 免得那個分頁永遠不能縮放；沒追蹤過的分頁不會被誤清設定。
try {
  api.tabs.onRemoved.addListener(id => { setDrawerZoomMode(id, false).catch(() => {}); });
  api.tabs.onUpdated.addListener((id, ch) => {
    if (ch && ch.status === 'loading') setDrawerZoomMode(id, false).catch(() => {});
  });
} catch (_) { /* 沒有 tabs 事件就算了 */ }
// SW 剛醒（被回收過、記憶體層已丟）：session 快照若還在，代表那些分頁可能卡在
// disabled，逐一還原。殘留窗口：指標若一直停在抽屜上沒動，要到下一次 mouseenter
// 才重新停用——比「永遠卡住」好得多。
(async () => {
  try {
    const all = await zoomSnaps();
    for (const k of Object.keys(all)) await setDrawerZoomMode(Number(k), false);
  } catch (_) {}
})();

// ---------------------------------------------------------- 抽屜內容腳本補種
// manifest content_scripts 只管「擴充就緒之後才載入」的頁面——安裝／重載前就開著的
// 分頁永遠等不到 drawer.js（看起來像「抽屜只在某一個分頁生效」）。三個時機把三支
// 檔補進所有已開的 http/https 分頁：安裝／更新、瀏覽器啟動、autoHideDrawer 撥成 ON。
// drawer.js 的旗標是活體感知的：活實體跳過、死實體拆遺體重建——重複注入無害。
// 休眠分頁不喚醒（它恢復載入時 manifest 注入自然會補）；單分頁失敗不擋其他分頁。
const DRAWER_CS_FILES = ['defaults.js', 'i18n.js', 'drawer.js'];
async function injectDrawerScripts() {
  if (!api.scripting || typeof api.scripting.executeScript !== 'function') return;
  let on = false;                                    // 功能關著就不擴大注入面
  try { on = !!(await api.storage.local.get('autoHideDrawer')).autoHideDrawer; } catch (_) {}
  if (!on) return;
  let tabs = [];
  try {
    tabs = await api.tabs.query({ windowType: 'normal', url: ['http://*/*', 'https://*/*'] });
  } catch (_) { return; }
  const jobs = (tabs || [])
    .filter(t => t && t.id > 0 && !t.discarded)
    .map(t => Promise.resolve()
      .then(() => api.scripting.executeScript({ target: { tabId: t.id }, files: DRAWER_CS_FILES }))
      .then(() => { testStats.drawerInjects++; })    // 只算成功，失敗不灌水
      .catch(() => {}));                             // 特殊頁／無權限／分頁剛關：跳過
  await Promise.allSettled(jobs);                    // 並發跑，分頁多也不拖
}
try {
  if (api.runtime.onInstalled) api.runtime.onInstalled.addListener(() => { injectDrawerScripts().catch(() => {}); });
  if (api.runtime.onStartup) api.runtime.onStartup.addListener(() => { injectDrawerScripts().catch(() => {}); });
} catch (_) { /* 老引擎沒這些事件就算了 */ }

// 叫側欄捲到某張卡：側欄開著就即時轉（runtime message → sidepanel.js → postMessage 進
// iframe）；不在（正要開起來）就存 storage.session，sidepanel.js 開好讀出來自己捲。
function notePanelFocus(tabId) {
  try {
    if (api.storage && api.storage.session) {
      Promise.resolve(api.storage.session.set({ panelFocus: { tabId, at: Date.now() } })).catch(() => {});
    }
  } catch (_) { /* 存不了就算了 */ }
  try {
    Promise.resolve(api.runtime.sendMessage({ type: 'riffle-panel-focus', tabId })).catch(() => {});
  } catch (_) { /* 側欄沒開：靠 session 那條 */ }
}

if (api.runtime && api.runtime.onMessageExternal) {
  api.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !/^riffle-/.test(msg.type)) return;
    if (['riffle-click-tab', 'riffle-close-tab', 'riffle-restore-tab', 'riffle-panel-front', 'riffle-back-to-full'].indexOf(msg.type) < 0) return;
    // externally_connectable 先擋到只剩 127.0.0.1/localhost；這層再驗「設定埠上的頁面」
    // （同台機器別的本機服務不該能驅動切分頁／開側欄）。用 URL 解析不用 regex，
    // 杜絕 userinfo／奇特主機寫法的繞路；埠缺省視為 80（https 443），跟 server 對不上就拒。
    let su = null;
    try { su = new URL(String((sender && sender.url) || '')); } catch (_) { return; }
    if (!/^https?:$/.test(su.protocol)) return;
    if (!RIFFLE_HOSTS.has(su.hostname)) return;
    const sp = su.port || (su.protocol === 'https:' ? '443' : '80');
    if (sp !== String(port)) return;
    const tabId = Math.floor(Number(msg.tabId));
    // ---- 卡片 × 鈕家族（頁面直送；server 輪詢路徑是退路）----
    if (msg.type === 'riffle-close-tab') {
      if (Number.isFinite(tabId) && tabId > 0) {
        Promise.resolve(api.tabs.remove(tabId)).then(
          () => { testStats.closed++; sendResponse({ ok: true }); },
          () => sendResponse({ ok: true })   // tab 已不在＝目的已達，叫用端把它當成功清卡
        );
      } else sendResponse({ ok: false });
      return true;
    }
    if (msg.type === 'riffle-restore-tab') {
      restoreLastClosed().then(x => sendResponse({ ok: !!x })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (msg.type === 'riffle-panel-front') {
      // 側欄回報「現在停在這張卡」：Alt+Shift+R 從側欄出發時照它定位
      if (Number.isFinite(tabId) && tabId > 0 && api.storage && api.storage.session) {
        Promise.resolve(api.storage.session.set({ panelFront: { tabId, at: Date.now() } })).catch(() => {});
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'riffle-back-to-full') {
      testStats.backToFull++;
      goFullFromPanel(Number.isFinite(tabId) && tabId > 0 ? tabId : 0)
        .then(ok => sendResponse({ ok })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    testStats.extClicks++;
    // sidePanel.open 成不成功要等 promise，所以在同一個 try 裡先把 promise 抓住，
    // 回覆一律等它落地才送（外層 listener 回 true 保住 sendResponse 的通道）。
    try {
      const windowId = Math.floor(Number(msg.windowId));
      // 頁面沒帶 windowId（完整版工具列鈕、沒有預覽中的分頁）→ 開在「送出訊息的那個分頁」
      // 所在的視窗（sender.tab 由 Chrome 填，外部訊息偽造不了）
      const winId = Number.isFinite(windowId) ? windowId
        : (sender.tab && Number.isFinite(sender.tab.windowId) ? sender.tab.windowId : NaN);
      let panel = 'unavailable';
      let errMsg = '';
      let openP = null;
      // sidePanel.open 在任何 await 之前同步呼叫（使用者手勢過期就不給開）。
      // PWA 視窗沒有側欄：開的是「目標分頁所在的那個一般視窗」——windowId 由頁面從卡資料帶來。
      if (api.sidePanel && typeof api.sidePanel.open === 'function' && Number.isFinite(winId)) {
        if (panelPorts.size) {
          panel = 'already';                  // 側欄開著：不重開，只切分頁＋讓它捲
        } else {
          testStats.panelOpenCalls++;
          panel = 'failed';                   // 還沒落地前先當失敗，成功了再翻
          try {
            openP = Promise.resolve(api.sidePanel.open({ windowId: winId })).then(
              () => { testStats.panelOpenOk++; panel = 'opened'; },
              e => {
                testStats.panelOpenFail++; panel = 'failed';
                errMsg = String((e && e.message) || e || 'sidePanel.open rejected');
              });
          } catch (e) {                       // 同步丟錯：直接算失敗，別讓整個 listener 掛掉
            errMsg = String((e && e.message) || e || 'sidePanel.open threw');
          }
        }
      }
      // 切分頁＋把目標視窗帶到前景（不需手勢；最小化要先還原）
      if (Number.isFinite(tabId)) {
        Promise.resolve(api.tabs.update(tabId, { active: true })).catch(() => {});
        notePanelFocus(tabId);
      }
      if (Number.isFinite(winId)) {
        Promise.resolve(api.windows.get(winId)).then(w => {
          const props = { focused: true };
          if (w && w.state === 'minimized') props.state = 'normal';
          return api.windows.update(winId, props);
        }).catch(() => {});
      }
      const reply = () => {
        // 「只開側欄」（工具列鈕）沒帶分頁：側欄真的開了／已開才算成功，被拒絕就是失敗。
        // 沒有 sidePanel 能力（例如 Firefox）時退回看有沒有分頁可切。
        const ok = panel === 'opened' || panel === 'already'
          || (panel === 'unavailable' && Number.isFinite(tabId) && tabId > 0);
        const out = { ok, panel };
        if (!ok) out.error = errMsg || 'the side panel did not open';
        try { sendResponse(out); } catch (_) { /* 呼叫端已離線：忽略 */ }
      };
      (openP || Promise.resolve()).then(reply, reply);
      return true;
    } catch (e) {   // 理論上到不了，保險：一定回得出一個結果
      try { sendResponse({ ok: false, panel: 'failed', error: String((e && e.message) || e) }); } catch (_) { /* ignore */ }
      return true;
    }
  });
}

// 找到開著的 RiffleDesk（App 視窗或一般分頁）帶到前景；都沒有就開一個新的。
// 判別方式：網址主機是 127.0.0.1 / localhost / [::1]、埠＝settings 設的那個，
// 且 pathname 是 UI 本身（/ 或 /index.html）——/api/tabs 之類的裸 API 分頁不算。
const RIFFLE_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
function isRiffleTab(tb, wantPort) {
  let u;
  try { u = new URL(tb.url || ''); } catch (_) { return false; }
  if (u.protocol !== 'http:' || !RIFFLE_HOSTS.has(u.hostname)) return false;
  const tp = u.port || (u.protocol === 'https:' ? '443' : '80');   // URL.port 對預設埠會回空字串
  if (tp !== String(wantPort)) return false;
  return u.pathname === '/' || u.pathname === '/index.html';
}
async function focusWindow(tb) {
  // 最小化的視窗只帶 focused:true 不會還原（Windows/macOS）——檢查 state 才補 normal
  let w = null;
  try { w = await api.windows.get(tb.windowId); } catch (_) { /* 視窗沒了也照樣試 */ }
  const props = { focused: true };
  if (w && w.state === 'minimized') props.state = 'normal';
  await api.tabs.update(tb.id, { active: true });
  await api.windows.update(tb.windowId, props);
}
async function focusRiffleDesk(tabId) {
  const wantPort = port || DEFAULT_PORT;
  const tabs = await api.tabs.query({});
  let fallback = null;
  for (const tb of tabs) {
    if (!isRiffleTab(tb, wantPort)) continue;
    let u;
    try { u = new URL(tb.url); } catch (_) { if (!fallback) fallback = tb; continue; }
    if (u.searchParams.get('mode') === 'panel') { if (!fallback) fallback = tb; continue; }
    await focusWindow(tb);
    return tb;
  }
  if (fallback) {
    await focusWindow(fallback);
    return fallback;
  }
  const url = base() + '/' + (Number.isFinite(tabId) && tabId > 0 ? `?tabs=1&tabfocus=${tabId}` : '');
  const created = await api.tabs.create({ url });
  // 全域快捷鍵從別的 app 觸發時，新分頁可能開在沒焦點的視窗——補一次聚焦
  try { await api.windows.update(created.windowId, { focused: true }); } catch (_) { /* 補不成就算了 */ }
  return null;
}

// 收起某個視窗的側邊欄。Chrome 沒有穩定的 sidePanel.close：有的版本有 ═ 有就用，
// 沒有就用 setOptions(enabled:false) 抖一下收回（馬上 re-enable，不然工具列按鈕會失效）；
// Firefox 走 sidebarAction.close()。
async function closeSidePanel(windowId) {
  try {
    if (api.sidePanel && typeof api.sidePanel.close === 'function') {
      await api.sidePanel.close({ windowId });
      return;
    }
  } catch (_) { /* 往下退 */ }
  try {
    if (api.sidePanel && typeof api.sidePanel.setOptions === 'function' && Number.isFinite(windowId)) {
      await api.sidePanel.setOptions({ windowId, enabled: false });
      setTimeout(() => {
        Promise.resolve(api.sidePanel.setOptions({ windowId, enabled: true })).catch(() => {});
      }, 80);
      return;
    }
  } catch (_) { /* 往下退 */ }
  try {
    if (api.sidebarAction && typeof api.sidebarAction.close === 'function') await api.sidebarAction.close();
  } catch (_) { /* 關不掉就算了 */ }
}

// 側欄「回到完整畫面」（按鈕或 Alt+Shift+R 在側欄開著時）：
// ① 完整視窗若停在某張卡 → 卡片位置經 POST /api/tabs/focus（server 廣播給完整視窗）
// ② 聚焦既有 RiffleDesk 分頁／PWA（沒有就開 ?tabs=1&tabfocus=，開機直接進分頁模式定位）
// ③ 收起側欄
async function goFullFromPanel(tabId) {
  let winId = null;
  if (tabId > 0) {
    try { const tb = await api.tabs.get(tabId); winId = tb && tb.windowId; } catch (_) { winId = null; }
    // 定位：叫所有「非側欄」的 RiffleDesk 客戶端捲到這張卡（寫入 API：擴充身分直送）
    try {
      await fetch(base() + '/api/tabs/focus', {
        method: 'POST', headers: await headers(true), body: JSON.stringify({ tabId }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
    } catch (_) { /* server 暫時不在：至少視窗照樣聚焦 */ }
  }
  await focusRiffleDesk(tabId > 0 ? tabId : undefined);
  if (winId != null) await closeSidePanel(winId);
  else {
    // tabId 查不到（剛被關掉）→ 掃全部一般視窗把開著的那個側欄收起來
    try {
      const wins = await api.windows.getAll({ windowTypes: ['normal'] });
      for (const w of wins) if (panelPorts.size) { await closeSidePanel(w.id); }
    } catch (_) { /* 算了 */ }
  }
  return true;
}

// Alt+Shift+R；global:true（Windows/macOS 上仍要瀏覽器有焦點才有效，全系统層級只有
// ChromeOS 支援 global；chrome:// 頁面不會觸發）。不順手就到
// chrome://extensions/shortcuts 改。
// 側欄開著時焦點常在側欄裡——這時快捷鍵＝「回到完整畫面」：定位到側欄最後看的卡再收起側欄。
if (api.commands && api.commands.onCommand) {
  api.commands.onCommand.addListener(name => {
    if (name !== 'focus-riffledesk') return;
    (async () => {
      if (panelPorts.size) {
        let tabId = 0;
        try {
          const d = await Promise.resolve(api.storage.session.get({ panelFront: null }));
          if (d.panelFront) tabId = Math.floor(Number(d.panelFront.tabId)) || 0;
        } catch (_) { /* 沒紀錄就不定位 */ }
        await goFullFromPanel(tabId);
      } else {
        await focusRiffleDesk();
      }
    })().catch(() => {});
  });
}

// 側邊欄點了檔案卡：面板頁自己投影（POST /api/project）完後通知背景——
// 有完整視窗收到（delivered>0）就把它帶到前景；沒有就替面板在背景分頁開 /?open=<path>。
// 失敗要回 {ok:false}：側邊欄頁只在收到 ok:true 時才回 iframe 一個 open-ack，
// 否則 iframe 逾時會自己補開分頁（使用者至少看得到東西打開）。
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'riffle-panel-open') return;
  (async () => {
    let okDone = false;
    try {
      if (Number(msg.delivered) > 0) { await focusRiffleDesk(); okDone = true; }
      else if (typeof msg.path === 'string' && msg.path) {
        await api.tabs.create({ url: base() + '/?open=' + encodeURIComponent(msg.path) });
        okDone = true;
      }
    } catch (_) { /* okDone 留 false */ }
    sendResponse({ ok: okDone });
  })();
  return true;   // 非同步回應：通道留住
});
