// The live-changes catalogue (design-build-plan §2.20, frozen by F-1): what
// `GET /api/events` may say. The console holds one `LISTEN`, maps each
// Postgres notice to one of these types, coalesces bursts, numbers it and
// fans it out as Server-Sent Events (T2-18 builds that; this file is the
// vocabulary both ends are written against).
//
// **Ids, never bodies.** An event says WHAT changed; the client refetches it
// through the route that already decides who may read it (`refetch` below
// names that route). So the stream opens no new read path (invariant 3) and
// can leak nothing the routes would not: every payload is ids, names and
// counts — a count "is not a body" (§2.20) — and never a row, a message's
// text or a file's content.
//
// **Reach is `owner`, for every event, and none reaches an agent.** The stream
// is one `owner` route in the client API table (`client-api.ts`); an agent
// learns about changes through its own tools, never through this.

import type { Reach } from "./client-api.js";

/** The capability `GET /api/identity` advertises while `GET /api/events` is served. */
export const EVENTS_CAPABILITY = "events" as const;

/** The route that streams them — a row in the client API table. */
export const EVENTS_ROUTE = "GET /api/events" as const;

/** Every event's reach (§2.20). One value, on purpose: a type an agent could subscribe to would be a second door. */
export const EVENT_REACH: Reach = "owner";

/** The event types, in the catalogue's order. */
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
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** What `vault.sync` reports (§2.21): the act that just happened, or the state it left. */
export const VAULT_SYNC_STATES = ["commit", "push", "pull", "conflict"] as const;
export type VaultSyncState = (typeof VAULT_SYNC_STATES)[number];

/** A `runs` row starting or finishing. `kind` is the row's own kind (`turn`, `capture`, …); `turn_id` rides along when the run belongs to a chat turn. */
export interface RunEvent {
  readonly run_id: number;
  readonly kind: string;
  readonly turn_id?: string;
}

/**
 * Each type's payload. Numeric ids are JSON numbers (the `bigint` keys of
 * `runs`, `inbox`, `work`, `outbound_messages`); text ids — an agent, a
 * turn, an artifact — are strings.
 */
export interface EventPayloads {
  "run.started": RunEvent;
  "run.finished": RunEvent;
  "turn.progress": { readonly turn_id: string };
  "message.new": { readonly message_id: number; readonly thread: string };
  "presence.changed": { readonly agent_id: string };
  /** How many requests wait — a count, which is not a body. */
  "needs_you.changed": { readonly waiting: number };
  "work.changed": { readonly work_id: number };
  /** A task's room, or an artifact's comment threads. */
  "thread.changed": { readonly work_id: number } | { readonly artifact_id: string };
  "capture.new": { readonly inbox_id: number };
  /** How many files the reconcile pass changed — a count, not the paths. */
  "vault.reconciled": { readonly changed: number };
  "vault.sync": { readonly state: VaultSyncState };
  "routine.status": { readonly name: string };
  "sync.status": { readonly name: string };
  "connection.health": { readonly connection: string };
  /** The protected path that was written (`config_write`), e.g. `.metistry/compute.yaml`. */
  "config.changed": { readonly file: string };
  /** The budget scope whose limit was crossed: `instance`, or a provider's name. */
  "budget.state": { readonly scope: string };
  "release.available": { readonly version: string };
  /** The replay gap was too large: refetch every visible screen. */
  resync: Record<string, never>;
}

/**
 * One event as a client receives it. `id` is the SSE `id:` field — opaque,
 * increasing, and what a reconnect sends back as `Last-Event-ID`; `type` is
 * the SSE `event:` field; `data` is the JSON on the `data:` line.
 */
export interface ClientEvent<T extends EventType = EventType> {
  readonly id: string;
  readonly type: T;
  readonly data: EventPayloads[T];
}

export interface EventDefinition {
  readonly type: EventType;
  /** The payload's fields as the document writes them; `?` marks an optional one, `|` alternatives. */
  readonly payload: string;
  readonly when: string;
  /** Where the client goes for the thing itself. Every route named here is a row in the client API table (a test holds it). */
  readonly refetch: string;
  readonly reach: Reach;
}

function event(type: EventType, payload: string, when: string, refetch: string): EventDefinition {
  return { type, payload, when, refetch, reach: EVENT_REACH };
}

/** The catalogue, one row per type — the document's event table repeats it line for line. */
export const EVENT_CATALOGUE: readonly EventDefinition[] = [
  event("run.started", "{run_id, kind, turn_id?}", "a `runs` row starts", "`GET /api/runs/:id`"),
  event("run.finished", "{run_id, kind, turn_id?}", "a `runs` row finishes", "`GET /api/runs/:id`"),
  event("turn.progress", "{turn_id}", "a tool call in a turn starts or ends", "`GET /api/turns/:turn_id/progress` — the working indicator"),
  event("message.new", "{message_id, thread}", "a reply is stored", "`GET /api/messages?since=`"),
  event("presence.changed", "{agent_id}", "a claim, a lease, a heartbeat (throttled)", "`GET /api/q/agent_presence`"),
  event("needs_you.changed", "{waiting}", "a request is raised, decided or snoozed", "`GET /api/proposals?since=`"),
  event("work.changed", "{work_id}", "a task moves or changes", "`GET /api/q/board`"),
  event("thread.changed", "{work_id | artifact_id}", "a room or a thread gets a message", "`GET /api/work/:id/thread`, `GET /api/artifacts/:id/comments`"),
  event("capture.new", "{inbox_id}", "a capture lands or is classified", "Activity (`GET /api/q/activity_feed`)"),
  event("vault.reconciled", "{changed}", "a reconcile pass finishes with changes", "Today and Knowledge (`GET /api/today`, `GET /api/knowledge/pages`)"),
  event("vault.sync", "{state}", "a commit, push, pull or conflict", "`GET /api/vault/status`"),
  event("routine.status", "{name}", "a routine run finishes", "`GET /api/scheduled/routines/:name`"),
  event("sync.status", "{name}", "a sync run finishes", "`GET /api/scheduled/syncs/:name`"),
  event("connection.health", "{connection}", "a check or a call fails or recovers", "`GET /api/connections/:name`"),
  event("config.changed", "{file}", "a protected write (`config_write`)", "the pane showing it"),
  event("budget.state", "{scope}", "a limit is crossed", "`GET /api/compute`"),
  event("release.available", "{version}", "the daily Update Check routine finds a newer runtime", "`GET /api/identity`"),
  event("resync", "{}", "the replay gap was too large", "every visible screen"),
];

/** True for a type in the catalogue — a client ignores any other, so a newer console's additive type never breaks an older client. */
export function isEventType(v: unknown): v is EventType {
  return typeof v === "string" && (EVENT_TYPES as readonly string[]).includes(v);
}
