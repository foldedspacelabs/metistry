// ops/scripts/test-workspace.mjs: the root `pnpm test` gives every package a
// scratch database of its own, copied from the shared one. These hold the
// pure half — how a package's database is named, that no two packages share
// one, which packages run, what the child inherits — with no Postgres and no
// pnpm, except the one case that reads the real workspace listing to show the
// rule holds for every package actually in the tree.
//
// Run: node --test ops/scripts/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { childEnv, packageDbName, parseArgs, plan, scratchSuffix, workspacePackages, workspacePatterns } from "../test-workspace.mjs";

const SCRATCH = /^metistry_test_[a-z0-9_]+$/;
const SUFFIX = /^_[a-z0-9_]+$/;

test("scratchSuffix: the unscoped name, lowercase, metistry- dropped, `_` for anything else — what testDb accepts as a suffix", () => {
  assert.equal(scratchSuffix("@foldedspacelabs/metistry-core"), "_core");
  assert.equal(scratchSuffix("@foldedspacelabs/metistry-mcp-live-capture"), "_mcp_live_capture");
  assert.equal(scratchSuffix("@metistry-apps/console"), "_console");
  assert.equal(scratchSuffix("@metistry-apps/plugin-claude-code"), "_plugin_claude_code");
  assert.equal(scratchSuffix("Routines"), "_routines");
  assert.match(scratchSuffix("@x/weird.name--1"), SUFFIX);
  assert.throws(() => scratchSuffix("@x/metistry-"), /cannot derive/);
});

test("packageDbName: base + suffix, within Postgres's 63, the base cut back visibly rather than the server truncating silently", () => {
  assert.equal(packageDbName("metistry_test_x_88", "_core"), "metistry_test_x_88_core");
  const long = "metistry_test_" + "a".repeat(40); // the longest default `pnpm test` derives
  const name = packageDbName(long, "_mcp_live_capture");
  assert.equal(name.length, 63);
  assert.ok(name.endsWith("_mcp_live_capture"), name);
  assert.ok(name.startsWith("metistry_test_aaaa"), name);
  assert.throws(() => packageDbName("metistry_test_x", "_" + "s".repeat(60)), /no room/);
});

const pkgs = [
  { name: "@foldedspacelabs/metistry-core", path: "/w/packages/core", scripts: { test: "vitest run" } },
  { name: "@foldedspacelabs/metistry-tasks", path: "/w/packages/tasks", scripts: { test: "vitest run" } },
  { name: "@metistry-apps/console", path: "/w/apps/console", scripts: { test: "vitest run" } },
  { name: "@metistry-apps/macos", path: "/w/apps/macos", scripts: { build: "swift build" } },
];

test("plan: two packages' suites run against two different databases, both copies of the one base", () => {
  const out = plan(pkgs, "metistry_test_x_88");
  assert.deepEqual(
    out.map((p) => [p.name, p.database]),
    [
      ["@foldedspacelabs/metistry-core", "metistry_test_x_88_core"],
      ["@foldedspacelabs/metistry-tasks", "metistry_test_x_88_tasks"],
      ["@metistry-apps/console", "metistry_test_x_88_console"],
    ],
  );
  assert.equal(new Set(out.map((p) => p.database)).size, out.length, "no two packages share a database");
  for (const p of out) {
    assert.match(p.database, SCRATCH);
    assert.equal(p.stem + p.suffix, p.database); // exactly what recreateScratchDb is handed
    assert.match(p.suffix, SUFFIX);
  }
});

test("plan: a package with no test script is left out, as pnpm --if-present left it", () => {
  assert.ok(!plan(pkgs, "metistry_test_x_88").some((p) => p.name === "@metistry-apps/macos"));
});

test("plan: a collision is an error, not a shared database", () => {
  const twins = [
    { name: "@a/metistry-core", path: "/w/a", scripts: { test: "x" } },
    { name: "@b/core", path: "/w/b", scripts: { test: "x" } },
  ];
  assert.throws(() => plan(twins, "metistry_test_x"), /would share the database metistry_test_x_core/);
});

test("plan --only: by full name, unscoped name or directory; nothing matched is an error", () => {
  assert.deepEqual(plan(pkgs, "metistry_test_x", ["tasks"]).map((p) => p.name), ["@foldedspacelabs/metistry-tasks"]);
  assert.deepEqual(plan(pkgs, "metistry_test_x", ["@metistry-apps/console", "metistry-core"]).map((p) => p.name), ["@foldedspacelabs/metistry-core", "@metistry-apps/console"]);
  assert.throws(() => plan(pkgs, "metistry_test_x", ["nope"]), /matched no package/);
  assert.throws(() => plan(pkgs, "metistry_test_x", ["macos"]), /matched no package/); // has no test script
});

test("parseArgs: concurrency defaults to one package at a time; --only repeats; anything else is usage", () => {
  assert.deepEqual(parseArgs([]), { concurrency: 1, only: [] });
  assert.deepEqual(parseArgs(["--concurrency", "2", "--only", "tasks", "--only=core"]), { concurrency: 2, only: ["tasks", "core"] });
  assert.deepEqual(parseArgs(["-j", "3", "--concurrency=4"]).concurrency, 4);
  assert.throws(() => parseArgs(["--concurrency", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--concurrency", "two"]), /positive integer/);
  assert.throws(() => parseArgs(["--no-file-parallelism"]), /usage:/); // the flag that never reached vitest is not quietly swallowed here either
});

test("childEnv: the package's database as METISTRY_TEST_DB_NAME; METISTRY_DB_NAME follows it only where it was set", () => {
  const base = { PATH: "/usr/bin", METISTRY_DB_PASSWORD: "pw", METISTRY_TEST_DB_NAME: "metistry_test_x" };
  assert.deepEqual(childEnv(base, "metistry_test_x_core"), { PATH: "/usr/bin", METISTRY_DB_PASSWORD: "pw", METISTRY_TEST_DB_NAME: "metistry_test_x_core" });
  assert.equal(childEnv({ ...base, METISTRY_DB_NAME: "metistry_test_x" }, "metistry_test_x_core").METISTRY_DB_NAME, "metistry_test_x_core");
  assert.deepEqual(base, { PATH: "/usr/bin", METISTRY_DB_PASSWORD: "pw", METISTRY_TEST_DB_NAME: "metistry_test_x" }, "the caller's env is not mutated");
});

test("workspacePatterns: pnpm-workspace.yaml's packages list, quotes or not, comments dropped; anything beyond <dir>/* or <dir> is an error", () => {
  assert.deepEqual(workspacePatterns('packages:\n  - "apps/*"\n  - \'packages/*\'\n  - collectors # one package\n  - routines/\nother:\n  - not/a/package\n'), ["apps/*", "packages/*", "collectors", "routines"]);
  assert.throws(() => workspacePatterns("packages:\n  - apps/**\n"), /more than <dir>\/\*/);
  assert.throws(() => workspacePatterns("packages:\n  - '!apps/x'\n"), /more than/);
  assert.throws(() => workspacePatterns("catalog: {}\n"), /names no packages/);
});

test("the real workspace: every package with a test script gets its own database within 63 characters, even from the longest default name", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const packages = workspacePackages(root); // the filesystem, not pnpm — CI runs this before pnpm is installed
  assert.ok(packages.length > 10, `pnpm-workspace.yaml resolved to ${packages.length} packages`);
  assert.ok(!packages.some((p) => p.name === "metistry"), "the root is not a package to test");
  assert.ok(packages.some((p) => p.name === "@foldedspacelabs/metistry-core"), "packages/* resolved");
  assert.ok(packages.some((p) => p.name === "@metistry-apps/collectors"), "a plain <dir> entry resolved");
  const longest = "metistry_test_" + "d".repeat(40);
  for (const base of ["metistry_test_metistry", longest]) {
    const out = plan(packages, base);
    assert.ok(out.length > 10, `${out.length} packages have a test script`);
    assert.equal(new Set(out.map((p) => p.database)).size, out.length);
    for (const p of out) {
      assert.match(p.database, SCRATCH);
      assert.ok(p.database.length <= 63, p.database);
    }
  }
});
