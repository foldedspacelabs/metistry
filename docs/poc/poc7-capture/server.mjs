#!/usr/bin/env node
// PoC-7: HTTP capture surface.
// Zero-dependency Node HTTP server. Accepts POST /capture as either
// application/json or multipart/form-data (with a hand-rolled binary-safe
// multipart parser). Every capture is written to inbox/ as the raw payload
// plus a <name>.meta.json sidecar.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INBOX_DIR = path.join(__dirname, 'inbox');
const HOST = '127.0.0.1';
const PORT = Number(process.env.POC7_PORT || 8091);
const TOKEN = process.env.POC7_TOKEN || 'scratch-token-poc7';

fs.mkdirSync(INBOX_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Multipart/form-data parser. Operates entirely on Buffers so binary payload
// bytes (0x00, 0x0d, 0x0a, etc.) are never mangled by a string round-trip.
// ---------------------------------------------------------------------------

/**
 * Split a buffer on all occurrences of a delimiter buffer, using
 * Buffer.indexOf (byte-safe, no encoding involved).
 */
function splitBuffer(buf, delimiter) {
  const parts = [];
  let start = 0;
  while (true) {
    const idx = buf.indexOf(delimiter, start);
    if (idx === -1) {
      parts.push(buf.subarray(start));
      break;
    }
    parts.push(buf.subarray(start, idx));
    start = idx + delimiter.length;
  }
  return parts;
}

/**
 * Parse a multipart/form-data body buffer given the boundary string from the
 * Content-Type header. Returns a map of field name -> { value } for plain
 * fields, or { filename, contentType, data } for file fields.
 */
function parseMultipart(bodyBuffer, boundary) {
  const boundaryDelim = Buffer.from(`--${boundary}`);
  const fields = {};

  // Splitting on the boundary marker yields: preamble, part, part, ..., epilogue("--\r\n"...)
  const rawParts = splitBuffer(bodyBuffer, boundaryDelim);

  for (const rawPart of rawParts) {
    // Each real part starts with \r\n right after the boundary line, and the
    // final marker part starts with "--" (end of multipart body). Skip those
    // and any empty preamble/epilogue slices.
    if (rawPart.length === 0) continue;
    if (rawPart.subarray(0, 2).toString('ascii') === '--') continue; // closing boundary

    // Strip the leading CRLF that follows "--boundary"
    let part = rawPart;
    if (part.subarray(0, 2).toString('ascii') === '\r\n') {
      part = part.subarray(2);
    } else {
      continue; // malformed part, skip
    }
    // Strip the trailing CRLF that precedes the next boundary marker.
    if (part.subarray(part.length - 2).toString('ascii') === '\r\n') {
      part = part.subarray(0, part.length - 2);
    }

    const headerSep = part.indexOf('\r\n\r\n');
    if (headerSep === -1) continue;
    const headerText = part.subarray(0, headerSep).toString('utf8');
    const data = part.subarray(headerSep + 4);

    const headers = {};
    for (const line of headerText.split('\r\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      headers[line.slice(0, colonIdx).trim().toLowerCase()] = line.slice(colonIdx + 1).trim();
    }

    const disposition = headers['content-disposition'] || '';
    const nameMatch = disposition.match(/name="([^"]*)"/);
    const filenameMatch = disposition.match(/filename="([^"]*)"/);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];

    if (filenameMatch) {
      fields[fieldName] = {
        filename: filenameMatch[1],
        contentType: headers['content-type'] || 'application/octet-stream',
        data, // Buffer, untouched
      };
    } else {
      fields[fieldName] = { value: data.toString('utf8') };
    }
  }

  return fields;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
    });
    req.on('end', () => resolve(Buffer.concat(chunks, size)));
    req.on('error', reject);
  });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function safeBaseName(name) {
  return (name || 'file')
    .replace(/[/\\]/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 200);
}

function writeCapture({ originalName, mime, note, url, buffer }) {
  const id = crypto.randomUUID();
  const ext = originalName && path.extname(originalName) ? path.extname(originalName) : '';
  const storedName = `${id}${ext}`;
  const storedPath = path.join(INBOX_DIR, storedName);
  fs.writeFileSync(storedPath, buffer);

  const meta = {
    id,
    timestamp: new Date().toISOString(),
    mime: mime || 'application/octet-stream',
    original_filename: originalName || null,
    note: note || null,
    url: url || null,
    size: buffer.length,
    sha256: sha256(buffer),
    stored_as: storedName,
  };
  fs.writeFileSync(path.join(INBOX_DIR, `${storedName}.meta.json`), JSON.stringify(meta, null, 2));
  return meta;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const start = process.hrtime.bigint();
  try {
    if (req.method !== 'POST' || req.url !== '/capture') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${TOKEN}`) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const contentType = req.headers['content-type'] || '';
    const bodyBuffer = await readRawBody(req);

    if (contentType.startsWith('application/json')) {
      let payload;
      try {
        payload = JSON.parse(bodyBuffer.toString('utf8'));
      } catch (e) {
        sendJson(res, 400, { error: 'invalid_json', detail: String(e.message) });
        return;
      }
      const { note, url, text } = payload;
      const contentBuf = Buffer.from(
        JSON.stringify({ url: url || null, text: text || null }, null, 2),
        'utf8'
      );
      const meta = writeCapture({
        originalName: 'capture.json',
        mime: 'application/json',
        note,
        url,
        buffer: contentBuf,
      });
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      sendJson(res, 201, { ok: true, meta, elapsed_ms: elapsedMs });
      return;
    }

    if (contentType.startsWith('multipart/form-data')) {
      const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
      if (!boundaryMatch) {
        sendJson(res, 400, { error: 'missing_boundary' });
        return;
      }
      const boundary = boundaryMatch[1] || boundaryMatch[2];
      const fields = parseMultipart(bodyBuffer, boundary);

      const fileField = fields.file;
      const noteField = fields.note;
      if (!fileField || !fileField.data) {
        sendJson(res, 400, { error: 'missing_file_field' });
        return;
      }

      const meta = writeCapture({
        originalName: fileField.filename,
        mime: fileField.contentType,
        note: noteField ? noteField.value : null,
        buffer: fileField.data,
      });
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      sendJson(res, 201, { ok: true, meta, elapsed_ms: elapsedMs });
      return;
    }

    sendJson(res, 415, { error: 'unsupported_content_type', contentType });
  } catch (err) {
    sendJson(res, 500, { error: 'internal_error', detail: String(err && err.stack || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`poc7-capture listening on http://${HOST}:${PORT} (token=${TOKEN})`);
  console.log(`inbox: ${INBOX_DIR}`);
});
