// `metistry migrate-inbox` against a fixture instance repo (a real `git
// init`, real files) and the scratch database. What it has to get right:
// the untracked legacy `inbox/`, a second instance's lowercase
// `Knowledge/inbox/` on a case-insensitive filesystem, the .gitignore
// rewrite, the row rewrite, idempotency, and `--dry-run` changing nothing.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { actualName, migrateInbox, rewriteGitignore, REWRITE_PATHS_SQL } from "../src/migrate-inbox.js";
import { GITIGNORE } from "../src/init.js";

const exec = promisify(execFile);

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}
const hasDb = !!process.env.METISTRY_DB_PASSWORD;

/** An instance repo in the pre-2026-09-16 layout: gitignored `inbox/`, vault beside it. */
async function legacyInstance(files: Record<string, string> = { "1757000000000-note.md": "# an old capture\n" }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-inbox-mig-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir };
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  await mkdir(join(dir, "Knowledge"), { recursive: true });
  await writeFile(join(dir, "Knowledge", "now.md"), "# Now\n");
  await mkdir(join(dir, "inbox"), { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, "inbox", name), body);
  await writeFile(join(dir, ".gitignore"), "inbox/\nstate/\n.obsidian/workspace*\n");
  await exec("git", ["add", "-A"], { cwd: dir, env });
  await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"], { cwd: dir, env });
  return dir;
}

const lines: string[] = [];
const out = (l: string) => lines.push(l);

describe("gitignore rewrite", () => {
  it("drops the inbox line and adds the .large spill, keeping everything else", () => {
    expect(rewriteGitignore("inbox/\nstate/\n.obsidian/workspace*\n")).toBe("state/\n.obsidian/workspace*\nKnowledge/Inbox/.large/\n");
    expect(rewriteGitignore("/inbox\nstate/\n")).toBe("state/\nKnowledge/Inbox/.large/\n");
    // already migrated: byte-identical to what `metistry init` stamps today
    expect(rewriteGitignore(GITIGNORE)).toBe(GITIGNORE);
    // a hand-added rule survives
    expect(rewriteGitignore("state/\n*.tmp\n")).toContain("*.tmp");
  });
});

describe("migrate-inbox (fixture instance repo)", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  const fixture = async (...args: Parameters<typeof legacyInstance>) => {
    const d = await legacyInstance(...args);
    dirs.push(d);
    return d;
  };

  it("moves untracked captures into the vault, rewrites .gitignore, and commits", async () => {
    const dir = await fixture({ "1757000000000-note.md": "# an old capture\n", "1757000000001-shot.png": "PNG" });
    const r = await migrateInbox({ instanceDir: dir, out, openSession: async () => null });

    expect(r).toMatchObject({ code: 0, from: "inbox", moved: 2, gitignore: "updated", alreadyDone: false });
    expect(existsSync(join(dir, "inbox"))).toBe(false);
    expect((await readdir(join(dir, "Knowledge", "Inbox"))).sort()).toEqual(["1757000000000-note.md", "1757000000001-shot.png"]);
    expect(await readFile(join(dir, "Knowledge", "Inbox", "1757000000000-note.md"), "utf8")).toBe("# an old capture\n");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(GITIGNORE);

    // committed: the captures are part of the record now (invariant 1)
    const tracked = await exec("git", ["-C", dir, "ls-files"], { env: { ...process.env, HOME: dir } });
    expect(tracked.stdout).toContain("Knowledge/Inbox/1757000000000-note.md");
    const log = await exec("git", ["-C", dir, "log", "--oneline"], { env: { ...process.env, HOME: dir } });
    expect(log.stdout).toContain("Inbox moved into the vault");
  });

  it("is idempotent: the second run moves nothing and says so", async () => {
    const dir = await fixture();
    await migrateInbox({ instanceDir: dir, out, openSession: async () => null });
    const again = await migrateInbox({ instanceDir: dir, out, openSession: async () => null });
    expect(again).toMatchObject({ from: null, moved: 0, gitignore: "unchanged", alreadyDone: true });
  });

  it("--dry-run changes nothing and prints the plan", async () => {
    const dir = await fixture();
    const r = await migrateInbox({ instanceDir: dir, out, dryRun: true, openSession: async () => null });
    expect(r.commands.some((c) => c.includes("move inbox/1757000000000-note.md"))).toBe(true);
    expect(existsSync(join(dir, "inbox", "1757000000000-note.md"))).toBe(true); // still there
    expect(existsSync(join(dir, "Knowledge", "Inbox"))).toBe(false);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain("inbox/\n");
  });

  it("a second instance's lowercase Knowledge/inbox is renamed through a temp name (macOS is case-insensitive)", async () => {
    const dir = await fixture({});
    await rm(join(dir, "inbox"), { recursive: true, force: true });
    await mkdir(join(dir, "Knowledge", "inbox"), { recursive: true });
    await writeFile(join(dir, "Knowledge", "inbox", "1757000000009-lower.md"), "# lowercase\n");

    const r = await migrateInbox({ instanceDir: dir, out, openSession: async () => null });
    expect(r).toMatchObject({ from: "Knowledge/inbox", moved: 1 });
    expect(await actualName(join(dir, "Knowledge"), "inbox")).toBe("Inbox"); // the real entry, not what existsSync would say
    expect(await readFile(join(dir, "Knowledge", "Inbox", "1757000000009-lower.md"), "utf8")).toBe("# lowercase\n");
  });

  it("refuses a directory that is not a git repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "metistry-noninstance-"));
    dirs.push(plain);
    await expect(migrateInbox({ instanceDir: plain, out, openSession: async () => null })).rejects.toThrow(/not a git repository/);
  });

  it.skipIf(!hasDb)("rewrites inbox.path rows to the repo-relative form, once", async () => {
    const pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      user: process.env.METISTRY_DB_USER ?? "metistry",
      password: process.env.METISTRY_DB_PASSWORD,
      max: 1,
    });
    try {
      await pool.query(`DELETE FROM inbox WHERE source = 'mig-test'`);
      await pool.query(`INSERT INTO inbox (source, path, sha256) VALUES ('mig-test', '1757000000000-note.md', $1), ('mig-test', 'inbox/1757000000001-old.md', $2), ('mig-test', 'Knowledge/Inbox/1757000000002-new.md', $3)`, [
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
      ]);
      const dir = await fixture();
      const session = await pool.connect();
      const r = await migrateInbox({
        instanceDir: dir,
        out,
        openSession: async () => ({ query: (t: string, v?: unknown[]) => session.query(t, v as never), end: async () => session.release() }),
      });
      expect(r.rowsRewritten).toBeGreaterThanOrEqual(2);
      const { rows } = await pool.query(`SELECT path FROM inbox WHERE source = 'mig-test' ORDER BY path`);
      expect(rows.map((x) => x.path)).toEqual([
        "Knowledge/Inbox/1757000000000-note.md",
        "Knowledge/Inbox/1757000000001-old.md",
        "Knowledge/Inbox/1757000000002-new.md", // already migrated: untouched, not double-prefixed
      ]);
      // idempotent at the SQL level too
      const second = await pool.query(REWRITE_PATHS_SQL);
      expect(second.rowCount).toBe(0);
    } finally {
      await pool.query(`DELETE FROM inbox WHERE source = 'mig-test'`).catch(() => {});
      await pool.end();
    }
  });
});
