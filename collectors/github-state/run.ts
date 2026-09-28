// github-state: reconcile issues + PRs from the configured repos into
// `work` (§4.8), and mirror each pull request waiting on the owner's review
// into Needs You as a `pull_request` request (plan §2.12, R6; T2-13).
//
// Status comes from GitHub, never invented. Degrades absent without a
// token/repos. Uses the REST API (and, for review threads, one GraphQL read)
// with a fine-grained read-only PAT (env), no SDK dependency. PRs carry their
// head SHA and review-request metadata (work.meta) so "what's waiting on my
// review" is one query (one extra reviews call per open non-draft PR).
//
// **Read-only, enforced here, not asked of the token.** Every request this
// collector sends goes through `readOnlyGithub`: a GET to api.github.com, or
// a POST to its /graphql whose document is a `query` operation — anything
// else is refused before it leaves, so no edit to this file can make the
// sync write to GitHub even with a token that could. Posting a review is the
// owner's door in the console, through its own client holding the owner's
// `github_write` secret (apps/console/src/github-pulls-route.ts); nothing
// here can reach it, and it never reads this collector's token.
//
// **The mirror** (core's `raiseMirror`: one pending row per PR, the same
// subject an agent's `requests_create` names, so the two asks are one card):
//
//   * with `syncs.github-state.raise.review_requested` on (the default), an
//     open PR that needs my review raises one `pull_request` request carrying
//     its head SHA, the diff and the open review threads, linked to its work
//     row — whose `meta.head_sha` is what the stale check reads (T2-14);
//   * a head that moved while the request waits is a new question: the old
//     request is resolved at source and one for the new head is raised;
//   * it resolves at source when the review lands — my approval is on
//     GitHub, the PR went back to draft, or it closed or merged. A request
//     answered through the owner's door is the owner's answer and is not
//     raised again for the same head;
//   * a viewer this token cannot name (`/user` degraded) claims nothing and
//     clears nothing.

import { GITHUB_API_ORIGIN, PULL_REQUEST_KIND, RESOLVED_AT_SOURCE, githubPullRef, githubPullSource, raiseMirror, resolveAtSource } from "@foldedspacelabs/metistry-core";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface GithubCtx {
  githubToken?: string;
  githubRepos?: string[]; // ["owner/repo", ...]
  fetchFn?: typeof fetch;
  /** the runner's resolved Needs You switches (`syncs.github-state.raise`); absent = the manifest's defaults */
  raise?: Readonly<Record<string, boolean>>;
}

/** This collector's name — the `source_agent` of every request it raises. */
export const COMPONENT = "github-state";
/** `payload.event` of the request a PR waiting on my review raises. */
export const REVIEW_EVENT = "review_requested";
/**
 * The manifest's `needs_you` default for the rule this collector reads. A
 * test holds it to `manifest.yaml`. (`assigned` is declared there too, and
 * is T4-23's to read.)
 */
export const RAISE_DEFAULTS: Readonly<Record<"review_requested", boolean>> = { review_requested: true };

const PATCH_CHARS = 60_000; // limit: fixed — the card shows the diff; a larger one is truncated and marked, the PR is one click away
const THREADS_MAX = 50; // limit: fixed — GitHub's page; a PR with more open threads is reviewed on GitHub
const COMMENTS_MAX = 20; // limit: fixed — the conversation a thread body draws
const COMMENT_CHARS = 2_000; // limit: fixed — one comment's text on the card

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
  head?: { sha?: string } | null;
  user?: { login: string } | null;
  requested_reviewers?: { login: string }[];
  requested_teams?: { slug: string }[];
}

/** One open review thread as the card and the thread doors read it. `id` is GitHub's node id — what the reply and resolve doors take. */
export interface ReviewThread {
  id: string;
  path: string | null;
  line: number | null;
  outdated: boolean;
  messages: { id: number | null; author: string; at: string | null; text: string }[];
}

/** Refused before it left: the collector reads, and nothing else (module header). */
export class ReadOnlyRefused extends Error {
  override readonly name = "ReadOnlyRefused";
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
}

/** Is this GraphQL request body a `query` operation and nothing else? Comments stripped; the first token decides, and no mutation or subscription may ride beside it. */
export function isGraphqlQuery(body: unknown): boolean {
  if (typeof body !== "string") return false;
  let doc: unknown;
  try {
    doc = (JSON.parse(body) as { query?: unknown }).query;
  } catch {
    return false;
  }
  if (typeof doc !== "string") return false;
  const text = doc.replace(/#[^\n]*/g, "").trim();
  return /^query\b/.test(text) && !/\b(?:mutation|subscription)\b/.test(text);
}

/**
 * The only fetch this collector sends through: GETs to api.github.com, and a
 * GraphQL `query` to its /graphql. Everything else — another host, another
 * method, a mutation — throws `ReadOnlyRefused` and is never sent.
 */
export function readOnlyGithub(fetchFn: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = urlOf(input);
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new ReadOnlyRefused("github-state: not a URL");
    }
    if (target.origin !== GITHUB_API_ORIGIN) throw new ReadOnlyRefused(`github-state reads ${GITHUB_API_ORIGIN} and nothing else — refused a request to ${target.origin}`);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "GET") return fetchFn(url, init);
    if (method === "POST" && target.pathname === "/graphql" && isGraphqlQuery(init?.body)) return fetchFn(url, init);
    throw new ReadOnlyRefused(`github-state reads and never writes — refused ${method} ${target.pathname} (a review is the owner's door, not this sync's)`);
  };
}

function ghHeaders(ctx: GithubCtx, accept = "application/vnd.github+json") {
  return {
    authorization: `Bearer ${ctx.githubToken}`,
    accept,
    "user-agent": "metistry-github-state",
  };
}

/** The token's own login — "my review" is relative to it. Degrades to null. */
async function fetchViewer(ctx: GithubCtx, get: typeof fetch): Promise<string | null> {
  try {
    const res = await get(`${GITHUB_API_ORIGIN}/user`, { headers: ghHeaders(ctx), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return ((await res.json()) as { login?: string }).login ?? null;
  } catch {
    return null;
  }
}

/** Has `login` left an APPROVED review on this PR? One call per open non-draft PR. */
async function approvedBy(ctx: GithubCtx, get: typeof fetch, repo: string, number: number, login: string): Promise<boolean> {
  const res = await get(`${GITHUB_API_ORIGIN}/repos/${repo}/pulls/${number}/reviews?per_page=100`, {
    headers: ghHeaders(ctx),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`github ${repo}#${number} reviews: HTTP ${res.status}`);
  const reviews = (await res.json()) as { user?: { login: string } | null; state: string }[];
  return reviews.some((r) => r.user?.login === login && r.state === "APPROVED");
}

/** merged_at from the single-PR endpoint — the open-issues listing never carries it. */
async function fetchPullState(ctx: GithubCtx, get: typeof fetch, repo: string, number: number): Promise<{ merged_at: string | null }> {
  const res = await get(`${GITHUB_API_ORIGIN}/repos/${repo}/pulls/${number}`, {
    headers: ghHeaders(ctx),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`github ${repo}#${number} pull state: HTTP ${res.status}`);
  return (await res.json()) as { merged_at: string | null };
}

/** Open PRs with review-request detail and their heads (the issues listing omits both). */
async function fetchPulls(ctx: GithubCtx, get: typeof fetch, repo: string): Promise<Map<number, GhPull>> {
  const out = new Map<number, GhPull>();
  for (let page = 1; page <= 5; page++) {
    const res = await get(`${GITHUB_API_ORIGIN}/repos/${repo}/pulls?state=open&per_page=100&page=${page}`, {
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

async function fetchOpen(ctx: GithubCtx, get: typeof fetch, repo: string): Promise<GhItem[]> {
  const items: GhItem[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await get(`${GITHUB_API_ORIGIN}/repos/${repo}/issues?state=open&per_page=100&page=${page}`, { headers: ghHeaders(ctx), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`github ${repo}: HTTP ${res.status}`);
    const batch = (await res.json()) as GhItem[];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

/** The PR's diff, for the card — capped, and marked when it was. Degrades to none: the card still links the PR. */
async function fetchPatch(ctx: GithubCtx, get: typeof fetch, repo: string, number: number): Promise<{ patch: string; truncated: boolean } | null> {
  try {
    const res = await get(`${GITHUB_API_ORIGIN}/repos/${repo}/pulls/${number}`, { headers: ghHeaders(ctx, "application/vnd.github.diff"), signal: AbortSignal.timeout(30_000) });
    if (!res.ok || typeof res.text !== "function") return null;
    const text = await res.text();
    return text.length > PATCH_CHARS ? { patch: text.slice(0, PATCH_CHARS), truncated: true } : { patch: text, truncated: false };
  } catch {
    return null;
  }
}

/** The one GraphQL document this collector sends: a PR's review threads. A `query` — `readOnlyGithub` refuses anything else. */
export const REVIEW_THREADS_QUERY = `query MetistryReviewThreads($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${THREADS_MAX}) {
        nodes {
          id isResolved isOutdated path line
          comments(first: ${COMMENTS_MAX}) { nodes { databaseId author { login } body createdAt } }
        }
      }
    }
  }
}`;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The PR's open review threads — what the owner may reply to or resolve through the thread doors. */
async function fetchThreads(ctx: GithubCtx, get: typeof fetch, repo: string, number: number): Promise<ReviewThread[]> {
  const [owner, name] = repo.split("/");
  const res = await get(`${GITHUB_API_ORIGIN}/graphql`, {
    method: "POST",
    headers: { ...ghHeaders(ctx), "content-type": "application/json" },
    body: JSON.stringify({ query: REVIEW_THREADS_QUERY, variables: { owner, name, number } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`github ${repo}#${number} review threads: HTTP ${res.status}`);
  const j = (await res.json()) as {
    data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown[] } | null } | null } | null };
    errors?: { message?: string }[];
  };
  if (j.errors?.length) throw new Error(`github ${repo}#${number} review threads: ${j.errors.map((e) => e.message ?? "error").join("; ")}`);
  const nodes = j.data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) throw new Error(`github ${repo}#${number} review threads: the answer has no reviewThreads`);
  const out: ReviewThread[] = [];
  for (const raw of nodes) {
    const t = raw as { id?: unknown; isResolved?: unknown; isOutdated?: unknown; path?: unknown; line?: unknown; comments?: { nodes?: unknown[] } };
    if (typeof t.id !== "string" || t.isResolved === true) continue;
    out.push({
      id: t.id,
      path: typeof t.path === "string" ? t.path : null,
      line: typeof t.line === "number" ? t.line : null,
      outdated: t.isOutdated === true,
      messages: (t.comments?.nodes ?? []).map((c) => {
        const m = c as { databaseId?: unknown; author?: { login?: unknown } | null; body?: unknown; createdAt?: unknown };
        return {
          id: typeof m.databaseId === "number" ? m.databaseId : null,
          author: typeof m.author?.login === "string" ? m.author.login : "ghost",
          at: typeof m.createdAt === "string" ? m.createdAt : null,
          text: clip(typeof m.body === "string" ? m.body : "", COMMENT_CHARS),
        };
      }),
    });
  }
  return out;
}

/** The newest request ever raised for a PR, with the head it was raised for. */
async function lastPullRequest(db: Db, ref: string): Promise<{ decision: string; head_sha: string | null } | null> {
  const { rows } = await db.query(
    `SELECT decision, payload->>'head_sha' AS head_sha FROM proposals
     WHERE source IS NOT NULL AND source->>'kind' = 'github' AND source->>'external_ref' = $1
     ORDER BY id DESC LIMIT 1`,
    [ref],
  );
  const r = rows[0] as { decision: string; head_sha: string | null } | undefined;
  return r ? { decision: String(r.decision), head_sha: r.head_sha ?? null } : null;
}

export interface OpenPull {
  repo: string;
  item: GhItem;
  workId: number | null;
  head: string | null;
  needs: boolean;
  /** the viewer is known, so `needs` is an answer and not a degradation */
  known: boolean;
  requested: boolean;
  threads: ReviewThread[];
}

/** The request a PR waiting on my review raises: what the card draws (§2.12's diff body), and the head it was shown at. */
export function reviewPayload(p: OpenPull, patch: { patch: string; truncated: boolean } | null): Record<string, unknown> {
  return {
    title: `Review ${p.repo}#${p.item.number}: ${p.item.title}`,
    event: REVIEW_EVENT,
    repo: p.repo,
    number: p.item.number,
    url: p.item.html_url,
    head_sha: p.head,
    author: p.item.user?.login ?? null,
    requested: p.requested,
    ...(patch ? { patch: patch.patch, ...(patch.truncated ? { patch_truncated: true } : {}) } : {}),
    threads: p.threads,
  };
}

/** One PR's mirror, against what GitHub says now (module header). Returns how many requests it raised or cleared. */
async function reconcileMirror(db: Db, ctx: GithubCtx, get: typeof fetch, p: OpenPull, raiseOn: boolean): Promise<number> {
  if (!p.known) return 0; // who "my" is unknown: claim nothing, clear nothing
  const source = githubPullSource(p.repo, p.item.number, p.item.user?.login ?? null);
  const last = await lastPullRequest(db, source.external_ref);
  if (!p.needs) {
    // the review landed (my approval), or it went back to draft
    return last?.decision === "pending" ? (await resolveAtSource(db, source)).length : 0;
  }
  let cleared = 0;
  if (last?.decision === "pending") {
    if (last.head_sha !== null && last.head_sha === p.head) return 0; // waiting, on this head
    // it was pushed again: the question the owner may be reading is not this one
    cleared = (await resolveAtSource(db, source)).length;
  } else if (last && last.decision !== RESOLVED_AT_SOURCE && last.head_sha === p.head) {
    return 0; // answered, for this head
  }
  if (!raiseOn) return cleared;
  await raiseMirror(db, {
    kind: PULL_REQUEST_KIND,
    source_agent: COMPONENT,
    trust: "external", // the words are GitHub's, not the owner's or the assistant's
    source,
    payload: reviewPayload(p, await fetchPatch(ctx, get, p.repo, p.item.number)),
    work_id: p.workId,
  });
  return cleared + 1;
}

/** One reconcile pass. Returns rows upserted + closed, and requests raised or cleared. */
export async function run(db: Db, ctx: GithubCtx = {}): Promise<number> {
  if (!ctx.githubToken || !ctx.githubRepos?.length) return 0; // degrades absent
  const get = readOnlyGithub(ctx.fetchFn ?? fetch);
  const raiseOn = ctx.raise && Object.hasOwn(ctx.raise, "review_requested") ? ctx.raise.review_requested === true : RAISE_DEFAULTS.review_requested;
  let touched = 0;
  const me = await fetchViewer(ctx, get);
  for (const repo of ctx.githubRepos) {
    const open = await fetchOpen(ctx, get, repo);
    const pulls = open.some((i) => i.pull_request) ? await fetchPulls(ctx, get, repo) : new Map<number, GhPull>();
    const area = repo.split("/")[1] ?? repo;
    const refs: string[] = [];
    const openPulls: OpenPull[] = [];
    for (const it of open) {
      const ref = githubPullRef(repo, it.number);
      refs.push(ref);
      const author = it.user?.login ?? null;
      const meta: Record<string, unknown> = { author, url: it.html_url };
      let pull: Omit<OpenPull, "workId"> | null = null;
      if (it.pull_request) {
        const p = pulls.get(it.number);
        const reviewers = (p?.requested_reviewers ?? []).map((r) => r.login);
        const head = typeof p?.head?.sha === "string" ? p.head.sha : null;
        meta.draft = !!p?.draft;
        meta.head_sha = head;
        meta.review_requested = reviewers;
        meta.review_teams = (p?.requested_teams ?? []).map((t) => t.slug);
        // "needs my review" (owner ruling 2026-09-06): the configured repos
        // are the ones I review, so any open non-draft PR I haven't approved
        // needs me — including PRs opened under my own account by an agent.
        // A fresh review request re-opens it even after an approval. Teams
        // are listed but not matched (membership isn't known here). Unknown
        // viewer (/user degraded) → never claims a review is mine.
        const needs = !!me && !p?.draft && (reviewers.includes(me) || !(await approvedBy(ctx, get, repo, it.number, me)));
        meta.needs_my_review = needs;
        // the open review threads of a PR waiting on me: what the owner may
        // reply to or resolve (the thread doors), read on every pass
        const threads = needs ? await fetchThreads(ctx, get, repo, it.number) : [];
        if (needs) meta.threads = threads;
        pull = { repo, item: it, head, needs, known: !!me, requested: !!me && reviewers.includes(me), threads };
      }
      const { rows } = await db.query(
        `INSERT INTO work (title, area, kind, status, external_ref, owner, due, updated_at, meta)
         VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8)
         ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO UPDATE SET
           title = EXCLUDED.title, status = 'open', owner = EXCLUDED.owner,
           due = EXCLUDED.due, updated_at = EXCLUDED.updated_at, meta = EXCLUDED.meta
         RETURNING id`,
        [it.title, area, it.pull_request ? "pr" : "issue", ref, it.assignee?.login ?? null,
         it.milestone?.due_on ? it.milestone.due_on.slice(0, 10) : null, it.updated_at, JSON.stringify(meta)],
      );
      touched++;
      if (pull) openPulls.push({ ...pull, workId: rows[0] ? Number(rows[0].id) : null });
    }
    for (const p of openPulls) touched += await reconcileMirror(db, ctx, get, p, raiseOn);
    // anything we track for this repo that is no longer open → closed
    const closed = await db.query(
      `UPDATE work SET status = 'closed', updated_at = now()
       WHERE external_ref LIKE $1 AND status <> 'closed' AND NOT (external_ref = ANY($2::text[]))
       RETURNING id, external_ref, kind`,
      [`gh:${repo}#%`, refs],
    );
    touched += closed.rows.length;
    // Merged vs. closed-without-merge only shows up on the single-PR endpoint
    // (the /pulls list we already fetched doesn't carry it) — fetch it, but
    // only for rows we're actually closing right now, so cost stays bounded.
    // A closed PR owes no review: its request resolves at source.
    for (const row of closed.rows as { id: number; external_ref: string; kind: string }[]) {
      if (row.kind !== "pr") continue;
      const m = /#(\d+)$/.exec(row.external_ref);
      if (!m) continue;
      const state = await fetchPullState(ctx, get, repo, Number(m[1]));
      await db.query(`UPDATE work SET meta = meta || $2::jsonb WHERE id = $1`, [
        row.id,
        JSON.stringify({ merged: !!state.merged_at, merged_at: state.merged_at ?? null }),
      ]);
      await resolveAtSource(db, githubPullSource(repo, Number(m[1])));
    }
  }
  return touched;
}
