// Live changes — `GET /api/events` (design-build-plan §2.20, T2-18). The
// server tells the client WHAT changed, as ids; the client refetches the thing
// itself through the route that already decides who may read it.
//
// Five pieces, each small enough to hold in one reading:
//
//   * **The notice.** Migration 0035 puts one trigger on each of seven tables
//     and `pg_notify('metistry_events', {table, op, id})` — never a column
//     value. `parseNotice` reads one and refuses anything else.
//   * **The mapper.** Notices are gathered for 250 ms (a burst — a collector's
//     upsert of forty rows, a reconcile pass — is one batch), looked up in ONE
//     query per table, and turned into typed events from the catalogue
//     (`packages/core/src/events.ts`). Inside a batch each event is emitted
//     once per (type, what it is about): forty `work.changed` for one row are
//     one. `mapBatch` is where every "where does this event come from" rule
//     lives, and it is pure: rows in, events out.
//   * **The hub.** Numbers each event, keeps the last 1,000 of them (or ten
//     minutes, whichever is fewer) for `Last-Event-ID` replay, and fans them
//     out. `publish` REFUSES a payload that is not ids and counts
//     (`payloadRefusal`): the stream is incapable of carrying a body, rather
//     than asked not to.
//   * **The feed.** One `LISTEN` on a dedicated connection, re-established
//     with backoff when it drops — and a `resync` published when it comes
//     back, because notices sent while nobody listened are gone.
//   * **The snooze poll** (ruling 17, X-17). A snooze ending is `snoozed_until
//     <= now()` becoming true with no row written, so no trigger ever fires
//     for it — the one change to `needs_you.changed`'s count that the LISTEN
//     cannot see. Every `SNOOZE_POLL_MS` the feed re-asks the same count by
//     hand and says so only when it moved since the last time either this or
//     a batch asked (`pollWaiting`, sharing `mapBatch`'s `memory.waiting`).
//
// **Why ids never bodies.** The stream opens no new read path (invariant 3):
// every event says what to refetch and the refetch passes the route's own
// gate. So the stream can leak nothing the routes would not, and a count "is
// not a body" (§2.20).
//
// **Ids across restarts.** An event id is a decimal integer, increasing,
// starting at `Date.now() × 1000` when the console starts — so a new process
// begins above every id the last one issued, a client resuming with an id
// from before the restart is always behind this process's first event, and
// it gets `resync` rather than a replay of unrelated events. (The one way
// round it is a wall clock moved back by more than the old process's uptime;
// then the worst case is a replay the client did not need.)

import type { IncomingMessage, ServerResponse } from "node:http";
import { VAULT_SYNC_STATES, intEnv, isEventType, type ClientEvent, type EventPayloads, type EventType } from "@foldedspacelabs/metistry-core";
import { sendError } from "./http-util.js";

/** The one channel the triggers notify on (migration 0035). */
export const EVENTS_CHANNEL = "metistry_events";

/** The seven tables with a `metistry_notify` trigger — the only tables a notice may name. */
export const NOTIFY_TABLES = ["runs", "proposals", "work", "inbox", "artifact_comments", "outbound_messages", "agents"] as const;
export type NotifyTable = (typeof NOTIFY_TABLES)[number];

/** §2.20: the replay buffer holds the last 1,000 events… */
export const RING_SIZE = 1000;
/** …or the last ten minutes of them, whichever is fewer. */
export const RING_AGE_MS = 10 * 60_000; // limit: fixed — §2.20's replay window; a longer one is a resync, which is always correct
/** §2.20: a burst is gathered this long before it is mapped and emitted. */
export const COALESCE_MS = 250;
/** A comment line this often keeps proxies from closing an idle stream, and re-checks the credential (`stillAllowed`). */
export const DEFAULT_HEARTBEAT_MS = 20_000;
/** Open streams the console holds at once. §2.20 expects one per app; the rest is room for a phone and a browser tab or two. */
export const DEFAULT_MAX_STREAMS = 32;
/** A subscriber whose unsent frames pass this is too slow to keep: the stream is ended and the client resumes with `Last-Event-ID`. */
export const MAX_BUFFERED_BYTES = 256 * 1024; // limit: fixed — frames are ids, so this is thousands of them; a client that far behind is gone, not slow
/** What a browser's `EventSource` waits before reconnecting (the SSE `retry:` field). */
export const RETRY_MS = 3000; // limit: fixed — a browser's own default is about this; the replay makes the wait cost nothing
/**
 * How often the feed re-checks the Needs You count on its own (ruling 17,
 * X-17). A snooze ending writes no row — `snoozed_until` is compared against
 * `now()`, not set by anything — so nothing notifies Postgres and the trigger
 * path says nothing. This is the only way that moment is ever seen; every
 * other way `waiting` changes (raised, decided, put down with `later`) is a
 * write the trigger already catches, well inside one tick of this.
 */
export const SNOOZE_POLL_MS = 30_000; // limit: fixed — a snooze is counted in hours; this is coarse on purpose

/** The reconciler's own component name on its runs rows (apps/reconciler/src/indexer.ts): its reconcile pass is not a sync. */
export const RECONCILER_COMPONENT = "reconciler";
/** The Update Check routine (routines/update-check/): its own run row carries `meta.release_available`. */
export const UPDATE_CHECK_COMPONENT = "update-check";

// ---------------------------------------------------------------------------
// The notice
// ---------------------------------------------------------------------------

export interface Notice {
  readonly table: NotifyTable;
  readonly op: "insert" | "update";
  /** A `bigint` key as a number, or a text key (`agents.id`, `artifact_comments.id`). */
  readonly id: number | string;
}

const TEXT_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** One notice off the channel, or undefined for anything that is not exactly `{table, op, id}` from a trigger this migration made. */
export function parseNotice(payload: string | undefined): Notice | undefined {
  if (payload === undefined || payload.length > 512) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== 3) return undefined;
  if (typeof o.table !== "string" || !(NOTIFY_TABLES as readonly string[]).includes(o.table)) return undefined;
  if (o.op !== "insert" && o.op !== "update") return undefined;
  const id = o.id;
  if (typeof id === "number") {
    if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  } else if (typeof id !== "string" || !TEXT_KEY.test(id)) {
    return undefined;
  }
  return { table: o.table as NotifyTable, op: o.op, id };
}

// ---------------------------------------------------------------------------
// Ids and counts only — the payload guard
// ---------------------------------------------------------------------------

type FieldKind = "count" | "rowid" | "kind" | "turn" | "agent" | "artifact" | "thread" | "name" | "version" | "path" | "scope" | "sync_state";

/** What each kind of field may hold. Every one is an identifier, a name, a state token or a non-negative integer — none can hold prose. */
const FIELD_OK: Record<FieldKind, (v: unknown) => boolean> = {
  count: (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
  rowid: (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0,
  kind: (v) => typeof v === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(v),
  turn: (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v), // mcp-brain's validTurnId
  agent: (v) => typeof v === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(v), // agents.id's CHECK
  artifact: (v) => typeof v === "string" && /^art_[0-9A-Z]{1,40}$/.test(v),
  // a conversation key: the client names it (`default`, `fold`, a handle), so it is an id of the owner's choosing — bounded, one line
  thread: (v) => typeof v === "string" && /^[^\u0000-\u001f\u007f]{1,120}$/.test(v),
  name: (v) => typeof v === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v), // a manifest's name
  version: (v) => typeof v === "string" && /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/.test(v),
  path: (v) => typeof v === "string" && /^[A-Za-z0-9._ /-]{1,200}$/.test(v) && !v.split("/").includes(".."),
  scope: (v) => typeof v === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(v),
  sync_state: (v) => typeof v === "string" && (VAULT_SYNC_STATES as readonly string[]).includes(v),
};

/** Each type's fields — required, then optional — exactly as the catalogue writes them. `thread.changed` is one of two shapes and is checked by hand. */
const SHAPES: Record<Exclude<EventType, "thread.changed">, { required: Record<string, FieldKind>; optional?: Record<string, FieldKind> }> = {
  "run.started": { required: { run_id: "rowid", kind: "kind" }, optional: { turn_id: "turn" } },
  "run.finished": { required: { run_id: "rowid", kind: "kind" }, optional: { turn_id: "turn" } },
  "turn.progress": { required: { turn_id: "turn" } },
  "message.new": { required: { message_id: "rowid", thread: "thread" } },
  "presence.changed": { required: { agent_id: "agent" } },
  "needs_you.changed": { required: { waiting: "count" } },
  "work.changed": { required: { work_id: "rowid" } },
  "capture.new": { required: { inbox_id: "rowid" } },
  "vault.reconciled": { required: { changed: "count" } },
  "vault.sync": { required: { state: "sync_state" } },
  "routine.status": { required: { name: "name" } },
  "sync.status": { required: { name: "name" } },
  "connection.health": { required: { connection: "name" } },
  "config.changed": { required: { file: "path" } },
  "budget.state": { required: { scope: "scope" } },
  "release.available": { required: { version: "version" } },
  resync: { required: {} },
};

/**
 * Why a payload may not be streamed, or undefined when it may. A payload is
 * a plain object whose keys are EXACTLY its type's fields and whose values
 * are ids, names, state tokens or counts — so an extra key, a row, a string
 * that is a sentence, or a nested object is refused, whatever put it there.
 */
export function payloadRefusal(type: string, data: unknown): string | undefined {
  if (!isEventType(type)) return `${JSON.stringify(type)} is not a catalogue type`;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return `${type}: the payload is not an object`;
  const d = data as Record<string, unknown>;
  const keys = Object.keys(d);
  if (type === "thread.changed") {
    if (keys.length !== 1) return "thread.changed carries exactly one of work_id, artifact_id";
    if (keys[0] === "work_id") return FIELD_OK.rowid(d.work_id) ? undefined : "thread.changed: work_id is not a row id";
    if (keys[0] === "artifact_id") return FIELD_OK.artifact(d.artifact_id) ? undefined : "thread.changed: artifact_id is not an artifact id";
    return `thread.changed: ${keys[0]} is not one of its fields`;
  }
  const shape = SHAPES[type];
  for (const k of keys) {
    const kind = shape.required[k] ?? shape.optional?.[k];
    if (kind === undefined) return `${type}: ${k} is not one of its fields`;
    if (!FIELD_OK[kind](d[k])) return `${type}: ${k} is not ${kind === "count" ? "a count" : kind === "rowid" ? "a row id" : `an id of kind ${kind}`}`;
  }
  for (const k of Object.keys(shape.required)) if (!(k in d)) return `${type}: ${k} is missing`;
  return undefined;
}

/** Thrown by `EventHub.publish` for a payload `payloadRefusal` refuses: the hub cannot be made to stream a body. */
export class EventPayloadError extends Error {
  override readonly name = "EventPayloadError";
}

// ---------------------------------------------------------------------------
// The hub: numbering, the replay ring, fan-out, and the SSE response
// ---------------------------------------------------------------------------

export interface HubOptions {
  /** The id the first event follows. Default `Date.now() × 1000` — see "Ids across restarts" above. Tests and the fixture recorder pin it. */
  firstId?: number;
  ringSize?: number;
  ringAgeMs?: number;
  heartbeatMs?: number;
  maxStreams?: number;
  now?: () => number;
}

/** What a subscriber resuming from an id is owed: the events after it, or `resync` because some are gone. */
export type Resume = { readonly replay: readonly ClientEvent[] } | { readonly resync: true };

interface Stamped {
  readonly seq: number;
  readonly at: number;
  readonly event: ClientEvent;
}

type Subscriber = (e: ClientEvent) => void;

export interface ServeOptions {
  /** The request's `Last-Event-ID`, if it sent one. */
  lastEventId?: string | undefined;
  /** Asked at every heartbeat: false ends the stream, so a revoked session stops hearing within one. */
  stillAllowed?: (() => Promise<boolean>) | undefined;
}

/** One SSE frame. `data` is one line of JSON — ids and counts, so never a newline to escape. */
export function frame(e: ClientEvent): string {
  return `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

export class EventHub {
  private last: number;
  private readonly ring: Stamped[] = [];
  private readonly subs = new Set<Subscriber>();
  private readonly closers = new Set<() => void>();
  private readonly now: () => number;
  readonly ringSize: number;
  readonly ringAgeMs: number;
  readonly heartbeatMs: number;
  readonly maxStreams: number;

  constructor(o: HubOptions = {}) {
    this.now = o.now ?? Date.now;
    this.last = o.firstId ?? this.now() * 1000;
    if (!Number.isSafeInteger(this.last) || this.last < 0) throw new Error(`firstId must be a non-negative safe integer, got ${this.last}`);
    this.ringSize = o.ringSize ?? RING_SIZE;
    this.ringAgeMs = o.ringAgeMs ?? RING_AGE_MS;
    this.heartbeatMs = o.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.maxStreams = o.maxStreams ?? DEFAULT_MAX_STREAMS;
  }

  /** The newest id issued — or, before any, the id the first will follow. */
  get head(): string {
    return String(this.last);
  }

  /** Open streams right now. */
  get streams(): number {
    return this.subs.size;
  }

  /** Number, remember and fan out one event. Throws `EventPayloadError` for a payload that is not ids and counts — nothing is numbered or sent. */
  publish<T extends EventType>(type: T, data: EventPayloads[T]): ClientEvent<T> {
    const refusal = payloadRefusal(type, data);
    if (refusal !== undefined) throw new EventPayloadError(refusal);
    const seq = ++this.last;
    const event = Object.freeze({ id: String(seq), type, data: Object.freeze({ ...data }) }) as ClientEvent<T>;
    this.ring.push({ seq, at: this.now(), event });
    this.prune();
    for (const s of this.subs) s(event);
    return event;
  }

  private prune(): void {
    const floor = this.now() - this.ringAgeMs;
    let drop = Math.max(0, this.ring.length - this.ringSize);
    while (drop < this.ring.length && this.ring[drop]!.at < floor) drop++;
    if (drop > 0) this.ring.splice(0, drop);
  }

  /**
   * What a client that last saw `lastEventId` is owed. Nothing missed → an
   * empty replay; every missed event still held → exactly those, in order;
   * any of them gone (older than the ring, from before this process
   * started, from the future, or not an id this console mints) → `resync`.
   */
  resume(lastEventId: string | undefined): Resume {
    if (lastEventId === undefined) return { replay: [] };
    const trimmed = lastEventId.trim();
    if (!/^\d{1,17}$/.test(trimmed)) return { resync: true };
    const seen = Number(trimmed);
    if (!Number.isSafeInteger(seen)) return { resync: true };
    if (seen > this.last) return { resync: true };
    if (seen === this.last) return { replay: [] };
    this.prune();
    const oldest = this.ring[0]?.seq ?? this.last + 1;
    if (seen + 1 < oldest) return { resync: true };
    return { replay: this.ring.filter((s) => s.seq > seen).map((s) => s.event) };
  }

  /** Every event from now on, until the returned function is called. Synchronous with `resume`, so nothing falls between the replay and the live stream. */
  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }

  /** End every open stream (a shutdown, a test's teardown). */
  closeAll(): void {
    for (const close of [...this.closers]) close();
  }

  /**
   * Answer `GET /api/events`: `text/event-stream`, the replay or `resync`
   * this subscriber is owed, then live frames and a heartbeat comment until
   * the client goes, the credential stops being good, or it falls too far
   * behind. The caller has already passed the owner gate.
   */
  serve(req: IncomingMessage, res: ServerResponse, o: ServeOptions = {}): void {
    if (this.subs.size >= this.maxStreams) {
      return sendError(
        res,
        "rate_limited",
        `this console already holds ${this.subs.size} open event streams (METISTRY_EVENTS_MAX_STREAMS = ${this.maxStreams}) — one per app is the design (docs/ops/client-api.md "Live changes"); close another, or poll with since cursors until one ends`,
      );
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // a buffering proxy in front would hold frames back
    });

    let open = true;
    let beat: NodeJS.Timeout | undefined;
    let unsubscribe = (): void => undefined;
    const end = (drop = false): void => {
      if (!open) return;
      open = false;
      if (beat) clearInterval(beat);
      unsubscribe();
      this.closers.delete(end);
      if (drop) res.destroy();
      else res.end();
    };
    const write = (text: string): void => {
      if (!open) return;
      res.write(text);
      // too far behind to keep: drop it rather than buffer for it; the client
      // resumes with the last id it has and gets a replay or a resync
      if (res.writableLength > MAX_BUFFERED_BYTES) end(true);
    };
    this.closers.add(end);
    req.on("close", () => end());
    res.on("close", () => end());
    res.on("error", () => end(true));

    // resume and subscribe in one synchronous step: an event published in between would be neither replayed nor sent
    const resumed = this.resume(o.lastEventId);
    unsubscribe = this.subscribe((e) => write(frame(e)));

    write(`retry: ${RETRY_MS}\n\n`);
    if ("resync" in resumed) {
      // numbered at the head: a resubscribe after refetching everything resumes from here
      write(`id: ${this.head}\nevent: resync\ndata: {}\n\n`);
    } else if (o.lastEventId === undefined) {
      // an id with no data sets the client's Last-Event-ID without dispatching an event (WHATWG SSE), so a
      // client that hears nothing before a reconnect still resumes from here rather than from nothing
      write(`id: ${this.head}\n\n`);
    } else {
      for (const e of resumed.replay) write(frame(e));
    }

    let checking = false;
    beat = setInterval(() => {
      write(": heartbeat\n\n");
      if (!o.stillAllowed || checking) return;
      checking = true;
      o.stillAllowed()
        .then((ok) => {
          if (!ok) end();
        })
        .catch(() => end())
        .finally(() => {
          checking = false;
        });
    }, this.heartbeatMs);
    beat.unref?.();
  }
}

// ---------------------------------------------------------------------------
// The mapper: a batch of notices → typed events
// ---------------------------------------------------------------------------

/** What a query answers — pg's shape, and the console's `Db`. */
export interface EventsDb {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** The runs row, reduced to what a mapping rule reads. No text column, no meta but the named keys. */
export interface RunFacts {
  id: number;
  kind: string;
  component: string;
  ok: boolean | null;
  finished: boolean;
  turn_id: string | null;
  run_kind: string | null;
  release_available: string | null;
  scope: string | null;
  state: string | null;
  connection: string | null;
  file: string | null;
  /** The reconciler's pass: files added + changed + renamed + removed. */
  files_changed: number | null;
}

/** Everything the lookups found for one batch — the input `mapBatch` turns into events. */
export interface BatchFacts {
  runs: Map<number, RunFacts>;
  work: Map<number, { claimed_by: string | null }>;
  outbound: Map<number, { thread: string }>;
  comments: Map<string, { work_id: number | null; artifact_id: string | null }>;
  /** Pending, un-snoozed requests — asked once per batch, only when a proposal moved. */
  waiting: number | null;
}

/** State the mapper keeps between batches so each thing is said once. */
export interface MapperMemory {
  /** Runs whose finish has been announced — a finish is said once however many notices a row gets after it. */
  finished: Set<number>;
  /** Each connection's last outcome: `connection.health` is for a failure or a recovery, not every call. */
  connectionOk: Map<string, boolean>;
  /**
   * The last `waiting` count said, by any means — a batch or the snooze poll
   * (below). `null` until the first one takes: neither says anything from a
   * baseline it never had.
   */
  waiting: number | null;
}

export function newMapperMemory(): MapperMemory {
  return { finished: new Set(), connectionOk: new Map(), waiting: null };
}

const FINISHED_MEMORY = 4096; // limit: fixed — only to stop a duplicate run.finished from a late second notice; older ids cannot recur
/** The runs kinds a connection reports its health through (§2.6: every call writes `connection_call`). */
const CONNECTION_KINDS = new Set(["connection_call", "connection_check"]);

type Emit = { [T in EventType]: { type: T; data: EventPayloads[T] } }[EventType];

/** One (type, subject) is one event per batch: the key that says what an event is about. */
function subjectOf(e: Emit): string {
  switch (e.type) {
    case "needs_you.changed":
    case "vault.reconciled":
    case "resync":
      return e.type; // the latest count is the only one worth sending
    case "run.started":
    case "run.finished":
      return `${e.type}:${e.data.run_id}`; // a run is its id; its kind and turn ride along
    default:
      return `${e.type}:${JSON.stringify(e.data)}`; // every other payload is nothing but what it is about
  }
}

/**
 * Where every event comes from — the rules, in one place:
 *
 *   runs            insert → `run.started`; finished (once) → `run.finished`;
 *                   a row with `meta.turn_id` → `turn.progress` at both ends
 *                   (a tool call in a turn starting and ending); and, when a
 *                   row finishes, by its kind:
 *                     routine_run            → `routine.status {name: component}`
 *                                              (+ `release.available` for the
 *                                              Update Check's `meta.release_available`)
 *                     collector_run          → `sync.status {name}`, except the
 *                                              reconciler's pass → `vault.reconciled`
 *                                              when it changed any file
 *                     runner (preflight/skip) → the status of the routine or
 *                                              sync it is about (`meta.run_kind`)
 *                     budget                 → `budget.state {scope: meta.scope}`
 *                     config_write           → `config.changed {file: meta.path}`
 *                     vault_sync             → `vault.sync {state: meta.state}`
 *                     connection_call/_check → `connection.health` when it fails
 *                                              or recovers (`meta.connection`)
 *   proposals       any change → `needs_you.changed {waiting}` (a count)
 *   work            any change → `work.changed`; a row claimed by an agent →
 *                   `presence.changed` too (a claim, a lease)
 *   inbox           any change → `capture.new` (it landed, or was classified)
 *   artifact_comments any change → `thread.changed` for its task or artifact
 *   outbound_messages insert → `message.new` (an update — `notified_at`, from an older console — is not news)
 *   agents          any change the trigger lets through → `presence.changed`
 *
 * Pure: the notices and what the lookups found go in, events come out, and
 * `memory` is the only thing it changes.
 */
export function mapBatch(notices: readonly Notice[], facts: BatchFacts, memory: MapperMemory): Emit[] {
  const out: Emit[] = [];
  const push = (e: Emit) => out.push(e);
  let proposalsMoved = false;

  for (const n of notices) {
    switch (n.table) {
      case "runs": {
        const r = facts.runs.get(Number(n.id));
        if (!r) break;
        const turn = r.turn_id !== null && FIELD_OK.turn(r.turn_id) ? r.turn_id : undefined;
        const kind = FIELD_OK.kind(r.kind) ? r.kind : undefined;
        if (kind === undefined) break; // a kind no client could render is not a run the stream can describe
        const run = { run_id: r.id, kind, ...(turn ? { turn_id: turn } : {}) };
        if (n.op === "insert") {
          push({ type: "run.started", data: run });
          if (turn) push({ type: "turn.progress", data: { turn_id: turn } });
        }
        if (r.finished && !memory.finished.has(r.id)) {
          memory.finished.add(r.id);
          if (memory.finished.size > FINISHED_MEMORY) memory.finished.delete(memory.finished.values().next().value as number);
          push({ type: "run.finished", data: run });
          if (turn) push({ type: "turn.progress", data: { turn_id: turn } });
          for (const e of finishedRunEvents(r, memory)) push(e);
        }
        break;
      }
      case "proposals":
        proposalsMoved = true;
        break;
      case "work": {
        const id = Number(n.id);
        push({ type: "work.changed", data: { work_id: id } });
        const claimedBy = facts.work.get(id)?.claimed_by;
        if (claimedBy && FIELD_OK.agent(claimedBy)) push({ type: "presence.changed", data: { agent_id: claimedBy } });
        break;
      }
      case "inbox":
        push({ type: "capture.new", data: { inbox_id: Number(n.id) } });
        break;
      case "artifact_comments": {
        const c = facts.comments.get(String(n.id));
        if (c?.work_id) push({ type: "thread.changed", data: { work_id: c.work_id } });
        else if (c?.artifact_id) push({ type: "thread.changed", data: { artifact_id: c.artifact_id } });
        break;
      }
      case "outbound_messages": {
        if (n.op !== "insert") break;
        const m = facts.outbound.get(Number(n.id));
        if (m) push({ type: "message.new", data: { message_id: Number(n.id), thread: m.thread } });
        break;
      }
      case "agents":
        push({ type: "presence.changed", data: { agent_id: String(n.id) } });
        break;
    }
  }
  if (proposalsMoved && facts.waiting !== null) {
    push({ type: "needs_you.changed", data: { waiting: facts.waiting } });
    memory.waiting = facts.waiting; // the snooze poll's baseline moves with every batch that already said this — never a duplicate right behind one
  }

  // one per (type, subject), the latest payload, in the order each was first said
  const seen = new Map<string, number>();
  const deduped: Emit[] = [];
  for (const e of out) {
    const key = subjectOf(e);
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, deduped.length);
      deduped.push(e);
    } else {
      deduped[at] = e;
    }
  }
  return deduped;
}

/** The kind-specific events a runs row says when it finishes. */
function finishedRunEvents(r: RunFacts, memory: MapperMemory): Emit[] {
  const out: Emit[] = [];
  const name = FIELD_OK.name(r.component) ? r.component : undefined;
  const statusOf = (runKind: string | null): Emit | undefined =>
    name === undefined ? undefined : runKind === "routine_run" ? { type: "routine.status", data: { name } } : runKind === "collector_run" ? { type: "sync.status", data: { name } } : undefined;

  if (r.kind === "routine_run") {
    const s = statusOf("routine_run");
    if (s) out.push(s);
    if (r.component === UPDATE_CHECK_COMPONENT && r.release_available !== null && FIELD_OK.version(r.release_available)) {
      out.push({ type: "release.available", data: { version: r.release_available } });
    }
  } else if (r.kind === "collector_run") {
    if (r.component === RECONCILER_COMPONENT) {
      if (r.files_changed !== null && r.files_changed > 0) out.push({ type: "vault.reconciled", data: { changed: r.files_changed } });
    } else {
      const s = statusOf("collector_run");
      if (s) out.push(s);
    }
  } else if (r.kind === "runner") {
    const s = statusOf(r.run_kind);
    if (s) out.push(s);
  } else if (r.kind === "budget") {
    if (r.scope !== null && FIELD_OK.scope(r.scope)) out.push({ type: "budget.state", data: { scope: r.scope } });
  } else if (r.kind === "config_write") {
    if (r.file !== null && FIELD_OK.path(r.file)) out.push({ type: "config.changed", data: { file: r.file } });
  } else if (r.kind === "vault_sync") {
    if (r.state !== null && FIELD_OK.sync_state(r.state)) out.push({ type: "vault.sync", data: { state: r.state as (typeof VAULT_SYNC_STATES)[number] } });
  } else if (CONNECTION_KINDS.has(r.kind)) {
    if (r.connection !== null && FIELD_OK.name(r.connection)) {
      const ok = r.ok === true;
      const before = memory.connectionOk.get(r.connection);
      memory.connectionOk.set(r.connection, ok);
      if (!ok || before === false) out.push({ type: "connection.health", data: { connection: r.connection } });
    }
  }
  return out;
}

// ---- the lookups: one query per table per batch, and only the columns a rule reads ----

const RUNS_SQL = `
  SELECT id, kind, component, ok, finished_at IS NOT NULL AS finished,
         meta->>'turn_id' AS turn_id, meta->>'run_kind' AS run_kind,
         meta->>'release_available' AS release_available,
         meta->>'scope' AS scope, meta->>'state' AS state, meta->>'connection' AS connection,
         coalesce(meta->>'path', meta->>'file') AS file,
         CASE WHEN kind = 'collector_run' AND component = $2 THEN
           (SELECT coalesce(sum(CASE WHEN jsonb_typeof(meta->k) = 'number' THEN (meta->>k)::numeric ELSE 0 END), 0)::bigint
              FROM unnest(ARRAY['added', 'changed', 'renamed', 'removed']) AS k)
         END AS files_changed
  FROM runs WHERE id = ANY($1::bigint[])`;
const WORK_SQL = `SELECT id, claimed_by FROM work WHERE id = ANY($1::bigint[])`;
const OUTBOUND_SQL = `SELECT id, thread FROM outbound_messages WHERE id = ANY($1::bigint[])`;
const COMMENTS_SQL = `SELECT id, work_id, artifact_id FROM artifact_comments WHERE id = ANY($1::text[])`;
/** The Needs You count: what `GET /api/proposals` lists without a cursor — pending, and not put down until later. */
const WAITING_SQL = `SELECT count(*)::int AS waiting FROM proposals WHERE decision = 'pending' AND (snoozed_until IS NULL OR snoozed_until <= now())`;

const ids = (notices: readonly Notice[], table: NotifyTable, op?: Notice["op"]): number[] => [
  ...new Set(notices.filter((n) => n.table === table && (op === undefined || n.op === op)).map((n) => Number(n.id))),
];

/** Look up what `mapBatch` needs for these notices: at most five queries, whatever the batch's size. */
export async function lookupBatch(db: EventsDb, notices: readonly Notice[]): Promise<BatchFacts> {
  const facts: BatchFacts = { runs: new Map(), work: new Map(), outbound: new Map(), comments: new Map(), waiting: null };
  const runIds = ids(notices, "runs");
  const workIds = ids(notices, "work");
  const outboundIds = ids(notices, "outbound_messages", "insert");
  const commentIds = [...new Set(notices.filter((n) => n.table === "artifact_comments").map((n) => String(n.id)))];
  const proposals = notices.some((n) => n.table === "proposals");
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  await Promise.all([
    runIds.length > 0 &&
      db.query(RUNS_SQL, [runIds, RECONCILER_COMPONENT]).then(({ rows }) => {
        for (const r of rows) {
          facts.runs.set(Number(r.id), {
            id: Number(r.id),
            kind: String(r.kind),
            component: String(r.component),
            ok: r.ok === null || r.ok === undefined ? null : Boolean(r.ok),
            finished: Boolean(r.finished),
            turn_id: r.turn_id ?? null,
            run_kind: r.run_kind ?? null,
            release_available: r.release_available ?? null,
            scope: r.scope ?? null,
            state: r.state ?? null,
            connection: r.connection ?? null,
            file: r.file ?? null,
            files_changed: num(r.files_changed),
          });
        }
      }),
    workIds.length > 0 &&
      db.query(WORK_SQL, [workIds]).then(({ rows }) => {
        for (const r of rows) facts.work.set(Number(r.id), { claimed_by: r.claimed_by ?? null });
      }),
    outboundIds.length > 0 &&
      db.query(OUTBOUND_SQL, [outboundIds]).then(({ rows }) => {
        for (const r of rows) facts.outbound.set(Number(r.id), { thread: String(r.thread) });
      }),
    commentIds.length > 0 &&
      db.query(COMMENTS_SQL, [commentIds]).then(({ rows }) => {
        for (const r of rows) facts.comments.set(String(r.id), { work_id: num(r.work_id), artifact_id: r.artifact_id ?? null });
      }),
    proposals &&
      db.query(WAITING_SQL).then(({ rows }) => {
        facts.waiting = Number(rows[0]?.waiting ?? 0);
      }),
  ]);
  return facts;
}

// ---------------------------------------------------------------------------
// The feed: one LISTEN, batched, re-established when it drops
// ---------------------------------------------------------------------------

/** A dedicated connection that can LISTEN — pg's `PoolClient` fits this shape. */
export interface ListenClient {
  query(text: string): Promise<unknown>;
  on(event: "notification", listener: (msg: { channel: string; payload?: string | undefined }) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  /** Hand the connection back; `true` destroys it (it is dead, or it is ours to close). */
  release(destroy?: boolean | Error): void;
}

export interface FeedOptions {
  hub: EventHub;
  /** Where the lookups go — the console's pool. */
  db: EventsDb;
  /** A fresh connection to LISTEN on — `() => pool.connect()`. Held for as long as it lives. */
  connect: () => Promise<ListenClient>;
  coalesceMs?: number;
  /** How often the LISTEN connection is proved alive with `SELECT 1` (a half-open socket delivers nothing and says nothing). */
  pingMs?: number;
  /** How often the Needs You count is re-checked on its own, for a snooze ending with no row written (default `SNOOZE_POLL_MS`). */
  snoozePollMs?: number;
  log?: (line: string) => void;
}

export interface EventFeed {
  /** True while a LISTEN is in place. */
  readonly listening: boolean;
  /** Resolves once the first LISTEN is in place (or the feed is stopped). */
  readonly ready: Promise<void>;
  /** Map and emit what is gathered now, without waiting for the window (tests). */
  flush(): Promise<void>;
  stop(): Promise<void>;
}

const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 30_000]; // limit: fixed — a lost LISTEN is retried forever; this is only how fast
const PING_TIMEOUT_MS = 10_000; // limit: fixed — a SELECT 1 that takes this long on a loopback database is a dead connection

/**
 * Start listening. Each notice joins the current batch; the batch is mapped
 * and published `coalesceMs` after its first notice. When the connection
 * drops it is re-established with backoff and a `resync` is published —
 * notices sent while nobody listened are gone, and a client told so refetches
 * rather than trusting a stream with a hole in it. A batch whose lookups fail
 * is a `resync` for the same reason.
 *
 * Beside the LISTEN, a second and much plainer clock: every `snoozePollMs`
 * the Needs You count is re-asked directly (ruling 17, X-17), because a
 * snooze ending is a comparison against `now()`, not a write — the one way
 * `waiting` can change that no trigger ever sees. The first ask only sets
 * the baseline; only a LATER ask that reads a different count says anything,
 * so nothing is said before the count actually changes, and a batch that
 * already said it moves the same baseline, so the two paths never double up.
 */
export function startEventFeed(o: FeedOptions): EventFeed {
  const log = o.log ?? ((line: string) => console.warn(line));
  const coalesceMs = o.coalesceMs ?? COALESCE_MS;
  const pingMs = o.pingMs ?? 30_000;
  const snoozePollMs = o.snoozePollMs ?? SNOOZE_POLL_MS;
  const memory = newMapperMemory();
  let pending: Notice[] = [];
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;
  let listening = false;
  let client: ListenClient | undefined;
  let wake: (() => void) | undefined;
  let markReady!: () => void;
  const ready = new Promise<void>((r) => (markReady = r));

  const publishSafely = <T extends EventType>(type: T, data: EventPayloads[T]): void => {
    try {
      o.hub.publish(type, data);
    } catch (err) {
      // the guard refused it: logged, never streamed
      log(`events: not streamed — ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * The one thing the LISTEN cannot see: re-ask the pending, un-snoozed count
   * and say so only when it moved since the last time either clock asked.
   * `memory.waiting` starting `null` means the very first ask — this one or
   * a batch's — sets the baseline rather than announcing it as a change.
   */
  const pollWaiting = async (): Promise<void> => {
    try {
      const { rows } = await o.db.query(WAITING_SQL);
      const waiting = Number(rows[0]?.waiting ?? 0);
      if (memory.waiting !== null && waiting !== memory.waiting) publishSafely("needs_you.changed", { waiting });
      memory.waiting = waiting;
    } catch (err) {
      log(`events: could not re-check the Needs You count (${err instanceof Error ? err.message : String(err)})`);
    }
  };
  void pollWaiting();
  const snoozeTimer = setInterval(() => void pollWaiting(), snoozePollMs);
  snoozeTimer.unref?.();

  const runBatch = async (batch: Notice[]): Promise<void> => {
    try {
      const facts = await lookupBatch(o.db, batch);
      for (const e of mapBatch(batch, facts, memory)) publishSafely(e.type, e.data);
    } catch (err) {
      log(`events: a batch of ${batch.length} notice(s) could not be looked up (${err instanceof Error ? err.message : String(err)}) — telling subscribers to resync`);
      publishSafely("resync", {});
    }
  };

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const batch = pending;
    pending = [];
    if (batch.length > 0) chain = chain.then(() => runBatch(batch));
    return chain;
  };

  const onNotification = (msg: { channel: string; payload?: string | undefined }): void => {
    if (msg.channel !== EVENTS_CHANNEL) return;
    const n = parseNotice(msg.payload);
    if (!n) return;
    pending.push(n);
    if (!timer) timer = setTimeout(() => void flush(), coalesceMs);
  };

  const loop = async (): Promise<void> => {
    let attempt = 0;
    // anything but a first attempt that simply worked leaves a stretch in which nobody listened
    let gap = false;
    while (!stopped) {
      let c: ListenClient | undefined;
      try {
        c = await o.connect();
        if (stopped) throw new Error("stopped");
        const dropped = new Promise<void>((resolve) => {
          wake = resolve;
          c!.on("error", (err) => {
            log(`events: the LISTEN connection failed (${err.message}) — reconnecting`);
            resolve();
          });
          c!.on("end", () => resolve());
        });
        c.on("notification", onNotification);
        await c.query(`LISTEN ${EVENTS_CHANNEL}`);
        client = c;
        listening = true;
        attempt = 0;
        if (gap) publishSafely("resync", {}); // it was down: whatever was said meanwhile is gone
        gap = true; // from here, any way out of this LISTEN is a stretch with nobody listening
        markReady();
        const ping = setInterval(() => {
          const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer")), PING_TIMEOUT_MS).unref?.());
          Promise.race([c!.query("SELECT 1"), timeout]).catch((err) => {
            log(`events: the LISTEN connection stopped answering (${err instanceof Error ? err.message : String(err)}) — reconnecting`);
            wake?.();
          });
        }, pingMs);
        ping.unref?.();
        await dropped;
        clearInterval(ping);
      } catch (err) {
        gap = true;
        if (!stopped) log(`events: could not LISTEN (${err instanceof Error ? err.message : String(err)}) — retrying`);
      }
      listening = false;
      client = undefined;
      wake = undefined;
      if (c) {
        try {
          c.release(true);
        } catch {
          /* already gone */
        }
      }
      if (stopped) break;
      const wait = RECONNECT_BACKOFF_MS[Math.min(attempt++, RECONNECT_BACKOFF_MS.length - 1)]!;
      await new Promise<void>((r) => setTimeout(r, wait).unref?.());
    }
    markReady();
  };
  void loop();

  return {
    get listening() {
      return listening;
    },
    ready,
    flush,
    async stop() {
      stopped = true;
      clearInterval(snoozeTimer);
      const c = client;
      if (c) {
        try {
          await c.query(`UNLISTEN ${EVENTS_CHANNEL}`);
        } catch {
          /* it is going anyway */
        }
      }
      wake?.();
      await flush();
    },
  };
}

/** The hub `main.ts` builds: the defaults, overridable from the environment. */
export function hubFromEnv(env: NodeJS.ProcessEnv = process.env): EventHub {
  return new EventHub({
    heartbeatMs: intEnv("METISTRY_EVENTS_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS, env),
    maxStreams: intEnv("METISTRY_EVENTS_MAX_STREAMS", DEFAULT_MAX_STREAMS, env),
  });
}
