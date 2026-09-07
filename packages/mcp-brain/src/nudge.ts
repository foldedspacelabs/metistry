// Tool-result nudges (§4.21): a pull-only agent has no attention channel
// but its own tool calls, so every result carries one terse, deterministic
// line when there is something waiting — ready tasks in its projects, or a
// claim it holds whose lease is about to lapse (or already has). Computed
// server-side from the task list; no model anywhere (invariant 4).

import type { Task, TasksService } from "@foldedspacelabs/metistry-tasks";
import { allProjects, memberOf } from "./scope.js";
import type { AgentPrincipal } from "./types.js";

export interface NudgeOptions {
  /** Warn when a held lease has this many seconds or fewer left. */
  leaseWarningSeconds: number;
}

export async function computeNudge(tasks: TasksService, principal: AgentPrincipal, opts: NudgeOptions, now = Date.now()): Promise<string | null> {
  const parts: string[] = [];
  // ready counts per project, in slug order; an every-project principal gets one unfiltered read
  const ready = new Map<string, number>();
  let bundles = 0; // review bundles (§4.21) addressed to this agent, waiting on the list
  const count = (t: Task) => {
    if (t.project === null) return;
    ready.set(t.project, (ready.get(t.project) ?? 0) + 1);
    if (t.kind === "review" && t.owner === principal.id) bundles++;
  };
  if (allProjects(principal)) {
    for (const t of await tasks.listReady({ limit: 500 })) count(t);
  } else {
    for (const project of principal.projects) {
      ready.set(project, 0);
      for (const t of await tasks.listReady({ project, limit: 500 })) count(t);
    }
  }
  if (bundles > 0) parts.push(`${bundles} review bundle${bundles === 1 ? "" : "s"} queued for you — call tasks_list_ready`);
  for (const project of [...ready.keys()].sort()) {
    const n = ready.get(project) ?? 0;
    if (n > 0) parts.push(`${n} task${n === 1 ? "" : "s"} ready in project ${project} — call tasks_list_ready`);
  }
  const held = await tasks.listForAgent(principal.id);
  for (const t of held) {
    if (!memberOf(principal, t.project) || !t.lease_expires_at) continue;
    const left = Math.round((new Date(t.lease_expires_at).getTime() - now) / 1000);
    if (left <= 0) parts.push(`lease on task #${t.id} expired — call tasks_claim to retake it or tasks_release to hand it back`);
    else if (left <= opts.leaseWarningSeconds) parts.push(`claim on task #${t.id} expires in ${left}s — call tasks_heartbeat`);
  }
  return parts.length > 0 ? `nudge: ${parts.join("; ")}` : null;
}
