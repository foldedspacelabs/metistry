// The Linear sync and Add to Today against the real (scratch) database: the
// work upsert through the partial unique index, the task mirrors raised and
// resolved at source through core's mirrors, and Add to Today's idempotency
// through the inbox's unique index. Skipped without a db.

import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { parseTaskLine } from "@foldedspacelabs/metistry-core";
import { dirSink } from "@foldedspacelabs/metistry-mcp-brain";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { run as linearSync, SOURCE_KIND } from "../linear/run.js";
import { TODAY_PRINCIPAL, TodayRefused, addIssueToToday } from "../linear/today.js";
import { fakeLinear, fixture, linearInstance, opener } from "./linear-fixture.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

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
});
