// Budgets (C5) — the pure decision, so the same rules run in the engine
// before a call, in the runner's preflight before a routine, and in a test
// with no database at all.
//
// Two properties this file exists to guarantee:
//
// 1. THE CHECK HAPPENS BEFORE THE SPEND, not after it. A budget enforced on
//    the way out is a report; enforced on the way in it is a control. So
//    nothing here takes a result — it takes what has been spent so far and
//    answers yes or no.
// 2. EVERY REFUSAL NAMES THE FIELD THAT WOULD PERMIT IT (R3). "budget
//    exceeded" is a riddle; `budgets.instance.daily_usd` is an instruction.
//
// The three actions are the owner's (C5): `allow` records and warns but
// never refuses; `stop` (the default) refuses, and the runner's preflight
// reads the same verdict so a paused engine does not sit behind a scheduler
// that keeps filling the queue with refusals; `critical_only` refuses
// everything except an assignment marked `critical: true` in `compute.yaml`
// — WHAT may carry that mark is still the owner's question (OPEN-4), so
// this file enforces the flag and decides nothing about who may set it.
//
// The 80 % warning (R2) rides on the same pass: one hit per (scope, window),
// with a key the caller dedupes on, so a warning arrives once per window and
// not once per call.

import { DEFAULT_BUDGET_ACTION, resolveAssignment, type Budget, type BudgetAction, type Budgets, type Compute } from "./compute.js";
import { ROUTINE_TIER } from "./tiers.js";
import type { PreflightMiss } from "./preflight.js";

/** The `runs.error` prefix and the code a refused call reports. One string, so a query for "what did budgets stop" is exact. */
export const BUDGET_EXCEEDED = "budget_exceeded";

/** Warn at 80 % of a window (R2) — early enough to act, late enough not to be noise. */
export const BUDGET_WARN_FRACTION = 0.8;  // limit: fixed — the documented 80 % warning (docs/ops/compute.md "Budgets"); the budget itself is the knob

export const BUDGET_WINDOWS = ["daily", "monthly"] as const;
export type BudgetWindow = (typeof BUDGET_WINDOWS)[number];

/** What has been spent in the two windows a budget can name. */
export interface Spent {
  daily: number;
  monthly: number;
}

export const NO_SPEND: Spent = { daily: 0, monthly: 0 };

/** One budget, measured. `over` is the refusal condition; `fraction` is what the warning reads. */
export interface BudgetHit {
  /** `instance`, or `provider:<name>` — the scope whose window this is. */
  scope: string;
  window: BudgetWindow;
  /** The dotted path in `compute.yaml` that sets this limit — what a refusal names. */
  field: string;
  limit: number;
  spent: number;
  fraction: number;
  over: boolean;
  action: BudgetAction;
}

export interface BudgetVerdict {
  allowed: boolean;
  /** The hit that refused the call, when one did. */
  refusal?: BudgetHit;
  /** Every hit at or past the warn fraction — over or not. Deduped by the caller on `budgetWindowKey`. */
  warnings: BudgetHit[];
}

export interface BudgetCheckInput {
  budgets: Budgets | undefined;
  /** The provider about to be called — its own budget is checked alongside the instance's. */
  provider: string;
  /** Spend so far: the instance total, and this provider's share. */
  spent: { instance: Spent; provider: Spent };
  /** `assignments.*.critical` on the assignment about to run — the only thing `critical_only` lets through. */
  critical?: boolean;
}

function hitsFor(scope: string, path: string, budget: Budget, spent: Spent): BudgetHit[] {
  const out: BudgetHit[] = [];
  const windows: [BudgetWindow, number | undefined, number][] = [
    ["daily", budget.daily_usd, spent.daily],
    ["monthly", budget.monthly_usd, spent.monthly],
  ];
  for (const [window, limit, used] of windows) {
    if (limit === undefined || limit <= 0) continue;
    out.push({
      scope,
      window,
      field: `${path}.${window}_usd`,
      limit,
      spent: used,
      fraction: used / limit,
      over: used >= limit,
      action: budget.action ?? DEFAULT_BUDGET_ACTION,
    });
  }
  return out;
}

/**
 * The whole decision. An `allow` budget never refuses — it is the "record
 * only" setting — but it still warns, because a limit you asked to be told
 * about is still a limit you asked about.
 *
 * When two windows are both over, the refusal is the FIRST in declaration
 * order (instance before provider, daily before monthly): one refusal, one
 * field to edit, rather than a list to work through.
 */
export function checkBudgets(input: BudgetCheckInput): BudgetVerdict {
  const hits: BudgetHit[] = [];
  const b = input.budgets;
  if (b?.instance) hits.push(...hitsFor("instance", "budgets.instance", b.instance, input.spent.instance));
  const own = b?.providers?.[input.provider];
  if (own) hits.push(...hitsFor(`provider:${input.provider}`, `budgets.providers.${input.provider}`, own, input.spent.provider));

  const refusal = hits.find((h) => h.over && (h.action === "stop" || (h.action === "critical_only" && input.critical !== true)));
  return {
    allowed: refusal === undefined,
    ...(refusal ? { refusal } : {}),
    warnings: hits.filter((h) => h.fraction >= BUDGET_WARN_FRACTION),
  };
}

const money = (n: number): string => `$${n.toFixed(2)}`;

/**
 * The refusal, in one sentence that says what stopped, what it cost, and
 * the two fields that would change the answer (R3). Prefixed with
 * `budget_exceeded:` so `runs.error` is greppable.
 */
export function budgetRefusalMessage(hit: BudgetHit): string {
  const raise = `raise ${hit.field} in compute.yaml`;
  const relax =
    hit.action === "critical_only"
      ? `, mark the assignment \`critical: true\`, or set ${hit.field.replace(/\.[a-z_]+_usd$/, ".action")}: allow`
      : `, or set ${hit.field.replace(/\.[a-z_]+_usd$/, ".action")}: allow to record spend without refusing`;
  return `${BUDGET_EXCEEDED}: the ${hit.scope} ${hit.window} budget of ${money(hit.limit)} is spent (${money(hit.spent)}) — ${raise}${relax}. The window resets on its own; nothing was called, so nothing was spent.`;
}

/** The 80 % warning (R2) — the same fields, before the wall rather than at it. */
export function budgetWarningMessage(hit: BudgetHit): string {
  const pct = Math.round(hit.fraction * 100);
  return hit.over
    ? `budget: the ${hit.scope} ${hit.window} budget of ${money(hit.limit)} is spent (${money(hit.spent)}) and ${hit.field.replace(/\.[a-z_]+_usd$/, ".action")} is \`${hit.action}\`, so calls continue — raise ${hit.field} or change the action in compute.yaml.`
    : `budget: ${pct}% of the ${hit.scope} ${hit.window} budget spent (${money(hit.spent)} of ${money(hit.limit)}). At 100% the action is \`${hit.action}\` — ${hit.field} in compute.yaml is the limit.`;
}

/**
 * The key a warning is deduped on: one per (scope, window, calendar window).
 * A daily warning fires once today and again tomorrow; a monthly one once
 * this month. The date is formatted from the caller's clock in UTC, which
 * is the same clock the spend query's `current_date` runs on in a container.
 */
export function budgetWindowKey(hit: BudgetHit, now: Date = new Date()): string {
  const iso = now.toISOString();
  const stamp = hit.window === "daily" ? iso.slice(0, 10) : iso.slice(0, 7);
  return `${hit.scope}:${hit.window}:${stamp}`;
}

/** The name of the seeded query the spend numbers come from (invariant 3: one read path). */
export const SPEND_QUERY = "spend";

/** A row of `queries/spend.yaml`, as the driver returns it (numerics arrive as strings from pg). */
export interface SpendRow {
  provider?: string | null;
  is_today?: boolean | null;
  is_this_month?: boolean | null;
  cost_usd?: number | string | null;
}

const money_ = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? "0"));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Fold `spend` rows into the two windows, optionally for one provider.
 *
 * The windowing itself is Postgres's (`is_today` / `is_this_month` on the
 * row) rather than this process's: the clock that recorded the spend is the
 * clock that decides which window it fell in, so a container in UTC and a
 * Mac in BST can never disagree about whether a call was "today".
 */
export function spentFrom(rows: readonly SpendRow[], provider?: string): Spent {
  let daily = 0;
  let monthly = 0;
  for (const r of rows) {
    if (provider !== undefined && (r.provider ?? "") !== provider) continue;
    const cost = money_(r.cost_usd);
    if (r.is_this_month) monthly += cost;
    if (r.is_today) daily += cost;
  }
  return { daily, monthly };
}

// ---- the routine pause (C5: `stop` pauses routines too) -----------------------

/**
 * The budget half of the runner's preflight. A routine that declares
 * `requires.engine` would enqueue a turn something has to pay for; if the
 * tier that turn will run on is over a `stop` budget, the run is not worth
 * starting — a stopped engine behind a running scheduler just fills the
 * queue with refusals nobody reads.
 *
 * Null means "go". The miss names the `compute.yaml` field, not an
 * environment variable, which is why `PreflightMiss.fix` exists.
 */
export function budgetMiss(cfg: Compute, rows: readonly SpendRow[], tierOrCrew: string = ROUTINE_TIER): PreflightMiss | null {
  const budgets = cfg.budgets;
  if (!budgets) return null;
  const assignment = resolveAssignment(cfg, tierOrCrew);
  const provider = assignment?.provider ?? "";
  const verdict = checkBudgets({
    budgets,
    provider,
    spent: { instance: spentFrom(rows), provider: spentFrom(rows, provider) },
    critical: assignment?.critical === true,
  });
  if (!verdict.refusal) return null;
  return {
    name: verdict.refusal.field,
    why: `the ${verdict.refusal.scope} ${verdict.refusal.window} budget is spent, so the turn this run would enqueue could not be answered`,
    fix: budgetRefusalMessage(verdict.refusal),
  };
}
