// pptxview.js — 純瀏覽器端 .pptx（OOXML）檢視。
// fflate 解 ZIP → DOMParser 解 XML → 每張投影片渲染成一張等比縮放的 HTML 卡。
// MVP 範圍：文字框（p:sp）＋圖片（p:pic）＋基本位置（a:xfrm 的 off/ext）。
// 不做：動畫、SmartArt、母片／版式繼承、舊 .ppt 二進位格式。
// 供 reader.js（閱讀面板）與 thumbs.js（卡面縮圖）共用。
import { t } from './i18n.js';

export const EMU_PER_PX = 914400 / 96;   // 1 英寸 = 914400 EMU = 96 CSS px

// 命名空間通配：DOMParser 產生的 XML 節點都帶 p:/a:/r: 前綴，統統用 localName 找。
function els(node, local) {
  return node ? Array.from(node.getElementsByTagNameNS('*', local)) : [];
}
function first(node, local) { return els(node, local)[0] || null; }
function kids(node, local) {
  if (!node) return [];
  return Array.from(node.childNodes).filter(n => n.nodeType === 1 && n.localName === local);
}

// rels 檔：Relationship Id → 解析後的 ZIP 內路徑。
function parseRels(files, relsPath, baseDir, dec) {
  const bytes = files[relsPath];
  const map = new Map();
  if (!bytes) return map;
  const doc = new DOMParser().parseFromString(dec.decode(bytes), 'text/xml');
  for (const rel of els(doc, 'Relationship')) {
    const id = rel.getAttribute('Id');
    let target = rel.getAttribute('Target') || '';
    if (!id || !target) continue;
    if (/^[a-z]+:/i.test(target)) continue;             // 外部連結不收
    if (target.startsWith('/')) target = target.slice(1);
    else if (baseDir) {
      // 相對於 rels 屬主的目錄解析 ../
      const parts = (baseDir + '/' + target).split('/');
      const out = [];
      for (const p of parts) {
        if (p === '..') out.pop();
        else if (p !== '.' && p !== '') out.push(p);
      }
      target = out.join('/');
    }
    map.set(id, target);
  }
  return map;
}

// p:sp（文字框）：段落＋字級。回 null 代表整個 shape 沒文字。
function parseSp(sp) {
  const tx = first(sp, 'txBody');
  if (!tx) return null;
  const paras = [];
  for (const p of els(tx, 'p')) {
    let text = '';
    let sz = 0;   // 百分之一磅
    for (const node of p.childNodes) {
      if (node.nodeType !== 1) continue;
      if (node.localName === 'br') { text += '\n'; continue; }
      if (node.localName !== 'r' && node.localName !== 'fld') continue;
      const tEl = first(node, 't');
      if (tEl) text += tEl.textContent || '';
      const rPr = first(node, 'rPr');
      const s2 = rPr && parseInt(rPr.getAttribute('sz') || '0', 10);
      if (s2 > sz) sz = s2;
    }
    if (!text && !sz) continue;   // 空段落（常見：結尾多一個 <a:p/>）
    paras.push({ text, pt: sz ? sz / 100 : 0 });
  }
  if (!paras.length) return null;
  return paras;
}

// shape 位置：spPr 或 pic 的 spPr 底下的 a:xfrm（off/ext）。沒有的話回 null → 流式排列。
function getXfrm(shapeEl) {
  const spPr = kids(shapeEl, 'spPr')[0];
  const xfrm = spPr ? kids(spPr, 'xfrm')[0] : null;
  if (!xfrm) return null;
  const off = kids(xfrm, 'off')[0], ext = kids(xfrm, 'ext')[0];
  if (!off || !ext) return null;
  return {
    x: +off.getAttribute('x') || 0, y: +off.getAttribute('y') || 0,
    cx: +ext.getAttribute('cx') || 0, cy: +ext.getAttribute('cy') || 0
  };
}

const PIC_EXTS = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

// 解析整份 pptx。buf 是 ArrayBuffer。回：
// { wPx, hPx, slides: [ { items: [...], text: '純文字（給 Ctrl+F）' } ] }，所有位置已是 px。
//   items: { type:'text', x,y,cx,cy|null, paras:[{text,pt}] } | { type:'pic', x,y,cx,cy|null, blob, url, name }
// blob 保留給縮圖（createImageBitmap），url（blob:）給 <img>。
export function parsePptx(buf) {
  if (typeof fflate === 'undefined') throw new Error('fflate lib missing');
  const files = fflate.unzipSync(new Uint8Array(buf));
  const dec = new TextDecoder();
  const xmlOf = name => {
    const b = files[name];
    return b ? new DOMParser().parseFromString(dec.decode(b), 'text/xml') : null;
  };
  const pres = xmlOf('ppt/presentation.xml');
  if (!pres) throw new Error('not a valid pptx (missing ppt/presentation.xml)');
  // 投影片尺寸（EMU）；舊檔沒寫就退預設 10"×7.5"
  const sldSz = first(pres, 'sldSz');
  const wPx = Math.round((+((sldSz && sldSz.getAttribute('cx')) || 9144000)) / EMU_PER_PX);
  const hPx = Math.round((+((sldSz && sldSz.getAttribute('cy')) || 6858000)) / EMU_PER_PX);
  // 順序：sldIdLst 的 r:id → presentation.xml.rels → slides/slideN.xml
  const presRels = parseRels(files, 'ppt/_rels/presentation.xml.rels', 'ppt', dec);
  const slidePaths = els(pres, 'sldId')
    .map(n => presRels.get(n.getAttribute('r:id')))
    .filter(Boolean);
  const slides = [];
  for (const sp of slidePaths) {
    const doc = xmlOf(sp);
    if (!doc) continue;
    const baseDir = sp.includes('/') ? sp.slice(0, sp.lastIndexOf('/')) : '';
    const rels = parseRels(files, baseDir + '/_rels/' + sp.split('/').pop() + '.rels', baseDir, dec);
    slides.push(parseSlide(doc, rels, files));
  }
  return {
    wPx, hPx, slides,
    // 這份解析產生的全部 blob URL（renderSlides 換檔時整批回收）
    blobUrls: slides.flatMap(s => s.items.filter(i => i.type === 'pic').map(i => i.url))
  };
}

function parseSlide(doc, rels, files) {
  const slide = { items: [], text: '' };
  const spTree = first(doc, 'spTree');
  if (!spTree) return slide;

  const walk = (parent) => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType !== 1) continue;
      if (node.localName === 'grpSp') { walk(node); continue; }   // 群組遞迴（xfrm 當 identity）
      if (node.localName === 'sp') {
        const paras = parseSp(node);
        if (!paras) continue;
        slide.items.push({ type: 'text', frame: getXfrm(node), paras });
      } else if (node.localName === 'pic') {
        const blip = first(node, 'blip');
        const rid = blip && (blip.getAttribute('r:embed') || blip.getAttribute('r:link'));
        const target = rid && rels.get(rid);
        const bytes = target && files[target];
        if (!bytes || !PIC_EXTS.test(target)) continue;
        const blob = new Blob([bytes]);
        slide.items.push({
          type: 'pic', frame: getXfrm(node), blob,
          url: URL.createObjectURL(blob), name: target.split('/').pop()
        });
      }
    }
  };
  walk(spTree);

  // 純文字（Ctrl+F 抓得到）：段落依 shape 順序排
  slide.text = slide.items
    .filter(i => i.type === 'text')
    .map(i => i.paras.map(p => p.text).join('\n'))
    .filter(Boolean)
    .join('\n');
  return slide;
}

// ---- 渲染：每張投影片一張等比縮放的卡 ----
// 外層 100% 寬、aspect-ratio 固定；內層固定 wPx×hPx、transform: scale，欄寬變就重算。
const observed = new Map();   // container → ResizeObserver
let liveBlobUrls = [];        // 上一份 render 出去的 blob URL（換檔時整批回收）

export function renderSlides(container, parsed) {
  // 換檔／重渲染：回收上一批 blob URL（reader 換檔會先清容器，靠容器查不到舊 <img>，所以記模組層）
  for (const u of liveBlobUrls) { try { URL.revokeObjectURL(u); } catch (_) {} }
  liveBlobUrls = parsed.blobUrls || [];
  disposeSlides(container);
  container.innerHTML = '';
  container.classList.add('pptx-view');
  container.style.cssText = 'display:block;overflow:auto;height:100%;padding:12px;background:transparent;';
  const { wPx, hPx, slides } = parsed;
  if (!slides.length) {
    const p = document.createElement('p');
    p.className = 'msg-dim';
    // i18n.js 不在本單准改範圍：套用既有的「不支援內容預覽」鍵
    p.textContent = t('noPreviewType');
    container.appendChild(p);
    return;
  }
  const innerNodes = [];
  for (const slide of slides) {
    const outer = document.createElement('div');
    outer.className = 'pptx-slide';
    outer.style.cssText =
      'position:relative;width:100%;margin:0 auto 16px auto;box-shadow:0 2px 10px rgba(0,0,0,.25);' +
      `aspect-ratio:${wPx}/${hPx};background:#fff;color:#222;overflow:hidden;border-radius:2px;`;
    const inner = document.createElement('div');
    inner.className = 'pptx-slide-inner';
    inner.style.cssText =
      `position:absolute;left:0;top:0;width:${wPx}px;height:${hPx}px;transform-origin:0 0;`;
    let flowY = 24;   // 沒位置的東西依序往下排
    for (const item of slide.items) {
      if (item.type === 'text') {
        const d = document.createElement('div');
        d.className = 'pptx-text';
        const f = item.frame;
        if (f) {
          d.style.cssText = `position:absolute;left:${f.x / EMU_PER_PX}px;top:${f.y / EMU_PER_PX}px;` +
            `width:${f.cx / EMU_PER_PX}px;height:${f.cy / EMU_PER_PX}px;overflow:hidden;`;
        } else {
          d.style.cssText = `position:absolute;left:24px;top:${flowY}px;width:${wPx - 48}px;overflow:hidden;`;
        }
        for (const para of item.paras) {
          const pe = document.createElement('div');
          pe.className = 'pptx-para';
          if (para.pt) pe.style.fontSize = (para.pt * 96 / 72) + 'px';
          else pe.style.fontSize = '18px';
          pe.textContent = para.text || ' ';
          d.appendChild(pe);
          if (!f) flowY += (para.pt ? para.pt * 96 / 72 : 18) * 1.3;
        }
        if (!f) flowY += 12;
        inner.appendChild(d);
      } else if (item.type === 'pic') {
        const img = document.createElement('img');
        img.className = 'pptx-pic';
        img.src = item.url;
        img.alt = item.name || '';
        const f = item.frame;
        if (f) {
          img.style.cssText = `position:absolute;left:${f.x / EMU_PER_PX}px;top:${f.y / EMU_PER_PX}px;` +
            `width:${f.cx / EMU_PER_PX}px;height:${f.cy / EMU_PER_PX}px;object-fit:fill;`;
        } else {
          img.style.cssText = `position:absolute;left:24px;top:${flowY}px;max-width:${wPx - 48}px;max-height:${hPx / 2}px;`;
          flowY += hPx / 2 + 16;
        }
        inner.appendChild(img);
      }
    }
    outer.appendChild(inner);
    container.appendChild(outer);
    innerNodes.push(inner);
  }
  const rescale = () => {
    // 用外層卡的實寬當縮放基準（width:100% 自然扣掉容器 padding）
    const outer = innerNodes[0] && innerNodes[0].parentElement;
    const cw = outer ? outer.clientWidth : container.clientWidth;
    if (!cw) return;
    const s = cw / wPx;
    for (const n of innerNodes) {
      if (!n.isConnected) continue;
      n.style.transform = `scale(${s})`;
      n.parentElement.style.height = (hPx * s) + 'px';
    }
  };
  rescale();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(rescale);
    ro.observe(container);
    observed.set(container, ro);
  }
}

// 換檔／重渲染前回收：blob URL＋ResizeObserver
export function disposeSlides(container) {
  const ro = observed.get(container);
  if (ro) { ro.disconnect(); observed.delete(container); }
  for (const img of container.querySelectorAll('img.pptx-pic')) {
    if (img.src && img.src.startsWith('blob:')) { try { URL.revokeObjectURL(img.src); } catch (_) {} }
  }
  liveBlobUrls = [];
}

// ---- 縮圖（thumbs.js 用）：解析 + 第一張投影片的文字行／第一張圖 ----
// 回 { title, lines, bitmap|null }；fflate 不在直接丟錯（呼叫端畫通用圖示）。
// parsePptx 會替「全部投影片」的圖各建一個 blob URL；縮圖只用到第一張圖，
// 而且走 createImageBitmap(blob)——bitmap 解碼完成後像素已離開 blob，所以
// return 前把 parsed.blobUrls 整批 revoke（renderSlides 那條路另有 liveBlobUrls 管）。
export async function pptxThumb(buf) {
  const parsed = parsePptx(buf);
  try {
    const slide = parsed.slides[0];
    if (!slide) return { title: '', lines: [], bitmap: null };
    const lines = [];
    for (const item of slide.items) {
      if (item.type !== 'text') continue;
      for (const p of item.paras) {
        const s = (p.text || '').trim();
        if (s) lines.push({ text: s, pt: p.pt || 0 });
      }
    }
    lines.sort((a, b) => b.pt - a.pt);   // 最大字的排前面＝多半是標題
    let bitmap = null;
    const pic = slide.items.find(i => i.type === 'pic');
    if (pic) { try { bitmap = await createImageBitmap(pic.blob); } catch (_) { bitmap = null; } }
    return { title: lines.length ? lines[0].text : '', lines, bitmap };
  } finally {
    for (const u of parsed.blobUrls || []) { try { URL.revokeObjectURL(u); } catch (_) {} }
  }
}
