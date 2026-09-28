// The Scheduled doors (design-build-plan §2.1, §2.5; T3-3) — everything
// recurring, in one place: every routine and sync with where each field came
// from, Run Now, and the owner's changes to `.metistry/scheduled.yaml`.
//
// Four things this file holds.
//
//   * **One file, and never a manifest.** Every write here is one edit to
//     `.metistry/scheduled.yaml` — the third and last protected path the
//     console writes (`CALLER_AUTHORITY.console`), through the reconciler as
//     `user`. A manifest is the product's (or the owner's extension's) and
//     no door here can name one: the only path `ScheduledOverlay.write`
//     knows is the overlay's.
//   * **Validated before it is written, and against the manifests.** The
//     file is edited as a YAML document, so the owner's comments and every
//     other entry survive; the result must parse under core's closed schema
//     (`parseScheduled`) AND fit the component it names (`checkScheduled` —
//     the rule the runner holds a component by). A change that would hold a
//     component is refused naming the field; nothing is written. An invalid
//     file is never rewritten — the owner fixes it first.
//   * **Timing is inside the boundary; what runs is not.** A schedule, a
//     pause, Reset to Default, a sync's cadence and raise toggles, Run Now:
//     `owner` — a phone may change them. A New Routine — creating one
//     (`POST /api/scheduled/routines`, T3-8) and its actor, task and per-run
//     grants — `local`, the Mac alone (the table's reach; the gate in
//     server.ts enforces it before this file runs). Per-run grants are
//     read-only (owner ruling, W1): core's schema refuses `write:` by name,
//     and a New Routine's actor is a crew — its run is one crew run.
//   * **Run Now is the runner's tick for one component** (`runNow`,
//     runner.ts): the owner's pause and a held entry apply, and so does the
//     preflight, budget included.
//
// It degrades absent: with no scheduled components wired in (a console built
// without its runner — tests, a stranger's embed) every route answers 503.
// Reads work wherever the runner does; writes need the vault bridge and the
// instance directory the runner reads its overlay from.

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isMap as isYamlMap, isScalar, isSeq, parseDocument, Scalar, type Document, type YAMLMap } from "yaml";
import {
  AGENT_NAME_RE,
  SCHEDULED_NAME_RE,
  checkScheduled,
  describeSchedule,
  emptyScheduled,
  errorEnvelope,
  isAssignment,
  isInterval,
  isLegacyCron,
  newRoutines,
  parseScheduled,
  resolveUnit,
  routineAssignmentSchema,
  scheduleSchema,
  statusFor,
  timeOfDayFields,
  EVERY,
  type ErrorCode,
  type Occurrence,
  type ProfileFacts,
  type ResolveContext,
  type ResolvedScheduled,
  type RoutineAssignment,
  type Schedule,
  type Scheduled,
  type ScheduledUnit,
  type Sourced,
} from "@foldedspacelabs/metistry-core";
import { VaultError } from "@foldedspacelabs/metistry-artifacts";
import type { QueryStore } from "@foldedspacelabs/metistry-queries";
import { readBody, sendError, sendJson, sendUnrouted } from "./http-util.js";
import { overlayFromText, titleOf, unitOf, type OverlayRead, type RunNowResult, type ScheduledCollector } from "./runner.js";

export { titleOf }; // a New Routine's display name — the runner's, so a run's label and the listing's are one

// ---- what the console hands this file ---------------------------------------------

/**
 * `.metistry/scheduled.yaml`, as the Scheduled doors reach it: read from the
 * file the RUNNER reads (so what is shown is what runs), written through the
 * reconciler as `user` with a compare-and-swap on the bytes that were read.
 */
export interface ScheduledOverlay {
  /** The file's bytes; null when there is no file yet; undefined when this console cannot see it. */
  read(): Promise<Buffer | null | undefined>;
  /**
   * Write the whole file, as `user`, if it is still `expectedSha256` ("" =
   * must not exist yet). Throws `VaultError("conflict")` when it changed.
   * Absent = this console cannot write it, and `readOnly` says why.
   */
  write?: ((content: Buffer, expectedSha256: string, message: string) => Promise<void>) | undefined;
  /** Why writes answer 503, when `write` is absent — the variable or the shape that would change it. */
  readOnly?: string | undefined;
}

export interface ScheduledAdmin {
  /** Every component the runner schedules — its manifest's unit, origin and code. */
  components: readonly ScheduledCollector[];
  overlay: ScheduledOverlay;
  /** `Me/profile.md`'s facts, read per request through the vault bridge; absent = the profile says nothing. */
  profile?: (() => Promise<ProfileFacts>) | undefined;
  /** METISTRY_TZ (`configuredTimeZone`) — the zone a time of day falls back to; null = none. */
  timeZone: string | null;
  /** Run Now: the runner's tick for one component (runner.ts `runNow`, bound to the runner's ctx and options). Absent = 503. */
  runNow?: ((name: string) => Promise<RunNowResult>) | undefined;
  /**
   * Whether an agent id names a live CREW this console can run — a New
   * Routine's `actor`, since its run is one crew run (T3-8). Absent = not
   * checked (the runner still refuses a run whose actor is no crew).
   */
  actorExists?: ((id: string) => Promise<boolean>) | undefined;
  /**
   * Whether this console's runner runs New Routines — it was given the crew
   * queue (`RunnerOptions.agentRoutines`). False or absent: a New Routine is
   * kept and listed, held with `ASSIGNMENT_NOT_RUN`, and not run.
   */
  runsAssignments?: boolean | undefined;
  /** The clock `next_run` counts from; tests pin it. */
  now?: (() => Date) | undefined;
}

type Audit = (kind: string, tool: string, ok: boolean, meta: Record<string, unknown>) => Promise<void>;

export interface ScheduledDeps {
  admin?: ScheduledAdmin | undefined;
  queries: QueryStore;
  audit: Audit;
}

/** Everything under this prefix is the owner's. server.ts's management gate uses it so any other credential gets the canonical 403 across the whole family, never a 404 that would say which names exist. */
export function isScheduledRoute(pathname: string): boolean {
  return pathname === "/api/scheduled" || pathname.startsWith("/api/scheduled/");
}

const NOT_WIRED =
  "Scheduled is not wired into this console — it lists and changes what the console's runner schedules, and this process was started without one (docs/ops/scheduled.md)";

/** A New Routine on a console whose runner has no crew queue: kept and listed, and nothing here can run it. */
export const ASSIGNMENT_NOT_RUN =
  "a New Routine runs as one crew run, and this console's runner was started without the crew queue — it is kept, listed, and not run here (docs/ops/scheduled.md)";

/** `POST /api/scheduled/routines` — New Routine (T3-8, reach local). */
const CREATE_KEY = "POST /api/scheduled/routines";

const ROUTE_RE = /^(GET|PUT|POST|DELETE) \/api\/scheduled(?:\/(routines|syncs)\/([^/]+)(?:\/(schedule|pause|resume|run|assignment))?)?$/;

// ---- the wire shapes (docs/ops/client-api.md, "Scheduled") -------------------------

interface LastRun {
  run_id: string;
  at: string | null;
  ok: boolean | null;
  outcome: string | null;
  cost_usd: string | null;
  error: string | null;
}

interface HistoryRow extends LastRun {
  steps: number | null;
  trigger: string | null;
}

interface Shared {
  name: string;
  title: string;
  paused: Sourced<boolean>;
  next_run: string | null;
  last_run: LastRun | null;
  /** No entry in the file — the **default** tag; Reset to Default returns here. */
  is_default: boolean;
  /** Why the runner does not run it (its entry does not fit its manifest, the file does not validate, a New Routine before T3-8); null when it runs. */
  held: string | null;
  /** The schedule for a person: `working days at 07:00`, `every 15m`. */
  describe: string;
  /** Why no next run can be placed (`no_working_days`, `no_timezone`, `unknown_timezone`); null otherwise. */
  next_refused: { reason: string; why: string } | null;
}

interface RoutineView extends Shared {
  kind: "routine";
  source: "product" | "extension" | "assignment";
  schedule: Sourced<unknown>;
  config: Readonly<Record<string, Sourced<unknown>>>;
  actor: string | null;
  task: string | null;
  grants: RoutineAssignment["grants"] | null;
  /** A time of day's weekdays — `profile` when a day set follows `Me/profile.md`; null for an interval or with no working days to follow. */
  days: Sourced<readonly string[]> | null;
  time_zone: Sourced<string> | null;
}

interface SyncView extends Shared {
  kind: "sync";
  connection: string | null;
  /** The cadence: `{value: "15m"}` from the closed four; null value for a manifest default that is not an interval. */
  every: Sourced<string | null>;
  raise: Readonly<Record<string, Sourced<boolean>>>;
}

// ---- reading the layers -------------------------------------------------------------

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

interface Current {
  /** What was read: null = no file, undefined = not visible. */
  bytes: Buffer | null | undefined;
  text: string;
  overlay: OverlayRead;
}

async function current(admin: ScheduledAdmin): Promise<Current> {
  const bytes = await admin.overlay.read();
  const text = bytes ? bytes.toString("utf8") : "";
  return { bytes, text, overlay: bytes ? overlayFromText(text) : { ok: true, value: emptyScheduled } };
}

async function facts(admin: ScheduledAdmin): Promise<ProfileFacts> {
  if (!admin.profile) return {};
  try {
    return await admin.profile();
  } catch {
    return {}; // the bridge is down: shown as saying nothing, which is what a next run it cannot place says
  }
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function lastRunOf(row: Record<string, unknown> | undefined): LastRun | null {
  if (!row) return null;
  return {
    run_id: String(row.id),
    at: iso(row.ts),
    ok: typeof row.ok === "boolean" ? row.ok : null,
    outcome: str(row.outcome),
    cost_usd: str(row.cost_usd),
    error: str(row.error),
  };
}

function historyOf(row: Record<string, unknown>): HistoryRow {
  return { ...lastRunOf(row)!, steps: row.steps === null || row.steps === undefined ? null : Number(row.steps), trigger: str(row.trigger) };
}

const HISTORY_QUERY = "routine_history";

/** A component's runs through the named query (invariant 3). A console loaded without the seed queries shows no history rather than failing the door. */
async function history(queries: QueryStore, name: string, limit: number): Promise<Record<string, unknown>[]> {
  if (!queries.names().includes(HISTORY_QUERY)) return [];
  return (await queries.run(HISTORY_QUERY, { component: name, limit })).rows as Record<string, unknown>[];
}

/** The last run of each name, in one pass of the named query (invariant 3: one read path). */
async function lastRuns(queries: QueryStore, names: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  await Promise.all(
    names.map(async (n) => {
      const row = (await history(queries, n, 1))[0];
      if (row) out.set(n, row);
    }),
  );
  return out;
}

interface Layers {
  units: ScheduledUnit[];
  byName: Map<string, ScheduledCollector>;
  file: Scheduled;
  /** why each unit is held when the FILE does not validate (the runner's rule: the names it names, or all) */
  fileHeld: (name: string) => string | null;
  errors: readonly string[];
  ctx: ResolveContext;
  facts: ProfileFacts;
}

async function layers(admin: ScheduledAdmin, cur: Current, runs: Map<string, Record<string, unknown>>): Promise<Layers> {
  const f = await facts(admin);
  const lastRunsAt: Record<string, Date> = {};
  for (const [n, r] of runs) if (r.ts) lastRunsAt[n] = new Date(String(r.ts instanceof Date ? r.ts.toISOString() : r.ts));
  const ctx: ResolveContext = { now: (admin.now ?? (() => new Date()))(), profile: f, fallbackTimeZone: admin.timeZone, lastRuns: lastRunsAt };
  const o = cur.overlay;
  const fileHeld = (name: string): string | null => {
    if (o.ok) return null;
    if (o.held !== "all" && !o.held.includes(name)) return null;
    const which = o.held === "all" ? "it cannot be read well enough to say which components it changes" : `it names ${name}`;
    return `.metistry/scheduled.yaml does not validate, and ${which} — held until it does: ${o.errors.join("; ")}`;
  };
  return {
    units: admin.components.map(unitOf),
    byName: new Map(admin.components.map((c) => [c.name, c])),
    file: o.ok ? o.value : emptyScheduled,
    fileHeld,
    errors: o.ok ? [] : o.errors,
    ctx,
    facts: f,
  };
}

function nextOf(next: Occurrence | null): Pick<Shared, "next_run" | "next_refused"> {
  if (next === null) return { next_run: null, next_refused: null };
  return next.ok ? { next_run: next.at.toISOString(), next_refused: null } : { next_run: null, next_refused: { reason: next.reason, why: next.why } };
}

function unitView(unit: ScheduledUnit, l: Layers, runs: Map<string, Record<string, unknown>>): RoutineView | SyncView {
  const r0: ResolvedScheduled = resolveUnit(unit, l.file, l.ctx);
  const fileHeld = l.fileHeld(unit.name);
  const r = fileHeld ? { ...r0, held: fileHeld, next: null } : r0;
  const shared: Shared = {
    name: r.name,
    title: r.displayName,
    paused: r.paused,
    ...nextOf(r.next),
    last_run: lastRunOf(runs.get(r.name)),
    is_default: r.isDefault,
    held: r.held,
    describe: r.describe,
  };
  if (r.section === "syncs") {
    const s = r.schedule.value;
    const every = !isLegacyCron(s) && isInterval(s) ? s.every : null;
    return { ...shared, kind: "sync", connection: r.connection, every: { value: every, origin: r.schedule.origin }, raise: r.raise };
  }
  return {
    ...shared,
    kind: "routine",
    source: l.byName.get(unit.name)?.origin ?? "product",
    schedule: r.schedule,
    config: r.config,
    actor: null,
    task: null,
    grants: null,
    days: r.days,
    time_zone: r.timeZone,
  };
}

function assignmentView(name: string, a: RoutineAssignment, l: Layers, runs: Map<string, Record<string, unknown>>, runsAssignments: boolean): RoutineView {
  const tod = timeOfDayFields(a.schedule, "yours", l.ctx);
  const held = l.fileHeld(name) ?? (runsAssignments ? null : ASSIGNMENT_NOT_RUN);
  // when it runs next: the same resolution a manifest's routine gets, over its own schedule (an assignment has no layers below it)
  const next = held !== null || a.paused === true ? null : resolveUnit({ name, section: "routines", displayName: titleOf(name), schedule: a.schedule, config: {}, raise: {} }, emptyScheduled, l.ctx).next;
  return {
    name,
    title: titleOf(name),
    kind: "routine",
    source: "assignment",
    schedule: { value: a.schedule, origin: "yours" },
    paused: a.paused !== undefined ? { value: a.paused, origin: "yours" } : { value: false, origin: "default" },
    config: {},
    actor: a.actor,
    task: a.task,
    grants: a.grants ?? null,
    days: tod.days,
    time_zone: tod.timeZone,
    ...nextOf(next),
    last_run: lastRunOf(runs.get(name)),
    is_default: false,
    held,
    describe: describeSchedule(a.schedule),
  };
}

/** The New Routines in a valid file: assignments under a name no manifest has (core's `newRoutines` — the runner's own reading). */
function assignments(file: Scheduled, units: readonly ScheduledUnit[]): [string, RoutineAssignment][] {
  return newRoutines(file, units.map((u) => u.name));
}

// ---- the edit: one YAML document, validated, compare-and-swapped ----------------------

export type Refusal = { readonly code: ErrorCode; readonly message: string };
export const refuse = (code: ErrorCode, message: string): Refusal => ({ code, message });

export type Edit = (doc: Document, file: Scheduled) => Refusal | void;

export type EditResult = { ok: true; file: Scheduled; changed: boolean } | { ok: false; refusal: Refusal };

const WRITE_ATTEMPTS = 3; // limit: fixed — a compare-and-swap lost to a concurrent edit is re-read and re-applied; three losses in a row is somebody else editing the file right now

/** A schedule as a flow map, its times double-quoted — as the file's own examples are, so `08:00` can never be read as a sexagesimal number. */
export function scheduleNode(doc: Document, schedule: Schedule): YAMLMap {
  const node = doc.createNode(schedule, { flow: true }) as YAMLMap;
  const at: unknown = node.get("at", true);
  if (isSeq(at)) for (const item of at.items) if (isScalar(item)) item.type = Scalar.QUOTE_DOUBLE;
  return node;
}

/** `deleteIn` that is a no-op when the path is not there (the library throws for a missing parent). */
export function drop(doc: Document, path: readonly (string | number)[]): void {
  if (doc.hasIn(path)) doc.deleteIn(path);
}

/** Remove a routine's or sync's entry if nothing is left in it, and the section if nothing is left in that. */
export function prune(doc: Document, section: "routines" | "syncs", name: string): void {
  const entry = doc.getIn([section, name], true);
  if (isYamlMap(entry) && entry.items.length === 0) drop(doc, [section, name]);
  const sec = doc.getIn([section], true);
  if (isYamlMap(sec) && sec.items.length === 0) drop(doc, [section]);
}

/**
 * Read, edit, validate, write — once, or again from a fresh read when the
 * file changed underneath (the compare-and-swap lost). Nothing is written
 * when the edit changes nothing (every door here is idempotent by its own
 * identity), when the file does not validate (it is never rewritten), or
 * when the result would not validate or would hold `name`'s component.
 */
export async function applyEdit(admin: ScheduledAdmin, units: readonly ScheduledUnit[], name: string, what: string, edit: Edit): Promise<EditResult> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const cur = await current(admin);
    if (cur.bytes === undefined) return { ok: false, refusal: refuse("not_available", admin.overlay.readOnly ?? "this console cannot see .metistry/scheduled.yaml") };
    const before = parseScheduled(cur.text);
    if (!before.ok) {
      return {
        ok: false,
        refusal: refuse("invalid_request", `.metistry/scheduled.yaml does not validate, and an invalid file is never rewritten — fix it first (docs/ops/scheduled.md): ${before.errors.join("; ")}`),
      };
    }
    const doc = parseDocument(cur.text);
    const no = edit(doc, before.value);
    if (no) return { ok: false, refusal: no };
    const text = doc.toString();
    const after = parseScheduled(text);
    if (!after.ok) return { ok: false, refusal: refuse("invalid_request", `nothing was written — ${after.errors.join("; ")}`) };
    const holds = checkScheduled(after.value, units).filter((p) => p.name === name && p.holds);
    if (holds.length > 0) return { ok: false, refusal: refuse("invalid_request", `nothing was written — ${holds.map((p) => p.message).join("; ")}`) };
    if (JSON.stringify(after.value) === JSON.stringify(before.value)) return { ok: true, file: after.value, changed: false };
    if (!admin.overlay.write) return { ok: false, refusal: refuse("not_available", admin.overlay.readOnly ?? "this console cannot write .metistry/scheduled.yaml") };
    try {
      await admin.overlay.write(Buffer.from(text, "utf8"), cur.bytes === null ? "" : sha256(cur.bytes), `scheduled: ${what} (from Scheduled, as you)`);
      return { ok: true, file: after.value, changed: true };
    } catch (err) {
      if (err instanceof VaultError && err.code === "conflict") continue; // someone else's edit landed first: re-read, re-apply
      if (err instanceof VaultError && (err.code === "not_available" || err.code === "forbidden")) {
        return { ok: false, refusal: refuse("not_available", `the reconciler did not take the write to .metistry/scheduled.yaml (${err.code}): ${err.message} — nothing was written`) };
      }
      throw err;
    }
  }
  return { ok: false, refusal: refuse("not_available", ".metistry/scheduled.yaml kept changing while this was written — nothing of this change was written; try again") };
}

// ---- bodies ------------------------------------------------------------------------------

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function body(req: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; message: string }> {
  let raw: unknown;
  try {
    const bytes = await readBody(req);
    raw = bytes.length === 0 ? null : JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, message: "the body is not JSON" };
  }
  if (raw === null || raw === undefined) return { ok: true, value: {} };
  if (!isPlain(raw)) return { ok: false, message: "the body is a JSON object" };
  return { ok: true, value: raw };
}

/** A door that takes no fields (pause, resume, Run Now): `{}` or nothing, and a key is refused by name rather than ignored. */
function noFields(b: Record<string, unknown>): string | null {
  const keys = Object.keys(b);
  return keys.length === 0 ? null : `this takes no fields — ${keys.join(", ")} ${keys.length === 1 ? "is" : "are"} not read here`;
}

const issues = (err: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }, at: string): string =>
  err.issues.map((i) => `${[at, ...i.path.map(String)].filter(Boolean).join(".")}: ${i.message}`).join("; ");

// ---- a New Routine's assignment: validated once, for create and change alike -------------

/**
 * An assignment body, validated: core's closed schema (a `write:` grant is
 * refused by name — per-run grants are read-only), then its actor — a live
 * crew, since a New Routine's run is one crew run. The message names the
 * field and says nothing was written.
 */
async function validAssignment(admin: ScheduledAdmin, b: Record<string, unknown>): Promise<{ ok: true; value: RoutineAssignment } | { ok: false; message: string }> {
  const parsed = routineAssignmentSchema.safeParse(b);
  if (!parsed.success) return { ok: false, message: `${issues(parsed.error, "")} — nothing was written` };
  const a = parsed.data;
  if (!AGENT_NAME_RE.test(a.actor) || (admin.actorExists && !(await admin.actorExists(a.actor)))) {
    return {
      ok: false,
      message: `actor: no crew is named ${a.actor} — a New Routine runs as one crew run, so its actor is a crew's id (GET /api/agents, kind crew); nothing was written`,
    };
  }
  return { ok: true, value: a };
}

/** The whole assignment, written over whatever the entry held — the schedule as a flow map, the grants as one. */
function writeAssignment(doc: Document, name: string, a: RoutineAssignment): void {
  doc.setIn(["routines", name, "actor"], a.actor);
  doc.setIn(["routines", name, "task"], a.task);
  if (a.grants) doc.setIn(["routines", name, "grants"], doc.createNode(a.grants, { flow: true }));
  else drop(doc, ["routines", name, "grants"]);
  doc.setIn(["routines", name, "schedule"], scheduleNode(doc, a.schedule));
  if (a.paused !== undefined) doc.setIn(["routines", name, "paused"], a.paused);
}

/**
 * `POST /api/scheduled/routines` — **New Routine** (T3-8; reach `local`, the
 * gate in server.ts has refused anything but the local owner token). A name
 * of its own — never a manifest's, never one the file already has — and an
 * assignment `validAssignment` accepts; written as one new entry through the
 * same compare-and-swap every door here uses. 201 with the routine as
 * Scheduled lists it.
 */
async function createRoutine(req: IncomingMessage, res: ServerResponse, admin: ScheduledAdmin, deps: ScheduledDeps): Promise<void> {
  const read = await body(req);
  if (!read.ok) return sendError(res, "invalid_request", read.message);
  const { name, ...rest } = read.value;
  if (typeof name !== "string" || !SCHEDULED_NAME_RE.test(name)) {
    return sendError(res, "invalid_request", "name: a New Routine's name is lowercase kebab-case (weekly-digest) — it is its key in .metistry/scheduled.yaml; nothing was written");
  }
  const units = admin.components.map(unitOf);
  const unit = units.find((u) => u.name === name);
  if (unit) {
    return sendError(res, "conflict", `name: ${name} is ${unit.displayName}, a ${unit.section === "routines" ? "routine" : "sync"} with a manifest — a New Routine takes a name of its own; nothing was written`);
  }
  const a = await validAssignment(admin, rest);
  if (!a.ok) return sendError(res, "invalid_request", a.message);
  const r = await applyEdit(admin, units, name, `new routine ${titleOf(name)}`, (doc, file) => {
    if ((file.routines && Object.hasOwn(file.routines, name)) || (file.syncs && Object.hasOwn(file.syncs, name))) {
      return refuse("conflict", `name: .metistry/scheduled.yaml already has an entry named ${name} — PUT /api/scheduled/routines/${name}/assignment changes a New Routine; nothing was written`);
    }
    writeAssignment(doc, name, a.value);
  });
  const audit = (ok: boolean, meta: Record<string, unknown>) => deps.audit("scheduled", "create", ok, { name, ...meta });
  if (!r.ok) {
    await audit(false, { code: r.refusal.code });
    return sendJson(res, statusFor(r.refusal.code), errorEnvelope(r.refusal.code, r.refusal.message));
  }
  await audit(true, { actor: a.value.actor, grants: a.value.grants ?? null });
  const cur = await current(admin);
  const runs = await lastRuns(deps.queries, [name]);
  const l = await layers(admin, { ...cur, overlay: { ok: true, value: r.file } }, runs);
  const entry = r.file.routines![name] as RoutineAssignment;
  return sendJson(res, 201, { ok: true, routine: assignmentView(name, entry, { ...l, fileHeld: () => null }, runs, admin.runsAssignments === true), as_of: (admin.now ?? (() => new Date()))().toISOString() });
}

// ---- the routes ----------------------------------------------------------------------------

export async function scheduledRoutes(req: IncomingMessage, res: ServerResponse, key: string, deps: ScheduledDeps): Promise<void> {
  if (key === CREATE_KEY) {
    if (!deps.admin) return sendError(res, "not_available", NOT_WIRED);
    return createRoutine(req, res, deps.admin, deps);
  }
  const m = ROUTE_RE.exec(key);
  if (!m) return sendUnrouted(res);
  const [, method, section, rawName, verb] = m as unknown as [string, string, "routines" | "syncs" | undefined, string | undefined, string | undefined];
  const { admin, queries, audit } = deps;
  if (!admin) return sendError(res, "not_available", NOT_WIRED);
  const now = (): string => (admin.now ?? (() => new Date()))().toISOString();
  const fail = (r: Refusal): void => sendJson(res, statusFor(r.code), errorEnvelope(r.code, r.message));

  // GET /api/scheduled — every routine and sync
  if (!section) {
    if (method !== "GET") return sendUnrouted(res);
    const cur = await current(admin);
    const provisional = await layers(admin, cur, new Map());
    const names = [...provisional.units.map((u) => u.name), ...assignments(provisional.file, provisional.units).map(([n]) => n)];
    const runs = await lastRuns(queries, names);
    const l = await layers(admin, cur, runs);
    const views = l.units.map((u) => unitView(u, l, runs));
    const routines = [...views.filter((v): v is RoutineView => v.kind === "routine"), ...assignments(l.file, l.units).map(([n, a]) => assignmentView(n, a, l, runs, admin.runsAssignments === true))];
    routines.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return sendJson(res, 200, {
      routines,
      syncs: views.filter((v): v is SyncView => v.kind === "sync"),
      timezone: (typeof l.facts.timezone === "string" && l.facts.timezone.trim() !== "" ? l.facts.timezone : null) ?? admin.timeZone,
      problems: cur.overlay.ok ? checkScheduled(l.file, l.units) : [],
      errors: l.errors,
      as_of: now(),
    });
  }

  const name = decodeURIComponent(rawName!);
  const units = admin.components.map(unitOf);
  const unit = units.find((u) => u.name === name);
  const wanted = section === "routines" ? "routine" : "sync";
  const other = (u: ScheduledUnit): string =>
    u.section === "syncs" ? `${name} is a sync — it is /api/scheduled/syncs/${name}` : `${name} is a routine — it is /api/scheduled/routines/${name}`;

  /** The one routine or sync as the file now stands, for a read or a write's answer. */
  const viewOf = async (file?: Scheduled): Promise<RoutineView | SyncView | null> => {
    const cur = await current(admin);
    const runs = await lastRuns(queries, [name]);
    const l0 = await layers(admin, cur, runs);
    const l = file ? { ...l0, file, fileHeld: () => null, errors: [] } : l0;
    if (unit) return unitView(unit, l, runs);
    const entry = l.file.routines?.[name];
    return section === "routines" && entry !== undefined && Object.hasOwn(l.file.routines!, name) && isAssignment(entry) ? assignmentView(name, entry, l, runs, admin.runsAssignments === true) : null;
  };
  const answer = async (status: number, file: Scheduled | undefined, extra: Record<string, unknown> = {}): Promise<void> => {
    const view = await viewOf(file);
    return sendJson(res, status, { ok: true, [wanted]: view, ...extra, as_of: now() });
  };

  if (!SCHEDULED_NAME_RE.test(name)) return sendError(res, "not_found", `no ${wanted} is named ${JSON.stringify(name)} — a name is lowercase kebab-case, the manifest's`);
  if (unit && unit.section !== section) return sendError(res, "not_found", other(unit));

  // ---- reads ----
  if (method === "GET" && !verb) {
    const view = await viewOf();
    if (!view) return sendError(res, "not_found", `no ${wanted} named ${name} is scheduled here (GET /api/scheduled lists them)`);
    const rows = await history(queries, name, 50);
    return sendJson(res, 200, { [wanted]: view, history: rows.map(historyOf), as_of: now() });
  }

  // ---- everything below changes something ----
  const read = await body(req);
  if (!read.ok) return sendError(res, "invalid_request", read.message);
  const b = read.value;
  const cur = await current(admin);
  const entry = cur.overlay.ok && section === "routines" && cur.overlay.value.routines && Object.hasOwn(cur.overlay.value.routines, name) ? cur.overlay.value.routines[name] : undefined;
  const assignment = !unit && entry !== undefined && isAssignment(entry) ? entry : undefined;
  if (!unit && !assignment) {
    if (!cur.overlay.ok) return sendError(res, "invalid_request", `.metistry/scheduled.yaml does not validate, so whether it has a New Routine named ${name} cannot be read — fix the file first: ${cur.overlay.errors.join("; ")}`);
    return sendError(res, "not_found", `no ${wanted} named ${name} is scheduled here (GET /api/scheduled lists them)`);
  }
  const audited = async (tool: string, ok: boolean, meta: Record<string, unknown> = {}): Promise<void> => audit("scheduled", tool, ok, { name, ...meta });
  const done = async (tool: string, r: EditResult, extra: Record<string, unknown> = {}): Promise<void> => {
    if (!r.ok) {
      await audited(tool, false, { code: r.refusal.code });
      return fail(r.refusal);
    }
    if (r.changed) await audited(tool, true);
    return answer(200, r.file, extra);
  };

  // Run Now — a routine's or a sync's
  if (method === "POST" && verb === "run") {
    const extra = noFields(b);
    if (extra) return sendError(res, "invalid_request", extra);
    if (assignment && admin.runsAssignments !== true) return sendJson(res, 200, { ok: false, name, run_id: null, started: false, refused: { reason: "held", message: `${titleOf(name)} was not started: ${ASSIGNMENT_NOT_RUN}` } });
    if (!admin.runNow) return sendError(res, "not_available", "Run Now needs this console's runner, and it was started without one");
    const r = await admin.runNow(name);
    await audited("run", r.started, r.started ? { run_id: r.runId } : { reason: r.reason });
    if (r.started) return sendJson(res, 202, { ok: true, name, run_id: r.runId, started: true, refused: null });
    if (r.reason === "not_found") return sendError(res, "not_found", r.message);
    return sendJson(res, 200, { ok: false, name, run_id: null, started: false, refused: { reason: r.reason, message: r.message } });
  }

  // PUT /api/scheduled/syncs/:name — cadence, pause, raise toggles; never the connection
  if (section === "syncs") {
    if (!(method === "PUT" && !verb)) return sendUnrouted(res);
    for (const k of Object.keys(b)) {
      if (k === "connection") return sendError(res, "invalid_request", "connection: a sync's connection is never changed here — it is the connection's own fact (§2.6); this door sets every, paused and raise");
      if (!["every", "paused", "raise"].includes(k)) return sendError(res, "invalid_request", `${k}: a sync takes every, paused and raise`);
    }
    if (b.every !== undefined && b.every !== null && !(EVERY as readonly unknown[]).includes(b.every)) {
      return sendError(res, "invalid_request", `every: every must be one of ${EVERY.join(", ")} — ${JSON.stringify(b.every)} is not (the set is closed; null returns it to the default)`);
    }
    if (b.paused !== undefined && b.paused !== null && typeof b.paused !== "boolean") return sendError(res, "invalid_request", "paused: true, false, or null for the default");
    if (b.raise !== undefined && (!isPlain(b.raise) || Object.values(b.raise).some((v) => v !== null && typeof v !== "boolean"))) {
      return sendError(res, "invalid_request", "raise: a map of the sync's Needs You rules, each true, false, or null for the default");
    }
    const r = await applyEdit(admin, units, name, `${name}'s cadence, pause and raise toggles`, (doc, file) => {
      const existing = file.syncs && Object.hasOwn(file.syncs, name) ? file.syncs[name] : undefined;
      if (!existing) {
        return refuse(
          "invalid_request",
          `${name} names no connection in .metistry/scheduled.yaml yet (syncs.${name}.connection), and a sync's entry needs one — this door never sets the connection (§2.6). Add the entry's connection first; nothing was written`,
        );
      }
      const set = (field: string, v: unknown): void => {
        if (v === undefined) return;
        if (v === null) drop(doc, ["syncs", name, field]);
        else doc.setIn(["syncs", name, field], v);
      };
      set("every", b.every);
      set("paused", b.paused);
      if (isPlain(b.raise)) {
        for (const [rule, v] of Object.entries(b.raise)) {
          if (v === null) drop(doc, ["syncs", name, "raise", rule]);
          else doc.setIn(["syncs", name, "raise", rule], v);
        }
        const raise = doc.getIn(["syncs", name, "raise"], true);
        if (isYamlMap(raise) && raise.items.length === 0) drop(doc, ["syncs", name, "raise"]);
      }
    });
    return done("sync", r);
  }

  // ---- routines ----
  const label = unit?.displayName ?? titleOf(name);

  if (method === "PUT" && verb === "schedule") {
    const parsed = scheduleSchema.safeParse(b);
    if (!parsed.success) return sendError(res, "invalid_request", `${issues(parsed.error, "schedule")} — nothing was written`);
    const r = await applyEdit(admin, units, name, `${label}'s schedule`, (doc) => {
      doc.setIn(["routines", name, "schedule"], scheduleNode(doc, parsed.data));
    });
    return done("schedule", r);
  }

  if (method === "POST" && (verb === "pause" || verb === "resume")) {
    const extra = noFields(b);
    if (extra) return sendError(res, "invalid_request", extra);
    const r = await applyEdit(admin, units, name, `${verb} ${label}`, (doc) => {
      if (verb === "pause") doc.setIn(["routines", name, "paused"], true);
      else {
        drop(doc, ["routines", name, "paused"]);
        prune(doc, "routines", name);
      }
    });
    return done(verb, r);
  }

  if (method === "DELETE" && !verb) {
    if (assignment) {
      return sendError(res, "invalid_request", `${name} is a New Routine — it has no default to reset to. Pause it to stop it; nothing was written`);
    }
    const r = await applyEdit(admin, units, name, `reset ${label} to its default`, (doc) => {
      drop(doc, ["routines", name]);
      prune(doc, "routines", name);
    });
    return done("reset", r, r.ok ? { reset: r.changed } : {});
  }

  if (method === "PUT" && verb === "assignment") {
    // reach `local`: the gate in server.ts has already refused anything but the local owner token
    if (unit) {
      return sendError(
        res,
        "invalid_request",
        `${label} is a ${unit.section === "routines" ? "routine" : "sync"} with a manifest — what it runs is its manifest's, and a manifest is never written here. A New Routine takes a name of its own; nothing was written`,
      );
    }
    if (!assignment) return sendError(res, "not_found", `no New Routine named ${name} — a New Routine is created with POST /api/scheduled/routines`);
    const a = await validAssignment(admin, b);
    if (!a.ok) return sendError(res, "invalid_request", a.message);
    const r = await applyEdit(admin, units, name, `${label}'s actor, task and per-run grants`, (doc) => writeAssignment(doc, name, a.value));
    return done("assignment", r);
  }

  return sendUnrouted(res);
}
