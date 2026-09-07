// External-agent registry (§4.2 management surface, §4.11 read tiers,
// §4.19 trust rules). The second credential class, structurally distinct
// from owner sessions/tokens (CRIT-7): an agent token authenticates the
// agent surface only, and its grants live HERE, on the server, attached to
// the token — never asserted by the agent, never carried in a request.
//
// `authenticateAgent` is the reusable principal source: a pure function of
// (db, Authorization header). The future mcp-brain bridge calls the same
// thing, so there is one place to get "who is this agent" right.

import { mintToken, parseBearer, tokenHash } from "@foldedspacelabs/metistry-core";
import type { Db } from "./auth-store.js";

export const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const AGENT_KINDS = ["external", "internal"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export const TIERS = ["none", "index", "areas"] as const;
export type Tier = (typeof TIERS)[number];

/** A grant is a read tier plus, for `areas`, the Knowledge/ prefixes it covers. */
export interface Grants {
  tier: Tier;
  areas: string[];
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
}

/** The registry id of the instance's own assistant (CLAUDE.md naming: never the assistant's name). */
export const INTERNAL_ASSISTANT_ID = "assistant";

/**
 * The widest grant the validator admits, for the primary assistant: every
 * note-bearing top-level vault folder of plan §4.15. The validator refuses
 * bare `Knowledge` on purpose (an area grant is a prefix, and "everything"
 * is not an area), so the widest valid read is the union of the top-level
 * areas. Root-level notes (`Knowledge/now.md`) sit under none of them and
 * are therefore NOT readable through this grant — a known gap, reported,
 * not routed around. Override per instance with METISTRY_ASSISTANT_AREAS.
 */
export const ASSISTANT_DEFAULT_AREAS = [
  "Knowledge/Areas",
  "Knowledge/Projects",
  "Knowledge/Resources",
  "Knowledge/Techniques",
  "Knowledge/Journal",
  "Knowledge/People",
  "Knowledge/Me",
] as const;

export interface AgentRow {
  id: string;
  display_name: string;
  kind: string;
  grants: Grants;
  projects: string[];
  created_at: string;
  last_seen_at: string | null;
  revoked: boolean;
}

/** Thrown for caller mistakes; the route maps `code` to the uniform envelope. */
export class AgentError extends Error {
  constructor(public readonly code: "invalid_request" | "conflict" | "not_found", message: string) {
    super(message);
  }
}

// A vault area prefix: `Knowledge/` plus one or more TitleCase segments
// (CLAUDE.md casing rule — Obsidian renders these; Linux containers do not
// forgive `knowledge/`). No traversal, no trailing slash, no bare
// `Knowledge` (that would be "everything", which is not an area grant).
const AREA_RE = /^Knowledge(\/[A-Z][A-Za-z0-9 _.'-]*)+$/;
const MAX_AREAS = 64;
const MAX_AREA_LEN = 200;

/** Validate + normalize a grants payload. Throws AgentError on any miss. */
export function validateGrants(input: unknown): Grants {
  const g = (input ?? {}) as { tier?: unknown; areas?: unknown };
  if (!TIERS.includes(g.tier as Tier)) throw new AgentError("invalid_request", "tier must be none | index | areas");
  const tier = g.tier as Tier;
  const rawAreas = g.areas === undefined ? [] : g.areas;
  if (!Array.isArray(rawAreas) || rawAreas.length > MAX_AREAS) throw new AgentError("invalid_request", "areas must be a list");
  const areas: string[] = [];
  for (const a of rawAreas) {
    if (typeof a !== "string") throw new AgentError("invalid_request", "area must be a string");
    const s = a.trim();
    if (s.length > MAX_AREA_LEN || !AREA_RE.test(s) || s.includes("..")) {
      throw new AgentError("invalid_request", "area must be a TitleCase Knowledge/... prefix");
    }
    if (!areas.includes(s)) areas.push(s);
  }
  if (tier !== "areas" && areas.length > 0) throw new AgentError("invalid_request", "areas only apply to tier=areas");
  if (tier === "areas" && areas.length === 0) throw new AgentError("invalid_request", "tier=areas needs at least one area");
  return { tier, areas };
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

function coerceGrants(raw: unknown): Grants {
  const g = (raw ?? {}) as Partial<Grants>;
  return { tier: TIERS.includes(g.tier as Tier) ? (g.tier as Tier) : "none", areas: Array.isArray(g.areas) ? g.areas : [] };
}

/**
 * Resolve an agent bearer token to its principal. Pure function of
 * (db, Authorization header): hash lookup, not revoked, bumps last_seen_at.
 * Null on any miss — the caller returns the uniform 401.
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
     WHERE token_hash = $1 AND revoked_at IS NULL
     RETURNING id, kind, grants, projects`,
    [tokenHash(token)],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, kind: row.kind === "internal" ? "internal" : "external", grants: coerceGrants(row.grants), projects: row.projects ?? [] };
}

export interface InternalAgentConfig {
  /** The bearer the internal agent presents; only its hash is stored. From the user's .env, never minted here. */
  token: string;
  display_name?: string | undefined;
  /** Validated grants; default = the widest valid read (ASSISTANT_DEFAULT_AREAS). */
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
  const grants = cfg.grants ?? validateGrants({ tier: "areas", areas: [...ASSISTANT_DEFAULT_AREAS] });
  const projects = validateProjects(cfg.projects ?? []);
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
       revoked_at = NULL
     RETURNING (xmax = 0) AS created`,
    [id, displayName, tokenHash(cfg.token), JSON.stringify(grants), projects],
  );
  return { id, created: rows[0]?.created === true };
}

/** The registry, minus anything secret: token hashes never leave the db. */
export async function listAgents(db: Db): Promise<AgentRow[]> {
  const { rows } = await db.query(
    `SELECT id, display_name, kind, grants, projects, created_at, last_seen_at, revoked_at IS NOT NULL AS revoked
     FROM agents ORDER BY revoked, created_at`,
  );
  return rows.map((r) => ({ ...r, grants: coerceGrants(r.grants) }));
}

/** Register an agent and mint its token. The token is returned ONCE. */
export async function createAgent(
  db: Db,
  input: { id?: unknown; display_name?: unknown; kind?: unknown },
): Promise<{ id: string; token: string }> {
  const id = typeof input.id === "string" ? input.id : "";
  if (!AGENT_ID_RE.test(id)) throw new AgentError("invalid_request", "id must be a slug ^[a-z][a-z0-9-]{0,39}$");
  const displayName = typeof input.display_name === "string" ? input.display_name.trim().slice(0, 120) : "";
  if (!displayName) throw new AgentError("invalid_request", "display_name required");
  const kind = input.kind === undefined ? "external" : input.kind;
  if (!AGENT_KINDS.includes(kind as (typeof AGENT_KINDS)[number])) throw new AgentError("invalid_request", "kind must be external | internal");
  const token = mintToken(32);
  try {
    await db.query(`INSERT INTO agents (id, display_name, kind, token_hash) VALUES ($1, $2, $3, $4)`, [
      id, displayName, kind, tokenHash(token),
    ]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new AgentError("conflict", "agent id already registered");
    throw err;
  }
  return { id, token };
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
  const { rows } = await db.query(
    `UPDATE agents SET projects = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [id, projects],
  );
  return rows.length === 1;
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
