#!/usr/bin/env node
// Generates docs/product/design/tokens.css from docs/product/design/tokens.json
// and prints the WCAG contrast table that design-system.md quotes.
//
//   node ops/scripts/build-design-tokens.mjs          # write tokens.css + print the table
//   node ops/scripts/build-design-tokens.mjs --check  # fail if an output is stale, a pair is below AA,
//                                                     # or a decision-19 check fails (see below)
//
// One source of truth: tokens.json. tokens.css is a build artifact that is
// committed so the PWA and the preview page can load it with no build step.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
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
// Chart marks are non-text graphics (WCAG 1.4.11), not labels: a bar or a line
// carries its value through an axis and a direct label, never through being
// readable as type. Holding them to 4.5:1 collapses a sequential ramp on a
// near-white ground — steps four and five land within 0.03 of each other and
// stop being distinguishable, which is the opposite of accessible.
const NON_TEXT = new Set(["focus-ring", "border-control", "chart-1", "chart-2", "chart-3", "chart-4", "chart-5"]);

// A `contrast` entry names a ground the role is painted on. A string is the
// role as text (4.5:1, or 3:1 for a NON_TEXT role). `{ "on": …, "as": "glyph" }`
// is the role as a non-text mark only — a dot, a status glyph — held to
// WCAG 1.4.11's 3:1: for a ground where it is legal as a mark and not as words
// (a selected row's `accent-quiet` re-inks every state colour inside it, and
// only some of them clear 4.5:1 there).
const grounds = (def) =>
  (def.contrast ?? []).map((e) => (typeof e === "string" ? { on: e, as: "text" } : { on: e.on, as: e.as ?? "text" }));

// Every problem is collected rather than thrown, so one run reports all of
// them and CI prints them together: { kind, where, message }.
const findings = [];
const finding = (kind, where, message) => findings.push({ kind, where, message });

const rows = [];
for (const [name, def] of Object.entries(T.color)) {
  for (const { on, as } of grounds(def)) {
    const bg = T.color[on];
    if (bg === undefined) {
      finding("contrast", "tokens.json", `${name} declares a ground \`${on}\` that is not a colour role`);
      continue;
    }
    if (as !== "text" && as !== "glyph") {
      finding("contrast", "tokens.json", `${name} on ${on}: \`as\` is ${JSON.stringify(as)}; it is "text" or "glyph"`);
      continue;
    }
    for (const mode of ["light", "dark"]) {
      if (!hex(def[mode]) || !hex(bg[mode])) {
        finding("contrast", "tokens.json", `${name} on ${on} (${mode}): both sides must be #rrggbb to be checked`);
        continue;
      }
      const ratio = contrast(def[mode], bg[mode]);
      const min = NON_TEXT.has(name) || as === "glyph" ? 3 : 4.5;
      rows.push({ fg: name, bg: on, as, mode, ratio, min, pass: ratio >= min });
    }
  }
}

const table = [
  "| foreground | on | mode | ratio | minimum | AA |",
  "| --- | --- | --- | ---: | ---: | --- |",
  ...rows.map(
    (r) =>
      `| \`${r.fg}\`${r.as === "glyph" ? " (glyph)" : ""} | \`${r.bg}\` | ${r.mode} | ${r.ratio.toFixed(2)}:1 | ${r.min}:1 | ${r.pass ? "pass" : "**FAIL**"} |`,
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

// ----- decision 19: the painted ground, the stray literal, the pinned accent -----
// The contrast table is only as honest as the pairs tokens.json declares, and
// nearly every colour fault in the design engagement was a colour used on a
// ground nobody had declared (review-00 §3.4, C6–C8; amendments §1.7). Four
// checks close the ways that has happened; both modes run them.
//
//   quiet fill    every `*-quiet` fill is declared, as text, as the ground of
//                 the ink it exists for — so a chip is checked on the fill it
//                 is painted on, not on `surface`, which nothing is drawn on.
//   painted pair  a web CSS rule that paints a token ink on a token ground
//                 (`color:` and `background:` in one rule) names a declared
//                 pair; a ground declared for a glyph only does not cover text.
//                 A computed ground — a `color-mix()` tint — is no token and
//                 has no pair to declare: the quiet fills exist to replace
//                 those (C6), and this check reads a chip once it uses one.
//   stray hex     every hex colour in docs/product/design/*.svg and the web
//                 CSS is a token's value. A colour that is not a token is a
//                 colour no check has ever seen. ONE EXEMPTION, named in every
//                 run's output: docs/product/design/legacy/ — the wireframes
//                 drawn before round B's palette, superseded by the canvas
//                 boards and kept as history, unrepainted (its README.md).
//   accent        `accent` is pinned (ruling 8, C11): a literal in both
//                 schemes, mapped to no system accent in tokens.json, and read
//                 from none in the Mac app's Swift or the web CSS. The user's
//                 accent setting would otherwise repaint the one colour every
//                 declared accent pair describes — and a purple setting makes
//                 it `agent`. Apple's own controls keep controlAccentColor;
//                 nothing we draw reads it.
const designDir = new URL("docs/product/design/", root);
const webDir = new URL("apps/console/web/", root);
const swiftDir = new URL("apps/macos/sources/", root);
// The stray-hex exemption (see above). The glob is the top level of
// docs/product/design only, so this directory is not read; it is named here and
// counted in the summary so the exemption is a decision on the page, not an
// accident of a non-recursive readdir.
const legacyDir = new URL("docs/product/design/legacy/", root);

/** Same length, newlines kept: offsets and line numbers survive blanking. */
const blank = (s) => s.replace(/[^\n]/g, " ");
/** 1-based line of a character offset. */
const lineAt = (text, index) => {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) n++;
  return n;
};

/**
 * Every declaration in a stylesheet: { block, selector, prop, value, line }.
 * Only innermost `{…}` bodies are read, so a selector (`#feed-list`) or an
 * at-rule's prelude is never mistaken for a value.
 */
const declarations = (text) => {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  const out = [];
  let block = 0;
  for (const m of src.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    block++;
    const selector = m[1].split(";").pop().trim().replace(/\s+/g, " ");
    let at = m.index + m[1].length + 1;
    for (const part of m[2].split(";")) {
      const colon = part.indexOf(":");
      if (colon !== -1) {
        const prop = part.slice(0, colon).trim().toLowerCase();
        out.push({ block, selector, prop, value: part.slice(colon + 1).trim(), line: lineAt(src, at + part.search(/\S/)) });
      }
      at += part.length + 1;
    }
  }
  return out;
};

/**
 * Every colour-bearing value in an SVG: presentation attributes, `style=""`,
 * and `<style>` sheets. Text content is prose — "PR #418" is not a colour —
 * and `href="#feed"` is not a colour attribute.
 */
const COLOUR_ATTR = /\s(fill|stroke|stop-color|flood-color|lighting-color|color)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const STYLE_ATTR = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const STYLE_EL = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g;
const svgValues = (text) => {
  const out = [];
  // The sheets, read as CSS where they stand: everything else blanked.
  let sheets = "";
  let last = 0;
  for (const m of text.matchAll(STYLE_EL)) {
    const start = m.index + m[1].length;
    sheets += blank(text.slice(last, start)) + m[2].replace(/<!\[CDATA\[|\]\]>/g, blank);
    last = start + m[2].length;
  }
  sheets += blank(text.slice(last));
  for (const d of declarations(sheets)) out.push({ value: d.value, line: d.line });
  // The tags, with the sheets blanked so a `>` in a selector cannot end a tag.
  const tags = text.replace(STYLE_EL, (_, open, body, close) => open + blank(body) + close);
  for (const t of tags.matchAll(/<[A-Za-z][^>]*>/g)) {
    for (const a of t[0].matchAll(COLOUR_ATTR)) out.push({ value: a[2] ?? a[3], line: lineAt(tags, t.index + a.index) });
    for (const a of t[0].matchAll(STYLE_ATTR)) {
      for (const part of (a[1] ?? a[2]).split(";")) {
        const colon = part.indexOf(":");
        if (colon !== -1) out.push({ value: part.slice(colon + 1), line: lineAt(tags, t.index + a.index) });
      }
    }
  }
  return out;
};

// `&#123;` is an entity and `url(#abc)` a reference, not colours.
const HEX = /(?<!&)#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])/gi;
const hexesIn = (value) => [...value.replace(/url\([^)]*\)/gi, "").matchAll(HEX)].map((m) => m[0]);
/** `#ABC` → `#aabbcc`; `#rrggbbff` → `#rrggbb`. A hex with real alpha stays as written: a composite is never a token. */
const normHex = (h) => {
  let s = h.slice(1).toLowerCase();
  if (s.length <= 4) s = [...s].map((c) => c + c).join("");
  if (s.length === 8 && s.endsWith("ff")) s = s.slice(0, 6);
  return `#${s}`;
};
const tokenHexes = new Set(
  Object.values(T.color)
    .flatMap((d) => [d.light, d.dark])
    .filter((v) => typeof v === "string" && hex(v))
    .map(normHex),
);

/** Report every hex in `values` that is not a token, one finding per file. Returns how many hexes were read. */
const strayHexes = (where, values) => {
  const bad = new Map();
  let seen = 0;
  for (const { value, line } of values) {
    for (const h of hexesIn(value)) {
      seen++;
      const n = normHex(h);
      if (tokenHexes.has(n)) continue;
      const b = bad.get(n) ?? { line, count: 0 };
      b.count++;
      bad.set(n, b);
    }
  }
  if (bad.size) {
    const total = [...bad.values()].reduce((a, b) => a + b.count, 0);
    const list = [...bad].map(([h, b]) => `${h} (line ${b.line}${b.count > 1 ? `, ×${b.count}` : ""})`).join(", ");
    finding("stray hex", where, `${total} colour(s) that are not a token's value — ${list}`);
  }
  return seen;
};

const TOKEN_VAR = /^var\(\s*--mt-color-([a-z0-9-]+)\s*(?:,[^)]*)?\)$/;
const tokenOf = (value) => TOKEN_VAR.exec(value.replace(/!important\s*$/i, "").trim())?.[1] ?? null;

/** Every rule that sets a token `color` and a token `background` must name a declared pair. Returns how many were read. */
const paintedPairs = (where, decls) => {
  const blocks = new Map();
  for (const d of decls) {
    if (!blocks.has(d.block)) blocks.set(d.block, []);
    blocks.get(d.block).push(d);
  }
  let n = 0;
  for (const ds of blocks.values()) {
    const fg = ds.findLast((d) => d.prop === "color");
    const bg = ds.findLast((d) => d.prop === "background" || d.prop === "background-color");
    if (!fg || !bg) continue;
    const [ink, ground] = [tokenOf(fg.value), tokenOf(bg.value)];
    // Not a token pair (a color-mix(), a literal, `transparent`), or an unknown role — reported on its own.
    if (!ink || !ground || !T.color[ink] || !T.color[ground]) continue;
    n++;
    const declared = grounds(T.color[ink]).find((g) => g.on === ground);
    if (!declared) {
      finding("painted pair", `${where}:${fg.line}`, `\`${fg.selector}\` paints ${ink} on ${ground}, a pair tokens.json does not declare — add "${ground}" to ${ink}'s contrast, or repaint`);
    } else if (declared.as === "glyph" && !NON_TEXT.has(ink)) {
      finding("painted pair", `${where}:${fg.line}`, `\`${fg.selector}\` paints ${ink} as text on ${ground}, which is declared for a glyph only (3:1); text needs 4.5:1`);
    }
  }
  return n;
};

/** Swift with string literals and comments blanked: a role's description may say "controlAccentColor"; code may not. */
const swiftCode = (src) =>
  src
    .replace(/"""[\s\S]*?"""/g, blank)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank);
const SYSTEM_ACCENT = /\b(?:controlAccentColor|accentColor)\b/i;

/** Runs every decision-19 check against the tree on disk. Returns counts for the summary line. */
const lint = () => {
  // quiet fill
  for (const name of Object.keys(T.color).filter((n) => n.endsWith("-quiet"))) {
    const ink = name.slice(0, -"-quiet".length);
    if (T.color[ink]) {
      const g = grounds(T.color[ink]).find((x) => x.on === name);
      if (!g || g.as !== "text") {
        finding("quiet fill", "tokens.json", `${name} is the fill ${ink} is painted on, but ${ink}'s contrast does not declare "${name}" as text — the check would be reading a ground that never ships`);
      }
    } else if (!Object.values(T.color).some((d) => grounds(d).some((x) => x.on === name))) {
      finding("quiet fill", "tokens.json", `${name} is a quiet fill that no role declares as its ground`);
    }
  }

  // accent, in the tokens
  const accent = T.color.accent;
  if (!accent) finding("accent", "tokens.json", "there is no `accent` role");
  else {
    for (const mode of ["light", "dark"]) {
      if (typeof accent[mode] !== "string" || !hex(accent[mode])) {
        finding("accent", "tokens.json", `accent.${mode} is ${JSON.stringify(accent[mode])}; the pinned accent is a #rrggbb literal`);
      }
    }
  }
  for (const [name, def] of Object.entries(T.color)) {
    if (SYSTEM_ACCENT.test(String(def.apple ?? ""))) {
      finding("accent", "tokens.json", `${name}.apple maps to the system accent (${JSON.stringify(def.apple)}); the brand colour is pinned, and controlAccentColor drives only the controls Apple draws itself`);
    }
  }

  // accent, in the Mac app
  for (const f of readdirSync(swiftDir, { recursive: true }).filter((p) => p.endsWith(".swift")).sort()) {
    const code = swiftCode(readFileSync(new URL(f, swiftDir), "utf8"));
    for (const m of code.matchAll(/\bcontrolAccentColor\b|\.accentColor\b/g)) {
      finding("accent", `apps/macos/sources/${f}:${lineAt(code, m.index)}`, `${m[0].replace(/^\./, "")} reads the system accent; draw with the pinned role (MetistryColorRole.accent)`);
    }
  }

  // the design SVGs: stray hex (legacy/ exempt — counted, not read)
  const svgs = readdirSync(designDir).filter((f) => f.endsWith(".svg")).sort();
  let legacy = 0;
  try {
    legacy = readdirSync(legacyDir).filter((f) => f.endsWith(".svg")).length;
  } catch {
    // no legacy directory: nothing is exempt
  }
  let hexes = 0;
  for (const f of svgs) hexes += strayHexes(`docs/product/design/${f}`, svgValues(readFileSync(new URL(f, designDir), "utf8")));

  // the web CSS: stray hex, painted pair, unknown role, accent. tokens.css is
  // this generator's own output (its staleness is checked above), so it is
  // the tokens by construction and is not read again here.
  const sheets = readdirSync(webDir).filter((f) => f.endsWith(".css") && f !== "tokens.css").sort();
  let painted = 0;
  for (const f of sheets) {
    const where = `apps/console/web/${f}`;
    const decls = declarations(readFileSync(new URL(f, webDir), "utf8"));
    hexes += strayHexes(where, decls);
    painted += paintedPairs(where, decls);
    for (const d of decls) {
      for (const m of d.value.matchAll(/var\(\s*--mt-color-([a-z0-9-]+)/g)) {
        if (!T.color[m[1]]) finding("unknown role", `${where}:${d.line}`, `--mt-color-${m[1]} is not a colour role in tokens.json`);
      }
      if (/\baccentcolor(?:text)?\b/i.test(d.value)) {
        finding("accent", `${where}:${d.line}`, `\`${d.selector}\` paints with the system AccentColor; use var(--mt-color-accent)`);
      }
    }
  }
  return { hexes, svgs: svgs.length, legacy, sheets: sheets.length, painted };
};

/** Print every failure; returns how many there were. */
const report = () => {
  const failures = rows.filter((r) => !r.pass);
  if (failures.length) {
    console.error(`${failures.length} colour pair(s) below the minimum:`);
    for (const f of failures) console.error(`  ${f.fg}${f.as === "glyph" ? " (glyph)" : ""} on ${f.bg} (${f.mode}) = ${f.ratio.toFixed(2)}:1, needs ${f.min}:1`);
  }
  if (findings.length) {
    console.error(`${findings.length} design-token problem(s):`);
    for (const f of findings) console.error(`  [${f.kind}] ${f.where}: ${f.message}`);
  }
  return failures.length + findings.length;
};

const check = process.argv.includes("--check");

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
  const seen = lint();
  if (report()) process.exit(1);
  console.log(
    `design tokens: ok (${rows.length} pairs checked; ${seen.painted} painted pairs declared; ` +
      `${seen.hexes} hex colour(s) in ${seen.svgs} SVG(s) and ${seen.sheets} stylesheet(s) are tokens` +
      `${seen.legacy ? ` (docs/product/design/legacy/: ${seen.legacy} pre-round-B SVGs exempt)` : ""}; accent pinned)`,
  );
} else {
  for (const p of cssPaths) writeFileSync(p, css);
  writeFileSync(previewPath, inlinePreview(readFileSync(previewPath, "utf8")));
  writeFileSync(swiftPath, swiftFile);
  console.log(`wrote ${[...cssPaths, swiftPath].map((p) => fileURLToPath(p)).join(", ")} and inlined the CSS into preview.html`);
  console.log(table);
  lint();
  const n = report();
  if (n) {
    console.error(`\n${n} problem(s) — fix them before committing.`);
    process.exit(1);
  }
}
