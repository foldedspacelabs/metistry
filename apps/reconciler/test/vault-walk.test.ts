// The knowledge walk, since the instance directory became the vault
// (2026-09-17). What it must NOT see is the whole point: the machinery under
// `.metistry/`, Obsidian's own `.obsidian/`, git, and `Artifacts/` — which is
// owner-visible content at the root that nothing has ever indexed.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Committer } from "../src/committer.js";
import { Vault } from "../src/vault.js";
import { tempRepo, type TempRepo } from "./helpers.js";

describe("Vault.walkVault", () => {
  let repo: TempRepo;
  let vault: Vault;

  beforeAll(async () => {
    repo = await tempRepo();
    await mkdir(join(repo.root, ".obsidian"), { recursive: true });
    await writeFile(join(repo.root, ".obsidian", "workspace.json"), "{}");
    await mkdir(join(repo.root, "Inbox", ".large"), { recursive: true });
    await writeFile(join(repo.root, "Inbox", "capture.md"), "# capture\n");
    await writeFile(join(repo.root, "Inbox", ".large", "clip.mov"), "big");
    await writeFile(join(repo.root, "CLAUDE.md"), "# instructions\n");
    vault = new Vault(repo.root, repo.git, new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test" }), { maxBytes: 4096 });
  });
  afterAll(() => repo.cleanup());

  it("walks from the instance ROOT — the vault has no directory of its own any more", async () => {
    const paths = await vault.walkVault();
    expect(paths).toContain("now.md");
    expect(paths).toContain("Areas/Alpha.md");
    expect(paths).toContain("Inbox/capture.md");
    // the root files are vault content: Obsidian renders them, so the index sees them
    expect(paths).toContain("CLAUDE.md");
  });

  it("skips .metistry/, .obsidian/, .git/ and Artifacts/", async () => {
    const paths = await vault.walkVault();
    for (const skipped of [".metistry", ".obsidian", ".git", "Artifacts"]) {
      expect(paths.filter((p) => p === skipped || p.startsWith(`${skipped}/`)), skipped).toEqual([]);
    }
    // the fixture really does contain each of them, or this test proves nothing
    const onDisk = (await readdir(repo.root)).sort();
    expect(onDisk).toEqual(expect.arrayContaining([".git", ".metistry", ".obsidian", "Artifacts"]));
  });

  it("skips the gitignored capture spill, so its rows are left alone rather than archived", async () => {
    expect(await vault.walkVault()).not.toContain("Inbox/.large/clip.mov");
  });
});
