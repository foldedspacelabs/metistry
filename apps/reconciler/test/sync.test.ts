// Integrate before pushing (§2.21, T10-3), against a REAL bare remote: the
// owner pushes from another clone, commits in the working tree, edits the
// same lines — and every git argv the reconciler runs is recorded, so the
// last test can say that no `--force` and no `reset --hard` ever ran.
// Real git, throwaway repos; no database (sync-record.integration.test.ts
// owns the rows).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { Committer, type SyncRecord } from "../src/committer.js";
import { Git, refusedGitArgs, type GitOptions, type GitResult } from "../src/git.js";
import { makeBridge } from "../src/server.js";
import { conflictKey, protectedKey } from "../src/sync-record.js";
import { Indexer, type ReconcileSummary } from "../src/indexer.js";
import { Vault } from "../src/vault.js";
import { tempRepo, type TempRepo } from "./helpers.js";

const exec = promisify(execFile);

/** Every argv the reconciler hands git, in order — the committer's whole git surface. */
class RecordingGit extends Git {
  argv: string[][] = [];
  /** Runs once, right after the first successful `fetch` — the owner racing our push. */
  afterFetch: (() => Promise<void>) | null = null;
  override async raw(args: string[], opts: GitOptions = {}): Promise<GitResult> {
    this.argv.push([...args]);
    const r = await super.raw(args, opts);
    if (args[0] === "fetch" && r.code === 0 && this.afterFetch) {
      const f = this.afterFetch;
      this.afterFetch = null;
      await f();
    }
    return r;
  }
}

/** Every argv every test ran — the last describe reads it whole. */
const everyArgv: string[][] = [];

let repo: TempRepo;
let git: RecordingGit;
let committer: Committer;
let scratch: string;
let bare: string;
let owner: string; // the owner's other clone
let records: SyncRecord[];
let rewalked: string[][];

/** git as the OWNER, never through the reconciler: their identity, their config. */
async function asOwner(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: scratch, LANG: "C", LC_ALL: "C" };
  const { stdout } = await exec("git", ["-c", "user.name=Owner", "-c", "user.email=owner@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, env });
  return stdout;
}

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

/** The owner edits in their other clone and pushes. */
async function ownerPushes(path: string, content: string, message: string): Promise<string> {
  await asOwner(owner, ["pull", "-q", "--ff-only", "origin", "main"]);
  await put(owner, path, content);
  await asOwner(owner, ["add", "-A"]);
  await asOwner(owner, ["commit", "-q", "-m", message]);
  await asOwner(owner, ["push", "-q", "origin", "main"]);
  return (await asOwner(owner, ["rev-parse", "HEAD"])).trim();
}

/** A bridge write as vault.ts lands it, then its intent. */
async function write(path: string, content: string, message: string, principal = "assistant"): Promise<void> {
  await put(repo.root, path, content);
  committer.enqueue({ paths: [path], principal, message });
}

const remoteHead = async () => (await asOwner(bare, ["rev-parse", "main"])).trim();
const localHead = async () => (await repo.git.head())!;
const isAncestor = async (a: string, b: string) =>
  exec("git", ["merge-base", "--is-ancestor", a, b], { cwd: repo.root }).then(
    () => true,
    () => false,
  );
const subjects = async (rev: string) => (await asOwner(bare, ["log", "--reverse", "--format=%an|%s", rev])).trim().split("\n");

beforeEach(async () => {
  repo = await tempRepo();
  scratch = await mkdtemp(join(tmpdir(), "metistry-sync-"));
  bare = join(scratch, "remote.git");
  owner = join(scratch, "owner");
  await exec("git", ["init", "-q", "--bare", "-b", "main", bare]);
  await exec("git", ["remote", "add", "origin", bare], { cwd: repo.root });
  git = new RecordingGit(repo.root);
  committer = new Committer(git, { authorPrefix: "Metistry", authorEmail: "metistry@test", sourceTrailer: "Brain-Source", sweepExternalEdits: true });
  records = [];
  rewalked = [];
  committer.hooks = {
    record: async (e) => {
      records.push(e);
    },
    integrated: (changed) => {
      rewalked.push(changed);
    },
  };
  // the first push creates the remote branch; the owner clones from there
  const first = await committer.push();
  expect(first).toMatchObject({ attempted: true, ok: true, pushed: true });
  await exec("git", ["clone", "-q", bare, owner], { env: { ...process.env, HOME: scratch } });
  records = [];
});

afterEach(async () => {
  everyArgv.push(...git.argv);
  await repo.cleanup();
  await rm(scratch, { recursive: true, force: true });
});

describe("integrate before pushing (§2.21 rule 2)", () => {
  it("the first push creates the remote branch, and a push with nothing new does not push", async () => {
    expect(await remoteHead()).toBe(await localHead());
    const r = await committer.push();
    expect(r).toMatchObject({ ok: true, integrated: "up_to_date", ahead: 0, pushed: false });
    expect(records).toEqual([]);
  });

  it("the owner pushes from another clone while the reconciler holds unpushed commits → both histories survive, as one line", async () => {
    const ownerSha = await ownerPushes("Areas/Owner.md", "from the other clone\n", "Owner's note");
    await write("Areas/A.md", "a\n", "Act A");
    await write("Areas/B.md", "b\n", "Act B");
    await committer.flush();
    const unpushed = await localHead();

    const r = await committer.push();
    expect(r).toMatchObject({ ok: true, integrated: "rebased", behind: 1, pushed: true, ahead: 0 });

    // the owner's commit is untouched (same sha), ours sit on top of it, and there is no merge commit
    const tip = await remoteHead();
    expect(tip).toBe(await localHead());
    expect(await isAncestor(ownerSha, tip)).toBe(true);
    expect(await subjects(tip)).toEqual(["seed|seed", "Owner|Owner's note", "Metistry assistant|Act A", "Metistry assistant|Act B"]);
    expect((await asOwner(bare, ["rev-list", "--merges", "main"])).trim()).toBe("");
    // a rebased act keeps its author, its date and its trailers
    const before = (await repo.git.run(["show", "-s", "--format=%an|%ae|%ad|%B", unpushed])).trim();
    const after = (await repo.git.run(["show", "-s", "--format=%an|%ae|%ad|%B", tip])).trim();
    expect(after).toBe(before);
    expect(after).toContain("Brain-Source: assistant");

    // the working tree holds both sides, and nothing is left dirty
    expect(await readFile(join(repo.root, "Areas/Owner.md"), "utf8")).toBe("from the other clone\n");
    expect(await readFile(join(repo.root, "Areas/A.md"), "utf8")).toBe("a\n");
    expect(await repo.git.status()).toEqual([]);
    // rule 5: the files that came in are re-walked; the act is on the record
    expect(rewalked).toEqual([["Areas/Owner.md"]]);
    expect(records.map((e) => [e.state, e.ok])).toEqual([
      ["pull", true],
      ["push", true],
    ]);
    expect(records[0]!.meta).toMatchObject({ integrated: "rebased", behind: 1, changed: 1 });
  });

  it("the owner commits in the working tree → nothing is lost: their commit is merged, never rebased", async () => {
    await put(repo.root, "Areas/Local.md", "the owner, in a terminal\n");
    await asOwner(repo.root, ["add", "--", "Areas/Local.md"]);
    await asOwner(repo.root, ["commit", "-q", "-m", "Owner's local commit"]);
    const localOwnerSha = await localHead();
    const remoteSha = await ownerPushes("Areas/Remote.md", "pushed elsewhere\n", "Owner's remote commit");
    await write("Areas/C.md", "c\n", "Act C");
    await committer.flush();

    const r = await committer.push();
    expect(r).toMatchObject({ ok: true, integrated: "merged", pushed: true });
    const tip = await remoteHead();
    expect(await isAncestor(localOwnerSha, tip)).toBe(true); // the SAME commit, not a copy
    expect(await isAncestor(remoteSha, tip)).toBe(true);
    const merge = (await repo.git.run(["show", "-s", "--format=%P|%an|%s|%(trailers:only,unfold)", tip])).trim();
    expect(merge.split("|")[0]!.split(" ")).toHaveLength(2);
    expect(merge).toContain("|Metistry reconciler|Merge origin/main|Brain-Source: reconciler");
    for (const f of ["Areas/Local.md", "Areas/Remote.md", "Areas/C.md"]) expect(existsSync(join(repo.root, f))).toBe(true);
    expect(await repo.git.status()).toEqual([]);
  });

  it("the owner's working-tree commit with nothing remote is simply pushed", async () => {
    await put(repo.root, "Areas/Local.md", "mine\n");
    await asOwner(repo.root, ["add", "--", "Areas/Local.md"]);
    await asOwner(repo.root, ["commit", "-q", "-m", "Owner's local commit"]);
    const sha = await localHead();
    expect(await committer.push()).toMatchObject({ ok: true, integrated: "up_to_date", pushed: true });
    expect(await remoteHead()).toBe(sha);
  });

  it("only the remote moved → a fast-forward, and the re-walk hears which files", async () => {
    await ownerPushes("Areas/Alpha.md", "rewritten on GitHub\n", "Edit Alpha on GitHub");
    const r = await committer.push();
    expect(r).toMatchObject({ ok: true, integrated: "fast_forward", behind: 1, ahead: 0, pushed: false });
    expect(await localHead()).toBe(await remoteHead());
    expect(await readFile(join(repo.root, "Areas/Alpha.md"), "utf8")).toBe("rewritten on GitHub\n");
    expect(rewalked).toEqual([["Areas/Alpha.md"]]);
  });

  it("pull() integrates on its own schedule and never pushes", async () => {
    await ownerPushes("Areas/Owner.md", "x\n", "Owner's note");
    await write("Areas/A.md", "a\n", "Act A");
    await committer.flush();
    const before = await remoteHead();
    expect(await committer.pull()).toMatchObject({ ok: true, integrated: "rebased", ahead: 1, pushed: false });
    expect(await remoteHead()).toBe(before);
    expect(committer.lastPull?.result.integrated).toBe("rebased");
  });

  it("an Obsidian edit is swept and committed before the integrate, so it merges instead of blocking", async () => {
    await ownerPushes("Areas/Owner.md", "x\n", "Owner's note");
    await put(repo.root, "Areas/Beta.md", "# Beta\n\nedited in Obsidian, not yet swept\n");
    const r = await committer.push();
    expect(r).toMatchObject({ ok: true, integrated: "rebased", pushed: true });
    expect(await subjects(await remoteHead())).toContain("Metistry user|Edits from Obsidian: Beta");
  });

  it("each act is replayed against its own parent — an act that undoes the one before it stays undone", async () => {
    // Alpha.md: an act changes line 2, the next act puts it back; the owner edits line 6
    const lines = (l2: string, l6: string) => ["# Alpha", l2, "three", "four", "five", l6, "seven", ""].join("\n");
    await write("Areas/Alpha.md", lines("two", "six"), "Seed Alpha");
    await committer.flush();
    await committer.push();
    await ownerPushes("Areas/Alpha.md", lines("two", "SIX (owner)"), "Owner edits line 6");
    await write("Areas/Alpha.md", lines("TWO (act 1)", "six"), "Act 1");
    await committer.flush();
    await write("Areas/Alpha.md", lines("two", "six"), "Act 2 undoes act 1", "user");
    await committer.flush();

    const r = await committer.push();
    expect(r).toMatchObject({ ok: true, integrated: "rebased", pushed: true });
    expect(await readFile(join(repo.root, "Areas/Alpha.md"), "utf8")).toBe(lines("two", "SIX (owner)"));
  });

  it("an act that would not apply on its own falls back to a merge of the whole, which is clean", async () => {
    const lines = (l2: string) => ["# Alpha", l2, "three", ""].join("\n");
    await write("Areas/Alpha.md", lines("two"), "Seed Alpha");
    await committer.flush();
    await committer.push();
    await ownerPushes("Areas/Alpha.md", lines("TWO (owner)"), "Owner edits line 2");
    await write("Areas/Alpha.md", lines("TWO (act)"), "Act 1");
    await committer.flush();
    await write("Areas/Alpha.md", lines("two"), "Act 2 undoes act 1");
    await committer.flush();

    const r = await committer.push();
    expect(r).toMatchObject({ ok: true, integrated: "merged", pushed: true });
    expect(await readFile(join(repo.root, "Areas/Alpha.md"), "utf8")).toBe(lines("TWO (owner)"));
  });

  it("the remote moves between our fetch and our push → integrate again, then push", async () => {
    await write("Areas/A.md", "a\n", "Act A");
    await committer.flush();
    git.afterFetch = async () => {
      await ownerPushes("Areas/Race.md", "raced\n", "Owner races the push");
    };
    const from = git.argv.length;
    const r = await committer.push();
    expect(r).toMatchObject({ ok: true, pushed: true, integrated: "rebased" });
    expect(await subjects(await remoteHead())).toEqual(["seed|seed", "Owner|Owner races the push", "Metistry assistant|Act A"]);
    expect(git.argv.slice(from).filter((a) => a[0] === "push")).toHaveLength(2); // refused once, then through
  });

  it("acts that were already published are merged, never rebased — even when the remote was rewritten", async () => {
    await write("Areas/A.md", "a\n", "Act A (published)");
    await committer.flush();
    await committer.push();
    const published = await localHead();
    // the owner rewrites the remote without our act (their own git; the reconciler's could not)
    await asOwner(owner, ["fetch", "-q", "origin"]);
    await asOwner(owner, ["reset", "-q", "--hard", "origin/main~1"]);
    await put(owner, "Areas/Rewrite.md", "r\n");
    await asOwner(owner, ["add", "-A"]);
    await asOwner(owner, ["commit", "-q", "-m", "Owner rewrote the remote"]);
    await asOwner(owner, ["push", "-q", "--force", "origin", "main"]);
    await write("Areas/B.md", "b\n", "Act B");
    await committer.flush();

    const r = await committer.push();
    expect(r).toMatchObject({ ok: true, integrated: "merged", pushed: true });
    expect(await isAncestor(published, await remoteHead())).toBe(true); // the published act kept its sha
  });
});

describe("re-walk what changed (§2.21 rule 5)", () => {
  it("the walk after an integrate starts after the one already running — it never joins a walk that read the old tree", async () => {
    const vault = new Vault(repo.root, repo.git, committer, { maxBytes: 4096 });
    const indexer = new Indexer({ query: async () => ({ rows: [] }) }, vault, committer, { commitExternalEdits: false });
    const started: string[] = [];
    let finishFirst!: () => void;
    (indexer as unknown as { reconcileNow(t: string): Promise<ReconcileSummary> }).reconcileNow = async (trigger) => {
      started.push(trigger);
      if (trigger === "interval") await new Promise<void>((r) => (finishFirst = r));
      return { run_id: started.length } as ReconcileSummary;
    };
    const running = indexer.reconcile("interval");
    const joined = indexer.reconcile("on_demand"); // an ordinary caller joins the running walk…
    const after = indexer.reconcileAfter("integrate"); // …the integrate's does not
    const after2 = indexer.reconcileAfter("integrate"); // and two integrates share the one that follows
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual(["interval"]);
    finishFirst();
    expect(await joined).toBe(await running);
    const [a, b] = await Promise.all([after, after2]);
    expect(started).toEqual(["interval", "integrate"]);
    expect(a).toBe(b);
  });
});

describe("a conflict stops, never guesses (§2.21 rule 3)", () => {
  it("a conflicting edit → no push, one request, nothing overwritten; writes keep committing; the next clean integrate clears it", async () => {
    const theirs = await ownerPushes("now.md", "# Now\n\nthe owner's plan\n", "Owner rewrites now");
    await write("now.md", "# Now\n\nthe assistant's plan\n", "Brief rewrites now");
    await committer.flush();
    const ours = await localHead();

    const r = await committer.push();
    expect(r).toMatchObject({ attempted: true, ok: false, integrated: "conflict", pushed: false });
    expect(r.error).toContain("now.md");
    // no push, and nothing touched: same HEAD, same bytes, no merge or rebase left behind
    expect(await remoteHead()).toBe(theirs);
    expect(await localHead()).toBe(ours);
    expect(await readFile(join(repo.root, "now.md"), "utf8")).toBe("# Now\n\nthe assistant's plan\n");
    expect(await repo.git.status()).toEqual([]);
    expect(await repo.git.operationInProgress()).toBeNull();

    expect(committer.vault.state).toBe("conflict");
    const c = committer.vault.conflict!;
    expect(c).toMatchObject({ reason: "diverged", paths: ["now.md"], remote_name: "origin", branch: "main", local: { sha: ours, ahead: 1 }, remote: { sha: theirs, behind: 1 } });
    expect(c.sides[0]).toMatchObject({ path: "now.md", local: { subject: "Brief rewrites now" }, remote: { subject: "Owner rewrites now", author: "Owner" } });
    expect(records.map((e) => e.state)).toEqual(["conflict"]);

    // trying again finds the same episode: the same key, so still ONE report (the db test counts the rows)
    await committer.push();
    expect(records.map((e) => e.state)).toEqual(["conflict", "conflict"]);
    expect(conflictKey(records[1]!.conflict!)).toBe(conflictKey(records[0]!.conflict!));
    expect(records[1]!.conflict!.since).toBe(records[0]!.conflict!.since);

    // writes keep committing locally meanwhile
    await write("Areas/Meanwhile.md", "still writing\n", "Meanwhile");
    expect((await committer.flush()).commits).toHaveLength(1);

    // the owner resolves it in a terminal, in the working tree
    await asOwner(repo.root, ["pull", "-q", "--no-rebase", "--no-edit", "origin", "main"]).catch(() => undefined);
    expect(await repo.git.operationInProgress()).toBe("merge");
    await put(repo.root, "now.md", "# Now\n\nboth plans\n");
    await asOwner(repo.root, ["add", "--", "now.md"]);
    await asOwner(repo.root, ["commit", "-q", "--no-edit"]);

    const clean = await committer.push();
    expect(clean).toMatchObject({ ok: true, pushed: true });
    expect(committer.vault).toEqual({ state: "clean", conflict: null });
    expect(await asOwner(bare, ["show", "main:now.md"])).toBe("# Now\n\nboth plans\n");
  });

  it("an uncommitted edit in the way (the sweep is off) → a conflict naming it, its bytes untouched", async () => {
    // a `.metistry/` edit used to be the example; a remote change there is now refused before anything is in anyone's way (next describe)
    const unswept = new Committer(git, { authorPrefix: "Metistry", authorEmail: "metistry@test", sourceTrailer: "Brain-Source", sweepExternalEdits: false });
    await ownerPushes("now.md", "# Now\n\nremote\n", "Owner edits now elsewhere");
    await writeFile(join(repo.root, "now.md"), "# Now\n\nlocal, uncommitted\n");
    const head = await localHead();

    const r = await unswept.pull();
    expect(r).toMatchObject({ ok: false, integrated: "conflict" });
    expect(unswept.vault.conflict).toMatchObject({ reason: "local_changes", paths: ["now.md"] });
    expect(await readFile(join(repo.root, "now.md"), "utf8")).toBe("# Now\n\nlocal, uncommitted\n");
    expect(await localHead()).toBe(head);

    // the owner drops their edit; the next sync is clean
    await asOwner(repo.root, ["checkout", "-q", "--", "now.md"]);
    expect(await unswept.pull()).toMatchObject({ ok: true, integrated: "fast_forward" });
    expect(unswept.vault.state).toBe("clean");
  });

  it("an uncommitted `.metistry/` edit and a remote change to the same file → refused as protected configuration, the local bytes untouched", async () => {
    await ownerPushes(".metistry/rules.yaml", "rules: [remote]\n", "Owner edits rules elsewhere");
    await writeFile(join(repo.root, ".metistry/rules.yaml"), "rules: [local, uncommitted]\n");
    const head = await localHead();
    expect(await committer.pull()).toMatchObject({ ok: false, integrated: "conflict" });
    expect(committer.vault.conflict).toMatchObject({ reason: "protected_path_from_remote", paths: [".metistry/rules.yaml"] });
    expect(await readFile(join(repo.root, ".metistry/rules.yaml"), "utf8")).toBe("rules: [local, uncommitted]\n");
    expect(await localHead()).toBe(head);
  });

  it("a remote that shares no history is a conflict, not a merge of unrelated histories", async () => {
    const other = join(scratch, "other.git");
    await exec("git", ["init", "-q", "--bare", "-b", "main", other]);
    const stranger = join(scratch, "stranger");
    await exec("git", ["init", "-q", "-b", "main", stranger]);
    await put(stranger, "README.md", "a different repository\n");
    await asOwner(stranger, ["add", "-A"]);
    await asOwner(stranger, ["commit", "-q", "-m", "unrelated"]);
    await asOwner(stranger, ["push", "-q", other, "main"]);
    await exec("git", ["remote", "set-url", "origin", other], { cwd: repo.root });
    await write("Areas/A.md", "a\n", "Act A");

    const r = await committer.push();
    expect(r).toMatchObject({ ok: false, integrated: "conflict" });
    expect(committer.vault.conflict).toMatchObject({ reason: "unrelated", base: "" });
    expect(existsSync(join(repo.root, "README.md"))).toBe(false);
  });

  it("check() degrades with the paths while the sync is stopped", async () => {
    await ownerPushes("now.md", "theirs\n", "Owner rewrites now");
    await write("now.md", "ours\n", "Brief rewrites now");
    await committer.flush();
    await committer.push();

    const token = mintToken();
    const vault = new Vault(repo.root, repo.git, committer, { maxBytes: 4096 });
    const server = makeBridge({ vault, committer }, { token, ownerToken: mintToken(), maxBodyBytes: 65536 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const c = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/check`, { headers: { authorization: `Bearer ${token}` } })).json();
      expect(c.status).toBe("degraded");
      expect(c.remediation).toContain("vault sync stopped: now.md changed both here and on origin/main");
      expect(c.meta.vault_sync).toMatchObject({ state: "conflict", conflict: { paths: ["now.md"] } });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("the remote is not a write path into configuration (ruling 2026-09-26: refuse and report)", () => {
  /** What git ran since `mark` — the steps that would move a tree or a ref. */
  const moves = (mark: number) => git.argv.slice(mark).filter((a) => ["merge", "push", "reset", "commit-tree", "merge-tree"].includes(a[0]!));

  it("a remote commit touching `.metistry/deployment.yaml` → nothing moves, state conflict naming it, no merge or push; retries add nothing; a revert on the remote lets the rest through", async () => {
    const theirs = await ownerPushes(".metistry/deployment.yaml", "shape: hostile\n", "Change the deployment");
    await write("Areas/A.md", "a\n", "Act A");
    await committer.flush();
    const ours = await localHead();

    const mark = git.argv.length;
    const r = await committer.push();
    expect(r).toMatchObject({ attempted: true, ok: false, integrated: "conflict", pushed: false, ahead: 1, behind: 1 });
    expect(r.error).toContain(".metistry/deployment.yaml");
    expect(moves(mark)).toEqual([]);
    expect(git.argv.slice(mark)).toContainEqual(expect.arrayContaining(["diff", "--name-only"]));
    // nothing moved: both heads where they were, the file never landed, the push is held
    expect(await remoteHead()).toBe(theirs);
    expect(await localHead()).toBe(ours);
    expect(existsSync(join(repo.root, ".metistry/deployment.yaml"))).toBe(false);
    expect(await repo.git.status()).toEqual([]);

    expect(committer.vault.state).toBe("conflict");
    const c = committer.vault.conflict!;
    expect(c).toMatchObject({
      reason: "protected_path_from_remote",
      paths: [".metistry/deployment.yaml"],
      path_count: 1,
      commits: [{ sha: theirs, author: "Owner", subject: "Change the deployment", paths: [".metistry/deployment.yaml"] }],
      commit_count: 1,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ state: "conflict", ok: false, meta: { reason: "protected_path_from_remote", paths: [".metistry/deployment.yaml"], commits: [theirs] } });

    // the next tick finds the same commit: same key (the db test counts ONE row), same episode, still nothing moved
    const mark2 = git.argv.length;
    expect(await committer.push()).toMatchObject({ ok: false, integrated: "conflict", pushed: false });
    expect(moves(mark2)).toEqual([]);
    expect(records.map((e) => e.state)).toEqual(["conflict", "conflict"]);
    expect(records[1]!.conflict!.commits!.map(protectedKey)).toEqual(records[0]!.conflict!.commits!.map(protectedKey));
    expect(records[1]!.conflict!.since).toBe(records[0]!.conflict!.since);

    // the owner reverts it on the remote: nothing protected is left to bring in, so the rest integrates and the held push goes out
    await asOwner(owner, ["revert", "--no-edit", "HEAD"]);
    await asOwner(owner, ["push", "-q", "origin", "main"]);
    expect(await committer.push()).toMatchObject({ ok: true, pushed: true });
    expect(committer.vault).toEqual({ state: "clean", conflict: null });
    expect(existsSync(join(repo.root, ".metistry/deployment.yaml"))).toBe(false);
    expect(await asOwner(bare, ["show", "main:Areas/A.md"])).toBe("a\n");
  });

  it("a mixed commit (a note AND protected config) is refused whole — the note does not ride in either, nor does an earlier vault-only commit", async () => {
    await ownerPushes("Areas/Earlier.md", "harmless\n", "A harmless note");
    await asOwner(owner, ["pull", "-q", "--ff-only", "origin", "main"]);
    await put(owner, "Areas/Owner.md", "a note\n");
    await put(owner, ".metistry/rules.yaml", "rules: [remote]\n");
    await asOwner(owner, ["add", "-A"]);
    await asOwner(owner, ["commit", "-q", "-m", "Note and rules"]);
    await asOwner(owner, ["push", "-q", "origin", "main"]);
    const mixed = (await asOwner(owner, ["rev-parse", "HEAD"])).trim();
    const head = await localHead();

    const mark = git.argv.length;
    expect(await committer.pull()).toMatchObject({ ok: false, integrated: "conflict" });
    expect(moves(mark)).toEqual([]);
    expect(await localHead()).toBe(head);
    expect(existsSync(join(repo.root, "Areas/Owner.md"))).toBe(false);
    expect(existsSync(join(repo.root, "Areas/Earlier.md"))).toBe(false);
    expect(await readFile(join(repo.root, ".metistry/rules.yaml"), "utf8")).toBe("rules: []\n");
    // the refusal names only the protected path, and only the commit that made it
    expect(committer.vault.conflict).toMatchObject({ reason: "protected_path_from_remote", paths: [".metistry/rules.yaml"], commit_count: 1, commits: [{ sha: mixed, paths: [".metistry/rules.yaml"] }] });
    expect(rewalked).toEqual([]);
  });

  it("the whole of `.metistry/` — `state/` too, which git would overwrite silently as ignored — and a case-folded `claude.md` are refused", async () => {
    await asOwner(owner, ["pull", "-q", "--ff-only", "origin", "main"]);
    await put(owner, ".metistry/state/.env", "METISTRY_SECRET=theirs\n");
    await put(owner, "claude.md", "# instructions from the remote\n");
    await asOwner(owner, ["add", "-f", "-A"]);
    await asOwner(owner, ["commit", "-q", "-m", "Plant state and instructions"]);
    await asOwner(owner, ["push", "-q", "origin", "main"]);

    expect(await committer.pull()).toMatchObject({ ok: false, integrated: "conflict" });
    expect(committer.vault.conflict).toMatchObject({ reason: "protected_path_from_remote", paths: [".metistry/state/.env", "claude.md"] });
    expect(existsSync(join(repo.root, ".metistry/state/.env"))).toBe(false);
    expect(existsSync(join(repo.root, "claude.md"))).toBe(false);
  });

  it("a vault-only remote commit still integrates as before", async () => {
    const theirs = await ownerPushes("Areas/Owner.md", "just a note\n", "Owner's note");
    const mark = git.argv.length;
    expect(await committer.pull()).toMatchObject({ ok: true, integrated: "fast_forward", behind: 1 });
    expect(await localHead()).toBe(theirs);
    expect(git.argv.slice(mark)).toContainEqual(["merge", "--ff-only", "-q", theirs]);
    expect(committer.vault.state).toBe("clean");
    expect(records.map((e) => e.state)).toEqual(["pull"]);
  });
});

describe("the owner's operation in the working tree is theirs (§2.21 rule 4)", () => {
  it("while the owner is mid-merge, nothing is staged, committed or integrated — then the queue lands", async () => {
    await ownerPushes("now.md", "theirs\n", "Owner rewrites now");
    await write("now.md", "ours\n", "Brief rewrites now");
    await committer.flush();
    await asOwner(repo.root, ["pull", "-q", "--no-rebase", "--no-edit", "origin", "main"]).catch(() => undefined);
    expect(await repo.git.operationInProgress()).toBe("merge");
    const unmerged = await asOwner(repo.root, ["ls-files", "-u"]);
    expect(unmerged).toContain("now.md");

    // a write lands and the flush comes round: it waits
    await write("now.md", "a write during the owner's merge\n", "Write during merge");
    const f = await committer.flush();
    expect(f).toMatchObject({ commits: [], paused: "merge" });
    expect(committer.depth).toBe(1);
    expect(await asOwner(repo.root, ["ls-files", "-u"])).toBe(unmerged); // the owner's conflict is still theirs to resolve
    expect(await committer.push()).toMatchObject({ attempted: false, ok: true, paused: "merge" });

    await put(repo.root, "now.md", "resolved by the owner\n");
    await asOwner(repo.root, ["add", "--", "now.md"]);
    await asOwner(repo.root, ["commit", "-q", "--no-edit"]);
    const done = await committer.flush();
    expect(done.paused).toBeUndefined();
    expect(committer.depth).toBe(0);
    expect(await committer.push()).toMatchObject({ ok: true, pushed: true });
  });

  it("a bridge write never interleaves with the tree step: it waits for the hold, and the hold waits for writes in flight", async () => {
    const order: string[] = [];
    let releaseWrite!: () => void;
    const inFlight = committer.withTree(async () => {
      order.push("write 1 starts");
      await new Promise<void>((r) => (releaseWrite = r));
      order.push("write 1 ends");
    });
    const hold = (committer as unknown as { holdingTree<T>(fn: () => Promise<T>): Promise<T> }).holdingTree(async () => {
      order.push("tree step");
    });
    const later = committer.withTree(async () => {
      order.push("write 2");
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["write 1 starts"]);
    releaseWrite();
    await Promise.all([inFlight, hold, later]);
    expect(order).toEqual(["write 1 starts", "write 1 ends", "tree step", "write 2"]);
  });
});

describe("never force, never rewrite published history (§2.21 rule 1)", () => {
  it("no --force or reset --hard ever appears in git's argv — across every scenario above", () => {
    expect(everyArgv.length).toBeGreaterThan(100);
    for (const argv of everyArgv) {
      const flags = argv.slice(0, argv.includes("--") ? argv.indexOf("--") : argv.length);
      expect(flags.some((a) => a.startsWith("--force") || a === "-f" || a === "--hard" || a === "--mirror"), argv.join(" ")).toBe(false);
      if (argv[0] === "push" || argv[0] === "fetch") expect(flags.some((a) => a.startsWith("+") || a.startsWith(":")), argv.join(" ")).toBe(false);
      if (argv[0] === "reset") expect(flags.includes("--keep") || argv.includes("--"), argv.join(" ")).toBe(true);
      expect(["rebase", "checkout", "stash", "update-ref", "branch", "clean"]).not.toContain(argv[0]);
    }
    // …and the rebase really ran as `reset --keep` onto the remote, and a push really went out
    expect(everyArgv.some((a) => a[0] === "reset" && a.includes("--keep"))).toBe(true);
    expect(everyArgv.some((a) => a[0] === "merge" && a.includes("--ff-only"))).toBe(true);
    expect(everyArgv.some((a) => a[0] === "push")).toBe(true);
  });

  it("the Git class cannot run a rewrite: a refused argv never reaches git", async () => {
    const refused: string[][] = [
      ["push", "--force", "origin", "main"],
      ["push", "-f", "origin", "main"],
      ["push", "--force-with-lease", "origin", "main"],
      ["push", "origin", "+main:main"],
      ["push", "origin", ":main"],
      ["push", "--delete", "origin", "main"],
      ["push", "--mirror", "origin"],
      ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      ["fetch", "--force", "origin"],
      ["reset", "--hard", "HEAD~1"],
      ["reset", "--soft", "HEAD~1"],
      ["reset", "--merge", "HEAD~1"],
      ["reset", "HEAD~1"],
      ["merge", "origin/main"],
      ["rebase", "origin/main"],
      ["checkout", "--", "now.md"],
      ["branch", "-D", "main"],
      ["update-ref", "refs/heads/main", "HEAD~1"],
      ["stash"],
      ["clean", "-fdx"],
      ["gc", "--prune=now"],
    ];
    for (const argv of refused) expect(refusedGitArgs(argv), argv.join(" ")).not.toBeNull();
    const allowed: string[][] = [
      ["push", "-q", "origin", "main:main"],
      ["fetch", "-q", "--no-tags", "origin", "refs/heads/main"],
      ["reset", "-q", "--", "now.md"],
      ["reset", "-q", "--keep", "abc123"],
      ["merge", "--ff-only", "-q", "abc123"],
      ["commit", "-q", "--only", "-m", "-f", "--", "now.md"], // a message is data
      ["add", "-A", "--", "--force"], // so is a path
    ];
    for (const argv of allowed) expect(refusedGitArgs(argv), argv.join(" ")).toBeNull();

    // behaviourally: a diverged remote, and a forced push asked for directly — nothing reaches git
    const theirs = await ownerPushes("Areas/Owner.md", "x\n", "Owner's note");
    await write("Areas/A.md", "a\n", "Act A");
    await committer.flush();
    const r = await repo.git.raw(["push", "--force", "origin", "main:main"]);
    expect(r).toMatchObject({ code: 128 });
    expect(r.stderr).toMatch(/^refused: /);
    expect(await remoteHead()).toBe(theirs);
  });
});

afterAll(() => {
  everyArgv.length = 0;
});
