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
 * **All three stored kinds arrive intact since P2.** The registry has always
 * written `crew` on a sub-agent's row (`apps/console/src/crews.ts`), and the
 * host used to collapse it to `external` before this function ever saw it —
 * so a crew was indistinguishable from a foreign agent and `/mcp` could not
 * hold it to the toolset its manifest declares (§2.2, §2.3). Now the row's
 * own kind decides the role, and the crew's `uses` groups ride along as the
 * allowlist `may()` refuses outside of.
 *
 * `source` is a description, not a decision: no rule reads it. It is carried
 * so that P3's one renderer — and the refusal that says "your scope is
 * configuration, not a grant" — have a field to read instead of a fourth
 * prose reconstruction (§2.7). A crew's is the manifest the host loaded;
 * without one (a crew row this console cannot see a manifest for) it is the
 * registry, which is where the row itself is.
 */
export function principalOf(p: AgentPrincipal): Principal {
  const internal = p.kind === "internal";
  const crew = p.kind === "crew";
  const role: Role = internal ? "assistant" : crew ? "crew" : "agent";
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
      // Copied like the areas: a grant rewritten mid-request cannot widen a
      // decision already being made. Absent stays absent — none.
      ...(p.grants.connections !== undefined ? { connections: [...p.grants.connections] } : {}),
    },
    source: internal ? "environment" : crew && p.manifest !== undefined ? { manifest: p.manifest } : "registry",
    // Copied for the same reason the areas are, and only for a crew: on any
    // other role an allowlist would be a rule nothing declared.
    ...(crew ? { uses: [...(p.uses ?? [])] } : {}),
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
