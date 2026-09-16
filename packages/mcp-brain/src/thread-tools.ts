// tasks_comment / tasks_thread — the room on a `work` row
// (docs/ops/threads.md, docs/research/2026-09-12-agent-room-review.md
// phase 2). An adapter over the artifacts module's service, adding
// nothing: the principal comes from the credential, the project boundary,
// the ping-pong cap and the escalation to the owner are all the service's.
//
// Two absences are the design, not an omission:
//
// - **No addressee.** There is no `to_agent`, no `@name`, no thread id to
//   target. A message cannot wake anyone; agents read the room when they
//   claim the row. Triggering stays where its policy already lives
//   (`agents_delegate`, review dispatch), so the collaboration rule holds
//   by the absence of a field rather than by a warning in a prompt.
// - **No resolve.** Closing a room is the user's hand
//   (`POST /api/work/:id/thread/resolve`); the service refuses every other
//   principal, and nothing in the system resolves a room on a timer.
//
// Scope is the same grant every tasks_* tool gets: a work row outside the
// caller's projects — and any row with no project at all — is `not_found`.

import { z } from "zod";
import { ArtifactsError, type ArtifactsService } from "@foldedspacelabs/metistry-artifacts";
import { toPrincipal } from "./artifacts-tools.js";
import { done, fail, type Outcome } from "./outcome.js";
import type { AgentPrincipal } from "./types.js";

export const THREAD_TOOL_NAMES = ["tasks_comment", "tasks_thread"] as const;
export type ThreadToolName = (typeof THREAD_TOOL_NAMES)[number];

/** The server's registration function, narrowed to these names. */
export type Register = <S extends z.ZodRawShape>(name: ThreadToolName, description: string, inputSchema: S, body: (args: z.infer<z.ZodObject<S>>) => Promise<Outcome>) => void;

const workId = z.number().int().positive();

const NOT_AVAILABLE = "work threads are not configured in this deployment (the console needs a vault bridge — docs/ops/reconciler.md)";

export function registerThreadTools(reg: Register, service: ArtifactsService | undefined, agent: AgentPrincipal): void {
  const principal = toPrincipal(agent);

  const guard = async (fn: (svc: ArtifactsService) => Promise<Outcome>): Promise<Outcome> => {
    if (!service) return fail("not_available", NOT_AVAILABLE);
    try {
      return await fn(service);
    } catch (err) {
      if (err instanceof ArtifactsError) return fail(err.code, err.message);
      throw err;
    }
  };

  reg(
    "tasks_comment",
    "Say something on a task in your projects — scope questions, findings, what you are about to do. Whoever reads the task reads it; it wakes nobody (use agents_delegate to make someone act). Past the agent-only cap it escalates to the user.",
    { work_id: workId, body: z.string().min(1).max(20_000) },
    (a) =>
      guard(async (svc) => {
        const r = await svc.workComment({ work: a.work_id, body: a.body }, principal);
        if (!r) return fail("not_found");
        return r.demoted
          ? done({ demoted: true, proposal_id: r.proposal_id, cap: r.cap }, { work_id: a.work_id, demoted: true, proposal_id: r.proposal_id })
          : done({ comment: r.comment }, { work_id: a.work_id, comment: r.comment.id });
      }),
  );

  reg(
    "tasks_thread",
    "Read the room on a task: every message oldest-first, who is in it, and whether the user resolved it. Read it before you claim — it is what the last crew left behind.",
    { work_id: workId },
    (a) =>
      guard(async (svc) => {
        const t = await svc.workThread(a.work_id, principal);
        if (!t) return fail("not_found");
        return done(t, { work_id: a.work_id, comments: t.comments.length, state: t.state });
      }),
  );
}
