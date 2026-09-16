// Minimal routine runner (SHOULD-8): schedules collectors from their
// manifests, gates on the runs table (per-collector last-run — survives
// restarts, no double-run storms), executes under a two-phase runs row.
// Schedule parsing lives in core (scheduleToSeconds — shared with the
// watchdog's silent-collector probe, so "due" and "silent" can never
// disagree about an interval). Every shipped manifest must parse: the
// console refuses to start otherwise (it crash-looped once on an unparsed
// schedule — manifests.test.ts).
//
// Three hardening behaviours ride on the same gate (docs/ops/automation.md):
// PREFLIGHT, so a component whose credential was never set costs an
// environment lookup rather than an API call every window; a FAILURE STREAK,
// so a component that has failed N times in a row stops being run at all
// until it succeeds again; and ALERT DEDUPE by error signature, so "the
// token expired" tells you once a day instead of once an hour. Each of the
// three records ONE runs row per window, never one per tick, and every
// message names the environment variable or manifest field that would fix
// it.

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  startRun,
  finishRun,
  validateManifest,
  scheduleToSeconds,
  blockedConfigMessage,
  errorSignature,
  failureStreaks,
  intEnv,
  preflight,
  requirementsOf,
  shouldAlert,
  signatureTag,
  streakFor,
  DEFAULT_ALERT_DEDUPE_HOURS,
  DEFAULT_MAX_STREAK,
  PREFLIGHT_FAILED,
  RUNNER_KIND,
  SKIPPED_STREAK,
  type ComponentStreak,
  type Requirements,
} from "@foldedspacelabs/metistry-core";
import type { RegisteredCollector, Db, CollectorCtx } from "@metistry-apps/collectors";

export { scheduleToSeconds }; // one import path for the runner's callers and tests

export interface ScheduledCollector extends RegisteredCollector {
  intervalSec: number;
  runKind: "collector_run" | "routine_run";
  /** what the manifest says this needs before a run is worth starting (preflight) */
  requires: Requirements;
  /** the component's directory, so a refusal can name the file you would edit */
  dir: string;
}

export interface RunnerOptions {
  /** the install's environment — preflight reads the declared variables from it */
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  /** consecutive failures after which a component stops being run (METISTRY_RUNNER_MAX_STREAK) */
  maxStreak?: number;
  /** how long one (component, error signature) stays quiet after alerting (METISTRY_ALERT_DEDUPE_H) */
  alertDedupeHours?: number;
  /** injected by tests; production always uses the wall clock */
  now?: Date;
}

interface ResolvedOptions {
  env: NodeJS.ProcessEnv;
  fetchFn: typeof fetch;
  maxStreak: number;
  alertDedupeHours: number;
  now: Date;
}

function resolve(opts: RunnerOptions): ResolvedOptions {
  const env = opts.env ?? process.env;
  return {
    env,
    fetchFn: opts.fetchFn ?? fetch,
    maxStreak: opts.maxStreak ?? intEnv("METISTRY_RUNNER_MAX_STREAK", DEFAULT_MAX_STREAK, env),
    alertDedupeHours: opts.alertDedupeHours ?? intEnv("METISTRY_ALERT_DEDUPE_H", DEFAULT_ALERT_DEDUPE_HOURS, env),
    now: opts.now ?? new Date(),
  };
}

export async function loadSchedules(
  registered: RegisteredCollector[],
  collectorsDir: string,
): Promise<ScheduledCollector[]> {
  const out: ScheduledCollector[] = [];
  for (const c of registered) {
    const dir = `${collectorsDir}/${c.name}`;
    const manifest = validateManifest(parseYaml(await readFile(`${dir}/manifest.yaml`, "utf8")));
    if (!manifest.ok) throw new Error(`${c.name}: invalid manifest: ${manifest.errors.join("; ")}`);
    const m = manifest.manifest;
    if (m.type !== "collector" && m.type !== "routine") throw new Error(`${c.name}: not schedulable (type ${m.type})`);
    if (m.schedule === undefined) throw new Error(`${c.name}: no schedule`);
    out.push({
      ...c,
      dir,
      requires: requirementsOf(m),
      intervalSec: scheduleToSeconds(m.schedule),
      runKind: m.type === "routine" ? "routine_run" : "collector_run",
    });
  }
  return out;
}

// ---- bookkeeping rows (one per window, never one per tick) -----------------

interface Windows {
  lastRun: number;
  lastSkip: number;
  lastPreflight: number;
}

const millis = (v: unknown): number => (v ? new Date(String(v)).getTime() : 0);

/**
 * The three timestamps the gate needs, in one round trip: when this
 * component last ran, and when it last recorded a skipped or blocked-config
 * window. The marker rows carry `kind = 'runner'` precisely so they are
 * invisible to the due-gate and to the streak — they are the runner's
 * bookkeeping, not the component's work.
 */
async function windowsFor(db: Db, c: ScheduledCollector): Promise<Windows> {
  const { rows } = await db.query(
    `SELECT max(ts) FILTER (WHERE kind = $2) AS last_run,
            max(ts) FILTER (WHERE kind = $3 AND tool = $4) AS last_skip,
            max(ts) FILTER (WHERE kind = $3 AND tool = $5) AS last_preflight
     FROM runs WHERE component = $1`,
    [c.name, c.runKind, RUNNER_KIND, SKIPPED_STREAK, PREFLIGHT_FAILED],
  );
  const r = rows[0] ?? {};
  return { lastRun: millis(r.last_run), lastSkip: millis(r.last_skip), lastPreflight: millis(r.last_preflight) };
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

// ---- the tick --------------------------------------------------------------

/** Run every collector that's due (last finished run older than its interval). */
export async function tick(db: Db, scheduled: ScheduledCollector[], ctx: CollectorCtx = {}, options: RunnerOptions = {}): Promise<void> {
  const opts = resolve(options);
  const streaks: ComponentStreak[] = await failureStreaks(db);

  for (const c of scheduled) {
    const windows = await windowsFor(db, c);
    const windowMs = c.intervalSec * 1000;
    if (opts.now.getTime() - windows.lastRun < windowMs) continue;

    // 1. the streak: N consecutive failures and the runner stops spending on it
    const streak = streakFor(streaks, c.name, c.runKind);
    if (streak && streak.count >= opts.maxStreak) {
      if (opts.now.getTime() - windows.lastSkip >= windowMs) {
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
    const pre = await preflight(c.requires, { env: opts.env, fetchFn: opts.fetchFn });
    if (!pre.ok) {
      if (opts.now.getTime() - windows.lastPreflight >= windowMs) {
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

    // 3. the run itself, unchanged — plus the signature on the failing row
    const runId = await startRun(db, { component: c.name, kind: c.runKind });
    try {
      const n = await c.run(db, ctx);
      await finishRun(db, runId, { ok: true, meta: { processed: n } });
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

export function startRunner(
  db: Db,
  scheduled: ScheduledCollector[],
  ctx: CollectorCtx = {},
  everyMs = 60_000,
  options: RunnerOptions = {},
): NodeJS.Timeout {
  return setInterval(() => tick(db, scheduled, ctx, options).catch((e) => console.error("runner:", e)), everyMs);
}
