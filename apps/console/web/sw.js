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

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "Metistry", body: "" };
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, data: { url: data.url ?? "/" } }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url ?? "/"));
});
