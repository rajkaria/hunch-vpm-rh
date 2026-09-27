/**
 * Render the brand geometry to the raster files a browser needs: favicons and
 * the app icons. (The share card is src/app/opengraph-image.tsx, drawn with
 * next/og at build time from the same staged SVG paths.)
 *
 * The identity is drawn from its own numbers, not traced from a screenshot and
 * not typeset in a substitute font: a half-circle of radius 17 cut through the
 * bottom edge of a hard 88x88 block on a 100-unit grid, the same construction
 * the staged SVGs use, evaluated per pixel here.
 *
 * The outputs are committed, so a build never depends on running this. Re-run
 * it with `pnpm --filter @hunch-rh/web icons` if the geometry ever changes.
 *
 * Rules obeyed here, from the brand guidelines: no glow, no gradient, no
 * shadow on an identity element; the block's corners are never rounded (the
 * app-icon tile's rounded corner is the tile, not the block); both axes scale
 * together; clear space is at least 17 grid units on every side.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const INK = [0x08, 0x08, 0x0a];
const PAPER = [0xf4, 0xf4, 0xf2];
const LIME = [0xc8, 0xf0, 0x4f];

// ------------------------------------------------------------------ geometry

/**
 * The mark, on its own 100-unit grid: a hard 88x88 block from 6 to 94, with an
 * arch driven through its bottom edge. The arch is a 34-wide rectangle from
 * y=48 down through the bottom, capped by a half-circle of radius 17 centred
 * on (50, 48) — which is the single module the whole identity is built from.
 *
 * `opening` widens it for the small master, which is the version that stays
 * legible at 16px.
 */
function markInside(x, y, opening = 17) {
  const inBlock = x >= 6 && x <= 94 && y >= 6 && y <= 94;
  if (!inBlock) return false;
  const cx = 50;
  const cy = 48;
  const inColumn = x >= cx - opening && x <= cx + opening && y >= cy;
  const dx = x - cx;
  const dy = y - cy;
  const inCap = y <= cy && dx * dx + dy * dy <= opening * opening;
  return !(inColumn || inCap);
}

// ------------------------------------------------------------------ raster

/** A canvas of straight RGB bytes plus an alpha plane, painted by predicates. */
function canvas(width, height, background) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = background[0];
    pixels[i * 4 + 1] = background[1];
    pixels[i * 4 + 2] = background[2];
    pixels[i * 4 + 3] = background.length > 3 ? background[3] : 255;
  }
  return { width, height, pixels };
}

/**
 * Paint `colour` wherever `inside(u, v)` holds, with 4x4 supersampling for the
 * edges. Everything in this identity is a straight edge or a circle, so a
 * fixed grid is enough — there is no thin diagonal to alias badly.
 */
function paint(target, inside, colour, samples = 4) {
  const step = 1 / samples;
  const offset = step / 2;
  for (let py = 0; py < target.height; py++) {
    for (let px = 0; px < target.width; px++) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          if (inside(px + offset + sx * step, py + offset + sy * step)) hits++;
        }
      }
      if (hits === 0) continue;
      const alpha = hits / (samples * samples);
      const index = (py * target.width + px) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const under = target.pixels[index + channel];
        target.pixels[index + channel] = Math.round(colour[channel] * alpha + under * (1 - alpha));
      }
      target.pixels[index + 3] = Math.max(target.pixels[index + 3], Math.round(255 * alpha));
    }
  }
}

/** A rounded rectangle, used only for the app-icon tile's own corner. */
function roundedRect(x0, y0, x1, y1, radius) {
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
    const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };
}

/** Map a predicate defined on a source grid onto a placed, uniformly scaled box. */
function placed(inside, originX, originY, scale) {
  // Both axes take the same scale. Nothing in this identity is ever stretched.
  return (x, y) => inside((x - originX) / scale, (y - originY) / scale);
}

// ------------------------------------------------------------------ png

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function toPng(target) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(target.width, 0);
  header.writeUInt32BE(target.height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = target.width * 4;
  const raw = Buffer.alloc((stride + 1) * target.height);
  for (let y = 0; y < target.height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(target.pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An ICO holding PNG payloads, which every browser that matters reads. */
function toIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const at = index * 16;
    directory[at] = image.size >= 256 ? 0 : image.size;
    directory[at + 1] = image.size >= 256 ? 0 : image.size;
    directory[at + 2] = 0;
    directory[at + 3] = 0;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(image.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

// ------------------------------------------------------------------ the files

/**
 * The app-icon tile: a lime ground with the mark knocked out in ink, exactly
 * the staged `hunch-tile.svg` — the mark inset by 112 of 512 and scaled 2.88,
 * which leaves far more than the 17-unit clear space on every side.
 */
function tile(size, opening = 17) {
  const target = canvas(size, size, [0, 0, 0, 0]);
  const scale = size / 512;
  paint(target, roundedRect(0, 0, size, size, 112 * scale), LIME);
  paint(target, placed((x, y) => markInside(x, y, opening), 112 * scale, 112 * scale, 2.88 * scale), INK);
  return target;
}

function write(relative, data) {
  const path = join(ROOT, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log(`${relative}  ${(data.length / 1024).toFixed(1)} kB`);
}

write('public/icon-512.png', toPng(tile(512)));
write('public/icon-192.png', toPng(tile(192)));
write('public/apple-icon.png', toPng(tile(180)));
// The share card is src/app/opengraph-image.tsx (next/og), rendered at build time.
write(
  'src/app/favicon.ico',
  toIco(
    // 16 and 32 use the small master, whose wider opening is what keeps the
    // mark legible at the minimum size the guidelines allow.
    [
      { size: 16, data: toPng(tile(16, 20)) },
      { size: 32, data: toPng(tile(32, 20)) },
      { size: 48, data: toPng(tile(48)) },
    ],
  ),
);
