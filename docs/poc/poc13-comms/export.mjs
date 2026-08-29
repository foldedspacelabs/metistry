// PoC-13 scratch — runs as a launchd job rooted at granted node so chat.db is readable.
// Outputs: (a) Mail store file counts, (b) NULL-text fraction over last 1000 messages,
// (c) 200 most recent text-bearing, non-tapback messages with pseudonymised conversation ids.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const OUT = '/Users/mattcolf/Development/Metistry/.claude/worktrees/metistry-phase-0-poc-12cdbc/poc/poc13-comms';
const DB = `${homedir()}/Library/Messages/chat.db`;
const q = (sql) => JSON.parse(execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', DB, sql], { encoding: 'utf8', maxBuffer: 1 << 28 }) || '[]');

// ---------- 1. Mail store survey (counts only, never names) ----------
const mailRoot = `${homedir()}/Library/Mail`;
let mail = { exists: false };
try {
  statSync(mailRoot);
  let files = 0, dirs = 0, emlx = 0, bytes = 0, depthCap = 0;
  const walk = (d, depth) => {
    if (depth > 8) { depthCap++; return; }
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) { dirs++; walk(p, depth + 1); }
      else {
        files++;
        if (/\.eml(x|xpart)?$/i.test(e.name)) emlx++;
        try { bytes += statSync(p).size; } catch {}
      }
    }
  };
  walk(mailRoot, 0);
  const top = readdirSync(mailRoot, { withFileTypes: true }).map(e => (e.isDirectory() ? 'dir' : 'file'));
  mail = { exists: true, topLevelEntries: top.length, topLevelDirs: top.filter(t => t === 'dir').length, files, dirs, emlxLike: emlx, totalBytes: bytes, depthCapHits: depthCap };
} catch { mail = { exists: false }; }

// ---------- 2. NULL-text fraction over the last 1000 messages ----------
const last1000 = q(`SELECT
    SUM(CASE WHEN text IS NULL THEN 1 ELSE 0 END) AS null_text,
    SUM(CASE WHEN text IS NOT NULL AND TRIM(text)='' THEN 1 ELSE 0 END) AS empty_text,
    SUM(CASE WHEN text IS NULL AND attributedBody IS NOT NULL THEN 1 ELSE 0 END) AS null_text_with_ab,
    SUM(CASE WHEN COALESCE(associated_message_type,0)<>0 THEN 1 ELSE 0 END) AS tapbacks,
    COUNT(*) AS n
  FROM (SELECT text, attributedBody, associated_message_type FROM message ORDER BY date DESC LIMIT 1000);`)[0];

// same, restricted to non-tapbacks, to see the fraction that matters for a real bridge
const last1000nt = q(`SELECT
    SUM(CASE WHEN text IS NULL THEN 1 ELSE 0 END) AS null_text,
    SUM(CASE WHEN text IS NULL AND attributedBody IS NOT NULL THEN 1 ELSE 0 END) AS null_text_with_ab,
    COUNT(*) AS n
  FROM (SELECT text, attributedBody FROM message WHERE COALESCE(associated_message_type,0)=0 ORDER BY date DESC LIMIT 1000);`)[0];

const totals = q(`SELECT COUNT(*) AS total_messages FROM message;`)[0];

// ---------- 3. The 200-message export ----------
const rows = q(`SELECT m.ROWID AS rowid,
    datetime(m.date/1000000000 + 978307200,'unixepoch','localtime') AS ts,
    m.is_from_me AS is_from_me,
    m.service AS service,
    COALESCE(c.chat_identifier, 'unknown') AS chat_ident,
    COALESCE(c.style, 0) AS chat_style,
    m.text AS text
  FROM message m
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN chat c ON c.ROWID = cmj.chat_id
  WHERE m.text IS NOT NULL AND TRIM(m.text) <> ''
    AND COALESCE(m.associated_message_type,0) = 0
  ORDER BY m.date DESC LIMIT 200;`);

const convMap = new Map();
const out = rows.map(r => {
  const h = createHash('sha256').update(String(r.chat_ident)).digest('hex');
  if (!convMap.has(h)) convMap.set(h, `conv-${convMap.size + 1}`);
  return {
    rowid: r.rowid,
    ts: r.ts,
    is_from_me: r.is_from_me ? 1 : 0,
    conv: convMap.get(h),
    is_group: r.chat_style === 43 ? 1 : 0,
    text: String(r.text).replace(/￼/g, ' ').replace(/\s+/g, ' ').trim(),
  };
}).filter(r => r.text.length > 0);

writeFileSync(`${OUT}/messages-200.jsonl`, out.map(o => JSON.stringify(o)).join('\n') + '\n');
// text-only fixture for the Swift classifier: one message per line, tab-separated rowid + text
writeFileSync(`${OUT}/messages-200.tsv`,
  out.map(o => `${o.rowid}\t${o.is_from_me}\t${o.conv}\t${o.text.replace(/\t/g, ' ')}`).join('\n') + '\n');

const lens = out.map(o => o.text.length).sort((a, b) => a - b);
console.log(JSON.stringify({
  mail,
  totals,
  last1000_all: last1000,
  last1000_nontapback: last1000nt,
  exported: out.length,
  conversations: convMap.size,
  fromMe: out.filter(o => o.is_from_me).length,
  groupMsgs: out.filter(o => o.is_group).length,
  tsRange: [out.at(-1)?.ts, out[0]?.ts],
  textLen: { min: lens[0], p25: lens[(lens.length * 0.25) | 0], median: lens[(lens.length / 2) | 0], p75: lens[(lens.length * 0.75) | 0], max: lens.at(-1) },
}, null, 1));
