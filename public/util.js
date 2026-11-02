// shared helpers + tunable params (localStorage)
export const TOOLBAR_H = 44;             // 工具列高度（css px）：canvas 頂端與所有 NDC/像素換算共用
// panel 模式的工具列是兩列（搜尋＋類型/模式切換），canvas 頂端跟著往下：
// 座標換算都該用這個，不要直接用 TOOLBAR_H 常數。
export function toolbarH() {
  if (typeof document === 'undefined' || !document.body || !document.body.classList.contains('panel-mode')) return TOOLBAR_H;
  // 側邊欄介面縮放（--panelZoom）只縮 DOM：頂列視覺高度＝82×z，卡堆畫布的 top 跟著走（index.html 的 calc）
  const z = parseFloat(document.body.style.getPropertyValue('--panelZoom'));
  return 82 * (Number.isFinite(z) && z > 0 ? z : 1);
}
export function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
export function fmtDate(ms) {
  const d = new Date(ms);
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// 卡面／閱讀器要看的「AI 到底幾點幾分動了它」。永遠用本機時區（Windows／Mac 同一份程式碼，
// 各看各的本地時間），刻意不做相對時間（「3 分鐘前」下一秒就過期，還得定時重畫卡面）。
export function fmtDateTime(ms) {
  const d = new Date(ms);
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
export function damp(cur, target, rate, dt) { // exponential damping, frame-rate independent
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}
export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
// 便宜的字串指紋（FNV-1a 32 位，回 8 個十六進位字元）。
// 「內容有沒有變」的比較用：data: URL favicon（24KB）、頁面文字（1500 字）這種長字串
// 每次都比全文太貴，先收成短雜湊。
export function shortHash(s) {
  const str = s == null ? '' : String(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export async function api(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ('http ' + r.status));
  return r;
}
export const apiJson = async (url, opts) => (await api(url, opts)).json();

// ---------------------------------------------------------------- tunables
// v8：FOV 預設 30→22（弱透視）＋取景包絡改算 hover 全覆蓋。版本號變 → 舊存檔整組重置。
export const PARAMS_VER = 9;   // v9：改用歐哥在擺位實驗室擺的姿態（fov 24），舊存檔作廢
export const P_DEFAULTS = {
  // v8 寬度優先＋真撥開：前排卡寬 = 右區寬 85%（左右各 ~7% 邊），高度放不下就少顯示
  // 幾張／縮間距，寬度不退讓。hover 撥開＝前方卡整組下壓＋繞底邊前倒（tilt°）＋往前滑，
  // 被指卡窄波抽高翻平、後方卡微後仰。全景只依右區實際寬高比解算，不寫死像素。
  // v8 改動：FOV 收窄到 22（20~26）壓掉梯形感；取景包絡改為「每個可見深度都算一次 hover」，
  // 杜絕中後段波峰被切。預設值由離線掃參（tests/_fitlab）定：85%寬＋撥開不切邊＋
  // 被指卡曝光≥半張 → 八種視窗全可行；lift/bend 再大包絡必出界，物理上限。
  fov: 24,       // 相機視角（20-26）；22 ≈ 極弱透視，卡面上緣/下緣寬比 ≥0.85（梯形幾乎看不出來）
  pitch: 73,     // camera elevation degrees (45-85)；陡一點後排才露得出內文
  minGap: 0.40,  // 卡片間距下限（世界單位）
  maxGap: 0.40,  // 檔案少時最多拉開到這麼多（=minGap：間距錨死）
  lift: 0.08,    // 被指卡抽高量（世界單位，卡高 2.5）
  push: 0.45,    // 撥開時前方卡下壓量（讓出指向前那道縫）
  range: 1.2,    // 撥開衰減範圍（以卡為單位的高斯寬；越遠影響越小）
  tilt: 15,      // 撥開前倒角：前方卡繞底邊往鏡頭倒（度，掃參規格下限 15~30）
  bend: 0.08,    // 翻平程度：抽高卡上半部往鏡頭彎的曲率（0=不彎）
  hinge: 0.45,   // 折點高度（卡高比例，從下緣算起）
  frontWidth: 0.85,  // 前排卡投影寬度 ÷ 堆視區寬度（取景主尺，0.5~0.95，±5% 驗收帶）
  hoverDelay: 120    // hover 意圖延遲 ms（0~600）：滑過去就有撥開動態；滾輪捲動中不觸發
};
export const P = { ...P_DEFAULTS };
// localStorage 的值做人為消毒：只收有限數字、收斂到合理範圍，NaN/損毀值回落預設。
// 版本遷移：__v ≠ PARAMS_VER（舊版存檔）→ 整組丟棄用新預設，避免舊取景參數把卡變小。
export const P_RANGES = {
  fov: [15, 40], pitch: [45, 85], minGap: [0.08, 1.2], maxGap: [0.15, 3],
  lift: [0, 2.5], push: [0, 2.5], range: [0.4, 4], tilt: [0, 30],
  bend: [0, 1.2], hinge: [0.15, 0.85],
  frontWidth: [0.5, 0.95], hoverDelay: [0, 600]
};
try {
  const saved = JSON.parse(localStorage.getItem('floderParams2') || '{}');
  if (saved.__v === PARAMS_VER) {
    for (const k of Object.keys(P_RANGES)) {
      const v = Number(saved[k]);
      if (Number.isFinite(v)) P[k] = clamp(v, P_RANGES[k][0], P_RANGES[k][1]);
    }
    if (P.maxGap < P.minGap) P.maxGap = P.minGap;   // 存檔防呆：min>max 反轉區間會讓間距塌縮、minGap 滑桿失效
  }
} catch (_) {}
export function saveParams() {
  try { localStorage.setItem('floderParams2', JSON.stringify({ ...P, __v: PARAMS_VER })); } catch (_) {}
}

export const KIND_COLOR = {
  markdown: '#2f6fed', text: '#6b7280', html: '#e34f26', json: '#8e44ad',
  table: '#1b9e77', sheet: '#217346', code: '#b58900', image: '#d33682', pdf: '#c0392b',
  video: '#0c8599', binary: '#4d5a68', tab: '#5b5ea6'
};
export const KIND_LABEL = {
  markdown: 'MD', text: 'TXT', html: 'HTML', json: 'JSON', table: 'CSV',
  sheet: 'XLS', code: 'CODE', image: 'IMG', pdf: 'PDF', video: 'VID', binary: 'BIN', tab: 'TAB'
};
export function kindOf(file) { return file.kind || 'binary'; }

// ---------------------------------------------------------------- theme（亮＝書頁紙色、暗＝柔和高對比）
// 亮：暖米色紙底＋深褐墨字（不用純白純黑，降低刺眼與眩光，長時間閱讀不累）。
// 暗：深灰底（非純黑）＋暖白字（非純白），對比約 11~12:1——夠清楚又不會字邊發光。
// CSS 介面用 index.html 的 :root 變數；這裡是畫布（卡面縮圖）與 3D 場景用的同一組色票。
export const THEMES = {
  light: {
    scene: 0xe8e0cc, ground: 0xddd3bd,
    paper: '#faf5e8', paperEdge: '#d9cdb2', text: '#3a3229', heading: '#241e16',
    code: '#8a4f12', dim: '#8a7d68', gridLine: '#cdbf9f', gridHead: '#eee5d1',
    gridHeadText: '#241e16', gridText: '#4a4034', skeleton: '#e8dfcb',
    jsonKey: '#46638c', jsonStr: '#2f7a4f', jsonNum: '#a85d1a', err: '#a33a2a',
    // 檔名列（表頭）：紙色主題用「墨色系」——低彩度、像書脊標籤，每種檔案一個色相、明度一致
    tabText: '#fbf7ee', reading: '#c0782e',   // 正在閱讀的卡：琥珀色外框（紙色上醒目但不刺眼）
    tabs: { markdown: '#3f5d7a', text: '#6e665a', html: '#a65a32', json: '#6b4f7f', table: '#4c7559',
      sheet: '#3d6b4e', code: '#86691f', image: '#9c4a60', pdf: '#9a3f35', video: '#256874', binary: '#5f5a52', tab: '#565a86' }
  },
  dark: {
    scene: 0x121417, ground: 0x171a1f,
    paper: '#202328', paperEdge: '#383d45', text: '#d2cdc2', heading: '#ece6d8',
    code: '#e0a868', dim: '#8d949e', gridLine: '#464c56', gridHead: '#2a2e35',
    gridHeadText: '#ece6d8', gridText: '#c9c4ba', skeleton: '#30343b',
    jsonKey: '#8cb4ff', jsonStr: '#7fd1a5', jsonNum: '#e5a66a', err: '#ff8a80',
    // 暗色主題的表頭：同一組色相但更深更沉（像夜間模式的書籤），不搶內文、白字對比 ≥ 5:1
    tabText: '#efe9dd', reading: '#e0a24a',
    tabs: { markdown: '#2f4a66', text: '#4c5159', html: '#83452a', json: '#553f69', table: '#355a45',
      sheet: '#2c553d', code: '#6b5418', image: '#7a3a4c', pdf: '#7a332c', video: '#1d525c', binary: '#454b54', tab: '#3c4066' }
  }
};
let themeName = (() => {
  try { const t = localStorage.getItem('floderTheme'); if (t && THEMES[t]) return t; } catch (_) {}
  try { if (matchMedia('(prefers-color-scheme: light)').matches) return 'light'; } catch (_) {}
  return 'dark';
})();
export let themeGen = 0;               // 換主題 +1：舊主題畫到一半的縮圖回來時認得出來、丟掉
export function theme() { return THEMES[themeName]; }
export function themeNow() { return themeName; }
export function kindColor(kind) { return THEMES[themeName].tabs[kind] || THEMES[themeName].tabs.binary; }
// 外觀（主題或字型）變了：卡面縮圖要全部重畫——共用主題換色那條路
export function refreshLook() {
  themeGen++;
  dispatchEvent(new CustomEvent('themechange', { detail: themeName }));
}
export function setTheme(name) {
  if (!THEMES[name] || name === themeName) return;
  themeName = name; themeGen++;
  try { localStorage.setItem('floderTheme', name); } catch (_) {}
  document.documentElement.dataset.theme = name;
  dispatchEvent(new CustomEvent('themechange', { detail: name }));
}
document.documentElement.dataset.theme = themeName;
