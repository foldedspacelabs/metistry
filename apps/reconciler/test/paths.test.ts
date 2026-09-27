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
import { INSTANCE_CONFIG_DIRS, INSTANCE_LAYOUT, LEGACY_MACHINERY_ROOTS, PROTECTED_ROOT_FILES } from "@foldedspacelabs/metistry-core";
import { CALLER_AUTHORITY, SECTION_WRITERS, confine, isDailyNotePath, isProtected, isProtectedFromRemote, mayClaim, parseVaultPath, sectionWriteAllowed, writeAllowed } from "../src/paths.js";
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
      expect(writeAllowed(p, "assistant", "owner"), p).toBe(false);
      expect(writeAllowed(p, "user", "owner"), p).toBe(true);
      expect(writeAllowed(p, "user", "console"), p).toBe(false);
    }
  });

  it("leaves the legacy vault free — Knowledge/ is where the assistant works", () => {
    for (const p of ["Knowledge/now.md", "Knowledge/Journal/2026-09-01.md", "Knowledge/Inbox/capture.md"]) {
      expect(isProtected(p), p).toBe(false);
      expect(writeAllowed(p, "assistant", "console"), p).toBe(true);
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
      expect(writeAllowed(p, "assistant", "owner"), p).toBe(false);
      expect(writeAllowed(p, "user", "owner"), p).toBe(true);
    }
    // a note that merely shares a name with a protected file is vault content
    expect(isProtected("Areas/identity.yaml")).toBe(false);
    expect(isProtected("Areas/CLAUDE.md")).toBe(false);
    expect(writeAllowed("Areas/Alpha.md", "assistant", "console")).toBe(true);
  });

  // The 2026-09-20 ruling, as a unit: `principal: user` is a CLAIM, and a
  // claim is worth exactly what the credential behind it is worth.
  it("a console bearer claiming `user` reaches no protected path but its three doors", () => {
    for (const p of [
      ".metistry/identity.yaml",
      ".metistry/rules.yaml",
      ".metistry/deployment.yaml",
      ".metistry/metistry.lock",
      ".metistry/queries/knowledge_pages.yaml",
      ".metistry/agents/a/manifest.yaml",
      // M15: installing an extension is the owner's hand — the console can never
      // add a unit the product will load (plan §2.7)
      ".metistry/extensions/e/manifest.yaml",
      "CLAUDE.md",
      "README.md",
    ]) {
      expect(writeAllowed(p, "user", "console"), p).toBe(false);
      expect(writeAllowed(p, "user", "owner"), p).toBe(true);
    }
    // …and the three enumerated doors: §4.10 self-modification
    // (prompt-overlay.ts), the Compute pane's two writes (compute-routes.ts),
    // and the Scheduled doors (T3-2/T3-3), each gated on the owner there.
    expect(writeAllowed(".metistry/assistant-prompt.md", "user", "console")).toBe(true);
    expect(writeAllowed(".metistry/compute.yaml", "user", "console")).toBe(true);
    expect(writeAllowed(".metistry/scheduled.yaml", "user", "console")).toBe(true);
    // still `user` even there — attribution does not move because authority did
    expect(writeAllowed(".metistry/assistant-prompt.md", "assistant", "console")).toBe(false);
    expect(writeAllowed(".metistry/compute.yaml", "assistant", "console")).toBe(false);
    expect(writeAllowed(".metistry/scheduled.yaml", "assistant", "console")).toBe(false);
    expect(writeAllowed(".metistry/scheduled.yaml", "agent-seven", "console")).toBe(false);
    // and the door is a path, not a directory: nothing beside it opens
    expect(writeAllowed(".metistry/compute.yaml.bak", "user", "console")).toBe(false);
    expect(writeAllowed(".metistry/queries/compute.yaml", "user", "console")).toBe(false);
  });

  // T3-2: `.metistry/scheduled.yaml` is the ONE protected path the ruling of
  // 2026-09-26 added to the console's doors — and adding it opened nothing
  // else. Every protected path the layout names, every config directory, the
  // root files, the legacy roots, and every near miss of the new door's
  // spelling: refused to the console, written by the owner.
  it("the console still cannot write any other protected path", () => {
    expect(CALLER_AUTHORITY.console.protectedPaths).toEqual([".metistry/assistant-prompt.md", ".metistry/compute.yaml", ".metistry/scheduled.yaml"]);
    const doors = new Set(CALLER_AUTHORITY.console.protectedPaths as readonly string[]);
    const named = Object.values(INSTANCE_LAYOUT).filter((p) => isProtected(p) && !doors.has(p));
    expect(named).toContain(".metistry/identity.yaml");
    expect(named).toContain(".metistry/secrets.yaml");
    const others = [
      ...named,
      ...INSTANCE_CONFIG_DIRS.filter((d) => d !== "instance-migrations").map((d) => `.metistry/${d}/scheduled.yaml`),
      ...PROTECTED_ROOT_FILES,
      ...LEGACY_MACHINERY_ROOTS.filter((r) => r.includes(".")),
      // near misses of the new door: another name, another place, a child of it
      ".metistry/scheduled.yml",
      ".metistry/scheduled.yaml.bak",
      ".metistry/scheduled.yaml/x",
      ".metistry/Scheduled.yaml",
      ".metistry/extensions/scheduled.yaml",
      ".metistry/routines/scheduled.yaml",
      ".metistry/connections/github.yaml",
    ];
    for (const p of others) {
      expect(isProtected(p), p).toBe(true);
      expect(writeAllowed(p, "user", "console"), p).toBe(false);
      expect(writeAllowed(p, "user", "owner"), p).toBe(true);
    }
    // a vault note that happens to be called scheduled.yaml is not the door, and not protected
    expect(isProtected("scheduled.yaml")).toBe(false);
    expect(isProtected("Areas/scheduled.yaml")).toBe(false);
  });

  it("the owner bearer may be the user and nobody else — a leaked one cannot forge an agent into history", () => {
    expect(writeAllowed("Areas/Alpha.md", "user", "owner")).toBe(true);
    expect(writeAllowed("Areas/Alpha.md", "researcher", "owner")).toBe(false);
    expect(mayClaim("owner", "user")).toBe(true);
    expect(mayClaim("owner", "assistant")).toBe(false);
    // the console IS the multiplexer: it stamps the principal from its own
    // authenticated caller, so every principal is in range for it
    expect(mayClaim("console", "user")).toBe(true);
    expect(mayClaim("console", "agent-seven")).toBe(true);
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
      expect(writeAllowed(p, "capture", "console"), p).toBe(true);
      expect(writeAllowed(p, "assistant", "console"), p).toBe(true);
    }
    // ...and the casing rule still forbids the other spelling of it
    expect(parseVaultPath("inbox/x.md")).toEqual({ ok: false, code: "invalid_request" });
  });
});

// `Me/` and the user's own journal (daily-flow-spec §5.1 D10, §6.6): not the
// §4.7 machinery, so any `principal` may still CLAIM them (`mayClaim`), but
// only `user` may WRITE them — the other half of the rule `mayKnowledge`'s
// `write` door states for `knowledge_write`, for a write that reaches the
// vault straight from a routine (`plan-tomorrow`, the fold's routine half)
// and never goes through `may()` at all.
describe("what a commit from the remote may not change (isProtectedFromRemote, ruling 2026-09-26)", () => {
  it("refuses every protected path, all of `.metistry/` including `state/`, and the case-folded spellings a macOS checkout would land on", () => {
    for (const p of [".metistry/deployment.yaml", ".metistry/rules.yaml", ".metistry/agents/x.yaml", ".metistry/state/.env", ".metistry/state/pg/x", "CLAUDE.md", "README.md", "claude.md", "Readme.md", ".Metistry/rules.yaml", ".METISTRY/state/.env", "rules.yaml", "Rules.yaml", "queries/x.yaml", "Queries/x.yaml"]) {
      expect(isProtectedFromRemote(p), p).toBe(true);
    }
  });
  it("lets the vault through", () => {
    for (const p of ["now.md", "Areas/Alpha.md", "Journal/2026-09-26.md", "Me/About.md", "Inbox/x.md", "Areas/.metistry/x", "Areas/CLAUDE.md", ".gitignore"]) {
      expect(isProtectedFromRemote(p), p).toBe(false);
    }
  });
});

describe("Me/ and the user's own journal are the owner's, whatever the caller (isUserOwnedPath)", () => {
  it("refuses every non-user principal, whichever caller class is asking", () => {
    for (const p of ["Me/New.md", "Me/profile.md", "Journal/2026-09-21.md", "Journal/Meetings/2026-09-21-standup.md"]) {
      expect(isProtected(p), p).toBe(false); // this is NOT the §4.7 machinery
      expect(writeAllowed(p, "assistant", "console"), p).toBe(false);
      expect(writeAllowed(p, "plan-tomorrow", "console"), p).toBe(false);
      expect(writeAllowed(p, "knowledge-fold", "console"), p).toBe(false);
      expect(writeAllowed(p, "user", "console"), p).toBe(true);
      expect(writeAllowed(p, "user", "owner"), p).toBe(true);
    }
  });

  it("leaves the machine-owned Journal subdirectories alone — each is its own one-writer place, and this rule is not it", () => {
    for (const p of ["Journal/Plan/2026-09-22.md", "Journal/Fold/2026-09-21.md", "Journal/Standup/2026-09-21.md"]) {
      expect(writeAllowed(p, "plan-tomorrow", "console"), p).toBe(true);
      expect(writeAllowed(p, "assistant", "console"), p).toBe(true);
    }
  });
});

// One writer per REGION (plan §2.13, T2-6): the section operation is a second,
// narrower door beside `writeAllowed`, not a hole in it.
describe("the section operation's policy (sectionWriteAllowed)", () => {
  const DAY = "Journal/2026-09-26.md";

  it("its writers are plan §2.13's two, and nobody else", () => {
    expect([...SECTION_WRITERS.day].sort()).toEqual(["morning-brief", "user"]);
    expect(sectionWriteAllowed(DAY, "day", "morning-brief", "console")).toBe(true);
    expect(sectionWriteAllowed(DAY, "day", "user", "console")).toBe(true);
    expect(sectionWriteAllowed(DAY, "day", "user", "owner")).toBe(true);
    for (const p of ["assistant", "agent-seven", "plan-tomorrow", "knowledge-fold", "standup-draft", "capture"]) {
      expect(sectionWriteAllowed(DAY, "day", p, "console"), p).toBe(false);
    }
  });

  it("the credential still bounds the claim: the owner bearer may not be the Morning Brief", () => {
    expect(sectionWriteAllowed(DAY, "day", "morning-brief", "owner")).toBe(false);
  });

  it("**a non-user principal cannot write the note any other way**: writeAllowed is unchanged for the whole file", () => {
    expect(writeAllowed(DAY, "morning-brief", "console")).toBe(false);
    expect(writeAllowed(DAY, "user", "console")).toBe(true);
  });

  it("its only home is the owner's daily note, on a real day", () => {
    for (const p of [DAY, "Journal/2024-02-29.md"]) expect(isDailyNotePath(p), p).toBe(true);
    for (const p of [
      "Journal/2026-02-30.md",
      "Journal/2025-02-29.md",
      "Journal/2026-13-01.md",
      "Journal/2026-9-26.md",
      "Journal/2026-09-26.markdown",
      "Journal/Plan/2026-09-26.md",
      "Journal/Meetings/2026-09-26-sync.md",
      "journal/2026-09-26.md",
      "Areas/Journal/2026-09-26.md",
      ".metistry/2026-09-26.md",
    ]) {
      expect(isDailyNotePath(p), p).toBe(false);
      expect(sectionWriteAllowed(p, "day", "user", "owner"), p).toBe(false);
    }
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
