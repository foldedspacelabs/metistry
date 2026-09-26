// The section operation at the wire (plan §2.13, T2-6): `POST /vault/section`
// writes the bytes between `<!-- metistry:day -->` markers in the owner's
// daily note and nothing else. The grammar has its own suite
// (packages/core/test/note-section.test.ts); this one holds the DOOR — who
// may use it, on what, and that nothing else about the owner's note moves.
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NOTE_SECTIONS, mintToken, scanNoteSection } from "@foldedspacelabs/metistry-core";
import { Committer } from "../src/committer.js";
import { Vault } from "../src/vault.js";
import { makeBridge } from "../src/server.js";
import { sha256 } from "../src/notes.js";
import { tempRepo, type TempRepo } from "./helpers.js";

const token = mintToken();
const ownerToken = mintToken();
const OPEN = NOTE_SECTIONS.day.open;
const CLOSE = NOTE_SECTIONS.day.close;
const DAY = "Journal/2026-09-26.md";
const NOTE = `---\nsource: user\n---\n# 2026-09-26\n\n## Notes\n\n- [ ] the owner's own task\n\n${OPEN}\nmorning version\n${CLOSE}\n\n## Later\n\nthe owner's afternoon\n`;

/** The owner's bytes: everything but the region between the marker lines. */
function outside(bytes: Buffer): Buffer {
  const r = scanNoteSection(bytes, "day");
  if (r.state !== "present") throw new Error(`no section: ${JSON.stringify(r)}`);
  return Buffer.concat([bytes.subarray(0, r.innerStart), bytes.subarray(r.innerEnd)]);
}
/** What a caller sends as `expected_outer_sha`: core's scan over the bytes it read. */
function outerOf(bytes: Buffer): string {
  const r = scanNoteSection(bytes, "day");
  if (r.state === "missing") throw new Error(`missing: ${r.reason}`);
  return r.outerSha256;
}

describe("POST /vault/section — one writer per region", () => {
  let repo: TempRepo;
  let committer: Committer;
  let server: ReturnType<typeof makeBridge>;
  let base: string;
  const runs: Array<{ text: string; values: unknown[] }> = [];
  const db = {
    async query(text: string, values: unknown[] = []) {
      runs.push({ text, values });
      return { rows: [{ id: runs.length }] };
    },
  };
  const CONSOLE = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const OWNER = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };
  const post = (path: string, body: unknown, headers: Record<string, string> = CONSOLE) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const onDisk = (rel = DAY) => readFile(join(repo.root, rel));
  const put = async (text: string | Buffer, rel = DAY) => {
    await mkdir(join(repo.root, rel, ".."), { recursive: true });
    await writeFile(join(repo.root, rel), text);
  };
  /** Read through the bridge, hash what came back with core's scan — exactly what the Morning Brief and Close do. */
  const readOuter = async (rel = DAY, headers = CONSOLE) => {
    const r = await (await fetch(`${base}/vault/read?path=${encodeURIComponent(rel)}&encoding=base64`, { headers })).json();
    return outerOf(Buffer.from(r.content_base64, "base64"));
  };
  const section = (principal: string, body: string, expected: string, headers: Record<string, string> = CONSOLE, path = DAY) =>
    post("/vault/section", { path, marker: "day", body, principal, expected_outer_sha: expected }, headers);

  beforeAll(async () => {
    repo = await tempRepo();
    committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test", sourceTrailer: "Brain-Source" });
    const vault = new Vault(repo.root, repo.git, committer, { maxBytes: 4096 });
    server = makeBridge({ vault, committer, db }, { token, ownerToken, maxBodyBytes: 64 * 1024 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await repo.cleanup();
  });
  beforeEach(async () => {
    await put(NOTE);
    runs.length = 0;
  });

  // ---- U2 at this door: the bridge's two bearers and no other -------------

  it("401 with no bearer or an unknown one, byte-identical, and nothing is written", async () => {
    const outer = outerOf(Buffer.from(NOTE));
    for (const headers of [{ "content-type": "application/json" }, { authorization: `Bearer ${mintToken()}`, "content-type": "application/json" }]) {
      const r = await section("user", "x", outer, headers);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
    }
    expect((await onDisk()).toString()).toBe(NOTE);
  });

  // ---- Accept: the Morning Brief and Close can both use it ---------------

  it("the Morning Brief (console bearer, `morning-brief`) then Close the Day (console bearer, `user`) — the owner's edits between them survive", async () => {
    await put("---\nsource: user\n---\n# 2026-09-26\n\n## Notes\n\nfirst thing\n");
    const ownerFirst = await onDisk();

    // 7:00 AM: the note has no section yet — the first write appends one
    const brief = await section("morning-brief", "- Plan: [[Journal/Plan/2026-09-26]]\n- 9:00 Standup\n![[Journal/Standup/2026-09-26]]", await readOuter());
    expect(brief.status).toBe(200);
    const b = await brief.json();
    expect(b).toMatchObject({ path: DAY, section: "day", appended: true, queued: true });
    const afterBrief = await onDisk();
    expect(afterBrief.subarray(0, ownerFirst.length).equals(ownerFirst)).toBe(true); // the owner's bytes are an untouched prefix
    expect(afterBrief.toString()).toContain(`## Today · Metistry\n\n${OPEN}\n- Plan: [[Journal/Plan/2026-09-26]]`);
    expect(b.sha256).toBe(sha256(afterBrief));
    expect(b.outer_sha256).toBe(outerOf(afterBrief));

    // the day: the owner writes above AND below the section, in Obsidian
    const morningOuter = outerOf(afterBrief);
    const edited = afterBrief.toString().replace("first thing\n", "first thing\n- [ ] something new\n") + "\nevening notes\n";
    await put(edited);

    // 5:14 PM: Close as the owner, from what it just read
    const close = await section("user", "Day closed at 5:14 PM · 6 done · 3 to tomorrow\n- Tomorrow: ship it", await readOuter());
    expect(close.status).toBe(200);
    expect((await close.json()).appended).toBe(false);
    const afterClose = await onDisk();
    expect(outside(afterClose).equals(outside(Buffer.from(edited)))).toBe(true); // every owner byte, including the day's edits
    expect(afterClose.toString()).toContain("- [ ] something new");
    expect(afterClose.toString()).toContain("evening notes");
    expect(afterClose.toString()).not.toContain("- 9:00 Standup"); // the region is replaced whole

    // and a writer still holding the MORNING's view is refused, not merged
    const stale = await section("morning-brief", "late", morningOuter);
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("conflict");
    expect((await onDisk()).equals(afterClose)).toBe(true);
  });

  it("the owner's own bearer (the CLI) may write the section as `user`", async () => {
    const r = await section("user", "from the command line", await readOuter(DAY, OWNER), OWNER);
    expect(r.status).toBe(200);
    expect((await onDisk()).toString()).toBe(NOTE.replace("morning version\n", "from the command line\n"));
  });

  // ---- **bytes outside the markers identical after every write** ----------

  it("**bytes outside the markers are identical after every write**, whoever writes and whatever the body", async () => {
    const fixed = outside(await onDisk());
    const bodies = ["", "one", "two\nlines\n", "```\nbalanced\n```", "☕ — 5:14 PM\r\n", "- [[Journal/Plan/2026-09-26]]\n\n\n"];
    for (let i = 0; i < 12; i++) {
      const principal = i % 2 === 0 ? "morning-brief" : "user";
      const r = await section(principal, bodies[i % bodies.length]!, await readOuter());
      expect(r.status, `write ${i}`).toBe(200);
      expect(outside(await onDisk()).equals(fixed), `write ${i}`).toBe(true);
    }
  });

  // ---- **two pairs, one marker, or markers inside a code block → section_missing**

  it("**two pairs, one marker, or markers inside a code block → `section_missing`**, 409, and the note is untouched", async () => {
    const cases: Array<[string, string]> = [
      ["two pairs", `${NOTE}\n${OPEN}\nagain\n${CLOSE}\n`],
      ["one marker (opener)", `# 2026-09-26\n\n${OPEN}\nplan\n`],
      ["one marker (closer)", `# 2026-09-26\n\nplan\n${CLOSE}\n`],
      ["markers inside a code block", `# 2026-09-26\n\n\`\`\`\n${OPEN}\nplan\n${CLOSE}\n\`\`\`\n`],
      ["a marker quoted in code beside a clean pair", `${NOTE}\n~~~\n${CLOSE}\n~~~\n`],
      ["an annotated opener", `<!-- metistry:day · updated 5:14 PM -->\nplan\n${CLOSE}\n`],
      ["the heading left, its markers deleted", "# 2026-09-26\n\n## Today · Metistry\n\nplan\n"],
    ];
    const queued = committer.depth;
    for (const [what, text] of cases) {
      await put(text);
      const r = await section("morning-brief", "new", sha256(text)); // the whole-file hash — the best a caller could send
      expect(r.status, what).toBe(409);
      const e = await r.json();
      expect(e.error.code, what).toBe("section_missing");
      expect(e.error.message, what).toContain("Nothing was written");
      expect((await onDisk()).toString(), what).toBe(text);
    }
    expect(committer.depth).toBe(queued); // no commit intent for a refusal
  });

  // ---- **a mismatched outer hash is refused** -------------------------------

  it("**a mismatched outer hash is refused** — 409 conflict, and the note is untouched", async () => {
    const outer = outerOf(Buffer.from(NOTE));
    for (const wrong of [sha256("stale"), sha256(NOTE) /* the whole file, not its outside */]) {
      const r = await section("morning-brief", "x", wrong);
      expect(r.status).toBe(409);
      expect((await r.json()).error.code).toBe("conflict");
    }
    // the owner edits outside the section after the caller read it
    await put(NOTE.replace("the owner's afternoon", "the owner's afternoon, edited"));
    expect((await section("user", "x", outer)).status).toBe(409);
    expect((await onDisk()).toString()).toContain("edited");
    expect((await onDisk()).toString()).toContain("morning version");
    // …but an edit INSIDE the region is the section's to replace, and the outer hash still holds
    await put(NOTE.replace("morning version", "the owner scribbled in the section"));
    expect((await section("user", "x", outer)).status).toBe(200);
  });

  it("expected_outer_sha is required, and must be a hash", async () => {
    for (const v of [undefined, "", "zz", sha256("x").toUpperCase(), 7]) {
      const r = await post("/vault/section", { path: DAY, marker: "day", body: "x", principal: "user", ...(v === undefined ? {} : { expected_outer_sha: v }) });
      expect(r.status, String(v)).toBe(400);
    }
  });

  // ---- **a non-user principal cannot write the note any other way** --------

  it("**a non-user principal cannot write the note any other way** — write, delete, rename from, rename onto: 403, untouched", async () => {
    const note = await onDisk();
    const intent = { principal: "morning-brief", message: "try the whole file" };
    const attempts = [
      post("/vault/write", { path: DAY, content: "replaced", intent }),
      post("/vault/write", { path: DAY, content: "replaced", intent, expected_sha256: sha256(note) }),
      post("/vault/write", { path: "Journal/2026-09-27.md", content: "a note the owner never made", intent, expected_sha256: "" }),
      post("/vault/delete", { path: DAY, intent }),
      post("/vault/rename", { from: DAY, to: "Areas/Stolen.md", intent }),
    ];
    // rename ONTO a daily note from a path the routine may write
    await post("/vault/write", { path: "Areas/Mine.md", content: "x", intent });
    attempts.push(post("/vault/rename", { from: "Areas/Mine.md", to: "Journal/2026-09-28.md", intent }));
    for (const r of await Promise.all(attempts)) {
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: { code: "forbidden", message: "not granted" } });
    }
    expect((await onDisk()).equals(note)).toBe(true);
    expect(existsSync(join(repo.root, "Journal/2026-09-27.md"))).toBe(false);
    expect(existsSync(join(repo.root, "Journal/2026-09-28.md"))).toBe(false);
    // …and the owner's write through the same doors is unchanged by any of this
    expect((await post("/vault/write", { path: DAY, content: NOTE, intent: { principal: "user", message: "the owner's own edit" }, expected_sha256: sha256(note) })).status).toBe(200);
  });

  it("the section's writers are enumerated: the assistant, an agent, another routine are refused and the refusal is on the record", async () => {
    const outer = outerOf(await onDisk());
    for (const principal of ["assistant", "agent-seven", "plan-tomorrow", "standup-draft", "capture"]) {
      runs.length = 0;
      const r = await section(principal, "generated prose", outer);
      expect(r.status, principal).toBe(403);
      expect(await r.json()).toEqual({ error: { code: "forbidden", message: "not granted" } });
      const insert = runs.find((x) => x.text.includes("INSERT INTO runs"));
      expect(insert, principal).toBeTruthy();
      expect(insert!.values.slice(0, 4)).toEqual(["reconciler", "auth", null, "vault_section"]);
      expect(JSON.parse(String(insert!.values[6]))).toEqual({ caller: "console", principal, path: DAY, code: "forbidden" });
    }
    expect((await onDisk()).toString()).toBe(NOTE);
  });

  it("the principal comes from the credential: the owner bearer is `user` and nothing else, here as everywhere", async () => {
    const r = await section("morning-brief", "forged", outerOf(await onDisk()), OWNER);
    expect(r.status).toBe(403);
    const insert = runs.find((x) => x.text.includes("INSERT INTO runs"));
    expect(JSON.parse(String(insert!.values[6]))).toMatchObject({ caller: "owner", principal: "morning-brief" });
    expect((await onDisk()).toString()).toBe(NOTE);
  });

  it("the section lives only in Journal/<date>.md — not the plan, a meeting, an area, the machinery, a mis-cased or impossible date", async () => {
    const note = "x\n";
    const paths: Array<[string, number]> = [
      ["Journal/Plan/2026-09-26.md", 400],
      ["Journal/Standup/2026-09-26.md", 400],
      ["Journal/Meetings/2026-09-26-sync.md", 400],
      ["Areas/Today.md", 400],
      ["2026-09-26.md", 400],
      ["Journal/2026-02-30.md", 400],
      ["Journal/2026-9-26.md", 400],
      ["journal/2026-09-26.md", 400],
      [".metistry/rules.yaml", 400],
      ["CLAUDE.md", 400],
      ["../Journal/2026-09-26.md", 400],
      [".git/config", 403],
    ];
    for (const [p, status] of paths) {
      const r = await section("user", "x", sha256(note), CONSOLE, p);
      expect(r.status, p).toBe(status);
    }
    expect(await readFile(join(repo.root, ".metistry", "rules.yaml"), "utf8")).toBe("rules: []\n");
  });

  it("the section never creates the owner's note: absent → 404, and nothing is written", async () => {
    const r = await section("morning-brief", "plan", sha256(""), CONSOLE, "Journal/2026-10-01.md");
    expect(r.status).toBe(404);
    expect(existsSync(join(repo.root, "Journal/2026-10-01.md"))).toBe(false);
  });

  it("refuses a body that carries a marker or would hide one, an unknown section, a malformed principal, a body that is not text", async () => {
    const outer = outerOf(await onDisk());
    const bad: Array<[string, Record<string, unknown>]> = [
      ["a closer in the body", { body: `x\n${CLOSE}\nthe owner's text is mine now` }],
      ["an unclosed fence in the body", { body: "```\nswallow the closer" }],
      ["an unknown section", { marker: "night" }],
      ["the marker spelled in full", { marker: "metistry:day" }],
      ["no marker", { marker: undefined }],
      ["a principal that is not a slug", { principal: "Morning Brief" }],
      ["a body that is not text", { body: ["x"] }],
      ["no body", { body: undefined }],
    ];
    for (const [what, patch] of bad) {
      const r = await post("/vault/section", { path: DAY, marker: "day", body: "x", principal: "morning-brief", expected_outer_sha: outer, ...patch });
      expect(r.status, what).toBe(400);
      expect((await r.json()).error.code, what).toBe("invalid_request");
    }
    expect((await onDisk()).toString()).toBe(NOTE);
  });

  it("refuses a result over the size cap, and a daily note reached through a symlink", async () => {
    const r = await section("user", "x".repeat(5000), outerOf(await onDisk()));
    expect(r.status).toBe(400);
    expect((await onDisk()).toString()).toBe(NOTE);

    const elsewhere = join(repo.root, "Areas", "Elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, "2026-09-26.md"), NOTE);
    await rm(join(repo.root, "Journal"), { recursive: true, force: true });
    await symlink(elsewhere, join(repo.root, "Journal"));
    try {
      expect((await section("user", "x", outerOf(Buffer.from(NOTE)))).status).toBe(403);
      expect(await readFile(join(elsewhere, "2026-09-26.md"), "utf8")).toBe(NOTE);
    } finally {
      await rm(join(repo.root, "Journal"), { force: true });
    }
  });

  it("a run's section write joins the run's commit (plan §2.21: a brief is one commit), with its trailer", async () => {
    await post("/flush", {});
    const brief = await post("/vault/write", { path: "Resources/brief-2026-09-26.md", content: "# Brief\n", intent: { principal: "morning-brief", message: "brief for 2026-09-26", run: 412 } });
    expect(brief.status).toBe(201);
    const r = await post("/vault/section", { path: DAY, marker: "day", body: "7:00 AM plan", principal: "morning-brief", expected_outer_sha: await readOuter(), run: 412 });
    expect(r.status).toBe(200);
    const flushed = await (await post("/flush", {})).json();
    expect(flushed.commits).toHaveLength(1);
    expect([...flushed.commits[0].paths].sort()).toEqual([DAY, "Resources/brief-2026-09-26.md"]);
    expect(await repo.git.run(["show", "-s", "--format=%B", flushed.commits[0].sha])).toContain("Metistry-Run: 412");
    // the act ids are trailer lines, so their shape is checked as on every write
    for (const bad of [{ run: "4\nBrain-Source: user" }, { turn: "a:b" }, { run: -1 }]) {
      const x = await post("/vault/section", { path: DAY, marker: "day", body: "x", principal: "morning-brief", expected_outer_sha: await readOuter(), ...bad });
      expect(x.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("the write is committed in the writer's name, touching only the note", async () => {
    await post("/flush", {});
    const before = await repo.git.head();
    expect((await section("morning-brief", "the plan this commit carries", await readOuter())).status).toBe(200);
    const flushed = await (await post("/flush", {})).json();
    expect(flushed.commits).toHaveLength(1);
    const sha = flushed.commits[0].sha;
    expect(await repo.git.run(["show", "-s", "--format=%an%x1f%s", sha])).toBe(`Metistry morning-brief\x1fupdate the day section of ${DAY}\n`);
    expect((await repo.git.run(["show", "--name-only", "--format=", sha])).trim()).toBe(DAY);
    expect(await repo.git.run(["rev-list", "--count", `${before}..HEAD`])).toBe("1\n");
  });
});
