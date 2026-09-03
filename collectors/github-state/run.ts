// github-state: reconcile issues + PRs from the configured repos into
// `work` (§4.8). Status comes from GitHub, never invented. Degrades absent
// without a token/repos. Uses the REST API with a fine-grained read-only
// PAT (env), no SDK dependency.

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
  assignee?: { login: string } | null;
  milestone?: { due_on: string | null } | null;
}

async function fetchOpen(ctx: GithubCtx, repo: string): Promise<GhItem[]> {
  const items: GhItem[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await (ctx.fetchFn ?? fetch)(
      `https://api.github.com/repos/${repo}/issues?state=open&per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${ctx.githubToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "metistry-github-state",
        },
        signal: AbortSignal.timeout(30_000),
      },
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
  for (const repo of ctx.githubRepos) {
    const open = await fetchOpen(ctx, repo);
    const area = repo.split("/")[1] ?? repo;
    const refs: string[] = [];
    for (const it of open) {
      const ref = `gh:${repo}#${it.number}`;
      refs.push(ref);
      await db.query(
        `INSERT INTO work (title, area, kind, status, external_ref, owner, due, updated_at)
         VALUES ($1, $2, $3, 'open', $4, $5, $6, $7)
         ON CONFLICT (external_ref) DO UPDATE SET
           title = EXCLUDED.title, status = 'open', owner = EXCLUDED.owner,
           due = EXCLUDED.due, updated_at = EXCLUDED.updated_at`,
        [it.title, area, it.pull_request ? "pr" : "issue", ref, it.assignee?.login ?? null,
         it.milestone?.due_on ? it.milestone.due_on.slice(0, 10) : null, it.updated_at],
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
