// File history on the bridge (design-build-plan §2.21, T10-4): `GET /vault/log`
// with a path — each commit's provenance trailers, what it did to the file and
// what the file was called then — and `GET /vault/show`, one note at one
// commit. Against a throwaway git repo; no database.
//
// The misuse half is the ticket's bold line: a protected or non-vault path is
// refused, and a bad revision is refused — both before git runs, for either
// bearer — plus the bridge's own 401s.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { Committer } from "../src/committer.js";
import { Git } from "../src/git.js";
import { Vault, parseLog } from "../src/vault.js";
import { makeBridge } from "../src/server.js";
import { sha256 } from "../src/notes.js";
import { tempRepo, type TempRepo } from "./helpers.js";

const exec = promisify(execFile);
const token = mintToken();
const ownerToken = mintToken();

/** Every git argv the vault ran, so a read can be shown to have mutated nothing. */
class RecordingGit extends Git {
  readonly argv: string[][] = [];
  override raw(args: string[], opts = {}) {
    this.argv.push(args);
    return super.raw(args, opts);
  }
  override rawBytes(args: string[], opts = {}) {
    this.argv.push(args);
    return super.rawBytes(args, opts);
  }
}

describe("file history: GET /vault/log with a path, GET /vault/show", () => {
  let repo: TempRepo;
  let git: RecordingGit;
  let server: ReturnType<typeof makeBridge>;
  let base: string;
  const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const OWNER = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const get = (path: string, headers: Record<string, string> = H) => fetch(`${base}${path}`, { headers });
  const show = (path: string, sha: string, headers: Record<string, string> = H) => get(`/vault/show?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(sha)}`, headers);
  const write = async (path: string, content: string, intent: Record<string, unknown>) => {
    expect((await post("/vault/write", { path, content, intent })).ok).toBe(true);
    await post("/flush", {});
    return (await git.head())!;
  };

  // the file's life, oldest first
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80]);
  let seed: string;
  let v1: string;
  let v2: string;
  let moved: string;
  let v3: string;
  let gone: string;
  let pic: string;

  beforeAll(async () => {
    repo = await tempRepo();
    git = new RecordingGit(repo.root);
    const committer = new Committer(git, { authorPrefix: "Metistry", authorEmail: "metistry@test", sourceTrailer: "Brain-Source" });
    const vault = new Vault(repo.root, git, committer, { maxBytes: 4096 });
    server = makeBridge({ vault, committer }, { token, ownerToken, maxBodyBytes: 64 * 1024 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    seed = (await git.head())!;
    v1 = await write("Areas/Plan.md", "# Plan\n\nv1\n", { principal: "user", message: "Start the plan" });
    v2 = await write("Areas/Plan.md", "# Plan\n\nv2\n", { principal: "assistant", message: "Fold into the plan", run: "42", turn: "t_fold-1" });
    expect((await post("/vault/rename", { from: "Areas/Plan.md", to: "Areas/Roadmap.md", intent: { principal: "user", message: "Rename the plan" } })).ok).toBe(true);
    await post("/flush", {});
    moved = (await git.head())!;
    v3 = await write("Areas/Roadmap.md", "# Roadmap\n\nv3\n", { principal: "assistant", message: "Update the roadmap", turn: "t_brief-2" });
    expect((await post("/vault/delete", { path: "Areas/Roadmap.md", intent: { principal: "user", message: "Drop the roadmap" } })).ok).toBe(true);
    await post("/flush", {});
    gone = (await git.head())!;
    expect((await post("/vault/write", { path: "Areas/pixel.png", content_base64: PNG.toString("base64"), intent: { principal: "user", message: "a picture" } })).ok).toBe(true);
    await post("/flush", {});
    pic = (await git.head())!;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await repo.cleanup();
  });

  it("log follows the file across a rename and a delete, newest first, naming it as it was called then", async () => {
    const r = await get("/vault/log?path=Areas/Roadmap.md&limit=20");
    expect(r.status).toBe(200);
    const { entries } = await r.json();
    expect(entries.map((e: { sha: string }) => e.sha)).toEqual([gone, v3, moved, v2, v1]);
    expect(entries.map((e: { change: string; path: string }) => [e.change, e.path])).toEqual([
      ["deleted", "Areas/Roadmap.md"],
      ["modified", "Areas/Roadmap.md"],
      ["renamed", "Areas/Roadmap.md"],
      ["modified", "Areas/Plan.md"],
      ["added", "Areas/Plan.md"],
    ]);
  });

  it("log carries each commit's provenance trailers (T10-1): source, runs, turns", async () => {
    const { entries } = await (await get("/vault/log?path=Areas/Roadmap.md")).json();
    const at = (sha: string) => entries.find((e: { sha: string }) => e.sha === sha);
    expect(at(v2)).toMatchObject({ author: "Metistry assistant", subject: "Fold into the plan", source: "assistant", runs: ["42"], turns: ["t_fold-1"] });
    expect(at(v3)).toMatchObject({ source: "assistant", runs: [], turns: ["t_brief-2"] });
    expect(at(v1)).toMatchObject({ source: "user", runs: [], turns: [] });
    // the whole-tree log keeps its shape, with the trailers added and no per-file fields
    const all = (await (await get("/vault/log?limit=2")).json()).entries;
    expect(all[0]).toMatchObject({ sha: pic, subject: "a picture", source: "user" });
    expect(all[0].path).toBeUndefined();
    expect(all[0].change).toBeUndefined();
  });

  it("a trailer the committer would never write is dropped, not passed on", () => {
    const out = `\x1eabc\x1fOwner\x1f2026-09-26T00:00:00Z\x1fNot A Slug\x1f42,bad id\n,43\x1f\x1fsubject with \x1f inside\n`;
    const [e] = parseLog(out, null);
    expect(e).toMatchObject({ sha: "abc", author: "Owner", source: null, runs: ["42", "43"], turns: [], subject: "subject with \x1f inside" });
  });

  it("show returns one note at one commit, with its bytes, their hash and the commit it came from", async () => {
    const r = await show("Areas/Plan.md", v2);
    expect(r.status).toBe(200);
    const b = await r.json();
    const bytes = Buffer.from(b.content_base64, "base64");
    expect(bytes.toString("utf8")).toBe("# Plan\n\nv2\n");
    expect(b).toMatchObject({ path: "Areas/Plan.md", sha: v2, author: "Metistry assistant", subject: "Fold into the plan", source: "assistant", runs: ["42"], turns: ["t_fold-1"], sha256: sha256(bytes), bytes: bytes.length });
    expect(b.content).toBeUndefined();
    // an abbreviated id names the same commit, and the answer carries the full one
    expect((await (await show("Areas/Plan.md", v1.slice(0, 10))).json()).sha).toBe(v1);
    // a file the working tree no longer has is still in history
    expect(Buffer.from((await (await show("Areas/Roadmap.md", v3)).json()).content_base64, "base64").toString()).toBe("# Roadmap\n\nv3\n");
  });

  it("show hands back binary bytes untouched", async () => {
    const b = await (await show("Areas/pixel.png", pic)).json();
    expect(Buffer.from(b.content_base64, "base64").equals(PNG)).toBe(true);
    expect(b.sha256).toBe(sha256(PNG));
  });

  it("MISUSE: no bearer, or a bearer that is neither class, is 401", async () => {
    expect((await show("Areas/Plan.md", v1, {})).status).toBe(401);
    expect((await show("Areas/Plan.md", v1, { authorization: `Bearer ${mintToken()}` })).status).toBe(401);
  });

  it("MISUSE: a protected or non-vault path is refused — for the console's bearer and the owner's alike", async () => {
    for (const headers of [H, OWNER]) {
      for (const path of [".metistry/identity.yaml", ".metistry/rules.yaml", ".gitignore", "Artifacts/bundle-1/report.md", "CLAUDE.md", "README.md", ".obsidian/app.json"]) {
        const r = await show(path, seed, headers);
        expect(r.status, path).toBe(403);
        expect((await r.json()).error.code, path).toBe("forbidden");
      }
      // confine()'s own refusals still come first: traversal, absolute, .git
      for (const path of ["../outside.md", "/etc/passwd", ".git/config", "Areas/../../x.md"]) {
        expect([400, 403], path).toContain((await show(path, seed, headers)).status);
      }
    }
    // the file really is in the seed commit — the refusal is the path's, not a miss
    expect(await git.run(["cat-file", "-e", `${seed}:.metistry/identity.yaml`])).toBe("");
  });

  it("MISUSE: a bad revision is refused by shape, before it can reach git's argv", async () => {
    const before = git.argv.length;
    for (const sha of ["", "HEAD", "HEAD~1", "main", "abc12", "--output=/tmp/x", "-p", `${v1}^`, `${v1}:Areas/Plan.md`, "g".repeat(40), `${v1.slice(0, 20)} ${v1.slice(20)}`, "a".repeat(65)]) {
      const r = await show("Areas/Plan.md", sha);
      expect(r.status, sha).toBe(400);
      expect((await r.json()).error.code, sha).toBe("invalid_request");
    }
    expect((await get("/vault/show?path=Areas/Plan.md")).status).toBe(400); // no sha at all
    expect(git.argv.slice(before)).toEqual([]);
  });

  it("a well-formed id that is no commit here, or not on this branch, or a file absent at that commit, is not_found", async () => {
    expect((await show("Areas/Plan.md", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).status).toBe(404);
    // a blob's id is hex too, and it is not a commit
    const blob = (await git.run(["rev-parse", `${v1}:Areas/Plan.md`])).trim();
    expect((await show("Areas/Plan.md", blob)).status).toBe(404);
    // a commit that exists but is not in HEAD's history (a fetched, unintegrated one)
    const tree = (await git.run(["rev-parse", `${v2}^{tree}`])).trim();
    const env = { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" };
    const stray = (await exec("git", ["commit-tree", tree, "-m", "stray"], { cwd: repo.root, env })).stdout.trim();
    expect((await show("Areas/Plan.md", stray)).status).toBe(404);
    // the file before it existed, after it was deleted, and a directory
    expect((await show("Areas/Plan.md", seed)).status).toBe(404);
    expect((await show("Areas/Roadmap.md", gone)).status).toBe(404);
    expect((await show("Areas", v1)).status).toBe(404);
  });

  it("show reads and never writes: every git call it makes is a read", async () => {
    const head = await git.head();
    const before = git.argv.length;
    await show("Areas/Plan.md", v2);
    await show("Areas/pixel.png", pic);
    const subs = new Set(git.argv.slice(before).map((a) => a[0]));
    expect([...subs].sort()).toEqual(["cat-file", "log", "ls-tree", "rev-parse"]);
    expect(await git.head()).toBe(head);
    expect(await git.status()).toEqual([]);
  });
});
