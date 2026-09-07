// Vault bridge wire contract + committer, against a throwaway git repo.
// No database: the index loop has its own integration test.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { Committer } from "../src/committer.js";
import { Vault } from "../src/vault.js";
import { makeBridge } from "../src/server.js";
import { sha256 } from "../src/notes.js";
import { tempRepo, type TempRepo } from "./helpers.js";

const token = mintToken();
const intent = (principal: string, message: string, group?: string) => ({ principal, message, ...(group ? { group } : {}) });

describe("vault bridge", () => {
  let repo: TempRepo;
  let committer: Committer;
  let base: string;
  let server: ReturnType<typeof makeBridge>;
  const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = (path: string, body: unknown, headers: Record<string, string> = H) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const get = (path: string, headers: Record<string, string> = H) => fetch(`${base}${path}`, { headers });

  beforeAll(async () => {
    repo = await tempRepo();
    committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test", sourceTrailer: "Brain-Source" });
    const vault = new Vault(repo.root, repo.git, committer, { maxBytes: 4096 });
    server = makeBridge({ vault, committer }, { token, maxBodyBytes: 64 * 1024 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await repo.cleanup();
  });

  it("refuses missing/wrong bearer with the uniform envelope (CRIT-9)", async () => {
    const r = await get("/vault/read?path=Knowledge/now.md", {});
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
    expect((await get("/check", { authorization: `Bearer ${mintToken()}` })).status).toBe(401);
    expect((await post("/vault/write", { path: "Knowledge/x.md", content: "x", intent: intent("assistant", "m") }, { "content-type": "application/json" })).status).toBe(401);
  });

  it("check() is the frozen shape and probes the repo", async () => {
    const c = await (await get("/check")).json();
    expect(c).toMatchObject({ name: "reconciler", status: "ok", meta: { queue_depth: 0 } });
    expect(typeof c.meta.head).toBe("string");
    expect(typeof c.latency_ms).toBe("number");
  });

  it("reads a note with its content hash; unknown → not_found", async () => {
    const r = await get("/vault/read?path=Knowledge/Areas/Alpha.md");
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.path).toBe("Knowledge/Areas/Alpha.md");
    expect(b.content).toContain("[[Beta]]");
    expect(b.sha256).toBe(sha256(await readFile(join(repo.root, "Knowledge/Areas/Alpha.md"))));
    expect((await get("/vault/read?path=Knowledge/Nope.md")).status).toBe(404);
  });

  it("lists under a prefix with depth", async () => {
    const shallow = await (await get("/vault/list?prefix=Knowledge&depth=1")).json();
    expect(shallow.entries.map((e: any) => e.path)).toEqual(["Knowledge/Areas", "Knowledge/now.md"]);
    const deep = await (await get("/vault/list?prefix=Knowledge&depth=2")).json();
    expect(deep.entries.map((e: any) => e.path)).toContain("Knowledge/Areas/Alpha.md");
    expect(deep.entries.map((e: any) => e.path)).not.toContain(".git"); // never listed
  });

  // path confinement at the wire — each of these is a distinct attack shape
  it("refuses traversal, absolute, .git, instance-migrations/, lowercase knowledge/ on read and write", async () => {
    const cases: Array<[string, number]> = [
      ["../../etc/passwd", 400],
      ["/etc/passwd", 400],
      ["Knowledge/../../x.md", 400],
      ["knowledge/Areas/Alpha.md", 400],
      [".git/config", 403],
      ["Knowledge/.git/x", 403],
      ["instance-migrations/0002_evil.sql", 403],
    ];
    for (const [p, status] of cases) {
      expect((await get(`/vault/read?path=${encodeURIComponent(p)}`)).status, `read ${p}`).toBe(status);
      const w = await post("/vault/write", { path: p, content: "x", intent: intent("user", "try") });
      expect(w.status, `write ${p}`).toBe(status);
    }
    expect((await get(`/vault/read?path=`)).status).toBe(400);
  });

  it("refuses a write through a symlink component", async () => {
    const { symlink, unlink } = await import("node:fs/promises");
    await symlink("/", join(repo.root, "Knowledge", "Root"));
    const w = await post("/vault/write", { path: "Knowledge/Root/tmp/owned.txt", content: "x", intent: intent("user", "try") });
    expect(w.status).toBe(403);
    await unlink(join(repo.root, "Knowledge", "Root"));
  });

  it("protected paths: forbidden for every principal but user (§4.7)", async () => {
    for (const p of ["identity.yaml", "rules.yaml", "sources.yaml", "deployment.yaml", "metistry.lock", "CLAUDE.md", "queries/q.yaml"]) {
      const r = await post("/vault/write", { path: p, content: "name: Mallory\n", intent: intent("assistant", "rename myself") });
      expect(r.status, p).toBe(403);
      expect(await r.json()).toEqual({ error: { code: "forbidden", message: "not granted" } });
    }
    expect(await readFile(join(repo.root, "identity.yaml"), "utf8")).toBe("name: Example\n"); // untouched
    const ok = await post("/vault/write", { path: "sources.yaml", content: "sources: []\n", intent: intent("user", "add sources") });
    expect(ok.status).toBe(201);
    // renaming a vault note ONTO a protected path is refused too
    const mv = await post("/vault/rename", { from: "Knowledge/now.md", to: "rules.yaml", intent: intent("assistant", "sneaky") });
    expect(mv.status).toBe(403);
    const rm = await post("/vault/delete", { path: "identity.yaml", intent: intent("assistant", "sneaky") });
    expect(rm.status).toBe(403);
  });

  it("rejects malformed intents and bodies", async () => {
    expect((await post("/vault/write", { path: "Knowledge/x.md", content: "x" })).status).toBe(400); // no intent
    expect((await post("/vault/write", { path: "Knowledge/x.md", content: "x", intent: { principal: "Bad Name", message: "m" } })).status).toBe(400);
    expect((await post("/vault/write", { path: "Knowledge/x.md", content: "x", intent: { principal: "assistant" } })).status).toBe(400); // no message
    expect((await post("/vault/write", { path: "Knowledge/x.md", content: "x", content_base64: "eA==", intent: intent("assistant", "m") })).status).toBe(400); // both
    expect((await post("/vault/write", { path: "Knowledge/x.md", intent: intent("assistant", "m") })).status).toBe(400); // neither
    expect((await post("/vault/write", { path: "Knowledge/x.md", content: "x", intent: intent("assistant", "m"), expected_sha256: "zz" })).status).toBe(400);
    const big = await post("/vault/write", { path: "Knowledge/Big.md", content: "x".repeat(5000), intent: intent("assistant", "m") });
    expect(big.status).toBe(400); // over the size cap
  });

  it("write lands on the working tree before any commit; CAS mismatch → 409", async () => {
    const before = (await repo.git.head())!;
    const w = await post("/vault/write", { path: "Knowledge/Areas/Delta.md", content: "# Delta\n", intent: intent("assistant", "Add Delta"), expected_sha256: "" });
    expect(w.status).toBe(201);
    const body = await w.json();
    expect(body).toMatchObject({ path: "Knowledge/Areas/Delta.md", sha256: sha256("# Delta\n"), created: true, queued: true });
    // visible at once
    expect((await (await get("/vault/read?path=Knowledge/Areas/Delta.md")).json()).content).toBe("# Delta\n");
    expect(await repo.git.head()).toBe(before); // no commit yet
    // creating again with expected "" (must not exist) → conflict
    expect((await post("/vault/write", { path: "Knowledge/Areas/Delta.md", content: "other", intent: intent("assistant", "x"), expected_sha256: "" })).status).toBe(409);
    // stale hash → conflict; right hash → ok
    expect((await post("/vault/write", { path: "Knowledge/Areas/Delta.md", content: "v2", intent: intent("assistant", "x"), expected_sha256: sha256("stale") })).status).toBe(409);
    const ok = await post("/vault/write", { path: "Knowledge/Areas/Delta.md", content: "# Delta v2\n", intent: intent("assistant", "Revise Delta"), expected_sha256: body.sha256 });
    expect(ok.status).toBe(200);
    expect((await get("/check")).ok).toBe(true);
    expect((await (await get("/check")).json()).meta.queue_depth).toBeGreaterThan(0);
  });

  it("flush: exactly one commit per group with the server-stamped author; request names never become authors", async () => {
    const before = (await repo.git.head())!;
    // two intents in one group → one commit; one intent in another group → another; a third principal → a third
    await post("/vault/write", { path: "Knowledge/Areas/E1.md", content: "e1", intent: intent("assistant", "Add E1", "batch-1") });
    await post("/vault/write", { path: "Knowledge/Areas/E2.md", content: "e2", intent: intent("assistant", "Add E2", "batch-1") });
    await post("/vault/write", { path: "Knowledge/Areas/F.md", content: "f", intent: intent("assistant", "Add F", "batch-2") });
    await post("/vault/write", { path: "Knowledge/Areas/G.md", content: "g", intent: { principal: "researcher", message: "Add G", author: "Mallory <m@evil>", name: "Mallory" } });
    const r = await (await post("/flush", {})).json();
    // the earlier test's two Delta intents (group = principal 'assistant') + sources.yaml (user) also flush here
    const log = await repo.git.run(["log", `${before}..HEAD`, "--format=%an <%ae>%x1f%s%x1e"]);
    const commits = log.split("\x1e").map((l) => l.trim()).filter(Boolean).map((l) => l.split("\x1f"));
    const byAuthor = commits.map((c) => c[0]);
    expect(byAuthor.filter((a) => a === "Metistry assistant <metistry@test>").length).toBe(3); // Delta group, batch-1, batch-2
    expect(byAuthor).toContain("Metistry researcher <metistry@test>");
    expect(byAuthor).toContain("Metistry user <metistry@test>");
    expect(byAuthor.join("\n")).not.toContain("Mallory");
    expect(r.commits.length).toBe(commits.length);
    const batch1 = r.commits.find((c: any) => c.group === "batch-1");
    expect(batch1.paths).toEqual(["Knowledge/Areas/E1.md", "Knowledge/Areas/E2.md"]);
    const files = await repo.git.run(["show", "--name-only", "--format=", batch1.sha]);
    expect(files.trim().split("\n").sort()).toEqual(["Knowledge/Areas/E1.md", "Knowledge/Areas/E2.md"]);
    const msg = await repo.git.run(["show", "-s", "--format=%B", batch1.sha]);
    expect(msg).toContain("Add E1");
    expect(msg).toContain("- Add E2");
    expect(msg).toContain("Brain-Source: assistant");
    expect(await repo.git.status()).toEqual([]); // nothing left dirty
    expect(committer.depth).toBe(0);
  });

  it("a second flush with an empty queue commits nothing", async () => {
    const head = await repo.git.head();
    expect(await (await post("/flush", {})).json()).toEqual({ commits: [], skipped: 0, failed: 0 });
    expect(await repo.git.head()).toBe(head);
  });

  it("rename lands as a git rename; delete removes and commits", async () => {
    const mv = await post("/vault/rename", { from: "Knowledge/Areas/F.md", to: "Knowledge/Areas/Moved/F2.md", intent: intent("assistant", "Move F") });
    expect(mv.status).toBe(200);
    expect((await get("/vault/read?path=Knowledge/Areas/F.md")).status).toBe(404);
    expect((await (await get("/vault/read?path=Knowledge/Areas/Moved/F2.md")).json()).content).toBe("f");
    expect((await post("/vault/rename", { from: "Knowledge/Areas/G.md", to: "Knowledge/Areas/Moved/F2.md", intent: intent("assistant", "clobber") })).status).toBe(409);
    await post("/flush", {});
    const show = await repo.git.run(["show", "--name-status", "--format=", "-M", "HEAD"]);
    expect(show).toMatch(/^R\d+\tKnowledge\/Areas\/F\.md\tKnowledge\/Areas\/Moved\/F2\.md/m);
    const del = await post("/vault/delete", { path: "Knowledge/Areas/G.md", intent: intent("assistant", "Drop G") });
    expect(del.status).toBe(200);
    expect((await post("/vault/delete", { path: "Knowledge/Areas/G.md", intent: intent("assistant", "again") })).status).toBe(404);
    await post("/flush", {});
    expect(await repo.git.run(["show", "--name-status", "--format=", "HEAD"])).toContain("D\tKnowledge/Areas/G.md");
  });

  it("log and diff read history through git", async () => {
    const log = await (await get("/vault/log?path=Knowledge/Areas/Delta.md&limit=5")).json();
    expect(log.entries.length).toBe(1);
    expect(log.entries[0]).toMatchObject({ author: "Metistry assistant", subject: "Add Delta" });
    const all = await (await get("/vault/log?limit=3")).json();
    expect(all.entries.length).toBe(3);
    await post("/vault/write", { path: "Knowledge/Areas/Delta.md", content: "# Delta v3\n", intent: intent("assistant", "again") });
    const d = await (await get("/vault/diff?path=Knowledge/Areas/Delta.md")).json(); // HEAD vs working tree
    expect(d.diff).toContain("-# Delta v2");
    expect(d.diff).toContain("+# Delta v3");
    expect((await get("/vault/diff?from=--output=/tmp/x")).status).toBe(400); // an option is not a revision
    expect((await get("/vault/diff?from=nope-not-a-rev")).status).toBe(404);
  });

  it("search matches settled notes and excludes drafts", async () => {
    const r = await (await get("/vault/search?q=zebra")).json();
    const paths = r.hits.map((h: any) => h.path);
    expect(paths).toContain("Knowledge/Areas/Beta.md");
    expect(paths).not.toContain("Knowledge/Areas/Draft.md");
    expect(r.hits.find((h: any) => h.path === "Knowledge/Areas/Beta.md").snippet).toContain("zebra");
    const byTitle = await (await get("/vault/search?q=alpha")).json();
    expect(byTitle.hits[0]).toMatchObject({ path: "Knowledge/Areas/Alpha.md", title: "Alpha", description: "the first area" });
    expect((await get("/vault/search?q=")).status).toBe(400);
  });

  it("reconcile is not_available without an index db; unknown routes are 404", async () => {
    expect((await post("/reconcile", {})).status).toBe(503);
    expect((await get("/nope")).status).toBe(404);
  });
});
