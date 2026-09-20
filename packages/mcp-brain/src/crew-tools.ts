// agents_delegate (plan §4.11 "the brief is the context transfer", §4.18.B
// local target, Phase 5 crews) — the ONE tool through which the instance's
// own assistant hands work to a crew. The bridge owns two rules here and
// nothing else:
//
// - internal principals only: a crew never dispatches crews, an external
//   agent never dispatches anything (uniform with knowledge_write — anyone
//   else is told "not granted");
// - the outcome is the host's: the crew registry, the data policy (crew
//   scope ∩ the local target's allow list), and the durable work row live in
//   the host's dispatcher (Metistry's console, apps/console/src/crews.ts),
//   which is where the existing dispatch enforcement is reused rather than
//   duplicated. This adapter adds nothing to it.
//
// The result of a crew run never comes back through this tool: the crew
// reports through its own `requests_create` / `tasks_*` calls and the run lands as a
// `runs` row on the crew's id (component = crew name, kind = crew_run).

import { z } from "zod";
import { may, type ErrorCode } from "@foldedspacelabs/metistry-core";
import { done, fail, refuse, type Outcome } from "./outcome.js";
import { principalOf } from "./principal.js";
import type { AgentPrincipal } from "./types.js";

export const CREW_TOOL_NAMES = ["agents_delegate"] as const;
export type CrewToolName = (typeof CREW_TOOL_NAMES)[number];

/** The server's registration function, narrowed to these names. */
export type Register = <S extends z.ZodRawShape>(name: CrewToolName, description: string, inputSchema: S, body: (args: z.infer<z.ZodObject<S>>) => Promise<Outcome>) => void;

export interface CrewDispatchInput {
  crew: string;
  brief: string;
  /** An existing task the work relates to — carried as a handle, never a payload (§4.19). */
  task_id?: number | undefined;
  /** Caller-supplied; a retried dispatch with the same key returns the existing work row. */
  idempotency_key?: string | undefined;
}

export type CrewDispatchOutcome =
  | {
      ok: true;
      /** The queued work row the assistant's drain loop runs (kind task, owner crew:<name>). */
      work_id: number;
      /** The dispatch audit row (component console, kind dispatch, tool local-crew). */
      run_id: number;
      crew: string;
      /** The effective allow list the brief was checked against: crew scope ∩ target allow. */
      allow: string[];
      /** true when idempotency_key matched an earlier dispatch. */
      deduplicated: boolean;
    }
  | { ok: false; code: ErrorCode; message?: string | undefined; violations?: unknown[] | undefined };

/** One registered crew as the tool advertises it: its name, and the manifest's own `description` when it wrote one. */
export interface CrewSummary {
  name: string;
  description?: string | undefined;
}

/** The host's side of dispatch: registry lookup, policy, durable enqueue. Injected; the bridge never sees a manifest. */
export interface CrewDispatcher {
  dispatch(input: CrewDispatchInput, principal: AgentPrincipal): Promise<CrewDispatchOutcome>;
  /** The registered crews, for the tool definition and `not_found` hints. */
  crews(): CrewSummary[];
}

// The roster's two caps (H8). It is a HINT inside one field's description,
// spent out of the same definition-token budget PoC-17 measured, so it is
// bounded rather than as long as the registry happens to be.
// limit: fixed — a 40-crew install must not double the brain's definition surface to advertise them all; past this the roster says "and N more" and the assistant asks
const ROSTER_MAX = 20;
// limit: fixed — one line per crew: a description longer than this is a paragraph, and what distinguishes two crews is in its first clause
const ROSTER_CHARS = 120;

/**
 * The roster sentence appended to the `crew` field's description: each crew's
 * name and what its manifest says it does, so the assistant CHOOSES from the
 * descriptions instead of learning the registry by refusal.
 *
 * The names come from the host's registry every time the tool is registered
 * (the brain builds one server per request), so an edited or removed manifest
 * shows up on the next call rather than at the next restart.
 */
export function crewRoster(crews: readonly CrewSummary[]): string {
  if (crews.length === 0) return " None are registered in this deployment.";
  const shown = crews.slice(0, ROSTER_MAX).map((c) => {
    const d = (c.description ?? "").replaceAll(/\s+/g, " ").trim();
    if (d === "") return c.name;
    return `${c.name} — ${d.length > ROSTER_CHARS ? `${d.slice(0, ROSTER_CHARS - 1).trimEnd()}…` : d}`;
  });
  const more = crews.length > ROSTER_MAX ? `; and ${crews.length - ROSTER_MAX} more` : "";
  return ` Registered: ${shown.join("; ")}${more}.`;
}

const NOT_AVAILABLE = "crews are not configured in this deployment (the console loads agents/<area>/<name>.md manifests — docs/ops/crews.md)";

export function registerCrewTools(reg: Register, dispatcher: CrewDispatcher | undefined, principal: AgentPrincipal): void {
  reg(
    "agents_delegate",
    "Delegate a brief to a named helper agent (agents/<area>/<name>.md — its own model, tool groups, and read scope); the brief is the full context transfer. " +
      "A path outside the agent's scope or the local target's data policy is refused with violations, nothing queued. Results return only via the helper's own requests_create/tasks_* calls. Instance assistant only; others get not granted.",
    {
      crew: z
        .string()
        .regex(/^[a-z][a-z0-9-]{0,39}$/)
        .describe(`The helper agent's name (agents/<area>/<name>.md).${dispatcher ? crewRoster(dispatcher.crews()) : ""}`),
      brief: z.string().min(1).max(200_000).describe("Everything the helper needs, in prose. Handles and paths, not pasted secrets."),
      task_id: z.number().int().positive().optional().describe("A related task id, passed to the crew as a handle."),
      idempotency_key: z.string().min(1).max(200).optional(),
    },
    async (a) => {
      const admitted = may(principalOf(principal), "act", { kind: "tool", name: "agents_delegate" });
      if (!admitted.ok) return refuse(admitted);
      if (!dispatcher) return fail("not_available", NOT_AVAILABLE);
      const r = await dispatcher.dispatch(
        { crew: a.crew, brief: a.brief, ...(a.task_id !== undefined ? { task_id: a.task_id } : {}), ...(a.idempotency_key !== undefined ? { idempotency_key: a.idempotency_key } : {}) },
        principal,
      );
      // violations ride in the message (the assistant must see WHICH path or source to remove) and in the audit row's meta
      if (!r.ok) return fail(r.code, r.violations ? `${r.message ?? "refused"}: ${JSON.stringify(r.violations)}` : r.message, r.violations ? { violations: r.violations } : undefined);
      return done(
        { queued: true, work_id: r.work_id, crew: r.crew, allow: r.allow, deduplicated: r.deduplicated, returns_via: "report queue + runs (component = crew name, kind = crew_run)" },
        { crew: r.crew, work_id: r.work_id, dispatch_run_id: r.run_id, deduplicated: r.deduplicated },
      );
    },
  );
}
