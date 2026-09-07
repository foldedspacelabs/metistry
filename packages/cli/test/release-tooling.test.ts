// The repo-level release tooling, held to the same standard as the CLI:
// the changelog generator against a changesets fixture, the Sparkle
// appcast against a release fixture (and its refusal to emit an unsigned
// feed), and the workflow itself — parsed, so the job names, the trigger
// and the asset names cannot drift from what `metistry update` downloads.
// (Reaching out of the package into ops/ follows lock-key.test.ts: the
// facts two files must agree on are asserted where the code lives.)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { CLI_PACKAGE_NAME, groupsOf, notesEntries, renderReleaseNotes, sectionFor } from "../../../ops/release/changelog.mjs";
import { renderAppcast, UNSIGNED_PLACEHOLDER } from "../../../ops/release/appcast.mjs";
import { runtimeAssetName } from "../src/release.js";

const repoFile = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");

/** What `changeset version` leaves behind in fixed mode: the same version everywhere, plus dependency churn. */
const CLI_CHANGELOG = `# @foldedspacelabs/metistry-cli

## 0.2.0

### Minor Changes

- a1b2c3d: Release pipeline: versioned artifacts on GitHub Releases, and a
  \`metistry update\` release mode that verifies and installs them.

### Patch Changes

- 9f8e7d6: Doctor reports the release a runtime pack came from.
- Updated dependencies [a1b2c3d]
  - @foldedspacelabs/metistry-core@0.2.0

## 0.1.0

### Patch Changes

- old news nobody is releasing today
`;

const CORE_CHANGELOG = `# @foldedspacelabs/metistry-core

## 0.2.0

### Minor Changes

- a1b2c3d: Release pipeline: versioned artifacts on GitHub Releases, and a
  \`metistry update\` release mode that verifies and installs them.

### Patch Changes

- Updated dependencies [a1b2c3d]
`;

describe("release notes from the changesets", () => {
  it("takes only the section for this version", () => {
    expect(sectionFor(CLI_CHANGELOG, "0.2.0")).toContain("Doctor reports the release");
    expect(sectionFor(CLI_CHANGELOG, "0.2.0")).not.toContain("old news");
    expect(sectionFor(CLI_CHANGELOG, "v0.2.0")).toBe(sectionFor(CLI_CHANGELOG, "0.2.0"));
    expect(sectionFor(CLI_CHANGELOG, "9.9.9")).toBe("");
  });

  it("drops the commit-hash prefix and the fixed-mode dependency churn, and joins wrapped bullets", () => {
    const groups = groupsOf(sectionFor(CLI_CHANGELOG, "0.2.0"));
    expect(groups.map((g) => g.heading)).toEqual(["Minor Changes", "Patch Changes"]);
    expect(groups[0]!.items).toEqual(["Release pipeline: versioned artifacts on GitHub Releases, and a `metistry update` release mode that verifies and installs them."]);
    expect(groups[1]!.items).toEqual(["Doctor reports the release a runtime pack came from."]);
    expect(JSON.stringify(groups)).not.toContain("Updated dependencies");
  });

  it("renders one release body: deduplicated bullets, the packages, the images, the assets and how to update", () => {
    const md = renderReleaseNotes({
      version: "v0.2.0",
      entries: [
        { name: "@foldedspacelabs/metistry-cli", changelog: CLI_CHANGELOG },
        { name: "@foldedspacelabs/metistry-core", changelog: CORE_CHANGELOG },
      ],
      images: ["ghcr.io/foldedspacelabs/metistry-console:0.2.0"],
      assets: [runtimeAssetName("0.2.0", "darwin-arm64"), runtimeAssetName("0.2.0", "linux-x64"), "checksums.txt"],
    });
    expect(md.startsWith("## Metistry 0.2.0\n")).toBe(true);
    // the one changeset both packages carry appears once
    expect(md.match(/Release pipeline: versioned artifacts/g)).toHaveLength(1);
    expect(md.indexOf("### Minor Changes")).toBeLessThan(md.indexOf("### Patch Changes"));
    expect(md).toContain("- `@foldedspacelabs/metistry-cli@0.2.0`");
    expect(md).toContain("- `ghcr.io/foldedspacelabs/metistry-console:0.2.0`");
    expect(md).toContain("- `metistry-runtime-0.2.0-linux-x64.tar.gz`");
    expect(md).toContain("metistry update --version 0.2.0");
    expect(md).not.toContain("Updated dependencies");
  });

  it("says so rather than inventing changes when a version has no changesets", () => {
    expect(renderReleaseNotes({ version: "0.3.0", entries: [{ name: "x", changelog: CLI_CHANGELOG }] })).toContain("_No changesets in this release._");
  });
});

describe("notesEntries: the CLI package's own section, or a fallback", () => {
  // Two versions in the fixture, so picking the right one is actually tested.
  const CLI_WITH_BOTH = `# @foldedspacelabs/metistry-cli

## 0.2.0

### Minor Changes

- this version's story

## 0.1.0

### Minor Changes

- an older story that must not leak into 0.2.0's notes
`;
  const OTHER = { name: "@foldedspacelabs/metistry-other", changelog: "# other\n\n## 0.2.0\n\n### Patch Changes\n\n- unrelated package bump\n" };

  it("picks the CLI package's section for the tagged version", () => {
    const entries = [{ name: CLI_PACKAGE_NAME, changelog: CLI_WITH_BOTH }, OTHER];
    const picked = notesEntries(entries, "0.2.0");
    expect(picked).toEqual([entries[0]]);
    expect(sectionFor(picked[0]!.changelog, "0.2.0")).toContain("this version's story");
    expect(sectionFor(picked[0]!.changelog, "0.2.0")).not.toContain("older story");
  });

  it("falls back to every package's section when the CLI has no section for this version", () => {
    const entries = [{ name: CLI_PACKAGE_NAME, changelog: CLI_WITH_BOTH }, OTHER];
    expect(notesEntries(entries, "9.9.9")).toEqual(entries);
  });

  it("falls back when the CLI's section for this version is blank", () => {
    const cliBlank = { name: CLI_PACKAGE_NAME, changelog: "# @foldedspacelabs/metistry-cli\n\n## 0.5.0\n\n## 0.4.0\n\n### Patch Changes\n\n- x\n" };
    const entries = [cliBlank, OTHER];
    expect(notesEntries(entries, "0.5.0")).toEqual(entries);
  });

  it("falls back when there is no CLI package entry at all", () => {
    expect(notesEntries([OTHER], "0.2.0")).toEqual([OTHER]);
  });
});

describe("Sparkle appcast", () => {
  const item = {
    version: "0.2.0",
    url: "https://github.com/foldedspacelabs/metistry/releases/download/v0.2.0/Metistry-0.2.0.dmg",
    length: 74_182_144,
    pubDate: "Mon, 07 Sep 2026 15:00:00 +0000",
    minimumSystemVersion: "13.0",
    notesUrl: "https://github.com/foldedspacelabs/metistry/releases/tag/v0.2.0",
  };

  it("is a feed the updater can read: version, enclosure, length and the EdDSA signature", () => {
    const { xml, signed } = renderAppcast({ ...item, signature: "MC4CAQAwBQYDK2Vw" });
    expect(signed).toBe(true);
    expect(xml).toContain('<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">');
    expect(xml).toContain("<sparkle:version>0.2.0</sparkle:version>");
    expect(xml).toContain("<sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>");
    expect(xml).toContain(`<enclosure url="${item.url}" length="74182144" type="application/octet-stream" sparkle:edSignature="MC4CAQAwBQYDK2Vw"/>`);
    expect(xml).not.toContain(UNSIGNED_PLACEHOLDER);
  });

  it("marks an unsigned feed loudly instead of pretending — the key lives in a repo secret, never here", () => {
    const { xml, signed } = renderAppcast(item);
    expect(signed).toBe(false);
    expect(xml).toContain(UNSIGNED_PLACEHOLDER);
    expect(xml).toContain("DO NOT PUBLISH");
    expect(xml).toContain("SPARKLE_PRIVATE_KEY");
    // and no key material can be in the repo: the generator only ever takes a signature as input
    expect(repoFile("ops/release/appcast.mjs")).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });

  it("refuses a feed it cannot describe", () => {
    expect(() => renderAppcast({ ...item, url: "" })).toThrow(/url/);
    expect(() => renderAppcast({ ...item, length: 0 })).toThrow(/length/);
    expect(() => renderAppcast({ ...item, version: "" })).toThrow(/version/);
  });

  it("escapes what goes into the XML", () => {
    const { xml } = renderAppcast({ ...item, title: 'Metistry "0.2.0" <beta> & more' });
    expect(xml).toContain("<title>Metistry &quot;0.2.0&quot; &lt;beta&gt; &amp; more</title>");
  });
});

describe(".github/workflows/release.yml", () => {
  const wf = parseYaml(repoFile(".github/workflows/release.yml")) as {
    on: { push: { tags: string[] } };
    jobs: Record<string, { needs?: string | string[]; if?: unknown; permissions?: Record<string, string>; outputs?: Record<string, string>; strategy?: { matrix?: { app?: string[]; include?: { target: string }[] } } }>;
  };

  it("fires on a v* tag and gates everything on the verify job", () => {
    expect(wf.on.push.tags).toEqual(["v*"]);
    for (const job of ["runtime", "npm", "images", "publish"]) {
      expect([wf.jobs[job]!.needs].flat()).toContain("verify");
    }
  });

  it("builds a runtime pack per os-arch and a release for every asset metistry update looks for", () => {
    const targets = wf.jobs.runtime!.strategy!.matrix!.include!.map((i) => i.target);
    expect(targets.sort()).toEqual(["darwin-arm64", "linux-x64"]);
    const text = repoFile(".github/workflows/release.yml");
    for (const t of targets) expect(runtimeAssetName("0.0.0", t)).toContain(t);
    expect(text).toContain("sha256sum * | tee checksums.txt");
    expect(text).toContain("node ops/release/changelog.mjs");
    expect(text).toContain("gh release upload");
  });

  it("publishes npm with provenance and container images for the three app images", () => {
    expect(wf.jobs.npm!.permissions).toMatchObject({ "id-token": "write" });
    const text = repoFile(".github/workflows/release.yml");
    expect(text).toContain("--provenance");
    expect(text).toContain('NPM_CONFIG_PROVENANCE: "true"');
    expect(text).toContain("npm publish skipped — NPM_TOKEN is not set");
    // a 4xx from the registry is a skip too, not a silent success — it says so and reports it
    expect(text).toContain("::notice::npm publish skipped — the registry rejected it with a 4xx");
    expect(text).toContain('echo "published=true"');
    expect(wf.jobs.npm!.outputs).toMatchObject({ published: "${{ steps.publish.outputs.published }}" });
    expect(wf.jobs.images!.permissions).toMatchObject({ packages: "write" });
    expect(wf.jobs.images!.strategy!.matrix!.app).toEqual(["console", "assistant", "reconciler"]);
    // the watchdog is a launchd host job, not an image — it ships in the pack
    expect(wf.jobs.images!.strategy!.matrix!.app).not.toContain("watchdog");
    expect(wf.jobs.images!.outputs).toMatchObject({ published: "${{ steps.login.outcome == 'success' }}" });
  });

  it("tells a reader which of npm/images actually got published, not just that the workflow succeeded", () => {
    const text = repoFile(".github/workflows/release.yml");
    expect(text).toContain("NPM_PUBLISHED: ${{ needs.npm.outputs.published }}");
    expect(text).toContain("IMAGES_PUBLISHED: ${{ needs.images.outputs.published }}");
    expect(text).toContain("**Published:**");
  });

  it("carries the DMG and appcast jobs as disabled, documented stubs — there is no app yet", () => {
    for (const job of ["macos-app", "appcast"]) {
      expect(wf.jobs[job], `${job} is missing`).toBeDefined();
      expect(wf.jobs[job]!.if, `${job} must stay disabled`).toBe(false);
    }
    const text = repoFile(".github/workflows/release.yml");
    expect(text).toContain("SPARKLE_PRIVATE_KEY");
    expect(text).toContain("notarytool submit");
  });
});

describe("versioning", () => {
  it("changesets is in fixed mode: one version for the whole product, private apps versioned too", () => {
    const cfg = JSON.parse(repoFile(".changeset/config.json")) as { fixed: string[][]; privatePackages: { version: boolean; tag: boolean }; access: string };
    expect(cfg.fixed).toEqual([["@foldedspacelabs/metistry-*", "@metistry-apps/*"]]);
    expect(cfg.privatePackages).toEqual({ version: true, tag: false });
    expect(cfg.access).toBe("public");
  });

  it("the root package.json version is the product's VERSION, and CI checks it against packages/cli", () => {
    expect(JSON.parse(repoFile("package.json")).version).toBe(JSON.parse(repoFile("packages/cli/package.json")).version);
    expect(JSON.parse(repoFile("package.json")).scripts["release:version"]).toContain("ops/scripts/sync-root-version.mjs");
    expect(repoFile(".github/workflows/release.yml")).toContain("node ops/scripts/sync-root-version.mjs --check");
  });
});
