// The Morning Brief against the real (scratch) database (T3-6): only
// Postgres can prove the SQL the file pass adds — its own `brief_for` row,
// the one `note` request per broken note (the pending-row dedupe on
// the real `proposals` table), and the one turn on `inbound_messages` — and
// that the seeded `Templates/Brief.md` renders its requests out of the real
// `pending_requests` query. One fake: the vault bridge, which keeps the
// reconciler's section grammar (core's `writeNoteSection`) so nothing
// touches a repo. The fake-db suite (routines/morning-brief/brief-file.test.ts)
// proves the decisions.
//
// Every fixture carries an `itest-brief` marker and is removed again.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PROFILE_PATH, writeNoteSection } from "@foldedspacelabs/metistry-core";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { COMPONENT, DEFAULT_TEMPLATE, briefPath, dailyNotePath, run as morningBrief, type BriefVault } from "../morning-brief/run.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

const SEED = fileURLToPath(new URL("../../seed/", import.meta.url));
const MARK = "itest-brief";
const TZ = "America/New_York";
/** Monday 2026-09-28, 07:00 in New York. */
const SLOT = new Date("2026-09-28T11:00:00Z");
const DATE = "2026-09-28";
const PROFILE = `---\nsource: user\ntimezone: ${TZ}\nworking_days: [mon, tue, wed, thu, fri]\n---\n`;
const DAILY = `# ${DATE}\n\nmine\n\n## Today · Metistry\n\n<!-- metistry:day -->\n<!-- /metistry:day -->\n`;

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

interface FakeVault extends BriefVault {
  files: Map<string, string>;
}

function fakeVault(note: string | null = DAILY): FakeVault {
  const files = new Map<string, string>([
    [DEFAULT_TEMPLATE, readFileSync(`${SEED}vault/Templates/Brief.md`, "utf8")],
    [PROFILE_PATH, PROFILE],
    ...(note === null ? [] : ([[dailyNotePath(DATE), note]] as [string, string][])),
  ]);
  return {
    files,
    async read(path) {
      const text = files.get(path);
      return text === undefined ? null : { content: Buffer.from(text, "utf8"), sha256: sha(text) };
    },
    async write(path, content, _intent, expectedSha256) {
      const current = files.get(path);
      if (expectedSha256 !== undefined && expectedSha256 !== (current === undefined ? "" : sha(current))) throw Object.assign(new Error("conflict"), { code: "conflict" });
      files.set(path, content.toString("utf8"));
      return { path, sha256: sha(content.toString("utf8")), bytes: content.length, created: current === undefined };
    },
    async section(path, marker, body, _principal, expectedOuterSha) {
      const current = files.get(path);
      if (current === undefined) throw Object.assign(new Error("not_found"), { code: "not_found" });
      const out = writeNoteSection(Buffer.from(current, "utf8"), marker, body, expectedOuterSha);
      if (!out.ok) throw Object.assign(new Error(out.code), { code: out.code });
      files.set(path, out.content.toString("utf8"));
      return { path, sha256: sha(out.content.toString("utf8")), appended: out.appended };
    },
  };
}

describe.skipIf(!hasDb)("morning-brief (real db)", () => {
  let pool: pg.Pool;
  let queries: QueryStore;

  const cleanup = async () => {
    await pool.query(`DELETE FROM runs WHERE component = $1`, [COMPONENT]);
    await pool.query(`DELETE FROM proposals WHERE source_agent = $1 OR payload->>'title' LIKE '%' || $2 || '%'`, [COMPONENT, MARK]);
    await pool.query(`DELETE FROM inbound_messages WHERE thread = $1`, [COMPONENT]);
    await pool.query(`DELETE FROM outbound_messages WHERE kind = 'brief' AND text LIKE '%' || $1 || '%'`, [briefPath(DATE)]);
  };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    queries = new QueryStore(pool);
    await queries.loadDir(`${SEED}queries`);
    await cleanup();
    await pool.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('decision', 'researcher', 'internal', $1)`, [JSON.stringify({ title: `Which repo? ${MARK}` })]);
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM runs WHERE component = $1`, [COMPONENT]);
    await pool.query(`DELETE FROM inbound_messages WHERE thread = $1`, [COMPONENT]);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  const ctx = (vault: FakeVault, slot = SLOT) => ({ vault, queries, calendar: null, now: slot, scheduledFor: slot, timeZone: TZ, env: {}, runId: 7 });

  it("writes the brief from the real requests, the section, its own row and ONE turn — and not twice for one morning", async () => {
    const vault = fakeVault();
    expect(await morningBrief(pool, ctx(vault))).toBe(1);

    const brief = vault.files.get(briefPath(DATE)) ?? "";
    expect(brief).toContain("source: morning-brief");
    expect(brief).toContain(`Which repo? ${MARK}`); // through the real pending_requests query
    expect(brief).toContain(`![[Journal/Standup/${DATE}]]`);
    expect(vault.files.get(dailyNotePath(DATE))).toContain("### Standup");

    const runs = await pool.query(`SELECT kind, ok, finished_at, meta FROM runs WHERE component = $1 ORDER BY id`, [COMPONENT]);
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({ kind: "routine_run", ok: true, meta: expect.objectContaining({ brief_for: DATE, outcome: "acted", day_section: "written", prose_slots: 1, next_up: null }) });
    expect(runs.rows[0].finished_at).not.toBeNull();

    const turns = await pool.query(`SELECT id, text, meta FROM inbound_messages WHERE thread = $1`, [COMPONENT]);
    expect(turns.rows).toHaveLength(1);
    expect(turns.rows[0].meta).toEqual({ kind: "prose", tier: "routine", fresh_session: true, source: COMPONENT, path: briefPath(DATE), slots: 1 });
    expect(runs.rows[0].meta.inbound_id).toBe(Number(turns.rows[0].id));

    expect(await morningBrief(pool, ctx(vault))).toBe(1); // the chat message still goes (a request is pending)…
    expect((await pool.query(`SELECT 1 FROM inbound_messages WHERE thread = $1`, [COMPONENT])).rows).toHaveLength(1); // …but no second file, no second turn
  });

  it("broken markers raise ONE note request on the real table, however many mornings find them", async () => {
    const broken = `# ${DATE}\n\n<!-- /metistry:day -->\n`;
    expect(await morningBrief(pool, ctx(fakeVault(broken)))).toBe(1);
    await pool.query(`DELETE FROM runs WHERE component = $1`, [COMPONENT]);
    expect(await morningBrief(pool, ctx(fakeVault(broken)))).toBe(1);
    const { rows } = await pool.query(`SELECT kind, decision, payload FROM proposals WHERE source_agent = $1`, [COMPONENT]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "knowledge", decision: "pending", payload: expect.objectContaining({ day_section: { day: DATE, path: dailyNotePath(DATE), reason: "unpaired", at_line: 3 } }) });
  });
});
