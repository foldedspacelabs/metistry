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
// validator uses (core's `validAgentAreaGrant` — the AGENT-grant rule, never
// a statement about what the OWNER may see), so a crafted prefix — `..`,
// `.metistry/`, `Artifacts/`, a lowercase folder, a path outside the vault —
// never reaches a proposal, let alone a grant. One rule, one regex, two
// doors.
//
// **After a Decline** (ruled 2026-09-19 C: "this may frustrate an agent …
// the agent should maybe be told to escalate if they really do need
// access"): the re-ask is not silently a second identical row and not
// silently deduped into the answered one either. The tool answers with the
// decision the owner already gave — declined, when, their note if there was
// one — and says the one way forward: ask again with `escalate: true` and a
// fuller reason. That ask makes a NEW row flagged `escalated`, which Needs
// You renders as "asked again after a decline". Two declines in a row close
// it: the third ask is refused with "ask the owner directly", because a
// mechanism that can be worked indefinitely is not a control. All of it is
// enforced HERE, at the tool — never by telling a model to be considerate.
//
// **The ceiling leaves a record** (C42, T2-2). That third refusal writes no
// proposal — it is not a question the owner has not answered — so without
// more it was invisible: an agent that had hit the ceiling looked exactly
// like one that had stopped asking. Every ceiling refusal now writes one
// `runs` row, kind `access_ceiling` (`ACCESS_CEILING_KIND`), naming the agent,
// the area and the declines behind it, and the console's Agents panel lists
// them beside the grant they are about (`GET /api/agents`'
// `access_ceilings`). It is the record, never a second queue: the owner acts
// on it on Agents, where the whole credential is in view.

import { AREA_PREFIX_REFUSAL, describeScope, finishRun, redactSecrets, SKIP_FEEDBACK, startRun, validAgentAreaGrant, type ErrorCode, type ScopeView } from "@foldedspacelabs/metistry-core";
import { principalOf } from "./principal.js";
import type { AgentPrincipal, Db, Tier } from "./types.js";

/** The `proposals.kind` this writes. Recognised by the console's triage branch and by nothing else. */
export const ACCESS_REQUEST_KIND = "access_request";

/**
 * The `runs.kind` a ceiling refusal writes (C42). Read by the console's
 * Agents panel (`accessCeilings` in apps/console/src/agents.ts) — imported
 * there, never respelled. No migration: `runs.kind` is free text.
 */
export const ACCESS_CEILING_KIND = "access_ceiling";

/** What an `access_ceiling` row's `meta` carries — everything the Agents panel shows, read off the record rather than the caller. */
export interface AccessCeilingMeta {
  agent: string;
  area: string;
  /** The consecutive declines that closed it — `MAX_DECLINES` or more. */
  declines: number;
  /** The newest decline: the row the owner answered, and when. */
  last_proposal: number;
  last_declined_at: string | null;
}

export interface AccessRequestInput {
  area: string;
  reason: string;
  /** Ask again after a decline. Ignored when nothing was declined — an escalation flag on a first ask would be a lie in the owner's queue. */
  escalate?: boolean | undefined;
}

export type AccessRequestOutcome =
  | {
      ok: true;
      id: number;
      area: string;
      /** true = a pending ask for this (agent, area) already existed and this is its id. */
      replayed: boolean;
      /** true = this row is a second ask after a decline, and the queue says so. */
      escalated: boolean;
    }
  | { ok: false; code: ErrorCode; message: string; expose?: Record<string, unknown> };

/** What the row carries. `current_*` is read off the CREDENTIAL, never off the request (§4.19). */
export interface AccessRequestPayload {
  title: string;
  area: string;
  reason: string;
  current_tier: Tier;
  current_areas: string[];
  /**
   * What this credential holds, in the ONE vocabulary (core's
   * `describeScope` — P3 §3.4). The Needs You card renders THIS, so the
   * sentence the owner reads when they answer is the sentence the Agents
   * panel and `metistry agents list` show — one record, said one way
   * (§2.10). The two fields above stay: they are the machine-readable half,
   * and a row written before this existed still renders from them.
   */
  current_scope: ScopeView;
  provenance: { agent: string; via: string; submitted_at: string };
  /** Present only on a re-ask after a decline: the queue renders it, and the prior row is named so the owner can read what they answered. */
  escalated?: true;
  prior_proposal?: number;
  prior_declined_at?: string | null;
}

const MAX_REASON = 1_000;  // limit: fixed — the API contract (the tool's schema declares the same bound); a reason this long is an essay, and the owner is reading it in a queue
const MAX_NOTE = 300;  // limit: fixed — how much of the owner's note rides back in a refusal envelope; the whole note is on the row they wrote it on
const MAX_DECLINES = 2;  // limit: fixed — the escalation ladder's height: ask, escalate once, then ask the owner in words instead

/**
 * The decisions this (agent, area) has already had, newest first. Only the
 * settled ones: a pending row is the dedupe case above, not a decision.
 */
interface PriorDecision {
  id: number;
  decision: string;
  decidedAt: string | null;
  /** The owner's words, or null — never the SKIP marker, which is not a reason and is kept out of every agent-facing path. */
  note: string | null;
}

/**
 * Raise one access request.
 *
 * - **Deduplicated on `(agent, area)` while one is PENDING** — the existing
 *   id comes back with `replayed: true`, so an agent that retries (or that
 *   keeps hitting the same refusal) cannot fill the owner's queue with the
 *   same sentence. Migration 0022's partial unique index makes that true
 *   under concurrency too, rather than only in the read-then-write below it.
 *   It is also the rate limit on escalations: one open ask per (agent, area)
 *   is one open escalation.
 * - **After a decline** the ask is answered rather than repeated (above), and
 *   after two consecutive declines it is refused outright.
 * - **Every principal may ask, the assistant included** (ruled 2026-09-19 B).
 *   An approval for an internal row PERSISTS across the restart that re-syncs
 *   its configured grants — apps/console/src/agents.ts's grant overrides —
 *   which is what made this refusable before and does not any more.
 */
export async function requestAccess(db: Db, principal: AgentPrincipal, input: AccessRequestInput): Promise<AccessRequestOutcome> {
  const area = typeof input.area === "string" ? input.area.trim() : "";
  if (!validAgentAreaGrant(area)) {
    return { ok: false, code: "invalid_request", message: `${AREA_PREFIX_REFUSAL} — not the whole vault, not \`.metistry/\`, not \`Artifacts/\`, no traversal` };
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, MAX_REASON) : "";
  if (reason === "") return { ok: false, code: "invalid_request", message: "reason is required — the owner is deciding whether to widen a grant, and an ask with no why is one they cannot answer" };

  const pending = await pendingFor(db, principal.id, area);
  if (pending !== null) return { ok: true, id: pending, area, replayed: true, escalated: false };

  // What the owner has already said about this exact (agent, area). Counted
  // CONSECUTIVELY from the newest: an approval in between resets the ladder,
  // because a decline before a grant is not a standing refusal.
  const declines = await consecutiveDeclines(db, principal.id, area);
  const last = declines[0];
  if (declines.length >= MAX_DECLINES && last) {
    await recordCeiling(db, principal.id, { agent: principal.id, area, declines: declines.length, last_proposal: last.id, last_declined_at: last.decidedAt });
    return {
      ok: false,
      code: "rate_limited",
      message: `the owner has declined ${area} ${declines.length} times — asking again is not a question they have not answered. If it genuinely blocks you, say so in words: raise a \`requests_create\` report naming the area and what it is stopping, and let them come back to it.`,
      expose: { reason: "declined_twice", area, declines: declines.length, decided_at: last.decidedAt, ...(last.note ? { note: last.note } : {}) },
    };
  }
  if (last && !input.escalate) {
    // The answer they already gave, rather than a second identical row. A
    // decline is information the agent never had a way to read before — there
    // is no tool that reads an agent's own proposals — so the tool hands it
    // over here, with the one way forward attached.
    return {
      ok: false,
      code: "forbidden",
      message: `the owner declined this on ${last.decidedAt ?? "an earlier date"}${last.note ? ` — "${last.note}"` : ""}. Work without it if you can. If you genuinely need it, ask once more with escalate: true and a reason that says what they did not know the first time; they will see it flagged as a second ask.`,
      expose: { reason: "declined", area, proposal_id: last.id, decided_at: last.decidedAt, ...(last.note ? { note: last.note } : {}), may_escalate: true },
    };
  }

  // An `escalate: true` with nothing declined behind it is an ordinary ask:
  // the flag describes the row's history, so it is taken from the record and
  // never from the caller's word for it.
  const escalated = last !== undefined;
  const payload: AccessRequestPayload = {
    title: `${principal.id} asks${escalated ? " again" : ""} to read ${area}`,
    area,
    reason,
    current_tier: principal.grants.tier,
    current_areas: [...principal.grants.areas],
    current_scope: describeScope(principalOf(principal)),
    provenance: { agent: principal.id, via: "mcp-brain", submitted_at: new Date().toISOString() },
    ...(last ? { escalated: true as const, prior_proposal: last.id, prior_declined_at: last.decidedAt } : {}),
  };
  const ins = await db.query(
    `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('${ACCESS_REQUEST_KIND}', $1, 'external', $2::jsonb)
     ON CONFLICT (source_agent, (payload->>'area')) WHERE kind = '${ACCESS_REQUEST_KIND}' AND decision = 'pending' DO NOTHING
     RETURNING id`,
    [principal.id, JSON.stringify(redactSecrets(payload))], // secret-named fields never land in the queue (§4.3 default 3)
  );
  if (ins.rows[0]) return { ok: true, id: Number(ins.rows[0].id), area, replayed: false, escalated };
  // Lost the race with a concurrent identical ask: the earlier row wins.
  const again = await pendingFor(db, principal.id, area);
  if (again === null) throw new Error("access request insert returned no row and no pending match"); // unreachable unless the row was decided mid-flight
  return { ok: true, id: again, area, replayed: true, escalated: false };
}

/**
 * One `access_ceiling` row per ceiling refusal (C42): complete on insert —
 * `ok: false`, because the ask was refused, with the refusal's own reason as
 * the error. `component` is the agent, as it is on the `tool` row the same
 * call writes, so an agent's history reads as one list.
 *
 * Best-effort, like the reconciler's `auditRefusal`: the refusal is the
 * control and it stands whether or not its record lands. A record that could
 * not be written must not turn a refusal into a 500 the agent retries.
 */
async function recordCeiling(db: Db, agentId: string, meta: AccessCeilingMeta): Promise<void> {
  try {
    const id = await startRun(db, { component: agentId, kind: ACCESS_CEILING_KIND, tool: "request_access", meta: { ...meta } });
    await finishRun(db, id, { ok: false, error: "declined_twice" });
  } catch (err) {
    console.error("mcp-brain: could not record the access ceiling:", err instanceof Error ? err.message : err);
  }
}

async function pendingFor(db: Db, agentId: string, area: string): Promise<number | null> {
  const { rows } = await db.query(
    `SELECT id FROM proposals WHERE kind = '${ACCESS_REQUEST_KIND}' AND source_agent = $1 AND payload->>'area' = $2 AND decision = 'pending' LIMIT 1`,
    [agentId, area],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/**
 * The run of declines at the head of this (agent, area)'s history, newest
 * first — empty when the last answer was a grant (or there has been none).
 *
 * `deny` is the one stored decision that means "no": Decline writes it with
 * the owner's words, Skip writes it with `SKIP_FEEDBACK` and no words, and a
 * revocation writes it with its own fixed reason. All three are refusals the
 * agent must not simply repeat; only the first carries a note worth relaying,
 * which is why the marker is dropped here rather than quoted back as though
 * the owner had said it.
 */
async function consecutiveDeclines(db: Db, agentId: string, area: string): Promise<PriorDecision[]> {
  const { rows } = await db.query(
    `SELECT id, decision, feedback, decided_at FROM proposals
     WHERE kind = '${ACCESS_REQUEST_KIND}' AND source_agent = $1 AND payload->>'area' = $2 AND decision <> 'pending'
     ORDER BY decided_at DESC NULLS LAST, id DESC LIMIT ${MAX_DECLINES + 1}`,
    [agentId, area],
  );
  const out: PriorDecision[] = [];
  for (const r of rows) {
    if (String(r.decision) !== "deny") break; // an approval (or a revision) ends the run: the ladder starts again
    const feedback = typeof r.feedback === "string" ? r.feedback.trim() : "";
    out.push({
      id: Number(r.id),
      decision: String(r.decision),
      decidedAt: r.decided_at instanceof Date ? r.decided_at.toISOString() : r.decided_at === null || r.decided_at === undefined ? null : String(r.decided_at),
      note: feedback === "" || feedback === SKIP_FEEDBACK ? null : feedback.slice(0, MAX_NOTE),
    });
  }
  return out;
}
