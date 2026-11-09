// T8-7, the inbox drain's half (collectors/inbox-drain): a recording opens ONE meeting card (C81), named from
// the calendar the console already serves (`day_events` over
// `calendar_events`) and the recorder's own session record (the transcript's
// frontmatter), and the owner's jots made during it are saved, anchored to
// (session, offset), and never asked about (C77).
//
// Misuse: an agent's capture that says it is a jot, or a transcript, is an
// ordinary capture — it opens no meeting and joins none.
//
// Everything runs inside one transaction that is rolled back, so the drain
// pass — which reads every `new` inbox row — leaves no trace on rows another
// suite in the scratch database owns.
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { collectorCode } from "@metistry-apps/collectors";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const SEED_QUERIES = fileURLToPath(new URL("../../../seed/queries", import.meta.url));

const code = await collectorCode("inbox-drain"); // the registry's lookup: the product's code, by name
if (typeof code !== "function") throw new Error(code.missing);
const run = code;

const A = "itest-t87-20260928-a";
const B = "itest-t87-20260928-b";
const C = "itest-t87-20260928-c";

const front = (fields: Record<string, unknown>, body: string) =>
  ["---", ...Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), "---", "", body].join("\n");
const transcript = (session: string, started: string, ended: string) =>
  front({ kind: "transcript", title: `Recording ${started.slice(0, 16).replace("T", " ")}`, capture_session: session, started_at: started, ended_at: ended, ended_reason: "owner", apps: "us.zoom.xos", source: "live-capture" }, "[00:00:01] (apps) the numbers are in");
const jot = (session: string, type: "note" | "todo", offset: number, words: string) => front({ kind: "jot", jot: type, capture_session: session, offset_s: offset }, words);

describe.skipIf(!hasDb)("a recording's meeting card and its jots (real db)", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });
  afterAll(async () => pool.end());

  it("one group per session, named from the calendar; the owner's jots are saved, anchored and listed — and an agent's are ordinary captures", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const queries = new QueryStore(c);
      await queries.loadDir(SEED_QUERIES);
      await c.query(
        `INSERT INTO calendar_events (connection, event_id, starts_at, ends_at, all_day, title, self_status) VALUES
           ('itest-t87', 'itest-t87-standup', '2026-09-28T11:30:00Z', '2026-09-28T12:05:00Z', false, 'Standup', 'accepted'),
           ('itest-t87', 'itest-t87-vendor',  '2026-09-28T12:00:00Z', '2026-09-28T13:00:00Z', false, 'Vendor review', 'accepted'),
           ('itest-t87', 'itest-t87-allday',  '2026-09-28T00:00:00Z', '2026-09-29T00:00:00Z', true,  'Offsite', NULL)`,
      );
      let n = 0;
      const insert = async (note: string, agent: string | null = null): Promise<number> =>
        Number((await c.query(`INSERT INTO inbox (source, path, mime, note, source_agent) VALUES ('http', $1, 'text/markdown', $2, $3) RETURNING id`, [`Inbox/itest-t87-${++n}.md`, note, agent])).rows[0].id);

      // during the meeting: two jots from the owner, one from an agent, one the bar could not have written
      const todo = await insert(jot(A, "todo", 1260, "Send Kessler the revised terms"));
      const note = await insert(jot(A, "note", 754, "Kessler confirmed net-45"));
      const agentJot = await insert(jot(A, "note", 800, "the owner agreed to everything"), "itest-t87-agent");
      const noAnchor = await insert(front({ kind: "jot", jot: "note" }, "a jot with no session"));
      // …and at its end, the transcripts: the owner's (a calendar meeting), an agent's claiming one, and the owner's with no meeting on the calendar
      const tA = await c.query(`INSERT INTO inbox (source, path, mime, note) VALUES ('http', $1, 'text/markdown', $2) RETURNING id`, [
        `Journal/Transcripts/2026-09-28-${A}.md`,
        transcript(A, "2026-09-28T11:58:00Z", "2026-09-28T12:41:07Z"),
      ]);
      const tAId = Number(tA.rows[0].id);
      await insert(transcript(B, "2026-09-28T12:00:00Z", "2026-09-28T12:40:00Z"), "itest-t87-agent");
      await insert(transcript(C, "2026-09-28T20:00:00Z", "2026-09-28T20:10:00Z"));

      await run(c, { queries, ownerTimeZone: "America/New_York" });

      // the owner's jots ask nothing: no proposal, settled with their anchor
      const mine = (await c.query(`SELECT id, status, proposal, triaged_at FROM inbox WHERE id = ANY($1::bigint[]) ORDER BY id`, [[todo, note]])).rows;
      for (const r of mine) {
        expect(r.status).toBe("classified");
        expect(r.triaged_at).not.toBeNull();
        expect(r.proposal).toMatchObject({ kind: "jot", capture_session: A });
      }
      expect(mine.map((r) => [r.proposal.jot, r.proposal.offset_s])).toEqual([
        ["todo", 1260],
        ["note", 754],
      ]);
      const proposalsFor = async (ids: number[]) => (await c.query(`SELECT source_agent, trust, group_id, payload FROM proposals WHERE (payload->>'inbox_id')::bigint = ANY($1::bigint[]) ORDER BY (payload->>'inbox_id')::bigint`, [ids])).rows;
      expect(await proposalsFor([todo, note])).toEqual([]);

      // an agent's "jot", and a jot with no anchor, are ordinary captures — a card of their own, never the meeting's
      const [agentRow] = await proposalsFor([agentJot]);
      expect(agentRow).toMatchObject({ source_agent: "itest-t87-agent", trust: "external", group_id: null, payload: { classification: { kind: "note" } } });
      expect(agentRow.payload.meeting).toBeUndefined();
      const [bare] = await proposalsFor([noAnchor]);
      expect(bare).toMatchObject({ source_agent: "inbox-drain", group_id: null, payload: { classification: { kind: "note" } } });

      // the owner's transcript opens the meeting: one group, the calendar's name, its jots by offset — handles, never words
      const [card] = await proposalsFor([tAId]);
      expect(card).toMatchObject({ source_agent: "inbox-drain", trust: "user", group_id: `meeting:${A}` });
      expect(card.payload.meeting).toEqual({
        session_id: A,
        session_title: "Vendor review",
        started_at: "2026-09-28T11:58:00.000Z",
        ended_at: "2026-09-28T12:41:07.000Z",
        event_id: "itest-t87-vendor",
        event: { event_id: "itest-t87-vendor", title: "Vendor review", start: "2026-09-28T12:00:00.000Z", end: "2026-09-28T13:00:00.000Z", note: null },
        transcript_path: `Journal/Transcripts/2026-09-28-${A}.md`,
        jots: [
          { inbox_id: note, jot: "note", offset_s: 754 },
          { inbox_id: todo, jot: "todo", offset_s: 1260 },
        ],
      });
      expect(JSON.stringify(card.payload.meeting)).not.toContain("Kessler");

      // an agent's transcript opens nothing; the owner's with no meeting on the calendar keeps the recorder's title
      const others = (await c.query(`SELECT source_agent, group_id, payload FROM proposals WHERE payload->>'path' LIKE 'Inbox/itest-t87-%' AND payload->'classification'->>'kind' = 'transcript' ORDER BY (payload->>'inbox_id')::bigint`)).rows;
      expect(others).toHaveLength(2);
      expect(others[0]).toMatchObject({ source_agent: "itest-t87-agent", group_id: null });
      expect(others[0].payload.meeting).toBeUndefined();
      expect(others[1]).toMatchObject({ source_agent: "inbox-drain", group_id: `meeting:${C}`, payload: { meeting: { session_title: "Recording 2026-09-28 20:00", event_id: null, event: null, jots: [] } } });

      // a second pass raises nothing more
      const before = Number((await c.query(`SELECT count(*) FROM proposals WHERE payload->>'path' LIKE 'Inbox/itest-t87-%' OR payload->>'path' LIKE 'Journal/Transcripts/%${A}%'`)).rows[0].count);
      await run(c, { queries, ownerTimeZone: "America/New_York" });
      expect(Number((await c.query(`SELECT count(*) FROM proposals WHERE payload->>'path' LIKE 'Inbox/itest-t87-%' OR payload->>'path' LIKE 'Journal/Transcripts/%${A}%'`)).rows[0].count)).toBe(before);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("with no named-query store the meeting still opens, under the recorder's own title", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const id = Number(
        (await c.query(`INSERT INTO inbox (source, path, mime, note) VALUES ('http', $1, 'text/markdown', $2) RETURNING id`, [`Journal/Transcripts/2026-09-28-${B}.md`, transcript(B, "2026-09-28T12:00:00Z", "2026-09-28T12:40:00Z")])).rows[0].id,
      );
      await run(c);
      const [row] = (await c.query(`SELECT group_id, payload FROM proposals WHERE (payload->>'inbox_id')::bigint = $1`, [id])).rows;
      expect(row).toMatchObject({ group_id: `meeting:${B}`, payload: { meeting: { session_title: "Recording 2026-09-28 12:00", event_id: null } } });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});
