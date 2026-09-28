// C45, tested per door (T2-15; design-system amendments §2.4): an answer whose
// consequence fails leaves the request PENDING, with `payload.error` saying
// why, and is never silently resolved. "A screen must not draw a refusal as a
// decision" — so the proof is the ROW, read back from Postgres and from the
// queue every client draws, not the response body alone.
//
// One describe per consequential door of `POST /api/proposals/:id` (and the
// agent's own auto-run through `propose_action`), each driven through every
// way it can fail: a refusal from the service (the code it names), and a
// consequence that THROWS (`internal`, with no detail on the row). The doors
// that answer through another system (F-5's `pr_review`, `rsvp`, `draft`,
// `resolve_conflict`, `act`, `today`, `delegate`) each add their describe here
// when they land (the ticket's acceptance) — `resolve_conflict` has (T2-10),
// and `pr_review` (T2-13).
//
// Failures that cannot be provoked honestly through the API — a unique
// violation in the tasks service, a grants write that throws — are injected
// at the database the console is handed, one query, one time.
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { githubPullSource, knowledgeConflictSource, mintToken, raiseMirror } from "@foldedspacelabs/metistry-core";
import type { GithubWriteClient } from "../src/github-write.js";
import { fakeGithub, fakeWriteClient } from "./github-fake.js";
import { VaultError, type VaultClient } from "@foldedspacelabs/metistry-artifacts";
import { ACCESS_REQUEST_KIND } from "@foldedspacelabs/metistry-mcp-brain";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import { ConflictMoved, type ConflictSide } from "../src/knowledge-routes.js";
import { OVERLAY_PATH } from "../src/prompt-overlay.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };

/** What the vault does with the next write: take it, refuse it the way the bridge refuses, or fall over. */
type VaultMode = "ok" | "refuse" | "throw";

/** An in-memory vault holding one overlay; enough of the contract for the improvement door. */
function fakeVault() {
  const files = new Map<string, string>([[OVERLAY_PATH, "You are {{name}}.\n"]]);
  const state = { mode: "ok" as VaultMode, writes: 0 };
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const client = {
    async read(path: string) {
      const content = files.get(path);
      return content === undefined ? null : { path, content: Buffer.from(content, "utf8"), sha256: sha(content), bytes: content.length };
    },
    async write(path: string, content: Buffer) {
      if (state.mode === "refuse") throw new VaultError("conflict", "the overlay changed underneath this write");
      if (state.mode === "throw") throw new Error("ECONNRESET vault-bridge 10.0.0.9:7443 secret-ish detail");
      const text = content.toString("utf8");
      const created = !files.has(path);
      files.set(path, text);
      state.writes++;
      return { path, sha256: sha(text), bytes: text.length, created };
    },
  } as unknown as VaultClient;
  return { client, state };
}

describe.skipIf(!hasDb)("C45 — a failed answer leaves the request pending, with payload.error (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let bare: string; // a second console with no vault bridge at all
  let server: ReturnType<typeof makeServer>;
  let bareServer: ReturnType<typeof makeServer>;
  let cookie: string;
  const vault = fakeVault();
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const asker = `c45-ask-${suffix}`;
  const crew = `c45-crew-${suffix}`;
  const gone = `c45-gone-${suffix}`;
  const enrollee = `c45-enrol-${suffix}`;
  const reconciler = `c45-reconciler-${suffix}`; // raises the conflict reviews, as the reconciler does
  /** What the reconciler's /vault/conflicts/resolve does with the next settle. */
  const conflicts = { mode: "ok" as "ok" | "refuse" | "throw" | "stale", calls: 0 };
  /** GitHub, for the PR doors (T2-13); and whether the owner's client falls over outright on its next read. */
  const gh = fakeGithub();
  const githubMode = { throw: false };
  const realGithub = fakeWriteClient(gh);
  const githubWrite = new Proxy(realGithub, {
    get(target, prop, receiver) {
      if (prop === "pull" && githubMode.throw) {
        return async () => {
          githubMode.throw = false;
          throw new Error("ECONNRESET api.github.com 10.0.0.9 secret-ish detail");
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as GithubWriteClient;
  let askerToken: string;
  let rpcId = 1;

  /** One query, one time: the next statement matching `match` fails with `err` instead of reaching Postgres. */
  let fault: { match: RegExp; err: Error } | null = null;
  const failNext = (match: RegExp, err: Error) => {
    fault = { match, err };
  };
  const db = {
    query(text: string, values?: unknown[]) {
      if (fault && fault.match.test(text)) {
        const { err } = fault;
        fault = null;
        return Promise.reject(err);
      }
      return pool.query(text, values);
    },
  };

  const owner = (method: string, path: string, body?: unknown, at = base) =>
    fetch(at + path, { method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const answer = (id: number, body: Record<string, unknown>, at = base) => owner("POST", `/api/proposals/${id}`, body, at);

  async function plant(kind: string, source: string, payload: Record<string, unknown>): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO proposals (ts, kind, source_agent, trust, payload) VALUES (now() - interval '1 minute', $1, $2, 'external', $3::jsonb) RETURNING id`,
      [kind, source, JSON.stringify(payload)],
    );
    return Number(rows[0].id);
  }

  const rowOf = async (id: number) => (await pool.query(`SELECT decision, decided_at, feedback, payload FROM proposals WHERE id = $1`, [id])).rows[0]!;

  /**
   * The C45 contract, in one place: the refusal came back with `code`; the row
   * is still pending and undecided; `payload.error` carries the same code and
   * message, the answer that was refused, and when; the queue every client
   * draws shows it WITH the reason; and the owner can still answer it.
   */
  async function expectLeftPending(id: number, res: Response, code: string, verb: string, opts: { status?: number; internal?: boolean } = {}): Promise<Record<string, unknown>> {
    const body = await res.json();
    if (opts.status !== undefined) expect(res.status).toBe(opts.status);
    expect(body.error.code).toBe(code);
    const row = await rowOf(id);
    expect(row.decision).toBe("pending");
    expect(row.decided_at).toBeNull();
    expect(row.payload.error).toMatchObject({ code, decision: verb });
    expect(Number.isNaN(Date.parse(row.payload.error.at))).toBe(false);
    if (opts.internal) {
      // `internal` carries no detail across the wire — and payload.error IS the wire (GET /api/proposals)
      expect(JSON.stringify(row.payload.error)).not.toMatch(/ECONNRESET|10\.0\.0\.9|secret-ish|boom/);
    } else {
      expect(row.payload.error.message).toBe(body.error.message);
    }
    const queue = await (await owner("GET", "/api/proposals?limit=100")).json();
    const drawn = (queue.proposals as { id: number | string; payload: { error?: { code?: string } } }[]).find((p) => Number(p.id) === id);
    expect(drawn, "a failed answer stays in Needs You").toBeDefined();
    expect(drawn!.payload.error?.code).toBe(code);
    return row.payload.error as Record<string, unknown>;
  }

  /** ...and it is still the owner's to settle: Skip is valid on every kind — in the bulk list, where Skip lives (K2). */
  async function stillAnswerable(id: number): Promise<void> {
    const r = await owner("POST", "/api/proposals/batch", { ids: [id], decision: "skip" });
    expect(r.status).toBe(200);
    expect((await r.json()).results).toEqual([expect.objectContaining({ id, ok: true })]);
    expect((await rowOf(id)).decision).toBe("deny");
  }

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const common = { origin: "http://127.0.0.1:0", inboxDir: `/tmp/metistry-test-inbox-c45-${Date.now()}`, policy, secureCookies: false };
    server = makeServer(db, new QueryStore(pool), {
      ...common,
      vault: vault.client,
      githubWrite,
      knowledgeConflicts: {
        async resolve(path: string, keep: ConflictSide) {
          conflicts.calls++;
          if (conflicts.mode === "refuse") throw new VaultError("not_available", "the vault is mid-merge — finish it, then settle the conflict; nothing was discarded");
          if (conflicts.mode === "throw") throw new Error("ECONNRESET vault-bridge 10.0.0.9:7443 secret-ish detail");
          if (conflicts.mode === "stale") throw new ConflictMoved(`${path} is not what you saw — look at both sides again before discarding one`, { path, original: "Areas/C45/Note.md", sha256: "b".repeat(64), original_sha256: "a".repeat(64) });
          return { path: "Areas/C45/Note.md", copy: path, kept: keep, sha256: "a".repeat(64), bytes: 1, recorded: null };
        },
      },
    });
    bareServer = makeServer(pool, new QueryStore(pool), common);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => bareServer.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    bare = `http://127.0.0.1:${(bareServer.address() as AddressInfo).port}`;
    const pkId = `c45-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "c45-test" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ({ token: askerToken } = await agents.createAgent(pool, { id: asker, display_name: "c45 asker" }));
    await agents.createAgent(pool, { id: gone, display_name: "c45 revoked" });
    await agents.revokeAgent(pool, gone);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => bareServer.close(() => r()));
    await pool.query(`DELETE FROM proposals WHERE source_agent = ANY($1::text[])`, [[asker, crew, gone, enrollee, reconciler]]);
    await pool.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [[asker, crew, gone, enrollee]]);
    await pool.end();
  });

  // ---- Approve on an improvement: the prompt overlay write --------------------------

  describe("Approve on an improvement (the prompt overlay write)", () => {
    const improvement = () => plant("improvement", asker, { title: "c45 improvement", suggested_edit: { path: OVERLAY_PATH, content: "## c45 section" } });

    it("no vault bridge in this deployment: 503, pending, with the reason", async () => {
      const id = await improvement();
      await expectLeftPending(id, await answer(id, { decision: "allow" }, bare), "not_available", "allow", { status: 503 });
      await stillAnswerable(id);
    });

    it("a payload with no suggested edit: 400, pending — never an empty overlay write", async () => {
      const id = await plant("improvement", asker, { title: "c45 empty improvement" });
      const before = vault.state.writes;
      await expectLeftPending(id, await answer(id, { decision: "allow" }), "invalid_request", "allow", { status: 400 });
      expect(vault.state.writes).toBe(before);
      await stillAnswerable(id);
    });

    it("the vault refuses the write: its code, pending — and Approve works once the vault takes it", async () => {
      const id = await improvement();
      vault.state.mode = "refuse";
      await expectLeftPending(id, await answer(id, { decision: "allow" }), "conflict", "allow", { status: 409 });
      // no retry happened on its own; the owner decides again
      vault.state.mode = "ok";
      const again = await answer(id, { decision: "allow" });
      expect(again.status).toBe(200);
      expect((await rowOf(id)).decision).toBe("allow");
    });

    it("the vault falls over: 500, pending, `internal` with no detail on the row", async () => {
      const id = await improvement();
      vault.state.mode = "throw";
      try {
        await expectLeftPending(id, await answer(id, { decision: "allow" }), "internal", "allow", { status: 500, internal: true });
      } finally {
        vault.state.mode = "ok";
      }
      await stillAnswerable(id);
    });
  });

  // ---- Approve on an action: one service call ----------------------------------------

  describe("Approve on an action (one service call, as the user)", () => {
    const newTask = async (title: string) => Number((await pool.query(`INSERT INTO work (title, kind, status) VALUES ($1, 'task', 'open') RETURNING id`, [title])).rows[0].id);

    it("a stored action that does not validate: 400 naming the field, pending", async () => {
      const id = await plant("action", asker, { title: "c45 bad action", action: { kind: "rm_rf", args: {} }, reason: "test" });
      const err = await expectLeftPending(id, await answer(id, { decision: "allow" }), "invalid_request", "allow", { status: 400 });
      expect(String(err.message)).toContain("kind must be one of");
      await stillAnswerable(id);
    });

    it("the service refuses: its code, pending, nothing applied", async () => {
      const id = await plant("action", asker, { title: "c45 missing task", action: { kind: "task_update", args: { work_id: 999_999_999, patch: { status: "blocked" } } }, reason: "test" });
      await expectLeftPending(id, await answer(id, { decision: "allow" }), "not_found", "allow", { status: 404 });
      expect((await rowOf(id)).payload.result).toBeUndefined();
      await stillAnswerable(id);
    });

    it("the service throws: 500, pending, `internal`, and the task untouched", async () => {
      const work = await newTask("c45 action throws");
      const id = await plant("action", asker, { title: "c45 throw", action: { kind: "task_update", args: { work_id: work, patch: { title: "never renamed" } } }, reason: "test" });
      failNext(/UPDATE work w/, new Error("boom: connection terminated"));
      await expectLeftPending(id, await answer(id, { decision: "allow" }), "internal", "allow", { status: 500, internal: true });
      expect((await pool.query(`SELECT title FROM work WHERE id = $1`, [work])).rows[0].title).toBe("c45 action throws");
      await stillAnswerable(id);
    });

    it("the agent's own run (act_within_scope) that fails is not `auto`: it lands pending, with the error, in Needs You", async () => {
      expect((await owner("PUT", `/api/agents/${asker}/autonomy`, { level: "act_within_scope" })).status).toBe(200);
      // a real row (the proposal links to it), and a move the board refuses: `blocked` needs the claim
      const work = await newTask("c45 auto refused");
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${askerToken}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: rpcId++,
          method: "tools/call",
          params: { name: "propose_action", arguments: { kind: "task_update", args: { work_id: work, patch: { status: "blocked" } }, reason: "c45 auto" } },
        }),
      });
      const result = (await res.json()).result as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0]!.text.split("\n")[0]!);
      expect(body.error.code).not.toBe("internal"); // the service's own refusal, not a crash
      // the refusal the agent reads carries no proposal id, so find the row it raised by what it is about
      const raised = (await pool.query(`SELECT id FROM proposals WHERE kind = 'action' AND source_agent = $1 AND work_id = $2`, [asker, work])).rows;
      expect(raised).toHaveLength(1);
      const id = Number(raised[0].id);
      const row = await rowOf(id);
      expect(row.decision).toBe("pending"); // never `auto`: nothing ran
      expect(row.decided_at).toBeNull();
      expect(row.payload.error).toMatchObject({ code: body.error.code, message: body.error.message });
      expect((await pool.query(`SELECT status FROM work WHERE id = $1`, [work])).rows[0].status).toBe("open");
      const queue = await (await owner("GET", "/api/proposals?limit=100")).json();
      expect((queue.proposals as { id: number }[]).some((p) => Number(p.id) === id)).toBe(true);
      await owner("PUT", `/api/agents/${asker}/autonomy`, { level: "observe" });
      await stillAnswerable(id);
    });
  });

  // ---- Approve as Work: the work row ---------------------------------------------------

  describe("Approve as Work (the work row)", () => {
    const suggestion = (title: string) => plant("knowledge", asker, { title, suggested_work: { title } });
    const workFor = async (id: number) => (await pool.query(`SELECT count(*)::int AS n FROM work WHERE idempotency_key = $1`, [`proposal:${id}`])).rows[0].n as number;

    it("the tasks service refuses: its code, pending, no work row", async () => {
      const id = await suggestion("c45 work refused");
      failNext(/INSERT INTO work/, Object.assign(new Error("duplicate key"), { code: "23505" })); // the service's own conflict
      await expectLeftPending(id, await answer(id, { decision: "accept_as_work" }), "conflict", "accept_as_work", { status: 409 });
      expect(await workFor(id)).toBe(0);
      await stillAnswerable(id);
    });

    it("the tasks service throws: 500, pending, `internal`, no work row", async () => {
      const id = await suggestion("c45 work throws");
      failNext(/INSERT INTO work/, new Error("boom: disk full"));
      await expectLeftPending(id, await answer(id, { decision: "accept_as_work" }), "internal", "accept_as_work", { status: 500, internal: true });
      expect(await workFor(id)).toBe(0);
      await stillAnswerable(id);
    });
  });

  // ---- Approve on an enrolment: letting a remote agent in ------------------------------

  describe("Approve on an enrolment (letting a remote agent in)", () => {
    it("the agent was revoked since it asked: 404, pending — an approval that let nobody in is not an approval", async () => {
      await agents.createAgent(pool, { id: enrollee, display_name: "c45 enrolee", remote: true });
      const id = (await agents.enrollmentProposal(pool, { id: enrollee, display_name: "c45 enrolee" }))!;
      await agents.revokeAgent(pool, enrollee);
      await expectLeftPending(id, await answer(id, { decision: "approve" }), "not_found", "approve", { status: 404 });
      expect((await pool.query(`SELECT approved_at FROM agents WHERE id = $1`, [enrollee])).rows[0].approved_at).toBeNull();
      // Decline is not a failure here: its consequence — nobody gets in — already holds
      expect((await answer(id, { decision: "deny" })).status).toBe(200);
      expect((await rowOf(id)).decision).toBe("deny");
    });
  });

  // ---- Approve / Revise on an access request: the grants write ---------------------------

  describe("Approve and Revise on an access request (the grants write)", () => {
    const ask = (source: string, payload: Record<string, unknown> = { title: "c45 ask", area: "Areas/C45", reason: "test" }) => plant(ACCESS_REQUEST_KIND, source, payload);
    const grantsOf = async (id: string) => (await pool.query(`SELECT grants FROM agents WHERE id = $1`, [id])).rows[0]!.grants;

    it("a row that names no area: 400, pending", async () => {
      const id = await ask(asker, { title: "c45 no area", reason: "test" });
      await expectLeftPending(id, await answer(id, { decision: "allow" }), "invalid_request", "allow", { status: 400 });
      await stillAnswerable(id);
    });

    it("Revise without an area the validator admits: 400, pending, nothing granted", async () => {
      const id = await ask(asker);
      const before = await grantsOf(asker);
      await expectLeftPending(id, await answer(id, { decision: "accept_with_changes", area: "../etc" }), "invalid_request", "accept_with_changes", { status: 400 });
      expect(await grantsOf(asker)).toEqual(before);
      await stillAnswerable(id);
    });

    it("a crew's scope is its manifest: 403, pending", async () => {
      // made here, not in beforeAll: a crew sync in another suite revokes every crew its manifests do not name
      await pool.query(`INSERT INTO agents (id, display_name, kind, token_hash, grants) VALUES ($1, $1, 'crew', $2, '{"tier":"index","areas":[]}'::jsonb)`, [crew, mintToken(32)]);
      const id = await ask(crew);
      await expectLeftPending(id, await answer(id, { decision: "allow" }), "forbidden", "allow", { status: 403 });
      expect(await grantsOf(crew)).toEqual({ tier: "index", areas: [] });
      await stillAnswerable(id);
    });

    it("a revoked agent: 404, pending", async () => {
      const id = await ask(gone);
      await expectLeftPending(id, await answer(id, { decision: "allow" }), "not_found", "allow", { status: 404 });
      await stillAnswerable(id);
    });

    it("the grants write throws: 500, pending, `internal`, nothing granted", async () => {
      const id = await ask(asker);
      const before = await grantsOf(asker);
      failNext(/UPDATE agents SET grants/, new Error("boom: serialization failure"));
      await expectLeftPending(id, await answer(id, { decision: "allow" }), "internal", "allow", { status: 500, internal: true });
      expect(await grantsOf(asker)).toEqual(before);
      await stillAnswerable(id);
    });
  });

  // ---- Keep Mine / Take the Other on a knowledge conflict: the Resolve a conflict door ----

  describe("Keep Mine and Take the Other on a knowledge conflict (the resolve_conflict door, T2-10)", () => {
    let n = 0;
    /** A conflict copy's review, raised as the reconciler raises it: a mirror of the copy. */
    const conflictReview = async () => {
      const copy = `Areas/C45/Note-${suffix}-${++n}.sync-conflict-20260927-101500-ABCDEFG.md`;
      const { id } = await raiseMirror(pool, {
        kind: "review",
        source_agent: reconciler,
        trust: "internal",
        payload: { title: "Sync conflict: Note.md", event: "knowledge_conflict", body: { kind: "before_after" }, conflict: { path: copy, original: "Areas/C45/Note.md", sha256: "b".repeat(64), original_sha256: "a".repeat(64) } },
        source: knowledgeConflictSource(copy),
      });
      return { id, copy };
    };
    const settle = (copy: string, keep: ConflictSide, at = base) => owner("POST", "/api/knowledge/conflicts/resolve", { path: copy, keep, seen_sha: keep === "mine" ? "b".repeat(64) : "a".repeat(64) }, at);

    it("no vault bridge in this deployment: 503, the review pending with the reason — Keep Mine is the review's `allow`", async () => {
      const { id, copy } = await conflictReview();
      const error = await expectLeftPending(id, await settle(copy, "mine", bare), "not_available", "allow", { status: 503 });
      expect(error).toMatchObject({ door: "resolve_conflict", keep: "mine" });
      await stillAnswerable(id);
    });

    it("the bridge refuses the settle: its code, pending — Take the Other is the review's Revise — and a settle that works leaves it to the source", async () => {
      const { id, copy } = await conflictReview();
      conflicts.mode = "refuse";
      try {
        const error = await expectLeftPending(id, await settle(copy, "theirs"), "not_available", "accept_with_changes", { status: 503 });
        expect(error).toMatchObject({ door: "resolve_conflict", keep: "theirs" });
      } finally {
        conflicts.mode = "ok";
      }
      // no retry happened on its own; the owner settles again, and the row
      // is the reconciler's to clear at its source (the copy is gone), not this door's to decide
      expect((await settle(copy, "theirs")).status).toBe(200);
      expect((await rowOf(id)).decision).toBe("pending");
    });

    it("the bridge falls over: 500, pending, `internal` with no detail on the row", async () => {
      const { id, copy } = await conflictReview();
      conflicts.mode = "throw";
      try {
        await expectLeftPending(id, await settle(copy, "mine"), "internal", "allow", { status: 500, internal: true });
      } finally {
        conflicts.mode = "ok";
      }
      await stillAnswerable(id);
    });

    it("stale is not a failed answer: 409, and nothing written on the row", async () => {
      const { id, copy } = await conflictReview();
      conflicts.mode = "stale";
      try {
        const r = await settle(copy, "mine");
        expect(r.status).toBe(409);
        expect(await r.json()).toMatchObject({ reason: "stale", conflict: { path: copy } });
      } finally {
        conflicts.mode = "ok";
      }
      const row = await rowOf(id);
      expect(row.decision).toBe("pending");
      expect(row.payload.error).toBeUndefined();
      await stillAnswerable(id);
    });
  });

  // ---- Approve / Request Changes on a pull request: the pr_review door (T2-13) ----

  describe("Approve and Request Changes on a pull request (the pr_review door, T2-13)", () => {
    const REPO = `c45-pr-${suffix}/metistry`;
    const HEAD = "c".repeat(40);
    let n = 0;
    /** A PR waiting on review, raised as the GitHub sync raises it: a mirror of the PR. */
    const pullRequest = async () => {
      const number = ++n;
      gh.pulls.set(`${REPO}#${number}`, { repo: REPO, number, head: HEAD, state: "open" });
      const { id } = await raiseMirror(pool, { kind: "pull_request", source_agent: "github-state", trust: "external", source: githubPullSource(REPO, number, "dana"), payload: { title: `Review #${number}`, repo: REPO, number, head_sha: HEAD } });
      return { id, number };
    };
    const review = (number: number, event: string, body: string, at = base) => owner("POST", `/api/github/pulls/${REPO}/${number}/review`, { event, body, head_sha: HEAD }, at);

    afterAll(async () => {
      await pool.query(`DELETE FROM proposals WHERE source->>'external_ref' LIKE $1`, [`gh:${REPO}#%`]);
    });

    it("no write client in this deployment: 503, the request pending with the reason — Approve is the request's `allow`", async () => {
      const { id, number } = await pullRequest();
      const error = await expectLeftPending(id, await review(number, "approve", "", bare), "not_available", "allow", { status: 503 });
      expect(error).toMatchObject({ door: "pr_review", event: "approve" });
      await stillAnswerable(id);
    });

    it("GitHub refuses the review: its code, pending — Request Changes is the request's Revise", async () => {
      const { id, number } = await pullRequest();
      gh.refuseNext = { status: 422, message: "Review cannot be requested from pull request author" };
      const error = await expectLeftPending(id, await review(number, "request_changes", "Rename it."), "invalid_request", "accept_with_changes", { status: 400 });
      expect(error).toMatchObject({ door: "pr_review", event: "request_changes" });
      // the owner posts again, it lands, and the request is theirs, answered — the error gone with the question
      const again = await review(number, "request_changes", "Rename it.");
      expect(again.status).toBe(201);
      const row = await rowOf(id);
      expect(row).toMatchObject({ decision: "accept_with_changes", feedback: "Rename it." });
      expect(row.payload.error).toBeUndefined();
    });

    it("the client falls over: 500, pending, `internal` with no detail on the row", async () => {
      const { id, number } = await pullRequest();
      githubMode.throw = true;
      await expectLeftPending(id, await review(number, "approve", ""), "internal", "allow", { status: 500, internal: true });
      await stillAnswerable(id);
    });

    it("stale is not a failed answer: 409, and nothing written on the row", async () => {
      const { id, number } = await pullRequest();
      gh.pulls.get(`${REPO}#${number}`)!.head = "e".repeat(40);
      const r = await review(number, "approve", "");
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ reason: "stale", pull: { head_sha: "e".repeat(40) } });
      const row = await rowOf(id);
      expect(row.decision).toBe("pending");
      expect(row.payload.error).toBeUndefined();
      await stillAnswerable(id);
    });
  });

  // ---- the boundary ------------------------------------------------------------------------

  describe("what is NOT a failed consequence", () => {
    it("a refusal of the REQUEST itself — a verb the row does not offer, a stale answer — writes nothing on the row", async () => {
      const id = await plant("action", asker, { title: "c45 boundary", action: { kind: "capture", args: { note: "n" } }, reason: "test" });
      expect((await answer(id, { decision: "yolo" })).status).toBe(400);
      expect((await answer(id, { decision: "allow", if_unchanged: { seen_at: "2000-01-01T00:00:00.000Z" } })).status).toBe(409);
      const row = await rowOf(id);
      expect(row.decision).toBe("pending");
      expect(row.payload.error).toBeUndefined();
      await stillAnswerable(id);
    });
  });
});
