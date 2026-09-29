// W3 checkpoint D1: a write the reconciler took but had not committed when
// it stopped used to stay uncommitted for good — `metistry update` writes
// `.metistry/metistry.lock` and `.metistry/secrets.yaml` and restarts the
// supervisor seconds later. Both halves of the fix, on real git in a
// throwaway repo: the stop commits the queue (shutdown.ts + `drain`), and a
// start commits what a killed process owed (`recover`, from the journal) —
// and nothing else.
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMIT_JOURNAL, Committer, journalEntry, type CommitterConfig } from "../src/committer.js";
import { installShutdown, type SignalSource } from "../src/shutdown.js";
import { Git } from "../src/git.js";
import { Vault } from "../src/vault.js";
import { tempRepo, type TempRepo } from "./helpers.js";

let repo: TempRepo;
let journal: string;
const cfg = (): CommitterConfig => ({ authorPrefix: "Metistry", authorEmail: "metistry@test", sourceTrailer: "Brain-Source", journal });

/** A running reconciler's write door, as the bridge drives it: bytes on disk, the intent queued (and journalled). */
function reconciler(): { committer: Committer; vault: Vault } {
  const committer = new Committer(repo.git, cfg());
  return { committer, vault: new Vault(repo.root, repo.git, committer, { maxBytes: 65536 }) };
}

async function commitsSince(since: string): Promise<Array<{ author: string; subject: string; trailers: string; files: string[] }>> {
  const out = await repo.git.run(["log", "--reverse", `${since}..HEAD`, "--format=%x1e%an%x1f%s%x1f%(trailers:only,unfold)%x1f", "--name-only"]);
  return out
    .split("\x1e")
    .filter((c) => c.trim())
    .map((c) => {
      const [author, subject, trailers, files] = c.split("\x1f");
      return { author: author!, subject: subject!, trailers: trailers!.trim(), files: files!.trim().split("\n").filter(Boolean).sort() };
    });
}

const dirty = async () => (await repo.git.status()).map((e) => e.path).sort();

beforeEach(async () => {
  repo = await tempRepo();
  journal = await repo.git.gitPath(COMMIT_JOURNAL);
});
afterEach(async () => {
  await repo.cleanup();
});

describe("the stop commits the queue (SIGTERM / SIGINT)", () => {
  it("a queued protected write and SIGTERM → committed as `user` before exit, and the journal is gone", async () => {
    const before = (await repo.git.head())!;
    const { committer, vault } = reconciler();
    const w = await vault.write(".metistry/metistry.lock", Buffer.from("product:\n  version: 0.15.0\n"), { principal: "user", message: "metistry update → 0.15.0" }, "owner");
    expect(w.ok).toBe(true);
    expect(existsSync(journal)).toBe(true); // journalled before the write answered

    const source = new EventEmitter();
    const events: string[] = [];
    let exited: number | undefined;
    let committedAtExit: string[] = [];
    const exit = new Promise<void>((resolve) => {
      const h = installShutdown({
        committer,
        stop: () => events.push("stop"),
        close: async () => void events.push("close"),
        exit: (code) => {
          exited = code;
          void repo.git.run(["log", "-1", "--format=%s"]).then((s) => {
            committedAtExit = [s.trim()];
            h.uninstall();
            resolve();
          });
        },
        log: () => {},
        timeoutMs: 5_000,
        source: source as unknown as SignalSource,
      });
    });
    source.emit("SIGTERM");
    await exit;

    expect(exited).toBe(0);
    expect(events).toEqual(["stop", "close"]);
    expect(committedAtExit).toEqual(["metistry update → 0.15.0"]);
    const commits = await commitsSince(before);
    expect(commits).toEqual([{ author: "Metistry user", subject: "metistry update → 0.15.0", trailers: "Brain-Source: user", files: [".metistry/metistry.lock"] }]);
    expect(await dirty()).toEqual([]);
    expect(existsSync(journal)).toBe(false);
  });

  it("SIGINT does the same; a second signal exits at once with 1", async () => {
    const { committer, vault } = reconciler();
    await vault.write("Areas/Note.md", Buffer.from("# Note\n"), { principal: "assistant", message: "a note" }, "console");
    // hold the committer so the first stop cannot finish, then signal again
    let release!: () => void;
    await new Promise<void>((held) => void committer.holdHistory(() => new Promise<void>((r) => ((release = r), held()))));
    const source = new EventEmitter();
    const codes: number[] = [];
    const h = installShutdown({ committer, stop: () => {}, exit: (c) => codes.push(c), log: () => {}, timeoutMs: 5_000, source: source as unknown as SignalSource });
    source.emit("SIGINT");
    source.emit("SIGTERM");
    expect(codes).toEqual([1]);
    release();
    await h.done;
    expect(codes).toEqual([1, 0]);
    h.uninstall();
  });

  it("a flush that outlives the deadline leaves the queue in the journal, and the next start commits it", async () => {
    const before = (await repo.git.head())!;
    const { committer, vault } = reconciler();
    let release!: () => void;
    void committer.holdHistory(() => new Promise<void>((r) => (release = r)));
    // the tree is held too, so the bytes land the way vault.ts lands them and the intent is queued by hand
    await writeFile(join(repo.root, ".metistry", "secrets.yaml"), "secrets: {}\n");
    committer.enqueue({ paths: [".metistry/secrets.yaml"], principal: "user", message: "secrets: shared scope" });
    void vault;
    const r = await committer.drain(50);
    expect(r).toMatchObject({ flush: null, timedOut: true, left: 1 });
    expect(JSON.parse(await readFile(journal, "utf8")).intents).toHaveLength(1);

    // the process is SIGKILLed here: its queue dies with it, the journal does not
    const next = new Committer(repo.git, cfg());
    const rec = await next.recover();
    expect(rec).toMatchObject({ replayed: 1, dropped: 0 });
    expect(await commitsSince(before)).toEqual([{ author: "Metistry user", subject: "secrets: shared scope", trailers: "Brain-Source: user", files: [".metistry/secrets.yaml"] }]);
    expect(await dirty()).toEqual([]);
    release();
  });
});

describe("the start commits what a killed process owed — and nothing else", () => {
  it("a dirty protected file the last process wrote → one commit, author `Metistry user`, the message it was written with", async () => {
    const before = (await repo.git.head())!;
    const old = reconciler();
    await old.vault.write(".metistry/metistry.lock", Buffer.from("product:\n  version: 0.15.0\n"), { principal: "user", message: "metistry update → 0.15.0" }, "owner");
    expect(await dirty()).toEqual([".metistry/metistry.lock"]);
    // hard kill: `old` is never flushed

    const fresh = new Committer(repo.git, cfg());
    const r = await fresh.recover();
    expect(r.replayed).toBe(1);
    expect(r.flush?.commits).toHaveLength(1);
    expect(await commitsSince(before)).toEqual([{ author: "Metistry user", subject: "metistry update → 0.15.0", trailers: "Brain-Source: user", files: [".metistry/metistry.lock"] }]);
    expect(await dirty()).toEqual([]);
    expect(existsSync(journal)).toBe(false);
  });

  it("update's two writes come back as the two commits they would have been, run and turn trailers kept", async () => {
    const before = (await repo.git.head())!;
    const old = reconciler();
    await old.vault.write(".metistry/metistry.lock", Buffer.from("v: 1\n"), { principal: "user", message: "metistry update → 0.15.0" }, "owner");
    await old.vault.write(".metistry/secrets.yaml", Buffer.from("s: {}\n"), { principal: "user", message: "secrets: shared scope" }, "owner");
    await old.vault.write("Areas/Brief.md", Buffer.from("# Brief\n"), { principal: "assistant", message: "Morning brief", run: "42", turn: "turn-x" }, "console");

    const r = await new Committer(repo.git, cfg()).recover();
    expect(r.replayed).toBe(3);
    expect(await commitsSince(before)).toEqual([
      { author: "Metistry user", subject: "metistry update → 0.15.0", trailers: "Brain-Source: user", files: [".metistry/metistry.lock"] },
      { author: "Metistry user", subject: "secrets: shared scope", trailers: "Brain-Source: user", files: [".metistry/secrets.yaml"] },
      { author: "Metistry assistant", subject: "Morning brief", trailers: "Brain-Source: assistant\nMetistry-Run: 42\nMetistry-Turn: turn-x", files: ["Areas/Brief.md"] },
    ]);
  });

  it("an unrelated dirty Knowledge/ note and the owner's own .metistry/ edit are NOT touched", async () => {
    const before = (await repo.git.head())!;
    const old = reconciler();
    await old.vault.write(".metistry/metistry.lock", Buffer.from("v: 1\n"), { principal: "user", message: "metistry update → 0.15.0" }, "owner");
    // edits nobody queued: a note typed in Obsidian, and the owner's hand on rules.yaml
    await writeFile(join(repo.root, "Areas", "Loose.md"), "# typed in Obsidian\n");
    await mkdir(join(repo.root, "Knowledge"), { recursive: true });
    await writeFile(join(repo.root, "Knowledge", "Loose.md"), "# also loose\n");
    await writeFile(join(repo.root, ".metistry", "rules.yaml"), "rules: [mine]\n");

    await new Committer(repo.git, cfg()).recover();
    const commits = await commitsSince(before);
    expect(commits.map((c) => c.files)).toEqual([[".metistry/metistry.lock"]]);
    expect(await dirty()).toEqual([".metistry/rules.yaml", "Areas/Loose.md", "Knowledge/Loose.md"]);
  });

  it("a write already committed before the kill makes no second commit", async () => {
    const old = reconciler();
    await old.vault.write(".metistry/metistry.lock", Buffer.from("v: 1\n"), { principal: "user", message: "lock" }, "owner");
    await old.committer.flush();
    const head = (await repo.git.head())!;
    // the journal the kill left behind can name it anyway (killed between the commit and the rewrite)
    await writeFile(journal, JSON.stringify({ version: 1, intents: [{ paths: [".metistry/metistry.lock"], principal: "user", message: "lock", group: "write:1" }] }));
    const r = await new Committer(repo.git, cfg()).recover();
    expect(r).toMatchObject({ replayed: 1, flush: { commits: [], skipped: 1 } });
    expect(await repo.git.head()).toBe(head);
  });

  it("no journal, or one that does not parse: nothing happens", async () => {
    const head = await repo.git.head();
    expect(await new Committer(repo.git, cfg()).recover()).toEqual({ replayed: 0, dropped: 0, flush: null });
    await writeFile(journal, "{not json");
    expect(await new Committer(repo.git, cfg()).recover()).toEqual({ replayed: 0, dropped: 0, flush: null });
    expect(await repo.git.head()).toBe(head);
  });
});

describe("a journal entry is never a way round the bridge (misuse)", () => {
  const ok = { principal: "user", message: "m", paths: [".metistry/metistry.lock"] };
  it("a protected path under any principal but `user` is refused", () => {
    expect(journalEntry(ok)).not.toBeNull();
    expect(journalEntry({ ...ok, principal: "assistant" })).toBeNull();
    expect(journalEntry({ ...ok, principal: "agent:x", paths: ["CLAUDE.md"] })).toBeNull();
  });
  it("paths the bridge would refuse are refused", () => {
    for (const p of [".git/config", "../outside.md", "/etc/passwd", ".metistry/instance-migrations/0002.sql", "a\\b.md", ""]) {
      expect(journalEntry({ ...ok, paths: [p] }), p).toBeNull();
    }
  });
  it("a malformed entry is refused, and a forged trailer id is dropped", () => {
    expect(journalEntry(null)).toBeNull();
    expect(journalEntry({ ...ok, paths: [] })).toBeNull();
    expect(journalEntry({ ...ok, principal: "user\nBrain-Source: assistant" })).toBeNull();
    expect(journalEntry({ ...ok, group: "x\ny" })).toBeNull();
    expect(journalEntry({ ...ok, run: "1\nMetistry-Run: 2" })?.run).toBeUndefined();
  });
  it("a refused entry is counted and not committed; the rest still are", async () => {
    await writeFile(join(repo.root, ".metistry", "rules.yaml"), "rules: [forged]\n");
    await writeFile(join(repo.root, "Areas", "Ok.md"), "# ok\n");
    await writeFile(journal, JSON.stringify({ version: 1, intents: [{ paths: [".metistry/rules.yaml"], principal: "assistant", message: "forged" }, { paths: ["Areas/Ok.md"], principal: "assistant", message: "ok" }] }));
    const r = await new Committer(repo.git, cfg()).recover();
    expect(r).toMatchObject({ replayed: 1, dropped: 1 });
    expect(await dirty()).toEqual([".metistry/rules.yaml"]);
  });
});

describe("the journal follows the queue", () => {
  it("a write that lands while a flush is running keeps the flush's batch in the journal too", async () => {
    // a git whose `commit` waits on a gate: the flush has taken its batch off the queue and not committed it
    let reached!: () => void;
    const atCommit = new Promise<void>((r) => (reached = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    class GatedGit extends Git {
      override async run(args: string[], opts?: Parameters<Git["run"]>[1]): Promise<string> {
        if (args[0] === "commit") {
          reached();
          await gate;
        }
        return super.run(args, opts);
      }
    }
    const git = new GatedGit(repo.root);
    const committer = new Committer(git, cfg());
    const vault = new Vault(repo.root, git, committer, { maxBytes: 65536 });
    await vault.write("Areas/A.md", Buffer.from("a\n"), { principal: "assistant", message: "a" }, "console");
    const flushing = committer.flush();
    await atCommit;
    expect(committer.depth).toBe(0); // A is in flight, not queued
    await vault.write("Areas/B.md", Buffer.from("b\n"), { principal: "assistant", message: "b" }, "console");
    const mid = JSON.parse(await readFile(journal, "utf8")).intents.map((i: { paths: string[] }) => i.paths[0]).sort();
    expect(mid).toEqual(["Areas/A.md", "Areas/B.md"]);
    open();
    await flushing;
    expect(JSON.parse(await readFile(journal, "utf8")).intents.map((i: { paths: string[] }) => i.paths[0])).toEqual(["Areas/B.md"]);
    await committer.flush();
    expect(existsSync(journal)).toBe(false);
  });

  it("no journal configured: memory only, as before", async () => {
    const committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test" });
    committer.enqueue({ paths: ["now.md"], principal: "user", message: "m" });
    expect(existsSync(journal)).toBe(false);
    expect(await committer.recover()).toEqual({ replayed: 0, dropped: 0, flush: null });
  });
});
