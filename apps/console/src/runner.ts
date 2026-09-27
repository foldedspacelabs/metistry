// The routine runner (SHOULD-8; T3-1 made it a scheduler): schedules
// collectors and routines from their manifests ⊕ `.metistry/scheduled.yaml`,
// gates on the runs table (per-component last run — survives restarts, no
// double-run storms), executes under a two-phase runs row.
//
// TWO KINDS OF SCHEDULE (design-build-plan §2.5, docs/ops/scheduled.md):
//
//   * an INTERVAL — `{every: 5m|15m|1h|6h}`, or a legacy cron string read as
//     one (`scheduleToSeconds`, shared with the watchdog, one release) — is
//     due once that long has passed since the last run;
//   * a TIME OF DAY — `{days, at, tz?}` — is due once one of its slots has
//     passed since the last run (`dueOccurrence`, core): once, at its time,
//     in the zone the schedule, then `Me/profile.md`, then METISTRY_TZ names
//     — and never in UTC by default. Slots missed while the Mac slept are
//     coalesced into ONE run for the latest of them (launchd's rule). A
//     component that has never run counts its slots from when the runner
//     started, so a fresh install does not fire every routine at once.
//
// EVERY TICK re-reads `.metistry/scheduled.yaml` (the owner's schedule and
// pause for any component, by name) and, when a time of day follows it,
// `Me/profile.md` — so an override or a moved timezone lands on the next
// tick with no restart. An invalid overlay is never applied, and never
// replaced by the defaults either (a paused routine would run again): every
// component it names is HELD, and when it is too broken to say which, all
// of them are. Every SHIPPED manifest must parse (manifests.test.ts gates
// it in CI), but loadSchedules itself is more defensive than that: a
// manifest it cannot load or schedule is skipped and logged, not fatal — the
// console crash-looped once on an unparsed schedule, and one bad manifest
// (shipped or instance-authored) must not take every OTHER component down
// with it.
//
// Three hardening behaviours ride on the same gate (docs/ops/automation.md):
// PREFLIGHT, so a component whose credential was never set costs an
// environment lookup rather than an API call every window; a FAILURE STREAK,
// so a component that has failed N times in a row stops being run at all
// until it succeeds again; and ALERT DEDUPE by error signature, so "the
// token expired" tells you once a day instead of once an hour. Each of the
// three records ONE runs row per window — for a time of day, one per slot —
// never one per tick, and every message names the environment variable or
// manifest field that would fix it.

import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  startRun,
  finishRun,
  scheduleToSeconds,
  blockedConfigMessage,
  configuredTimeZone,
  describeSchedule,
  dueOccurrence,
  emptyScheduled,
  errorSignature,
  failureStreaks,
  intEnv,
  entryProblems,
  isAssignment,
  isInterval,
  isLegacyCron,
  longestGapSeconds,
  PROFILE_PATH,
  parseScheduled,
  preflight,
  profileFacts,
  requirementsOf,
  scheduledUnitOf,
  shouldAlert,
  signatureTag,
  streakFor,
  DEFAULT_ALERT_DEDUPE_HOURS,
  DEFAULT_MAX_STREAK,
  EVERY_SECONDS,
  PREFLIGHT_FAILED,
  RUNNER_KIND,
  SCHEDULE_HELD,
  SKIPPED_STREAK,
  WEEKDAYS,
  emptyCompute,
  type Compute,
  type ComponentStreak,
  type Manifest,
  type ManifestSchedule,
  type OccurrenceRefusal,
  type PreflightMiss,
  type ProfileFacts,
  type Requirements,
  type Scheduled,
  type ScheduledUnit,
  type TemplateQueries,
  type TemplateReader,
} from "@foldedspacelabs/metistry-core";
import type { RegisteredCollector, Db, CollectorCtx } from "@metistry-apps/collectors";
import { vaultReader, type PlanCtx, type PlanVault } from "@metistry-apps/routines";

export { scheduleToSeconds }; // one import path for the runner's callers and tests

/**
 * What the runner hands a component: every collector's ctx, plus what a
 * ROUTINE needs and no collector does — the named-query store, the vault
 * bridge (which `plan-tomorrow` renders tomorrow's plan out of,
 * docs/product/daily-flow-spec.md §7), and the `TemplateReader` adapter over
 * that same bridge (which `knowledge-fold` reads `Templates/Fold.md` and any
 * `{{ include }}` inside it through — `FoldCtx` has no `vault` field of its
 * own, only `reader`). One type rather than one per caller, so `main.ts`
 * composes the capabilities it already built for the server and hands them
 * on; a component takes the fields it declares and ignores the rest.
 */
export type ComponentCtx = CollectorCtx & PlanCtx & { reader?: TemplateReader };

/**
 * The routine-only slice of `ComponentCtx`, built ONCE here from the objects
 * `main.ts` already has — the named-query store, and, when the vault bridge
 * is up, both the vault client itself (`plan-tomorrow`'s own read/write) and
 * the `TemplateReader` adapter over it (`vaultReader`,
 * `routines/vault-reader.ts`). Absent vault → neither `vault` nor `reader`,
 * exactly like a missing calendar bridge (§6.4): every query-backed or
 * vault-backed directive renders its own "not configured" note and the file
 * still renders.
 */
export function routineCapabilities(queries: TemplateQueries, vault?: PlanVault): Pick<ComponentCtx, "queries" | "vault" | "reader"> {
  return {
    queries,
    ...(vault ? { vault, reader: vaultReader(vault) } : {}),
  };
}

export interface ScheduledCollector extends RegisteredCollector {
  /**
   * The manifest's schedule — the DEFAULT. `.metistry/scheduled.yaml` may
   * override it, and is read on every tick, so an override lands on the next
   * one with no restart. §2.5's closed shape, or — for one release — a legacy
   * cron string, read as an interval.
   */
  schedule: ManifestSchedule;
  runKind: "collector_run" | "routine_run";
  /** what the manifest says this needs before a run is worth starting (preflight) */
  requires: Requirements;
  /** the component's directory, so a refusal can name the file you would edit */
  dir: string;
  /**
   * The pinned `<provider>/<model-id>` a collector's manifest declares, if it
   * declares one. It reaches the collector THROUGH HERE rather than being a
   * constant in its `run.ts`, so the manifest stays the single statement of
   * what a component may call (invariant 5) and CI's check reads the same
   * line the runner does.
   */
  usesModel?: string;
  /**
   * What Scheduled reads off the manifest (`scheduledUnitOf`, core): the
   * section its changes live in, and the config keys and Needs You rules it
   * declares — what `.metistry/scheduled.yaml` may name for it. Absent (a
   * component built by hand): a routine under `routines`, a collector under
   * `syncs`, declaring nothing.
   */
  unit?: ScheduledUnit;
}

// ---- the owner's layers: scheduled.yaml and Me/profile.md -------------------

/**
 * `Me/profile.md` and its two facts a schedule follows — core's (T3-4), the
 * one reader the runner, `plan-tomorrow`'s working-day guard and the
 * Scheduled view share, so none of them can disagree about which days you
 * work. Re-exported so this file stays the runner's one import path.
 */
export { PROFILE_PATH, profileFacts };

/**
 * `.metistry/scheduled.yaml` as the runner reads it on a tick. `ok: false`
 * is never applied (scheduled.ts): `held` names the components the broken
 * file mentions — they are not run until it validates, because the defaults
 * are not a safe state (a paused routine would run again) — or is `"all"`
 * when the file is too broken to say which.
 */
export type OverlayRead =
  | { readonly ok: true; readonly value: Scheduled }
  | { readonly ok: false; readonly errors: readonly string[]; readonly held: "all" | readonly string[] };

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The names a file that did not validate still names. Anything it might have meant but cannot be read as — a YAML error, a key other than routines/syncs (a typo of one) — is `"all"`. */
function namedIn(text: string): "all" | string[] {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return "all";
  }
  if (!isMap(raw)) return "all";
  const names: string[] = [];
  for (const [key, section] of Object.entries(raw)) {
    if (key !== "routines" && key !== "syncs") return "all";
    if (section === null || section === undefined) continue;
    if (!isMap(section)) return "all";
    names.push(...Object.keys(section));
  }
  return names;
}

/** Read `.metistry/scheduled.yaml`. No path, or no file, is no changes (every component on its manifest's defaults). */
export async function readOverlay(path: string | null | undefined): Promise<OverlayRead> {
  if (!path) return { ok: true, value: emptyScheduled };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true, value: emptyScheduled };
    return { ok: false, errors: [`(file): cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`], held: "all" };
  }
  const r = parseScheduled(text);
  return r.ok ? { ok: true, value: r.value } : { ok: false, errors: r.errors, held: namedIn(text) };
}

type Effective =
  | { readonly held: false; readonly schedule: ManifestSchedule; readonly paused: boolean }
  | { readonly held: true; readonly why: string; /** alert per component — false when the file-level alert already covers it */ readonly alert: boolean };

/** The unit this component is under Scheduled — its manifest's, or, for one built by hand, its kind's section with nothing declared. */
function unitOf(c: ScheduledCollector): ScheduledUnit {
  return c.unit ?? { name: c.name, section: c.runKind === "routine_run" ? "routines" : "syncs", displayName: c.name, schedule: c.schedule, config: {}, raise: {} };
}

/**
 * This component's schedule and pause after the overlay: its manifest's
 * default, then its entry — `routines.<name>` for a routine or a collector
 * that presents as one (§2.5), `syncs.<name>` for a sync. An entry the
 * runner cannot apply HOLDS the component rather than being ignored (an
 * ignored entry is a change the owner made that nothing applies): a New
 * Routine named like it, an entry in the other section or in both, a config
 * key or Needs You rule its manifest does not declare (`entryProblems`,
 * core — the one statement of what an entry may name).
 */
export function effectiveSchedule(c: ScheduledCollector, overlay: OverlayRead): Effective {
  if (!overlay.ok) {
    if (overlay.held !== "all" && !overlay.held.includes(c.name)) return { held: false, schedule: c.schedule, paused: false };
    const which = overlay.held === "all" ? "it cannot be read well enough to say which components it changes" : `it names ${c.name}`;
    return { held: true, alert: false, why: `.metistry/scheduled.yaml does not validate, and ${which} — held until it does: ${overlay.errors.join("; ")}` };
  }
  const unit = unitOf(c);
  const problems = entryProblems(unit, overlay.value).filter((p) => p.holds);
  if (problems.length > 0) return { held: true, alert: true, why: problems.map((p) => p.message).join("; ") };
  const routines = overlay.value.routines;
  const syncs = overlay.value.syncs;
  const routine = unit.section === "routines" && routines !== undefined && Object.hasOwn(routines, c.name) ? routines[c.name] : undefined;
  const sync = unit.section === "syncs" && syncs !== undefined && Object.hasOwn(syncs, c.name) ? syncs[c.name] : undefined;
  // entryProblems has refused a New Routine under this name, so a routine entry here is an override
  if (routine !== undefined && !isAssignment(routine)) return { held: false, schedule: routine.schedule ?? c.schedule, paused: routine.paused ?? false };
  if (sync !== undefined) return { held: false, schedule: sync.every !== undefined ? { every: sync.every } : c.schedule, paused: sync.paused ?? false };
  return { held: false, schedule: c.schedule, paused: false };
}

// ---- options ------------------------------------------------------------------

export interface RunnerOptions {
  /** the install's environment — preflight reads the declared variables from it */
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  /** consecutive failures after which a component stops being run (METISTRY_RUNNER_MAX_STREAK) */
  maxStreak?: number;
  /** how long one (component, error signature) stays quiet after alerting (METISTRY_ALERT_DEDUPE_H) */
  alertDedupeHours?: number;
  /**
   * The budget half of preflight (C5: `stop` pauses routines too). Asked only
   * of a component that declares `requires.engine`, so a model-free collector
   * never pays for the lookup. Absent = no budget pause at all, which is what
   * an install with no `budgets:` block gets.
   */
  budget?: () => Promise<PreflightMiss | null>;
  /**
   * `compute.yaml` in force, for the `requires.engine` half of preflight
   * (C2/C3): a routine that would enqueue an assistant turn is not started
   * when nothing assigns a default, because nothing would answer it. A
   * function, not a value, so a hot reload takes effect on the next window.
   */
  compute?: () => Compute;
  /**
   * `.metistry/scheduled.yaml`, read on EVERY tick (`readOverlay`). Absent =
   * no changes: every component on its manifest's defaults.
   */
  scheduled?: () => Promise<OverlayRead>;
  /**
   * `Me/profile.md`'s facts (`profileFacts`), read at most once a tick and
   * only when a time of day follows the profile — a day set, or no `tz`. A
   * read that THROWS (the vault bridge is down) is not "the profile says
   * nothing": those components wait for a tick that can read it, rather
   * than being refused for a fact that was only unreachable. Absent = the
   * profile says nothing.
   */
  profile?: () => Promise<ProfileFacts>;
  /** The zone a time of day falls back to — METISTRY_TZ (`configuredTimeZone`), never TZ. Default: read from `env`. `null` = none. */
  timeZone?: string | null;
  /**
   * When this runner started. A time-of-day component that has never run
   * counts its slots from here — so a fresh install does not fire every
   * routine at once, and the first slot after start runs at its time.
   * Default: `now`.
   */
  startedAt?: Date;
  /** injected by tests; production always uses the wall clock */
  now?: Date;
}

interface ResolvedOptions {
  env: NodeJS.ProcessEnv;
  fetchFn: typeof fetch;
  maxStreak: number;
  alertDedupeHours: number;
  budget?: (() => Promise<PreflightMiss | null>) | undefined;
  compute: () => Compute;
  scheduled: () => Promise<OverlayRead>;
  profile: () => Promise<ProfileFacts>;
  timeZone: string | null;
  now: Date;
  startedAt: Date;
}

const NO_OVERLAY = async (): Promise<OverlayRead> => ({ ok: true, value: emptyScheduled });
const NO_PROFILE = async (): Promise<ProfileFacts> => ({});

function resolve(opts: RunnerOptions): ResolvedOptions {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  return {
    env,
    fetchFn: opts.fetchFn ?? fetch,
    maxStreak: opts.maxStreak ?? intEnv("METISTRY_RUNNER_MAX_STREAK", DEFAULT_MAX_STREAK, env),
    alertDedupeHours: opts.alertDedupeHours ?? intEnv("METISTRY_ALERT_DEDUPE_H", DEFAULT_ALERT_DEDUPE_HOURS, env),
    ...(opts.budget ? { budget: opts.budget } : {}),
    compute: opts.compute ?? emptyCompute,
    scheduled: opts.scheduled ?? NO_OVERLAY,
    profile: opts.profile ?? NO_PROFILE,
    timeZone: opts.timeZone !== undefined ? opts.timeZone : configuredTimeZone(env),
    now,
    startedAt: opts.startedAt ?? now,
  };
}

/**
 * A collector or routine as its registry loaded it (plan §2.7): the manifest
 * in force — the product's, or the owner's extension that replaced it — and
 * the product code that runs it (collectors/index.ts, routines/index.ts).
 */
export interface ComponentUnit {
  name: string;
  manifest: Manifest;
  /** the manifest file in force, so a refusal can name the file you would edit */
  path: string;
  run: RegisteredCollector["run"];
}

/**
 * The schedule of every loaded unit. The registry has already validated each
 * manifest and skipped what it could not load, with the reason; what is left
 * to refuse here is a schedule this build's `scheduleToSeconds` cannot parse
 * — skipped and logged the same way, never fatal, so one bad manifest
 * (shipped or the owner's) cannot take every OTHER component down with it.
 * Most frequent first.
 */
export async function loadSchedules(units: readonly ComponentUnit[]): Promise<ScheduledCollector[]> {
  const out: ScheduledCollector[] = [];
  for (const u of units) {
    const dir = dirname(u.path);
    try {
      const m = u.manifest;
      if (m.type !== "collector" && m.type !== "routine") throw new Error(`not schedulable (type ${m.type})`);
      if (m.schedule === undefined) throw new Error(`no schedule`);
      if (isLegacyCron(m.schedule)) scheduleToSeconds(m.schedule); // throws on a cron this build cannot read as an interval
      const unit = scheduledUnitOf(m);
      out.push({
        name: u.name,
        run: u.run,
        dir,
        schedule: m.schedule,
        requires: requirementsOf(m),
        runKind: m.type === "routine" ? "routine_run" : "collector_run",
        ...(unit ? { unit } : {}),
        ...(m.type === "collector" && m.uses_model ? { usesModel: m.uses_model } : {}),
      });
    } catch (e) {
      console.warn(`${u.name}: skipped — ${(e as Error).message} (fix ${u.path})`);
    }
  }
  // A tick runs what is due one after another, so order is latency: the
  // most frequent component first (inbox-drain, every five minutes, is what
  // a capture waits on), then by name — a rule, where the old static list
  // had an order nobody wrote down. "Frequent" is the manifest default's
  // widest gap (`longestGapSeconds`, the watchdog's bound): an interval is
  // its own length, and a time of day — a day or more — sorts after every
  // interval. Order is fixed at load; a `.metistry/scheduled.yaml` override
  // changes when a component is due, not where it sits in a tick.
  const gap = new Map(out.map((c) => [c, longestGapSeconds(c.schedule)]));
  return out.sort((a, b) => gap.get(a)! - gap.get(b)! || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---- bookkeeping rows (one per window, never one per tick) -----------------

interface Windows {
  lastRun: number;
  /** the latest slot a run has been started FOR (`meta.scheduled_for`) — the anchor a clock skew between this process and Postgres cannot move */
  lastSlot: number;
  lastRefused: number;
  lastSkip: number;
  lastPreflight: number;
  lastHeld: number;
}

const millis = (v: unknown): number => (v ? new Date(String(v)).getTime() : 0);

/**
 * Every timestamp the gate needs, in one round trip: when this component
 * last ran, the latest slot a run was started for, when it last recorded a
 * refused schedule, and when it last recorded a skipped, blocked-config or
 * held window. The marker rows carry `kind = 'runner'` precisely so they are
 * invisible to the due-gate and to the streak — they are the runner's
 * bookkeeping, not the component's work.
 */
async function windowsFor(db: Db, c: ScheduledCollector): Promise<Windows> {
  const { rows } = await db.query(
    `SELECT max(ts) FILTER (WHERE kind = $2) AS last_run,
            max(CASE WHEN kind = $2 AND meta->>'scheduled_for' ~ '^\\d{4}-\\d{2}-\\d{2}T'
                     THEN (meta->>'scheduled_for')::timestamptz END) AS last_slot,
            max(ts) FILTER (WHERE kind = $2 AND meta->>'schedule_refused' IS NOT NULL) AS last_refused,
            max(ts) FILTER (WHERE kind = $3 AND tool = $4) AS last_skip,
            max(ts) FILTER (WHERE kind = $3 AND tool = $5) AS last_preflight,
            max(ts) FILTER (WHERE kind = $3 AND tool = $6) AS last_held
     FROM runs WHERE component = $1`,
    [c.name, c.runKind, RUNNER_KIND, SKIPPED_STREAK, PREFLIGHT_FAILED, SCHEDULE_HELD],
  );
  const r = rows[0] ?? {};
  return {
    lastRun: millis(r.last_run),
    lastSlot: millis(r.last_slot),
    lastRefused: millis(r.last_refused),
    lastSkip: millis(r.last_skip),
    lastPreflight: millis(r.last_preflight),
    lastHeld: millis(r.last_held),
  };
}

/** One failed `runner` row naming what was not done and why. */
async function recordRunnerRow(
  db: Db,
  c: ScheduledCollector,
  tool: string,
  error: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const id = await startRun(db, { component: c.name, kind: RUNNER_KIND, tool, meta: { run_kind: c.runKind, ...meta } });
  await finishRun(db, id, { ok: false, error });
}

/**
 * Raise a Needs You item for this (component, signature), unless the same
 * signature already alerted inside the window and the streak has not been
 * broken since. The signature rides in the text as `[sig:…]` — that is the
 * dedupe key AND the handle a future ack would name; `outbound_messages` is
 * the path the watchdog's alerts already take, so the notifier pushes these
 * with no new row kind and nothing new for the PWA to render.
 */
async function raiseAlert(
  db: Db,
  opts: ResolvedOptions,
  a: { signature: string; text: string; streakSince: Date | null },
): Promise<boolean> {
  const tag = signatureTag(a.signature);
  const { rows } = await db.query(
    `SELECT max(ts) AS ts FROM outbound_messages WHERE kind = 'alert' AND position($1 in text) > 0`,
    [tag],
  );
  const lastAlertAt = rows[0]?.ts ? new Date(String(rows[0].ts)) : null;
  if (!shouldAlert({ lastAlertAt, streakSince: a.streakSince, now: opts.now, windowHours: opts.alertDedupeHours })) {
    return false;
  }
  await db.query(`INSERT INTO outbound_messages (thread, text, kind) VALUES ('default', $1, 'alert')`, [`${a.text} ${tag}`]);
  return true;
}

const clip = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** How often a held component or a refused schedule is recorded again while it stays that way. */
const RECORD_AGAIN_MS = 24 * 3_600_000;

/**
 * A schedule the runner could not place — `no_working_days`, `no_timezone`,
 * `unknown_timezone` (§2.5; D7's `skipped:<reason>`). Recorded as the
 * component's OWN kind of row, `ok` — nothing failed, the component was not
 * run — so a routine's history and Activity show the absent skip, and the
 * watchdog sees the runner is alive. A routine's row carries `meta.outcome`;
 * a collector's does not (that vocabulary is the routines'). Once a day
 * while it lasts, never once a tick; no alert — it is a fact about the
 * profile, not a fault.
 */
async function recordRefused(db: Db, c: ScheduledCollector, reason: OccurrenceRefusal, why: string, schedule: ManifestSchedule): Promise<void> {
  const id = await startRun(db, {
    component: c.name,
    kind: c.runKind,
    meta: {
      schedule_refused: reason,
      why,
      schedule: describeSchedule(schedule),
      ...(c.runKind === "routine_run" ? { outcome: `skipped:${reason}` } : {}),
    },
  });
  await finishRun(db, id, { ok: true });
}

// ---- when is it due ------------------------------------------------------------

type Slot =
  | { readonly due: false }
  | {
      readonly due: true;
      /** the slot this run is for — null for an interval, which has none */
      readonly scheduledFor: Date | null;
      readonly timeZone: string | null;
      /** has a runner marker already been recorded for THIS window? — an interval's length, or since the slot */
      readonly recorded: (lastMarker: number) => boolean;
    }
  | { readonly due: "refused"; readonly reason: OccurrenceRefusal; readonly why: string }
  | { readonly due: "wait"; readonly why: string };

type ProfileRead = { readonly ok: true; readonly facts: ProfileFacts } | { readonly ok: false; readonly why: string };

async function slotFor(schedule: ManifestSchedule, w: Windows, opts: ResolvedOptions, profile: () => Promise<ProfileRead>): Promise<Slot> {
  const now = opts.now.getTime();
  if (isLegacyCron(schedule) || isInterval(schedule)) {
    const windowMs = (isLegacyCron(schedule) ? scheduleToSeconds(schedule) : EVERY_SECONDS[schedule.every]) * 1000;
    if (now - w.lastRun < windowMs) return { due: false };
    return { due: true, scheduledFor: null, timeZone: null, recorded: (last) => now - last < windowMs };
  }
  let facts: ProfileFacts = {};
  if (typeof schedule.days === "string" || schedule.tz === undefined) {
    const p = await profile();
    if (!p.ok) return { due: "wait", why: p.why };
    facts = p.facts;
  }
  const ran = Math.max(w.lastRun, w.lastSlot);
  const anchor = ran > 0 ? ran : opts.startedAt.getTime();
  const owed = dueOccurrence(schedule, new Date(anchor), opts.now, { profile: facts, fallbackTimeZone: opts.timeZone });
  if (owed === null) return { due: false };
  if (!owed.ok) return { due: "refused", reason: owed.reason, why: owed.why };
  const slot = owed.at.getTime();
  return { due: true, scheduledFor: owed.at, timeZone: owed.timeZone, recorded: (last) => last >= slot };
}

// ---- the tick --------------------------------------------------------------

/**
 * Run every component that is due — each at most once a tick, under its
 * manifest's schedule as `.metistry/scheduled.yaml` changes it.
 */
export async function tick(db: Db, scheduled: ScheduledCollector[], ctx: ComponentCtx = {}, options: RunnerOptions = {}): Promise<void> {
  const opts = resolve(options);
  const streaks: ComponentStreak[] = await failureStreaks(db);

  const overlay = await opts.scheduled();
  if (!overlay.ok) {
    const held = overlay.held === "all" ? "every scheduled component is" : overlay.held.length === 0 ? "nothing it names is scheduled here, so nothing is" : `${overlay.held.join(", ")} ${overlay.held.length === 1 ? "is" : "are"}`;
    const told = await raiseAlert(db, opts, {
      signature: errorSignature("scheduled.yaml", overlay.errors.join("\n")),
      streakSince: null,
      text:
        `.metistry/scheduled.yaml does not validate, so it is not applied — and ${held} held rather than run on defaults: ` +
        `${clip(overlay.errors.join("; "), 160)}. Fix the file (docs/ops/scheduled.md) and the next tick picks it up`,
    });
    // logged when it is news (a new fault, or a day on), not once a minute
    if (told) console.warn(`runner: .metistry/scheduled.yaml does not validate — ${held} held: ${overlay.errors.join("; ")}`);
  }

  // Me/profile.md, at most once a tick and only if a time of day follows it.
  let profileRead: Promise<ProfileRead> | undefined;
  const profile = (): Promise<ProfileRead> =>
    (profileRead ??= opts.profile().then(
      (facts): ProfileRead => ({ ok: true, facts }),
      (err): ProfileRead => {
        const why = `${PROFILE_PATH} could not be read (${err instanceof Error ? err.message : String(err)})`;
        console.warn(`runner: ${why} — schedules that follow it wait for the next tick`);
        return { ok: false, why };
      },
    ));

  for (const c of scheduled) {
    // 0. the owner's layer: paused (their choice — no run, and no row a tick)
    // or held (an entry that cannot be applied, recorded once a day)
    const eff = effectiveSchedule(c, overlay);
    if (!eff.held && eff.paused) continue;
    const windows = await windowsFor(db, c);
    if (eff.held) {
      if (opts.now.getTime() - windows.lastHeld >= RECORD_AGAIN_MS) {
        await recordRunnerRow(db, c, SCHEDULE_HELD, `${c.name} held: ${eff.why}`, {});
        if (eff.alert) await raiseAlert(db, opts, { signature: errorSignature(`${c.name}/${SCHEDULE_HELD}`, eff.why), streakSince: null, text: `${c.name} is not being run: ${eff.why}` });
      }
      continue;
    }

    const slot = await slotFor(eff.schedule, windows, opts, profile);
    if (slot.due === false || slot.due === "wait") continue;
    if (slot.due === "refused") {
      if (opts.now.getTime() - windows.lastRefused >= RECORD_AGAIN_MS) {
        console.log(`${c.name}: not scheduled — ${slot.why}`);
        await recordRefused(db, c, slot.reason, slot.why, eff.schedule);
      }
      continue;
    }

    // 1. the streak: N consecutive failures and the runner stops spending on it
    const streak = streakFor(streaks, c.name, c.runKind);
    if (streak && streak.count >= opts.maxStreak) {
      if (!slot.recorded(windows.lastSkip)) {
        const lastError = streak.lastError ?? "(none recorded)";
        await recordRunnerRow(
          db,
          c,
          SKIPPED_STREAK,
          `${c.name} skipped: ${streak.count} consecutive failed runs since ${streak.since.toISOString()} ` +
            `(limit METISTRY_RUNNER_MAX_STREAK = ${opts.maxStreak}) — last error: ${clip(lastError)}`,
          { streak: streak.count, max_streak: opts.maxStreak, error_signature: streak.signature, since: streak.since.toISOString() },
        );
        await raiseAlert(db, opts, {
          signature: errorSignature(`${c.name}/${SKIPPED_STREAK}`, lastError),
          streakSince: streak.since,
          text:
            `${c.name} is no longer being run: ${streak.count} failures in a row (limit METISTRY_RUNNER_MAX_STREAK = ${opts.maxStreak}). ` +
            `Fix the cause — ${clip(lastError, 80)} — and the next successful run clears it; ` +
            `raise METISTRY_RUNNER_MAX_STREAK to keep trying, or remove \`schedule\` from ${c.dir}/manifest.yaml to retire it`,
        });
      }
      continue;
    }

    // 2. preflight: never spend a window on a component that cannot succeed
    const pre = await preflight(c.requires, { env: opts.env, compute: opts.compute(), fetchFn: opts.fetchFn, ...(opts.budget ? { budget: opts.budget } : {}) });
    if (!pre.ok) {
      if (!slot.recorded(windows.lastPreflight)) {
        const message = blockedConfigMessage(c.name, c.dir, pre);
        await recordRunnerRow(db, c, PREFLIGHT_FAILED, message, { missing: pre.missing.map((m) => m.name) });
        await raiseAlert(db, opts, {
          signature: errorSignature(`${c.name}/${PREFLIGHT_FAILED}`, pre.missing.map((m) => m.name).join(",")),
          streakSince: null,
          text: message,
        });
      }
      continue;
    }

    // 3. the run itself — plus the slot it is for, on the row from the start
    // (an overlapping tick sees the in-flight row and its slot) and in the
    // ctx, so a late run after the Mac slept still plans and dates from its
    // slot rather than from the moment it woke
    const slotMeta = slot.scheduledFor ? { scheduled_for: slot.scheduledFor.toISOString(), time_zone: slot.timeZone } : undefined;
    const runId = await startRun(db, { component: c.name, kind: c.runKind, ...(slotMeta ? { meta: slotMeta } : {}) });
    const runCtx: ComponentCtx = {
      ...ctx,
      ...(c.usesModel ? { usesModel: c.usesModel } : {}),
      ...(slot.scheduledFor ? { scheduledFor: slot.scheduledFor } : {}),
      ...(slot.timeZone ? { timeZone: slot.timeZone } : {}),
    };
    try {
      const n = await c.run(db, runCtx);
      // T1-4: every routine_run row carries meta.outcome — acted or silent,
      // from the same count the routine already returns — so the activity
      // feed (T1-3) can tell a real event from a run that found nothing to
      // do. A routine that skips for a specific reason (rather than finding
      // nothing) writes ITS OWN row saying so (plan-tomorrow, knowledge-fold)
      // — this generic row only ever knows "acted" or "silent" from the
      // count. Collector rows are unaffected: a collector reports items
      // processed, not an assistant-facing outcome.
      const meta: Record<string, unknown> = c.runKind === "routine_run" ? { processed: n, outcome: n > 0 ? "acted" : "silent" } : { processed: n };
      await finishRun(db, runId, { ok: true, meta });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const signature = errorSignature(c.name, error);
      await finishRun(db, runId, { ok: false, error, meta: { error_signature: signature } });
      const count = (streak?.count ?? 0) + 1;
      await raiseAlert(db, opts, {
        signature,
        streakSince: streak?.since ?? opts.now,
        text:
          `${c.name} failed ${count} run(s) in a row: ${clip(error, 100)}. ` +
          `Fix it, or remove \`schedule\` from ${c.dir}/manifest.yaml to retire it; ` +
          `after METISTRY_RUNNER_MAX_STREAK (${opts.maxStreak}) failures in a row the runner stops running it`,
      });
    }
  }
}

/**
 * Tick every `everyMs` (METISTRY_RUNNER_TICK_MS, a minute): a slot fires on
 * the first tick at or after it. `startedAt` is fixed here, once, so a
 * component that has never run counts its slots from this process's start.
 * A tick still running when the next is due is not overlapped — the next
 * one simply waits its turn.
 */
export function startRunner(
  db: Db,
  scheduled: ScheduledCollector[],
  ctx: ComponentCtx = {},
  everyMs = 60_000,
  options: RunnerOptions = {},
): NodeJS.Timeout {
  const startedAt = options.startedAt ?? new Date();
  let busy = false;
  return setInterval(() => {
    if (busy) return;
    busy = true;
    tick(db, scheduled, ctx, { ...options, startedAt })
      .catch((e) => console.error("runner:", e))
      .finally(() => {
        busy = false;
      });
  }, everyMs);
}
