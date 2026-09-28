// Mirrors as the hub (T4-23, R7; screen 3 §12.7) against the real (scratch)
// database: one subject is one card whoever asked first — an agent's review
// ask and GitHub's review request for the same PR are ONE row with both
// askers on it — every clear carries a receipt naming what happened at the
// source, and an issue assigned to me raises one `task` mirror that clears
// when it is closed or given to someone else. The one-row guarantee is
// Postgres's (0027's unique index), so only Postgres can prove it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { submitPullRequest } from "@foldedspacelabs/metistry-mcp-brain";
import { RECEIPTS, run } from "../github-state/run.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const REPO = `itest-hub-${suffix}/repo`;
const HEAD = "e".repeat(40);
const AGENT = `itest-hub-agent-${suffix}`;

/** What GitHub says right now, which each test moves: PRs by number, issues by number with their assignees. */
interface State {
  viewer: string | null;
  pulls: Map<number, { open: boolean; approved: boolean }>;
  issues: Map<number, { open: boolean; assignees: string[] }>;
}

function github(s: State): typeof fetch {
  return (async (url: string) => {
    const u = new URL(url);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/user") return s.viewer ? json({ login: s.viewer }) : new Response("nope", { status: 401 });
    if (u.pathname === "/graphql") return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    const review = /^\/repos\/.+\/pulls\/(\d+)\/reviews$/.exec(u.pathname);
    if (review) return json(s.pulls.get(Number(review[1]))?.approved ? [{ user: { login: "me" }, state: "APPROVED" }] : []);
    if (u.pathname === `/repos/${REPO}/pulls`) {
      return json([...s.pulls].filter(([, p]) => p.open).map(([number]) => ({ number, draft: false, head: { sha: HEAD }, user: { login: "dana" }, requested_reviewers: [] })));
    }
    const one = /^\/repos\/.+\/pulls\/(\d+)$/.exec(u.pathname);
    if (one) return s.pulls.get(Number(one[1]))?.open ? new Response("@@ -1 +1 @@\n-a\n+b\n", { status: 200 }) : json({ merged_at: "2026-09-28T13:00:00Z" });
    if (u.pathname === `/repos/${REPO}/issues`) {
      const pulls = [...s.pulls].filter(([, p]) => p.open).map(([number]) => ({
        number, title: `PR ${number}`, state: "open", pull_request: {}, html_url: `https://github.com/${REPO}/pull/${number}`, updated_at: "2026-09-28T12:00:00Z", user: { login: "dana" },
      }));
      const issues = [...s.issues].filter(([, i]) => i.open).map(([number, i]) => ({
        number, title: `Issue ${number}`, state: "open", body: "The parser  drops\nthe last token.", html_url: `https://github.com/${REPO}/issues/${number}`, updated_at: "2026-09-28T12:00:00Z",
        user: { login: "sam" }, assignee: i.assignees[0] ? { login: i.assignees[0] } : null, assignees: i.assignees.map((login) => ({ login })),
      }));
      return json([...pulls, ...issues]);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe.skipIf(!hasDb)("mirrors as the hub (T4-23, real db)", () => {
  let pool: pg.Pool;
  const s: State = { viewer: "me", pulls: new Map(), issues: new Map() };
  const pass = (raise?: Record<string, boolean>) => run(pool, { githubToken: "t", githubRepos: [REPO], fetchFn: github(s), ...(raise ? { raise } : {}) });
  const rowsFor = async (n: number) =>
    (
      await pool.query(`SELECT id, kind, source_agent, decision, payload FROM proposals WHERE source->>'kind' = 'github' AND source->>'external_ref' = $1 ORDER BY id`, [`gh:${REPO}#${n}`])
    ).rows as { id: number; kind: string; source_agent: string; decision: string; payload: Record<string, any> }[];
  const ask = (n: number, body: string) => submitPullRequest(pool, AGENT, { title: `Review PR ${n}`, body, refs: [`https://github.com/${REPO}/pull/${n}`] });

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM proposals WHERE source->>'external_ref' LIKE $1`, [`gh:${REPO}#%`]);
    await pool.query(`DELETE FROM work WHERE external_ref LIKE $1`, [`gh:${REPO}#%`]);
    await pool.end();
  });

  it("one card for an agent ask and a GitHub request on the same PR — GitHub first, then the agent: both askers on it", async () => {
    s.pulls.set(1, { open: true, approved: false });
    await pass();
    const asked = await ask(1, "I changed the tokenizer; the tests pass.");
    expect(asked).toMatchObject({ ok: true, deduplicated: "subject" });
    const rows = await rowsFor(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "pull_request", source_agent: "github-state", decision: "pending" });
    expect(asked.ok && asked.id).toBe(Number(rows[0]!.id));
    expect(rows[0]!.payload.also_asked).toEqual([
      expect.objectContaining({ source_agent: AGENT, trust: "external", title: "Review PR 1", event: "review_asked", context: { prose: "I changed the tokenizer; the tests pass.", refs: [`https://github.com/${REPO}/pull/1`] } }),
    ]);
    // GitHub's own words are untouched by the second asker
    expect(rows[0]!.payload).toMatchObject({ title: `Review ${REPO}#1: PR 1`, event: "review_requested", head_sha: HEAD });

    // the same agent again, and the sync's next pass: still one card, the asker once
    await ask(1, "again");
    await pass();
    const again = await rowsFor(1);
    expect(again).toHaveLength(1);
    expect(again[0]!.payload.also_asked).toHaveLength(1);
  });

  it("one card for an agent ask and a GitHub request on the same PR — the agent first, then GitHub: both askers on it", async () => {
    s.pulls.set(2, { open: true, approved: false });
    await pass({ review_requested: false }); // the sync tracks the PR (and its head) but raises nothing
    expect(await rowsFor(2)).toHaveLength(0);
    const asked = await ask(2, "Ready for you.");
    expect(asked).toMatchObject({ ok: true, deduplicated: false });
    await pass(); // now GitHub's request for the same PR
    const rows = await rowsFor(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_agent: AGENT, decision: "pending" });
    expect(rows[0]!.payload.also_asked).toEqual([expect.objectContaining({ source_agent: "github-state", trust: "external", event: "review_requested" })]);
  });

  it("a source change resolves the one card with a receipt naming what happened there", async () => {
    s.pulls.set(1, { open: true, approved: true });
    await pass();
    const [one] = await rowsFor(1);
    expect(one).toMatchObject({ decision: "resolved_at_source" });
    expect(one!.payload.cleared).toEqual({ what: RECEIPTS.approved, where: "github" });
    expect(one!.payload.also_asked).toHaveLength(1); // the askers survive the clear

    s.pulls.set(2, { open: false, approved: false });
    await pass();
    const [two] = await rowsFor(2);
    expect(two).toMatchObject({ decision: "resolved_at_source" });
    expect(two!.payload.cleared).toEqual({ what: RECEIPTS.merged, where: "github" });
  });

  it("an issue assigned to me raises one task, once per assignment, and clears with a receipt when it is given away or closed", async () => {
    s.issues.set(10, { open: true, assignees: ["sam", "me"] });
    s.issues.set(11, { open: true, assignees: ["sam"] }); // not mine: nothing
    await pass();
    await pass();
    let ten = await rowsFor(10);
    expect(ten).toHaveLength(1);
    expect(ten[0]).toMatchObject({ kind: "task", source_agent: "github-state", decision: "pending" });
    expect(ten[0]!.payload).toMatchObject({ title: `${REPO}#10 · Issue 10`, body: "The parser drops the last token.", event: "github_assigned", repo: REPO, number: 10, url: `https://github.com/${REPO}/issues/10`, author: "sam" });
    const work = (await pool.query(`SELECT id FROM work WHERE external_ref = $1`, [`gh:${REPO}#10`])).rows[0];
    expect((await pool.query(`SELECT work_id FROM proposals WHERE id = $1`, [ten[0]!.id])).rows[0].work_id).toBe(work.id);
    expect(await rowsFor(11)).toHaveLength(0);

    // given to someone else: cleared at its source, saying so
    s.issues.set(10, { open: true, assignees: ["sam"] });
    await pass();
    ten = await rowsFor(10);
    expect(ten.map((r) => r.decision)).toEqual(["resolved_at_source"]);
    expect(ten[0]!.payload.cleared).toEqual({ what: RECEIPTS.reassigned, where: "github" });

    // back to me: a new assignment, a new card; answered, it is not asked again while it lasts
    s.issues.set(10, { open: true, assignees: ["me"] });
    await pass();
    ten = await rowsFor(10);
    expect(ten.map((r) => r.decision)).toEqual(["resolved_at_source", "pending"]);
    await pool.query(`UPDATE proposals SET decision = 'deny', decided_at = now() WHERE id = $1`, [ten[1]!.id]);
    await pass();
    expect((await rowsFor(10)).map((r) => r.decision)).toEqual(["resolved_at_source", "deny"]);

    // closed: a waiting one clears as closed
    s.issues.set(12, { open: true, assignees: ["me"] });
    await pass();
    s.issues.set(12, { open: false, assignees: ["me"] });
    await pass();
    const twelve = await rowsFor(12);
    expect(twelve.map((r) => r.decision)).toEqual(["resolved_at_source"]);
    expect(twelve[0]!.payload.cleared).toEqual({ what: RECEIPTS.closed, where: "github" });
  });

  it("raises no issue task with the switch off, and an unknown viewer claims nothing and clears nothing", async () => {
    s.issues.set(13, { open: true, assignees: ["me"] });
    await pass({ assigned: false });
    expect(await rowsFor(13)).toHaveLength(0);
    await pass();
    expect((await rowsFor(13)).map((r) => r.decision)).toEqual(["pending"]);

    s.viewer = null; // /user degraded
    s.issues.set(13, { open: true, assignees: ["sam"] });
    s.issues.set(14, { open: true, assignees: ["me"] });
    await pass();
    expect((await rowsFor(13)).map((r) => r.decision)).toEqual(["pending"]);
    expect(await rowsFor(14)).toHaveLength(0);
    s.viewer = "me";
  });
});
