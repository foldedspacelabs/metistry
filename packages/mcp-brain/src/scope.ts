// Project scope (§4.19): the collaboration boundary for every tasks_* tool
// and the nudge.
//
// Since P1 (docs/research/2026-09-19-grants-and-access-simplified.md §4) the
// RULE is core's — `may(principal, "read", {kind: "project", …})` — and these
// two functions are the names the tools already call, kept so the call sites
// read as they did. What they no longer hold is a policy opinion of their own:
//
// - an EXTERNAL principal is a member of exactly `projects`; empty = none
//   (a capture-only agent sees no task at all);
// - an INTERNAL principal (the instance's own assistant — its scope comes
//   from configuration the user's hand controls, not from a grant it asked
//   for) with an EMPTY `projects` list is a member of EVERY project: the hub
//   holds the shared list, and the owner's assistant is the hub's voice. A
//   non-empty list narrows it like any other agent. That derivation is
//   `principalOf`'s, once, rather than a `kind === "internal"` here.
//
// Tasks with no project stay invisible to every agent, internal included —
// a project is the unit of coordination, and a row outside one is the
// user's alone.

import { may } from "@foldedspacelabs/metistry-core";
import { principalOf } from "./principal.js";
import type { AgentPrincipal } from "./types.js";

/** True when the principal's membership is "every project" (internal + empty list). */
export function allProjects(principal: AgentPrincipal): boolean {
  return principalOf(principal).scope.projects === null;
}

/** Membership test for one project slug. */
export function memberOf(principal: AgentPrincipal, project: string | null): project is string {
  return may(principalOf(principal), "read", { kind: "project", door: "task", slug: project }).ok;
}
