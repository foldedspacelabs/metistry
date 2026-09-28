// A report is acknowledged; an agent reads its answer (X-10 — ruling 8 of
// 2026-09-27; plan §2.12, T2-3), end to end through the real console and the
// real brain on /mcp.
//
// T2-3 made a report unapprovable, which left it Dismiss alone and left
// knowledge-fold — which folds decided reports — with nothing to read. A
// report that names no act is now answered **Acknowledge**, stored as its own
// word (`acknowledged`, never `allow`), and the fold reads that
// (routines/test/knowledge-fold.integration.test.ts proves the fold's SQL
// against it). And an agent that asked had no way to learn the answer: now a
// replay of `requests_create` — no new tool — reads back where the owner's
// answer stands, for the caller's own request and never another agent's.
//
// The bold tests of the ticket, by name: an acknowledged report is read by the
// fold (stored here as the fold reads it; the fold's own suite reads it); an
// agent reads its own question's answer and is refused another's. Plus the
// answer door's misuse tests for the new decision (U2).
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { ACKNOWLEDGED, mintToken } from "@foldedspacelabs/metistry-core";
import { readBack } from "@foldedspacelabs/metistry-mcp-brain";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };

describe.skipIf(!hasDb)("a report is acknowledged; an agent reads its answer (integration, X-10)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let cookie: string;
  let captureToken: string;
  const localOwnerToken = mintToken(32);
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const asker = `x10-ask-${suffix}`;
  const other = `x10-other-${suffix}`;
  const MARK = `x10-${suffix}`;
  let askerToken: string;
  let otherToken: string;
  let nextId = 1;

  const owner = (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie }) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const answer = (id: number, body: Record<string, unknown>) => owner("POST", `/api/proposals/${id}`, body);
  const rowOf = async (id: number) => (await pool.query(`SELECT kind, source_agent, decision, decided_at, feedback, payload FROM proposals WHERE id = $1`, [id])).rows[0]!;
  const served = async (id: number) => ((await (await owner("GET", "/api/proposals?limit=200")).json()).proposals as any[]).find((p) => Number(p.id) === id);

  /** One tools/call on /mcp as an agent, parsed to { isError, body } like the bridge's own suites. */
  async function tool(token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: any; text: string }> {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    });
    const result = (await r.json()).result as { isError?: boolean; content: { type: string; text: string }[] };
    const text = result.content[0]!.text;
    const nl = text.indexOf("\n");
    return { isError: !!result.isError, body: JSON.parse(nl === -1 ? text : text.slice(0, nl)), text };
  }

  async function plant(kind: string, payload: Record<string, unknown>, source = asker): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO proposals (ts, kind, source_agent, trust, payload) VALUES (now() - interval '1 minute', $1, $2, 'external', $3::jsonb) RETURNING id`,
      [kind, source, JSON.stringify(payload)],
    );
    return Number(rows[0].id);
  }

  const report = (token: string, title: string, key?: string) =>
    tool(token, "requests_create", { title, body: "The fold drops drafts older than a week.", kind: "finding", ...(key ? { idempotency_key: key } : {}) });

  const TWO = [
    { prompt: "Which repo should the fix land in?", options: ["metistry", "metistry-instance"] },
    { prompt: "Which labels apply?", options: ["bug", "docs", "ui"], multi: true },
  ];
  const question = (token: string, title: string, key?: string) =>
    tool(token, "requests_create", { title, body: "I have a patch for the fold.", kind: "question", questions: TWO, ...(key ? { idempotency_key: key } : {}) });

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-x10-${Date.now()}`,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `x10-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "x10-test" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    captureToken = await store.mintOwnerToken(pool, MARK);
    ({ token: askerToken } = await agents.createAgent(pool, { id: asker, display_name: "x10 asker" }));
    ({ token: otherToken } = await agents.createAgent(pool, { id: other, display_name: "x10 other" }));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.query(`DELETE FROM proposals WHERE source_agent = ANY($1::text[])`, [[asker, other]]);
    await pool.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [[asker, other]]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]);
    await pool.end();
  });

  describe("a report is acknowledged", () => {
    it("an agent's report is served Acknowledge beside Dismiss, and Acknowledge stores `acknowledged` — the decision the fold reads — and fires nothing", async () => {
      const r = await report(askerToken, "The fold drops drafts");
      expect(r.isError, JSON.stringify(r.body)).toBe(false);
      const id = Number(r.body.id);

      const row = await served(id);
      expect(row.request).toMatchObject({
        type: "report",
        body: "excerpt",
        primary: { label: "Acknowledge", sends: { decision: "acknowledge" } },
        revise: null,
        decline: { label: "Dismiss", sends: { decision: "skip" } },
        decisions: ["acknowledge", "skip"],
      });

      const sent = await answer(id, { decision: "acknowledge", if_unchanged: { seen_at: row.ts } });
      expect(sent.status).toBe(200);
      expect(await sent.json()).toEqual({ ok: true }); // nothing applied, granted, built or acted on
      const settled = await rowOf(id);
      expect(settled).toMatchObject({ kind: "report", decision: ACKNOWLEDGED, feedback: null });
      expect(settled.decision).toBe("acknowledged");
      expect(settled.decided_at).not.toBeNull();
      expect(settled.payload.result).toBeUndefined();
      // exactly the shape knowledge-fold's read selects (routines/knowledge-fold/run.ts)
      const folded = await pool.query(
        `SELECT id FROM proposals WHERE id = $1 AND (decision IN ('allow', 'accept_with_changes') OR (kind = 'report' AND decision = $2)) AND kind IN ('knowledge', 'report', 'session', 'review')`,
        [id, ACKNOWLEDGED],
      );
      expect(folded.rows).toHaveLength(1);
      // answered once: the second is the 409 with the winner
      const again = await answer(id, { decision: "skip" });
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ reason: "already_decided", decision: "acknowledged" });
    });

    it("a report that names its act keeps it, and is not acknowledged: an event's Try Again is not a report to fold", async () => {
      const id = await plant("report", { title: "standup failed", body: "exit 1", act: { label: "Try Again", kind: "run_now", component: "standup" } });
      expect((await served(id)).request).toMatchObject({ primary: { label: null, sends: { door: "act" } }, decisions: ["skip"] });
      const r = await answer(id, { decision: "acknowledge" });
      expect(r.status).toBe(400);
      expect((await r.json()).error.message).toBe("this report takes skip | later");
      expect((await rowOf(id)).decision).toBe("pending");
    });

    it("only a report is acknowledged: a note, a question and a kind the table does not know refuse it, and nothing is written", async () => {
      const note = await plant("knowledge", { title: "a note" });
      const q = await plant("decision", { title: "Which repo?", questions: [{ prompt: "Which repo?", options: ["a", "b"], multi: false, allow_other: true }] });
      const unknown = await plant("no_such_kind", { title: "something new" });
      for (const [id, word] of [[note, "note"], [q, "question"], [unknown, "report"]] as const) {
        const r = await answer(id, { decision: "acknowledge" });
        expect(r.status, word).toBe(400);
        expect((await r.json()).error.message, word).toMatch(new RegExp(`^this ${word} takes `));
        expect((await rowOf(id)).decision, word).toBe("pending");
      }
    });

    it("Acknowledge carries no words, and is not a batch verb", async () => {
      const id = await plant("report", { title: "a finding", body: "x", kind: "finding" });
      const r = await answer(id, { decision: "acknowledge", feedback: "thanks, keep going" });
      expect(r.status).toBe(400);
      expect((await r.json()).error.message).toMatch(/^Acknowledge carries no words/);
      const b = await owner("POST", "/api/proposals/batch", { ids: [id], decision: "acknowledge" });
      expect(b.status).toBe(400);
      expect(await rowOf(id)).toMatchObject({ decision: "pending", feedback: null });
    });

    it("an agent reads back that its report was acknowledged — or dismissed — by replaying it", async () => {
      const kept = await report(askerToken, "A finding to keep", `${MARK}-kept`);
      const dropped = await report(askerToken, "A finding to drop", `${MARK}-dropped`);
      expect((await answer(Number(kept.body.id), { decision: "acknowledge" })).status).toBe(200);
      expect((await answer(Number(dropped.body.id), { decision: "skip" })).status).toBe(200);
      const k = await report(askerToken, "A finding to keep", `${MARK}-kept`);
      expect(k.body).toMatchObject({ id: Number(kept.body.id), deduplicated: "idempotency_key", answer: { state: "acknowledged" } });
      const d = await report(askerToken, "A finding to drop", `${MARK}-dropped`);
      expect(d.body).toMatchObject({ id: Number(dropped.body.id), deduplicated: "idempotency_key", answer: { state: "dismissed" } });
      expect(d.body.answer.feedback).toBeUndefined(); // the skip marker is not the owner's words
    });
  });

  describe("an agent reads its own question's answer, and is refused another's", () => {
    it("a new question has no answer yet; its replay says it waits; once answered the replay carries each question's answer", async () => {
      const key = `${MARK}-q1`;
      const first = await question(askerToken, "Two things before I file the fix", key);
      expect(first.isError, JSON.stringify(first.body)).toBe(false);
      expect(first.body).toEqual({ id: expect.any(Number), deduplicated: false });
      const id = Number(first.body.id);

      const waiting = await question(askerToken, "Two things before I file the fix", key);
      expect(waiting.body).toEqual({ id, deduplicated: "idempotency_key", answer: { state: "pending" } });

      expect((await answer(id, { decision: "answers", answers: [{ other: "metistry, then backport" }, { choices: ["ui", "bug"] }] })).status).toBe(200);
      const back = await question(askerToken, "Two things before I file the fix", key);
      expect(back.isError).toBe(false);
      expect(back.body).toEqual({
        id,
        deduplicated: "idempotency_key",
        answer: {
          state: "answered",
          decided_at: expect.any(String),
          answers: [
            { prompt: "Which repo should the fix land in?", choices: [], other: "metistry, then backport" },
            { prompt: "Which labels apply?", choices: ["bug", "ui"] },
          ],
        },
      });
      // the same by title, inside the near-duplicate window
      const byTitle = await question(askerToken, "Two things before I file the fix");
      expect(byTitle.body).toMatchObject({ id, deduplicated: "title", answer: { state: "answered" } });
      // and reading it back wrote nothing: still one row, still answered once
      expect((await pool.query(`SELECT count(*)::int AS n FROM proposals WHERE source_agent = $1 AND payload->>'idempotency_key' = $2`, [asker, key])).rows[0].n).toBe(1);
      expect((await rowOf(id)).decision).toBe("answered");
    });

    it("Revise and Decline read back in the owner's words", async () => {
      const revised = await question(askerToken, "Two wrong questions", `${MARK}-rev`);
      const declined = await question(askerToken, "Two unwanted questions", `${MARK}-dec`);
      expect((await answer(Number(revised.body.id), { decision: "accept_with_changes", feedback: "ask about the migration instead" })).status).toBe(200);
      expect((await answer(Number(declined.body.id), { decision: "deny", feedback: "not this week" })).status).toBe(200);
      expect((await question(askerToken, "Two wrong questions", `${MARK}-rev`)).body.answer).toEqual({ state: "revised", decided_at: expect.any(String), feedback: "ask about the migration instead" });
      expect((await question(askerToken, "Two unwanted questions", `${MARK}-dec`)).body.answer).toEqual({ state: "declined", decided_at: expect.any(String), feedback: "not this week" });
    });

    it("is refused another agent's: echoing its question exactly — key, title, questions — finds nothing of it, and reads none of its answer", async () => {
      const key = `${MARK}-theirs`;
      const title = "Where do the migration notes go?";
      const theirs = await question(askerToken, title, key);
      const theirId = Number(theirs.body.id);
      expect((await answer(theirId, { decision: "answers", answers: [{ other: "the private runbook" }, { choices: ["docs"] }] })).status).toBe(200);

      // the other agent sends the very same call: it is a new request of its own, waiting — never the first agent's row
      const echo = await question(otherToken, title, key);
      expect(echo.isError).toBe(false);
      expect(echo.body).toEqual({ id: expect.any(Number), deduplicated: false });
      expect(Number(echo.body.id)).not.toBe(theirId);
      expect(echo.text).not.toContain("the private runbook");
      expect(await rowOf(Number(echo.body.id))).toMatchObject({ source_agent: other, decision: "pending" });
      // and its replay reads back its own (waiting) row, still not the first agent's answer
      const again = await question(otherToken, title, key);
      expect(again.body).toEqual({ id: Number(echo.body.id), deduplicated: "idempotency_key", answer: { state: "pending" } });
      expect(again.text).not.toContain("the private runbook");

      // the read itself is keyed on the caller: another agent's id is the same null as no row at all
      expect(await readBack(pool, other, theirId)).toBeNull();
      expect(await readBack(pool, other, 2_000_000_000)).toBeNull();
      expect(await readBack(pool, asker, theirId)).toMatchObject({ state: "answered", answers: [{ other: "the private runbook" }, { choices: ["docs"] }] });
      // …and only a report or a question is read back: a row of another kind the caller raised is not
      const access = await plant("access_request", { area: "Areas/Health", reason: "x" });
      expect(await readBack(pool, asker, access)).toBeNull();
    });

    it("the tool surface holds: reading back is requests_create — no tool was added", async () => {
      const list = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${askerToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} }),
      });
      const tools: { name: string; description: string }[] = (await list.json()).result.tools;
      expect(tools.map((t) => t.name).filter((n) => /(^|_)(answers?|read_?back|acknowledge|requests_(get|read|status))(_|$)/.test(n))).toEqual([]);
      expect(tools.find((t) => t.name === "requests_create")!.description).toMatch(/A repeat \(same idempotency_key, or title within 24h\) returns its id and answer\./);
    });
  });

  describe("U2 — Acknowledge reaches the owner and no one else", () => {
    const ack = { decision: "acknowledge" };
    const fresh = () => plant("report", { title: `U2 ${mintToken(4)}`, body: "x", kind: "finding" });

    it("401 with no credential, and nothing is acknowledged", async () => {
      const id = await fresh();
      expect((await owner("POST", `/api/proposals/${id}`, ack, {})).status).toBe(401);
      expect((await rowOf(id)).decision).toBe("pending");
    });

    it("403 for an agent bearer — an agent cannot acknowledge its own report", async () => {
      const id = await fresh();
      expect((await owner("POST", `/api/proposals/${id}`, ack, { authorization: `Bearer ${askerToken}` })).status).toBe(403);
      expect((await rowOf(id)).decision).toBe("pending");
    });

    it("403 for the capture owner token", async () => {
      const id = await fresh();
      expect((await owner("POST", `/api/proposals/${id}`, ack, { authorization: `Bearer ${captureToken}` })).status).toBe(403);
      expect((await rowOf(id)).decision).toBe("pending");
    });

    it("the local owner token reaches it", async () => {
      const id = await fresh();
      expect((await owner("POST", `/api/proposals/${id}`, ack, { authorization: `Bearer ${localOwnerToken}` })).status).toBe(200);
      expect((await rowOf(id)).decision).toBe("acknowledged");
    });
  });
});
