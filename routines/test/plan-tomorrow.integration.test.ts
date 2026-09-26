// plan-tomorrow against the real (scratch) database: only Postgres can prove
// that the seeded `Templates/Plan.md` — the file a user edits in Obsidian —
// renders real `- [ ]` lines out of `vault_tasks` through the real named
// queries, in the order the template asks for, with the provenance footer
// that names it. The fake-db suite (routines/plan-tomorrow/plan.test.ts)
// proves the gate and the ownership rule; this proves the whole path, end to
// end, with only two fakes: the vault bridge (so nothing touches a repo) and
// the calendar (so nothing needs a Mac).
//
// Every fixture carries an `itest-plan` marker and is removed again.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";
import { COMPONENT, PLAN_DIR, PROFILE_PATH, TEMPLATE_PATH, run as planTomorrow, type PlanVault } from "../plan-tomorrow/run.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)

const SEED = fileURLToPath(new URL("../../seed/", import.meta.url));
const seedFile = (rel: string): string => readFileSync(`${SEED}vault/${rel}`, "utf8");

const MARK = "itest-plan";
const NOTE = `Journal/2026-09-20-${MARK}.md`;
const RULES = `Me/Routines-${MARK}.md`;
/** Monday 2026-09-21, 19:30 in New York: past the 17:30 day end below, so the target is Tuesday 2026-09-22. */
const EVENING = new Date("2026-09-21T23:30:00Z");
const TARGET = "2026-09-22";
const PLAN_FILE = `${PLAN_DIR}/${TARGET}.md`;
const ENV = { METISTRY_TZ: "America/New_York" } satisfies NodeJS.ProcessEnv;

const PROFILE = `---
source: user
working_days: [mon, tue, wed, thu, fri]
working_hours: "09:00-17:30"
---
# Working profile
`;

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

interface FakeVault extends PlanVault {
  files: Map<string, string>;
  writes: { path: string; principal: string; expected: string | undefined }[];
}

/** The vault bridge, in memory, with the bridge's own compare-and-swap semantics ("" = must not exist). */
function fakeVault(extra: Record<string, string> = {}): FakeVault {
  const files = new Map<string, string>(
    Object.entries({
      [TEMPLATE_PATH]: seedFile("Templates/Plan.md"),
      [PROFILE_PATH]: PROFILE,
      "Me/Working Style.md": seedFile("Me/Working Style.md"),
      ...extra,
    }),
  );
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
      const at = current === undefined ? "" : sha(current);
      if (expectedSha256 !== undefined && expectedSha256 !== at) throw new Error(`conflict on ${path}`);
      const text = content.toString("utf8");
      files.set(path, text);
      writes.push({ path, principal: intent.principal, expected: expectedSha256 });
      return { path, sha256: sha(text), bytes: Buffer.byteLength(text, "utf8"), created: current === undefined };
    },
  };
}

const calendar = {
  async events(day: string) {
    return day === TARGET ? [{ title: `${MARK} design review`, start: `${TARGET}T18:00:00Z`, end: `${TARGET}T19:00:00Z`, all_day: false, calendar: "Work" }] : [];
  },
};

describe.skipIf(!hasDb)("plan-tomorrow (real db)", () => {
  let pool: pg.Pool;
  let queries: QueryStore;

  const cleanup = async () => {
    await pool.query(`DELETE FROM vault_tasks WHERE path LIKE '%' || $1 || '%'`, [MARK]);
    await pool.query(`DELETE FROM runs WHERE component = $1`, [COMPONENT]);
    await pool.query(`DELETE FROM proposals WHERE source_agent = $1`, [COMPONENT]);
  };

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      password: process.env.METISTRY_DB_PASSWORD,
    });
    // The real seeded queries, loaded the way the console loads them (D4
    // overlay, seed first) — `vault_tasks_query` is what the template's
    // `where:` compiles into, and nothing here writes SQL of its own.
    queries = new QueryStore(pool);
    await queries.loadDir(`${SEED}queries`);
    await cleanup();

    // Two open lines in one note — one due tomorrow, one overdue — and a
    // recurrence RULE, which is never itself a task (§4).
    const task = async (key: string, line: number, text: string, fields: Record<string, unknown>) => {
      const cols = { path: NOTE, task_key: key, line_no: line, text, text_norm: text.toLowerCase(), checked: false, parsed_on: "2026-09-20", first_seen_on: "2026-09-20", ...fields };
      const names = Object.keys(cols);
      await pool.query(
        `INSERT INTO vault_tasks (${names.join(", ")}, last_seen_at) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}, now())`,
        Object.values(cols),
      );
    };
    await task(`h:${MARK}:1`, 12, `Call the dentist ${MARK}`, { due: TARGET, priority: 1, size: "S" });
    await task(`h:${MARK}:2`, 14, `Send the contract ${MARK}`, { due: "2026-09-18", priority: 2 });
    await pool.query(
      `INSERT INTO vault_tasks (path, task_key, line_no, text, text_norm, checked, recur_rule, recur_next, parsed_on, first_seen_on, last_seen_at)
       VALUES ($1, $2, 3, $3, lower($3), false, 'every week', $4, '2026-09-20', '2026-09-20', now())`,
      [RULES, `h:${MARK}:rule`, `Water the plants ${MARK}`, TARGET],
    );
  });

  beforeEach(async () => {
    // each test decides for itself whether the evening is settled
    await pool.query(`DELETE FROM runs WHERE component = $1`, [COMPONENT]);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("renders the seeded template into Journal/Plan/<tomorrow>.md, from the rows that are really in the vault", async () => {
    const vault = fakeVault();
    expect(await planTomorrow(pool, { vault, queries, calendar, now: EVENING, env: ENV })).toBe(1);

    const [write] = vault.writes;
    expect(write).toMatchObject({ path: PLAN_FILE, principal: COMPONENT, expected: "" });
    const text = vault.files.get(PLAN_FILE) ?? "";

    // the file is this routine's, and says so where `ownershipRefusal` reads it
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain(`source: ${COMPONENT}`);
    expect(text).toContain(`# Plan — ${TARGET}`);

    // the tasks, as LINKS to the note they live on — never copied text with a
    // second identity (§2.1) — in the template's own order (priority, due, size)
    const dentist = text.indexOf(`Call the dentist ${MARK}`);
    const contract = text.indexOf(`Send the contract ${MARK}`);
    expect(dentist).toBeGreaterThan(-1);
    expect(contract).toBeGreaterThan(dentist); // p1 before p2, which is what `order:` asked for
    expect(text).toContain(`- [[${NOTE.replace(/\.md$/, "")}]] — Call the dentist ${MARK} · due ${TARGET} · p1 · size s`);

    // the recurring rule is PROPOSED for a note that does not exist yet, never
    // materialised into one (§4, D4): no checkbox, no minted anchor
    expect(text).toContain("## Recurring tomorrow");
    expect(text).toContain(`- Water the plants ${MARK} — every week, due ${TARGET}`);
    expect(text).not.toContain(`- [ ] Water the plants`);
    expect(text).not.toMatch(/\^mt-/);

    // the calendar, the user's own prose included verbatim, and the footer
    expect(text).toContain(`${MARK} design review`);
    expect(text).toContain("## Prioritisation");
    expect(text).toContain("Deep work before the first meeting"); // the seeded example prose, spliced verbatim and never executed
    expect(text.trimEnd().endsWith("-->")).toBe(true);
    expect(text).toContain(`<!-- rendered by ${COMPONENT} from ${TEMPLATE_PATH} (sha256 ${sha(seedFile("Templates/Plan.md")).slice(0, 12)}…)`);

    // …and the ledger row the morning brief and `metistry doctor` read
    const { rows } = await pool.query(`SELECT meta FROM runs WHERE component = $1 AND kind = 'routine_run' AND ok ORDER BY ts DESC LIMIT 1`, [COMPONENT]);
    expect(rows[0]?.meta).toMatchObject({ planned_for: TARGET, outcome: "acted", path: PLAN_FILE, created: true, truncated: false, template_warnings: 0 });
  });

  it("re-running the same evening replaces the same file under compare-and-swap — never a second one", async () => {
    const vault = fakeVault();
    await planTomorrow(pool, { vault, queries, calendar, now: EVENING, env: ENV });
    const first = vault.files.get(PLAN_FILE) ?? "";
    await pool.query(`DELETE FROM runs WHERE component = $1`, [COMPONENT]); // step over the once-a-night gate on purpose

    expect(await planTomorrow(pool, { vault, queries, calendar, now: EVENING, env: ENV })).toBe(1);
    expect(vault.writes.map((w) => w.path)).toEqual([PLAN_FILE, PLAN_FILE]);
    expect(vault.writes[1]?.expected).toBe(sha(first)); // the sha it had just read, not a blind replace
    // ONE file, replaced — never appended to and never joined by a second.
    // Byte-for-byte equality of two renders is the fake-db suite's assertion,
    // not this one: `day_work` and `pending_requests` read the whole database,
    // and a sibling suite's fixtures come and go inside this one's run.
    expect([...vault.files.keys()].filter((p) => p.startsWith(PLAN_DIR))).toEqual([PLAN_FILE]);
    const second = vault.files.get(PLAN_FILE) ?? "";
    expect(second).toContain(`# Plan — ${TARGET}`);
    expect(second).toContain(`Call the dentist ${MARK}`);
    expect(second.split(`# Plan — ${TARGET}`)).toHaveLength(2);
  });

  it("a plan file the user has taken over is left exactly as it is", async () => {
    const mine = `---\nsource: user\n---\n# ${MARK} my own plan for tomorrow\n`;
    const vault = fakeVault({ [PLAN_FILE]: mine });
    expect(await planTomorrow(pool, { vault, queries, calendar, now: EVENING, env: ENV })).toBe(0);
    expect(vault.files.get(PLAN_FILE)).toBe(mine);
    expect(vault.writes).toHaveLength(0);
    const { rows } = await pool.query(`SELECT meta FROM runs WHERE component = $1 ORDER BY ts DESC LIMIT 1`, [COMPONENT]);
    expect(rows[0]?.meta).toMatchObject({ outcome: "skipped:user_owned", source: "user" });
  });

  it("an evening this routine has already settled is not planned twice", async () => {
    await pool.query(
      `INSERT INTO runs (component, kind, ok, started_at, finished_at, meta) VALUES ($1, 'routine_run', true, now(), now(), $2)`,
      [COMPONENT, JSON.stringify({ planned_for: TARGET, outcome: "acted" })],
    );
    const vault = fakeVault();
    expect(await planTomorrow(pool, { vault, queries, calendar, now: EVENING, env: ENV })).toBe(0);
    expect(vault.writes).toHaveLength(0);
  });
});
