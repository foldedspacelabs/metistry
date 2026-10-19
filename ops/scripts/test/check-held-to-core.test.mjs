// ops/scripts/check-held-to-core.mjs against a throwaway tree, then against
// this repository (the acceptance: the tree as committed passes, and each way
// of letting the Swift copy drift from core is a named failure).
//
// Run: node --test ops/scripts/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run } from "../check-held-to-core.mjs";

const script = fileURLToPath(new URL("../check-held-to-core.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const FILTER = `          if echo "$changed" | grep -qE '^(apps/macos/|\\.github/workflows/ci\\.yml|packages/core/test/held-to-core/)'; then\n`;

/** A tree that passes; `tweak` may break one thing in it. */
function tree(tweak = {}) {
  const root = mkdtempSync(join(tmpdir(), "held-to-core-"));
  const put = (rel, text) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("packages/core/test/held-to-core/shape.json", tweak.json ?? '{"keys":{}}');
  put("packages/core/test/shape.test.ts", tweak.core ?? 'readFileSync(new URL("./held-to-core/shape.json", import.meta.url))');
  put("apps/macos/tests/kit/shape-tests.swift", tweak.swift ?? 'let c = try HeldToCore.cases("shape")');
  put("apps/macos/tests/kit/held-to-core.swift", 'static func keys() { cases("shape") }');
  put(".github/workflows/ci.yml", tweak.ci ?? FILTER);
  return root;
}

test("a tree whose cases are read by both sides, and whose CI runs the Swift job, passes", () => {
  const r = run(tree());
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("a fixture no core test reads is refused", () => {
  const r = run(tree({ core: "// nothing" }));
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /shape\.json: no core test reads it/);
});

test("a fixture no Swift test reads is refused — the copy would be held to nothing", () => {
  const r = run(tree({ swift: "// a hand-copied list" }));
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /no Swift test .* reads it/);
});

test("the loader alone does not count as a Swift test reading the fixture", () => {
  // held-to-core.swift in the tree above names "shape"; the test file does not
  const r = run(tree({ swift: "// no reference" }));
  assert.equal(r.ok, false);
});

test("a Swift test naming a fixture that does not exist is refused", () => {
  const r = run(tree({ swift: 'HeldToCore.cases("shape")\nHeldToCore.cases("shpae")' }));
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /names no fixture/);
});

test("invalid JSON is refused", () => {
  const r = run(tree({ json: "{" }));
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /not valid JSON/);
});

test("a CI filter that would skip the Swift job when a case changes is refused", () => {
  const r = run(tree({ ci: FILTER.replace("|packages/core/test/held-to-core/", "") }));
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /macos-app filter does not include/);
});

test("this repository passes, through the CLI", () => {
  const r = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /held to core: ok — 2 fixtures/);
});
