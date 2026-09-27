// The Mac app swap against a REAL disk image: `hdiutil create` builds a
// Metistry-<version>.dmg the way ops/release/build-app.sh does (the bundle
// plus an /Applications symlink, UDZO), a fake release serves it with its
// sha256 in checksums.txt, and `updateApp` runs with the real plutil, hdiutil,
// ditto, codesign, spctl and pgrep — into a scratch "Applications" directory
// under the OS temp dir, never the real one. macOS only (hdiutil); CI's Linux
// jobs skip it.
//
// Two real-world answers it pins: an unsigned local build is installed with
// the assessment skipped, and an ad-hoc signed one — which codesign verifies
// and Gatekeeper rejects — is refused with the installed app untouched.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { realExec } from "../src/exec.js";
import { appDmgAssetName, previousAppPath, readBundleInfo, updateApp } from "../src/mac-app.js";
import { CHECKSUMS_ASSET } from "../src/release.js";
import { StepRunner } from "../src/steps.js";
import { makeBundle } from "./fixtures.js";

const run = promisify(execFile);
const have = process.platform === "darwin" && existsSync("/usr/bin/hdiutil");

async function buildDmg(root: string, version: string, opts: { adhoc?: boolean } = {}): Promise<Buffer> {
  const stage = join(root, `stage-${version}${opts.adhoc ? "-adhoc" : ""}`);
  await makeBundle(join(stage, "Metistry.app"), version);
  if (opts.adhoc) await run("codesign", ["--sign", "-", "--force", join(stage, "Metistry.app")]);
  await symlink("/Applications", join(stage, "Applications"));
  const dmg = join(root, `${opts.adhoc ? "adhoc-" : ""}${appDmgAssetName(version)}`);
  await run("hdiutil", ["create", "-volname", `Metistry ${version}`, "-srcfolder", stage, "-ov", "-format", "UDZO", "-quiet", dmg], { timeout: 120_000 });
  return readFile(dmg);
}

function serve(version: string, dmg: Buffer) {
  const name = appDmgAssetName(version);
  const url = (n: string) => `https://example.test/dl/v${version}/${n}`;
  const sums = Buffer.from(`${createHash("sha256").update(dmg).digest("hex")}  ${name}\n`);
  return (async (u: string | URL | Request) => {
    const s = String(u);
    if (s.endsWith(`/releases/tags/v${version}`)) return new Response(JSON.stringify({ tag_name: `v${version}`, assets: [name, CHECKSUMS_ASSET].map((n) => ({ name: n, browser_download_url: url(n) })) }), { status: 200 });
    if (s === url(name)) return new Response(new Uint8Array(dmg), { status: 200 });
    if (s === url(CHECKSUMS_ASSET)) return new Response(new Uint8Array(sums), { status: 200 });
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "metistry-app-int-"));
  const d = { root, apps: join(root, "Applications"), home: join(root, "home"), product: join(root, "product"), mounts: join(root, "mnt") };
  for (const p of [d.apps, d.home, d.product, d.mounts]) await mkdir(p, { recursive: true });
  return { ...d, app: join(d.apps, "Metistry.app") };
}

async function mounted(root: string): Promise<boolean> {
  const { stdout } = await run("hdiutil", ["info"]);
  return stdout.includes(root);
}

describe.skipIf(!have)("the Mac app swap against a real DMG (macOS; skipped elsewhere)", () => {
  it("mounts read-only, verifies, swaps, keeps the previous, detaches — and a second run is a no-op", async () => {
    const d = await scratch();
    await makeBundle(d.app, "0.13.0");
    const fetchFn = serve("0.14.0", await buildDmg(d.root, "0.14.0"));
    const out: string[] = [];
    const r = new StepRunner({ dryRun: false, out: (l) => out.push(l), exec: realExec, env: { HOME: d.home } });

    const res = await updateApp(r, { productDir: d.product, version: "0.14.0", fetchFn, env: { HOME: d.home }, appPath: d.app, mountRoot: d.mounts });

    expect(res, out.join("\n")).toMatchObject({ status: "installed", version: "0.14.0", from: "0.13.0" });
    expect(await readBundleInfo(realExec, d.app)).toEqual({ id: "com.foldedspacelabs.metistry", version: "0.14.0" });
    expect((await readBundleInfo(realExec, previousAppPath(d.app))).version).toBe("0.13.0");
    expect(out.join("\n")).toContain("UNSIGNED");
    expect(await mounted(d.mounts)).toBe(false);
    expect(await readdir(d.mounts)).toEqual([]);
    expect((await readdir(d.apps)).sort()).toEqual(["Metistry.app", "Metistry.app.previous"]);

    const again = await updateApp(r, { productDir: d.product, version: "0.14.0", fetchFn, env: { HOME: d.home }, appPath: d.app, mountRoot: d.mounts });
    expect(again).toMatchObject({ status: "current", detail: "app already 0.14.0" });
  }, 180_000);

  it("REFUSES an ad-hoc signed app Gatekeeper rejects: the installed app is untouched and the image detached", async () => {
    const d = await scratch();
    await makeBundle(d.app, "0.13.0");
    const fetchFn = serve("0.14.0", await buildDmg(d.root, "0.14.0", { adhoc: true }));
    const out: string[] = [];
    const r = new StepRunner({ dryRun: false, out: (l) => out.push(l), exec: realExec, env: { HOME: d.home } });

    const res = await updateApp(r, { productDir: d.product, version: "0.14.0", fetchFn, env: { HOME: d.home }, appPath: d.app, mountRoot: d.mounts });

    expect(res.status, out.join("\n")).toBe("failed");
    expect(res.detail).toContain("spctl");
    expect((await readBundleInfo(realExec, d.app)).version).toBe("0.13.0");
    expect((await readdir(d.apps)).sort()).toEqual(["Metistry.app"]);
    expect(await mounted(d.mounts)).toBe(false);
  }, 180_000);
});
