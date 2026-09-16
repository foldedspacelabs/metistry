// The repo-level release tooling, held to the same standard as the CLI:
// the changelog generator against a changesets fixture, the Sparkle
// appcast against a release fixture (and its refusal to emit an unsigned
// feed), and the workflow itself — parsed, so the job names, the trigger
// and the asset names cannot drift from what `metistry update` downloads.
// (Reaching out of the package into ops/ follows lock-key.test.ts: the
// facts two files must agree on are asserted where the code lives.)
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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

describe("changelog.mjs CLI entrypoint", () => {
  // Regression test: `release.yml` invokes the generator with --assets and
  // --images flags (exactly like this), and a naive "first argv token not
  // starting with --" scan for the optional positional <root> arg picks up
  // a flag's *value* instead, sends collectEntries() to a nonexistent path,
  // and silently renders "_No changesets in this release._" even though
  // packages/cli/CHANGELOG.md has a real 0.2.0 section.
  it("still finds real changeset entries when --assets and --images are passed", () => {
    const scriptPath = fileURLToPath(new URL("../../../ops/release/changelog.mjs", import.meta.url));
    const out = execFileSync(
      process.execPath,
      [scriptPath, "0.2.0", "--assets", "checksums.txt,a.tar.gz", "--images", "ghcr.io/x/metistry-console:0.2.0"],
      { encoding: "utf8" },
    );
    expect(out).not.toContain("_No changesets in this release._");
    expect(out).toContain("Two install verbs, terminal-first");
    expect(out).toContain("### Container images");
    expect(out).toContain("- `ghcr.io/x/metistry-console:0.2.0`");
    expect(out).toContain("### Assets");
    expect(out).toContain("- `checksums.txt`");
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

  it("publishes npm via Trusted Publishing (OIDC, no token) and container images for the three app images", () => {
    // Trusted Publishing needs both permissions, and no long-lived token anywhere.
    expect(wf.jobs.npm!.permissions).toMatchObject({ "id-token": "write", contents: "read" });
    const text = repoFile(".github/workflows/release.yml");
    expect(text).not.toContain("NPM_TOKEN");
    expect(text).not.toContain("NODE_AUTH_TOKEN");
    expect(text).toContain("--provenance");
    // provenance is unsupported for a private repo even for a public package — gated on repository.private
    expect(text).toContain("github.event.repository.private");
    expect(text).toContain("npm install -g npm@latest");
    // a 4xx from the registry (not configured for Trusted Publishing yet) is a skip, not a failure
    expect(text).toContain("::notice::npm publish skipped for $name");
    expect(text).toContain('published_any=true');
    expect(text).toContain('echo "published=$published_any"');
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

  it("builds the DMG and the appcast for real — on macos-14, from the packs this run already built", () => {
    for (const job of ["macos-app", "appcast"]) {
      expect(wf.jobs[job], `${job} is missing`).toBeDefined();
      // These were `if: false` stubs until the app existed (apps/macos, 2026-09-09).
      expect(wf.jobs[job]!.if, `${job} must not be disabled`).not.toBe(false);
      expect(String(wf.jobs[job]!["runs-on"]), `${job} must run on macOS`).toMatch(/^macos-/);
    }
    // Swift 6 tools version: the macos-14 image's Xcode is 15.4 / Swift 5.10 and
    // refuses the package outright, so the job that COMPILES has to be newer.
    // `appcast` only runs sign_update and node, so it can stay on macos-14.
    expect(wf.jobs["macos-app"]!["runs-on"]).toBe("macos-15");
    expect(repoFile("apps/macos/Package.swift")).toContain("swift-tools-version: 6.0");
    expect(parseYaml(repoFile(".github/workflows/ci.yml")).jobs["macos-app"]["runs-on"]).toBe("macos-15");
    const text = repoFile(".github/workflows/release.yml");
    expect(text).toContain("ops/release/build-app.sh");
    expect(text).toContain("ops/release/notarize.sh");
    expect(text).toContain("ops/release/fetch-sparkle-tools.sh");
    expect(text).toContain("ops/release/appcast.mjs");
    expect(text).toContain("sparkle/bin/sign_update");
    // The app embeds the packs this run produced rather than rebuilding the
    // product a second time, so the DMG and `metistry update` ship the same bytes.
    expect(text).toContain("name: runtime-darwin-arm64");
    expect(text).toContain("name: runtime-deps-darwin-arm64");
    // exact secret names actually set on foldedspacelabs/metistry — an
    // Apple ID + app-specific password is not how notarization works here
    for (const secret of ["APPLE_CERTIFICATE_P12", "APPLE_CERTIFICATE_PASSWORD", "APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID", "APPLE_API_KEY_P8", "SPARKLE_PRIVATE_KEY"]) {
      expect(text, `expected secrets.${secret} in release.yml`).toContain(`secrets.${secret}`);
    }
    expect(text).not.toContain("APPLE_ID");
    expect(text).not.toContain("APPLE_APP_SPECIFIC_PASSWORD");
    // APPLE_TEAM_ID belonged to the `xcodebuild archive` the stub imagined
    // (DEVELOPMENT_TEAM=). There is no Xcode project: the signing identity
    // carries the team, and notarytool authenticates with the API key.
    expect(text).not.toContain("APPLE_TEAM_ID");
  });

  it("a release without the Apple or Sparkle secrets is still a complete release", () => {
    const text = repoFile(".github/workflows/release.yml");
    // `secrets` is not available in a job-level `if`, so each job gates itself
    // in its first step and says so — the same courtesy `images` extends a fork
    // without packages:write, rather than failing the whole release. The
    // Developer ID gate lives in the composite action every darwin job uses.
    const keychain = repoFile(".github/actions/apple-keychain/action.yml");
    expect(keychain).toContain("::notice::APPLE_CERTIFICATE_P12/APPLE_CERTIFICATE_PASSWORD are not set");
    for (const job of ["runtime", "runtime-deps", "macos-app"]) {
      const steps = (wf.jobs[job] as { steps: { uses?: string }[] }).steps;
      expect(steps.some((st) => st.uses === "./.github/actions/apple-keychain"), `${job} imports the Developer ID via the composite action`).toBe(true);
    }
    expect(text).toContain("::notice::SPARKLE_PRIVATE_KEY is not set");
    expect(text).toContain("::notice::APPLE_API_KEY_P8 is not set");
    expect(wf.jobs["macos-app"]!.outputs).toMatchObject({ built: "${{ steps.gate.outputs.ok }}" });
    // publish waits for both but tolerates either being absent: its gate names
    // only verify/runtime/runtime-deps.
    expect(wf.jobs.publish!.needs).toEqual(["verify", "runtime", "runtime-deps", "npm", "images", "macos-app", "appcast"]);
    expect(String(wf.jobs.publish!.if)).not.toContain("macos-app");
  });

  it("checksums.txt covers the DMG and the appcast, not just the runtime packs", () => {
    const text = repoFile(".github/workflows/release.yml");
    // Every asset lands in the same `assets/` directory before `sha256sum *`.
    for (const pattern of ["pattern: runtime-*", "pattern: macos-app", "pattern: appcast"]) {
      expect(text, `expected download ${pattern}`).toContain(pattern);
    }
    expect(text).toContain("sha256sum * | tee checksums.txt");
  });

  it("the app's Info.plist and the pinned Sparkle tooling agree", () => {
    const plist = repoFile("apps/macos/resources/Info.plist");
    const versions = repoFile("ops/release/runtime-versions.env");
    const publicKey = /SPARKLE_PUBLIC_ED_KEY=(\S+)/.exec(versions)?.[1];
    expect(publicKey, "SPARKLE_PUBLIC_ED_KEY missing from runtime-versions.env").toBeTruthy();
    // The app verifies the feed with this key; the workflow signs it with the
    // matching private key. If they drift, every update is rejected silently.
    expect(plist).toContain(`<string>${publicKey}</string>`);
    expect(plist).toContain("<key>SUPublicEDKey</key>");
    // The framework linked into the app and the sign_update that signs its feed
    // must be the same Sparkle release.
    const sparkleVersion = /SPARKLE_VERSION=(\S+)/.exec(versions)?.[1];
    expect(repoFile("apps/macos/Package.swift")).toContain(`exact: "${sparkleVersion}"`);
    expect(JSON.parse(repoFile("apps/macos/Package.resolved")).pins[0].state.version).toBe(sparkleVersion);
    // The feed the app polls is the one the release publishes.
    expect(plist).toContain("releases/latest/download/appcast.xml");
  });

  it("the app declares the bundle id everything else already assumes", () => {
    // The TCC helpers are com.foldedspacelabs.metistry.<bridge>; the app is the
    // root of that namespace (docs/ops/apple-signing.md §3).
    expect(repoFile("apps/macos/resources/Info.plist")).toContain("<string>com.foldedspacelabs.metistry</string>");
    expect(repoFile("ops/release/build-app.sh")).toContain("--identifier com.foldedspacelabs.metistry");
  });

  it("the bundle carries the ONE agent where SMAppService.agent(plistName:) looks, and the audit lets a plist through", () => {
    // `SMAppService.agent(plistName:)` resolves exactly one path:
    // <app>/Contents/Library/LaunchAgents/<plistName>. The Swift call names
    // the file; build-app.sh puts it there; neither may drift from the other.
    const build = repoFile("ops/release/build-app.sh");
    expect(build).toContain('mkdir -p "$contents/Library/LaunchAgents"');
    expect(build).toContain('cp "$app_src/resources/launchd/com.foldedspacelabs.metistry.plist" "$contents/Library/LaunchAgents/com.foldedspacelabs.metistry.plist"');
    expect(repoFile("apps/macos/sources/kit/background-agent.swift")).toContain('"com.foldedspacelabs.metistry.plist"');
    // Its BundleProgram is a RESOURCE, not Contents/MacOS: codesign treats
    // everything in MacOS/ as nested code needing its own signature, and a
    // shell script cannot carry one (the v0.7.0 DMG job learned this).
    expect(repoFile("apps/macos/resources/launchd/com.foldedspacelabs.metistry.plist")).toContain("<key>BundleProgram</key><string>Contents/Resources/MetistrySupervisor</string>");
    expect(build).toContain('cp "$app_src/resources/launchd/metistry-supervisor" "$contents/Resources/MetistrySupervisor"');
    // …and the pre-notarization audit walks every file but only judges the
    // Mach-O ones, so a plist sealed under Contents/Library is not a finding.
    expect(build).toMatch(/case "\$\(file -b "\$f"\)" in Mach-O\*\) ;; \*\) continue ;; esac/);
  });

  it("no assistant name is baked into the app (CLAUDE.md: it lives only in identity.yaml)", () => {
    // The one place a name can enter is the wizard's text field, which sends it
    // to `metistry init --name`. Every Swift source is walked rather than a
    // hand-written list, so adding a view cannot quietly escape the rule.
    const swiftSources = ["sources/kit", "sources/app"].flatMap((dir) => {
      const abs = fileURLToPath(new URL(`../../../apps/macos/${dir}`, import.meta.url));
      return readdirSync(abs)
        .filter((f) => f.endsWith(".swift"))
        .map((f) => `apps/macos/${dir}/${f}`);
    });
    expect(swiftSources.length).toBeGreaterThan(10);
    for (const file of [...swiftSources, "apps/macos/resources/Info.plist"]) {
      expect(repoFile(file).toLowerCase(), `${file} must not name the assistant`).not.toContain("metis ");
    }
    expect(repoFile("apps/macos/sources/kit/first-run-model.swift")).toContain('"--name"');
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
