// 字型：幾款精選（Google Fonts，按需載入；中文字型依用到的字分片下載，不會一次抓幾十 MB）
// ＋使用者自己的字型檔（.ttf/.otf/.woff/.woff2，存在這台電腦瀏覽器的 IndexedDB）。
// 換字型會同時套到介面、閱讀區、卡片上的字（卡面縮圖重畫）。
import { t } from './i18n.js';
import { refreshLook } from './util.js';

const SYSTEM = '"Segoe UI", "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", system-ui, sans-serif';
export const FONT_PRESETS = [
  { id: 'system', label: 'fontSystem', stack: SYSTEM },
  // 書卷：思源宋體＋Source Serif（英文），配紙色主題最像在看書
  { id: 'serif', label: 'fontSerif', css: 'family=Source+Serif+4:opsz,wght@8..60,400;8..60,700&family=Noto+Serif+TC:wght@400;700',
    stack: '"Source Serif 4", "Noto Serif TC", serif', probe: 'Noto Serif TC' },
  // 文楷：霞鶩文楷，手寫楷書味、有個性但很好讀（近年中文圈最受歡迎的開源字型之一）
  { id: 'wenkai', label: 'fontWenkai', css: 'family=LXGW+WenKai+TC:wght@400;700',
    stack: '"LXGW WenKai TC", serif', probe: 'LXGW WenKai TC' },
  // 粉圓：圓體，親切、圓潤，長時間看螢幕柔和
  { id: 'round', label: 'fontRound', css: 'family=Huninn',
    stack: '"Huninn", ' + SYSTEM, probe: 'Huninn' },
  // 芫荽：仿宋＋手感，文青、有格調
  { id: 'iansui', label: 'fontIansui', css: 'family=Iansui',
    stack: '"Iansui", serif', probe: 'Iansui' }
];
const USER_FAMILY = 'RiffleUserFont';
let current = SYSTEM;
export function fontStack() { return current; }

function setVar(stack) {
  current = stack;
  document.documentElement.style.setProperty('--font', stack);
}

async function loadGoogle(p) {
  const id = 'gf-' + p.id;
  if (!document.getElementById(id)) {
    const l = document.createElement('link');
    l.id = id; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?' + p.css + '&display=swap';
    document.head.appendChild(l);
    await new Promise(res => { l.onload = res; l.onerror = res; setTimeout(res, 4000); });
  }
  // 先把常用字載進來，卡面縮圖才會用新字型畫（canvas 不會等字型）
  try { await document.fonts.load(`24px "${p.probe}"`, '交接檔案搜尋ABCabc123'); } catch (_) {}
}

// ---- 使用者字型：IndexedDB 存原始檔
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('riffledesk', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('fonts');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbPut(v) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('fonts', 'readwrite'); tx.objectStore('fonts').put(v, 'user'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function idbGet() { const db = await idb(); return new Promise((res, rej) => { const r = db.transaction('fonts').objectStore('fonts').get('user'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

async function useUserFont(buf) {
  const ff = new FontFace(USER_FAMILY, buf);
  await ff.load();
  document.fonts.add(ff);
  setVar(`"${USER_FAMILY}", ` + SYSTEM);
}

export async function applyFont(id, { repaint = true } = {}) {
  try { localStorage.setItem('riffleFont', id); } catch (_) {}
  if (id === 'custom') {
    const v = await idbGet().catch(() => null);
    if (v && v.buf) await useUserFont(v.buf).catch(() => setVar(SYSTEM));
    else setVar(SYSTEM);
  } else {
    const p = FONT_PRESETS.find(x => x.id === id) || FONT_PRESETS[0];
    if (p.css) await loadGoogle(p);
    setVar(p.stack);
  }
  if (repaint) refreshLook();
}

export async function loadUserFontFile(file) {
  const buf = await file.arrayBuffer();
  await useUserFont(buf);                       // 壞檔會在這裡丟錯，不會存進去
  await idbPut({ name: file.name, buf });
  try { localStorage.setItem('riffleFont', 'custom'); } catch (_) {}
  refreshLook();
  return file.name;
}
export async function userFontName() { const v = await idbGet().catch(() => null); return v ? v.name : null; }
export function savedFontId() { try { return localStorage.getItem('riffleFont') || 'system'; } catch (_) { return 'system'; } }

// 工具列的字型選單
export async function buildFontMenu(sel, onMsg) {
  const userName = await userFontName();
  sel.innerHTML = '';
  for (const p of FONT_PRESETS) { const o = document.createElement('option'); o.value = p.id; o.textContent = t(p.label); sel.appendChild(o); }
  if (userName) { const o = document.createElement('option'); o.value = 'custom'; o.textContent = t('fontMine', { name: userName }); sel.appendChild(o); }
  const up = document.createElement('option'); up.value = '__upload'; up.textContent = t('fontUpload'); sel.appendChild(up);
  const more = document.createElement('option'); more.value = '__more'; more.textContent = t('fontMore'); sel.appendChild(more);
  const cur = savedFontId();
  sel.value = (cur === 'custom' && !userName) ? 'system' : cur;
  sel.onchange = async () => {
    const v = sel.value;
    if (v === '__more') { window.open('https://fonts.google.com/?subset=chinese-traditional', '_blank', 'noopener'); sel.value = savedFontId(); return; }
    if (v === '__upload') {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.ttf,.otf,.woff,.woff2';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) { sel.value = savedFontId(); return; }
        try { const n = await loadUserFontFile(f); await buildFontMenu(sel, onMsg); onMsg && onMsg(t('fontLoaded', { name: n })); }
        catch (e) { sel.value = savedFontId(); onMsg && onMsg(t('fontBad')); }
      };
      inp.click();
      sel.value = savedFontId();
      return;
    }
    await applyFont(v);
  };
}
