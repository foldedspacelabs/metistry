// PoC-13 scratch, pass 2 — the `text` column is nearly always NULL on this Mac, so the
// body has to come out of the typedstream `attributedBody` blob. Zero-dependency decoder,
// validated against the small set of rows that carry BOTH text and attributedBody.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const OUT = '/Users/example/Development/Metistry/.claude/worktrees/metistry-phase-0-poc-12cdbc/poc/poc13-comms';
const DB = `${homedir()}/Library/Messages/chat.db`;
const q = (sql) => JSON.parse(execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', DB, sql], { encoding: 'utf8', maxBuffer: 1 << 29 }) || '[]');

// --- typedstream ("streamtyped") minimal reader: pull the primary NSString payload ---
function decodeAttributedBody(hex) {
  if (!hex) return null;
  const buf = Buffer.from(hex, 'hex');
  const marker = buf.indexOf('NSString', 0, 'latin1');
  if (marker < 0) return null;
  // after the class name comes a version int and the 0x2B ('+') C-string type tag
  let i = marker + 8;
  const scanEnd = Math.min(i + 24, buf.length);
  while (i < scanEnd && buf[i] !== 0x2b) i++;
  if (i >= scanEnd) return null;
  i++;
  if (i >= buf.length) return null;
  let len = buf[i++];
  if (len === 0x81) { len = buf.readUInt16LE(i); i += 2; }
  else if (len === 0x82) { len = buf.readUInt32LE(i); i += 4; }
  else if (len >= 0x80) return null;
  if (len <= 0 || i + len > buf.length) return null;
  return buf.slice(i, i + len).toString('utf8');
}

const norm = (s) => (s == null ? null : String(s).replace(/￼/g, ' ').replace(/\s+/g, ' ').trim());

// --- A. decoder validation: rows that have BOTH text and attributedBody ---
const both = q(`SELECT text, hex(attributedBody) AS ab FROM message
  WHERE text IS NOT NULL AND TRIM(text) <> '' AND attributedBody IS NOT NULL LIMIT 500;`);
let vOK = 0, vBad = 0, vNull = 0;
for (const r of both) {
  const d = norm(decodeAttributedBody(r.ab));
  if (d === null) vNull++;
  else if (d === norm(r.text)) vOK++;
  else vBad++;
}

// --- B. Mail store recency histogram (counts only) ---
let mailHist = {};
try {
  const outp = execFileSync('/usr/bin/find', [`${homedir()}/Library/Mail`, '-type', 'f', '-name', '*.emlx', '-newermt', '2025-08-26'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  mailHist.emlx_modified_last_12mo = outp.split('\n').filter(Boolean).length;
} catch (e) { mailHist.err = String(e).slice(0, 120); }
try {
  const outp = execFileSync('/usr/bin/find', [`${homedir()}/Library/Mail`, '-type', 'f', '-name', '*.emlx', '-newermt', '2026-05-26'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  mailHist.emlx_modified_last_3mo = outp.split('\n').filter(Boolean).length;
} catch (e) { mailHist.err2 = String(e).slice(0, 120); }

// --- C. the real export: 200 most recent non-tapback messages with a decodable body ---
const rows = q(`SELECT m.ROWID AS rowid,
    datetime(m.date/1000000000 + 978307200,'unixepoch','localtime') AS ts,
    m.is_from_me AS is_from_me,
    COALESCE(c.chat_identifier,'unknown') AS chat_ident,
    COALESCE(c.style,0) AS chat_style,
    m.text AS text,
    hex(m.attributedBody) AS ab
  FROM message m
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN chat c ON c.ROWID = cmj.chat_id
  WHERE COALESCE(m.associated_message_type,0) = 0
    AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
  ORDER BY m.date DESC LIMIT 900;`);

const convMap = new Map();
const out = [];
let undecodable = 0, emptyAfterDecode = 0;
for (const r of rows) {
  if (out.length >= 200) break;
  let body = norm(r.text);
  let src = 'text';
  if (!body) { body = norm(decodeAttributedBody(r.ab)); src = 'attributedBody'; }
  if (body === null) { undecodable++; continue; }
  if (body.length === 0) { emptyAfterDecode++; continue; }
  const h = createHash('sha256').update(String(r.chat_ident)).digest('hex');
  if (!convMap.has(h)) convMap.set(h, `conv-${convMap.size + 1}`);
  out.push({ rowid: r.rowid, ts: r.ts, is_from_me: r.is_from_me ? 1 : 0, conv: convMap.get(h),
             is_group: r.chat_style === 43 ? 1 : 0, src, text: body });
}

writeFileSync(`${OUT}/messages-200.jsonl`, out.map(o => JSON.stringify(o)).join('\n') + '\n');
writeFileSync(`${OUT}/messages-200.tsv`,
  out.map(o => `${o.rowid}\t${o.is_from_me}\t${o.conv}\t${o.text.replace(/\t/g, ' ')}`).join('\n') + '\n');

const lens = out.map(o => o.text.length).sort((a, b) => a - b);
console.log(JSON.stringify({
  decoderValidation: { sampleWithBoth: both.length, exactMatch: vOK, mismatch: vBad, decodeFailed: vNull },
  mailHist,
  scanned: rows.length,
  undecodable, emptyAfterDecode,
  exported: out.length,
  bySource: { text: out.filter(o => o.src === 'text').length, attributedBody: out.filter(o => o.src === 'attributedBody').length },
  conversations: convMap.size,
  fromMe: out.filter(o => o.is_from_me).length,
  groupMsgs: out.filter(o => o.is_group).length,
  tsRange: [out.at(-1)?.ts, out[0]?.ts],
  textLen: { min: lens[0], p25: lens[(lens.length*0.25)|0], median: lens[(lens.length/2)|0], p75: lens[(lens.length*0.75)|0], max: lens.at(-1) },
}, null, 1));
