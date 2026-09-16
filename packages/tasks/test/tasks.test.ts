// Control-flow and misuse tests over a fake Db. They prove the shape of
// what the service sends — one atomic statement per mutation, identity as
// a bind value, a runs row around every change. Only Postgres can prove the
// SQL itself; that lives in tasks.integration.test.ts.
import { describe, expect, it } from "vitest";
import { TasksError, TasksService, check, type Db } from "../src/index.js";

interface Call {
  text: string;
  values: unknown[];
}

const ROW = {
  id: "7",
  title: "t",
  project: null,
  area: null,
  kind: "task",
  status: "open",
  external_ref: null,
  owner: null,
  due: null,
  claimed_by: null,
  lease_expires_at: null,
  depends_on: ["1", "2"],
  idempotency_key: null,
  history: [],
  created_by: "a",
  closed_at: null,
  created_at: new Date(0),
  updated_at: new Date(0),
  meta: {},
};

/** Answers INSERT INTO runs with an id; everything else from `script` in order. */
function fakeDb(script: Record<string, unknown>[][] = []) {
  const calls: Call[] = [];
  const queue = [...script];
  const db: Db = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (/^\s*INSERT INTO runs/.test(text)) return { rows: [{ id: 99 }] };
      if (/^\s*UPDATE runs/.test(text)) return { rows: [] };
      return { rows: queue.shift() ?? [] };
    },
  };
  return { db, calls, work: () => calls.filter((c) => !/\bruns\b/.test(c.text)) };
}

describe("TasksService", () => {
  it("claim is ONE atomic UPDATE whose WHERE carries the whole policy", async () => {
    const { db, work } = fakeDb([[{ ...ROW, status: "in_progress", claimed_by: "a" }]]);
    const out = await new TasksService(db).claim(7, "a");
    expect(out.ok).toBe(true);
    const [claim, ...rest] = work();
    expect(rest).toEqual([]); // no read before, no read after on success
    expect(claim?.text).toMatch(/^\s*UPDATE work/);
    expect(claim?.text).toContain("claimed_by IS NULL OR w.lease_expires_at < now()");
    expect(claim?.text).toContain("status IN ('open', 'in_progress')");
    expect(claim?.text).toContain("IS DISTINCT FROM 'closed'"); // dependency gate
    expect(claim?.text).toContain("RETURNING");
    expect(claim?.values.slice(0, 3)).toEqual([7, "a", 900]);
  });

  it("agent identity travels as a bind value — hostile text never reaches the SQL", async () => {
    const hostile = "a'; UPDATE work SET claimed_by = 'me'; --";
    const { db, calls } = fakeDb([[{ ...ROW, claimed_by: hostile }]]);
    await new TasksService(db).claim(7, hostile);
    for (const c of calls) expect(c.text).not.toContain(hostile);
    expect(calls.some((c) => c.values.includes(hostile))).toBe(true);
  });

  it("wraps every mutation in a two-phase runs row: component = agent, kind = task_op", async () => {
    const { db, calls } = fakeDb([[{ ...ROW, claimed_by: "bot-1" }]]);
    await new TasksService(db).claim(7, "bot-1");
    expect(calls[0]?.text).toMatch(/INSERT INTO runs/);
    expect(calls[0]?.values.slice(0, 2)).toEqual(["bot-1", "task_op"]);
    expect(JSON.parse(String(calls[0]?.values[6]))).toEqual({ op: "claim", id: 7 }); // meta is the 7th bind since runs gained `provider` (0015)
    expect(calls.at(-1)?.text).toMatch(/UPDATE runs/);
    expect(calls.at(-1)?.values[1]).toBe(true); // ok
  });

  it("records a failed run (ok=false) and rethrows when the statement throws", async () => {
    const calls: Call[] = [];
    const db: Db = {
      async query(text, values = []) {
        calls.push({ text, values });
        if (/INSERT INTO runs/.test(text)) return { rows: [{ id: 1 }] };
        if (/UPDATE runs/.test(text)) return { rows: [] };
        throw new Error("boom");
      },
    };
    await expect(new TasksService(db).claim(1, "a")).rejects.toThrow("boom");
    expect(calls.at(-1)?.values.slice(1, 3)).toEqual([false, "boom"]);
  });

  it("claim with no row returns {ok:false, reason} from a diagnostic read", async () => {
    const { db } = fakeDb([[], [{ ...ROW, status: "open", deps_closed: false }]]);
    const out = await new TasksService(db).claim(7, "a");
    expect(out).toMatchObject({ ok: false, reason: "dependencies_open" });
    const gone = fakeDb([[], []]);
    expect(await new TasksService(gone.db).claim(7, "a")).toEqual({ ok: false, reason: "not_found" });
  });

  it("create is idempotent: DO NOTHING on the key, then hands back the existing row", async () => {
    const { db, work } = fakeDb([[], [{ ...ROW, idempotency_key: "k1" }]]);
    const t = await new TasksService(db).create({ title: "x", idempotency_key: "k1" }, "a");
    expect(t.id).toBe(7);
    expect(t.depends_on).toEqual([1, 2]); // int8[] normalized to numbers
    expect(work()[0]?.text).toContain("ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING");
    expect(work()[0]?.values[7]).toBe("a"); // created_by = server-side identity
    expect(work()[1]?.text).toMatch(/WHERE idempotency_key = \$1/);
  });

  it("create refuses unknown dependencies before inserting", async () => {
    const { db, work } = fakeDb([[{ id: "1" }]]);
    await expect(new TasksService(db).create({ title: "x", depends_on: [1, 2] }, "a")).rejects.toMatchObject({ code: "unknown_dependency" });
    expect(work().length).toBe(1); // the existence check only — no INSERT
  });

  it("heartbeat and update are holder-only single statements; failures explain themselves", async () => {
    const { db, work } = fakeDb([[], [{ ...ROW, status: "in_progress", claimed_by: "b", lease_expires_at: new Date() }]]);
    const out = await new TasksService(db).heartbeat(7, "a");
    expect(out).toMatchObject({ ok: false, reason: "not_holder" });
    expect(work()[0]?.text).toContain("w.claimed_by = $2 AND w.lease_expires_at > now()");

    const u = fakeDb([[{ ...ROW, status: "closed", claimed_by: null }]]);
    const closed = await new TasksService(u.db).update(7, "a", { status: "closed", note: "done" });
    expect(closed.ok).toBe(true);
    const sql = u.work()[0]?.text ?? "";
    expect(sql).toContain("w.claimed_by = $2");
    expect(sql).toContain("closed_at = CASE WHEN $3::text = 'closed' THEN now()");
    const hist = JSON.parse(String(u.work()[0]?.values[3]))[0];
    expect(hist).toMatchObject({ agent: "a", op: "update", status: "closed", note: "done" });
  });

  it("rejects malformed input before touching the database", async () => {
    const { db, calls } = fakeDb();
    const svc = new TasksService(db);
    await expect(svc.create({ title: "" }, "a")).rejects.toBeInstanceOf(TasksError);
    await expect(svc.create({ title: "x" }, "")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(svc.create({ title: "x", due: "tomorrow" }, "a")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(svc.claim(0, "a")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(svc.claim(1, "a", 0)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(svc.update(1, "a", {})).rejects.toMatchObject({ code: "invalid_input" });
    await expect(svc.update(1, "a", { status: "open" as never })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(svc.listReady({ limit: 0 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toEqual([]);
  });

  it("listReady filters by project as a bind and gates on dependencies", async () => {
    const { db, calls } = fakeDb([[ROW]]);
    const rows = await new TasksService(db).listReady({ project: "p1", limit: 5 });
    expect(rows[0]?.id).toBe(7);
    expect(calls[0]?.text).toContain("w.status = 'open'");
    expect(calls[0]?.text).toContain("IS DISTINCT FROM 'closed'");
    expect(calls[0]?.values).toEqual(["p1", 5]);
  });

  it("check() reports failed with the error as remediation on an unmigrated db", async () => {
    const db: Db = {
      async query() {
        throw new Error('column "history" does not exist');
      },
    };
    const r = await check(db);
    expect(r).toMatchObject({ name: "tasks", status: "failed" });
    expect(r.remediation).toContain("history");
    const ok = await new TasksService(fakeDb().db).check();
    expect(ok.status).toBe("ok");
  });
});
