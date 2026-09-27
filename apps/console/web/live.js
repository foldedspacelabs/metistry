// Live changes in the PWA (T7-7; design-build-plan §2.20). The console says
// WHAT changed on `GET /api/events` — ids and counts, never bodies — and the
// view showing it refetches through the route it already reads. Polling stays
// as the fallback, and only as the fallback: every poll timer the shell keeps
// runs while the stream is not up, and none runs while it is.
//
// DOM-free on purpose, like lib.js: the shell (app.js) hands it the browser's
// `EventSource` and its own refreshers, and a test hands it fakes.

/** The stream's route (`docs/ops/client-api.md` "Live changes"). */
export const EVENTS_PATH = "/api/events";

/** The capability `GET /api/identity` lists while that route streams; without it the PWA never subscribes, and polls. */
export const EVENTS_CAPABILITY = "events";

/**
 * The event types the PWA listens for: core's catalogue (`EVENT_TYPES` in
 * packages/core/src/events.ts), in its order — a test holds the two equal.
 * The browser dispatches a named SSE event only to a listener for that name,
 * so a type a newer console adds is ignored until it is listed here.
 */
export const EVENT_TYPES = [
  "run.started",
  "run.finished",
  "turn.progress",
  "message.new",
  "presence.changed",
  "needs_you.changed",
  "work.changed",
  "thread.changed",
  "capture.new",
  "vault.reconciled",
  "vault.sync",
  "routine.status",
  "sync.status",
  "connection.health",
  "config.changed",
  "budget.state",
  "release.available",
  "resync",
];

/**
 * Which of the shell's views each event refreshes — the catalogue's "the
 * client refetches" column, read as the PWA's views: a view is named when it
 * reads the route the catalogue names. `open` is what is open where it
 * matters: `{ artifact_id }` of the artifact on screen, so one artifact's
 * threads never refetch another's. An empty list is a type no PWA view shows
 * yet (the Scheduled routes, the vault's sync state) — listed so the table
 * covers the whole catalogue. `needs_you.changed` carries the count itself;
 * the shell paints it without a fetch.
 */
export function viewsFor(type, data = {}, open = {}) {
  switch (type) {
    case "run.started":
    case "run.finished":
      // a turn's run is the reply in flight; every run is a row in Activity and in Today's Since You Last Looked
      return [...(data.turn_id ? ["chat"] : []), "feed", ...(type === "run.finished" ? ["today"] : [])];
    case "turn.progress":
    case "message.new":
      return ["chat"];
    case "presence.changed":
      return ["agents", "agent", "today"];
    case "needs_you.changed":
      return ["triage"];
    case "work.changed":
      return ["board", "card", "rooms", "projects", "project", "today"];
    case "thread.changed":
      // the artifact pushed, and the sheet of its comments over it (T7-3b)
      if (data.artifact_id !== undefined) return data.artifact_id === open.artifact_id ? ["artifact", "thread"] : [];
      return ["rooms"];
    case "capture.new":
      return ["feed", "today"];
    case "vault.reconciled":
      return ["today", "knowledge", "area", "page"];
    case "connection.health":
    case "release.available":
      return ["settings"];
    case "config.changed":
      return ["settings", "usage", "projects", "project"];
    case "budget.state":
      return ["usage", "projects", "project"];
    default:
      return []; // vault.sync, routine.status, sync.status: no PWA view reads their routes yet; resync is every visible view
  }
}

/** How long a closed stream waits before a fresh one: the console's own `retry:` first, then backing off to a minute. */
export const RECONNECT_MS = [3000, 6000, 15000, 30000, 60000];

// EventSource.readyState: the browser gave up on this one and will not reconnect it.
const CLOSED = 2;

/**
 * The stream and the polls it stands in for.
 *
 * - `poll(name, fn, ms)` registers the fallback for one view (again with a
 *   new interval replaces it). Its timer runs only while the PWA is started
 *   and the stream is not `live`.
 * - `start({ stream })` subscribes (`stream: false` — no `events`
 *   capability, no `EventSource` — polls instead); `stop()` ends both, on
 *   sign-out.
 * - While the browser reconnects on its own it sends `Last-Event-ID` and the
 *   console replays what was missed, so nothing is refetched. When it gives
 *   up (a non-200: the console restarting, 429, 503) a fresh stream opens
 *   after a backoff; a fresh stream carries no `Last-Event-ID`, so its open
 *   is a reload, as a `resync` is.
 *
 * States, handed to `onState`: `off` · `polling` (no stream offered) ·
 * `connecting` · `live` · `down`.
 */
export function createLive({ url = EVENTS_PATH, EventSource: ES = null, onEvent = () => {}, onReload = () => {}, onState = () => {} } = {}) {
  const polls = new Map(); // name → { fn, ms, timer }
  let started = false;
  let state = "off";
  let source = null;
  let retry = null;
  let attempt = 0;
  let fresh = false; // the next open is a new subscription: what happened before it is unknown

  const polling = () => started && state !== "live";

  function sync() {
    for (const p of polls.values()) {
      if (polling() && !p.timer) p.timer = setInterval(p.fn, p.ms);
      else if (!polling() && p.timer) { clearInterval(p.timer); p.timer = null; }
    }
  }

  function setState(s) {
    const changed = s !== state;
    state = s;
    sync();
    if (changed) onState(s);
  }

  function poll(name, fn, ms) {
    const old = polls.get(name);
    if (old?.timer) clearInterval(old.timer);
    polls.set(name, { fn, ms, timer: null });
    sync();
  }

  function open() {
    retry = null;
    let es;
    try {
      es = new ES(url);
    } catch {
      return closed();
    }
    source = es;
    es.addEventListener("open", () => {
      if (source !== es) return;
      attempt = 0;
      setState("live");
      if (fresh) { fresh = false; onReload("reconnect"); }
    });
    es.addEventListener("error", () => {
      if (source !== es) return;
      if (es.readyState === CLOSED) { source = null; closed(); }
      else setState("down"); // the browser is reconnecting, with Last-Event-ID
    });
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (e) => {
        if (source !== es) return;
        let data;
        try {
          data = e.data ? JSON.parse(e.data) : {};
        } catch {
          return; // not the console's frame: nothing to act on
        }
        if (type === "resync") onReload("resync");
        else onEvent(type, data ?? {});
      });
    }
  }

  function closed() {
    setState("down");
    fresh = true;
    const ms = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
    attempt++;
    retry = setTimeout(open, ms);
  }

  return {
    poll,
    get state() { return state; },
    start({ stream = true } = {}) {
      if (started) return;
      started = true;
      if (stream && ES) { setState("connecting"); open(); }
      else setState("polling");
    },
    stop() {
      started = false;
      if (retry) clearTimeout(retry);
      retry = null;
      source?.close();
      source = null;
      attempt = 0;
      fresh = false;
      setState("off");
    },
    /** Back online, or back in front: a stream waiting out its backoff tries now. */
    nudge() {
      if (!started || !retry) return;
      clearTimeout(retry);
      open();
    },
  };
}

/**
 * Refetch the views events name, gathered: a burst of events refetches each
 * view once. Only a view on screen refetches (`visible()` names them); one
 * the owner is in the middle of (`busy(view)` — a field with focus, a drag,
 * an open picker) waits for `flush()` after they leave it, and so does
 * everything while the page is hidden.
 */
export function createRefresher({ refreshers, visible, busy = () => false, hidden = () => false, delayMs = 100 }) {
  const pending = new Set();
  let timer = null;

  function flush() {
    timer = null;
    if (hidden()) return;
    const on = new Set(visible());
    for (const view of [...pending]) {
      if (!on.has(view)) { pending.delete(view); continue; } // it loads fresh when it opens
      if (busy(view)) continue;
      pending.delete(view);
      Promise.resolve().then(() => refreshers[view]()).catch(() => {});
    }
  }

  return {
    /** Mark views changed; they refetch after the burst. */
    queue(views) {
      for (const v of views) if (Object.hasOwn(refreshers, v)) pending.add(v);
      if (pending.size && !timer) timer = setTimeout(flush, delayMs);
    },
    flush,
    get pending() { return [...pending]; },
  };
}
