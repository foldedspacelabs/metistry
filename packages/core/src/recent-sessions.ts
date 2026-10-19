// Last time in this repository (research 2026-10-04-context-mode-review §6
// CM-4; ticket X-131; ruled 2026-10-04, Context Mode Q3): what a coding
// agent is handed about the owner's earlier sessions in a repository.
//
// The rule, in one place so the session-start briefing (X-128) cannot
// restate it differently:
//
//   * a session the knowledge fold has READ goes to any agent whose grant
//     allows it;
//   * a session still WAITING for the fold goes only to an agent in the SAME
//     project as the repository;
//   * what is handed is a HANDLE — date, tool, repo, branch, turns, files and
//     the owner's first prompt, clipped. Never the agent's last reply: it is
//     agent-written, so it stays out (and `vault_sessions` has no column for
//     it). This module copies a fixed list of fields and nothing else, so a
//     query an instance overlay widened still cannot carry one through.
//
// Pure: no database, no filesystem. The caller injects `run`, a runner of
// named queries (invariant 3 — packages/queries executes them, nothing here
// talks to Postgres), so this stays a small function the briefing and the
// tests both call.

import { FIRST_PROMPT_CHARS, MAX_FILES, clip } from "./session-summary.js";
import { PROJECT_SLUG_RE } from "./projects.js";

/** One earlier session as an agent is handed it. A closed shape: add a field here and the tests say so. */
export interface SessionHandle {
  /** Vault path of the session note — the handle. */
  path: string;
  /** ISO timestamp the session started (or was captured, when it names none). */
  date: string;
  tool: string;
  repo: string | null;
  branch: string | null;
  turns: number | null;
  files: string[];
  /** The OWNER's first prompt, clipped. */
  first_prompt: string;
  /** Whether the knowledge fold has read this session. False only for the same-project arm. */
  folded: boolean;
}

export const SESSION_HANDLE_KEYS: readonly (keyof SessionHandle)[] = ["path", "date", "tool", "repo", "branch", "turns", "files", "first_prompt", "folded"];

/** Runs one named query and returns its rows (the console's QueryStore, or a stub). */
export type NamedQueryRunner = (name: string, params: Record<string, string | number | boolean>) => Promise<Record<string, unknown>[]>;

export const RECENT_SESSIONS_DEFAULT_DAYS = 14;  // limit: fixed — mirrors seed/queries/recent_sessions.yaml's default; the briefing narrows it, the owner's yaml overlay widens it
export const RECENT_SESSIONS_DEFAULT_LIMIT = 20; // limit: fixed — same

/**
 * The project slug a project page stands for: `Projects/Drey Mascot.md` →
 * `drey-mascot`. One deterministic rule — lowercase the file's name, every run
 * of other characters becomes `-` — and a name that does not come out as a
 * slug (`PROJECT_SLUG_RE`) stands for no project. Only `Projects/<Name>.md`
 * is a project page; a note inside a project's folder is not one.
 */
export function projectSlugForPage(path: string | null | undefined): string | null {
  if (typeof path !== "string") return null;
  const m = /^Projects\/([^/]+)\.md$/.exec(path);
  if (!m) return null;
  const slug = m[1]!.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return PROJECT_SLUG_RE.test(slug) ? slug : null;
}

/** Is the caller a member of the project this page stands for? Both sides must name one — nothing matches by default. */
export function callerInProjectOf(page: string | null | undefined, callerProjects: readonly string[]): boolean {
  const slug = projectSlugForPage(page);
  return slug !== null && callerProjects.includes(slug);
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** One row → a handle, by copying a fixed list of fields; null when the row is not a session handle. */
export function toSessionHandle(row: Record<string, unknown>): SessionHandle | null {
  const path = text(row.path);
  const tool = text(row.tool);
  if (!path || !tool) return null;
  const when = row.date instanceof Date ? row.date.toISOString() : text(row.date);
  if (!when) return null;
  const files = Array.isArray(row.files) ? row.files.filter((f): f is string => typeof f === "string").slice(0, MAX_FILES) : [];
  const turns = typeof row.turns === "number" && Number.isFinite(row.turns) ? row.turns : null;
  return {
    path,
    date: when,
    tool,
    repo: text(row.repo),
    branch: text(row.branch),
    turns,
    files,
    first_prompt: clip(text(row.first_prompt) ?? "", FIRST_PROMPT_CHARS),
    folded: row.folded === true,
  };
}

export interface SelectOptions {
  /** True only once the caller's project is proved. An unfolded session is dropped without it, whatever the rows say. */
  allowUnfolded: boolean;
  /** The caller's knowledge grant, per path (`canSeeUnder` for its tier); absent = every path. */
  canSee?: (path: string) => boolean;
}

/** The handles a caller may be handed from these rows: folded ones, plus unfolded ones only when allowed. Order is kept. */
export function selectSessionHandles(rows: readonly Record<string, unknown>[], opts: SelectOptions): SessionHandle[] {
  const out: SessionHandle[] = [];
  for (const row of rows) {
    const h = toSessionHandle(row);
    if (!h) continue;
    if (!h.folded && !opts.allowUnfolded) continue;
    if (opts.canSee && !opts.canSee(h.path)) continue;
    out.push(h);
  }
  return out;
}

export interface RecentSessionsRequest {
  /** The checkout's basename, as the capture saw it. Blank matches nothing. */
  repo: string;
  /** The repository's git remote, in any clone spelling; absent = no project, so folded sessions only. */
  remote?: string | null;
  /** Projects the calling agent belongs to (`agents.projects`). */
  callerProjects: readonly string[];
  days?: number;
  limit?: number;
  canSee?: (path: string) => boolean;
}

/**
 * Last time in this repository, for one caller. Resolves the repository to a
 * project page (`project_for_repo` — the one page that claims the remote, or
 * none), asks `recent_sessions` for the unfolded arm only when that page's
 * project is one of the caller's, and filters the answer again on the way
 * out. An unmapped repository, an ambiguous one (two pages claim it), and a
 * caller outside the project all fall to the same place: folded sessions
 * only.
 */
export async function recentSessionsForCaller(run: NamedQueryRunner, req: RecentSessionsRequest): Promise<SessionHandle[]> {
  if (!req.repo.trim()) return [];
  let allowUnfolded = false;
  if (req.remote && req.remote.trim()) {
    const page = (await run("project_for_repo", { remote: req.remote }))[0];
    allowUnfolded = callerInProjectOf(text(page?.path), req.callerProjects);
  }
  const rows = await run("recent_sessions", {
    repo: req.repo,
    days: req.days ?? RECENT_SESSIONS_DEFAULT_DAYS,
    limit: req.limit ?? RECENT_SESSIONS_DEFAULT_LIMIT,
    unfolded: allowUnfolded,
  });
  return selectSessionHandles(rows, req.canSee ? { allowUnfolded, canSee: req.canSee } : { allowUnfolded });
}
