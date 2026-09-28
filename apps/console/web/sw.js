// Service worker: push display and notification tap, and the offline shell
// (T7-4; screen 18 §4). A classic script — a worker registered without
// `type: "module"` imports nothing — so the names it shares with offline.js
// are repeated here, and a test holds them equal.
//
// What it does with a request, and nothing more:
//
// - **A write** (anything but GET) is not touched: it reaches the network or
//   fails there. The worker queues nothing. The outbox is the page's
//   (offline.js), and it holds captures and ticks only — an answer, a move,
//   Run Now or a grant has nowhere to wait.
// - **`GET /api/events`** (the live-changes stream, T7-7) is not touched —
//   never answered from a cache, never held: a stream the worker stands in
//   front of is a stream the page cannot tell is down, and its polls would
//   never restart. The sign-in doors (`/auth/`) are not touched either.
// - **Any other `GET /api/…`** goes to the network first. A 200 is kept,
//   stamped with when it was read; when the network does not answer, the
//   kept one answers instead, marked `x-metistry-offline: 1` — the page
//   shows the last view, stamped *Showing 9:04 AM*. A response the console
//   marks `no-store` is never kept. The page forgets every kept read on a 401.
// - **The shell** (the page, its scripts, styles and icons) goes to the
//   network first too — it is served no-cache while the UI iterates — and
//   falls back to the copy kept at install, so the app opens with no network.
const SHELL_CACHE = "metistry-shell-v1";
const READS_CACHE = "metistry-reads-v1"; // offline.js READS_CACHE
const OFFLINE_HEADER = "x-metistry-offline"; // offline.js OFFLINE_HEADER
const READ_AT_HEADER = "x-metistry-read-at"; // offline.js READ_AT_HEADER
const EVENTS_PATH = "/api/events"; // live.js EVENTS_PATH

const SHELL = [
  "/",
  "/app.js", "/lib.js", "/live.js", "/offline.js", "/md.js",
  "/today.js", "/needs-you.js", "/work.js", "/knowledge.js", "/more.js",
  "/tokens.css", "/style.css",
  "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/apple-touch-icon.png",
  "/vendor/simplewebauthn.js",
];

self.addEventListener("install", (event) => {
  // one file that will not fetch never costs the worker its install (push lives here too)
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith("metistry-") && n !== SHELL_CACHE && n !== READS_CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // a write reaches the network or fails there; the worker holds none
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === EVENTS_PATH || url.pathname.startsWith("/auth/")) return; // the stream and sign-in pass straight through
  if (url.pathname.startsWith("/api/")) return event.respondWith(read(req));
  event.respondWith(shell(req));
});

/** A read: the network's answer, kept; or, with no network, the kept one, marked. */
async function read(req) {
  let res;
  try {
    res = await fetch(req);
  } catch {
    const kept = await caches.match(req, { cacheName: READS_CACHE });
    if (!kept) return Response.error();
    const headers = new Headers(kept.headers);
    headers.set(OFFLINE_HEADER, "1");
    return new Response(kept.body, { status: kept.status, statusText: kept.statusText, headers });
  }
  if (res.status === 200 && !/no-store/i.test(res.headers.get("cache-control") ?? "")) {
    try {
      const headers = new Headers(res.headers);
      headers.set(READ_AT_HEADER, new Date().toISOString());
      const body = await res.clone().arrayBuffer();
      await (await caches.open(READS_CACHE)).put(req, new Response(body, { status: 200, headers }));
    } catch { /* a read that cannot be kept is still answered */ }
  }
  return res;
}

/** The shell: the network's copy while there is one, the installed copy while there is not. */
async function shell(req) {
  try {
    return await fetch(req);
  } catch {
    const kept = (await caches.match(req, { cacheName: SHELL_CACHE })) ?? (req.mode === "navigate" ? await caches.match("/", { cacheName: SHELL_CACHE }) : undefined);
    return kept ?? Response.error();
  }
}

// ----- push (T7-5; screen 18 §6) -----
// A notification says the card's type and title and nothing more, and never
// a secret. The worker reads three fields of a payload — `type`, `title` and
// `url` — and no other: a `body`, `actions`, an `image`, `data` are never
// read, so no server text but those two words reaches a lock screen, and no
// payload can add action buttons (iOS web push has none, and answering blind
// is the thing the card exists to prevent). Each word is one line, clipped,
// with anything key-shaped blanked first — the shapes core's `looksLikeKey`
// refuses as a variable, plus runs of six digits or more (a one-time code, a
// card) — and a test holds the two together. A tap opens the payload's page
// on this origin, in the window already open when there is one; a link
// anywhere else opens the app instead.
const NOTE_TYPE_MAX = 40;
const NOTE_TITLE_MAX = 120;
const BLANK = "\u2022\u2022\u2022";

// packages/core/src/variables.ts KEY_PATTERNS, as replacements: a leading
// capture keeps what came before the key, the key itself is blanked.
const KEY_SHAPES = [
  /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  /(^|[^A-Za-z0-9])(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /(^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
  /(^|[^A-Za-z0-9])glpat-[A-Za-z0-9_-]{16,}/g,
  /(^|[^A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /(^|[^A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  /(^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/g,
  /(^|[^A-Za-z0-9])ya29\.[0-9A-Za-z_-]{20,}/g,
  /(^|[^A-Za-z0-9])lin_(?:api|oauth)_[A-Za-z0-9]{20,}/g,
  /(^|[^A-Za-z0-9])apk_[A-Za-z0-9_]{16,}/g,
  /(^|[^A-Za-z0-9])hf_[A-Za-z0-9]{20,}/g,
  /(^|[^A-Za-z0-9])npm_[A-Za-z0-9]{30,}/g,
  /()eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /()-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----.*$/g,
  /(^\s*(?:bearer|basic|token)\s+)\S{8,}/gi,
  /(\bbearer\s+)\S{8,}/gi,
  /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
  /([?&#][A-Za-z_]*(?:token|key|secret|sig|signature|password|passwd|auth|credential)[A-Za-z_]*=)[^&#\s]{6,}/gi,
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const charClass = (c) => (c >= "a" && c <= "z" ? 0 : c >= "A" && c <= "Z" ? 1 : c >= "0" && c <= "9" ? 2 : 3);

/** core's looksRandom: a run of token characters that reads as a key, not a word or a slug. */
function looksRandom(run) {
  if (UUID_RE.test(run)) return false;
  const alnum = run.replace(/[^A-Za-z0-9]/g, "");
  if (alnum.length < 20 || !/[0-9]/.test(alnum) || !/[A-Za-z]/.test(alnum)) return false;
  if (alnum.length >= 32 && /^[0-9a-f]+$/i.test(alnum)) return true;
  let changes = 0;
  for (let i = 1; i < alnum.length; i++) if (charClass(alnum[i]) !== charClass(alnum[i - 1])) changes++;
  return changes / (alnum.length - 1) >= 0.3;
}

/** `text` with every key-shaped part blanked. */
function scrubKeys(text) {
  let out = text;
  for (const re of KEY_SHAPES) out = out.replace(re, (_m, lead) => `${lead}${BLANK}`);
  out = out.replace(/[A-Za-z0-9+=_-]{20,}/g, (run) => (looksRandom(run) ? BLANK : run));
  return out.replace(/\d(?:[ -]?\d){5,}/g, BLANK); // a one-time code, a PIN, a card number
}

/** One line of at most `max` characters, scrubbed before it is clipped — a key cut in half by the clip is still caught. */
function noteLine(value, max) {
  if (typeof value !== "string") return "";
  const line = scrubKeys(value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, " ").trim());
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}\u2026` : line;
}

/** A path on this origin, or the app's root. Never another site. */
function safeUrl(u) {
  if (typeof u !== "string" || !u.startsWith("/") || u.startsWith("//") || u.startsWith("/\\")) return "/";
  try {
    const url = new URL(u, self.location.origin);
    return url.origin === self.location.origin ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}

/**
 * What a payload shows: the card's type as the heading and its title as the
 * line; with no type (a console that predates it), the title alone.
 */
function notificationFor(data) {
  const d = data !== null && typeof data === "object" ? data : {};
  const type = noteLine(d.type, NOTE_TYPE_MAX);
  const title = noteLine(d.title, NOTE_TITLE_MAX);
  return {
    title: type || title || "Metistry",
    options: { body: type ? title : "", icon: "/icon-192.png", data: { url: safeUrl(d.url) } },
  };
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch { /* unreadable: still one notification — a subscription made with userVisibleOnly must show one */ }
  const n = notificationFor(data);
  event.waitUntil(self.registration.showNotification(n.title, n.options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openApp(safeUrl(event.notification.data?.url)));
});

/** Tap opens that card: in the window already open (app.js routes the message), else a new one. */
async function openApp(url) {
  const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const here = open.find((c) => {
    try { return new URL(c.url).origin === self.location.origin; } catch { return false; }
  });
  if (!here) return self.clients.openWindow(url);
  await here.focus();
  here.postMessage({ type: "metistry.open", url });
}
