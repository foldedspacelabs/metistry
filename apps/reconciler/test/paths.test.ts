// Path confinement — every rule the write surface relies on (invariant 8:
// misuse tests ship with the interface).
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confine, isProtected, parseVaultPath, writeAllowed } from "../src/paths.js";
import { tempRepo, type TempRepo } from "./helpers.js";

describe("parseVaultPath (syntactic)", () => {
  const bad = ["", "/etc/passwd", "../x.md", "Knowledge/../identity.yaml", "Knowledge/./a.md", "Knowledge//a.md", "~/x", "C:/x", "Knowledge/a\\b.md", "Knowledge/a\0.md", "Knowledge/ a.md", "knowledge/Areas/x.md", "KNOWLEDGE/x.md", "a".repeat(600)];
  for (const p of bad) {
    it(`refuses ${JSON.stringify(p.slice(0, 40))}`, () => {
      const r = parseVaultPath(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_request");
    });
  }
  for (const p of [".git/config", "Knowledge/.git/hooks/x", ".GIT/x", "instance-migrations/0002.sql"]) {
    it(`forbids ${p}`, () => {
      const r = parseVaultPath(p);
      expect(r).toEqual({ ok: false, code: "forbidden" });
    });
  }
  it("accepts vault paths, including lowercase files inside Knowledge/", () => {
    expect(parseVaultPath("Knowledge/Areas/Alpha.md").ok).toBe(true);
    expect(parseVaultPath("Knowledge/now.md").ok).toBe(true);
    expect(parseVaultPath("inbox/2026-09-06-note.md").ok).toBe(true);
  });
});

describe("protected paths (§4.7)", () => {
  it("names the set and restricts it to the user principal", () => {
    for (const p of ["identity.yaml", "assistant-prompt.md", "rules.yaml", "sources.yaml", "deployment.yaml", "metistry.lock", "CLAUDE.md", "queries/x.yaml", "agents/a/manifest.yaml", "routines/r/manifest.yaml", "extensions/e/x.ts"]) {
      expect(isProtected(p), p).toBe(true);
      expect(writeAllowed(p, "assistant"), p).toBe(false);
      expect(writeAllowed(p, "user"), p).toBe(true);
    }
    expect(isProtected("Knowledge/identity.yaml")).toBe(false);
    expect(writeAllowed("Knowledge/Areas/Alpha.md", "assistant")).toBe(true);
  });
});

describe("confine (filesystem)", () => {
  let repo: TempRepo;
  beforeAll(async () => {
    repo = await tempRepo();
    await mkdir(join(repo.root, "..", "outside-" + repo.root.split("-").pop()), { recursive: true });
    await symlink(join(repo.root, "..", "outside-" + repo.root.split("-").pop()), join(repo.root, "Knowledge", "Escape"));
    await writeFile(join(repo.root, "Knowledge", "Areas", "Real.md"), "x");
    await symlink(join(repo.root, "Knowledge", "Areas", "Real.md"), join(repo.root, "Knowledge", "Areas", "Link.md"));
  });
  afterAll(() => repo.cleanup());

  it("resolves a good path inside the repo", async () => {
    const r = await confine(repo.root, "Knowledge/Areas/New.md");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path.rel).toBe("Knowledge/Areas/New.md");
  });
  it("refuses a symlinked directory (would escape the repo)", async () => {
    expect(await confine(repo.root, "Knowledge/Escape/x.md")).toEqual({ ok: false, code: "forbidden" });
  });
  it("refuses a symlinked file", async () => {
    expect(await confine(repo.root, "Knowledge/Areas/Link.md")).toEqual({ ok: false, code: "forbidden" });
  });
  it("refuses a case-mismatched existing prefix", async () => {
    // on a case-insensitive fs this would silently land inside Areas/; on Linux it would fork the tree
    const r = await confine(repo.root, "Knowledge/areas/Real.md");
    expect(r.ok).toBe(false);
  });
});
