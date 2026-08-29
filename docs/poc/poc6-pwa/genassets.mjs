// PoC-6 asset + VAPID key generator. Zero deps: node built-ins only.
// Creates: icon-180.png, icon-512.png, vapid.json
import { webcrypto } from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/* ---------- minimal PNG encoder (solid colour, 8-bit RGB) ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function solidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type 2 = truecolour RGB
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 3;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- VAPID keypair ---------- */
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function main() {
  const COLOR = [37, 99, 235]; // solid blue
  fs.writeFileSync(path.join(DIR, 'icon-180.png'), solidPng(180, COLOR));
  fs.writeFileSync(path.join(DIR, 'icon-512.png'), solidPng(512, COLOR));
  console.log('wrote icon-180.png, icon-512.png');

  const vapidPath = path.join(DIR, 'vapid.json');
  if (fs.existsSync(vapidPath)) {
    console.log('vapid.json already exists - leaving it alone');
    const v = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
    console.log('publicKey (base64url):', v.publicKey);
    return;
  }

  const kp = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const rawPub = await webcrypto.subtle.exportKey('raw', kp.publicKey);
  const jwkPriv = await webcrypto.subtle.exportKey('jwk', kp.privateKey);
  const jwkPub = await webcrypto.subtle.exportKey('jwk', kp.publicKey);

  fs.writeFileSync(vapidPath, JSON.stringify({
    note: 'THROWAWAY PoC key. Not for production.',
    subject: 'mailto:poc@example.invalid',
    publicKey: b64url(rawPub),
    jwkPublic: jwkPub,
    jwkPrivate: jwkPriv,
  }, null, 2));
  fs.chmodSync(vapidPath, 0o600);
  console.log('wrote vapid.json (mode 600)');
  console.log('publicKey (base64url):', b64url(rawPub), `[${new Uint8Array(rawPub).length} raw bytes]`);
}

main().catch((e) => { console.error(e); process.exit(1); });
