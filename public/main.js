// glue: toolbar (chips/search), folder tree wiring, 3-pane layout state machine.
import { P, TOOLBAR_H, toolbarH, apiJson, clamp, themeNow, setTheme, fmtDate, refreshLook } from './util.js';
import { initCodeTheme } from './codetheme.js';
// 卡片視區（StackScene）用動態 import：three.js CDN 掛掉／WebGL 建不起來時要能改顯示說明卡，
// 所以不能在最上面靜態 import stack.js（一失敗整個 main.js 都不會跑，左欄與閱讀也一起死）
import { applyFont, buildFontMenu, savedFontId } from './fonts.js';
import { t, LANG, setLang, applyStatic } from './i18n.js';
applyStatic();
import { FolderTree } from './tree.js';
import { Reader } from './reader.js';
import { attachScrubber } from './scrub.js';
import { initLive } from './live.js';
import { createUndo, newGroup } from './undo.js';
import { initMirror } from './mirror.js';
import { initProject, initProjectSettings, handleProject, handlePile, clickPileToast, setHiddenForTest, restoreRecent, restorePiles, clickNotification, requestUrlOpen, diffFor, noteDiff } from './project.js';
import { TabsMode } from './tabs.js';
import { TAB_X_ZONE, TAB_AI_ZONE, tabBadgeAt } from './thumbs.js';
import { copyTabForAI } from './tabcopy.js';
import { loadSharedPrefs, sharedPrefsNow, postSharedPrefs } from './prefs.js';

const canvas = document.getElementById('gl');
const treeEl = document.getElementById('tree');
const splitter = document.getElementById('splitter');
const splitter2 = document.getElementById('splitter2');
const searchBox = document.getElementById('searchBox');
const chipsEl = document.getElementById('chips');
const statusEl = document.getElementById('status');

// ?mode=panel＝擴充側邊欄（Chrome sidePanel／Firefox sidebar）裡的精簡快翻模式：
// 只有搜尋框＋類型下拉＋卡堆：沒有左欄樹；閱讀面板平時不參與版面，點檔案卡＝就地開整欄閱讀覆層。
const PANEL = new URLSearchParams(location.search).get('mode') === 'panel';
if (PANEL) document.body.classList.add('panel-mode');
// 共享 prefs（server 那份）開機先抓：卡堆建構（讀「我的視角」）與下面的側欄縮放都要用它。
// 抓不到就當空物件：各 surface 退回自己的 localStorage，行為跟以前一樣。
await loadSharedPrefs();
// ---- 側邊欄介面縮放（Chrome 側欄沒有瀏覽器縮放）：Ctrl+滾輪／Ctrl+±／Ctrl+0 ----
// 只縮 DOM 介面：body 掛 --panelZoom，CSS 對 #gl 以外的頂層元素套 zoom——卡堆畫布本身的
// raycast 座標與貼圖解析度完全不動（畫布頂緣用 calc 跟著頂列視覺高度走）。畫布上的
// Ctrl+滾輪走 stack.js 自己的相機遠近，不進這裡；完整版整個不攔（瀏覽器原生縮放）。
const PANEL_ZOOM_MIN = 0.7, PANEL_ZOOM_MAX = 1.6;
const PANEL_ZOOM_KEY = 'rd.panelZoom';
let panelZoom = 1;
let panelZoomPostT = null;
function setPanelZoom(z) {
  panelZoom = Math.round(Math.min(PANEL_ZOOM_MAX, Math.max(PANEL_ZOOM_MIN, z)) * 100) / 100;
  try { localStorage.setItem(PANEL_ZOOM_KEY, String(panelZoom)); } catch (_) { /* 沒儲存空間就算了 */ }
  // 共享寫回節流到最後一格落定：Ctrl+滾輪連發時 server 端每筆都是同步落盤，不節流會狂寫磁碟
  clearTimeout(panelZoomPostT);
  panelZoomPostT = setTimeout(() => postSharedPrefs({ panelZoom }), 800);
  document.body.style.setProperty('--panelZoom', String(panelZoom));
  dispatchEvent(new Event('resize'));   // 頂列視覺高度變了：卡堆畫布的 top／高度全部重算到位
}
let hasLocalPanelZoom = false;
if (PANEL) {
  try {
    const raw = localStorage.getItem(PANEL_ZOOM_KEY);
    const z = parseFloat(raw);
    if (raw !== null && Number.isFinite(z) && z >= PANEL_ZOOM_MIN && z <= PANEL_ZOOM_MAX) { panelZoom = z; hasLocalPanelZoom = true; }
  } catch (_) { /* 壞資料就回到 1 */ }
  if (!hasLocalPanelZoom) {
    // 抽屜的 localStorage 被按站台切開（永遠空）：從 server 共享 prefs 撿回使用者設過的縮放
    // （以「本機沒存過」判斷，不以 ===1：使用者明確存過 1.0 不該被他處的共享值蓋掉）
    const sh = Number(sharedPrefsNow().panelZoom);
    if (Number.isFinite(sh) && sh >= PANEL_ZOOM_MIN && sh <= PANEL_ZOOM_MAX) panelZoom = Math.round(sh * 100) / 100;
  }
  if (panelZoom !== 1) document.body.style.setProperty('--panelZoom', String(panelZoom));
  // 卡堆畫布上＝相機遠近（stack.js 的 wheel handler）；其餘地方（頂列、閱讀覆層…）＝介面縮放
  addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    const tgt = e.target;
    if (tgt && (tgt === canvas || (tgt.closest && tgt.closest('#gl')))) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    setPanelZoom(panelZoom * Math.exp(-e.deltaY * unit * 0.002));
  }, { passive: false });
}
// 拖分隔線期間 body 掛 .dragging：禁止選取、iframe 不吃滑鼠、游標全域 col-resize
let dragging = false;
// 左欄收合狀態（宣告在 setBodyMode 之前：它在這裡就要被讀到）
let treeCollapsed = false;
// body 只放「模式 + 兩個旗標」三種 class；用 classList 逐項換，不動 body 上其他 class
const BODY_MODES = ['twocol', 'threecol', 'wide', 'full'];
function setBodyMode(m) {
  for (const x of BODY_MODES) document.body.classList.toggle('mode-' + x, x === m);
  document.body.classList.toggle('tree-collapsed', treeCollapsed);
  document.body.classList.toggle('dragging', dragging);
}

// ---------------------------------------------------------------- chips
const CHIP_DEFS = [
  { id: 'md', label: '.md', exts: ['.md', '.markdown'] },
  { id: 'txt', label: '.txt', exts: ['.txt', '.log'] },
  { id: 'json', label: '.json', exts: ['.json'] },
  { id: 'html', label: '.html', exts: ['.html', '.htm'] },
  { id: 'table', label: t('chipTable'), exts: ['.csv', '.tsv', '.xlsx', '.xls'] },
  { id: 'slides', label: '.pptx', exts: ['.pptx'] },
  { id: 'code', label: t('chipCode'), exts: ['.py', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.less', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.java', '.go', '.rs', '.rb', '.php', '.sh', '.bash', '.bat', '.ps1', '.sql', '.lua', '.vue', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg'] },
  { id: 'image', label: t('chipImage'), exts: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'] },
  { id: 'video', label: t('chipVideo'), exts: ['.mp4', '.m4v', '.webm', '.ogv', '.mov'] },
  { id: 'readable', label: t('chipReadable'), special: 'readable' },
  { id: 'all', label: 'All', special: 'all' }
];
// 全新安裝（localStorage 還沒存過）停在「全部可讀」：第一次打開就看得到所有
// 能看的檔；使用者動過 chips 之後才照 localStorage 的選取沿用。
let chipsOn = ['readable'];
try {
  const saved = JSON.parse(localStorage.getItem('floderChips2') || 'null');
  if (Array.isArray(saved) && saved.length) chipsOn = saved;
} catch (_) {}

function extsParam() {
  if (chipsOn.includes('all')) return 'all';
  if (chipsOn.includes('readable')) return 'readable';
  const set = new Set();
  for (const id of chipsOn) {
    const def = CHIP_DEFS.find(d => d.id === id);
    if (def && def.exts) def.exts.forEach(e => set.add(e));
  }
  return [...set].join(',');
}

// chips 選取改了之後的共同動作：存檔、重畫 chips/下拉、重載卡堆與資料夾數字
function applyChips(next) {
  const same = next.length === chipsOn.length && next.every(id => chipsOn.includes(id));
  if (same) return;
  chipsOn = next;
  try { localStorage.setItem('floderChips2', JSON.stringify(chipsOn)); } catch (_) {}
  buildChips();
  // 卡堆先換（使用者在看的是這個），資料夾數字在背景原地更新，不擋畫面
  if (lockedFolder) loadFolder(lockedFolder);
  else if (pileState) applyPile();
  else if (convoState) loadPseudo();          // 偽資料夾（AI 對話區）也照 chips 重新篩
  refreshConvoCounts();
  tree.setExts(effectiveExts());
}

function buildChips() {
  chipsEl.innerHTML = '';
  for (const def of CHIP_DEFS) {
    const b = document.createElement('button');
    b.className = 'chip' + (chipsOn.includes(def.id) ? ' on' : '');
    b.textContent = def.label;
    b.dataset.chip = def.id;
    b.addEventListener('click', async (e) => {
      // 單選語意：一般點擊只亮這一個（預設 .md）；按住 Ctrl / Shift 點＝多選加減
      const next = e.ctrlKey || e.shiftKey || e.metaKey
        ? (chipsOn.includes(def.id)
            ? (chipsOn.length > 1 ? chipsOn.filter(id => id !== def.id) : chipsOn)  // 至少保留一個
            : [...chipsOn, def.id])
        : [def.id];
      applyChips(next);
    });
    chipsEl.appendChild(b);
  }
  buildChipSel();
}

// panel 模式的「類型 ▾」下拉（窄欄放不下九顆 chips）：單選語意，選完即生效。
// 與 chips 共享 chipsOn 狀態；分頁模式下整個停用（CSS 已藏掉，這裡再 disable 一層給驗收用）
const chipSel = document.getElementById('chipSel');
function buildChipSel() {
  if (!chipSel) return;
  chipSel.innerHTML = '';
  for (const def of CHIP_DEFS) {
    const o = document.createElement('option');
    o.value = def.id;
    o.textContent = (def.id === 'all' ? t('chipTypeAll') : def.label);
    chipSel.appendChild(o);
  }
  // 多選（Ctrl 點的）在下拉沒有對應單一值 → 顯示第一個選中的
  chipSel.value = chipsOn[0] || 'all';
}
if (chipSel) {
  chipSel.title = t('chipTypeDrop');
  chipSel.addEventListener('change', () => applyChips([chipSel.value]));
}

// ---------------------------------------------------------------- layout
// 3D 卡堆是賣點：沒有 WebGL（或 three.js 載不進來）就顯示一張說明卡，不做 2D 替代卡片格。
// 左欄樹與閱讀面板照常可用——它們不碰 WebGL。
async function createCardView() {
  try {
    const { StackScene } = await import('./stack.js');
    return new StackScene(canvas);
  } catch (err) {
    console.warn('3D card stack unavailable:', err);
  }
  const { No3DView } = await import('./no3d.js');
  return new No3DView();
}
// 建得起來也可能跑到一半失去 context（顯卡驅動重置／GPU hang）：WebGL context 掉掉時
// 用同一張說明卡蓋住卡片欄，樹和閱讀區照用，重新載入頁面就回到 3D。
function placeGlNotice() {
  const el = document.getElementById('glnotice');
  if (!el || !stack.viewCss) return;
  el.style.left = Math.round(stack.viewCss.x) + 'px';
  el.style.width = Math.round(stack.viewCss.w) + 'px';
}
function watchContextLoss() {
  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault();                       // 允許之後 restored；這裡不重建，直接請他重載
    if (document.body.classList.contains('gl-lost')) return;
    document.body.classList.add('gl-lost');
    const overlay = document.createElement('div');
    overlay.id = 'glnotice';
    document.body.appendChild(overlay);
    placeGlNotice();
    // 說明卡跟開機偵測失敗時是同一張；用到才載 no3d.js（它不 import three.js）
    import('./no3d.js').then(({ buildNotice }) => {
      overlay.appendChild(buildNotice({ reload: true }));
      placeGlNotice();
    }, () => {});
  });
}
const stack = await createCardView();
const no3d = !!stack.no3d;
// 側邊欄精簡模式（400px 窄欄）：焦點卡幾乎填滿欄寬，卡內字才讀得到
if (!no3d && PANEL && typeof stack.setCompactFit === 'function') stack.setCompactFit(true);
// 視角共享：存「我的視角」時連 server 共享 prefs 一起寫；抽屜 iframe 的 localStorage
// 被站台切開看不到這裡，共享那份（開機已被 loadSharedPrefs 鋪進 __rifflePrefsBoot）是它的真身
if (!no3d && typeof stack.onPersistFav !== 'undefined') stack.onPersistFav = v => postSharedPrefs({ favView: v });
// 開機落點（僅面板系：側邊欄／抽屜）：沒存過「我的視角」就用各 surface 共用的最後視角，
// 再沒有才回預設視角。完整 App 維持「沒存過＝預設視角」的既有行為不動。
if (!no3d && PANEL && !stack.favView()) {
  const lv = sharedPrefsNow().lastView;
  if (lv && Number.isFinite(lv.yaw) && Number.isFinite(lv.pitch) && Number.isFinite(lv.zoom)) {
    stack.orbit.yaw = clamp(lv.yaw, -30, 30);
    stack.orbit.pitch = clamp(lv.pitch, 22, 65);
    stack.orbit.zoom = clamp(lv.zoom, 0.7, 1.8);
    stack.poke();
  }
}
if (no3d) {
  document.body.classList.add('no3d-mode');   // CSS 藏掉 3D 專屬的視角按鈕列；畫布自己藏
  canvas.style.display = 'none';
} else {
  watchContextLoss();
}
const reader = new Reader();
// 左欄預設寬：0.15（約 1/7）——樹只要看得到資料夾名就好，空間留給 3D 卡堆。
// 拖過的值存 localStorage，之後以拖的為準；雙擊分隔線回到這個預設。
let tUser = 0.15;
try { const s = parseFloat(localStorage.getItem('floderTreeFrac')); if (s > 0.1 && s < 0.6) tUser = s; } catch (_) {}
// 三欄右區內的卡堆佔比（splitter2 拖動值，存 localStorage 沿用；↺ 回三欄時還原）
let vUser = 0.5;
try { const s = parseFloat(localStorage.getItem('floderViewFrac')); if (s > 0.05 && s < 0.95) vUser = s; } catch (_) {}

// 左欄可以整條收起來（工具列 ◧）：收起來時樹寬 0，卡堆吃回整個寬度；展開回原本的 tUser
const treeFrac = () => (treeCollapsed ? 0 : tUser);
try { treeCollapsed = localStorage.getItem('floderTreeCollapsed') === '1'; } catch (_) {}

const MODES = {
  twocol: () => ({ tree: treeFrac(), view: 1 - treeFrac(), reader: 0 }),
  threecol: () => ({ tree: treeFrac(), view: (1 - treeFrac()) * vUser, reader: (1 - treeFrac()) * (1 - vUser) }),
  wide: () => ({ tree: treeFrac(), view: 0, reader: 1 - treeFrac() }),
  full: () => ({ tree: 0, view: 0, reader: 1 })
};
let mode = 'twocol';
let fracs = MODES.twocol();

function readerRectFor(targetMode) {
  const f = MODES[targetMode]();
  const W = innerWidth;
  return { x: (f.tree + f.view) * W + 6, y: 54, w: f.reader * W - 18, h: innerHeight - 54 - 16 };
}

function applyFracs(f) {
  // 側邊欄模式永遠滿寬卡堆：樹與閱讀欄不參與版面（CSS 也藏了）
  if (PANEL) f = { tree: 0, view: 1, reader: 0 };
  const W = innerWidth;
  treeEl.style.width = Math.round(f.tree * W) + 'px';
  treeEl.style.display = f.tree < 0.005 ? 'none' : '';
  splitter.style.left = Math.round(f.tree * W) + 'px';
  splitter2.style.left = Math.round((f.tree + f.view) * W) + 'px';
  const vx = f.tree * W, vw = f.view * W;
  stack.setViewportNow(vx, vw);
  placeGlNotice();
  if (f.reader > 0.004) {
    reader.setOpen(true);
    reader.el.style.left = Math.round((f.tree + f.view) * W + 6) + 'px';
    reader.el.style.width = Math.round(f.reader * W - 18) + 'px';
  } else if (!reader.el.classList.contains('show')) {
    reader.setOpen(false);
  }
}

// 回到「沒有閱讀欄」的版面（卡堆欄變寬、視野也空出來了）：相機一律落到使用者
// 存的「★ 我的視角」，沒存過就回預設視角——不論他剛剛是不是自己轉過相機。
// 一律用同一條規則，落點才一致（不會有時停在他亂轉的角度）。視角換法見 settleView。
function settleViewFor(m) {
  if (MODES[m]().reader > 0.004) return;   // 還有閱讀欄的版面：維持目前視角
  if (!stack.goFavView()) stack.resetView();
}

// 版面切換一律立即到位，不跑欄寬動畫：開關閱讀欄時右半邊欄寬漸變會讓整個
// 卡堆看起來「滑向右邊」，一格一格補間像卡頓。卡堆的 viewport＋相機取景在
// stack.setViewportNow 裡同一步驟重算到位（不閃白、不留殘影）。
function setMode(next) {
  if (next === mode) return;
  mode = next;
  setBodyMode(next);
  updateSizeBtn();
  fracs = MODES[next]();
  applyFracs(fracs);
  // 版面先定格（setViewportNow 會把取景當場算好），再換視角：orbit 的變化由此後
  // 每幀既有的阻尼插值（fitCur → fitTarget）平滑過去，不是瞬跳。
  settleViewFor(next);
  // 面板抵達最終位置後重算飛行終點（飛行中的卡精準落進閱讀面板）
  if (stack.extracted) stack.restage(readerRectFor(mode));
}

addEventListener('resize', () => {
  applyFracs(fracs);
  // 視窗大小變了＝卡堆欄寬也變了：沒有閱讀欄的版面一樣落回我的視角
  settleViewFor(mode);
  if (stack.extracted) stack.restage(readerRectFor(mode));
});

// ------------------------------------------------------------ splitter drags
// 兩條都是即時拖動：pointermove 直接寫 fracs + applyFracs（stack.setViewportNow 每幀重取景），
// 不走 setMode 的 300ms 動畫。最小欄寬 ~200px；比例存 localStorage；雙擊回預設。
const MIN_COL_PX = 200;

function trackSplitter(el, { activeWhen, onMove, onUp, onDbl }) {
  el.addEventListener('pointerdown', e => {
    if (!activeWhen()) return;
    e.preventDefault();
    dragging = true;
    el.classList.add('drag');
    document.body.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
    const move = ev => onMove(ev);
    const up = () => {
      dragging = false;
      el.classList.remove('drag');
      document.body.classList.remove('dragging');
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      onUp && onUp();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });
  el.addEventListener('dblclick', () => { if (activeWhen()) onDbl(); });
}

function saveFrac(key, v) { try { localStorage.setItem(key, String(v)); } catch (_) {} }

// 左欄收合鈕（工具列 ◧）：按一下收起樹、卡堆吃回全部寬度；再按一下展開。
// applyFracs 在樹寬 0 時本來就把整棵樹 display:none；再補 inert＋aria-hidden，
// 讓輔助技術與焦點都確定不會停在藏起來的列上。
function applyTreeVisibility() {
  treeEl.inert = treeCollapsed;
  treeEl.setAttribute('aria-hidden', treeCollapsed ? 'true' : 'false');
  document.body.classList.toggle('tree-collapsed', treeCollapsed);
}
function setTreeCollapsed(v) {
  if (v === treeCollapsed) { syncTreeBtn(); return; }   // 狀態沒變也重刷一次 UI，修得回不同步
  treeCollapsed = v;
  saveFrac('floderTreeCollapsed', v ? '1' : '0');
  syncTreeBtn();
  fracs = MODES[mode]();
  applyFracs(fracs);
  settleViewFor(mode);
  if (stack.extracted) stack.restage(readerRectFor(mode));
}
let btnTreeEl = null;
function syncTreeBtn() {
  applyTreeVisibility();
  const btn = btnTreeEl || (btnTreeEl = document.getElementById('btnTree'));
  if (!btn) return;
  btn.textContent = treeCollapsed ? '▢' : '◧';
  btn.classList.toggle('on', treeCollapsed);
  btn.setAttribute('aria-expanded', treeCollapsed ? 'false' : 'true');
  const label = t(treeCollapsed ? 'treeShowTitle' : 'treeHideTitle');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

// 拖到最左邊＝收合左欄。門檻帶遲滯（收在 12px 內、展要拖過 32px），游標在邊界抖才不會來回跳。
const COLLAPSE_AT_PX = 12, EXPAND_AT_PX = 32;

// splitter1：樹｜右區（full 滿版閱讀以外都能拖；三欄／wide 也調樹寬）
trackSplitter(splitter, {
  activeWhen: () => mode !== 'full',
  onMove: ev => {
    // 收合時保留 tUser，展開就回到原本寬度
    const collapse = treeCollapsed ? ev.clientX <= EXPAND_AT_PX : ev.clientX <= COLLAPSE_AT_PX;
    if (collapse !== treeCollapsed) { treeCollapsed = collapse; syncTreeBtn(); }
    if (!treeCollapsed) {
      tUser = clamp(ev.clientX / innerWidth, Math.max(MIN_COL_PX / innerWidth, 0.12), 0.5);
      saveFrac('floderTreeFrac', tUser);
    }
    fracs = MODES[mode]();
    applyFracs(fracs);
  },
  // 拖完（含拖到最左＝收合左欄）：卡堆欄變了寬，落點一樣回到「我的視角」／預設視角
  onUp: () => {
    saveFrac('floderTreeFrac', tUser);
    settleViewFor(mode);
    if (stack.extracted) stack.restage(readerRectFor(mode));
  },
  onDbl: () => {
    treeCollapsed = false;
    syncTreeBtn();
    tUser = 0.15;
    saveFrac('floderTreeFrac', tUser);
    fracs = MODES[mode]();
    applyFracs(fracs);
    settleViewFor(mode);
    if (stack.extracted) stack.restage(readerRectFor(mode));
  }
});

// splitter2：卡堆｜閱讀面板（三欄；閱讀面板 ≥ 右區 90% → 2/3 模式；拖回 >20% 恢復三欄）
trackSplitter(splitter2, {
  activeWhen: () => mode === 'threecol',   // wide 時 splitter2 已隱藏；snap 後的追蹤靠 window 層 listener
  onMove: ev => {
    const W = innerWidth;
    const treePx = treeFrac() * W;
    const rightPx = (1 - treeFrac()) * W;
    const minF = MIN_COL_PX / rightPx;          // 卡堆欄最小 ~200px
    // 已 snap 進 wide：往右拖回（想留 >20% 給卡堆）就恢復三欄（hysteresis，避免在 90% 附近跳動）
    if (mode === 'wide') {
      const wantView = (ev.clientX - treePx) / rightPx;
      if (wantView > 0.2 && ev.clientX <= W - MIN_COL_PX) {
        mode = 'threecol';
        setBodyMode('threecol');
      } else {
        fracs = MODES.wide();
        applyFracs(fracs);
        return;
      }
    }
    const viewPx = clamp(ev.clientX - treePx, MIN_COL_PX, rightPx - MIN_COL_PX);
    // 閱讀面板 ≥ 右區 90% → 視同 2/3 模式（檔案堆隱藏）
    if ((rightPx - viewPx) >= rightPx * 0.9) {
      mode = 'wide';
      setBodyMode('wide');
      fracs = MODES.wide();
      applyFracs(fracs);
      return;
    }
    vUser = clamp(viewPx / rightPx, minF, 1 - minF);
    saveFrac('floderViewFrac', vUser);
    fracs = MODES.threecol();
    applyFracs(fracs);
  },
  onUp: () => {
    saveFrac('floderViewFrac', vUser);
    if (stack.extracted) stack.restage(readerRectFor(mode));
  },
  onDbl: () => {
    if (mode !== 'threecol') return;
    vUser = 0.5;
    saveFrac('floderViewFrac', vUser);
    fracs = MODES.threecol();
    applyFracs(fracs);
    if (stack.extracted) stack.restage(readerRectFor(mode));
  }
});

// ---------------------------------------------------------------- folder data
let lockedFolder = null;
const dirCache = new Map();   // path|exts -> files

function effectiveExts() { return searchBroad ? 'all' : extsParam(); }   // 搜尋期間放寬 chips
async function fetchFolder(path, off = 0) {
  const key = path + '|' + effectiveExts() + '|' + stack.sortMode + '|' + off;
  if (dirCache.has(key)) return dirCache.get(key);
  const data = await apiJson('/api/list?path=' + encodeURIComponent(path) +
    '&exts=' + encodeURIComponent(effectiveExts()) +
    '&sort=' + encodeURIComponent(stack.sortMode || 'new') +
    (off ? '&off=' + off : ''));
  // 投影帶來的 +N −M（project.js 的 diffByPath）貼到檔案物件上，卡面標題旁才畫得出來
  for (const f of data.files || []) { const d = diffFor(f.path); if (d) f.diff = d; }
  if (dirCache.size > 30) dirCache.delete(dirCache.keys().next().value);
  dirCache.set(key, data);
  return data;
}

async function loadFolder(path) {
  statusEl.textContent = t('reading');
  try {
    const data = await fetchFolder(path, 0);
    // 慢回應競態：fetch 期間使用者已切進分頁模式（點分頁鈕／Alt+2／「分頁符合」條）——
    // 這包舊的資料夾內容落地會把分頁卡堆整堆蓋掉，直接丟掉。
    if (tabsMode.active) return;
    // 大資料夾只回第一頁（~300 張＋總數）：滑近尾端時由 stack 續頁
    const more = data.hasMore ? {
      total: data.total, hasMore: data.hasMore,
      fetchMore: () => fetchFolder(path, stack.files.length)
    } : null;
    stack.setFolder(path, data.files, more);
    showPath(path);
    statusEl.textContent = t('fileCount', { path: shortPath(path), n: stack.total != null ? stack.total : data.files.length });
  } catch (err) {
    statusEl.textContent = t('readFail', { msg: err.message });
  }
}
function shortPath(p) {
  return p.length > 60 ? '…' + p.slice(-58) : p;
}

const tree = new FolderTree(treeEl, {
  // hover 預覽（sel＝樹的唯一選取模型）：真資料夾直接載；偽資料夾（對話/今天/最近7天）走 previewCrow。
  // 都不動「鎖定」——離開左欄時樹會再送一次 lockedSel 讓畫面還原
  onPreview: sel => {
    if (tabsMode.active) return;   // 分頁模式中 hover 樹不動卡堆；點下（onLock）才離開分頁模式
    previewCrowCancel();
    if (sel.kind === 'crow') {
      if (sel.meta.pile) return openPile(sel.meta.id, tree.selRow(sel));
      return previewCrow(sel.meta);
    }
    return loadFolder(sel.path);
  },
  // 真正鎖定發生時（滑鼠點、方向鍵 debounce 到點）取消任何還在等的方向鍵載入
  onLock: sel => {
    clearTimeout(navTimer); navTimer = null;
    previewCrowCancel(); tabsMode.drop(); exitPseudo(false); dropPile();
    // wide／full 時卡堆是藏起來的：點樹卻不換版面＝畫面零回饋，看起來像卡住。
    // 點樹就是要逛檔案 → 回三欄讓點到的資料夾的卡真的露出來。
    // （投影走 tree.lock 也會經過這裡，但 projectOpen 緊接著會 setMode('wide') 蓋回來）
    if (!PANEL && (mode === 'wide' || mode === 'full')) setMode('threecol');
    lockedFolder = sel.path;
    return loadFolder(sel.path);
  },
  onPinChanged: async () => { await tree.boot(); buildConvoSections(); }
});
tree.exts = extsParam();

// ====================== AI 對話區：「AI 最近給我的」＋「對話」列表 ======================
// 左樹最上面（快速存取之上）的兩個偽資料夾區塊。來源是本機 AI agent（Claude/Codex）
// 自己的對話記錄，伺服器 /api/convos 系列端點回來。點下去＝把那份清單載進卡堆。
let convoState = null;        // 目前卡堆在看的偽資料夾：{kind:'recent'|'changed',hours} | {kind:'convo',id,title}
let pileState = null;         // 目前卡堆在看的一疊：{id, title, files}（AI 挑好的清單）
let pileReturn = null;        // 開疊之前的資料夾：✕／Esc 回那裡
// 開疊時順便自動開的閱讀欄：{path, mode, from}。使用者自己換檔／換版面就清掉，
// 離開疊時只收「還停在這個自動開的檔、版面也沒被動過」的那種。
let pileAutoReader = null;
let convoWrap = null;         // #tree 裡的容器 div
let convoGen = 0;             // 非同步回填數字的世代計數（重建後舊回應丟掉）
let convoShowAuto = (() => { try { return localStorage.getItem('riffleConvoAuto') === '1'; } catch (_) { return false; } })();
let convoShowN = 15;          // 「更早」群組先列 15 則，「顯示更多」全開
// 對話區兩個摺疊群組的開關狀態（記住）：24 小時內預設展開；更早預設收起
let convo24Open = (() => { try { return localStorage.getItem('riffleConvo24Open') !== '0'; } catch (_) { return true; } })();
let convoOldOpen = (() => { try { return localStorage.getItem('riffleConvoOldOpen') === '1'; } catch (_) { return false; } })();
// 「更早」的全歷史清單：展開時才叫伺服器掃（第一次要解析所有 transcript，較久），60 秒內重用
let convoDeepCache = { t: 0, data: null };
let convoRowsMeta = [];       // [{row, cnt, id, lastN}]
let recentRowsMeta = [];      // [{row, cnt, hours, lastN}]
let changedRowsMeta = [];     // [{row, cnt, changedHours, lastN}] — —「最近改動」列，索引沒跑會整列藏起來
// 對話標籤：後端 agent id → 給人看的工具名（新增解析器時同步 convos.js KIND_LABEL）
const AGENT_LABEL = {
  claude: 'Claude', codex: 'Codex', gemini: 'Gemini',
  cline: 'Cline', roo: 'Roo Code', kilo: 'Kilo Code', pi: 'Pi', grok: 'Grok Build'
};
const agentTag = a => AGENT_LABEL[a] || a;
const convoFilesCache = new Map();  // convoId -> 完整檔案清單（未按 chips 過濾）
let convoListCache = { t: 0, data: null };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// 跟伺服器 parseExts 同一套語意的 client 版（token 化 chips → 檔案收不收）
function chipsAcceptFile(f) {
  if (searchBroad) return true;
  if (chipsOn.includes('all')) return true;
  if (chipsOn.includes('readable')) return f.kind != null;
  const set = new Set();
  for (const id of chipsOn) {
    const def = CHIP_DEFS.find(d => d.id === id);
    if (def && def.exts) def.exts.forEach(e => set.add(e));
  }
  return set.has(f.ext);
}

function fmtConvDate(ms) {
  if (!ms) return '';
  const s = fmtDate(ms);
  return String(s).slice(0, 4) === String(new Date().getFullYear()) ? s.slice(5) : s;
}

function makeCrow({ icon, label, date, tag }) {
  const row = el('div', 'trow crow');
  row.appendChild(el('span', 'tw leaf', '▶'));
  row.appendChild(el('span', 'fico', icon));
  if (date) row.appendChild(el('span', 'cdate', date));
  row.appendChild(el('span', 'nm', label));
  if (tag) row.appendChild(el('span', 'atag', tag));
  const cnt = el('span', 'cnt');
  row.appendChild(cnt);
  return { row, cnt };
}

function applyCrowHide(meta) {
  const hide = tree.hideEmpty && meta.lastN === 0;
  meta.row.style.display = hide ? 'none' : '';
}
function applyCrowHides() { for (const m of [...recentRowsMeta, ...changedRowsMeta, ...convoRowsMeta]) applyCrowHide(m); }
// 樹最上面的「只看有檔案的資料夾」開關切換時，數字沒變也要重判一次藏不藏
treeEl.addEventListener('change', e => { if (e.target.closest('#treeBar')) setTimeout(applyCrowHides, 0); });

async function fetchConvoList(force) {
  if (!force && convoListCache.data && Date.now() - convoListCache.t < 10000) return convoListCache.data;
  try {
    const d = await apiJson('/api/convos?days=30');
    convoListCache = { t: Date.now(), data: d.convos || [] };
  } catch (_) { convoListCache.data = convoListCache.data || []; }
  return convoListCache.data;
}

// 全歷史深掃（days=3650）：只有使用者展開「更早」時才叫，絕不擋開啟速度
async function fetchConvoListDeep() {
  if (convoDeepCache.data && Date.now() - convoDeepCache.t < 60000) return convoDeepCache.data;
  try {
    const d = await apiJson('/api/convos?days=3650');
    convoDeepCache = { t: Date.now(), data: d.convos || [] };
  } catch (_) { convoDeepCache.data = convoDeepCache.data || []; }
  return convoDeepCache.data;
}

async function fetchConvoFiles(id) {
  if (convoFilesCache.has(id)) return convoFilesCache.get(id);
  const d = await apiJson('/api/convo?id=' + encodeURIComponent(id));
  const files = d.files || [];
  if (convoFilesCache.size > 40) convoFilesCache.delete(convoFilesCache.keys().next().value);
  convoFilesCache.set(id, files);
  return files;
}

async function buildConvoSections() {
  const gen = ++convoGen;
  tree.crowRows.clear();                    // 舊列要整批換掉，hover 登記失了根
  const wrap = el('div');
  wrap.id = 'convos';
  wrap.appendChild(el('div', 'sec', t('secRecent')));
  const todayM = makeCrow({ icon: '🕘', label: t('recToday') });
  const weekM = makeCrow({ icon: '🕘', label: t('recWeek') });
  todayM.hours = 24; weekM.hours = 168;
  todayM.row.addEventListener('click', () => openRecent(24, todayM.row));
  weekM.row.addEventListener('click', () => openRecent(168, weekM.row));
  tree.attachCrow(todayM.row, { hours: 24 });    // hover 預覽跟資料夾同一套
  tree.attachCrow(weekM.row, { hours: 168 });
  wrap.appendChild(todayM.row); wrap.appendChild(weekM.row);
  recentRowsMeta = [todayM, weekM];
  // 索引檔 mtime 查的「最近改動」：跟上面確定是 AI 寫的分開，來源不可考——扣掉 AI 寫的檔才顯示
  const changedM = makeCrow({ icon: '📝', label: t('recChanged') });
  changedM.changedHours = 168;
  changedM.row.title = t('changedTip');
  changedM.row.addEventListener('click', () => openChanged(168, changedM.row));
  tree.attachCrow(changedM.row, { changedHours: 168 });
  wrap.appendChild(changedM.row);
  changedRowsMeta = [changedM];
  wrap.appendChild(el('div', 'sec', t('secConvos')));
  const listEl = el('div');
  wrap.appendChild(listEl);
  if (convoWrap) convoWrap.remove();
  convoWrap = wrap;
  treeEl.insertBefore(wrap, (tree.secQuick && tree.secQuick.isConnected) ? tree.secQuick : treeEl.firstChild);

  const all = await fetchConvoList();
  if (gen !== convoGen || !convoWrap.isConnected) return;
  convoRenderedFP = convoFingerprint(all);   // live.js 的 convos 事件靠這個判斷要不要重建
  listEl.innerHTML = '';
  convoRowsMeta = [];
  const addConvoRow = (c) => {
    const m = makeCrow({
      icon: '💬', date: fmtConvDate(c.updated),
      label: c.title || t('convoNoTitle'),
      tag: agentTag(c.agent)
    });
    m.id = c.id; m.lastN = c.fileCount;
    if (c.auto) m.row.classList.add('auto');
    m.cnt.textContent = String(c.fileCount);
    m.cnt.classList.toggle('zero', c.fileCount === 0);
    m.row.title = c.project || c.title || '';
    m.row.addEventListener('click', () => openConvo(c, m.row));
    tree.attachCrow(m.row, { id: c.id, title: c.title });   // hover 預覽跟資料夾同一套
    listEl.appendChild(m.row);
    convoRowsMeta.push(m);
  };
  // 摺疊群組標題列（▾/▸＋名稱＋則數），點就切開關並記住
  const grpHead = (label, n, open, onToggle) => {
    const h = el('div', 'sec gsec' + (open ? ' open' : ''));
    h.appendChild(el('span', 'gcar', open ? '▾' : '▸'));
    h.appendChild(el('span', 'glabel', label));
    if (n != null) h.appendChild(el('span', 'gcnt', String(n)));
    h.addEventListener('click', onToggle);
    return h;
  };
  const grpToggle = (key, get, set) => () => {
    set(!get());
    try { localStorage.setItem(key, get() ? '1' : '0'); } catch (_) {}
    buildConvoSections();
  };
  // 「24 小時內」從快速的 30 天清單切出來（開啟零成本）；「更早」＝全歷史，
  // 預設收起，第一次展開才深掃（慢，但那是使用者自己要的）
  const cutoff = Date.now() - 86400000;
  // 預設只列「你自己打字開的對話」；程式自動跑的（隊友工單、claude -p、別的 AI 派的 codex）收在最後一列
  // auto 則數：深掃完成後把全歷史的也算進來（依 agent:id 去重）
  const pool = (() => {
    if (!convoDeepCache.data) return all;
    const seen = new Set(all.map(c => c.agent + ':' + c.id));
    return all.concat(convoDeepCache.data.filter(c => !seen.has(c.agent + ':' + c.id)));
  })();
  const autoN = pool.filter(c => c.auto).length;
  const convos = convoShowAuto ? all : all.filter(c => !c.auto);
  const fresh = convos.filter(c => (c.updated || 0) >= cutoff);
  listEl.appendChild(grpHead(t('convoGrp24'), fresh.length, convo24Open,
    grpToggle('riffleConvo24Open', () => convo24Open, v => { convo24Open = v; })));
  if (convo24Open) {
    if (!fresh.length) listEl.appendChild(el('div', 'crow-empty', t('convoEmpty24')));
    for (const c of fresh) addConvoRow(c);
  }
  const deepAll = convoDeepCache.data
    ? (convoShowAuto ? convoDeepCache.data : convoDeepCache.data.filter(c => !c.auto))
    : null;
  // 24h 那組的絕對不會出現在這裡（cutoff 切分互斥，不用再去重）
  const older = deepAll ? deepAll.filter(c => (c.updated || 0) < cutoff) : null;
  listEl.appendChild(grpHead(t('convoGrpOld'), older ? older.length : null, convoOldOpen,
    grpToggle('riffleConvoOldOpen', () => convoOldOpen, v => { convoOldOpen = v; })));
  if (convoOldOpen) {
    if (!older) {
      listEl.appendChild(el('div', 'crow-empty', t('convoLoading')));
      fetchConvoListDeep().then(() => buildConvoSections());   // 第一次掃全歷史，好了自己重畫
    } else if (!older.length && !fresh.length) {
      listEl.appendChild(el('div', 'crow-empty', t('convoEmpty')));
    } else {
      const shown = older.slice(0, convoShowN);
      for (const c of shown) addConvoRow(c);
      // 「顯示更多」一次全部展開；全開後同一列變「收起」回到最近 15 則
      if (older.length > shown.length) {
        const more = makeCrow({ icon: '▾', label: t('convoMore', { n: older.length - shown.length }) });
        more.row.classList.add('more');
        more.row.addEventListener('click', () => { convoShowN = Infinity; buildConvoSections(); });
        listEl.appendChild(more.row);
      } else if (older.length > 15 && convoShowN > 15) {
        const less = makeCrow({ icon: '▴', label: t('convoLess') });
        less.row.classList.add('more');
        less.row.addEventListener('click', () => { convoShowN = 15; buildConvoSections(); });
        listEl.appendChild(less.row);
      }
    }
  } else if (!convos.length) {
    // 30 天快速窗就空的話別宣判「沒有對話」——更早的可能根本還沒掃
    listEl.appendChild(el('div', 'crow-empty', t('convoEmpty30')));
  }
  if (autoN) {
    const tog = makeCrow({ icon: convoShowAuto ? '▴' : '⚙', label: t(convoShowAuto ? 'convoAutoHide' : 'convoAutoShow', { n: autoN }) });
    tog.row.classList.add('more');
    tog.row.title = t('convoAutoTitle');
    tog.row.addEventListener('click', () => {
      convoShowAuto = !convoShowAuto;
      try { localStorage.setItem('riffleConvoAuto', convoShowAuto ? '1' : '0'); } catch (_) {}
      buildConvoSections();
    });
    listEl.appendChild(tog.row);
  }
  applyCrowHides();
  refreshConvoCounts();
  restoreRecent();          // 投影清單被 tree.boot() 洗掉時放回去（每次重建都在正確位置重掛）
  restorePiles();
}

function refreshConvoCounts() {
  const gen = convoGen;
  for (const m of recentRowsMeta) {
    apiJson('/api/recent?hours=' + m.hours + '&exts=' + encodeURIComponent(effectiveExts()))
      .then(d => {
        if (gen !== convoGen || !m.row.isConnected) return;
        m.lastN = (d.files || []).length;
        m.cnt.textContent = String(m.lastN);
        m.cnt.classList.toggle('zero', m.lastN === 0);
        applyCrowHide(m);
      }).catch(() => { m.cnt.textContent = ''; });
  }
  for (const m of changedRowsMeta) {
    apiJson('/api/recentmod?hours=' + m.changedHours + '&exts=' + encodeURIComponent(effectiveExts()))
      .then(d => {
        if (gen !== convoGen || !m.row.isConnected) return;
        if (d.indexed === false) { m.lastN = 0; m.row.style.display = 'none'; return; }  // 索引沒跑：整列消失
        m.lastN = (d.files || []).length;
        m.cnt.textContent = String(m.lastN);
        m.cnt.classList.toggle('zero', m.lastN === 0);
        applyCrowHide(m);
      }).catch(() => { m.cnt.textContent = ''; });
  }
  for (const m of convoRowsMeta) {
    fetchConvoFiles(m.id)
      .then(files => {
        if (gen !== convoGen || !m.row.isConnected) return;
        m.lastN = files.filter(chipsAcceptFile).length;
        m.cnt.textContent = String(m.lastN);
        m.cnt.classList.toggle('zero', m.lastN === 0);
        applyCrowHide(m);
      }).catch(() => { m.cnt.textContent = '…'; });
  }
}

function selectCrow(row, crowMeta) {
  clearTimeout(navTimer); navTimer = null;   // 點對話列＝放棄方向鍵還在等的載入
  tabsMode.drop();               // 分頁模式中點對話列＝離開分頁模式（不還原）
  lockedFolder = null;
  tree.lockCrow(crowMeta, row);              // 鎖定選取＝這列偽資料夾（同時清掉其他 .sel／預覽框）
  endContentSearch();
}
// 離開偽資料夾＝鎖定換到真資料夾（onLock）。hover 預覽真資料夾不叫這個——
// 鎖定仍是對話，離開左欄要靠 convoState 還原回去
function exitPseudo(clearRow) {
  if (!convoState) return;
  convoState = null;
  if (clearRow) for (const r of treeEl.querySelectorAll('.crow.sel')) r.classList.remove('sel');
}

function showPseudoPath(text) {
  pathNow = '';
  const crumbs = pathBar.querySelector('.crumbs');
  crumbs.textContent = '';
  crumbs.appendChild(el('span', 'seg last', text));
  pathBar.classList.add('on');
  pathBar.title = text;
  pathBar.querySelector('.copy').style.display = 'none';  // 偽資料夾沒有真路徑可複製
}

// 偽資料夾的檔案＋路徑列標題：鎖定（openConvo/openRecent）與 hover 預覽（previewCrow）共用
async function loadCrowFiles(meta) {
  if (meta.hours != null) {
    const d = await apiJson('/api/recent?hours=' + meta.hours + '&exts=' + encodeURIComponent(effectiveExts()));
    return { files: d.files || [], label: t('pathRecent', { which: meta.hours <= 24 ? t('recToday') : t('recWeek') }) };
  }
  if (meta.changedHours != null) {
    const d = await apiJson('/api/recentmod?hours=' + meta.changedHours + '&exts=' + encodeURIComponent(effectiveExts()));
    return { files: d.files || [], label: t('pathChanged', { which: meta.changedHours <= 24 ? t('recToday') : t('recWeek') }) };
  }
  const files = (await fetchConvoFiles(meta.id)).filter(chipsAcceptFile);
  return { files, label: t('pathConvo', { title: meta.title || t('convoNoTitle') }) };
}

let crowLoadTok = 0;   // 偽資料夾載入的世代：後到的請求一到，先到而還沒回的結果直接丟
function previewCrowCancel() { crowLoadTok++; }

// hover 預覽偽資料夾：只換卡堆＋路徑列，不動「鎖定」（樹那邊仍是原來的 .sel）
async function previewCrow(meta) {
  const tok = ++crowLoadTok;
  statusEl.textContent = t('reading');
  try {
    const { files, label } = await loadCrowFiles(meta);
    if (tok !== crowLoadTok) return;   // 已移去別列或鎖定了別的
    stack.setFolder(label, files);
    showPseudoPath(label);
    statusEl.textContent = t('fileCount', { path: '', n: files.length });
  } catch (e) {
    if (tok === crowLoadTok) statusEl.textContent = t('readFail', { msg: e.message });
  }
}

async function openRecent(hours, row) {
  selectCrow(row, { hours });
  convoState = { kind: 'recent', hours };
  const tok = ++crowLoadTok;
  statusEl.textContent = t('reading');
  try {
    const { files, label } = await loadCrowFiles({ hours });
    if (tok !== crowLoadTok) return;
    stack.setFolder(label, files);
    showPseudoPath(label);
    statusEl.textContent = t('fileCount', { path: '', n: files.length });
  } catch (e) { if (tok === crowLoadTok) statusEl.textContent = t('readFail', { msg: e.message }); }
}

// 「最近改動（不確定是誰改的）」列：same as openRecent but backed by /api/recentmod
async function openChanged(hours, row) {
  selectCrow(row, { changedHours: hours });
  convoState = { kind: 'changed', hours };
  const tok = ++crowLoadTok;
  statusEl.textContent = t('reading');
  try {
    const { files, label } = await loadCrowFiles({ changedHours: hours });
    if (tok !== crowLoadTok) return;
    stack.setFolder(label, files);
    showPseudoPath(label);
    statusEl.textContent = t('fileCount', { path: '', n: files.length });
  } catch (e) { if (tok === crowLoadTok) statusEl.textContent = t('readFail', { msg: e.message }); }
}

async function openConvo(c, row) {
  selectCrow(row || null, { id: c.id, title: c.title });
  convoState = { kind: 'convo', id: c.id, title: c.title };
  const tok = ++crowLoadTok;
  statusEl.textContent = t('reading');
  try {
    const { files, label } = await loadCrowFiles({ id: c.id, title: c.title });
    if (tok !== crowLoadTok) return;
    stack.setFolder(label, files);
    showPseudoPath(label);
    statusEl.textContent = t('fileCount', { path: '', n: files.length });
  } catch (e) { if (tok === crowLoadTok) statusEl.textContent = t('readFail', { msg: e.message }); }
}

function loadPseudo() {         // chips 切換／檔案被刪後重載目前的偽資料夾
  if (!convoState) return;
  if (convoState.kind === 'recent') {
    const row = recentRowsMeta.find(m => m.hours === convoState.hours);
    openRecent(convoState.hours, row ? row.row : null);
  } else if (convoState.kind === 'changed') {
    const row = changedRowsMeta.find(m => m.changedHours === convoState.hours);
    openChanged(convoState.hours, row ? row.row : null);
  } else {
    const m = convoRowsMeta.find(x => x.id === convoState.id);
    openConvo({ id: convoState.id, title: convoState.title }, m ? m.row : null);
  }
}
// ==================== end AI 對話區 ====================

// ====================== AI 整理的疊：只顯示這一疊，別的檔一張都不出現 ======================
// 一疊＝伺服器存下的一組路徑（/api/pile）。進來時記住原本的資料夾，「✕／Esc」回那裡。
// chips 類型過濾、排序、多選、右鍵、閱讀、編輯都照常——卡堆只是換了資料來源。
function pileRowsEl() { return document.getElementById('projPiles'); }
function pileRowFor(id) {
  const box = pileRowsEl();
  return box ? [...box.querySelectorAll('.pile-row')].find(r => r.dataset.pile === id) : null;
}

function showPileBar() {
  const title = pileState.title;
  const n = pileState.files.length;
  pathNow = '';
  const crumbs = pathBar.querySelector('.crumbs');
  crumbs.textContent = '';
  const txt = el('span', 'seg last', t('pileBar', { title, n }));
  const back = el('button', 'pile-back', t('pileBack'));
  back.addEventListener('click', () => closePile());
  crumbs.append(txt, back);
  pathBar.classList.add('on');
  pathBar.title = title;
  pathBar.querySelector('.copy').style.display = 'none';
}

function applyPile() {
  if (!pileState) return;
  const files = pileState.files.filter(chipsAcceptFile);
  stack.setFolder(pileState.title, files);
  showPileBar();
  statusEl.textContent = t('fileCount', { path: pileState.title, n: files.length });
  // 開疊順便開第一顆看得到的檔（chips 全濾光就不開）；只有第一次進來才自動開
  if (files.length && !pileAutoReader) autoOpenPileFront(files[0]);
}

// 疊展開後自動開第一顆檔進閱讀欄：卡堆讓到左邊（twocol→threecol），已在三欄以上不動。
// 記下「這是順便開的」與開之前的版面，closePile 才收得回去。
async function autoOpenPileFront(file) {
  const from = mode;
  if (!PANEL && mode === 'twocol') setMode('threecol');
  const rec = { path: file.path, from, expectMode: mode };
  pileAutoReader = rec;                 // 先記：開檔途中使用者換檔就算他的
  stack.readingPath = file.path;
  stack.poke();
  if (PANEL) reader.setOpen(true);
  reader.show();
  await reader.open(file).catch(() => {});
}

// closePile 的收尾：只收「還停在自動開的那個檔、版面也沒被使用者動過」的閱讀欄
function restorePileAutoReader(auto) {
  pileAutoReader = null;
  if (!auto || !reader.el.classList.contains('open')) return;
  if (PANEL) { reader.setOpen(false); reader.hide(); stack.readingPath = null; return; }
  if (mode !== auto.expectMode) return;                       // 使用者按過版面鈕
  if (!reader.file || norm(reader.file.path) !== norm(auto.path)) return;   // 使用者自己換了檔
  const restore = () => {
    if (reader.revise.active()) reader.revise.detach();
    reader.hide();
    stack.readingPath = null;
    stack.returnExtracted(false);
    if (auto.from === 'twocol') setMode('twocol');            // 從例欄來就回兩欄；wide／full 照舊
  };
  if (reader.editing() && reader.editor.dirty) reader.tryLeave(restore);
  else restore();
}

async function openPile(id, row) {
  if (!id) return false;
  tabsMode.drop();   // 分頁模式中開一疊＝離開分頁模式（不還原）
  statusEl.textContent = t('reading');
  let d;
  try { d = await apiJson('/api/pile?id=' + encodeURIComponent(id)); }
  catch (e) { statusEl.textContent = t('readFail', { msg: e.message }); return false; }
  const files = d.files || [];
  for (const f of files) { if (f.diff) noteDiff(f.path, f.diff); }   // 讓之後逛到同檔的資料夾視圖也有徽章
  // 已經在別疊裡：回程目標不覆蓋，仍是原本那個資料夾
  if (!pileState) pileReturn = convoState ? { kind: 'crow', meta: { ...convoState } }
    : (lockedFolder ? { kind: 'folder', path: lockedFolder } : null);
  pileState = { id: d.id, title: d.title || t('pileNoTitle'), files };
  pileAutoReader = null;
  exitPseudo(true);
  convoState = null;
  lockedFolder = null;
  tree.lockCrow({ id, pile: true }, row || pileRowFor(d.id));   // 樹上只留這一疊的實心選取
  previewCrowCancel();
  if (!files.length) {
    stack.setFolder(pileState.title, []);
    showPileBar();
    statusEl.textContent = t('pileNone');
    return true;
  }
  applyPile();
  return true;
}

// 鎖定到別的資料夾＝放棄這一疊（不回到疊、也不動卡堆，載入由 onLock 接手）
function dropPile() {
  if (!pileState) return;
  pileState = null;
  pileReturn = null;
  restorePileAutoReader(pileAutoReader);   // 疊被別的東西接手：順便開的閱讀欄也別留著
  for (const r of treeEl.querySelectorAll('#projPiles .sel')) r.classList.remove('sel');
}

// 檔案被改名／刪掉後重抓這一疊（伺服器只回還在的檔；全沒了就是空疊）
async function reloadPile() {
  if (!pileState) return;
  const id = pileState.id;
  try {
    const d = await apiJson('/api/pile?id=' + encodeURIComponent(id));
    if (!pileState || pileState.id !== id) return;
    pileState.files = d.files || [];
    applyPile();
  } catch (_) { if (pileState) pileState.files = []; applyPile(); }
}

function closePile() {
  if (!pileState) return;
  const back = pileReturn;
  const auto = pileAutoReader;
  pileState = null;
  pileReturn = null;
  for (const r of treeEl.querySelectorAll('#projPiles .sel')) r.classList.remove('sel');
  for (const r of treeEl.querySelectorAll('.crow.sel')) r.classList.remove('sel');
  if (back && back.kind === 'folder') { tree.lock(back.path); restorePileAutoReader(auto); return; }
  if (back && back.kind === 'crow') {
    if (back.meta.kind === 'recent') openRecent(back.meta.hours, null);
    else openConvo({ id: back.meta.id, title: back.meta.title }, null);
    restorePileAutoReader(auto);
    return;
  }
  const first = (tree.roots && tree.roots[0]) || (tree.drives && tree.drives[0] && tree.drives[0].path);
  if (first) tree.lock(first);
  else { showPath(''); stack.setFolder('', []); }
  restorePileAutoReader(auto);
}
// ==================== end AI 整理的疊 ====================

// ====================== 瀏覽器分頁模式（extension/ 擴充把 Chrome 分頁推給 server） ======================
// 進場記住現在在看什麼（資料夾／對話／一疊），離開時還原；運作本體在 tabs.js。
const tabsMode = new TabsMode({
  stack, statusEl,
  panel: PANEL,                     // 側邊欄模式：分頁卡多畫 ⧉ 複製給 AI、點卡＝切分頁
  pathBar: () => document.getElementById('pathBar'),
  canvas: () => document.getElementById('gl'),
  toast: (m, act) => toast(m, act),
  // 側邊欄網頁卡上的 ⧉＝複製給 AI（跟完整版右欄預覽的按鈕同一條流程，tabcopy.js）
  copyForAi: f => { copyTabForAI(f.tab, { toast: m => toast(m) }).catch(() => {}); },
  setBtnOn: on => {
    document.getElementById('btnTabs').classList.toggle('on', on);
    document.getElementById('btnModeFiles').classList.toggle('on', !on);
    document.body.classList.toggle('tabs-on', on);
    if (chipSel) chipSel.disabled = on;   // 分頁沒有副檔名可篩：類型下拉停用（CSS 已藏）
    if (on) hideTabStrip();               // 進分頁模式了：檔案搜尋的提示條收起來
  },
  // 記住檔案模式當下的狀態：去哪個資料夾＋滾到哪一張（chips／排序本來就各自保留在 localStorage）
  getReturn: () => ({
    scroll: Math.round(stack.scrollTarget),
    ...(convoState ? { kind: 'crow', meta: { ...convoState } }
      : (pileState ? { kind: 'pile', id: pileState.id }
      : (lockedFolder ? { kind: 'folder', path: lockedFolder } : { kind: 'none' })))
  }),
  clearCurrent() {
    exitPseudo(true);
    dropPile();
    convoState = null;
    lockedFolder = null;
    previewCrowCancel();
  },
  restore(back) {
    if (back && back.kind === 'folder') { tree.lock(back.path); }
    else if (back && back.kind === 'crow') {
      if (back.meta.kind === 'recent') openRecent(back.meta.hours, null);
      else openConvo({ id: back.meta.id, title: back.meta.title }, null);
    }
    else if (back && back.kind === 'pile') { openPile(back.id, null); }
    else {
      const first = (tree.roots && tree.roots[0]) || (tree.drives && tree.drives[0] && tree.drives[0].path);
      if (first) tree.lock(first);
      else { showPath(''); stack.setFolder('', []); }
    }
    // 回到檔案模式時跳回離開時看到的那張卡（等清單載入後再跳，大資料夾續頁也不會跳錯）
    if (back && back.scroll > 0) restoreScrollTo(back.scroll);
  }
});
// 等卡堆真的有內容（資料夾載進來）才把滾動位置設回去；最多等 4 秒
function restoreScrollTo(idx) {
  const t0 = performance.now();
  const step = () => {
    if (tabsMode.active) return;                 // 又切回分頁了：不動
    if (stack.files.length) {
      const i = Math.min(idx, stack.files.length - 1);
      if (i > 0) { stack.scrollCur = i; stack.scrollTarget = i; stack.scrollVel = 0; }
      return;
    }
    if (performance.now() - t0 < 4000) setTimeout(step, 120);
  };
  step();
}
document.getElementById('btnTabs').addEventListener('click', () => tabsMode.toggle());
document.getElementById('btnModeFiles').addEventListener('click', () => { if (tabsMode.active) tabsMode.exit(); });
document.getElementById('btnModeFiles').classList.add('on');
// 側邊欄「點卡連動」與 ?tabs=1 開機：搬到檔尾（tabStrip 等 const 初始化完）才跑，
// 見檔尾 bootUrlTabs()。
// ==================== end 瀏覽器分頁模式 ====================

// ---------------------------------------------------------------- card → reader
let clickT0 = 0;
let clickToTextMs = 0;

stack.readerOpen = () => mode !== 'twocol';
stack.getReaderRect = () => {
  const target = (mode === 'twocol') ? 'threecol' : mode;
  return readerRectFor(target);
};

// ---------------------- panel 模式：點檔案卡＝就地開整欄閱讀覆層 ----------------------------
// 側邊欄沒有第三欄可放：閱讀面板改當覆層整欄蓋住卡堆（CSS：body.panel-mode #reader.open 滿版），
// 頂列多一顆「← 返回」（Esc／✕ 同效果）。卡堆原地不滾——收掉覆層後還停在同一張。

// 開閱讀區看一張卡：檔案卡由 stack 的抽卡流程帶進來；分頁卡（完整版）點卡即到此＝右欄預覽
function openInReader(file) {
  clickT0 = performance.now();
  // 使用者自己點卡換了檔：這就不算「開疊順便開的」，離開疊時不該替他關
  if (pileAutoReader && norm(file.path) !== norm(pileAutoReader.path)) pileAutoReader = null;
  // 提示卡是點擊穿透的（index.html #hint）：它會一直蓋在卡堆中央，
  // 既然開始看卡了就不再需要它——順手收掉，也免得它的 Esc 多佔一次。
  hideTip();
  stack.readingPath = file.path;               // 卡堆裡這張加外框、微微抬高
  stack.poke();
  if (PANEL) {
    reader.setOpen(true);                      // panel 的 .open＝整欄覆層（index.html 的 panel CSS）
    reader.show();
    reader.open(file).then(() => { clickToTextMs = Math.round(performance.now() - clickT0); });
    return;
  }
  if (mode === 'twocol') setMode('threecol');
  reader.show();                               // panel fades in over the flying card
  reader.open(file).then(() => {
    clickToTextMs = Math.round(performance.now() - clickT0);
  });
}
stack.onCardClick = openInReader;

// 右欄網頁預覽的「側欄模式」鈕：交給 tabsMode（趁點擊手勢直送擴充，見 tabs.js）
reader.enterSidePanel = tab => tabsMode.enterSidePanel(tab);

// ---------------------------------------------------------------- 工具列「原地切側欄」鈕
// 完整版才用（側欄自己不用開側欄），擴充連上才顯現：每 30 秒問一次 /api/tabs?meta=1，
// SSE 推播與開機時各補一次；沒連上就藏（不會出現按了才說不行的死按鈕）。
// 點了：右欄正在預覽某個網頁 → 順便把 Chrome 切到那個網頁；沒有 → 只開側欄不動目前分頁。
const btnSidePanel = document.getElementById('btnSidePanel');
async function refreshExtLive() {
  if (!btnSidePanel) return;
  let alive = false, extId = '';
  try {
    const d = await apiJson('/api/tabs?meta=1');
    alive = !!d.extAlive;
    extId = (typeof d.extId === 'string') ? d.extId : '';
  } catch (_) { alive = false; }
  if (extId) tabsMode.extId = extId;   // 沒進過分頁模式也能直送擴充
  btnSidePanel.hidden = PANEL || !alive;
}
if (btnSidePanel && !PANEL) {
  btnSidePanel.addEventListener('click', () => {
    // 不做任何前置 await：sendMessage 要趕在使用者手勢效期內送出去
    const cur = (reader.el.classList.contains('show') && reader.file && reader.file.tab && !reader.file.tab.note)
      ? reader.file.tab : null;
    tabsMode.enterSidePanel(cur);
  });
  refreshExtLive();
  setInterval(refreshExtLive, 30000);
}

// 分頁卡：卡面右上角的 ×（uv 熱區）＝關掉那個網頁（全部模式都有畫；側欄的 ⧉＝複製給 AI）。
// 除此之外——完整版點分頁卡＝右欄預覽（截圖＋文字／DOM，頂列有「切到這個網頁」），不切分頁；
// 側邊欄點分頁卡＝把主視窗 Chrome 切到那個分頁。安裝說明卡例外：照舊開閱讀區看安裝步驟。
stack.onClickIntercept = (file, uv) => {
  if (tabsMode.active && file.tab) {
    if (tabsMode.handleBadgeHit(file, uv)) return true;
    if (PANEL && !file.tab.note) { tabsMode.activateTab(file.tab); return true; }
    openInReader(file); return true;
  }
  return false;
};

// reader buttons
// 閱讀區大小只用一顆按鈕輪流切：1/3 → 2/3 → 全螢幕 → 1/3（按鈕上寫的是「現在」的大小）
var SIZE_CYCLE = { threecol: 'wide', wide: 'full', full: 'threecol', twocol: 'threecol' };
var SIZE_LABEL = { threecol: '1/3', wide: '2/3', full: t('sizeFull'), twocol: '1/3' };
function updateSizeBtn() {
  const btnSize = document.getElementById('btnSize');   // 每次現查：setMode 可能在這段程式跑到之前就被呼叫
  if (!btnSize || !SIZE_LABEL) return;   // var 宣告：早於此段被呼叫時是 undefined，不會丟錯
  btnSize.textContent = SIZE_LABEL[mode] || '1/3';
  btnSize.title = t('sizeTitle', { cur: SIZE_LABEL[mode] || '1/3', next: SIZE_LABEL[SIZE_CYCLE[mode]] });
}
document.getElementById('btnSize').addEventListener('click', () => setMode(SIZE_CYCLE[mode] || 'threecol'));
updateSizeBtn();
document.getElementById('btnTree').addEventListener('click', () => setTreeCollapsed(!treeCollapsed));
syncTreeBtn();
document.getElementById('btnClose').addEventListener('click', () => putBack());
// 側邊欄閱讀覆層的「← 返回」：跟 ✕／Esc 同一件事
document.getElementById('btnPanelBack').addEventListener('click', () => putBack());

function putBack() {
  // 編輯中有未存的內容 → 先跳頁內提示（存檔／放棄／繼續編輯），不直接關
  if (reader.editing() && reader.editor.dirty) {
    reader.tryLeave(() => doPutBack());
    return;
  }
  doPutBack();
}
function doPutBack() {
  pileAutoReader = null;   // 使用者自己把閱讀欄收了：之後不用再替他收
  if (reader.revise.active()) reader.revise.detach();
  reader.hide();
  stack.readingPath = null;
  stack.returnExtracted(false);
  if (PANEL) { reader.setOpen(false); return; }   // 側邊欄：覆層直接收掉，版面模式本來就是兩欄
  setMode('twocol');
}

function isReading() { return !!stack.extracted || mode !== 'twocol'; }

// ---------------------------------------------------------------- 方向鍵＝走左邊資料夾樹
// ↑／↓＝樹的高亮往上／往下移一列「看得見」的列（跨區：AI 最近給我的 → 對話 → 快速存取 →
// 本機；被「只看有這類檔案的資料夾」藏起來的列一律跳過）。高亮立刻動，停住 120ms 沒再按
// 才真正載那個資料夾的檔案——按住 ↓ 可以一路滑過去，不會每滑一列就打一次 /api/list。
// →＝展開資料夾（已展開＝移到第一個看得見的子資料夾）；←＝收起（已收起＝移到父層）。
// Home／End＝移到第一列／最後一列。Enter／空白鍵＝把卡堆最前面那張開進閱讀面板。
// 卡堆本身只用滑鼠滾輪翻；閱讀內文捲動＝滾輪或（閱讀中）空白鍵。
const NAV_DEBOUNCE_MS = 120;
let navTimer = null;

// 左樹所有「可走」的列，照畫面順序：AI 對話區的資料列（「顯示更多」等操作列沒 meta，跳過）
// ＋真資料夾列。只留看得見的：style 藏掉或未展開樹枝裡的列 offsetParent 是 null
function navableRows() {
  const out = [];
  for (const row of treeEl.querySelectorAll('#projPiles .pile-row, #convos .crow, .trow:not(.crow)')) {
    if (row.offsetParent === null || row.style.display === 'none') continue;
    if (row.classList.contains('pile-row')) {
      out.push({ kind: 'pile', row });
    } else if (row.classList.contains('crow')) {
      const m = recentRowsMeta.find(x => x.row === row) || changedRowsMeta.find(x => x.row === row) || convoRowsMeta.find(x => x.row === row);
      if (m) out.push({ kind: 'crow', row, meta: m });
    } else {
      const node = tree.rowNode.get(row);
      if (node) out.push({ kind: 'folder', row, node });
    }
  }
  return out;
}
function navCurrentIdx(rows) {
  const sel = treeEl.querySelector('.trow.sel');
  return sel ? rows.findIndex(r => r.row === sel) : -1;
}

// 高亮立刻動（純視覺，不載檔）；停下來才把內容載進卡堆
function navFocus(item) {
  for (const r of treeEl.querySelectorAll('.trow.sel')) r.classList.remove('sel');
  item.row.classList.add('sel');
  item.row.scrollIntoView({ block: 'nearest' });
  clearTimeout(navTimer);
  navTimer = setTimeout(() => {
    navTimer = null;
    // 等待期間使用者用滑鼠點了別列（.sel 已不在這列）→ 這一輪不載
    if (treeEl.querySelector('.trow.sel') !== item.row) return;
    if (item.kind === 'pile') openPile(item.row.dataset.pile, item.row);
    else if (item.kind === 'crow') {
      const title = (item.row.querySelector('.nm') || {}).textContent || '';
      if (item.meta.hours != null) openRecent(item.meta.hours, item.row);
      else openConvo({ id: item.meta.id, title }, item.row);
    } else {
      tree.lock(item.node.path, item.node);   // onLock 會設 lockedFolder＋載入檔案
    }
  }, NAV_DEBOUNCE_MS);
}
function navMove(dir) {
  const rows = navableRows();
  if (!rows.length) return;
  const i = navCurrentIdx(rows);
  const j = i < 0 ? (dir > 0 ? 0 : rows.length - 1) : i + dir;
  if (j >= 0 && j < rows.length) navFocus(rows[j]);
}
async function navRight() {
  const rows = navableRows();
  const item = rows[navCurrentIdx(rows)];
  if (!item || item.kind !== 'folder') return;
  const node = item.node;
  if (!node.expanded) {
    if (node.tw.classList.contains('leaf')) return;   // 沒有子資料夾，展開也是空的
    await tree.toggle(node);
    return;
  }
  // 已展開 → 移到第一個看得見的子資料夾
  for (const c of node.kidsBox.children) {
    if (!c.classList.contains('trow')) continue;
    if (c.offsetParent === null || c.style.display === 'none') continue;
    const cn = tree.rowNode.get(c);
    if (cn) navFocus({ kind: 'folder', row: c, node: cn });
    return;
  }
}
function navLeft() {
  const rows = navableRows();
  const item = rows[navCurrentIdx(rows)];
  if (!item || item.kind !== 'folder') return;
  const node = item.node;
  if (node.expanded) { tree.toggle(node); return; }
  const par = tree.parentOf(node);
  if (par) navFocus({ kind: 'folder', row: par.row, node: par });
}
function navHomeEnd(toLast) {
  const rows = navableRows();
  if (rows.length) navFocus(toLast ? rows[rows.length - 1] : rows[0]);
}
// 卡堆「最前面」那張＝卷動位置停的卡（跟點卡同一條路進閱讀）
function navOpenFront() {
  const n = stack.view.length;
  if (!n) return;
  const i = clamp(Math.round(stack.scrollCur), 0, n - 1);
  if (stack.view[i]) stack.onCardClick(stack.view[i]);
}

addEventListener('keydown', e => {
  const tag = e.target && e.target.tagName;
  const mod = e.ctrlKey || e.metaKey;
  // 閱讀區專屬快捷鍵：Ctrl+F／Ctrl+S／Ctrl+E（只在閱讀開著時攔，不搶瀏覽器自己的 Ctrl+F 以外行為）
  if (mod && isReading()) {
    const k = e.key.toLowerCase();
    if (k === 'f') { e.preventDefault(); reader.find.open(); return; }
    if (k === 's' && reader.editing()) { e.preventDefault(); reader.editor.save(); return; }
    if (k === 'e' && e.shiftKey && reader.file && reader.file.kind === 'html') { e.preventDefault(); reader.revise.toggle(); return; }
    if (k === 'e' && !e.shiftKey && !reader.revise.active() && reader.file && reader.canEdit()) {
      e.preventDefault(); reader.toggleEdit(); return;
    }
    if (k === 'enter' && reader.editing()) { e.preventDefault(); reader.btnSaveExit.click(); return; }
  }
  // 改版模式：Esc 離開改版、Ctrl+Z 復原上一個改動
  if (reader.revise.active()) {
    // the find bar sits on top of the overlay — Esc must close it first, not the mode
    if (e.key === 'Escape' && reader.find.isOpen) { e.preventDefault(); reader.find.close(); return; }
    if (e.key === 'Escape') { e.preventDefault(); reader.revise.exit(); return; }
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      // leave typing alone: an <input>/<textarea>/contenteditable has its own undo
      const t2 = e.target;
      if (t2 && (t2.tagName === 'TEXTAREA' || t2.tagName === 'INPUT' || t2.isContentEditable)) return;
      e.preventDefault(); reader.revise.undo(); return;
    }
  }
  // 查找列裡的 Esc 由 find.js 自己收；編輯器裡的 Esc 離開編輯
  if (e.key === 'Escape' && reader.find.isOpen) { e.preventDefault(); reader.find.close(); return; }
  if (e.key === 'Escape' && reader.editing()) {
    e.preventDefault();
    reader.exitEdit().catch(() => {});
    return;
  }
  if (e.key === 'Escape' && (closeMenu() || closeDlg() || closeSettings() || hideTip())) return;   // 先關右鍵選單／對話框
  // 檔案／分頁 切換：Alt+1＝檔案、Alt+2＝分頁（跟工具列的兩段鈕同一件事；輸入框裡也照吃）
  if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && (e.code === 'Digit1' || e.code === 'Numpad1' || e.code === 'Digit2' || e.code === 'Numpad2')) {
    e.preventDefault();
    if (e.code === 'Digit1' || e.code === 'Numpad1') { if (tabsMode.active) tabsMode.exit(); }
    else if (!tabsMode.active) tabsMode.enter();
    return;
  }
  // 側邊欄介面縮放鍵：Ctrl+0 還原、Ctrl+= 放大、Ctrl+- 縮小（完整版不攔，留給瀏覽器原生縮放）
  if (PANEL && mod && !e.altKey) {
    if (e.key === '0') { e.preventDefault(); setPanelZoom(1); return; }
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setPanelZoom(panelZoom * 1.1); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); setPanelZoom(panelZoom / 1.1); return; }
  }
  // 輸入框不吃快捷鍵；但下拉選單（排序、字型）選完焦點會留在上面，Esc 要照樣能退出閱讀
  if (tag === 'SELECT' && e.key === 'Escape') e.target.blur();
  else if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  // 方向鍵＝走左邊資料夾樹；卡堆只用滑鼠滾輪翻
  // （編輯器開著時方向鍵／空白／Enter／Home／End 都是打字，交給 contenteditable）
  if (!reader.editing() && !dlg.classList.contains('on') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      navMove(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'ArrowRight') { e.preventDefault(); navRight(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); navLeft(); return; }
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); navHomeEnd(e.key === 'End'); return; }
    if (e.key === 'Enter' && tag !== 'BUTTON' && tag !== 'A') { e.preventDefault(); navOpenFront(); return; }
    // 空白鍵：閱讀開著＝捲動閱讀內文（Shift＝往回捲）；沒開閱讀＝開卡堆最前面那張
    if (e.key === ' ' && tag !== 'BUTTON' && tag !== 'A') {
      e.preventDefault();
      if (mode !== 'twocol') reader.body.scrollBy({ top: (e.shiftKey ? -1 : 1) * Math.max(140, reader.body.clientHeight * 0.85) });
      else navOpenFront();
      return;
    }
  }
  // 編輯器裡 Ctrl+A／Delete 是編輯器的（全選文字／刪字），不是卡片
  if (reader.editing()) {
    if (mod && (e.key === 'a' || e.key === 'A')) return;
    if (e.key === 'Delete' && tag !== 'INPUT') return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); stack.toggleSelectAll(); return; }
  // 編輯器內 Ctrl+Z＝打字復原（CodeJar 自己處理，這裡不要搶）
  if (reader.editing() && (e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) return;
  if (undo.onKeydown(e)) { e.preventDefault(); return; }   // Ctrl+Z＝復原上一個改名/刪除
  if (e.key === 'Delete' && stack.selected.size && !tabsMode.active) { batchTrash(stack.selectedFiles()); return; }
  // 側邊欄的閱讀覆層最優先收（覆層蓋在卡堆上，選取清除和欄位階梯都排在它後面）
  if (e.key === 'Escape' && PANEL && reader.el.classList.contains('open')) { putBack(); return; }
  if (e.key === 'Escape' && mode === 'twocol' && stack.selected.size) { stack.clearSelection(); return; }
  if (e.key === 'Escape') {
    // a pile sits in twocol as well, so it gets its own step before the layout ladder
    if (pileState && mode === 'twocol') { closePile(); return; }
    // 分頁模式也是兩欄：Esc（右欄沒開時）＝離開分頁回到原本的資料夾／對話／疊
    if (tabsMode.active && mode === 'twocol') { tabsMode.exit(); return; }
    if (mode === 'full') setMode('wide');
    else if (mode === 'wide') setMode('threecol');
    else if (pileState) closePile();   // reading inside a pile: first Esc puts the file back, this one leaves
    else if (mode === 'threecol') putBack();
  } else if (e.key === 'f' || e.key === 'F') {
    if (!PANEL && isReading()) setMode(mode === 'full' ? 'threecol' : 'full');
  } else if (e.key === 't' || e.key === 'T') {
    tabsMode.toggle();               // T ＝ 分頁模式開關（跟工具列「分頁」鈕同一件事）
  } else if (e.key === '2') {
    if (!PANEL && isReading()) setMode(mode === 'wide' ? 'threecol' : 'wide');
  }
});

// ---------------------------------------------------------------- search
// placeholder for the future Rust full-text backend; now: filter current folder
function search(query) {
  searchBox.value = query;
  stack.setNameFilter(query);
}
window.search = search;

// 按 Enter＝搜尋內文：目前資料夾（含子資料夾）裡哪些檔案「內容」有這段字（依上方類型按鈕過濾）。
// 結果直接變成卡堆；打開的檔案會把搜尋字標黃。Esc 或清空搜尋框＝回到原資料夾。
let contentQuery = '';
async function contentSearch(q) {
  if (!lockedFolder || !q) return;
  clearTimeout(searchTimer);   // 打字後 250ms 的「放寬類型重載資料夾」別蓋掉搜尋結果
  statusEl.textContent = t('searching', { q });
  try {
    const r = await fetch('/api/search?path=' + encodeURIComponent(lockedFolder) + '&q=' + encodeURIComponent(q) +
      '&exts=' + encodeURIComponent(extsParam()) + '&limit=500');
    if (r.status === 404) { statusEl.textContent = t('searchUnavailable'); return; }
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || ('http ' + r.status));
    if (tabsMode.active) return;   // 搜尋回應晚到：使用者已切去分頁模式，別蓋掉卡堆
    contentQuery = q;
    reader.highlight = q;
    stack.nameFilter = '';
    stack.setFolder('🔍 ' + q, d.files);
    statusEl.textContent = t('searchDone', { q, n: d.files.length, scanned: d.scanned, more: d.truncated ? t('searchMore') : '' });
  } catch (err) {
    statusEl.textContent = t('searchFail', { msg: err.message });
  }
}
function endContentSearch() {
  if (!contentQuery) return;
  contentQuery = ''; reader.highlight = '';
  if (lockedFolder) loadFolder(lockedFolder);
}
// 檔案模式搜尋時，分頁也有符合 → 卡堆上方浮一條「分頁符合 N 個 → 看分頁」，
// 點了帶著同一個搜尋字切進分頁模式（分頁模式搜尋比對標題／網址／內文／摘要）。
const tabStrip = document.getElementById('tabStrip');
let tabStripTimer = null;
function hideTabStrip() { if (tabStrip) tabStrip.hidden = true; }
async function refreshTabMatchStrip() {
  if (!tabStrip) return;
  const q = searchBox.value.trim().toLowerCase();
  if (tabsMode.active || !q) return hideTabStrip();
  let d = null;
  try { d = await apiJson('/api/tabs'); } catch (_) { d = null; }
  if (tabsMode.active || searchBox.value.trim().toLowerCase() !== q) return;   // 打字又變了：這輪不作數
  const list = (d && d.extAlive && Array.isArray(d.tabs)) ? d.tabs : [];
  const n = list.filter(tb =>
    String(tb.title || '').toLowerCase().includes(q) ||
    String(tb.url || '').toLowerCase().includes(q) ||
    String(tb.text || '').toLowerCase().includes(q) ||
    String(tb.desc || '').toLowerCase().includes(q)).length;
  if (!n) return hideTabStrip();
  tabStrip.textContent = t('tabMatchStrip', { n });
  tabStrip.hidden = false;
}
if (tabStrip) {
  tabStrip.addEventListener('click', () => {
    const q = searchBox.value.trim();
    hideTabStrip();
    if (tabsMode.active) tabsMode.setQuery(q);
    else tabsMode.enterWithQuery(q);
  });
}

searchBox.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    // 分頁模式：Enter 不打內文搜尋——篩選即時生效了（內文也在比對範圍）
    if (tabsMode.active) return;
    contentSearch(searchBox.value.trim());
  }
  else if (e.key === 'Escape') {
    searchBox.value = '';
    if (tabsMode.active) tabsMode.setQuery('');
    stack.setNameFilter('');
    endContentSearch();
    searchBox.blur();
  }
});
searchBox.addEventListener('input', () => {
  if (tabsMode.active) { tabsMode.setQuery(searchBox.value); return; }
  clearTimeout(tabStripTimer);
  tabStripTimer = setTimeout(refreshTabMatchStrip, 350);
  if (!searchBox.value.trim()) endContentSearch();
});

// 排序
{
  const sel = document.getElementById('sortSel');
  const opts = [['new', 'sortNew'], ['old', 'sortOld'], ['big', 'sortBig'], ['small', 'sortSmall'], ['name', 'sortName']];
  for (const [v, k] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t(k); sel.appendChild(o); }
  let m = 'new';
  try { const s = localStorage.getItem('floderSort'); if (opts.some(o => o[0] === s)) m = s; } catch (_) {}
  sel.value = m;
  stack.sortMode = m;
  sel.addEventListener('change', () => {
    try { localStorage.setItem('floderSort', sel.value); } catch (_) {}
    stack.sortMode = sel.value;
    // 分頁中的大資料夾：頁面是伺服器按排序切的，換排序要整個重載第一頁
    if (stack.hasMore || (stack.total != null && stack.total > stack.files.length)) {
      dirCache.clear();
      if (lockedFolder) loadFolder(lockedFolder);
      else stack.setSort(sel.value);
    } else {
      stack.setSort(sel.value);
    }
  });
}

// 視角按鈕：預設視角 / 我的視角 / 存成我的視角
function toast(msg, action) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('act', false);
  if (action && action.label && action.fn) {
    el.classList.add('act');                       // 讓連結可點（預設 toast 不吃滑鼠）
    const a = document.createElement('a');
    a.textContent = action.label;
    a.href = '#';
    a.addEventListener('click', e => { e.preventDefault(); el.classList.remove('on'); action.fn(); });
    el.appendChild(a);
  }
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), action ? 6000 : 1800);
}
{
  // 視角提示列：平常不顯示；相機偏離「我的視角」（沒存過＝偏離預設視角）才淡入
  // 「存成我的視角」＋「回我的視角」（沒存過只顯示存）。按存／按回／視角回到存的一樣就淡出。
  const bar = document.getElementById('viewBar');
  const saveBtn = document.getElementById('btnViewSave');
  const favBtn = document.getElementById('btnViewFav');
  const FADE_MS = 200;               // 跟 index.html #viewBar 的 .18s 一起看
  let hideTimer = null, rafId = null, last = null;
  // 「最後在用的視角」寫回 server 共享 prefs（去抖 1.5s：拖曳途中不每幀都寫）。
  // 沒存過「我的視角」的面板系 surface 開機就拿它當落點；與 favView 同值時不重寫。
  const VIEW_SETTLE_MS = 1500;
  let lastViewTimer = null;
  let lastSentView = (window.__rifflePrefsBoot && window.__rifflePrefsBoot.lastView) || null;
  const sameView = (a, b) => !!a && !!b &&
    Math.abs(a.yaw - b.yaw) < 0.001 && Math.abs(a.pitch - b.pitch) < 0.001 && Math.abs(a.zoom - b.zoom) < 0.001;
  const noteViewSettled = () => {
    if (no3d) return;
    clearTimeout(lastViewTimer);
    lastViewTimer = setTimeout(() => {
      const v = { yaw: stack.orbit.yaw, pitch: stack.orbit.pitch, zoom: stack.orbit.zoom };
      if (sameView(v, lastSentView)) return;
      lastSentView = v;
      postSharedPrefs({ lastView: v });
    }, VIEW_SETTLE_MS);
  };
  const sync = differsIn => {
    // differs 由 stack.notifyView 傳進來；undefined（初次、存檔後）就自己算
    const differs = !no3d && (differsIn === undefined ? stack.viewDiffers() : differsIn);
    const has = !!stack.favView();
    if (differs === last && has === favBtn.classList.contains('has')) return;   // 狀態沒變就不動 DOM
    last = differs;
    clearTimeout(hideTimer);
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    favBtn.hidden = !has;
    favBtn.classList.toggle('has', has);
    if (differs) {
      bar.classList.add('on');
      // 兩次 rAF：先讓 display:flex 真的生效，opacity 才會從 0 漸變（同一次 recalc 會直接跳出來）
      rafId = requestAnimationFrame(() => {
        rafId = requestAnimationFrame(() => { rafId = null; if (last) bar.classList.add('show'); });
      });
    } else {
      bar.classList.remove('show');               // 先淡出，200ms 後才真的拆掉
      hideTimer = setTimeout(() => bar.classList.remove('on'), FADE_MS);
    }
  };
  stack.onViewChange = differs => { sync(differs); noteViewSettled(); };
  document.getElementById('btnViewHome').addEventListener('click', () => stack.resetView());
  favBtn.addEventListener('click', () => { if (!stack.goFavView()) toast(t('viewFavNone')); });
  saveBtn.addEventListener('click', () => {
    if (stack.saveFavView()) toast(t('viewSaved'));
    else toast(t('viewSaveFail'));
    sync();
  });
  sync();
}
// 檔名搜尋期間放寬 chips：chips 只載入勾選副檔名，搜尋常有「明明有這檔卻搜不到」；
// 有搜尋字就放寬成全部檔（name filter 仍只看檔名），清空立即回到 chips 視圖。
let searchBroad = false, searchTimer = null;
searchBox.addEventListener('input', () => {
  if (tabsMode.active) return;   // 分頁模式的篩選由 tabsMode.setQuery 處理（標題／網址／內文）
  stack.setNameFilter(searchBox.value);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const broaden = searchBox.value.trim() !== '';
    if (broaden === searchBroad || !lockedFolder) return;
    searchBroad = broaden;
    chipsEl.classList.toggle('muted', broaden);   // 視覺提示：搜尋期間 chips 暫不生效
    loadFolder(lockedFolder);
    tree.setExts(effectiveExts());
  }, 250);
});

// ---------------------------------------------------------------- 安裝成 App（PWA）
// manifest＋sw.js 都齊時 Chrome 才丟 beforeinstallprompt：按鈕平常藏著，可裝才出現。
// 裝成 App 後 RiffleDesk 是獨立視窗（點分頁卡切的是原本的瀏覽器視窗），
// 擴充的 Alt+Shift+R 可把它叫回最前面（提示寫在按鈕 title 裡）。
let deferredInstall = null;
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  const b = document.getElementById('btnInstall');
  if (b) b.hidden = false;
});
const btnInstall = document.getElementById('btnInstall');
if (btnInstall) btnInstall.addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  try { await deferredInstall.userChoice; } catch (_) {}
  deferredInstall = null;
  btnInstall.hidden = true;
});
// 只為可安裝而存在的 service worker（不快取任何東西，fetch 原樣放行）
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---------------------------------------------------------------- boot
buildChips();
applyFracs(fracs);

(async () => {
  try {
    // 側欄帶 ?tabs=1 開局（點卡連動／「側欄模式」鈕開出來的）＝一進來就是要翻分頁卡：
    // 最優先進分頁模式，不等資料夾樹、也不先鋪「今天的 AI 檔」卡堆——先鋪再換堆的話，
    // setFolder 會把使用者在等清單那段時間滾出的位置清零（強制拉回第一張），還白畫
    // 一輪檔案縮圖佔住主執行緒（開局頓 1–2 秒的主因）。樹和離開分頁的落點在背景補。
    if (PANEL && new URLSearchParams(location.search).get('tabs') === '1') {
      await bootUrlTabs();
      panelLandingBoot();   // fire-and-forget：不擋卡堆，也不動卡堆
      return;
    }
    let d;
    if (PANEL) {
      // 側邊欄（無 tabs 參數）：首屏卡堆＝今天的 AI 檔。它不靠樹，跟樹並行抓，
      // 樹只做「今天沒檔案」時的備援落點。
      const treeP = tree.boot();
      treeP.catch(() => {});   // 早窗口的 unhandledrejection 吃掉；錯誤由下方 await 統一進 catch
      await openRecent(24, null);
      d = await treeP;
    } else {
      d = await tree.boot();
    }
    buildConvoSections();   // AI 對話區（最近給我的＋對話列表）掛在快速存取之上
    const first = (d.roots && d.roots[0]) || (d.drives && d.drives[0] && d.drives[0].path);
    if (PANEL) {
      // 側邊欄預設看「AI 最近給我的：今天」（快翻是這個欄位最重要的用途）；
      // 今天掃不到檔案（或對話紀錄整個關掉）就照舊退到第一個根目錄。
      if (!stack.files.length) convoState = null;
      else {
        statusEl.textContent = t('fileCount', { n: stack.files.length });
        await bootUrlOpen(); await bootUrlPile();
        return;
      }
    }
    if (!first) statusEl.textContent = t('noRoots');
    else if (!lockedFolder) {
      // 開機自動鎖第一個根；但 boot 期間若已有人搶先鎖了別的資料夾（手速快／自動化），
      // 預設根這一鎖會把人家的卡堆清空蓋掉——放棄預設鎖。
      // 走 lock() 正規路徑：tree 內部 lockedPath 同步、先清殘留 .sel、觸發 onLock 載入
      const node = tree.nodes.get(String(first).replace(/[/\\]+$/, '').toLowerCase());
      if (node) await tree.lock(first);
      else { lockedFolder = first; await loadFolder(first); }
      statusEl.textContent += t('ready');
    }
  } catch (err) {
    statusEl.textContent = t('initFail', { msg: err.message });
    await bootUrlOpen();    // 樹還在半殘狀態，但讀檔只需要 lock＋API，值得一試
    await bootUrlTabs();    // ?tabs=1 同理：分頁模式只吃 /api/tabs，不靠樹
    return;
  }
  await bootUrlOpen();      // ?open=… 要等預設資料夾載完，否則會被它的載入蓋掉
  await bootUrlPile();      // ?pile=… 同理：預設資料夾先載好當「回到原本資料夾」的目標
  await bootUrlTabs();      // ?tabs=1：同上，最後進分頁模式（panel 與完整視窗都認）
})();

// ---------------------------------------------------------------- 網址進分頁模式（?tabs=1[&tabfocus=N]）
// 側邊欄「點卡連動」：擴充趁手勢把側欄開在這種網址上——直接進分頁模式並捲到剛點的那張。
// 完整視窗也認同一個網址：擴充「回到完整畫面」找不到既有視窗要新開時，就開
// ?tabs=1&tabfocus=，落地直接是定位好的分頁模式。
// 完整視窗＝boot 最後跑（預設內容先載好，enter 才記得到「離開時回到哪裡」，早跑會被
// openRecent/lock 的清場蓋掉）。側欄 tabs 開局反過來＝最先跑（見 boot 段開頭的註解），
// 落點由 panelLandingBoot() 在背景補。兩條路都不會在模組評估期呼叫本函式，
// 所以 tabStrip 等前半段 const 早已初始化完，沒有 TDZ 問題。
async function bootUrlTabs() {
  const sp = new URLSearchParams(location.search);
  if (sp.get('tabs') !== '1') return;
  // 跟 ?open=/?pile= 一致：進場後立刻把參數從網址剝掉，重新整理不會再帶著過期的 tabfocus 跳
  const tfRaw = sp.get('tabfocus');
  const tabId = (tfRaw != null && tfRaw !== '' && Number.isFinite(+tfRaw))
    ? Math.max(0, Math.floor(+tfRaw)) : null;
  sp.delete('tabs'); sp.delete('tabfocus');
  const qs = sp.toString();
  try { history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash); } catch (_) {}
  try { await tabsMode.enterAt(tabId); } catch (err) { console.warn('tabs boot failed', err); }
}
// ?tabs=1 側欄開局的背景補課：資料夾樹（離開分頁模式要鎖資料夾用）＋預設落點。
// 全程不碰卡堆——分頁卡已經在螢幕上，任何 setFolder 都會把使用者滾到的位置清掉。
// 落點規則跟無 tabs 參數的開局一致：今天有 AI 給的檔就回那一列，沒有就第一個根。
async function panelLandingBoot() {
  try {
    const d = await tree.boot();
    buildConvoSections();
    const first = (d.roots && d.roots[0]) || (d.drives && d.drives[0] && d.drives[0].path);
    let back = null;
    try {
      const r = await loadCrowFiles({ hours: 24 });
      if (r.files && r.files.length) back = { kind: 'crow', meta: { kind: 'recent', hours: 24 }, scroll: 0 };
    } catch (_) { /* 掃不到就退回根目錄 */ }
    if (!back && first) back = { kind: 'folder', path: first, scroll: 0 };
    if (back && tabsMode.active && (!tabsMode.returnTo || tabsMode.returnTo.kind === 'none')) tabsMode.returnTo = back;
    // 分頁模式沒進成（enterAt 掛了）：別讓側欄停在空白——直接把落點內容載上來
    if (!tabsMode.active && back) {
      if (back.kind === 'crow') await openRecent(back.meta.hours, null);
      else if (back.kind === 'folder') await tree.lock(back.path);
    }
  } catch (_) { /* 落點補不上就算了：離開分頁時 restore 的 none 路徑會退到第一個根 */ }
}
// 側欄已開著時，背景轉來 {rifflePanel:'tab-focus'} 叫這裡捲到那張卡
if (PANEL) {
  addEventListener('message', ev => {
    if (ev.source !== window.parent) return;    // 只有外層側欄頁能叫這裡捲
    const d = ev && ev.data;
    if (!d || d.rifflePanel !== 'tab-focus') return;
    tabsMode.focusTab(d.tabId);
  });
}

// ---------------------------------------------------------------- 側欄「回到完整畫面」
// 頂列 ⤢ 鈕（按鈕提示也寫著 Alt+Shift+R）：聚焦既有 RiffleDesk 完整視窗（沒有就開一個
// 停在同一張卡）＋收起側欄——全部交給擴充做（直送訊息，跟點卡同路線）；擴充不在
// （手動 ?mode=panel 打開的分頁）就退回只定位：POST /api/tabs/focus 請完整視窗捲過去。
// 另：每 0.7s 把「側欄現在看哪張卡」回報給擴充，Alt+Shift+R 在側欄 focus 時照它定位。
if (PANEL) {
  const bf = document.getElementById('btnBackToFull');
  if (bf) bf.addEventListener('click', async () => {
    const front = tabsMode.active ? tabsMode.frontTabId() : 0;
    const r = await tabsMode._extOp({ type: 'riffle-back-to-full', tabId: front }, 1500);
    if (r && r.ok === true) return;      // 擴充收下了：聚焦＋定位＋收側欄它全包
    if (front) {
      apiJson('/api/tabs/focus', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tabId: front })
      }).catch(() => {});
    }
  });
  let lastFrontPing = 0;
  setInterval(() => {
    if (!tabsMode.active) return;
    const id = tabsMode.frontTabId();
    if (id && id !== lastFrontPing) {
      lastFrontPing = id;
      tabsMode._extOp({ type: 'riffle-panel-front', tabId: id }, 800);
    }
  }, 700);
}

// ---------------------------------------------------------------- 網址開一疊（?pile=<id>）
// 沒有分頁可推時 CLI 改開這種網址。跟 ?open= 一樣立刻把參數拿掉；打不開就留一句提示。
async function bootUrlPile() {
  const params = new URLSearchParams(location.search);
  if (!params.has('pile')) return;
  const id = params.get('pile');
  params.delete('pile');
  const qs = params.toString();
  try { history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash); } catch (_) {}
  if (!id) return;
  // 只有一個檔的疊：等同單檔投影，直接開檔（走 projectOpen → wide 大版面）
  let files = null;
  try {
    const d = await apiJson('/api/pile?id=' + encodeURIComponent(id));
    files = d.files || [];
  } catch (_) { /* 取不到就退回 openPile，讓它自己報錯 */ }
  if (files && files.length === 1) {
    const opened = await projectOpen(files[0].path).catch(() => false);
    if (!opened) toast(t('pileNone'));
    return;
  }
  const opened = await openPile(id, null).catch(() => false);
  if (!opened) toast(t('pileNone'));
}

// ---------------------------------------------------------------- 網址投影（?open=<路徑>[&line=N]）
// CLI 沒有分頁可推時改用預設瀏覽器開這種網址；這裡讀回來，走跟推送投影同一條路開檔。
// open/line 一律立刻從網址拿掉（成功、失敗、連載入都還沒開始都一樣）：之後重新整理不會
// 再開一次。其他既有參數原樣保留。
async function bootUrlOpen() {
  const params = new URLSearchParams(location.search);
  if (!params.has('open')) return;
  const path = params.get('open');
  const line = Number(params.get('line')) || 0;
  params.delete('open');
  params.delete('line');
  const qs = params.toString();
  const clean = location.pathname + (qs ? '?' + qs : '') + location.hash;
  try { history.replaceState(history.state, '', clean); } catch (_) {}
  if (!path) { toast(t('projGone', { name: '' })); return; }
  const opened = await requestUrlOpen(path, line).catch(() => false);
  if (!opened) toast(t('projGone', { name: splitPath(path).name || path }));
}
stack.poke();
if (stack.renderer) stack.renderer.render(stack.scene, stack.camera);   // 沒有 3D 時沒有 renderer

// ---------------------------------------------------------------- test hooks
window.__dbg = {
  stack: () => stack.dbg(),
  panelMode: () => PANEL,
  uiZoom: () => panelZoom,
  setUiZoom: z => setPanelZoom(z),
  badgeZone: (u, v) => tabBadgeAt(u, v, { ai: PANEL }),
  selProbe: () => {
    // e2e（滾動不順／卡堆上不畫框）：逐幀取樣每張卡畫面上的位置與大小。
    // 用「檔名」認卡（滾動時 slot 會換綁，fileIdx 會變）。
    // 卡堆上已經沒有任何框線物件了，所以這裡只回卡片自己的狀態；
    // scale 是 mesh 的區域縮放（選取不得改變它）。
    // 卡片用「路徑」認（同名檔不打架；滾動時 slot 會換綁，fileIdx 會變）。
    const st = stack;
    const out = { scroll: +(st.scrollCur || 0).toFixed(3), sel: st.selected.size, cards: [] };
    for (const s of st.slots || []) {
      if (!s.file || !s.mesh || s.mode !== 'home') continue;
      const c = st.cardScreen(s.fileIdx);
      out.cards.push({
        n: s.file.name,
        p: s.file.path,
        op: +s.opacity.toFixed(2),
        sc: +s.mesh.scale.x.toFixed(3),
        x: c ? +c.x.toFixed(2) : null, y: c ? +c.y.toFixed(2) : null,
        sel: st.selected.has(s.file.path) ? 1 : 0
      });
    }
    return out;
  },
  scene: () => stack,
  mode: () => mode,
  fracs: () => ({ ...fracs }),
  setFracs: f => { fracs = f; applyFracs(fracs); },
  avgFps: () => stack.avgFps(),
  resetFps: () => stack.resetFps(),
  heap: () => (performance.memory ? performance.memory.usedJSHeapSize : 0),
  clickToTextMs: () => clickToTextMs,
  folderSwitchMs: () => stack.lastFolderSwitchMs,
  setParam: (k, v) => {
    if (!Object.hasOwn(P, k)) return;
    v = Number(v);
    if (!Number.isFinite(v)) return;
    P[k] = v; stack.poke();
  },
  cardScreen: i => stack.cardScreen(i),
  viewRect: () => ({ x: stack.viewCss.x, y: toolbarH(), w: stack.viewCss.w, h: canvas.clientHeight || innerHeight - toolbarH() }),
  viewGL: () => stack.glViewportCss(),
  viewGLRaw: () => stack.glViewportRaw(),
  slotTex: () => stack.slotTex(),
  selRows: () => [...treeEl.querySelectorAll('.trow.sel')].map(r => r.dataset.path),
  previewRows: () => [...treeEl.querySelectorAll('.trow.preview')].map(r => r.dataset.path),
  cornerBounds: () => stack.cornerBoundsCss(),
  visibleCards: () => stack.visibleCards(),
  pickAt: (x, y) => stack.pickAtCss(x, y),
  meshVisible: i => stack.cardMeshVisible(i),
  exposedRatio: i => stack.exposedRatio(i),
  setFit: o => stack.setFitOverride(o),
  hoverNow: d => { stack.hoverD = d; stack._hoverCand = null; stack.poke(); },
  fitProbe: (vis, gap, pitch, cy, cz) =>
    stack._dbgSolveFit ? stack._dbgSolveFit(vis, gap, pitch, cy == null ? null : { cy, cz }) : null,
  cardBounds: i => stack.cardBoundsCss(i),
  cardEdges: i => stack.cardEdgeWidthsCss(i),
  fileNames: n => stack.view.slice(0, n || 40).map(f => f.name),
  filePaths: n => stack.view.slice(0, n || 40).map(f => f.path),
  openFileByName: name => {
    const f = stack.view.find(x => x.name === name);
    if (f) { stack.onCardClick(f); return true; }
    return false;
  },
  fileSecret: i => !!(stack.view[i] && stack.view[i].secret),
  selClick: (i, range) => stack.selectClick(i, !!range),
  selClear: () => stack.clearSelection(),
  selAll: () => stack.selectAll(),
  selCount: () => stack.selectedFiles().length,
  allSelected: () => stack.allSelected(),
  selAllState: () => {
    const b = document.getElementById('btnSelAll');
    return { pressed: b.getAttribute('aria-pressed'), on: b.classList.contains('on'),
      title: b.title, barLabel: selBar.querySelector('[data-act=all]').textContent };
  },
  selectChip: id => {
    const b = chipsEl.querySelector(`[data-chip="${id}"]`);
    if (b) b.click();
  },
  chipsOn: () => [...chipsOn],
  lockedFolder: () => lockedFolder,
  // 唯一的「目前選取」：偽資料夾回 'crow:…'，真資料夾回路徑（e2e 驗 hover/鎖定還原用）
  lockedSel: () => convoState ? (convoState.kind === 'recent' ? 'crow:recent' + convoState.hours : (convoState.kind === 'changed' ? 'crow:changed' + convoState.hours : 'crow:convo:' + convoState.id)) : lockedFolder,
  crowRect: text => {
    const r = [...document.querySelectorAll('#convos .crow')].find(x => x.textContent.includes(text));
    if (!r || r.offsetParent === null) return null;
    const b = r.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  },
  treeRows: () => [...treeEl.querySelectorAll('.trow')].map(r => r.dataset.path),
  treeRowRect: path => {
    const r = [...treeEl.querySelectorAll('.trow')].find(x => x.dataset.path === path);
    if (!r) return null;
    const b = r.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  },
  readerText: () => reader.body.innerText.slice(0, 80),
  // 改版模式（e2e 用）：狀態、清單、存檔
  revise: () => ({ on: reader.revise.active(), items: reader.revise.items.map(i => ({ n: i.n, op: i.op })), frame: !!reader.revise.iframe }),
  reviseSave: () => reader.revise.save(false),
  reviseFrameSrc: () => (reader.revise.iframe && reader.revise.iframe.src) || null,
  reviseListText: () => (document.getElementById('reviseList') || {}).innerText || '',
  panel: () => ({ open: reader.el.classList.contains('open'), shown: reader.el.classList.contains('show'), file: reader.file && reader.file.name }),
  expandTreeNode: path => {
    const n = tree.nodes.get(String(path).replace(/[/\\]+$/, '').toLowerCase());
    if (n) return tree.toggle(n);
    return null;
  },
  lockFolder: path => tree.lock(path),
  // 方向鍵＝走左樹的測試鉤子
  nav: dir => navMove(dir),
  navRows: () => navableRows().map(r => r.kind === 'crow' ? ('crow:' + (r.meta.hours != null ? 'recent' + r.meta.hours : (r.meta.changedHours != null ? 'changed' + r.meta.changedHours : r.meta.id))) : r.row.dataset.path),
  focusIdx: () => clamp(Math.round(stack.scrollCur), 0, Math.max(0, stack.view.length - 1)),
  fitGap: () => Math.abs(stack.fitCur.dist - stack.fitTarget.dist) + stack.fitCur.target.distanceTo(stack.fitTarget.target),
  openReader: i => (mode !== 'twocol' ? stack.switchReading(i) : stack.extractFile(i, stack.getReaderRect())),
  closeReader: () => putBack(),
  setMode: m => { if (MODES[m]) setMode(m); },
  setTreeCollapsed: v => setTreeCollapsed(!!v),
  treeCollapsed: () => treeCollapsed,
  // 相機狀態（「關閱讀欄要回到我的視角」驗收用）：orbit＝使用者視角、fitCur＝實際相機解
  camera: () => ({
    orbit: { ...stack.orbit },
    fit: { dist: stack.fitCur.dist, pitch: stack.fitCur.pitch, yaw: stack.fitCur.yaw || 0,
      target: stack.fitCur.target.toArray() },
    fav: stack.favView()
  }),
  // 用同一套 orbit 模型「亂轉」相機（不必真的拖滑鼠）
  setOrbit: (yaw, pitch, zoom) => {
    stack.orbit.yaw = clamp(yaw, -30, 30);
    stack.orbit.pitch = clamp(pitch, 22, 65);
    stack.orbit.zoom = clamp(zoom, 0.7, 1.8);
    stack.poke();
    if (stack.notifyView) stack.notifyView();
  },
  // 視角提示列狀態（e2e 用）：differs＝目前視角偏離我的視角；bar＝提示列真的看得見
  viewState: () => {
    const vb = document.getElementById('viewBar');
    // 注意 #viewBar 是 position:fixed，offsetParent 恆為 null，只能用 getClientRects 判有沒有版面
    const shown = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).opacity !== '0';
    return {
      differs: stack.viewDiffers(),
      bar: shown(vb) && vb.classList.contains('show'),
      hasFav: !!stack.favView(),
      saveShown: shown(document.getElementById('btnViewSave')),
      favShown: shown(document.getElementById('btnViewFav'))
    };
  },
  saveFavView: () => stack.saveFavView(),
  clearFavView: () => {
    try { localStorage.removeItem('floderMyView'); } catch (_) {}
    stack._favCache = undefined;
    try { delete window.__rifflePrefsBoot.favView; } catch (_) {}   // 開機快照那份也清：favView() 的第二兜底，不清下次讀又被撿回
    postSharedPrefs({ favView: null });   // 共享那份也清——抽屜靠它兜底，不清會被撿回去
    stack.notifyView();
  },
  sharedPrefs: () => sharedPrefsNow(),
  setTheme: n => setTheme(n),
  // 投影（project.js）的測試鉤子：直接餵一個事件、假裝分頁在背景、讀最近清單
  project: data => handleProject(data),
  projHidden: v => setHiddenForTest(v),
  projClickNotif: () => clickNotification(),
  projRecent: () => [...document.querySelectorAll('#projRecent .proj-row .nm')].map(e => e.textContent),
  projSplit: p => splitPath(p),
  // 疊（pile）的測試鉤子
  pile: data => handlePile(data),
  pileOpen: id => openPile(id, pileRowFor(id)),
  pileClose: () => closePile(),
  pileClickToast: () => clickPileToast(),
  pileState: () => (pileState ? { id: pileState.id, title: pileState.title, n: pileState.files.length } : null),
  pileBar: () => (pathBar.classList.contains('on') ? pathBar.textContent : ''),
  pileRows: () => [...document.querySelectorAll('#projPiles .pile-row')].map(r => r.dataset.pile),
  projLine: () => {
    const m = document.querySelector('#readerBody .proj-line');
    return m ? Math.round(parseFloat(m.style.top)) : null;
  },
  readerScrollTop: () => reader.body.scrollTop,
  // 分頁模式（tabs.js）的測試鉤子：狀態、模擬單擊；卡面 ×／⧉ 的投縮放後螢幕座標（e2e 點卡角用）
  tabs: () => tabsMode._dbg(),
  tabBadges: which => stack.tabBadgePositions(which === 'ai' ? TAB_AI_ZONE : TAB_X_ZONE),
  tabZone: (i, which) => stack.cardZoneCss(i, which === 'ai' ? TAB_AI_ZONE : TAB_X_ZONE),
  tabsEnter: () => tabsMode.enter(),
  // 測試鉤子：直接把分頁卡送進右欄預覽（等於完整版點卡）；回 false＝那張不是分頁卡
  tabsPreview: i => { const f = stack.view[i]; if (f && f.tab) { openInReader(f); return true; } return false; },
  tabsExit: () => tabsMode.exit(),
  ready: () => !!lockedFolder && stack.files.length >= 0
};

// ---------------------------------------------------------------- 設定面板（⚙）：主題、字型、語言、說明
const settingsEl = document.getElementById('settings');
const btnSettings = document.getElementById('btnSettings');
const serviceStatus = document.getElementById('serviceStatus');
const serviceRestart = document.getElementById('serviceRestart');
const serviceStop = document.getElementById('serviceStop');
let currentService = null;
async function refreshService() {
  serviceStatus.textContent = t('serviceChecking');
  serviceRestart.disabled = serviceStop.disabled = true;
  try {
    const response = await fetch('/api/service', { signal: AbortSignal.timeout(2500) });
    if (!response.ok) { serviceStatus.textContent = t('serviceOld'); return; }
    currentService = await response.json();
    serviceStatus.textContent = t('serviceRunning', { version: currentService.version });
    serviceRestart.disabled = serviceStop.disabled = false;
  } catch (_) { serviceStatus.textContent = t('serviceUnavailable'); }
}
async function controlService(action) {
  if (!currentService || (action === 'stop' && !confirm(t('serviceStopConfirm')))) return;
  serviceRestart.disabled = serviceStop.disabled = true;
  try {
    const previous = currentService.instanceId;
    const response = await fetch(`/api/service/${action}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: previous }),
      signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('service request failed');
    serviceStatus.textContent = t(action === 'stop' ? 'serviceStopped' : 'serviceRestarting');
    if (action === 'stop') return;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 400));
      try {
        const next = await fetch('/api/service', { signal: AbortSignal.timeout(1000) }).then(r => r.json());
        if (next.instanceId && next.instanceId !== previous) { location.reload(); return; }
      } catch (_) {}
    }
    throw new Error('restart timed out');
  } catch (_) {
    serviceStatus.textContent = t('serviceUnavailable');
    serviceRestart.disabled = serviceStop.disabled = false;
  }
}
serviceRestart.addEventListener('click', () => controlService('restart'));
serviceStop.addEventListener('click', () => controlService('stop'));
function closeSettings() {
  if (!settingsEl.classList.contains('on')) return false;
  settingsEl.classList.remove('on'); btnSettings.classList.remove('on'); return true;
}
btnSettings.addEventListener('click', () => {
  const on = !settingsEl.classList.contains('on');
  settingsEl.classList.toggle('on', on); btnSettings.classList.toggle('on', on);
  if (on) { hideTip(); refreshService(); }
});
addEventListener('pointerdown', e => {
  if (!settingsEl.contains(e.target) && !btnSettings.contains(e.target)) closeSettings();
}, true);
{
  const light = document.getElementById('btnThemeLight'), dark = document.getElementById('btnThemeDark');
  const sync = () => { light.classList.toggle('on', themeNow() === 'light'); dark.classList.toggle('on', themeNow() !== 'light'); };
  light.addEventListener('click', () => { setTheme('light'); sync(); });
  dark.addEventListener('click', () => { setTheme('dark'); sync(); });
  sync();
  const zh = document.getElementById('btnLangZh'), en = document.getElementById('btnLangEn');
  zh.classList.toggle('on', LANG === 'zh'); en.classList.toggle('on', LANG === 'en');
  zh.addEventListener('click', () => setLang('zh'));
  en.addEventListener('click', () => setLang('en'));
  // HTML「預設執行網頁程式」開關（reader.js 每次打開檔案時當場讀這個值）
  const htmlRun = document.getElementById('htmlRun');
  try { htmlRun.checked = localStorage.getItem('riffleHtmlRun') === '1'; } catch (_) {}
  htmlRun.addEventListener('change', () => {
    try { htmlRun.checked ? localStorage.setItem('riffleHtmlRun', '1') : localStorage.removeItem('riffleHtmlRun'); } catch (_) {}
    reader.htmlRunMaybeChanged();   // 正在看的 HTML 立刻套用（逐檔按過 ▶ 的不動）
  });
  // 程式碼配色（⚙ 下拉＋閱讀區迷你選單共用；換色時卡面縮圖跟著重畫）
  initCodeTheme({ uiTheme: themeNow, onChange: () => refreshLook() });
}

// 操作說明：設定面板裡一份；第一次使用另外跳一張提示卡，按「知道了」後不再出現
const TIP_KEY = 'riffleTipSeen';
for (const ul of document.querySelectorAll('ul.help')) {
  // help1..helpN 連號為止（t() 沒這個 key 時原樣回傳 key，拿來當中止條件）
  for (let i = 1; ; i++) {
    const s = t('help' + i);
    if (s === 'help' + i) break;
    const li = document.createElement('li'); li.textContent = s; ul.appendChild(li);
  }
}
const tipEl = document.getElementById('hint');
const tipAgain = document.getElementById('tipAgain');
function tipSeen() { try { return localStorage.getItem(TIP_KEY) === '1'; } catch (_) { return false; } }
function hideTip() {
  if (!tipEl.classList.contains('on')) return false;
  // 看不見的說明（例如側欄模式用 CSS 藏起來）不能吃掉 Esc：靜靜收掉、讓 Esc 繼續往下走
  const shown = tipEl.getClientRects().length > 0 && getComputedStyle(tipEl).visibility !== 'hidden';
  if (!shown) { tipEl.classList.remove('on'); return false; }
  tipEl.classList.remove('on');
  try { localStorage.setItem(TIP_KEY, '1'); } catch (_) {}
  tipAgain.checked = false;
  return true;
}
tipEl.querySelector('.foot button').addEventListener('click', hideTip);
tipAgain.checked = !tipSeen();
tipAgain.addEventListener('change', () => {
  try { tipAgain.checked ? localStorage.removeItem(TIP_KEY) : localStorage.setItem(TIP_KEY, '1'); } catch (_) {}
});
if (!tipSeen()) tipEl.classList.add('on');

// 完整路徑列：卡堆左上角，每一段可點（跳到那一層），最後有複製鈕；太長換行不截斷
const pathBar = document.getElementById('pathBar');
let pathNow = '';
function showPath(p) {
  pathNow = p || '';
  pathBar.querySelector('.copy').style.display = '';   // 偽資料夾會藏起來，真路徑要還原
  const crumbs = pathBar.querySelector('.crumbs');
  crumbs.textContent = '';
  pathBar.classList.toggle('on', !!pathNow);
  if (!pathNow) return;
  pathBar.title = pathNow;
  const sep = pathNow.includes('\\') ? '\\' : '/';
  const parts = pathNow.split(/[\\/]+/);
  let acc = '';
  parts.forEach((part, i) => {
    if (i === 0) acc = part === '' ? '/' : part + sep;          // 'D:' → 'D:\'；posix 開頭空字串 → '/'
    else acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
    if (part === '' && i > 0) return;
    if (i > 0 && !(i === 1 && parts[0] === '')) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = sep; crumbs.appendChild(s); }
    const el = document.createElement('span');
    el.className = 'seg' + (i === parts.length - 1 ? ' last' : '');
    el.textContent = part || '/';
    el.title = t('pathCrumb');
    const target = acc;
    el.addEventListener('click', () => { if (norm(target) !== norm(lockedFolder || '')) tree.lock(target); });
    crumbs.appendChild(el);
  });
}
function norm(p) { return String(p).replace(/[/\\]+$/, '').toLowerCase(); }
pathBar.querySelector('.copy').addEventListener('click', () => { if (pathNow) copyText(pathNow); });
stack.pathBarEl = pathBar;
attachScrubber(stack);

// chips 放不下時：滾輪直接橫捲，兩端淡出提示「還有」
{
  const fade = () => {
    chipsEl.style.setProperty('--fl', chipsEl.scrollLeft > 2 ? '18px' : '0px');
    chipsEl.style.setProperty('--fr', chipsEl.scrollLeft + chipsEl.clientWidth < chipsEl.scrollWidth - 2 ? '18px' : '0px');
  };
  chipsEl.addEventListener('wheel', e => {
    if (chipsEl.scrollWidth <= chipsEl.clientWidth) return;
    e.preventDefault(); chipsEl.scrollLeft += e.deltaY + e.deltaX;
  }, { passive: false });
  chipsEl.addEventListener('scroll', fade);
  addEventListener('resize', fade);
  setTimeout(fade, 0);
}

// ---------------------------------------------------------------- font
buildFontMenu(document.getElementById('fontSel'), msg => toast(msg));
applyFont(savedFontId(), { repaint: savedFontId() !== 'system' });

// ---------------------------------------------------------------- file actions（右鍵選單＋閱讀區「⋯」）
const menuEl = document.getElementById('ctxMenu');
function closeMenu() { if (!menuEl.classList.contains('on')) return false; menuEl.classList.remove('on'); return true; }
addEventListener('pointerdown', e => { if (!menuEl.contains(e.target)) closeMenu(); }, true);
addEventListener('blur', closeMenu);

async function copyText(v) {
  try { await navigator.clipboard.writeText(v); toast(t('copied', { v: v.length > 60 ? '…' + v.slice(-58) : v })); }
  catch (_) { toast(t('opFail', { msg: 'clipboard' })); }
}
async function postOp(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 404) throw new Error(t('opUnavailable'));
  let d = {}; try { d = await r.json(); } catch (_) {}
  if (!r.ok || d.ok === false) throw new Error(d.error || ('http ' + r.status));
  return d;
}
function parentDir(p) { return p.replace(/[\\/][^\\/]*$/, '') || p; }
function refreshAfterChange(file) {
  for (const k of [...dirCache.keys()]) if (k.startsWith(parentDir(file.path) + '|')) dirCache.delete(k);
  convoFilesCache.clear();   // 偽資料夾的檔案清單也別信舊的（刪掉的檔要消失）
  if (stack.extracted && reader.file && reader.file.path === file.path) putBack();
  if (lockedFolder) loadFolder(lockedFolder);
  else if (pileState) reloadPile();
  else if (convoState) loadPseudo();
}

// Ctrl+Z 復原（改名／刪除）。批次刪除共用一個 group id，整批算一步。
const undo = createUndo({
  toast,
  onRestored: (d) => {
    // 每個受影響路徑把該資料夾的快取清掉，重新載入目前視圖
    const dirs = new Set((d.paths || []).map(p => parentDir(p)));
    for (const k of [...dirCache.keys()]) if (dirs.has(k.split('|')[0])) dirCache.delete(k);
    convoFilesCache.clear();
    // 復原的正是正在編輯的檔（undo 一次存檔）：留在編輯器裡，改成磁碟上的版本
    const inEditor = reader.file && reader.editing() && (d.paths || []).includes(reader.file.path);
    if (inEditor) {
      reader.editor.dirty = false;
      reader.open({ ...reader.file, mtime: Date.now() }).then(() => reader.startEdit()).catch(() => {});
    } else if (stack.extracted && reader.file && (d.paths || []).includes(reader.file.path)) putBack();
    if (lockedFolder) loadFolder(lockedFolder);
    else if (pileState) reloadPile();
    else if (convoState) loadPseudo();
  }
});
reader.toast = toast;
reader.undoAction = undo.undoAction;
document.getElementById('btnUndoTop').addEventListener('click', () => undo.undoLast());

function openMenu(file, x, y) {
  if (file.tab) {
    // 分頁卡的右鍵選單：改名／垃圾桶／找對話這些檔案操作不適用
    if (file.tab.note) return;   // 安裝說明卡不給選單
    const tabItems = [
      ['tabsActivate', () => tabsMode.activateTab(file.tab)],
      ['mOpen', () => { const i = stack.view.indexOf(file); if (mode !== 'twocol') stack.switchReading(i); else stack.extractFile(i, stack.getReaderRect()); }],
      null,
      ['tabsCopyUrl', () => copyText(file.tab.url)],
      ['tabsOpenNew', () => postOp('/api/tabs/action', { op: 'open', url: file.tab.url }).catch(e => toast(t('opFail', { msg: e.message })))]
    ];
    renderMenuItems(file, tabItems, x, y);
    return;
  }
  const items = [
    ['mOpen', () => { const i = stack.view.indexOf(file); if (mode !== 'twocol') stack.switchReading(i); else stack.extractFile(i, stack.getReaderRect()); }],
    null,
    ['mCopyPath', () => copyText(file.path)],
    ['mCopyName', () => copyText(file.name)],
    ['mCopyDir', () => copyText(parentDir(file.path))],
    ['mWhichConvo', () => whichConvo(file)],
    null,
    ['mReveal', () => postOp('/api/reveal', { path: file.path }).catch(e => toast(t('opFail', { msg: e.message })))],
    ['mOpenApp', () => postOp('/api/open', { path: file.path }).catch(e => toast(t('opFail', { msg: e.message })))],
    null,
    ['mRename', () => renameFlow(file)],
    ['mTrash', () => trashFlow(file), 'danger']
  ];
  const selN = stack.selected.size;
  if (selN > 1 && stack.selected.has(file.path)) items.push(null, ['mTrashSel', () => batchTrash(stack.selectedFiles()), 'danger', { n: selN }]);
  else if (stack.view.indexOf(file) >= 0) items.splice(1, 0, ['mSelect', () => stack.selectClick(stack.view.indexOf(file), false)]);
  renderMenuItems(file, items, x, y);
}

function renderMenuItems(file, items, x, y) {
  menuEl.innerHTML = '';
  const head = document.createElement('div'); head.className = 'head'; head.textContent = file.name; menuEl.appendChild(head);
  for (const it of items) {
    if (!it) { const sp = document.createElement('div'); sp.className = 'sep'; menuEl.appendChild(sp); continue; }
    const [key, fn, cls, vars] = it;
    if (key === 'mOpen' && stack.view.indexOf(file) < 0) continue;
    const d = document.createElement('div'); d.className = 'it' + (cls ? ' ' + cls : ''); d.textContent = t(key, vars);
    d.addEventListener('click', () => { closeMenu(); fn(); });
    menuEl.appendChild(d);
  }
  menuEl.classList.add('on');
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menuEl.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
stack.onCardMenu = (file, x, y) => openMenu(file, x, y);
document.getElementById('btnMore').addEventListener('click', e => {
  if (!reader.file) return;
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(reader.file, r.left - 160, r.bottom + 4);
  e.stopPropagation();
});

// 右鍵選單「是哪則對話做的？」：問伺服器哪則對話寫過這個檔，直接打開最新那則
async function whichConvo(file) {
  try {
    const d = await apiJson('/api/whichconvo?path=' + encodeURIComponent(file.path));
    if (!d.convos || !d.convos.length) { toast(t('convoNone')); return; }
    openConvo(d.convos[0], null);   // 回傳已按新→舊排
  } catch (e) { toast(t('opFail', { msg: e.message })); }
}

// ---- 自製對話框（不用瀏覽器的 prompt/confirm：那會卡住整個頁面）
const dlg = document.getElementById('dlg');
let dlgDone = null;
function closeDlg() { if (!dlg.classList.contains('on')) return false; dlg.classList.remove('on'); if (dlgDone) dlgDone(null); return true; }
function ask({ title, body, input, ok, danger }) {
  return new Promise(res => {
    dlg.querySelector('.ttl').textContent = title;
    dlg.querySelector('.body').textContent = body || '';
    const inp = dlg.querySelector('.inp');
    inp.style.display = input == null ? 'none' : '';
    if (input != null) inp.value = input;
    const yes = dlg.querySelector('.yes'), no = dlg.querySelector('.no');
    yes.textContent = ok; no.textContent = t('cancel');
    yes.classList.toggle('danger', !!danger);
    dlgDone = v => { dlgDone = null; dlg.classList.remove('on'); res(v); };
    yes.onclick = () => dlgDone && dlgDone(input == null ? true : inp.value);
    no.onclick = () => dlgDone && dlgDone(null);
    inp.onkeydown = e => { if (e.key === 'Enter') yes.onclick(); if (e.key === 'Escape') no.onclick(); };
    dlg.classList.add('on');
    if (input != null) {
      inp.focus();
      const dot = input.lastIndexOf('.');
      inp.setSelectionRange(0, dot > 0 ? dot : input.length);   // 預設只選主檔名，不選副檔名（同 Windows）
    } else yes.focus();
  });
}
async function renameFlow(file) {
  const v = await ask({ title: t('renameTitle'), body: file.path, input: file.name, ok: t('renameOk') });
  if (!v || v === file.name) return;
  try { await postOp('/api/rename', { path: file.path, newName: v.trim() }); toast(t('opDone', { v: v.trim() }), undo.undoAction()); refreshAfterChange(file); }
  catch (e) { toast(t('opFail', { msg: e.message })); }
}
async function trashFlow(file) {
  const ok = await ask({ title: t('trashTitle'), body: t('trashBody', { name: file.name }), ok: t('trashOk'), danger: true });
  if (!ok) return;
  try { await postOp('/api/trash', { path: file.path }); toast(t('opDone', { v: file.name }), undo.undoAction()); refreshAfterChange(file); }
  catch (e) { toast(t('opFail', { msg: e.message })); }
}

// ---------------------------------------------------------------- 多選＋批次
const selBar = document.getElementById('selBar');
const btnSelAll = document.getElementById('btnSelAll');
const selAllBtn = selBar.querySelector('[data-act=all]');
selBar.querySelector('[data-act=copy]').textContent = t('selCopy');
selBar.querySelector('[data-act=trash]').textContent = t('selTrash');
selBar.querySelector('[data-act=clear]').textContent = t('selClear');
selBar.querySelector('.hint').textContent = t('selHint');
// 「全選」是切換鈕：已全選就變「取消全選」，按下去清空。按鈕同時反映按下態與 aria-pressed。
// 這幾顆的文案／提示由 JS 全權管理（不放 data-i18n-title，否則語言切換會蓋回「全選」）。
function syncSelectAllUi(all) {
  const on = !!all;
  for (const b of [btnSelAll, selAllBtn]) {
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const label = t(on ? 'selNone' : 'selAll');
  const title = t(on ? 'selNoneTitle' : 'selAllTitle');
  btnSelAll.title = title;
  btnSelAll.setAttribute('aria-label', title);
  selAllBtn.textContent = label;
}
syncSelectAllUi(false);
stack.onSelection = files => {
  const all = !!stack.allSelected();
  // 分頁卡不是本機檔案：選取列（複製路徑／丟垃圾桶）不適用，藏起來
  selBar.classList.toggle('on', files.length > 0 && !tabsMode.active);
  selBar.querySelector('.n').textContent = t('selCount', { n: files.length });
  const v = stack.viewCss;
  selBar.style.left = Math.round(v.x + v.w / 2) + 'px';
  syncSelectAllUi(all);
};
btnSelAll.addEventListener('click', () => stack.toggleSelectAll());
selBar.addEventListener('click', e => {
  const act = e.target.dataset && e.target.dataset.act;
  if (act === 'copy') copyText(stack.selectedFiles().map(f => f.path).join('\n'));
  else if (act === 'trash') batchTrash(stack.selectedFiles());
  else if (act === 'all') stack.toggleSelectAll();
  else if (act === 'clear') stack.clearSelection();
});
async function batchTrash(files) {
  if (!files.length) return;
  const list = files.slice(0, 8).map(f => '• ' + f.name).join('\n') + (files.length > 8 ? `\n… +${files.length - 8}` : '');
  const ok = await ask({ title: t('batchTrashTitle', { n: files.length }), body: t('batchTrashBody', { list }), ok: t('trashOk'), danger: true });
  if (!ok) return;
  let okN = 0, failN = 0, lastErr = '';
  const gid = newGroup();            // 整批同一個 group id → Ctrl+Z 一步復原全部
  for (const f of files) {                       // 一個一個來：哪個失敗都清楚，不會半途全炸
    try { await postOp('/api/trash', { path: f.path, group: gid }); okN++; }
    catch (e) { failN++; lastErr = e.message; if (/伺服器需更新|server needs an update/.test(lastErr)) break; }
  }
  toast(t('batchDone', { ok: okN, fail: failN ? t('batchFailPart', { n: failN, msg: lastErr }) : '' }), okN ? undo.undoAction() : null);
  stack.clearSelection();
  if (okN) refreshAfterChange(files[0]);
}

// ---------------------------------------------------------------- 全螢幕（瀏覽器的分頁列、網址列都蓋掉）
{
  const btn = document.getElementById('btnFull');
  const sync = () => { btn.textContent = document.fullscreenElement ? '🗗' : '⛶'; };
  btn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch (_) {}
  });
  document.addEventListener('fullscreenchange', sync);
  sync();
}

// 投影：AI 推來一個檔 → 切到它所在的資料夾並在閱讀面板打開（帶 line 就捲到那行）。
// 這裡只管「打開」，搶不搶前景由 project.js 決定。
// `path.dirname` 的瀏覽器版：單看分隔符會把根層檔算錯（'C:\\a.md' → 'C:'、
// '/a.md' → ''），所以「切完是磁碟代號或空字串」時補回分隔符。
function splitPath(p) {
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  if (i < 0) return { dir: '', name: s };
  let dir = s.slice(0, i), name = s.slice(i + 1);
  if (!dir) dir = s[i];                                              // '/a.md' → '/'
  else if (/^[A-Za-z]:$/.test(dir)) dir = dir + s[i];                // 'C:\\a.md' → 'C:\\'
  return { dir, name };
}

let projSeq = 0;   // 連續投影的世代號：後到的取代先到的，慢的那次結果丟掉
// 回傳 true＝打開了、false＝打不開（路徑不存在／沒權限／被後到的投影取代）
async function projectOpen(path, line) {
  const seq = ++projSeq;
  const stale = () => seq !== projSeq;
  const { dir, name } = splitPath(path);
  if (!dir) { toast(t('projGone', { name })); return false; }
  // 鍵盤導航可能有一趟載入還在等：投影是明確意圖，取消它，別让它半路蓋掉
  clearTimeout(navTimer); navTimer = null;
  previewCrowCancel();
  if (norm(dir) !== norm(lockedFolder || '') || convoState) {
    exitPseudo(true);
    // 一律走 tree.lock()：樹內部的 lockedPath／選取列／麵包屑才會跟投影結果一致；
    // 節點還沒展開時 lock() 也照樣載入（只是沒有 .sel 可標）
    await tree.lock(dir);
    if (stale()) return false;
  }
  // chips 可能把這個類型濾掉了：卡堆裡找不到就另外向伺服器要（exts=all）拿檔案資訊
  let f = stack.files.find(x => norm(x.path) === norm(path));
  if (!f) {
    try {
      const d = await apiJson('/api/list?path=' + encodeURIComponent(dir) + '&exts=all');
      if (stale()) return false;
      f = (d.files || []).find(x => norm(x.path) === norm(path));
    } catch (_) {}
  }
  if (stale()) return false;
  if (!f) { toast(t('projGone', { name })); return false; }
  stack.readingPath = f.path;
  stack.poke();
  if (PANEL) reader.setOpen(true);   // 側邊欄：?open=／投影也走整欄閱讀覆層（以前開了個看不見的右欄）
  // 投影是明確意圖：直接給閱讀「2/3」大版面；已經是 wide／full 就原地換檔，不重切
  else if (mode === 'twocol' || mode === 'threecol') setMode('wide');
  reader.show();
  await reader.open(f);
  if (stale()) return false;
  if (line > 0) reader.scrollToLine(line);
  return true;
}

// HTML 裡點到本機檔案的連結：找出那個檔的資訊，在閱讀區打開（卡堆不動）
reader.onOpenPath = async (path, hash) => {
  const dir = path.replace(/[\\/][^\\/]*$/, ''), name = path.slice(dir.length + 1);
  try {
    const d = await apiJson('/api/list?path=' + encodeURIComponent(dir) + '&exts=all');
    const f = (d.files || []).find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!f) { toast(t('opFail', { msg: name })); return; }
    stack.readingPath = f.path; stack.poke();
    await reader.open(f);
    if (hash) {
      const ifr = document.querySelector('#readerBody iframe');
      const go = () => { try { const el = ifr.contentDocument.getElementById(decodeURIComponent(hash)); if (el) el.scrollIntoView(); } catch (_) {} };
      if (ifr) ifr.addEventListener('load', go, { once: true });
    }
  } catch (e) { toast(t('opFail', { msg: e.message })); }
};

// ---------------------------------------------------------------- live 更新（live.js 的回呼）
// 這裡只提供 live.js 需要的狀態與動作；SSE／藥丸／⟳／R 鍵／索引開關都在 live.js。
let convoRenderedFP = '';   // 目前左欄對話區渲染的是哪份清單（buildConvoSections 會更新）
function convoFingerprint(list) { return list.map(c => c.id + '@' + c.updated + ':' + c.fileCount).join('|'); }

// 藥丸點擊／⟳／R：重載目前資料夾（清掉自己的 dirCache）；正在讀的卡還在就繼續讀
async function reloadCurrentView() {
  const keep = mode !== 'twocol' ? reader.file : null;
  if (lockedFolder) {
    for (const k of [...dirCache.keys()]) if (k.startsWith(lockedFolder + '|')) dirCache.delete(k);
    await loadFolder(lockedFolder);
  } else if (convoState) {
    convoFilesCache.clear();
    convoListCache = { t: 0, data: null };
    await loadPseudo();
  } else {
    return;   // 只有 hover 預覽的過渡狀態：不動卡堆
  }
  if (!keep) return;
  const hit = stack.files.find(f => f.path === keep.path);
  if (hit) {
    stack.readingPath = hit.path; stack.poke();     // 卡堆裡繼續標「正在讀」
    if (hit.mtime !== keep.mtime || hit.size !== keep.size) reader.open(hit).catch(() => {});
  } else {
    putBack();   // 正在讀的檔案不見了：關掉閱讀面板
  }
}

function refreshTreeCounts() {
  const jobs = [];
  for (const arr of tree.twins.values()) for (const n of arr) if (n.loaded && n.row.isConnected) jobs.push(tree.refreshChildCounts(n));
  jobs.push(tree.refreshTopCounts(false));
  Promise.all(jobs).catch(() => {});
}

// SSE 送來 convos 事件：數字重抓；清單（標題／檔案數／時間）有變才重建區塊，選取保留
function liveConvosChanged() {
  convoFilesCache.clear();
  refreshConvoCounts();
  fetchConvoList(true).then(all => {
    const fp = convoFingerprint(all);
    if (fp === convoRenderedFP) return;
    const keep = convoState;   // 鎖定選取（對話或 今天/最近7天）跨重建保留
    buildConvoSections().then(() => {
      if (!keep) return;
      const m = keep.kind === 'convo' ? convoRowsMeta.find(x => x.id === keep.id)
                                      : recentRowsMeta.find(x => x.hours === keep.hours);
      if (m) m.row.classList.add('sel');
    });
  }).catch(() => {});
}

initLive({
  stack,
  panel: PANEL,                     // 側邊欄：SSE 掛 ?panel=1，投影／疊的廣播不發給它
  currentTarget: () => (convoState || pileState ? null : lockedFolder),
  isPseudo: () => !!(convoState || pileState),
  reload: reloadCurrentView,
  refreshTree: refreshTreeCounts,
  refreshConvos: liveConvosChanged,
  onTabs: () => { tabsMode.onServerPush(); refreshExtLive(); },
  // 側欄「回到完整畫面」：POST /api/tabs/focus 廣播只發給非側欄客戶端——捲到那張卡（順便進分頁模式）
  onTabFocus: id => tabsMode.focusTab(id)
});

initProject({ openPath: projectOpen, openPile, attachPileRow: (row, id) => tree.attachCrow(row, { id, pile: true }) });
initProjectSettings();

// ---- DOM 鏡像：sr-only 可讀區域給螢幕閱讀器／側欄 AI agent（細節全在 mirror.js）----
initMirror({ stack, openCard: f => stack.onCardClick(f), ctx: () => ({ contentQuery }) });
