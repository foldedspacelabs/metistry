#!/usr/bin/env node
// PoC-8: router fast path. Zero-dependency Node HTTP server exposing
// GET /api/q/:name, resolved ONLY against a named-query directory, executed
// via a `psql` subprocess against the pgvector/pg17 container from step 1,
// with an in-memory TTL cache and an `as_of` freshness stamp on responses.
//
// NOTE: named queries are stored as JSON here to keep this PoC at zero
// dependencies (no YAML parser available without npm install). The real
// product config format is expected to be YAML.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERIES_DIR = path.join(__dirname, 'queries');
const HOST = '127.0.0.1';
const PORT = Number(process.env.POC8_PORT || 8092);

const PSQL_BIN = process.env.POC8_PSQL_BIN || '/opt/homebrew/opt/libpq/bin/psql';
const PG_HOST = process.env.POC8_PG_HOST || '127.0.0.1';
const PG_PORT = process.env.POC8_PG_PORT || '5433';
const PG_USER = process.env.POC8_PG_USER || 'postgres';
const PG_DB = process.env.POC8_PG_DB || 'postgres';
const PG_PASSWORD = process.env.POC8_PG_PASSWORD || 'poc';

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

// name -> { data: [...], cachedAt: number(ms), expiresAt: number(ms) }
const cache = new Map();

function loadQueryDef(name) {
  if (!NAME_RE.test(name)) return null;
  const file = path.join(QUERIES_DIR, `${name}.json`);
  const resolved = path.resolve(file);
  // Defense in depth: resolved path must stay inside QUERIES_DIR even
  // though NAME_RE already forbids path separators / traversal segments.
  if (!resolved.startsWith(path.resolve(QUERIES_DIR) + path.sep)) return null;
  if (!fs.existsSync(resolved)) return null;
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function validateAndBindParams(def, queryParams) {
  const bound = {};
  for (const [key, spec] of Object.entries(def.params || {})) {
    const raw = queryParams.has(key) ? queryParams.get(key) : undefined;
    if (spec.type === 'int') {
      let val = raw === undefined ? spec.default : Number(raw);
      if (!Number.isInteger(val)) {
        throw new Error(`param '${key}' must be an integer`);
      }
      const max = spec.max || 500;
      const min = spec.min !== undefined ? spec.min : 1;
      if (val < min || val > max) {
        throw new Error(`param '${key}' must be between ${min} and ${max}`);
      }
      bound[key] = val;
    } else {
      // Only 'int' params are used in this PoC; extend here for 'str' etc.
      bound[key] = raw === undefined ? spec.default : String(raw);
    }
  }
  return bound;
}

function substituteSql(sql, bound) {
  // Bound values are already validated (integers within bounds), so direct
  // textual substitution is safe here. A string-typed param would need
  // proper quoting/escaping; not needed for this PoC's int-only param.
  let out = sql;
  for (const [key, val] of Object.entries(bound)) {
    out = out.replaceAll(`:${key}`, String(val));
  }
  return out;
}

// Minimal RFC4180-ish CSV line parser (handles quoted fields with embedded
// commas/quotes, which is all psql --csv emits).
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        fields.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
  }
  fields.push(cur);
  return fields;
}

function runPsql(sql) {
  return new Promise((resolve, reject) => {
    const args = [
      '-h', PG_HOST,
      '-p', String(PG_PORT),
      '-U', PG_USER,
      '-d', PG_DB,
      '--no-psqlrc',
      '-t',
      '--csv',
      '-c', sql,
    ];
    const spawnStart = process.hrtime.bigint();
    execFile(PSQL_BIN, args, { env: { ...process.env, PGPASSWORD: PG_PASSWORD }, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const spawnMs = Number(process.hrtime.bigint() - spawnStart) / 1e6;
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve({ stdout, spawnMs });
    });
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const COLUMNS = {
  open_work: ['id', 'title', 'area', 'status', 'updated_at'],
};

const server = http.createServer(async (req, res) => {
  const reqStart = process.hrtime.bigint();
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const match = url.pathname.match(/^\/api\/q\/([^/]+)$/);
    if (req.method !== 'GET' || !match) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const name = match[1];
    const def = loadQueryDef(name);
    if (!def) {
      sendJson(res, 404, { error: 'unknown_query', name });
      return;
    }

    let bound;
    try {
      bound = validateAndBindParams(def, url.searchParams);
    } catch (e) {
      sendJson(res, 400, { error: 'invalid_params', detail: e.message });
      return;
    }

    const nocache = url.searchParams.get('nocache') === '1';
    const cacheKey = `${name}:${JSON.stringify(bound)}`;
    const now = Date.now();

    if (!nocache) {
      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAt > now) {
        const totalMs = Number(process.hrtime.bigint() - reqStart) / 1e6;
        sendJson(res, 200, {
          query: name,
          params: bound,
          rows: hit.data,
          cache: 'hit',
          as_of: new Date(hit.cachedAt).toISOString(),
          timing_ms: { total: totalMs },
        });
        return;
      }
    }

    const sql = substituteSql(def.sql, bound);
    const { stdout, spawnMs } = await runPsql(sql);
    const columns = COLUMNS[name] || [];
    const rows = stdout
      .split('\n')
      .filter((l) => l.length > 0)
      .map((line) => {
        const fields = parseCsvLine(line);
        const obj = {};
        columns.forEach((col, i) => { obj[col] = fields[i]; });
        return obj;
      });

    const cachedAt = Date.now();
    if (!nocache) {
      cache.set(cacheKey, {
        data: rows,
        cachedAt,
        expiresAt: cachedAt + (def.cache_ttl || 0) * 1000,
      });
    }

    const totalMs = Number(process.hrtime.bigint() - reqStart) / 1e6;
    sendJson(res, 200, {
      query: name,
      params: bound,
      rows,
      cache: nocache ? 'bypass' : 'miss',
      as_of: new Date(cachedAt).toISOString(),
      timing_ms: { total: totalMs, psql_subprocess: spawnMs },
    });
  } catch (err) {
    sendJson(res, 500, { error: 'internal_error', detail: String(err && err.stack || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`poc8-fastpath listening on http://${HOST}:${PORT}`);
  console.log(`queries dir: ${QUERIES_DIR}`);
});
