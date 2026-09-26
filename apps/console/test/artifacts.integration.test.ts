// The artifacts adapter end to end: the console's routes over the module
// over the console's HTTP vault client over a REAL reconciler bridge
// running in-process on a throwaway git repo — so "one version = one
// commit" is asserted with `git log`, not simulated. Misuse first
// (invariant 8): the management gate (session only), the raw-file route's
// never-text/html rule (decision #14), and the PWA shell's sandbox
// attribute. Skipped without a db.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeServer } from "../src/server.js";
import { httpVaultClient } from "../src/vault-client.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import { Committer } from "../../reconciler/src/committer.js";
import { Vault } from "../../reconciler/src/vault.js";
import { makeBridge } from "../../reconciler/src/server.js";
import { tempRepo, type TempRepo } from "../../reconciler/test/helpers.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };
const P = "itest-console-art";

describe("PWA shell: HTML artifacts render only in an opaque-origin sandbox (decision #14)", () => {
  const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  it("the iframe gets sandbox with NO tokens and a CSP meta in the srcdoc; allow-same-origin never appears; text goes through textContent", () => {
    expect(app).toContain('frame.setAttribute("sandbox", "")');
    expect(app).not.toContain("allow-same-origin");
    expect(app).not.toContain("allow-scripts");
    expect(app).toContain("frame.srcdoc = ART_CSP + body.content");
    expect(app).toMatch(/ART_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \\'none\\';/);
    expect(app).toContain("pre.textContent = body.content");
    expect(app).not.toMatch(/innerHTML\s*=\s*body\.content/);
    expect(html).toContain('id="artifacts"');
    expect(html).toContain('data-view="artifacts"');
  });

  // Rooms (0016): every value in a room came out of the database and may be
  // agent-authored, so the panel builds its markup from esc() only, and the
  // one mutating control it has — resolve — is a POST to the work route.
  it("the Rooms panel escapes every agent-authored value and has exactly one resolve path", () => {
    expect(html).toContain('id="rooms"');
    expect(html).toContain('data-view="rooms"');
    expect(app).toContain("function roomCard(r)");
    expect(app).not.toMatch(/room-messages"\)\.innerHTML\s*=\s*[^;]*\$\{c\.body\}/); // bodies go through esc()
    expect(app).toContain("${esc(c.body)}");
    expect(app).toMatch(/\/thread\/\$\{op\}/); // resolve/reopen: the console route, nothing else
    expect(app).not.toContain("tasks_resolve"); // no agent-side verb exists to call
  });
});

describe.skipIf(!hasDb)("artifacts routes (integration, real reconciler in-process)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let repo: TempRepo;
  let bridge: ReturnType<typeof makeBridge>;
  let cookie: string;
  let ownerToken: string;
  let agentToken: string;
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const agentId = `itest-cart-${suffix}`;

  const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie }) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    await pool.query(`DELETE FROM artifact_comments WHERE artifact_id IN (SELECT id FROM artifacts WHERE project = $1)`, [P]);
    await pool.query(`DELETE FROM artifact_versions WHERE artifact_id IN (SELECT id FROM artifacts WHERE project = $1)`, [P]);
    await pool.query(`DELETE FROM artifacts WHERE project = $1`, [P]);
    await pool.query(`DELETE FROM artifact_comments WHERE work_id IN (SELECT id FROM work WHERE project = $1)`, [P]); // rooms hang on work rows (0016)
    await pool.query(`DELETE FROM proposals WHERE work_id IN (SELECT id FROM work WHERE project = $1)`, [P]);
    await pool.query(`DELETE FROM work WHERE project = $1`, [P]);

    // the real vault bridge on a throwaway repo, exactly as launchd would run it
    repo = await tempRepo();
    const token = mintToken();
    const committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test", sourceTrailer: "Brain-Source" });
    bridge = makeBridge({ vault: new Vault(repo.root, repo.git, committer, { maxBytes: 1024 * 1024 }), committer }, { token, maxBodyBytes: 2 * 1024 * 1024 });
    await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
    const vault = httpVaultClient({ url: `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`, token });

    // the Rooms panel calls /api/q/rooms and nothing else (invariant 3), so the seed dir is loaded here
    const queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    server = makeServer(pool, queries, {
      origin: "https://console.test",
      inboxDir: `/tmp/metistry-test-inbox-art-${Date.now()}`,
      policy,
      secureCookies: false,
      webRoot: fileURLToPath(new URL("../web", import.meta.url)),
      vault,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `art-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "art-test" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, "art-test");
    ({ token: agentToken } = await agents.createAgent(pool, { id: agentId, display_name: "art itest" }));
    await agents.setProjects(pool, agentId, [P]);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => bridge.close(() => r()));
    await repo.cleanup();
    await pool.end();
  });

  it("management gate: no credential → 401; owner token and agent token → uniform 403 on every artifact/dispatch route", async () => {
    for (const [method, path] of [["GET", "/api/artifacts"], ["POST", "/api/artifacts"], ["GET", "/api/artifacts/art_01J00000000000000000000000"], ["POST", "/api/dispatches"], ["GET", "/api/dispatches/1"], ["GET", "/api/work/1/thread"], ["POST", "/api/work/1/comments"], ["POST", "/api/work/1/thread/resolve"]] as const) {
      const body = method === "POST" ? {} : undefined;
      expect((await json(method, path, body, {})).status, `${method} ${path} anon`).toBe(401);
      expect((await json(method, path, body, { authorization: `Bearer ${ownerToken}` })).status, `${method} ${path} owner token`).toBe(403);
      expect((await json(method, path, body, { authorization: `Bearer ${agentToken}` })).status, `${method} ${path} agent token`).toBe(403);
    }
  });

  let artifactId: string;
  let v1: string;
  let v2: string;

  it("publish through the session → files in the instance repo, ONE commit per version by the reconciler, commit resolved on read", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    const r = await json("POST", "/api/artifacts", {
      project: P,
      slug: "site",
      files: [
        { path: "index.html", content: "<!doctype html><html><body><script>parent.document.cookie</script>hi</body></html>" },
        { path: "notes.md", content: "# Notes\n\nsee [[Alpha]]\n" },
        { path: "img/pixel.png", content_base64: png.toString("base64") },
      ],
      expected_current_version: null,
      idempotency_key: "site-1",
      message: "first cut",
    });
    expect(r.status).toBe(201);
    const body = await r.json();
    artifactId = body.artifact.id;
    v1 = body.version.id;
    expect(body.artifact).toMatchObject({ project: P, slug: "site", kind: "html", created_by: "user" });
    expect(body.version.manifest["index.html"].kind).toBe("html");
    expect(body.version.manifest["img/pixel.png"]).toMatchObject({ kind: "image", bytes: png.length });
    expect(body.links.review).toBe(`https://console.test/#/artifacts/${artifactId}/${v1}/review`);

    // the reconciler landed it: one commit, authored from the principal, subject tagged with the version
    const log = await repo.git.run(["log", "--format=%an%x1f%s", "--", `Artifacts/${P}/site`]);
    expect(log.trim().split("\n")).toEqual([`Metistry user\x1ffirst cut (${v1})`]);
    expect(readFileSync(`${repo.root}/Artifacts/${P}/site/notes.md`, "utf8")).toBe("# Notes\n\nsee [[Alpha]]\n");

    const r2 = await json("POST", "/api/artifacts", { project: P, slug: "site", files: [{ path: "index.html", content: "<html><body>v2</body></html>" }, { path: "img/pixel.png", content_base64: png.toString("base64") }], expected_current_version: v1, idempotency_key: "site-2", message: "second cut" });
    expect(r2.status).toBe(201);
    v2 = (await r2.json()).version.id;
    const log2 = await repo.git.run(["log", "--format=%s", "--", `Artifacts/${P}/site`]);
    expect(log2.trim().split("\n")).toEqual([`second cut (${v2})`, `first cut (${v1})`]);
    expect((await repo.git.raw(["ls-files", `Artifacts/${P}/site/notes.md`])).stdout.trim()).toBe(""); // dropped files go in the same commit

    const versions = (await (await json("GET", `/api/artifacts/${artifactId}/versions`)).json()).versions;
    expect(versions.map((v: any) => v.id)).toEqual([v2, v1]);
    expect(versions.every((v: any) => /^[0-9a-f]{40}$/.test(v.commit))).toBe(true); // resolved lazily from git log
    const diff = await (await json("GET", `/api/artifacts/${artifactId}/diff?from=${v1}&to=${v2}`)).json();
    expect(diff.diff).toContain("-<!doctype html>");
    expect(diff.diff).toContain("+<html><body>v2</body></html>");

    // CAS: stale → 409, retry with the same key → 200 + deduplicated
    expect((await json("POST", "/api/artifacts", { project: P, slug: "site", files: [{ path: "index.html", content: "x" }], expected_current_version: v1, idempotency_key: "site-3", message: "stale" })).status).toBe(409);
    const again = await json("POST", "/api/artifacts", { project: P, slug: "site", files: [{ path: "index.html", content: "x" }], idempotency_key: "site-2", message: "retry" });
    expect(again.status).toBe(200);
    expect((await again.json()).deduplicated).toBe(true);
  });

  it("raw file route: images render natively with no-store + nosniff; HTML is NEVER text/html on the console origin; superseded content is 503", async () => {
    const img = await fetch(`${base}/api/artifacts/${artifactId}/versions/${v1}/file?path=img/pixel.png&raw=1`, { headers: { cookie } }); // unchanged since v1: same hash, still served for v1
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("cache-control")).toBe("no-store");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(img.headers.get("content-disposition")).toMatch(/^inline/);
    expect(Buffer.from(await img.arrayBuffer())[0]).toBe(0x89);

    const html = await fetch(`${base}/api/artifacts/${artifactId}/versions/${v2}/file?path=index.html&raw=1`, { headers: { cookie } });
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("application/octet-stream");
    expect(html.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(html.headers.get("content-security-policy")).toContain("sandbox");

    const asJson = await (await json("GET", `/api/artifacts/${artifactId}/versions/${v2}/file?path=index.html`)).json();
    expect(asJson).toMatchObject({ kind: "html", content: "<html><body>v2</body></html>" });
    // v1's index.html was overwritten on the working tree by v2: not served as v1
    expect((await json("GET", `/api/artifacts/${artifactId}/versions/${v1}/file?path=index.html`)).status).toBe(503);
    expect((await json("GET", `/api/artifacts/${artifactId}/versions/${v2}/file?path=nope.md`)).status).toBe(404);
    expect((await json("GET", `/api/artifacts/${artifactId}/versions/${v2}/file?path=../../identity.yaml`)).status).toBe(404);
  });

  // Ruled 2026-09-19 (D): "the owner should always have access to everything
  // … dropping artifacts from the owner's access isn't right." The grant
  // validator that refuses `Artifacts/` is about AGENTS; this is the owner's
  // own read of the same bytes, through the door that has them, over a real
  // vault — unchanged by any of it.
  it("the OWNER reads Artifacts/ on both doors: the artifacts door serves the bytes, the knowledge door names it", async () => {
    // the file is really under Artifacts/ in the instance repo
    expect(readFileSync(`${repo.root}/Artifacts/${P}/site/index.html`, "utf8")).toBe("<html><body>v2</body></html>");

    const file = await (await json("GET", `/api/artifacts/${artifactId}/versions/${v2}/file?path=index.html`)).json();
    expect(file).toMatchObject({ kind: "html", content: "<html><body>v2</body></html>" });
    const raw = await fetch(`${base}/api/artifacts/${artifactId}/versions/${v2}/file?path=img/pixel.png&raw=1`, { headers: { cookie } });
    expect(raw.status).toBe(200); // bytes, with decision #14's headers on them
    expect((await (await json("GET", "/api/artifacts")).json()).artifacts.some((a: any) => a.id === artifactId)).toBe(true);

    // …and the knowledge door, which reads the INDEX and has never walked
    // Artifacts/, says where the bytes are rather than "no such page"
    const page = await (await json("GET", `/api/knowledge/page?path=${encodeURIComponent(`Artifacts/${P}/site/notes.md`)}`)).json();
    expect(page.error.message).toContain("/api/artifacts");
  });

  it("comments + dispatch through the routes: a thread, a reply, resolve; dispatch makes one review task and its bundle status is inferred", async () => {
    const c = await json("POST", `/api/artifacts/${artifactId}/comments`, { version: v2, body: "needs a title", path: "index.html", anchor: { line: 1 } });
    expect(c.status).toBe(201);
    const thread = (await c.json()).comment;
    expect(thread).toMatchObject({ author_principal: "user", author_kind: "human", state: "open" });
    expect((await json("POST", `/api/artifacts/${artifactId}/comments`, { parent: thread.id, body: "on it" })).status).toBe(201);
    const list = await (await json("GET", `/api/artifacts/${artifactId}/comments?version=${v2}`)).json();
    expect(list.threads).toHaveLength(1);
    expect(list.threads[0].replies).toHaveLength(1);

    const d = await json("POST", "/api/dispatches", { artifact: artifactId, version: v2, thread_ids: [thread.id], to_agent: agentId });
    expect(d.status).toBe(201);
    const dispatched = await d.json();
    expect(dispatched.route).toBe("work");
    expect(dispatched.work).toMatchObject({ kind: "review", project: P, owner: agentId, created_by: "user" });
    const work = await pool.query(`SELECT count(*)::int AS n FROM work WHERE project = $1 AND kind = 'review'`, [P]);
    expect(work.rows[0]!.n).toBe(1);

    expect(await (await json("GET", `/api/dispatches/${dispatched.work.id}`)).json()).toMatchObject({ addressed: false, threads: [{ id: thread.id, state: "open" }] });
    expect((await json("POST", `/api/artifacts/${artifactId}/comments/${thread.id}/resolve`)).status).toBe(200);
    expect((await (await json("GET", `/api/dispatches/${dispatched.work.id}`)).json()).addressed).toBe(true);
    expect((await json("GET", `/api/dispatches/999999999`)).status).toBe(404);
    expect((await json("POST", "/api/dispatches", { artifact: artifactId, version: v2, thread_ids: ["cmt_01J00000000000000000000000"], to_agent: agentId })).status).toBe(400);
  });

  // --- rooms on work rows (0016) ---------------------------------------------------

  it("a room on a work row: the user posts as `user`, resolve is a route with no counterpart anywhere else, and the `rooms` query renders both anchors", async () => {
    const { rows } = await pool.query(`INSERT INTO work (title, project, kind, status) VALUES ('scope the console room', $1, 'task', 'open') RETURNING id`, [P]);
    const workId = Number(rows[0]!.id);

    const empty = await (await json("GET", `/api/work/${workId}/thread`)).json();
    expect(empty).toMatchObject({ work_id: workId, project: P, state: "open", comments: [], participants: [] });
    expect((await json("GET", "/api/work/999999999/thread")).status).toBe(404);

    const posted = await json("POST", `/api/work/${workId}/comments`, { body: "does this include the migration?" });
    expect(posted.status).toBe(201);
    expect((await posted.json()).comment).toMatchObject({ work_id: workId, author_principal: "user", author_kind: "human" });
    expect((await json("POST", `/api/work/${workId}/comments`, {})).status).toBe(400); // no body

    // an agent's voice in the same room, through the module (the bridge's path)
    await pool.query(
      `INSERT INTO artifact_comments (id, work_id, body, author_principal, author_kind, parent_id)
       SELECT 'cmt_' || $1, $2, 'it does — I will take the schema', $3, 'agent', c.id FROM artifact_comments c WHERE c.work_id = $2 AND c.parent_id IS NULL`,
      ["0".repeat(25) + "9", workId, agentId],
    );

    const read = await (await json("GET", `/api/work/${workId}/thread`)).json();
    expect(read.comments.map((c: { body: string }) => c.body)).toEqual(["does this include the migration?", "it does — I will take the schema"]);
    expect(read.participants.map((p: { principal: string }) => p.principal)).toEqual(["user", agentId]);
    expect(read.link).toBe(`https://console.test/#/rooms/work/${workId}`);

    // resolve: this route and no other. Nothing on the agent surface, nothing on a timer.
    const resolved = await json("POST", `/api/work/${workId}/thread/resolve`);
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ state: "resolved", resolved_by: "user" });
    expect((await (await json("POST", `/api/work/${workId}/thread/reopen`)).json()).state).toBe("open");
    expect((await json("POST", `/api/work/${workId}/thread/close`)).status).toBe(404); // no third verb

    // the room view reads one named query and nothing else (invariant 3)
    const roomsRes = await json("GET", `/api/q/rooms?project=${P}&limit=50`);
    expect(roomsRes.status).toBe(200);
    const roomRows = (await roomsRes.json()).rows as any[];
    const room = roomRows.find((r) => r.anchor === "work" && Number(r.work_id) === workId)!;
    expect(room).toMatchObject({ state: "open", messages: 2, agent_tail: 1, cap: 10, escalated: false });
    expect(room.title).toContain("scope the console room");
    expect(room.participants.map((p: { principal: string }) => p.principal).sort()).toEqual([agentId, "user"].sort());
    expect(roomRows.some((r) => r.anchor === "artifact")).toBe(true); // the artifact threads this suite made are in the same view
  });

  it("without a vault the routes answer not_available (degrades: absent)", async () => {
    const bare = makeServer(pool, new QueryStore(pool), { origin: "https://console.test", inboxDir: "/tmp/unused", policy, secureCookies: false });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    const r = await fetch(`http://127.0.0.1:${(bare.address() as AddressInfo).port}/api/artifacts`, { headers: { cookie } });
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe("not_available");
    await new Promise<void>((r) => bare.close(() => r()));
  });
});
