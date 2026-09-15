// Scheduled-work failure model (docs/ops/automation.md). Derived from
// `runs`, no schema change: a component's STREAK is the run of consecutive
// `ok = false` rows since its last `ok = true`, and its SIGNATURE is a hash
// of the component plus the error with every number, id and path normalised
// out. Both live here so the runner (which decides to stop spending), the
// alert path (which decides whether you have already been told) and
// `metistry doctor` (which reports it) can never disagree about what "still
// broken, same way" means.
//
// Why a query helper in core rather than a named query: the runner and
// doctor are both inside the product, both already read `runs` directly for
// scheduling, and one SQL text is the only way the streak the runner acts on
// and the streak doctor prints stay the same number.

import { createHash } from "node:crypto";
import type { RunExecutor } from "./runs.js";

/** Consecutive failures after which the runner stops running a component (METISTRY_RUNNER_MAX_STREAK). */
export const DEFAULT_MAX_STREAK = 5;

/** Hours one (component, error signature) stays silent after it has alerted once (METISTRY_ALERT_DEDUPE_H). */
export const DEFAULT_ALERT_DEDUPE_HOURS = 24;

/** `kind` for the runner's own bookkeeping rows — never a component's own run, so it can never be mistaken for one. */
export const RUNNER_KIND = "runner";
/** `tool` on the row recording that a window was skipped because the streak is at the limit. */
export const SKIPPED_STREAK = "skipped_streak";
/** `tool` on the row recording that a window was not started because a prerequisite was missing. */
export const PREFLIGHT_FAILED = "preflight_failed";

/** The run kinds the runner schedules, and the only kinds a streak is computed over. */
export const SCHEDULED_KINDS = ["collector_run", "routine_run"] as const;

/**
 * An error message with everything that varies between two occurrences of
 * the same fault taken out: uuids, absolute paths, long hex ids and every
 * digit run. "token expired at 10:04 for request 8f2c…" and the same fault
 * an hour later normalise to one string, so they hash to one signature and
 * cost you one notification rather than one an hour forever.
 */
export function normalizeError(error: string): string {
  return error
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/(?:\/[\w.@+-]+){2,}/g, "<path>") // absolute paths and url paths; a bare host survives
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 200);
}

/** sha256(component + normalised error), first 12 hex — short enough to read out, long enough not to collide in one install. */
export function errorSignature(component: string, error: string): string {
  return createHash("sha256").update(`${component} ${normalizeError(error)}`).digest("hex").slice(0, 12);
}

/** How a signature is spelled inside an alert's text — the handle you would ack, and the key the dedupe query matches on. */
export function signatureTag(signature: string): string {
  return `[sig:${signature}]`;
}

export interface ComponentStreak {
  component: string;
  kind: string;
  /** consecutive failed runs since the last ok one (≥ 1 — a component with no open streak has no row) */
  count: number;
  /** the first failure of the current streak */
  since: Date;
  lastError: string | null;
  /** signature of the most recent error in the streak */
  signature: string;
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

/**
 * One row per component/kind that has failed at least once since its last
 * successful run. Components that are healthy, or have never run, are
 * absent — `streakFor` returns 0 for them.
 */
export async function failureStreaks(db: RunExecutor, kinds: readonly string[] = SCHEDULED_KINDS): Promise<ComponentStreak[]> {
  const { rows } = await db.query(
    `WITH last_ok AS (
       SELECT component, kind, max(ts) AS ts FROM runs
       WHERE kind = ANY($1) AND ok GROUP BY component, kind
     )
     SELECT r.component, r.kind, count(*) AS n, min(r.ts) AS since,
            (array_agg(r.error ORDER BY r.ts DESC))[1] AS last_error
     FROM runs r
     LEFT JOIN last_ok o ON o.component = r.component AND o.kind = r.kind
     WHERE r.kind = ANY($1) AND r.ok = false AND (o.ts IS NULL OR r.ts > o.ts)
     GROUP BY r.component, r.kind`,
    [[...kinds]],
  );
  return rows.map((r) => {
    const component = String(r.component);
    const lastError = r.last_error === null || r.last_error === undefined ? null : String(r.last_error);
    return {
      component,
      kind: String(r.kind),
      count: Number(r.n),
      since: toDate(r.since),
      lastError,
      signature: errorSignature(component, lastError ?? "(no error text)"),
    };
  });
}

export function streakFor(streaks: ComponentStreak[], component: string, kind: string): ComponentStreak | undefined {
  return streaks.find((s) => s.component === component && s.kind === kind);
}

export interface AlertGate {
  /** when this exact signature last alerted, or null if it never has */
  lastAlertAt: Date | null;
  /** first failure of the CURRENT streak: an alert older than this belongs to a streak that has since cleared */
  streakSince: Date | null;
  now?: Date;
  windowHours?: number;
}

/**
 * Alert once per (component, signature) per window — and again when the
 * streak cleared and came back, because "it broke, you fixed it, it broke
 * again the same way" is news even inside the window. A changed signature is
 * a different key, so it alerts on its own.
 */
export function shouldAlert(gate: AlertGate): boolean {
  if (gate.lastAlertAt === null) return true;
  const now = (gate.now ?? new Date()).getTime();
  const windowMs = (gate.windowHours ?? DEFAULT_ALERT_DEDUPE_HOURS) * 3_600_000;
  if (now - gate.lastAlertAt.getTime() >= windowMs) return true;
  if (gate.streakSince !== null && gate.lastAlertAt.getTime() < gate.streakSince.getTime()) return true;
  return false;
}
