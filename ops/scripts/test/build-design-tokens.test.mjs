// Decision 19's checks in ops/scripts/build-design-tokens.mjs, exercised the
// way CI runs them: the script is copied into a throwaway tree beside a
// tokens.json, a web stylesheet, design SVGs and Swift sources, run once to
// generate its outputs, then run with --check as a child process.
//
// Run: node --test ops/scripts/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptSrc = fileURLToPath(new URL("../build-design-tokens.mjs", import.meta.url));
const realTokens = JSON.parse(readFileSync(new URL("../../../docs/product/design/tokens.json", import.meta.url), "utf8"));
const BEGIN = "/* === BEGIN TOKENS — generated from tokens.json by ops/scripts/build-design-tokens.mjs === */";
const END = "/* === END TOKENS === */";

// Everything here is a token or is not a colour at all: an id selector, an
// anchor, a url() reference, an entity and "#418" in prose.
const CLEAN_CSS = `body { color: var(--mt-color-text-primary); background: var(--mt-color-bg); }
#feed-list { background: var(--mt-color-surface); border: 1px solid #E4DED1; }
.chip.ok { color: var(--mt-color-ok); background: var(--mt-color-ok-quiet); }
`;
const CLEAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg">
  <style>text { fill: #1a1815 } .card > .row { fill: #fffdf8; stroke: #e4ded1 }</style>
  <a href="#feed"><rect fill="#125F6B" stroke="url(#ramp)" style="stop-color: #6ec9d6"/></a>
  <text>PR #418 &#123; landed</text>
</svg>
`;

/** A throwaway tree with the script in place, so it resolves its root the way CI does. */
function fixture({ tokens = realTokens, css = CLEAN_CSS, svgs = { "mac-x.svg": CLEAN_SVG }, swift = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "design-tokens-"));
  for (const d of ["ops/scripts", "docs/product/design", "apps/console/web", "apps/macos/sources/kit"]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  cpSync(scriptSrc, join(root, "ops/scripts/build-design-tokens.mjs"));
  writeFileSync(join(root, "docs/product/design/tokens.json"), JSON.stringify(tokens, null, 2));
  writeFileSync(join(root, "docs/product/design/preview.html"), `<style>\n${BEGIN}\n${END}\n</style>\n`);
  writeFileSync(join(root, "apps/console/web/style.css"), css);
  for (const [name, body] of Object.entries(svgs)) writeFileSync(join(root, "docs/product/design", name), body);
  for (const [path, body] of Object.entries(swift)) {
    mkdirSync(dirname(join(root, "apps/macos/sources", path)), { recursive: true });
    writeFileSync(join(root, "apps/macos/sources", path), body);
  }
  return root;
}

const run = (root, ...args) =>
  spawnSync(process.execPath, [join(root, "ops/scripts/build-design-tokens.mjs"), ...args], { encoding: "utf8" });
/** Generate, then --check: what a contributor runs and then what CI runs. */
const check = (opts) => {
  const root = fixture(opts);
  run(root);
  return run(root, "--check");
};
/** A deep copy of the real tokens with one change applied. */
const tokensWith = (edit) => {
  const t = structuredClone(realTokens);
  edit(t.color);
  return t;
};

test("a clean tree passes; selectors, anchors, url() references, entities and prose are not colours", () => {
  const r = check();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^design tokens: ok \(\d+ pairs checked; 2 painted pairs declared; 6 hex colours in 1 SVGs and 1 stylesheet\(s\) are tokens; accent pinned\)$/m);
});

test("a stray hex in a design SVG fails the check — attribute, style=\"\" and <style> alike", () => {
  const svg = `<svg>
  <style>.win { fill: #f6f7f9 }</style>
  <rect fill="#123456"/>
  <rect style="fill: #abcdef; stroke: #fffdf8"/>
</svg>
`;
  const r = check({ svgs: { "mac-x.svg": svg } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[stray hex\] docs\/product\/design\/mac-x\.svg: 3 colour\(s\) that are not a token's value — #f6f7f9 \(line 2\), #123456 \(line 3\), #abcdef \(line 4\)/);
  assert.doesNotMatch(r.stderr, /#fffdf8/);
});

test("a stray hex in the web CSS fails the check; an id selector does not", () => {
  const r = check({ css: `${CLEAN_CSS}.art-frame { background: #7a3b3b; }\n#feed-filter { display: flex; }\n` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[stray hex\] apps\/console\/web\/style\.css: 1 colour\(s\) that are not a token's value — #7a3b3b \(line 4\)/);
  assert.doesNotMatch(r.stderr, /#feed/);
});

test("an undeclared painted pair fails the check", () => {
  const css = `${CLEAN_CSS}.chip.hint {\n  background: var(--mt-color-ok-quiet);\n  color: var(--mt-color-text-tertiary);\n}\n`;
  const r = check({ css });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[painted pair\] apps\/console\/web\/style\.css:6: `\.chip\.hint` paints text-tertiary on ok-quiet, a pair tokens\.json does not declare/);
});

test("a pair declared for a glyph only does not cover text painted with color:", () => {
  const tokens = tokensWith((c) => c.ok.contrast.push({ on: "accent-quiet", as: "glyph" }));
  const css = `${CLEAN_CSS}.row.selected .state { color: var(--mt-color-ok); background: var(--mt-color-accent-quiet); }\n`;
  const r = check({ tokens, css });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /paints ok as text on accent-quiet, which is declared for a glyph only \(3:1\); text needs 4\.5:1/);
});

test("a glyph is held to 3:1 and text to 4.5:1 on the same ground", () => {
  // ok on accent-quiet is 4.12:1 in light mode: a legal mark, illegible words.
  const asGlyph = check({ tokens: tokensWith((c) => c.ok.contrast.push({ on: "accent-quiet", as: "glyph" })) });
  assert.equal(asGlyph.status, 0, asGlyph.stderr);
  const asText = check({ tokens: tokensWith((c) => c.ok.contrast.push("accent-quiet")) });
  assert.equal(asText.status, 1);
  assert.match(asText.stderr, /ok on accent-quiet \(light\) = 4\.12:1, needs 4\.5:1/);
});

test("a quiet fill that its ink does not declare as a ground fails the check", () => {
  const tokens = tokensWith((c) => {
    c.ok.contrast = c.ok.contrast.filter((g) => g !== "ok-quiet");
  });
  const r = check({ tokens });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[quiet fill\] tokens\.json: ok-quiet is the fill ok is painted on, but ok's contrast does not declare "ok-quiet" as text/);
});

test("a declared ground that is not a role fails rather than crashing", () => {
  const r = check({ tokens: tokensWith((c) => c.ok.contrast.push("ok-qiuet")) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[contrast\] tokens\.json: ok declares a ground `ok-qiuet` that is not a colour role/);
});

test("accent mapped to the system accent in tokens.json fails the check", () => {
  const r = check({ tokens: tokensWith((c) => (c.accent.apple = "controlAccentColor / tintColor")) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[accent\] tokens\.json: accent\.apple maps to the system accent/);
});

test("an accent that is not a #rrggbb literal fails the check", () => {
  const r = check({ tokens: tokensWith((c) => (c.accent.dark = "rgba(110, 201, 214, 1)")) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[accent\] tokens\.json: accent\.dark is "rgba\(110, 201, 214, 1\)"; the pinned accent is a #rrggbb literal/);
});

test("Swift that reads the system accent fails; a comment or a string that names it does not", () => {
  const swift = {
    "app/row.swift": "import SwiftUI\n\nlet selection = Color(nsColor: NSColor.controlAccentColor)\nlet tint = Color.accentColor\n",
    "kit/notes.swift": '// never NSColor.controlAccentColor — the accent is pinned\nlet why = "Color.accentColor follows the user\'s setting"\n',
  };
  const r = check({ swift });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[accent\] apps\/macos\/sources\/app\/row\.swift:3: controlAccentColor reads the system accent/);
  assert.match(r.stderr, /\[accent\] apps\/macos\/sources\/app\/row\.swift:4: accentColor reads the system accent/);
  assert.doesNotMatch(r.stderr, /notes\.swift/);
});

test("the web CSS may not paint with the system AccentColor", () => {
  const r = check({ css: `${CLEAN_CSS}.focus { outline-color: AccentColor; }\n` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[accent\] apps\/console\/web\/style\.css:4: `\.focus` paints with the system AccentColor/);
});

test("a var() naming a role tokens.json does not have fails — a dropped role cannot linger", () => {
  const r = check({ css: `${CLEAN_CSS}.approve { background: var(--mt-color-affirmative); color: var(--mt-color-on-affirmative); }\n` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[unknown role\] apps\/console\/web\/style\.css:4: --mt-color-affirmative is not a colour role/);
  assert.match(r.stderr, /--mt-color-on-affirmative is not a colour role/);
});

test("one run reports every problem, not just the first", () => {
  const r = check({
    css: `${CLEAN_CSS}.x { color: var(--mt-color-text-tertiary); background: var(--mt-color-failed-quiet); }\n`,
    svgs: { "mac-x.svg": '<svg><rect fill="#010203"/></svg>\n' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^2 design-token problem\(s\):$/m);
  assert.match(r.stderr, /\[stray hex\]/);
  assert.match(r.stderr, /\[painted pair\]/);
});

test("the generator writes its outputs and still exits 1 on a finding", () => {
  const root = fixture({ svgs: { "mac-x.svg": '<svg><rect fill="#010203"/></svg>\n' } });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[stray hex\] docs\/product\/design\/mac-x\.svg/);
  assert.match(readFileSync(join(root, "apps/console/web/tokens.css"), "utf8"), /--mt-color-accent: #125f6b;/);
});
