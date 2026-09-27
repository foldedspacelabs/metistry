// T7-7 — live events in the PWA (design-build-plan §2.20): one EventSource on
// `GET /api/events`, the view on screen refetches on an event, and polling
// with the `since` cursors is the fallback while the stream is down. The
// ticket's own test is held first: **the poll timers stop while the stream is
// healthy and restart when it drops.**
//
// live.js is DOM-free, so it is imported as it is and driven with a fake
// EventSource and vitest's fake timers — no DOM library (CLAUDE.md). The
// shell's wiring in app.js is read from the source, as pwa-shell.test.ts does.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_CATALOGUE, EVENT_TYPES as CORE_EVENT_TYPES, EVENTS_CAPABILITY as CORE_CAPABILITY } from "@foldedspacelabs/metistry-core";
import { EVENTS_CAPABILITY, EVENTS_PATH, EVENT_TYPES, RECONNECT_MS, createLive, createRefresher, viewsFor } from "../web/live.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SRC = read("../web/app.js");
const SW = read("../web/sw.js");

type Listener = (e: { data?: string; lastEventId?: string }) => void;

/** What the browser's EventSource does, as far as live.js can see it. */
class FakeEventSource {
  static made: FakeEventSource[] = [];
  static latest = () => FakeEventSource.made.at(-1)!;
  readyState = 0; // CONNECTING
  closed = false;
  listeners: Record<string, Listener[]> = {};
  constructor(readonly url: string) {
    FakeEventSource.made.push(this);
  }
  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] ??= []).push(fn);
  }
  close() {
    this.readyState = 2;
    this.closed = true;
  }
  emit(type: string, e: { data?: string; lastEventId?: string } = {}) {
    for (const fn of this.listeners[type] ?? []) fn(e);
  }
  /** The response arrived: 200, text/event-stream. */
  opened() {
    this.readyState = 1;
    this.emit("open");
  }
  /** The connection dropped; the browser will reconnect by itself, sending Last-Event-ID. */
  dropped() {
    this.readyState = 0;
    this.emit("error");
  }
  /** A non-200 (the console restarting, 429, 503): the browser gives up on this one. */
  refused() {
    this.readyState = 2;
    this.emit("error");
  }
  send(type: string, data: unknown, id = "1790000000000124") {
    this.emit(type, { data: typeof data === "string" ? data : JSON.stringify(data), lastEventId: id });
  }
}

function harness() {
  const events: [string, unknown][] = [];
  const reloads: string[] = [];
  const states: string[] = [];
  const live = createLive({
    EventSource: FakeEventSource as unknown as typeof EventSource,
    onEvent: (type: string, data: unknown) => void events.push([type, data]),
    onReload: (why: string) => void reloads.push(why),
    onState: (s: string) => void states.push(s),
  });
  const ticks: Record<string, number> = { chat: 0, needs: 0, feed: 0, board: 0 };
  live.poll("chat", () => ticks.chat++, 2500);
  live.poll("needs", () => ticks.needs++, 30000);
  live.poll("feed", () => ticks.feed++, 10000);
  live.poll("board", () => ticks.board++, 10000);
  const snapshot = () => ({ ...ticks });
  return { live, events, reloads, states, ticks, snapshot };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.made = [];
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The ticket's test
// ---------------------------------------------------------------------------

describe("the poll timers stop while the stream is healthy and restart when it drops", () => {
  it("polls while connecting, none while live, all again once it drops, none once it is back", () => {
    const h = harness();
    h.live.start();
    const es = FakeEventSource.latest();
    expect(es.url).toBe("/api/events");

    // connecting: nothing is live yet, so the fallback runs
    vi.advanceTimersByTime(30000);
    expect(h.ticks).toEqual({ chat: 12, needs: 1, feed: 3, board: 3 });

    // healthy: not one poll timer left running
    es.opened();
    expect(h.live.state).toBe("live");
    expect(vi.getTimerCount()).toBe(0);
    const whileLive = h.snapshot();
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.ticks).toEqual(whileLive);

    // dropped: every poll restarts
    es.dropped();
    expect(h.live.state).toBe("down");
    vi.advanceTimersByTime(30000);
    expect(h.ticks.chat - whileLive.chat).toBe(12);
    expect(h.ticks.needs - whileLive.needs).toBe(1);
    expect(h.ticks.feed - whileLive.feed).toBe(3);
    expect(h.ticks.board - whileLive.board).toBe(3);

    // back: they stop again
    es.opened();
    expect(vi.getTimerCount()).toBe(0);
    const back = h.snapshot();
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.ticks).toEqual(back);
    expect(h.states).toEqual(["connecting", "live", "down", "live"]);
  });

  it("a poll registered while the stream is live (the chat's burst after a send) waits for it to drop", () => {
    const h = harness();
    h.live.start();
    FakeEventSource.latest().opened();
    let burst = 0;
    h.live.poll("chat", () => burst++, 1000);
    vi.advanceTimersByTime(20000);
    expect(burst).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    FakeEventSource.latest().dropped();
    vi.advanceTimersByTime(5000);
    expect(burst).toBe(5);
  });

  it("registering a view's poll again replaces it: one timer per view, never two", () => {
    const h = harness();
    h.live.start();
    h.live.poll("chat", () => h.ticks.chat++, 1000);
    h.live.poll("chat", () => h.ticks.chat++, 2500);
    expect(vi.getTimerCount()).toBe(4);
    vi.advanceTimersByTime(5000);
    expect(h.ticks.chat).toBe(2);
  });

  it("the stream refused outright (non-200) is down too: the polls run through the backoff", () => {
    const h = harness();
    h.live.start();
    FakeEventSource.latest().opened();
    FakeEventSource.latest().refused();
    expect(h.live.state).toBe("down");
    vi.advanceTimersByTime(2500);
    expect(h.ticks.chat).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reconnecting
// ---------------------------------------------------------------------------

describe("reconnect", () => {
  it("while the browser reconnects by itself (with Last-Event-ID) no second stream opens and nothing is reloaded — the console replays", () => {
    const h = harness();
    h.live.start();
    const es = FakeEventSource.latest();
    es.opened();
    es.dropped();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.made).toHaveLength(1);
    es.opened();
    es.send("work.changed", { work_id: 214 }); // a replayed frame arrives like a live one
    expect(h.reloads).toEqual([]);
    expect(h.events).toEqual([["work.changed", { work_id: 214 }]]);
  });

  it("when the browser gives up, a fresh stream opens after the console's retry, and its open is a reload — it carries no Last-Event-ID", () => {
    const h = harness();
    h.live.start();
    const first = FakeEventSource.latest();
    first.opened();
    first.refused();
    vi.advanceTimersByTime(RECONNECT_MS[0]! - 1);
    expect(FakeEventSource.made).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.made).toHaveLength(2);
    const second = FakeEventSource.latest();
    expect(h.reloads).toEqual([]);
    second.opened();
    expect(h.reloads).toEqual(["reconnect"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off while it keeps failing, and starts over once one opens", () => {
    const h = harness();
    h.live.start();
    FakeEventSource.latest().refused();
    const opensAt: number[] = [];
    for (const ms of RECONNECT_MS) {
      vi.advanceTimersByTime(ms);
      opensAt.push(FakeEventSource.made.length);
      FakeEventSource.latest().refused();
    }
    expect(opensAt).toEqual([2, 3, 4, 5, 6]);
    vi.advanceTimersByTime(RECONNECT_MS.at(-1)! - 1); // capped at the last step
    expect(FakeEventSource.made).toHaveLength(6);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.made).toHaveLength(7);
    FakeEventSource.latest().opened();
    FakeEventSource.latest().refused();
    vi.advanceTimersByTime(RECONNECT_MS[0]!);
    expect(FakeEventSource.made).toHaveLength(8);
  });

  it("back online (or back in front) during a backoff, it tries now", () => {
    const h = harness();
    h.live.start();
    FakeEventSource.latest().refused();
    h.live.nudge();
    expect(FakeEventSource.made).toHaveLength(2);
    vi.advanceTimersByTime(RECONNECT_MS[0]!);
    expect(FakeEventSource.made).toHaveLength(2); // the pending retry went with the nudge
  });

  it("a nudge with a stream open, or reconnecting by itself, opens nothing", () => {
    const h = harness();
    h.live.start();
    h.live.nudge();
    FakeEventSource.latest().opened();
    h.live.nudge();
    FakeEventSource.latest().dropped();
    h.live.nudge();
    expect(FakeEventSource.made).toHaveLength(1);
  });

  it("`resync` is a reload of every visible screen, not an event", () => {
    const h = harness();
    h.live.start();
    FakeEventSource.latest().opened();
    FakeEventSource.latest().send("resync", {});
    expect(h.reloads).toEqual(["resync"]);
    expect(h.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Starting, stopping, and a console with no stream
// ---------------------------------------------------------------------------

describe("start and stop", () => {
  it("signed out: the stream is closed, no timer is left, and a late error from the old stream reopens nothing", () => {
    const h = harness();
    h.live.start();
    const es = FakeEventSource.latest();
    es.opened();
    es.dropped();
    expect(vi.getTimerCount()).toBe(4);
    h.live.stop();
    expect(es.closed).toBe(true);
    expect(h.live.state).toBe("off");
    expect(vi.getTimerCount()).toBe(0);
    es.refused();
    es.send("work.changed", { work_id: 1 });
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeEventSource.made).toHaveLength(1);
    expect(h.events).toEqual([]);
    expect(h.ticks).toEqual({ chat: 0, needs: 0, feed: 0, board: 0 });
  });

  it("stopped during a backoff, it does not come back", () => {
    const h = harness();
    h.live.start();
    FakeEventSource.latest().refused();
    h.live.stop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeEventSource.made).toHaveLength(1);
  });

  it("signed in again, it subscribes again", () => {
    const h = harness();
    h.live.start();
    h.live.stop();
    h.live.start();
    expect(FakeEventSource.made).toHaveLength(2);
    expect(FakeEventSource.made[0]!.closed).toBe(true);
  });

  it("start twice opens one stream", () => {
    const h = harness();
    h.live.start();
    h.live.start();
    expect(FakeEventSource.made).toHaveLength(1);
  });

  it("with no stream offered (no `events` capability) it never subscribes, and polls", () => {
    const h = harness();
    h.live.start({ stream: false });
    expect(FakeEventSource.made).toHaveLength(0);
    expect(h.live.state).toBe("polling");
    vi.advanceTimersByTime(10000);
    expect(h.ticks.feed).toBe(1);
  });

  it("with no EventSource in the browser, it polls", () => {
    const live = createLive({ EventSource: null });
    let n = 0;
    live.poll("chat", () => n++, 1000);
    live.start();
    expect(live.state).toBe("polling");
    vi.advanceTimersByTime(3000);
    expect(n).toBe(3);
  });

  it("a constructor that throws is a refused stream: down, polling, and retried", () => {
    let calls = 0;
    const Throws = function () { calls++; throw new Error("blocked"); } as unknown as typeof EventSource;
    const live = createLive({ EventSource: Throws });
    live.start();
    expect(live.state).toBe("down");
    vi.advanceTimersByTime(RECONNECT_MS[0]!);
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

describe("the catalogue (packages/core/src/events.ts)", () => {
  it("listens for exactly core's event types, on core's route, under core's capability", () => {
    expect(EVENT_TYPES).toEqual([...CORE_EVENT_TYPES]);
    expect(EVENTS_PATH).toBe("/api/events");
    expect(EVENTS_CAPABILITY).toBe(CORE_CAPABILITY);
  });

  it("every type is listened for by name — the browser dispatches a named SSE event to no other listener", () => {
    const h = harness();
    h.live.start();
    const es = FakeEventSource.latest();
    for (const type of CORE_EVENT_TYPES) expect(es.listeners[type], type).toHaveLength(1);
  });

  it("hands each event's parsed payload on, ids and counts as sent", () => {
    const h = harness();
    h.live.start();
    const es = FakeEventSource.latest();
    es.opened();
    es.send("needs_you.changed", { waiting: 3 });
    es.send("message.new", { message_id: 9, thread: "main" });
    es.send("thread.changed", { artifact_id: "art_01" });
    expect(h.events).toEqual([
      ["needs_you.changed", { waiting: 3 }],
      ["message.new", { message_id: 9, thread: "main" }],
      ["thread.changed", { artifact_id: "art_01" }],
    ]);
  });

  it("a frame that is not JSON is dropped, and the stream keeps going", () => {
    const h = harness();
    h.live.start();
    const es = FakeEventSource.latest();
    es.opened();
    es.send("work.changed", "{not json");
    es.send("work.changed", { work_id: 2 });
    expect(h.events).toEqual([["work.changed", { work_id: 2 }]]);
    expect(h.live.state).toBe("live");
  });

  it("every catalogue row has an answer in the PWA's table, and every view it names is one of the shell's", () => {
    const views = new Set(Object.keys(liftViews()));
    for (const row of EVENT_CATALOGUE) {
      const named = viewsFor(row.type, {}, {});
      expect(Array.isArray(named), row.type).toBe(true);
      for (const v of named) expect(views, `${row.type} → ${v}`).toContain(v);
    }
  });

  it("refetches where the catalogue says the client refetches", () => {
    expect(viewsFor("needs_you.changed", { waiting: 2 })).toEqual(["triage"]);
    expect(viewsFor("message.new", { message_id: 1, thread: "main" })).toEqual(["chat"]);
    expect(viewsFor("turn.progress", { turn_id: "t1" })).toEqual(["chat"]);
    expect(viewsFor("work.changed", { work_id: 1 })).toContain("board");
    expect(viewsFor("presence.changed", { agent_id: "a" })).toContain("agents");
    expect(viewsFor("capture.new", { inbox_id: 1 })).toContain("feed");
    expect(viewsFor("vault.reconciled", { changed: 2 })).toEqual(expect.arrayContaining(["today", "knowledge"]));
    expect(viewsFor("budget.state", { scope: "instance" })).toContain("usage");
    expect(viewsFor("connection.health", { connection: "gmail" })).toContain("settings");
  });

  it("a run is the chat's only when it belongs to a turn", () => {
    expect(viewsFor("run.started", { run_id: 1, kind: "turn", turn_id: "t1" })).toContain("chat");
    expect(viewsFor("run.started", { run_id: 1, kind: "routine_run" })).not.toContain("chat");
    expect(viewsFor("run.finished", { run_id: 1, kind: "routine_run" })).toContain("feed");
  });

  it("an artifact's thread refetches only that artifact's threads; a task's thread refetches its room", () => {
    expect(viewsFor("thread.changed", { artifact_id: "art_A" }, { artifact_id: "art_A" })).toEqual(["artifacts"]);
    expect(viewsFor("thread.changed", { artifact_id: "art_B" }, { artifact_id: "art_A" })).toEqual([]);
    expect(viewsFor("thread.changed", { artifact_id: "art_B" }, {})).toEqual([]);
    expect(viewsFor("thread.changed", { work_id: 7 }, {})).toEqual(["rooms"]);
  });

  it("an unknown type refreshes nothing", () => {
    expect(viewsFor("something.new", {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Refetching the views on screen
// ---------------------------------------------------------------------------

describe("the refresher", () => {
  function refresher(o: { visible?: string[]; busy?: Set<string>; hidden?: boolean } = {}) {
    const calls: string[] = [];
    const state = { visible: o.visible ?? ["board"], busy: o.busy ?? new Set<string>(), hidden: o.hidden ?? false };
    const views = ["today", "chat", "triage", "feed", "board", "rooms"];
    const r = createRefresher({
      refreshers: Object.fromEntries(views.map((v) => [v, async () => void calls.push(v)])),
      visible: () => state.visible,
      busy: (v: string) => state.busy.has(v),
      hidden: () => state.hidden,
    });
    return { r, calls, state };
  }
  const settle = async () => { await vi.advanceTimersByTimeAsync(200); };

  it("a burst refetches each view once", async () => {
    const { r, calls } = refresher({ visible: ["board", "triage"] });
    for (let i = 0; i < 5; i++) r.queue(["board", "rooms"]);
    r.queue(["triage"]);
    await settle();
    expect(calls.sort()).toEqual(["board", "triage"]);
  });

  it("only a view on screen refetches; another loads fresh when it opens, so it is not kept", async () => {
    const { r, calls, state } = refresher({ visible: ["chat"] });
    r.queue(["board", "chat"]);
    await settle();
    expect(calls).toEqual(["chat"]);
    state.visible = ["board"];
    r.flush();
    await settle();
    expect(calls).toEqual(["chat"]);
  });

  it("a view the owner is typing in waits, and refetches once they leave it", async () => {
    const { r, calls, state } = refresher({ visible: ["triage"], busy: new Set(["triage"]) });
    r.queue(["triage"]);
    await settle();
    expect(calls).toEqual([]);
    expect(r.pending).toEqual(["triage"]);
    state.busy.clear();
    r.flush();
    await settle();
    expect(calls).toEqual(["triage"]);
  });

  it("nothing refetches behind a hidden page; it does when the page is back", async () => {
    const { r, calls, state } = refresher({ visible: ["feed"], hidden: true });
    r.queue(["feed"]);
    await settle();
    expect(calls).toEqual([]);
    state.hidden = false;
    r.flush();
    await settle();
    expect(calls).toEqual(["feed"]);
  });

  it("a view with no refresher is ignored, and a failing refetch is swallowed", async () => {
    const r = createRefresher({ refreshers: { board: async () => { throw new Error("offline"); } }, visible: () => ["board", "knowledge"] });
    r.queue(["knowledge", "board"]);
    expect(r.pending).toEqual(["board"]);
    await settle();
    expect(r.pending).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The shell's wiring (app.js) and the service worker
// ---------------------------------------------------------------------------

/** Lift a top-level declaration out of app.js by name (as pwa-shell.test.ts does). */
function lift(name: string): string {
  const lines = SRC.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^(?:const|let) ${name}\\b|^(?:async )?function ${name}\\(`).test(l));
  if (start === -1) throw new Error(`app.js no longer declares ${name} — update this test with the rename`);
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
    }
    if (depth <= 0) return lines.slice(start, i + 1).join("\n");
  }
  throw new Error(`could not find the end of ${name} in app.js`);
}

function liftViews(): Record<string, { sections: string[] }> {
  return new Function(`${lift("VIEWS")}\nreturn VIEWS;`)();
}

describe("the shell", () => {
  it("keeps no timer of its own: every poll is registered with the stream, so none runs while it is up", () => {
    expect(SRC).not.toMatch(/\bsetInterval\(/);
    for (const name of ["chat", "needs", "feed", "board"]) expect(SRC).toContain(`live.poll("${name}", `);
  });

  it("every view it refetches on an event is one of its views", () => {
    const views = liftViews();
    const refresh = new Function(`${lift("LIVE_REFRESH")}\nreturn LIVE_REFRESH;`)();
    for (const v of Object.keys(refresh)) expect(views, v).toHaveProperty(v);
  });

  it("the count comes off `needs_you.changed` itself — no fetch — and the Needs You list refetches", () => {
    const body = lift("live");
    expect(body).toMatch(/type === "needs_you\.changed"[\s\S]*setNeeds\(data\.waiting\)/);
    expect(body).toContain("liveRefresher.queue(viewsFor(type, data");
  });

  it("subscribes only when GET /api/identity lists the `events` capability; otherwise polls", async () => {
    for (const [capabilities, stream] of [[["capture", "events"], true], [["capture"], false]] as const) {
      const started: unknown[] = [];
      const polled: string[] = [];
      const goLive = new Function(
        "live", "pollChat", "watchNeeds", "fetch", "EVENTS_CAPABILITY", "signedIn",
        `${lift("goLive")}\nreturn goLive;`,
      )(
        { start: (o: unknown) => started.push(o) },
        () => polled.push("chat"),
        () => polled.push("needs"),
        async (url: string) => ({ ok: url === "/api/identity", json: async () => ({ capabilities }) }),
        EVENTS_CAPABILITY,
        true,
      );
      await goLive();
      expect(polled).toEqual(["chat", "needs"]);
      expect(started).toEqual([{ stream }]);
    }
  });

  it("an unreadable identity is no stream, not no client", async () => {
    const started: unknown[] = [];
    const goLive = new Function("live", "pollChat", "watchNeeds", "fetch", "EVENTS_CAPABILITY", "signedIn", `${lift("goLive")}\nreturn goLive;`)(
      { start: (o: unknown) => started.push(o) }, () => {}, () => {}, async () => { throw new Error("offline"); }, EVENTS_CAPABILITY, true,
    );
    await goLive();
    expect(started).toEqual([{ stream: false }]);
  });

  it("signing in goes live on every path in, and signing out stops it", () => {
    expect(SRC.match(/\bgoLive\(\);/g)?.length).toBe(3); // boot, sign-in, enrolment
    expect(lift("showAuth")).toContain("live.stop();");
  });

  it("the stream's state is on <body data-stream>, for the offline band to follow", () => {
    expect(lift("live")).toContain("document.body.dataset.stream = state");
  });

  it("live.js is DOM-free and imports nothing, so a test loads it as it is", () => {
    const LIVE = read("../web/live.js");
    expect(LIVE).not.toMatch(/\bdocument\.|\bwindow\.|^import /m);
    const r = spawnSync(process.execPath, ["--check", fileURLToPath(new URL("../web/live.js", import.meta.url))], { encoding: "utf8" });
    expect(r.stderr).toBe("");
  });
});

describe("the service worker", () => {
  it("never stands in front of the stream: no fetch handler, or one that lets /api/events through", () => {
    if (/addEventListener\(\s*["']fetch["']/.test(SW)) expect(SW).toMatch(/\/api\/events/);
    else expect(SW).not.toMatch(/onfetch/);
  });
});
