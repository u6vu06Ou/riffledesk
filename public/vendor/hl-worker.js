/* RiffleDesk 程式碼上色 worker：大檔（>200KB 或預估超過 30ms）完整的 highlight.js
   運算移出 UI thread，結果回傳一次換入（捲動不跳）。本檔與 highlight.min.js 同目錄，
   importScripts 相對路徑解析 /vendor/*.min.js（同源，CSP script-src 'self' 放行）。 */
/* global hljs */
importScripts('highlight.min.js', 'languages-powershell.min.js', 'languages-dockerfile.min.js');

onmessage = e => {
  const { id, text, lang } = e.data || {};
  try {
    if (!lang || !hljs.getLanguage(lang)) { postMessage({ id, ok: false, error: 'no-lang' }); return; }
    const t0 = performance.now();
    const r = hljs.highlight(text, { language: lang, ignoreIllegals: true });
    postMessage({ id, ok: true, value: r.value, language: r.language || lang, ms: performance.now() - t0 });
  } catch (err) {
    postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
