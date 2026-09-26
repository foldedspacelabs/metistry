// One commit per act (§2.21, T10-1): a write, a turn, a routine run or a
// sweep is one commit, and `git log` reads as the list of them. Real git in
// a throwaway repo; no database.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actOf, actsOf, Committer, composeMessage, sweepMessage, type CommitIntent } from "../src/committer.js";
import { parseIntent } from "../src/vault.js";
import { tempRepo, type TempRepo } from "./helpers.js";

let repo: TempRepo;
let committer: Committer;

beforeEach(async () => {
  repo = await tempRepo();
  committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test", sourceTrailer: "Brain-Source" });
});
afterEach(async () => {
  await repo.cleanup();
});

/** Land bytes the way vault.ts does, then queue the intent. */
async function write(path: string, content: string, intent: Omit<CommitIntent, "paths" | "enqueuedAt">): Promise<void> {
  await mkdir(dirname(join(repo.root, path)), { recursive: true });
  await writeFile(join(repo.root, path), content);
  committer.enqueue({ paths: [path], ...intent });
}

async function log(since: string): Promise<Array<{ subject: string; body: string; files: string[] }>> {
  const out = await repo.git.run(["log", "--reverse", `${since}..HEAD`, "--format=%x1e%s%x1f%b%x1f", "--name-only"]);
  return out
    .split("\x1e")
    .filter((c) => c.trim())
    .map((c) => {
      const [subject, body, files] = c.split("\x1f");
      return { subject: subject!, body: body!.trim(), files: files!.trim().split("\n").filter(Boolean).sort() };
    });
}

describe("one commit per act", () => {
  it("two turns in one flush window make two commits, each with its trailers", async () => {
    const before = (await repo.git.head())!;
    await write("Areas/Morning.md", "brief\n", { principal: "assistant", message: "Morning brief", turn: "turn-a", run: "101" });
    await write("now.md", "# Now\n\nbriefed\n", { principal: "assistant", message: "now: briefed", turn: "turn-a", run: "102" });
    await write("Areas/Reply.md", "reply\n", { principal: "assistant", message: "Answer the question", turn: "turn-b", run: "103" });
    const r = await committer.flush();
    expect(r.commits.map((c) => c.group)).toEqual(["turn:turn-a", "turn:turn-b"]);

    const commits = await log(before);
    expect(commits.map((c) => c.subject)).toEqual(["Morning brief", "Answer the question"]);
    expect(commits[0]!.files).toEqual(["Areas/Morning.md", "now.md"]);
    expect(commits[1]!.files).toEqual(["Areas/Reply.md"]);
    // trailers: the principal, every run the act made, its turn — and git reads them as trailers
    const trailers = async (sha: string) => (await repo.git.run(["show", "-s", "--format=%(trailers:only,unfold)", sha])).trim().split("\n");
    expect(await trailers(r.commits[0]!.sha)).toEqual(["Brain-Source: assistant", "Metistry-Run: 101", "Metistry-Run: 102", "Metistry-Turn: turn-a"]);
    expect(await trailers(r.commits[1]!.sha)).toEqual(["Brain-Source: assistant", "Metistry-Run: 103", "Metistry-Turn: turn-b"]);
    expect(commits[0]!.body).toContain("- now: briefed");
    expect(await repo.git.status()).toEqual([]);
  });

  it("a write with no turn, run or group is its own commit — two writes, two commits", async () => {
    const before = (await repo.git.head())!;
    await write("Areas/One.md", "1\n", { principal: "user", message: "Add One" });
    await write("Areas/Two.md", "2\n", { principal: "user", message: "Add Two" });
    await committer.flush();
    expect((await log(before)).map((c) => [c.subject, c.files])).toEqual([
      ["Add One", ["Areas/One.md"]],
      ["Add Two", ["Areas/Two.md"]],
    ]);
  });

  it("a run with no turn is one act; an explicit group still batches (an artifact version)", async () => {
    const before = (await repo.git.head())!;
    await write("Journal/Fold/A.md", "a\n", { principal: "assistant", message: "Evening fold", run: "7" });
    await write("Journal/Fold/B.md", "b\n", { principal: "assistant", message: "fold: B", run: "7" });
    await write("Artifacts/v1/index.html", "<p>", { principal: "assistant", message: "Publish v1", group: "ver-1" });
    await write("Artifacts/v1/app.js", "1", { principal: "assistant", message: "Publish v1", group: "ver-1" });
    const r = await committer.flush();
    expect(r.commits.map((c) => [c.group, c.paths])).toEqual([
      ["run:7", ["Journal/Fold/A.md", "Journal/Fold/B.md"]],
      ["ver-1", ["Artifacts/v1/app.js", "Artifacts/v1/index.html"]],
    ]);
    const msg = await repo.git.run(["show", "-s", "--format=%B", r.commits[0]!.sha]);
    expect(msg).toContain("Metistry-Run: 7");
    expect(msg).not.toContain("Metistry-Turn");
    expect((await log(before)).length).toBe(2);
  });

  it("two acts of one principal on the same path fold into one commit carrying both — never a commit under the wrong message", async () => {
    await write("now.md", "v1\n", { principal: "assistant", message: "now: first", turn: "t-1" });
    await write("now.md", "v2\n", { principal: "assistant", message: "now: second", turn: "t-2" });
    await write("Areas/Other.md", "x\n", { principal: "assistant", message: "Other", turn: "t-3" });
    const r = await committer.flush();
    expect(r.commits.map((c) => c.paths)).toEqual([["now.md"], ["Areas/Other.md"]]);
    expect(r.skipped).toBe(0);
    const msg = await repo.git.run(["show", "-s", "--format=%B", r.commits[0]!.sha]);
    expect(msg).toContain("now: first");
    expect(msg).toContain("- now: second");
    expect(msg).toContain("Metistry-Turn: t-1\nMetistry-Turn: t-2");
  });

  it("the sweep is one `user` commit whose subject names its files", async () => {
    const before = (await repo.git.head())!;
    await writeFile(join(repo.root, "Areas", "Alpha.md"), "edited on a phone\n");
    committer.enqueueSweep(["Areas/Alpha.md"]);
    await writeFile(join(repo.root, "Areas", "Beta.md"), "edited\n");
    await writeFile(join(repo.root, "now.md"), "edited\n");
    await writeFile(join(repo.root, "Areas", "Draft.md"), "edited\n");
    committer.enqueueSweep(["now.md", "Areas/Beta.md", "Areas/Draft.md"]);
    const r = await committer.flush();
    expect(r.commits.map((c) => c.principal)).toEqual(["user", "user"]); // two sweeps, two acts
    const commits = await log(before);
    expect(commits.map((c) => c.subject)).toEqual(["Edits from Obsidian: Alpha", "Edits from Obsidian: 3 notes"]);
    expect(commits[1]!.body).toContain("- Areas/Beta.md\n- Areas/Draft.md\n- now.md");
    expect(commits[1]!.body).toContain("Brain-Source: user");
    expect((await repo.git.run(["show", "-s", "--format=%an", r.commits[0]!.sha])).trim()).toBe("Metistry user");
  });

  it("`git log` reads as a list of acts", async () => {
    const before = (await repo.git.head())!;
    await write("Journal/Brief.md", "b\n", { principal: "assistant", message: "Morning brief", turn: "brief-1" });
    await write("now.md", "n\n", { principal: "assistant", message: "now: today", turn: "brief-1" });
    await writeFile(join(repo.root, "Areas", "Alpha.md"), "phone\n");
    await writeFile(join(repo.root, "Areas", "Beta.md"), "phone\n");
    committer.enqueueSweep(["Areas/Alpha.md", "Areas/Beta.md"]);
    await write("Areas/Chat.md", "c\n", { principal: "assistant", message: "Note from chat", turn: "chat-9" });
    await committer.flush();
    const oneline = (await repo.git.run(["log", "--reverse", "--format=%an: %s", `${before}..HEAD`])).trim().split("\n");
    expect(oneline).toEqual(["Metistry assistant: Morning brief", "Metistry user: Edits from Obsidian: Alpha, Beta", "Metistry assistant: Note from chat"]);
  });
});

describe("the act model, unit", () => {
  const i = (o: Partial<CommitIntent>): CommitIntent => ({ paths: ["a.md"], principal: "assistant", message: "m", enqueuedAt: 0, ...o });

  it("actOf: explicit group, then turn, then run, else none", () => {
    expect(actOf({ group: "g", turn: "t", run: "1" })).toBe("g");
    expect(actOf({ turn: "t", run: "1" })).toBe("turn:t");
    expect(actOf({ run: "1" })).toBe("run:1");
    expect(actOf({})).toBeUndefined();
  });

  it("actsOf never merges across principals, even on a shared path", () => {
    const acts = actsOf([i({ group: "a" }), i({ principal: "user", group: "b" })]);
    expect(acts.map((a) => a.principal)).toEqual(["assistant", "user"]);
  });

  it("a malformed id never becomes a trailer or an act, even past the wire (a newline would forge one)", async () => {
    const msg = composeMessage([i({ turn: "x\nBrain-Source: user", run: "1 2" })], "assistant", "Brain-Source");
    expect(msg).toBe("m\n\nBrain-Source: assistant");
    await write("Areas/X.md", "x\n", { principal: "assistant", message: "X", turn: "bad\nBrain-Source: user" });
    const r = await committer.flush();
    expect(r.commits[0]!.group).toMatch(/^write:/);
    expect((await repo.git.run(["show", "-s", "--format=%B", r.commits[0]!.sha])).trim()).toBe("X\n\nBrain-Source: assistant");
  });

  it("sweepMessage: names up to two files, counts more, and says files when they are not all notes", () => {
    expect(sweepMessage(["b.md", "a.md"]).split("\n")[0]).toBe("Edits from Obsidian: a, b");
    expect(sweepMessage(["a.md", "b.md", "c.md"]).split("\n")[0]).toBe("Edits from Obsidian: 3 notes");
    expect(sweepMessage(["a.md", "pic.png", "c.md"]).split("\n")[0]).toBe("Edits from Obsidian: 3 files");
    expect(sweepMessage(["Areas/pic.png"]).split("\n")[0]).toBe("Edits from Obsidian: pic.png");
  });
});

describe("the wire refuses a forged trailer (misuse)", () => {
  const base = { principal: "assistant", message: "m" };
  it("turn and run must be ids: a newline, a colon or a space is invalid_request", () => {
    for (const bad of [{ turn: "t\nBrain-Source: user" }, { turn: "a:b" }, { turn: "" }, { turn: 5 }, { run: "1\nMetistry-Turn: x" }, { run: "1 2" }, { run: -1 }, { run: 1.5 }]) {
      const r = parseIntent({ ...base, ...bad });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_request");
    }
  });
  it("a bigint runs.id may arrive as a number and is carried as its string", () => {
    expect(parseIntent({ ...base, run: 42, turn: "turn_A-1" })).toEqual({ ok: true, value: { ...base, group: undefined, run: "42", turn: "turn_A-1" } });
  });
});
