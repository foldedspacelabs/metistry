// The service against the real (scratch) database with the in-memory
// vault: the full loop — publish → versions → comments → dispatch → a
// claimable `work` row — plus every refusal shape on real rows: CAS
// conflict, idempotent retry, the autonomy boundary demoting to a
// proposal, the ping-pong cap, addressed inference, and agent scoping.
// Skipped without a db. Scratch db: ops/scripts/test-db.sh.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { ArtifactsService, memoryVault, staticDirectory, type MemoryVault, type Principal, type Thread } from "../src/index.js";
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const P = "itest-art"; // project scope keeps this suite's rows apart
const P2 = "itest-art-other";
const P3 = "itest-art-caps"; // the §4.21 controls get their own project so the counts are exact
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
    await pool.query(`DELETE FROM artifact_comments WHERE artifact_id IN (SELECT id FROM artifacts WHERE project IN ($1, $2, $3))`, [P, P2, P3]);
    await pool.query(`DELETE FROM artifact_versions WHERE artifact_id IN (SELECT id FROM artifacts WHERE project IN ($1, $2, $3))`, [P, P2, P3]);
    await pool.query(`DELETE FROM artifacts WHERE project IN ($1, $2, $3)`, [P, P2, P3]);
    await pool.query(`DELETE FROM artifact_comments WHERE work_id IN (SELECT id FROM work WHERE project IN ($1, $2, $3) OR title = 'no project')`, [P, P2, P3]);
    await pool.query(`DELETE FROM proposals WHERE work_id IN (SELECT id FROM work WHERE project IN ($1, $2, $3) OR title = 'no project')`, [P, P2, P3]);
    await pool.query(`DELETE FROM work WHERE project IN ($1, $2, $3) OR title = 'no project'`, [P, P2, P3]);
    await pool.query(`DELETE FROM proposals WHERE source_agent = ANY($1::text[])`, [IDS]);
    await pool.query(`DELETE FROM runs WHERE kind = 'artifact_op' AND component = ANY($1::text[])`, [["user", ...IDS]]);
    await pool.query(`DELETE FROM runs WHERE kind = 'project_mode' AND meta->>'project' = $1`, [P3]);
    await pool.query(`DELETE FROM runs WHERE meta->>'project' = $1 AND component = 'itest-art-spend'`, [P3]);
    await pool.query(`DELETE FROM outbound_messages WHERE kind = 'alert' AND text LIKE $1`, [`project ${P3} flipped%`]);
    await pool.query(`DELETE FROM projects WHERE id IN ($1, $2, $3)`, [P, P2, P3]);
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

  // --- rooms on work rows (0016) --------------------------------------------------

  describe("work threads: the task is the room", () => {
    let roomWork: number;
    let otherWork: number; // in P2 — carol's project, not alice's
    let looseWork: number; // no project at all: the user's alone

    beforeAll(async () => {
      roomWork = (await tasks.create({ title: "scope the migration", project: P, kind: "task" }, "user")).id;
      otherWork = (await tasks.create({ title: "someone else's", project: P2, kind: "task" }, "user")).id;
      const { rows } = await pool.query(`INSERT INTO work (title, kind, status) VALUES ('no project', 'task', 'open') RETURNING id`);
      looseWork = Number(rows[0]!.id);
    });

    it("the schema allows exactly one parent: an artifact anchor OR a work anchor, never both, never neither", async () => {
      const both = pool.query(
        `INSERT INTO artifact_comments (id, artifact_id, version_id, work_id, body, author_principal, author_kind) VALUES ($1, $2, $3, $4, 'x', 'user', 'human')`,
        [`cmt_${"0".repeat(26)}`, artifactId, v2, roomWork],
      );
      await expect(both).rejects.toMatchObject({ constraint: "artifact_comments_one_parent" });
      const neither = pool.query(
        `INSERT INTO artifact_comments (id, body, author_principal, author_kind) VALUES ($1, 'x', 'user', 'human')`,
        [`cmt_${"1".repeat(26)}`],
      );
      await expect(neither).rejects.toMatchObject({ constraint: "artifact_comments_one_parent" });
      // and an artifact thread still names an exact version
      const halfArtifact = pool.query(
        `INSERT INTO artifact_comments (id, artifact_id, body, author_principal, author_kind) VALUES ($1, $2, 'x', 'user', 'human')`,
        [`cmt_${"2".repeat(26)}`, artifactId],
      );
      await expect(halfArtifact).rejects.toMatchObject({ constraint: "artifact_comments_version_with_artifact" });
    });

    it("an empty room is a valid room; appending opens it, and everyone who has spoken is a participant", async () => {
      const empty = await svc.workThread(roomWork, alice);
      expect(empty).toMatchObject({ work_id: roomWork, project: P, state: "open", comments: [], participants: [], agent_tail: 0, cap: 3 });
      expect(empty!.link).toBe(`https://itest.example/#/rooms/work/${roomWork}`);

      const first = await svc.workComment({ work: roomWork, body: "does this include the migration?" }, alice);
      expect(first).toMatchObject({ demoted: false, comment: { work_id: roomWork, author_principal: alice.id, author_kind: "agent", parent_id: null } });
      const second = await svc.workComment({ work: roomWork, body: "it does — I will take the schema" }, bob);
      expect(second).toMatchObject({ demoted: false, comment: { parent_id: (first as { comment: { id: string } }).comment.id } }); // one room: replies hang off the root

      const t = await svc.workThread(roomWork, bob);
      expect(t!.comments.map((c) => c.body)).toEqual(["does this include the migration?", "it does — I will take the schema"]); // newest LAST
      expect(t!.participants).toEqual([
        { principal: alice.id, kind: "agent", comments: 1 },
        { principal: bob.id, kind: "agent", comments: 1 },
      ]);
      expect(t!.agent_tail).toBe(2);
      // one root per work row, enforced in the schema
      const roots = await pool.query(`SELECT count(*)::int AS n FROM artifact_comments WHERE work_id = $1 AND parent_id IS NULL`, [roomWork]);
      expect(roots.rows[0]!.n).toBe(1);
    });

    it("every append is a runs row on the principal (kind artifact_op, op work_comment)", async () => {
      const { rows } = await pool.query(
        `SELECT ok, meta FROM runs WHERE kind = 'artifact_op' AND meta->>'op' = 'work_comment' AND (meta->>'work_id')::int = $1 ORDER BY id`,
        [roomWork],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ ok: true, meta: expect.objectContaining({ module: "artifacts", project: P, principal_kind: "agent" }) });
    });

    it("scope is the same grant tasks_* gets: another project's row, and a row with NO project, do not exist for an agent", async () => {
      expect(await svc.workThread(otherWork, alice)).toBeNull();
      expect(await svc.workComment({ work: otherWork, body: "hello" }, alice)).toBeNull();
      expect(await svc.workThread(looseWork, alice)).toBeNull(); // a project is the unit of coordination
      expect(await svc.workThread(looseWork, user)).not.toBeNull(); // the user sees their own row
      expect(await svc.workThread(999_999_999, user)).toBeNull();
      expect(await svc.workThread(otherWork, carol)).not.toBeNull(); // carol IS a member of P2
    });

    it("the ping-pong cap applies to a room: the next agent message is not stored, the room demotes to ONE proposal that NAMES the work row, and a human message resets", async () => {
      expect((await svc.workComment({ work: roomWork, body: "third" }, alice))?.demoted).toBe(false); // 3 = cap
      const d = await svc.workComment({ work: roomWork, body: "fourth" }, bob);
      expect(d).toMatchObject({ demoted: true, cap: 3 });
      const again = await svc.workComment({ work: roomWork, body: "fifth" }, alice);
      expect(again).toMatchObject({ demoted: true, proposal_id: (d as { proposal_id: number }).proposal_id }); // once, while pending

      const props = await pool.query(`SELECT kind, source_agent, work_id, payload FROM proposals WHERE work_id = $1`, [roomWork]);
      expect(props.rows).toHaveLength(1);
      expect(props.rows[0]).toMatchObject({ kind: "review", source_agent: bob.id, work_id: String(roomWork) });
      expect(props.rows[0]!.payload).toMatchObject({ reason: "ping_pong_cap", cap: 3, work_id: roomWork, project: P });
      expect((props.rows[0]!.payload as { transcript: unknown[] }).transcript).toHaveLength(3); // the refused messages were not stored
      expect((await svc.workThread(roomWork, user))!.comments).toHaveLength(3);

      // the human turn is the release valve
      expect((await svc.workComment({ work: roomWork, body: "include it; ship the migration" }, user))?.demoted).toBe(false);
      expect((await svc.workThread(roomWork, user))!.agent_tail).toBe(0);
      expect((await svc.workComment({ work: roomWork, body: "on it" }, alice))?.demoted).toBe(false);
    });

    it("resolve is the USER's hand and nothing else — no agent, no system principal, and no artifact verb reaches a room", async () => {
      await expect(svc.workThreadResolve(roomWork, alice)).rejects.toMatchObject({ code: "forbidden" });
      await expect(svc.workThreadResolve(roomWork, { kind: "system", id: "sweeper" })).rejects.toMatchObject({ code: "forbidden" });
      expect((await svc.workThread(roomWork, user))!.state).toBe("open"); // nothing moved

      const rootId = (await svc.workThread(roomWork, user))!.comments[0]!.id;
      expect(await svc.commentResolve(rootId, user)).toBeNull(); // artifacts_resolve cannot address a room
      expect(await svc.commentReply({ parent: rootId, body: "sneaking in" }, alice)).toBeNull(); // nor artifacts_comment

      const resolved = await svc.workThreadResolve(roomWork, user);
      expect(resolved).toMatchObject({ state: "resolved", resolved_by: "user" });
      expect(resolved!.resolved_at).toBeInstanceOf(Date);
      expect((await svc.workThreadReopen(roomWork, user))).toMatchObject({ state: "open", resolved_by: null, resolved_at: null });
      const rec = await pool.query(`SELECT meta FROM runs WHERE kind = 'artifact_op' AND meta->>'op' IN ('work_resolve', 'work_reopen') AND (meta->>'work_id')::int = $1`, [roomWork]);
      expect(rec.rows).toHaveLength(2);
    });

    it("an agent can still say something after the user resolved it — a room is a record, not a gate", async () => {
      await svc.workThreadResolve(roomWork, user);
      expect((await svc.workComment({ work: roomWork, body: "one more thing" }, bob))?.demoted).toBe(false);
      expect((await svc.workThread(roomWork, user))!.state).toBe("resolved");
      await svc.workThreadReopen(roomWork, user);
    });
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

  // ----- §4.21 controls on real rows -----
  describe("§4.21 controls", () => {
    const alice3: Principal = { kind: "agent", id: alice.id, projects: [P, P3] };
    const bob3: Principal = { kind: "agent", id: bob.id, projects: [P, P3] };
    let svc3: ArtifactsService;
    let art3: string;
    let ver3: string;
    const threads: string[] = [];
    const bundles: number[] = [];

    beforeAll(async () => {
      svc3 = new ArtifactsService(pool, vault, {
        origin: "https://itest.example",
        tasks,
        agents: staticDirectory([
          { id: alice.id, kind: "external", projects: [P, P3], revoked: false },
          { id: bob.id, kind: "external", projects: [P, P3], revoked: false },
          { id: carol.id, kind: "external", projects: [P2], revoked: false },
        ]),
      });
    });

    it("publish creates the project row lazily (ensureProject), with the defaults: autonomous, no budget, cap 20", async () => {
      expect((await pool.query(`SELECT 1 FROM projects WHERE id = $1`, [P3])).rows).toHaveLength(0);
      const r = await svc3.publish({ project: P3, slug: "spec", files: [{ path: "spec.md", content: "# Spec\n" }], idempotency_key: "caps-1", message: "spec" }, alice3);
      art3 = r.artifact.id;
      ver3 = r.version.id;
      const row = await pool.query(`SELECT mode, daily_budget_usd, max_open_bundles FROM projects WHERE id = $1`, [P3]);
      expect(row.rows).toEqual([{ mode: "autonomous", daily_budget_usd: null, max_open_bundles: 20 }]);
      expect(await svc3.projectPolicy(P3)).toEqual({ id: P3, mode: "autonomous", daily_budget_usd: null, max_open_bundles: 20, exists: true });
      expect(await svc3.projectPolicy("itest-art-nope")).toMatchObject({ mode: "autonomous", max_open_bundles: 20, exists: false });
      for (let i = 0; i < 6; i++) threads.push((await svc3.commentCreate({ artifact: art3, version: ver3, body: `point ${i}` }, user))!.id);
    });

    it("per-agent cap (3): the fourth bundle from one agent is QUEUED — blocked, unclaimable, not ready — and addressing one releases it", async () => {
      for (let i = 0; i < 3; i++) {
        const r = await svc3.dispatchReview({ artifact: art3, version: ver3, thread_ids: [threads[i]!], to_agent: bob.id }, alice3);
        expect(r).toMatchObject({ route: "work", queued: null });
        if (r?.route === "work") bundles.push(r.work.id);
      }
      const fourth = await svc3.dispatchReview({ artifact: art3, version: ver3, thread_ids: [threads[3]!], to_agent: bob.id }, alice3);
      expect(fourth).toMatchObject({ route: "work", queued: { reason: "agent_cap", cap: 3, open: 3 } });
      if (fourth?.route !== "work") return;
      const q = fourth.work.id;
      expect(fourth.work).toMatchObject({ status: "blocked", claimed_by: null });
      expect(fourth.work.history[0]).toMatchObject({ op: "create", status: "blocked", note: "over_cap: agent_cap 3/3" });
      expect((await tasks.listReady({ project: P3 })).map((t) => t.id)).not.toContain(q);
      expect(await tasks.claim(q, bob.id)).toMatchObject({ ok: false, reason: "blocked" });
      expect(await svc3.bundleStatus(q, bob3)).toMatchObject({ status: "blocked", addressed: false });

      // bob addresses bundle #1 (resolves its only thread) → a slot frees → the queued bundle is released inline
      expect((await tasks.claim(bundles[0]!, bob.id)).ok).toBe(true);
      await svc3.commentResolve(threads[0]!, bob3);
      const released = await tasks.get(q);
      expect(released).toMatchObject({ status: "open", claimed_by: null });
      expect(released!.history.at(-1)).toMatchObject({ op: "update", status: "open", note: "released: under cap", agent: bob.id });
      expect((released!.meta as { bundle: Record<string, unknown> }).bundle.queued).toBeUndefined();
      expect((await tasks.listReady({ project: P3 })).map((t) => t.id)).toContain(q);
      const rec = await pool.query(`SELECT meta FROM runs WHERE kind = 'artifact_op' AND component = $1 AND meta->>'op' = 'release_queued'`, [bob.id]);
      expect(rec.rows).toEqual([{ meta: expect.objectContaining({ project: P3, work_id: q }) }]);
      bundles.push(q);
      // alice is back at her cap (bundles 2, 3, 4 open and unaddressed): one more queues again
      expect(await svc3.dispatchReview({ artifact: art3, version: ver3, thread_ids: [threads[4]!], to_agent: bob.id }, alice3)).toMatchObject({ route: "work", queued: { reason: "agent_cap" } });
    });

    it("per-project cap (projects.max_open_bundles): a different sender at the project's cap is queued with reason project_cap; the user's hand is never capped", async () => {
      await pool.query(`UPDATE projects SET max_open_bundles = 3 WHERE id = $1`, [P3]); // the user's hand (PUT /api/projects) — set directly here
      const r = await svc3.dispatchReview({ artifact: art3, version: ver3, thread_ids: [threads[5]!], to_agent: alice.id }, bob3);
      expect(r).toMatchObject({ route: "work", queued: { reason: "project_cap", cap: 3, open: 3 } });
      const byUser = await svc3.dispatchReview({ artifact: art3, version: ver3, thread_ids: [threads[5]!], to_agent: alice.id }, user);
      expect(byUser).toMatchObject({ route: "work", queued: null });
      const counts = await pool.query(`SELECT status, count(*)::int AS n FROM work WHERE project = $1 AND kind = 'review' GROUP BY status ORDER BY status`, [P3]);
      expect(counts.rows).toEqual([{ status: "blocked", n: 2 }, { status: "in_progress", n: 1 }, { status: "open", n: 4 }]);
    });

    it("the kill switch: mode review routes every agent-to-agent bundle to a proposal (reason review_mode) without touching membership; the user still dispatches", async () => {
      await pool.query(`UPDATE projects SET mode = 'review' WHERE id = $1`, [P3]);
      const r = await svc3.dispatchReview({ artifact: art3, version: ver3, thread_ids: [threads[1]!], to_agent: bob.id }, alice3);
      expect(r).toMatchObject({ route: "proposal", reason: "review_mode" });
      const prop = await pool.query(`SELECT payload FROM proposals WHERE id = $1`, [(r as { proposal_id: number }).proposal_id]);
      expect(prop.rows[0]!.payload).toMatchObject({ reason: "review_mode", project: P3, to_agent: bob.id });
      expect(await svc3.dispatchReview({ artifact: art3, version: ver3, thread_ids: [threads[1]!], to_agent: bob.id }, user)).toMatchObject({ route: "work" });
      await pool.query(`UPDATE projects SET mode = 'autonomous', max_open_bundles = 20 WHERE id = $1`, [P3]);
    });

    it("narrowing from the directory: may_dispatch_to on the sender, accept_from on the recipient", async () => {
      const narrowed = new ArtifactsService(pool, vault, {
        origin: "https://itest.example",
        tasks,
        agents: staticDirectory([
          { id: alice.id, kind: "external", projects: [P3], revoked: false, autonomy: { may_dispatch_to: [carol.id], max_open_bundles: 50 } },
          { id: bob.id, kind: "external", projects: [P3], revoked: false, autonomy: { accept_from: ["user"], max_open_bundles: 50 } },
        ]),
      });
      expect(await narrowed.dispatchReview({ artifact: art3, version: ver3, thread_ids: [threads[1]!], to_agent: bob.id }, alice3)).toMatchObject({ route: "proposal", reason: "may_dispatch_to" });
      expect(await narrowed.dispatchReview({ artifact: art3, version: ver3, thread_ids: [threads[1]!], to_agent: bob.id }, { ...alice3, id: alice.id })).toMatchObject({ route: "proposal", reason: "may_dispatch_to" });
      expect(await narrowed.dispatchReview({ artifact: art3, version: ver3, thread_ids: [threads[1]!], to_agent: alice.id }, bob3)).toMatchObject({ route: "work" }); // bob has no may_dispatch_to; alice has no accept_from
      const narrowedBob = new ArtifactsService(pool, vault, {
        origin: "https://itest.example",
        tasks,
        agents: staticDirectory([
          { id: alice.id, kind: "external", projects: [P3], revoked: false, autonomy: { max_open_bundles: 50 } },
          { id: bob.id, kind: "external", projects: [P3], revoked: false, autonomy: { accept_from: ["user"] } },
        ]),
      });
      expect(await narrowedBob.dispatchReview({ artifact: art3, version: ver3, thread_ids: [threads[1]!], to_agent: bob.id }, alice3)).toMatchObject({ route: "proposal", reason: "accept_from" });
    });

    it("budget: spend over projects.daily_budget_usd flips the project to review ONCE — runs kind project_mode, one alert, deduped on a same-day re-flip", async () => {
      await pool.query(`UPDATE projects SET daily_budget_usd = 0.50 WHERE id = $1`, [P3]);
      expect(await svc3.enforceBudget(P3)).toEqual({ project: P3, mode: "autonomous", spend_usd: 0, budget_usd: 0.5, flipped: false });
      // spend lands as runs rows stamped with the project (an agent's turn under a crew, a dispatch) — 0.30 + 0.30 today
      for (const cost of [0.3, 0.3]) {
        await pool.query(`INSERT INTO runs (component, kind, ok, cost_usd, meta) VALUES ('itest-art-spend', 'turn', true, $1, $2::jsonb)`, [cost, JSON.stringify({ project: P3 })]);
      }
      expect(await svc3.spendToday(P3)).toBeCloseTo(0.6, 6);
      const first = await svc3.enforceBudget(P3);
      expect(first).toMatchObject({ mode: "review", budget_usd: 0.5, flipped: true });
      expect(first.spend_usd).toBeCloseTo(0.6, 6);
      expect((await pool.query(`SELECT mode FROM projects WHERE id = $1`, [P3])).rows[0]!.mode).toBe("review");
      const flips = await pool.query(`SELECT component, ok, meta FROM runs WHERE kind = 'project_mode' AND meta->>'project' = $1 ORDER BY id`, [P3]);
      expect(flips.rows).toHaveLength(1);
      expect(flips.rows[0]).toMatchObject({ component: "projects", ok: true, meta: expect.objectContaining({ from: "autonomous", to: "review", reason: "budget", budget_usd: 0.5 }) });
      const alerts = () => pool.query(`SELECT text FROM outbound_messages WHERE kind = 'alert' AND text LIKE $1`, [`project ${P3} flipped%`]);
      expect((await alerts()).rows).toHaveLength(1);
      // a dispatch now routes to the user; the check does not flip or alert again
      expect(await svc3.dispatchReview({ artifact: art3, version: ver3, thread_ids: [threads[2]!], to_agent: bob.id }, alice3)).toMatchObject({ route: "proposal", reason: "review_mode" });
      expect(await svc3.enforceBudget(P3)).toMatchObject({ mode: "review", flipped: false });
      expect((await pool.query(`SELECT count(*)::int AS n FROM runs WHERE kind = 'project_mode' AND meta->>'project' = $1`, [P3])).rows[0]!.n).toBe(1);
      // the user switches back while still over budget: recorded again, alerted no more (24h dedupe)
      await pool.query(`UPDATE projects SET mode = 'autonomous' WHERE id = $1`, [P3]);
      expect(await svc3.enforceBudget(P3)).toMatchObject({ mode: "review", flipped: true });
      expect((await pool.query(`SELECT count(*)::int AS n FROM runs WHERE kind = 'project_mode' AND meta->>'project' = $1`, [P3])).rows[0]!.n).toBe(2);
      expect((await alerts()).rows).toHaveLength(1);
      await pool.query(`UPDATE projects SET mode = 'autonomous', daily_budget_usd = NULL WHERE id = $1`, [P3]);
    });
  });
});
