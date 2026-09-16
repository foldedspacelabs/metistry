// Budgets, enforced where the money moves (C5, C12).
//
// The rules are pure and live in core (`budget.ts`); this file is the wiring
// the engine needs: read spend through the ONE read path (invariant 3 — the
// `spend` named query, executed by `packages/queries`, never hand-rolled SQL
// against `runs`), decide, and record.
//
// Three properties worth stating, because each is a decision:
//
// 1. THE GUARD RUNS ON EVERY KIND. It is wired into `makeEngine`'s `guard`
//    seam rather than into the OpenAI loop, so the SDK path is budgeted too
//    and a future adapter inherits it without remembering to.
// 2. NO BUDGETS, NO QUERY. An install with no `budgets:` block does not read
//    spend at all — the check costs nothing until it is asked for.
// 3. A BUDGET THAT CANNOT BE READ REFUSES. If `budgets:` is configured and
//    the `spend` query is not loaded, the guard says so and stops rather
//    than waving calls through: a control that silently cannot run is worse
//    than no control, because you believe you have one.
//
// The 80 % warning (R2) rides the same pass and is deduped on the calendar
// window, so it arrives once per day or per month and not once per call.

import {
  BUDGET_EXCEEDED,
  budgetRefusalMessage,
  budgetWarningMessage,
  budgetWindowKey,
  checkBudgets,
  finishRun,
  spentFrom,
  startRun,
  SPEND_QUERY,
  type BudgetHit,
  type Compute,
  type SpendRow,
} from "@foldedspacelabs/metistry-core";
import type { TurnGuard, TurnSpec } from "./engine.js";

export interface BudgetDb {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** The runs `kind` every budget record carries — one word to query for "what did budgets do". */
export const BUDGET_KIND = "budget";

/** Thrown to refuse a turn. The drain decides what a refusal LOOKS like (a Needs You window for chat, a failure for a routine); this only says no. */
export class BudgetRefusal extends Error {
  constructor(
    readonly hit: BudgetHit,
    message: string,
  ) {
    super(message);
    this.name = "BudgetRefusal";
  }
}

/** True when an error is a budget refusal — the drain's branch, without importing the class into three files. */
export function isBudgetRefusal(err: unknown): err is BudgetRefusal {
  return err instanceof BudgetRefusal || (err instanceof Error && err.message.startsWith(`${BUDGET_EXCEEDED}:`));
}

export interface BudgetDeps {
  db: BudgetDb;
  /** The configuration in force, read fresh per turn: `compute.yaml` is hot-reloaded and a budget raised mid-day must take effect mid-day. */
  compute: () => Compute;
  /**
   * The `spend` named query, or undefined when it is not loaded. Injected as
   * a function rather than a QueryStore so this module never learns what a
   * QueryStore is — and so a test needs neither.
   */
  spend?: (() => Promise<SpendRow[]>) | undefined;
  component?: string | undefined;
  now?: (() => Date) | undefined;
}

/** Has this (scope, window, calendar window) already been recorded? One row per window, not one per call. */
async function alreadyRecorded(db: BudgetDb, tool: string, key: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM runs WHERE kind = $1 AND tool = $2 AND meta->>'window_key' = $3 LIMIT 1`, [BUDGET_KIND, tool, key]);
  return rows.length > 0;
}

async function record(db: BudgetDb, component: string, tool: string, hit: BudgetHit, key: string, message: string): Promise<void> {
  const id = await startRun(db, {
    component,
    kind: BUDGET_KIND,
    tool,
    meta: { window_key: key, scope: hit.scope, window: hit.window, field: hit.field, limit: hit.limit, spent: hit.spent, action: hit.action },
  });
  await finishRun(db, id, { ok: false, error: message });
}

/**
 * The gate. Returns normally to allow the turn; throws `BudgetRefusal` to
 * stop it before a single token is bought.
 */
export function makeBudgetGuard(deps: BudgetDeps): TurnGuard {
  const component = deps.component ?? "assistant";
  const now = deps.now ?? (() => new Date());
  return async (spec: TurnSpec) => {
    const cfg = deps.compute();
    const budgets = cfg.budgets;
    if (!budgets || (budgets.instance === undefined && Object.keys(budgets.providers ?? {}).length === 0)) return;

    const provider = spec.assignment?.provider ?? "";
    if (!deps.spend) {
      throw new BudgetRefusal(
        { scope: "instance", window: "daily", field: "budgets", limit: 0, spent: 0, fraction: 1, over: true, action: "stop" },
        `${BUDGET_EXCEEDED}: compute.yaml sets budgets, but the \`${SPEND_QUERY}\` named query is not loaded, so spend cannot be read — ` +
          `add seed/queries to METISTRY_QUERIES_DIRS, or remove budgets: from compute.yaml. Refusing rather than spending against a limit nothing can measure.`,
      );
    }
    const rows = await deps.spend();
    const verdict = checkBudgets({
      budgets,
      provider,
      spent: { instance: spentFrom(rows), provider: spentFrom(rows, provider) },
      critical: spec.assignment?.critical === true,
    });

    for (const hit of verdict.warnings) {
      const key = budgetWindowKey(hit, now());
      if (await alreadyRecorded(deps.db, "warn", key)) continue;
      await record(deps.db, component, "warn", hit, key, budgetWarningMessage(hit));
    }
    if (verdict.refusal) {
      const message = budgetRefusalMessage(verdict.refusal);
      await record(deps.db, component, "stop", verdict.refusal, `${budgetWindowKey(verdict.refusal, now())}:${Date.now()}`, message);
      throw new BudgetRefusal(verdict.refusal, message);
    }
  };
}

/**
 * The Eve adopt: a CHAT turn refused by a budget offers one more window as a
 * Needs You item instead of dying quietly; a routine or crew turn just fails
 * with `budget_exceeded` (the runner's preflight has already stopped
 * scheduling them — docs/ops/compute.md "Budgets").
 *
 * The offer is a `decision` proposal in the one queue (D7) plus the alert
 * that carries it to the phone. It does NOT raise the budget itself and
 * could not: `compute.yaml` is a §4.7 protected path, so the limit moves by
 * the user's hand or not at all (invariant 2). What the item buys is that
 * the user hears about it where they already read things, with the exact
 * field to edit in front of them.
 *
 * Once per window: a refusal storm must not become a notification storm.
 */
export async function offerBudgetWindow(db: BudgetDb, thread: string, hit: BudgetHit, now: Date = new Date()): Promise<boolean> {
  const key = `offer:${budgetWindowKey(hit, now)}`;
  if (await alreadyRecorded(db, "offer", key)) return false;
  const title = `Compute is over its ${hit.scope} ${hit.window} budget — allow one more window?`;
  const body =
    `${budgetRefusalMessage(hit)}\n\n` +
    `Nothing is running on this budget until the window resets or ${hit.field} changes in compute.yaml ` +
    `(\`metistry compute budget ${hit.scope === "instance" ? "instance" : hit.scope} --${hit.window} <usd>\`).`;
  await db.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('decision', 'assistant', 'internal', $1)`, [
    JSON.stringify({
      title,
      options: [`Allow one more ${hit.window} window (raise ${hit.field})`, "Leave it stopped until the window resets"],
      thread,
      budget: { scope: hit.scope, window: hit.window, field: hit.field, limit: hit.limit, spent: hit.spent },
    }),
  ]);
  await db.query(`INSERT INTO outbound_messages (thread, text, kind) VALUES ($1, $2, 'alert')`, [thread, body]);
  const id = await startRun(db, {
    component: "assistant",
    kind: BUDGET_KIND,
    tool: "offer",
    meta: { window_key: key, scope: hit.scope, window: hit.window, field: hit.field, thread },
  });
  await finishRun(db, id, { ok: true, meta: { offered: true } });
  return true;
}
