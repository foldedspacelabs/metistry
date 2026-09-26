// The tasks service against the real (scratch) database. The fake-db tests
// prove control flow; only Postgres can prove the race — five agents
// claiming one row in the same instant must produce exactly one winner —
// and the partial-index ON CONFLICT, the dependency subquery, and lease
// arithmetic. Skipped without a db. Scratch db: ops/scripts/test-db.sh
// (honours METISTRY_TEST_DB_NAME so concurrent runs stay apart).
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { TasksService, check, ensureSchema } from "../src/index.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const P = "itest-tasks"; // project scope keeps this suite's rows apart from everything else in the scratch db
const P2 = "itest-tasks-moved"; // the board arm can re-file a card, so it needs a second slug to move it to

describe.skipIf(!hasDb)("tasks (real db)", () => {
  let pool: pg.Pool;
  let svc: TasksService;
  beforeAll(async () => {
    pool = await testDb(pg.Pool, { max: 10 }); // the race test needs ≥5 simultaneous connections
    await pool.query(`DELETE FROM work WHERE project = $1`, [P]);
    await pool.query(`DELETE FROM runs WHERE kind = 'task_op' AND component LIKE 'itest-%'`);
    await pool.query(`DELETE FROM work WHERE project = $1`, [P2]);
    await pool.query(`DELETE FROM projects WHERE id = ANY($1::text[])`, [[P, P2]]);
    svc = new TasksService(pool);
  });

  it("the first create with a project slug makes its `projects` row (ensureProject, 0011) — idempotently, with the defaults", async () => {
    expect((await pool.query(`SELECT 1 FROM projects WHERE id = $1`, [P])).rows).toHaveLength(0);
    await svc.create({ title: "first in project", project: P }, "itest-alice");
    await svc.create({ title: "second in project", project: P }, "itest-alice");
    const { rows } = await pool.query(`SELECT id, mode, daily_budget_usd, max_open_bundles FROM projects WHERE id = $1`, [P]);
    expect(rows).toEqual([{ id: P, mode: "autonomous", daily_budget_usd: null, max_open_bundles: 20 }]);
    // free-text projects predate the table and get no row (the CHECK would refuse them); the task still lands
    const legacy = await svc.create({ title: "legacy", project: "Not A Slug" }, "itest-alice");
    expect(legacy.project).toBe("Not A Slug");
    expect((await pool.query(`SELECT 1 FROM projects WHERE id = 'Not A Slug'`)).rows).toHaveLength(0);
    await pool.query(`DELETE FROM work WHERE id = $1`, [legacy.id]);
  });

  it("a row born blocked (a queued review bundle, §4.21) is visible but never ready or claimable until reopened", async () => {
    const q = await svc.create({ title: "queued bundle", project: P, kind: "review", status: "blocked", note: "over_cap: agent_cap 3/3" }, "itest-alice");
    expect(q).toMatchObject({ status: "blocked", claimed_by: null });
    expect(q.history).toEqual([expect.objectContaining({ op: "create", status: "blocked", note: "over_cap: agent_cap 3/3", agent: "itest-alice" })]);
    expect((await svc.listReady({ project: P })).map((t) => t.id)).not.toContain(q.id);
    expect(await svc.claim(q.id, "itest-bob")).toMatchObject({ ok: false, reason: "blocked" });
    await expect(svc.create({ title: "x", project: P, status: "closed" as never }, "itest-alice")).rejects.toMatchObject({ code: "invalid_input" });
  });
  afterAll(async () => pool.end());

  it("check() passes on the migrated schema; ensureSchema is a no-op there", async () => {
    expect((await check(pool)).status).toBe("ok");
    await ensureSchema(pool); // idempotent against 0001..0008
    await ensureSchema(pool);
    expect((await svc.check()).status).toBe("ok");
  });

  it("dependency gating: B is ready only after A closes", async () => {
    const a = await svc.create({ title: "A", project: P }, "itest-alice");
    const b = await svc.create({ title: "B", project: P, depends_on: [a.id] }, "itest-alice");
    expect(b.depends_on).toEqual([a.id]);
    expect(b.created_by).toBe("itest-alice");

    const ready = (await svc.listReady({ project: P })).map((t) => t.id);
    expect(ready).toContain(a.id);
    expect(ready).not.toContain(b.id);
    expect(await svc.claim(b.id, "itest-bob")).toMatchObject({ ok: false, reason: "dependencies_open" });

    expect((await svc.claim(a.id, "itest-bob")).ok).toBe(true);
    expect((await svc.listReady({ project: P })).map((t) => t.id)).not.toContain(a.id); // claimed: no longer ready
    const closed = await svc.update(a.id, "itest-bob", { status: "closed", note: "shipped" });
    expect(closed.ok && closed.task.status).toBe("closed");
    expect(closed.ok && closed.task.closed_at).toBeInstanceOf(Date);
    expect(closed.ok && closed.task.claimed_by).toBeNull(); // closed releases the claim
    expect(closed.ok && closed.task.history.map((h) => h.op)).toEqual(["create", "claim", "update"]);

    expect((await svc.listReady({ project: P })).map((t) => t.id)).toContain(b.id);
    expect((await svc.claim(b.id, "itest-bob")).ok).toBe(true);
  });

  it("the claim race: five concurrent agents, exactly one winner", async () => {
    const t = await svc.create({ title: "contested", project: P }, "itest-alice");
    const agents = ["itest-r1", "itest-r2", "itest-r3", "itest-r4", "itest-r5"];
    const results = await Promise.all(agents.map((a) => svc.claim(t.id, a)));
    const winners = results.filter((r) => r.ok);
    expect(winners.length).toBe(1);
    expect(results.filter((r) => !r.ok).every((r) => r.reason === "claimed")).toBe(true);
    const row = await svc.get(t.id);
    expect(row?.status).toBe("in_progress");
    expect(agents).toContain(row?.claimed_by);
    expect(row?.history.filter((h) => h.op === "claim").length).toBe(1); // losers wrote nothing

    // Every attempt left an action record, win or lose.
    const { rows } = await pool.query(
      `SELECT component, ok FROM runs WHERE kind = 'task_op' AND meta->>'op' = 'claim' AND (meta->>'id')::bigint = $1 ORDER BY component`,
      [t.id],
    );
    expect(rows.map((r) => r.component)).toEqual(agents);
    expect(rows.every((r) => r.ok === true)).toBe(true); // a lost race is a clean outcome, not an error
  });

  it("an expired lease releases the task; heartbeat by the old holder is not renewed", async () => {
    const t = await svc.create({ title: "leased", project: P }, "itest-alice");
    expect((await svc.claim(t.id, "itest-slow", 1)).ok).toBe(true);
    expect(await svc.claim(t.id, "itest-fast")).toMatchObject({ ok: false, reason: "claimed" });
    expect((await svc.heartbeat(t.id, "itest-slow", 1)).ok).toBe(true); // live lease renews
    await sleep(1_200);
    expect(await svc.heartbeat(t.id, "itest-slow")).toMatchObject({ ok: false, reason: "lease_expired" });
    expect((await svc.listReady({ project: P })).map((x) => x.id)).not.toContain(t.id); // in_progress rows are claimable, not "ready"
    const taken = await svc.claim(t.id, "itest-fast");
    expect(taken.ok && taken.task.claimed_by).toBe("itest-fast");
    expect(await svc.update(t.id, "itest-slow", { note: "too late" })).toMatchObject({ ok: false, reason: "not_holder" });
  });

  it("collected rows (issue/pr) are never listed or claimable — the source of truth owns them", async () => {
    const { rows } = await pool.query(
      `INSERT INTO work (title, project, kind, status, external_ref) VALUES ('an issue', $1, 'issue', 'open', 'gh:itest/repo#901') RETURNING id`,
      [P],
    );
    const id = Number(rows[0].id);
    expect((await svc.listReady({ project: P })).map((t) => t.id)).not.toContain(id);
    expect(await svc.claim(id, "itest-alice")).toMatchObject({ ok: false, reason: "not_claimable" });
    expect((await svc.get(id))?.claimed_by).toBeNull();
    await pool.query(`DELETE FROM work WHERE id = $1`, [id]);
  });

  it("heartbeat, update, and release by a non-holder are rejected", async () => {
    const t = await svc.create({ title: "mine", project: P }, "itest-alice");
    expect((await svc.claim(t.id, "itest-holder")).ok).toBe(true);
    expect(await svc.heartbeat(t.id, "itest-intruder")).toMatchObject({ ok: false, reason: "not_holder" });
    expect(await svc.update(t.id, "itest-intruder", { status: "closed" })).toMatchObject({ ok: false, reason: "not_holder" });
    expect(await svc.release(t.id, "itest-intruder")).toMatchObject({ ok: false, reason: "not_holder" });
    expect((await svc.get(t.id))?.claimed_by).toBe("itest-holder");

    const blocked = await svc.update(t.id, "itest-holder", { status: "blocked", note: "waiting on creds" });
    expect(blocked.ok && blocked.task.claimed_by).toBe("itest-holder"); // blocked keeps the claim
    expect((await svc.listForAgent("itest-holder")).map((x) => x.id)).toContain(t.id);
    const released = await svc.release(t.id, "itest-holder", "handing back");
    expect(released.ok && released.task).toMatchObject({ status: "open", claimed_by: null, lease_expires_at: null });
    expect((await svc.listForAgent("itest-holder")).map((x) => x.id)).not.toContain(t.id);
  });

  it("create is idempotent on the key and refuses a dangling dependency", async () => {
    const key = `itest-${Date.now()}`;
    const first = await svc.create({ title: "once", project: P, idempotency_key: key, due: "2026-12-31" }, "itest-alice");
    const again = await svc.create({ title: "once (retried)", project: P, idempotency_key: key }, "itest-alice");
    expect(again.id).toBe(first.id);
    expect(again.title).toBe("once"); // the earlier create wins, untouched
    expect(again.due).toBe("2026-12-31");
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM work WHERE idempotency_key = $1`, [key]);
    expect(rows[0]?.n).toBe(1);
    await expect(svc.create({ title: "orphan", project: P, depends_on: [2_000_000_000] }, "itest-alice")).rejects.toMatchObject({ code: "unknown_dependency" });
  });

  // --- the three gaps the board named (docs/ops/board.md "Drags") ---

  it("unblock: a blocked row reaches `open` again, and only from blocked", async () => {
    const t = await svc.create({ title: "queued bundle", project: P, kind: "review", status: "blocked", note: "over_cap" }, "itest-alice");
    expect(await svc.claim(t.id, "itest-bob")).toMatchObject({ ok: false, reason: "blocked" });
    const un = await svc.update(t.id, "user", { status: "open", note: "cap raised" });
    expect(un.ok && un.task).toMatchObject({ status: "open", claimed_by: null, lease_expires_at: null });
    expect((await svc.listReady({ project: P })).map((x) => x.id)).toContain(t.id);
    // the same call on a row that is not blocked is refused, named
    expect(await svc.update(t.id, "user", { status: "open" })).toMatchObject({ ok: false, reason: "not_blocked" });
    // and a blocked row a crew still holds unblocks without the crew's hand — that is the point
    expect((await svc.claim(t.id, "itest-holder")).ok).toBe(true);
    expect((await svc.update(t.id, "itest-holder", { status: "blocked" })).ok).toBe(true);
    const un2 = await svc.update(t.id, "user", { status: "open" });
    expect(un2.ok && un2.task).toMatchObject({ status: "open", claimed_by: null });
  });

  it("assign: owner is set and cleared after create, on a row nobody holds", async () => {
    const t = await svc.create({ title: "unassigned", project: P }, "itest-alice");
    expect(t.owner).toBeNull();
    const assigned = await svc.update(t.id, "user", { owner: "helper-a" });
    expect(assigned.ok && assigned.task.owner).toBe("helper-a");
    expect(assigned.ok && assigned.task.status).toBe("open"); // still Assigned, not started — claim() is what starts it
    expect(assigned.ok && assigned.task.history.at(-1)).toMatchObject({ agent: "user", op: "update", owner: "helper-a" });
    const cleared = await svc.update(t.id, "user", { owner: null });
    expect(cleared.ok && cleared.task.owner).toBeNull();
    // owner is informational: a DIFFERENT agent can still claim an addressed row
    expect((await svc.update(t.id, "user", { owner: "helper-a" })).ok).toBe(true);
    expect((await svc.claim(t.id, "itest-bob")).ok).toBe(true);
    // and a closed row refuses the board arm outright
    expect((await svc.update(t.id, "itest-bob", { status: "closed" })).ok).toBe(true);
    expect(await svc.update(t.id, "user", { owner: "helper-b" })).toMatchObject({ ok: false, reason: "closed" });
  });

  it("the board arm refuses a collected row — github-state owns what an issue says", async () => {
    const { rows } = await pool.query(
      `INSERT INTO work (title, project, kind, status, external_ref) VALUES ('an issue', $1, 'issue', 'open', $2) RETURNING id`,
      [P, `gh:itest/repo#${Date.now() % 100000}`],
    );
    const id = Number(rows[0].id);
    expect(await svc.update(id, "user", { owner: "helper-a" })).toMatchObject({ ok: false, reason: "not_claimable" });
    expect(await svc.update(id, "user", { title: "renamed" })).toMatchObject({ ok: false, reason: "not_claimable" });
    expect((await svc.get(id))?.title).toBe("an issue");
    await pool.query(`DELETE FROM work WHERE id = $1`, [id]);
  });

  it("title and project move with the card, and a new project slug gets its projects row", async () => {
    const t = await svc.create({ title: "misfiled", project: P }, "itest-alice");
    const moved = await svc.update(t.id, "user", { title: "filed right", project: P2 });
    expect(moved.ok && moved.task).toMatchObject({ title: "filed right", project: P2 });
    expect((await pool.query(`SELECT 1 FROM projects WHERE id = $1`, [P2])).rows).toHaveLength(1);
  });

  it("renew with a note lands on history; renew without one leaves history alone", async () => {
    const t = await svc.create({ title: "long job", project: P }, "itest-alice");
    expect((await svc.claim(t.id, "itest-holder")).ok).toBe(true);
    const before = (await svc.get(t.id))!.history.length;
    expect((await svc.heartbeat(t.id, "itest-holder")).ok).toBe(true);
    expect((await svc.get(t.id))!.history).toHaveLength(before);
    const noted = await svc.heartbeat(t.id, "itest-holder", 900, "still reading the diff");
    expect(noted.ok && noted.task.history.at(-1)).toMatchObject({ agent: "itest-holder", op: "heartbeat", note: "still reading the diff" });
    expect(noted.ok && noted.task.history).toHaveLength(before + 1);
  });
});
