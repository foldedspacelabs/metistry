// Live changes (design-build-plan §2.20, T2-18), without a database: the
// notice parser, the payload guard, the hub's numbering and replay, the
// mapping rules, and the feed's behaviour when its LISTEN drops. The wire —
// the triggers, the gate, the stream over a socket — is
// events.integration.test.ts.
import { describe, expect, it } from "vitest";
import { EVENT_CATALOGUE, EVENT_TYPES, type ClientEvent, type EventType } from "@foldedspacelabs/metistry-core";
import {
  EventHub,
  EventPayloadError,
  RING_SIZE,
  mapBatch,
  newMapperMemory,
  parseNotice,
  payloadRefusal,
  startEventFeed,
  type BatchFacts,
  type ListenClient,
  type Notice,
  type RunFacts,
} from "../src/events.js";

/** One valid payload per type — what the catalogue's payload column says, with real-looking ids. */
const SAMPLE: { [T in EventType]: unknown } = {
  "run.started": { run_id: 9001, kind: "tool", turn_id: "turn-8a1c" },
  "run.finished": { run_id: 9001, kind: "turn" },
  "turn.progress": { turn_id: "turn-8a1c" },
  "message.new": { message_id: 512, thread: "default" },
  "presence.changed": { agent_id: "cursor" },
  "needs_you.changed": { waiting: 3 },
  "work.changed": { work_id: 214 },
  "thread.changed": { artifact_id: "art_01M3FY9WJ7M4N2ZAJFNZBVH8KK" },
  "capture.new": { inbox_id: 77 },
  "vault.reconciled": { changed: 4 },
  "vault.sync": { state: "push" },
  "routine.status": { name: "morning-brief" },
  "sync.status": { name: "github-state" },
  "connection.health": { connection: "github" },
  "config.changed": { file: ".metistry/compute.yaml" },
  "budget.state": { scope: "instance" },
  "release.available": { version: "0.12.0" },
  resync: {},
};

describe("parseNotice — exactly {table, op, id} from a trigger migration 0035 made", () => {
  it("reads a notice", () => {
    expect(parseNotice(`{"table" : "runs", "op" : "insert", "id" : 12}`)).toEqual({ table: "runs", op: "insert", id: 12 });
    expect(parseNotice(`{"table":"agents","op":"update","id":"cursor"}`)).toEqual({ table: "agents", op: "update", id: "cursor" });
    expect(parseNotice(`{"table":"artifact_comments","op":"insert","id":"cmt_01M3FY9WJ7M4N2ZAJFNZBVH8KK"}`)?.id).toBe("cmt_01M3FY9WJ7M4N2ZAJFNZBVH8KK");
  });

  it("refuses anything else", () => {
    for (const bad of [
      undefined,
      "",
      "not json",
      "[]",
      `{"table":"runs","op":"insert"}`,
      `{"table":"runs","op":"insert","id":1,"text":"a body"}`, // a fourth key is not a notice
      `{"table":"passkeys","op":"insert","id":1}`, // not a table with a trigger
      `{"table":"runs","op":"delete","id":1}`,
      `{"table":"runs","op":"insert","id":0}`,
      `{"table":"runs","op":"insert","id":1.5}`,
      `{"table":"agents","op":"insert","id":"has space"}`,
      `{"table":"runs","op":"insert","id":1}`.padEnd(600, " "),
    ]) {
      expect(parseNotice(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("payloadRefusal — ids and counts, never a body", () => {
  it("admits one payload of every catalogue type", () => {
    for (const type of EVENT_TYPES) expect(payloadRefusal(type, SAMPLE[type]), type).toBeUndefined();
    expect(payloadRefusal("thread.changed", { work_id: 214 })).toBeUndefined();
  });

  it("**refuses a payload that is not exactly its type's fields, each an id, a name, a state or a count**", () => {
    const refused: [string, unknown][] = [
      ["work.changed", { work_id: 214, title: "Freeze the store interface" }], // an extra field is a body in waiting
      ["message.new", { message_id: 512, thread: "default", text: "the reply itself" }],
      ["message.new", { message_id: 512, thread: "a sentence\nwith a newline in it" }],
      ["message.new", { message_id: 512, thread: "x".repeat(121) }],
      ["needs_you.changed", { waiting: -1 }],
      ["needs_you.changed", { waiting: 1.5 }],
      ["needs_you.changed", { waiting: "3" }],
      ["work.changed", { work_id: { id: 214 } }],
      ["work.changed", {}],
      ["run.started", { run_id: 1, kind: "Tool call: knowledge_search" }],
      ["turn.progress", { turn_id: "has spaces and punctuation!" }],
      ["presence.changed", { agent_id: "Not A Slug" }],
      ["thread.changed", { work_id: 1, artifact_id: "art_01" }], // one of the two, never both
      ["thread.changed", { comment: "cmt_01" }],
      ["config.changed", { file: "../../etc/passwd" }],
      ["release.available", { version: "the newest one" }],
      ["vault.sync", { state: "exploded" }],
      ["resync", { reason: "anything" }],
      ["work.deleted", { work_id: 1 }], // not a catalogue type
      ["work.changed", null],
      ["work.changed", [214]],
    ];
    for (const [type, data] of refused) expect(payloadRefusal(type, data), `${type} ${JSON.stringify(data)}`).toBeDefined();
  });
});

describe("EventHub — numbering, the replay ring, fan-out", () => {
  const publishN = (hub: EventHub, n: number): ClientEvent[] => Array.from({ length: n }, (_, i) => hub.publish("work.changed", { work_id: i + 1 }));

  it("numbers every event after the id it starts from, increasing", () => {
    const hub = new EventHub({ firstId: 4100 });
    expect(hub.head).toBe("4100");
    const [a, b] = publishN(hub, 2);
    expect([a!.id, b!.id]).toEqual(["4101", "4102"]);
    expect(hub.head).toBe("4102");
  });

  it("starts above every id a console started earlier could have issued", () => {
    let t = 1_790_000_000_000;
    const first = new EventHub({ now: () => t });
    publishN(first, 5);
    t += 1; // one millisecond later, a restart
    const second = new EventHub({ now: () => t });
    expect(Number(second.head)).toBeGreaterThan(Number(first.head));
    // and a client resuming from the first process is told to resync, never replayed the second's events
    publishN(second, 3);
    expect(second.resume(first.head)).toEqual({ resync: true });
  });

  it("**refuses to publish a body** — nothing is numbered and no subscriber hears it", () => {
    const hub = new EventHub({ firstId: 0 });
    const heard: ClientEvent[] = [];
    hub.subscribe((e) => heard.push(e));
    expect(() => hub.publish("message.new", { message_id: 1, thread: "default", text: "the reply" } as never)).toThrow(EventPayloadError);
    expect(hub.head).toBe("0");
    expect(heard).toEqual([]);
  });

  it("**replays exactly the events after Last-Event-ID**, in order", () => {
    const hub = new EventHub({ firstId: 0 });
    const events = publishN(hub, 10);
    const r = hub.resume(events[5]!.id);
    expect("replay" in r && r.replay.map((e) => e.id)).toEqual(events.slice(6).map((e) => e.id));
    expect(hub.resume(events[9]!.id)).toEqual({ replay: [] });
    expect(hub.resume(undefined)).toEqual({ replay: [] });
  });

  it("sends resync when the gap is larger than the ring — the last 1,000 events", () => {
    const hub = new EventHub({ firstId: 0 });
    const events = publishN(hub, RING_SIZE + 5);
    expect(hub.resume(events[3]!.id)).toEqual({ resync: true }); // event 5 is gone
    const r = hub.resume(events[4]!.id); // the oldest kept is event 6: nothing missing
    expect("replay" in r && r.replay.length).toBe(RING_SIZE);
  });

  it("sends resync when the gap is older than ten minutes", () => {
    let t = 1_000_000;
    const hub = new EventHub({ firstId: 0, now: () => t });
    const [old] = publishN(hub, 2);
    t += 10 * 60_000 + 1;
    hub.publish("work.changed", { work_id: 99 });
    expect(hub.resume(old!.id)).toEqual({ resync: true }); // the event after it has aged out
  });

  it("sends resync for an id it could not have issued", () => {
    const hub = new EventHub({ firstId: 100 });
    publishN(hub, 3);
    for (const id of ["104", "99999", "abc", "-1", "1e3", "", " ", "1".repeat(30)]) expect(hub.resume(id), JSON.stringify(id)).toEqual({ resync: true });
  });
});

// ---- the mapping rules ------------------------------------------------------------------

function facts(o: Partial<BatchFacts> = {}): BatchFacts {
  return { runs: new Map(), work: new Map(), outbound: new Map(), comments: new Map(), waiting: null, ...o };
}
function run(o: Partial<RunFacts> & { id: number; kind: string }): RunFacts {
  return { component: "console", ok: null, finished: false, turn_id: null, run_kind: null, release_available: null, scope: null, state: null, connection: null, file: null, files_changed: null, ...o };
}
const runs = (...rs: RunFacts[]) => new Map(rs.map((r) => [r.id, r]));
const n = (table: Notice["table"], op: Notice["op"], id: number | string): Notice => ({ table, op, id });
const types = (es: { type: string }[]) => es.map((e) => e.type);

describe("mapBatch — where every event comes from", () => {
  it("a tool call in a turn: started and progressing, then finished and progressing — each once", () => {
    const memory = newMapperMemory();
    const tool = run({ id: 7, kind: "tool", component: "assistant", turn_id: "turn-1" });
    expect(mapBatch([n("runs", "insert", 7)], facts({ runs: runs(tool) }), memory)).toEqual([
      { type: "run.started", data: { run_id: 7, kind: "tool", turn_id: "turn-1" } },
      { type: "turn.progress", data: { turn_id: "turn-1" } },
    ]);
    const done = { ...tool, ok: true, finished: true };
    expect(mapBatch([n("runs", "update", 7)], facts({ runs: runs(done) }), memory)).toEqual([
      { type: "run.finished", data: { run_id: 7, kind: "tool", turn_id: "turn-1" } },
      { type: "turn.progress", data: { turn_id: "turn-1" } },
    ]);
    // a later touch of a finished row does not finish it again
    expect(mapBatch([n("runs", "update", 7)], facts({ runs: runs(done) }), memory)).toEqual([]);
  });

  it("a burst is one event per subject — the latest payload, in first-said order", () => {
    const out = mapBatch(
      [n("work", "update", 1), n("work", "update", 2), n("work", "update", 1), n("proposals", "insert", 5), n("proposals", "update", 5), n("work", "update", 1)],
      facts({ waiting: 4 }),
      newMapperMemory(),
    );
    expect(out).toEqual([
      { type: "work.changed", data: { work_id: 1 } },
      { type: "work.changed", data: { work_id: 2 } },
      { type: "needs_you.changed", data: { waiting: 4 } },
    ]);
  });

  it("two turns in one burst are two turn.progress — a subject is the whole payload, not the type", () => {
    const rows = [run({ id: 1, kind: "tool", turn_id: "turn-a" }), run({ id: 2, kind: "tool", turn_id: "turn-b" }), run({ id: 3, kind: "tool", turn_id: "turn-a" })];
    const out = mapBatch(rows.map((r) => n("runs", "insert", r.id)), facts({ runs: runs(...rows) }), newMapperMemory());
    expect(out.filter((e) => e.type === "turn.progress")).toEqual([
      { type: "turn.progress", data: { turn_id: "turn-a" } },
      { type: "turn.progress", data: { turn_id: "turn-b" } },
    ]);
    expect(out.filter((e) => e.type === "run.started")).toHaveLength(3);
  });

  it("finishing runs say what they finished: a routine, a sync, a reconcile, a budget, a config write, a vault sync, a release", () => {
    const rows = [
      run({ id: 1, kind: "routine_run", component: "morning-brief", finished: true, ok: true }),
      run({ id: 2, kind: "collector_run", component: "github-state", finished: true, ok: true }),
      run({ id: 3, kind: "collector_run", component: "reconciler", finished: true, ok: true, files_changed: 4 }),
      run({ id: 4, kind: "collector_run", component: "reconciler", finished: true, ok: true, files_changed: 0 }),
      run({ id: 5, kind: "runner", component: "plan-tomorrow", finished: true, ok: false, run_kind: "routine_run" }),
      run({ id: 6, kind: "budget", component: "assistant", finished: true, ok: false, scope: "instance" }),
      run({ id: 7, kind: "config_write", component: "reconciler", finished: true, ok: true, file: ".metistry/identity.yaml" }),
      run({ id: 8, kind: "vault_sync", component: "reconciler", finished: true, ok: true, state: "push" }),
      run({ id: 9, kind: "routine_run", component: "update-check", finished: true, ok: true, release_available: "0.12.0" }),
    ];
    const out = mapBatch(rows.map((r) => n("runs", "update", r.id)), facts({ runs: runs(...rows) }), newMapperMemory()).filter((e) => e.type !== "run.finished");
    expect(out).toEqual([
      { type: "routine.status", data: { name: "morning-brief" } },
      { type: "sync.status", data: { name: "github-state" } },
      { type: "vault.reconciled", data: { changed: 4 } },
      { type: "routine.status", data: { name: "plan-tomorrow" } },
      { type: "budget.state", data: { scope: "instance" } },
      { type: "config.changed", data: { file: ".metistry/identity.yaml" } },
      { type: "vault.sync", data: { state: "push" } },
      { type: "routine.status", data: { name: "update-check" } },
      { type: "release.available", data: { version: "0.12.0" } },
    ]);
  });

  it("release.available comes from the Update Check's own row and nowhere else", () => {
    const forged = [
      run({ id: 1, kind: "routine_run", component: "morning-brief", finished: true, ok: true, release_available: "9.9.9" }),
      run({ id: 2, kind: "tool", component: "update-check", finished: true, ok: true, release_available: "9.9.9" }), // an agent named update-check, calling a tool
      run({ id: 3, kind: "routine_run", component: "update-check", finished: true, ok: true, release_available: "the latest one" }),
    ];
    const out = mapBatch(forged.map((r) => n("runs", "update", r.id)), facts({ runs: runs(...forged) }), newMapperMemory());
    expect(types(out)).not.toContain("release.available");
  });

  it("connection.health on a failure and on a recovery, not on every call", () => {
    const memory = newMapperMemory();
    const call = (id: number, ok: boolean) => mapBatch([n("runs", "update", id)], facts({ runs: runs(run({ id, kind: "connection_call", connection: "github", finished: true, ok })) }), memory);
    const health = (es: { type: string }[]) => es.filter((e) => e.type === "connection.health").length;
    expect(health(call(1, true))).toBe(0); // healthy, as far as anyone knew
    expect(health(call(2, false))).toBe(1); // fails
    expect(health(call(3, false))).toBe(1); // still failing: said again — it is still the thing to look at
    expect(health(call(4, true))).toBe(1); // recovers
    expect(health(call(5, true))).toBe(0);
  });

  it("the rest of the tables: a reply, a claim, a capture, a room and an artifact thread, an agent", () => {
    const out = mapBatch(
      [n("outbound_messages", "insert", 12), n("outbound_messages", "update", 11), n("work", "update", 3), n("inbox", "insert", 40), n("artifact_comments", "insert", "cmt_A"), n("artifact_comments", "insert", "cmt_B"), n("agents", "update", "cursor")],
      facts({
        outbound: new Map([[12, { thread: "default" }]]),
        work: new Map([[3, { claimed_by: "devin" }]]),
        comments: new Map([
          ["cmt_A", { work_id: 3, artifact_id: null }],
          ["cmt_B", { work_id: null, artifact_id: "art_01M3FY9WJ7M4N2ZAJFNZBVH8KK" }],
        ]),
      }),
      newMapperMemory(),
    );
    expect(out).toEqual([
      { type: "message.new", data: { message_id: 12, thread: "default" } }, // the notifier's update of 11 says nothing
      { type: "work.changed", data: { work_id: 3 } },
      { type: "presence.changed", data: { agent_id: "devin" } },
      { type: "capture.new", data: { inbox_id: 40 } },
      { type: "thread.changed", data: { work_id: 3 } },
      { type: "thread.changed", data: { artifact_id: "art_01M3FY9WJ7M4N2ZAJFNZBVH8KK" } },
      { type: "presence.changed", data: { agent_id: "cursor" } },
    ]);
  });

  it("drops a value it cannot vouch for rather than stream it", () => {
    const out = mapBatch(
      [n("runs", "insert", 1), n("runs", "insert", 2)],
      facts({ runs: runs(run({ id: 1, kind: "tool", turn_id: "not a turn id; it is a sentence" }), run({ id: 2, kind: "Not A Kind" })) }),
      newMapperMemory(),
    );
    expect(out).toEqual([{ type: "run.started", data: { run_id: 1, kind: "tool" } }]); // no turn_id, and run 2 not at all
  });

  it("every type in the catalogue but resync has a rule that emits it — and resync is the feed's", () => {
    const rows = [
      run({ id: 1, kind: "tool", turn_id: "t1" }),
      run({ id: 2, kind: "routine_run", component: "update-check", finished: true, ok: true, release_available: "0.12.0" }),
      run({ id: 3, kind: "collector_run", component: "github-state", finished: true, ok: true }),
      run({ id: 4, kind: "collector_run", component: "reconciler", finished: true, ok: true, files_changed: 1 }),
      run({ id: 5, kind: "vault_sync", finished: true, ok: true, state: "commit" }),
      run({ id: 6, kind: "connection_call", connection: "github", finished: true, ok: false }),
      run({ id: 7, kind: "config_write", finished: true, ok: true, file: ".metistry/compute.yaml" }),
      run({ id: 8, kind: "budget", finished: true, ok: false, scope: "openrouter" }),
    ];
    const out = mapBatch(
      [...rows.map((r) => n("runs", "insert", r.id)), n("proposals", "insert", 1), n("work", "insert", 1), n("inbox", "insert", 1), n("artifact_comments", "insert", "cmt_A"), n("outbound_messages", "insert", 1), n("agents", "insert", "cursor")],
      facts({ runs: runs(...rows), waiting: 1, outbound: new Map([[1, { thread: "default" }]]), comments: new Map([["cmt_A", { work_id: 1, artifact_id: null }]]) }),
      newMapperMemory(),
    );
    for (const e of out) expect(payloadRefusal(e.type, e.data), e.type).toBeUndefined();
    expect(new Set(types(out))).toEqual(new Set(EVENT_CATALOGUE.map((e) => e.type).filter((t) => t !== "resync")));
  });
});

// ---- the feed, against a fake connection ----------------------------------------------

class FakeListen implements ListenClient {
  listeners: Record<string, ((...a: any[]) => void)[]> = {};
  queries: string[] = [];
  released = false;
  constructor(private readonly failListen = false) {}
  async query(text: string): Promise<unknown> {
    this.queries.push(text);
    if (this.failListen && text.startsWith("LISTEN")) throw new Error("connection refused");
    return {};
  }
  on(event: string, fn: (...a: any[]) => void): this {
    (this.listeners[event] ??= []).push(fn);
    return this;
  }
  emit(event: string, ...a: unknown[]): void {
    for (const fn of this.listeners[event] ?? []) fn(...a);
  }
  release(): void {
    this.released = true;
  }
  notify(payload: object): void {
    this.emit("notification", { channel: "metistry_events", payload: JSON.stringify(payload) });
  }
}

const noDb = { query: async () => ({ rows: [] }) };
const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("startEventFeed — one LISTEN, batched, and honest about gaps", () => {
  it("gathers a burst into one batch and publishes it", async () => {
    const hub = new EventHub({ firstId: 0 });
    const c = new FakeListen();
    const feed = startEventFeed({ hub, db: noDb, connect: async () => c, coalesceMs: 20, log: () => undefined });
    await feed.ready;
    expect(c.queries).toContain("LISTEN metistry_events");
    for (let i = 0; i < 5; i++) c.notify({ table: "work", op: "update", id: 7 });
    c.notify({ table: "inbox", op: "insert", id: 3 });
    c.emit("notification", { channel: "someone_else", payload: `{"table":"work","op":"update","id":8}` }); // not ours
    c.notify({ table: "work", op: "update", id: 9, text: "a body" }); // not a notice
    await until(() => hub.head === "2");
    const r = hub.resume("0");
    expect("replay" in r && r.replay.map((e) => [e.type, e.data])).toEqual([
      ["work.changed", { work_id: 7 }],
      ["capture.new", { inbox_id: 3 }],
    ]);
    await feed.stop();
  });

  it("re-establishes a dropped LISTEN and tells every subscriber to resync — what was said meanwhile is gone", async () => {
    const hub = new EventHub({ firstId: 0 });
    const heard: string[] = [];
    hub.subscribe((e) => heard.push(e.type));
    const clients = [new FakeListen(true), new FakeListen(), new FakeListen()];
    let i = 0;
    const logs: string[] = [];
    const feed = startEventFeed({ hub, db: noDb, connect: async () => clients[i++]!, coalesceMs: 5, log: (l) => logs.push(l) });
    await feed.ready; // the first attempt failed; the second listened
    expect(clients[0]!.released).toBe(true);
    expect(heard).toEqual(["resync"]); // it could not LISTEN for a while: say so
    clients[1]!.emit("error", new Error("terminating connection due to administrator command"));
    await until(() => heard.length === 2, 5000);
    expect(heard).toEqual(["resync", "resync"]);
    expect(clients[1]!.released).toBe(true);
    expect(logs.some((l) => l.includes("administrator command"))).toBe(true);
    await feed.stop();
  });

  it("a batch whose lookups fail is a resync, not silence", async () => {
    const hub = new EventHub({ firstId: 0 });
    const c = new FakeListen();
    const feed = startEventFeed({ hub, db: { query: async () => Promise.reject(new Error("db down")) }, connect: async () => c, coalesceMs: 5, log: () => undefined });
    await feed.ready;
    c.notify({ table: "runs", op: "insert", id: 1 });
    await until(() => hub.head === "1");
    const r = hub.resume("0");
    expect("replay" in r && r.replay.map((e) => e.type)).toEqual(["resync"]);
    await feed.stop();
  });
});
