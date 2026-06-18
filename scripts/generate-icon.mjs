// Generates a 1024x1024 PNG app icon for Portcode with zero dependencies.
// Design: rounded navy tile with an accent-blue ">_" prompt mark.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const S = 1024;
const px = new Uint8Array(S * S * 4); // RGBA

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  // simple alpha-over compositing onto existing pixel
  const sa = a / 255;
  const da = px[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return;
  px[i] = (r * sa + px[i] * da * (1 - sa)) / oa;
  px[i + 1] = (g * sa + px[i + 1] * da * (1 - sa)) / oa;
  px[i + 2] = (b * sa + px[i + 2] * da * (1 - sa)) / oa;
  px[i + 3] = oa * 255;
}

// Rounded-rect tile with a vertical navy gradient.
const radius = 200;
function inRoundedRect(x, y, m, r) {
  const lo = m,
    hi = S - m;
  if (x < lo || y < lo || x >= hi || y >= hi) return false;
  const cx = Math.min(Math.max(x, lo + r), hi - r);
  const cy = Math.min(Math.max(y, lo + r), hi - r);
  const dx = x - cx,
    dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

for (let y = 0; y < S; y++) {
  const t = y / S;
  const r = Math.round(27 + t * -12); // 27 -> 15
  const g = Math.round(36 + t * -16); // 36 -> 20
  const b = Math.round(64 + t * -16); // 64 -> 48
  for (let x = 0; x < S; x++) {
    if (inRoundedRect(x, y, 40, radius)) set(x, y, r, g, b, 255);
  }
}

// Thick line segment via distance-to-segment, with the accent color.
function segment(x1, y1, x2, y2, w, r, g, b) {
  const minx = Math.floor(Math.min(x1, x2) - w),
    maxx = Math.ceil(Math.max(x1, x2) + w);
  const miny = Math.floor(Math.min(y1, y2) - w),
    maxy = Math.ceil(Math.max(y1, y2) + w);
  const vx = x2 - x1,
    vy = y2 - y1;
  const len2 = vx * vx + vy * vy || 1;
  for (let y = miny; y <= maxy; y++) {
    for (let x = minx; x <= maxx; x++) {
      let tt = ((x - x1) * vx + (y - y1) * vy) / len2;
      tt = Math.max(0, Math.min(1, tt));
      const px0 = x1 + tt * vx,
        py0 = y1 + tt * vy;
      const d = Math.hypot(x - px0, y - py0);
      const a = Math.max(0, Math.min(1, w - d)); // 1px antialias edge
      if (a > 0) set(x, y, r, g, b, Math.round(a * 255));
    }
  }
}

const AC = [91, 140, 255]; // accent #5b8cff
const w = 46;
// ">" chevron
segment(360, 330, 560, 512, w, ...AC);
segment(560, 512, 360, 694, w, ...AC);
// "_" underscore
segment(600, 700, 760, 700, w, ...AC);

// ── PNG encode ──────────────────────────────────────────────────────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

// scanlines with filter byte 0
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.subarray(y * S * 4, (y + 1) * S * 4).forEach((v, i) => {
    raw[y * (S * 4 + 1) + 1 + i] = v;
  });
}
const idat = deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(new URL("../app-icon.png", import.meta.url), png);
console.log("wrote app-icon.png", png.length, "bytes");
