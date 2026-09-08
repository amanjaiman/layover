// Minimal PNG read/write (8-bit RGB/RGBA, non-interlaced) and an area resampler. No dependencies,
// so the icon build runs on plain Node everywhere the release workflow does.
import zlib from 'node:zlib';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** {width, height, data: Uint8ClampedArray RGBA} from a PNG buffer. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw Error('not a PNG');
  let pos = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || ![2, 6].includes(ctype) || interlace) throw Error(`unsupported PNG (depth ${depth}, colour type ${ctype}, interlace ${interlace}); export as 8-bit RGB/RGBA, non-interlaced`);
  const bpp = ctype === 6 ? 4 : 3, stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8ClampedArray(width * height * 4);
  const prev = new Uint8Array(stride); let cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]; const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0; let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) { const o = (y * width + x) * 4, s = x * bpp; out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = bpp === 4 ? cur[s + 3] : 255; }
    prev.set(cur);
  }
  return { width, height, data: out };
}

export function encodePng({ width, height, data }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Area-average resample (premultiplied, so edges do not darken). Good for shrinking; adequate for mild enlarging. */
export function resample(img, dw, dh) {
  const { width: sw, height: sh, data: s } = img; const out = new Uint8ClampedArray(dw * dh * 4);
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * fy, y1 = (y + 1) * fy;
    for (let x = 0; x < dw; x++) {
      const x0 = x * fx, x1 = (x + 1) * fx;
      let r = 0, g = 0, b = 0, a = 0, w = 0;
      for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy); if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx); if (wx <= 0) continue;
          const k = wx * wy, i = (sy * sw + sx) * 4, al = s[i + 3] / 255;
          r += s[i] * al * k; g += s[i + 1] * al * k; b += s[i + 2] * al * k; a += al * k; w += k;
        }
      }
      const o = (y * dw + x) * 4;
      if (a > 0) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; out[o + 3] = 255 * a / w; }
    }
  }
  return { width: dw, height: dh, data: out };
}

/** Tight bounding box of non-transparent pixels. */
export function bounds(img, threshold = 8) {
  const { width, height, data } = img; let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > threshold) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function crop(img, { x0, y0, w, h }) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
  return { width: w, height: h, data: out };
}

/** Composite `top` over `base` at (dx, dy), both straight-alpha RGBA. */
export function over(base, top, dx, dy) {
  for (let y = 0; y < top.height; y++) for (let x = 0; x < top.width; x++) {
    const X = dx + x, Y = dy + y; if (X < 0 || Y < 0 || X >= base.width || Y >= base.height) continue;
    const i = (y * top.width + x) * 4, o = (Y * base.width + X) * 4, A = top.data[i + 3] / 255, oa = base.data[o + 3] / 255, na = A + oa * (1 - A);
    if (!na) continue;
    for (let c = 0; c < 3; c++) base.data[o + c] = (top.data[i + c] * A + base.data[o + c] * oa * (1 - A)) / na;
    base.data[o + 3] = na * 255;
  }
  return base;
}

/** Anti-aliased rounded square filled with a colour. */
export function roundedSquare(size, radius, [r, g, b], inset = 0) {
  const data = new Uint8ClampedArray(size * size * 4), SS = 4, lo = inset, hi = size - inset;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let n = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const X = x + (sx + .5) / SS, Y = y + (sy + .5) / SS;
      if (X < lo || Y < lo || X > hi || Y > hi) continue;
      const cx = Math.max(lo + radius, Math.min(hi - radius, X)), cy = Math.max(lo + radius, Math.min(hi - radius, Y));
      if (Math.hypot(X - cx, Y - cy) <= radius) n++;
    }
    const o = (y * size + x) * 4; data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255 * n / (SS * SS);
  }
  return { width: size, height: size, data };
}

export function blank(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; }
