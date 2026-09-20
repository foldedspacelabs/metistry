// The credential this bridge authenticated, as the shape `core`'s `may()`
// decides on. One mapping function, called at the doors — **no storage
// change**: the registry row, the `.env`-derived internal row and the crew's
// manifest-derived row are all still written exactly where they were (P1 of
// docs/research/2026-09-19-grants-and-access-simplified.md §4).
//
// This file is the ONLY place in the package that reads `principal.kind`.
// That is the point: `kind` was a proxy for three different questions —
// "which writer am I", "where did this row's grants come from", "is this a
// crew" — reconstructed in prose at every door (§2.3, §2.7). Here it becomes
// a `role` and a `source` once, and every door asks `may()`.

import type { Principal, Role } from "@foldedspacelabs/metistry-core";
import type { AgentPrincipal } from "./types.js";

/**
 * An agent bearer → the decision principal.
 *
 * **`crew` is not produced yet**, and that is faithful rather than an
 * oversight: `authenticateAgent` still collapses the registry's third stored
 * `kind` to `external` (§2.3), so a crew arrives here indistinguishable from
 * any other foreign agent — exactly as it did before P1. P2 is where the row
 * keeps its own kind, `uses` rides on the principal, and `/mcp` enforces the
 * crew's toolset at the door instead of in the caller (§2.2).
 *
 * `source` is likewise a description, not a decision: no rule below reads it
 * today. It is carried so that P3's one renderer — and the refusal that says
 * "your scope is configuration, not a grant" — have a field to read instead
 * of a fourth prose reconstruction (§2.7).
 */
export function principalOf(p: AgentPrincipal): Principal {
  const internal = p.kind === "internal";
  const role: Role = internal ? "assistant" : "agent";
  return {
    id: p.id,
    role,
    scope: {
      tier: p.grants.tier,
      // Copied, so a scope already handed to a request cannot widen because
      // the registry row behind it was rewritten while the request ran.
      areas: [...p.grants.areas],
      queries: p.grants.queries === true,
      // The internal rule (§4.19): the hub holds the shared list and the
      // owner's assistant is the hub's voice, so an EMPTY list on an internal
      // credential is every project — `null` here. A non-empty list narrows
      // it like any other agent's. Tasks with no project stay invisible to
      // every agent, internal included; that is `may()`'s null-slug case.
      projects: internal && p.projects.length === 0 ? null : [...p.projects],
      autonomy: p.autonomy,
    },
    source: internal ? "environment" : "registry",
  };
}

/**
 * The `internal | external` value the `proposals.trust` column and the
 * artifacts module's principal carry. A RECORD of who acted, not a decision
 * about what they may do — but derived here anyway, so `kind` has exactly one
 * reader in this package and the misuse test can say so with a grep.
 */
export function trustOf(p: AgentPrincipal): "internal" | "external" {
  return principalOf(p).role === "assistant" ? "internal" : "external";
}
