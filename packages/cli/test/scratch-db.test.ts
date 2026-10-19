// Every scratch database answers in UTC — the shared one ops/scripts/test-db.sh
// builds and each copy `recreateScratchDb` makes — whatever zone the server
// itself runs in. Otherwise a suite's "30 days out" is 30 calendar days in the
// server's zone, which across a DST change is 30 × 24 + 1 hours on a Mac and
// 30 × 24 on CI's UTC server (apps/assistant's archive suite failed exactly
// that way in October 2026). A per-database setting is not copied by
// CREATE DATABASE … TEMPLATE, so the copy is checked on its own.
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { dropScratchDb, loadTestEnv, recreateScratchDb, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const OWN = { suffix: "_tz" } as const;

describe.skipIf(!hasDb)("scratch databases answer in UTC (real db)", () => {
  afterAll(async () => dropScratchDb(pg.Pool, OWN));

  it("the shared scratch database test-db.sh built", async () => {
    const pool = await testDb(pg.Pool);
    try {
      const { rows } = await pool.query<{ timezone: string }>("SELECT current_setting('timezone') AS timezone");
      expect(rows[0]?.timezone).toBe("UTC");
    } finally {
      await pool.end();
    }
  });

  it("a fresh database recreateScratchDb makes — empty, and as a TEMPLATE copy of the shared one", async () => {
    for (const template of [undefined, process.env.METISTRY_TEST_DB_NAME]) {
      await recreateScratchDb(pg.Pool, { ...OWN, ...(template === undefined ? {} : { template }) });
      const pool = await testDb(pg.Pool, OWN);
      try {
        const { rows } = await pool.query<{ timezone: string }>("SELECT current_setting('timezone') AS timezone");
        expect(rows[0]?.timezone, template === undefined ? "empty" : "template copy").toBe("UTC");
      } finally {
        await pool.end();
      }
    }
  });
});
