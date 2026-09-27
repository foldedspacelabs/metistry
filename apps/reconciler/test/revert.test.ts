// Roll back on the bridge (design-build-plan §2.21, T10-6): `POST /vault/revert`
// against a throwaway git repo — no database, no network.
//
// The ticket's bold line, each a test below:
//   * the console-initiated revert refuses every `.metistry/` protected path;
//   * the reconciler refuses revert for any principal but `user`;
//   * history is never rewritten;
//   * reverting the revert restores the state.
// (The passkey-session refusal is the console's route — apps/console.)
// And the acceptance: a day of agent writes rolled back, then its undo.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { Committer } from "../src/committer.js";
import { Git, refusedGitArgs } from "../src/git.js";
import { Vault } from "../src/vault.js";
import { makeBridge } from "../src/server.js";
import { beforeArg, parseRevertTarget, validMoment } from "../src/revert.js";
import { tempRepo, type TempRepo } from "./helpers.js";

const exec = promisify(execFile);
const token = mintToken();
const ownerToken = mintToken();

/** Every argv the reconciler hands git — the last test reads it whole. */
class RecordingGit extends Git {
  readonly argv: string[][] = [];
  override raw(args: string[], opts = {}) {
    this.argv.push([...args]);
    return super.raw(args, opts);
  }
  override rawBytes(args: string[], opts = {}) {
    this.argv.push([...args]);
    return super.rawBytes(args, opts);
  }
}
const everyArgv: string[][] = [];
/** Each test here drives real git many times over — a laptop under load needs more than vitest's default 5 s. */
const SLOW = 60_000;
vi.setConfig({ testTimeout: SLOW, hookTimeout: SLOW });

const OLD_DAY = "2026-01-01T09:00:00Z"; // the seed and the owner's commits: long before the "day" of agent writes
const PROTECTED = [
  ".metistry/identity.yaml",
  ".metistry/rules.yaml",
  ".metistry/compute.yaml",
  ".metistry/scheduled.yaml",
  ".metistry/assistant-prompt.md",
  ".metistry/deployment.yaml",
  ".metistry/agents/scout.yaml",
  ".metistry/queries/today.yaml",
  "CLAUDE.md",
  "README.md",
];

interface Harness {
  repo: TempRepo;
  git: RecordingGit;
  base: string;
  reverted: string[][];
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const repo = await tempRepo();
  // the owner's configuration, committed by hand on an old day
  for (const p of PROTECTED) {
    await mkdir(join(repo.root, p, ".."), { recursive: true });
    await writeFile(join(repo.root, p), `# ${p} v1\n`);
  }
  await ownerCommit(repo.root, "configuration", OLD_DAY);
  const git = new RecordingGit(repo.root);
  const committer = new Committer(git, { authorPrefix: "Metistry", authorEmail: "metistry@test", sourceTrailer: "Brain-Source" });
  const vault = new Vault(repo.root, git, committer, { maxBytes: 64 * 1024 });
  const reverted: string[][] = [];
  const server = makeBridge({ vault, committer, reverted: (paths) => reverted.push(paths) }, { token, ownerToken, maxBodyBytes: 256 * 1024 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    repo,
    git,
    base,
    reverted,
    close: async () => {
      everyArgv.push(...git.argv);
      await new Promise<void>((r) => server.close(() => r()));
      await repo.cleanup();
    },
  };
}

/** The owner's own commit in the working tree, at a chosen date (a terminal, not the bridge). */
async function ownerCommit(root: string, message: string, date?: string): Promise<string> {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) };
  await exec("git", ["add", "-A"], { cwd: root, env });
  await exec("git", ["-c", "user.name=Owner", "-c", "user.email=owner@test", "commit", "-q", "-m", message], { cwd: root, env });
  return (await exec("git", ["rev-parse", "HEAD"], { cwd: root, env })).stdout.trim();
}

const CONSOLE = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const OWNER = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };
const USER = { principal: "user", message: "Approved in Needs You (request #7)" };

function client(h: Harness) {
  const post = (path: string, body: unknown, headers: Record<string, string> = CONSOLE) => fetch(`${h.base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return {
    post,
    revert: (body: Record<string, unknown>, headers: Record<string, string> = CONSOLE) => post("/vault/revert", { intent: USER, ...body }, headers),
    /** An agent's write through the bridge, committed at once — one act, as T10-1 makes it. */
    async write(path: string, content: string, principal = "assistant", turn?: string) {
      const r = await post("/vault/write", { path, content, intent: { principal, message: `${principal} edits ${path}`, ...(turn ? { turn } : {}) } });
      expect(r.ok, await r.clone().text()).toBe(true);
      await post("/flush", {});
      return (await h.git.head())!;
    },
    async remove(path: string, principal = "assistant") {
      expect((await post("/vault/delete", { path, intent: { principal, message: `${principal} removes ${path}` } })).ok).toBe(true);
      await post("/flush", {});
      return (await h.git.head())!;
    },
  };
}

const read = (h: Harness, p: string) => readFile(join(h.repo.root, p), "utf8").catch(() => null);
const tree = async (h: Harness, rev = "HEAD") => (await h.git.run(["rev-parse", `${rev}^{tree}`])).trim();
const ancestor = async (h: Harness, a: string, b: string) => (await h.git.raw(["merge-base", "--is-ancestor", a, b])).code === 0;

// ---------------------------------------------------------------- the acceptance

describe("acceptance: roll back a day of agent writes, then undo it", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  it("previews, reverts as `user` in one new commit, leaves configuration alone, and reverting it restores the day", async () => {
    const c = client(h);
    const morning = (await h.git.head())!;
    const seedTree = await tree(h);
    // the day: three agent acts and one console write to configuration (the Compute pane)
    await c.write("Areas/Beta.md", "# Beta\n\nrewritten by the fold\n", "assistant", "t_fold-1");
    await c.write("Areas/New.md", "# New\n\nan agent's new note\n", "agent-scout");
    await c.remove("Areas/Alpha.md");
    const compute = await c.post("/vault/write", { path: ".metistry/compute.yaml", content: "# compute moved to a cheaper model\n", intent: { principal: "user", message: "Compute: assign" } });
    expect(compute.ok).toBe(true);
    await c.post("/flush", {});
    const evening = (await h.git.head())!;
    const eveningTree = await tree(h);

    // the preview: nothing changes
    const preview = await c.revert({ to: "2026-01-02", dry_run: true });
    expect(preview.status).toBe(200);
    const p = await preview.json();
    expect(p).toMatchObject({ dry_run: true, target: { to: "2026-01-02" }, head: evening, base: { sha: morning }, revert_count: 4, config: [], skipped_config: [".metistry/compute.yaml"] });
    expect(p.files).toEqual([
      { path: "Areas/Alpha.md", change: "added" },
      { path: "Areas/Beta.md", change: "modified" },
      { path: "Areas/New.md", change: "deleted" },
    ]);
    expect(p.reverts.map((r: { author: string }) => r.author)).toEqual(["user", "assistant", "agent-scout", "assistant"]);
    expect(await h.git.head()).toBe(evening);
    expect(h.reverted).toEqual([]);

    // Approve: the same change set, pinned to the history it was previewed on
    const expectSet = { files: p.files.map((f: { path: string }) => f.path), reverts: p.reverts.map((r: { sha: string }) => r.sha), skipped_config: p.skipped_config };
    const done = await c.revert({ to: "2026-01-02", head: evening, expect: expectSet });
    expect(done.status).toBe(201);
    const out = await done.json();
    expect(out).toMatchObject({ dry_run: false, head: evening });
    const rolled = (await h.git.head())!;
    expect(out.sha).toBe(rolled);
    const commit = await h.git.run(["log", "-1", "--format=%an%n%B", rolled]);
    expect(commit).toContain("Metistry user");
    expect(commit).toContain("Roll back to 2026-01-02");
    expect(commit).toContain("Left as they are (configuration): .metistry/compute.yaml");
    expect(commit).toContain("Approved in Needs You (request #7)");
    expect(commit).toContain("Brain-Source: user");
    expect(await read(h, "Areas/Beta.md")).toBe("# Beta\n\nplain note mentioning zebra\n");
    expect(await read(h, "Areas/New.md")).toBeNull();
    expect(await read(h, "Areas/Alpha.md")).toContain("title: Alpha");
    expect(await read(h, ".metistry/compute.yaml")).toBe("# compute moved to a cheaper model\n");
    // one new commit on top of the day — the day is still history
    expect((await h.git.run(["rev-parse", `${rolled}^`])).trim()).toBe(evening);
    expect(await ancestor(h, evening, rolled)).toBe(true);
    expect(h.reverted).toEqual([["Areas/Alpha.md", "Areas/Beta.md", "Areas/New.md"]]);
    // the vault is the morning's, but for the configuration left alone
    const diff = (await h.git.run(["diff", "--name-only", seedTree, await tree(h)])).trim();
    expect(diff).toBe(".metistry/compute.yaml");

    // undo: revert the revert
    const undo = await c.revert({ commit: rolled });
    expect(undo.status).toBe(201);
    expect(await tree(h)).toBe(eveningTree);
    expect(await read(h, "Areas/New.md")).toBe("# New\n\nan agent's new note\n");
    expect(await h.git.run(["log", "-1", "--format=%s"])).toContain('Revert "Roll back to 2026-01-02"');
  });
});

// ---------------------------------------------------------------- the bold lines

describe("reverting the revert restores the state", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  it("a commit, reverted, then its revert reverted: the tree is the one before either", async () => {
    const c = client(h);
    await c.write("Areas/Plan.md", "# Plan\n\nv1\n");
    const v2 = await c.write("Areas/Plan.md", "# Plan\n\nv2 — the fold's rewrite\n");
    await c.write("Areas/Other.md", "# Other\n\nlater, unrelated\n");
    const before = await tree(h);
    const r1 = await c.revert({ commit: v2.slice(0, 10) });
    expect(r1.status).toBe(201);
    const one = await r1.json();
    expect(one.files).toEqual([{ path: "Areas/Plan.md", change: "modified" }]);
    expect(await read(h, "Areas/Plan.md")).toBe("# Plan\n\nv1\n");
    expect(await read(h, "Areas/Other.md")).toBe("# Other\n\nlater, unrelated\n"); // a later commit's work stays
    const r2 = await c.revert({ commit: one.sha });
    expect(r2.status).toBe(201);
    expect(await tree(h)).toBe(before);
  });

  it("one file: back to before its last change, and a deleted note comes back where it was", async () => {
    const c = client(h);
    await c.write("Areas/Solo.md", "# Solo\n\nfirst\n");
    await c.write("Areas/Solo.md", "# Solo\n\nsecond\n");
    await c.write("Areas/Beside.md", "# Beside\n\nx\n");
    const r = await c.revert({ file: "Areas/Solo.md" });
    expect(r.status).toBe(201);
    expect((await r.json()).files).toEqual([{ path: "Areas/Solo.md", change: "modified" }]);
    expect(await read(h, "Areas/Solo.md")).toBe("# Solo\n\nfirst\n");
    expect(await read(h, "Areas/Beside.md")).toBe("# Beside\n\nx\n");

    await c.remove("Areas/Solo.md");
    const back = await c.revert({ file: "Areas/Solo.md" });
    expect(back.status).toBe(201);
    expect(await read(h, "Areas/Solo.md")).toBe("# Solo\n\nfirst\n");
  });
});

describe("**the console-initiated revert refuses every `.metistry/` protected path**", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  it("a commit that changed configuration and a note: the note goes back, every configuration path stays, and says so", async () => {
    const c = client(h);
    for (const p of PROTECTED) {
      await writeFile(join(h.repo.root, p), `# ${p} v2\n`);
      await writeFile(join(h.repo.root, "Areas", "Beta.md"), `# Beta\n\nedited alongside ${p}\n`);
      const sha = await ownerCommit(h.repo.root, `owner changes ${p}`);
      const r = await c.revert({ commit: sha });
      expect(r.status, p).toBe(201);
      const out = await r.json();
      expect(out.skipped_config, p).toEqual([p]);
      expect(out.files, p).toEqual([{ path: "Areas/Beta.md", change: "modified" }]);
      expect(await read(h, p), p).toBe(`# ${p} v2\n`);
    }
  });

  it("a commit that changed only configuration is not a rollback the console can make", async () => {
    await writeFile(join(h.repo.root, ".metistry/rules.yaml"), "rules: [only config]\n");
    const sha = await ownerCommit(h.repo.root, "owner tunes the rules");
    const head = await h.git.head();
    const r = await client(h).revert({ commit: sha });
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toContain("--include-config");
    expect(await h.git.head()).toBe(head);
  });

  it("a protected file named outright, or include_config from the console's bearer, is 403 — and nothing moves", async () => {
    const c = client(h);
    const head = await h.git.head();
    for (const p of [...PROTECTED, ".metistry/state/.env", ".Metistry/rules.yaml", "claude.md"]) {
      const r = await c.revert({ file: p });
      expect([400, 403], p).toContain(r.status);
      if (r.status === 403) expect((await r.json()).error.code).toBe("forbidden");
    }
    const inc = await c.revert({ to: "2026-01-02", include_config: true });
    expect(inc.status).toBe(403);
    expect((await inc.json()).error.message).toContain("--include-config");
    // a preview that names configuration changes nothing, so the console may show one
    const peek = await c.revert({ to: "2026-01-02", include_config: true, dry_run: true });
    expect(peek.status).toBe(200);
    expect((await peek.json()).config.length).toBeGreaterThan(0);
    expect(await h.git.head()).toBe(head);
  });

  it("the owner-class bearer with include_config reverts configuration too — and still never the schema's migrations", async () => {
    await writeFile(join(h.repo.root, ".metistry/compute.yaml"), "# a compute change to undo\n");
    await writeFile(join(h.repo.root, ".metistry/instance-migrations/0002_local.sql"), "-- a migration\n");
    const sha = await ownerCommit(h.repo.root, "owner changes compute and adds a migration");
    // even the owner's bearer leaves configuration alone unless asked
    const without = await client(h).revert({ commit: sha, dry_run: true }, OWNER);
    expect(without.status).toBe(400);
    expect((await without.json()).error.message).toContain("nothing to roll back but configuration (.metistry/compute.yaml, .metistry/instance-migrations/0002_local.sql)");
    const r = await client(h).revert({ commit: sha, include_config: true }, OWNER);
    expect(r.status).toBe(201);
    const out = await r.json();
    expect(out.config).toEqual([".metistry/compute.yaml"]);
    expect(out.skipped_config).toEqual([".metistry/instance-migrations/0002_local.sql"]);
    expect(await read(h, ".metistry/compute.yaml")).toBe("# .metistry/compute.yaml v2\n");
    expect(await read(h, ".metistry/instance-migrations/0002_local.sql")).toBe("-- a migration\n");
  });
});

describe("**the reconciler refuses revert for any principal but `user`**", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  it("an agent, the assistant, a routine or the reconciler itself — from either bearer — is 403, dry run or not, and nothing moves", async () => {
    const c = client(h);
    const sha = await c.write("Areas/Beta.md", "# Beta\n\nan agent's edit\n");
    for (const principal of ["assistant", "agent-scout", "morning-brief", "reconciler", "owner"]) {
      for (const headers of [CONSOLE, OWNER]) {
        for (const dry_run of [true, false]) {
          const r = await c.post("/vault/revert", { intent: { principal, message: "undo" }, commit: sha, dry_run }, headers);
          expect(r.status, `${principal} ${headers === OWNER ? "owner" : "console"}`).toBe(403);
          expect((await r.json()).error.code).toBe("forbidden");
        }
      }
    }
    expect(await h.git.head()).toBe(sha);
    expect(await read(h, "Areas/Beta.md")).toBe("# Beta\n\nan agent's edit\n");
  });

  it("no bearer, or a wrong one, is 401", async () => {
    const body = JSON.stringify({ intent: USER, to: "2026-01-02" });
    expect((await fetch(`${h.base}/vault/revert`, { method: "POST", body })).status).toBe(401);
    expect((await fetch(`${h.base}/vault/revert`, { method: "POST", headers: { authorization: `Bearer ${mintToken()}` }, body })).status).toBe(401);
  });
});

describe("stale, in the way, and malformed", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await client(h).post("/flush", {});
  });

  it("a later write to the same lines after the preview is refused stale; a later unrelated write survives the rollback", async () => {
    const c = client(h);
    const agent = await c.write("Areas/Beta.md", "# Beta\n\nthe agent's line\n");
    const preview = await (await c.revert({ commit: agent, dry_run: true })).json();
    await c.write("Areas/Beta.md", "# Beta\n\nthe owner's own line, since\n", "user");
    const r = await c.revert({ commit: agent, head: preview.head });
    expect(r.status).toBe(409);
    expect((await r.json()).error.message).toContain("stale");
    expect(await read(h, "Areas/Beta.md")).toBe("# Beta\n\nthe owner's own line, since\n");

    const again = await c.write("Areas/Gamma.md", "# Gamma\n\nan agent's note\n");
    const p2 = await (await c.revert({ commit: again, dry_run: true })).json();
    await c.write("Areas/Delta.md", "# Delta\n\nunrelated, since\n", "user");
    const ok = await c.revert({ commit: again, head: p2.head, expect: { files: ["Areas/Gamma.md"], reverts: [again], skipped_config: [] } });
    expect(ok.status).toBe(201);
    expect(await read(h, "Areas/Gamma.md")).toBeNull();
    expect(await read(h, "Areas/Delta.md")).toBe("# Delta\n\nunrelated, since\n");
  });

  it("a change set other than the one approved is refused stale", async () => {
    const c = client(h);
    const sha = await c.write("Areas/Epsilon.md", "# E\n");
    const r = await c.revert({ commit: sha, expect: { files: ["Areas/Something-else.md"], reverts: [sha], skipped_config: [] } });
    expect(r.status).toBe(409);
    expect(await read(h, "Areas/Epsilon.md")).toBe("# E\n");
  });

  it("an uncommitted edit to a file the rollback changes is the owner's work: 409, and it is untouched", async () => {
    const c = client(h);
    const sha = await c.write("Areas/Zeta.md", "# Zeta\n\nagent\n");
    await writeFile(join(h.repo.root, "Areas", "Zeta.md"), "# Zeta\n\ntyped in Obsidian, not yet committed\n");
    const head = await h.git.head();
    const r = await c.revert({ commit: sha });
    expect(r.status).toBe(409);
    expect((await r.json()).error.message).toContain("in the way");
    expect(await read(h, "Areas/Zeta.md")).toBe("# Zeta\n\ntyped in Obsidian, not yet committed\n");
    expect(await h.git.head()).toBe(head);
    await ownerCommit(h.repo.root, "owner keeps the Obsidian edit");
  });

  it("a bad revision, a bad moment, two targets, a path outside, an unknown or root commit — each refused before anything moves", async () => {
    const c = client(h);
    const head = await h.git.head();
    const root = (await h.git.run(["rev-list", "--max-parents=0", "HEAD"])).trim();
    for (const [body, status] of [
      [{ commit: "HEAD~1" }, 400],
      [{ commit: "--output=/tmp/x" }, 400],
      [{ to: "yesterday" }, 400],
      [{ to: "2026-02-30" }, 400],
      [{ commit: "abcdef12", to: "2026-01-02" }, 400],
      [{}, 400],
      [{ file: "../outside.md" }, 400],
      [{ file: ".git/config" }, 403],
      [{ commit: "0123456789abcdef" }, 404],
      [{ commit: root }, 400],
      [{ to: "1999-01-01" }, 400],
    ] as const) {
      const r = await c.revert(body as Record<string, unknown>);
      expect(r.status, JSON.stringify(body)).toBe(status);
    }
    expect(await h.git.head()).toBe(head);
  });
});

describe("the target's shape", () => {
  it("one of commit, to or file — or file with to — and nothing else reaches git's argv", () => {
    expect(parseRevertTarget({ commit: "ABCDEF12" })).toEqual({ ok: true, value: { kind: "commit", commit: "abcdef12" } });
    expect(parseRevertTarget({ to: "2026-09-26" })).toEqual({ ok: true, value: { kind: "to", to: "2026-09-26" } });
    expect(parseRevertTarget({ file: "Areas/x.md", to: "2026-09-26T08:00:00-04:00" })).toEqual({ ok: true, value: { kind: "file", file: "Areas/x.md", to: "2026-09-26T08:00:00-04:00" } });
    expect(parseRevertTarget({ commit: "abcdef12", file: "x.md" }).ok).toBe(false);
    for (const bad of ["2026-9-26", "26/09/2026", "2026-09-26T08:00", "2026-09-26 08:00:00", "--all", "now"]) expect(validMoment(bad), bad).toBe(false);
    expect(beforeArg("2026-09-26")).toBe("--before=2026-09-26 23:59:59");
    expect(beforeArg("2026-09-26T08:00:00.123Z")).toBe("--before=2026-09-26T08:00:00Z");
  });
});

describe("**history is never rewritten**", () => {
  it("no argv any rollback above ran is one git.ts refuses — no --force, no reset, no rebase, no checkout", () => {
    expect(everyArgv.length).toBeGreaterThan(100);
    expect(everyArgv.filter((a) => refusedGitArgs(a) !== null)).toEqual([]);
    expect(everyArgv.filter((a) => ["reset", "rebase", "checkout", "restore", "update-ref", "push"].includes(a[0]!) || a.some((x) => x.startsWith("--force") || x === "--hard"))).toEqual([]);
    // the branch only ever moved forward, onto a commit whose parent was HEAD
    expect(everyArgv.filter((a) => a[0] === "merge").every((a) => a[1] === "--ff-only")).toBe(true);
  });
});
