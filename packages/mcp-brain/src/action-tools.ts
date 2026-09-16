// propose_action — the agent's side of an executable `action` proposal
// (docs/ops/actions.md; ADOPT 6 of the 2026-09-16 Taskuary review).
//
// Three properties, all enforced here and none of them prompted for:
//
// - **The kind set is closed.** `{kind, args}` is parsed by core's
//   `actionSchema` before anything is written. The tool's own input schema is
//   deliberately loose (`args` is an object) so the DEFINITION stays small;
//   the SHAPE is still a contract, checked by the closed schema server-side,
//   and a miss comes back naming the path that failed.
// - **The table decides, not the caller.** `deny` refuses with the field that
//   would permit it. `propose` writes a pending row for the user. `allow`
//   runs it on the spot through the host's executor — which is the console
//   calling the same service the owner's own click calls — and the row is
//   STILL written, decided `auto`, carrying the result, so the timeline shows
//   what happened without the user having been there.
// - **Discovery is lazy for this group, by credential.** An agent whose table
//   admits nothing is not offered the tool at all, which is every agent until
//   the owner sets a level. That keeps the bridge's eager definition budget
//   where it was (~4.9k of the 5k line) for everyone who has not opted in, and
//   costs none of the +1 turn a meta-tool index would
//   (docs/research/2026-08-tool-discovery.md).
//
// A failed execution leaves the proposal PENDING with the error on it: the
// user still has a decision to make, and nothing is half-applied because one
// action is one service call.

import { z } from "zod";
import {
  ACTION_KINDS,
  actionWorkId,
  admitsAnyAction,
  describeAction,
  effectiveActions,
  parseAction,
  redactSecrets,
  type Action,
  type ErrorCode,
} from "@foldedspacelabs/metistry-core";
import { done, fail, type Outcome } from "./outcome.js";
import type { AgentPrincipal, Db } from "./types.js";

export const ACTION_TOOL_NAMES = ["propose_action"] as const;
export type ActionToolName = (typeof ACTION_TOOL_NAMES)[number];

/** The server's registration function, narrowed to these names. */
export type Register = <S extends z.ZodRawShape>(name: ActionToolName, description: string, inputSchema: S, body: (args: z.infer<z.ZodObject<S>>) => Promise<Outcome>) => void;

/** What one executed action came back with — the service's own ids, plus the `runs` row that recorded it. */
export type ActionExecution =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: ErrorCode; message: string; details?: Record<string, unknown> };

/**
 * The host's ability to actually DO an action. Injected, because the bridge
 * holds no targets, no vault and no board — the console does, and it reaches
 * them through the routes the owner reaches them through
 * (apps/console/src/actions.ts). Absent = `allow` degrades to `not_available`
 * rather than silently becoming a proposal.
 */
export interface ActionExecutor {
  execute(action: Action, ctx: { proposalId: number; onBehalfOf: string }): Promise<ActionExecution>;
}

const NOT_AVAILABLE = "this deployment has no action executor wired, so an allowed action cannot be run here (docs/ops/actions.md)";

export function registerActionTools(reg: Register, db: Db, principal: AgentPrincipal, executor: ActionExecutor | undefined): void {
  // Lazy by credential: nothing to offer, nothing listed. An agent that has
  // not been given room does not learn the tool exists, which is a narrower
  // surface than a tool that always refuses.
  if (!admitsAnyAction(principal.autonomy)) return;
  const table = effectiveActions(principal.autonomy);
  const admitted = ACTION_KINDS.filter((k) => table[k] !== "deny");

  reg(
    "propose_action",
    `Ask the user's console to do one thing on a work row: ${admitted.join(", ")}. Runs at once where your autonomy allows it, otherwise it waits in Needs You; either way it is recorded. args is the kind's own object (docs/ops/actions.md).`,
    {
      kind: z.enum(ACTION_KINDS),
      args: z.record(z.string(), z.unknown()).describe("dispatch {work_id,target,brief} · task_update {work_id,patch} · comment {work_id|artifact_id+version_id, body} · capture {note,filename?}"),
      reason: z.string().min(1).max(2_000).describe("Why — the user reads this before allowing it."),
    },
    async (a) => proposeAction(db, principal, executor, a.kind, a.args, a.reason),
  );
}

/**
 * The whole path, extracted so the misuse tests can drive it without an MCP
 * client: validate → consult the table → write the row → (allow) execute.
 */
export async function proposeAction(
  db: Db,
  principal: AgentPrincipal,
  executor: ActionExecutor | undefined,
  kind: string,
  args: unknown,
  reason: string,
): Promise<Outcome> {
  const parsed = parseAction({ kind, args });
  if (!parsed.ok) return fail("invalid_request", parsed.error);
  const action = parsed.action;

  const mode = effectiveActions(principal.autonomy)[action.kind];
  if (mode === "deny") {
    return fail(
      "forbidden",
      `autonomy.actions.${action.kind} is deny for ${principal.id} — the user raises it (PUT /api/agents/${principal.id}/autonomy, or \`metistry agents autonomy ${principal.id} --allow ${action.kind}\`); nothing else can (docs/ops/actions.md)`,
      { action: action.kind, mode },
    );
  }
  if (mode === "allow" && !executor) return fail("not_available", NOT_AVAILABLE, { action: action.kind });

  const proposalId = await insertActionProposal(db, principal, action, reason);

  if (mode === "propose") {
    return done({ status: "pending", proposal_id: proposalId, action: action.kind }, { proposal_id: proposalId, action: action.kind, mode });
  }

  // allow: run it now, through the console's own human route. The row above
  // exists first on purpose — an execution nobody can see afterwards is worse
  // than one that failed.
  const run = await executor!.execute(action, { proposalId, onBehalfOf: principal.id });
  if (!run.ok) {
    await db.query(
      `UPDATE proposals SET payload = payload || jsonb_build_object('error', $2::jsonb) WHERE id = $1 AND decision = 'pending'`,
      [proposalId, JSON.stringify({ code: run.code, message: run.message, at: new Date().toISOString(), ...(run.details ?? {}) })],
    );
    return fail(run.code, run.message, { proposal_id: proposalId, action: action.kind, mode });
  }
  await db.query(
    `UPDATE proposals SET decision = 'auto', decided_at = now(), payload = payload || jsonb_build_object('result', $2::jsonb)
     WHERE id = $1 AND decision = 'pending'`,
    [proposalId, JSON.stringify({ ...run.result, at: new Date().toISOString(), by: "auto", on_behalf_of: principal.id })],
  );
  return done({ status: "executed", proposal_id: proposalId, action: action.kind, result: run.result }, { proposal_id: proposalId, action: action.kind, mode });
}

/** One pending `action` row. `work_id` is set where the action names one, so staleness and the room join it for free. */
async function insertActionProposal(db: Db, principal: AgentPrincipal, action: Action, reason: string): Promise<number> {
  // Secret-named fields never land in the queue (§4.3 default 3) — an `args`
  // object came from a model and is not trusted to be free of them.
  const payload = redactSecrets({
    title: describeAction(action),
    action,
    reason,
    provenance: { agent: principal.id, via: "mcp-brain", submitted_at: new Date().toISOString() },
  });
  const { rows } = await db.query(
    `INSERT INTO proposals (kind, source_agent, trust, payload, work_id) VALUES ('action', $1, $2, $3::jsonb, $4) RETURNING id`,
    [principal.id, principal.kind === "internal" ? "internal" : "external", JSON.stringify(payload), actionWorkId(action) ?? null],
  );
  return Number(rows[0]!.id);
}
