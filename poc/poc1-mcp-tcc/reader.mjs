// PoC-1 scratch — same read the MCP server performs, runnable as a launchd
// job whose program is node itself (mirrors the production bridge process tree:
// launchd -> node -> sqlite3 -> chat.db).
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const DB = `${homedir()}/Library/Messages/chat.db`;
try {
  const out = execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', DB,
    "SELECT COUNT(*) AS message_count FROM message;"], { encoding: 'utf8' });
  console.log('OK', out.trim());
} catch (e) {
  console.log('DENIED', (e.stderr || e.message || '').toString().trim());
  process.exit(1);
}
