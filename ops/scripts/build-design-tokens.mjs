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
// Two copies, one generator. The console serves its web root as static files
// and cannot reach outside it, so the PWA needs its own tokens.css — which is
// a drift risk the moment a human has to remember to copy it. The generator
// owns both and --check fails on either being stale.
const cssPaths = [
  new URL("docs/product/design/tokens.css", root),
  new URL("apps/console/web/tokens.css", root),
];
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
  // Reply prose (design-system.md §4) is its own group: the one place tuned for
  // density rather than scanning, so it must not inherit a `type` step.
  for (const [k, v] of Object.entries(T.reply)) if (k !== "$meta") out.push(`  --mt-reply-${k}: ${v};`);
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

// ----- Swift emit: the Mac app's copy of the same roles -----
// apps/macos is a Swift package with no build step of its own that could read
// JSON at compile time, and Bundle.module resources do not survive being
// assembled into a .app by hand — so the tokens are generated as source. Same
// rule as tokens.css: edit tokens.json, never the .swift.
//
// Colours are emitted as literal components rather than hex strings so an
// rgba() scrim (the one token that is not a hex triple) needs no special case
// at the call site. Type steps are emitted as Apple's own semantic Font values
// from each step's `apple` field, not as point sizes: design-system P7 —
// Dynamic Type and VoiceOver arrive free with the standard style, and a fixed
// pt size throws that away.
const swiftPath = new URL("apps/macos/sources/kit/design-tokens.swift", root);

const APPLE_FONT = {
  largeTitle: ".largeTitle",
  title: ".title",
  title2: ".title2",
  title3: ".title3",
  headline: ".headline",
  body: ".body",
  callout: ".callout",
  subheadline: ".subheadline",
  footnote: ".footnote",
  caption: ".caption",
  caption2: ".caption2",
  "body (monospaced)": ".body.monospaced()",
};

/** `bg` -> `bg`, `text-primary` -> `textPrimary`; a Swift case name. */
const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
/** `"16px"` -> `16`; every space/size/radius token is a whole number of px on the 4pt grid. */
const px = (v) => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v).trim());
  if (m === null) return null;
  return m[1];
};
/** `#rrggbb` or `rgba(r, g, b, a)` -> Swift `(r, g, b, a)` in 0…1. */
const swiftRGBA = (value) => {
  const h = hex(value);
  if (h) return `(${h.map((c) => (c / 255).toFixed(4)).join(", ")}, 1.0)`;
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(String(value).trim());
  if (!m) throw new Error(`tokens.json: colour ${JSON.stringify(value)} is neither #rrggbb nor rgba()`);
  return `(${[m[1], m[2], m[3]].map((c) => (Number(c) / 255).toFixed(4)).join(", ")}, ${Number(m[4]).toFixed(4)})`;
};

const swiftIndent = (lines, n) => lines.map((l) => `${" ".repeat(n)}${l}`).join("\n");

const colorRoles = Object.keys(T.color);
const typeSteps = Object.keys(T.type).filter((k) => k !== "$meta");
for (const step of typeSteps) {
  if (APPLE_FONT[T.type[step].apple] === undefined) {
    throw new Error(`tokens.json: type step ${step} has apple: ${JSON.stringify(T.type[step].apple)}, which this generator has no SwiftUI Font for — add it to APPLE_FONT`);
  }
}

const swiftFile = `// GENERATED — do not edit.
// Source: docs/product/design/tokens.json (v${T.$meta.version}, ${T.$meta.updated})
// Rebuild: node ops/scripts/build-design-tokens.mjs   (--check fails on drift)
//
// The design system's semantic roles, for SwiftUI. No token names a hue, a
// screen or a component, so a role can be re-pointed without touching a call
// site (docs/product/design-system.md §2).
//
// Colours resolve against the ColorScheme a view already has from the
// environment rather than through an AppKit dynamic NSColor: MetistryKit stays
// AppKit-free so an iOS target can share it unchanged. Type steps map to
// Apple's own semantic Font values (design-system P7): Dynamic Type,
// VoiceOver and Increase Contrast then come free.

import SwiftUI

// MARK: - Colour roles

public enum MetistryColorRole: String, CaseIterable, Sendable {
${swiftIndent(colorRoles.map((r) => `case ${camel(r)} = "${r}"`), 4)}
}

public extension MetistryColorRole {
    /// sRGB components in 0…1 for one scheme. Emitted as components rather than
    /// hex so the one rgba() token (\`scrim\`) needs no special case.
    func components(_ scheme: ColorScheme) -> (red: Double, green: Double, blue: Double, opacity: Double) {
        let dark = scheme == .dark
        switch self {
${swiftIndent(
  colorRoles.map(
    (r) => `case .${camel(r)}: return dark ? ${swiftRGBA(T.color[r].dark)} : ${swiftRGBA(T.color[r].light)}`,
  ),
  8,
)}
        }
    }

    func color(_ scheme: ColorScheme) -> Color {
        let c = components(scheme)
        return Color(.sRGB, red: c.red, green: c.green, blue: c.blue, opacity: c.opacity)
    }

    /// What this role is for, verbatim from tokens.json — so a reader of the
    /// Swift never has to open the JSON to know why a role exists.
    var role: String {
        switch self {
${swiftIndent(colorRoles.map((r) => `case .${camel(r)}: return ${JSON.stringify(T.color[r].role)}`), 8)}
        }
    }
}

// MARK: - Type scale

public enum MetistryTextStyle: String, CaseIterable, Sendable {
${swiftIndent(typeSteps.map((s) => `case ${camel(s)} = "${s}"`), 4)}
}

public extension MetistryTextStyle {
    /// Apple's semantic style for this step, from tokens.json's \`apple\` field.
    var font: Font {
        switch self {
${swiftIndent(typeSteps.map((s) => `case .${camel(s)}: return ${APPLE_FONT[T.type[s].apple]}`), 8)}
        }
    }

    /// The step's design weight. Apple's styles carry their own, so this is
    /// only applied where tokens.json asks for more than the style gives.
    var weight: Font.Weight {
        switch self {
${swiftIndent(
  typeSteps.map((s) => {
    const w = Number(T.type[s].weight);
    const name = w >= 700 ? ".bold" : w >= 600 ? ".semibold" : w >= 500 ? ".medium" : ".regular";
    return `case .${camel(s)}: return ${name}`;
  }),
  8,
)}
        }
    }
}

// MARK: - Spacing, size, radius (the 4pt grid — ${T.space.$meta.grid})

public enum MetistrySpace {
${swiftIndent(
  Object.entries(T.space)
    .filter(([k]) => k !== "$meta" && px(T.space[k]) !== null)
    .map(([k, v]) => `public static let s${k}: CGFloat = ${px(v)}`),
  4,
)}
}

public enum MetistrySize {
${swiftIndent(
  Object.entries(T.size)
    .filter(([k]) => k !== "$meta" && px(T.size[k]) !== null)
    .map(([k, v]) => `public static let ${camel(k)}: CGFloat = ${px(v)}`),
  4,
)}
}

public enum MetistryRadius {
${swiftIndent(
  Object.entries(T.radius)
    .filter(([k]) => px(T.radius[k]) !== null)
    .map(([k, v]) => `public static let ${camel(k)}: CGFloat = ${px(v)}`),
  4,
)}
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
  for (const p of cssPaths) {
    let current = "";
    try {
      current = readFileSync(p, "utf8");
    } catch {
      console.error(`${fileURLToPath(p)} is missing — run: node ops/scripts/build-design-tokens.mjs`);
      process.exit(1);
    }
    if (current !== css) {
      console.error(`${fileURLToPath(p)} is stale — run: node ops/scripts/build-design-tokens.mjs`);
      process.exit(1);
    }
  }
  const html = readFileSync(previewPath, "utf8");
  if (html !== inlinePreview(html)) {
    console.error("preview.html's inlined tokens are stale — run: node ops/scripts/build-design-tokens.mjs");
    process.exit(1);
  }
  let currentSwift = "";
  try {
    currentSwift = readFileSync(swiftPath, "utf8");
  } catch {
    console.error(`${fileURLToPath(swiftPath)} is missing — run: node ops/scripts/build-design-tokens.mjs`);
    process.exit(1);
  }
  if (currentSwift !== swiftFile) {
    console.error(`${fileURLToPath(swiftPath)} is stale — run: node ops/scripts/build-design-tokens.mjs`);
    process.exit(1);
  }
  if (failures.length) {
    console.error(`${failures.length} colour pair(s) below the minimum:`);
    for (const f of failures) console.error(`  ${f.fg} on ${f.bg} (${f.mode}) = ${f.ratio.toFixed(2)}:1`);
    process.exit(1);
  }
  console.log(`design tokens: ok (${rows.length} pairs checked)`);
} else {
  for (const p of cssPaths) writeFileSync(p, css);
  writeFileSync(previewPath, inlinePreview(readFileSync(previewPath, "utf8")));
  writeFileSync(swiftPath, swiftFile);
  console.log(`wrote ${[...cssPaths, swiftPath].map((p) => fileURLToPath(p)).join(", ")} and inlined the CSS into preview.html`);
  console.log(table);
  if (failures.length) {
    console.error(`\n${failures.length} pair(s) below the minimum — fix tokens.json before committing.`);
    process.exit(1);
  }
}
