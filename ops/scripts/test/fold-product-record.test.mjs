// Exercises ops/scripts/fold-product-record.mjs end-to-end rather than by
// import: the script resolves every path from its own `import.meta.url`, so
// each test copies it into a throwaway `<tmp>/ops/scripts/` alongside a
// matching `docs/product/record/` and `docs/product/PRODUCT.md` and runs it
// as a child process, the way CI and `release:version` do.
//
// Run: node --test ops/scripts/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptSrc = fileURLToPath(new URL("../fold-product-record.mjs", import.meta.url));

function fixture(productBody, fragments) {
  const root = mkdtempSync(join(tmpdir(), "fold-product-record-"));
  mkdirSync(join(root, "ops/scripts"), { recursive: true });
  mkdirSync(join(root, "docs/product/record"), { recursive: true });
  cpSync(scriptSrc, join(root, "ops/scripts/fold-product-record.mjs"));
  writeFileSync(join(root, "docs/product/PRODUCT.md"), productBody);
  writeFileSync(join(root, "docs/product/record/README.md"), "# not a fragment\n");
  for (const [name, body] of Object.entries(fragments)) {
    writeFileSync(join(root, "docs/product/record", name), body);
  }
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [join(root, "ops/scripts/fold-product-record.mjs"), ...args], {
    encoding: "utf8",
  });
}

const product = (root) => readFileSync(join(root, "docs/product/PRODUCT.md"), "utf8");
const remainingFragments = (root) =>
  readdirSync(join(root, "docs/product/record")).filter((name) => name !== "README.md");

test("folds fragments in filename order, one blank line between entries, then deletes them", () => {
  const root = fixture("# Product\n\n## Log\n\n- 2026-01-01 — first entry.\n", {
    "2026-09-16-b-second.md": "- 2026-09-16 — **B.** second.\n",
    "2026-09-01-a-first.md": "- 2026-09-01 — **A.** first.\n",
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    product(root),
    "# Product\n\n## Log\n\n- 2026-01-01 — first entry.\n\n- 2026-09-01 — **A.** first.\n\n- 2026-09-16 — **B.** second.\n"
  );
  assert.deepEqual(remainingFragments(root), []);
});

test("no fragments: no change, exit 0 (idempotent)", () => {
  const root = fixture("# Product\n\n- 2026-01-01 — only entry.\n", {});
  const before = product(root);

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(product(root), before);
});

test("folding twice is a no-op the second time", () => {
  const root = fixture("# Product\n\n- 2026-01-01 — only entry.\n", {
    "2026-09-16-once.md": "- 2026-09-16 — **Once.** done.\n",
  });

  assert.equal(run(root).status, 0);
  const afterFirst = product(root);

  const second = run(root);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(product(root), afterFirst);
});

test("--check passes well-formed fragments and changes nothing", () => {
  const root = fixture("# Product\n\n- 2026-01-01 — only entry.\n", {
    "2026-09-16-ok.md": "- 2026-09-16 — **Fine.** ok.\n",
  });
  const before = product(root);

  const result = run(root, "--check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(product(root), before);
  assert.ok(remainingFragments(root).includes("2026-09-16-ok.md"));
});

test('--check fails on a fragment that does not start with "- 20"', () => {
  const root = fixture("# Product\n\n- 2026-01-01 — only entry.\n", {
    "2026-09-16-bad.md": "Not a bullet at all.\n",
  });

  const result = run(root, "--check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /2026-09-16-bad\.md/);
});

test("fold without --check also refuses a malformed fragment, leaving PRODUCT.md unchanged", () => {
  const root = fixture("# Product\n\n- 2026-01-01 — only entry.\n", {
    "2026-09-16-bad.md": "Not a bullet at all.\n",
  });
  const before = product(root);

  const result = run(root);
  assert.equal(result.status, 1);
  assert.equal(product(root), before);
});
