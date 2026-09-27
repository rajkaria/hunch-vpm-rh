/**
 * Render the brand geometry to the raster files a browser and a link preview
 * need: favicons, the app icons, and the OpenGraph card.
 *
 * The identity is drawn from its own numbers, not traced from a screenshot and
 * not typeset in a substitute font. A half-circle of radius 17 on stroke 12,
 * on a 100-unit grid, driven through the bottom edge of a hard 88x88 block —
 * the same construction the staged SVGs use, evaluated per pixel here. That
 * matters for the OpenGraph card in particular: the logotype is a stroked
 * path, so rendering it as geometry means the wordmark in a link preview is
 * the real wordmark rather than whatever font happened to be available.
 *
 * The outputs are committed, so a build never depends on running this. Re-run
 * it with `pnpm --filter @hunch-vpm/web icons` if the geometry ever changes.
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

/**
 * The logotype, as the stroked segments and half-circles it is drawn from.
 * Coordinates are the path's own, before the `translate(101 -10)` the staged
 * SVG applies. Stroke is 12, so a point is inked when it is within 6 of a
 * centreline; the caps are butt caps, which for these shapes is exactly "and
 * within the segment's own extent".
 */
const HALF_STROKE = 6;
const R = 17;

const STROKES = [
  { kind: 'v', x: 14, y0: 14, y1: 90 }, // h — stem
  { kind: 'arc', cx: 31, cy: 67, side: 'up' }, // h — shoulder
  { kind: 'v', x: 48, y0: 67, y1: 90 },
  { kind: 'v', x: 71, y0: 44, y1: 67 }, // u
  { kind: 'arc', cx: 88, cy: 67, side: 'down' },
  { kind: 'v', x: 105, y0: 44, y1: 67 },
  { kind: 'v', x: 128, y0: 67, y1: 90 }, // n
  { kind: 'arc', cx: 145, cy: 67, side: 'up' },
  { kind: 'v', x: 162, y0: 67, y1: 90 },
  { kind: 'h', y: 50, x0: 202, x1: 212 }, // c
  { kind: 'arc', cx: 202, cy: 67, side: 'left' },
  { kind: 'h', y: 84, x0: 202, x1: 212 },
  { kind: 'v', x: 229, y0: 14, y1: 90 }, // h — stem
  { kind: 'arc', cx: 246, cy: 67, side: 'up' },
  { kind: 'v', x: 263, y0: 67, y1: 90 },
];

function logotypeInside(x, y) {
  for (const stroke of STROKES) {
    if (stroke.kind === 'v') {
      if (Math.abs(x - stroke.x) <= HALF_STROKE && y >= stroke.y0 && y <= stroke.y1) return true;
    } else if (stroke.kind === 'h') {
      if (Math.abs(y - stroke.y) <= HALF_STROKE && x >= stroke.x0 && x <= stroke.x1) return true;
    } else {
      const dx = x - stroke.cx;
      const dy = y - stroke.cy;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (Math.abs(distance - R) > HALF_STROKE) continue;
      if (stroke.side === 'up' && dy <= 0) return true;
      if (stroke.side === 'down' && dy >= 0) return true;
      if (stroke.side === 'left' && dx <= 0) return true;
      if (stroke.side === 'right' && dx >= 0) return true;
    }
  }
  return false;
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

/**
 * The OpenGraph card: the lockup on the Ink ground, at the proportions the
 * guidelines set, with a single lime rule. No glow, no gradient, no shadow.
 */
function openGraph() {
  const width = 1200;
  const height = 630;
  const target = canvas(width, height, INK);

  // The lockup is the mark at 0.84 plus the logotype translated by (101, -10),
  // laid out on the staged 396x84 viewBox. Both axes take the same scale, and
  // it is centred, which leaves clear space many times the 17 units required.
  const scale = 1.9;
  const originX = Math.round((width - 396 * scale) / 2);
  const originY = Math.round((height - 84 * scale) / 2);
  paint(target, placed((x, y) => markInside(x, y), originX, originY, 0.84 * scale), LIME);
  paint(target, placed(logotypeInside, originX + 101 * scale, originY - 10 * scale, scale), LIME);

  // One accent band along the bottom edge. The card carries no typeset text
  // on purpose: the platform renders the title and description beside it, and
  // a font substitution here would put a different product's wordmark in a
  // link preview.
  paint(target, (x, y) => y >= height - 14, LIME);

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
write('public/og.png', toPng(openGraph()));
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
