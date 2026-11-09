// Doctor waits out a job it has just started (X-122).
//
// Two doctor runs failed a healthy install on 2026-10-04 by racing a
// kickstart: after `metistry update` sixteen schedule rows read "the console's
// runner is not running it" because the console had come up seconds earlier
// and its scheduler had not ticked yet, and at `up` the recorder helper's
// socket was ENOENT one second after bootstrap. Neither was a fault; both were
// a check made before the thing it checks could have answered.
//
// The rule, in one place: a row whose subject started less than a grace ago
// is *starting*, not failed. A probe is asked again until the grace is spent
// (bridges, helpers); a clock-based check reads `pending` with why (schedules,
// which only a scheduler tick can answer and a tick is a minute away). Past
// the grace the row fails exactly as before — a job that is NOT just started
// gets no benefit of the doubt, and the tests hold that line.
//
// "Started" is evidence, never a guess: the supervisor's own uptime for a
// child, `ps -o etimes=` for a launchd job, `docker compose ps` for a
// container — and the start times `up` and `update` hand over for what they
// have just bootstrapped or kickstarted. Nothing here parses a sentence.

import { intEnv, type ChildStatus } from "@foldedspacelabs/metistry-core";
import type { Exec } from "./exec.js";
import { labelFor } from "./launchd.js";
import { SUPERVISOR_SERVICE } from "./supervisor.js";
import { processUptimeSec, parseLaunchctlPrint, parseComposePs, parseComposeUptimeSec } from "./doctor.js";
import type { DoctorRow } from "./doctor.js";

/**
 * How long after it starts a job is given before a failed probe of it counts
 * (METISTRY_DOCTOR_START_GRACE_SEC). It is also the most a single doctor run
 * waits on a bridge that is coming up. Thirty seconds is a bridge's cold
 * start with a helper behind it; a slow machine raises it.
 */
export const DEFAULT_START_GRACE_SEC = 30;

/** The runner's own tick (METISTRY_RUNNER_TICK_MS, a minute) — the console's scheduler runs nothing until its first one. */
export const DEFAULT_RUNNER_TICK_MS = 60_000;

/** How often a bridge that is coming up is asked again. */
export const REPROBE_INTERVAL_MS = 1_000; // limit: fixed — a poll interval, not a policy

/** The env var `up` and `update` use to hand a child doctor the jobs they have just started: `label=epochMs,label=epochMs`. */
export const STARTED_ENV = "METISTRY_DOCTOR_STARTED";

export function startGraceSec(env: NodeJS.ProcessEnv): number {
  return intEnv("METISTRY_DOCTOR_START_GRACE_SEC", DEFAULT_START_GRACE_SEC, env);
}

/**
 * How long a freshly started console is given before a schedule row's
 * "overdue" counts: its runner's first tick (the runner does nothing before
 * it) plus the start grace for that tick's runs to land.
 */
export function runnerGraceSec(env: NodeJS.ProcessEnv): number {
  return intEnv("METISTRY_RUNNER_TICK_MS", DEFAULT_RUNNER_TICK_MS, env) / 1000 + startGraceSec(env);
}

// ---- what has just been started -------------------------------------------------------------

/** A start time per launchd label, in epoch milliseconds. */
export type StartedAt = Readonly<Record<string, number>>;

/** `label=ms,label=ms` → a map; anything malformed is dropped, so a bad value can only grant LESS grace. */
export function parseStarted(text: string | undefined): StartedAt {
  const out: Record<string, number> = {};
  for (const part of (text ?? "").split(",")) {
    const at = part.lastIndexOf("=");
    if (at <= 0) continue;
    const ms = Number(part.slice(at + 1));
    if (Number.isFinite(ms) && ms > 0) out[part.slice(0, at).trim()] = ms;
  }
  return out;
}

export function serializeStarted(started: StartedAt): string {
  return Object.entries(started).map(([label, ms]) => `${label}=${Math.round(ms)}`).join(",");
}

/** Seconds since a label was started, per the hints; a start time in the future (a skewed clock) reads as 0, never negative. */
function hintAgeSec(hints: StartedAt, labels: readonly string[], nowMs: number): number | undefined {
  const ages = labels.flatMap((l) => (hints[l] !== undefined ? [Math.max(0, (nowMs - hints[l]!) / 1000)] : []));
  return ages.length > 0 ? Math.min(...ages) : undefined;
}

const smallest = (xs: readonly (number | undefined)[]): number | undefined => {
  const ns = xs.filter((x): x is number => x !== undefined);
  return ns.length > 0 ? Math.min(...ns) : undefined;
};

export interface AgeContext {
  env: NodeJS.ProcessEnv;
  exec: Exec;
  uid: number;
  platform: NodeJS.Platform;
  /** the launchd shape's supervisor children (`supervisorSnapshot`), when there is one */
  children?: readonly ChildStatus[] | undefined;
  /** the install's compose directory, when a service runs in a container */
  composeDir?: string | undefined;
  labelSuffix?: string | undefined;
  started: StartedAt;
  nowMs: number;
}

/**
 * How long ago a service last (re)started, or undefined when nothing says.
 * The smallest of every witness: a supervisor child's uptime, its launchd
 * job's, its container's, and the start `up`/`update` recorded — and a
 * service that is a supervisor child was restarted with the supervisor, so
 * the supervisor's start counts for it too. `jobs` are the launchd services
 * that serve it (the live-capture bridge, and the recorder helper behind it).
 */
export async function serviceAgeSec(ctx: AgeContext, service: string, jobs: readonly string[] = [service]): Promise<number | undefined> {
  const labels = jobs.map((j) => labelFor(j, ctx.labelSuffix));
  const supervisorLabel = labelFor(SUPERVISOR_SERVICE, ctx.labelSuffix);
  const child = ctx.children?.find((c) => c.name === service);
  const witnesses: (number | undefined)[] = [
    child?.state === "running" && child.uptimeMs !== undefined ? child.uptimeMs / 1000 : undefined,
    hintAgeSec(ctx.started, child ? [...labels, supervisorLabel] : labels, ctx.nowMs),
  ];
  if (ctx.platform === "darwin") {
    for (const label of labels) {
      const r = await ctx.exec("launchctl", ["print", `gui/${ctx.uid}/${label}`]).catch(() => undefined);
      if (!r || r.code !== 0) continue;
      const p = parseLaunchctlPrint(r.stdout);
      if (p.state === "running" && p.pid !== undefined) witnesses.push(await processUptimeSec(ctx.exec, p.pid));
    }
  }
  if (ctx.composeDir) {
    const r = await ctx.exec("docker", ["compose", "ps", "--format", "json", service], { cwd: ctx.composeDir }).catch(() => undefined);
    if (r && r.code === 0) {
      const e = (() => {
        try {
          return parseComposePs(r.stdout).find((x) => x.Service === service);
        } catch {
          return undefined;
        }
      })();
      if (e?.State === "running") witnesses.push(parseComposeUptimeSec(e.Status));
    }
  }
  return smallest(witnesses);
}

// ---- waiting out a start ----------------------------------------------------------------------

export interface WaitOptions {
  /** probe the row again */
  reprobe: () => Promise<DoctorRow>;
  /** how long ago its subject started; undefined = unknown, which grants nothing */
  ageSec: () => Promise<number | undefined>;
  graceSec: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  intervalMs?: number;
}

/**
 * A failed row whose subject started less than `graceSec` ago is asked again,
 * every second, until it stops failing or the grace is spent; then it is
 * whatever the last probe said. A row that is not failed, or whose subject
 * has been up past the grace (or whose age nothing can tell), is returned
 * untouched on the first answer — no waiting, no second probe.
 */
export async function waitOutStart(first: DoctorRow, o: WaitOptions): Promise<DoctorRow> {
  if (first.status !== "failed") return first;
  const age = await o.ageSec();
  if (age === undefined || age >= o.graceSec) return first;
  const deadline = o.now() + (o.graceSec - age) * 1000;
  let row = first;
  while (o.now() < deadline) {
    await o.sleep(Math.min(o.intervalMs ?? REPROBE_INTERVAL_MS, Math.max(0, deadline - o.now())));
    row = await o.reprobe();
    if (row.status !== "failed") return { ...row, meta: { ...row.meta, waited_for_start: true, started_sec_ago: Math.round(age) } };
  }
  return { ...row, meta: { ...row.meta, waited_for_start_sec: Math.round(o.graceSec - age) } };
}
