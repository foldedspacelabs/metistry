#!/usr/bin/env node
// The definition-token budget, checked generically (docs/research/2026-08-tool-discovery.md
// §4: "CI warns when an eager bridge crosses it").
//
// `packages/core/src/manifest.ts` states the rule — `discovery: eager` is the
// default and `lazy` "is for bridges past >20 tools / >5k definition tokens" —
// but until now only mcp-brain's own test enforced it, on itself. A second
// bridge could cross the line in silence, and the surface every turn pays for
// is the SUM of the bridges mounted, not any one of them.
//
// So: for every bridge manifest under apps/ and packages/, print what its tool
// surface actually costs, and fail when an EAGER bridge is past the budget.
//
// How a bridge gets measured. It exports `toolSurface()` from its package
// entry — the same instinct as `check()` (CLAUDE.md: "every bridge and
// collector exports check() so `metistry doctor` is generic"), so this script
// needs no per-bridge knowledge and a new bridge is measured the day it ships.
// `packages/mcp-brain/src/surface.ts` is the reference implementation: it
// stands up the real server and reads a real `tools/list`, so the numbers are
// production's definitions rather than a snapshot that goes stale.
//
// A bridge with no such export (eventkit and apple-fm are REST surfaces
// reached by the router and collectors, never listed to a model) is reported
// DECLARED-ONLY: its manifest's `exposes:` count is still checked, and its
// token cost is `n/a` rather than a guess.
//
// Run after a build — `pnpm -r build` — since it imports what each bridge
// ships. An unbuilt bridge is an error, not a pass: a check that quietly
// degrades to "nothing to measure" is not a check.
//
// No dependencies: plain fs recursion + regex over the manifest fields this
// needs, like prompt-lint.mjs and audit-limits.mjs next door. `--json` prints
// the per-bridge rows instead of the table.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..", "..");

/** Where bridges live. Collectors, routines and targets expose no tools to a model. */
const SCAN = ["apps", "packages"];
const SKIP = new Set(["node_modules", "dist", ".build", "test", "tests", "__fixtures__"]);

/**
 * The manifest schema's own two lines (`packages/core/src/manifest.ts`:
 * "lazy is for bridges past >20 tools / >5k definition tokens"). `chars / 4`
 * is the industry's rule of thumb and the one `packages/mcp-brain`'s own test
 * has always counted in, so the two agree by construction.
 */
export const MAX_EAGER_TOOLS = 20;
export const MAX_DEFINITION_TOKENS = 5000;

/**
 * Bridges knowingly over the TOOL-COUNT line, with the number that was
 * acknowledged. The count axis is guidance about *strategy* — past it, lazy
 * discovery is the thing to consider — while the token axis is the budget; and
 * mcp-brain's manifest has carried "noted, not acted on" for the count since
 * 0016, because its definition tokens are what actually gate lazy.
 *
 * Recording it here rather than waiving it makes the next tool a DECISION:
 * a bridge may sit at its acknowledged number, and the tool after that fails
 * this check until somebody either trims the surface or switches the manifest
 * to `discovery: lazy`. That is what mcp-brain's manifest already promises in
 * prose ("the NEXT tool registered here forces the lazy decision"), and what
 * the owner asked for on 2026-09-19: "we're getting pretty close to the
 * performance impact number based on the number of tools we have now and that
 * number is likely to grow … we should handle this contradiction on tool pool
 * size" (docs/research/2026-09-19-code-mode-mcp.md §5, Q3).
 */
export const COUNT_ACKNOWLEDGED = { brain: 25 };

// ---- manifests -----------------------------------------------------------

/**
 * The three fields this needs, read without a YAML parser: the type, the
 * discovery mode, and the declared tool names. Top-level keys only — a `name:`
 * indented under `exposes:` is a tool, the one in column 0 is the bridge.
 */
export function parseBridgeManifest(text) {
  const top = (key) => text.match(new RegExp(`^${key}:[ \\t]*([^\\n#]*)`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (top("type") !== "bridge") return null;
  const exposes = text.slice(text.search(/^exposes:/m) + 1);
  const declared = [...exposes.matchAll(/^[ \t]+-[ \t]+name:[ \t]*([^\n#]*)/gm)].map((m) => m[1].trim().replace(/^["']|["']$/g, ""));
  return { name: top("name") ?? "", discovery: top("discovery") ?? "eager", declared };
}

/** Every manifest.yaml under the scanned roots, skipping build output and test trees. */
function manifests(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw err;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const rel = join(dir, e.name);
    if (e.isDirectory()) manifests(rel, out);
    else if (e.name === "manifest.yaml") out.push(rel);
  }
  return out;
}

// ---- measurement ---------------------------------------------------------

/** What one `tools/list` costs. `chars / 4` throughout, as above. */
export function measure(tools) {
  const chars = JSON.stringify(tools).length;
  return { tools: tools.length, chars, tokens: Math.ceil(chars / 4) };
}

/** A package's entry point, from its package.json `main` (default `dist/index.js`). */
function entryOf(dir) {
  const pkgPath = join(ROOT, dir, "package.json");
  if (!existsSync(pkgPath)) return null;
  const main = JSON.parse(readFileSync(pkgPath, "utf8")).main ?? "./dist/index.js";
  return join(ROOT, dir, main);
}

/**
 * One bridge's row: measured from its own `toolSurface()` when it has one,
 * declared-only when it does not, and an ERROR when it ships an entry point
 * that has not been built.
 */
export async function inspect(manifestRel) {
  const dir = manifestRel.split(sep).slice(0, -1).join(sep);
  const manifest = parseBridgeManifest(readFileSync(join(ROOT, manifestRel), "utf8"));
  if (!manifest) return null;
  const row = { bridge: manifest.name, dir, discovery: manifest.discovery, declared: manifest.declared.length, measured: false, tools: manifest.declared.length, chars: null, tokens: null };
  const entry = entryOf(dir);
  if (entry === null) return row; // no package of its own (a Swift bridge, an app): the manifest is all there is
  if (!existsSync(entry)) return { ...row, error: `${entry.slice(ROOT.length + 1)} is missing — run \`pnpm -r build\` before this check` };
  // Look before importing: a bridge that exports no surface should not be
  // loaded at all, since importing somebody's entry point to find out is a
  // side effect this has no business causing.
  const types = entry.replace(/\.js$/, ".d.ts");
  const declaresSurface = [entry, ...(existsSync(types) ? [types] : [])].some((f) => /\btoolSurface\b/.test(readFileSync(f, "utf8")));
  if (!declaresSurface) return row;
  const { toolSurface } = await import(pathToFileURL(entry).href);
  if (typeof toolSurface !== "function") return row;
  const list = await toolSurface();
  return { ...row, measured: true, ...measure(list) };
}

// ---- the budget ----------------------------------------------------------

/**
 * Why a row fails. A `lazy` bridge has already made the decision the budget
 * exists to force, so the budget does not bind on it.
 */
export function findingsFor(rows, acknowledged = COUNT_ACKNOWLEDGED) {
  const out = [];
  for (const r of rows) {
    if (r.error) {
      out.push({ bridge: r.bridge, reason: r.error });
      continue;
    }
    if (r.discovery !== "eager") continue;
    if (r.tokens !== null && r.tokens > MAX_DEFINITION_TOKENS) {
      out.push({
        bridge: r.bridge,
        reason:
          `${r.tokens} definition tokens is past the manifest schema's >${MAX_DEFINITION_TOKENS} line ` +
          `(packages/core/src/manifest.ts) — trim the surface, or set \`discovery: lazy\` and mean it (docs/research/2026-08-tool-discovery.md)`,
      });
    }
    const ceiling = acknowledged[r.bridge];
    if (r.tools > MAX_EAGER_TOOLS && !(ceiling !== undefined && r.tools <= ceiling)) {
      out.push({
        bridge: r.bridge,
        reason:
          `${r.tools} eager tools is past the manifest schema's >${MAX_EAGER_TOOLS} line` +
          (ceiling === undefined
            ? ` — this is the lazy decision (docs/research/2026-08-tool-discovery.md §4)`
            : `, and past the ${ceiling} acknowledged in ops/scripts/check-tool-surface.mjs — the next tool was always going to force the lazy decision; make it, or move the ceiling with a reason`),
      });
    }
  }
  return out;
}

/** How much room is left on each axis, in words, so the number is read rather than inferred. */
export function headroomOf(row, acknowledged = COUNT_ACKNOWLEDGED) {
  if (row.error || row.discovery !== "eager") return "—";
  const tokens = row.tokens === null ? null : `${MAX_DEFINITION_TOKENS - row.tokens} tokens`;
  const over = row.tools - MAX_EAGER_TOOLS;
  const tools = over > 0 ? `${over} tools OVER (acknowledged ${acknowledged[row.bridge] ?? "—"})` : `${-over} tools`;
  return [tokens, tools].filter(Boolean).join(", ");
}

/** The human table: per-bridge numbers, so the headroom is visible rather than implied. */
function render(rows) {
  const cell = (r) => ({
    bridge: r.bridge,
    tools: r.error ? "?" : `${r.tools}${r.measured ? "" : " (declared)"}`,
    tokens: r.error ? "?" : r.tokens === null ? "n/a" : String(r.tokens),
    headroom: headroomOf(r),
  });
  const cells = rows.map(cell);
  const head = { bridge: "bridge", tools: "tools", tokens: "≈tokens", headroom: "headroom to the line" };
  const width = (k) => Math.max(head[k].length, ...cells.map((c) => c[k].length));
  const line = (c, pad = " ") => `  ${["bridge", "tools", "tokens", "headroom"].map((k) => c[k].padEnd(width(k), pad)).join("  ")}`.trimEnd();
  console.log(`tool surface (budget: >${MAX_EAGER_TOOLS} tools / >${MAX_DEFINITION_TOKENS} definition tokens — packages/core/src/manifest.ts)\n`);
  console.log(line(head));
  console.log(line({ bridge: "", tools: "", tokens: "", headroom: "" }, "-"));
  for (const [i, c] of cells.entries()) console.log(`${line(c)}${rows[i].discovery === "eager" ? "" : `  [discovery: ${rows[i].discovery}]`}`);
}

// Run as a script, not when imported by its test. `realpathSync` because the
// module URL is the resolved path and argv[1] need not be — /var is a symlink
// to /private/var on macOS, which is where a test's throwaway tree lands.
if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const rows = (await Promise.all(SCAN.flatMap((r) => manifests(r)).sort().map(inspect))).filter((r) => r !== null);
  const findings = findingsFor(rows);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ rows, findings }, null, 2));
  else render(rows);
  for (const f of findings) console.error(`\n${f.bridge}: ${f.reason}`);
  if (findings.length > 0) {
    if (!process.argv.includes("--json")) console.error(`\ncheck-tool-surface: ${findings.length} bridge(s) past the budget`);
    process.exit(1);
  }
}
