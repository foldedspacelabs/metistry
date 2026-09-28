// knowledge-fold against the real (scratch) database: only Postgres can prove
// the four windowed reads (proposals decided — reports acknowledged among
// them, X-10 — work closed, artifact_versions
// published, inbox sessions), the anchor row it writes for itself, and that a
// second pass with nothing new stays silent. The fake-db suite proves the
// gates and the rendering. Every fixture carries an `itest-fold` marker and is
// removed again.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { COMPONENT, run as knowledgeFold } from "../knowledge-fold/run.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const AGENT = "itest-fold-agent";
const MARK = "itest-fold";
const ART = "art_itest_fold";
const VER = "ver_itest_fold";

/** Tomorrow 19:00 local: past the evening gate, and a different local day from the anchor rows below. */
const eveningAfter = (): Date => {
  const d = new Date(Date.now() + 86_400_000);
  d.setHours(19, 0, 0, 0);
  return d;
};

describe.skipIf(!hasDb)("knowledge-fold (real db)", () => {
  let pool: pg.Pool;
  const cleanup = async () => {
    await pool.query(`DELETE FROM inbound_messages WHERE thread = 'fold'`);
    await pool.query(`DELETE FROM runs WHERE component = $1`, [COMPONENT]);
    await pool.query(`DELETE FROM proposals WHERE source_agent = $1`, [AGENT]);
    await pool.query(`DELETE FROM work WHERE title LIKE '%' || $1 || '%'`, [MARK]);
    await pool.query(`DELETE FROM artifact_versions WHERE id = $1`, [VER]);
    await pool.query(`DELETE FROM artifacts WHERE id = $1`, [ART]);
    await pool.query(`DELETE FROM inbox WHERE path LIKE '%' || $1 || '%'`, [MARK]);
  };
  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("folds exactly the handles that are new since its anchor, then goes quiet", async () => {
    // the anchor: a fold that ran an hour ago (meta.folded = true is what makes a row an anchor)
    await pool.query(
      `INSERT INTO runs (component, kind, ok, ts, started_at, finished_at, meta)
       VALUES ($1, 'routine_run', true, now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour', '{"folded": true}')`,
      [COMPONENT],
    );
    // material from the last half hour: one of each kind the fold reads…
    const accepted = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload, decision, decided_at, ts)
       VALUES ('knowledge', $1, 'internal', $2, 'allow', now() - interval '30 minutes', now() - interval '40 minutes') RETURNING id`,
      [AGENT, JSON.stringify({ title: `${MARK} accepted a fact` })],
    );
    // an acknowledged report (X-10): a report cannot be approved (T2-3), so
    // Acknowledge is how the owner keeps one, and the fold reads it
    const acknowledged = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload, decision, decided_at, ts)
       VALUES ('report', $1, 'external', $2, 'acknowledged', now() - interval '25 minutes', now() - interval '45 minutes') RETURNING id`,
      [AGENT, JSON.stringify({ title: `${MARK} an acknowledged finding`, body: "the drafts fold drops them", kind: "finding" })],
    );
    // …and reports that must not be: Dismissed (deny + the skip marker), still waiting,
    // and `acknowledged` on a kind that is not a report (only a report's acknowledgement is one)
    await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload, decision, feedback, decided_at, ts) VALUES
         ('report',    $1, 'external', $2, 'deny',         'skipped', now() - interval '25 minutes', now() - interval '45 minutes'),
         ('report',    $1, 'external', $3, 'pending',      NULL,      NULL,                          now() - interval '45 minutes'),
         ('knowledge', $1, 'internal', $4, 'acknowledged', NULL,      now() - interval '25 minutes', now() - interval '45 minutes')`,
      [AGENT, JSON.stringify({ title: `${MARK} a dismissed report` }), JSON.stringify({ title: `${MARK} an unread report` }), JSON.stringify({ title: `${MARK} not a report` })],
    );
    // …plus three that must NOT be folded: still pending, denied, and the fold's own output
    await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload, decision, ts) VALUES
         ('knowledge', $1, 'internal', $2, 'pending', now() - interval '30 minutes'),
         ('knowledge', $1, 'internal', $3, 'deny',    now() - interval '30 minutes')`,
      [AGENT, JSON.stringify({ title: `${MARK} still pending` }), JSON.stringify({ title: `${MARK} denied` })],
    );
    await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload, decision, decided_at, ts)
       VALUES ('knowledge', $1, 'internal', $2, 'allow', now() - interval '30 minutes', now() - interval '30 minutes')`,
      [COMPONENT, JSON.stringify({ title: `${MARK} the fold's own proposal` })],
    );
    const work = await pool.query(
      `INSERT INTO work (title, kind, status, area, external_ref, updated_at)
       VALUES ($1, 'issue', 'closed', 'fsl', 'gh:foldedspacelabs/metistry#999', now() - interval '20 minutes') RETURNING id`,
      [`${MARK} shipped the bridge`],
    );
    await pool.query(
      `INSERT INTO work (title, kind, status, updated_at) VALUES ($1, 'issue', 'open', now() - interval '20 minutes')`,
      [`${MARK} still open`],
    );
    await pool.query(`INSERT INTO artifacts (id, project, slug, created_by) VALUES ($1, 'itest-fold', 'brief', $2)`, [ART, AGENT]);
    await pool.query(
      `INSERT INTO artifact_versions (id, artifact_id, path_prefix, manifest, author_principal, author_kind, message, created_at)
       VALUES ($1, $2, 'Artifacts/itest-fold/brief', '{}', $3, 'agent', $4, now() - interval '10 minutes')`,
      [VER, ART, AGENT, `${MARK} published v2`],
    );
    const inbox = await pool.query(
      `INSERT INTO inbox (source, path, mime, note, ts) VALUES ('session', $1, 'text/markdown', $2, now() - interval '5 minutes') RETURNING id`,
      [`${MARK}-session.md`, `${MARK} 3h in metistry`],
    );

    expect(await knowledgeFold(pool, { now: eveningAfter() })).toBe(1);

    const { rows } = await pool.query(`SELECT id, text, meta, status FROM inbound_messages WHERE thread = 'fold' ORDER BY id`);
    expect(rows).toHaveLength(1); // exactly one turn per fold
    const text = String(rows[0].text);
    expect(rows[0].status).toBe("new"); // the drain picks it up like any other message
    expect(rows[0].meta).toMatchObject({ kind: "fold", source: COMPONENT });
    expect(text).toContain(`proposal #${accepted.rows[0].id} — ${MARK} accepted a fact`);
    expect(text).toContain(`proposal #${acknowledged.rows[0].id} — ${MARK} an acknowledged finding · report from ${AGENT}`);
    expect(text).not.toContain("a dismissed report");
    expect(text).not.toContain("an unread report");
    expect(text).not.toContain("not a report");
    expect(text).toContain(`work #${work.rows[0].id} — ${MARK} shipped the bridge`);
    expect(text).toContain(`${ART} ${VER} — ${MARK} published v2`);
    expect(text).toContain(`inbox #${inbox.rows[0].id} — ${MARK} 3h in metistry`);
    // pending, denied, still-open and the fold's own output never reach the brief
    expect(text).not.toContain("still pending");
    expect(text).not.toContain("denied");
    expect(text).not.toContain("still open");
    expect(text).not.toContain("the fold's own proposal");

    const anchor = await pool.query(
      `SELECT meta FROM runs WHERE component = $1 AND kind = 'routine_run' AND ok AND meta->>'folded' = 'true' ORDER BY ts DESC LIMIT 1`,
      [COMPONENT],
    );
    expect(anchor.rows[0].meta).toMatchObject({ folded: true, thread: "fold", inbound_id: Number(rows[0].id) });
    expect(Number(anchor.rows[0].meta.items)).toBeGreaterThanOrEqual(5);

    // second pass: the anchor has moved past everything above
    const second = await knowledgeFold(pool, { now: eveningAfter() });
    const after = await pool.query(`SELECT text FROM inbound_messages WHERE thread = 'fold' ORDER BY id DESC LIMIT 1`);
    if (second === 0) {
      expect(after.rows).toHaveLength(1); // nothing new, nothing enqueued
    } else {
      // another suite's row landed in the seconds between the two passes; the
      // point still holds — this fold's own material is not folded twice
      expect(String(after.rows[0].text)).not.toContain(MARK);
    }
  });
});
