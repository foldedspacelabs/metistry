// The release body, generated from what `changeset version` already wrote
// into each package's CHANGELOG.md — so the notes on a GitHub release are
// the same sentences the changesets carried, never a second hand-written
// account that drifts.
//
//   node ops/release/changelog.mjs <version> [<root>]   -> markdown on stdout
//
// Fixed mode means every package gets the same version and the same
// "Updated dependencies" churn; that churn is dropped and the real
// bullets are deduplicated, so one changeset reads as one line.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The body under `## <version>` in a changesets CHANGELOG.md, up to the next `## `. */
export function sectionFor(changelog, version) {
  const v = String(version).replace(/^v/, "");
  const lines = String(changelog).split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${v}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * `[{ heading: "Minor Changes", items: ["…"] }]`. A `- Updated
 * dependencies …` bullet and its indented children are dropped: in fixed
 * mode every package has them and they say nothing a reader wants.
 */
export function groupsOf(body) {
  const groups = [];
  let current = null;
  let skipping = false;
  for (const raw of String(body).split("\n")) {
    const heading = /^###\s+(.+?)\s*$/.exec(raw);
    if (heading) {
      current = { heading: heading[1], items: [] };
      groups.push(current);
      skipping = false;
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      skipping = /^updated dependencies/i.test(bullet[1]);
      if (!skipping && current) current.items.push(normalize(bullet[1]));
      continue;
    }
    if (/^\s+\S/.test(raw) && current && current.items.length && !skipping) {
      // a wrapped continuation line of the bullet above
      current.items[current.items.length - 1] += ` ${raw.trim()}`;
    }
  }
  return groups.filter((g) => g.items.length > 0);
}

/** Drop the changeset's commit-hash prefix (`abc1234: text`) — it points at a squashed commit nobody can look up. */
function normalize(text) {
  return text.replace(/^[0-9a-f]{7,40}:\s*/i, "").trim();
}

const ORDER = ["Major Changes", "Minor Changes", "Patch Changes"];

/** The product-level package: fixed mode gives every package the same
 * version section, so its CHANGELOG.md is the one a reader means by "the
 * changelog for this release". */
export const CLI_PACKAGE_NAME = "@foldedspacelabs/metistry-cli";

/**
 * Which entries the release body's bullets come from: the CLI package's
 * own `## <version>` section, when `changeset version` actually wrote one
 * for this release. Falls back to every package's section (still
 * deduplicated by `renderReleaseNotes`) when there is no CLI entry, or its
 * section for this version is missing or blank — e.g. a version the CLI
 * itself carries no changeset for.
 * @param {{name: string, changelog: string}[]} entries
 * @param {string} version
 */
export function notesEntries(entries, version) {
  const cli = entries.find((e) => e.name === CLI_PACKAGE_NAME);
  if (cli && sectionFor(cli.changelog, version).trim()) return [cli];
  return entries;
}

/**
 * @param {{version: string, entries: {name: string, changelog: string}[],
 *          assets?: string[], images?: string[], repo?: string}} opts
 */
export function renderReleaseNotes(opts) {
  const version = String(opts.version).replace(/^v/, "");
  const merged = new Map();
  for (const e of notesEntries(opts.entries ?? [], version)) {
    for (const g of groupsOf(sectionFor(e.changelog, version))) {
      const into = merged.get(g.heading) ?? [];
      for (const item of g.items) if (!into.includes(item)) into.push(item);
      merged.set(g.heading, into);
    }
  }

  const out = [`## Metistry ${version}`, ""];
  const headings = [...merged.keys()].sort((a, b) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib) || a.localeCompare(b);
  });
  if (headings.length === 0) out.push("_No changesets in this release._", "");
  for (const h of headings) {
    out.push(`### ${h}`, "");
    for (const item of merged.get(h)) out.push(`- ${item}`);
    out.push("");
  }

  const packages = (opts.entries ?? []).map((e) => e.name).sort();
  if (packages.length) {
    out.push("### Packages", "", ...packages.map((p) => `- \`${p}@${version}\``), "");
  }
  if (opts.images?.length) {
    out.push("### Container images", "", ...opts.images.map((i) => `- \`${i}\``), "");
  }
  if (opts.assets?.length) {
    out.push("### Assets", "", ...opts.assets.map((a) => `- \`${a}\``), "", "Verify a download against `checksums.txt` before unpacking it — `metistry update` does this for you.", "");
  }
  out.push(
    "### Updating",
    "",
    "```sh",
    "metistry update                 # release mode: pack + images, verified, migrated, restarted",
    `metistry update --version ${version}  # pin this release exactly`,
    "metistry update --rollback      # back to the previous release",
    "```",
    "",
  );
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Every workspace package that has a CHANGELOG.md, in `apps/`, `packages/` and `plugins/`. */
export function collectEntries(root) {
  const entries = [];
  for (const group of ["packages", "apps", "plugins"]) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const pkg = join(dir, name, "package.json");
      const log = join(dir, name, "CHANGELOG.md");
      if (!existsSync(pkg) || !existsSync(log)) continue;
      const { name: pkgName, private: isPrivate } = JSON.parse(readFileSync(pkg, "utf8"));
      if (isPrivate || !pkgName) continue; // private apps ship as images, not as npm packages
      entries.push({ name: pkgName, changelog: readFileSync(log, "utf8") });
    }
  }
  return entries;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: changelog.mjs <version> [<root>]");
    process.exit(2);
  }
  const flag = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? [] : String(process.argv[i + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  };
  const positional = process.argv.slice(3).find((a) => !a.startsWith("--"));
  const root = positional ?? new URL("../..", import.meta.url).pathname;
  process.stdout.write(renderReleaseNotes({ version, entries: collectEntries(root), assets: flag("assets"), images: flag("images") }));
}
