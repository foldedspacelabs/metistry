// Tool-result nudges (§4.21): a pull-only agent has no attention channel
// but its own tool calls, so every result carries one terse, deterministic
// line when there is something waiting — ready tasks in its projects, or a
// claim it holds whose lease is about to lapse (or already has). Computed
// server-side from the task list; no model anywhere (invariant 4).

import type { TasksService } from "@foldedspacelabs/metistry-tasks";
import type { AgentPrincipal } from "./types.js";

export interface NudgeOptions {
  /** Warn when a held lease has this many seconds or fewer left. */
  leaseWarningSeconds: number;
}

export async function computeNudge(tasks: TasksService, principal: AgentPrincipal, opts: NudgeOptions, now = Date.now()): Promise<string | null> {
  const parts: string[] = [];
  const projects = [...principal.projects].sort();
  for (const project of projects) {
    const n = (await tasks.listReady({ project, limit: 500 })).length;
    if (n > 0) parts.push(`${n} task${n === 1 ? "" : "s"} ready in project ${project} — call tasks_list_ready`);
  }
  const held = await tasks.listForAgent(principal.id);
  for (const t of held) {
    if (t.project === null || !principal.projects.includes(t.project) || !t.lease_expires_at) continue;
    const left = Math.round((new Date(t.lease_expires_at).getTime() - now) / 1000);
    if (left <= 0) parts.push(`lease on task #${t.id} expired — call tasks_claim to retake it or tasks_release to hand it back`);
    else if (left <= opts.leaseWarningSeconds) parts.push(`claim on task #${t.id} expires in ${left}s — call tasks_heartbeat`);
  }
  return parts.length > 0 ? `nudge: ${parts.join("; ")}` : null;
}
