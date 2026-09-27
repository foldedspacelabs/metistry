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
//
// EVENTS BECOME REQUESTS (C96, T2-9): the alert is a push; what the owner
// answers is a Needs You request. A routine that fails raises one `report`
// per error signature, with two timestamps (when it last succeeded, when it
// failed), and it clears itself the next time the routine succeeds. A secret
// that is missing raises ONE `secret_failure` request (read as access)
// naming every component it stopped, and it clears itself once the secret is
// set. Both are mirrors of this instance's own state (core's `raiseMirror`),
// so a waiting one is never raised twice, and one the owner answered is not
// raised again until what it was about has recovered.
//
// THREE STRIKES AND A STOP LIMIT (C135, C133, T3-12). A component that fails
// three times in a row (METISTRY_RUNNER_MAX_STREAK, default 3) stops being
// run and raises ONE request per (component, error signature) per streak: a
// routine's waiting failure report is turned into the stop rather than joined
// by a second row; a collector, which raises nothing for a single failure,
// raises its stop as a `report` of its own. A budget whose action is `stop`
// pauses every routine that would enqueue a turn (preflight, C5) and raises
// ONE `report` per budget window, naming every routine it paused; it clears
// itself when the window resets or the limit moves.

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
  SCHEDULED_KINDS,
  emptyCompute,
  raiseMirror,
  redactSecrets,
  resolveAtSource,
  budgetRefusalMessage,
  budgetWindowKey,
  type BudgetHit,
  type BudgetMiss,
  type Compute,
  type ComponentStreak,
  type ConfigValue,
  type Manifest,
  type ManifestSchedule,
  type OccurrenceRefusal,
  type PreflightMiss,
  type PreflightResult,
  type ProfileFacts,
  type RequestSource,
  type Requirements,
  type Scheduled,
  type ScheduledUnit,
  type TemplateQueries,
  type TemplateReader,
} from "@foldedspacelabs/metistry-core";
import type { RegisteredCollector, Db, CollectorCtx } from "@metistry-apps/collectors";
import { vaultReader, type PlanCtx, type PlanVault, type UpdateCheckCtx } from "@metistry-apps/routines";

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
export type ComponentCtx = CollectorCtx &
  PlanCtx &
  UpdateCheckCtx & {
    reader?: TemplateReader;
    /**
     * A routine's resolved Scheduled config — every key its manifest
     * declares, the owner's value from `routines.<name>.config` in
     * `.metistry/scheduled.yaml` over the manifest's default (§2.5). Handed
     * on per run, from the same overlay read that decided the run was due;
     * absent for a component that declares no config.
     */
    config?: Readonly<Record<string, ConfigValue>>;
  };

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
  /** Where its manifest came from (plan §2.7): the product's, or the owner's extension. Absent = product. */
  origin?: "product" | "extension";
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
  return overlayFromText(text);
}

/** The overlay as the runner applies it, from the file's text — one reading for the runner and the Scheduled doors (scheduled-routes.ts). */
export function overlayFromText(text: string): OverlayRead {
  const r = parseScheduled(text);
  return r.ok ? { ok: true, value: r.value } : { ok: false, errors: r.errors, held: namedIn(text) };
}

type Effective =
  | {
      readonly held: false;
      readonly schedule: ManifestSchedule;
      readonly paused: boolean;
      /** The resolved config — each declared key, the owner's value over the manifest's default. Empty when the component declares none. */
      readonly config: Readonly<Record<string, ConfigValue>>;
    }
  | { readonly held: true; readonly why: string; /** alert per component — false when the file-level alert already covers it */ readonly alert: boolean };

/** The unit this component is under Scheduled — its manifest's, or, for one built by hand, its kind's section with nothing declared. */
export function unitOf(c: ScheduledCollector): ScheduledUnit {
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
    if (overlay.held !== "all" && !overlay.held.includes(c.name)) return { held: false, schedule: c.schedule, paused: false, config: resolvedConfig(unitOf(c), undefined) };
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
  if (routine !== undefined && !isAssignment(routine)) {
    return { held: false, schedule: routine.schedule ?? c.schedule, paused: routine.paused ?? false, config: resolvedConfig(unit, routine.config) };
  }
  if (sync !== undefined) return { held: false, schedule: sync.every !== undefined ? { every: sync.every } : c.schedule, paused: sync.paused ?? false, config: resolvedConfig(unit, undefined) };
  return { held: false, schedule: c.schedule, paused: false, config: resolvedConfig(unit, undefined) };
}

/**
 * Every config key the manifest declares, the owner's value over its
 * default. `entryProblems` has already held a component whose entry names
 * an undeclared key or a value of the wrong kind, so what is here applies
 * as written.
 */
function resolvedConfig(unit: ScheduledUnit, mine: Readonly<Record<string, ConfigValue>> | undefined): Readonly<Record<string, ConfigValue>> {
  const out: Record<string, ConfigValue> = {};
  for (const [key, field] of Object.entries(unit.config)) {
    out[key] = mine !== undefined && Object.hasOwn(mine, key) ? mine[key]! : field.default;
  }
  return out;
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
   * an install with no `budgets:` block gets. A miss that carries its `hit`
   * (core's `budgetMiss`) also raises the one Stop-limit request (C133), and
   * is asked again on a later tick only while that request waits, to clear
   * it once the budget no longer stops anything.
   */
  budget?: () => Promise<PreflightMiss | BudgetMiss | null>;
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
  /**
   * Where a failed routine and a missing secret become Needs You requests
   * (C96). Default: `runnerRequests` over the runner's own `db`. `null`
   * raises none — for a caller whose `db` has no `proposals` table, which
   * no install is.
   */
  requests?: RunnerRequests | null;
  /** injected by tests; production always uses the wall clock */
  now?: Date;
}

interface ResolvedOptions {
  env: NodeJS.ProcessEnv;
  fetchFn: typeof fetch;
  maxStreak: number;
  alertDedupeHours: number;
  budget?: (() => Promise<PreflightMiss | BudgetMiss | null>) | undefined;
  compute: () => Compute;
  scheduled: () => Promise<OverlayRead>;
  profile: () => Promise<ProfileFacts>;
  timeZone: string | null;
  requests: RunnerRequests | null;
  now: Date;
  startedAt: Date;
}

const NO_OVERLAY = async (): Promise<OverlayRead> => ({ ok: true, value: emptyScheduled });
const NO_PROFILE = async (): Promise<ProfileFacts> => ({});

function resolve(db: Db, opts: RunnerOptions): ResolvedOptions {
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
    requests: opts.requests !== undefined ? opts.requests : runnerRequests(db),
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
  /** Where the manifest came from — the registry's `origin`. Absent = product. */
  origin?: "product" | "extension";
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
        ...(u.origin ? { origin: u.origin } : {}),
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
  const opts = resolve(db, options);
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

  // every secret a preflight found missing this tick, and what it stopped —
  // raised as one request per secret once the whole tick has been seen
  const secretMisses = new Map<string, { why: string; stopped: Set<string> }>();
  // every budget that paused a routine this tick, and which routines (C133)
  const budgetStops = new Map<string, BudgetStop>();

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
        // stopped before this process saw the third failure (a restart, a
        // lowered limit): the same one request — a no-op when it is raised
        await tell(opts, (r) => r.componentStopped(stopOf(c, streak.count, streak.since, lastError, streak.signature, null, opts)));
      }
      continue;
    }

    // 2. preflight: never spend a window on a component that cannot succeed
    let budgetHit: BudgetHit | undefined;
    const askBudget = opts.budget;
    const budget = askBudget
      ? async (): Promise<PreflightMiss | null> => {
          const miss = await askBudget();
          if (miss && "hit" in miss) budgetHit = miss.hit;
          return miss;
        }
      : undefined;
    const pre = await preflight(c.requires, { env: opts.env, compute: opts.compute(), fetchFn: opts.fetchFn, ...(budget ? { budget } : {}) });
    if (!pre.ok) {
      noteSecretMisses(secretMisses, c, pre);
      if (budgetHit) noteBudgetStop(budgetStops, c, budgetHit, opts.now);
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
      ...componentCtx(c, ctx, eff.config),
      ...(slot.scheduledFor ? { scheduledFor: slot.scheduledFor } : {}),
      ...(slot.timeZone ? { timeZone: slot.timeZone } : {}),
    };
    await execute(db, c, runId, runCtx, streak, opts);
  }

  if (secretMisses.size > 0) {
    const failures = [...secretMisses].map(([name, m]) => ({ name, why: m.why, stopped: [...m.stopped].sort() }));
    await tell(opts, (r) => r.secretsFailed(failures, opts.now));
  }
  await tell(opts, (r) => r.secretsRestored((name) => (opts.env[name] ?? "").trim() !== ""));

  if (budgetStops.size > 0) await tell(opts, (r) => r.budgetStopped([...budgetStops.values()]));
  // a waiting Stop-limit request clears once its budget no longer stops the
  // routines — asked again only while one waits, so an install whose budget
  // is fine pays for no spend query on a tick that runs no routine
  const askBudget = opts.budget;
  if (askBudget) {
    await tell(opts, (r) =>
      r.budgetResumed(async () => {
        const miss = await askBudget();
        if (miss === null) return null;
        return "hit" in miss ? budgetStopKey(miss.hit, opts.now) : undefined;
      }),
    );
  }
}

/** A component's stop, as the requests seam takes it. */
function stopOf(c: ScheduledCollector, failures: number, since: Date, error: string, signature: string, runId: number | null, opts: ResolvedOptions): ComponentStop {
  return { component: c.name, title: unitOf(c).displayName, runKind: c.runKind, failures, limit: opts.maxStreak, since, error, signature, runId, stoppedAt: opts.now };
}

/** A budget's pause this tick: one per budget window, every routine it paused named once. */
function noteBudgetStop(into: Map<string, BudgetStop>, c: ScheduledCollector, hit: BudgetHit, now: Date): void {
  const key = budgetStopKey(hit, now);
  const seen = into.get(key) ?? { key, hit, paused: [], at: now };
  if (!seen.paused.includes(c.name)) into.set(key, { ...seen, paused: [...seen.paused, c.name].sort() });
}

/**
 * The preflight misses that are a SECRET — a declared variable or the
 * engine's `auth.secret` that is unset. Not a `reachable` URL (a bridge that
 * is down is not a credential) and not a miss that carries its own `fix`
 * (compute.yaml assigns nothing, a budget stopped it): those are not the
 * owner's secret to set, and the budget stop has a request of its own (C133).
 */
function noteSecretMisses(into: Map<string, { why: string; stopped: Set<string> }>, c: ScheduledCollector, pre: PreflightResult): void {
  for (const m of pre.missing) {
    if (m.fix !== undefined || c.requires.reachable.includes(m.name)) continue;
    const seen = into.get(m.name) ?? { why: m.why, stopped: new Set<string>() };
    seen.stopped.add(c.name);
    into.set(m.name, seen);
  }
}

/** Raise or clear through `opts.requests`. A queue write that fails is logged and never costs the tick: the run row and the alert already hold the fact. */
async function tell(opts: ResolvedOptions, act: (r: RunnerRequests) => Promise<unknown>): Promise<void> {
  if (opts.requests === null) return;
  try {
    await act(opts.requests);
  } catch (err) {
    console.error(`runner: a Needs You request could not be written — ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- events become requests (C96, T2-9) ---------------------------------------

/** The source system of every request the runner raises: the subject is this instance's own — its runs, its secrets. */
export const RUNNER_SOURCE_KIND = "metistry";
/** What raises them: this process, never an agent. */
export const RUNNER_AGENT = "runner";
/** A failed routine is a `report` (§2.12): an excerpt, its act, Dismiss. */
export const ROUTINE_FAILED_KIND = "report";
/** A missing secret is access (§2.12), stored as its own kind — `access_request`'s Approve is a grants write for an area, and a secret names none. */
export const SECRET_FAILED_KIND = "secret_failure";
/** A collector that stopped after three strikes (C135) is a `report` too — its only request: a single failure raises none. */
export const COLLECTOR_FAILED_KIND = "report";
/** A budget whose action is `stop` paused the routines (C133): a `report` (C96), whose act is Raise. */
export const BUDGET_STOPPED_KIND = "report";
/** `payload.event` — what raised the request, for a client drawing it and for the doors that answer it. */
export const ROUTINE_FAILED_EVENT = "routine_failed";
export const SECRET_FAILED_EVENT = "secret_failed";
export const COLLECTOR_FAILED_EVENT = "collector_failed";
export const BUDGET_STOPPED_EVENT = "budget_stopped";
/** How much of a failed run's error the report carries — the run row has all of it. */
export const ROUTINE_ERROR_EXCERPT = 600; // limit: fixed — an excerpt a phone can show without scrolling; Activity has the run

const ROUTINE_REF = "routine-failed:";
const SECRET_REF = "secret:";
const COLLECTOR_REF = "collector-failed:";
const BUDGET_REF = "budget-stop:";

/** One request per (routine, error signature): the same fault again is the same subject, a different fault is news. */
export function routineFailedSource(component: string, signature: string): RequestSource {
  return { kind: RUNNER_SOURCE_KIND, external_ref: `${ROUTINE_REF}${component}#${signature}` };
}

/** One request per secret, however many components it stopped. */
export function secretFailedSource(name: string): RequestSource {
  return { kind: RUNNER_SOURCE_KIND, external_ref: `${SECRET_REF}${name}` };
}

/** A collector's three strikes: one request per (collector, error signature), as a routine's failure is. */
export function collectorFailedSource(component: string, signature: string): RequestSource {
  return { kind: RUNNER_SOURCE_KIND, external_ref: `${COLLECTOR_REF}${component}#${signature}` };
}

/**
 * `<scope>:<window>:<calendar window>@<limit>` — one Stop-limit request per
 * budget window. The limit is in the key so a raised limit that is spent
 * again the same day is news, not the answered request of the old limit.
 */
export function budgetStopKey(hit: BudgetHit, now: Date): string {
  return `${budgetWindowKey(hit, now)}@${hit.limit}`;
}

/** One request per budget window, however many routines it paused. */
export function budgetStoppedSource(key: string): RequestSource {
  return { kind: RUNNER_SOURCE_KIND, external_ref: `${BUDGET_REF}${key}` };
}

export interface RoutineFailure {
  readonly component: string;
  /** The name the owner reads (the manifest's display name). */
  readonly title: string;
  readonly runId: number;
  readonly error: string;
  readonly signature: string;
  readonly failedAt: Date;
}

export interface SecretFailure {
  /** The variable that is unset — the name the owner sets. */
  readonly name: string;
  readonly why: string;
  /** Every component it stopped this tick, by name. */
  readonly stopped: readonly string[];
}

/** A component the runner has stopped running: its streak reached the limit (C135). */
export interface ComponentStop {
  readonly component: string;
  /** The name the owner reads (the manifest's display name). */
  readonly title: string;
  readonly runKind: ScheduledCollector["runKind"];
  /** Consecutive failures — at least `limit`. */
  readonly failures: number;
  /** METISTRY_RUNNER_MAX_STREAK in force. */
  readonly limit: number;
  /** The first failure of the streak. */
  readonly since: Date;
  /** The latest failure's error, and its signature — the request's key. */
  readonly error: string;
  readonly signature: string;
  /** The run that failed the last time; null when the stop was first seen on a skipped window. */
  readonly runId: number | null;
  readonly stoppedAt: Date;
}

/** A budget that paused routines this tick (C133). */
export interface BudgetStop {
  /** `budgetStopKey` — the request's key. */
  readonly key: string;
  readonly hit: BudgetHit;
  /** Every routine it paused this tick, by name. */
  readonly paused: readonly string[];
  readonly at: Date;
}

/** Where the runner's events become requests. `runnerRequests` is the one implementation; the seam is for tests that model `runs` alone. */
export interface RunnerRequests {
  routineFailed(f: RoutineFailure): Promise<void>;
  /** The routine ran: every report still waiting on one of its faults is cleared at its source. */
  routineSucceeded(component: string): Promise<void>;
  /** The collector ran: its waiting stop, if any, is cleared at its source. */
  collectorSucceeded(component: string): Promise<void>;
  /** Three strikes: one request per (component, signature) per streak — a routine's waiting report says it stopped. */
  componentStopped(s: ComponentStop): Promise<void>;
  secretsFailed(failures: readonly SecretFailure[], at: Date): Promise<void>;
  /** Clears the waiting request of every secret `isSet` says is set again. */
  secretsRestored(isSet: (name: string) => boolean): Promise<void>;
  /** A Stop limit paused routines: one request per budget window, naming each. */
  budgetStopped(stops: readonly BudgetStop[]): Promise<void>;
  /**
   * Clears every waiting Stop-limit request but the one `current` names —
   * `current` resolves to the key of the budget stopping routines now, null
   * when none is, undefined when it cannot say (nothing is cleared). Asked
   * only when a request waits.
   */
  budgetResumed(current: () => Promise<string | null | undefined>): Promise<void>;
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : (v instanceof Date ? v : new Date(String(v))).toISOString());

/** Pending mirrors whose `external_ref` starts with `prefix` — one SELECT, the prefix compared as text (never a LIKE pattern). */
async function pendingRefs(db: Db, prefix: string): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT source->>'external_ref' AS ref FROM proposals
     WHERE decision = 'pending' AND source->>'kind' = $1 AND left(source->>'external_ref', $2) = $3`,
    [RUNNER_SOURCE_KIND, prefix.length, prefix],
  );
  return rows.map((r) => String(r.ref));
}

/**
 * When the components last succeeded, and whether a request for `source`
 * has been raised since — waiting or answered. "Since" is what makes an
 * answer stick: a Dismiss is not asked again while the fault lasts, and is
 * asked again once the component has recovered and failed anew. Both times
 * are Postgres's own, so no clock in this process can move the line.
 */
async function toldSince(db: Db, source: RequestSource, components: readonly string[]): Promise<{ lastOk: string | null; told: boolean }> {
  const { rows } = await db.query(
    `WITH last_ok AS (SELECT max(ts) AS ts FROM runs WHERE component = ANY($1) AND kind = ANY($2) AND ok)
     SELECT (SELECT ts FROM last_ok) AS last_ok,
            EXISTS (SELECT 1 FROM proposals
                    WHERE source->>'kind' = $3 AND source->>'external_ref' = $4
                      AND ts > coalesce((SELECT ts FROM last_ok), '-infinity'::timestamptz)) AS told`,
    [[...components], [...SCHEDULED_KINDS], source.kind, source.external_ref],
  );
  return { lastOk: iso(rows[0]?.last_ok), told: rows[0]?.told === true };
}

const clipTo = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The runner's requests, written to the `proposals` table through core's mirrors. */
export function runnerRequests(db: Db): RunnerRequests {
  return {
    async routineFailed(f) {
      const source = routineFailedSource(f.component, f.signature);
      const { lastOk, told } = await toldSince(db, source, [f.component]);
      if (told) return;
      await raiseMirror(db, {
        kind: ROUTINE_FAILED_KIND,
        source_agent: RUNNER_AGENT,
        trust: "internal",
        source,
        payload: {
          title: `${f.title} failed`,
          body: clipTo(f.error, ROUTINE_ERROR_EXCERPT),
          event: ROUTINE_FAILED_EVENT,
          component: f.component,
          run_id: f.runId,
          error_signature: f.signature,
          // the two timestamps (C64, C96): when it last worked, and when it did not
          last_ok_at: lastOk,
          failed_at: f.failedAt.toISOString(),
          act: { label: "Try Again", kind: "run_now", component: f.component },
        },
      });
    },

    async routineSucceeded(component) {
      for (const ref of await pendingRefs(db, `${ROUTINE_REF}${component}#`)) await resolveAtSource(db, { kind: RUNNER_SOURCE_KIND, external_ref: ref });
    },

    async collectorSucceeded(component) {
      for (const ref of await pendingRefs(db, `${COLLECTOR_REF}${component}#`)) await resolveAtSource(db, { kind: RUNNER_SOURCE_KIND, external_ref: ref });
    },

    async componentStopped(s) {
      const routine = s.runKind === "routine_run";
      const source = routine ? routineFailedSource(s.component, s.signature) : collectorFailedSource(s.component, s.signature);
      const stopped = stoppedFields(s);
      // A routine's report for this fault is waiting: it becomes the stop,
      // rather than a second request about the same fault beside it.
      if (routine) {
        const { rows } = await db.query(
          `UPDATE proposals SET payload = payload || $3::jsonb
           WHERE decision = 'pending' AND source->>'kind' = $1 AND source->>'external_ref' = $2 AND NOT (payload ? 'stopped')
           RETURNING id`,
          [source.kind, source.external_ref, JSON.stringify(redactSecrets(stopped))],
        );
        if (rows.length > 0) return;
      }
      // Waiting already, or answered since it last ran cleanly: one request
      // per signature per streak, and an answer sticks while the fault lasts.
      const { lastOk, told } = await toldSince(db, source, [s.component]);
      if (told) return;
      await raiseMirror(db, {
        kind: routine ? ROUTINE_FAILED_KIND : COLLECTOR_FAILED_KIND,
        source_agent: RUNNER_AGENT,
        trust: "internal",
        source,
        payload: {
          body: clipTo(s.error, ROUTINE_ERROR_EXCERPT),
          event: routine ? ROUTINE_FAILED_EVENT : COLLECTOR_FAILED_EVENT,
          component: s.component,
          run_id: s.runId,
          error_signature: s.signature,
          last_ok_at: lastOk,
          failed_at: s.stoppedAt.toISOString(),
          act: { label: "Try Again", kind: "run_now", component: s.component },
          ...stopped,
        },
      });
    },

    async secretsFailed(failures, at) {
      for (const f of failures) {
        const source = secretFailedSource(f.name);
        // Waiting already: it names everything this secret has stopped, so a
        // component stopped since (a routine whose time came round) is added
        // to the list rather than raised on its own.
        const { rows } = await db.query(
          `SELECT id, payload->'stopped' AS stopped FROM proposals WHERE decision = 'pending' AND source->>'kind' = $1 AND source->>'external_ref' = $2 LIMIT 1`,
          [source.kind, source.external_ref],
        );
        const waiting = rows[0];
        if (waiting) {
          const had = Array.isArray(waiting.stopped) ? (waiting.stopped as unknown[]).map(String) : [];
          const all = [...new Set([...had, ...f.stopped])].sort();
          if (all.length !== had.length) {
            await db.query(`UPDATE proposals SET payload = payload || $2::jsonb WHERE id = $1 AND decision = 'pending'`, [waiting.id, JSON.stringify(secretStopped(f.name, all))]);
          }
          continue;
        }
        const { lastOk, told } = await toldSince(db, source, f.stopped);
        if (told) continue;
        await raiseMirror(db, {
          kind: SECRET_FAILED_KIND,
          source_agent: RUNNER_AGENT,
          trust: "internal",
          source,
          payload: {
            title: `${f.name} is not set`,
            event: SECRET_FAILED_EVENT,
            variable: f.name, // not `secret`: a field of that name is redacted on the way in (redact.ts)
            why: f.why,
            ...secretStopped(f.name, f.stopped),
            last_ok_at: lastOk,
            failed_at: at.toISOString(),
            fix: `Set ${f.name} in this install's .env (\`metistry secrets sync --to env\`); what it stopped runs again on its next window.`,
          },
        });
      }
    },

    async secretsRestored(isSet) {
      for (const ref of await pendingRefs(db, SECRET_REF)) {
        if (isSet(ref.slice(SECRET_REF.length))) await resolveAtSource(db, { kind: RUNNER_SOURCE_KIND, external_ref: ref });
      }
    },

    async budgetStopped(stops) {
      for (const b of stops) {
        const source = budgetStoppedSource(b.key);
        const { rows } = await db.query(
          `SELECT id, decision, payload->'paused' AS paused FROM proposals WHERE source->>'kind' = $1 AND source->>'external_ref' = $2 ORDER BY id DESC LIMIT 1`,
          [source.kind, source.external_ref],
        );
        const last = rows[0];
        if (last) {
          // Waiting: a routine paused since joins its list. Answered, or
          // cleared and stopping again at the same limit in the same window:
          // the owner has heard about this window already.
          if (last.decision !== "pending") continue;
          const had = Array.isArray(last.paused) ? (last.paused as unknown[]).map(String) : [];
          const all = [...new Set([...had, ...b.paused])].sort();
          if (all.length !== had.length) {
            await db.query(`UPDATE proposals SET payload = payload || $2::jsonb WHERE id = $1 AND decision = 'pending'`, [last.id, JSON.stringify(budgetPaused(all))]);
          }
          continue;
        }
        const h = b.hit;
        await raiseMirror(db, {
          kind: BUDGET_STOPPED_KIND,
          source_agent: RUNNER_AGENT,
          trust: "internal",
          source,
          payload: {
            title: h.scope === "instance" ? `Compute stopped at the ${money(h.limit)} ${h.window} budget` : `${h.scope.replace(/^provider:/, "")} stopped at its ${money(h.limit)} ${h.window} budget`,
            event: BUDGET_STOPPED_EVENT,
            budget: { scope: h.scope, window: h.window, field: h.field, limit: h.limit, spent: h.spent, action: h.action },
            ...budgetPaused(b.paused),
            stopped_at: b.at.toISOString(),
            fix: budgetRefusalMessage(h),
            // Settings › Compute › Spending limits (C138): the limit is the owner's hand, never this request's
            act: { label: "Raise", kind: "open_settings", pane: "compute", section: "spending_limits" },
          },
        });
      }
    },

    async budgetResumed(current) {
      const waiting = await pendingRefs(db, BUDGET_REF);
      if (waiting.length === 0) return;
      const now = await current();
      if (now === undefined) return;
      for (const ref of waiting) {
        if (ref !== `${BUDGET_REF}${now}`) await resolveAtSource(db, { kind: RUNNER_SOURCE_KIND, external_ref: ref });
      }
    },
  };
}

const money = (n: number): string => `$${n.toFixed(2)}`;

/** What a stop adds to its request: the title that says so, and the streak — how many, since when, at what limit. */
function stoppedFields(s: ComponentStop): Record<string, unknown> {
  return {
    title: `${s.title} stopped after ${s.failures} failures`,
    stopped: { failures: s.failures, limit: s.limit, since: s.since.toISOString(), at: s.stoppedAt.toISOString() },
  };
}

/** The part of a Stop-limit request that names what it paused — the list, and the excerpt a report draws. */
function budgetPaused(paused: readonly string[]): Record<string, unknown> {
  return {
    paused,
    body: `Paused until the window resets or the limit is raised: ${paused.join(", ")}.`,
  };
}

/** The part of a secret's request that names what it stopped — the list, and the before-and-after body an access request draws. */
function secretStopped(name: string, stopped: readonly string[]): Record<string, unknown> {
  return {
    stopped,
    body: {
      kind: "before_after",
      heading: name,
      before: { label: "Stopped", text: stopped.join("\n") },
      after: { label: `Once ${name} is set`, text: "Each runs again on its next window." },
    },
  };
}

/** What one component is handed for a run: the shared ctx, its pinned model, and its resolved config. */
function componentCtx(c: ScheduledCollector, ctx: ComponentCtx, config: Readonly<Record<string, ConfigValue>>): ComponentCtx {
  return {
    ...ctx,
    ...(c.usesModel ? { usesModel: c.usesModel } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

/**
 * The run itself, under a runs row already started — the ONE place a
 * component's code is called, for a scheduled slot and for Run Now alike:
 * finish the row with what it did, or with its error, a streak-aware alert
 * and the signature the streak and the dedupe key on.
 */
async function execute(db: Db, c: ScheduledCollector, runId: number, runCtx: ComponentCtx, streak: ComponentStreak | undefined, opts: ResolvedOptions): Promise<void> {
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
    await tell(opts, (r) => (c.runKind === "routine_run" ? r.routineSucceeded(c.name) : r.collectorSucceeded(c.name)));
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
    if (c.runKind === "routine_run") {
      await tell(opts, (r) => r.routineFailed({ component: c.name, title: unitOf(c).displayName, runId, error, signature, failedAt: opts.now }));
    }
    // three strikes (C135): this failure is the one that stops it
    if (count >= opts.maxStreak) {
      await tell(opts, (r) => r.componentStopped(stopOf(c, count, streak?.since ?? opts.now, error, signature, runId, opts)));
    }
  }
}

// ---- Run Now: the tick, for one component, on the owner's word ------------------

/** Why Run Now did not start a run — a closed set a client branches on (docs/ops/client-api.md). */
export const RUN_NOW_REFUSALS = ["not_found", "paused", "held", "running", "blocked"] as const;
export type RunNowRefusal = (typeof RUN_NOW_REFUSALS)[number];

export type RunNowResult =
  | {
      readonly started: true;
      readonly runId: string;
      /** Settles when the run has finished and its row says so — never rejects. The console answers 202 without waiting. */
      readonly done: Promise<void>;
    }
  | { readonly started: false; readonly reason: RunNowRefusal; readonly message: string };

/** How long an unfinished row of the same component counts as a run still going — longer than any run takes; a crashed process's row stops blocking after it. */
const IN_FLIGHT_MS = 60 * 60_000; // limit: fixed — an hour: longer than any routine or sync run, short enough that a row a crash left open unblocks by itself

/**
 * **Run Now** (§2.1, T3-3): what the tick does for one component, when the
 * owner asks rather than when it is due. The owner's layer is read afresh
 * and applies exactly as on a tick — a PAUSED component is not run (Resume
 * is the owner's other door, and Run Now does not quietly override a pause),
 * a HELD one is not run (its entry does not fit its manifest) — and then
 * the same preflight, budget included (C5: a `stop` budget pauses routines
 * too), before one runs row is started and the component's code is called
 * through the same `execute`.
 *
 * What it does NOT share with the tick: the due-gate (the owner asked now),
 * and the failure streak — Run Now is how a fix is checked, and the success
 * it produces is what clears the streak. A run already going (an unfinished
 * row of the same kind in the last hour) refuses rather than doubling it.
 * The row carries `meta.trigger = "run_now"`, so history tells the two apart.
 */
export async function runNow(db: Db, scheduled: readonly ScheduledCollector[], name: string, ctx: ComponentCtx = {}, options: RunnerOptions = {}): Promise<RunNowResult> {
  const c = scheduled.find((x) => x.name === name);
  if (!c) return { started: false, reason: "not_found", message: `nothing named ${name} is scheduled here` };
  const opts = resolve(db, options);
  const label = c.unit?.displayName ?? c.name;
  const eff = effectiveSchedule(c, await opts.scheduled());
  if (eff.held) return { started: false, reason: "held", message: `${label} is held, so Run Now did not start it: ${eff.why}` };
  if (eff.paused) return { started: false, reason: "paused", message: `${label} is paused, so Run Now did not start it — Resume it first (the pause is yours, in .metistry/scheduled.yaml)` };
  const { rows } = await db.query(
    `SELECT id FROM runs WHERE component = $1 AND kind = $2 AND finished_at IS NULL AND ts > $3 ORDER BY id DESC LIMIT 1`,
    [c.name, c.runKind, new Date(opts.now.getTime() - IN_FLIGHT_MS)],
  );
  if (rows[0]) return { started: false, reason: "running", message: `${label} is already running (run ${String(rows[0].id)}) — Run Now waits for it to finish rather than start a second` };
  const pre = await preflight(c.requires, { env: opts.env, compute: opts.compute(), fetchFn: opts.fetchFn, ...(opts.budget ? { budget: opts.budget } : {}) });
  if (!pre.ok) return { started: false, reason: "blocked", message: blockedConfigMessage(c.name, c.dir, pre) };
  const runId = await startRun(db, { component: c.name, kind: c.runKind, meta: { trigger: "run_now" } });
  const streak = streakFor(await failureStreaks(db), c.name, c.runKind);
  const done = execute(db, c, runId, componentCtx(c, ctx, eff.config), streak, opts).catch((err: unknown) => {
    console.error(`runner: Run Now of ${c.name} (run ${String(runId)}) could not be recorded:`, err);
  });
  return { started: true, runId: String(runId), done };
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
