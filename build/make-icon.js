// Draws the Layover mark (teal ring + marigold dot) as PNG and ICO with no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function raster(size) {
  const px = new Uint8ClampedArray(size * size * 4);
  const c = size / 2, R = size * 0.36, W = size * 0.085, dr = size * 0.075, dx = c + size * 0.22, dy = c - size * 0.22;
  const bgR = size * 0.46;
  const put = (i, r, g, b, a) => {
    const A = a / 255, oa = px[i + 3] / 255, na = A + oa * (1 - A);
    if (!na) return;
    px[i] = (r * A + px[i] * oa * (1 - A)) / na; px[i + 1] = (g * A + px[i + 1] * oa * (1 - A)) / na; px[i + 2] = (b * A + px[i + 2] * oa * (1 - A)) / na; px[i + 3] = na * 255;
  };
  const SS = 4; // supersampling
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let bg = 0, ring = 0, dot = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const X = x + (sx + .5) / SS - c, Y = y + (sy + .5) / SS - c;
      const d = Math.hypot(X, Y);
      if (d <= bgR) bg++;
      if (Math.abs(d - R) <= W / 2) ring++;
      if (Math.hypot(x + (sx + .5) / SS - dx, y + (sy + .5) / SS - dy) <= dr) dot++;
    }
    const i = (y * size + x) * 4, n = SS * SS;
    if (bg) put(i, 0xF6, 0xF5, 0xF2, 255 * bg / n);
    if (ring) put(i, 0x0F, 0x73, 0x6D, 255 * ring / n);
    if (dot) put(i, 0xC8, 0x87, 0x1B, 255 * dot / n);
  }
  return px;
}

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
function png(size) {
  const px = raster(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; raw.set(px.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function ico(sizes) {
  const images = sizes.map(s => ({ s, data: png(s) }));
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = [], blobs = [];
  for (const { s, data } of images) {
    const e = Buffer.alloc(16); e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e[2] = 0; e[3] = 0; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e); blobs.push(data); offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

/** Monochrome ring + dot for the macOS menu bar (template image: black on transparent). */
function trayPng(size) {
  const px = new Uint8ClampedArray(size * size * 4);
  const c = size / 2, R = size * 0.34, W = size * 0.11, dr = size * 0.09, dx = c + size * 0.24, dy = c - size * 0.24, SS = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let ring = 0, dot = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const X = x + (sx + .5) / SS - c, Y = y + (sy + .5) / SS - c, d = Math.hypot(X, Y);
      if (Math.abs(d - R) <= W / 2) ring++;
      if (Math.hypot(x + (sx + .5) / SS - dx, y + (sy + .5) / SS - dy) <= dr) dot++;
    }
    const i = (y * size + x) * 4, a = Math.min(255, 255 * (ring + dot) / (SS * SS));
    px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = a;
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; raw.set(px.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
fs.writeFileSync(path.join(here, 'trayTemplate.png'), trayPng(16));
fs.writeFileSync(path.join(here, 'trayTemplate@2x.png'), trayPng(32));
fs.writeFileSync(path.join(here, 'icon.png'), png(512));
fs.writeFileSync(path.join(here, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
console.log('wrote build/icon.png and build/icon.ico');
