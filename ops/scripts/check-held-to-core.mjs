#!/usr/bin/env node
// The "held to core" Swift tests cannot drift (X-100).
//
// The Mac app carries a few of core's decisions over by hand — the autonomy
// arithmetic (`AgentAutonomy`), the key-shape check (`KeyShape`) — and says in
// its tests that it is "held to core". A test that holds the copy to core with
// cases typed a second time passes until someone recopies them. So the cases
// live ONCE, in packages/core/test/held-to-core/*.json: core's tests run each
// through the real function, the Swift tests run the same file through the
// copy. This check is what keeps that true:
//
//   * every fixture is valid JSON and is read by a core test AND a Swift test
//     (so neither side can quietly stop reading it and keep a copy of its own);
//   * every `HeldToCore.cases("x")` in the Swift tests names a fixture that
//     exists (a typo would otherwise be a runtime failure on a Mac only);
//   * ci.yml's change filter runs the macos-app job when a fixture changes — a
//     case edited in core's directory alone must still fail the Swift copy
//     before it merges, and a skipped job is not a failure.
//
//   node ops/scripts/check-held-to-core.mjs   exit 1 with one line per problem
//
// No dependency: node's fs and path only.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = "packages/core/test/held-to-core";
export const CORE_TESTS = "packages/core/test";
export const SWIFT_TESTS = "apps/macos/tests/kit";
export const WORKFLOW = ".github/workflows/ci.yml";
/** The loader itself names fixtures; only a TEST reading one counts as holding the copy to it. */
const LOADER = "held-to-core.swift";

const filesIn = (dir, test) => (existsSync(dir) ? readdirSync(dir).filter(test) : []);

/** Everything the CLI prints, for a checkout rooted at `root`. */
export function run(root) {
  const problems = [];
  const fixtures = filesIn(join(root, FIXTURES), (f) => f.endsWith(".json")).sort();
  if (fixtures.length === 0) return { ok: false, lines: [`${FIXTURES}: no fixtures — the cases core and the Mac app are both held to live there`] };

  const coreTests = filesIn(join(root, CORE_TESTS), (f) => /\.test\.ts$/.test(f)).map((f) => readFileSync(join(root, CORE_TESTS, f), "utf8"));
  const swiftTests = filesIn(join(root, SWIFT_TESTS), (f) => f.endsWith(".swift") && f !== LOADER).map((f) => readFileSync(join(root, SWIFT_TESTS, f), "utf8"));

  const names = new Set();
  for (const file of fixtures) {
    const name = file.replace(/\.json$/, "");
    names.add(name);
    try {
      JSON.parse(readFileSync(join(root, FIXTURES, file), "utf8"));
    } catch (e) {
      problems.push(`${FIXTURES}/${file}: not valid JSON — ${e.message}`);
    }
    if (!coreTests.some((t) => t.includes(`held-to-core/${file}`))) {
      problems.push(`${FIXTURES}/${file}: no core test reads it — a case only the Mac runs is not core's`);
    }
    if (!swiftTests.some((t) => t.includes(`"${name}"`))) {
      problems.push(`${FIXTURES}/${file}: no Swift test under ${SWIFT_TESTS}/ reads it (HeldToCore.cases("${name}")) — the copy would be held to nothing`);
    }
  }

  const used = new Set();
  for (const text of swiftTests) for (const m of text.matchAll(/HeldToCore\.cases\(\s*"([^"]+)"\s*\)/g)) used.add(m[1]);
  for (const name of used) if (!names.has(name)) problems.push(`${SWIFT_TESTS}: HeldToCore.cases("${name}") names no fixture in ${FIXTURES}/`);

  const workflow = join(root, WORKFLOW);
  const filter = existsSync(workflow) ? readFileSync(workflow, "utf8").split("\n").find((l) => l.includes("grep -qE") && l.includes("apps/macos/")) : undefined;
  if (!filter) problems.push(`${WORKFLOW}: cannot find the change filter that decides whether macos-app runs`);
  else if (!filter.includes(`${FIXTURES}/`)) problems.push(`${WORKFLOW}: the macos-app filter does not include ${FIXTURES}/ — a case changed in core would not run the Swift copy`);

  if (problems.length) return { ok: false, lines: [...problems, "", `held to core: ${problems.length} problem(s) — see the header of ops/scripts/check-held-to-core.mjs`] };
  return { ok: true, lines: [`held to core: ok — ${fixtures.length} fixtures (${[...names].join(", ")}), each read by a core test and a Swift test`] };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { ok, lines } = run(root);
  (ok ? console.log : console.error)(lines.join("\n"));
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
