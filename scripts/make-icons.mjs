#!/usr/bin/env node
// DEV ONLY (not shipped). Draws nika's icons from scratch with the Node stdlib (zlib) and writes PNGs:
//   app/src-tauri/icons/tray-<16|32|64>.png         black on transparent: macOS template image (the OS recolours it)
//   app/src-tauri/icons/tray-attn-<16|32|64>.png    the same with a small filled dot top-right (attention > 0)
//   app/src-tauri/icons/tray-light-<64>.png,
//   app/src-tauri/icons/tray-light-attn-<64>.png    light grey for Linux panels (AppIndicator has no template mode)
//   app/src-tauri/icons/source-1024.png             app icon: white logo on a rounded square; `cargo tauri icon` derives the rest
// The logo is the `i-logo` symbol of the design mockups (three circles joined by two lines), drawn in a 24 x 24 box.
// Usage: node scripts/make-icons.mjs [outDir]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'src-tauri', 'icons');

// --- PNG writer ---------------------------------------------------------------------------------------------------
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** rgba: Uint8Array of w*h*4 (straight alpha). */
export function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- shapes (24 x 24 logo units) ----------------------------------------------------------------------------------
const SW = 2.2; // stroke width, as in the mockup tray icon
const R = 3;
const CIRCLES = [[6, 12, true], [18, 6, false], [18, 18, false]]; // [cx, cy, filled]
const LINES = [[8.6, 10.6, 15.4, 7.4], [8.6, 13.4, 15.4, 16.6]];
const DOT = { x: 20.9, y: 3.1, r: 2.9, halo: 1.3 };

/** Distance to the segment, or Infinity beyond its ends (butt caps: the lines end flush inside the rings). */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  if (t < 0 || t > 1) return Infinity;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
/** Is (x, y) inside the logo strokes? */
function inLogo(x, y) {
  for (const [cx, cy, filled] of CIRCLES) {
    const d = Math.hypot(x - cx, y - cy);
    if (filled ? d <= R + SW / 2 : Math.abs(d - R) <= SW / 2) return true;
  }
  return LINES.some(([ax, ay, bx, by]) => segDist(x, y, ax, ay, bx, by) <= SW / 2);
}
const inDot = (x, y, grow = 0) => Math.hypot(x - DOT.x, y - DOT.y) <= DOT.r + grow;

/** Coverage 0..1 of `inside(u, v)` for pixel (px, py), by ss x ss sub-samples; (u, v) are logo units via `toUnits`. */
function coverage(px, py, ss, toUnits, inside) {
  let n = 0;
  for (let j = 0; j < ss; j++) {
    for (let i = 0; i < ss; i++) {
      const [u, v] = toUnits(px + (i + 0.5) / ss, py + (j + 0.5) / ss);
      if (inside(u, v)) n++;
    }
  }
  return n / (ss * ss);
}

function trayIcon(size, { attn, rgb }) {
  const rgba = new Uint8Array(size * size * 4);
  const toUnits = (x, y) => [(x / size) * 24, (y / size) * 24];
  const inside = attn ? (u, v) => (inLogo(u, v) && !inDot(u, v, DOT.halo)) || inDot(u, v) : inLogo;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = coverage(x, y, 8, toUnits, inside);
      const o = (y * size + x) * 4;
      rgba.set(rgb, o);
      rgba[o + 3] = Math.round(a * 255);
    }
  }
  return png(size, size, rgba);
}

function roundedRect(u, v, x0, y0, w, h, r) {
  const qx = Math.abs(u - (x0 + w / 2)) - (w / 2 - r);
  const qy = Math.abs(v - (y0 + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= r;
}

function appIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const k = size / 1024;
  const body = { x: 100 * k, y: 100 * k, s: 824 * k, r: 186 * k }; // Apple's icon grid: 824 px square inside 1024
  const scale = 22 * k; // px per logo unit
  const toLogo = (x, y) => [(x - size / 2) / scale + 12, (y - size / 2) / scale + 12];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const a = coverage(x, y, 3, (px, py) => [px, py], (px, py) => roundedRect(px, py, body.x, body.y, body.s, body.s, body.r));
      if (a === 0) continue;
      const t = Math.max(0, Math.min(1, (y - body.y) / body.s));
      const bg = [0x2b + (0x16 - 0x2b) * t, 0x34 + (0x1b - 0x34) * t, 0x52 + (0x2b - 0x52) * t]; // top #2b3452 to bottom #161b2b
      const l = coverage(x, y, 3, toLogo, inLogo);
      for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(bg[c] + (255 - bg[c]) * l);
      rgba[o + 3] = Math.round(a * 255);
    }
  }
  return png(size, size, rgba);
}

fs.mkdirSync(OUT, { recursive: true });
const BLACK = [0, 0, 0];
const LIGHT = [0xe8, 0xea, 0xf0];
for (const size of [16, 32, 64]) {
  fs.writeFileSync(path.join(OUT, `tray-${size}.png`), trayIcon(size, { attn: false, rgb: BLACK }));
  fs.writeFileSync(path.join(OUT, `tray-attn-${size}.png`), trayIcon(size, { attn: true, rgb: BLACK }));
}
fs.writeFileSync(path.join(OUT, 'tray-light-64.png'), trayIcon(64, { attn: false, rgb: LIGHT }));
fs.writeFileSync(path.join(OUT, 'tray-light-attn-64.png'), trayIcon(64, { attn: true, rgb: LIGHT }));
fs.writeFileSync(path.join(OUT, 'source-1024.png'), appIcon(1024));
process.stdout.write(`wrote icons to ${path.relative(process.cwd(), OUT) || '.'}\n`);
