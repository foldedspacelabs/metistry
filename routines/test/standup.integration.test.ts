// The Standup routine against the real (scratch) database (T3-5): only
// Postgres can prove that the seeded `Templates/Standup.md` renders
// yesterday's done lines and today's due lines out of `vault_tasks` through
// the real named queries, and that the routine's own `runs` row is the one
// the console turns into `routine.status {name: "standup"}`. The fake-db
// suite (routines/standup/standup.test.ts) proves the decisions; this proves
// the whole path with one fake — the vault bridge, so nothing touches a repo.
//
// Every fixture carries an `itest-standup` marker and is removed again.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PROFILE_PATH } from "@foldedspacelabs/metistry-core";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { COMPONENT, DEFAULT_TEMPLATE, run as standup, standupPath } from "../standup/run.js";
import type { PlanVault } from "../plan-tomorrow/run.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

const SEED = fileURLToPath(new URL("../../seed/", import.meta.url));
const seedFile = (rel: string): string => readFileSync(`${SEED}vault/${rel}`, "utf8");

const MARK = "itest-standup";
const NOTE = `Journal/2026-09-18-${MARK}.md`;
const TZ = "America/New_York";
/** Tuesday 2026-09-22, 08:00 in New York: yesterday is Monday the 21st. */
const SLOT = new Date("2026-09-22T12:00:00Z");
const DATE = "2026-09-22";
const FILE = standupPath(DATE);

const PROFILE = `---\nsource: user\ntimezone: ${TZ}\nworking_days: [mon, tue, wed, thu, fri]\n---\n`;

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

interface FakeVault extends PlanVault {
  files: Map<string, string>;
  writes: { path: string; principal: string; expected: string | undefined }[];
}

function fakeVault(profile = PROFILE): FakeVault {
  const files = new Map<string, string>([
    [DEFAULT_TEMPLATE, seedFile("Templates/Standup.md")],
    [PROFILE_PATH, profile],
    ["Me/Working Style.md", seedFile("Me/Working Style.md")],
  ]);
  const writes: FakeVault["writes"] = [];
  return {
    files,
    writes,
    async read(path) {
      const text = files.get(path);
      return text === undefined ? null : { content: Buffer.from(text, "utf8"), sha256: sha(text) };
    },
    async write(path, content, intent, expectedSha256) {
      const current = files.get(path);
      if (expectedSha256 !== undefined && expectedSha256 !== (current === undefined ? "" : sha(current))) throw new Error(`conflict on ${path}`);
      const text = content.toString("utf8");
      files.set(path, text);
      writes.push({ path, principal: intent.principal, expected: expectedSha256 });
      return { path, sha256: sha(text), bytes: Buffer.byteLength(text, "utf8"), created: current === undefined };
    },
  };
}

describe.skipIf(!hasDb)("standup (real db)", () => {
  let pool: pg.Pool;
  let queries: QueryStore;

  const cleanup = async () => {
    await pool.query(`DELETE FROM vault_tasks WHERE path LIKE '%' || $1 || '%'`, [MARK]);
    await pool.query(`DELETE FROM runs WHERE component = $1`, [COMPONENT]);
    await pool.query(`DELETE FROM proposals WHERE source_agent = $1`, [COMPONENT]);
  };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    queries = new QueryStore(pool);
    await queries.loadDir(`${SEED}queries`);
    await cleanup();
    const task = async (key: string, line: number, text: string, fields: Record<string, unknown>) => {
      const cols = { path: NOTE, task_key: key, line_no: line, text, text_norm: text.toLowerCase(), parsed_on: "2026-09-18", first_seen_on: "2026-09-18", ...fields };
      const names = Object.keys(cols);
      await pool.query(`INSERT INTO vault_tasks (${names.join(", ")}, last_seen_at) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}, now())`, Object.values(cols));
    };
    await task(`h:${MARK}:1`, 4, `Shipped the release notes ${MARK}`, { checked: true, done_on: "2026-09-21", priority: 1 });
    await task(`h:${MARK}:2`, 5, `Review the vendor contract ${MARK}`, { checked: false, due: DATE, priority: 2 });
    await task(`h:${MARK}:3`, 6, `Something done last week ${MARK}`, { checked: true, done_on: "2026-09-15" });
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM runs WHERE component = $1`, [COMPONENT]);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("renders the seeded template into Journal/Standup/<date>.md from the rows really in the vault, as source: standup", async () => {
    const vault = fakeVault();
    expect(await standup(pool, { vault, queries, calendar: null, now: SLOT, scheduledFor: SLOT, timeZone: TZ, env: {} })).toBe(1);

    expect(vault.writes).toEqual([{ path: FILE, principal: COMPONENT, expected: "" }]);
    const text = vault.files.get(FILE) ?? "";
    expect(text).toContain(`source: ${COMPONENT}`);
    expect(text).toContain(`# Standup — ${DATE}`);
    const yesterday = text.slice(text.indexOf("## Yesterday"), text.indexOf("## Today"));
    const today = text.slice(text.indexOf("## Today"));
    expect(yesterday).toContain(`Shipped the release notes ${MARK}`);
    expect(yesterday).not.toContain(`Something done last week ${MARK}`); // done, but not yesterday
    expect(today).toContain(`Review the vendor contract ${MARK}`);
    expect(text).not.toMatch(/\^mt-/);

    // the routine's own row: what Scheduled's history and the event stream read
    const { rows } = await pool.query(`SELECT kind, ok, finished_at, meta FROM runs WHERE component = $1 ORDER BY id`, [COMPONENT]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "routine_run", ok: true, meta: expect.objectContaining({ standup_for: DATE, outcome: "acted", path: FILE, created: true }) });
    expect(rows[0].finished_at).not.toBeNull(); // finished on insert: `routine.status` the moment it lands
  });

  it("nothing is written without working days — and the morning is not settled by the skip", async () => {
    const vault = fakeVault(`---\nsource: user\ntimezone: ${TZ}\n---\n`);
    expect(await standup(pool, { vault, queries, calendar: null, now: SLOT, scheduledFor: SLOT, timeZone: TZ, env: {} })).toBe(0);
    expect(vault.writes).toEqual([]);
    const { rows } = await pool.query(`SELECT meta FROM runs WHERE component = $1`, [COMPONENT]);
    expect(rows.map((r) => r.meta.outcome)).toEqual(["skipped:no_working_days"]);

    vault.files.set(PROFILE_PATH, PROFILE);
    expect(await standup(pool, { vault, queries, calendar: null, now: SLOT, scheduledFor: SLOT, timeZone: TZ, env: {} })).toBe(1);
    expect(vault.writes.map((w) => w.path)).toEqual([FILE]);
  });

  it("a morning already written is not written twice", async () => {
    const vault = fakeVault();
    const ctx = { vault, queries, calendar: null, now: SLOT, scheduledFor: SLOT, timeZone: TZ, env: {} };
    expect(await standup(pool, ctx)).toBe(1);
    expect(await standup(pool, ctx)).toBe(0);
    expect(vault.writes).toHaveLength(1);
  });
});
