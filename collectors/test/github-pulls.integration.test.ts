// The pull request mirror against the real (scratch) database (T2-13): one
// pending request per PR, for its current head; a new head is a new
// question; the request resolves at source when the review lands — my
// approval, a draft, a close — and an answer the owner gave is not asked
// again for the same head. The unique index that makes two raises one row is
// Postgres's (0027), so only Postgres can prove it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { RECEIPTS, run } from "../github-state/run.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const REPO = `itest-pr-${suffix}/repo`;
const REF = `gh:${REPO}#7`;
const sha = (c: string) => c.repeat(40);

/** What GitHub says right now, which each test moves. */
interface State {
  open: boolean;
  head: string;
  draft: boolean;
  reviewers: string[];
  reviews: { user: { login: string }; state: string }[];
  merged: boolean;
}

function github(s: State): typeof fetch {
  return (async (url: string) => {
    const u = new URL(url);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/user") return json({ login: "me" });
    if (u.pathname === "/graphql") {
      return json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  { id: "PRRT_open", isResolved: false, isOutdated: false, path: "src/a.ts", line: 4, comments: { nodes: [{ databaseId: 55, author: { login: "dana" }, body: "409 or 422?", createdAt: "2026-09-28T12:40:00Z" }] } },
                  { id: "PRRT_done", isResolved: true, isOutdated: false, path: "src/b.ts", line: 1, comments: { nodes: [] } },
                ],
              },
            },
          },
        },
      });
    }
    if (u.pathname.endsWith("/reviews")) return json(s.reviews);
    if (u.pathname === `/repos/${REPO}/pulls`) return json(s.open ? [{ number: 7, draft: s.draft, head: { sha: s.head }, user: { login: "dana" }, requested_reviewers: s.reviewers.map((login) => ({ login })) }] : []);
    if (u.pathname === `/repos/${REPO}/pulls/7`) return new Response(s.open ? "@@ -1 +1 @@\n-a\n+b\n" : JSON.stringify({ merged_at: s.merged ? "2026-09-28T13:00:00Z" : null }), { status: 200 });
    if (u.pathname === `/repos/${REPO}/issues`) {
      return json(s.open ? [{ number: 7, title: "Fix the parser", state: "open", pull_request: {}, html_url: `https://github.com/${REPO}/pull/7`, updated_at: "2026-09-28T12:00:00Z", user: { login: "dana" } }] : []);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe.skipIf(!hasDb)("the pull request mirror (real db)", () => {
  let pool: pg.Pool;
  const s: State = { open: true, head: sha("a"), draft: false, reviewers: ["me"], reviews: [], merged: false };
  const pass = () => run(pool, { githubToken: "t", githubRepos: [REPO], fetchFn: github(s) });
  const requests = async () =>
    (
      await pool.query(
        `SELECT id, decision, payload->>'head_sha' AS head, work_id FROM proposals WHERE kind = 'pull_request' AND source->>'external_ref' = $1 ORDER BY id`,
        [REF],
      )
    ).rows as { id: number; decision: string; head: string; work_id: number | null }[];

  const receipt = async (id: number) => (await pool.query(`SELECT payload->'cleared' AS cleared FROM proposals WHERE id = $1`, [id])).rows[0].cleared;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM proposals WHERE source->>'external_ref' LIKE $1`, [`gh:${REPO}#%`]);
    await pool.query(`DELETE FROM work WHERE external_ref LIKE $1`, [`gh:${REPO}#%`]);
    await pool.end();
  });

  it("raises one request for the head it saw, linked to the work row whose meta.head_sha the stale check reads", async () => {
    await pass();
    await pass(); // every pass raises; one row waits
    const rows = await requests();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "pending", head: sha("a") });
    const w = (await pool.query(`SELECT id, meta FROM work WHERE external_ref = $1`, [REF])).rows[0] as { id: number; meta: Record<string, unknown> };
    expect(Number(rows[0]!.work_id)).toBe(Number(w.id));
    expect(w.meta.head_sha).toBe(sha("a"));
    // the open threads were collected; a resolved one was not
    expect((w.meta.threads as { id: string }[]).map((t) => t.id)).toEqual(["PRRT_open"]);
    const p = (await pool.query(`SELECT payload, source_agent, trust FROM proposals WHERE id = $1`, [rows[0]!.id])).rows[0];
    expect(p).toMatchObject({ source_agent: "github-state", trust: "external" });
    expect(p.payload.threads[0]).toEqual({ id: "PRRT_open", path: "src/a.ts", line: 4, outdated: false, messages: [{ id: 55, author: "dana", at: "2026-09-28T12:40:00Z", text: "409 or 422?" }] });
    expect(p.payload.patch).toBe("@@ -1 +1 @@\n-a\n+b\n");
  });

  it("a new head is a new question: the waiting one resolves at source, one for the new head is raised", async () => {
    s.head = sha("b");
    await pass();
    const rows = await requests();
    expect(rows.map((r) => [r.decision, r.head])).toEqual([
      ["resolved_at_source", sha("a")],
      ["pending", sha("b")],
    ]);
    expect(await receipt(rows[0]!.id)).toEqual({ what: RECEIPTS.pushed, where: "github" }); // T4-23
  });

  it("an answer the owner gave is not asked again for the same head — a new push asks again", async () => {
    await pool.query(`UPDATE proposals SET decision = 'accept_with_changes', feedback = 'rename it', decided_at = now() WHERE source->>'external_ref' = $1 AND decision = 'pending'`, [REF]);
    await pass();
    expect((await requests()).filter((r) => r.decision === "pending")).toHaveLength(0);
    s.head = sha("c");
    await pass();
    expect((await requests()).filter((r) => r.decision === "pending").map((r) => r.head)).toEqual([sha("c")]);
  });

  it("resolves at source when my approval lands on GitHub, and asks again when I am re-requested", async () => {
    s.reviewers = [];
    s.reviews = [{ user: { login: "me" }, state: "APPROVED" }];
    await pass();
    expect((await requests()).at(-1)).toMatchObject({ decision: "resolved_at_source", head: sha("c") });
    expect(await receipt((await requests()).at(-1)!.id)).toEqual({ what: RECEIPTS.approved, where: "github" });
    s.reviewers = ["me"]; // a fresh request re-opens it, even after an approval
    await pass();
    expect((await requests()).at(-1)).toMatchObject({ decision: "pending", head: sha("c") });
  });

  it("resolves at source when the PR goes back to draft, and when it closes", async () => {
    s.draft = true;
    await pass();
    expect((await requests()).filter((r) => r.decision === "pending")).toHaveLength(0);
    expect(await receipt((await requests()).at(-1)!.id)).toEqual({ what: RECEIPTS.draft, where: "github" });
    s.draft = false;
    await pass();
    expect((await requests()).filter((r) => r.decision === "pending")).toHaveLength(1);
    s.open = false;
    s.merged = true;
    await pass();
    expect((await requests()).filter((r) => r.decision === "pending")).toHaveLength(0);
    expect(await receipt((await requests()).at(-1)!.id)).toEqual({ what: RECEIPTS.merged, where: "github" });
    expect((await pool.query(`SELECT status, meta->>'merged' AS merged FROM work WHERE external_ref = $1`, [REF])).rows[0]).toEqual({ status: "closed", merged: "true" });
  });
});
