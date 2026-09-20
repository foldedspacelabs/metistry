// The scanner in ops/scripts/audit-limits.mjs, exercised two ways: its
// `findUnwiredLimits` export against hand-written snippets (what counts as a
// limit, what counts as wired), and the script as a child process against a
// throwaway tree (what CI actually runs).
//
// Run: node --test ops/scripts/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findUnwiredLimits } from "../audit-limits.mjs";

const scriptSrc = fileURLToPath(new URL("../audit-limits.mjs", import.meta.url));
const names = (text, corpus) => findUnwiredLimits(text, "f.ts", corpus).map((h) => h.name);

test("a bare limit-shaped constant is a finding", () => {
  assert.deepEqual(names("const MAX_ROWS = 200;\n"), ["MAX_ROWS"]);
  assert.deepEqual(names("export const REQUEST_TIMEOUT_MS = 5_000;\n"), ["REQUEST_TIMEOUT_MS"]);
  assert.deepEqual(names("const maxOpenBundles = 20;\n"), ["maxOpenBundles"]);
  assert.deepEqual(names("const STOP_GRACE_MS = 30 * 1000;\n"), []); // no bound-shaped word in the name
  assert.deepEqual(names("const PING_TIMEOUT = 30 * 1000;\n"), ["PING_TIMEOUT"]);
});

test("a constant that is not limit-shaped is left alone", () => {
  assert.deepEqual(names("const PORT = 8080;\nconst EMBED_DIM = 768;\nconst VERSION = 3;\n"), []);
});

test("only named constants — an inline literal is not a policy knob", () => {
  assert.deepEqual(names("rows.slice(0, 10);\nfetch(url, { timeout: 5000 });\n"), []);
});

test("wired through intEnv/optionalEnv/process.env in the same file: not a finding", () => {
  assert.deepEqual(names('const MAX_ROWS = 200;\nconst rows = intEnv("METISTRY_MAX_ROWS", MAX_ROWS);\n'), []);
  assert.deepEqual(names('const GREP_TIMEOUT = 1500;\nconst t = optionalEnv("METISTRY_GREP_TIMEOUT", String(GREP_TIMEOUT));\n'), []);
  assert.deepEqual(names("const MAX_BODY = 1024;\nconst n = Number(process.env.METISTRY_MAX_BODY ?? MAX_BODY);\n"), []);
  assert.deepEqual(names('const MAX_ROWS = intEnv("METISTRY_MAX_ROWS", 200);\n'), []);
});

test("an EXPORTED default is looked up across the tree, a file-local one is not", () => {
  const decl = "export const DEFAULT_MAX_STREAK = 5;\n";
  const elsewhere = 'const maxStreak = intEnv("METISTRY_RUNNER_MAX_STREAK", DEFAULT_MAX_STREAK, env);\n';
  assert.deepEqual(names(decl, decl + elsewhere), []);
  assert.deepEqual(names(decl, decl), ["DEFAULT_MAX_STREAK"]);
  // file-local: another file reading it proves nothing, it cannot see it
  const local = "const MAX_STREAK = 5;\n";
  assert.deepEqual(names(local, local + elsewhere.replace("DEFAULT_MAX_STREAK", "MAX_STREAK")), ["MAX_STREAK"]);
});

test("the annotation clears it, on the line or the line above, and demands a reason", () => {
  assert.deepEqual(names("const MAX_ROWS = 200; // limit: fixed — the tool's contract\n"), []);
  assert.deepEqual(names("// limit: fixed — the tool's contract\nconst MAX_ROWS = 200;\n"), []);
  assert.deepEqual(names("const MAX_ROWS = 200; // limit: fixed\n"), ["MAX_ROWS"]); // no reason is not a decision
  assert.deepEqual(names("const MAX_ROWS = 200; // TODO make this configurable\n"), ["MAX_ROWS"]);
});

test("the finding carries file, line, name and value", () => {
  const hits = findUnwiredLimits("\n\nconst MAX_ROWS = 200;\n", "packages/x/src/y.ts");
  assert.deepEqual(hits, [{ file: "packages/x/src/y.ts", line: 3, name: "MAX_ROWS", value: "200" }]);
});

/** A throwaway tree with the script in place, so it resolves ROOT the way CI does. */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "audit-limits-"));
  mkdirSync(join(root, "ops/scripts"), { recursive: true });
  cpSync(scriptSrc, join(root, "ops/scripts/audit-limits.mjs"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const run = (root, ...args) => spawnSync(process.execPath, [join(root, "ops/scripts/audit-limits.mjs"), ...args], { encoding: "utf8" });

test("exit 1 and one line per finding; --json prints the findings", () => {
  const root = fixture({ "packages/x/src/a.ts": "const MAX_ROWS = 200;\n" });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /packages\/x\/src\/a\.ts:1: MAX_ROWS = 200/);
  assert.match(r.stderr, /audit-limits: 1 unwired limit/);
  assert.match(r.stderr, /limit: fixed/); // the message says how to clear it

  const j = run(root, "--json");
  assert.equal(j.status, 1);
  assert.deepEqual(JSON.parse(j.stdout), [{ file: "packages/x/src/a.ts", line: 1, name: "MAX_ROWS", value: "200" }]);
});

test("exit 0 and silence when every limit is wired or annotated", () => {
  const root = fixture({
    "apps/console/src/a.ts": 'const MAX_BODY = intEnv("METISTRY_MAX_BODY_BYTES", 1024);\n',
    "packages/x/src/b.ts": "const MAX_ROWS = 200; // limit: fixed — the tool's contract\n",
  });
  const r = run(root);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
});

test("apps/packages: tests, build output and anything above src/ are not scanned", () => {
  const root = fixture({
    "packages/x/src/a.test.ts": "const MAX_ROWS = 200;\n",
    "packages/x/test/b.ts": "const MAX_ROWS = 200;\n",
    "packages/x/dist/c.ts": "const MAX_ROWS = 200;\n",
    "packages/x/vitest.config.ts": "const MAX_ROWS = 200;\n",
  });
  assert.equal(run(root).status, 0);
});

test("routines and collectors are scanned whole — flat component dirs, no src/ to require (invariant 5)", () => {
  const root = fixture({
    "routines/weekly-review/run.ts": "const MAX_ROWS = 200;\n",
    "collectors/aws-costs/run.ts": "const MAX_ROWS = 200;\n",
  });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /routines\/weekly-review\/run\.ts:1: MAX_ROWS = 200/);
  assert.match(r.stderr, /collectors\/aws-costs\/run\.ts:1: MAX_ROWS = 200/);
});

test("routines and collectors: tests, build output and node_modules are still not scanned", () => {
  const root = fixture({
    "routines/weekly-review/review.test.ts": "const MAX_ROWS = 200;\n",
    "routines/test/b.ts": "const MAX_ROWS = 200;\n",
    "routines/dist/c.ts": "const MAX_ROWS = 200;\n",
    "collectors/aws-costs/aws.test.ts": "const MAX_ROWS = 200;\n",
    "collectors/dist/aws-costs/run.ts": "const MAX_ROWS = 200;\n",
  });
  assert.equal(run(root).status, 0);
});
