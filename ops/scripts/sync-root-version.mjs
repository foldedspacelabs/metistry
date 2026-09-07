#!/usr/bin/env node
// The root package.json version is the product's VERSION file: one number
// for the whole release (changesets runs in `fixed` mode, so every
// workspace package already carries it). The root is not a workspace
// package, so `changeset version` never touches it — this does, right
// after, from packages/cli (the package `metistry.lock` pins).
//
// Usage: node ops/scripts/sync-root-version.mjs [--check]

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel) => JSON.parse(readFileSync(root + rel, "utf8"));

const version = read("packages/cli/package.json").version;
if (typeof version !== "string" || version === "") {
  console.error("sync-root-version: packages/cli/package.json has no version");
  process.exit(1);
}

const file = root + "package.json";
const text = readFileSync(file, "utf8");
const current = JSON.parse(text).version;

if (process.argv.includes("--check")) {
  if (current !== version) {
    console.error(`sync-root-version: package.json is ${current}, packages/cli is ${version} — run: pnpm release:version`);
    process.exit(1);
  }
  console.log(`version ${version} (root and every package agree)`);
  process.exit(0);
}

if (current === version) {
  console.log(`version ${version} (already in sync)`);
  process.exit(0);
}

// Rewrite the one line, so the file's formatting and key order survive.
const next = text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1${JSON.stringify(version)}`);
if (next === text) {
  console.error('sync-root-version: no top-level "version" line in package.json');
  process.exit(1);
}
writeFileSync(file, next);
console.log(`package.json ${current} -> ${version}`);
