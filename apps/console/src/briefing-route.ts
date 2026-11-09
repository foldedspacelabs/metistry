// `GET /api/briefing?repo=<basename>&remote=<git remote>` — the session-start
// briefing (research 2026-10-04-context-mode-review §5–§6 CM-1; ticket X-128;
// ruled 2026-10-04: Context Mode Q1 handles plus the owner's text, Q2 on by
// default with an opt-out per agent, Q3 an unfolded session to the same
// project only).
//
// The one door X-129's plugins call once, at SessionStart, with the agent
// bearer `connect` minted. The console assembles with NO model (invariant 4)
// from named queries alone (invariant 3): `project_for_repo` (X-130),
// `briefing_page_handles`, `vault_tasks_query` and, through core's
// `recentSessionsForCaller`, `recent_sessions` (X-131). Core's
// `assembleBriefing` decides what appears and how, under the caller's grant;
// this file resolves the caller, fetches the rows, and writes the one `runs`
// row per briefing that carries the handles and the hash of what was sent.
//
// WHO: agent bearers only — the route admits the credential class before
// `may` is asked, as `/mcp` does (an owner credential is not an agent
// principal here, docs/ops/client-api.md), then `may` decides the role:
// `agent` is served; the assistant and a crew get the uniform hidden 403.
// Everything about the caller comes from the authenticated record: its
// grants (the tier the briefing renders at, and the `briefing: false`
// opt-out), and its `projects` — which `recentSessionsForCaller` insists on
// ("MUST come from the authenticated agent's record, never the request").
//
// WHAT IS NOT HERE: no caching. The hook calls once per session start and
// never again mid-session (the review's cache-churn risk is the caller's
// discipline, documented with the route); the console answers each call
// from the index as it stands, so a fold that just ran is in the next
// session's briefing.

import type { ServerResponse } from "node:http";
import {
  BRIEFING_DEFAULT_TOKENS,
  BRIEFING_MAX_FOLDS,
  BRIEFING_MAX_LINKS,
  BRIEFING_MAX_SESSIONS,
  BRIEFING_MAX_TASKS,
  BRIEFING_SESSION_DAYS,
  REPO_REMOTE_MAX,
  assembleBriefing,
  finishRun,
  may,
  mayListPath,
  normalizeRepoRemote,
  projectSlugForPage,
  recentSessionsForCaller,
  startRun,
  type Briefing,
  type BriefingPageHandle,
  type BriefingProjectPage,
  type BriefingTaskRow,
  type NamedQueryRunner,
  type Principal,
} from "@foldedspacelabs/metistry-core";
import type { QueryStore } from "@foldedspacelabs/metistry-queries";
import type { Db } from "./auth-store.js";
import type { AgentPrincipal } from "./agents.js";
import { sendError, sendJson, sendRefusal } from "./http-util.js";

export const BRIEFING_ROUTE = "GET /api/briefing";
const REPO_MAX = 200; // limit: fixed — a checkout basename; longer is not one

export interface BriefingRouteDeps {
  db: Db;
  queries: QueryStore;
  /** The owner's budget in tokens (METISTRY_BRIEFING_TOKENS); absent = core's default. */
  budgetTokens?: number | undefined;
  now: () => Date;
}

/** `repo` as the hook sends it: one path segment, no control characters. Blank is a 400, not an empty briefing. */
export function parseRepoParam(raw: string | null): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "" || s.length > REPO_MAX || /[\0-\x1f\x7f/\\]/.test(s)) return null;
  return s;
}

/** `remote`, optional: absent or blank is "no remote"; anything that does not reduce to a canonical remote is also none, never an error. */
export function parseRemoteParam(raw: string | null): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "" || s.length > REPO_REMOTE_MAX) return null;
  return normalizeRepoRemote(s);
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);

function pageHandle(r: Record<string, unknown>): BriefingPageHandle | null {
  const path = text(r.path);
  if (!path) return null;
  return { path, title: text(r.title) ?? path.replace(/^.*\//, "").replace(/\.md$/, ""), sha256: text(r.sha256), date: text(r.date) };
}

function taskRow(r: Record<string, unknown>): BriefingTaskRow | null {
  const path = text(r.path);
  const line = int(r.line_no);
  if (!path || line === null) return null;
  return { path, line_no: line, text: text(r.text) ?? "", source: text(r.source), due: text(r.due), priority: int(r.priority) };
}

/**
 * Assemble the briefing for one authenticated agent. Exported for the
 * tests; the route below is the HTTP half.
 */
export async function briefingFor(deps: BriefingRouteDeps, agent: AgentPrincipal, principal: Principal, repo: string, remote: string | null): Promise<Briefing> {
  const as_of = deps.now().toISOString();
  const base = { as_of, agent: agent.id, repo, remote, scope: principal.scope, budgetTokens: deps.budgetTokens ?? BRIEFING_DEFAULT_TOKENS };
  const run: NamedQueryRunner = async (name, params) => (await deps.queries.run(name, params)).rows;

  // Opted out, or no read grant at all: nothing is fetched and nothing is sent.
  if (agent.grants.briefing === false || principal.scope.tier === "none") {
    return assembleBriefing({ ...base, scope: { ...principal.scope, tier: "none" }, project: null, links: [], tasks: [], folds: [], sessions: [] });
  }

  // The project page (X-130): the one page the owner wrote that claims this remote, or none.
  let project: BriefingProjectPage | null = null;
  if (remote) {
    const row = (await run("project_for_repo", { remote }))[0];
    const path = text(row?.path);
    const slug = projectSlugForPage(path);
    // A page the caller may not even be told exists is no project for it: the
    // slug is the page's name, so nothing filed under it is looked up either.
    if (row && path && slug && mayListPath(principal.scope, path)) {
      project = { path, slug, title: text(row.title) ?? slug, description: text(row.description), sha256: null };
    }
  }

  let links: BriefingPageHandle[] = [];
  let folds: BriefingPageHandle[] = [];
  let tasks: BriefingTaskRow[] = [];
  if (project) {
    const handles = await run("briefing_page_handles", { path: project.path, limit: Math.max(BRIEFING_MAX_LINKS, BRIEFING_MAX_FOLDS) });
    for (const r of handles) {
      const h = pageHandle(r);
      if (!h) continue;
      if (r.relation === "self") project.sha256 = h.sha256;
      else if (r.relation === "link") links.push(h);
      else if (r.relation === "fold") folds.push(h);
    }
    // Open tasks in the project, the most important first, then the soonest due.
    const rows = await run("vault_tasks_query", { project: project.slug, status: "open", order_1: "priority", order_2: "due", limit: BRIEFING_MAX_TASKS * 2 });
    tasks = rows.map(taskRow).filter((t): t is BriefingTaskRow => t !== null);
  }

  // X-131: folded sessions to any caller its grant allows; an unfolded one only when
  // the caller's own `agents.projects` holds the repository's project.
  const sessions = await recentSessionsForCaller(run, {
    repo,
    remote,
    callerProjects: agent.projects,
    days: BRIEFING_SESSION_DAYS,
    limit: BRIEFING_MAX_SESSIONS * 2,
    canSee: (path) => mayListPath(principal.scope, path),
  });

  return assembleBriefing({ ...base, project, links, tasks, folds, sessions });
}

/**
 * The HTTP door. The caller has authenticated as an agent bearer (the server
 * admits that class alone before calling this); `principal` is `principalOf`
 * of that credential.
 */
export async function briefingRoute(deps: BriefingRouteDeps, res: ServerResponse, url: URL, agent: AgentPrincipal, principal: Principal): Promise<void> {
  const allowed = may(principal, "read", { kind: "console", door: "console_briefing", route: BRIEFING_ROUTE });
  if (!allowed.ok) return sendRefusal(res, allowed);
  const repo = parseRepoParam(url.searchParams.get("repo"));
  if (!repo) return sendError(res, "invalid_request", "repo is required: the checkout's basename, one path segment");
  const remote = parseRemoteParam(url.searchParams.get("remote"));
  const runId = await startRun(deps.db, { component: "console", kind: "briefing", meta: { agent: agent.id, repo, ...(remote ? { remote } : {}) } });
  try {
    const b = await briefingFor(deps, agent, principal, repo, remote);
    // One runs row per briefing: the handles and a hash of what was sent — never the text itself.
    await finishRun(deps.db, runId, {
      ok: true,
      meta: {
        tier: b.tier,
        empty: b.empty,
        truncated: b.truncated,
        chars: b.chars,
        budget_chars: b.budget_chars,
        sha256: b.sha256,
        ...(b.project ? { project: b.project.slug } : {}),
        ...(agent.grants.briefing === false ? { opted_out: true } : {}),
        handles: b.handles.map((h) => ({ kind: h.kind, path: h.path, ...(h.line !== undefined ? { line: h.line } : {}) })),
      },
    });
    return sendJson(res, 200, b);
  } catch (err) {
    await finishRun(deps.db, runId, { ok: false, error: String(err) });
    throw err;
  }
}
