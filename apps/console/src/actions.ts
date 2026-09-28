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
//
// `connection_call` (T4-9) is the same rule with the connection service — the
// pooled client behind the proxy — as the service. What it adds is the
// confirm token: Approve runs the payload the proxy built, previewed and bound
// to that token when the agent asked, and nothing a client sends with the
// Approve. The token is spent by the Approve that uses it, so the same
// request cannot run twice and a token copied into another row runs nothing.

import { Buffer } from "node:buffer";
import {
  EgressRefused,
  confirmTokenDigest,
  connectionCallDigest,
  finishRun,
  startRun,
  type Action,
  type ActionKind,
  type ErrorCode,
} from "@foldedspacelabs/metistry-core";
import { TasksError, type TasksService } from "@foldedspacelabs/metistry-tasks";
import { ArtifactsError, type ArtifactsService, type Principal } from "@foldedspacelabs/metistry-artifacts";
import { captureToInbox, redeemApprovalToken, releaseApprovalToken, type CaptureSink, type ConnectionsProxy } from "@foldedspacelabs/metistry-mcp-brain";
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
  /** The pooled client the connections proxy dials through (`ConnectionsProxy.call`). Absent → a `connection_call` answers `not_available`. */
  connections?: Pick<ConnectionsProxy, "call"> | undefined;
}

/** Who asked, and which proposal this is — provenance and the idempotency key, never authority. */
export interface ActionContext {
  proposalId: number;
  onBehalfOf: string;
  /** `connection_call` only: the `runs` row whose confirm record the Approve redeems (`payload.preview_run`, written by the proxy with the row). */
  previewRun?: number | undefined;
}

/** How much of an upstream's answer is kept on the request as its result — the rest is in the answer the agent reads, not the queue. */
const CONNECTION_RESULT_MAX_CHARS = 8_000; // limit: fixed — a Needs You row carries a readable result, not an archive; the connection_call runs row is the record

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

    case "connection_call":
      return runConnectionCall(svc, action, ctx);

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

/** The pool's refusal, duck-typed as mcp-brain does: decided before anything was dialled. */
function refusalCodeOf(err: unknown): string | undefined {
  if (err instanceof EgressRefused) return err.code;
  if (err instanceof Error && err.name === "ConnectionRefused" && typeof (err as { code?: unknown }).code === "string") return (err as unknown as { code: string }).code;
  return undefined;
}

/** A pre-dial refusal's code, as this door's envelope says it. */
function refusalAnswer(code: string): ErrorCode {
  switch (code) {
    case "unknown_connection":
    case "tool_not_listed":
    case "tool_off":
      return "not_found";
    case "caller_credential":
      return "invalid_request";
    default:
      return "not_available";
  }
}

/**
 * Approve on an Ask First connection call. Three things before anything is
 * dialled, each a refusal that leaves the request pending with why (C45):
 *
 *   1. the token redeems — the one the proxy minted for THIS request, for the
 *      agent that asked, unspent. A replay, or a token copied into another
 *      row, matches nothing;
 *   2. the payload is the one it previewed — the digest the proxy recorded
 *      against {agent, connection, tool, args}. A row whose arguments were
 *      changed after the preview runs nothing;
 *   3. the pool still agrees — the tool may have moved to Never since.
 *
 * The call is `approved: true` (the pool's Ask First gate) and records its
 * own `connection_call` row, so the audit of what reached a connection is one
 * kind whichever door it came through. A refusal decided before dialling
 * gives the token back — nothing reached the upstream, so Approve may be
 * pressed again once it is fixed; a call that was dialled keeps it spent,
 * because an upstream that failed may still have acted.
 */
async function runConnectionCall(svc: ActionServices, action: Action & { kind: "connection_call" }, ctx: ActionContext): Promise<ActionOutcome> {
  const { connection, tool, args, confirm_token } = action.args;
  if (!svc.connections) {
    return { ok: false, code: "not_available", message: `approving this calls ${tool} on ${connection}, and this console has no connections pool wired — nothing ran (docs/ops/connections.md)` };
  }
  if (ctx.previewRun === undefined || !Number.isSafeInteger(ctx.previewRun)) {
    return { ok: false, code: "invalid_request", message: "this request carries no preview the proxy recorded, so Approve runs nothing — Decline it; the agent can ask again through connections_call" };
  }
  const redeemed = await redeemApprovalToken(svc.db, { previewRun: ctx.previewRun, principal: ctx.onBehalfOf, digest: confirmTokenDigest(confirm_token), proposalId: ctx.proposalId });
  if (!redeemed.ok) {
    return {
      ok: false,
      code: "conflict",
      message: `this request's confirm token ${redeemed.miss === "spent" ? "was already used" : "was not issued for this request"} — nothing ran. Decline it; the agent can ask again`,
      details: { refused: `confirm_${redeemed.miss}` },
    };
  }
  // The server's payload, never the client's: the arguments about to run are
  // held to the digest the proxy recorded when it previewed them.
  if (redeemed.payload !== connectionCallDigest({ principal: ctx.onBehalfOf, connection, tool, args })) {
    return { ok: false, code: "conflict", message: "this request's arguments are not the ones the agent's call previewed — nothing ran. Decline it; the agent can ask again", details: { refused: "confirm_other_payload" } };
  }

  const runId = await startRun(svc.db, {
    component: ctx.onBehalfOf,
    kind: "connection_call",
    tool: "approve",
    meta: { via: "console", connection, connection_tool: tool, mode: "approved", proposal: ctx.proposalId, preview_run: ctx.previewRun, principal: "user", on_behalf_of: ctx.onBehalfOf },
  });
  try {
    const out = await svc.connections.call({ connection, tool, args, approved: true });
    await finishRun(svc.db, runId, { ok: true, meta: { dialled: true, is_error: out.isError, secrets: [...out.secrets] } });
    const text = JSON.stringify(out.content);
    return {
      ok: true,
      result: {
        connection,
        tool,
        is_error: out.isError,
        connection_run: runId,
        ...(text.length <= CONNECTION_RESULT_MAX_CHARS ? { content: out.content } : { content_omitted: true }),
      },
    };
  } catch (err) {
    const refusal = refusalCodeOf(err);
    const message = err instanceof Error ? err.message : String(err);
    if (refusal !== undefined) {
      await releaseApprovalToken(svc.db, ctx.previewRun);
      await finishRun(svc.db, runId, { ok: false, error: refusal, meta: { refusal, detail: message.slice(0, 500) } });
      return { ok: false, code: refusalAnswer(refusal), message: `${connection} refused the call before anything was sent (${refusal}) — nothing ran; Connections shows why, and Approve can be pressed again once it is fixed`, details: { refused: refusal } };
    }
    await finishRun(svc.db, runId, { ok: false, error: message.slice(0, 500), meta: { dialled: true } });
    return {
      ok: false,
      code: "not_available",
      message: `${connection} did not answer the call — it was sent, so it is not repeated; check ${connection} itself, then Decline this request`,
      details: { refused: "upstream" },
    };
  }
}
