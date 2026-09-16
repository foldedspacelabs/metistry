#!/usr/bin/env node
// Audit of unwired limits (plan-refresh R4, rivet review ADOPT 4).
//
// A cap that lives only as a literal is a decision nobody can change without a
// release: the operator hits it, reads the number in a stack trace, and has
// nowhere to put a different one. Invariant 5's instinct — everything is a
// directory with a manifest, CI validates — applied to the numbers.
//
// So every limit-shaped constant under apps/**/src and packages/**/src must be
// one of two things, and say which:
//
//   * READ FROM CONFIG — the identifier appears in an `intEnv(…)`,
//     `optionalEnv(…)`, `requireEnv(…)`, `process.env…` or a `compute.yaml`
//     read: in the same file for a file-local constant, anywhere in the tree
//     for an exported one, since the whole point of exporting a
//     `DEFAULT_*` is that another package reads it as `intEnv`'s fallback.
//     The literal is then a documented default, which is what we want.
//   * FIXED ON PURPOSE — annotated `// limit: fixed — <reason>` on the line or
//     the line above. Plenty of numbers should be fixed (a protocol's frame
//     size, an HTTP status, a backoff the supervisor's own tests pin); the
//     annotation is the difference between "decided" and "never thought
//     about".
//
// No dependencies: plain fs recursion + regex, like prompt-lint.mjs next door.
// `--json` prints the findings as an array instead of the human list.
//
// Exits 1 with `file:line: NAME = value` per unwired constant; 0 when clean.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

/** Roots to scan: the shipped source of every app and package. Tests, fixtures and build output are not policy. */
const SCAN = ["apps", "packages"];
const SRC_SEGMENT = `${sep}src${sep}`;
const SKIP = new Set(["node_modules", "dist", ".build", "test", "tests", "__fixtures__"]);

/** An identifier is limit-shaped when it names a bound. */
const LIMIT_NAME = /(^|_)(MAX|MIN)(_|$)|_LIMIT|^LIMIT|TIMEOUT|RETRIES|RETRY|BACKOFF|BUDGET|(^|_)CAP(_|$)|max|limit|timeout|retries|budget|cap/;

/**
 * `const NAME = 123;` / `const NAME = 30_000;` / `const NAME = 1.5;`, with an
 * optional `as const` or type annotation. Deliberately only NAMED constants —
 * an inline `slice(0, 10)` is not a policy knob and flagging it would drown
 * the signal.
 */
const DECL = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(-?\d[\d_]*(?:\.\d+)?)\s*(?:as\s+const\s*)?;/;

/** Milliseconds/seconds arithmetic counts too: `const X = 30 * 1000;`. */
const DECL_ARITH = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(-?\d[\d_]*(?:\.\d+)?(?:\s*\*\s*\d[\d_]*)+)\s*;/;

/** The annotation that makes a fixed limit a decision: `// limit: fixed — <reason>`. */
const ANNOTATION = /\/\/\s*limit:\s*fixed\s*[—-]\s*\S/;

/** What reading config looks like: core's three helpers, a raw `process.env`, or a `compute.yaml` value. */
const CONFIG_READ = /\b(?:intEnv|optionalEnv|requireEnv)\s*\(|\bprocess\.env\b|\bcompute\.yaml\b|\bcomputeConfig\b/;

/** A constant earns its place when some line mentions it AND reads config — `intEnv("METISTRY_X", NAME)`, in either order. */
function wiredIn(name, haystack) {
  const mentions = new RegExp(`\\b${name}\\b`);
  return haystack.split("\n").some((line) => mentions.test(line) && CONFIG_READ.test(line));
}

/** Every file under `dir` (relative to ROOT), skipping build output and tests. */
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const rel = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...walk(rel));
    } else if (/\.ts$/.test(e.name) && !/\.(test|spec|d)\.ts$/.test(e.name)) {
      out.push(rel);
    }
  }
  return out;
}

/** Files to audit: the TypeScript under an app's or a package's `src/`, nothing above it. */
function targets() {
  return SCAN.flatMap((r) => walk(r))
    .filter((p) => p.includes(SRC_SEGMENT))
    .sort();
}

/**
 * The unwired limit-shaped constants in one file's text.
 *
 * `corpus` is every scanned file concatenated: an EXPORTED constant is the
 * documented default of a knob read somewhere else — `DEFAULT_MAX_STREAK`
 * lives in `packages/core` and is read by `intEnv("METISTRY_RUNNER_MAX_STREAK",
 * DEFAULT_MAX_STREAK)` in two other packages — so exported names are looked up
 * across the whole tree and file-local ones only in their own file.
 */
export function findUnwiredLimits(text, file = "<text>", corpus = text) {
  const lines = text.split("\n");
  const hits = [];
  lines.forEach((line, i) => {
    const m = DECL.exec(line) ?? DECL_ARITH.exec(line);
    if (!m) return;
    const [, name, value] = m;
    if (!LIMIT_NAME.test(name)) return;
    if (ANNOTATION.test(line) || ANNOTATION.test(lines[i - 1] ?? "")) return;
    const haystack = /^\s*export\s+const\b/.test(line) ? corpus : text;
    if (wiredIn(name, haystack)) return;
    hits.push({ file, line: i + 1, name, value: value.trim() });
  });
  return hits;
}

const json = process.argv.includes("--json");
const files = targets().map((rel) => ({ rel: relative(".", rel), text: readFileSync(join(ROOT, rel), "utf8") }));
const corpus = files.map((f) => f.text).join("\n");
const findings = files.flatMap((f) => findUnwiredLimits(f.text, f.rel, corpus));

if (json) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  for (const f of findings) {
    console.error(`${f.file}:${f.line}: ${f.name} = ${f.value} — not read from config and not annotated; wire it through intEnv() with this as the default, or write \`// limit: fixed — <reason>\``);
  }
}

if (findings.length > 0) {
  if (!json) console.error(`\naudit-limits: ${findings.length} unwired limit(s)`);
  process.exit(1);
}
