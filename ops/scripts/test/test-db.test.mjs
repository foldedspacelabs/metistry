// The database-target guard in ops/scripts/test-db.sh: this script's entire
// job is DROP DATABASE + CREATE DATABASE, so it refuses outright — no
// override flag — whenever METISTRY_TEST_DB_NAME would resolve to the same
// name the install's own `.metistry/state/.env` configures. Every case here
// runs the real script, copied into a throwaway checkout tree, against a
// fake env — no real Postgres, no network. The refusal and --print-target
// paths both exit before the script builds a psql command line.
//
// Run: node --test ops/scripts/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testDbSrc = fileURLToPath(new URL("../test-db.sh", import.meta.url));
const migrateSrc = fileURLToPath(new URL("../migrate.sh", import.meta.url));

/** A throwaway checkout root carrying both scripts, since test-db.sh calls migrate.sh by its relative path once the guard clears. */
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "test-db-guard-"));
  mkdirSync(join(root, "ops/scripts"), { recursive: true });
  cpSync(testDbSrc, join(root, "ops/scripts/test-db.sh"));
  cpSync(migrateSrc, join(root, "ops/scripts/migrate.sh"));
  return root;
}

/** A throwaway instance dir with `.metistry/state/.env` — the install's own environment. */
function fixtureInstance(dbName = "metistry") {
  const dir = mkdtempSync(join(tmpdir(), "test-db-guard-instance-"));
  mkdirSync(join(dir, ".metistry/state"), { recursive: true });
  writeFileSync(join(dir, ".metistry/state/.env"), `METISTRY_DB_NAME=${dbName}\nMETISTRY_DB_PASSWORD=fake\n`);
  return dir;
}

function run(root, args, env = {}) {
  return spawnSync("sh", [join(root, "ops/scripts/test-db.sh"), ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
}

test("an unknown flag is a usage error, exit 2", () => {
  const r = run(fixtureRoot(), ["--bogus"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:.*--print-target/);
});

test("no instance dir: the default scratch name, and nothing refuses", () => {
  const r = run(fixtureRoot(), ["--print-target"], { METISTRY_DB_PASSWORD: "ci-only" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "target database: metistry_test (drop + recreate)\ninstall's configured database: none found (no instance .env names one)\nwould run: yes\n");
});

test("a scratch name distinct from the install's is allowed, instance dir present", () => {
  const instance = fixtureInstance("metistry");
  const r = run(fixtureRoot(), ["--print-target"], { METISTRY_TEST_DB_NAME: "metistry_test_guard", METISTRY_INSTANCE_DIR: instance });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /target database: metistry_test_guard \(drop \+ recreate\)/);
  assert.match(r.stdout, /install's configured database: metistry/);
  assert.match(r.stdout, /would run: yes/);
});

test("METISTRY_TEST_DB_NAME colliding with the install's configured db refuses, exit 2, names both", () => {
  const instance = fixtureInstance("metistry");
  const r = run(fixtureRoot(), [], { METISTRY_TEST_DB_NAME: "metistry", METISTRY_INSTANCE_DIR: instance });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /METISTRY_TEST_DB_NAME=metistry/);
  assert.match(r.stderr, /refusing to drop and recreate it/);
});

test("--print-target reports the same collision without dropping anything", () => {
  const instance = fixtureInstance("metistry");
  const r = run(fixtureRoot(), ["--print-target"], { METISTRY_TEST_DB_NAME: "metistry", METISTRY_INSTANCE_DIR: instance });
  assert.equal(r.status, 0, r.stderr); // print-target itself never fails — it REPORTS a refusal, it doesn't hit one
  assert.match(r.stdout, /would run: no --/);
  assert.equal(r.stderr, "");
});

test("there is no bypass flag — the script has no --install", () => {
  const instance = fixtureInstance("metistry");
  const r = run(fixtureRoot(), ["--install"], { METISTRY_TEST_DB_NAME: "metistry", METISTRY_INSTANCE_DIR: instance });
  assert.equal(r.status, 2); // --install is simply not a recognised flag here — usage error, not a bypass
  assert.match(r.stderr, /usage:/);
});

test("an instance .env that does not itself name METISTRY_DB_NAME reports none found, not a false collision", () => {
  const dir = mkdtempSync(join(tmpdir(), "test-db-guard-instance-"));
  mkdirSync(join(dir, ".metistry/state"), { recursive: true });
  writeFileSync(join(dir, ".metistry/state/.env"), "METISTRY_DB_PASSWORD=fake\n"); // no METISTRY_DB_NAME line
  const r = run(fixtureRoot(), ["--print-target"], { METISTRY_TEST_DB_NAME: "metistry", METISTRY_INSTANCE_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /install's configured database: none found/);
  assert.match(r.stdout, /would run: yes/);
});
