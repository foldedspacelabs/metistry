import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { loadKind } from "@foldedspacelabs/metistry-core";
import { RAISE_DEFAULTS, REVIEW_THREADS_QUERY, ReadOnlyRefused, isGraphqlQuery, readOnlyGithub, run } from "./run.js";

function fakeDb(closedRows: { id: number; external_ref: string; kind: string }[] = [{ id: 1, external_ref: "", kind: "" }]) {
  const q: { text: string; values: unknown[] }[] = [];
  return {
    q,
    async query(text: string, values: unknown[] = []) {
      q.push({ text, values });
      if (text.startsWith("UPDATE work SET status")) return { rows: closedRows };
      if (text.startsWith("INSERT INTO proposals")) return { rows: [{ id: 1 }] };
      return { rows: [] };
    },
  };
}

const HEAD = "a".repeat(40);
/** GitHub's GraphQL answer for a PR with no review threads. */
const NO_THREADS = { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } };

describe("github-state collector", () => {
  it("degrades absent without token/repos", async () => {
    const db = fakeDb();
    expect(await run(db, {})).toBe(0);
    expect(db.q).toHaveLength(0);
  });

  it("upserts open issues/PRs with gh: refs and closes the rest", async () => {
    const db = fakeDb();
    const fetchFn = (async (url: string) => ({
      ok: true,
      text: async () => "diff --git a/x b/x\n+new\n",
      json: async () => {
        if (url.endsWith("/user")) return { login: "samrivera" };
        if (url.endsWith("/graphql")) return NO_THREADS;
        if (url.endsWith("/reviews?per_page=100")) return [];
        if (url.includes("/pulls?")) return [
          { number: 9, draft: false, head: { sha: HEAD }, user: { login: "claude" }, requested_reviewers: [{ login: "samrivera" }], requested_teams: [] },
        ];
        return [
          { number: 7, title: "fix brief tz", state: "open", html_url: "https://gh/7", updated_at: "2026-09-01T00:00:00Z", user: { login: "samrivera" }, assignee: { login: "samrivera" } },
          { number: 9, title: "ios plan", state: "open", pull_request: {}, html_url: "https://gh/9", updated_at: "2026-09-02T00:00:00Z", user: { login: "claude" }, milestone: { due_on: "2026-09-10T00:00:00Z" } },
        ];
      },
    })) as unknown as typeof fetch;
    const n = await run(db, { githubToken: "t", githubRepos: ["foldedspacelabs/metistry"], fetchFn });
    const inserts = db.q.filter((x) => x.text.startsWith("INSERT INTO work"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.values).toContain("gh:foldedspacelabs/metistry#7");
    expect(inserts[0]!.values).toContain("issue");
    expect(inserts[1]!.values).toContain("pr");
    expect(inserts[1]!.values).toContain("2026-09-10");
    expect(JSON.parse(String(inserts[0]!.values[7]))).toEqual({ author: "samrivera", url: "https://gh/7" });
    expect(JSON.parse(String(inserts[1]!.values[7]))).toEqual({
      author: "claude", url: "https://gh/9", draft: false, head_sha: HEAD, review_requested: ["samrivera"], review_teams: [], needs_my_review: true, threads: [],
    });
    const close = db.q.find((x) => x.text.startsWith("UPDATE work"))!;
    expect(close.values[1]).toEqual(["gh:foldedspacelabs/metistry#7", "gh:foldedspacelabs/metistry#9"]);
    // 2 upserts + 2 requests raised (the PR waiting on my review; #7, assigned to me, a task — T4-23) + 1 closed
    expect(n).toBe(5);
    const raised = db.q.filter((x) => x.text.startsWith("INSERT INTO proposals")).map((x) => x.values[0]);
    expect(raised.sort()).toEqual(["pull_request", "task"]);
  });

  it("surfaces API failure as an error (the runner records it), never silent", async () => {
    const db = fakeDb();
    const fetchFn = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    await expect(run(db, { githubToken: "bad", githubRepos: ["o/r"], fetchFn })).rejects.toThrow(/HTTP 401/);
  });

  it("needs_my_review: open non-draft PR I haven't approved → true; my approval clears it; re-request re-opens it; draft/unknown viewer → false", async () => {
    const mk = (viewerOk: boolean, pull: any, reviews: any[]) => (async (url: string) => {
      if (url.endsWith("/user")) return { ok: viewerOk, json: async () => ({ login: "me" }) };
      if (url.endsWith("/graphql")) return { ok: true, json: async () => NO_THREADS };
      if (url.includes("/reviews?")) return { ok: true, json: async () => reviews };
      return { ok: true, json: async () => (url.includes("/pulls?") ? [pull] : [
        { number: 1, title: "t", state: "open", pull_request: {}, html_url: "", updated_at: "2026-09-01T00:00:00Z", user: pull.user },
      ]) };
    }) as unknown as typeof fetch;
    const needs = async (viewerOk: boolean, pull: any, reviews: any[] = []) => {
      const db = fakeDb();
      await run(db, { githubToken: "t", githubRepos: ["o/r"], fetchFn: mk(viewerOk, pull, reviews) });
      return JSON.parse(String(db.q.find((x) => x.text.startsWith("INSERT"))!.values[7])).needs_my_review;
    };
    const mine = { number: 1, user: { login: "me" }, requested_reviewers: [] };
    const theirs = { number: 1, user: { login: "other" }, requested_reviewers: [] };
    const approved = [{ user: { login: "me" }, state: "APPROVED" }];
    expect(await needs(true, mine)).toBe(true); // agent-opened under my account, unreviewed
    expect(await needs(true, theirs)).toBe(true);
    expect(await needs(true, theirs, [{ user: { login: "me" }, state: "COMMENTED" }])).toBe(true); // a comment isn't an approval
    expect(await needs(true, theirs, approved)).toBe(false);
    expect(await needs(true, { ...theirs, requested_reviewers: [{ login: "me" }] }, approved)).toBe(true); // re-requested
    expect(await needs(true, { ...theirs, draft: true })).toBe(false);
    expect(await needs(false, theirs)).toBe(false); // /user degraded → never claims a review is mine
  });

  it("closed PRs are fetched for merged state; closed issues are not", async () => {
    const db = fakeDb([
      { id: 11, external_ref: "gh:o/r#5", kind: "pr" },
      { id: 12, external_ref: "gh:o/r#6", kind: "issue" },
    ]);
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      if (url.endsWith("/user")) return { ok: true, json: async () => ({ login: "me" }) };
      if (url.includes("/reviews?")) return { ok: true, json: async () => [] };
      if (url.includes("/pulls?")) return { ok: true, json: async () => [] }; // nothing open right now
      if (url.endsWith("/pulls/5")) return { ok: true, json: async () => ({ merged_at: "2026-09-05T00:00:00Z" }) };
      return { ok: true, json: async () => [] }; // open-issues listing: empty
    }) as unknown as typeof fetch;
    await run(db, { githubToken: "t", githubRepos: ["o/r"], fetchFn });
    expect(calls.filter((u) => u.endsWith("/pulls/5"))).toHaveLength(1);
    expect(calls.some((u) => u.endsWith("/pulls/6"))).toBe(false); // issue: no per-PR fetch
    const metaUpdate = db.q.find((x) => x.text.startsWith("UPDATE work SET meta"));
    expect(metaUpdate!.values).toEqual([11, JSON.stringify({ merged: true, merged_at: "2026-09-05T00:00:00Z" })]);
  });

  it("closed-without-merge sets meta.merged = false", async () => {
    const db = fakeDb([{ id: 21, external_ref: "gh:o/r#8", kind: "pr" }]);
    const fetchFn = (async (url: string) => {
      if (url.endsWith("/user")) return { ok: true, json: async () => ({ login: "me" }) };
      if (url.includes("/reviews?")) return { ok: true, json: async () => [] };
      if (url.includes("/pulls?")) return { ok: true, json: async () => [] };
      if (url.endsWith("/pulls/8")) return { ok: true, json: async () => ({ merged_at: null }) };
      return { ok: true, json: async () => [] };
    }) as unknown as typeof fetch;
    await run(db, { githubToken: "t", githubRepos: ["o/r"], fetchFn });
    const metaUpdate = db.q.find((x) => x.text.startsWith("UPDATE work SET meta"));
    expect(metaUpdate!.values).toEqual([21, JSON.stringify({ merged: false, merged_at: null })]);
  });
});

// ---- T2-13: the read-only client, the manifest's defaults, the raise ------------------------

describe("the collector's PAT stays read-only (T2-13)", () => {
  const sent: { url: string; method: string }[] = [];
  const base = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method ?? "GET" });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const get = readOnlyGithub(base);
  const gql = (query: string) => JSON.stringify({ query, variables: {} });

  it("sends a GET to api.github.com and a GraphQL query to its /graphql — and nothing else leaves", async () => {
    sent.length = 0;
    await get("https://api.github.com/repos/o/r/pulls?state=open");
    await get("https://api.github.com/graphql", { method: "POST", body: gql(REVIEW_THREADS_QUERY) });
    expect(sent.map((x) => x.method)).toEqual(["GET", "POST"]);

    const refused: [string, RequestInit | undefined][] = [
      ["https://api.github.com/repos/o/r/pulls/1/reviews", { method: "POST", body: JSON.stringify({ event: "APPROVE", commit_id: HEAD }) }],
      ["https://api.github.com/repos/o/r/pulls/1/comments/5/replies", { method: "POST", body: "{}" }],
      ["https://api.github.com/repos/o/r/issues/1", { method: "PATCH", body: "{}" }],
      ["https://api.github.com/repos/o/r/pulls/1/requested_reviewers", { method: "DELETE" }],
      ["https://api.github.com/repos/o/r/contents/x", { method: "PUT", body: "{}" }],
      ["https://api.github.com/graphql", { method: "POST", body: gql("mutation { resolveReviewThread(input: {threadId: \"PRRT_1\"}) { thread { id } } }") }],
      ["https://api.github.com/graphql", { method: "POST", body: gql("query A { viewer { login } } mutation B { addPullRequestReviewThreadReply(input: {}) { comment { id } } }") }],
      ["https://api.github.com/graphql", { method: "POST", body: gql("# a comment\nsubscription { x }") }],
      ["https://api.github.com/graphql", { method: "POST", body: "not json" }],
      ["https://uploads.github.com/repos/o/r/releases/1/assets", { method: "GET" }],
      ["https://evil.example/repos/o/r/pulls", undefined],
    ];
    sent.length = 0;
    for (const [url, init] of refused) await expect(get(url, init), `${init?.method ?? "GET"} ${url}`).rejects.toBeInstanceOf(ReadOnlyRefused);
    expect(sent).toEqual([]); // refused before it left
  });

  it("reads a document's first operation, comments and all", () => {
    expect(isGraphqlQuery(gql(REVIEW_THREADS_QUERY))).toBe(true);
    expect(isGraphqlQuery(gql("  # leading comment\n query X { a }"))).toBe(true);
    expect(isGraphqlQuery(gql("{ a }"))).toBe(false); // the shorthand is a query to GraphQL, but not a document this client sends
    expect(isGraphqlQuery(JSON.stringify({ variables: {} }))).toBe(false);
    expect(isGraphqlQuery(undefined)).toBe(false);
  });

  it("a whole pass sends only GETs and the one threads query", async () => {
    const methods: string[] = [];
    const bodies: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      methods.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      if (typeof init?.body === "string") bodies.push(init.body);
      return {
        ok: true,
        text: async () => "",
        json: async () => {
          if (url.endsWith("/user")) return { login: "me" };
          if (url.endsWith("/graphql")) return NO_THREADS;
          if (url.includes("/reviews?")) return [];
          if (url.includes("/pulls?")) return [{ number: 3, head: { sha: HEAD }, user: { login: "dana" }, requested_reviewers: [{ login: "me" }] }];
          return [{ number: 3, title: "t", state: "open", pull_request: {}, html_url: "https://github.com/o/r/pull/3", updated_at: "2026-09-01T00:00:00Z", user: { login: "dana" } }];
        },
      };
    }) as unknown as typeof fetch;
    await run(fakeDb([]), { githubToken: "t", githubRepos: ["o/r"], fetchFn });
    expect(methods.every((m) => m.startsWith("GET ") || m === "POST /graphql"), methods.join(", ")).toBe(true);
    expect(bodies.every((b) => isGraphqlQuery(b))).toBe(true);
    expect(methods).toContain("POST /graphql");
  });
});

describe("the github-state manifest", () => {
  it("loads through the collector registry, and its needs_you defaults are the ones the code applies", async () => {
    const reg = await loadKind("collector", { productDir: fileURLToPath(new URL("../..", import.meta.url)) });
    const m = reg.get("github-state")?.manifest;
    expect(m, JSON.stringify(reg.skipped)).toBeDefined();
    expect(m?.needs_you?.review_requested?.default).toBe(RAISE_DEFAULTS.review_requested);
    expect(Object.fromEntries(Object.entries(m?.needs_you ?? {}).map(([k, v]) => [k, v.default]))).toEqual(RAISE_DEFAULTS);
  });
});

describe("the pull request mirror, without a database", () => {
  const pass = (over: { viewerOk?: boolean; reviewers?: string[]; draft?: boolean } = {}) =>
    (async (url: string) => ({
      ok: true,
      text: async () => "@@ -1 +1 @@\n-old\n+new\n",
      json: async () => {
        if (url.endsWith("/user")) return { login: "me" };
        if (url.endsWith("/graphql")) return NO_THREADS;
        if (url.includes("/reviews?")) return [];
        if (url.includes("/pulls?")) return [{ number: 3, draft: over.draft ?? false, head: { sha: HEAD }, user: { login: "dana" }, requested_reviewers: (over.reviewers ?? ["me"]).map((login) => ({ login })) }];
        return [{ number: 3, title: "Fix the parser", state: "open", pull_request: {}, html_url: "https://github.com/o/r/pull/3", updated_at: "2026-09-01T00:00:00Z", user: { login: "dana" } }];
      },
    })) as unknown as typeof fetch;
  const viewerless = (async (url: string) => (url.endsWith("/user") ? { ok: false, status: 401, json: async () => ({}) } : pass()(url))) as unknown as typeof fetch;

  it("raises one pull_request request carrying the head, the diff and the threads", async () => {
    const db = fakeDb([]);
    await run(db, { githubToken: "t", githubRepos: ["o/r"], fetchFn: pass() });
    const ins = db.q.filter((x) => x.text.startsWith("INSERT INTO proposals"));
    expect(ins).toHaveLength(1);
    const [kind, agent, trust, payload, source] = ins[0]!.values as string[];
    expect([kind, agent, trust]).toEqual(["pull_request", "github-state", "external"]);
    expect(JSON.parse(source!)).toEqual({ kind: "github", external_ref: "gh:o/r#3", person: "dana" });
    expect(JSON.parse(payload!)).toEqual({
      title: "Review o/r#3: Fix the parser",
      event: "review_requested",
      repo: "o/r",
      number: 3,
      url: "https://github.com/o/r/pull/3",
      head_sha: HEAD,
      author: "dana",
      requested: true,
      patch: "@@ -1 +1 @@\n-old\n+new\n",
      threads: [],
    });
  });

  it("raises nothing with syncs.github-state.raise.review_requested off", async () => {
    const db = fakeDb([]);
    await run(db, { githubToken: "t", githubRepos: ["o/r"], fetchFn: pass(), raise: { review_requested: false, assigned: true } });
    expect(db.q.some((x) => x.text.startsWith("INSERT INTO proposals"))).toBe(false);
  });

  it("an unknown viewer claims nothing and clears nothing", async () => {
    const db = fakeDb([]);
    await run(db, { githubToken: "t", githubRepos: ["o/r"], fetchFn: viewerless });
    expect(db.q.some((x) => /proposals/.test(x.text))).toBe(false);
  });
});
