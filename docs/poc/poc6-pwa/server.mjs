// Metistry PoC-6 server. ZERO dependencies - node built-ins only.
//
// Serves a minimal installable PWA and implements PAYLOAD-LESS web push:
//   * VAPID (RFC 8292) ES256 JWT via node:crypto webcrypto -> Authorization header
//   * NO RFC 8291 / aes128gcm body encryption, because there is no payload.
//     The service worker shows a fixed local notification instead.
//
// Listens on 127.0.0.1:8093; `tailscale serve --bg 8093` fronts it with a
// real HTTPS cert on https://<machine>.<tailnet>.ts.net/

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8093;
const HOST = '127.0.0.1';
const SUBS_PATH = path.join(DIR, 'subscriptions.json');
const VAPID_PATH = path.join(DIR, 'vapid.json');

/* ------------------------------------------------------------------ utils */

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/* ------------------------------------------------------------ VAPID setup */

const vapid = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
const VAPID_SUBJECT = vapid.subject || 'mailto:poc@example.invalid';
const VAPID_PUBLIC = vapid.publicKey; // base64url raw (65-byte uncompressed point)

let vapidPrivateKey = null;
async function getPrivateKey() {
  if (!vapidPrivateKey) {
    vapidPrivateKey = await webcrypto.subtle.importKey(
      'jwk',
      vapid.jwkPrivate,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,          // NOT extractable - it can never be read back out
      ['sign'],
    );
  }
  return vapidPrivateKey;
}

// Build the `Authorization: vapid t=<jwt>, k=<pubkey>` header for one endpoint.
// aud MUST be the ORIGIN of the push endpoint, not the full URL.
async function buildVapidHeader(endpoint) {
  const aud = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, // now + 12h
    sub: VAPID_SUBJECT,
  };

  const signingInput =
    b64url(Buffer.from(JSON.stringify(header))) + '.' +
    b64url(Buffer.from(JSON.stringify(claims)));

  // ECDSA P-256 / SHA-256 -> webcrypto returns raw r||s (64 bytes), which is
  // exactly the JWS ES256 signature format. No DER unwrapping needed.
  const sig = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    await getPrivateKey(),
    Buffer.from(signingInput),
  );

  const jwt = signingInput + '.' + b64url(sig);
  return {
    authorization: `vapid t=${jwt}, k=${VAPID_PUBLIC}`,
    // returned for logging/diagnostics only - never includes the private key
    debug: { header, claims, sigBytes: new Uint8Array(sig).length, jwtLength: jwt.length },
  };
}

/* ------------------------------------------------- subscription storage */

function readSubs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SUBS_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSubs(subs) {
  fs.writeFileSync(SUBS_PATH, JSON.stringify(subs, null, 2));
}

/* ------------------------------------------------------ payload-less push */

function postPush(endpoint, headers) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.request(endpoint, { method: 'POST', headers, timeout: 15000 }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({
          status: res.statusCode,
          statusText: res.statusMessage,
          body: body.slice(0, 400),
        }));
      });
    } catch (err) {
      return resolve({ status: 0, error: 'request-setup: ' + err.message });
    }
    req.on('timeout', () => { req.destroy(new Error('timeout after 15s')); });
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.end(); // no body at all - this is the payload-less part
  });
}

async function sendPushToAll() {
  const subs = readSubs();
  const results = [];

  for (const sub of subs) {
    const endpoint = sub.endpoint;
    let entry = { endpoint, host: null };
    try {
      entry.host = new URL(endpoint).host;
      const { authorization, debug } = await buildVapidHeader(endpoint);

      // Log the JWT SHAPE only. Never the private key.
      log('VAPID JWT for', entry.host, JSON.stringify(debug));

      const headers = {
        'Authorization': authorization,
        'TTL': '60',
        'Content-Length': '0',
        'Urgency': 'high',
      };
      const res = await postPush(endpoint, headers);
      entry = { ...entry, ...res, vapid: debug };
      log('push ->', entry.host, 'status=', res.status, res.error || '');
    } catch (err) {
      entry.status = 0;
      entry.error = err.message;
      log('push failed ->', endpoint, err.message);
    }
    results.push(entry);
  }

  return results;
}

/* --------------------------------------------------------- static assets */

const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json' },
  '/sw.js': { file: 'sw.js', type: 'text/javascript; charset=utf-8' },
  '/icon-180.png': { file: 'icon-180.png', type: 'image/png' },
  '/icon-512.png': { file: 'icon-512.png', type: 'image/png' },
};

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const payload = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/* ------------------------------------------------------------------ server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  log(req.method, pathname);

  // --- GET /vapid-public-key ---
  if (req.method === 'GET' && pathname === '/vapid-public-key') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(VAPID_PUBLIC);
  }

  // --- POST /subscribe ---
  if (req.method === 'POST' && pathname === '/subscribe') {
    try {
      const raw = await readBody(req);
      const sub = JSON.parse(raw);
      if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) {
        return json(res, 400, { ok: false, error: 'missing or non-https endpoint' });
      }
      const subs = readSubs();
      const idx = subs.findIndex((s) => s.endpoint === sub.endpoint);
      let action;
      if (idx >= 0) { subs[idx] = sub; action = 'updated'; }
      else { subs.push(sub); action = 'added'; }
      writeSubs(subs);
      log('subscribe', action, new URL(sub.endpoint).host, 'total=', subs.length);
      return json(res, 200, { ok: true, action, total: subs.length });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
  }

  // --- POST /push-test ---
  if (req.method === 'POST' && pathname === '/push-test') {
    try {
      const results = await sendPushToAll();
      return json(res, 200, {
        ok: true,
        count: results.length,
        results,
      });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  // --- GET /subscriptions (diagnostics) ---
  if (req.method === 'GET' && pathname === '/subscriptions') {
    const subs = readSubs();
    return json(res, 200, {
      count: subs.length,
      endpoints: subs.map((s) => s.endpoint),
    });
  }

  // --- static ---
  const entry = STATIC[pathname];
  if (req.method === 'GET' && entry) {
    let data;
    try {
      data = fs.readFileSync(path.join(DIR, entry.file));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found: ' + entry.file);
    }
    const headers = {
      'Content-Type': entry.type,
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    };
    // A service worker at / needs no special header here (scope is the root
    // anyway), but be explicit about the max scope for clarity.
    if (pathname === '/sw.js') headers['Service-Worker-Allowed'] = '/';
    res.writeHead(200, headers);
    return res.end(data);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 not found\n');
});

server.listen(PORT, HOST, () => {
  log(`Metistry PoC-6 listening on http://${HOST}:${PORT}`);
  log(`VAPID public key: ${VAPID_PUBLIC}`);
  log(`subscriptions file: ${SUBS_PATH}`);
});
