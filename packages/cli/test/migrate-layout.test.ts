// `metistry migrate-layout` against a fixture instance repo (a real `git
// init`, real files) and the scratch database.
//
// The fixture is the LEGACY shape as `metistry init` stamped it before the
// 2026-09-17 ruling — reconstructed by hand rather than checked out of git
// history, because the point of the test is the shape, and a shape spelled
// out in one function is readable in a year; a `git show <sha>:seed/…` is not.
// docs/ops/instance-layout.md, "The legacy layout, for reference" is what it
// mirrors, plus the two things the owner's own instance actually carries: a
// gitignored root `inbox/` from before #156, and `Artifacts/` already at the
// root.
//
// What it has to get right: every move, the .gitignore, every rewritten row,
// idempotency, a dry run that touches NOTHING, and the two refusals — a dirty
// tree and a name collision at the root.
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { INSTANCE_GITIGNORE, VAULT_ROOT_AREA } from "@foldedspacelabs/metistry-core";
import { DB_REWRITES, LayoutCollision, migrateLayout, planMigration, rewriteEnvFile, rewriteEnvValue, rewriteGitignore, rewriteManifestAreas } from "../src/migrate-layout.js";

const exec = promisify(execFile);

/** A crew manifest in the shape `seed/agents/example/researcher.md` has: frontmatter, aligned comments, a flow scope, then the operating prompt. */
const CREW_FIXTURE = `---
name: analyst
type: agent
model: haiku                  # haiku | sonnet | opus
uses: [knowledge, requests]
# Read tier (§4.11): TitleCase vault prefixes.
scope: [Knowledge/Projects, Knowledge/Resources]
projects: []                  # shared-list membership (§4.19); empty = none
max_turns: 10                 # agentic turns per run
---

You are an analyst. The brief is the brief.
`;

/** A target manifest with a block allow-list, including the bare vault the old schema admitted. */
const TARGET_FIXTURE = `name: local-crew
type: target
description: the local crew target
data_policy:
  # Personal roots are absent on purpose.
  allow:
    - Knowledge/Areas         # the aligned comment must survive
    - Knowledge/Projects
    - Knowledge
  deny_sources: [comms]
  max_brief_bytes: 65536
`;

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}
const hasDb = !!process.env.METISTRY_DB_PASSWORD;

const lines: string[] = [];
const out = (l: string) => lines.push(l);
/** Nothing in this suite may probe the real launchd; `linux` skips the darwin-only branch. */
const base = { out, openSession: async () => null, platform: "linux" as NodeJS.Platform };

/**
 * An instance repo in the pre-2026-09-17 layout: `Knowledge/` holds the vault
 * (captures included), the config half sits at the root beside it, `state/`
 * and `inbox/` are gitignored.
 */
async function legacyInstance(extra: (dir: string) => Promise<void> = async () => {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-layout-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir };
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir, env });

  await mkdir(join(dir, "Knowledge", "Journal"), { recursive: true });
  await mkdir(join(dir, "Knowledge", "Me"), { recursive: true });
  await mkdir(join(dir, "Knowledge", "Inbox"), { recursive: true });
  await mkdir(join(dir, "Knowledge", ".obsidian"), { recursive: true });
  await writeFile(join(dir, "Knowledge", "now.md"), "# Now\n");
  await writeFile(join(dir, "Knowledge", "CLAUDE.md"), "# The assistant's operating instructions\n");
  await writeFile(join(dir, "Knowledge", "Journal", "2026-09-01.md"), "# a day\n");
  await writeFile(join(dir, "Knowledge", "Me", "profile.md"), "# me\n");
  await writeFile(join(dir, "Knowledge", "Inbox", "1757000000000-capture.md"), "# a capture\n");
  await writeFile(join(dir, "Knowledge", ".obsidian", "app.json"), "{}\n");

  await mkdir(join(dir, "Artifacts"), { recursive: true });
  await writeFile(join(dir, "Artifacts", "README.md"), "# artifacts\n");
  for (const f of ["identity.yaml", "rules.yaml", "compute.yaml", "deployment.yaml", "instances.yaml", "metistry.lock"]) {
    await writeFile(join(dir, f), `# ${f}\n`);
  }
  for (const d of ["agents", "routines", "queries", "extensions", "instance-migrations", "targets"]) {
    await mkdir(join(dir, d), { recursive: true });
    await writeFile(join(dir, d, ".gitkeep"), "");
  }
  // A crew and a target that name vault prefixes, both hand-written and
  // column-aligned exactly the way the seed copies are: the rewrite has to
  // come back byte-identical apart from the prefixes themselves.
  await mkdir(join(dir, "agents", "research"), { recursive: true });
  await writeFile(join(dir, "agents", "research", "analyst.md"), CREW_FIXTURE);
  await mkdir(join(dir, "targets", "local-crew"), { recursive: true });
  await writeFile(join(dir, "targets", "local-crew", "manifest.yaml"), TARGET_FIXTURE);
  // The bake-off's fixtures and transcripts (docs/poc/poc18-bakeoff).
  await mkdir(join(dir, "eval"), { recursive: true });
  await writeFile(join(dir, "eval", "fixtures-harvest.jsonl"), '{"draft":true}\n');
  await writeFile(join(dir, "README.md"), "# Instance repo\n");
  // Verbatim the shape a real legacy instance has (the owner's own carries
  // exactly these three lines). The unanchored `inbox/` is load-bearing for
  // the test below: see the note on `extra`.
  await writeFile(join(dir, ".gitignore"), "state/\ninbox/\n.obsidian/workspace*\n");

  // `extra` runs BEFORE the commit, so whatever a test sets up is part of the
  // committed baseline and the tree is clean on EITHER filesystem.
  //
  // It used to run after, and that was a platform bug the Linux CI caught.
  // `git init` sets `core.ignorecase=true` on a case-insensitive filesystem,
  // which case-folds `.gitignore` matching too — so on macOS the legacy
  // `inbox/` line also matches `Knowledge/Inbox/`, and the vault inbox is
  // never committed at all. On Linux (and on a case-sensitive APFS volume)
  // it IS committed, so a test that removed it after the commit left
  // ` D Knowledge/Inbox/…` behind and the verb refused the dirty tree —
  // correctly, and only on one of the two platforms.
  await extra(dir);

  await exec("git", ["add", "-A"], { cwd: dir, env });
  await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"], { cwd: dir, env });

  // Held here rather than discovered forty lines later inside the verb: a
  // fixture that hands out a dirty tree makes every migrate-layout test fail
  // with the preflight refusal instead of whatever it was actually asserting.
  const status = await exec("git", ["status", "--porcelain"], { cwd: dir, env });
  if (status.stdout.trim() !== "") throw new Error(`legacyInstance left an uncommitted tree:\n${status.stdout}`);

  // the gitignored half, after the commit — it is derived state, and the
  // instance's `.gitignore` keeps it out of the index on both filesystems
  await mkdir(join(dir, "state"), { recursive: true });
  await writeFile(join(dir, "state", ".env"), "METISTRY_INSTANCE_DIR=" + dir + "\nMETISTRY_RULES_FILES=seed/rules.yaml:rules.yaml\n");
  return dir;
}

const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args], { env: { ...process.env, HOME: dir } });

describe("planMigration", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  const fixture = async (...a: Parameters<typeof legacyInstance>) => {
    const d = await legacyInstance(...a);
    dirs.push(d);
    return d;
  };

  it("reads the whole migration off disk before anything moves", async () => {
    const dir = await fixture();
    const plan = await planMigration(dir);
    expect(plan.layout).toBe("legacy");
    expect(plan.vaultDir).toBe("Knowledge");
    const moves = Object.fromEntries(plan.moves.map((m) => [m.from, m.to]));
    expect(moves["identity.yaml"]).toBe(".metistry/identity.yaml");
    expect(moves["instances.yaml"]).toBe(".metistry/instances.yaml");
    expect(moves["targets"]).toBe(".metistry/targets");
    expect(moves["state"]).toBe(".metistry/state");
    expect(moves["eval"]).toBe(".metistry/eval");
    expect(moves["Knowledge/CLAUDE.md"]).toBe("CLAUDE.md");
    expect(moves["Knowledge/.obsidian"]).toBe(".obsidian");
    expect(moves["Knowledge/Inbox"]).toBe("Inbox");
    // `Artifacts/` and `README.md` were already at the root and are not touched
    expect(plan.moves.some((m) => m.from === "Artifacts" || m.from === "README.md")).toBe(false);
  });

  it("refuses a name collision with an existing root entry, naming both sides", async () => {
    const dir = await fixture(async (d) => {
      await mkdir(join(d, "Journal"), { recursive: true }); // already at the root somehow
    });
    await expect(planMigration(dir)).rejects.toThrow(LayoutCollision);
    await expect(planMigration(dir)).rejects.toThrow(/Knowledge\/Journal → Journal/);
    expect(existsSync(join(dir, "Knowledge", "Journal"))).toBe(true); // nothing moved
  });

  it("a flat instance plans nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-flat-"));
    dirs.push(dir);
    await mkdir(join(dir, ".metistry"), { recursive: true });
    await writeFile(join(dir, ".metistry", "identity.yaml"), "name: Seed\n");
    const plan = await planMigration(dir);
    expect(plan).toMatchObject({ layout: "flat", moves: [] });
  });
});

describe("migrate-layout (fixture instance repo)", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  const fixture = async (...a: Parameters<typeof legacyInstance>) => {
    const d = await legacyInstance(...a);
    dirs.push(d);
    return d;
  };

  it("moves the whole tree, rewrites .gitignore and commits once", async () => {
    const dir = await fixture(async (d) => {
      await mkdir(join(d, "inbox"), { recursive: true }); // the pre-#156 root inbox
      await writeFile(join(d, "inbox", "1757000000001-old.md"), "# older capture\n");
    });
    const r = await migrateLayout({ instanceDir: dir, ...base });

    expect(r).toMatchObject({ code: 0, layout: "legacy", alreadyFlat: false, gitignore: "updated", committed: true, database: false });

    // the config half, under one dot-folder
    expect((await readdir(join(dir, ".metistry"))).sort()).toEqual([
      "agents", "compute.yaml", "deployment.yaml", "eval", "extensions", "identity.yaml", "instance-migrations",
      "instances.yaml", "metistry.lock", "queries", "routines", "rules.yaml", "state", "targets",
    ]);
    expect(await readFile(join(dir, ".metistry", "state", ".env"), "utf8")).toContain("METISTRY_RULES_FILES=seed/rules.yaml:.metistry/rules.yaml");

    // the vault, at the root — Knowledge/ gone
    expect(existsSync(join(dir, "Knowledge"))).toBe(false);
    expect(await readFile(join(dir, "now.md"), "utf8")).toBe("# Now\n");
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe("# The assistant's operating instructions\n");
    expect(await readFile(join(dir, "Journal", "2026-09-01.md"), "utf8")).toBe("# a day\n");
    expect(await readFile(join(dir, ".obsidian", "app.json"), "utf8")).toBe("{}\n");
    // both inboxes merged into the one `Inbox/`
    expect((await readdir(join(dir, "Inbox"))).sort()).toEqual(["1757000000000-capture.md", "1757000000001-old.md"]);
    // exactly one, canonically spelled — `existsSync("inbox")` would answer
    // true for `Inbox/` on macOS, so the real directory entries are the check
    expect((await readdir(dir)).filter((e) => e.toLowerCase() === "inbox")).toEqual(["Inbox"]);

    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(INSTANCE_GITIGNORE);

    const log = await git(dir, "log", "--oneline");
    expect(log.stdout).toContain("Migrate to the flat instance layout");
    const tracked = await git(dir, "ls-files");
    expect(tracked.stdout).toContain(".metistry/identity.yaml");
    expect(tracked.stdout).toContain("Journal/2026-09-01.md");
    expect(tracked.stdout).not.toContain("Knowledge/");
    expect(tracked.stdout).not.toContain(".metistry/state/"); // gitignored, and stayed that way
    // git followed the content rather than recording delete+add
    const status = await git(dir, "status", "--porcelain");
    expect(status.stdout.trim()).toBe("");
  });

  it("is idempotent: the second run says the instance is already flat and changes nothing", async () => {
    const dir = await fixture();
    await migrateLayout({ instanceDir: dir, ...base });
    const before = await git(dir, "rev-parse", "HEAD");
    const again = await migrateLayout({ instanceDir: dir, ...base });
    expect(again).toMatchObject({ alreadyFlat: true, layout: "flat", moves: [], committed: false });
    expect((await git(dir, "rev-parse", "HEAD")).stdout).toBe(before.stdout);
  });

  it("--dry-run prints every move and leaves the instance exactly as it was", async () => {
    const dir = await fixture();
    const sha = (await git(dir, "rev-parse", "HEAD")).stdout;
    const r = await migrateLayout({ instanceDir: dir, ...base, dryRun: true });

    expect(r.moves.map((m) => `${m.from} → ${m.to}`)).toEqual(
      expect.arrayContaining(["identity.yaml → .metistry/identity.yaml", "state → .metistry/state", "Knowledge/now.md → now.md", "Knowledge/CLAUDE.md → CLAUDE.md"]),
    );
    // the plan says `git mv` for what git tracks even in a dry run
    expect(r.commands).toContain("git -C " + dir + " mv identity.yaml .metistry/identity.yaml");
    expect(r.commands.some((c) => c.startsWith("move state → "))).toBe(true); // gitignored: a plain move

    expect(existsSync(join(dir, ".metistry"))).toBe(false);
    expect(await readFile(join(dir, "Knowledge", "now.md"), "utf8")).toBe("# Now\n");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("state/\ninbox/\n.obsidian/workspace*\n");
    expect((await git(dir, "rev-parse", "HEAD")).stdout).toBe(sha);
    expect((await git(dir, "status", "--porcelain")).stdout.trim()).toBe("");
  });

  it("refuses a dirty tree by default and proceeds with --allow-dirty", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "Knowledge", "now.md"), "# edited, uncommitted\n");
    await expect(migrateLayout({ instanceDir: dir, ...base })).rejects.toThrow(/uncommitted changes/);
    expect(existsSync(join(dir, "Knowledge"))).toBe(true); // untouched

    const r = await migrateLayout({ instanceDir: dir, ...base, allowDirty: true });
    expect(r.code).toBe(0);
    expect(await readFile(join(dir, "now.md"), "utf8")).toBe("# edited, uncommitted\n");
  });

  it("refuses a root collision before anything moves", async () => {
    const dir = await fixture(async (d) => {
      await writeFile(join(d, "now.md"), "# a root now.md that is not the vault's\n");
    });
    await expect(migrateLayout({ instanceDir: dir, ...base })).rejects.toThrow(/name collision/);
    expect(existsSync(join(dir, ".metistry"))).toBe(false);
    expect(await readFile(join(dir, "Knowledge", "now.md"), "utf8")).toBe("# Now\n");
  });

  // The two-step rename is only NEEDED on a case-insensitive filesystem —
  // `git mv inbox Inbox` there moves the directory inside itself — but it has
  // to be CORRECT on both, and CI runs on Linux. This asserts the end state
  // and the temp hop on either, and it asserts the filesystem it is actually
  // running on rather than assuming macOS, so a failure names which one.
  it("renames a lowercase root inbox/ through a temp name, on either kind of filesystem", async () => {
    const dir = await fixture(async (d) => {
      await rm(join(d, "Knowledge", "Inbox"), { recursive: true, force: true });
      await mkdir(join(d, "inbox"), { recursive: true });
      await writeFile(join(d, "inbox", "1757000000002-lower.md"), "# lowercase\n");
    });
    const caseInsensitive = existsSync(join(dir, "knowledge"));
    const r = await migrateLayout({ instanceDir: dir, ...base });

    expect(r.moves).toContainEqual({ from: "inbox", to: "Inbox", via: "rename" });
    expect(r.commands.some((c) => c.includes("Inbox-migrating"))).toBe(true);
    // the real directory entries: `existsSync("inbox")` answers true for
    // `Inbox/` on a case-insensitive disk, so it proves nothing here
    expect((await readdir(dir)).filter((e) => e.toLowerCase() === "inbox"), `filesystem is ${caseInsensitive ? "case-insensitive" : "case-sensitive"}`).toEqual(["Inbox"]);
    expect(await readFile(join(dir, "Inbox", "1757000000002-lower.md"), "utf8")).toBe("# lowercase\n");
    // and the migration still ends clean — the temp name is never left behind
    expect((await git(dir, "status", "--porcelain")).stdout.trim()).toBe("");
    expect((await readdir(dir)).some((e) => e.includes("-migrating"))).toBe(false);
  });

  it("refuses a directory that is not a git repository, and one that is not an instance", async () => {
    const plain = await mkdtemp(join(tmpdir(), "metistry-notrepo-"));
    dirs.push(plain);
    await expect(migrateLayout({ instanceDir: plain, ...base })).rejects.toThrow(/not a git repository/);
    await exec("git", ["init", "-q", "-b", "main"], { cwd: plain, env: { ...process.env, HOME: plain } });
    await expect(migrateLayout({ instanceDir: plain, ...base })).rejects.toThrow(/not an instance directory/);
  });
});

describe("manifests: the scopes the database grant would otherwise be undone by", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("rewrites a crew scope and a target allow-list, and changes NOTHING else in either file", async () => {
    const dir = await legacyInstance();
    dirs.push(dir);
    const r = await migrateLayout({ instanceDir: dir, ...base });

    expect(r.manifests.map((m) => m.file).sort()).toEqual([".metistry/agents/research/analyst.md", ".metistry/targets/local-crew/manifest.yaml"]);
    expect(r.manifests.find((m) => m.file.endsWith("analyst.md"))?.changed).toEqual(["Knowledge/Projects → Projects", "Knowledge/Resources → Resources"]);

    const crew = await readFile(join(dir, ".metistry", "agents", "research", "analyst.md"), "utf8");
    // one changed line, and the aligned comments, the flow style, the blank
    // line and the operating prompt all byte-identical
    expect(crew).toBe(CREW_FIXTURE.replace("scope: [Knowledge/Projects, Knowledge/Resources]", "scope: [Projects, Resources]"));

    const target = await readFile(join(dir, ".metistry", "targets", "local-crew", "manifest.yaml"), "utf8");
    expect(target).toBe(
      TARGET_FIXTURE.replace("    - Knowledge/Areas         #", "    - Areas         #").replace("    - Knowledge/Projects\n", "    - Projects\n"),
    );
    // the bare vault is LEFT, because neither schema has a flat spelling for
    // it — writing `/` there would fail validation and revoke the crew's row
    expect(target).toContain("    - Knowledge\n");
    expect(r.warnings.some((w) => w.includes("means the whole vault"))).toBe(true);
  });

  it("is idempotent, and a manifest with nothing to change is not rewritten at all", async () => {
    const dir = await legacyInstance();
    dirs.push(dir);
    await migrateLayout({ instanceDir: dir, ...base });
    const crewPath = join(dir, ".metistry", "agents", "research", "analyst.md");
    const after = await readFile(crewPath, "utf8");
    const r2 = await migrateLayout({ instanceDir: dir, ...base });
    expect(r2.alreadyFlat).toBe(true);
    expect(await readFile(crewPath, "utf8")).toBe(after);
    // and the pure function itself: a flat manifest comes back identical
    expect(rewriteManifestAreas(after)).toMatchObject({ text: after, changed: [] });
  });

  it("a dry run reports the rewrites and writes none", async () => {
    const dir = await legacyInstance();
    dirs.push(dir);
    const r = await migrateLayout({ instanceDir: dir, ...base, dryRun: true });
    expect(r.manifests).toHaveLength(2);
    // still at the legacy path, still legacy-spelled
    expect(await readFile(join(dir, "agents", "research", "analyst.md"), "utf8")).toBe(CREW_FIXTURE);
  });

  it("leaves a malformed manifest alone and says so rather than failing the migration", () => {
    const r = rewriteManifestAreas("---\nscope: [unclosed\n---\nbody\n");
    expect(r.changed).toEqual([]);
    expect(r.warnings[0]).toMatch(/YAML errors|not YAML/);
  });
});

describe("the casing warning: what becomes vault content", () => {
  it("names every lowercase root entry the reconciler will index after the move", async () => {
    const dir = await legacyInstance(async (d) => {
      await mkdir(join(d, "scratch"), { recursive: true });
      await writeFile(join(d, "scratch", "x.txt"), "x\n");
      await writeFile(join(d, "notes.md"), "# loose\n");
    });
    try {
      const plan = await planMigration(dir);
      // `eval/` is NOT here: it moves under .metistry/ and so never becomes
      // vault content. The two that stay at the root are.
      expect(plan.lowercaseVaultRoots).toEqual(["notes.md", "scratch"]);
      const r = await migrateLayout({ instanceDir: dir, ...base, dryRun: true });
      expect(r.warnings.some((w) => w.includes("scratch") && w.includes("TitleCase"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says nothing when the vault root is already all TitleCase", async () => {
    const dir = await legacyInstance();
    try {
      expect((await planMigration(dir)).lowercaseVaultRoots).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe(".gitignore", () => {
  it("is core's set for the flat layout, with every hand-added line kept", () => {
    expect(rewriteGitignore("state/\ninbox/\n.obsidian/workspace*\n")).toBe(INSTANCE_GITIGNORE);
    expect(rewriteGitignore("state/\nKnowledge/Inbox/.large/\n")).toBe(INSTANCE_GITIGNORE);
    expect(rewriteGitignore(INSTANCE_GITIGNORE)).toBe(INSTANCE_GITIGNORE); // idempotent
    const kept = rewriteGitignore("state/\n\n# mine\n*.tmp\n/scratch/\n");
    expect(kept).toContain("# mine");
    expect(kept).toContain("*.tmp");
    expect(kept).toContain("/scratch/");
    expect(kept.startsWith(".metistry/state/\n")).toBe(true);
  });
});

describe("state/.env", () => {
  const dir = "/Users/you/instance";
  it("rewrites the overlays that spelled a legacy path", () => {
    expect(rewriteEnvValue("METISTRY_RULES_FILES", "seed/rules.yaml:rules.yaml", dir).value).toBe("seed/rules.yaml:.metistry/rules.yaml");
    expect(rewriteEnvValue("METISTRY_COMPUTE_FILES", `seed/compute.yaml:${dir}/compute.yaml`, dir).value).toBe(`seed/compute.yaml:${dir}/.metistry/compute.yaml`);
    expect(rewriteEnvValue("METISTRY_INBOX_DIR", `${dir}/Knowledge/Inbox`, dir).value).toBe(`${dir}/Inbox`);
    expect(rewriteEnvValue("METISTRY_ASSISTANT_AREAS", "Knowledge/Areas,Knowledge/Me", dir).value).toBe("Areas,Me");
    // the old whole-vault sentinel becomes the one core defines
    expect(rewriteEnvValue("METISTRY_ASSISTANT_AREAS", "Knowledge/", dir).value).toBe(VAULT_ROOT_AREA);
  });

  it("leaves alone what it cannot tell apart, and says so", () => {
    // the instance dir itself is what everything is relative TO
    expect(rewriteEnvValue("METISTRY_INSTANCE_DIR", dir, dir).value).toBe(dir);
    // a URL is not a path list
    expect(rewriteEnvValue("METISTRY_RECONCILER_URL", "http://127.0.0.1:7812", dir).value).toBe("http://127.0.0.1:7812");
    // `targets` alone is the PRODUCT checkout's directory, not the instance's
    const t = rewriteEnvValue("METISTRY_TARGETS_DIRS", "targets", dir);
    expect(t.value).toBe("targets");
    expect(t.warnings[0]).toContain(".metistry/targets");
  });

  it("rewrites a file in place, touching only the lines that change", () => {
    const before = `# a comment\nMETISTRY_INSTANCE_DIR=${dir}\nexport METISTRY_RULES_FILES="seed/rules.yaml:rules.yaml"\nOTHER=1\n`;
    const r = rewriteEnvFile(before, dir);
    expect(r.changed).toEqual([{ key: "METISTRY_RULES_FILES", from: "seed/rules.yaml:rules.yaml", to: "seed/rules.yaml:.metistry/rules.yaml" }]);
    expect(r.text).toContain("# a comment");
    expect(r.text).toContain("OTHER=1");
    expect(r.text).toContain(`export METISTRY_RULES_FILES="seed/rules.yaml:.metistry/rules.yaml"`);
  });
});

// The rewrites below run against the shared scratch database, where other
// suites hold rows in the same tables at the same time. So every row this
// suite inserts carries a token no other run can collide with, every
// assertion filters to it, and cleanup is a scoped DELETE in `afterAll` —
// never a TRUNCATE, which would take other suites' rows with it.
describe.skipIf(!hasDb)("stored paths, against the scratch db", () => {
  let pool: pg.Pool;
  const token = `mig-layout-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dirs: string[] = [];

  beforeAll(() => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      user: process.env.METISTRY_DB_USER ?? "metistry",
      password: process.env.METISTRY_DB_PASSWORD,
      max: 2,
    });
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM inbox WHERE source = $1`, [token]).catch(() => {});
    await pool.query(`DELETE FROM knowledge_files WHERE path LIKE $1`, [`%${token}%`]).catch(() => {});
    await pool.query(`DELETE FROM knowledge_links WHERE from_path LIKE $1`, [`%${token}%`]).catch(() => {});
    await pool.query(`DELETE FROM embeddings WHERE path LIKE $1`, [`%${token}%`]).catch(() => {});
    await pool.query(`DELETE FROM agents WHERE id = $1`, [`mig-${token}`.slice(0, 40)]).catch(() => {});
    await pool.query(`DELETE FROM projects WHERE id = $1`, [`mig-${token}`.slice(0, 40)]).catch(() => {});
    await pool.end();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  const agentId = () => `mig-${token}`.slice(0, 40);
  const openOn = (client: pg.PoolClient) => async () => ({ query: (t: string, v?: unknown[]) => client.query(t, v as never), end: async () => client.release() });

  const seed = async () => {
    await pool.query(`INSERT INTO knowledge_files (path) VALUES ($1), ($2)`, [`Knowledge/Areas/${token}.md`, `Knowledge/Inbox/${token}.md`]);
    await pool.query(`INSERT INTO knowledge_links (from_path, to_path) VALUES ($1, $2)`, [`Knowledge/Areas/${token}.md`, `Knowledge/Me/${token}.md`]);
    await pool.query(`INSERT INTO embeddings (path, chunk_index, content, model, dim, embedding, content_hash) VALUES ($1, 0, 'x', 'test', 768, $2, $3)`, [
      `Knowledge/Areas/${token}.md`,
      `[${Array(768).fill(0).join(",")}]`,
      "f".repeat(64),
    ]);
    await pool.query(`INSERT INTO inbox (source, path, sha256) VALUES ($1, $2, $3), ($1, $4, $5), ($1, $6, $7)`, [
      token,
      `${token}-bare.md`,
      "a".repeat(64),
      `Knowledge/Inbox/${token}-vault.md`,
      "b".repeat(64),
      `Knowledge/inbox/${token}-lower.md`,
      "c".repeat(64),
    ]);
    await pool.query(`INSERT INTO agents (id, display_name, token_hash, grants) VALUES ($1, 'mig', $2, $3::jsonb)`, [
      agentId(),
      `${token}-hash`,
      JSON.stringify({ tier: "areas", areas: ["Knowledge/", "Knowledge/Areas/Fsl"] }),
    ]);
    await pool.query(`INSERT INTO projects (id, area) VALUES ($1, $2)`, [agentId(), "Knowledge/Areas/Fsl"]);
  };

  it("a dry run counts every row and rewrites none", async () => {
    await seed();
    const dir = await legacyInstance();
    dirs.push(dir);
    const client = await pool.connect();
    const r = await migrateLayout({ instanceDir: dir, out, platform: "linux", dryRun: true, openSession: openOn(client) });
    expect(r.database).toBe(true);
    expect(r.rows["knowledge_files.path"]).toBeGreaterThanOrEqual(2);
    expect(r.rows["agents.grants.areas"]).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query(`SELECT path FROM knowledge_files WHERE path LIKE $1`, [`%${token}%`]);
    expect(rows.every((x) => String(x.path).startsWith("Knowledge/"))).toBe(true); // untouched
  });

  it("rewrites every stored path in one transaction", async () => {
    const dir = await legacyInstance();
    dirs.push(dir);
    const client = await pool.connect();
    const r = await migrateLayout({ instanceDir: dir, out, platform: "linux", openSession: openOn(client) });
    expect(r.database).toBe(true);

    const files = await pool.query(`SELECT path FROM knowledge_files WHERE path LIKE $1 ORDER BY path`, [`%${token}%`]);
    expect(files.rows.map((x) => x.path)).toEqual([`Areas/${token}.md`, `Inbox/${token}.md`]);

    const links = await pool.query(`SELECT from_path, to_path FROM knowledge_links WHERE from_path LIKE $1`, [`%${token}%`]);
    expect(links.rows[0]).toEqual({ from_path: `Areas/${token}.md`, to_path: `Me/${token}.md` });

    const emb = await pool.query(`SELECT path FROM embeddings WHERE path LIKE $1`, [`%${token}%`]);
    expect(emb.rows[0].path).toBe(`Areas/${token}.md`);

    const captures = await pool.query(`SELECT path FROM inbox WHERE source = $1 ORDER BY path`, [token]);
    expect(captures.rows.map((x) => x.path)).toEqual([`Inbox/${token}-bare.md`, `Inbox/${token}-lower.md`, `Inbox/${token}-vault.md`]);

    const grants = await pool.query(`SELECT grants FROM agents WHERE id = $1`, [agentId()]);
    expect(grants.rows[0].grants.areas.sort()).toEqual(["/", "Areas/Fsl"]);

    const project = await pool.query(`SELECT area FROM projects WHERE id = $1`, [agentId()]);
    expect(project.rows[0].area).toBe("Areas/Fsl");
  });

  it("every rewrite is idempotent: a second pass matches nothing", async () => {
    const client = await pool.connect();
    try {
      for (const w of DB_REWRITES) {
        // `inbox.path (bare filename …)` is the one statement whose predicate
        // is not the Knowledge/ prefix — scope it to this suite's own rows so
        // another suite's legacy-shaped capture cannot be mistaken for one
        // this run failed to rewrite.
        const scoped = w.count.includes("FROM inbox") ? `${w.count} AND source = '${token}'` : w.count.includes("FROM agents") || w.count.includes("FROM projects") ? `${w.count} AND id = '${agentId()}'` : `${w.count} AND ${w.count.includes("from_path") ? "from_path" : w.count.match(/WHERE (\w+)/)?.[1] ?? "path"} LIKE '%${token}%'`;
        const res = await client.query(scoped);
        expect(res.rows[0].n, w.name).toBe(0);
      }
    } finally {
      client.release();
    }
  });
});
