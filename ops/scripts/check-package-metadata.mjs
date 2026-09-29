#!/usr/bin/env node
// Every published npm package names the repository it is built from.
//
// `release.yml` publishes with `--provenance` from a public repo, and the
// registry checks the sigstore bundle against the manifest: a package whose
// `repository.url` does not match the repo the provenance names is refused
// with E422 — which is how v0.15.0 published nothing to npm (2026-09-28).
// So every non-private packages/*/package.json must carry
//
//   "repository": { "type": "git",
//                   "url": "git+https://github.com/<owner>/<repo>.git",
//                   "directory": "packages/<dir>" }
//
// npm normalises that url to https://github.com/<owner>/<repo> before
// comparing, case-sensitively. The repo is fixed to the upstream one: a fork's
// packages still name upstream (its own publish is refused before provenance
// matters — it has no trusted publisher on npm), so a fork's CI stays green.
//
//   node ops/scripts/check-package-metadata.mjs   exit 1 with one line per problem
//
// No dependency: node's fs and path only.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = "foldedspacelabs/metistry";
const wantUrl = `git+https://github.com/${repo}.git`;

const problems = [];
let checked = 0;
for (const dir of readdirSync(join(root, "packages")).sort()) {
  const file = join(root, "packages", dir, "package.json");
  if (!existsSync(file)) continue;
  const rel = `packages/${dir}/package.json`;
  let p;
  try {
    p = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    problems.push(`${rel}: not valid JSON (${e.message})`);
    continue;
  }
  if (p.private) continue;
  checked++;
  const r = p.repository;
  if (!r || typeof r !== "object") {
    problems.push(`${rel}: no "repository" object — npm provenance refuses the publish (E422)`);
    continue;
  }
  if (r.type !== "git") problems.push(`${rel}: repository.type is ${JSON.stringify(r.type)}, want "git"`);
  if (r.url !== wantUrl) problems.push(`${rel}: repository.url is ${JSON.stringify(r.url)}, want ${JSON.stringify(wantUrl)}`);
  if (r.directory !== `packages/${dir}`) problems.push(`${rel}: repository.directory is ${JSON.stringify(r.directory)}, want "packages/${dir}"`);
}

if (problems.length) {
  for (const line of problems) console.error(line);
  process.exit(1);
}
console.log(`package metadata: ${checked} published package(s) name ${wantUrl}`);
