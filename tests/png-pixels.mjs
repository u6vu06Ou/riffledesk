// tests/png-pixels.mjs — minimal PNG decoder for Chromium screenshots.
// The "run page scripts" regression proof needs real pixels (an opaque-origin
// iframe is unreadable from the parent page), and this repo stays zero-dep,
// so screenshots are decoded right here.
// Handles the shapes Chromium produces: 8-bit, color type 2 (RGB) or 6 (RGBA),
// non-interlaced, all five scanline filters.
import zlib from 'node:zlib';

export function decodePng(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('not a png');
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('unsupported bit depth ' + bitDepth);
  if (colorType !== 2 && colorType !== 6) throw new Error('unsupported color type ' + colorType);
  if (interlace !== 0) throw new Error('unsupported interlace ' + interlace);
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // raw = per-row: 1 filter byte + stride bytes
  const px = Buffer.alloc(width * height * 4); // unfiltered RGBA
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    raw.copy(cur, 0, p, p + stride);
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;   // left
      const b = prev[x];                        // up
      const c = x >= bpp ? prev[x - bpp] : 0;   // up-left
      let v = cur[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      cur[x] = v;
    }
    for (let x = 0; x < width; x++) {
      const s = x * bpp, d = (y * width + x) * 4;
      px[d] = cur[s]; px[d + 1] = cur[s + 1]; px[d + 2] = cur[s + 2];
      px[d + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
    cur.copy(prev, 0);
  }
  return {
    width, height,
    px(x, y) {
      const d = (y * width + x) * 4;
      return [px[d], px[d + 1], px[d + 2], px[d + 3]];
    }
  };
}
