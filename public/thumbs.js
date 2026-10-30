// thumbnail painters (pure canvas, no three.js) + frame-budgeted build queue.
import { t } from './i18n.js';
import { fmtSize, fmtDate, KIND_LABEL, kindOf, theme, themeGen, kindColor } from './util.js';
import { fontStack } from './fonts.js';
import { thumbCodeColors, tokenizeLine } from './codetheme.js';

export const TEX_W = 1280, TEX_H = 800;         // full thumbnail canvas（1.6:1 寬卡，與 stack.js CARD_W/CARD_H 同比例）
const PH_W = 640, PH_H = 400;                   // placeholder canvas（同 1.6:1）
const HEAD_BYTES = 8192;                        // thumbnails only need the file head

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
  ctx.fillText(ellipsis(ctx, file.name, W - Math.round(28 * scale) - (badge ? Math.round(80 * scale) : 0)), Math.round(14 * scale), Math.round(46 * scale));
  ctx.font = `${Math.round(19 * scale)}px ${fontStack()}`;
  ctx.globalAlpha = 0.92;
  ctx.fillText(
    `${fmtSize(file.size)} · ${fmtDate(file.mtime)} · ${KIND_LABEL[kindOf(file)] || file.ext}`,
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

function paintJson(ctx, W, H, text, tabH) {
  let pretty = text;
  try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
  const lines = pretty.split(/\r?\n/).slice(0, 40);
  let y = tabH + 26;
  ctx.font = '22px Consolas, monospace';
  for (const ln of lines) {
    if (y > H - 24) break;
    const m = ln.match(/^(\s*)"(.*?)"(\s*:\s*)(.*)$/);
    if (m) {
      let x = 16;
      ctx.fillStyle = theme().dim;
      if (m[1]) { ctx.fillText(m[1], x, y); x += ctx.measureText(m[1]).width; }
      ctx.fillStyle = theme().jsonKey;
      const key = `"${m[2]}"`;
      ctx.fillText(key, x, y); x += ctx.measureText(key).width;
      ctx.fillStyle = theme().dim;
      ctx.fillText(m[3], x, y); x += ctx.measureText(m[3]).width;
      const v = m[4];
      ctx.fillStyle = /^"/.test(v) ? theme().jsonStr : /^-?[\d.]/.test(v) ? theme().jsonNum : theme().dim;
      ctx.fillText(ellipsis(ctx, v, 16 + W - 32 - x), x, y);
    } else {
      ctx.fillStyle = theme().text;
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
  if (!file.kind) {
    ctx.font = `22px ${fontStack()}`;
    ctx.fillStyle = theme().dim;
    ctx.fillText(t('thumbNoPreviewType'), 18, PH_H / 2 + 64);
  }
  return c;
}

// builds the full 768x1000 thumbnail canvas for a file (async: fetches head bytes)
export async function buildThumbCanvas(file) {
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
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = url;
      });
      paintImage(ctx, W, H, img, tabH);
    } else if (file.kind === 'sheet') {
      const buf = await (await fetch(url).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r; })).arrayBuffer();
      if (typeof XLSX === 'undefined') throw new Error('xlsx lib missing');
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      paintSheet(ctx, W, H, XLSX.utils.sheet_to_json(ws, { header: 1, raw: true }), tabH);
    } else if (file.kind === 'pdf') {
      // 刻意為空（不可 fall through）：原 90px PDF 浮水印已移除——檔名已在檔名列，
      // 浮水印會蓋內文；PDF 卡只留頁籤，不 fetch 內容。
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

function placeholderCanvasFull(file) {
  const c = document.createElement('canvas');
  c.width = TEX_W; c.height = TEX_H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = theme().paper;
  ctx.fillRect(0, 0, TEX_W, TEX_H);
  ctx.strokeStyle = theme().paperEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, TEX_W - 2, TEX_H - 2);
  drawTab(ctx, TEX_W, file, 1);
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
