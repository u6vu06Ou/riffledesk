// 快速跳轉捲軸：卡堆右側一條細軌，檔案很多（幾百、幾千張）時拖曳直接跳到第 N 張。
// 拖曳中顯示目標卡的檔名與日期；少於 SCRUB_MIN 張時藏起來（滾輪就夠用）。
import { t } from './i18n.js';

const SCRUB_MIN = 30;
const TOP = 84, BOTTOM = 70;   // 讓開右上張數、下方視角按鈕列

export function attachScrubber(stack) {
  const el = document.createElement('div');
  el.id = 'scrub';
  el.innerHTML = '<div class="track"><div class="thumb"></div></div><div class="tip"></div>';
  document.body.appendChild(el);
  const track = el.querySelector('.track'), thumb = el.querySelector('.thumb'), tip = el.querySelector('.tip');
  el.title = t('scrubTitle');
  let dragging = false;

  const idxAt = clientY => {
    const r = track.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    return Math.round(f * stack.scrollMax());
  };
  const countNow = () => (typeof stack.total === 'number' ? stack.total : stack.view.length);
  const label = i => {
    const f = stack.view[i];
    const n = countNow();
    if (!f) return t('scrubAt', { a: i + 1, n }); // 分頁大資料夾：還沒載入到的位置只顯示張數
    const d = f.mtime ? new Date(f.mtime) : null;
    const ds = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
    return t('scrubAt', { a: i + 1, n }) + ' · ' + f.name + (ds ? ' · ' + ds : '');
  };
  const showTip = (i, clientY) => {
    tip.textContent = label(i);
    tip.style.top = (clientY - el.getBoundingClientRect().top - 12) + 'px';
    tip.classList.add('on');
  };
  const go = e => { const i = idxAt(e.clientY); stack._jumpTo = i; stack.poke(); stack.maybeRequestMore && stack.maybeRequestMore(); showTip(i, e.clientY); };

  track.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    dragging = true; el.classList.add('drag'); track.setPointerCapture(e.pointerId); go(e);
  });
  track.addEventListener('pointermove', e => {
    if (dragging) go(e);
    else showTip(idxAt(e.clientY), e.clientY);
  });
  const end = () => { dragging = false; el.classList.remove('drag'); tip.classList.remove('on'); };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('pointerleave', () => { if (!dragging) tip.classList.remove('on'); });
  el.addEventListener('wheel', e => e.stopPropagation());

  // 每幀跟著堆視區位置與目前張數走（便宜：只改 style，數值沒變就不動）
  let last = '';
  const loop = () => {
    const n = countNow(), v = stack.viewCss;
    const show = n >= SCRUB_MIN && v.w > 360;
    const max = Math.max(1, stack.scrollMax());
    const f = Math.min(1, Math.max(0, stack.scrollCur / max));
    const key = [show, Math.round(v.x + v.w), Math.round(f * 1000), innerHeight].join('|');
    if (key !== last) {
      last = key;
      el.style.display = show ? '' : 'none';
      el.style.left = Math.round(v.x + v.w - 22) + 'px';
      el.style.top = TOP + 'px';
      el.style.height = Math.max(80, innerHeight - TOP - BOTTOM) + 'px';
      thumb.style.top = `calc((100% - 28px) * ${f.toFixed(4)})`;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
