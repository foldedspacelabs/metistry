// projects (plan §4.19): the row behind a project slug. A project is the
// collaboration boundary every other table already carries as a bare
// string; `projects` holds what the §4.21 controls need — the user's kill
// switch (`mode`), the daily soft budget, the per-project bundle cap.
// Rows are created lazily the first time a slug is used, so the modules
// that take a project (tasks, artifacts, the agent registry) call
// ensureProject and nothing ever "creates a project". Lives in core
// because it is the lowest package both tasks and artifacts depend on.

export interface ProjectExecutor {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** The slug shape shared by agents.id, agents.projects, and artifacts.project (0007/0010). */
export const PROJECT_SLUG_RE = /^[a-z][a-z0-9-]{0,39}$/;

export type ProjectMode = "autonomous" | "review";
export const PROJECT_MODES: readonly ProjectMode[] = ["autonomous", "review"];

export interface ProjectRow {
  id: string;
  title: string | null;
  area: string | null;
  mode: ProjectMode;
  daily_budget_usd: number | null;
  max_open_bundles: number;
  created_at: Date;
  updated_at: Date;
}

export const PROJECT_COLS = `id, title, area, mode, daily_budget_usd, max_open_bundles, created_at, updated_at`;

/** The defaults a slug with no row behaves as (identical to the table defaults). */
export const DEFAULT_MAX_OPEN_BUNDLES = 20;

export function toProjectRow(r: Record<string, unknown>): ProjectRow {
  return {
    id: String(r.id),
    title: (r.title as string | null) ?? null,
    area: (r.area as string | null) ?? null,
    mode: r.mode === "review" ? "review" : "autonomous",
    daily_budget_usd: r.daily_budget_usd === null || r.daily_budget_usd === undefined ? null : Number(r.daily_budget_usd), // pg returns numeric as text
    max_open_bundles: r.max_open_bundles === null || r.max_open_bundles === undefined ? DEFAULT_MAX_OPEN_BUNDLES : Number(r.max_open_bundles),
    created_at: r.created_at as Date,
    updated_at: r.updated_at as Date,
  };
}

/**
 * Create the project row if it does not exist. Idempotent and race-safe
 * (ON CONFLICT DO NOTHING). Throws on a non-slug: the callers validate
 * their project input first, so reaching here with free text is a bug,
 * not a user error.
 */
export async function ensureProject(db: ProjectExecutor, slug: string): Promise<{ id: string; created: boolean }> {
  if (typeof slug !== "string" || !PROJECT_SLUG_RE.test(slug)) throw new RangeError(`project must match ${PROJECT_SLUG_RE.source}`);
  const { rows } = await db.query(`INSERT INTO projects (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id`, [slug]);
  return { id: slug, created: rows.length === 1 };
}

/** The row, or the defaults when the slug has none yet (a read never creates). */
export async function getProject(db: ProjectExecutor, slug: string): Promise<ProjectRow | null> {
  if (typeof slug !== "string" || !PROJECT_SLUG_RE.test(slug)) return null;
  const { rows } = await db.query(`SELECT ${PROJECT_COLS} FROM projects WHERE id = $1`, [slug]);
  return rows[0] ? toProjectRow(rows[0]) : null;
}
