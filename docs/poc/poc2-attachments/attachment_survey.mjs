// PoC-2 scratch — run under launchd with node as job root (holds FDA).
// Lists recent attachments from chat.db, then stats each file to verify the
// path resolves and is readable by this (service) context.
import { execFileSync } from 'node:child_process';
import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';

const DB = `${homedir()}/Library/Messages/chat.db`;
const sql = `SELECT a.ROWID AS rowid, a.filename, a.mime_type, a.total_bytes,
    a.transfer_name,
    datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') AS msg_ts,
    m.is_from_me
  FROM attachment a
  JOIN message_attachment_join j ON j.attachment_id = a.ROWID
  JOIN message m ON m.ROWID = j.message_id
  ORDER BY m.date DESC LIMIT 12;`;

const rows = JSON.parse(
  execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', DB, sql], { encoding: 'utf8' }) || '[]'
);

for (const r of rows) {
  if (!r.filename) { r.file_check = 'NULL filename (e.g. plugin payload)'; continue; }
  const p = r.filename.replace(/^~\//, `${homedir()}/`);
  r.resolved_path = p;
  try {
    const st = statSync(p);
    const fd = openSync(p, 'r');
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    closeSync(fd);
    r.file_check = `OK size=${st.size} first_bytes=${buf.subarray(0, n).toString('hex')}`;
  } catch (e) {
    r.file_check = `FAIL ${e.code}: ${e.message}`;
  }
}
console.log(JSON.stringify(rows, null, 1));
