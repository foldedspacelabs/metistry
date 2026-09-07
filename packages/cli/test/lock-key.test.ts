// The one fact two files must agree on: the pg_advisory_lock key. The shell
// runner (ops/scripts/migrate.sh, zero dependencies) and the CLI runner
// (src/migrate.ts) serialise through it; if the literals ever drift the two
// can interleave. Grep both, compare to the exported constant.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIGRATION_LOCK_KEY } from "../src/migrate.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migration advisory lock key", () => {
  it("is the same literal in migrate.sh and migrate.ts, and both take pg_advisory_lock with it", () => {
    const sh = read("../../../ops/scripts/migrate.sh");
    const ts = read("../src/migrate.ts");
    const shKey = /^LOCK_KEY=(\d+)$/m.exec(sh)?.[1];
    const tsKey = /^export const MIGRATION_LOCK_KEY = (\d+);$/m.exec(ts)?.[1];
    expect(shKey).toBeDefined();
    expect(tsKey).toBeDefined();
    expect(shKey).toBe(tsKey);
    expect(Number(tsKey)).toBe(MIGRATION_LOCK_KEY);
    expect(sh).toMatch(/pg_advisory_lock\(%s\)/);
    expect(sh).toMatch(/pg_advisory_unlock\(%s\)/);
    expect(ts).toMatch(/SELECT pg_advisory_lock\(\$1\)/);
    expect(ts).toMatch(/SELECT pg_advisory_unlock\(\$1\)/);
    // a 32-bit-safe key: pg_advisory_lock(bigint) accepts more, but pg_locks reports objid as int4 — keep it comparable
    expect(MIGRATION_LOCK_KEY).toBeLessThan(2 ** 31);
  });

  it("both create the same schema_migrations table", () => {
    const sh = read("../../../ops/scripts/migrate.sh");
    const ts = read("../src/migrate.ts");
    for (const text of [sh, ts]) {
      expect(text).toContain("CREATE TABLE IF NOT EXISTS schema_migrations");
      expect(text).toContain("filename   text PRIMARY KEY");
      expect(text).toContain("applied_at timestamptz NOT NULL DEFAULT now()");
    }
  });
});
