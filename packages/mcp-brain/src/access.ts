// `request_access` (ruled 2026-09-19): an agent that can see a page's TITLE
// and not its content asks the owner for the area that holds it, instead of
// being stuck at a refusal with no next move.
//
// **It grants nothing.** It writes one `proposals` row of kind
// `access_request` into the Needs You queue, with the ask, the reason, and
// what this credential holds right now — and the owner answers it with
// Approve / Revise / Decline like every other request. The widening itself
// goes through the console's existing grants door (`PUT /api/agents/:id/
// grants` — apps/console/src/server.ts's `writeGrants`), the same
// `validateGrants` and the same `agent_admin` audit row the owner's own click
// goes through. Invariant 2 is intact: the grant is still the user's hand.
// Invariant 10 is intact: the console's mutating surface gains no verb —
// Approve is a door onto a service that already existed.
//
// The area is validated HERE, at the tool, against the same rule the grants
// validator uses (core's `validAreaPrefix`), so a crafted prefix — `..`,
// `.metistry/`, `Artifacts/`, a lowercase folder, a path outside the vault —
// never reaches a proposal, let alone a grant. One rule, one regex, two
// doors.

import { AREA_PREFIX_REFUSAL, redactSecrets, validAreaPrefix, type ErrorCode } from "@foldedspacelabs/metistry-core";
import type { AgentPrincipal, Db, Tier } from "./types.js";

/** The `proposals.kind` this writes. Recognised by the console's triage branch and by nothing else. */
export const ACCESS_REQUEST_KIND = "access_request";

export interface AccessRequestInput {
  area: string;
  reason: string;
}

export type AccessRequestOutcome =
  | {
      ok: true;
      id: number;
      area: string;
      /** true = a pending ask for this (agent, area) already existed and this is its id. */
      replayed: boolean;
    }
  | { ok: false; code: ErrorCode; message: string };

/** What the row carries. `current_*` is read off the CREDENTIAL, never off the request (§4.19). */
export interface AccessRequestPayload {
  title: string;
  area: string;
  reason: string;
  current_tier: Tier;
  current_areas: string[];
  provenance: { agent: string; via: string; submitted_at: string };
}

const MAX_REASON = 1_000;  // limit: fixed — the API contract (the tool's schema declares the same bound); a reason this long is an essay, and the owner is reading it in a queue

/**
 * Why an internal principal is refused rather than offered the queue: the
 * instance's own assistant gets its scope from CONFIGURATION in the user's
 * hand (§4.11, docs/ops/assistant-tools.md "Why the assistant's scope is
 * configuration, not a grant"), and `ensureInternalAgent` REPLACES an
 * internal row's grants from that configuration every time the console
 * starts. An approved ask would therefore be a widening that silently
 * disappears at the next restart — worse than no mechanism at all, because
 * the owner would believe they had granted it. The durable answer is
 * `METISTRY_ASSISTANT_AREAS`, and this refusal says so.
 */
export const INTERNAL_REFUSAL =
  "an internal principal's scope is configuration in the user's hand, not a grant to ask for — widening it is METISTRY_ASSISTANT_AREAS (docs/ops/assistant-tools.md). Raise a `requests_create` report naming the area and why instead.";

/**
 * Raise one access request. Deduplicated on `(source_agent, area)` while a
 * pending one exists — the existing id comes back with `replayed: true`, so
 * an agent that retries (or that keeps hitting the same refusal) cannot fill
 * the owner's queue with the same sentence. Migration 0022's partial unique
 * index makes that true under concurrency too, rather than only in the
 * read-then-write above it.
 */
export async function requestAccess(db: Db, principal: AgentPrincipal, input: AccessRequestInput): Promise<AccessRequestOutcome> {
  if (principal.kind === "internal") return { ok: false, code: "forbidden", message: INTERNAL_REFUSAL };
  const area = typeof input.area === "string" ? input.area.trim() : "";
  if (!validAreaPrefix(area)) {
    return { ok: false, code: "invalid_request", message: `${AREA_PREFIX_REFUSAL} — not the whole vault, not \`.metistry/\`, not \`Artifacts/\`, no traversal` };
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, MAX_REASON) : "";
  if (reason === "") return { ok: false, code: "invalid_request", message: "reason is required — the owner is deciding whether to widen a grant, and an ask with no why is one they cannot answer" };

  const pending = await pendingFor(db, principal.id, area);
  if (pending !== null) return { ok: true, id: pending, area, replayed: true };

  const payload: AccessRequestPayload = {
    title: `${principal.id} asks to read ${area}`,
    area,
    reason,
    current_tier: principal.grants.tier,
    current_areas: [...principal.grants.areas],
    provenance: { agent: principal.id, via: "mcp-brain", submitted_at: new Date().toISOString() },
  };
  const ins = await db.query(
    `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('${ACCESS_REQUEST_KIND}', $1, 'external', $2::jsonb)
     ON CONFLICT (source_agent, (payload->>'area')) WHERE kind = '${ACCESS_REQUEST_KIND}' AND decision = 'pending' DO NOTHING
     RETURNING id`,
    [principal.id, JSON.stringify(redactSecrets(payload))], // secret-named fields never land in the queue (§4.3 default 3)
  );
  if (ins.rows[0]) return { ok: true, id: Number(ins.rows[0].id), area, replayed: false };
  // Lost the race with a concurrent identical ask: the earlier row wins.
  const again = await pendingFor(db, principal.id, area);
  if (again === null) throw new Error("access request insert returned no row and no pending match"); // unreachable unless the row was decided mid-flight
  return { ok: true, id: again, area, replayed: true };
}

async function pendingFor(db: Db, agentId: string, area: string): Promise<number | null> {
  const { rows } = await db.query(
    `SELECT id FROM proposals WHERE kind = '${ACCESS_REQUEST_KIND}' AND source_agent = $1 AND payload->>'area' = $2 AND decision = 'pending' LIMIT 1`,
    [agentId, area],
  );
  return rows[0] ? Number(rows[0].id) : null;
}
