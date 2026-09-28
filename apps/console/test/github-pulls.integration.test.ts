// The owner's pull request doors (design-build-plan §2.1, §2.11, §2.12;
// T2-13): a review, a thread reply and a thread resolve, posted to GitHub as
// the owner through the one client holding `github_write`. Over real sockets
// against the scratch database; GitHub is the in-process fake in
// github-fake.ts, which records every request — so "nothing was posted" is a
// count, not a hope.
//
// The ticket's own tests, bold in its Tests line: **refused without the SHA
// shown**; **no agent credential reaches the write client** (every door,
// every agent-side credential, and the source: the client is read in one
// place); **the collector's PAT stays read-only** is the collector's
// (collectors/github-state/github.test.ts). Plus U2's four.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { githubPullSource, mintToken, raiseMirror } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import { GITHUB_PULL_ROUTE, isGithubPullRoute } from "../src/github-pulls-route.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import { TOKEN, fakeGithub, fakeWriteClient, writePolicy, type FakeGithub } from "./github-fake.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-prdoor";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const REPO = `itest-pr-${suffix}/metistry`;
const HEAD = "adf440c1".padEnd(40, "0");
const MOVED = "b".repeat(40);

describe("the route (pure)", () => {
  it("matches the three doors and nothing near them", () => {
    for (const k of ["POST /api/github/pulls/o/r/41/review", "POST /api/github/pulls/o/r/41/threads/PRRT_kw1/reply", "POST /api/github/pulls/o/r/41/threads/PRRT_kw1/resolve"]) expect(isGithubPullRoute(k), k).toBe(true);
    for (const k of ["GET /api/github/pulls/o/r/41/review", "POST /api/github/pulls/o/r/41", "POST /api/github/pulls/o/r/41/merge", "POST /api/github/pulls/o/r/41/threads/x/delete", "POST /api/github/pulls/o/41/review"]) expect(isGithubPullRoute(k), k).toBe(false);
    expect(GITHUB_PULL_ROUTE.exec("POST /api/github/pulls/o/r/41/threads/PRRT_kw1/reply")?.slice(1)).toEqual(["o", "r", "41", undefined, "PRRT_kw1", "reply"]);
  });

  it("the write client is handed to the PR doors and nothing else — not the MCP mount, not another route (by construction)", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
    const reads = src.split("\n").filter((l) => /cfg\.githubWrite/.test(l));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/if \(isGithubPullRoute\(key\)\) return githubPullRoute\(/);
    // …and the only module that builds requests with it is the door
    const route = readFileSync(fileURLToPath(new URL("../src/github-pulls-route.ts", import.meta.url)), "utf8");
    expect(route).toMatch(/deps\.github/);
    const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
    expect(main.split("\n").filter((l) => /\bgithubWrite\b/.test(l) && !l.trim().startsWith("//"))).toEqual([
      expect.stringContaining("const githubWrite = new GithubWriteClient("),
      expect.stringMatching(/^\s*githubWrite,$/),
    ]);
  });
});

describe.skipIf(!hasDb)("the pull request doors: POST /api/github/pulls/:owner/:repo/:number/…", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let bareServer: ReturnType<typeof makeServer>;
  let base: string;
  let bare: string;
  let gh: FakeGithub;
  let token: string | undefined = TOKEN;
  let secretsPolicy = writePolicy();
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `itest-prdoor-${suffix}`;
  const passkeyIds: string[] = [];
  const dirs: string[] = [];
  let n = 0;

  const local = { authorization: `Bearer ${localOwnerToken}` };
  async function post(path: string, body: unknown, headers: Record<string, string> = local, at = base) {
    const r = await fetch(`${at}/api/github/pulls/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: JSON.parse(text) as Record<string, any>, text };
  }
  /** A fresh open PR at HEAD, a thread on it, and — as the sync raises it — its waiting request. */
  async function pr(): Promise<{ number: number; thread: string; request: number; path: string }> {
    const number = ++n;
    gh.pulls.set(`${REPO}#${number}`, { repo: REPO, number, head: HEAD, state: "open" });
    const thread = `PRRT_kw${suffix}${number}`;
    gh.threads.set(thread, { id: thread, repo: REPO, number, resolved: false });
    const { id } = await raiseMirror(pool, { kind: "pull_request", source_agent: "github-state", trust: "external", source: githubPullSource(REPO, number, "dana"), payload: { title: `Review #${number}`, repo: REPO, number, head_sha: HEAD } });
    return { number, thread, request: id, path: `${REPO}/${number}` };
  }
  const requestRow = async (id: number) => (await pool.query(`SELECT decision, feedback, payload FROM proposals WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    gh = fakeGithub();
    const githubWrite = fakeWriteClient(gh, { token: () => token, policy: () => secretsPolicy });
    const serve = async (withClient: boolean) => {
      const dir = await mkdtemp(join(tmpdir(), "metistry-prdoor-"));
      dirs.push(dir);
      const s = makeServer(pool, queries, { origin: "http://127.0.0.1:0", inboxDir: dir, policy, secureCookies: false, localOwner: { token: localOwnerToken, trusted: [] }, ...(withClient ? { githubWrite } : {}) });
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
    };
    ({ s: server, url: base } = await serve(true));
    ({ s: bareServer, url: bare } = await serve(false));
    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest pr door" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM proposals WHERE source->>'external_ref' LIKE $1`, [`gh:${REPO}#%`]);
    await pool.query(`DELETE FROM runs WHERE component = 'console' AND kind = 'github' AND meta->>'repo' = $1`, [REPO]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => bareServer.close(() => r()));
    await pool.end();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  beforeEach(() => {
    token = TOKEN;
    secretsPolicy = writePolicy();
    gh.refuseNext = null;
  });

  // ---- U2: the four, on every door ------------------------------------------------------------

  describe("who may post (U2) — and no agent credential reaches the write client", () => {
    const doors = (p: { path: string; thread: string }) =>
      [
        [`${p.path}/review`, { event: "approve", body: "", head_sha: HEAD }],
        [`${p.path}/threads/${p.thread}/reply`, { body: "Fixed.", head_sha: HEAD }],
        [`${p.path}/threads/${p.thread}/resolve`, { head_sha: HEAD }],
      ] as const;

    it("no credential is the uniform 401 on every door, and GitHub hears nothing", async () => {
      const p = await pr();
      const before = gh.calls.length;
      for (const [path, body] of doors(p)) {
        const r = await post(path, body, {});
        expect(r.status, path).toBe(401);
        expect(r.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
      }
      expect(gh.calls.length).toBe(before);
    });

    it("an agent bearer is refused 403 on every door — the write client is never called, not even to read", async () => {
      const p = await pr();
      const before = gh.calls.length;
      for (const [path, body] of doors(p)) {
        const r = await post(path, body, { authorization: `Bearer ${agentToken}` });
        expect(r.status, path).toBe(403);
        expect(r.body.error.code).toBe("forbidden");
      }
      expect(gh.calls.length).toBe(before);
      expect((await requestRow(p.request)).decision).toBe("pending");
    });

    it("the capture owner token is refused 403 on every door — capture is its whole reach", async () => {
      const p = await pr();
      const before = gh.calls.length;
      for (const [path, body] of doors(p)) {
        const r = await post(path, body, { authorization: `Bearer ${ownerToken}` });
        expect(r.status, path).toBe(403);
        expect(r.body.error.code).toBe("forbidden");
      }
      expect(gh.calls.length).toBe(before);
    });

    it("an agent answering the request itself cannot post either: the request route is the owner's, and a PR's answers are doors, not decisions", async () => {
      const p = await pr();
      const before = gh.calls.length;
      const asAgent = await fetch(`${base}/api/proposals/${p.request}`, { method: "POST", headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" }, body: JSON.stringify({ decision: "allow" }) });
      expect(asAgent.status).toBe(403);
      // …and even the owner cannot APPROVE a pull request through the request row: its Approve is the door
      const asOwner = await fetch(`${base}/api/proposals/${p.request}`, { method: "POST", headers: { ...local, "content-type": "application/json" }, body: JSON.stringify({ decision: "allow" }) });
      expect(asOwner.status).toBe(400);
      expect(gh.calls.length).toBe(before);
      expect((await requestRow(p.request)).decision).toBe("pending");
    });

    it("the local owner token reaches it, and so does a passkey session (reach `owner`)", async () => {
      const a = await pr();
      expect((await post(`${a.path}/review`, { event: "comment", body: "Looking now.", head_sha: HEAD })).status).toBe(201);
      const b = await pr();
      expect((await post(`${b.path}/threads/${b.thread}/resolve`, { head_sha: HEAD }, { cookie: sessionCookie })).status).toBe(200);
    });
  });

  // ---- the ticket's own: refused without the SHA shown ---------------------------------------

  describe("refused without the SHA shown", () => {
    it("no head_sha, an empty one, or an abbreviation: 400 on every door, and GitHub hears nothing", async () => {
      const p = await pr();
      const before = gh.calls.length;
      const cases: [string, Record<string, unknown>][] = [
        [`${p.path}/review`, { event: "approve", body: "" }],
        [`${p.path}/review`, { event: "approve", head_sha: "" }],
        [`${p.path}/review`, { event: "approve", head_sha: null }],
        [`${p.path}/review`, { event: "approve", head_sha: "adf440c1" }],
        [`${p.path}/review`, { event: "approve", head_sha: HEAD.toUpperCase() }],
        [`${p.path}/threads/${p.thread}/reply`, { body: "Fixed." }],
        [`${p.path}/threads/${p.thread}/reply`, { body: "Fixed.", head_sha: HEAD.slice(0, 12) }],
        [`${p.path}/threads/${p.thread}/resolve`, {}],
      ];
      for (const [path, body] of cases) {
        const r = await post(path, body);
        expect(r.status, `${path} ${JSON.stringify(body)}`).toBe(400);
        expect(r.body.error.code).toBe("invalid_request");
        expect(r.body.error.message).toMatch(/head_sha/);
      }
      expect(gh.calls.length).toBe(before);
      // a malformed request is not a failed answer: nothing is written on the row
      const row = await requestRow(p.request);
      expect(row.decision).toBe("pending");
      expect(row.payload.error).toBeUndefined();
    });

    it("a head that is not the PR's now is 409 stale with the head as it stands — and nothing is posted", async () => {
      const p = await pr();
      gh.pulls.get(`${REPO}#${p.number}`)!.head = MOVED;
      const writes = gh.writes().length;
      for (const [path, body] of [
        [`${p.path}/review`, { event: "approve", body: "", head_sha: HEAD }],
        [`${p.path}/threads/${p.thread}/reply`, { body: "Fixed.", head_sha: HEAD }],
        [`${p.path}/threads/${p.thread}/resolve`, { head_sha: HEAD }],
      ] as const) {
        const r = await post(path, body);
        expect(r.status, path).toBe(409);
        expect(r.body).toMatchObject({ error: { code: "conflict" }, reason: "stale", pull: { repo: REPO, number: p.number, head_sha: MOVED, state: "open" } });
      }
      expect(gh.writes().length).toBe(writes);
      const row = await requestRow(p.request);
      expect(row.decision).toBe("pending");
      expect(row.payload.error).toBeUndefined(); // stale is not a failed answer
    });

    it("a PR that closed or merged is 409 stale too", async () => {
      const p = await pr();
      Object.assign(gh.pulls.get(`${REPO}#${p.number}`)!, { state: "closed", merged: true });
      const writes = gh.writes().length;
      const r = await post(`${p.path}/review`, { event: "approve", body: "", head_sha: HEAD });
      expect(r.status).toBe(409);
      expect(r.body.pull).toMatchObject({ state: "merged" });
      const t = await post(`${p.path}/threads/${p.thread}/reply`, { body: "x", head_sha: HEAD });
      expect(t.status).toBe(409);
      expect(t.body.pull).toMatchObject({ state: "merged" });
      expect(gh.writes().length).toBe(writes);
    });

    it("a thread that is not this PR's is 404 — the path names the PR the owner was shown", async () => {
      const a = await pr();
      const b = await pr();
      const writes = gh.writes().length;
      const r = await post(`${a.path}/threads/${b.thread}/reply`, { body: "x", head_sha: HEAD });
      expect(r.status).toBe(404);
      expect((await post(`${a.path}/threads/PRRT_nosuch/resolve`, { head_sha: HEAD })).status).toBe(404);
      expect(gh.writes().length).toBe(writes);
    });
  });

  // ---- what each door posts, and what it settles ---------------------------------------------

  describe("posting as the owner", () => {
    it("Approve posts one review pinned to the head shown, with the owner's token — and settles the request as `allow`", async () => {
      const p = await pr();
      const r = await post(`${p.path}/review`, { event: "approve", body: "Looks right.", head_sha: HEAD });
      expect(r).toMatchObject({ status: 201, body: { ok: true, review_id: 991, url: `https://github.com/${REPO}/pull/${p.number}#pullrequestreview-991`, head_sha: HEAD } });
      const sent = gh.writes().at(-1)!;
      expect(sent).toEqual({ method: "POST", path: `/repos/${REPO}/pulls/${p.number}/reviews`, authorization: `Bearer ${TOKEN}`, body: { commit_id: HEAD, event: "APPROVE", body: "Looks right." } });
      const row = await requestRow(p.request);
      expect(row).toMatchObject({ decision: "allow", feedback: "Looks right." });
      expect(row.payload.review).toMatchObject({ id: 991, event: "approve", head_sha: HEAD });
      expect(r.text).not.toContain(TOKEN);
      // the audit row names the secret it sent — Settings ▸ Secrets' *last used* — and never its value
      const audit = (await pool.query(`SELECT ok, meta FROM runs WHERE component = 'console' AND kind = 'github' AND tool = 'pr_review' AND meta->>'repo' = $1 AND (meta->>'number')::int = $2 ORDER BY id DESC LIMIT 1`, [REPO, p.number])).rows[0];
      expect(audit).toMatchObject({ ok: true, meta: { secrets: ["github_write"], event: "approve", review_id: 991 } });
      expect(JSON.stringify(audit)).not.toContain(TOKEN);
      expect(JSON.stringify(audit)).not.toContain("Looks right.");
    });

    it("Request Changes needs the owner's words, and settles the request as `accept_with_changes` with them", async () => {
      const p = await pr();
      const before = gh.calls.length;
      expect((await post(`${p.path}/review`, { event: "request_changes", body: "  ", head_sha: HEAD })).status).toBe(400);
      expect(gh.calls.length).toBe(before);
      const r = await post(`${p.path}/review`, { event: "request_changes", body: "Rename the flag.", head_sha: HEAD });
      expect(r.status).toBe(201);
      expect(gh.writes().at(-1)!.body).toEqual({ commit_id: HEAD, event: "REQUEST_CHANGES", body: "Rename the flag." });
      expect(await requestRow(p.request)).toMatchObject({ decision: "accept_with_changes", feedback: "Rename the flag." });
    });

    it("a comment, a reply and a resolve post — and leave the request waiting", async () => {
      const p = await pr();
      expect((await post(`${p.path}/review`, { event: "comment", body: "Why 409?", head_sha: HEAD })).body).toMatchObject({ ok: true, head_sha: HEAD });
      const reply = await post(`${p.path}/threads/${p.thread}/reply`, { body: "Fixed in the next push.", head_sha: HEAD });
      expect(reply).toMatchObject({ status: 201, body: { ok: true, comment_id: 5512, thread_id: p.thread, url: `https://github.com/${REPO}/pull/${p.number}#discussion_r5512` } });
      expect(gh.writes().at(-1)!.body.variables).toEqual({ id: p.thread, body: "Fixed in the next push." });
      const resolve = await post(`${p.path}/threads/${p.thread}/resolve`, { head_sha: HEAD });
      expect(resolve).toMatchObject({ status: 200, body: { ok: true, thread_id: p.thread, resolved: true } });
      expect((await requestRow(p.request)).decision).toBe("pending");
    });

    it("refuses what the body does not take, and an event outside the three", async () => {
      const p = await pr();
      for (const body of [{ event: "merge", head_sha: HEAD }, { event: "approve", head_sha: HEAD, commit_id: MOVED }, { body: "x", head_sha: HEAD, event: "approve", url: "https://evil.example" }]) {
        const r = await post(`${p.path}/review`, body);
        expect(r.status, JSON.stringify(body)).toBe(400);
      }
      expect((await post(`${p.path}/threads/${p.thread}/resolve`, { head_sha: HEAD, body: "x" })).status).toBe(400);
      expect((await post(`-o/metistry/${p.number}/review`, { event: "approve", head_sha: HEAD })).status).toBe(400); // not a GitHub owner
      expect((await post(`${REPO}/0/review`, { event: "approve", head_sha: HEAD })).status).toBe(400); // not a PR number
      expect((await post(`${p.path}/threads/${encodeURIComponent("PRRT kw")}/resolve`, { head_sha: HEAD })).status).toBe(400); // not a thread id
    });
  });

  // ---- the secret's own policy, and C45 ----------------------------------------------------------

  describe("the secret, and a post that could not happen", () => {
    it("github_write not on api.github.com's Sent only to list, or not delivered: 503, nothing sent, the request pending with why", async () => {
      const p = await pr();
      const before = gh.calls.length;
      secretsPolicy = writePolicy([]);
      let r = await post(`${p.path}/review`, { event: "approve", body: "", head_sha: HEAD });
      expect(r.status).toBe(503);
      expect(r.body.error.message).toMatch(/Sent only to/);
      secretsPolicy = writePolicy();
      token = undefined;
      r = await post(`${p.path}/review`, { event: "approve", body: "", head_sha: HEAD });
      expect(r.status).toBe(503);
      expect(r.body.error.message).toMatch(/metistry secrets sync --to env/);
      expect(gh.calls.length).toBe(before);
      const row = await requestRow(p.request);
      expect(row.decision).toBe("pending");
      expect(row.payload.error).toMatchObject({ code: "not_available", door: "pr_review", decision: "allow", action: "review" });
    });

    it("a console with no write client: 503, and the request says so", async () => {
      const p = await pr();
      const r = await post(`${p.path}/review`, { event: "approve", body: "", head_sha: HEAD }, local, bare);
      expect(r.status).toBe(503);
      expect((await requestRow(p.request)).payload.error).toMatchObject({ code: "not_available", door: "pr_review" });
    });

    it("GitHub refuses the review (your own PR): its words, redacted, the request pending — and the token on no response", async () => {
      const p = await pr();
      gh.refuseNext = { status: 422, message: `Can not approve your own pull request (token ${TOKEN})` };
      const r = await post(`${p.path}/review`, { event: "approve", body: "", head_sha: HEAD });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/Can not approve your own pull request/);
      expect(r.text).not.toContain(TOKEN);
      const row = await requestRow(p.request);
      expect(row.decision).toBe("pending");
      expect(row.payload.error).toMatchObject({ code: "invalid_request", door: "pr_review", decision: "allow" });
      expect(JSON.stringify(row.payload)).not.toContain(TOKEN);
    });
  });
});
