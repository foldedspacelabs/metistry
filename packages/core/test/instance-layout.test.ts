import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTANCE_CONFIG_DIRS,
  INSTANCE_GITIGNORE,
  INSTANCE_GITIGNORE_LINES,
  INSTANCE_LAYOUT,
  LEGACY_INSTANCE_LAYOUT,
  LEGACY_MACHINERY_ROOTS,
  NON_VAULT_ROOTS,
  detectLayout,
  instanceFile,
  instancePath,
  instanceStatePath,
  isProtectedPath,
  isVaultPath,
  metistryPath,
  resolveInstanceLayout,
  statePath,
} from "../src/instance-layout.js";

/** A directory in the pre-2026-09-17 shape: the vault in `Knowledge/`, config and `state/` at the root. */
async function legacyInstance(): Promise<string> {
  const dir = await tmp();
  await mkdir(join(dir, "Knowledge", "Journal"), { recursive: true });
  await mkdir(join(dir, "Knowledge", "Inbox"), { recursive: true });
  await mkdir(join(dir, "queries"), { recursive: true });
  await mkdir(join(dir, "state"), { recursive: true });
  await writeFile(join(dir, "identity.yaml"), 'name: X\ninstance_id: "5bebed51-6cf8-4334-83b2-e78f00dadeb1"\n');
  await writeFile(join(dir, "rules.yaml"), "tiers: {}\n");
  await writeFile(join(dir, "compute.yaml"), "providers:\n  lmstudio:\n    kind: openai-compatible\n    base_url: http://127.0.0.1:1234/v1\n    locality: on_machine\n");
  await writeFile(join(dir, "metistry.lock"), 'product:\n  version: "0.7.0"\n');
  await writeFile(join(dir, "Knowledge", "now.md"), "# now\n");
  return dir;
}

/** The flat shape, for the same assertions to be made against both. */
async function flatInstance(): Promise<string> {
  const dir = await tmp();
  await mkdir(join(dir, ".metistry", "state"), { recursive: true });
  await writeFile(join(dir, ".metistry", "identity.yaml"), "name: X\n");
  return dir;
}

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

// ---- the legacy layout, which a not-yet-migrated instance is still in -----------
//
// #193 moved every path to `.metistry/`; db/migrations/0021 recorded that "a
// legacy instance keeps working unchanged until the verb runs". These are the
// tests that make that sentence true rather than hopeful.

describe("LEGACY_INSTANCE_LAYOUT", () => {
  it("spells every key the pre-2026-09-17 way", () => {
    expect(LEGACY_INSTANCE_LAYOUT.metistryDir).toBe(""); // there was no enclosing directory
    expect(LEGACY_INSTANCE_LAYOUT.stateDir).toBe("state");
    expect(LEGACY_INSTANCE_LAYOUT.identity).toBe("identity.yaml");
    expect(LEGACY_INSTANCE_LAYOUT.rules).toBe("rules.yaml");
    expect(LEGACY_INSTANCE_LAYOUT.compute).toBe("compute.yaml");
    expect(LEGACY_INSTANCE_LAYOUT.deployment).toBe("deployment.yaml");
    expect(LEGACY_INSTANCE_LAYOUT.lock).toBe("metistry.lock");
    expect(LEGACY_INSTANCE_LAYOUT.queriesDir).toBe("queries");
    expect(LEGACY_INSTANCE_LAYOUT.inboxDir).toBe("Knowledge/Inbox");
    expect(LEGACY_INSTANCE_LAYOUT.artifactsDir).toBe("Artifacts");
    expect(LEGACY_INSTANCE_LAYOUT.assistantInstructions).toBe("CLAUDE.md");
  });

  it("covers exactly the keys the flat layout has — a reader can switch tables blind", () => {
    expect(Object.keys(LEGACY_INSTANCE_LAYOUT).sort()).toEqual(Object.keys(INSTANCE_LAYOUT).sort());
  });

  it("is frozen", () => {
    expect(Object.isFrozen(LEGACY_INSTANCE_LAYOUT)).toBe(true);
  });
});

describe("resolveInstanceLayout", () => {
  it("reads a legacy instance's own spelling", async () => {
    const dir = await legacyInstance();
    const r = resolveInstanceLayout(dir);
    expect(r.shape).toBe("legacy");
    expect(r.path("identity")).toBe(join(dir, "identity.yaml"));
    expect(r.path("compute")).toBe(join(dir, "compute.yaml"));
    expect(r.path("lock")).toBe(join(dir, "metistry.lock"));
    expect(r.path("inboxDir")).toBe(join(dir, "Knowledge", "Inbox"));
    expect(r.state(".env")).toBe(join(dir, "state", ".env"));
    expect(r.state()).toBe(join(dir, "state"));
  });

  it("reads a flat instance's", async () => {
    const dir = await flatInstance();
    const r = resolveInstanceLayout(dir);
    expect(r.shape).toBe("flat");
    expect(r.path("identity")).toBe(join(dir, ".metistry", "identity.yaml"));
    expect(r.state(".env")).toBe(join(dir, ".metistry", "state", ".env"));
  });

  it("resolves an unstamped directory to the flat table — that is the one `metistry init` writes", async () => {
    const dir = await tmp();
    const r = resolveInstanceLayout(dir);
    expect(r.shape).toBe("unknown");
    expect(r.layout).toBe(INSTANCE_LAYOUT);
    expect(r.path("identity")).toBe(join(dir, ".metistry", "identity.yaml"));
  });

  it("normalises trailing slashes and takes the same `exists` seam detectLayout does", () => {
    const r = resolveInstanceLayout("/i///", (p) => p === "/i/identity.yaml");
    expect(r.shape).toBe("legacy");
    expect(r.path("identity")).toBe("/i/identity.yaml");
    expect(r.path("metistryDir")).toBe("/i"); // the legacy machinery directory IS the instance root
  });
});

describe("instanceFile / instanceStatePath", () => {
  it("read through the resolved shape where instancePath/statePath spell the flat one", async () => {
    const legacy = await legacyInstance();
    expect(instanceFile(legacy, "identity")).toBe(join(legacy, "identity.yaml"));
    expect(instanceStatePath(legacy, ".env")).toBe(join(legacy, "state", ".env"));
    // the writers are unchanged: they stamp and move ONTO the flat layout
    expect(instancePath(legacy, "identity")).toBe(join(legacy, ".metistry", "identity.yaml"));
    expect(statePath(legacy, ".env")).toBe(join(legacy, ".metistry", "state", ".env"));

    const flat = await flatInstance();
    expect(instanceFile(flat, "identity")).toBe(instancePath(flat, "identity"));
    expect(instanceStatePath(flat, ".env")).toBe(statePath(flat, ".env"));
  });
});

describe("isProtectedPath on a legacy instance (invariant 2)", () => {
  it("protects the machinery at the instance root, where a legacy instance still keeps it", () => {
    for (const p of [
      "identity.yaml",
      "rules.yaml",
      "compute.yaml",
      "deployment.yaml",
      "instances.yaml",
      "sources.yaml",
      "assistant-prompt.md",
      "metistry.lock",
      "queries",
      "queries/board.yaml",
      "agents/fsl/scout.md",
      "routines/x/manifest.yaml",
      "targets/x/manifest.yaml",
      "extensions/x",
      "instance-migrations/0001.sql",
      "eval/fixtures/a.json",
    ]) {
      expect(isProtectedPath(p), p).toBe(true);
    }
    expect(LEGACY_MACHINERY_ROOTS.every((n) => isProtectedPath(n))).toBe(true);
  });

  it("still leaves the legacy vault free — Knowledge/ is knowledge, not machinery", () => {
    for (const p of ["Knowledge/now.md", "Knowledge/Journal/2026-09-17.md", "Knowledge/Inbox/capture.md", "Knowledge/identity.yaml"]) {
      expect(isProtectedPath(p), p).toBe(false);
    }
  });

  it("does not protect the legacy state/ — derived, gitignored, nobody's record (invariant 1)", () => {
    expect(isProtectedPath("state/.env")).toBe(false);
    expect(isProtectedPath("state/pg/PG_VERSION")).toBe(false);
  });
});

describe("isVaultPath on a legacy instance", () => {
  it("is false for the machinery and the derived state at the instance root", () => {
    for (const p of [
      "identity.yaml",
      "rules.yaml",
      "compute.yaml",
      "deployment.yaml",
      "instances.yaml",
      "sources.yaml",
      "assistant-prompt.md",
      "metistry.lock",
      "queries/board.yaml",
      "agents/fsl/scout.md",
      "routines/x/manifest.yaml",
      "targets/x/manifest.yaml",
      "extensions/x/manifest.yaml",
      "instance-migrations/0001.sql",
      "eval/transcripts/a.jsonl",
      "state",
      "state/ports.yaml",
      "state/pg/PG_VERSION",
      "state/pg/base/16384",
    ]) {
      expect(isVaultPath(p), p).toBe(false);
    }
  });

  it("is true for the legacy vault — that prefix IS the notes", () => {
    for (const p of ["Knowledge/now.md", "Knowledge/Journal/2026-09-17.md", "Knowledge/Inbox/capture.md", "Knowledge/CLAUDE.md"]) {
      expect(isVaultPath(p), p).toBe(true);
    }
  });
});
