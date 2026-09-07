// The service against the real (scratch) database with the in-memory
// vault: the full loop — publish → versions → comments → dispatch → a
// claimable `work` row — plus every refusal shape on real rows: CAS
// conflict, idempotent retry, the autonomy boundary demoting to a
// proposal, the ping-pong cap, addressed inference, and agent scoping.
// Skipped without a db. Scratch db: ops/scripts/test-db.sh.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { ArtifactsService, memoryVault, staticDirectory, type MemoryVault, type Principal, type Thread } from "../src/index.js";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;
const P = "itest-art"; // project scope keeps this suite's rows apart
const P2 = "itest-art-other";
const IDS = ["itest-art-user", "itest-art-alice", "itest-art-bob", "itest-art-carol"];

const user: Principal = { kind: "user", id: "user" };
const alice: Principal = { kind: "agent", id: "itest-art-alice", projects: [P] };
const bob: Principal = { kind: "agent", id: "itest-art-bob", projects: [P] };
const carol: Principal = { kind: "agent", id: "itest-art-carol", projects: [P2] }; // not a member of P

describe.skipIf(!hasDb)("artifacts (real db, memory vault)", () => {
  let pool: pg.Pool;
  let vault: MemoryVault;
  let svc: ArtifactsService;
  let tasks: TasksService;
  let artifactId: string;
  let v1: string;
  let v2: string;

  const files = (body: string) => [{ path: "plan.md", content: body }, { path: "notes/why.txt", content: "because\n" }];

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      password: process.env.METISTRY_DB_PASSWORD,
    });
    await pool.query(`DELETE FROM artifact_comments WHERE artifact_id IN (SELECT id FROM artifacts WHERE project IN ($1, $2))`, [P, P2]);
    await pool.query(`DELETE FROM artifact_versions WHERE artifact_id IN (SELECT id FROM artifacts WHERE project IN ($1, $2))`, [P, P2]);
    await pool.query(`DELETE FROM artifacts WHERE project IN ($1, $2)`, [P, P2]);
    await pool.query(`DELETE FROM work WHERE project IN ($1, $2)`, [P, P2]);
    await pool.query(`DELETE FROM proposals WHERE source_agent = ANY($1::text[])`, [IDS]);
    await pool.query(`DELETE FROM runs WHERE kind = 'artifact_op' AND component = ANY($1::text[])`, [["user", ...IDS]]);
    vault = memoryVault();
    tasks = new TasksService(pool);
    svc = new ArtifactsService(pool, vault, {
      origin: "https://itest.example",
      tasks,
      // the target side of a dispatch: alice+bob in P, carol in P2 only (the console's agents table plays this role in production)
      agents: staticDirectory([
        { id: alice.id, kind: "external", projects: [P], revoked: false },
        { id: bob.id, kind: "external", projects: [P], revoked: false },
        { id: carol.id, kind: "external", projects: [P2], revoked: false },
      ]),
      pingPongCap: 3, // small enough to hit in a test; the default is 10
    });
  });
  afterAll(async () => pool.end());

  it("check() passes on the migrated schema", async () => {
    expect((await svc.check()).status).toBe("ok");
  });

  it("publish creates the artifact + version, attributed to the principal, with an action record", async () => {
    const r = await svc.publish({ project: P, slug: "plan", files: files("# Plan v1\n"), idempotency_key: "pub-1", message: "first draft" }, alice);
    artifactId = r.artifact.id;
    v1 = r.version.id;
    expect(r.artifact).toMatchObject({ project: P, slug: "plan", kind: "bundle", current_version: v1, created_by: alice.id });
    expect(r.version).toMatchObject({ artifact_id: artifactId, commit: null, path_prefix: `Artifacts/${P}/plan`, author_principal: alice.id, author_kind: "agent", idempotency_key: "pub-1" });
    expect(Object.keys(r.version.manifest).sort()).toEqual(["notes/why.txt", "plan.md"]);
    const runs = await pool.query(`SELECT ok, meta FROM runs WHERE kind = 'artifact_op' AND component = $1 AND meta->>'op' = 'publish'`, [alice.id]);
    expect(runs.rows).toEqual([{ ok: true, meta: expect.objectContaining({ module: "artifacts", version: v1, deduplicated: false }) }]);
  });

  it("idempotent retry returns the same version; a fresh key with the right expected version makes v2 in a new intent group", async () => {
    const again = await svc.publish({ project: P, slug: "plan", files: files("# Plan v1\n"), idempotency_key: "pub-1", message: "first draft" }, alice);
    expect(again).toMatchObject({ deduplicated: true, version: { id: v1 } });

    const r2 = await svc.publish({ project: P, slug: "plan", files: [{ path: "plan.md", content: "# Plan v2\n" }], expected_current_version: v1, idempotency_key: "pub-2", message: "second draft" }, alice);
    v2 = r2.version.id;
    expect(r2.artifact.current_version).toBe(v2);
    expect(r2.artifact.kind).toBe("markdown"); // one file now
    expect(vault.files.has(`Artifacts/${P}/plan/notes/why.txt`)).toBe(false); // dropped in the same intent group
    const log = await vault.log(`Artifacts/${P}/plan`);
    expect(log.map((e) => e.subject)).toEqual([`second draft (${v2})`, `first draft (${v1})`]); // one commit per version, flushed at publish
  });

  it("CAS: a stale expected version is a conflict and changes nothing", async () => {
    await expect(svc.publish({ project: P, slug: "plan", files: [{ path: "plan.md", content: "stale" }], expected_current_version: v1, idempotency_key: "pub-3", message: "stale" }, alice)).rejects.toMatchObject({ code: "conflict" });
    expect((await svc.get(artifactId, alice))?.artifact.current_version).toBe(v2);
    expect((await vault.read(`Artifacts/${P}/plan/plan.md`))?.content.toString()).toBe("# Plan v2\n");
  });

  it("versions/get resolve the commit lazily from the vault log; diff works once both are committed; superseded content is not_available", async () => {
    const versions = await svc.versions(artifactId, user);
    expect(versions?.map((v) => v.id)).toEqual([v2, v1]);
    expect(versions?.every((v) => typeof v.commit === "string" && v.commit.length > 0)).toBe(true);
    const stored = await pool.query(`SELECT commit FROM artifact_versions WHERE id = $1`, [v1]);
    expect(stored.rows[0]?.commit).toBe(versions?.[1]?.commit);
    const d = await svc.diff(artifactId, v1, v2, user);
    expect(d?.diff).toContain("-# Plan v1");
    expect(d?.diff).toContain("+# Plan v2");
    const cur = await svc.readFile(artifactId, v2, "plan.md", user);
    expect(cur?.content.toString()).toBe("# Plan v2\n");
    expect(cur?.kind).toBe("markdown");
    await expect(svc.readFile(artifactId, v1, "plan.md", user)).rejects.toMatchObject({ code: "not_available" });
    expect(await svc.readFile(artifactId, v1, "nope.md", user)).toBeNull();
  });

  it("scope: an agent outside the project sees nothing — not_found reads, empty lists, forbidden publish", async () => {
    expect(await svc.get(artifactId, carol)).toBeNull();
    expect(await svc.versions(artifactId, carol)).toBeNull();
    expect(await svc.list({ project: P }, carol)).toEqual([]);
    expect((await svc.list({}, carol)).map((a) => a.id)).not.toContain(artifactId);
    expect((await svc.list({}, alice)).map((a) => a.id)).toContain(artifactId);
    expect((await svc.list({ project: P }, user)).map((a) => a.id)).toContain(artifactId);
    expect(await svc.commentCreate({ artifact: artifactId, version: v2, body: "hi" }, carol)).toBeNull();
    await expect(svc.publish({ project: P, slug: "other", files: files("x"), idempotency_key: "c-1", message: "m" }, carol)).rejects.toMatchObject({ code: "forbidden" });
  });

  let t1: string;
  let t2: string;
  it("comments: threads on an exact version, one level of replies, resolve/reopen, path must exist in the version", async () => {
    const root = await svc.commentCreate({ artifact: artifactId, version: v2, path: "plan.md", anchor: { line: 1 }, body: "tighten the intro" }, user);
    expect(root).toMatchObject({ version_id: v2, path: "plan.md", anchor: { line: 1 }, state: "open", author_principal: "user", author_kind: "human", parent_id: null });
    t1 = root!.id;
    const second = await svc.commentCreate({ artifact: artifactId, version: v2, body: "overall: good" }, bob);
    t2 = second!.id;
    expect(second).toMatchObject({ author_kind: "agent", path: null });
    await expect(svc.commentCreate({ artifact: artifactId, version: v2, path: "missing.md", body: "x" }, user)).rejects.toMatchObject({ code: "invalid_request" });

    const reply = await svc.commentReply({ parent: t1, body: "done in the next version" }, alice);
    expect(reply).toMatchObject({ demoted: false, comment: { parent_id: t1, author_principal: alice.id, author_kind: "agent" } });
    if (reply?.demoted === false) await expect(svc.commentReply({ parent: reply.comment.id, body: "nested?" }, user)).rejects.toMatchObject({ code: "invalid_request" });

    const threads = (await svc.commentList(artifactId, v2, user)) as Thread[];
    expect(threads.map((t) => t.id)).toEqual([t1, t2]);
    expect(threads[0]!.replies).toHaveLength(1);

    expect(await svc.commentResolve(t1, alice)).toMatchObject({ state: "resolved", resolved_by: alice.id });
    expect(await svc.commentReopen(t1, user)).toMatchObject({ state: "open", resolved_by: null, resolved_at: null });
    expect(await svc.commentResolve(t1, carol)).toBeNull(); // outside the project: does not exist for carol
  });

  it("ping-pong cap: consecutive agent-only replies stop at the cap; the next agent reply demotes the thread to ONE review proposal; a human reply resets", async () => {
    const root = await svc.commentCreate({ artifact: artifactId, version: v2, body: "debate me" }, alice); // agent root counts as 1
    const id = root!.id;
    expect((await svc.commentReply({ parent: id, body: "no" }, bob))?.demoted).toBe(false); // 2
    expect((await svc.commentReply({ parent: id, body: "yes" }, alice))?.demoted).toBe(false); // 3 = cap
    const d = await svc.commentReply({ parent: id, body: "no!" }, bob);
    expect(d).toMatchObject({ demoted: true, cap: 3 });
    const d2 = await svc.commentReply({ parent: id, body: "still no" }, bob);
    expect(d2).toMatchObject({ demoted: true, proposal_id: (d as { proposal_id: number }).proposal_id }); // once, while pending
    const props = await pool.query(`SELECT kind, source_agent, trust, payload FROM proposals WHERE payload->>'thread_id' = $1`, [id]);
    expect(props.rows).toHaveLength(1);
    expect(props.rows[0]).toMatchObject({ kind: "review", source_agent: bob.id, trust: "external", payload: expect.objectContaining({ reason: "ping_pong_cap", thread_id: id }) });
    expect((props.rows[0]!.payload as { transcript: unknown[] }).transcript).toHaveLength(3); // the refused replies were not stored
    expect((await svc.commentReply({ parent: id, body: "settle down" }, user))?.demoted).toBe(false); // human resets the run
    expect((await svc.commentReply({ parent: id, body: "ok" }, bob))?.demoted).toBe(false);
  });

  it("dispatch inside the project → ONE work row of kind review, claimable through the tasks module; addressed is inferred from thread states", async () => {
    const before = await pool.query(`SELECT count(*)::int AS n FROM work WHERE project = $1`, [P]);
    const r = await svc.dispatchReview({ artifact: artifactId, version: v2, thread_ids: [t1, t2], to_agent: bob.id, message: "please address both" }, alice);
    expect(r?.route).toBe("work");
    if (r?.route !== "work") return;
    expect(r.work).toMatchObject({ kind: "review", project: P, status: "open", owner: bob.id, created_by: alice.id });
    expect(r.work.meta).toEqual({ bundle: { module: "artifacts", artifact: artifactId, version: v2, thread_ids: [t1, t2], from: alice.id, to_agent: bob.id, message: "please address both", links: r.links } });
    const after = await pool.query(`SELECT count(*)::int AS n FROM work WHERE project = $1`, [P]);
    expect(after.rows[0]!.n - before.rows[0]!.n).toBe(1);

    expect((await tasks.listReady({ project: P })).map((t) => t.id)).toContain(r.work.id);
    const claim = await tasks.claim(r.work.id, bob.id);
    expect(claim.ok).toBe(true);

    expect(await svc.bundleStatus(r.work.id, bob)).toMatchObject({ work_id: r.work.id, to_agent: bob.id, from: alice.id, addressed: false, status: "in_progress", threads: [{ id: t1, state: "open" }, { id: t2, state: "open" }] });
    await svc.commentResolve(t1, bob);
    await svc.commentResolve(t2, bob);
    expect((await svc.bundleStatus(r.work.id, bob))?.addressed).toBe(true);
    expect(await svc.bundleStatus(r.work.id, carol)).toBeNull();

    // a thread from another version is rejected at write
    await expect(svc.dispatchReview({ artifact: artifactId, version: v1, thread_ids: [t1], to_agent: bob.id }, alice)).rejects.toMatchObject({ code: "invalid_request" });
    // the user's hand always dispatches, even to a non-member
    const byUser = await svc.dispatchReview({ artifact: artifactId, version: v2, thread_ids: [t1], to_agent: carol.id }, user);
    expect(byUser?.route).toBe("work");
  });

  it("dispatch across the boundary (target not a member) → a review proposal for the user, no work row", async () => {
    const before = await pool.query(`SELECT count(*)::int AS n FROM work WHERE project = $1`, [P]);
    const r = await svc.dispatchReview({ artifact: artifactId, version: v2, thread_ids: [t1], to_agent: carol.id }, alice);
    expect(r).toMatchObject({ route: "proposal", reason: "outside_project" });
    const after = await pool.query(`SELECT count(*)::int AS n FROM work WHERE project = $1`, [P]);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    const prop = await pool.query(`SELECT kind, source_agent, trust, decision, payload FROM proposals WHERE id = $1`, [(r as { proposal_id: number }).proposal_id]);
    expect(prop.rows[0]).toMatchObject({ kind: "review", source_agent: alice.id, trust: "external", decision: "pending", payload: expect.objectContaining({ reason: "outside_project", to_agent: carol.id, artifact: artifactId }) });
    // an unknown target is outside every project
    expect((await svc.dispatchReview({ artifact: artifactId, version: v2, thread_ids: [t1], to_agent: "nobody" }, alice))?.route).toBe("proposal");
    // a caller outside the project cannot even see the artifact
    expect(await svc.dispatchReview({ artifact: artifactId, version: v2, thread_ids: [t1], to_agent: bob.id }, carol)).toBeNull();
  });
});
