// `metistry init` into a temp dir with real git: the by-hand bootstrap's
// structure, the single commit and its author, the identity name (the ONLY
// place the name lives), the non-empty refusal, the lock file, and that no
// secret is ever written into the repo.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { applyName, init, lockFile, mentionFor, INSTANCE_DIRS } from "../src/init.js";
import { readInstanceId, INSTANCE_ID_RE } from "../src/instance.js";
import { parseLock } from "../src/lock.js";
import { main } from "../src/main.js";
import { portsFile, portsOf, serializeNamespace, type Namespace } from "../src/namespace.js";

const seedDir = fileURLToPath(new URL("../../../seed/", import.meta.url));
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const fresh = () => mkdtemp(join(tmpdir(), "metistry-init-"));
const MINTED = "TEST-TOKEN-NEVER-ON-DISK";

describe("metistry init", () => {
  it("stamps the instance repo exactly like the by-hand bootstrap, in one commit authored Metistry", async () => {
    const dir = join(await fresh(), "instance");
    const r = await init({ dir, seedDir, version: "1.2.3", now: new Date("2026-09-07T12:00:00Z"), mint: () => MINTED, platform: "linux" });

    expect(r.dir).toBe(dir);
    // the vault is the directory itself: notes at the root, machinery under .metistry/
    expect(existsSync(join(dir, "now.md"))).toBe(true);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true); // the assistant's operating instructions, the user's hand
    expect(existsSync(join(dir, "Knowledge"))).toBe(false); // the legacy vault directory is gone
    expect(existsSync(join(dir, ".metistry", "identity.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".metistry", "rules.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".metistry", "compute.yaml"))).toBe(true);
    expect(existsSync(join(dir, "Inbox", "README.md"))).toBe(true); // the vault inbox, tracked (docs/ops/inbox.md)
    // (no `existsSync(join(dir, "inbox"))` check: macOS is case-insensitive, so
    // it would answer for `Inbox/`. The tracked-file list below is the real one.)
    // the daily-flow journal tree (docs/product/daily-flow-spec.md §5.1, §6.1, §6.6, ticket P1-8)
    for (const p of ["Journal/README.md", "Journal/Plan/README.md", "Journal/Fold/README.md", "Journal/Standup/README.md", "Journal/Meetings/README.md", "People/README.md", "Projects/README.md", "Resources/README.md", "Me/profile.md", "Me/Working Style.md"]) {
      expect(existsSync(join(dir, ...p.split("/"))), p).toBe(true);
    }
    for (const t of ["Daily", "Meeting", "Plan", "Standup", "Fold", "Weekly"]) {
      expect(existsSync(join(dir, "Templates", `${t}.md`)), t).toBe(true);
    }
    for (const d of INSTANCE_DIRS) expect(existsSync(join(dir, ".metistry", d, ".gitkeep")), d).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".metistry/state/\n.obsidian/workspace*\nInbox/.large/\n");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toMatch(/^# Instance repo — private\./);
    expect(readFileSync(join(dir, ".metistry", "metistry.lock"), "utf8")).toBe(lockFile("1.2.3", new Date("2026-09-07T12:00:00Z")));
    // the documented lock shape (docs/ops/cli.md) — the same one `metistry update` moves; no db at init, so no migrations recorded
    expect(parseYaml(readFileSync(join(dir, ".metistry", "metistry.lock"), "utf8"))).toEqual({
      product: { version: "1.2.3", commit: "unknown", source: "git" },
      updated_at: "2026-09-07T12:00:00.000Z",
      migrations_applied: [],
    });
    expect(parseLock(readFileSync(join(dir, ".metistry", "metistry.lock"), "utf8")).product.version).toBe("1.2.3");

    // git: branch main, exactly one commit, the stamped author, clean tree, .large/ ignored
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(dir, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%s")).toBe("Metistry <metistry@localhost>|Metistry <metistry@localhost>|Instance created");
    expect(git(dir, "rev-parse", "HEAD")).toBe(r.commit);
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "ls-files").split("\n").sort()).toEqual(
      [
        ".gitignore",
        ".metistry/compute.yaml",
        ".metistry/identity.yaml",
        ".metistry/metistry.lock",
        ".metistry/rules.yaml",
        "CLAUDE.md",
        "Inbox/README.md",
        "Journal/README.md",
        "Journal/Brief/README.md",
        "Journal/Fold/README.md",
        "Journal/Meetings/README.md",
        "Journal/Plan/README.md",
        "Journal/Standup/README.md",
        "Me/profile.md",
        "Me/Working Style.md",
        "People/README.md",
        "Projects/README.md",
        "README.md",
        "Resources/README.md",
        "Templates/Brief.md",
        "Templates/Daily.md",
        "Templates/Fold.md",
        "Templates/Meeting.md",
        "Templates/Plan.md",
        "Templates/Standup.md",
        "Templates/Weekly.md",
        "now.md",
        ...INSTANCE_DIRS.map((d) => `.metistry/${d}/.gitkeep`),
      ].sort(),
    );
    // a capture is part of the record now; only the .large/ spill is ignored
    await mkdir(join(dir, "Inbox", ".large"), { recursive: true });
    await writeFile(join(dir, "Inbox", ".large", "clip.mov"), "big");
    expect(git(dir, "status", "--porcelain")).toBe("");
    await writeFile(join(dir, "Inbox", "1757-x.md"), "capture");
    expect(git(dir, "status", "--porcelain")).toBe("?? Inbox/1757-x.md");
    await rm(join(dir, "Inbox", "1757-x.md"));

    // the seed's default name stays when --name is not given; the .env lines are returned, not written
    expect(r.assistantName).toBe((parseYaml(readFileSync(join(seedDir, "identity.yaml"), "utf8")) as { name: string }).name);
    expect(r.envLines).toEqual([
      `METISTRY_INSTANCE_DIR=${dir}`,
      `METISTRY_BRIDGE_TOKEN_RECONCILER=${MINTED}`,
      `METISTRY_BRIDGE_TOKEN_RECONCILER_USER=${MINTED}`,
      "METISTRY_RECONCILER_URL=http://host.docker.internal:7812",
      "METISTRY_ORIGIN=http://127.0.0.1:8080", // required to start in either shape (apps/console/src/main.ts requireEnv)
      `METISTRY_LOCAL_OWNER_TOKEN=${MINTED}`, // the console's local owner door (docs/ops/auth.md)
    ]);
    for (const f of git(dir, "ls-files").split("\n")) expect(readFileSync(join(dir, f), "utf8"), f).not.toContain(MINTED);

    // an instance directory is self-contained: it is minted with its own id,
    // which is the Keychain account its secrets are filed under, and `state/`
    // (Postgres data, the assistant's transcripts, the generated .env) is
    // gitignored so none of it can ever be committed
    expect(r.instanceId).toMatch(INSTANCE_ID_RE);
    expect(await readInstanceId(dir)).toBe(r.instanceId);
    expect(readFileSync(join(dir, ".metistry", "identity.yaml"), "utf8")).toContain(`instance_id: "${r.instanceId}"`);
    await writeFile(join(dir, "state.txt"), "not the dir"); // only `state/` is ignored
    await mkdir(join(dir, ".metistry", "state"), { recursive: true });
    await mkdir(join(dir, ".metistry"), { recursive: true });
    await writeFile(join(dir, ".metistry", "state", ".env"), "METISTRY_DB_PASSWORD=secret");
    expect(git(dir, "status", "--porcelain")).toBe("?? state.txt");
  });

  it("the six templates use only the §6.2 directive grammar's verbs, and all six stay source: user (P1-8)", async () => {
    const dir = join(await fresh(), "instance");
    await init({ dir, seedDir, version: "0.0.1", mint: () => MINTED });
    const ALLOWED_VERBS = new Set(["date", "tasks", "recurring", "calendar", "work", "requests", "include", "prose", "section", "/section"]);
    for (const name of ["Daily", "Meeting", "Plan", "Standup", "Fold", "Weekly"]) {
      const text = readFileSync(join(dir, "Templates", `${name}.md`), "utf8");
      const fm = parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(text)![1]!) as { source: string; type: string; tags: string[] };
      // §6.1: the seeded templates ship `source: user` so `ownershipRefusal`
      // refuses any assistant write to them, always — none is machine-owned.
      expect(fm.source, name).toBe("user");
      expect(fm.type, name).toBe("resource"); // §13.8: no frozen `template` frontmatter type yet
      expect(fm.tags, name).toEqual(["template"]);
      for (const m of text.matchAll(/\{\{\s*([a-z/]+)\b/g)) {
        expect(ALLOWED_VERBS.has(m[1]!), `${name}: unknown directive verb "${m[1]}"`).toBe(true);
      }
      // §6.3: `prose` reaches a model and is legal only in a template whose
      // output the assistant may write — in practice, the fold's alone.
      if (name !== "Fold") expect(text, name).not.toMatch(/\{\{\s*prose\b/);
    }
  });

  it("re-running init (--force) never overwrites a template or a Me/ page the user has since edited, and still fills in what is missing (P1-8)", async () => {
    const dir = join(await fresh(), "instance");
    await init({ dir, seedDir, version: "0.0.1", mint: () => MINTED });

    const planPath = join(dir, "Templates", "Plan.md");
    const editedPlan = "---\nsource: user\n---\n# My own plan, rewritten in Obsidian\n";
    await writeFile(planPath, editedPlan);
    const profilePath = join(dir, "Me", "profile.md");
    const editedProfile = "---\nsource: user\ntimezone: America/Chicago\n---\n";
    await writeFile(profilePath, editedProfile);
    // simulate a template the seed has not shipped before this instance existed
    await rm(join(dir, "Templates", "Weekly.md"));

    await init({ dir, seedDir, version: "0.0.1", force: true, mint: () => MINTED });
    expect(readFileSync(planPath, "utf8")).toBe(editedPlan);
    expect(readFileSync(profilePath, "utf8")).toBe(editedProfile);
    expect(existsSync(join(dir, "Templates", "Weekly.md"))).toBe(true); // missing files still get stamped in
  });

  it("--name lands in identity.yaml (and the mention follows), keeping the seed's comments", async () => {
    const dir = join(await fresh(), "instance");
    const r = await init({ dir, seedDir, version: "0.0.1", name: "Athena Prime", mint: () => MINTED });
    expect(r.assistantName).toBe("Athena Prime");
    const text = readFileSync(join(dir, ".metistry", "identity.yaml"), "utf8");
    const parsed = parseYaml(text) as { name: string; mention: string; voice: string; icon: string };
    expect(parsed.name).toBe("Athena Prime");
    expect(parsed.mention).toBe("@athena-prime");
    expect(parsed.voice).toBeTruthy();
    expect(parsed.icon).toBeTruthy();
    expect(text).toMatch(/^# SEED TEMPLATE/);
    // the name appears in identity.yaml and nowhere else in the repo
    const hits = execFileSync("git", ["grep", "-l", "Athena", "HEAD"], { cwd: dir, encoding: "utf8" }).trim().split("\n");
    expect(hits).toEqual(["HEAD:.metistry/identity.yaml"]);
  });

  it("refuses a non-empty directory unless --force, and never leaves a half-stamped tree behind", async () => {
    const dir = join(await fresh(), "instance");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "notes.txt"), "mine");
    await expect(init({ dir, seedDir, version: "0.0.1", mint: () => MINTED })).rejects.toThrow(/not empty.*--force/);
    expect(readdirSync(dir)).toEqual(["notes.txt"]);

    const r = await init({ dir, seedDir, version: "0.0.1", force: true, mint: () => MINTED });
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true); // --force stamps around what is there
  });

  it("refuses an empty --name and a seedDir that is not a seed", async () => {
    const dir = join(await fresh(), "instance");
    await expect(init({ dir, seedDir, version: "0.0.1", name: "  ", mint: () => MINTED })).rejects.toThrow(/--name/);
    await expect(init({ dir: join(await fresh(), "x"), seedDir: tmpdir(), version: "0.0.1" })).rejects.toThrow(/not a Metistry seed/);
  });

  it("applyName rewrites only the name/mention lines; mentionFor slugs", () => {
    const out = applyName('name: Metis\nmention: "@metis"\nicon: "x"\n', 'O"Brien 9');
    expect(out).toBe('name: "O\\"Brien 9"\nmention: "@o-brien-9"\nicon: "x"\n');
    expect(mentionFor("Metis")).toBe("@metis");
    expect(() => applyName("icon: x\n", "A")).toThrow(/name:/);
  });

  it("main: init prints the .env lines and exits 0; usage errors exit 2", async () => {
    const dir = join(await fresh(), "instance");
    const lines: string[] = [];
    const code = await main(["init", dir, "--name", "Ada", "--product-dir", fileURLToPath(new URL("../../../", import.meta.url))], { out: (s) => lines.push(s), platform: "linux" });
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain(`METISTRY_INSTANCE_DIR=${dir}`);
    expect(text).toMatch(/METISTRY_BRIDGE_TOKEN_RECONCILER=[A-Za-z0-9_-]{40,}/);
    expect(text).toContain("METISTRY_RECONCILER_URL=http://host.docker.internal:7812");
    expect(text).toContain("METISTRY_ORIGIN=http://127.0.0.1:8080");
    expect(text).toContain('assistant named "Ada"');
    expect(existsSync(join(dir, ".env"))).toBe(false);

    const errs: string[] = [];
    expect(await main(["init"], { out: () => {}, err: (s) => errs.push(s) })).toBe(2);
    expect(errs[0]).toMatch(/usage/);
    expect(await main(["bogus"], { out: () => {}, err: () => {} })).toBe(2);
    expect(await main([], { out: () => {}, err: () => {} })).toBe(2);
    // init from inside a checkout pins the checkout's HEAD into the lock
    const lock = parseLock(readFileSync(join(dir, ".metistry", "metistry.lock"), "utf8"));
    expect(lock.product.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.product.source).toBe("git");
  });

  it("main: --channel writes product.source, and a typo is refused rather than guessed", async () => {
    const product = fileURLToPath(new URL("../../../", import.meta.url));
    const dir = join(await fresh(), "release-instance");
    expect(await main(["init", dir, "--channel", "release", "--product-dir", product], { out: () => {} })).toBe(0);
    expect(parseLock(readFileSync(join(dir, ".metistry", "metistry.lock"), "utf8")).product.source).toBe("release");

    const errs: string[] = [];
    const bad = join(await fresh(), "nope");
    expect(await main(["init", bad, "--channel", "stable", "--product-dir", product], { out: () => {}, err: (s) => errs.push(s) })).toBe(2);
    expect(errs[0]).toMatch(/--channel must be git or release/);
    expect(existsSync(bad)).toBe(false);
  });

  it("on darwin, prints launchd-shaped lines with METISTRY_ORIGIN; --shape compose keeps the old lines even there (docs/ops/deployment-shapes.md #4)", async () => {
    const dir = join(await fresh(), "instance");
    const launchd = await init({ dir, seedDir, version: "0.0.1", mint: () => MINTED, platform: "darwin" });
    expect(launchd.envLines).toEqual([
      `METISTRY_INSTANCE_DIR=${dir}`,
      `METISTRY_BRIDGE_TOKEN_RECONCILER=${MINTED}`,
      `METISTRY_BRIDGE_TOKEN_RECONCILER_USER=${MINTED}`,
      "METISTRY_RECONCILER_URL=http://127.0.0.1:7812",
      "METISTRY_ORIGIN=http://127.0.0.1:8080",
      `METISTRY_LOCAL_OWNER_TOKEN=${MINTED}`,
    ]);

    const composeDir = join(await fresh(), "instance");
    const compose = await init({ dir: composeDir, seedDir, version: "0.0.1", mint: () => MINTED, platform: "darwin", shape: "compose" });
    expect(compose.envLines).toEqual([
      `METISTRY_INSTANCE_DIR=${composeDir}`,
      `METISTRY_BRIDGE_TOKEN_RECONCILER=${MINTED}`,
      `METISTRY_BRIDGE_TOKEN_RECONCILER_USER=${MINTED}`,
      "METISTRY_RECONCILER_URL=http://host.docker.internal:7812",
      "METISTRY_ORIGIN=http://127.0.0.1:8080",
      `METISTRY_LOCAL_OWNER_TOKEN=${MINTED}`,
    ]);

    // and a non-darwin platform keeps today's compose default without --shape
    const linuxDir = join(await fresh(), "instance");
    const linux = await init({ dir: linuxDir, seedDir, version: "0.0.1", mint: () => MINTED, platform: "linux" });
    expect(linux.envLines).toContain("METISTRY_RECONCILER_URL=http://host.docker.internal:7812");
  });

  it("on macOS with no --shape, the keep-awake answer is recorded against launchd (ruling 23)", async () => {
    const dir = join(await fresh(), "instance");
    const r = await init({ dir, seedDir, version: "0.0.1", mint: () => MINTED, platform: "darwin", keepAwake: "always" });
    expect(r.keepAwake).toBe("always");
    expect(readFileSync(join(dir, ".metistry", "deployment.yaml"), "utf8")).toContain("shape: launchd");

    // an explicit --shape always wins over the platform guess, on any platform
    const linuxDir = join(await fresh(), "instance");
    await init({ dir: linuxDir, seedDir, version: "0.0.1", mint: () => MINTED, platform: "linux", shape: "launchd", keepAwake: "never" });
    expect(readFileSync(join(linuxDir, ".metistry", "deployment.yaml"), "utf8")).toContain("shape: launchd");
  });

  it("--keep-awake is refused for a shape that cannot hold the Mac awake — compose installs no supervisor", async () => {
    const dir = join(await fresh(), "instance");
    // the platform guess resolves to compose (a non-darwin platform)
    await expect(init({ dir, seedDir, version: "0.0.1", mint: () => MINTED, platform: "linux", keepAwake: "always" })).rejects.toThrow(
      /--keep-awake is refused for --shape compose/,
    );
    expect(existsSync(dir)).toBe(false); // refused before anything is stamped

    // an explicit --shape compose refuses it even on darwin
    await expect(
      init({ dir, seedDir, version: "0.0.1", mint: () => MINTED, platform: "darwin", shape: "compose", keepAwake: "never" }),
    ).rejects.toThrow(/--keep-awake is refused for --shape compose/);

    // --shape launchd (or its platform guess) still answers the question normally
    const r = await init({ dir, seedDir, version: "0.0.1", mint: () => MINTED, platform: "darwin", shape: "launchd", keepAwake: "always" });
    expect(r.keepAwake).toBe("always");
  });

  it("a namespaced instance's launchd lines use its own ports (state/ports.yaml), not the fixed defaults", async () => {
    const dir = join(await fresh(), "instance");
    const namespace: Namespace = { labelSuffix: "a1b2c3d4", base: 8460, ports: portsOf(8460), from: "test" };
    await mkdir(join(dir, ".metistry", "state"), { recursive: true });
    await writeFile(portsFile(dir), serializeNamespace(namespace, "a1b2c3d4-0000-4000-8000-000000000000"));

    const r = await init({ dir, seedDir, version: "0.0.1", force: true, mint: () => MINTED, platform: "darwin" });
    expect(r.envLines).toContain(`METISTRY_RECONCILER_URL=http://127.0.0.1:${namespace.ports.reconciler}`);
    expect(r.envLines).toContain(`METISTRY_ORIGIN=http://127.0.0.1:${namespace.ports.console}`);

    // compose ignores the namespace entirely — docker compose never reads ports.yaml
    const r2 = await init({ dir, seedDir, version: "0.0.1", force: true, mint: () => MINTED, shape: "compose" });
    expect(r2.envLines).toContain("METISTRY_RECONCILER_URL=http://host.docker.internal:7812");
    expect(r2.envLines).toContain("METISTRY_ORIGIN=http://127.0.0.1:8080");
  });

  it("main: --shape rejects a typo rather than falling back to the platform guess", async () => {
    const dir = join(await fresh(), "instance");
    const errs: string[] = [];
    expect(await main(["init", dir, "--shape", "docker"], { out: () => {}, err: (s) => errs.push(s) })).toBe(2);
    expect(errs[0]).toMatch(/--shape must be compose or launchd/);
    expect(existsSync(dir)).toBe(false);
  });
});
