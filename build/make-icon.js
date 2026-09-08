// Builds every icon from build/logo.png (the folded-L mark, iris gradient, transparent background):
//   icon.png       1024, transparent   Windows/Linux app icon, notifications, Windows tray (resized by the app)
//   icon.ico       16…256              Windows executable and installer
//   icon-mac.png   1024                the mark on a rounded off-white tile with the macOS margin, for .icns
//   trayTemplate*.png                  black silhouette for the macOS menu bar (template image)
//   src/renderer/logo.png  96          the mark in the app's rail
// No dependencies: runs on plain Node in the release workflow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, resample, bounds, crop, over, roundedSquare, blank } from './png.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = decodePng(fs.readFileSync(path.join(here, 'logo.png')));
const mark = crop(source, bounds(source));

/** The mark centred on a transparent square, its taller side filling `fill` of the canvas. */
function markOn(size, fill, base = blank(size, size), dy = 0) {
  const scale = (size * fill) / Math.max(mark.width, mark.height);
  const w = Math.max(1, Math.round(mark.width * scale)), h = Math.max(1, Math.round(mark.height * scale));
  return over(base, resample(mark, w, h), Math.round((size - w) / 2), Math.round((size - h) / 2 + dy));
}

function ico(frames) {
  const images = frames.map(f => ({ s: f.width, data: encodePng(f) }));
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length; const entries = [], blobs = [];
  for (const { s, data } of images) {
    const e = Buffer.alloc(16); e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e); blobs.push(data); offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

/** Black silhouette of the mark for the menu bar; macOS tints template images itself. */
function trayTemplate(size) {
  const img = markOn(size, 0.9);
  for (let i = 0; i < img.data.length; i += 4) { img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0; img.data[i + 3] = Math.min(255, img.data[i + 3] * 1.15); }
  return img;
}

// App icon: a little breathing room so Windows does not clip the fold at small sizes.
fs.writeFileSync(path.join(here, 'icon.png'), encodePng(markOn(1024, 0.86)));
fs.writeFileSync(path.join(here, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map(s => markOn(s, s <= 32 ? 0.96 : 0.9))));

// macOS: the tile occupies 824/1024 of the canvas with ~22.4% corner radius, as Apple's grid does.
const macSize = 1024, tile = 824, inset = (macSize - tile) / 2;
const macBase = roundedSquare(macSize, tile * 0.224, [0xF6, 0xF5, 0xF2], inset);
fs.writeFileSync(path.join(here, 'icon-mac.png'), encodePng(markOn(macSize, 0.56, macBase)));

fs.writeFileSync(path.join(here, 'trayTemplate.png'), encodePng(trayTemplate(16)));
fs.writeFileSync(path.join(here, 'trayTemplate@2x.png'), encodePng(trayTemplate(32)));
fs.writeFileSync(path.join(here, '..', 'src', 'renderer', 'logo.png'), encodePng(markOn(96, 1)));
console.log('wrote build/icon.png, icon.ico, icon-mac.png, trayTemplate*.png and src/renderer/logo.png from build/logo.png');
