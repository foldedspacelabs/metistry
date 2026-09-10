// A PLACEHOLDER app icon, drawn in code.
//
//   node ops/release/make-app-icon.mjs <out.png> [size]
//
// Why generate it instead of committing a PNG: this is a stand-in until there
// is a real mark, and a committed binary blob is the kind of thing that quietly
// ships forever because nobody remembers it is a placeholder. A 60-line script
// that says "placeholder" in its first paragraph does not have that problem.
//
// No dependency: PNG is a handful of chunks around a zlib stream, and zlib is
// in Node's stdlib. Colours come from docs/product/design/tokens.json — the
// `accent` and `on-accent` roles — so even the placeholder is in the system.
//
// Replacing it: draw a real icon, save the 1024pt master, and point
// ops/release/build-app.sh's ICON_PNG at it instead of calling this.

import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

const tokens = JSON.parse(readFileSync(new URL("../../docs/product/design/tokens.json", import.meta.url), "utf8"));
const rgb = (hex) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const BG = rgb(tokens.color.accent.light);
const FG = rgb(tokens.color["on-accent"].light);

const out = process.argv[2];
if (!out) {
  process.stderr.write("usage: make-app-icon.mjs <out.png> [size]\n");
  process.exit(2);
}
const size = Number(process.argv[3] ?? 1024);

// --- draw ------------------------------------------------------------------
// A rounded square in `accent` with a white "M" of four thick strokes. Apple's
// macOS icon grid insets the art; 1024 with a ~100px margin is close enough for
// something that exists to be replaced.
const px = new Uint8Array(size * size * 4); // RGBA, transparent by default
const inset = Math.round(size * 0.098);
const radius = Math.round(size * 0.185);
const set = (x, y, [r, g, b], a = 255) => {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
};

const inRounded = (x, y) => {
  const lo = inset;
  const hi = size - inset - 1;
  if (x < lo || y < lo || x > hi || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + radius), hi - radius);
  const cy = Math.min(Math.max(y, lo + radius), hi - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
};

/** Distance from point p to segment ab, for drawing a stroke of some width. */
const distToSegment = (px_, py, ax, ay, bx, by) => {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px_ - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2));
  const dx = px_ - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
};

// The four strokes of an M, in fractions of the icon box.
const box = { x0: size * 0.3, x1: size * 0.7, y0: size * 0.33, y1: size * 0.67 };
const mid = { x: (box.x0 + box.x1) / 2, y: box.y0 + (box.y1 - box.y0) * 0.62 };
const strokes = [
  [box.x0, box.y1, box.x0, box.y0],
  [box.x0, box.y0, mid.x, mid.y],
  [mid.x, mid.y, box.x1, box.y0],
  [box.x1, box.y0, box.x1, box.y1],
];
const stroke = size * 0.058;

for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    if (!inRounded(x, y)) continue;
    set(x, y, BG);
    const d = Math.min(...strokes.map(([ax, ay, bx, by]) => distToSegment(x + 0.5, y + 0.5, ax, ay, bx, by)));
    if (d <= stroke / 2) set(x, y, FG);
  }
}

// --- encode ----------------------------------------------------------------
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
// filter byte 0 (None) in front of every scanline; the deflate below does the work.
const raw = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y++) {
  raw[y * (size * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
}

writeFileSync(
  out,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
process.stderr.write(`placeholder icon: ${out} (${size}x${size})\n`);
