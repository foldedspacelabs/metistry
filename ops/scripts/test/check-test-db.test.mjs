// ops/scripts/check-test-db.mjs: its exports against hand-written test files
// (what is refused, what is not), and the script as a child process against a
// throwaway tree (what CI runs). Nothing here reads the environment or reaches
// a database.
//
// The fixtures spell the forbidden constructions through `NEW`, so this file
// is not itself one of the test files the check would refuse.
//
// Run: node --test ops/scripts/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findViolations, isTestFile, pgBindings, run, testFiles } from "../check-test-db.mjs";

const scriptSrc = fileURLToPath(new URL("../check-test-db.mjs", import.meta.url));
const NEW = "new";
const [DB_FROM_ENV, SESSION, MAKE_POOL] = ["openDbFromEnv", "openMigrationSession", "makePool"];
const lines = (text) => findViolations(text).map((v) => v.line);

test("a test file is anything under test/ tests/ __tests__/, or named *.test.* / *.spec.*", () => {
  for (const yes of ["apps/console/test/a.integration.test.ts", "packages/x/test/helpers.ts", "routines/tests/b.mjs", "src/__tests__/c.js", "packages/x/src/d.test.ts", "e.spec.mts"]) assert.equal(isTestFile(yes), true, yes);
  for (const no of ["apps/console/src/db.ts", "packages/x/test/fixture.json", "docs/test/notes.md", "ops/scripts/check-test-db.mjs"]) assert.equal(isTestFile(no), false, no);
});

test("the pg module and its classes under whatever name a file gives them", () => {
  const b = pgBindings(
    [
      'import pg from "pg";',
      'import * as postgres from "pg";',
      'import driver, { Pool as P, Client } from "pg";',
      'import type { PoolConfig } from "pg";',
      'const { default: late } = await import("pg");',
      'const req = require("pg");',
      "const { Pool: Q } = pg;",
    ].join("\n"),
  );
  assert.deepEqual([...b.namespaces].sort(), ["driver", "late", "pg", "postgres", "req"]);
  assert.deepEqual([...b.classes].sort(), ["Client", "P", "Q"]);
});

test("every way of building a pg connection directly is refused, with its line", () => {
  assert.deepEqual(lines(`import pg from "pg";\nconst p = ${NEW} pg.Pool({ database: "x" });`), [2]);
  assert.deepEqual(lines(`import pg from "pg";\nconst c = ${NEW} pg.Client({});`), [2]);
  assert.deepEqual(lines(`import * as postgres from "pg";\n\n${NEW} postgres.Pool();`), [3]);
  assert.deepEqual(lines(`import { Pool } from "pg";\n${NEW} Pool({});`), [2]);
  assert.deepEqual(lines(`import { Client as PgClient } from "pg";\n${NEW} PgClient({});`), [2]);
  assert.deepEqual(lines(`import pg from "pg";\nconst { Pool } = pg;\n${NEW} Pool({});`), [3]);
  assert.deepEqual(lines(`const { default: pg } = await import("pg");\n${NEW} pg.Pool({});`), [2]);
});

test("the product's env-driven openers are refused unless handed {} or testDbEnv()", () => {
  assert.deepEqual(lines(`await ${DB_FROM_ENV}({ ...process.env, METISTRY_DB_NAME: 'x' });`), [1]);
  assert.deepEqual(lines(`await ${SESSION}(process.env);`), [1]);
  assert.deepEqual(lines(`const env = testDbEnv();\nawait ${DB_FROM_ENV}(env);`), [2]);
  assert.deepEqual(lines(`const p = ${MAKE_POOL}();`), [1]);
  assert.deepEqual(lines(`await ${SESSION}( {} );`), []);
  assert.deepEqual(lines(`expect(await ${DB_FROM_ENV}({})).toBeNull();\nawait ${SESSION}(testDbEnv({ suffix: '_mig' }));\nawait ${DB_FROM_ENV}( testDbEnv() );`), []);
});

test("what a test is supposed to write passes", () => {
  const ok = [
    'import pg from "pg";',
    'import { Client } from "@modelcontextprotocol/sdk/client/index.js";',
    'import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";',
    "pool = await testDb(pg.Pool, { max: 10 });",
    "const pool2: pg.Pool = await testDb(pg.Pool);",
    `const client = ${NEW} Client({ name: "t", version: "0" }); // the MCP client, not pg's`,
    'it("openDbFromEnv builds a working pool", () => {});',
  ].join("\n");
  assert.deepEqual(findViolations(ok), []);
});

test("run(): a stray pool fails naming file and line; the same suite through testDb passes", () => {
  const root = mkdtempSync(join(tmpdir(), "metistry-check-test-db-"));
  mkdirSync(join(root, "apps", "x", "test"), { recursive: true });
  mkdirSync(join(root, "apps", "x", "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pg", "test"), { recursive: true });
  writeFileSync(join(root, "apps", "x", "src", "db.ts"), `import pg from "pg";\nexport const pool = ${NEW} pg.Pool({});\n`); // product code: not this check's business
  writeFileSync(join(root, "node_modules", "pg", "test", "a.test.js"), `const pg = require("pg");\n${NEW} pg.Client({});\n`); // a dependency's own tests: skipped
  const suite = join(root, "apps", "x", "test", "a.integration.test.ts");
  writeFileSync(suite, `import pg from "pg";\nbeforeAll(async () => {\n  pool = ${NEW} pg.Pool({ database: process.env.METISTRY_TEST_DB_NAME });\n});\n`);
  assert.deepEqual(testFiles(root), ["apps/x/test/a.integration.test.ts"]);

  const r = run(root);
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /^apps\/x\/test\/a\.integration\.test\.ts:3: `new pg\.Pool…`/);
  assert.match(r.lines.at(-1), /testDb\(\) from @foldedspacelabs\/metistry-core\/test-env/);

  writeFileSync(suite, 'import pg from "pg";\nimport { testDb } from "@foldedspacelabs/metistry-core/test-env";\nbeforeAll(async () => {\n  pool = await testDb(pg.Pool);\n});\n');
  const good = run(root);
  assert.equal(good.ok, true);
  assert.deepEqual(good.lines, ["test db: ok — 1 test files, none opens Postgres on its own; 1 go through testDb()"]);
});

test("this checkout passes — what CI runs", () => {
  const r = spawnSync(process.execPath, [scriptSrc], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^test db: ok — \d+ test files/);
});
