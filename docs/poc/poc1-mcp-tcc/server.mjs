#!/usr/bin/env node
// PoC-1 scratch — minimal MCP stdio server, zero dependencies.
// One tool: list_recent_messages(limit) → reads ~/Library/Messages/chat.db
// via /usr/bin/sqlite3 in read-only mode. Errors are returned in-band so the
// caller can see the exact TCC/sqlite failure text.

import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';

const DB = `${homedir()}/Library/Messages/chat.db`;

function listRecent(limit) {
  const n = Math.max(1, Math.min(Number(limit) || 3, 20));
  const sql = `SELECT m.ROWID AS rowid,
    datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') AS ts,
    h.id AS handle, m.is_from_me,
    substr(COALESCE(m.text, '<no plain text / attributedBody only>'), 1, 120) AS text
  FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
  ORDER BY m.date DESC LIMIT ${n};`;
  try {
    const out = execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', DB, sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, text: out.trim() || '[] (query ran, zero rows)' };
  } catch (e) {
    return { ok: false, text: `SQLITE_ERROR status=${e.status} stderr=${(e.stderr || '').toString().trim()} message=${e.message}` };
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'poc-messages', version: '0.0.0' },
    }});
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [{
      name: 'list_recent_messages',
      description: 'List the most recent messages from the local iMessage database (chat.db).',
      inputSchema: { type: 'object', properties: {
        limit: { type: 'number', description: 'How many messages to return (default 3, max 20)' },
      }},
    }]}});
  } else if (method === 'tools/call') {
    const r = listRecent(params?.arguments?.limit);
    send({ jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: r.text }],
      isError: !r.ok,
    }});
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
