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
  });

  it("does not index the assistant's operating instructions or the readme", async () => {
    const paths = await vault.walkVault();
    expect(paths).not.toContain("CLAUDE.md");
    expect(paths).not.toContain("README.md");
    // the fixture really does have one, or this proves nothing
    expect(await readdir(repo.root)).toContain("CLAUDE.md");
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

// ---- the same walk over an instance that has not been migrated yet -----------
//
// The walk starts at the instance ROOT in both layouts. On a legacy instance
// that root also holds `identity.yaml`, `queries/`, `metistry.lock` and the
// gitignored `state/` — including a Postgres cluster. Before core's
// predicates knew the legacy names, every one of those became a
// `knowledge_files` row, and `isProtectedPath` said the assistant could
// write them (invariant 2).

describe("Vault.walkVault on a legacy instance", () => {
  let repo: TempRepo;
  let vault: Vault;

  beforeAll(async () => {
    repo = await tempRepo();
    // turn the fixture into the legacy shape: the vault under Knowledge/,
    // the machinery at the root beside it
    await mkdir(join(repo.root, "Knowledge", "Journal"), { recursive: true });
    await mkdir(join(repo.root, "Knowledge", "Inbox"), { recursive: true });
    await writeFile(join(repo.root, "Knowledge", "now.md"), "# Now\n");
    await writeFile(join(repo.root, "Knowledge", "Journal", "2026-09-01.md"), "# a day\n");
    await writeFile(join(repo.root, "Knowledge", "Inbox", "capture.md"), "# capture\n");
    await writeFile(join(repo.root, "identity.yaml"), "name: X\n");
    await writeFile(join(repo.root, "rules.yaml"), "tiers: {}\n");
    await writeFile(join(repo.root, "compute.yaml"), "providers: {}\n");
    await writeFile(join(repo.root, "metistry.lock"), "product: {}\n");
    await mkdir(join(repo.root, "queries"), { recursive: true });
    await writeFile(join(repo.root, "queries", "board.yaml"), "name: board\n");
    await mkdir(join(repo.root, "agents", "research"), { recursive: true });
    await writeFile(join(repo.root, "agents", "research", "analyst.md"), "---\nname: analyst\n---\n");
    await mkdir(join(repo.root, "state", "pg", "base"), { recursive: true });
    await writeFile(join(repo.root, "state", "ports.yaml"), "label_suffix: abc12345\n");
    await writeFile(join(repo.root, "state", "pg", "PG_VERSION"), "17\n");
    await writeFile(join(repo.root, "state", "pg", "base", "16384"), "cluster bytes");
    vault = new Vault(repo.root, repo.git, new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test" }), { maxBytes: 4096 });
  });
  afterAll(() => repo.cleanup());

  it("indexes the legacy vault", async () => {
    const paths = await vault.walkVault();
    expect(paths).toContain("Knowledge/now.md");
    expect(paths).toContain("Knowledge/Journal/2026-09-01.md");
    expect(paths).toContain("Knowledge/Inbox/capture.md");
  });

  it("indexes none of the machinery at the instance root, and nothing in state/", async () => {
    const paths = await vault.walkVault();
    for (const p of ["identity.yaml", "rules.yaml", "compute.yaml", "metistry.lock", "queries/board.yaml", "agents/research/analyst.md", "state/ports.yaml", "state/pg/PG_VERSION", "state/pg/base/16384"]) {
      expect(paths, p).not.toContain(p);
    }
    // the fixture really does have them all, or this proves nothing
    expect((await readdir(repo.root)).sort()).toEqual(expect.arrayContaining(["agents", "compute.yaml", "identity.yaml", "metistry.lock", "queries", "rules.yaml", "state"]));
  });
});
