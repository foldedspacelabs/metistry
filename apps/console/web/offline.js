// Offline in the PWA (T7-4; screen 18 §4; design-build-plan §2.17) — one
// rule per verb:
//
//   Reading                     the last view, stamped *Showing 9:04 AM* (sw.js keeps the reads)
//   Capture                     waits, and sends with its Idempotency-Key
//   Tick a task                 waits with the line it saw; replays through the Tick door's 409
//   Answer, move, Run Now,      not offered — they need the console's answer
//   a mode, a grant             before they happen
//   Send in Chat                refused with the reason; the draft stays
//
// The outbox holds exactly two routes, and that list is closed: anything
// else handed to it is refused before it is stored, so an answer, a move,
// Run Now or a grant cannot be queued by any path through the PWA — not by a
// view that forgets to disable a button, not by a gesture. The principle is
// screen 18's: anything with a consequence for someone else, or that cannot
// be taken back, needs the server's answer before it happens; a note to
// yourself does not.
//
// DOM-free on purpose, like live.js and lib.js: the shell (app.js) hands it
// `fetch`, IndexedDB and its own callbacks, and a test hands it fakes.

import { clockTime } from "./lib.js";

/**
 * What the outbox may hold (docs/ops/client-api.md, the route table's
 * Idempotent column): `POST /capture` and the Tick door. Both honour
 * `Idempotency-Key`, so a replay of one that reached the console before the
 * connection dropped is the first answer again, never a second act. The
 * Defer door honours the key too, but the outbox is captures and ticks
 * (§2.17) — Defer is not offered offline.
 */
export const OUTBOX_ROUTES = [
  { verb: "capture", method: "POST", path: /^\/capture$/ },
  { verb: "tick", method: "POST", path: /^\/api\/vault-tasks\/[^/?#]+\/check$/ },
];

/** The outbox's verb for a request, or null: the request is never queued. */
export function queueable(method, path) {
  const m = String(method ?? "").toUpperCase();
  const p = String(path ?? "").split(/[?#]/)[0];
  return OUTBOX_ROUTES.find((r) => r.method === m && r.path.test(p))?.verb ?? null;
}

/** A write the outbox refused to hold. Its message says why; nothing was stored. */
export class NotQueueable extends Error {
  constructor(message) {
    super(message);
    this.name = "NotQueueable";
  }
}

// ----- whether the console answered -----

/** Set by sw.js on a read it answered from its cache because the network did not. */
export const OFFLINE_HEADER = "x-metistry-offline";
/** When a cached read was first read from the console (ISO 8601). */
export const READ_AT_HEADER = "x-metistry-read-at";
/** The cache sw.js keeps the reads in; the shell forgets it on a 401. */
export const READS_CACHE = "metistry-reads-v1";

/** A gateway answering for a console it could not reach (the home proxy, a tunnel). */
const GATEWAY = new Set([502, 504]);

/**
 * Whether a response says the console was not reached: a gateway's 502 or
 * 504, or a read the worker served from its cache. A thrown `fetch` is the
 * other way to learn it; the caller catches that.
 */
export function unreached(res) {
  if (!res) return true;
  if (GATEWAY.has(res.status)) return true;
  return res.headers?.get?.(OFFLINE_HEADER) === "1";
}

/** When a cached read was read, or null for a live one. */
export function readAt(res) {
  const at = res?.headers?.get?.(READ_AT_HEADER);
  return at && !Number.isNaN(new Date(at).getTime()) ? at : null;
}

// ----- the outbox -----

/**
 * The outbox: a queue of writes that wait for the console, drained head
 * first. `store` persists it (`idbStore`, or `memoryStore` where IndexedDB
 * is not available); `send(entry)` is the shell's `fetch`.
 *
 * A drain stops, keeping everything, at the first write the console does not
 * answer (a thrown fetch, 502/504, 429 or 5xx) and at a 401 — a session
 * that ended holds the queue until the owner signs in again. Every other
 * answer takes the head off: 2xx `sent`, 409 `stale` (the Tick door's
 * `seen_text` check — the line changed while the tick waited), and any other
 * 4xx `refused`, with the console's own words. `onResult` hears each one.
 */
export function createOutbox({ store, send, onChange = () => {}, onResult = () => {}, now = () => new Date() }) {
  let entries = [];
  let draining = null;
  let inFlight = null;

  const changed = () => onChange(entries.length);

  async function load() {
    entries = [...(await store.all())].sort((a, b) => a.seq - b.seq);
    changed();
    return entries.length;
  }

  /**
   * Hold one write. `headers["idempotency-key"]` is required and is minted
   * by the caller BEFORE its first attempt, so a write that did reach the
   * console before the connection dropped replays as the same act.
   */
  async function add({ method = "POST", path, headers = {}, body, meta = {} }) {
    const verb = queueable(method, path);
    if (!verb) throw new NotQueueable(`${method} ${path} is never queued: it needs the console's answer before it happens`);
    const key = headers["idempotency-key"];
    if (typeof key !== "string" || !key || key.length > 200) throw new NotQueueable("a write waits only with the Idempotency-Key its first attempt carried");
    if (entries.some((e) => e.id === key)) return entries.find((e) => e.id === key);
    const entry = {
      id: key,
      seq: entries.reduce((n, e) => Math.max(n, e.seq), 0) + 1,
      verb,
      method,
      path,
      headers: { ...headers },
      body,
      meta: { ...meta },
      queued_at: now().toISOString(),
    };
    await store.put(entry);
    entries.push(entry);
    changed();
    return entry;
  }

  /** Take a waiting write back before it is sent (Don't Send). The one in flight cannot be. */
  async function cancel(id) {
    if (inFlight === id) return false;
    const i = entries.findIndex((e) => e.id === id);
    if (i === -1) return false;
    entries.splice(i, 1);
    await store.delete(id);
    changed();
    return true;
  }

  async function drainOnce() {
    const done = [];
    while (entries.length) {
      const e = entries[0];
      inFlight = e.id;
      let res;
      try {
        res = await send(e);
      } catch {
        return { held: entries.length, reason: "unreached", done };
      } finally {
        inFlight = null;
      }
      if (unreached(res)) return { held: entries.length, reason: "unreached", done };
      if (res.status === 401) return { held: entries.length, reason: "unauthenticated", done };
      if (res.status === 429 || res.status >= 500) return { held: entries.length, reason: "later", done };
      const body = await res.json().catch(() => ({}));
      const outcome = res.ok || alreadyAsked(e, res.status, body) ? "sent" : res.status === 409 ? "stale" : "refused";
      if (entries[0] === e) entries.shift();
      await store.delete(e.id).catch(() => {});
      changed();
      const result = { entry: e, outcome, status: res.status, body, replayed: res.headers?.get?.("idempotency-replayed") === "true" };
      done.push(result);
      onResult(result);
    }
    return { held: 0, reason: null, done };
  }

  return {
    load,
    add,
    cancel,
    /** Send what waits, oldest first. One drain at a time: a second call joins the first. */
    drain() {
      if (!draining) draining = drainOnce().finally(() => { draining = null; });
      return draining;
    },
    /** The writes waiting, oldest first — for one verb, or all. */
    waiting(verb = null) {
      return entries.filter((e) => !verb || e.verb === verb).map((e) => ({ ...e, meta: { ...e.meta } }));
    },
    get size() { return entries.length; },
  };
}

/**
 * A tick's 409 whose line already says what the tick asked — the first
 * attempt reached the console before the connection dropped and the console
 * has since restarted (its keys live in memory), or the box was ticked in
 * Obsidian meanwhile. The note is the record, and it says what was asked.
 */
function alreadyAsked(e, status, body) {
  if (e.verb !== "tick" || status !== 409 || body?.reason !== "stale" || !body.task) return false;
  return Boolean(body.task.checked) === Boolean(e.meta.checked) && String(body.task.text ?? "") === String(e.meta.seen_text ?? "");
}

/** The outbox kept in memory: for a browser without IndexedDB (it lasts until the page does), and for tests. */
export function memoryStore(seed = []) {
  const m = new Map(seed.map((e) => [e.id, e]));
  return {
    all: async () => [...m.values()],
    put: async (e) => { m.set(e.id, e); },
    delete: async (id) => { m.delete(id); },
  };
}

/**
 * The outbox in IndexedDB, which survives a reload and holds a file's bytes
 * (a Blob is structured-cloned) — localStorage holds neither safely.
 */
export function idbStore(idb, name = "metistry-outbox") {
  let db = null;
  const open = () => new Promise((resolve, reject) => {
    const req = idb.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("entries", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  async function tx(mode, fn) {
    db ??= await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction("entries", mode);
      const req = fn(t.objectStore("entries"));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  return {
    all: () => tx("readonly", (s) => s.getAll()),
    put: (e) => tx("readwrite", (s) => s.put(e)).then(() => {}),
    delete: (id) => tx("readwrite", (s) => s.delete(id)).then(() => {}),
  };
}

/**
 * IndexedDB where the browser has it and lets this page use it; memory where
 * it does not (a private window refuses the open). The first refusal
 * switches to memory for the rest of the page's life.
 */
export function keptStore(idb) {
  let s = idb ? idbStore(idb) : memoryStore();
  const guarded = (op) => async (...args) => {
    try {
      return await s[op](...args);
    } catch {
      s = memoryStore();
      return s[op](...args);
    }
  };
  return { all: guarded("all"), put: guarded("put"), delete: guarded("delete") };
}

// ----- the band (screen 18 §4) -----

/**
 * The band under the header while the console cannot be reached: what is
 * wrong, and what still works. `shownAt` is when the view on screen was read
 * (a cached read's time); `waiting` how many writes the outbox holds.
 */
export function bandText({ shownAt = null, waiting = 0 } = {}) {
  const when = shownAt ? clockTime(shownAt) : "";
  const parts = [
    ...(when ? [`Showing ${when}`] : []),
    "Captures and ticks wait and send when it's back",
    ...(waiting ? [`${waiting} waiting`] : []),
  ];
  return { title: "Can't reach Metistry", detail: parts.join(" · ") };
}

/** What a drain did, said once: *Sent 2 that were waiting.* — and what the console would not take. */
export function drainedText(done) {
  if (!done?.length) return "";
  const sent = done.filter((d) => d.outcome === "sent").length;
  const stale = done.filter((d) => d.outcome === "stale").length;
  const refused = done.length - sent - stale;
  return [
    sent ? `Sent ${sent} that ${sent === 1 ? "was" : "were"} waiting.` : "",
    stale ? `${stale} ${stale === 1 ? "tick was" : "ticks were"} not written: the line changed while ${stale === 1 ? "it" : "they"} waited.` : "",
    refused ? `${refused} ${refused === 1 ? "was" : "were"} refused by Metistry.` : "",
  ].filter(Boolean).join(" ");
}
