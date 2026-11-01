// scripts/gen-icons.mjs — 產生 RiffleDesk 的 PWA 圖示（public/icons/icon-192.png、icon-512.png）。
// 零相依：自己畫像素（深底圓角方塊＋三張扇形散開的卡片，最前面那張帶文字行），
// 自行編碼 PNG（zlib deflate）。跑法：node scripts/gen-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// ---------------------------------------------------------------- png 編碼
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, data, crc]);
}
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));   // filter byte 0 per row
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (1 + w * 4) + 1);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- 畫面
const hex = s => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const C = {
  bg: hex('#171a1f'),
  cardBack: hex('#2c3138'),
  cardMid: hex('#4a5f80'),
  cardFront: hex('#f2ecdd'),
  line: hex('#3a3229'),
  accent: hex('#4a7fd8')
};

// 點是否在「以 (cx,cy) 為中心、旋轉 rot 度、寬 w 高 h 的圓角矩形」內（圓角半徑 rad）
function inCard(x, y, cx, cy, rot, w, h, rad) {
  const a = -rot * Math.PI / 180;
  const dx = x - cx, dy = y - cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  const hw = w / 2, hh = h / 2;
  if (Math.abs(lx) > hw || Math.abs(ly) > hh) return false;
  const qx = Math.max(Math.abs(lx) - (hw - rad), 0);
  const qy = Math.max(Math.abs(ly) - (hh - rad), 0);
  return qx * qx + qy * qy <= rad * rad;
}
// 前卡的「文字行」：在前卡的 local 座標系裡是一條條橫槓
const inFrontLine = (() => {
  const rows = [0.00, 0.16, 0.32, 0.48];   // 相對卡面（-0.5~0.5）
  const widths = [0.62, 0.78, 0.70, 0.45];
  return (x, y, cx, cy, rot, w, h) => {
    const a = -rot * Math.PI / 180;
    const dx = x - cx, dy = y - cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    const ry = ly / h, rx = lx / w;
    for (let i = 0; i < rows.length; i++) {
      if (Math.abs(ry - rows[i]) < 0.045 && rx > -0.36 && rx < -0.36 + widths[i]) return true;
    }
    // 藍色標題槓
    if (Math.abs(ry + 0.28) < 0.05 && rx > -0.36 && rx < 0.36) return 'accent';
    return false;
  };
})();

function makeIcon(size) {
  const S = size;
  const img = new Uint8Array(S * S * 4);
  const rad = S * 0.16;                     // 外框圓角
  const cw = S * 0.56, ch = S * 0.36;       // 卡尺寸（1.55:1）
  const cx0 = S / 2, cy0 = S * 0.54;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4;
      // 底：圓角深色方塊（外面透明）
      if (!inCard(x, y, S / 2, S / 2, 0, S * 0.86, S * 0.86, rad)) continue;
      let col = C.bg;
      if (inCard(x, y, cx0 - S * 0.10, cy0 - ch * 0.16, 11, cw, ch, rad * 0.2)) col = C.cardBack;
      if (inCard(x, y, cx0 + S * 0.10, cy0 - ch * 0.16, -9, cw, ch, rad * 0.2)) col = C.cardMid;
      if (inCard(x, y, cx0, cy0 + ch * 0.06, 0, cw * 1.04, ch * 1.04, rad * 0.2)) {
        col = C.cardFront;
        const ln = inFrontLine(x, y, cx0, cy0 + ch * 0.06, 0, cw * 1.04, ch * 1.04);
        if (ln === 'accent') col = C.accent;
        else if (ln) col = C.line;
      }
      img[o] = col[0]; img[o + 1] = col[1]; img[o + 2] = col[2]; img[o + 3] = 255;
    }
  }
  return encodePng(img, S, S);
}

fs.mkdirSync(OUT, { recursive: true });
for (const sz of [192, 512]) {
  const f = path.join(OUT, `icon-${sz}.png`);
  fs.writeFileSync(f, makeIcon(sz));
  console.log(`${path.relative(process.cwd(), f)}  (${fs.statSync(f).size} bytes)`);
}
// 瀏覽器擴充也要一組（工具列/about:addons 圖示）：32 給工具列、128 給擴充管理頁
const OUT_EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
fs.mkdirSync(OUT_EXT, { recursive: true });
for (const sz of [32, 128]) {
  const f = path.join(OUT_EXT, `icon-${sz}.png`);
  fs.writeFileSync(f, makeIcon(sz));
  console.log(`${path.relative(process.cwd(), f)}  (${fs.statSync(f).size} bytes)`);
}
