// The database-target guard in ops/scripts/migrate.sh (2026-09-19 incident:
// it ran with METISTRY_TEST_DB_NAME set but METISTRY_DB_NAME unset, defaulted
// to the live `metistry` database, and applied a migration there). Every case
// here runs the real script, copied into a throwaway checkout tree, against a
// fake env — no real Postgres, no network. The refusal and --print-target
// paths both exit before the script ever builds a psql command line, so
// there is nothing here that could reach a database even if one existed.
//
// Run: node --test ops/scripts/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptSrc = fileURLToPath(new URL("../migrate.sh", import.meta.url));

/** A throwaway checkout root: just enough for the script's own `ROOT=$(dirname "$0")/../..` to resolve. */
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "migrate-guard-"));
  mkdirSync(join(root, "ops/scripts"), { recursive: true });
  cpSync(scriptSrc, join(root, "ops/scripts/migrate.sh"));
  return root;
}

/** A throwaway instance dir with `.metistry/state/.env` — the install's own environment. */
function fixtureInstance(env = "METISTRY_DB_NAME=metistry\nMETISTRY_DB_PASSWORD=fake\n") {
  const dir = mkdtempSync(join(tmpdir(), "migrate-guard-instance-"));
  mkdirSync(join(dir, ".metistry/state"), { recursive: true });
  writeFileSync(join(dir, ".metistry/state/.env"), env);
  return dir;
}

/** Runs the fixture copy of migrate.sh with an explicit, minimal env (no inheritance of this process's own METISTRY_* or PATH surprises). */
function run(root, args, env = {}) {
  return spawnSync("sh", [join(root, "ops/scripts/migrate.sh"), ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
}

test("an unknown flag is a usage error, exit 2", () => {
  const r = run(fixtureRoot(), ["--bogus"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:.*--install.*--print-target/);
});

test("no test var, no instance dir: the built-in default, and nothing refuses", () => {
  const r = run(fixtureRoot(), ["--print-target"], { METISTRY_DB_PASSWORD: "ci-only" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "target database: metistry\nsource: default\nwould run: yes\n");
  assert.equal(r.stderr, "");
});

test("the incident: METISTRY_TEST_DB_NAME set, METISTRY_DB_NAME unset, refuses and names both databases", () => {
  const r = run(fixtureRoot(), [], { METISTRY_TEST_DB_NAME: "metistry_test_guard" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /METISTRY_TEST_DB_NAME=metistry_test_guard/);
  assert.match(r.stderr, /METISTRY_DB_NAME=metistry/);
  assert.match(r.stderr, /test shell must never touch a different database by omission/);
});

test("a test shell whose explicit override MATCHES the scratch name is not refused", () => {
  const r = run(fixtureRoot(), ["--print-target"], { METISTRY_TEST_DB_NAME: "metistry_test_guard", METISTRY_DB_NAME: "metistry_test_guard" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /target database: metistry_test_guard/);
  assert.match(r.stdout, /would run: yes/);
});

test("a target sourced from the install's own .metistry/state/.env is refused without --install", () => {
  const instance = fixtureInstance();
  const r = run(fixtureRoot(), [], { METISTRY_INSTANCE_DIR: instance });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /METISTRY_DB_NAME=metistry/);
  assert.match(r.stderr, /install's own environment/);
  assert.match(r.stderr, /instance \.env/);
  assert.match(r.stderr, /--install/);
});

test("--print-target reports the same refusal without running anything", () => {
  const instance = fixtureInstance();
  const r = run(fixtureRoot(), ["--print-target"], { METISTRY_INSTANCE_DIR: instance });
  assert.equal(r.status, 0, r.stderr); // print-target itself never fails — it REPORTS a refusal, it doesn't hit one
  assert.match(r.stdout, /target database: metistry/);
  assert.match(r.stdout, /source: instance \.env/);
  assert.match(r.stdout, /would run: no --/);
  assert.equal(r.stderr, "");
});

test("--install allows the install's own database through the guard", () => {
  const instance = fixtureInstance();
  const r = run(fixtureRoot(), ["--print-target", "--install"], { METISTRY_INSTANCE_DIR: instance });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "target database: metistry\nsource: instance .env (" + join(instance, ".metistry/state/.env") + ")\nwould run: yes\n");
});

test("the legacy pre-2026-09-17 instance layout (state/.env, no .metistry/) is read the same way", () => {
  const dir = mkdtempSync(join(tmpdir(), "migrate-guard-legacy-instance-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "state/.env"), "METISTRY_DB_NAME=metistry\n");
  const r = run(fixtureRoot(), [], { METISTRY_INSTANCE_DIR: dir });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /install's own environment/);
});

test("a checkout root .env naming METISTRY_DB_NAME is tracked as its own source, and is NOT the install-db refusal", () => {
  const root = fixtureRoot();
  writeFileSync(join(root, ".env"), "METISTRY_DB_NAME=metistry\nMETISTRY_DB_PASSWORD=fake\n");
  const r = run(root, ["--print-target"], {});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "target database: metistry\nsource: checkout .env\nwould run: yes\n");
});

test("an explicit METISTRY_DB_NAME survives being sourced past a real instance .env (test-db.sh's own invocation shape)", () => {
  const instance = fixtureInstance(); // its own .env would otherwise clobber METISTRY_DB_NAME back to "metistry"
  const r = run(fixtureRoot(), ["--print-target"], {
    METISTRY_DB_NAME: "metistry_test_guard",
    METISTRY_TEST_DB_NAME: "metistry_test_guard",
    METISTRY_INSTANCE_DIR: instance,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "target database: metistry_test_guard\nsource: environment\nwould run: yes\n");
});

test("an instance .env that does not itself name METISTRY_DB_NAME is not the install-db source", () => {
  const instance = fixtureInstance("METISTRY_DB_PASSWORD=fake\n"); // no METISTRY_DB_NAME line
  const r = run(fixtureRoot(), ["--print-target"], { METISTRY_INSTANCE_DIR: instance });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "target database: metistry\nsource: default\nwould run: yes\n");
});
