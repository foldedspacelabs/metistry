// Today's three routes (design-build-plan §2.1, §2.10; screen-05-today
// §2, §8, §15.6; decision D10; ticket T2-7):
//
//   GET /api/today?date=        the day, composed: the vault's tasks (Today's
//                               preset), the work rows, the owner's drag
//                               order, the calendar, and the paths of the
//                               brief, the standup and the plan
//   GET /api/vault-tasks?where= the vault's tasks by any filter in the one
//                               `where:` language — All, and its saved views
//   PUT /api/today/order        the owner's drag order for one day
//
// **One read path, one filter language.** Every row comes out of a named
// query (invariant 3): `vault_tasks_query`, `day_work`, `today_order`,
// `day_events`, `tracker_closed` — all `expose: route`, so this owner-only door is the only
// door onto them. Both task reads compile their filter with core's
// `compileTaskFilter` (D15) — Today's preset is a `where:` string like any
// other, so what Today shows is a view the owner could paste into a template
// and get the same list. Nothing here writes SQL against the vault's tasks.
//
// **Today's preset**, written once below (`todayPreset`): the open lines
// owed on or before the day — `due <= <day> or do <= <day>`, which carries
// forward everything overdue or planned earlier and still open — then the
// lines ticked on that day (`done = <day> and status = done`), so a row
// ticked a moment ago is still on the day after the next walk, struck. A
// `#someday` line leaves Today (screen-05 §15.5.1) — it carries no `do`,
// but it may still carry a `due`, and `not someday` (ruling 14) cannot join
// an `or` under an `and` — the grammar has no brackets — so the preset drops
// `someday` rows by their `row_flags`-backed column after the query. Ordered by priority, then due — the order a day falls back to until
// the owner drags it (`today_order`).
//
// **The work on the day** is `day_work` narrowed to what the owner's day
// holds: a row an agent is waiting on them for (`waiting_on_me`, §3), the
// board's `blocked` state (the one only the owner's hand leaves), what is
// due or overdue on the day, and what closed on it. An in-progress row with
// no date is the Board's business, not the day's.
//
// **The order door refuses a key outside the day.** `PUT /api/today/order`
// takes the whole order for one day — `task_key`s and `work:<id>`s — and
// every key must be one `GET /api/today` serves for that day, or the request
// is `400` naming the keys; nothing is written. So the table can only ever
// hold an arrangement of rows the owner was actually shown: no client can
// park an arbitrary string in it, and no key from another day leaks into
// this one. The write replaces the day's order whole, in one statement.
//
// **What day it is** is the owner's: `METISTRY_TZ`, never `TZ` (both
// deployment shapes set `TZ` to UTC whenever `METISTRY_TZ` is unset, so
// reading it is the UTC fallback by another name). With no `METISTRY_TZ` the
// day is UTC's, said plainly in `docs/ops/client-api.md`; a client that
// knows its own day sends `date`.
//
// Reached only by the `user` principal: server.ts's management gate runs
// first, so an agent bearer and the capture owner token get the uniform 403.

import type { IncomingMessage, ServerResponse } from "node:http";
import { calendarDate, compileTaskFilter, errorEnvelope, statusFor, TASK_KEY_RE, TASK_QUERY_NAME, type ErrorCode, type TaskFilterParams } from "@foldedspacelabs/metistry-core";
import type { VaultClient } from "@foldedspacelabs/metistry-artifacts";
import type { QueryStore } from "@foldedspacelabs/metistry-queries";
import type { Db } from "./auth-store.js";
import { readJson, sendJson } from "./http-util.js";
import { trackerClosedForDay } from "./tracker-complete-route.js";

export const TODAY_ROUTE = "GET /api/today";
export const VAULT_TASKS_ROUTE = "GET /api/vault-tasks";
export const TODAY_ORDER_ROUTE = "PUT /api/today/order";
const ROUTES: ReadonlySet<string> = new Set([TODAY_ROUTE, VAULT_TASKS_ROUTE, TODAY_ORDER_ROUTE]);

/** The named queries Today composes (seed/queries/). */
export const DAY_WORK_QUERY = "day_work";
export const TODAY_ORDER_QUERY = "today_order";
export const DAY_EVENTS_QUERY = "day_events";

/** The work rows the day holds (see the header): `day_work` flags, joined by `or`. */
export const DAY_WORK_FLAGS = "waiting_on_me,blocked,due,overdue,closed";
/** A work row's key in the order: the board's id, spelled so it can never be a task key. */
const WORK_KEY_RE = /^work:([1-9]\d{0,17})$/;

const TODAY_TASKS_MAX = 500; // limit: fixed — `compileTaskFilter`'s ceiling; a day owing more than this is a report, not a day
const DAY_WORK_MAX = 200; // limit: fixed — work rows on one day; the Board holds the rest
const ORDER_KEYS_MAX = 1000; // limit: fixed — the most one day can hold (tasks + work, each capped above) with room; a longer body is not an order
const WHERE_MAX = 500; // limit: fixed — a `where:` a person typed; the parser's own gates refuse the rest
const OFFSET_MAX = 100_000; // limit: fixed — paging past this is an export, and the vault is the export
const OUTSIDE_NAMED = 10; // limit: fixed — how many refused keys the message names; the count is exact

/** The day's machine-written files (docs/product/daily-flow-spec.md §5.1; seed/vault/Journal/README.md). Each is named for the day it is FOR. */
export const DAY_FILES = {
  brief: (day: string) => `Journal/Brief/${day}.md`,
  standup: (day: string) => `Journal/Standup/${day}.md`,
  plan: (day: string) => `Journal/Plan/${day}.md`,
} as const;

/**
 * Today's preset, in the one `where:` language: the open lines owed on or
 * before the day, and the lines ticked on it. Two filters because the
 * grammar never mixes a scope (`status`) into an `or`; the route runs both
 * and serves the open ones first.
 */
export function todayPreset(day: string): { open: { where: string; order: string }; done: { where: string; order: string } } {
  return {
    open: { where: `due <= ${day} or do <= ${day}`, order: "priority, due" },
    done: { where: `done = ${day} and status = done`, order: "priority, due" },
  };
}

/**
 * All's saved views (screen-05 §15.6), each a `where:` string in the one
 * language — so each compiles, with `compileTaskFilter`, to ONE run of
 * `vault_tasks_query` and nothing else, and the owner can paste any of them
 * into a template or the All box and get the same list. Ruling 14 (X-14)
 * gave the grammar the carry count, `names_person` and `not <flag>` that
 * Slipping and Owed need:
 *
 *   - **Slipping** — carried three or more times (days owed past the day it
 *     was owed on), overdue, or owed to or by a person (review-01 §5.7).
 *   - **Owed** — the line names a person and is the owner's move: owed TO
 *     them. With `waiting` it is owed BY them, which is the next view.
 *   - **Waiting on Others** — `waiting`.
 */
export const SAVED_TASK_VIEWS: readonly { name: string; where: string }[] = Object.freeze([
  { name: "Slipping", where: "carried >= 3 or overdue or names_person" },
  { name: "Owed", where: "names_person and not waiting" },
  { name: "Waiting on Others", where: "waiting" },
]);

type Audit = (kind: string, tool: string, ok: boolean, meta: Record<string, unknown>) => Promise<void>;
type Row = Record<string, unknown>;

export interface TodayDeps {
  db: Db;
  queries: QueryStore;
  /** The reconciler's bridge: where the brief, standup and plan are looked for. Absent → those three are null. */
  vault?: VaultClient | undefined;
  audit: Audit;
  /** The instant "today" is taken from. Injectable for tests. */
  now?: (() => Date) | undefined;
  /** `METISTRY_TZ` (core `configuredTimeZone`) — never `TZ`. Null or absent → UTC. */
  timeZone?: string | null | undefined;
}

/** True when the request is for this module. Used by server.ts's management gate so a non-`user` credential gets the uniform 403. */
export function isTodayRoute(key: string): boolean {
  return ROUTES.has(key);
}

const refuse = (res: ServerResponse, code: ErrorCode, message: string) => sendJson(res, statusFor(code), errorEnvelope(code, message));

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** `2026-02-30` has the shape and is no day: round-trip it through the UTC calendar, which has no zone to disagree with. */
function isCalendarDay(s: string): boolean {
  if (!ISO_DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The owner's zone and today in it — or the reason the console cannot say. */
function clock(deps: TodayDeps): { ok: true; zone: string; now: Date; today: string } | { ok: false; message: string } {
  const zone = deps.timeZone || "UTC";
  const now = (deps.now ?? (() => new Date()))();
  try {
    return { ok: true, zone, now, today: calendarDate(now, zone) };
  } catch {
    return { ok: false, message: `the console's zone ${JSON.stringify(zone)} is not one this runtime knows — set METISTRY_TZ to an IANA zone (e.g. America/New_York)` };
  }
}

/** The compiled filter's params for one run of `vault_tasks_query`, with the caller's context filled in: the day, and the owner's whole vault. */
function taskParams(where: string, order: string, limit: number, day: string, now: Date, zone: string): { ok: true; params: TaskFilterParams } | { ok: false; error: string } {
  const out = compileTaskFilter({ where, order, limit }, { now, timeZone: zone });
  if (!out.ok) return out;
  return { ok: true, params: { ...out.params, today: day, me: "", path_prefix: "", offset: 0 } };
}

/**
 * The rows one day holds — the two task filters of the preset and the work
 * — which is both what `GET /api/today` serves and the set
 * `PUT /api/today/order` judges every key against.
 */
async function dayRows(day: string, deps: TodayDeps, now: Date, zone: string): Promise<{ tasks: Row[]; work: Row[] }> {
  const preset = todayPreset(day);
  const open = taskParams(preset.open.where, preset.open.order, TODAY_TASKS_MAX, day, now, zone);
  const done = taskParams(preset.done.where, preset.done.order, TODAY_TASKS_MAX, day, now, zone);
  // the preset is this file's own string over an ISO day: a refusal is a bug here, never the caller's
  if (!open.ok || !done.ok) throw new Error(`Today's preset does not compile: ${!open.ok ? open.error : !done.ok ? done.error : ""}`);
  const [o, d, w] = await Promise.all([
    deps.queries.run(TASK_QUERY_NAME, open.params as unknown as Record<string, unknown>),
    deps.queries.run(TASK_QUERY_NAME, done.params as unknown as Record<string, unknown>),
    deps.queries.run(DAY_WORK_QUERY, { day, flags: DAY_WORK_FLAGS, combine: "or", limit: DAY_WORK_MAX }),
  ]);
  // `#someday` leaves Today's open list (screen-05 §15.5.1); a someday line ticked today was still done today
  return { tasks: [...o.rows.filter((r) => r.someday !== true), ...d.rows], work: w.rows };
}

/** The order keys the day's rows answer to: each task's `task_key`, each work row's `work:<id>`. */
function dayKeys(rows: { tasks: Row[]; work: Row[] }): Set<string> {
  return new Set([...rows.tasks.map((t) => String(t.task_key)), ...rows.work.map((w) => `work:${String(w.id)}`)]);
}

/** Null when the file is not there — not written yet, or no bridge to ask; a bridge that fails to answer is the same null, because the rest of the day still renders. */
async function present(vault: VaultClient | undefined, path: string): Promise<string | null> {
  if (!vault) return null;
  try {
    return (await vault.read(path)) ? path : null;
  } catch {
    return null;
  }
}

export async function todayRoutes(req: IncomingMessage, res: ServerResponse, key: string, url: URL, deps: TodayDeps): Promise<void> {
  const c = clock(deps);
  if (!c.ok) return refuse(res, "not_available", c.message);
  if (key === TODAY_ROUTE) return getToday(res, url, deps, c);
  if (key === VAULT_TASKS_ROUTE) return getVaultTasks(res, url, deps, c);
  return putOrder(req, res, deps, c);
}

type Clock = Extract<ReturnType<typeof clock>, { ok: true }>;

async function getToday(res: ServerResponse, url: URL, deps: TodayDeps, c: Clock): Promise<void> {
  const unknown = [...url.searchParams.keys()].filter((k) => k !== "date");
  if (unknown.length > 0) return refuse(res, "invalid_request", `unknown parameter ${unknown.join(", ")} — GET /api/today takes date (YYYY-MM-DD) and nothing else`);
  const asked = url.searchParams.get("date") ?? "";
  if (asked !== "" && !isCalendarDay(asked)) return refuse(res, "invalid_request", "date must be a calendar day, YYYY-MM-DD — or leave it out for today in the owner's zone");
  const day = asked || c.today;

  const [rows, order, events, brief, standup, plan] = await Promise.all([
    dayRows(day, deps, c.now, c.zone),
    deps.queries.run(TODAY_ORDER_QUERY, { day }),
    deps.queries.run(DAY_EVENTS_QUERY, { day, tz: c.zone }),
    present(deps.vault, DAY_FILES.brief(day)),
    present(deps.vault, DAY_FILES.standup(day)),
    present(deps.vault, DAY_FILES.plan(day)),
  ]);
  // A stored key the day no longer holds (the line moved, was ticked on
  // another day, the row closed) is not served: the order is an arrangement
  // of THIS day's rows, and the next drag clears it from the table.
  const keys = dayKeys(rows);
  // *Done in Linear* (T4-26): the day's open lines whose issue the tracker
  // closed — named here, never ticked here; the owner's Tick is the write
  const trackerClosed = await trackerClosedForDay(rows.tasks, deps.queries);
  return sendJson(res, 200, {
    date: day,
    tasks: rows.tasks,
    work: rows.work,
    order: order.rows.map((r) => String(r.task_key)).filter((k) => keys.has(k)),
    events: events.rows,
    tracker_closed: trackerClosed,
    brief,
    standup,
    plan,
    as_of: c.now.toISOString(),
  });
}

const VAULT_TASKS_PARAMS = ["where", "order", "limit", "offset"];

async function getVaultTasks(res: ServerResponse, url: URL, deps: TodayDeps, c: Clock): Promise<void> {
  const q = url.searchParams;
  const unknown = [...q.keys()].filter((k) => !VAULT_TASKS_PARAMS.includes(k));
  if (unknown.length > 0) return refuse(res, "invalid_request", `unknown parameter ${unknown.join(", ")} — GET /api/vault-tasks takes where, order, limit and offset`);
  const where = q.get("where") ?? "";
  const order = q.get("order") ?? "";
  if (where.length > WHERE_MAX || order.length > WHERE_MAX) return refuse(res, "invalid_request", `where and order are at most ${WHERE_MAX} characters each`);
  const limit = q.has("limit") ? Number(q.get("limit")) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= TODAY_TASKS_MAX)) return refuse(res, "invalid_request", `limit must be a whole number from 1 to ${TODAY_TASKS_MAX}`);
  const offset = q.has("offset") ? Number(q.get("offset")) : 0;
  if (!(Number.isInteger(offset) && offset >= 0 && offset <= OFFSET_MAX)) return refuse(res, "invalid_request", `offset must be a whole number from 0 to ${OFFSET_MAX}`);

  // One parser (D15): a filter outside the grammar is refused with the
  // parser's own words, which name the token — never guessed at, never
  // passed through.
  const out = compileTaskFilter({ where, order, limit }, { now: c.now, timeZone: c.zone });
  if (!out.ok) return refuse(res, "invalid_request", out.error);
  const pageSize = out.params.limit;
  const { rows } = await deps.queries.run(TASK_QUERY_NAME, {
    ...out.params,
    // one row past the page says whether there is another
    limit: pageSize + 1,
    today: c.today,
    me: "",
    path_prefix: "", // the owner's door: the whole vault
    offset,
  } as unknown as Record<string, unknown>);
  return sendJson(res, 200, { where, rows: rows.slice(0, pageSize), more: rows.length > pageSize, as_of: c.now.toISOString() });
}

const ORDER_FIELDS = ["date", "task_keys"];
const ORDER_BODY = "{date: YYYY-MM-DD, task_keys: [task_key | work:<id>, …]}";

async function putOrder(req: IncomingMessage, res: ServerResponse, deps: TodayDeps, c: Clock): Promise<void> {
  let body: Record<string, unknown>;
  try {
    const raw = await readJson(req);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refuse(res, "invalid_request", `body must be a JSON object: ${ORDER_BODY}`);
    body = raw as Record<string, unknown>;
  } catch {
    return refuse(res, "invalid_request", "request body is not JSON");
  }
  const unknown = Object.keys(body).filter((k) => !ORDER_FIELDS.includes(k));
  if (unknown.length > 0) return refuse(res, "invalid_request", `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} — the body is ${ORDER_BODY}`);
  if (typeof body.date !== "string" || !isCalendarDay(body.date)) return refuse(res, "invalid_request", "date must be a calendar day, YYYY-MM-DD — the day the order is for");
  const day = body.date;
  const keys = body.task_keys;
  if (!Array.isArray(keys)) return refuse(res, "invalid_request", `task_keys must be an array: the day's rows in the owner's order — ${ORDER_BODY}`);
  if (keys.length > ORDER_KEYS_MAX) return refuse(res, "invalid_request", `task_keys holds at most ${ORDER_KEYS_MAX} keys`);
  const malformed = keys.filter((k) => typeof k !== "string" || !(TASK_KEY_RE.test(k) || WORK_KEY_RE.test(k)));
  if (malformed.length > 0) return refuse(res, "invalid_request", `task_keys holds ${malformed.length} ${malformed.length === 1 ? "entry that is" : "entries that are"} not a key — each is a task_key (an anchor \`mt-…\` or a hash key) or \`work:<id>\`, exactly as GET /api/today serves it`);
  const order = keys as string[];
  const seen = new Set<string>();
  const twice = order.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
  if (twice.length > 0) return refuse(res, "invalid_request", `task_keys names ${[...new Set(twice)].slice(0, OUTSIDE_NAMED).join(", ")} more than once — a row has one place in the day`);

  // The key has to be one of the day's own rows — the ticket's refusal.
  const rows = await dayRows(day, deps, c.now, c.zone);
  const held = dayKeys(rows);
  const outside = order.filter((k) => !held.has(k));
  if (outside.length > 0) {
    await deps.audit("today_order", "order", false, { day, outcome: "outside_day", keys: order.length, outside: outside.length });
    const named = outside.slice(0, OUTSIDE_NAMED).join(", ");
    const rest = outside.length > OUTSIDE_NAMED ? ` and ${outside.length - OUTSIDE_NAMED} more` : "";
    return sendJson(res, statusFor("invalid_request"), {
      ...errorEnvelope("invalid_request", `${outside.length === 1 ? "this key is" : "these keys are"} not on ${day}: ${named}${rest} — the order holds only rows GET /api/today serves for that day; refresh Today and drag again`),
      outside: outside.slice(0, OUTSIDE_NAMED),
    });
  }

  // The day's order, replaced whole in ONE statement (the console holds no
  // transaction): rows not in the new order go, the rest take their new
  // places. The two halves touch disjoint keys, so they cannot collide.
  await deps.db.query(
    `WITH incoming AS (
       SELECT u.k AS task_key, u.i::int AS position FROM unnest($2::text[]) WITH ORDINALITY AS u(k, i)
     ), gone AS (
       DELETE FROM today_order t
        WHERE t.day = $1::date AND NOT EXISTS (SELECT 1 FROM incoming n WHERE n.task_key = t.task_key)
     )
     INSERT INTO today_order (day, task_key, position, updated_at)
     SELECT $1::date, n.task_key, n.position, now() FROM incoming n
     ON CONFLICT (day, task_key) DO UPDATE SET position = EXCLUDED.position, updated_at = now()`,
    [day, order],
  );
  // the day and the count, never the keys: an anchor is harmless, but a hash key is derived from the owner's own words
  await deps.audit("today_order", "order", true, { day, outcome: "stored", keys: order.length });
  return sendJson(res, 200, { ok: true, date: day, order });
}
