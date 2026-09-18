// Path confinement — every rule the write surface relies on (invariant 8:
// misuse tests ship with the interface).
//
// Since the 2026-09-17 layout the instance directory IS the vault, so these
// paths have no `Knowledge/` prefix, the protected set is the `.metistry/`
// PLACE rather than a list of filenames, and the casing rule applies at the
// root.
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confine, isProtected, parseVaultPath, writeAllowed } from "../src/paths.js";
import { tempRepo, type TempRepo } from "./helpers.js";

describe("parseVaultPath (syntactic)", () => {
  const bad = [
    "",
    "/etc/passwd",
    "../x.md",
    "Areas/../.metistry/identity.yaml",
    "Areas/./a.md",
    "Areas//a.md",
    "~/x",
    "C:/x",
    "Areas/a\\b.md",
    "Areas/a\0.md",
    "Areas/ a.md",
    "a".repeat(600),
    // the casing rule, now at the ROOT: these names are spelled exactly one way
    "inbox/x.md",
    "INBOX/x.md",
    "artifacts/bundle-1/x.pdf",
    ".Metistry/identity.yaml",
    "claude.md",
    "readme.md",
  ];
  for (const p of bad) {
    it(`refuses ${JSON.stringify(p.slice(0, 40))}`, () => {
      const r = parseVaultPath(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_request");
    });
  }
  for (const p of [".git/config", "Areas/.git/hooks/x", ".GIT/x", ".metistry/instance-migrations/0002.sql"]) {
    it(`forbids ${p}`, () => {
      const r = parseVaultPath(p);
      expect(r).toEqual({ ok: false, code: "forbidden" });
    });
  }
  it("accepts vault paths at the root, lowercase file names included", () => {
    expect(parseVaultPath("Areas/Alpha.md").ok).toBe(true);
    expect(parseVaultPath("now.md").ok).toBe(true);
    expect(parseVaultPath("Inbox/2026-09-06-note.md").ok).toBe(true);
    // syntactically fine; whether it is INDEXED is the walk's business, not this one's
    expect(parseVaultPath("Artifacts/bundle-1/report.pdf").ok).toBe(true);
  });
  it("accepts the protected paths too — parsing says WHERE, writeAllowed says WHO", () => {
    expect(parseVaultPath(".metistry/identity.yaml").ok).toBe(true);
    expect(parseVaultPath("CLAUDE.md").ok).toBe(true);
  });
});

describe("protected paths on an instance that has not been migrated yet (§4.7)", () => {
  // The legacy layout kept the same machinery at the instance ROOT. #193
  // restated the protected set as the `.metistry/` PLACE, which quietly took
  // every one of these OUT of it: on a legacy instance the assistant could
  // write `identity.yaml`, `rules.yaml`, `metistry.lock` and
  // `instance-migrations/` through brain-commit. Invariant 2 does not wait
  // for a migration verb.
  it("restricts the legacy root machinery to the user principal too", () => {
    for (const p of [
      "identity.yaml",
      "assistant-prompt.md",
      "rules.yaml",
      "sources.yaml",
      "compute.yaml",
      "deployment.yaml",
      "instances.yaml",
      "metistry.lock",
      "queries/board.yaml",
      "agents/research/analyst.md",
      "routines/r/manifest.yaml",
      "targets/t/manifest.yaml",
      "extensions/e/x.ts",
      "instance-migrations/0001_local.sql",
    ]) {
      expect(isProtected(p), p).toBe(true);
      expect(writeAllowed(p, "assistant"), p).toBe(false);
      expect(writeAllowed(p, "user"), p).toBe(true);
    }
  });

  it("leaves the legacy vault free — Knowledge/ is where the assistant works", () => {
    for (const p of ["Knowledge/now.md", "Knowledge/Journal/2026-09-01.md", "Knowledge/Inbox/capture.md"]) {
      expect(isProtected(p), p).toBe(false);
      expect(writeAllowed(p, "assistant"), p).toBe(true);
    }
  });
});

describe("protected paths (§4.7)", () => {
  it("names the set and restricts it to the user principal", () => {
    for (const p of [
      ".metistry/identity.yaml",
      ".metistry/assistant-prompt.md",
      ".metistry/rules.yaml",
      ".metistry/sources.yaml",
      ".metistry/deployment.yaml",
      ".metistry/metistry.lock",
      ".metistry/queries/x.yaml",
      ".metistry/agents/a/manifest.yaml",
      ".metistry/routines/r/manifest.yaml",
      ".metistry/targets/t/manifest.yaml",
      ".metistry/extensions/e/x.ts",
      "CLAUDE.md",
      "README.md",
    ]) {
      expect(isProtected(p), p).toBe(true);
      expect(writeAllowed(p, "assistant"), p).toBe(false);
      expect(writeAllowed(p, "user"), p).toBe(true);
    }
    // a note that merely shares a name with a protected file is vault content
    expect(isProtected("Areas/identity.yaml")).toBe(false);
    expect(isProtected("Areas/CLAUDE.md")).toBe(false);
    expect(writeAllowed("Areas/Alpha.md", "assistant")).toBe(true);
  });

  it(".metistry/state/ is NOT protected — it is derived, and nobody's record (invariant 1)", () => {
    expect(isProtected(".metistry/state/models/a.gguf")).toBe(false);
    // …but a sibling whose name merely starts with "state" still is
    expect(isProtected(".metistry/stateful.yaml")).toBe(true);
  });

  // The vault inbox (docs/ops/inbox.md) is ordinary vault content, not a
  // protected path: the capture principal writes into it, the assistant
  // reads it like the rest of the vault, and the gitignored `.large/`
  // spill is a directory name, not a `.git`-class refusal.
  it("Inbox is writable by the capture principal, .large/ included", () => {
    for (const p of ["Inbox/1757556000000-note.md", "Inbox/.large/1757556000000-clip.mov"]) {
      expect(parseVaultPath(p).ok, p).toBe(true);
      expect(isProtected(p), p).toBe(false);
      expect(writeAllowed(p, "capture"), p).toBe(true);
      expect(writeAllowed(p, "assistant"), p).toBe(true);
    }
    // ...and the casing rule still forbids the other spelling of it
    expect(parseVaultPath("inbox/x.md")).toEqual({ ok: false, code: "invalid_request" });
  });
});

describe("confine (filesystem)", () => {
  let repo: TempRepo;
  beforeAll(async () => {
    repo = await tempRepo();
    await mkdir(join(repo.root, "..", "outside-" + repo.root.split("-").pop()), { recursive: true });
    await symlink(join(repo.root, "..", "outside-" + repo.root.split("-").pop()), join(repo.root, "Escape"));
    await writeFile(join(repo.root, "Areas", "Real.md"), "x");
    await symlink(join(repo.root, "Areas", "Real.md"), join(repo.root, "Areas", "Link.md"));
  });
  afterAll(() => repo.cleanup());

  it("resolves a good path inside the repo", async () => {
    const r = await confine(repo.root, "Areas/New.md");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path.rel).toBe("Areas/New.md");
  });
  it("refuses a symlinked directory (would escape the repo)", async () => {
    expect(await confine(repo.root, "Escape/x.md")).toEqual({ ok: false, code: "forbidden" });
  });
  it("refuses a symlinked file", async () => {
    expect(await confine(repo.root, "Areas/Link.md")).toEqual({ ok: false, code: "forbidden" });
  });
  it("refuses a case-mismatched existing prefix", async () => {
    // on a case-insensitive fs this would silently land inside Areas/; on Linux it would fork the tree
    const r = await confine(repo.root, "areas/Real.md");
    expect(r.ok).toBe(false);
  });
});
