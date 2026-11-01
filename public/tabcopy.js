// tabcopy.js — 「複製給 AI」的共用流程：完整版右欄網頁預覽的按鈕，跟側邊欄網頁卡上的 ⧉，
// 走的是同一條路。內容來源：先向擴充要一次即時的 text/html（op:'read'），要不到
// （內建頁／休眠／逾時）就退回畫面上已快取的那份，提示裡說明白。
import { buildForAI, getMaxTokens } from './copyai.js';
import { t, LANG } from './i18n.js';

// tab＝分頁物件（id/title/url；file.tab 或分頁預覽裡的 tab 均可）。
// cached＝畫面上已有的 {text, html}（完整版預覽本來就載過一次，拿來當退回）。
// onNoText：完全沒內容可複製時想自己顯示（例如預覽的狀態列）就給；不給就走 toast。
// 回傳 { ok, tokens?, usedCache? }；所有提示（成功／失敗）都在這裡發。
export async function copyTabForAI(tab, { cached = null, toast = () => {}, onNoText = null } = {}) {
  let page = cached;
  let usedCache = false;
  try {
    const r = await fetch('/api/tabs/action', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'read', tabId: tab.id })
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d && (d.text || d.html)) page = d;
    else if (page) usedCache = true;
  } catch (_) {
    if (page) usedCache = true;
  }
  if (!page || (!page.text && !page.html)) {
    const msg = t('tabsNoText');
    if (onNoText) onNoText(msg); else toast(msg);
    return { ok: false, reason: 'no-text' };
  }
  const built = buildForAI({
    title: page.title || tab.title || '',
    url: page.url || tab.url || '',
    text: page.text || '',
    html: page.html || '',
    lang: LANG
  }, getMaxTokens());
  try {
    await navigator.clipboard.writeText(built.text);
    toast(t('copyAiDone', { n: built.tokens }) + (usedCache ? t('copyAiCache') : ''));
    return { ok: true, tokens: built.tokens, usedCache };
  } catch (_) {
    toast(t('opFail', { msg: 'clipboard' }));
    return { ok: false, reason: 'clipboard' };
  }
}
