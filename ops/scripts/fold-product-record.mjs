#!/usr/bin/env node
// docs/product/record/ is the changesets fix applied to docs/product/PRODUCT.md
// (docs/product/record/README.md): each PR adds one fragment file instead of
// appending to the shared file directly, so two open PRs never conflict on
// the same line. This folds the fragments in at release time.
//
// Usage: node ops/scripts/fold-product-record.mjs [--check]
//   (no flag) fold every fragment into PRODUCT.md, in filename order, then
//             delete the folded fragments; no fragments -> no change, exit 0
//   --check   verify every fragment is well-formed and change nothing (CI)

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const recordDir = root + "docs/product/record/";
const productFile = root + "docs/product/PRODUCT.md";

function fragmentNames() {
  return readdirSync(recordDir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort();
}

// The one shape a fragment must have: it starts with the bullet it will
// become, `- <YYYY-…> — …`. Checked before every fold, not only `--check`,
// so a malformed fragment is refused rather than folded in silently.
function malformed(name, text) {
  return text.startsWith("- 20") ? null : `${name}: does not start with "- 20" (must open "- <YYYY-MM-DD> — …")`;
}

const check = process.argv.includes("--check");
const names = fragmentNames();

const bodies = [];
const errors = [];
for (const name of names) {
  const text = readFileSync(recordDir + name, "utf8").trim();
  const error = malformed(name, text);
  if (error) errors.push(error);
  else bodies.push(text);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`fold-product-record: ${error}`);
  process.exit(1);
}

if (check) {
  console.log(`fold-product-record --check: ${names.length} fragment(s), all well-formed`);
  process.exit(0);
}

if (names.length === 0) {
  console.log("fold-product-record: no fragments, PRODUCT.md unchanged");
  process.exit(0);
}

// One blank line between entries — including between the file's existing
// tail and the first folded fragment — so the fragments a run folds together
// stay visually distinct from one another.
const current = readFileSync(productFile, "utf8").replace(/\n*$/, "");
writeFileSync(productFile, `${current}\n\n${bodies.join("\n\n")}\n`);

for (const name of names) unlinkSync(recordDir + name);

console.log(`fold-product-record: folded ${names.length} fragment(s) into PRODUCT.md`);
