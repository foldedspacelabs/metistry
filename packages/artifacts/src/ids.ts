// Prefixed, time-ordered ids ("art_…", "ver_…", "cmt_…"): a ULID —
// 48-bit millisecond timestamp + 80 bits of randomness, Crockford base32,
// 26 chars — hand-rolled because it is fifteen lines and a dependency is
// a maintenance obligation (CLAUDE.md). Sortable by creation time, which
// makes version ids read in order in any listing.

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encode(value: bigint, chars: number): string {
  let out = "";
  for (let i = 0; i < chars; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

export function ulid(now = Date.now()): string {
  const rand = randomBytes(10);
  let r = 0n;
  for (const b of rand) r = (r << 8n) | BigInt(b);
  return encode(BigInt(now), 10) + encode(r, 16);
}

export type IdPrefix = "art" | "ver" | "cmt";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

const ID_RE = /^(art|ver|cmt)_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isId(value: unknown, prefix: IdPrefix): value is string {
  return typeof value === "string" && ID_RE.test(value) && value.startsWith(`${prefix}_`);
}
