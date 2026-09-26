// The four Taskuary adopts that land in the console
// (docs/research/2026-09-16-taskuary-review.md §5 — ADOPT 1 timeline, 2
// approve-as-work, 3 decide-time staleness, 5 later/skip + batch).
//
// Misuse first, as everywhere else in this tree: the interesting property of
// each of these is what it REFUSES. `accept_as_work` on a row that carries no
// suggestion; a decision answered against a version of the row that has since
// moved; a batch verb that would fire a per-kind consequence; `skip`'s
// feedback reaching a path that carries a decline's words somewhere.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken, SKIP_FEEDBACK } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer, parseSeenAt, suggestedWorkOf } from "../src/server.js";
import * as store from "../src/auth-store.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };

// ---- pure: what the server will build a work row from -----------------------------

describe("suggestedWorkOf (pure, misuse)", () => {
  const ok = { kind: "knowledge", payload: { suggested_work: { title: "renew the cert" } } };

  it("reads a well-formed suggestion off knowledge and report proposals only", () => {
    expect(suggestedWorkOf(ok)).toEqual({ title: "renew the cert" });
    expect(suggestedWorkOf({ kind: "report", payload: { suggested_work: { title: "x" } } })).toEqual({ title: "x" });
    // an `improvement` allow writes the prompt overlay and a `decision` answers a
    // question: neither may grow a second, silent consequence
    for (const kind of ["improvement", "decision", "grant_elevation", "review", "draft_settle"]) {
      expect(suggestedWorkOf({ kind, payload: { suggested_work: { title: "x" } } }), kind).toBeUndefined();
    }
  });

  it("refuses anything that is not a title, and anything that would INVENT a field", () => {
    for (const sw of [undefined, null, "renew the cert", ["renew"], {}, { title: "" }, { title: "   " }, { title: 7 }, { title: "x".repeat(501) }]) {
      expect(suggestedWorkOf({ kind: "knowledge", payload: { suggested_work: sw } }), JSON.stringify(sw)).toBeUndefined();
    }
    // an unknown `kind` is a refusal, never a silent fallback to `task`
    expect(suggestedWorkOf({ kind: "knowledge", payload: { suggested_work: { title: "x", kind: "issue" } } })).toBeUndefined();
    expect(suggestedWorkOf({ kind: "knowledge", payload: { suggested_work: { title: "x", kind: "review" } } })).toEqual({ title: "x", kind: "review" });
    // a project that is not a slug is DROPPED, not passed on: accepting must not create a project
    expect(suggestedWorkOf({ kind: "knowledge", payload: { suggested_work: { title: "x", project: "Some Project" } } })).toEqual({ title: "x" });
    expect(suggestedWorkOf({ kind: "knowledge", payload: { suggested_work: { title: "x", project: "metistry" } } })).toEqual({ title: "x", project: "metistry" });
  });
});

describe("parseSeenAt (pure, misuse)", () => {
  it("takes the `ts` this server serialises and the cursor it mints, and nothing else", () => {
    expect(parseSeenAt("2026-09-16T00:00:00.001Z")?.toISOString()).toBe("2026-09-16T00:00:00.001Z");
    expect(parseSeenAt("2026-09-16 00:00:00.001+00")?.toISOString()).toBe("2026-09-16T00:00:00.001Z");
    expect(parseSeenAt("2026-09-16 00:00:00.001+00|42")?.toISOString()).toBe("2026-09-16T00:00:00.001Z"); // the list cursor
    for (const bad of [undefined, null, 7, "", "yesterday", "now()", "2026-09-16", "'; DROP TABLE proposals; --"]) {
      expect(parseSeenAt(bad), String(bad)).toBeNull();
    }
  });
});

// ---- the live server --------------------------------------------------------------

describe.skipIf(!hasDb)("Taskuary adopts (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let cookie: string;
  let ownerToken: string;
  let dir: string;

  const json = (method: string, path: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** One pending proposal, with whatever payload the case needs. */
  async function propose(kind: string, payload: Record<string, unknown>): Promise<{ id: number; ts: string }> {
    const { rows } = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ($1, 'tq-test', 'user', $2::jsonb) RETURNING id, ts`,
      [kind, JSON.stringify(payload)],
    );
    return { id: Number(rows[0].id), ts: (rows[0].ts as Date).toISOString() };
  }

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    dir = await mkdtemp(join(tmpdir(), "metistry-tq-"));
    const queries = new QueryStore(pool);
    await queries.loadDir(new URL("../../../seed/queries", import.meta.url).pathname);
    server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: join(dir, "inbox"),
      policy,
      secureCookies: false,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `tq-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "tq-test" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, "tq-test");
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  });

  // ---- ADOPT 2: the click is what creates the row ---------------------------------

  it("accept_as_work creates exactly ONE owner-less, unclaimed row, links it, and allows the proposal", async () => {
    const p = await propose("knowledge", { suggested_work: { title: "renew the wildcard cert" }, classification: { kind: "todo" } });
    const r = await json("POST", `/api/proposals/${p.id}`, { decision: "accept_as_work" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.work.title).toBe("renew the wildcard cert");

    const work = await pool.query(`SELECT id, title, owner, claimed_by, status, kind, created_by FROM work WHERE id = $1`, [body.work.id]);
    // owner-less and unclaimed: any agent may take it (collaboration rule 4).
    // Addressing it to somebody would be a second decision nobody made.
    expect(work.rows[0]).toMatchObject({ owner: null, claimed_by: null, status: "open", kind: "task", created_by: "user" });

    const after = await pool.query(`SELECT decision, work_id FROM proposals WHERE id = $1`, [p.id]);
    expect(after.rows[0].decision).toBe("allow");
    expect(Number(after.rows[0].work_id)).toBe(body.work.id);

    // EXACTLY one: the idempotency key is the proposal, so a re-post cannot make a second
    const all = await pool.query(`SELECT count(*) AS n FROM work WHERE idempotency_key = $1`, [`proposal:${p.id}`]);
    expect(Number(all.rows[0].n)).toBe(1);
    // and the second answer is the 409, not a second row
    expect((await json("POST", `/api/proposals/${p.id}`, { decision: "accept_as_work" })).status).toBe(409);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM work WHERE idempotency_key = $1`, [`proposal:${p.id}`])).rows[0].n)).toBe(1);
  });

  it("accept_as_work is refused where the row carries no suggestion — the verb comes from the STORED payload", async () => {
    const bare = await propose("knowledge", { classification: { kind: "note" } });
    expect((await json("POST", `/api/proposals/${bare.id}`, { decision: "accept_as_work" })).status).toBe(400);
    // an improvement carrying a suggestion someone planted is still refused
    const planted = await propose("improvement", { suggested_work: { title: "rewrite the prompt" } });
    expect((await json("POST", `/api/proposals/${planted.id}`, { decision: "accept_as_work" })).status).toBe(400);
    expect((await pool.query(`SELECT count(*) AS n FROM work WHERE title = 'rewrite the prompt'`)).rows[0].n).toBe("0");
    // both are still pending: a refused verb decides nothing
    for (const p of [bare, planted]) {
      expect((await pool.query(`SELECT decision FROM proposals WHERE id = $1`, [p.id])).rows[0].decision).toBe("pending");
    }
  });

  // ---- ADOPT 3: decide-time staleness ---------------------------------------------

  it("if_unchanged: a proposal that moved after the client rendered it answers 409 stale, with the current row", async () => {
    // Backdated: every fixture in this file stays in the PAST. A row with a
    // `ts` in the future would sit ahead of the `since` cursor every other
    // test in this database mints, and quietly hide their rows from them.
    const { rows: made } = await pool.query(
      `INSERT INTO proposals (ts, kind, source_agent, trust, payload)
       VALUES (now() - interval '1 hour', 'knowledge', 'tq-test', 'user', '{"title":"before"}'::jsonb) RETURNING id, ts`,
    );
    const p = { id: Number(made[0].id), ts: (made[0].ts as Date).toISOString() };
    const seenAt = p.ts;
    // the payload is rewritten after the client painted it (a re-drain, a crew
    // revising its own report) — a proposal has no `updated_at`, so the row's
    // own `ts` moving is what says it changed
    await pool.query(`UPDATE proposals SET ts = now() - interval '1 minute', payload = '{"title":"after"}'::jsonb WHERE id = $1`, [p.id]);
    const r = await json("POST", `/api/proposals/${p.id}`, { decision: "allow", if_unchanged: { seen_at: seenAt } });
    expect(r.status).toBe(409);
    const body = await r.json();
    // the SAME envelope as `already decided` (#132), told apart by `reason`
    expect(body).toMatchObject({ error: { code: "conflict" }, reason: "stale", decision: "pending" });
    expect(body.proposal.payload.title).toBe("after"); // the current row, so the client can repaint
    expect((await pool.query(`SELECT decision FROM proposals WHERE id = $1`, [p.id])).rows[0].decision).toBe("pending");

    // re-read and answer against what it says NOW: accepted
    const now = body.proposal.ts;
    expect((await json("POST", `/api/proposals/${p.id}`, { decision: "allow", if_unchanged: { seen_at: now } })).status).toBe(200);
  });

  it("if_unchanged: a linked work row moving counts as movement; a junk seen_at is a 400, never a decision", async () => {
    const { rows } = await pool.query(`INSERT INTO work (title, kind, status) VALUES ('tq linked', 'task', 'open') RETURNING id`);
    const workId = Number(rows[0].id);
    const p = await propose("report", { title: "about that work row" });
    await pool.query(`UPDATE proposals SET work_id = $2 WHERE id = $1`, [p.id, workId]);
    const seenAt = new Date(Date.now() - 60_000).toISOString();
    await pool.query(`UPDATE work SET updated_at = now() WHERE id = $1`, [workId]);
    const r = await json("POST", `/api/proposals/${p.id}`, { decision: "allow", if_unchanged: { seen_at: seenAt } });
    expect(r.status).toBe(409);
    expect((await r.json()).reason).toBe("stale");

    const bad = await json("POST", `/api/proposals/${p.id}`, { decision: "allow", if_unchanged: { seen_at: "yesterday" } });
    expect(bad.status).toBe(400);
    expect((await pool.query(`SELECT decision FROM proposals WHERE id = $1`, [p.id])).rows[0].decision).toBe("pending");
    // omitting it entirely is the old behaviour, unchanged
    expect((await json("POST", `/api/proposals/${p.id}`, { decision: "allow" })).status).toBe(200);
  });

  // ---- ADOPT 5: later / skip ------------------------------------------------------

  it("later hides the row from the queue WITHOUT deciding it, and it comes back by itself", async () => {
    const p = await propose("knowledge", { title: "not right now" });
    const before = await (await json("GET", "/api/proposals")).json();
    expect(before.proposals.some((q: { id: number | string }) => Number(q.id) === p.id)).toBe(true);

    const r = await json("POST", `/api/proposals/${p.id}`, { decision: "later" });
    expect(r.status).toBe(200);
    expect((await r.json()).snoozed_until).toBeTruthy();

    const row = (await pool.query(`SELECT decision, decided_at, snoozed_until FROM proposals WHERE id = $1`, [p.id])).rows[0];
    expect(row.decision).toBe("pending"); // a later NEVER ends a proposal
    expect(row.decided_at).toBeNull();
    expect(row.snoozed_until).not.toBeNull();

    const hidden = await (await json("GET", "/api/proposals")).json();
    expect(hidden.proposals.some((q: { id: number | string }) => Number(q.id) === p.id)).toBe(false);

    // the clock runs out (the only thing that brings it back — there is no un-snooze verb)
    await pool.query(`UPDATE proposals SET snoozed_until = now() - interval '1 minute' WHERE id = $1`, [p.id]);
    const back = await (await json("GET", "/api/proposals")).json();
    expect(back.proposals.some((q: { id: number | string }) => Number(q.id) === p.id)).toBe(true);
    // and it is answerable exactly as before
    expect((await json("POST", `/api/proposals/${p.id}`, { decision: "allow" })).status).toBe(200);
  });

  it("skip stores a deny whose feedback is the marker — and the weekly review's reason line will not carry it", async () => {
    const p = await propose("knowledge", { title: "nothing to learn here" });
    expect((await json("POST", `/api/proposals/${p.id}`, { decision: "skip", feedback: "ignore me" })).status).toBe(200);
    const row = (await pool.query(`SELECT decision, feedback FROM proposals WHERE id = $1`, [p.id])).rows[0];
    expect(row.decision).toBe("deny");
    // the user's own words are NOT kept: a skip is putting something down, not a judgement
    expect(row.feedback).toBe(SKIP_FEEDBACK);

    // deny, by contrast, keeps the reason — that is the difference
    const q = await propose("knowledge", { title: "declined with a reason" });
    expect((await json("POST", `/api/proposals/${q.id}`, { decision: "deny", feedback: "wrong area" })).status).toBe(200);
    expect((await pool.query(`SELECT feedback FROM proposals WHERE id = $1`, [q.id])).rows[0].feedback).toBe("wrong area");

    // the one query that carries a decline's words anywhere excludes the marker
    const reasons = await pool.query(
      `SELECT feedback FROM proposals
       WHERE decision IN ('deny','accept_with_changes') AND decided_at > now() - interval '7 days'
         AND feedback IS NOT NULL AND feedback <> '' AND feedback <> $1`,
      [SKIP_FEEDBACK],
    );
    expect(reasons.rows.map((r) => r.feedback)).toContain("wrong area");
    expect(reasons.rows.map((r) => r.feedback)).not.toContain(SKIP_FEEDBACK);
  });

  it("skip fires NONE of deny's per-kind consequences: an enrolment request skipped does not revoke the agent", async () => {
    const agentId = `tq-enrol-${mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "")}`;
    await pool.query(`INSERT INTO agents (id, display_name, kind, token_hash) VALUES ($1, $1, 'external', $2)`, [agentId, `${agentId}-hash`]);
    const p = await propose("decision", { title: "let it in?", options: ["approve", "deny"], enroll: { agent: agentId } });
    expect((await json("POST", `/api/proposals/${p.id}`, { decision: "skip" })).status).toBe(200);
    const a = (await pool.query(`SELECT revoked_at FROM agents WHERE id = $1`, [agentId])).rows[0];
    expect(a.revoked_at).toBeNull(); // deny would have revoked it; skip is not deny
  });

  // ---- ADOPT 5: the batch ---------------------------------------------------------

  it("batch applies one verb to many, all-or-nothing PER ROW, with a result for each", async () => {
    const a = await propose("knowledge", { title: "batch a" });
    const b = await propose("knowledge", { title: "batch b" });
    const c = await propose("knowledge", { title: "batch c" });
    // c is answered from "another device" first: it must not take the rest down with it
    expect((await json("POST", `/api/proposals/${c.id}`, { decision: "allow" })).status).toBe(200);

    const r = await json("POST", "/api/proposals/batch", { ids: [a.id, b.id, c.id, 999_999_999], decision: "skip" });
    expect(r.status).toBe(200);
    const { results } = await r.json();
    expect(results.map((x: { id: number; ok: boolean }) => [x.id, x.ok])).toEqual([
      [a.id, true],
      [b.id, true],
      [c.id, false],
      [999_999_999, false],
    ]);
    expect(results[2].reason).toBe("already_decided");
    expect(results[3].error.code).toBe("not_found");
    // the two that applied, applied fully
    const rows = await pool.query(`SELECT id, decision, feedback FROM proposals WHERE id = ANY($1::bigint[]) ORDER BY id`, [[a.id, b.id]]);
    expect(rows.rows.every((x) => x.decision === "deny" && x.feedback === SKIP_FEEDBACK)).toBe(true);
  });

  it("batch refuses the verbs that DO something per kind, and anything that is not a list of ids", async () => {
    const p = await propose("knowledge", { suggested_work: { title: "would have been a task" } });
    for (const decision of ["allow", "accept_with_changes", "accept_as_work", "approve", "yolo", 7, undefined]) {
      const r = await json("POST", "/api/proposals/batch", { ids: [p.id], decision });
      expect(r.status, String(decision)).toBe(400);
    }
    for (const ids of [[], "1,2", [0], [-1], ["1"], [1.5], Array.from({ length: 101 }, (_, i) => i + 1)]) {
      expect((await json("POST", "/api/proposals/batch", { ids, decision: "skip" })).status, JSON.stringify(ids)).toBe(400);
    }
    expect((await pool.query(`SELECT decision FROM proposals WHERE id = $1`, [p.id])).rows[0].decision).toBe("pending");
    expect((await pool.query(`SELECT count(*) AS n FROM work WHERE title = 'would have been a task'`)).rows[0].n).toBe("0");
  });

  it("batch is management: an owner token is the uniform 403, never a 404 that hides the route", async () => {
    const r = await fetch(`${base}/api/proposals/batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ids: [1], decision: "skip" }),
    });
    expect(r.status).toBe(403);
  });

  // ---- ADOPT 1: the timeline, through the named query ------------------------------

  it("the timeline carries a capture the instant it lands — before any drain has seen it", async () => {
    const tag = `tq-cap-${Date.now()}`;
    await pool.query(`INSERT INTO inbox (source, path, note, status) VALUES ('http', $1, $2, 'new')`, [
      `Inbox/${tag}.md`,
      `call the dentist\nand the vet`,
    ]);
    const { rows } = await (await json("GET", "/api/q/activity_feed?hours=1&limit=200&kind=capture")).json();
    const row = rows.find((r: { ref: string }) => String(r.detail).startsWith("http")) as Record<string, string>;
    expect(row).toBeDefined();
    expect(row.kind).toBe("capture");
    expect(row.group).toBe("capture");
    expect(rows.every((r: { kind: string }) => r.kind === "capture")).toBe(true); // the chip filters
    expect(rows.some((r: { subject: string }) => r.subject === "call the dentist")).toBe(true);
    expect(rows.some((r: { detail: string }) => r.detail === "http · new")).toBe(true); // the "triaging" pill
  });
});
