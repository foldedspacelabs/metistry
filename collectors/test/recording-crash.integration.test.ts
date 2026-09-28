// T8-2b's bold test, the database's half: a crashed recording raises ONE
// report. The recorder delivers the transcript (packages/mcp-live-capture —
// its tests prove the crash saves up to the crash, and that a redelivery is
// the same inbox row by its Idempotency-Key); this drain reads the capture
// and raises the report. Only Postgres can prove "one": the pending-subject
// index `raiseMirror` inserts against.
//
// Everything runs inside one transaction that is rolled back, so the drain
// pass — which reads every `new` inbox row — leaves no trace on rows another
// suite in the scratch database owns.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { run } from "../inbox-drain/run.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

const transcript = (session: string, endedReason: string) =>
  [
    "---",
    'kind: "transcript"',
    'title: "Recording 2026-09-28 13:00"',
    `capture_session: ${JSON.stringify(session)}`,
    'started_at: "2026-09-28T12:00:00Z"',
    'ended_at: "2026-09-28T12:41:07Z"',
    `ended_reason: ${JSON.stringify(endedReason)}`,
    'source: "live-capture"',
    "---",
    "",
    "[00:00:01] (apps) the numbers are in",
  ].join("\n");

describe.skipIf(!hasDb)("a crashed recording raises one report (real db)", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });
  afterAll(async () => pool.end());

  it("one crash, one report — however many passes or copies — and none for a clean stop or an agent's capture", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      let n = 0;
      const insert = async (session: string, reason: string, agent: string | null = null) =>
        Number(
          (
            await c.query(
              `INSERT INTO inbox (source, path, mime, note, source_agent) VALUES ('http', $1, 'application/json', $2, $3) RETURNING id`,
              [`Inbox/itest-t82b-${session}-${reason}-${++n}.md`, transcript(session, reason), agent],
            )
          ).rows[0].id,
        );
      const crashed = await insert("itest-t82b-a", "crashed");
      await insert("itest-t82b-b", "owner");
      // the same session arriving twice (a second door, a hand re-import): still one card
      const copy = await insert("itest-t82b-a", "crashed");
      await insert("itest-t82b-c", "crashed", "itest-t82b-agent");

      await run(c);
      await c.query(`UPDATE inbox SET status = 'new' WHERE id = $1`, [crashed]); // a second pass over the same row
      await run(c);

      const reports = (
        await c.query(`SELECT source, payload, trust, source_agent FROM proposals WHERE kind = 'report' AND source->>'kind' = 'live-capture' AND source->>'external_ref' LIKE 'crash:itest-t82b-%'`)
      ).rows;
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        source: { kind: "live-capture", external_ref: "crash:itest-t82b-a" },
        trust: "internal",
        source_agent: "inbox-drain",
        payload: { title: "A recording stopped unexpectedly", event: "recording_crashed", capture_session: "itest-t82b-a" },
      });
      expect([crashed, copy]).toContain(reports[0].payload.inbox_id); // one transaction, one ts: either copy may be read first

      // every transcript is still classified as one, deterministically
      const kinds = (await c.query(`SELECT DISTINCT proposal->>'kind' AS kind FROM inbox WHERE path LIKE 'Inbox/itest-t82b-%'`)).rows.map((r) => r.kind);
      expect(kinds).toEqual(["transcript"]);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});
