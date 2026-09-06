// github-state: reconcile issues + PRs from the configured repos into
// `work` (§4.8). Status comes from GitHub, never invented. Degrades absent
// without a token/repos. Uses the REST API with a fine-grained read-only
// PAT (env), no SDK dependency. PRs additionally carry review-request
// metadata (work.meta) so "what's waiting on my review" is one query.

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface GithubCtx {
  githubToken?: string;
  githubRepos?: string[]; // ["owner/repo", ...]
  fetchFn?: typeof fetch;
}

interface GhItem {
  number: number;
  title: string;
  state: string; // open | closed
  pull_request?: unknown;
  html_url: string;
  updated_at: string;
  user?: { login: string } | null;
  assignee?: { login: string } | null;
  milestone?: { due_on: string | null } | null;
}

interface GhPull {
  number: number;
  draft?: boolean;
  user?: { login: string } | null;
  requested_reviewers?: { login: string }[];
  requested_teams?: { slug: string }[];
}

function ghHeaders(ctx: GithubCtx) {
  return {
    authorization: `Bearer ${ctx.githubToken}`,
    accept: "application/vnd.github+json",
    "user-agent": "metistry-github-state",
  };
}

/** The token's own login — "my review" is relative to it. Degrades to null. */
async function fetchViewer(ctx: GithubCtx): Promise<string | null> {
  try {
    const res = await (ctx.fetchFn ?? fetch)("https://api.github.com/user", { headers: ghHeaders(ctx), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return ((await res.json()) as { login?: string }).login ?? null;
  } catch {
    return null;
  }
}

/** Open PRs with review-request detail (the issues listing omits it). */
async function fetchPulls(ctx: GithubCtx, repo: string): Promise<Map<number, GhPull>> {
  const out = new Map<number, GhPull>();
  for (let page = 1; page <= 5; page++) {
    const res = await (ctx.fetchFn ?? fetch)(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=100&page=${page}`, {
      headers: ghHeaders(ctx),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`github ${repo} pulls: HTTP ${res.status}`);
    const batch = (await res.json()) as GhPull[];
    for (const p of batch) out.set(p.number, p);
    if (batch.length < 100) break;
  }
  return out;
}

async function fetchOpen(ctx: GithubCtx, repo: string): Promise<GhItem[]> {
  const items: GhItem[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await (ctx.fetchFn ?? fetch)(
      `https://api.github.com/repos/${repo}/issues?state=open&per_page=100&page=${page}`,
      { headers: ghHeaders(ctx), signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok) throw new Error(`github ${repo}: HTTP ${res.status}`);
    const batch = (await res.json()) as GhItem[];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

/** One reconcile pass. Returns rows upserted + closed. */
export async function run(db: Db, ctx: GithubCtx = {}): Promise<number> {
  if (!ctx.githubToken || !ctx.githubRepos?.length) return 0; // degrades absent
  let touched = 0;
  const me = await fetchViewer(ctx);
  for (const repo of ctx.githubRepos) {
    const open = await fetchOpen(ctx, repo);
    const pulls = open.some((i) => i.pull_request) ? await fetchPulls(ctx, repo) : new Map<number, GhPull>();
    const area = repo.split("/")[1] ?? repo;
    const refs: string[] = [];
    for (const it of open) {
      const ref = `gh:${repo}#${it.number}`;
      refs.push(ref);
      const author = it.user?.login ?? null;
      const meta: Record<string, unknown> = { author, url: it.html_url };
      if (it.pull_request) {
        const p = pulls.get(it.number);
        const reviewers = (p?.requested_reviewers ?? []).map((r) => r.login);
        meta.draft = !!p?.draft;
        meta.review_requested = reviewers;
        meta.review_teams = (p?.requested_teams ?? []).map((t) => t.slug);
        // "needs my review" = asked of me, not mine, not a draft. Teams are
        // listed but not matched (membership isn't known here).
        meta.needs_my_review = !!me && reviewers.includes(me) && author !== me && !p?.draft;
      }
      await db.query(
        `INSERT INTO work (title, area, kind, status, external_ref, owner, due, updated_at, meta)
         VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8)
         ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO UPDATE SET
           title = EXCLUDED.title, status = 'open', owner = EXCLUDED.owner,
           due = EXCLUDED.due, updated_at = EXCLUDED.updated_at, meta = EXCLUDED.meta`,
        [it.title, area, it.pull_request ? "pr" : "issue", ref, it.assignee?.login ?? null,
         it.milestone?.due_on ? it.milestone.due_on.slice(0, 10) : null, it.updated_at, JSON.stringify(meta)],
      );
      touched++;
    }
    // anything we track for this repo that is no longer open → closed
    const closed = await db.query(
      `UPDATE work SET status = 'closed', updated_at = now()
       WHERE external_ref LIKE $1 AND status <> 'closed' AND NOT (external_ref = ANY($2::text[]))
       RETURNING id`,
      [`gh:${repo}#%`, refs],
    );
    touched += closed.rows.length;
  }
  return touched;
}
