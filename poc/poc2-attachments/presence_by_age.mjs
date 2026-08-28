// PoC-2 addendum — image-attachment presence rate bucketed by message age.
// Answers: how quickly does iCloud offload remove local bytes? Informs the
// "bridge must copy recent images before optimization" requirement.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';

const DB = `${homedir()}/Library/Messages/chat.db`;
const sql = `SELECT a.filename,
    (strftime('%s','now') - (m.date/1000000000 + 978307200)) / 3600.0 AS age_h
  FROM attachment a
  JOIN message_attachment_join j ON j.attachment_id = a.ROWID
  JOIN message m ON m.ROWID = j.message_id
  WHERE a.mime_type LIKE 'image/%' AND a.filename IS NOT NULL
  ORDER BY m.date DESC LIMIT 2000;`;
const rows = JSON.parse(execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', DB, sql], { encoding: 'utf8' }) || '[]');

const buckets = [
  ['<6h', 0, 6], ['6-24h', 6, 24], ['1-3d', 24, 72], ['3-7d', 72, 168],
  ['1-4w', 168, 672], ['1-3mo', 672, 2160], ['>3mo', 2160, Infinity],
];
const out = {};
for (const [label] of buckets) out[label] = { present: 0, missing: 0 };
for (const r of rows) {
  const b = buckets.find(([, lo, hi]) => r.age_h >= lo && r.age_h < hi);
  if (!b) continue;
  const p = r.filename.replace(/^~\//, `${homedir()}/`);
  try { statSync(p); out[b[0]].present++; } catch { out[b[0]].missing++; }
}
for (const [label, v] of Object.entries(out)) {
  const t = v.present + v.missing;
  console.log(`${label.padEnd(6)} n=${String(t).padStart(4)} present=${String(v.present).padStart(4)} rate=${t ? (100 * v.present / t).toFixed(1) : '-'}%`);
}
