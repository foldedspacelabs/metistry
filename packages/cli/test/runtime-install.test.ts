// `metistry runtime install` — the bundle's Resources are a SEED; the
// product dir is a writable copy of it (docs/product/desktop-app-plan.md,
// "Where a bundled install's writable product dir lives"). A synthetic
// bundle stands in for Metistry.app: the same layout ops/release/
// build-app.sh assembles, small enough to build in a temp dir.
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeExec } from "./fixtures.js";
import { defaultProductDir, describeSeed, installRuntime, readReceipt, seedDirOf, upToDate, BUNDLE_SEED_REL, INSTALL_RECEIPT } from "../src/runtime-install.js";
import { StepRunner } from "../src/steps.js";

const V = "0.4.0";

async function put(root: string, rel: string, text: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), text);
}

/** A Metistry.app whose Contents/Resources/metistry is what build-app.sh puts there. */
async function bundle(opts: { version?: string; runtime?: boolean; manifestVersion?: string; cli?: boolean } = {}): Promise<string> {
  const version = opts.version ?? V;
  const app = join(await mkdtemp(join(tmpdir(), "metistry-app-")), "Metistry.app");
  const seed = join(app, BUNDLE_SEED_REL);
  const rel = join(seed, "releases", version);
  await mkdir(rel, { recursive: true });
  await put(rel, "metistry-runtime.json", JSON.stringify({ version: opts.manifestVersion ?? version, target: "darwin-arm64", commit: "abc1234def", built_at: "2026-09-10T00:00:00Z" }));
  if (opts.cli !== false) await put(rel, "packages/cli/dist/main.js", "// cli\n");
  await put(rel, "db/migrations/0001_init.sql", "select 1;\n");
  await symlink(join("releases", version), join(seed, "current"));
  if (opts.runtime !== false) {
    await put(seed, "runtime/manifest.json", JSON.stringify({ schema: 1, target: "darwin-arm64", components: { node: { version: "22.23.2" }, postgres: { version: "17.11" }, git: { version: "2.55.0" } } }));
    await put(seed, "runtime/node/bin/node", "#!/bin/sh\n");
    await put(seed, "runtime/postgres/bin/postgres", "#!/bin/sh\n");
    // libpq's versioned-name symlink farm: it must survive the copy as links
    await symlink("libpq.5.dylib", join(seed, "runtime/postgres/libpq.dylib"));
  }
  // a signed bundle's Resources are read-only
  await chmod(rel, 0o555);
  return app;
}

const runner = () => new StepRunner({ dryRun: false, out: () => {}, exec: fakeExec() });

describe("reading the seed", () => {
  it("--from takes the .app or the Resources directory inside it", async () => {
    const app = await bundle();
    expect(seedDirOf(app)).toBe(join(app, BUNDLE_SEED_REL));
    expect(seedDirOf(join(app, BUNDLE_SEED_REL))).toBe(join(app, BUNDLE_SEED_REL));
    const s = await describeSeed(app);
    expect(s.version).toBe(V);
    expect(s.commit).toBe("abc1234def");
    expect(s.releaseManifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.runtime?.components).toBe("node 22.23.2, postgres 17.11, git 2.55.0");
  });

  it("refuses a bundle that is not a product seed — BEFORE anything is copied", async () => {
    await expect(describeSeed(join(tmpdir(), "nope-does-not-exist"))).rejects.toThrow(/does not exist/);
    const noCurrent = await mkdtemp(join(tmpdir(), "metistry-seed-"));
    await expect(describeSeed(noCurrent)).rejects.toThrow(/has no current symlink/);
    // current points at a release whose own manifest says a different version
    const lying = await bundle({ manifestVersion: "9.9.9" });
    await expect(describeSeed(lying)).rejects.toThrow(/assembled by hand/);
    // no CLI inside: nothing installed from it could run
    const empty = await bundle({ cli: false });
    await expect(describeSeed(empty)).rejects.toThrow(/no packages\/cli\/dist\/main\.js/);
  });

  it("a seed with a runtime/ but no manifest.json is unverifiable and refused", async () => {
    const app = await bundle();
    await rm(join(app, BUNDLE_SEED_REL, "runtime", "manifest.json"));
    await expect(describeSeed(app)).rejects.toThrow(/refusing to install an unverifiable bundled runtime/);
  });
});

describe("installing it", () => {
  it("lays out exactly what `metistry update` in release mode does, and leaves it WRITABLE", async () => {
    const app = await bundle();
    const to = join(await mkdtemp(join(tmpdir(), "metistry-prod-")), "product");
    const r = await installRuntime(runner(), { from: app, to });
    expect(r.installed).toBe(true);
    expect(r.productDir).toBe(to);
    expect(existsSync(join(to, "releases", V, "packages/cli/dist/main.js"))).toBe(true);
    expect(existsSync(join(to, "runtime", "manifest.json"))).toBe(true);
    // `current` is RELATIVE, so the product dir stays movable (release.ts)
    expect(await readFile(join(to, "current", "metistry-runtime.json"), "utf8")).toContain('"version":"0.4.0"');
    // runtime/.release is what runtime-deps.ts compares a release against —
    // a bundled runtime and a downloaded one must be indistinguishable to it
    expect((await readFile(join(to, "runtime", ".release"), "utf8")).trim()).toBe(V);
    // `metistry update` must be able to DELETE this tree to install the next
    // release over it. The bundle's copy was 0555; if the copy inherited that,
    // this throws EACCES — which is exactly the failure this verb exists to
    // avoid, so it is an assertion rather than a comment.
    await rm(join(to, "releases", V), { recursive: true });
  });

  it("the receipt records the version and both manifest digests, and a second run is a no-op", async () => {
    const app = await bundle();
    const to = join(await mkdtemp(join(tmpdir(), "metistry-prod-")), "product");
    await installRuntime(runner(), { from: app, to, now: new Date("2026-09-10T12:00:00Z") });
    const receipt = await readReceipt(to);
    expect(receipt).toMatchObject({ schema: 1, version: V, installed_at: "2026-09-10T12:00:00.000Z" });
    expect(receipt!.release.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt!.release.commit).toBe("abc1234def");
    expect(receipt!.runtime!.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt!.runtime!.target).toBe("darwin-arm64");

    const again = await installRuntime(runner(), { from: app, to });
    expect(again.installed).toBe(false);
    expect(again.reason).toMatch(/already holds this seed/);

    // --force copies anyway
    expect((await installRuntime(runner(), { from: app, to, force: true })).installed).toBe(true);
  });

  it("a CHANGED seed (the app Sparkle-updated itself) is copied forward", async () => {
    const app = await bundle();
    const to = join(await mkdtemp(join(tmpdir(), "metistry-prod-")), "product");
    await installRuntime(runner(), { from: app, to });
    const newer = await bundle({ version: "0.5.0" });
    const r = await installRuntime(runner(), { from: newer, to });
    expect(r.installed).toBe(true);
    expect(r.version).toBe("0.5.0");
    expect((await readReceipt(to))!.version).toBe("0.5.0");
    // the previous release tree stays on disk — `metistry update --rollback`
    // is a symlink flip and needs it
    expect(existsSync(join(to, "releases", V))).toBe(true);
    expect(await readFile(join(to, "current", "metistry-runtime.json"), "utf8")).toContain('"version":"0.5.0"');
  });

  it("a half-deleted product dir is re-installed even though the receipt says otherwise", async () => {
    const app = await bundle();
    const to = join(await mkdtemp(join(tmpdir(), "metistry-prod-")), "product");
    await installRuntime(runner(), { from: app, to });
    const seed = await describeSeed(app);
    expect(upToDate(await readReceipt(to), seed, to)).toBe(true);
    await rm(join(to, "runtime"), { recursive: true });
    expect(upToDate(await readReceipt(to), seed, to)).toBe(false);
    expect((await installRuntime(runner(), { from: app, to })).installed).toBe(true);
  });

  it("--dry-run copies nothing", async () => {
    const app = await bundle();
    const to = join(await mkdtemp(join(tmpdir(), "metistry-prod-")), "product");
    const r = new StepRunner({ dryRun: true, out: () => {}, exec: fakeExec() });
    const res = await installRuntime(r, { from: app, to });
    expect(res.installed).toBe(false);
    expect(existsSync(to)).toBe(false);
    expect(r.commands.join("\n")).toContain("releases/0.4.0");
  });

  it("the default target is under Application Support, never inside the bundle", async () => {
    expect(defaultProductDir("/Users/x")).toBe("/Users/x/Library/Application Support/Metistry/product");
    const app = await bundle();
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const r = await installRuntime(runner(), { from: app, home });
    expect(r.productDir).toBe(defaultProductDir(home));
    expect(r.productDir.includes(".app/")).toBe(false);
    expect(existsSync(join(r.productDir, INSTALL_RECEIPT))).toBe(true);
  });
});
