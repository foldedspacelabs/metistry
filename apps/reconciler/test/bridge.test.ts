// Vault bridge wire contract + committer, against a throwaway git repo.
// No database: the index loop has its own integration test.
import { existsSync } from "node:fs";
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

// Two bearers, because the bridge has two caller CLASSES since 2026-09-20:
// `token` is the console's (and every caller it fronts), `ownerToken` is the
// local owner's hand — the CLI's protected-path writer. Which one a request
// presents is the whole of its authority; `intent.principal` is attribution
// inside that.
const token = mintToken();
const ownerToken = mintToken();
const intent = (principal: string, message: string, group?: string) => ({ principal, message, ...(group ? { group } : {}) });

describe("vault bridge", () => {
  let repo: TempRepo;
  let committer: Committer;
  let base: string;
  let server: ReturnType<typeof makeBridge>;
  const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const OWNER = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };
  const post = (path: string, body: unknown, headers: Record<string, string> = H) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const get = (path: string, headers: Record<string, string> = H) => fetch(`${base}${path}`, { headers });

  beforeAll(async () => {
    repo = await tempRepo();
    committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test", sourceTrailer: "Brain-Source" });
    const vault = new Vault(repo.root, repo.git, committer, { maxBytes: 4096 });
    server = makeBridge({ vault, committer }, { token, ownerToken, maxBodyBytes: 64 * 1024 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await repo.cleanup();
  });

  it("refuses missing/wrong bearer with the uniform envelope (CRIT-9)", async () => {
    const r = await get("/vault/read?path=now.md", {});
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
    expect((await get("/check", { authorization: `Bearer ${mintToken()}` })).status).toBe(401);
    expect((await post("/vault/write", { path: "x.md", content: "x", intent: intent("assistant", "m") }, { "content-type": "application/json" })).status).toBe(401);
  });

  it("check() is the frozen shape and probes the repo", async () => {
    const c = await (await get("/check")).json();
    expect(c).toMatchObject({ name: "reconciler", status: "ok", meta: { queue_depth: 0 } });
    expect(typeof c.meta.head).toBe("string");
    expect(typeof c.latency_ms).toBe("number");
  });

  it("reads a note with its content hash; unknown → not_found", async () => {
    const r = await get("/vault/read?path=Areas/Alpha.md");
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.path).toBe("Areas/Alpha.md");
    expect(b.content).toContain("[[Beta]]");
    expect(b.sha256).toBe(sha256(await readFile(join(repo.root, "Areas/Alpha.md"))));
    expect((await get("/vault/read?path=Nope.md")).status).toBe(404);
  });

  it("encoding=base64 returns the bytes untouched (binary artifacts must survive the round trip)", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]);
    const w = await post("/vault/write", { path: "Artifacts/p/s/pixel.png", content_base64: png.toString("base64"), intent: intent("user", "binary") });
    expect(w.status).toBe(201);
    const b = await (await get("/vault/read?path=Artifacts/p/s/pixel.png&encoding=base64")).json();
    expect(b.content).toBeUndefined();
    expect(Buffer.from(b.content_base64, "base64").equals(png)).toBe(true);
    expect(b.bytes).toBe(png.length);
    expect(b.sha256).toBe(sha256(png));
  });

  it("lists under a prefix with depth", async () => {
    const shallow = await (await get("/vault/list?prefix=Areas&depth=1")).json();
    expect(shallow.entries.map((e: any) => e.path)).toContain("Areas/Alpha.md");
    const deep = await (await get("/vault/list?depth=2")).json(); // no prefix = the vault root
    expect(deep.entries.map((e: any) => e.path)).toContain("Areas/Alpha.md");
    expect(deep.entries.map((e: any) => e.path)).not.toContain(".git"); // never listed
  });

  // path confinement at the wire — each of these is a distinct attack shape
  it("refuses traversal, absolute, .git, .metistry/instance-migrations/, a mis-cased root on read and write", async () => {
    const cases: Array<[string, number]> = [
      ["../../etc/passwd", 400],
      ["/etc/passwd", 400],
      ["../../x.md", 400],
      ["inbox/x.md", 400], // the casing rule at the root
      ["claude.md", 400],
      [".git/config", 403],
      [".git/x", 403],
      [".metistry/instance-migrations/0002_evil.sql", 403],
    ];
    for (const [p, status] of cases) {
      expect((await get(`/vault/read?path=${encodeURIComponent(p)}`)).status, `read ${p}`).toBe(status);
      const w = await post("/vault/write", { path: p, content: "x", intent: intent("user", "try") });
      expect(w.status, `write ${p}`).toBe(status);
    }
    expect((await get(`/vault/read?path=`)).status).toBe(400);
  });

  // Defence in depth: none of these paths are traversal, `.git`, or
  // `.metistry/instance-migrations/` — confine() has no reason to refuse them, and
  // without the isVaultPath gate they read back at 200. #197 narrowed the console's
  // `/api/knowledge/*` with core's isVaultPath; this is the reconciler doing the same
  // narrowing itself, so a caller that goes straight to the bridge (skipping the
  // console) still cannot read `.metistry/state/.env`.
  it("refuses to serve machinery through /vault/read — .metistry/**, .obsidian/**, the root CLAUDE.md/README.md — even though confine() lets the write through", async () => {
    for (const [p, content] of [
      [".metistry/state/.env", "METISTRY_DB_PASSWORD=secret\n"],
      ["CLAUDE.md", "# instructions\n"],
      ["README.md", "# readme\n"],
    ] as const) {
      const w = await post("/vault/write", { path: p, content, intent: intent("user", "seed a file the read gate must still refuse") }, OWNER);
      expect(w.status, `write ${p}`).toBe(201);
    }
    // `.obsidian/` is in the seed repo's `.gitignore` (real instances do the same) —
    // written straight to disk rather than through `/vault/write`, which would enqueue
    // a commit the committer can never make.
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(repo.root, ".obsidian"), { recursive: true });
    await writeFile(join(repo.root, ".obsidian", "workspace.json"), "{}");
    for (const p of [".metistry/state/.env", ".metistry/identity.yaml", ".obsidian/workspace.json", "CLAUDE.md", "README.md"]) {
      const r = await get(`/vault/read?path=${encodeURIComponent(p)}`);
      expect(r.status, p).toBe(404);
      expect(await r.json(), p).toEqual({ error: { code: "not_found", message: "not found" } });
    }
    // the one exception: Artifacts/** is binary content the artifacts service reads
    // through this same endpoint, not vault knowledge — it must stay readable.
    expect((await get("/vault/read?path=Artifacts/bundle-1/report.md")).status).toBe(200);
  });

  it("refuses a write through a symlink component", async () => {
    const { symlink, unlink } = await import("node:fs/promises");
    await symlink("/", join(repo.root, "", "Root"));
    const w = await post("/vault/write", { path: "Root/tmp/owned.txt", content: "x", intent: intent("user", "try") });
    expect(w.status).toBe(403);
    await unlink(join(repo.root, "", "Root"));
  });

  it("protected paths: forbidden for every principal but user (§4.7)", async () => {
    for (const p of [".metistry/identity.yaml", ".metistry/rules.yaml", ".metistry/sources.yaml", ".metistry/deployment.yaml", ".metistry/metistry.lock", "CLAUDE.md", "README.md", ".metistry/queries/q.yaml"]) {
      const r = await post("/vault/write", { path: p, content: "name: Mallory\n", intent: intent("assistant", "rename myself") }, OWNER);
      expect(r.status, p).toBe(403);
      expect(await r.json()).toEqual({ error: { code: "forbidden", message: "not granted" } });
    }
    expect(await readFile(join(repo.root, ".metistry", "identity.yaml"), "utf8")).toBe("name: Example\n"); // untouched
    const ok = await post("/vault/write", { path: ".metistry/sources.yaml", content: "sources: []\n", intent: intent("user", "add sources") }, OWNER);
    expect(ok.status).toBe(201);
    // renaming a vault note ONTO a protected path is refused too
    const mv = await post("/vault/rename", { from: "now.md", to: ".metistry/rules.yaml", intent: intent("assistant", "sneaky") }, OWNER);
    expect(mv.status).toBe(403);
    const rm = await post("/vault/delete", { path: ".metistry/identity.yaml", intent: intent("assistant", "sneaky") }, OWNER);
    expect(rm.status).toBe(403);
  });

  // ---- the principal comes from the CREDENTIAL (owner's ruling 2026-09-20) ----
  //
  // Until this shipped, `intent.principal` was the whole §4.7 check, and it
  // is a field in a body: every holder of the one shared bearer could write
  // `"principal": "user"` and rewrite `rules.yaml`, an agent definition, a
  // named query or `CLAUDE.md`. "Nothing does" is not "nothing can".

  it("the console's bearer claiming `user` is refused on a protected path — and not silently downgraded", async () => {
    for (const p of [".metistry/deployment.yaml", ".metistry/rules.yaml", ".metistry/metistry.lock", ".metistry/queries/q.yaml", ".metistry/agents/mallory/manifest.yaml", "CLAUDE.md"]) {
      const r = await post("/vault/write", { path: p, content: "shape: launchd\n", intent: intent("user", "I am the user, honest") });
      expect(r.status, p).toBe(403);
      expect(await r.json()).toEqual({ error: { code: "forbidden", message: "not granted" } });
    }
    // …and nothing landed on the working tree: a refusal is not a write with
    // a different author
    expect(await readFile(join(repo.root, ".metistry", "identity.yaml"), "utf8")).toBe("name: Example\n");
    expect(existsSync(join(repo.root, ".metistry", "agents", "mallory"))).toBe(false);
    // delete and rename are the same door
    expect((await post("/vault/delete", { path: ".metistry/sources.yaml", intent: intent("user", "tidy up") })).status).toBe(403);
    expect((await post("/vault/rename", { from: "now.md", to: "CLAUDE.md", intent: intent("user", "tidy up") })).status).toBe(403);
  });

  it("the owner's bearer writes the protected set, and may be nobody but the user", async () => {
    const ok = await post("/vault/write", { path: ".metistry/deployment.yaml", content: "shape: launchd\n", intent: intent("user", "metistry deployment set-shape → launchd") }, OWNER);
    expect(ok.status).toBe(201);
    // the CLI's own verbs, spelled as they spell them
    expect((await post("/vault/write", { path: ".metistry/metistry.lock", content: "product:\n  version: 0.10.0\n", intent: intent("user", "metistry update → 0.10.0") }, OWNER)).status).toBe(201);
    // …but an owner bearer is the user and nothing else: no forging an agent
    // into the git record with the strongest credential on the machine
    expect((await post("/vault/write", { path: "Areas/Owned.md", content: "x", intent: intent("researcher", "not me") }, OWNER)).status).toBe(403);
  });

  it("the console keeps its two enumerated protected doors: §4.10's prompt overlay and the Compute pane", async () => {
    const w = await post("/vault/write", { path: ".metistry/assistant-prompt.md", content: "# overlay\n", intent: intent("user", "assistant prompt: apply improvement proposal #7") });
    expect(w.status).toBe(201);
    // `POST /api/compute/assign` — the owner moving a tier to a cheaper model
    // from the phone, through the same function `metistry compute` calls
    const c = await post("/vault/write", { path: ".metistry/compute.yaml", content: "providers: {}\n", intent: intent("user", "metistry compute assign default → lmstudio/gemma") });
    expect(c.status).toBe(201);
    // and both are still the user's name on it — authority moved, attribution did not
    expect((await post("/vault/write", { path: ".metistry/assistant-prompt.md", content: "# no", intent: intent("assistant", "rewrite myself") })).status).toBe(403);
    expect((await post("/vault/write", { path: ".metistry/compute.yaml", content: "providers: {}\n", intent: intent("assistant", "pick my own model") })).status).toBe(403);
  });

  it("an agent relayed through the console cannot escalate: the bearer is the console's, whatever the body says", async () => {
    // mcp-brain stamps `intent.principal` from the agent's own credential, so
    // a crew write arrives as `agent-seven`. The escalation this refuses is
    // the body being rewritten anywhere between that agent and here.
    expect((await post("/vault/write", { path: "Areas/Crew.md", content: "notes", intent: intent("agent-seven", "crew note") })).status).toBe(201);
    expect((await post("/vault/write", { path: ".metistry/agents/agent-seven/manifest.yaml", content: "grants: all\n", intent: intent("agent-seven", "widen myself") })).status).toBe(403);
    expect((await post("/vault/write", { path: ".metistry/agents/agent-seven/manifest.yaml", content: "grants: all\n", intent: intent("user", "widen myself") })).status).toBe(403);
  });

  it("a bearer that is neither class is 401, and the owner bearer is not accepted as the console's", async () => {
    expect((await post("/vault/write", { path: "Areas/X.md", content: "x", intent: intent("user", "m") }, { authorization: `Bearer ${mintToken()}`, "content-type": "application/json" })).status).toBe(401);
    // the owner bearer is a superset of nothing: it reads like any caller
    expect((await get("/vault/read?path=now.md", OWNER)).status).toBe(200);
  });

  it("rejects malformed intents and bodies", async () => {
    expect((await post("/vault/write", { path: "x.md", content: "x" })).status).toBe(400); // no intent
    expect((await post("/vault/write", { path: "x.md", content: "x", intent: { principal: "Bad Name", message: "m" } })).status).toBe(400);
    expect((await post("/vault/write", { path: "x.md", content: "x", intent: { principal: "assistant" } })).status).toBe(400); // no message
    // run / turn become trailer lines: anything but an id would forge one (§2.21)
    expect((await post("/vault/write", { path: "x.md", content: "x", intent: { ...intent("assistant", "m"), turn: "t\nBrain-Source: user" } })).status).toBe(400);
    expect((await post("/vault/write", { path: "x.md", content: "x", intent: { ...intent("assistant", "m"), run: "1\nMetistry-Turn: x" } })).status).toBe(400);
    expect((await post("/vault/write", { path: "x.md", content: "x", content_base64: "eA==", intent: intent("assistant", "m") })).status).toBe(400); // both
    expect((await post("/vault/write", { path: "x.md", intent: intent("assistant", "m") })).status).toBe(400); // neither
    expect((await post("/vault/write", { path: "x.md", content: "x", intent: intent("assistant", "m"), expected_sha256: "zz" })).status).toBe(400);
    const big = await post("/vault/write", { path: "Big.md", content: "x".repeat(5000), intent: intent("assistant", "m") });
    expect(big.status).toBe(400); // over the size cap
  });

  it("write lands on the working tree before any commit; CAS mismatch → 409", async () => {
    const before = (await repo.git.head())!;
    const w = await post("/vault/write", { path: "Areas/Delta.md", content: "# Delta\n", intent: intent("assistant", "Add Delta"), expected_sha256: "" });
    expect(w.status).toBe(201);
    const body = await w.json();
    expect(body).toMatchObject({ path: "Areas/Delta.md", sha256: sha256("# Delta\n"), created: true, queued: true });
    // visible at once
    expect((await (await get("/vault/read?path=Areas/Delta.md")).json()).content).toBe("# Delta\n");
    expect(await repo.git.head()).toBe(before); // no commit yet
    // creating again with expected "" (must not exist) → conflict
    expect((await post("/vault/write", { path: "Areas/Delta.md", content: "other", intent: intent("assistant", "x"), expected_sha256: "" })).status).toBe(409);
    // stale hash → conflict; right hash → ok
    expect((await post("/vault/write", { path: "Areas/Delta.md", content: "v2", intent: intent("assistant", "x"), expected_sha256: sha256("stale") })).status).toBe(409);
    const ok = await post("/vault/write", { path: "Areas/Delta.md", content: "# Delta v2\n", intent: intent("assistant", "Revise Delta"), expected_sha256: body.sha256 });
    expect(ok.status).toBe(200);
    expect((await get("/check")).ok).toBe(true);
    expect((await (await get("/check")).json()).meta.queue_depth).toBeGreaterThan(0);
  });

  it("flush: exactly one commit per group with the server-stamped author; request names never become authors", async () => {
    const before = (await repo.git.head())!;
    // two intents in one group → one commit; one intent in another group → another; a third principal → a third
    await post("/vault/write", { path: "Areas/E1.md", content: "e1", intent: intent("assistant", "Add E1", "batch-1") });
    await post("/vault/write", { path: "Areas/E2.md", content: "e2", intent: intent("assistant", "Add E2", "batch-1") });
    await post("/vault/write", { path: "Areas/F.md", content: "f", intent: intent("assistant", "Add F", "batch-2") });
    await post("/vault/write", { path: "Areas/G.md", content: "g", intent: { principal: "researcher", message: "Add G", author: "Mallory <m@evil>", name: "Mallory" } });
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
    expect(batch1.paths).toEqual(["Areas/E1.md", "Areas/E2.md"]);
    const files = await repo.git.run(["show", "--name-only", "--format=", batch1.sha]);
    expect(files.trim().split("\n").sort()).toEqual(["Areas/E1.md", "Areas/E2.md"]);
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
    const mv = await post("/vault/rename", { from: "Areas/F.md", to: "Areas/Moved/F2.md", intent: intent("assistant", "Move F") });
    expect(mv.status).toBe(200);
    expect((await get("/vault/read?path=Areas/F.md")).status).toBe(404);
    expect((await (await get("/vault/read?path=Areas/Moved/F2.md")).json()).content).toBe("f");
    expect((await post("/vault/rename", { from: "Areas/G.md", to: "Areas/Moved/F2.md", intent: intent("assistant", "clobber") })).status).toBe(409);
    await post("/flush", {});
    const show = await repo.git.run(["show", "--name-status", "--format=", "-M", "HEAD"]);
    expect(show).toMatch(/^R\d+\tAreas\/F\.md\tAreas\/Moved\/F2\.md/m);
    const del = await post("/vault/delete", { path: "Areas/G.md", intent: intent("assistant", "Drop G") });
    expect(del.status).toBe(200);
    expect((await post("/vault/delete", { path: "Areas/G.md", intent: intent("assistant", "again") })).status).toBe(404);
    await post("/flush", {});
    expect(await repo.git.run(["show", "--name-status", "--format=", "HEAD"])).toContain("D\tAreas/G.md");
  });

  it("log and diff read history through git", async () => {
    const log = await (await get("/vault/log?path=Areas/Delta.md&limit=5")).json();
    expect(log.entries.length).toBe(1);
    expect(log.entries[0]).toMatchObject({ author: "Metistry assistant", subject: "Add Delta" });
    const all = await (await get("/vault/log?limit=3")).json();
    expect(all.entries.length).toBe(3);
    await post("/vault/write", { path: "Areas/Delta.md", content: "# Delta v3\n", intent: intent("assistant", "again") });
    const d = await (await get("/vault/diff?path=Areas/Delta.md")).json(); // HEAD vs working tree
    expect(d.diff).toContain("-# Delta v2");
    expect(d.diff).toContain("+# Delta v3");
    expect((await get("/vault/diff?from=--output=/tmp/x")).status).toBe(400); // an option is not a revision
    expect((await get("/vault/diff?from=nope-not-a-rev")).status).toBe(404);
  });

  it("search matches settled notes and excludes drafts", async () => {
    const r = await (await get("/vault/search?q=zebra")).json();
    const paths = r.hits.map((h: any) => h.path);
    expect(paths).toContain("Areas/Beta.md");
    expect(paths).not.toContain("Areas/Draft.md");
    expect(r.hits.find((h: any) => h.path === "Areas/Beta.md").snippet).toContain("zebra");
    const byTitle = await (await get("/vault/search?q=alpha")).json();
    expect(byTitle.hits[0]).toMatchObject({ path: "Areas/Alpha.md", title: "Alpha", description: "the first area" });
    expect((await get("/vault/search?q=")).status).toBe(400);
  });

  it("reconcile is not_available without an index db; unknown routes are 404", async () => {
    expect((await post("/reconcile", {})).status).toBe(503);
    expect((await get("/nope")).status).toBe(404);
  });
});

/**
 * Two properties that need their own server: what happens with no owner
 * bearer configured at all (an install that has not run `metistry secrets
 * sync --to env` yet), and the `runs` row a refusal leaves behind.
 */
describe("the owner bearer: fail closed, and the refusal is on the record", () => {
  let repo: TempRepo;
  let server: ReturnType<typeof makeBridge>;
  let base: string;
  const rows: Array<{ text: string; values: unknown[] }> = [];
  const db = {
    async query(text: string, values: unknown[] = []) {
      rows.push({ text, values });
      return { rows: [{ id: rows.length }] };
    },
  };
  const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });

  beforeAll(async () => {
    repo = await tempRepo();
    const committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test", sourceTrailer: "Brain-Source" });
    const vault = new Vault(repo.root, repo.git, committer, { maxBytes: 4096 });
    // no ownerToken — deliberately, that is the case under test
    server = makeBridge({ vault, committer, db }, { token, maxBodyBytes: 64 * 1024 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await repo.cleanup();
  });

  it("with no owner bearer, NO caller may write a protected path — the install is refused, not opened up", async () => {
    const r = await post("/vault/write", { path: ".metistry/deployment.yaml", content: "shape: launchd\n", intent: intent("user", "metistry deployment set-shape → launchd") });
    expect(r.status).toBe(403);
    // ordinary vault content is untouched by any of this
    expect((await post("/vault/write", { path: "Areas/Ordinary.md", content: "x", intent: intent("assistant", "note") })).status).toBe(201);
  });

  it("check() degrades with the command that fixes it, and says which bearers it holds", async () => {
    const c = await (await fetch(`${base}/check`, { headers: H })).json();
    expect(c.status).toBe("degraded");
    expect(c.remediation).toContain("METISTRY_BRIDGE_TOKEN_RECONCILER_USER");
    expect(c.remediation).toContain("metistry secrets sync --to env");
    expect(c.meta).toMatchObject({ principal_from_credential: true, owner_bearer: false });
  });

  it("every refused mutation lands in `runs` as kind=auth with the caller class on it", async () => {
    rows.length = 0;
    await post("/vault/write", { path: "CLAUDE.md", content: "# mine now\n", intent: intent("user", "claiming to be you") });
    const insert = rows.find((r) => r.text.includes("INSERT INTO runs"));
    expect(insert, "a refusal with a db configured writes a runs row").toBeTruthy();
    expect(insert!.values.slice(0, 4)).toEqual(["reconciler", "auth", null, "vault_write"]);
    expect(JSON.parse(String(insert!.values[6]))).toEqual({ caller: "console", principal: "user", path: "CLAUDE.md", code: "forbidden" });
    const update = rows.find((r) => r.text.includes("UPDATE runs"));
    expect(update!.values[1]).toBe(false); // ok = false
  });
});
