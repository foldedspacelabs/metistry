// Project scope (§4.19): the collaboration boundary for every tasks_* tool
// and the nudge. One rule, in one place, so the tools and the nudge cannot
// drift:
//
// - an EXTERNAL principal is a member of exactly `projects`; empty = none
//   (a capture-only agent sees no task at all);
// - an INTERNAL principal (the instance's own assistant — its scope comes
//   from configuration the user's hand controls, not from a grant it asked
//   for) with an EMPTY `projects` list is a member of EVERY project: the hub
//   holds the shared list, and the owner's assistant is the hub's voice. A
//   non-empty list narrows it like any other agent.
//
// Tasks with no project stay invisible to every agent, internal included —
// a project is the unit of coordination, and a row outside one is the
// user's alone.

import type { AgentPrincipal } from "./types.js";

/** True when the principal's membership is "every project" (internal + empty list). */
export function allProjects(principal: AgentPrincipal): boolean {
  return principal.kind === "internal" && principal.projects.length === 0;
}

/** Membership test for one project slug. */
export function memberOf(principal: AgentPrincipal, project: string | null): project is string {
  if (project === null) return false;
  return allProjects(principal) || principal.projects.includes(project);
}
