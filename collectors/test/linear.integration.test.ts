// The Linear sync and Add to Today against the real (scratch) database: the
// work upsert through the partial unique index, the task mirrors raised and
// resolved at source through core's mirrors, and Add to Today's idempotency
// through the inbox's unique index; and completion both ways (T4-26) — an
// issue closed in Linear closes its row while **no sync path writes a vault
// file**, and Close in Linear sends the read and the one fixed change through
// the connection's door, idempotent, refused with nothing sent when the owner
// set the tool to Never. One file, because every case here owns the
// `linear:%` rows while it runs. Skipped without a db.

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { parseTaskLine } from "@foldedspacelabs/metistry-core";
import { dirSink } from "@foldedspacelabs/metistry-mcp-brain";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { collectorCode } from "../index.js";
import { run as linearSync, SOURCE_KIND } from "../linear/run.js";
import { CompleteRefused, completeLinearIssue, linearTrackerOpener } from "../linear/complete.js";
import { TODAY_PRINCIPAL, TodayRefused, addIssueToToday } from "../linear/today.js";
import { CONNECTION_YAML, ENV, KEY, SEED_DIR, fakeLinear, fixture, linearInstance, opener } from "./linear-fixture.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

/** Everything a component's ctx can carry that reaches the vault — each a tripwire: any touch is recorded and throws. */
function tripwires() {
  const touched: string[] = [];
  const wire = (name: string) =>
    new Proxy(
      {},
      {
        get(_t, p) {
          if (p === "then") return undefined; // not a thenable
          touched.push(`${name}.${String(p)}`);
          throw new Error(`${name}.${String(p)} was touched`);
        },
      },
    );
  return { touched, ctx: { vault: wire("vault"), reader: wire("reader"), inboxSink: wire("inboxSink"), inboxDir: "/nonexistent/inbox" } };
}

describe.skipIf(!hasDb)("linear sync (real db)", () => {
  let pool: pg.Pool;
  const instance = linearInstance();

  const clean = async () => {
    await pool.query(`DELETE FROM proposals WHERE source->>'kind' = $1`, [SOURCE_KIND]);
    await pool.query(`DELETE FROM work WHERE external_ref LIKE 'linear:%'`);
    await pool.query(`DELETE FROM inbox WHERE idempotency_principal = $1`, [TODAY_PRINCIPAL]);
  };
  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await pool.end();
  });

  const pass = (assigned: string[], byId?: string, dir = instance) => {
    const linear = fakeLinear({ assigned: assigned.map(fixture), ...(byId ? { byId: fixture(byId) } : {}) });
    return linearSync(pool, { openSync: opener(dir, linear.fetch) }).then((n) => ({ n, sent: linear.sent }));
  };
  const work = async () =>
    (
      await pool.query(
        `SELECT external_ref, title, kind, status, owner, area, due::text AS due, meta->>'state' AS state, meta->>'priority_label' AS priority,
                meta->>'url' AS url, meta->>'connection' AS connection, meta->>'closed_reason' AS closed_reason
         FROM work WHERE external_ref LIKE 'linear:%' ORDER BY external_ref`,
      )
    ).rows;
  const mirrors = async () =>
    (
      await pool.query(
        `SELECT p.source->>'external_ref' AS ref, p.kind, p.decision, p.trust, p.source_agent, p.source->>'person' AS person,
                p.payload->>'title' AS title, w.external_ref AS work_ref
         FROM proposals p LEFT JOIN work w ON w.id = p.work_id
         WHERE p.source->>'kind' = $1 ORDER BY p.id`,
        [SOURCE_KIND],
      )
    ).rows;

  it("reconciles the assigned issues into work — upsert, never duplicate — and raises one task request each", async () => {
    expect((await pass(["assigned-1a.json", "assigned-1b.json"])).n).toBe(4);
    expect((await pass(["assigned-1a.json", "assigned-1b.json"])).n).toBe(4); // rerun: the same four rows
    expect(await work()).toEqual([
      { external_ref: "linear:ENG-101", title: "Tighten the egress allowlist", kind: "issue", status: "open", owner: "Sam Rivera", area: "ENG", due: null, state: "In Progress", priority: "High", url: "https://linear.app/fsl/issue/eng-101/tighten-the-egress-allowlist", connection: "linear", closed_reason: null },
      { external_ref: "linear:ENG-102", title: "Write the Linear sync docs", kind: "issue", status: "open", owner: "Sam Rivera", area: "ENG", due: "2026-10-02", state: "Todo", priority: "Medium", url: "https://linear.app/fsl/issue/eng-102/write-the-linear-sync-docs", connection: "linear", closed_reason: null },
      { external_ref: "linear:ENG-103", title: "Review the capture retention policy", kind: "issue", status: "open", owner: "Sam Rivera", area: "ENG", due: null, state: "Backlog", priority: "No priority", url: "https://linear.app/fsl/issue/eng-103/review-the-capture-retention-p", connection: "linear", closed_reason: null },
      { external_ref: "linear:OPS-7", title: "Rotate the backup key", kind: "issue", status: "open", owner: "Sam Rivera", area: "OPS", due: null, state: "Triage", priority: "Urgent", url: "https://linear.app/fsl/issue/ops-7/rotate-the-backup-key", connection: "linear", closed_reason: null },
    ]);
    // one subject, one row: the rerun raised nothing new
    expect(await mirrors()).toEqual([
      { ref: "linear:ENG-101", kind: "task", decision: "pending", trust: "external", source_agent: "linear", person: "Ada Park", title: "ENG-101 · Tighten the egress allowlist", work_ref: "linear:ENG-101" },
      { ref: "linear:ENG-102", kind: "task", decision: "pending", trust: "external", source_agent: "linear", person: "Ada Park", title: "ENG-102 · Write the Linear sync docs", work_ref: "linear:ENG-102" },
      { ref: "linear:ENG-103", kind: "task", decision: "pending", trust: "external", source_agent: "linear", person: null, title: "ENG-103 · Review the capture retention policy", work_ref: "linear:ENG-103" },
      { ref: "linear:OPS-7", kind: "task", decision: "pending", trust: "external", source_agent: "linear", person: "Ada Park", title: "OPS-7 · Rotate the backup key", work_ref: "linear:OPS-7" },
    ]);
  });

  it("an issue closed or given to someone else closes its row with why, and its request clears at source", async () => {
    await pass(["assigned-1a.json", "assigned-1b.json"]);
    const second = await pass(["assigned-2.json"], "issues-by-id-2.json");
    expect(second.n).toBe(4); // two upserts + two closed
    expect(second.sent.map((s) => s.operation)).toEqual(["MetistryAssignedIssues", "MetistryIssuesById"]);
    expect(second.sent[1]!.variables.ids).toEqual(["9b1d7a52-0c4e-4f7a-9e1b-3a5c7d9e1f02", "9b1d7a52-0c4e-4f7a-9e1b-3a5c7d9e1f03"]);
    const rows = await work();
    expect(rows.map((r) => [r.external_ref, r.status, r.closed_reason, r.state])).toEqual([
      ["linear:ENG-101", "open", null, "In Progress"],
      ["linear:ENG-102", "closed", "completed", "Done"],
      ["linear:ENG-103", "closed", "unassigned", "Backlog"],
      ["linear:OPS-7", "open", null, "Triage"],
    ]);
    expect(rows[0]!.title).toBe("Tighten the egress allowlist (ports too)");
    expect((await mirrors()).map((m) => [m.ref, m.decision])).toEqual([
      ["linear:ENG-101", "pending"],
      ["linear:ENG-102", "resolved_at_source"],
      ["linear:ENG-103", "resolved_at_source"],
      ["linear:OPS-7", "pending"],
    ]);
    // each clear carries its receipt: what became of the issue, in Linear (T4-23)
    const receipts = await pool.query(
      `SELECT source->>'external_ref' AS ref, payload->'cleared' AS cleared FROM proposals WHERE source->>'kind' = $1 AND decision = 'resolved_at_source' ORDER BY id`,
      [SOURCE_KIND],
    );
    expect(receipts.rows).toEqual([
      { ref: "linear:ENG-102", cleared: { what: "Completed in Linear", where: "linear" } },
      { ref: "linear:ENG-103", cleared: { what: "Assigned to someone else in Linear", where: "linear" } },
    ]);
  });

  it("an issue that comes back is raised again; one the owner answered is not raised again while it stays", async () => {
    await pass(["assigned-1a.json", "assigned-1b.json"]);
    await pass(["assigned-2.json"], "issues-by-id-2.json");
    // the owner answered OPS-7's request (a door's answer lands on the row)
    await pool.query(`UPDATE proposals SET decision = 'deny', decided_at = now() WHERE source->>'kind' = $1 AND source->>'external_ref' = 'linear:OPS-7'`, [SOURCE_KIND]);
    await pass(["assigned-1a.json", "assigned-1b.json"]); // ENG-102 and ENG-103 are assigned again
    const rows = await work();
    expect(rows.map((r) => [r.external_ref, r.status, r.closed_reason])).toEqual([
      ["linear:ENG-101", "open", null],
      ["linear:ENG-102", "open", null],
      ["linear:ENG-103", "open", null],
      ["linear:OPS-7", "open", null],
    ]);
    const m = await mirrors();
    expect(m.map((x) => [x.ref, x.decision])).toEqual([
      ["linear:ENG-101", "pending"],
      ["linear:ENG-102", "resolved_at_source"],
      ["linear:ENG-103", "resolved_at_source"],
      ["linear:OPS-7", "deny"],
      ["linear:ENG-102", "pending"],
      ["linear:ENG-103", "pending"],
    ]);
  });

  it("two Linear connections never close each other's rows", async () => {
    await pass(["assigned-1a.json", "assigned-1b.json"]);
    const other = linearInstance({
      "connections/linear.yaml": "",
      "connections/linear-second.yaml": "name: linear-second\ntype: tracker\nprovider: linear\nreach:\n  http:\n    url: https://api.linear.app/graphql\n    auth: { scheme: api_key, header: Authorization, secret: linear_api_key }\nsecrets: [linear_api_key]\n",
      "secrets.yaml": 'secrets:\n  linear_api_key:\n    hosts: [api.linear.app]\n    grants: { "connection:linear-second": on }\n',
    });
    const linear = fakeLinear({ assigned: [{ data: { viewer: { assignedIssues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }] });
    expect(await linearSync(pool, { openSync: opener(other, linear.fetch) })).toBe(0);
    expect((await work()).every((r) => r.status === "open")).toBe(true);
  });

  describe("Add to Today", () => {
    it("**captures the task line through the capture service, and a second Add to Today returns the first capture**", async () => {
      await pass(["assigned-1a.json", "assigned-1b.json"]);
      const dir = mkdtempSync(join(tmpdir(), "metistry-linear-inbox-"));
      const sink = dirSink(dir, { prefix: "Inbox" });
      const first = await addIssueToToday(pool, sink, { key: "OPS-7", today: "2026-09-27" });
      expect(first).toMatchObject({ replayed: false, line: "- [ ] Rotate the backup key do 2026-09-27 linear:OPS-7" });
      expect(first.path).toMatch(/^Inbox\/\d+-linear-OPS-7\.md$/);
      const second = await addIssueToToday(pool, sink, { key: "OPS-7", today: "2026-09-28" });
      expect(second).toEqual({ ...first, replayed: true }); // the first capture: same row, same file, the first day's line
      expect(readdirSync(dir)).toHaveLength(1);
      const { rows } = await pool.query(`SELECT source, source_agent, note, status FROM inbox WHERE idempotency_principal = $1`, [TODAY_PRINCIPAL]);
      expect(rows).toEqual([{ source: "linear", source_agent: null, note: first.line, status: "new" }]);
      // the task grammar reads it as today's, carrying the issue's ref
      const parsed = parseTaskLine(first.line, { now: new Date("2026-09-27T12:00:00Z") });
      expect(parsed).toMatchObject({ checked: false, scheduled_for: "2026-09-27", ext_refs: ["linear:OPS-7"], text: "Rotate the backup key" });
    });

    it("two presses at once make one capture", async () => {
      await pass(["assigned-1a.json", "assigned-1b.json"]);
      const dir = mkdtempSync(join(tmpdir(), "metistry-linear-inbox-"));
      const sink = dirSink(dir, { prefix: "Inbox" });
      const [a, b] = await Promise.all([addIssueToToday(pool, sink, { key: "ENG-101", today: "2026-09-27" }), addIssueToToday(pool, sink, { key: "ENG-101", today: "2026-09-27" })]);
      expect(a.id).toBe(b.id);
      expect(readdirSync(dir)).toHaveLength(1);
    });

    it("refuses a key that is not one, a date that is not one, and an issue the sync has not seen — writing nothing", async () => {
      const dir = mkdtempSync(join(tmpdir(), "metistry-linear-inbox-"));
      const sink = dirSink(dir, { prefix: "Inbox" });
      for (const [req, code] of [
        [{ key: "ops-7", today: "2026-09-27" }, "bad_key"],
        [{ key: "OPS-7\n- [ ] injected", today: "2026-09-27" }, "bad_key"],
        [{ key: "OPS-7", today: "tomorrow" }, "bad_date"],
        [{ key: "OPS-99", today: "2026-09-27" }, "unknown_issue"],
      ] as const) {
        const err = await addIssueToToday(pool, sink, req).catch((e: unknown) => e);
        expect(err, code).toBeInstanceOf(TodayRefused);
        expect((err as TodayRefused).code).toBe(code);
      }
      expect(readdirSync(dir)).toHaveLength(0);
    });
  });

  // ---- completion both ways (T4-26) ----

  const row = async (ref: string) =>
    (await pool.query(`SELECT status, meta->>'closed_reason' AS closed_reason, meta->>'state' AS state FROM work WHERE external_ref = $1`, [ref])).rows[0];
  const decision = async (ref: string) => (await pool.query(`SELECT decision FROM proposals WHERE source->>'kind' = $1 AND source->>'external_ref' = $2 ORDER BY id DESC LIMIT 1`, [SOURCE_KIND, ref])).rows[0]?.decision;
  const firstPass = async () => {
    const linear = fakeLinear({ assigned: [fixture("assigned-1a.json"), fixture("assigned-1b.json")] });
    const run = await collectorCode("linear");
    if (typeof run !== "function") throw new Error("the linear collector has no code");
    await run(pool, { openSync: opener(instance, linear.fetch) } as never);
  };

  describe("Linear → Metistry", () => {
    it("**an issue closed in Linear closes its row and clears its request — and the sync, handed the vault, touches none of it**", async () => {
      const run = await collectorCode("linear");
      if (typeof run !== "function") throw new Error("the linear collector has no code");
      const wires = tripwires();
      const first = fakeLinear({ assigned: [fixture("assigned-1a.json"), fixture("assigned-1b.json")] });
      await run(pool, { ...wires.ctx, openSync: opener(instance, first.fetch) } as never);
      const second = fakeLinear({ assigned: [fixture("assigned-2.json")], byId: fixture("issues-by-id-2.json") });
      await run(pool, { ...wires.ctx, openSync: opener(instance, second.fetch) } as never);
      expect(await row("linear:ENG-102")).toEqual({ status: "closed", closed_reason: "completed", state: "Done" });
      expect(await decision("linear:ENG-102")).toBe("resolved_at_source");
      expect(wires.touched).toEqual([]); // the owner's note is theirs: the line stays open until they tick it
      // …and the sync sent read queries only
      expect([...first.sent, ...second.sent].every((s) => s.operation.startsWith("Metistry") && !/Complete/.test(s.operation))).toBe(true);
    });
  });

  describe("Metistry → Linear: Close in Linear", () => {
    const script = () => fakeLinear({ assigned: [], complete: { read: fixture("complete-read.json"), update: fixture("complete-update.json") } });
    const openerOver = (dir: string, f: typeof fetch, env: NodeJS.ProcessEnv = ENV) => linearTrackerOpener({ instanceDir: dir, seedDir: SEED_DIR, extensions: false, env, fetch: f });

    it("**closes the issue through the connection's door: the read, then the one fixed change, by Linear's own id — the key only to api.linear.app**", async () => {
      await firstPass();
      const linear = script();
      const r = await completeLinearIssue(pool, openerOver(instance, linear.fetch), { connection: "linear", key: "OPS-7" });
      expect(r).toEqual({ connection: "linear", key: "OPS-7", ref: "linear:OPS-7", url: "https://linear.app/fsl/issue/ops-7/rotate-the-backup-key", state: "done", changed: true, secrets: ["linear_api_key"] });
      expect(linear.sent.map((s) => s.operation)).toEqual(["MetistryIssueToComplete", "MetistryCompleteIssue"]);
      expect(linear.sent.every((s) => s.url === "https://api.linear.app/graphql" && s.authorization === KEY)).toBe(true); // filled at the door, no Bearer
      expect(linear.sent[0]!.variables).toEqual({ id: "4e2f8c61-7a3b-4d5e-8f9a-1b2c3d4e5f07" }); // the sync's id for it
      expect(linear.sent[1]!.variables).toEqual({ id: "4e2f8c61-7a3b-4d5e-8f9a-1b2c3d4e5f07", stateId: "6f0e1d2c-3b4a-4958-8776-655443322100" }); // Done: the first by position
      expect(await row("linear:OPS-7")).toEqual({ status: "closed", closed_reason: "completed", state: "Done" });
      expect(await decision("linear:OPS-7")).toBe("resolved_at_source");
      expect(await row("linear:ENG-101")).toMatchObject({ status: "open" }); // one issue, one row
    });

    it("a second close is idempotent: Linear already has it closed, only the read is sent, changed false", async () => {
      await firstPass();
      const done = fakeLinear({ assigned: [], complete: { read: { data: { issue: { ...(fixture("complete-update.json") as any).data.issueUpdate.issue, team: { key: "OPS", name: "Operations", states: { nodes: [] } } } } } } });
      const r = await completeLinearIssue(pool, openerOver(instance, done.fetch), { connection: "linear", key: "OPS-7" });
      expect(r).toMatchObject({ state: "done", changed: false });
      expect(done.sent.map((s) => s.operation)).toEqual(["MetistryIssueToComplete"]);
      expect(await row("linear:OPS-7")).toMatchObject({ status: "closed", closed_reason: "completed" });
    });

    it("an issue the sync has not seen is looked up by its key, and no row is invented", async () => {
      const linear = script();
      const r = await completeLinearIssue(pool, openerOver(instance, linear.fetch), { connection: "linear", key: "OPS-7" });
      expect(r.changed).toBe(true);
      expect(linear.sent[0]!.variables).toEqual({ id: "OPS-7" });
      expect(await row("linear:OPS-7")).toBeUndefined();
    });

    it("**the owner's Never is enforced at the tool: refused, and nothing is sent**", async () => {
      await firstPass();
      const never = linearInstance({ "connections/linear.yaml": `${CONNECTION_YAML}tools:\n  complete_issue: { group: changes, mode: off }\n` });
      const linear = script();
      const err = await completeLinearIssue(pool, openerOver(never, linear.fetch), { connection: "linear", key: "OPS-7" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CompleteRefused);
      expect(err).toMatchObject({ code: "tool_off" });
      expect(linear.sent).toHaveLength(0);
      expect(await row("linear:OPS-7")).toMatchObject({ status: "open" });
      // Allow and Ask First both let the call through: the difference is whether the client asks first
      for (const mode of ["on", "ask"]) {
        const dir = linearInstance({ "connections/linear.yaml": `${CONNECTION_YAML}tools:\n  complete_issue: { group: changes, mode: ${mode} }\n` });
        const f = script();
        await expect(completeLinearIssue(pool, openerOver(dir, f.fetch), { connection: "linear", key: "OPS-7" })).resolves.toMatchObject({ state: "done" });
      }
    });

    it("refuses by code, sending nothing: a key that is not one, no such connection, a secret listed for another host, no delivered key", async () => {
      const linear = script();
      const open = openerOver(instance, linear.fetch);
      await expect(completeLinearIssue(pool, open, { connection: "linear", key: "ops-7" })).rejects.toMatchObject({ code: "bad_key" });
      await expect(completeLinearIssue(pool, open, { connection: "linear-other", key: "OPS-7" })).rejects.toMatchObject({ code: "no_connection" });
      const elsewhere = linearInstance({ "secrets.yaml": 'secrets:\n  linear_api_key:\n    hosts: [evil.example.com]\n    grants: { "connection:linear": on }\n' });
      const e1 = await completeLinearIssue(pool, openerOver(elsewhere, linear.fetch), { connection: "linear", key: "OPS-7" }).catch((e: Error) => e);
      expect(e1).toMatchObject({ code: "connection_failed" });
      expect(String((e1 as Error).message)).not.toContain(KEY);
      await expect(completeLinearIssue(pool, openerOver(instance, linear.fetch, {}), { connection: "linear", key: "OPS-7" })).rejects.toMatchObject({ code: "connection_failed" });
      expect(linear.sent).toHaveLength(0);
    });

    it("an issue Linear does not have is not_found; a key Linear refuses is Linear's code", async () => {
      const none = fakeLinear({ assigned: [], complete: { read: { data: { issue: null } } } });
      await expect(completeLinearIssue(pool, openerOver(instance, none.fetch), { connection: "linear", key: "OPS-7" })).rejects.toMatchObject({ code: "not_found" });
      const refused = (async () => new Response("{}", { status: 401 })) as typeof fetch;
      await expect(completeLinearIssue(pool, openerOver(instance, refused), { connection: "linear", key: "OPS-7" })).rejects.toMatchObject({ code: "linear", linear: "unauthorized" });
    });
  });
});

describe("no sync path writes a vault file — by construction", () => {
  it("**the linear sync and Close in Linear import nothing that can write the vault**", () => {
    for (const file of ["run.ts", "complete.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(`../linear/${file}`, import.meta.url)), "utf8");
      const imports = [...src.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
      expect(imports.every((i) => ["@foldedspacelabs/metistry-core", "@foldedspacelabs/metistry-connections", "./run.js"].includes(i!)), `${file}: ${imports.join(", ")}`).toBe(true);
    }
  });
});
