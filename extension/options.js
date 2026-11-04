// options 頁：改埠號＋看連線狀態。defaults.js、i18n.js 先於本檔載入（<script src>），
// 這裡仍留 fallback，載入順序出包也不至於整頁壞掉。
// 同一份程式兩邊跑：Firefox 用 browser.*（回 Promise），Chrome 只有 chrome.*，取得到哪個用哪個。
const api = globalThis.browser ?? globalThis.chrome;
const DEFAULT_PORT = (typeof RIFFLE_DEFAULT_PORT === 'number' && RIFFLE_DEFAULT_PORT) || 5177;
const t = (typeof RD_I18N !== 'undefined' && RD_I18N.t) || (k => k)
if (typeof RD_I18N !== 'undefined') RD_I18N.applyStatic();
const portEl = document.getElementById('port');
const statusEl = document.getElementById('status');
const debugEl = document.getElementById('debug');

const idleEl = document.getElementById('idleSweep');
const drawerEl = document.getElementById('autoHideDrawer');
const drawerSideEl = document.getElementById('drawerSide');

api.storage.local.get({ port: DEFAULT_PORT, idleSweep: true, autoHideDrawer: false, drawerSide: 'right' }).then(
  d => {
    portEl.value = d.port == null ? DEFAULT_PORT : d.port;
    idleEl.checked = d.idleSweep !== false;   // 預設開
    drawerEl.checked = d.autoHideDrawer === true;   // 自動收合側欄預設關
    drawerSideEl.value = d.drawerSide === 'left' ? 'left' : 'right';
  },
  () => { portEl.value = DEFAULT_PORT; }
);

// 閒置補拍開關：即改即存（不用按「存」鈕）
idleEl.addEventListener('change', () => {
  api.storage.local.set({ idleSweep: !!idleEl.checked }).catch(() => {});
});

// 自動收合側欄開關：即改即存，內容腳本監聽 storage 變化即時套用到已開分頁
drawerEl.addEventListener('change', () => {
  api.storage.local.set({ autoHideDrawer: !!drawerEl.checked }).catch(() => {});
});

// 抽屜待在左邊或右邊：即改即存（內容腳本拆掉舊 UI 重建，不用重整分頁）
drawerSideEl.addEventListener('change', () => {
  api.storage.local.set({ drawerSide: drawerSideEl.value === 'left' ? 'left' : 'right' }).catch(() => {});
});

// 「清除截圖快取」：叫背景把記憶體＋IndexedDB 的截圖一次清掉
document.getElementById('clearShots').addEventListener('click', async () => {
  const msg = document.getElementById('clearShotsMsg');
  msg.textContent = t('optClearing');
  try {
    const r = await api.runtime.sendMessage({ type: 'riffle-clear-shots' });
    msg.textContent = r && r.ok ? t('optCleared') : t('optClearFail');
  } catch (e) {
    msg.textContent = t('optClearFailMsg', { msg: String((e && e.message) || e) });
  }
});

document.getElementById('save').addEventListener('click', async () => {
  const raw = String(portEl.value).trim();
  // 整串要全是數字（擋 "12.7" 這種會被 Number 偷偷截斷的），再檢範圍
  if (!/^\d+$/.test(raw)) {
    statusEl.textContent = t('optPortBad');
    return;
  }
  const p = Number(raw);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    statusEl.textContent = t('optPortBad');
    return;
  }
  try {
    await api.storage.local.set({ port: p });
  } catch (e) {
    statusEl.textContent = t('optSaveFail', { msg: String((e && e.message) || e) });
    return;
  }
  statusEl.textContent = t('optSaved');
  // 「已存。」先留著讓使用者看見，1.5 秒後才換回狀態列
  setTimeout(refresh, 1500);
});

function fmt(ms) {
  if (!ms) return t('timeNever');
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 5 ? t('timeJustNow') : t('timeSecsAgo', { s });
}

async function refresh() {
  let st = null;
  try { st = await api.runtime.sendMessage({ type: 'riffle-status' }); } catch (_) { st = null; }
  if (!st) { statusEl.textContent = ''; return; }
  statusEl.textContent =
    `${t('stPort', { port: st.port })}\n${t('stLastPush', { when: fmt(st.lastPushOk) })}` +
    (st.sweep
      ? `\n${t('stSweepLine', { s: st.sweep.running ? t('stSweepRunning')
          : st.sweep.lastAt ? t('stSweepLast', { time: new Date(st.sweep.lastAt).toLocaleTimeString(), n: st.sweep.lastN })
          : (st.idleSweep === false ? t('stSweepOff') : t('stSweepNever')) })}`
      : '') +
    (st.sleeping ? `\n${t('stSleeping', { n: st.sleeping })}` : '') +
    (st.shotStore && st.shotStore.n ? `\n${t('stShotStore', { n: st.shotStore.n, mb: st.shotStore.mb })}` : '') +
    (st.lastError ? `\n${t('stLastErr', { msg: st.lastError })}` : '');
  // 除錯區：背景補抓循環最近失敗的分頁＋原因（權限／凍結／錯誤訊息）
  const fails = Array.isArray(st.grabFails) ? st.grabFails : [];
  debugEl.textContent = fails.length
    ? fails.map(f =>
        `${new Date(f.t).toLocaleTimeString()} 〔${f.kind}${f.fails > 1 ? '×' + f.fails : ''}〕 ${f.title || f.url}` +
        `\n    ${f.msg}${f.title && f.url ? '\n    ' + f.url : ''}`).join('\n')
    : t('dbgNone');
}
refresh();
setInterval(refresh, 3000);   // 狀態與除錯區即時跟著背景循環更新
