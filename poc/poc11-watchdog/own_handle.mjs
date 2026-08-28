import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
const DB = `${homedir()}/Library/Messages/chat.db`;
const sql = `SELECT DISTINCT account_login FROM chat WHERE account_login IS NOT NULL LIMIT 5;`;
console.log(execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', DB, sql], { encoding: 'utf8' }));
