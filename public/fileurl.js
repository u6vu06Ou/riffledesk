// fileurl.js — 把 Chrome 分頁的 file:// 網址翻成本機路徑，以及「這種分頁該怎麼畫」的純判斷。
// 只有純函式，Node 測試可以直接 import。

// 副檔名 → 檔案類型。跟 server.js 的 KIND 同一份（/api/file 不認的類型這裡也不認，
// 免得卡面去抓一個一定 415 的檔）。
const EXT_KIND = {
  '.md': 'markdown', '.markdown': 'markdown',
  '.txt': 'text', '.log': 'text', '.rst': 'text', '.tex': 'text',
  '.html': 'html', '.htm': 'html',
  '.json': 'json',
  '.csv': 'table', '.tsv': 'table',
  '.xlsx': 'sheet', '.xls': 'sheet',
  '.pptx': 'slides',
  '.yaml': 'code', '.yml': 'code', '.toml': 'code', '.ini': 'code', '.cfg': 'code',
  '.py': 'code', '.js': 'code', '.mjs': 'code', '.ts': 'code', '.tsx': 'code',
  '.jsx': 'code', '.css': 'code', '.scss': 'code', '.less': 'code',
  '.c': 'code', '.h': 'code', '.cpp': 'code', '.hpp': 'code', '.cc': 'code',
  '.cs': 'code', '.java': 'code', '.go': 'code', '.rs': 'code', '.rb': 'code',
  '.php': 'code', '.sh': 'code', '.bash': 'code', '.bat': 'code', '.ps1': 'code',
  '.sql': 'code', '.lua': 'code', '.vue': 'code', '.xml': 'code',
  '.svg': 'image', '.png': 'image', '.jpg': 'image', '.jpeg': 'image',
  '.gif': 'image', '.webp': 'image',
  '.mp4': 'video', '.m4v': 'video', '.webm': 'video', '.ogv': 'video', '.mov': 'video',
  '.pdf': 'pdf'
};
export function extToKind(ext) { return EXT_KIND[String(ext || '').toLowerCase()] || null; }
export function pathExtOf(p) { const m = /\.[^.\\/]+$/.exec(String(p || '')); return m ? m[0].toLowerCase() : ''; }

// 瀏覽器內建頁／擴充頁：擴充的 previewable() 不收、抓不到也拍不到，只能畫說明卡面。
// blob:/filesystem: 也算——它們同樣不在 previewable() 內，而且內容抓不回來。
const BUILTIN_RE = /^(chrome|chrome-extension|chrome-untrusted|edge|brave|opera|vivaldi|about|devtools|moz-extension|view-source|data|blob|filesystem):/i;
export function isBuiltinUrl(url) { return BUILTIN_RE.test(String(url || '')); }

// file:///D:/a/b.html?x=1#y → D:\a\b.html
// 認得的只有「本機絕對路徑」：非 file:、UNC（file://server/share）、file://localhost/…、
// 舊式 file:///C|/x、或路徑不成形，一律回 null（退回說明卡面，不猜）。
export function fileUrlToPath(url) {
  const s0 = String(url || '');
  if (!/^file:\/\//i.test(s0)) return null;
  let s = s0.replace(/^file:\/\//i, '');      // file:///D:/x → /D:/x
  s = s.replace(/[?#].*$/, '');               // 查詢字串／錨點不屬於路徑
  try { s = decodeURIComponent(s); } catch (_) { /* 壞的百分比編碼：照原樣 */ }
  if (s.startsWith('//')) return null;        // 網路磁碟：交給說明卡面
  s = s.replace(/^\/?([a-z])\|(?=\/)/i, '$1:');   // 舊式 file:///C|/x.md → C:/x.md
  const win = /^\/?[a-z]:[\\/]/i.test(s);
  if (win) {
    if (s.startsWith('/')) s = s.slice(1);
    return s.replace(/\//g, '\\');
  }
  if (s.startsWith('/') && s.length > 1) return s;   // POSIX 絕對路徑（'/' 本身沒有檔可看）
  return null;
}