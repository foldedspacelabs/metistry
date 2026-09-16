// Running an allowed `action` (docs/ops/actions.md; ADOPT 6 of
// docs/research/2026-09-16-taskuary-review.md).
//
// The one rule this file exists to hold: **an action is not a new capability,
// it is a new door onto an old one.** Every branch below calls exactly the
// service the owner's own click calls — `dispatch()` for a brief, the tasks
// service for the board's arm, the artifacts service for a comment,
// `captureToInbox()` for a capture — with the deciding principal the human
// route uses, so the data policy, the project scope, the lease rules and the
// audit rows all come from the same place they always did. Nothing here
// decides policy; if a call would be refused for the owner it is refused here,
// with the service's own sentence.
//
// The agent that asked travels as `on_behalf_of`: in the payload, in the audit
// row, and nowhere else. It is provenance, never authority (§4.19).
//
// One action is ONE service call. That is what makes "a failure never leaves
// it half-applied" true by construction rather than by a rollback nobody
// tested — there is no second step to strand.

import { Buffer } from "node:buffer";
import { finishRun, startRun, type Action, type ActionKind, type ErrorCode } from "@foldedspacelabs/metistry-core";
import { TasksError, type TasksService } from "@foldedspacelabs/metistry-tasks";
import { ArtifactsError, type ArtifactsService, type Principal } from "@foldedspacelabs/metistry-artifacts";
import { captureToInbox, type CaptureSink } from "@foldedspacelabs/metistry-mcp-brain";
import { dispatch, type TargetRegistry } from "./dispatch.js";
import { refusalCode, refusalMessage } from "./task-routes.js";
import type { Db } from "./auth-store.js";

/**
 * The deciding principal, per service, spelled exactly as that service's
 * human route spells it. Two words for one person is not a drift: `dispatch()`
 * writes `owner` into a task's history and `TasksService` writes `user`, and
 * an action must be indistinguishable from the click it stands in for.
 */
const USER_PRINCIPAL: Principal = { kind: "user", id: "user" };
const TASKS_PRINCIPAL = "user";
const DISPATCH_PRINCIPAL = "owner";

/** What the executor needs. Everything optional degrades to `not_available` with the env var that would supply it — never a silent no-op. */
export interface ActionServices {
  db: Db;
  tasks: TasksService;
  targets?: TargetRegistry | undefined;
  artifacts?: ArtifactsService | undefined;
  inbox: CaptureSink;
}

/** Who asked, and which proposal this is — provenance and the idempotency key, never authority. */
export interface ActionContext {
  proposalId: number;
  onBehalfOf: string;
}

export type ActionOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: ErrorCode; message: string; details?: Record<string, unknown> };

/** The `runs` tool name for one action — `action/<kind>`, so per-kind volume is one `group by`. */
export const actionTool = (kind: ActionKind): string => `action:${kind}`;

/**
 * Execute one validated action as the user. Wrapped in its own two-phase
 * `runs` row (CRIT-8): the door is recorded here, the operation records itself
 * inside the service, and a refusal is a row too — a safety mechanism that
 * leaves no trace is not visible, and one that is not visible is not trusted.
 */
export async function runAction(svc: ActionServices, action: Action, ctx: ActionContext): Promise<ActionOutcome> {
  const runId = await startRun(svc.db, {
    component: "console",
    kind: "action",
    tool: actionTool(action.kind),
    meta: { action: action.kind, proposal: ctx.proposalId, on_behalf_of: ctx.onBehalfOf, principal: "user" },
  });
  let outcome: ActionOutcome;
  try {
    outcome = await execute(svc, action, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRun(svc.db, runId, { ok: false, error: message });
    throw err;
  }
  await finishRun(
    svc.db,
    runId,
    outcome.ok ? { ok: true, meta: { ...outcome.result, run_id: runId } } : { ok: false, error: `${outcome.code}: ${outcome.message}`, meta: outcome.details ?? {} },
  );
  return outcome.ok ? { ok: true, result: { ...outcome.result, run_id: runId } } : outcome;
}

async function execute(svc: ActionServices, action: Action, ctx: ActionContext): Promise<ActionOutcome> {
  switch (action.kind) {
    case "dispatch": {
      if (!svc.targets) {
        return { ok: false, code: "not_available", message: "no compute targets are registered in this deployment — METISTRY_TARGETS_DIRS names the directories to load (default targets/, docs/ops/targets.md)" };
      }
      // The same call POST /api/tasks/:id/dispatch makes, principal and all:
      // the target's data_policy is checked inside it, and a refusal comes
      // back with its violations rather than as a generic failure.
      const r = await dispatch(svc.db, svc.targets, action.args.work_id, action.args.target, action.args.brief, DISPATCH_PRINCIPAL);
      if (r.ok) return { ok: true, result: { ref: r.ref, url: r.url, dispatch_run_id: r.run_id } };
      return { ok: false, code: r.code, message: r.message, ...(r.violations ? { details: { violations: r.violations } } : {}) };
    }

    case "task_update": {
      // The board's arm (docs/ops/board.md). Every refusal below is a WHERE
      // clause in packages/tasks, rendered by the adapter's own sentences so
      // an action and a drag say the same thing about the same row.
      try {
        const patch = action.args.patch;
        const r = await svc.tasks.update(action.args.work_id, TASKS_PRINCIPAL, {
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
          ...(patch.project !== undefined ? { project: patch.project } : {}),
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          note: `applied from action proposal #${ctx.proposalId} (asked by ${ctx.onBehalfOf})`,
        });
        if (r.ok) return { ok: true, result: { work_id: r.task.id, status: r.task.status, owner: r.task.owner, project: r.task.project } };
        return { ok: false, code: refusalCode(r.reason), message: refusalMessage(r, action.args.work_id), details: { refused: r.reason } };
      } catch (err) {
        if (err instanceof TasksError) return { ok: false, code: err.code === "conflict" ? "conflict" : "invalid_request", message: err.message };
        throw err;
      }
    }

    case "comment": {
      if (!svc.artifacts) {
        return { ok: false, code: "not_available", message: "comments need a vault bridge in this deployment — METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER (docs/ops/reconciler.md)" };
      }
      try {
        if (action.args.work_id !== undefined) {
          const r = await svc.artifacts.workComment({ work: action.args.work_id, body: action.args.body }, USER_PRINCIPAL);
          if (!r) return { ok: false, code: "not_found", message: `no work row ${action.args.work_id}` };
          // The ping-pong cap can demote a room instead of storing the
          // message (packages/artifacts/src/policy.ts). That is a real
          // outcome, not a failure: it is reported as what happened.
          return r.demoted
            ? { ok: true, result: { work_id: action.args.work_id, demoted: true, proposal_id: r.proposal_id } }
            : { ok: true, result: { work_id: action.args.work_id, comment_id: r.comment.id } };
        }
        const c = await svc.artifacts.commentCreate({ artifact: action.args.artifact_id!, version: action.args.version_id!, body: action.args.body }, USER_PRINCIPAL);
        if (!c) return { ok: false, code: "not_found", message: `no artifact ${action.args.artifact_id} at version ${action.args.version_id}` };
        return { ok: true, result: { artifact_id: action.args.artifact_id, version_id: action.args.version_id, comment_id: c.id } };
      } catch (err) {
        if (err instanceof ArtifactsError) return { ok: false, code: err.code, message: err.message };
        throw err;
      }
    }

    case "capture": {
      // Keyed on the proposal, so a double-tap on Approve — or a retry after a
      // dropped response — lands one inbox row, not two.
      const bytes = Buffer.from(action.args.note, "utf8");
      const r = await captureToInbox(svc.db, svc.inbox, {
        bytes,
        filename: action.args.filename ?? `action-${ctx.proposalId}.md`,
        mime: "text/markdown",
        note: action.args.note,
        source: "action",
        sourceAgent: ctx.onBehalfOf,
        idempotency: { principal: "action", key: `proposal:${ctx.proposalId}` },
      });
      return { ok: true, result: { inbox_id: r.id, path: r.path, ...(r.replayed ? { replayed: true } : {}) } };
    }
  }
}
