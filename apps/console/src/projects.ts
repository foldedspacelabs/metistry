// Projects (plan §4.19 "Multi-agent projects", §4.21 controls) — the
// management surface over the `projects` row (0011). A project is a VIEW
// over existing tables (agents, work, artifacts, proposals, runs) plus
// one small row of the user's decisions: the kill switch (`mode`), the
// daily soft budget, the per-project bundle cap. The rollup is the seed
// query `projects_rollup` (invariant 3: one read path); this file adds
// the last mode change from `runs` and the one write, which is always
// the user's hand (passkey session only) and always a `runs` row.

import { PROJECT_COLS, PROJECT_MODES, PROJECT_SLUG_RE, ensureProject, finishRun, startRun, toProjectRow, type ProjectMode, type ProjectRow } from "@foldedspacelabs/metistry-core";
import { QueryError, type QueryStore } from "@foldedspacelabs/metistry-queries";
import type { Db } from "./auth-store.js";
import { AgentError } from "./agents.js";

export interface ProjectView {
  id: string;
  title: string | null;
  area: string | null;
  mode: ProjectMode;
  daily_budget_usd: number | null;
  max_open_bundles: number;
  members: string[];
  open_tasks: number;
  bundles_in_flight: number;
  bundles_queued: number;
  open_threads: number;
  pending_reviews: number;
  spend_today_usd: number;
  last_activity: string | null;
  /** The most recent mode change — a budget flip (`project_mode`) or the user's toggle (`project_admin`) — so the panel can say WHY it is in review. */
  last_mode_change: { ts: string; by: string; reason: string; to: ProjectMode } | null;
  created_at: string;
  updated_at: string;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** The rollup (seed query) joined with the last mode change per project. */
export async function listProjects(db: Db, queries: QueryStore): Promise<{ projects: ProjectView[]; as_of: Date }> {
  let rows: Record<string, unknown>[];
  let as_of: Date;
  try {
    ({ rows, as_of } = await queries.run("projects_rollup"));
  } catch (err) {
    if (err instanceof QueryError && err.code === "unknown_query") return { projects: [], as_of: new Date() }; // seed dir not loaded: degrades empty, never 500
    throw err;
  }
  const ids = rows.map((r) => String(r.id));
  const changes = new Map<string, ProjectView["last_mode_change"]>();
  if (ids.length > 0) {
    const { rows: runs } = await db.query(
      `SELECT DISTINCT ON (meta->>'project') meta->>'project' AS project, ts, component, kind, meta
       FROM runs WHERE kind IN ('project_mode', 'project_admin') AND meta->>'project' = ANY($1::text[]) AND meta->>'to' IS NOT NULL
       ORDER BY meta->>'project', ts DESC`,
      [ids],
    );
    for (const r of runs) {
      const meta = (r.meta ?? {}) as Record<string, unknown>;
      changes.set(String(r.project), {
        ts: new Date(r.ts as string).toISOString(),
        by: r.kind === "project_mode" ? String(meta.reason ?? "budget") : "user",
        reason: String(meta.reason ?? (r.kind === "project_admin" ? "toggle" : "")),
        to: meta.to === "review" ? "review" : "autonomous",
      });
    }
  }
  const projects: ProjectView[] = rows.map((r) => {
    const p = toProjectRow(r);
    return {
      id: p.id,
      title: p.title,
      area: p.area,
      mode: p.mode,
      daily_budget_usd: p.daily_budget_usd,
      max_open_bundles: p.max_open_bundles,
      members: Array.isArray(r.members) ? (r.members as string[]) : [],
      open_tasks: num(r.open_tasks),
      bundles_in_flight: num(r.bundles_in_flight),
      bundles_queued: num(r.bundles_queued),
      open_threads: num(r.open_threads),
      pending_reviews: num(r.pending_reviews),
      spend_today_usd: num(r.spend_today_usd),
      last_activity: r.last_activity ? new Date(r.last_activity as string).toISOString() : null,
      last_mode_change: changes.get(p.id) ?? null,
      created_at: new Date(p.created_at).toISOString(),
      updated_at: new Date(p.updated_at).toISOString(),
    };
  });
  return { projects, as_of };
}

export interface ProjectPatch {
  mode?: ProjectMode;
  daily_budget_usd?: number | null;
  max_open_bundles?: number;
  title?: string | null;
  area?: string | null;
}

const MAX_BUNDLE_CAP = 1000;  // limit: fixed — the ceiling on what a PUT may ask for — the API contract, not a knob
const MAX_BUDGET = 1_000_000;  // limit: fixed — a sanity bound on a typed figure; a budget past this is a slipped decimal point

/** Validate a PUT body. Unknown keys are refused; every present key is checked. Throws AgentError (same envelope mapping as the registry). */
export function validateProjectPatch(input: unknown): ProjectPatch {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new AgentError("invalid_request", "body must be an object");
  const b = input as Record<string, unknown>;
  const out: ProjectPatch = {};
  for (const k of Object.keys(b)) {
    if (!["mode", "daily_budget_usd", "max_open_bundles", "title", "area"].includes(k)) throw new AgentError("invalid_request", `unknown key ${k}`);
  }
  if (b.mode !== undefined) {
    if (!PROJECT_MODES.includes(b.mode as ProjectMode)) throw new AgentError("invalid_request", "mode must be autonomous | review");
    out.mode = b.mode as ProjectMode;
  }
  if (b.daily_budget_usd !== undefined) {
    if (b.daily_budget_usd === null) out.daily_budget_usd = null;
    else if (typeof b.daily_budget_usd !== "number" || !Number.isFinite(b.daily_budget_usd) || b.daily_budget_usd < 0 || b.daily_budget_usd > MAX_BUDGET) throw new AgentError("invalid_request", "daily_budget_usd must be null or a number 0..1000000");
    else out.daily_budget_usd = Math.round(b.daily_budget_usd * 100) / 100;
  }
  if (b.max_open_bundles !== undefined) {
    const n = b.max_open_bundles;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_BUNDLE_CAP) throw new AgentError("invalid_request", `max_open_bundles must be an integer 0..${MAX_BUNDLE_CAP}`);
    out.max_open_bundles = n;
  }
  for (const k of ["title", "area"] as const) {
    if (b[k] === undefined) continue;
    if (b[k] === null) out[k] = null;
    else if (typeof b[k] !== "string" || (b[k] as string).length > 120) throw new AgentError("invalid_request", `${k} must be a string of at most 120 characters`);
    else out[k] = (b[k] as string).trim() || null;
  }
  if (Object.keys(out).length === 0) throw new AgentError("invalid_request", "nothing to change");
  return out;
}

/**
 * The user's hand on a project: ensure the row (a PUT on a slug nobody
 * used yet is how a budget can be set before the first agent joins),
 * apply the patch, and record it (runs kind project_admin, with the mode
 * transition when there is one — the brief and the panel read it).
 */
export async function updateProject(db: Db, id: string, patch: ProjectPatch, principal = "user"): Promise<ProjectRow> {
  if (!PROJECT_SLUG_RE.test(id)) throw new AgentError("invalid_request", "project must be a slug");
  await ensureProject(db, id);
  const before = await db.query(`SELECT ${PROJECT_COLS} FROM projects WHERE id = $1`, [id]);
  const prior = toProjectRow(before.rows[0]!);
  const runId = await startRun(db, {
    component: "console",
    kind: "project_admin",
    tool: "projects",
    meta: { project: id, principal, changes: patch, ...(patch.mode !== undefined && patch.mode !== prior.mode ? { from: prior.mode, to: patch.mode, reason: "toggle" } : {}) },
  });
  try {
    const { rows } = await db.query(
      `UPDATE projects SET
         mode = COALESCE($2, mode),
         daily_budget_usd = CASE WHEN $3 THEN $4::numeric ELSE daily_budget_usd END,
         max_open_bundles = COALESCE($5, max_open_bundles),
         title = CASE WHEN $6 THEN $7 ELSE title END,
         area = CASE WHEN $8 THEN $9 ELSE area END,
         updated_at = now()
       WHERE id = $1 RETURNING ${PROJECT_COLS}`,
      [
        id,
        patch.mode ?? null,
        patch.daily_budget_usd !== undefined,
        patch.daily_budget_usd ?? null,
        patch.max_open_bundles ?? null,
        patch.title !== undefined,
        patch.title ?? null,
        patch.area !== undefined,
        patch.area ?? null,
      ],
    );
    await finishRun(db, runId, { ok: true });
    return toProjectRow(rows[0]!);
  } catch (err) {
    await finishRun(db, runId, { ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
