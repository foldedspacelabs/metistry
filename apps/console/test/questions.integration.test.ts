// Questions v2 and both report names (T2-3; plan §2.12, screen 3 §12.3, C104,
// C105), end to end through the real console and the real brain on /mcp.
//
// An agent asks several questions in one request with `requests_create` kind
// `question` (no new tool); the owner answers each from Needs You, with an
// option or — where the question takes it — their own words as `other`; the
// row stores the answers per question. And the decisions a row may record are
// F-5's table's, read from the stored row: `decideProposal` builds no option
// list of its own, so a report cannot be approved.
//
// The bold tests of the ticket, by name: an answer outside the options without
// `other` is refused; free text never executes; a report cannot take `allow`;
// the tool-surface check holds (the count here; the token ratchet is
// packages/mcp-brain/test/brain.test.ts and ops/scripts/check-tool-surface.mjs).
// Plus the door's misuse tests (U2).
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };

describe.skipIf(!hasDb)("questions v2 and the table's answers (integration, T2-3)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let cookie: string;
  let captureToken: string;
  const localOwnerToken = mintToken(32);
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const asker = `q2-ask-${suffix}`;
  const enrollee = `q2-enrol-${suffix}`;
  const MARK = `q2-${suffix}`;
  let askerToken: string;
  let nextId = 1;

  const owner = (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie }) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const answer = (id: number, body: Record<string, unknown>) => owner("POST", `/api/proposals/${id}`, body);
  const batch = async (ids: number[], decision: string) => (await (await owner("POST", "/api/proposals/batch", { ids, decision })).json()).results as Record<string, unknown>[];
  const rowOf = async (id: number) => (await pool.query(`SELECT kind, decision, decided_at, feedback, payload, work_id FROM proposals WHERE id = $1`, [id])).rows[0]!;

  /** One tools/call on /mcp as an agent, parsed to { isError, body } like the bridge's own suites. */
  async function tool(token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: any }> {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    });
    const result = (await r.json()).result as { isError?: boolean; content: { type: string; text: string }[] };
    const text = result.content[0]!.text;
    const nl = text.indexOf("\n");
    return { isError: !!result.isError, body: JSON.parse(nl === -1 ? text : text.slice(0, nl)) };
  }

  async function plant(kind: string, payload: Record<string, unknown>, source = asker): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO proposals (ts, kind, source_agent, trust, payload) VALUES (now() - interval '1 minute', $1, $2, 'external', $3::jsonb) RETURNING id`,
      [kind, source, JSON.stringify(payload)],
    );
    return Number(rows[0].id);
  }

  const THREE = [
    { prompt: "Which repo should the fix land in?", options: ["metistry", "metistry-instance"] },
    { prompt: "Which labels apply?", options: ["bug", "docs", "ui"], multi: true },
    { prompt: "Ship it tonight?", options: ["yes", "not yet"], allow_other: false },
  ];
  /** An agent's three-question request, through the one tool every agent holds. */
  async function ask(title: string): Promise<number> {
    const r = await tool(askerToken, "requests_create", { title, body: "The fold drops drafts; I have a patch.", kind: "question", questions: THREE, refs: ["gh:x/y#7"] });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    return Number(r.body.id);
  }

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-q2-${Date.now()}`,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `q2-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "q2-test" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    captureToken = await store.mintOwnerToken(pool, MARK);
    ({ token: askerToken } = await agents.createAgent(pool, { id: asker, display_name: "q2 asker" }));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.query(`DELETE FROM proposals WHERE source_agent = ANY($1::text[])`, [[asker, enrollee]]);
    await pool.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [[asker, enrollee]]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]);
    await pool.end();
  });

  it("a three-question request round-trips: asked by an agent, drawn from the table, answered per question, stored per question", async () => {
    const id = await ask("Three things before I file the fix");

    // the queue serves it with its questions and its answers — the client draws, and keeps no rule of its own
    const queue = await (await owner("GET", "/api/proposals?limit=200")).json();
    const served = (queue.proposals as any[]).find((p) => Number(p.id) === id);
    expect(served.kind).toBe("decision");
    expect(served.request).toMatchObject({
      type: "question",
      word: "question",
      body: "choices",
      primary: { label: "Send Answers", sends: { decision: "answers" } },
      revise: { label: "Revise", sends: { decision: "accept_with_changes" } },
      decline: { label: "Decline", sends: { decision: "deny" } },
      decisions: ["answers", "accept_with_changes", "deny"],
    });
    expect(served.request.questions).toEqual([
      { prompt: "Which repo should the fix land in?", options: ["metistry", "metistry-instance"], multi: false, allow_other: true },
      { prompt: "Which labels apply?", options: ["bug", "docs", "ui"], multi: true, allow_other: true },
      { prompt: "Ship it tonight?", options: ["yes", "not yet"], multi: false, allow_other: false },
    ]);
    expect(served.payload.context).toEqual({ prose: "The fold drops drafts; I have a patch.", refs: ["gh:x/y#7"] });

    const since = queue.cursor as string;
    const sent = await answer(id, { decision: "answers", answers: [{ other: "metistry, then backport" }, { choices: ["ui", "bug"] }, { choices: ["not yet"] }], if_unchanged: { seen_at: served.ts } });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ ok: true });

    const row = await rowOf(id);
    expect(row.decision).toBe("answered");
    expect(row.decided_at).not.toBeNull();
    expect(row.payload.answers).toEqual([{ choices: [], other: "metistry, then backport" }, { choices: ["bug", "ui"] }, { choices: ["not yet"] }]);
    expect(row.feedback).toBe("Which repo should the fix land in? — metistry, then backport; Which labels apply? — bug, ui; Ship it tonight? — not yet");
    // the question itself is untouched: the answers ride beside it
    expect(row.payload.questions).toHaveLength(3);

    // a reconnect learns it was settled, with the answers on the row
    const changed = await (await owner("GET", `/api/proposals?since=${encodeURIComponent(since)}&limit=200`)).json();
    const settled = (changed.proposals as any[]).find((p) => Number(p.id) === id);
    expect(settled).toMatchObject({ decision: "answered", payload: { answers: row.payload.answers } });
    // and answered once: the second is the 409 with the winner
    const again = await answer(id, { decision: "answers", answers: [{ choices: ["metistry"] }, { choices: ["bug"] }, { choices: ["yes"] }] });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ reason: "already_decided", decision: "answered" });
  });

  it("an answer outside the options without `other` is refused — whole, and nothing is written on the row", async () => {
    const id = await ask("Three things, answered badly");
    const refused: [unknown, RegExp][] = [
      [[{ choices: ["metistry-cloud"] }, { choices: ["bug"] }, { choices: ["yes"] }], /answer 1: "metistry-cloud" is not one of this question's options/],
      [[{ choices: ["metistry"] }, { choices: ["bug"] }, { choices: ["tomorrow"] }], /answer 3: "tomorrow" is not one of this question's options, and it takes no answer in other words/],
      [[{ choices: ["metistry"] }, { choices: ["bug"] }, { other: "tomorrow" }], /answer 3: this question takes only its own options/],
      [[{ choices: ["metistry"] }, { choices: ["bug"] }], /a list of 3/],
      [[{ choices: ["metistry", "metistry-instance"] }, { choices: ["bug"] }, { choices: ["yes"] }], /pick one/],
      ["metistry", /a list of 3/],
    ];
    for (const [answers, reason] of refused) {
      const r = await answer(id, { decision: "answers", answers });
      expect(r.status, JSON.stringify(answers)).toBe(400);
      expect((await r.json()).error.message, JSON.stringify(answers)).toMatch(reason);
    }
    // an answer's words go in `other`, never in feedback; answers ride only with `answers`
    expect((await answer(id, { decision: "answers", answers: [{ choices: ["metistry"] }, { choices: ["bug"] }, { choices: ["yes"] }], feedback: "and ship" })).status).toBe(400);
    expect((await answer(id, { decision: "deny", answers: [] })).status).toBe(400);
    // the v1 wire answers ONE pick-one question, never three
    expect((await answer(id, { decision: "metistry" })).status).toBe(400);
    const row = await rowOf(id);
    expect(row.decision).toBe("pending");
    expect(row.payload.answers).toBeUndefined();
    expect(row.payload.error).toBeUndefined(); // a malformed answer is not a failed consequence (C45): nothing failed
  });

  it("free text never executes: `other` is words on the row — not a verb, not an option, not an enrolment", async () => {
    // an agent's question answered with words that spell verbs: recorded, and nothing else happens
    const id = await ask("Three things, in my own words");
    const r = await answer(id, { decision: "answers", answers: [{ other: "allow" }, { other: "accept_as_work" }, { choices: ["yes"] }] });
    expect(r.status).toBe(200);
    const row = await rowOf(id);
    expect(row).toMatchObject({ decision: "answered", work_id: null });
    expect(row.payload.answers).toEqual([{ choices: [], other: "allow" }, { choices: [], other: "accept_as_work" }, { choices: ["yes"] }]);
    expect(row.payload.result).toBeUndefined();

    // the one question whose answer DOES something — an enrolment's `approve` —
    // is never approved by words, even on a row planted to take them
    await agents.createAgent(pool, { id: enrollee, display_name: "q2 enrolee", remote: true });
    const approvedAt = async () => (await pool.query(`SELECT approved_at, revoked_at FROM agents WHERE id = $1`, [enrollee])).rows[0]!;
    const planted = await plant("decision", {
      title: `Let ${enrollee} in?`,
      questions: [{ prompt: `Let ${enrollee} in?`, options: ["approve", "deny"], multi: false, allow_other: true }],
      enroll: { agent: enrollee },
    });
    expect((await answer(planted, { decision: "answers", answers: [{ other: "approve" }] })).status).toBe(200);
    expect(await approvedAt()).toMatchObject({ approved_at: null, revoked_at: null });
    expect((await rowOf(planted)).decision).toBe("answered");

    // the console's own enrolment question takes only its options (v1: no Something else…)
    const enrolment = (await agents.enrollmentProposal(pool, { id: enrollee, display_name: "q2 enrolee" }))!;
    const words = await answer(enrolment, { decision: "answers", answers: [{ other: "approve" }] });
    expect(words.status).toBe(400);
    expect((await words.json()).error.message).toMatch(/takes only its own options/);
    expect((await answer(enrolment, { decision: "accept_with_changes", feedback: "later maybe" })).status).toBe(400); // Revise has nothing to change on it
    expect(await approvedAt()).toMatchObject({ approved_at: null });
    // …and its option `approve`, by either wire, is the one answer that lets it in
    const approved = await answer(enrolment, { decision: "answers", answers: [{ choices: ["approve"] }] });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ enrolled: { agent: enrollee, approved: true } });
    expect((await approvedAt()).approved_at).not.toBeNull();
    expect(await rowOf(enrolment)).toMatchObject({ decision: "approve", feedback: null }); // what the registry pane's settling stores too — and no words
    expect((await rowOf(enrolment)).payload.answers).toEqual([{ choices: ["approve"] }]);

    // its option `deny` is Decline: it revokes, and stores no "reason" the weekly review would quote
    const again = (await agents.enrollmentProposal(pool, { id: enrollee, display_name: "q2 enrolee" }))!;
    expect((await answer(again, { decision: "answers", answers: [{ choices: ["deny"] }] })).status).toBe(200);
    expect((await approvedAt()).revoked_at).not.toBeNull();
    expect(await rowOf(again)).toMatchObject({ decision: "deny", feedback: null });
  });

  it("a report cannot take `allow` — nor Approve as Work, Revise or Decline: it is Dismissed (`skip`), and acted on at its own door", async () => {
    const id = await plant("report", { title: "Nightly fold finished", body: "12 pages touched", kind: "finding", suggested_work: { title: "look into the two skipped pages" } });
    const served = ((await (await owner("GET", "/api/proposals?limit=200")).json()).proposals as any[]).find((p) => Number(p.id) === id);
    expect(served.request).toMatchObject({ type: "report", primary: { label: null, sends: { door: "act" } }, revise: null, decline: { label: "Dismiss", sends: { decision: "skip" } }, decisions: ["skip"] });
    for (const decision of ["allow", "accept_as_work", "accept_with_changes", "deny", "answers", "approve"]) {
      const r = await answer(id, { decision, feedback: "x" });
      expect(r.status, decision).toBe(400);
      expect((await r.json()).error.message, decision).toMatch(/this report takes skip \| later/);
    }
    expect(await batch([id], "deny")).toEqual([expect.objectContaining({ id, ok: false, error: expect.objectContaining({ code: "invalid_request" }) })]);
    expect(await rowOf(id)).toMatchObject({ decision: "pending", work_id: null });
    // Later and Dismiss are its answers
    expect((await answer(id, { decision: "later" })).status).toBe(200);
    expect((await answer(id, { decision: "skip" })).status).toBe(200);
    expect(await rowOf(id)).toMatchObject({ decision: "deny", feedback: "skipped", work_id: null });
  });

  it("Skip is bulk-only (K2): a single row takes it only as its type's Decline; the batch reaches every row", async () => {
    const note = await plant("knowledge", { title: "a note to put down" });
    const single = await answer(note, { decision: "skip" });
    expect(single.status).toBe(400);
    expect((await single.json()).error.message).toMatch(/^Skip is bulk-only \(K2\) — POST \/api\/proposals\/batch\. this note takes allow \| accept_with_changes \| deny \| later$/);
    expect(await batch([note], "skip")).toEqual([expect.objectContaining({ id: note, ok: true })]);
    expect(await rowOf(note)).toMatchObject({ decision: "deny", feedback: "skipped" });
  });

  it("Revise on a question is accept_with_changes, in words; Decline is deny; a question with nothing to answer has no Send Answers", async () => {
    const revised = await ask("Three wrong questions");
    expect((await answer(revised, { decision: "accept_with_changes", feedback: "these are the wrong questions — ask about the migration" })).status).toBe(200);
    expect(await rowOf(revised)).toMatchObject({ decision: "accept_with_changes", feedback: "these are the wrong questions — ask about the migration" });
    expect((await rowOf(revised)).payload.answers).toBeUndefined();

    const declined = await ask("Three unwanted questions");
    expect((await answer(declined, { decision: "deny", feedback: "not now" })).status).toBe(200);
    expect(await rowOf(declined)).toMatchObject({ decision: "deny", feedback: "not now" });

    // a v2 row with ONE pick-one question still takes v1's wire, the option itself
    const single = await plant("decision", { title: "Which repo?", questions: [{ prompt: "Which repo?", options: ["metistry", "metistry-instance"], multi: false, allow_other: true }] });
    expect((await answer(single, { decision: "metistry-instance" })).status).toBe(200);
    expect(await rowOf(single)).toMatchObject({ decision: "answered", feedback: "metistry-instance", payload: { answers: [{ choices: ["metistry-instance"] }] } });

    const empty = await plant("decision", { title: "Enrol this agent?" });
    const r = await answer(empty, { decision: "answers", answers: [] });
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toBe("this question takes accept_with_changes | deny | later");
  });

  it("answers on anything but a question are refused — the table, not the request, says what a row takes", async () => {
    const note = await plant("knowledge", { title: "a note", questions: THREE });
    const r = await answer(note, { decision: "answers", answers: [{ choices: ["metistry"] }, { choices: ["bug"] }, { choices: ["yes"] }] });
    expect(r.status).toBe(400);
    expect((await rowOf(note)).decision).toBe("pending");
  });

  it("the tool-surface check holds: asking is `requests_create`, and no tool was added", async () => {
    const list = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${askerToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} }),
    });
    const tools: { name: string; inputSchema: { properties: Record<string, any> } }[] = (await list.json()).result.tools;
    expect(tools.map((t) => t.name).filter((n) => /(^|_)(questions?|ask|answers?|decide|triage|proposals?)(_|$)/.test(n))).toEqual([]);
    const create = tools.find((t) => t.name === "requests_create")!;
    // …and a review is asked the same way, the PR in `refs` (T2-13) — still no new tool, and no new property
    expect(create.inputSchema.properties.kind.enum).toEqual(["finding", "decided", "decision", "gotcha", "progress", "question", "pull_request"]);
    expect(Object.keys(create.inputSchema.properties)).toContain("questions");
  });

  describe("U2 — the answer door refuses every credential but the owner's", () => {
    const body = { decision: "answers", answers: [{ choices: ["metistry"] }, { choices: ["bug"] }, { choices: ["yes"] }] };

    it("401 with no credential, and nothing is answered", async () => {
      const id = await ask("U2 no credential");
      expect((await owner("POST", `/api/proposals/${id}`, body, {})).status).toBe(401);
      expect((await rowOf(id)).decision).toBe("pending");
    });

    it("403 for an agent bearer — an agent cannot answer its own question", async () => {
      const id = await ask("U2 agent bearer");
      expect((await owner("POST", `/api/proposals/${id}`, body, { authorization: `Bearer ${askerToken}` })).status).toBe(403);
      expect((await rowOf(id)).decision).toBe("pending");
    });

    it("403 for the capture owner token", async () => {
      const id = await ask("U2 capture token");
      expect((await owner("POST", `/api/proposals/${id}`, body, { authorization: `Bearer ${captureToken}` })).status).toBe(403);
      expect((await rowOf(id)).decision).toBe("pending");
    });

    it("the local owner token reaches it", async () => {
      const id = await ask("U2 local owner");
      expect((await owner("POST", `/api/proposals/${id}`, body, { authorization: `Bearer ${localOwnerToken}` })).status).toBe(200);
      expect((await rowOf(id)).decision).toBe("answered");
    });
  });
});
