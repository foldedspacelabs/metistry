// The budget check in ops/scripts/check-tool-surface.mjs, exercised two ways —
// the same shape as audit-limits.test.mjs next door: its pure exports against
// hand-written inputs (what counts as a bridge, what counts as over), and the
// script as a child process against a throwaway tree with fake bridges in it
// (what CI actually runs, including a bridge that really does export
// `toolSurface()`).
//
// Run: node --test ops/scripts/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findingsFor, headroomOf, MAX_DEFINITION_TOKENS, MAX_EAGER_TOOLS, measure, parseBridgeManifest } from "../check-tool-surface.mjs";

const scriptSrc = fileURLToPath(new URL("../check-tool-surface.mjs", import.meta.url));

const bridge = (over = {}) => ({ bridge: "b", dir: "packages/b", discovery: "eager", declared: 3, measured: true, tools: 3, chars: 400, tokens: 100, ...over });

test("a bridge manifest yields its name, its discovery mode and its declared tools", () => {
  const m = parseBridgeManifest(
    ["name: brainy", "type: bridge", "discovery: eager         # 3 tools — under the line", "exposes:", "  - name: alpha", "    description: a", "  - name: beta", "  - name: gamma", "    destructive: true", ""].join("\n"),
  );
  assert.deepEqual(m, { name: "brainy", discovery: "eager", declared: ["alpha", "beta", "gamma"] });
});

test("discovery defaults to eager, like the schema's own default", () => {
  assert.equal(parseBridgeManifest("name: b\ntype: bridge\nexposes:\n  - name: alpha\n").discovery, "eager");
  assert.equal(parseBridgeManifest("name: b\ntype: bridge\ndiscovery: lazy\nexposes:\n  - name: alpha\n").discovery, "lazy");
});

test("anything that is not a bridge is not this check's business", () => {
  for (const type of ["collector", "routine", "target", "service"]) {
    assert.equal(parseBridgeManifest(`name: x\ntype: ${type}\nschedule: "@hourly"\n`), null);
  }
});

test("measure counts chars/4, the same rule of thumb the bridge's own test counts in", () => {
  const tools = [{ name: "alpha", description: "does a thing", inputSchema: { type: "object", properties: {} } }];
  const m = measure(tools);
  assert.equal(m.tools, 1);
  assert.equal(m.chars, JSON.stringify(tools).length);
  assert.equal(m.tokens, Math.ceil(m.chars / 4));
  assert.deepEqual(measure([]), { tools: 0, chars: 2, tokens: 1 });
});

test("under both lines: nothing to say", () => {
  assert.deepEqual(findingsFor([bridge()]), []);
});

test("past the token line, an eager bridge fails and is told both ways out", () => {
  const [f] = findingsFor([bridge({ tokens: MAX_DEFINITION_TOKENS + 1 })]);
  assert.match(f.reason, /definition tokens is past/);
  assert.match(f.reason, /discovery: lazy/);
  assert.equal(findingsFor([bridge({ tokens: MAX_DEFINITION_TOKENS })]).length, 0); // the line is ">", not "≥"
});

test("a lazy bridge has already made the decision the budget exists to force", () => {
  assert.deepEqual(findingsFor([bridge({ discovery: "lazy", tokens: 50_000, tools: 300 })]), []);
});

test("past the tool line: a fail, unless the number is the acknowledged one", () => {
  const over = bridge({ tools: MAX_EAGER_TOOLS + 1 });
  assert.match(findingsFor([over]).at(0).reason, /this is the lazy decision/);
  assert.deepEqual(findingsFor([over], { b: MAX_EAGER_TOOLS + 1 }), []); // acknowledged: it may sit here
  // …and the very next tool is the decision, by construction
  const grown = findingsFor([bridge({ tools: MAX_EAGER_TOOLS + 2 })], { b: MAX_EAGER_TOOLS + 1 });
  assert.equal(grown.length, 1);
  assert.match(grown[0].reason, /past the 21 acknowledged/);
});

test("an unbuilt bridge is an error, not a pass", () => {
  const [f] = findingsFor([{ bridge: "b", discovery: "eager", error: "packages/b/dist/index.js is missing — run `pnpm -r build` before this check" }]);
  assert.match(f.reason, /pnpm -r build/);
});

test("headroom names the room left on each axis, and says when one is spent", () => {
  assert.equal(headroomOf(bridge()), `${MAX_DEFINITION_TOKENS - 100} tokens, ${MAX_EAGER_TOOLS - 3} tools`);
  assert.equal(headroomOf(bridge({ tokens: null })), `${MAX_EAGER_TOOLS - 3} tools`); // declared-only: no token number to report
  assert.equal(headroomOf(bridge({ tools: 25 }), { b: 25 }), "4900 tokens, 5 tools OVER (acknowledged 25)");
  assert.equal(headroomOf(bridge({ discovery: "lazy" })), "—");
});

// ---- the script, as CI runs it -------------------------------------------

/** A throwaway tree with the script in place, so it resolves ROOT the way CI does. */
function fixture(bridges) {
  const root = mkdtempSync(join(tmpdir(), "check-tool-surface-"));
  mkdirSync(join(root, "ops/scripts"), { recursive: true });
  cpSync(scriptSrc, join(root, "ops/scripts/check-tool-surface.mjs"));
  for (const [name, b] of Object.entries(bridges)) {
    const dir = join(root, "packages", name);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "manifest.yaml"), `name: ${name}\ntype: bridge\ndiscovery: ${b.discovery ?? "eager"}\nexposes:\n${(b.declared ?? ["alpha"]).map((t) => `  - name: ${t}\n`).join("")}`);
    if (b.pkg !== false) writeFileSync(join(dir, "package.json"), JSON.stringify({ name, type: "module", main: "./dist/index.js" }));
    if (b.surface) writeFileSync(join(dir, "dist/index.js"), `export async function toolSurface() { return ${JSON.stringify(b.surface)}; }\n`);
    else if (b.built !== false) writeFileSync(join(dir, "dist/index.js"), `export const check = async () => ({ status: "ok" });\n`);
  }
  return root;
}

const tool = (i, schemaChars) => ({ name: `tool_${i}`, description: "d", inputSchema: { type: "object", properties: { p: { type: "string", description: "x".repeat(schemaChars) } } } });
const run = (root, ...args) => spawnSync(process.execPath, [join(root, "ops/scripts/check-tool-surface.mjs"), ...args], { encoding: "utf8" });

test("a bridge that exports toolSurface() is MEASURED, and the table prints its numbers", () => {
  const surface = [tool(1, 40), tool(2, 40)];
  const r = run(fixture({ small: { surface, declared: ["tool_1", "tool_2"] } }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /small/);
  assert.match(r.stdout, new RegExp(`\\b${Math.ceil(JSON.stringify(surface).length / 4)}\\b`)); // the real measurement, not the manifest's count
  assert.equal(r.stderr, "");
});

test("a bridge with no toolSurface() is reported declared-only rather than guessed at", () => {
  const r = run(fixture({ rest: { declared: ["list_events", "create_event"] } }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /rest\s+2 \(declared\)\s+n\/a/);
});

test("an eager bridge past the token line fails the run, naming itself", () => {
  const fat = Array.from({ length: 12 }, (_, i) => tool(i, 1800)); // ≈ 5.5k tokens
  const r = run(fixture({ fat: { surface: fat, declared: fat.map((t) => t.name) } }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^\nfat: \d+ definition tokens is past the manifest schema's >5000 line/m);
  assert.match(r.stderr, /check-tool-surface: 1 bridge\(s\) past the budget/);
});

test("an unbuilt bridge fails with the command that fixes it", () => {
  const r = run(fixture({ unbuilt: { built: false } }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dist\/index\.js is missing — run `pnpm -r build`/);
});

test("--json prints the rows and the findings instead of the table", () => {
  const r = run(fixture({ rest: { declared: ["a", "b"] } }), "--json");
  assert.equal(r.status, 0, r.stderr);
  const { rows, findings } = JSON.parse(r.stdout);
  assert.deepEqual(findings, []);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { bridge: "rest", dir: join("packages", "rest"), discovery: "eager", declared: 2, measured: false, tools: 2, chars: null, tokens: null });
});
