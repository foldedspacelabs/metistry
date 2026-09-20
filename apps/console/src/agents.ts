// External-agent registry (§4.2 management surface, §4.11 read tiers,
// §4.19 trust rules). The second credential class, structurally distinct
// from owner sessions/tokens (CRIT-7): an agent token authenticates the
// agent surface only, and its grants live HERE, on the server, attached to
// the token — never asserted by the agent, never carried in a request.
//
// `authenticateAgent` is the reusable principal source: a pure function of
// (db, Authorization header). The future mcp-brain bridge calls the same
// thing, so there is one place to get "who is this agent" right.

import {
  ACTION_KINDS,
  AREA_PREFIX_REFUSAL,
  ACTION_MODES,
  AUTONOMY_LEVELS,
  autonomyWidenings,
  effectiveActions,
  ensureProject,
  finishRun,
  intEnv,
  mintToken,
  parseBearer,
  startRun,
  tokenHash,
  validAreaPrefix,
  VAULT_ROOT_AREA,
  type ActionKind,
  type ActionMode,
  type AutonomyLevel,
} from "@foldedspacelabs/metistry-core";
import { ACCESS_REQUEST_KIND, underAreas } from "@foldedspacelabs/metistry-mcp-brain";
import type { Db } from "./auth-store.js";

export const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const AGENT_KINDS = ["external", "internal"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export const TIERS = ["none", "index", "areas"] as const;
export type Tier = (typeof TIERS)[number];

/** A grant is a read tier plus, for `areas`, the vault prefixes it covers. `queries` is a separate axis — mcp-brain's queries_list/queries_run (invariant 3's read path) — default false; internal principals get it regardless (mcp-brain's own rule, not this one). */
export interface Grants {
  tier: Tier;
  areas: string[];
  queries?: boolean;
}

/**
 * The server-side principal for an agent call (§4.20 Principal, kind=agent).
 * `kind` distinguishes the instance's own assistant (`internal`, scope from
 * configuration in the user's hand) from foreign agents (`external`, scope
 * from user-issued grants); mcp-brain reads it for its project rule only.
 */
export interface AgentPrincipal {
  id: string;
  kind: AgentKind;
  grants: Grants;
  projects: string[];
  /** The A3 half of `agents.autonomy` (docs/ops/actions.md) — what this credential may do with an `action`. Absent = observe. */
  autonomy?: { level?: AutonomyLevel | undefined; actions?: Partial<Record<ActionKind, ActionMode>> | undefined } | undefined;
}

/** The registry id of the instance's own assistant (CLAUDE.md naming: never the assistant's name). */
export const INTERNAL_ASSISTANT_ID = "assistant";

/**
 * The bare vault grant: the whole vault, root notes included (`now.md`).
 * Spelled `/` since the vault became the instance directory itself — core's
 * VAULT_ROOT_AREA. Admitted by the validator for `kind: internal` rows
 * ONLY — the owner's own assistant, whose scope is configuration in the
 * user's hand (§4.11) — and the internal default. External agents can never
 * hold it: for them an area grant is a prefix, and "everything" is not an
 * area. Narrow per instance with METISTRY_ASSISTANT_AREAS.
 */
export { VAULT_ROOT_AREA };
export const ASSISTANT_DEFAULT_AREAS = [VAULT_ROOT_AREA] as const;

/**
 * §4.21 optional narrowing below the project default — never widening.
 * Absent keys mean "project members" / the default cap. Set by the user's
 * hand; the artifacts module enforces it at dispatch.
 */
export interface Autonomy {
  may_dispatch_to?: string[];
  /** agent ids and/or the literal "user" */
  accept_from?: string[];
  max_open_bundles?: number;
  /**
   * A3 (docs/ops/actions.md): how much room this agent has with an `action`
   * proposal. The ONE key in this record that can widen rather than narrow —
   * which is why raising it is admitted only through the console's
   * user-principal route, and why every raise is recorded and alerted.
   * Absent = `observe`, so nothing an existing row can do changes.
   */
  level?: AutonomyLevel;
  /** Per-kind override, clamped by `level`; absent kinds take the level's default (core's ACTION_DEFAULTS). */
  actions?: Partial<Record<ActionKind, ActionMode>>;
}

export interface AgentRow {
  id: string;
  display_name: string;
  kind: string;
  grants: Grants;
  projects: string[];
  autonomy: Autonomy;
  created_at: string;
  last_seen_at: string | null;
  revoked: boolean;
  /** S2: this token will be presented from off this machine, so enrolling it took the owner's hand. */
  remote: boolean;
  /** S2: when the owner let it in. Null on a `remote` row means PENDING — the token authenticates nothing yet. */
  approved_at: string | null;
  /** Derived from the two above, so no client has to recombine them and get it wrong. */
  pending: boolean;
}

/** Thrown for caller mistakes; the route maps `code` to the uniform envelope. */
export class AgentError extends Error {
  constructor(public readonly code: "invalid_request" | "conflict" | "not_found" | "forbidden", message: string) {
    super(message);
  }
}

// A vault area prefix: one or more TitleCase segments from the vault root
// (CLAUDE.md casing rule — Obsidian renders these; Linux containers do not
// forgive `areas/`). No traversal, no trailing slash, and no way to spell
// `.metistry/` (it does not start with an uppercase letter) — the machinery
// is not grantable. "Everything" is not an area grant: it is the bare vault,
// spelled `/` and admitted for an internal row alone.
//
// The shape itself is core's `validAreaPrefix` since the access-request path
// landed: an agent asking for an area (mcp-brain's `request_access`) and the
// owner's own hand on `PUT /api/agents/:id/grants` must refuse the SAME
// strings, and two regexes that agree today are a refusal that drifts.
const BARE_VAULT_RE = /^\/$/;
/** The refusal, core's sentence — plus the internal row's extra spelling, which no agent is ever offered. */
const AREA_REFUSAL = AREA_PREFIX_REFUSAL;
const AREA_REFUSAL_WITH_BARE_VAULT = `${AREA_PREFIX_REFUSAL}, or / for the whole vault`;
const MAX_AREAS = 64;  // limit: fixed — a grant list this long is a mistake, not a configuration

export interface GrantsOptions {
  /** The row's kind. `internal` admits the bare vault (`/`); anything else (the default) refuses it. */
  kind?: AgentKind | undefined;
}

/** Validate + normalize a grants payload. Throws AgentError on any miss. */
export function validateGrants(input: unknown, opts: GrantsOptions = {}): Grants {
  const g = (input ?? {}) as { tier?: unknown; areas?: unknown; queries?: unknown };
  if (!TIERS.includes(g.tier as Tier)) throw new AgentError("invalid_request", "tier must be none | index | areas");
  const tier = g.tier as Tier;
  const rawAreas = g.areas === undefined ? [] : g.areas;
  if (!Array.isArray(rawAreas) || rawAreas.length > MAX_AREAS) throw new AgentError("invalid_request", "areas must be a list");
  const bareAllowed = opts.kind === "internal";
  const areas: string[] = [];
  for (const a of rawAreas) {
    if (typeof a !== "string") throw new AgentError("invalid_request", "area must be a string");
    let s = a.trim();
    if (bareAllowed && BARE_VAULT_RE.test(s)) s = VAULT_ROOT_AREA;
    else if (!validAreaPrefix(s)) {
      throw new AgentError("invalid_request", bareAllowed ? AREA_REFUSAL_WITH_BARE_VAULT : AREA_REFUSAL);
    }
    if (!areas.includes(s)) areas.push(s);
  }
  if (tier !== "areas" && areas.length > 0) throw new AgentError("invalid_request", "areas only apply to tier=areas");
  if (tier === "areas" && areas.length === 0) throw new AgentError("invalid_request", "tier=areas needs at least one area");
  if (g.queries !== undefined && typeof g.queries !== "boolean") throw new AgentError("invalid_request", "queries must be a boolean");
  const queries = g.queries === true;
  return { tier, areas, ...(queries ? { queries } : {}) };
}

/** Project ids share the agent slug shape (§4.19 projects are a view, keyed by slug). */
export function validateProjects(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > MAX_AREAS) throw new AgentError("invalid_request", "projects must be a list");
  const out: string[] = [];
  for (const p of input) {
    if (typeof p !== "string" || !AGENT_ID_RE.test(p)) throw new AgentError("invalid_request", "project must be a slug");
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

const MAX_BUNDLE_CAP = 1000;  // limit: fixed — the ceiling on what an autonomy payload may ask for — the API contract, not a knob

/** Validate + normalize an autonomy payload. Unknown keys are refused (a typo must not silently mean "no narrowing"). */
export function validateAutonomy(input: unknown): Autonomy {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new AgentError("invalid_request", "autonomy must be an object");
  const a = input as Record<string, unknown>;
  for (const k of Object.keys(a)) {
    if (!["may_dispatch_to", "accept_from", "max_open_bundles", "level", "actions"].includes(k)) throw new AgentError("invalid_request", `unknown autonomy key ${k}`);
  }
  const out: Autonomy = {};
  const ids = (name: string, v: unknown, allowUser: boolean): string[] => {
    if (!Array.isArray(v) || v.length > MAX_AREAS) throw new AgentError("invalid_request", `${name} must be a list of agent ids`);
    const list: string[] = [];
    for (const x of v) {
      if (typeof x !== "string" || !(AGENT_ID_RE.test(x) || (allowUser && x === "user"))) throw new AgentError("invalid_request", `${name}: ${allowUser ? "agent id or user" : "agent id"} expected`);
      if (!list.includes(x)) list.push(x);
    }
    return list;
  };
  if (a.may_dispatch_to !== undefined && a.may_dispatch_to !== null) out.may_dispatch_to = ids("may_dispatch_to", a.may_dispatch_to, false);
  if (a.accept_from !== undefined && a.accept_from !== null) out.accept_from = ids("accept_from", a.accept_from, true);
  if (a.max_open_bundles !== undefined && a.max_open_bundles !== null) {
    const n = a.max_open_bundles;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_BUNDLE_CAP) throw new AgentError("invalid_request", `max_open_bundles must be an integer 0..${MAX_BUNDLE_CAP}`);
    out.max_open_bundles = n;
  }
  // A3 (docs/ops/actions.md). Shape only here — whether this record may be
  // STORED (a narrowing may come from anywhere; a widening is the owner's
  // hand) is setAutonomy's question, so the validator stays pure and the
  // policy has one home.
  if (a.level !== undefined && a.level !== null) {
    if (!AUTONOMY_LEVELS.includes(a.level as AutonomyLevel)) throw new AgentError("invalid_request", `level must be ${AUTONOMY_LEVELS.join(" | ")}`);
    out.level = a.level as AutonomyLevel;
  }
  if (a.actions !== undefined && a.actions !== null) {
    if (typeof a.actions !== "object" || Array.isArray(a.actions)) throw new AgentError("invalid_request", "actions must be an object of action kind → allow | propose | deny");
    const actions: Partial<Record<ActionKind, ActionMode>> = {};
    for (const [kind, mode] of Object.entries(a.actions as Record<string, unknown>)) {
      if (!ACTION_KINDS.includes(kind as ActionKind)) throw new AgentError("invalid_request", `unknown action kind ${kind} — one of ${ACTION_KINDS.join(" | ")} (docs/ops/actions.md)`);
      if (!ACTION_MODES.includes(mode as ActionMode)) throw new AgentError("invalid_request", `actions.${kind} must be ${ACTION_MODES.join(" | ")}`);
      actions[kind as ActionKind] = mode as ActionMode;
    }
    if (Object.keys(actions).length > 0) out.actions = actions;
  }
  return out;
}

function coerceAutonomy(raw: unknown): Autonomy {
  try {
    return validateAutonomy(raw ?? {});
  } catch {
    return {}; // a malformed stored value narrows nothing — it is never widened either, the defaults apply
  }
}

function coerceGrants(raw: unknown): Grants {
  const g = (raw ?? {}) as Partial<Grants>;
  return { tier: TIERS.includes(g.tier as Tier) ? (g.tier as Tier) : "none", areas: Array.isArray(g.areas) ? g.areas : [], ...(g.queries === true ? { queries: true } : {}) };
}

/**
 * Resolve an agent bearer token to its principal. Pure function of
 * (db, Authorization header): hash lookup, not revoked, **not pending**,
 * bumps last_seen_at. Null on any miss — the caller returns the uniform
 * 401.
 *
 * The pending clause is the whole of S2's enforcement, and it lives in the
 * WHERE rather than in a branch above on purpose: a token awaiting
 * approval does not match, so it takes exactly the path an unknown token
 * takes — same 401, same body, and `last_seen_at` is not bumped either, so
 * there is nothing in the response to tell the two apart. "Enforce at the
 * tool" (CLAUDE.md): the refusal is a row the query cannot see, not a rule
 * a later edit could forget to apply.
 */
export async function authenticateAgent(
  db: Db,
  req: { headers: { authorization?: string | string[] | undefined } },
): Promise<AgentPrincipal | null> {
  const header = req.headers.authorization;
  const token = parseBearer(Array.isArray(header) ? header[0] : header);
  if (!token) return null;
  const { rows } = await db.query(
    `UPDATE agents SET last_seen_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL AND (NOT remote OR approved_at IS NOT NULL)
     RETURNING id, kind, grants, projects, autonomy`,
    [tokenHash(token)],
  );
  const row = rows[0];
  if (!row) return null;
  // `autonomy` rides the principal for the same reason grants do: what this
  // credential may DO is server-side, attached to the token, and never
  // asserted by the caller (§4.19). mcp-brain resolves it through core's
  // `effectiveActions`; nothing downstream re-derives the rules.
  const autonomy = coerceAutonomy(row.autonomy);
  return {
    id: row.id,
    kind: row.kind === "internal" ? "internal" : "external",
    grants: coerceGrants(row.grants),
    projects: row.projects ?? [],
    autonomy: { ...(autonomy.level !== undefined ? { level: autonomy.level } : {}), ...(autonomy.actions !== undefined ? { actions: autonomy.actions } : {}) },
  };
}

export interface InternalAgentConfig {
  /** The bearer the internal agent presents; only its hash is stored. From the user's .env, never minted here. */
  token: string;
  display_name?: string | undefined;
  /** Validated grants (validateGrants with kind internal); default = the whole vault (ASSISTANT_DEFAULT_AREAS). */
  grants?: Grants | undefined;
  /** Validated project slugs; empty = every project, by mcp-brain's internal rule. */
  projects?: string[] | undefined;
}

/**
 * Register (or re-sync) an INTERNAL agent from configuration — the plan's
 * "internal agents get their scope from their manifest" (§4.11), with the
 * environment as the manifest. Idempotent: the row is upserted, the hash is
 * derived from the same token (so a second call with the same token changes
 * nothing), grants and projects are REPLACED from config, and a prior
 * revocation is cleared — the presence of the token in the user's own
 * environment is the decision to run this agent; removing it is how the
 * user turns it off (main.ts revokes when it is absent). The token is never
 * minted or logged here; nothing about it crosses the wire.
 */
export async function ensureInternalAgent(db: Db, id: string, cfg: InternalAgentConfig): Promise<{ id: string; created: boolean }> {
  if (!AGENT_ID_RE.test(id)) throw new AgentError("invalid_request", "id must be a slug ^[a-z][a-z0-9-]{0,39}$");
  if (typeof cfg.token !== "string" || cfg.token.length < 16) throw new AgentError("invalid_request", "internal agent token must be at least 16 characters");
  const grants = cfg.grants ?? validateGrants({ tier: "areas", areas: [...ASSISTANT_DEFAULT_AREAS] }, { kind: "internal" });
  const projects = validateProjects(cfg.projects ?? []);
  for (const p of projects) await ensureProject(db, p); // the project row exists from the first use of its slug (0011)
  const displayName = (cfg.display_name ?? "").trim().slice(0, 120) || `${id} (internal)`;
  const { rows } = await db.query(
    `INSERT INTO agents (id, display_name, kind, token_hash, grants, projects)
     VALUES ($1, $2, 'internal', $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       kind = 'internal',
       display_name = EXCLUDED.display_name,
       token_hash = EXCLUDED.token_hash,
       grants = EXCLUDED.grants,
       projects = EXCLUDED.projects,
       revoked_at = NULL,
       remote = false
     RETURNING (xmax = 0) AS created`,
    [id, displayName, tokenHash(cfg.token), JSON.stringify(grants), projects],
  );
  return { id, created: rows[0]?.created === true };
}

/** The registry, minus anything secret: token hashes never leave the db. */
export async function listAgents(db: Db): Promise<AgentRow[]> {
  const { rows } = await db.query(
    `SELECT id, display_name, kind, grants, projects, autonomy, created_at, last_seen_at,
            revoked_at IS NOT NULL AS revoked, remote, approved_at,
            (remote AND approved_at IS NULL AND revoked_at IS NULL) AS pending
     FROM agents ORDER BY revoked, created_at`,
  );
  return rows.map((r) => ({ ...r, grants: coerceGrants(r.grants), autonomy: coerceAutonomy(r.autonomy) })) as AgentRow[];
}

/**
 * Register an agent and mint its token. The token is returned ONCE.
 *
 * `remote: true` (S2) is the caller saying this bearer will be presented
 * from off this machine. The token is minted either way — there is nothing
 * to hand over later, because the console shows a token once — but a
 * remote row starts PENDING and authenticates nothing until the owner
 * approves it. An `internal` row can never be remote: its token comes from
 * the user's own environment, which IS the approval (§4.11).
 */
export async function createAgent(
  db: Db,
  input: { id?: unknown; display_name?: unknown; kind?: unknown; remote?: unknown },
): Promise<{ id: string; token: string; pending: boolean }> {
  const id = typeof input.id === "string" ? input.id : "";
  if (!AGENT_ID_RE.test(id)) throw new AgentError("invalid_request", "id must be a slug ^[a-z][a-z0-9-]{0,39}$");
  const displayName = typeof input.display_name === "string" ? input.display_name.trim().slice(0, 120) : "";
  if (!displayName) throw new AgentError("invalid_request", "display_name required");
  const kind = input.kind === undefined ? "external" : input.kind;
  if (!AGENT_KINDS.includes(kind as (typeof AGENT_KINDS)[number])) throw new AgentError("invalid_request", "kind must be external | internal");
  if (input.remote !== undefined && typeof input.remote !== "boolean") throw new AgentError("invalid_request", "remote must be a boolean");
  const remote = input.remote === true;
  if (remote && kind !== "external") throw new AgentError("invalid_request", "remote applies to kind external only");
  const token = mintToken(32);
  try {
    await db.query(`INSERT INTO agents (id, display_name, kind, token_hash, remote, approved_at) VALUES ($1, $2, $3, $4, $5, $6)`, [
      id, displayName, kind, tokenHash(token), remote, remote ? null : new Date().toISOString(),
    ]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new AgentError("conflict", "agent id already registered");
    throw err;
  }
  return { id, token, pending: remote };
}

/**
 * The owner's hand on a pending enrolment (S2). Idempotent — approving an
 * already-approved row is a no-op that still answers true, because the
 * owner's answer arriving twice (from the console and from the Needs You
 * queue) must not read as a failure. False when there is no such row, when
 * it is revoked, or when it was never remote (nothing to approve).
 */
export async function approveAgent(db: Db, id: string): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE agents SET approved_at = coalesce(approved_at, now())
     WHERE id = $1 AND revoked_at IS NULL AND remote RETURNING id`,
    [id],
  );
  return rows.length === 1;
}

/** The pending enrolments, oldest first — what the owner is being asked about. */
export async function pendingAgents(db: Db): Promise<AgentRow[]> {
  return (await listAgents(db)).filter((a) => a.pending);
}

/** The proposals payload key an enrolment request is recognised by, both here and at triage. */
export const ENROLL_PAYLOAD_KEY = "enroll";

/** An enrolment request's payload: a `decision` proposal answered with its own two options. */
export interface EnrollPayload {
  title: string;
  options: ["approve", "deny"];
  enroll: { agent: string };
}

/** The agent id an enrolment proposal is about, or undefined when this payload is not one. */
export function enrollTarget(payload: unknown): string | undefined {
  const e = (payload as { enroll?: { agent?: unknown } } | null)?.enroll;
  return typeof e?.agent === "string" && AGENT_ID_RE.test(e.agent) ? e.agent : undefined;
}

/**
 * Surface a pending enrolment in the one queue that needs the user (D7).
 * A `decision` proposal, because that is the kind the PWA already renders
 * with its OWN options rather than the three triage verbs — `approve` and
 * `deny`, checked server-side against the stored row, never against the
 * request. Nothing new to render, and answering it from the phone is the
 * same gesture as answering it from the console.
 */
export async function enrollmentProposal(db: Db, row: { id: string; display_name: string }): Promise<number | undefined> {
  const payload: EnrollPayload = {
    title: `Let ${row.display_name} (${row.id}) in? It will present its token from another machine.`,
    options: ["approve", "deny"],
    enroll: { agent: row.id },
  };
  const { rows } = await db.query(
    `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('decision', $1, 'external', $2::jsonb) RETURNING id`,
    [row.id, JSON.stringify(payload)],
  );
  return rows[0]?.id === undefined ? undefined : Number(rows[0].id);
}

/** Settle any pending enrolment request for this agent — the owner answered it elsewhere. */
export async function settleEnrollment(db: Db, id: string, decision: "approve" | "deny"): Promise<number[]> {
  const { rows } = await db.query(
    `UPDATE proposals SET decision = $2, decided_at = now()
     WHERE kind = 'decision' AND decision = 'pending' AND payload->'enroll'->>'agent' = $1 RETURNING id`,
    [id, decision],
  );
  return rows.map((r) => Number(r.id));
}

// ----- access requests (ruled 2026-09-19) -----------------------------------
//
// `request_access` on /mcp writes a `proposals` row of kind `access_request`
// (packages/mcp-brain/src/access.ts) and grants NOTHING. What follows is the
// owner's half: the widening an Approve applies, the list the Agents panel
// shows beside each grant, and what a revocation does to an ask nobody
// answered. There is no new verb and no new route — Approve on that row is a
// door onto `setGrants`, the one the owner's own click already goes through
// (invariant 10).

/** The `proposals.kind`, from the bridge that writes it — imported, never respelled. */
export { ACCESS_REQUEST_KIND };

/**
 * The area an `access_request` payload is about, or undefined when it does
 * not carry one this validator would admit. Re-validated HERE rather than
 * trusted: the row was written by a tool that checked it, but a payload is
 * data, and a decision that widens a grant reads it again.
 */
export function accessArea(payload: unknown): string | undefined {
  const area = (payload as { area?: unknown } | null)?.area;
  return validAreaPrefix(area) ? area : undefined;
}

/**
 * What Approve applies: the requested prefix, and nothing else.
 *
 * - `areas` gains the prefix — unless a grant it already holds covers it
 *   (`underAreas`), in which case the list is untouched: widening by
 *   something already granted is not a widening.
 * - the tier becomes `areas`, because an area grant IS tier `areas`. For a
 *   tier `none` or `index` row that is the whole point of the ask; it is also
 *   a NARROWING on the other axis, and deliberately so: tier `index` browses
 *   every title in the vault and reads none of them, while tier `areas` sees
 *   titles only inside its prefixes (docs/ops/assistant-tools.md's table).
 *   The grant model has one tier, so "index browse plus one readable area"
 *   is not expressible — the owner trading one for the other is the decision
 *   they are making, and Decline leaves it exactly as it was.
 * - `queries` is carried across untouched and NEVER set: it is a separate
 *   axis (invariant 3's read path), no part of what was asked for, and
 *   nothing here may hand it over.
 */
export function widenedGrants(current: Grants, area: string): Grants {
  const held = current.tier === "areas" ? current.areas : [];
  const areas = underAreas(area, held) ? [...held] : [...held, area];
  return { tier: "areas", areas, ...(current.queries === true ? { queries: true } : {}) };
}

/** One pending ask, as the Agents panel lists it beside the grant it is about. */
export interface AccessRequestRow {
  proposal_id: number;
  agent: string;
  area: string;
  reason: string;
  ts: string;
}

/**
 * Every unanswered ask, oldest first. The panel where grants are EDITED shows
 * what has been asked for there, not only in the queue: the owner reading an
 * agent's row is the moment the question is live.
 */
export async function pendingAccessRequests(db: Db): Promise<AccessRequestRow[]> {
  const { rows } = await db.query(
    `SELECT id, source_agent, payload->>'area' AS area, payload->>'reason' AS reason, ts
     FROM proposals WHERE kind = '${ACCESS_REQUEST_KIND}' AND decision = 'pending' ORDER BY ts, id`,
  );
  return rows.map((r) => ({
    proposal_id: Number(r.id),
    agent: String(r.source_agent),
    area: String(r.area ?? ""),
    reason: String(r.reason ?? ""),
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
  }));
}

/** What a revocation writes on the asks it settles — a reason, and not the SKIP marker, because there IS something to learn from it. */
export const REVOKED_FEEDBACK = "declined with the agent's revocation — a revoked credential cannot be granted anything";

/**
 * Revoking an agent settles its pending access requests as `deny`.
 *
 * Decided rather than left open (and documented in docs/ops/actions.md): a
 * revoked token authenticates nothing, so an ask from it can never come true,
 * and a queue item whose only honest answer is "no, obviously" is noise in
 * the one list that is supposed to need the user. It mirrors
 * `settleEnrollment`, which does the same to a pending enrolment for the same
 * reason. The Approve path refuses a revoked agent independently
 * (apps/console/src/server.ts) — belt and braces, because a row could predate
 * this and a widening must never ride on one.
 */
export async function settleAccessRequests(db: Db, id: string): Promise<number[]> {
  const { rows } = await db.query(
    `UPDATE proposals SET decision = 'deny', feedback = $2, decided_at = now(), snoozed_until = NULL
     WHERE kind = '${ACCESS_REQUEST_KIND}' AND decision = 'pending' AND source_agent = $1 RETURNING id`,
    [id, REVOKED_FEEDBACK],
  );
  return rows.map((r) => Number(r.id));
}

/** Replace an active agent's grants. False if unknown or revoked. */
export async function setGrants(db: Db, id: string, grants: Grants): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE agents SET grants = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [id, JSON.stringify(grants)],
  );
  return rows.length === 1;
}

export async function setProjects(db: Db, id: string, projects: string[]): Promise<boolean> {
  for (const p of projects) await ensureProject(db, p); // membership is the grant (§4.21) — and the first use of a slug makes its row (0011)
  const { rows } = await db.query(
    `UPDATE agents SET projects = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [id, projects],
  );
  return rows.length === 1;
}

/** How long one widening stays quiet before it would alert again. Config, not a literal: "tell me once a day about this" is an opinion. */
const AUTONOMY_ALERT_DEDUPE_HOURS = intEnv("METISTRY_ALERT_DEDUPE_H", 24);

export interface SetAutonomyResult {
  /** False = no such row, or it is revoked. */
  ok: boolean;
  /** The raises this change made, as `autonomyWidenings` names them. Empty on a narrowing or a no-op. */
  widened: string[];
}

/**
 * Replace an active agent's autonomy record (validated).
 *
 * The §4.21 keys narrow and only narrow, as they always have. `level` and
 * `actions` (A3, docs/ops/actions.md) can go the other way, and that is the
 * whole of OPEN-2's resolution: a change that RAISES the level or any
 * effective mode is admitted only when the caller says it is the owner's own
 * route (`allowWidening`), which in this console is `PUT /api/agents/:id/
 * autonomy` — reached by the `user` principal alone — the CLI that calls it,
 * and the crew registry sync, whose input is a §4.7 protected file. Every
 * other caller, present or future, is narrowing-only by default: the
 * parameter is opt-IN, so a new call site cannot widen by forgetting.
 *
 * Compare-and-set on the record we checked: a concurrent change answers
 * `conflict` rather than being overwritten, so a widening can never ride in
 * on a stale read.
 */
export async function setAutonomy(db: Db, id: string, autonomy: Autonomy, opts: { allowWidening?: boolean } = {}): Promise<SetAutonomyResult> {
  const before = await db.query(`SELECT autonomy FROM agents WHERE id = $1 AND revoked_at IS NULL`, [id]);
  const row = before.rows[0] as { autonomy: unknown } | undefined;
  if (!row) return { ok: false, widened: [] };
  const previousJson = JSON.stringify(row.autonomy ?? {});
  const widened = autonomyWidenings(coerceAutonomy(row.autonomy), autonomy);
  if (widened.length > 0 && opts.allowWidening !== true) {
    throw new AgentError(
      "forbidden",
      `this would widen ${id}'s autonomy (${widened.join("; ")}) — a raise is the user's own hand: PUT /api/agents/${id}/autonomy from a console session, or \`metistry agents autonomy ${id}\` (docs/ops/actions.md)`,
    );
  }
  const { rows } = await db.query(
    `UPDATE agents SET autonomy = $2 WHERE id = $1 AND revoked_at IS NULL AND autonomy IS NOT DISTINCT FROM $3::jsonb RETURNING id`,
    [id, JSON.stringify(autonomy), previousJson],
  );
  if (rows.length !== 1) {
    throw new AgentError("conflict", `${id}'s autonomy changed while this change was being checked — re-read GET /api/agents and send it again`);
  }
  return { ok: true, widened };
}

/**
 * A raised bar is never silent (docs/ops/actions.md). One `runs` row per
 * widening — `agent_admin` / `autonomy_widened`, so `metistry runs` and the
 * NDJSON export carry it — and one Needs You alert per distinct change per
 * METISTRY_ALERT_DEDUPE_H, the same shape and the same dedupe the project
 * budget flip uses. Best effort on the alert: failing to notify must not
 * fail the change the owner already made.
 */
export async function recordWidening(db: Db, id: string, widened: string[], via: string): Promise<void> {
  if (widened.length === 0) return;
  const runId = await startRun(db, { component: "console", kind: "agent_admin", tool: "autonomy_widened", meta: { agent: id, op: "autonomy_widened", widened, via } });
  await finishRun(db, runId, { ok: true });
  const text = `agent ${id} was given more room: ${widened.join("; ")} — it can now act on its own within that table (dashboard → agents, docs/ops/actions.md)`;
  const dup = await db.query(
    `SELECT 1 FROM outbound_messages WHERE kind = 'alert' AND text = $1 AND ts > now() - make_interval(hours => $2::int)`,
    [text, AUTONOMY_ALERT_DEDUPE_HOURS],
  );
  if (!dup.rows[0]) await db.query(`INSERT INTO outbound_messages (thread, text, kind) VALUES ('default', $1, 'alert')`, [text]);
}

/** The effective (kind → mode) table for one stored record — what the registry pane and `metistry agents autonomy` both render. */
export function autonomyTable(autonomy: Autonomy): Record<ActionKind, ActionMode> {
  return effectiveActions(autonomy);
}

/** Revocation is permanent: the row stays (provenance on old proposals), the token dies. */
export async function revokeAgent(db: Db, id: string): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE agents SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [id],
  );
  return rows.length === 1;
}

/** Mint a replacement token; the old one stops authenticating immediately. */
export async function rotateAgent(db: Db, id: string): Promise<string | null> {
  const token = mintToken(32);
  const { rows } = await db.query(
    `UPDATE agents SET token_hash = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [id, tokenHash(token)],
  );
  return rows.length === 1 ? token : null;
}
