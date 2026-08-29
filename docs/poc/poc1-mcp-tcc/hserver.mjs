// PoC-1/PoC-4 scratch — minimal MCP streamable-HTTP server, zero dependencies.
// Runs as its own launchd service (node = responsibility root, holds FDA).
// GET /health for liveness; POST /mcp for JSON-RPC.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { readFileSync, statSync, unlinkSync } from 'node:fs';

const PORT = 7801;
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
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, text: out.trim() || '[] (query ran, zero rows)' };
  } catch (e) {
    return { ok: false, text: `SQLITE_ERROR status=${e.status} stderr=${(e.stderr || '').toString().trim()}` };
  }
}

// PoC-2: fetch an iMessage attachment as an image content block.
// Normalizes via sips (system tool) to jpeg max 1024px — handles HEIC (which
// the API does not accept) and size in one path. Restricted to Attachments/.
function getAttachment(p) {
  const root = `${homedir()}/Library/Messages/Attachments/`;
  const full = (p || '').replace(/^~\//, `${homedir()}/`);
  if (!full.startsWith(root) || full.includes('..')) {
    return { error: `path must be under ${root}` };
  }
  let st;
  try { st = statSync(full); } catch (e) { return { error: `stat failed: ${e.message}` }; }
  const tmp = `${tmpdir()}/poc2-${process.pid}-${Date.now()}.jpg`;
  try {
    execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', '1024', full, '--out', tmp],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    const buf = readFileSync(tmp);
    unlinkSync(tmp);
    return { data: buf.toString('base64'), mimeType: 'image/jpeg',
      meta: `source=${full} bytes=${st.size} converted_jpeg_bytes=${buf.length}` };
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    return { error: `readable (${st.size} bytes) but not convertible to an image: ${(e.stderr || e.message || '').toString().trim()}` };
  }
}

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return null; // notification
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'poc-messages-http', version: '0.0.0' },
    }};
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [{
      name: 'list_recent_messages',
      description: 'List the most recent messages from the local iMessage database (chat.db).',
      inputSchema: { type: 'object', properties: {
        limit: { type: 'number', description: 'How many messages to return (default 3, max 20)' },
      }},
    }, {
      name: 'get_attachment',
      description: 'Fetch an iMessage attachment by absolute path (under ~/Library/Messages/Attachments/) as an image.',
      inputSchema: { type: 'object', properties: {
        path: { type: 'string', description: 'Path from the attachment table filename column' },
      }, required: ['path'] },
    }]}};
  }
  if (method === 'tools/call') {
    if (params?.name === 'get_attachment') {
      const a = getAttachment(params?.arguments?.path);
      if (a.error) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: a.error }], isError: true } };
      }
      return { jsonrpc: '2.0', id, result: { content: [
        { type: 'text', text: a.meta },
        { type: 'image', data: a.data, mimeType: a.mimeType },
      ], isError: false } };
    }
    const r = listRecent(params?.arguments?.limit);
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text }], isError: !r.ok } };
  }
  return { jsonrpc: '2.0', id, result: {} };
}

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const probe = listRecent(1);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', chat_db_readable: probe.ok, pid: process.pid }));
    return;
  }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
    const out = Array.isArray(msg) ? msg.map(handle).filter(Boolean) : handle(msg);
    if (!out || (Array.isArray(out) && out.length === 0)) { res.writeHead(202); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`poc bridge listening on :${PORT}`);
});
