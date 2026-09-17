import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTANCE_CONFIG_DIRS,
  INSTANCE_GITIGNORE,
  INSTANCE_GITIGNORE_LINES,
  INSTANCE_LAYOUT,
  NON_VAULT_ROOTS,
  detectLayout,
  instancePath,
  isProtectedPath,
  isVaultPath,
  metistryPath,
  statePath,
} from "../src/instance-layout.js";

const tmp = () => mkdtemp(join(tmpdir(), "metistry-layout-"));

describe("INSTANCE_LAYOUT", () => {
  it("puts everything that is not knowledge under .metistry/, and the vault at the root", () => {
    expect(INSTANCE_LAYOUT.metistryDir).toBe(".metistry");
    expect(INSTANCE_LAYOUT.stateDir).toBe(".metistry/state");
    expect(INSTANCE_LAYOUT.identity).toBe(".metistry/identity.yaml");
    expect(INSTANCE_LAYOUT.rules).toBe(".metistry/rules.yaml");
    expect(INSTANCE_LAYOUT.compute).toBe(".metistry/compute.yaml");
    expect(INSTANCE_LAYOUT.deployment).toBe(".metistry/deployment.yaml");
    expect(INSTANCE_LAYOUT.lock).toBe(".metistry/metistry.lock");
    expect(INSTANCE_LAYOUT.inboxDir).toBe("Inbox");
    expect(INSTANCE_LAYOUT.artifactsDir).toBe("Artifacts");
    expect(INSTANCE_LAYOUT.assistantInstructions).toBe("CLAUDE.md");
  });

  it("names the config dirs and places each under .metistry/", () => {
    expect([...INSTANCE_CONFIG_DIRS]).toEqual(["queries", "agents", "routines", "targets", "extensions", "instance-migrations"]);
    for (const d of INSTANCE_CONFIG_DIRS) expect(metistryPath("/i", d)).toBe(`/i/.metistry/${d}`);
    expect(INSTANCE_LAYOUT.queriesDir).toBe(".metistry/queries");
    expect(INSTANCE_LAYOUT.instanceMigrationsDir).toBe(".metistry/instance-migrations");
  });

  it("is frozen — a caller wanting a different layout is describing a different product", () => {
    expect(Object.isFrozen(INSTANCE_LAYOUT)).toBe(true);
    expect(() => {
      (INSTANCE_LAYOUT as unknown as Record<string, string>).metistryDir = "metistry";
    }).toThrow();
  });

  it("gitignores derived state, Obsidian's workspace and oversized captures — and nothing else", () => {
    expect([...INSTANCE_GITIGNORE_LINES]).toEqual([".metistry/state/", ".obsidian/workspace*", "Inbox/.large/"]);
    expect(INSTANCE_GITIGNORE).toBe(".metistry/state/\n.obsidian/workspace*\nInbox/.large/\n");
  });
});

describe("instancePath / statePath", () => {
  it("joins under the instance dir, trailing slashes and all", () => {
    expect(instancePath("/i", "identity")).toBe("/i/.metistry/identity.yaml");
    expect(instancePath("/i///", "identity")).toBe("/i/.metistry/identity.yaml");
    expect(instancePath("/i", "inboxDir")).toBe("/i/Inbox");
    expect(instancePath("/i", "assistantInstructions")).toBe("/i/CLAUDE.md");
    expect(statePath("/i")).toBe("/i/.metistry/state");
    expect(statePath("/i/", ".env")).toBe("/i/.metistry/state/.env");
    expect(statePath("/i", "models", "repo")).toBe("/i/.metistry/state/models/repo");
  });
});

describe("isProtectedPath", () => {
  it("protects every config file and dir under .metistry/", () => {
    for (const p of [".metistry", ".metistry/identity.yaml", ".metistry/rules.yaml", ".metistry/compute.yaml", ".metistry/deployment.yaml", ".metistry/metistry.lock", ".metistry/assistant-prompt.md", ".metistry/sources.yaml", ".metistry/queries/board.yaml", ".metistry/agents/fsl/scout.md", ".metistry/routines/x/manifest.yaml", ".metistry/targets/x/manifest.yaml", ".metistry/extensions/x", ".metistry/instance-migrations/0001.sql"]) {
      expect(isProtectedPath(p), p).toBe(true);
    }
  });

  it("does NOT protect .metistry/state/ — derived, gitignored, nobody's record (invariant 1)", () => {
    expect(isProtectedPath(".metistry/state/x")).toBe(false);
    expect(isProtectedPath(".metistry/state")).toBe(false);
    expect(isProtectedPath(".metistry/state/models/a.gguf")).toBe(false);
    // …but a sibling whose name merely starts with "state" is still protected
    expect(isProtectedPath(".metistry/stateful.yaml")).toBe(true);
  });

  it("protects the two root files that define how the system behaves", () => {
    expect(isProtectedPath("CLAUDE.md")).toBe(true);
    expect(isProtectedPath("README.md")).toBe(true);
    expect(isProtectedPath("Areas/CLAUDE.md")).toBe(false); // a note that happens to share the name
  });

  it("leaves vault content free — that is the point of the split (invariant 2)", () => {
    for (const p of ["Inbox/x.md", "Inbox/.large/big.png", "Journal/2026-09-17.md", "Me/profile.md", "now.md", "Artifacts/bundle-1/report.pdf"]) {
      expect(isProtectedPath(p), p).toBe(false);
    }
  });

  it("answers false for nonsense rather than throwing", () => {
    expect(isProtectedPath("")).toBe(false);
    expect(isProtectedPath(undefined as unknown as string)).toBe(false);
  });
});

describe("isVaultPath", () => {
  it("is true for knowledge at the root", () => {
    for (const p of ["now.md", "Journal/2026-09-17.md", "Me/profile.md", "Inbox/capture.md"]) {
      expect(isVaultPath(p), p).toBe(true);
    }
  });

  it("is false for the two protected root files — instructions and a readme are not notes", () => {
    expect(isVaultPath("CLAUDE.md")).toBe(false);
    expect(isVaultPath("README.md")).toBe(false);
    // …only at the ROOT: a note that happens to share the name is knowledge
    expect(isVaultPath("Areas/CLAUDE.md")).toBe(true);
    expect(isVaultPath("Areas/README.md")).toBe(true);
  });

  it("is false for the machinery, git, Obsidian, dot-directories and Artifacts", () => {
    for (const p of [".metistry/identity.yaml", ".metistry/state/.env", ".git/config", ".obsidian/workspace.json", "Inbox/.large/big.png", "Artifacts", "Artifacts/bundle-1/report.pdf"]) {
      expect(isVaultPath(p), p).toBe(false);
    }
    expect(NON_VAULT_ROOTS.every((r) => !isVaultPath(r))).toBe(true);
  });

  it("refuses traversal and empty segments", () => {
    for (const p of ["", "../x", "Areas/../../etc", "Areas//x.md", "./x.md"]) expect(isVaultPath(p), p).toBe(false);
  });
});

describe("detectLayout", () => {
  it("flat: .metistry/identity.yaml is present", async () => {
    const dir = await tmp();
    await mkdir(join(dir, ".metistry"), { recursive: true });
    await writeFile(join(dir, ".metistry", "identity.yaml"), "name: X\n");
    expect(detectLayout(dir)).toBe("flat");
    expect(detectLayout(`${dir}/`)).toBe("flat");
  });

  it("legacy: a Knowledge/ directory, or identity.yaml at the root", async () => {
    const withVault = await tmp();
    await mkdir(join(withVault, "Knowledge"), { recursive: true });
    expect(detectLayout(withVault)).toBe("legacy");

    const withIdentity = await tmp();
    await writeFile(join(withIdentity, "identity.yaml"), "name: X\n");
    expect(detectLayout(withIdentity)).toBe("legacy");
  });

  it("flat wins over legacy leftovers — a half-migrated directory is flat", async () => {
    const dir = await tmp();
    await mkdir(join(dir, ".metistry"), { recursive: true });
    await mkdir(join(dir, "Knowledge"), { recursive: true });
    await writeFile(join(dir, ".metistry", "identity.yaml"), "name: X\n");
    expect(detectLayout(dir)).toBe("flat");
  });

  it("unknown: an empty directory is not an instance", async () => {
    expect(detectLayout(await tmp())).toBe("unknown");
  });

  it("takes an `exists` seam so callers can decide without a filesystem", () => {
    const seen: string[] = [];
    expect(
      detectLayout("/i", (p) => {
        seen.push(p);
        return p === "/i/.metistry/identity.yaml";
      }),
    ).toBe("flat");
    expect(seen).toEqual(["/i/.metistry/identity.yaml"]);
  });
});
