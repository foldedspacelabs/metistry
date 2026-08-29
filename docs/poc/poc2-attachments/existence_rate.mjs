// PoC-2 scratch — existence rate of the last 200 attachments, grouped by
// mime class, plus a couple of full missing paths for diagnosis.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';

const DB = `${homedir()}/Library/Messages/chat.db`;
const sql = `SELECT a.filename, a.mime_type, a.total_bytes,
    datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') AS msg_ts
  FROM attachment a
  JOIN message_attachment_join j ON j.attachment_id = a.ROWID
  JOIN message m ON m.ROWID = j.message_id
  ORDER BY m.date DESC LIMIT 200;`;
const rows = JSON.parse(execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', DB, sql], { encoding: 'utf8' }) || '[]');

const byClass = {};
const missingSamples = [];
let sizeMismatch = 0;
for (const r of rows) {
  const cls = (r.mime_type || 'null').split('/')[0];
  byClass[cls] ??= { present: 0, missing: 0, nullpath: 0 };
  if (!r.filename) { byClass[cls].nullpath++; continue; }
  const p = r.filename.replace(/^~\//, `${homedir()}/`);
  try {
    const st = statSync(p);
    byClass[cls].present++;
    if (r.total_bytes && st.size < r.total_bytes * 0.9) sizeMismatch++;
  } catch {
    byClass[cls].missing++;
    if (missingSamples.length < 4) missingSamples.push({ ts: r.msg_ts, mime: r.mime_type, path: p });
  }
}
console.log(JSON.stringify({ sample: rows.length, byClass, sizeMismatch, missingSamples }, null, 1));
