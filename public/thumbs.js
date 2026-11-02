// thumbnail painters (pure canvas, no three.js) + frame-budgeted build queue.
import { t } from './i18n.js';
import { fmtSize, fmtDate, fmtDateTime, KIND_LABEL, kindOf, theme, themeNow, themeGen, kindColor } from './util.js';
import { fontStack } from './fonts.js';
import { thumbCodeColors, tokenizeLine } from './codetheme.js';
import { pathExtOf } from './fileurl.js';

export const TEX_W = 1280, TEX_H = 800;         // full thumbnail canvas（1.6:1 寬卡，與 stack.js CARD_W/CARD_H 同比例）
const PH_W = 640, PH_H = 400;                   // placeholder canvas（同 1.6:1）
const HEAD_BYTES = 8192;                        // thumbnails only need the file head

// ---- 分頁卡右上角的動作鈕：直接畫進貼圖（卡翻轉／透視／彎曲都帶著走），不靠會飄的 DOM 浮鈕 ----
// ×＝關掉這個網頁（永遠顯示）；⧉＝複製給 AI 是另一張單的預留，現在不畫、熱區也不生效。
// 命中判定用幾何 uv（THREE intersect.uv：u、v∈[0,1]，v=1＝卡頂），與貼圖像素尺寸無關，
// 所以 1280×800 的真貼圖、640×400 的 placeholder、共用灰骨架都套同一組數字。
export const TAB_X_ZONE = { u0: 0.906, v0: 0.856 };                  // ×：u ≥ u0 且 v ≥ v0
export const TAB_X_UV = { u: 0.945, v: 0.925 };                      // × 圓心的 uv（hover 覆疊錨點用）
export const TAB_AI_ZONE = { u0: 0.828, u1: 0.906, v0: 0.856 };      // ⧉ 複製給 AI（只有側邊欄畫）
// 側邊欄模式（?mode=panel）：網頁卡在 × 左邊多畫一顆 ⧉＝複製給 AI；完整版不畫（右欄預覽已有按鈕）。
// 以一頁的模式為準（mode 載入時定死不會變），所以直接讀 body class，不用傳參。
export function panelAiBadge() {
  try { return typeof document !== 'undefined' && !!document.body && document.body.classList.contains('panel-mode'); }
  catch (_) { return false; }
}
export function drawTabBadges(ctx, W, H, { ai = false } = {}) {
  const r = H * 0.042, cy = H * (1 - TAB_X_UV.v);
  const disc = u => {
    ctx.beginPath(); ctx.arc(W * u, cy, r, 0, 7);
    ctx.fillStyle = 'rgba(246,248,250,.94)';    // 淺色圓底（深截圖卡上也跳得出來）
    ctx.fill();
    ctx.lineWidth = Math.max(1, H * 0.004);     // 細邊：卡在淺色卡面上時圓底仍有輪廓
    ctx.strokeStyle = 'rgba(20,22,28,.35)';
    ctx.stroke();
  };
  disc(TAB_X_UV.u);   // × 圓底
  ctx.strokeStyle = '#272a31';                   // 深色 ×
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, H * 0.011);
  const dx = r * 0.38;
  ctx.beginPath();
  ctx.moveTo(W * TAB_X_UV.u - dx, cy - dx); ctx.lineTo(W * TAB_X_UV.u + dx, cy + dx);
  ctx.moveTo(W * TAB_X_UV.u - dx, cy + dx); ctx.lineTo(W * TAB_X_UV.u + dx, cy - dx);
  ctx.stroke();
  ctx.lineCap = 'butt';
  if (!ai) return;
  disc(0.875);   // ⧉ 複製給 AI 圓底（只有側邊欄開：panelAiBadge()）
  ctx.fillStyle = '#272a31';
  ctx.font = `bold ${Math.round(r * 1.15)}px ${fontStack()}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⧉', W * 0.875, cy + r * 0.06);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}
// 給 uv 判定落在哪個熱區：'x' | 'ai' | null（ai 預設關——熱區跟著畫面走，不畫就不做隱形熱區）
export function tabBadgeAt(u, v, { ai = false } = {}) {
  if (typeof u !== 'number' || typeof v !== 'number' || v < TAB_X_ZONE.v0) return null;
  if (u >= TAB_X_ZONE.u0) return 'x';
  if (ai && u >= TAB_AI_ZONE.u0 && u < TAB_AI_ZONE.u1) return 'ai';
  return null;
}

function ellipsis(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

// ---- header tab (filename row). scale lets the same layout serve both sizes.
function drawTab(ctx, W, file, scale) {
  const color = kindColor(kindOf(file));
  const tabH = Math.round(96 * scale);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, tabH);
  // ⚠ badge for files whose head looks like it holds a password / API key
  // (flag from /api/list `secret: true`); drawn on every card face since both
  // the placeholder and the real thumbnail go through this function
  const badge = !!file.secret;
  if (badge) {
    const r = Math.round(22 * scale);
    ctx.beginPath(); ctx.arc(W - r - Math.round(10 * scale), Math.round(24 * scale) + r, r, 0, 7);
    ctx.fillStyle = '#e0a24a';
    ctx.fill();
    ctx.fillStyle = '#3a2d10';
    ctx.font = `bold ${Math.round(30 * scale)}px ${fontStack()}`;
    ctx.textAlign = 'center';
    ctx.fillText('⚠', W - r - Math.round(10 * scale), Math.round(24 * scale) + r + Math.round(11 * scale));
    ctx.textAlign = 'left';
  }
  ctx.fillStyle = theme().tabText;
  ctx.font = `bold ${Math.round(30 * scale)}px ${fontStack()}`;
  // 網頁卡右上角畫了 ×（側邊欄多一顆 ⧉）：標題和網域列都要在徽章左邊收尾，不能壓到徽章
  const isTabCard = !!(file.tab && !file.tab.note);
  const badgeU = isTabCard && panelAiBadge() ? TAB_AI_ZONE.u0 : TAB_X_ZONE.u0;
  const xGap = isTabCard ? Math.round(W * (1 - badgeU)) + Math.round(8 * scale) : 0;
  // git 加減行數徽章（檔案卡限定）：投影／疊帶來的 file.diff，跟在檔名後面、字小一級，
  // 照 GitHub 慣例 加=綠、減=紅。分頁卡沒有這種資料。
  const diffSegs = (file.diff && !isTabCard)
    ? [['+' + file.diff.adds, '#3fb950'], ['−' + file.diff.dels, '#f85149']]
    : null;
  let diffW = 0;
  if (diffSegs) {
    ctx.font = `600 ${Math.round(19 * scale)}px ${fontStack()}`;
    diffW = Math.round(12 * scale) + diffSegs.reduce((w, [s], i) => w + ctx.measureText(s).width + (i ? Math.round(8 * scale) : 0), 0);
    ctx.font = `bold ${Math.round(30 * scale)}px ${fontStack()}`;
  }
  const nmX = Math.round(14 * scale), nmY = Math.round(46 * scale);
  const name = ellipsis(ctx, file.name, W - Math.round(28 * scale) - (badge ? Math.round(80 * scale) : 0) - xGap - diffW);
  ctx.fillText(name, nmX, nmY);
  if (diffSegs) {
    let dx = nmX + ctx.measureText(name).width + Math.round(12 * scale);
    ctx.font = `600 ${Math.round(19 * scale)}px ${fontStack()}`;
    for (let i = 0; i < diffSegs.length; i++) {
      ctx.fillStyle = diffSegs[i][1];
      ctx.fillText(diffSegs[i][0], dx, nmY - Math.round(2 * scale));
      dx += ctx.measureText(diffSegs[i][0]).width + Math.round(8 * scale);
    }
    ctx.fillStyle = theme().tabText;
  }
  ctx.font = `${Math.round(19 * scale)}px ${fontStack()}`;
  ctx.globalAlpha = 0.92;
  // 分頁卡畫「網域 · 最後開啟時間」：0 B 這種檔案大小對分頁沒意義
  ctx.fillText(
    (file.tab && !file.tab.note)
      ? ellipsis(ctx, tabMetaText(file), W - Math.round(28 * scale) - xGap)
      : `${fmtSize(file.size)} · ${fmtDateTime(file.mtime)} · ${KIND_LABEL[kindOf(file)] || file.ext}`,
    Math.round(14 * scale), Math.round(72 * scale));
  ctx.globalAlpha = 1;
  return tabH;
}

function drawLines(ctx, lines, x, y, w, lineH, color, mono, px) {
  ctx.font = `${px}px ${mono ? 'Consolas, monospace' : fontStack()}`;
  ctx.fillStyle = color;
  for (let i = 0; i < lines.length; i++) {
    if (y + lineH * i > ctx.canvas.height - 16) break;
    ctx.fillText(ellipsis(ctx, lines[i], w), x, y + lineH * i);
  }
  return y + lineH * lines.length;
}

function drawGrid(ctx, rows, x, y, w, maxRows) {
  if (!rows.length) return y;
  const nCols = Math.max(1, Math.min(8, ...rows.map(r => r.length)));
  rows = rows.slice(0, maxRows);
  const colW = w / nCols, rowH = 40;
  ctx.strokeStyle = theme().gridLine;
  ctx.lineWidth = 1.5;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < nCols; c++) {
      const cx = x + c * colW, cy = y + r * rowH;
      ctx.strokeRect(cx, cy, colW, rowH);
      if (r === 0) { ctx.fillStyle = theme().gridHead; ctx.fillRect(cx + 1, cy + 1, colW - 2, rowH - 2); }
      ctx.fillStyle = r === 0 ? theme().gridHeadText : theme().gridText;
      ctx.font = `22px ${fontStack()}`;
      const cell = rows[r][c] == null ? '' : String(rows[r][c]);
      if (cell) ctx.fillText(ellipsis(ctx, cell, colW - 12), cx + 6, cy + 28);
    }
  }
  return y + rows.length * rowH;
}

// ---- per-kind body painters (area below the tab) --------------------------
// 內文一律緊貼檔名列（tab）畫：後排卡只露出一條時，那一條就要有可讀的字，
// 不能再留空白帶。
function paintMarkdown(ctx, W, H, text, tabH) {
  // Obsidian 等筆記開頭的屬性區（--- … ---）不畫在卡面上，直接從正文開始
  text = text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '');
  const lines = text.split(/\r?\n/);
  let y = tabH + 2;
  for (let i = 0; i < lines.length && y < H - 30; i++) {
    let ln = lines[i];
    const h = ln.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      const lvl = h[1].length;
      const px = lvl === 1 ? 46 : lvl === 2 ? 38 : 30;
      y = drawLines(ctx, [h[2].replace(/\*\*(.+?)\*\*/g, '$1')], 16, y + px, W - 32, px + 12, theme().heading, false, px) + 8;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(ln)) {
      const tbl = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) {
          tbl.push(lines[i].replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(s => s.trim()));
        }
        i++;
      }
      i--;
      y = drawGrid(ctx, tbl, 16, y, W - 32, 12) + 12;
      continue;
    }
    if (/^\s*```/.test(ln)) {   // fenced code block: mono run
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
      y = drawLines(ctx, code, 16, y + 24, W - 32, 30, theme().code, true, 22) + 10;
      continue;
    }
    ln = ln.replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^>\s?/, '▍ ').replace(/^[-*+]\s+/, '• ');
    if (!ln.trim()) { y += 14; continue; }
    y = drawLines(ctx, [ln], 16, y + 32, W - 32, 38, theme().text, false, 25) - 2;
  }
}

// JSON 卡跟程式碼卡同一家：底色／挑色都走目前的程式碼配色（codeTheme 下拉選鈕）。
// 以前混搭 UI 主題的 jsonKey/jsonStr，結果選了深色程式碼配色、卡身還是亮的——
// 「閱讀區黑了卡片沒黑」那次。follow（預設）時配色＝UI 主題，外觀沒變。
function paintJson(ctx, W, H, text, tabH) {
  let pretty = text;
  try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
  const pal = thumbCodeColors();
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, tabH, W, H - tabH);
  const lines = pretty.split(/\r?\n/).slice(0, 40);
  let y = tabH + 26;
  ctx.font = '22px Consolas, monospace';
  for (const ln of lines) {
    if (y > H - 24) break;
    const m = ln.match(/^(\s*)"(.*?)"(\s*:\s*)(.*)$/);
    if (m) {
      let x = 16;
      ctx.fillStyle = pal.comment;
      if (m[1]) { ctx.fillText(m[1], x, y); x += ctx.measureText(m[1]).width; }
      ctx.fillStyle = pal.attr;
      const key = `"${m[2]}"`;
      ctx.fillText(key, x, y); x += ctx.measureText(key).width;
      ctx.fillStyle = pal.comment;
      ctx.fillText(m[3], x, y); x += ctx.measureText(m[3]).width;
      const v = m[4];
      ctx.fillStyle = /^"/.test(v) ? pal.string : /^-?[\d.]/.test(v) ? pal.number : pal.comment;
      ctx.fillText(ellipsis(ctx, v, 16 + W - 32 - x), x, y);
    } else {
      ctx.fillStyle = pal.fg;
      ctx.fillText(ellipsis(ctx, ln, W - 32), 16, y);
    }
    y += 32;
  }
}

function paintTable(ctx, W, H, text, delim, tabH) {
  const rows = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 20)
    .map(l => l.split(delim === '\t' ? '\t' : delim));
  drawGrid(ctx, rows, 16, tabH + 6, W - 32, 18);
}

function paintSheet(ctx, W, H, aoa, tabH) {
  const rows = (aoa || []).slice(0, 20).map(r => r.map(v => (v == null ? '' : String(v)).slice(0, 40)));
  if (rows.length) drawGrid(ctx, rows, 16, tabH + 6, W - 32, 18);
  else drawLines(ctx, [t('thumbEmptySheet')], 16, tabH + 44, W - 32, 34, theme().dim, false, 22);
}

function paintPlain(ctx, W, H, text, mono, tabH) {
  const lines = text.split(/\r?\n/).slice(0, 40).map(l => l.replace(/\t/g, '  '));
  drawLines(ctx, lines, 16, tabH + 34, W - 32, 38, theme().text, mono, 25);
}

// 程式碼卡：卡身直接畫成「迷你編輯器」——底色／文字色用目前程式碼配色主題，
// keyword／string／comment 用一次 regex 挑色（< 0.5ms hljs 跑不起也沒必要，卡片只要神似）
function paintCode(ctx, W, H, text, tabH) {
  const pal = thumbCodeColors();
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, tabH, W, H - tabH);
  const lines = text.split(/\r?\n/).slice(0, 24);
  ctx.font = '25px Consolas, monospace';
  const COLORS = { code: pal.fg, keyword: pal.keyword, string: pal.string, comment: pal.comment };
  let y = tabH + 34;
  for (const ln of lines) {
    if (y > H - 24) break;
    let x = 16;
    const spans = tokenizeLine(ln.replace(/\t/g, '  '));
    for (let s = 0; s < spans.length && x < W - 40; s++) {
      const sp = spans[s];
      if (!sp.text) continue;
      ctx.fillStyle = COLORS[sp.kind] || pal.fg;
      let txt = sp.text;
      const wAvail = W - 16 - x;
      if (ctx.measureText(txt).width > wAvail) {   // 最後一段塞不下就省略號收尾
        txt = ellipsis(ctx, txt, wAvail);
        ctx.fillText(txt, x, y);
        break;
      }
      ctx.fillText(txt, x, y);
      x += ctx.measureText(txt).width;
    }
    y += 30;
  }
}

// HTML 卡面：照文件結構畫（標題大字、清單打點、表格畫格線、圖片畫成佔位框），跟閱讀區看起來同一份；
// 不做真正的網頁排版成像——那每張卡要多花 0.1~0.3 秒，捲動會卡
function paintHtml(ctx, W, H, text, tabH) {
  let doc;
  try { doc = new DOMParser().parseFromString(text, 'text/html'); } catch (_) { doc = null; }
  if (!doc || !doc.body) { drawLines(ctx, text.replace(/<[^>]+>/g, ' ').split(/\n/).filter(Boolean), 16, tabH + 34, W - 32, 38, theme().text, false, 25); return; }
  const SEL = 'h1,h2,h3,h4,p,li,pre,blockquote,table,img,figcaption,dt,dd';
  const blocks = [...doc.body.querySelectorAll(SEL)].filter(el => !(el.parentElement && el.parentElement.closest(SEL)));
  let y = tabH + 2;
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  if (!blocks.length) {
    const title = clean((doc.querySelector('title') || {}).textContent);
    if (title) y = drawLines(ctx, [title], 16, y + 46, W - 32, 58, theme().heading, false, 46) + 8;
    drawLines(ctx, clean(doc.body.textContent).match(/.{1,60}/g) || [], 16, y + 32, W - 32, 38, theme().text, false, 25);
    return;
  }
  for (const el of blocks) {
    if (y > H - 30) break;
    const tag = el.tagName;
    if (/^H[1-4]$/.test(tag)) {
      const px = tag === 'H1' ? 46 : tag === 'H2' ? 38 : 30;
      const txt = clean(el.textContent); if (!txt) continue;
      y = drawLines(ctx, [txt], 16, y + px, W - 32, px + 12, theme().heading, false, px) + 8;
    } else if (tag === 'TABLE') {
      const rows = [...el.rows].slice(0, 12).map(r => [...r.cells].map(c => clean(c.textContent)));
      y = drawGrid(ctx, rows, 16, y + 6, W - 32, 10) + 12;
    } else if (tag === 'IMG') {
      const alt = clean(el.getAttribute('alt')) || 'image';
      ctx.strokeStyle = theme().gridLine; ctx.lineWidth = 2;
      ctx.strokeRect(16, y + 10, 220, 90);
      drawLines(ctx, ['🖼 ' + alt], 30, y + 64, 190, 30, theme().dim, false, 22);
      y += 112;
    } else if (tag === 'PRE') {
      y = drawLines(ctx, el.textContent.split(/\n/).slice(0, 8), 16, y + 24, W - 32, 30, theme().code, true, 22) + 10;
    } else {
      const txt = clean(el.textContent); if (!txt) continue;
      const pre = tag === 'LI' ? '• ' : tag === 'BLOCKQUOTE' ? '▍ ' : '';
      y = drawLines(ctx, [pre + txt], 16, y + 32, W - 32, 38, theme().text, false, 25) - 2;
    }
  }
}

function paintImage(ctx, W, H, img, tabH) {
  const y0 = tabH + 8, availH = H - y0 - 10, availW = W - 20;
  const scale = Math.max(availW / img.width, availH / img.height);
  const dw = img.width * scale, dh = img.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(10, y0, availW, availH);
  ctx.clip();
  ctx.drawImage(img, 10 + (availW - dw) / 2, y0 + (availH - dh) / 2, dw, dh);
  ctx.restore();
}

// ---- 瀏覽器分頁卡（tabs.js 的偽檔案）----
// favicon 只吃 data: URL：外站圖畫進 canvas 會污染畫布，WebGL 貼圖上傳會整張卡炸掉。
// 截圖與 og:image 代表圖走同源 /api/tabs/shot、/api/tabs/og（擴充抓回存 server 記憶體），安全。
const TAB_HEAD_SCALE = 1.35;   // 分頁卡的檔名列放大（標題是認出「這是哪一頁」的主要線索）
export function tabCardModel(file) {
  // 卡面優先序：截圖 > file:// 的本機檔內容 > og:image 大圖＋摘要 > 摘要＋主內容文字
  // > 說明卡面（內建頁／休眠中）。
  const tb = (file && file.tab) || {};
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const summary = clean(tb.desc);
  const body = clean(tb.text);
  let mode;
  if (tb.note) mode = 'note';
  else if (tb.hasShot) mode = 'shot';
  else if (file && file.localPath) mode = 'local';
  else if (file && file.builtin) mode = 'builtin';
  else if (tb.hasOg) mode = 'og';
  else if (summary || body) mode = 'text';
  else if (tb.discarded) mode = 'sleeping';
  else mode = 'text';
  return { mode, summary, body, sleeping: !!tb.discarded,
           localKind: (file && file.localKind) || null };
}
function tabDomain(url) {
  try { return new URL(url).hostname || url; } catch (_) { return url || ''; }
}
// 檔名列第二行：沒 lastAccessed（擴充沒給或給 0）就不畫日期，免得出現 1970-01-01
export function tabMetaText(file) {
  const parts = [file.localName || tabDomain(file.tab.url)];
  if (file.mtime) parts.push(fmtDate(file.mtime));
  parts.push(KIND_LABEL.tab);
  return parts.join(' · ');
}
function loadImg(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });
}
// 大圖（分頁截圖／og 代表圖／本機圖檔）走 fetch→blob→createImageBitmap：
// JPEG 解碼在背景執行緒完成，主執行緒不必在 drawImage 時同步解碼（側欄一開
// 十幾張截圖連著來，舊寫法一張卡就咬掉主執行緒 5–15ms）。
// imageOrientation 'from-image'＝尊重 JPEG EXIF 方向（跟 <img> 行為一致）。
// 回傳的 ImageBitmap 跟 <img> 一樣有 width/height、能直接 drawImage，
// 但不像 <img> 會自己回收——畫進 canvas 後一律 closeBitmap() 釋放。
// fetch/createImageBitmap 不可用（舊瀏覽器）就退回 im.src 路線。
async function loadBitmap(url) {
  if (typeof fetch !== 'function' || typeof createImageBitmap !== 'function') return loadImg(url);
  const r = await fetch(url);
  if (!r.ok) throw new Error('http ' + r.status);
  return createImageBitmap(await r.blob(), { imageOrientation: 'from-image' });
}
function closeBitmap(img) { if (img && typeof img.close === 'function') img.close(); }
function wrapText(ctx, text, maxW, maxLines) {
  const out = [];
  let line = '';
  for (const ch of String(text)) {
    if (ch === '\n' || ctx.measureText(line + ch).width > maxW) {
      out.push(line); line = ch === '\n' ? '' : ch;
      if (out.length >= maxLines) break;
    } else line += ch;
  }
  if (out.length < maxLines && line) out.push(line);
  if (out.length === maxLines && ctx.measureText(out[maxLines - 1]).width > 0) {
    // 最後一行超寬就收省略號（前面 break 出來時內容可能還有剩）
    out[maxLines - 1] = ellipsis(ctx, out[maxLines - 1] + '…', maxW);
  }
  return out;
}
function drawFavicon(ctx, img, x, y, size) {
  try {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, size * 0.22);
    ctx.clip();
    ctx.drawImage(img, x, y, size, size);
    ctx.restore();
  } catch (_) { /* 污染或壞圖：不畫 */ }
}
// 卡身文字區：摘要（meta description）優先、較大較粗；主內容內文接在後面補滿剩下的空間。
// 純文字卡（含摘要）要排得下 ≥15 行內文——字級/行高是照這條驗收訂的。
function paintTabTextBlock(ctx, W, H, model, y, pad) {
  const maxW = W - pad * 2;
  if (model.summary && y < H - 60) {
    ctx.font = `600 30px ${fontStack()}`;
    ctx.fillStyle = theme().heading;
    const lines = wrapText(ctx, model.summary, maxW, 2);
    for (let i = 0; i < lines.length; i++) {
      const ly = y + 30 + i * 40;
      if (ly > H - 30) break;
      ctx.fillText(lines[i], pad, ly);
    }
    y += 30 + lines.length * 40 + 8;
  }
  if (model.body && y < H - 40) {
    ctx.font = `24px ${fontStack()}`;
    ctx.fillStyle = theme().text;
    const maxLines = Math.max(1, Math.floor((H - y - 26) / 28));
    const lines = wrapText(ctx, model.body, maxW, maxLines);
    for (let i = 0; i < lines.length; i++) {
      const ly = y + 26 + i * 28;
      if (ly > H - 22) break;
      ctx.fillText(lines[i], pad, ly);
    }
    y += 26 + lines.length * 28;
  }
  return y;
}

// 沒截圖也沒代表圖的卡：favicon（載不到就用網域首字母色塊）＋網址，下面排
// 摘要＋主內容文字（擴充在背景抓的）——標題已經在放大的檔名列上，這裡不再重複大字標題。
function paintTabFallbackBody(ctx, W, H, file, tabH, favImg) {
  const PAD = 48;
  const url = file.tab.url || '';
  const dom = tabDomain(url);
  const icon = 56;
  let y = tabH + 26;

  if (favImg) drawFavicon(ctx, favImg, PAD, y, icon);
  else drawDomainBadge(ctx, dom, PAD, y, icon);

  // 網域／網址：跟圖示同一列，淡色、單行截斷
  ctx.font = `26px ${fontStack()}`;
  ctx.fillStyle = theme().dim;
  ctx.fillText(ellipsis(ctx, url.replace(/^https?:\/\//, ''), W - PAD * 2 - icon - 18),
    PAD + icon + 18, y + icon / 2 + 9);
  y += icon + 20;

  const model = tabCardModel(file);
  y = paintTabTextBlock(ctx, W, H, model, y, PAD);
  // 休眠中的分頁（Chrome 省記憶體丟棄）：抓不到文字，說明一句，免得卡片看起來像壞掉
  if (!model.summary && !model.body && model.sleeping) {
    ctx.font = `26px ${fontStack()}`;
    ctx.fillStyle = theme().dim;
    const lines = wrapText(ctx, t('tabsSleeping'), W - PAD * 2, 3);
    for (let i = 0; i < lines.length; i++) {
      const ly = y + 28 + i * 34;
      if (ly > H - 26) break;
      ctx.fillText(lines[i], PAD, ly);
    }
    y += 28 + lines.length * 34;
  }

  if (file.tab.active) {
    ctx.font = `26px ${fontStack()}`;
    ctx.fillStyle = theme().dim;
    ctx.fillText(t('tabsActiveTab'), PAD, Math.min(y + 26, H - 30));
  }
}

// 說明卡面（瀏覽器內建頁／休眠分頁／本機檔讀不到）：大圖示＋一句標題＋小字說明。
// 這三種以前都是空白卡身，使用者看不出為什麼點開什麼都沒有。
function paintExplainBody(ctx, W, H, tabH, icon, title, body) {
  const PAD = 48;
  const availH = H - tabH;
  const iconPx = 96;
  let y = tabH + Math.round(availH * 0.28);
  ctx.font = `${iconPx}px ${fontStack()}`;
  ctx.fillStyle = theme().dim;
  ctx.textAlign = 'center';
  ctx.fillText(icon, W / 2, y + iconPx * 0.8);
  ctx.textAlign = 'left';
  y += iconPx + 30;
  ctx.font = `600 34px ${fontStack()}`;
  ctx.fillStyle = theme().heading;
  ctx.textAlign = 'center';
  const tl = wrapText(ctx, title, W - PAD * 2, 2);
  for (let i = 0; i < tl.length; i++) ctx.fillText(tl[i], W / 2, y + i * 42);
  y += tl.length * 42 + 16;
  ctx.font = `26px ${fontStack()}`;
  ctx.fillStyle = theme().dim;
  const bl = wrapText(ctx, body, W - PAD * 2, 5);
  for (let i = 0; i < bl.length; i++) {
    if (y + i * 34 > H - 26) break;
    ctx.fillText(bl[i], W / 2, y + i * 34);
  }
  ctx.textAlign = 'left';
}

// 影片卡面：不抓影格畫縮圖（拿前幾格＝整段開頭都下來了，違反速度鐵律）——
// 大圖示＋一句提示；點開後右欄才是真的 <video> 播放。
function paintVideoBody(ctx, W, H, tabH) {
  const iconPx = 96;
  const cy = tabH + Math.round((H - tabH) * 0.30);
  ctx.font = `${iconPx}px ${fontStack()}`;
  ctx.fillStyle = theme().dim;
  ctx.textAlign = 'center';
  ctx.fillText('🎬', W / 2, cy + iconPx * 0.5);
  ctx.font = `26px ${fontStack()}`;
  ctx.fillText(t('thumbVideoHint'), W / 2, cy + iconPx + 28);
  ctx.textAlign = 'left';
}

// file:// 分頁：直接把本機檔的內容畫在卡身上（跟檔案模式同一套畫法）。
// 讀不到（檔案沒了／不在允許範圍／類型不認得）就丟錯，呼叫端退回說明卡面。
async function paintLocalBody(ctx, W, H, file, tabH) {
  const kind = file.localKind;
  const url = '/api/file?path=' + encodeURIComponent(file.localPath);
  if (kind === 'image') { const img = await loadBitmap(url); paintImage(ctx, W, H, img, tabH); closeBitmap(img); return; }
  if (kind === 'pdf') return;   // PDF 卡只留檔名列（跟檔案模式一致）
  if (kind === 'video') { paintVideoBody(ctx, W, H, tabH); return; }
  if (kind === 'sheet') {
    const buf = await (await fetch(url).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r; })).arrayBuffer();
    if (typeof XLSX === 'undefined') throw new Error('xlsx lib missing');
    const wb = XLSX.read(buf, { type: 'array' });
    paintSheet(ctx, W, H, XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true }), tabH);
    return;
  }
  const r = await fetch(url + '&head=' + HEAD_BYTES);
  if (!r.ok) throw new Error('http ' + r.status);
  const text = await r.text();
  if (kind === 'markdown') paintMarkdown(ctx, W, H, text, tabH);
  else if (kind === 'json') paintJson(ctx, W, H, text, tabH);
  else if (kind === 'table') paintTable(ctx, W, H, text, pathExtOf(file.localPath) === '.tsv' ? '\t' : ',', tabH);
  else if (kind === 'html') paintHtml(ctx, W, H, text, tabH);
  else if (kind === 'code') paintCode(ctx, W, H, text, tabH);
  else paintPlain(ctx, W, H, text, false, tabH);
}
// 有代表圖（og:image）的卡：大圖鋪滿卡身上半（cover 裁切、置中），下半排摘要＋主內容文字
function paintTabOgBody(ctx, W, H, file, tabH, ogImg) {
  const PAD = 48;
  const imgH = Math.round((H - tabH) * 0.55);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, tabH, W, imgH);
  ctx.clip();
  const sc = Math.max(W / ogImg.width, imgH / ogImg.height);
  const dw = ogImg.width * sc, dh = ogImg.height * sc;
  ctx.drawImage(ogImg, (W - dw) / 2, tabH + (imgH - dh) / 2, dw, dh);
  ctx.restore();
  // 圖與文字之間一條淡邊
  ctx.strokeStyle = theme().paperEdge;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, tabH + imgH + 1); ctx.lineTo(W, tabH + imgH + 1); ctx.stroke();
  const y = paintTabTextBlock(ctx, W, H, tabCardModel(file), tabH + imgH + 20, PAD);
  if (file.tab.active) {
    ctx.font = `26px ${fontStack()}`;
    ctx.fillStyle = theme().dim;
    ctx.fillText(t('tabsActiveTab'), PAD, Math.min(y + 26, H - 30));
  }
}

async function buildTabCanvas(file) {
  const c = placeholderCanvasFull(file, TAB_HEAD_SCALE);
  c.themeGen = themeGen;
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  const tabH = Math.round(96 * TAB_HEAD_SCALE);
  let favImg = null;
  if (file.tab.fav && file.tab.fav.startsWith('data:')) {
    try { favImg = await loadImg(file.tab.fav); } catch (_) { favImg = null; }
  }
  const model = tabCardModel(file);
  if (model.mode === 'shot') {
    try {
      const img = await loadBitmap('/api/tabs/shot?id=' + encodeURIComponent(file.tab.id) + '&v=' + (file.tab.shotVer || 0));
      paintImage(ctx, W, H, img, tabH);
      closeBitmap(img);
    } catch (_) { paintTabFallbackBody(ctx, W, H, file, tabH, favImg); }
  } else if (model.mode === 'og') {
    try {
      const img = await loadBitmap('/api/tabs/og?id=' + encodeURIComponent(file.tab.id) + '&v=' + (file.tab.ogVer || 0));
      paintTabOgBody(ctx, W, H, file, tabH, img);
      closeBitmap(img);
    } catch (_) { paintTabFallbackBody(ctx, W, H, file, tabH, favImg); }
  } else if (model.mode === 'local') {
    try { await paintLocalBody(ctx, W, H, file, tabH); }
    catch (_) { paintExplainBody(ctx, W, H, tabH, '📄', t('tabsLocalGoneTitle'), t('tabsLocalGoneBody')); }
  } else if (model.mode === 'builtin') {
    paintExplainBody(ctx, W, H, tabH, '🧩', t('tabsBuiltinTitle'), t('tabsBuiltinBody'));
  } else if (model.mode === 'sleeping') {
    paintExplainBody(ctx, W, H, tabH, '💤', t('tabsSleepTitle'), t('tabsSleepBody'));
  } else {
    paintTabFallbackBody(ctx, W, H, file, tabH, favImg);
  }
  drawTab(ctx, W, file, TAB_HEAD_SCALE); // 檔名列（這裡是分頁標題）永遠畫在最上
  if (file.tab && !file.tab.note) drawTabBadges(ctx, W, H, { ai: panelAiBadge() });   // 右上角 ×（側欄多 ⧉）壓在檔名列之上
  return c;
}

// 網域首字母色塊圓：favicon 載不到時的替代圖示（同一網域固定同色，亮暗主題都吃白字）
function drawDomainBadge(ctx, domain, x, y, size) {
  let h = 0;
  for (const ch of String(domain)) h = (h * 31 + ch.codePointAt(0)) % 360;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, 7);
  ctx.fillStyle = `hsl(${h} 52% ${themeNow() === 'dark' ? 46 : 38}%)`;   // 兩邊都夠深，白字對比 ≥ 4.5:1
  ctx.fill();
  ctx.clip();
  const ch = (String(domain).replace(/^www\./, '')[0] || '?').toUpperCase();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(size * 0.54)}px ${fontStack()}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ch, x + size / 2, y + size / 2 + 2);
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}
// 安裝說明卡：擴充沒連上時卡堆裡的那一張
function buildTabNoteCanvas() {
  const c = placeholderCanvasFull({ name: t('tabsNoExtTitle'), path: 'tab://install', size: 0, mtime: Date.now(), ext: '.tab', kind: 'tab' });
  c.themeGen = themeGen;
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  const tabH = 96;
  let y = tabH + 52;
  for (const ln of t('tabsNoExtBody').split(/(?<=。)/)) {
    if (!ln.trim()) continue;
    y = drawLines(ctx, wrapText(ctx, ln.trim(), W - 64, 2), 32, y + 32, W - 64, 40, theme().text, false, 26) + 4;
  }
  y += 10;
  for (const ln of t('tabsNoExtSteps').split('\n')) {
    y = drawLines(ctx, [ln], 32, y + 30, W - 64, 38, ln.match(/^\d/) ? theme().heading : theme().text, false, 26) + 2;
    if (y > H - 40) break;
  }
  return c;
}

// ---- canvases ---------------------------------------------------------------
// 灰色骨架列：placeholder 卡在真貼圖出爐前至少看得出「這是一頁文字」
function drawSkeleton(ctx, W, tabH, H) {
  ctx.fillStyle = theme().skeleton;
  const widths = [0.86, 0.72, 0.8, 0.6];
  for (let i = 0; i < widths.length; i++) {
    const yy = tabH + Math.round(10 * (H / 500)) + i * Math.round(24 * (H / 500));
    if (yy > H - 20) break;
    ctx.beginPath();
    ctx.roundRect(18, yy, (W - 36) * widths[i], Math.round(10 * (H / 500)), 3);
    ctx.fill();
  }
}

export function placeholderCanvas(file) {
  const c = document.createElement('canvas');
  c.width = PH_W; c.height = PH_H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = theme().paper;
  ctx.fillRect(0, 0, PH_W, PH_H);
  ctx.strokeStyle = theme().paperEdge;
  ctx.strokeRect(0.5, 0.5, PH_W - 1, PH_H - 1);
  const tabH = drawTab(ctx, PH_W, file, 0.5);
  drawSkeleton(ctx, PH_W, tabH, PH_H);
  if (file.tab && !file.tab.note) drawTabBadges(ctx, PH_W, PH_H, { ai: panelAiBadge() });   // placeholder 階段 × 就要在（永遠顯示）
  if (!file.kind) {
    ctx.font = `22px ${fontStack()}`;
    ctx.fillStyle = theme().dim;
    ctx.fillText(t('thumbNoPreviewType'), 18, PH_H / 2 + 64);
  }
  return c;
}

// 共用灰骨架（不含檔名列）：離焦點太遠、根本看不見的卡就用這一張，
// 不要在綁卡時一口氣同步畫幾十張專屬 placeholder 卡住主執行緒。
// 卡滾近了（stack.js 的 phShared 近窗升級）才換成畫得出標題的專屬 placeholder。
const PH_BARE_HDR = 20;   // 假想檔名列高：無標題可畫，只在頂端留一條同比例邊距
// isTab＝分頁模式專用骨架：遠卡也一樣要畫右上角 ×（驗收：不 hover 也每張都有）
export function sharedPlaceholderCanvas(isTab) {
  const c = document.createElement('canvas');
  c.width = PH_W; c.height = PH_H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = theme().paper;
  ctx.fillRect(0, 0, PH_W, PH_H);
  ctx.strokeStyle = theme().paperEdge;
  ctx.strokeRect(0.5, 0.5, PH_W - 1, PH_H - 1);
  drawSkeleton(ctx, PH_W, PH_BARE_HDR, PH_H);
  if (isTab) drawTabBadges(ctx, PH_W, PH_H, { ai: panelAiBadge() });
  return c;
}

// builds the full 768x1000 thumbnail canvas for a file (async: fetches head bytes)
export async function buildThumbCanvas(file) {
  // 瀏覽器分頁卡：走自己的路（截圖／favicon），不碰 /api/file
  if (file.kind === 'tab' && file.tab) {
    return file.tab.note ? buildTabNoteCanvas() : buildTabCanvas(file);
  }
  const c = placeholderCanvasFull(file);
  c.themeGen = themeGen;
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  // 內文起點 = drawTab(scale 1) 的實際高度 96——之前寫死 116，底下留一條 20px 空白帶，
  // 後排卡正好只露出「那條空白」所以沒字。內文要緊貼檔名列。
  const tabH = 96;
  if (!file.kind) { drawTab(ctx, W, file, 1); return c; }   // binary: header only
  try {
    const url = '/api/file?path=' + encodeURIComponent(file.path);
    if (file.kind === 'image') {
      const img = await loadBitmap(url);
      paintImage(ctx, W, H, img, tabH);
      closeBitmap(img);
    } else if (file.kind === 'sheet') {
      const buf = await (await fetch(url).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r; })).arrayBuffer();
      if (typeof XLSX === 'undefined') throw new Error('xlsx lib missing');
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      paintSheet(ctx, W, H, XLSX.utils.sheet_to_json(ws, { header: 1, raw: true }), tabH);
    } else if (file.kind === 'pdf') {
      // 刻意為空（不可 fall through）：原 90px PDF 浮水印已移除——檔名已在檔名列，
      // 浮水印會蓋內文；PDF 卡只留頁籤，不 fetch 內容。
    } else if (file.kind === 'video') {
      paintVideoBody(ctx, W, H, tabH);
    } else {
      const r = await fetch(url + '&head=' + HEAD_BYTES);
      if (!r.ok) throw new Error('http ' + r.status);
      const text = await r.text();
      cacheHead(file.path, text);   // 留給 mirror.js 的 sr-only 預覽（不另外請求）
      if (file.kind === 'markdown') paintMarkdown(ctx, W, H, text, tabH);
      else if (file.kind === 'json') paintJson(ctx, W, H, text, tabH);
      else if (file.kind === 'table') paintTable(ctx, W, H, text, file.ext === '.tsv' ? '\t' : ',', tabH);
      else if (file.kind === 'html') paintHtml(ctx, W, H, text, tabH);
      else if (file.kind === 'code') paintCode(ctx, W, H, text, tabH);
      else paintPlain(ctx, W, H, text, false, tabH);
    }
  } catch (e) {
    ctx.font = `26px ${fontStack()}`;
    ctx.fillStyle = theme().err;
    ctx.fillText(t('thumbNoPreview'), 20, H / 2 - 30);
    ctx.fillStyle = theme().dim;
    ctx.font = `20px ${fontStack()}`;
    ctx.fillText(String(e.message || e).slice(0, 44), 20, H / 2 + 6);
  }
  drawTab(ctx, W, file, 1); // tab on top (image may overpaint the band)
  return c;
}

function placeholderCanvasFull(file, headScale) {
  const c = document.createElement('canvas');
  c.width = TEX_W; c.height = TEX_H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = theme().paper;
  ctx.fillRect(0, 0, TEX_W, TEX_H);
  ctx.strokeStyle = theme().paperEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, TEX_W - 2, TEX_H - 2);
  drawTab(ctx, TEX_W, file, headScale || 1);
  return c;
}

// ---- frame-budgeted build queue ---------------------------------------------
// fetch at most 2 concurrently; paint at most 1 per tick so the main thread
// never stalls on a burst of canvas work. cb(canvas) is called on success.
const pending = new Map();   // path -> { file, cbs: [fn] }
let inFlight = 0;

// 檔頭文字快取：縮圖本來就會抓 head bytes，順手留下來給 mirror.js 當
// sr-only 預覽行／搜尋命中行——mirror 絕不另外打 /api/file。
const headCache = new Map();   // path -> 前 8KB 文字（LRU 上限 80）
export function cachedHead(path) { return headCache.get(path); }
function cacheHead(path, text) {
  headCache.delete(path);
  headCache.set(path, text.slice(0, HEAD_BYTES));
  if (headCache.size > 80) headCache.delete(headCache.keys().next().value);
}

export function requestThumb(file, cb) {
  const key = file.path;
  const e = pending.get(key);
  if (e) { e.cbs.push(cb); return; }
  pending.set(key, { file, cbs: [cb] });
}

export function cancelThumb(path, cb) {
  const e = pending.get(path);
  if (!e) return;
  if (cb) {
    e.cbs = e.cbs.filter(f => f !== cb);
    if (!e.cbs.length && !e.building) pending.delete(path);
  } else pending.delete(path);
}

async function runOne(entry, key) {
  inFlight++;
  try {
    const canvas = await buildThumbCanvas(entry.file);
    paintQueue.push({ canvas, cbs: entry.cbs });
  } catch (_) { /* painters already draw errors; total failure = keep placeholder */ }
  inFlight--;
}

const paintQueue = [];       // [{canvas, cbs}] ready to hand to the GL layer

// called once per animation frame from the stack loop
export function pumpThumbs() {
  if (paintQueue.length) {
    const p = paintQueue.shift();
    for (const cb of p.cbs) cb(p.canvas);
  }
  if (inFlight < 2 && pending.size) {
    const [key, entry] = pending.entries().next().value;
    pending.delete(key);
    runOne(entry, key);
  }
}

export function thumbQueueSize() { return pending.size + paintQueue.length + inFlight; }
