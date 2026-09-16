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

  // Both tests below run migrateInbox's real UPDATE (REWRITE_PATHS_SQL) against
  // the shared scratch db, and other suites hold rows in the same `inbox`
  // table at the same time. So each test owns a `source` no other run can
  // collide with (pid + timestamp + random, never a literal like 'mig-test'
  // that a previous crashed run could have left behind), every assertion is
  // filtered to that source, and cleanup happens in `afterAll` — never a
  // TRUNCATE, which would take other suites' rows with it.
  describe.skipIf(!hasDb)("inbox.path rewrite against the scratch db", () => {
    let pool: pg.Pool;
    const sources: string[] = [];
    beforeAll(() => {
      pool = new pg.Pool({
        host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
        port: Number(process.env.METISTRY_DB_PORT ?? 5432),
        database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
        user: process.env.METISTRY_DB_USER ?? "metistry",
        password: process.env.METISTRY_DB_PASSWORD,
        max: 1,
      });
    });
    afterAll(async () => {
      for (const s of sources) await pool.query(`DELETE FROM inbox WHERE source = $1`, [s]).catch(() => {});
      await pool.end();
    });
    /** A source this run owns exclusively; recorded so `afterAll` deletes exactly what it inserted. */
    const ownSource = (label: string): string => {
      const s = `mig-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      sources.push(s);
      return s;
    };
    const openOn = (session: pg.PoolClient) => async () => ({ query: (t: string, v?: unknown[]) => session.query(t, v as never), end: async () => session.release() });

    it("rewrites inbox.path rows to the repo-relative form, once", async () => {
      const source = ownSource("rewrite");
      await pool.query(
        `INSERT INTO inbox (source, path, sha256) VALUES ($1, '1757000000000-note.md', $2), ($1, 'inbox/1757000000001-old.md', $3), ($1, 'Knowledge/Inbox/1757000000002-new.md', $4)`,
        [source, "a".repeat(64), "b".repeat(64), "c".repeat(64)],
      );
      const dir = await fixture();
      const session = await pool.connect();
      const r = await migrateInbox({ instanceDir: dir, out, openSession: openOn(session) });
      expect(r.rowsRewritten).toBeGreaterThanOrEqual(2);
      const { rows } = await pool.query(`SELECT path FROM inbox WHERE source = $1 ORDER BY path`, [source]);
      expect(rows.map((x) => x.path)).toEqual([
        "Knowledge/Inbox/1757000000000-note.md",
        "Knowledge/Inbox/1757000000001-old.md",
        "Knowledge/Inbox/1757000000002-new.md", // already migrated: untouched, not double-prefixed
      ]);
      // idempotent at the SQL level too — scoped to this run's own rows, so
      // a concurrent suite inserting a legacy-shaped path elsewhere can
      // never be mistaken for a row THIS run failed to rewrite
      const second = await pool.query(`${REWRITE_PATHS_SQL} AND source = $1`, [source]);
      expect(second.rowCount).toBe(0);
    });

    it("two inbox rows would end up at the same path", async () => {
      const source = ownSource("dup");
      // 'inbox/dup.md' and 'Knowledge/inbox/dup.md' both rewrite to
      // 'Knowledge/Inbox/dup.md' — the partial unique index (inbox_vault_path_uidx,
      // db/migrations/0015_inbox_in_vault.sql) is what actually raises 23505 here.
      await pool.query(`INSERT INTO inbox (source, path, sha256) VALUES ($1, 'inbox/dup.md', $2), ($1, 'Knowledge/inbox/dup.md', $3)`, [source, "d".repeat(64), "e".repeat(64)]);
      const dir = await fixture();
      const session = await pool.connect();
      // migrateInbox releases the session itself (its own `finally`), on both branches
      await expect(migrateInbox({ instanceDir: dir, out, openSession: openOn(session) })).rejects.toThrow(/two inbox rows would end up at the same Knowledge\/Inbox\/ path/);
    });
  });
});
