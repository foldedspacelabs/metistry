#!/usr/bin/env node
// Generates docs/product/design/tokens.css from docs/product/design/tokens.json
// and prints the WCAG contrast table that design-system.md quotes.
//
//   node ops/scripts/build-design-tokens.mjs          # write tokens.css + print the table
//   node ops/scripts/build-design-tokens.mjs --check  # fail if tokens.css is stale or a pair is below AA
//
// One source of truth: tokens.json. tokens.css is a build artifact that is
// committed so the PWA and the preview page can load it with no build step.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const jsonPath = new URL("docs/product/design/tokens.json", root);
const cssPath = new URL("docs/product/design/tokens.css", root);
// The PWA serves its own copy so the shell needs no build step and no CDN.
const webCssPath = new URL("apps/console/web/tokens.css", root);
const T = JSON.parse(readFileSync(jsonPath, "utf8"));

// ----- WCAG 2.1 relative luminance and contrast -----
const hex = (c) => {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null; // rgba() scrims are not text pairs; skipped
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(hex(a)), lum(hex(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

// ----- contrast table -----
// Text roles are held to AA 4.5:1; chip/statement text renders at >=13px 500
// weight so it is not "large text" and gets no exemption. Non-text roles
// (focus ring, borders) are held to the 3:1 non-text minimum.
const NON_TEXT = new Set(["focus-ring"]);
const rows = [];
for (const [name, def] of Object.entries(T.color)) {
  for (const on of def.contrast ?? []) {
    const bg = T.color[on];
    for (const mode of ["light", "dark"]) {
      const ratio = contrast(def[mode], bg[mode]);
      const min = NON_TEXT.has(name) ? 3 : 4.5;
      rows.push({ fg: name, bg: on, mode, ratio, min, pass: ratio >= min });
    }
  }
}

const table = [
  "| foreground | on | mode | ratio | minimum | AA |",
  "| --- | --- | --- | ---: | ---: | --- |",
  ...rows.map(
    (r) =>
      `| \`${r.fg}\` | \`${r.bg}\` | ${r.mode} | ${r.ratio.toFixed(2)}:1 | ${r.min}:1 | ${r.pass ? "pass" : "**FAIL**"} |`,
  ),
].join("\n");

// ----- CSS emit -----
const decls = (mode) => {
  const out = [];
  for (const [name, def] of Object.entries(T.color)) out.push(`  --mt-color-${name}: ${def[mode]};`);
  for (const [level, def] of Object.entries(T.elevation)) {
    if (level === "$meta") continue;
    out.push(`  --mt-elevation-${level}: ${def[mode]};`);
  }
  return out.join("\n");
};

const stat = () => {
  const out = [];
  out.push(`  --mt-font-sans: ${T.type.$meta.stack};`);
  out.push(`  --mt-font-mono: ${T.type.$meta.mono};`);
  for (const [name, s] of Object.entries(T.type)) {
    if (name === "$meta") continue;
    out.push(`  --mt-text-${name}-size: ${s.clamp};`);
    out.push(`  --mt-text-${name}-weight: ${s.weight};`);
    out.push(`  --mt-text-${name}-line: ${s.line};`);
    out.push(`  --mt-text-${name}-tracking: ${s.tracking};`);
  }
  for (const [k, v] of Object.entries(T.space)) if (k !== "$meta") out.push(`  --mt-space-${k}: ${v};`);
  for (const [k, v] of Object.entries(T.size)) if (k !== "$meta") out.push(`  --mt-size-${k}: ${v};`);
  for (const [k, v] of Object.entries(T.radius)) out.push(`  --mt-radius-${k}: ${v};`);
  for (const [k, v] of Object.entries(T.motion)) if (k !== "$meta") out.push(`  --mt-motion-${k}: ${v};`);
  for (const [k, v] of Object.entries(T.z)) out.push(`  --mt-z-${k}: ${v};`);
  return out.join("\n");
};

const css = `/* GENERATED — do not edit.
 * Source: docs/product/design/tokens.json (v${T.$meta.version}, ${T.$meta.updated})
 * Rebuild: node ops/scripts/build-design-tokens.mjs
 *
 * Light is the base. Dark is applied twice on purpose: once behind
 * prefers-color-scheme (guarded so an explicit light choice wins) and once
 * behind [data-theme="dark"] (so an explicit dark choice wins on a light OS).
 *
 * The [data-theme] selectors carry no :root prefix on purpose: custom
 * properties inherit, so putting data-theme on any element themes that
 * subtree. That is what lets the preview page show light and dark side by
 * side without a second copy of the palette.
 */

:root {
  color-scheme: light dark;

${stat()}

${decls("light")}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${decls("dark")}
  }
}

[data-theme="light"] {
  color-scheme: light;
${decls("light")}
}

[data-theme="dark"] {
  color-scheme: dark;
${decls("dark")}
}

/* Reduced motion: durations collapse, transforms become cross-fades. */
@media (prefers-reduced-motion: reduce) {
  :root {
    --mt-motion-duration-fast: var(--mt-motion-duration-instant);
    --mt-motion-duration-base: var(--mt-motion-duration-instant);
    --mt-motion-duration-slow: var(--mt-motion-duration-instant);
    --mt-motion-duration-sheet: var(--mt-motion-duration-instant);
  }
}
`;

// ----- preview page: the same tokens, inlined between markers -----
// preview.html must stay self-contained (no external resources), so the
// generator owns the block between BEGIN/END TOKENS rather than a <link>.
const previewPath = new URL("docs/product/design/preview.html", root);
const BEGIN = "/* === BEGIN TOKENS — generated from tokens.json by ops/scripts/build-design-tokens.mjs === */";
const END = "/* === END TOKENS === */";
const inlinePreview = (html) => {
  const a = html.indexOf(BEGIN);
  const b = html.indexOf(END);
  if (a === -1 || b === -1) throw new Error("preview.html is missing the BEGIN/END TOKENS markers");
  return `${html.slice(0, a + BEGIN.length)}\n${css}\n${html.slice(b)}`;
};

const check = process.argv.includes("--check");
const failures = rows.filter((r) => !r.pass);

if (check) {
  const current = readFileSync(cssPath, "utf8");
  if (current !== css) {
    console.error("tokens.css is stale — run: node ops/scripts/build-design-tokens.mjs");
    process.exit(1);
  }
  if (readFileSync(webCssPath, "utf8") !== css) {
    console.error("apps/console/web/tokens.css is stale — run: node ops/scripts/build-design-tokens.mjs");
    process.exit(1);
  }
  const html = readFileSync(previewPath, "utf8");
  if (html !== inlinePreview(html)) {
    console.error("preview.html's inlined tokens are stale — run: node ops/scripts/build-design-tokens.mjs");
    process.exit(1);
  }
  if (failures.length) {
    console.error(`${failures.length} colour pair(s) below the minimum:`);
    for (const f of failures) console.error(`  ${f.fg} on ${f.bg} (${f.mode}) = ${f.ratio.toFixed(2)}:1`);
    process.exit(1);
  }
  console.log(`design tokens: ok (${rows.length} pairs checked)`);
} else {
  writeFileSync(cssPath, css);
  writeFileSync(webCssPath, css);
  writeFileSync(previewPath, inlinePreview(readFileSync(previewPath, "utf8")));
  console.log(`wrote ${fileURLToPath(cssPath)}`);
  console.log(`wrote ${fileURLToPath(webCssPath)}`);
  console.log("inlined the same tokens into preview.html");
  console.log(table);
  if (failures.length) {
    console.error(`\n${failures.length} pair(s) below the minimum — fix tokens.json before committing.`);
    process.exit(1);
  }
}
