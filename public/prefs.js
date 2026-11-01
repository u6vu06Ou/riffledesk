// Shared per-machine UI prefs（★ 我的視角、最近視角、側欄縮放）。
// 為什麼需要這層：自動收合抽屜（drawer）的面板頁是被任意網站框住的第三方
// iframe，Chrome 的 storage partitioning 會給它一個每站台一份、永遠是空的
// localStorage——光靠 localStorage，抽屜永遠看不到完整 App／真側邊欄存的視角。
// RiffleDesk server 跟本頁同源，就在那裡放一份共享 JSON（/api/prefs → prefs.json）：
// 開機先抓回來當兜底（localStorage 沒有才用），存檔時本機與 server 都寫。
// 全部 best-effort：server 掛了、寫不進去，各 surface 照自己 localStorage 跑。

let boot = null;          // 開機抓到的共享 prefs（{} 就算抓過；null＝還沒抓）
let bootPromise = null;   // 單飛：整頁只抓一次

// main.js 在建卡堆之前 await 這個：localStorage 以外的 surface（抽屜）
// 一開機就要拿得到共享視角，不能等畫完第一幀才補（那樣會閃一下預設視角）。
export function loadSharedPrefs(timeoutMs = 1500) {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    let d = null;
    try {
      const r = await fetch('/api/prefs', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok && j.prefs && typeof j.prefs === 'object') d = j.prefs;
      }
    } catch (_) { /* server 沒回／太慢：各 surface 退回自己的 localStorage */ }
    boot = d || {};
    try { window.__rifflePrefsBoot = boot; } catch (_) {}
    return boot;
  })();
  return bootPromise;
}

export function sharedPrefsNow() { return boot || {}; }

// 寫回一組鍵值（null＝刪除）。本地 boot 副本樂觀先改——stack.js 的 favView()
// 兜底讀的就是它，存／清檔必須當場生效；POST 是火後不理（失敗下次開機再對齊）。
export function postSharedPrefs(patch) {
  const cur = boot || (boot = {});
  for (const k of Object.keys(patch)) {
    if (patch[k] === null) delete cur[k];
    else cur[k] = patch[k];
  }
  try { window.__rifflePrefsBoot = cur; } catch (_) {}
  try {
    fetch('/api/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
      cache: 'no-store'
    }).catch(() => {});
  } catch (_) { /* 持久化失敗就算：本機 localStorage 那份還在 */ }
}
