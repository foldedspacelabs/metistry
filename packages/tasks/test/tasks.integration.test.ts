// The tasks service against the real (scratch) database. The fake-db tests
// prove control flow; only Postgres can prove the race — five agents
// claiming one row in the same instant must produce exactly one winner —
// and the partial-index ON CONFLICT, the dependency subquery, and lease
// arithmetic. Skipped without a db. Scratch db: ops/scripts/test-db.sh
// (honours METISTRY_TEST_DB_NAME so concurrent runs stay apart).
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { TasksService, check, ensureSchema } from "../src/index.js";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;
const P = "itest-tasks"; // project scope keeps this suite's rows apart from everything else in the scratch db

describe.skipIf(!hasDb)("tasks (real db)", () => {
  let pool: pg.Pool;
  let svc: TasksService;
  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      password: process.env.METISTRY_DB_PASSWORD,
      max: 10, // the race test needs ≥5 simultaneous connections
    });
    await pool.query(`DELETE FROM work WHERE project = $1`, [P]);
    await pool.query(`DELETE FROM runs WHERE kind = 'task_op' AND component LIKE 'itest-%'`);
    svc = new TasksService(pool);
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
});
