// A recording's transcript is outside every default grant (T8-4,
// daily-flow-spec §8.4): the SQL half. knowledge_search, knowledge_list,
// knowledge_grep and the resources pick rows with `areaFilter`, so it has to
// say exactly what core's `underAreas` says — the same paths, against a real
// Postgres, for the grants an agent could hold.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { underAreas } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { areaFilter } from "../src/knowledge.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));

const PATHS = [
  "Journal/2026-09-28.md",
  "Journal/Meetings/standup.md",
  "Journal/Transcripts/2026-09-28-20260928-120000-00ab.md",
  "Journal/Transcripts/2026/old.md",
  "Journal/TranscriptsOld/x.md",
  "Areas/Health/sleep.md",
];

const GRANTS: (string[] | null)[] = [["Journal"], ["Journal/"], ["Journal/Transcripts"], ["Journal/Transcripts/2026"], ["/"], ["Areas/Health", "Journal"], [], null];

describe.skipIf(!hasDb)("areaFilter keeps transcripts out of `Journal` (real db)", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });
  afterAll(async () => pool?.end());

  it("selects exactly the paths underAreas admits, for every grant", async () => {
    for (const areas of GRANTS) {
      const { rows } = await pool.query(`SELECT path FROM unnest($2::text[]) AS t(path) WHERE ${areaFilter("path", 1)} ORDER BY path`, [areas, PATHS]);
      const expected = areas === null ? [...PATHS] : PATHS.filter((p) => underAreas(p, areas));
      expect(rows.map((r) => r.path), JSON.stringify(areas)).toEqual(expected.sort());
    }
    const journal = await pool.query(`SELECT path FROM unnest($2::text[]) AS t(path) WHERE ${areaFilter("path", 1)}`, [["Journal"], PATHS]);
    expect(journal.rows.map((r) => r.path)).not.toContain("Journal/Transcripts/2026-09-28-20260928-120000-00ab.md");
  });
});
