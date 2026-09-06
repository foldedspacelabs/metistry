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
export const TIERS = ["none", "index", "areas"] as const;
export type Tier = (typeof TIERS)[number];

/** A grant is a read tier plus, for `areas`, the Knowledge/ prefixes it covers. */
export interface Grants {
  tier: Tier;
  areas: string[];
}

/** The server-side principal for an agent call (§4.20 Principal, kind=agent). */
export interface AgentPrincipal {
  id: string;
  grants: Grants;
  projects: string[];
}

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
     RETURNING id, grants, projects`,
    [tokenHash(token)],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, grants: coerceGrants(row.grants), projects: row.projects ?? [] };
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
