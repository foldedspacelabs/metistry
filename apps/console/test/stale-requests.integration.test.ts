// Stale requests (T2-14; design-build-plan §2.12 *Stale*, design-system
// amendments §9): a card never acts on something the owner didn't see. Every
// row `GET /api/proposals` serves carries `subject` — `{basis, fingerprint}`
// of what the request is about as it stands: a pull request's head, a task's
// line, the work row — and `POST /api/proposals/:id` with
// `if_unchanged.subject` refuses an answer whose fingerprint is no longer the
// subject's: `409 stale`, nothing sent, nothing settled, nothing written.
//
// Over real sockets against the scratch database (docs/ops/testing.md). The
// ticket's own: **each subject change refuses the answer**. Plus U2's four.
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-stale";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const DIR = `Journal/itest-stale-${suffix}`;

type Served = { id: number; kind: string; subject: { basis: string; fingerprint: string } | null } & Record<string, unknown>;

describe.skipIf(!hasDb)("stale requests: the subject an answer was given to", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `${MARK}-${suffix}`;
  const passkeyIds: string[] = [];
  let inboxDir: string;
  let n = 0;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    inboxDir = await mkdtemp(join(tmpdir(), "metistry-stale-"));
    server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest stale" })).token;
  });

  afterAll(async () => {
    const ws = (await pool.query(`SELECT id FROM work WHERE title LIKE $1`, [`${MARK}-${suffix}%`])).rows.map((r) => r.id);
    await pool.query(`DELETE FROM proposals WHERE source_agent = $1 OR work_id = ANY($2::bigint[])`, [MARK, ws]);
    await pool.query(`DELETE FROM work WHERE id = ANY($1::bigint[])`, [ws]);
    await pool.query(`DELETE FROM vault_tasks WHERE path LIKE $1`, [`${DIR}/%`]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    rmSync(inboxDir, { recursive: true, force: true });
  });

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie: sessionCookie }) => {
    const r = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    return { status: r.status, body: text === "" ? null : JSON.parse(text) };
  };
  const answer = (id: number, body: Record<string, unknown>, headers?: Record<string, string>) => call("POST", `/api/proposals/${id}`, body, headers);

  /** The row as the queue serves it now — what a client renders. */
  async function served(id: number): Promise<Served> {
    const r = await call("GET", "/api/proposals?limit=200");
    expect(r.status).toBe(200);
    const row = (r.body.proposals as Served[]).find((p) => Number(p.id) === id); // bigint: pg serves it as a string
    expect(row, `proposal ${id} in the queue`).toBeDefined();
    return row!;
  }

  async function work(label: string, kind: "task" | "pr" | "issue", meta: Record<string, unknown> = {}): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO work (title, kind, status, meta, updated_at) VALUES ($1, $2, 'open', $3::jsonb, now() - interval '1 hour') RETURNING id`,
      [`${MARK}-${suffix} ${label}`, kind, JSON.stringify(meta)],
    );
    return Number(rows[0].id);
  }

  async function plant(kind: string, payload: Record<string, unknown>, workId: number | null = null): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload, work_id) VALUES ($1, $2, 'internal', $3::jsonb, $4) RETURNING id`,
      [kind, MARK, JSON.stringify(payload), workId],
    );
    return Number(rows[0].id);
  }

  /** One `- [ ]` line as the reconciler's walk would index it. */
  async function line(text: string): Promise<{ path: string; task_key: string }> {
    const at = { path: `${DIR}/${++n}.md`, task_key: `mt-st${suffix}${n}` };
    await pool.query(
      `INSERT INTO vault_tasks (path, task_key, anchor, line_no, text, text_norm, checked, parsed_on, first_seen_on, last_seen_at)
       VALUES ($1, $2, $2, 1, $3, lower($3), false, current_date, current_date, now())`,
      [at.path, at.task_key, text],
    );
    return at;
  }

  const stored = async (id: number) => (await pool.query(`SELECT decision, decided_at, snoozed_until, payload FROM proposals WHERE id = $1`, [id])).rows[0];

  /** The ticket's promise, asserted the same way for every subject: refused as stale, the row repainted with the subject as it stands, and NOTHING written on it. */
  async function expectStale(id: number, body: Record<string, unknown>, before: Served) {
    const r = await answer(id, body);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: { code: "conflict" }, reason: "stale", decision: "pending", decided_at: null });
    expect(Number(r.body.proposal.id)).toBe(id);
    expect(r.body.proposal.subject.basis).toBe(before.subject!.basis);
    expect(r.body.proposal.subject.fingerprint).not.toBe(before.subject!.fingerprint);
    for (const col of ["subject_head_sha", "subject_line_text", "subject_work_updated_at", "own_changed_at"]) expect(r.body.proposal).not.toHaveProperty(col);
    const row = await stored(id);
    expect(row).toMatchObject({ decision: "pending", decided_at: null, snoozed_until: null });
    expect(row.payload).not.toHaveProperty("error"); // not C45: the question was not answered, so nothing failed
    return r.body.proposal as Served;
  }

  // ---- what the queue serves ----------------------------------------------------------------

  it("serves every row with its subject as it stands — one basis per type — and never the columns it was read from", async () => {
    const pr = await plant("pull_request", { title: "Fix the parser", head_sha: "a1b2c3" }, await work("pr served", "pr", { head_sha: "a1b2c3" }));
    const task = await plant("task", { title: "call the plumber", task_line: await line("call the plumber") });
    const action = await plant("action", { title: "rename", action: { kind: "comment", args: { work_id: 1, body: "x" } } }, await work("action served", "task"));
    const question = await plant("decision", { question: "which?", options: ["a", "b"] });
    const rows = await Promise.all([pr, task, action, question].map(served));
    expect(rows.map((r) => r.subject?.basis ?? null)).toEqual(["head_sha", "line_text", "work_updated_at", null]);
    for (const r of rows) {
      for (const k of Object.keys(r)) expect(k.startsWith("subject_"), k).toBe(false);
      if (r.subject) expect(r.subject.fingerprint).toMatch(/^[a-z_]+:[0-9a-f]{32}$/);
    }
    // the since form (a reconnect) serves the same subject
    const since = await call("GET", `/api/proposals?since=${encodeURIComponent("1970-01-01 00:00:00+00|0")}&limit=1`);
    expect(since.status).toBe(200);
    for (const p of since.body.proposals as Served[]) expect(p).toHaveProperty("subject");
  });

  // ---- the ticket's own: each subject change refuses the answer --------------------------------

  describe("each subject change refuses the answer", () => {
    it("a pull request whose head moved: refused, and the row now carries the new head's fingerprint", async () => {
      const w = await work("pr head", "pr", { head_sha: "a1b2c3" });
      const id = await plant("pull_request", { title: "Fix the parser", head_sha: "a1b2c3" }, w);
      const before = await served(id);
      await pool.query(`UPDATE work SET meta = meta || '{"head_sha":"d4e5f6"}'::jsonb, updated_at = now() WHERE id = $1`, [w]);
      const now = await expectStale(id, { decision: "later", if_unchanged: { subject: before.subject!.fingerprint } }, before);
      expect(now.subject).toEqual((await served(id)).subject);
      // answered against the head it shows NOW: accepted
      expect((await answer(id, { decision: "later", if_unchanged: { subject: now.subject!.fingerprint } })).status).toBe(200);
    });

    it("a pull request whose head did NOT move is not stale — a comment moves its work row, not the question", async () => {
      const w = await work("pr comment", "pr", { head_sha: "a1b2c3" });
      const id = await plant("pull_request", { title: "Fix the parser", head_sha: "a1b2c3" }, w);
      const before = await served(id);
      await pool.query(`UPDATE work SET meta = meta || '{"comments":3}'::jsonb, updated_at = now() WHERE id = $1`, [w]);
      expect((await answer(id, { decision: "later", if_unchanged: { subject: before.subject!.fingerprint } })).status).toBe(200);
    });

    it("a task whose line was edited, and one whose line was deleted: both refused", async () => {
      const edited = await line("call the plumber");
      const a = await plant("task", { title: "call the plumber", task_line: edited });
      const beforeA = await served(a);
      await pool.query(`UPDATE vault_tasks SET text = 'call the plumber about the boiler' WHERE path = $1 AND task_key = $2`, [edited.path, edited.task_key]);
      await expectStale(a, { decision: "later", if_unchanged: { subject: beforeA.subject!.fingerprint } }, beforeA);

      const gone = await line("book the MOT");
      const b = await plant("task", { title: "book the MOT", task_line: gone });
      const beforeB = await served(b);
      await pool.query(`DELETE FROM vault_tasks WHERE path = $1 AND task_key = $2`, [gone.path, gone.task_key]);
      const now = await expectStale(b, { decision: "later", if_unchanged: { subject: beforeB.subject!.fingerprint } }, beforeB);
      expect(now.subject!.fingerprint).toBe("line_text:gone");
    });

    it("a tracker task whose one line (its work row's title) changed: refused", async () => {
      const w = await work("tracker", "issue");
      const id = await plant("task", { title: "tracker task" }, w);
      const before = await served(id);
      expect(before.subject!.basis).toBe("line_text");
      await pool.query(`UPDATE work SET title = title || ' (renamed)' WHERE id = $1`, [w]);
      await expectStale(id, { decision: "later", if_unchanged: { subject: before.subject!.fingerprint } }, before);
    });

    it("an action whose work row moved: refused BEFORE it runs — nothing sent — and answered again against the row as it is", async () => {
      const w = await work("action", "task");
      const title = `${MARK}-${suffix} action`;
      const id = await plant("action", { title: "rename it", action: { kind: "task_update", args: { work_id: w, patch: { title: `${title} renamed` } } }, reason: "t2-14" }, w);
      const before = await served(id);
      await pool.query(`UPDATE work SET updated_at = now() WHERE id = $1`, [w]); // someone else moved the row
      await expectStale(id, { decision: "allow", if_unchanged: { subject: before.subject!.fingerprint } }, before);
      expect((await pool.query(`SELECT title FROM work WHERE id = $1`, [w])).rows[0].title).toBe(title); // the action never ran
      expect((await stored(id)).payload).not.toHaveProperty("result");

      const again = await served(id);
      const r = await answer(id, { decision: "allow", if_unchanged: { subject: again.subject!.fingerprint } });
      expect(r.status).toBe(200);
      expect((await pool.query(`SELECT title FROM work WHERE id = $1`, [w])).rows[0].title).toBe(`${title} renamed`);
    });

    it("a row that has a subject, answered as if it had none, is stale — and so is the reverse", async () => {
      const id = await plant("action", { title: "comment", action: { kind: "comment", args: { work_id: 1, body: "x" } } }, await work("gained", "task"));
      const before = await served(id);
      const gained = await answer(id, { decision: "later", if_unchanged: { subject: null } });
      expect(gained.status).toBe(409);
      expect(gained.body).toMatchObject({ reason: "stale", proposal: { subject: before.subject } });
      expect(await stored(id)).toMatchObject({ decision: "pending", snoozed_until: null });
      const bare = await plant("knowledge", { title: "no subject" });
      expect((await served(bare)).subject).toBeNull();
      const r = await answer(bare, { decision: "later", if_unchanged: { subject: before.subject!.fingerprint } });
      expect(r.status).toBe(409);
      expect(r.body.reason).toBe("stale");
      expect((await answer(bare, { decision: "later", if_unchanged: { subject: null } })).status).toBe(200);
    });
  });

  // ---- the field itself --------------------------------------------------------------------

  describe("if_unchanged.subject — misuse and the old wire", () => {
    it("a subject this server could not have served is a 400, never a decision", async () => {
      const id = await plant("knowledge", { title: "junk subject" }, await work("junk", "task"));
      for (const subject of ["", "abc123", "work_updated_at:xyz", 42, {}, ["work_updated_at:gone"], true]) {
        const r = await answer(id, { decision: "allow", if_unchanged: { subject } });
        expect(r.status, JSON.stringify(subject)).toBe(400);
        expect(r.body.error.code).toBe("invalid_request");
      }
      for (const ifu of [{}, null, [], "x"]) expect((await answer(id, { decision: "allow", if_unchanged: ifu })).status, JSON.stringify(ifu)).toBe(400);
      expect(await stored(id)).toMatchObject({ decision: "pending", snoozed_until: null });
    });

    it("with a subject, the work row is judged by its fingerprint — a `seen_at` that is the row's `ts` no longer goes stale forever", async () => {
      const w = await work("unstick", "task");
      const id = await plant("knowledge", { title: "about a moved row" }, w);
      await pool.query(`UPDATE proposals SET ts = now() - interval '1 minute' WHERE id = $1`, [id]); // raised a minute ago…
      await pool.query(`UPDATE work SET updated_at = now() WHERE id = $1`, [w]); // moved after the row was raised, before it was rendered
      const row = await served(id);
      const seenAt = String(row.ts);
      // seen_at alone: exactly the old meaning — the work row moved after `ts`
      expect((await answer(id, { decision: "later", if_unchanged: { seen_at: seenAt } })).status).toBe(409);
      // with the subject it was rendered with, the same `ts` answers
      expect((await answer(id, { decision: "later", if_unchanged: { seen_at: seenAt, subject: row.subject!.fingerprint } })).status).toBe(200);
    });

    it("omitting it is the old behaviour, unchanged: opt-in, like seen_at", async () => {
      const w = await work("optin", "task");
      const id = await plant("knowledge", { title: "no if_unchanged" }, w);
      await pool.query(`UPDATE work SET updated_at = now() WHERE id = $1`, [w]);
      expect((await answer(id, { decision: "deny" })).status).toBe(200);
    });
  });

  // ---- U2: the four ------------------------------------------------------------------------

  describe("who may answer (U2)", () => {
    async function subjectRow() {
      const id = await plant("knowledge", { title: "u2" }, await work(`u2 ${++n}`, "task"));
      return { id, fingerprint: (await served(id)).subject!.fingerprint };
    }

    it("no credential is the uniform 401, and the row is untouched", async () => {
      const { id, fingerprint } = await subjectRow();
      const r = await answer(id, { decision: "deny", if_unchanged: { subject: fingerprint } }, {});
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
      expect((await stored(id)).decision).toBe("pending");
    });

    it("an agent bearer is refused 403, and the row is untouched", async () => {
      const { id, fingerprint } = await subjectRow();
      const r = await answer(id, { decision: "deny", if_unchanged: { subject: fingerprint } }, { authorization: `Bearer ${agentToken}` });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
      expect((await stored(id)).decision).toBe("pending");
    });

    it("the capture owner token is refused 403, and the row is untouched", async () => {
      const { id, fingerprint } = await subjectRow();
      const r = await answer(id, { decision: "deny", if_unchanged: { subject: fingerprint } }, { authorization: `Bearer ${ownerToken}` });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
      expect((await stored(id)).decision).toBe("pending");
    });

    it("the local owner token reaches it: stale is refused, the fresh subject is answered", async () => {
      const { id, fingerprint } = await subjectRow();
      const local = { authorization: `Bearer ${localOwnerToken}` };
      await pool.query(`UPDATE work SET updated_at = now() WHERE id = (SELECT work_id FROM proposals WHERE id = $1)`, [id]);
      const stale = await answer(id, { decision: "deny", if_unchanged: { subject: fingerprint } }, local);
      expect(stale.status).toBe(409);
      expect(stale.body.reason).toBe("stale");
      const r = await answer(id, { decision: "deny", if_unchanged: { subject: stale.body.proposal.subject.fingerprint } }, local);
      expect(r.status).toBe(200);
      expect((await stored(id)).decision).toBe("deny");
    });
  });
});
