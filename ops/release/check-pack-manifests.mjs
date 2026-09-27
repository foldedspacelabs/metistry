#!/usr/bin/env node
// Validate a runtime pack's manifests with the pack's OWN code.
//
//   node ops/release/check-pack-manifests.mjs <product-dir>
//
// Imports `<product-dir>/packages/cli/dist/doctor.js` — the doctor a release
// install runs, resolving `@foldedspacelabs/metistry-core` through the
// product dir's own node_modules — and runs its `walkManifests` over the
// same directory: collectors/, routines/, targets/, and every package's
// manifest.yaml. Exits 1 when any manifest does not validate, or when
// collectors/ or routines/ contribute none (a pack that shipped without
// them is broken in a way doctor would not notice).
//
// pack-runtime.sh runs it on the staged pack before tarring it, and CI runs
// it on the built checkout: a pack whose packed code and packed manifests
// disagree never becomes a release asset. (It was suspected, and ruled out,
// on 2026-09-27: the 0.14.0 pack validates all 26 of its manifests. The
// "schedule: expected string, received object" rows that upgrade printed
// came from 0.12.0's CLI, which ran the update and its closing doctor.)

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The roots that must each contribute at least one manifest. */
export const REQUIRED_ROOTS = ["collectors", "routines"];

/**
 * `{ found, invalid, missingRoots }` for one product dir, from its own
 * built doctor. Throws when there is no built CLI to ask.
 */
export async function checkPackManifests(dir) {
  const doctorJs = join(dir, "packages", "cli", "dist", "doctor.js");
  if (!existsSync(doctorJs)) throw new Error(`no built CLI at ${doctorJs} — build (or pack) first`);
  const { walkManifests } = await import(pathToFileURL(doctorJs).href);
  if (typeof walkManifests !== "function") throw new Error(`${doctorJs} does not export walkManifests`);
  const found = await walkManifests(dir);
  const invalid = found.filter((m) => !m.result.ok).map((m) => ({ dir: m.dir, errors: m.result.errors }));
  const missingRoots = REQUIRED_ROOTS.filter((root) => !found.some((m) => m.dir.startsWith(`${root}/`)));
  return { found: found.length, invalid, missingRoots };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write("usage: check-pack-manifests.mjs <product-dir>\n");
    process.exit(2);
  }
  const dir = resolve(arg);
  let r;
  try {
    r = await checkPackManifests(dir);
  } catch (err) {
    process.stderr.write(`check-pack-manifests: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  for (const m of r.invalid) process.stderr.write(`check-pack-manifests: ${m.dir}/manifest.yaml: ${m.errors.join("; ")}\n`);
  for (const root of r.missingRoots) process.stderr.write(`check-pack-manifests: ${root}/ contributed no manifest\n`);
  const ok = r.invalid.length === 0 && r.missingRoots.length === 0;
  process.stdout.write(`check-pack-manifests: ${dir} — ${r.found} manifest(s), ${r.invalid.length} invalid${ok ? "" : " — FAILED"}\n`);
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
