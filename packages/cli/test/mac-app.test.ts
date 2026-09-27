// The Mac app half of `metistry update` (mac-app.ts), against a scratch
// "Applications" directory, a fake release served by an injected `fetch`, and
// an injected exec that plays plutil, hdiutil, ditto, codesign, spctl, pgrep,
// kill and open. Nothing here reaches the real /Applications: every test names
// its app path, and the default-candidate test reads a scratch HOME only.
//
// The refusals are the point (U3): a checksum mismatch, a DMG whose version
// or bundle id is wrong, a signature Gatekeeper rejects, an unsigned app over
// a signed one — each leaves the installed app byte for byte as it was.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecOptions } from "../src/exec.js";
import { APP_BUNDLE_ID, appCandidates, appDmgAssetName, compareVersions, previousAppPath, resolveAppPath, rollbackApp, updateApp } from "../src/mac-app.js";
import { CHECKSUMS_ASSET, runtimeAssetName } from "../src/release.js";
import { StepRunner } from "../src/steps.js";
import { update, updateSummary } from "../src/update.js";
import { appRow } from "../src/doctor.js";
import { serializeLock } from "../src/lock.js";
import { defaultUi } from "../src/ui.js";
import { checkout, fakeExec, makeBundle, okDoctor } from "./fixtures.js";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

async function bundleVersion(path: string): Promise<string | undefined> {
  try {
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(await readFile(join(path, "Contents", "Info.plist"), "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

interface Fakes {
  /** what the DMG's Metistry.app says it is */
  dmgVersion?: string;
  dmgId?: string;
  /** the DMG carries no Metistry.app at all */
  dmgEmpty?: boolean;
  /** codesign -dv answers "signed" for paths containing these substrings */
  signed?: (path: string) => boolean;
  spctlCode?: number;
  codesignVerifyCode?: number;
  /** pgrep's answer, per call */
  pgrep?: () => string;
}

/** plutil reads the real file; hdiutil attach lays a bundle into the mountpoint; ditto copies. */
function appExec(f: Fakes = {}) {
  return fakeExec({
    plutil: async (args: string[]) => {
      const key = args[1]!;
      const file = args[args.length - 1]!;
      if (!existsSync(file)) return { code: 1, stdout: "", stderr: "no file" };
      const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(await readFile(file, "utf8"));
      return m ? { code: 0, stdout: `${m[1]}\n` } : { code: 1, stdout: "", stderr: "no key" };
    },
    hdiutil: async (args: string[]) => {
      if (args[0] !== "attach") return { code: 0 };
      const mp = args[args.indexOf("-mountpoint") + 1]!;
      if (!f.dmgEmpty) await makeBundle(join(mp, "Metistry.app"), f.dmgVersion ?? "0.14.0", f.dmgId);
      return { code: 0 };
    },
    ditto: async (args: string[]) => {
      await cp(args[0]!, args[1]!, { recursive: true });
      return { code: 0 };
    },
    codesign: async (args: string[]) => {
      if (args[0] === "-dv") return f.signed?.(args[1]!) ? { code: 0 } : { code: 1, stderr: "code object is not signed at all" };
      return { code: f.codesignVerifyCode ?? 0 };
    },
    spctl: async () => ({ code: f.spctlCode ?? 0, ...(f.spctlCode ? { stderr: "rejected" } : {}) }),
    pgrep: async () => {
      const out = f.pgrep?.() ?? "";
      return out ? { code: 0, stdout: out } : { code: 1, stdout: "" };
    },
  });
}

/** A release with a DMG, a checksums.txt that lists it, and a runtime pack. `corrupt` serves DMG bytes that do not match. */
function releaseServer(o: { version: string; corrupt?: boolean; noDmg?: boolean; target?: string }) {
  const v = o.version;
  const dmg = appDmgAssetName(v);
  const pack = runtimeAssetName(v, o.target ?? "linux-x64");
  const dmgBytes = Buffer.from(`a disk image for ${v}\n`);
  const packBytes = Buffer.from(`runtime pack for ${v}\n`);
  const url = (n: string) => `https://example.test/dl/v${v}/${n}`;
  const bodies = new Map<string, Buffer>([
    [url(dmg), o.corrupt ? Buffer.from("not the image you were promised") : dmgBytes],
    [url(pack), packBytes],
    [url(CHECKSUMS_ASSET), Buffer.from(`${sha256(packBytes)}  ${pack}\n${sha256(dmgBytes)}  ${dmg}\n`)],
  ]);
  const calls: string[] = [];
  const fn = (async (u: string | URL | Request) => {
    const s = String(u);
    calls.push(s);
    if (s.endsWith("/releases/latest") || s.endsWith(`/releases/tags/v${v}`)) {
      const names = [pack, CHECKSUMS_ASSET, ...(o.noDmg ? [] : [dmg])];
      return new Response(JSON.stringify({ tag_name: `v${v}`, assets: names.map((n) => ({ name: n, browser_download_url: url(n) })) }), { status: 200 });
    }
    const b = bodies.get(s);
    return b ? new Response(new Uint8Array(b), { status: 200 }) : new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function runner(exec: ReturnType<typeof appExec>, dryRun = false) {
  const out: string[] = [];
  return { r: new StepRunner({ dryRun, out: (l) => out.push(l), exec, env: {} }), out };
}

const scratch: string[] = [];
async function scratchDirs() {
  const root = await mkdtemp(join(tmpdir(), "metistry-app-"));
  scratch.push(root);
  const apps = join(root, "Applications");
  const home = join(root, "home");
  const product = join(root, "product");
  const mounts = join(root, "mnt");
  for (const d of [apps, home, product, mounts]) await mkdir(d, { recursive: true });
  return { root, apps, home, product, mounts, app: join(apps, "Metistry.app") };
}
afterEach(async () => {
  // a test that made its Applications read-only hands it back writable, so the OS can clean it
  for (const d of scratch.splice(0)) await chmod(join(d, "Applications"), 0o755).catch(() => {});
});

const noSleep = async () => {};

describe("the Mac app's release asset and paths", () => {
  it("names the DMG the release workflow and build-app.sh produce", async () => {
    expect(appDmgAssetName("0.14.0")).toBe("Metistry-0.14.0.dmg");
    expect(appDmgAssetName("v0.14.0")).toBe("Metistry-0.14.0.dmg");
    const wf = await readFile(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(wf).toContain("Metistry-$VERSION.dmg");
    const build = await readFile(new URL("../../../ops/release/build-app.sh", import.meta.url), "utf8");
    expect(build).toContain('dmg="$outdir/Metistry-$version.dmg"');
    // the bundle id the swap insists on is the one the app ships with
    const plist = await readFile(new URL("../../../apps/macos/resources/Info.plist", import.meta.url), "utf8");
    expect(plist).toMatch(new RegExp(`<key>CFBundleIdentifier</key>\\s*<string>${APP_BUNDLE_ID.replace(/\./g, "\\.")}</string>`));
  });

  it("looks in /Applications then ~/Applications, and METISTRY_APP_PATH replaces both", () => {
    expect(appCandidates({ HOME: "/Users/o" })).toEqual(["/Applications/Metistry.app", "/Users/o/Applications/Metistry.app"]);
    expect(appCandidates({})).toEqual(["/Applications/Metistry.app"]);
    expect(appCandidates({ HOME: "/Users/o", METISTRY_APP_PATH: "/x/Metistry.app" })).toEqual(["/x/Metistry.app"]);
  });

  it("compares versions numerically and never guesses at a non-semver one", () => {
    expect(compareVersions("0.14.0", "0.13.9")).toBe(1);
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("v0.14.0", "0.14.0")).toBe(0);
    expect(compareVersions("0.14.0", "<latest>")).toBeUndefined();
  });

  it("an app at the path that is not Metistry is left untouched — found by default or named", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "1.0.0", "com.example.other");
    const exec = appExec();
    expect(await resolveAppPath(exec, { METISTRY_APP_PATH: d.app }, undefined)).toMatchObject({ skip: expect.stringContaining("is not com.foldedspacelabs.metistry") });
    expect(await resolveAppPath(exec, {}, d.app)).toMatchObject({ skip: expect.stringContaining("is not Metistry") });
    expect(await resolveAppPath(exec, {}, null)).toEqual({ skip: "--no-app: the Mac app is left as it is" });
  });
});

describe("updateApp: download, verify, swap", () => {
  it("swaps in the release's app and keeps the old one as Metistry.app.previous", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "0.13.0");
    const exec = appExec();
    const s = releaseServer({ version: "0.14.0" });
    const { r, out } = runner(exec);

    const res = await updateApp(r, { productDir: d.product, version: "0.14.0", fetchFn: s.fn, env: {}, appPath: d.app, mountRoot: d.mounts });

    expect(res).toMatchObject({ status: "installed", version: "0.14.0", from: "0.13.0", path: d.app });
    expect(await bundleVersion(d.app)).toBe("0.14.0");
    expect(await bundleVersion(previousAppPath(d.app))).toBe("0.13.0");
    // mounted read-only, with no Finder window, and detached again
    const attach = exec.calls.find((c) => c.cmd === "hdiutil" && c.args[0] === "attach")!;
    expect(attach.args).toEqual(expect.arrayContaining(["-nobrowse", "-readonly"]));
    expect(attach.args[attach.args.length - 1]).toBe(join(d.product, ".app-download", "Metistry-0.14.0.dmg"));
    expect(exec.calls.some((c) => c.cmd === "hdiutil" && c.args[0] === "detach")).toBe(true);
    // unsigned: said out loud, and Gatekeeper is not asked
    expect(out.join("\n")).toContain("UNSIGNED");
    expect(exec.calls.some((c) => c.cmd === "spctl")).toBe(false);
    // nothing left behind: no download, no mountpoint, no half-copied bundle
    expect(existsSync(join(d.product, ".app-download"))).toBe(false);
    expect(await readdir(d.mounts)).toEqual([]);
    expect((await readdir(d.apps)).sort()).toEqual(["Metistry.app", "Metistry.app.previous"]);
    // never sudo, never a kill
    expect(exec.calls.map((c) => c.cmd)).not.toContain("sudo");
    expect(exec.calls.map((c) => c.cmd)).not.toContain("kill");
  });

  it("is idempotent: the release's version already installed downloads nothing", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "0.14.0");
    const exec = appExec();
    const s = releaseServer({ version: "0.14.0" });
    const { r, out } = runner(exec);
    const res = await updateApp(r, { productDir: d.product, version: "0.14.0", fetchFn: s.fn, env: {}, appPath: d.app, mountRoot: d.mounts });
    expect(res).toMatchObject({ status: "current", detail: "app already 0.14.0" });
    expect(out.join("\n")).toContain("app already 0.14.0");
    expect(s.calls).toEqual([]);
    expect(exec.calls.some((c) => c.cmd === "hdiutil")).toBe(false);
    expect(existsSync(previousAppPath(d.app))).toBe(false);
  });

  it("never downgrades an app that is newer than the release", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "0.15.0");
    const s = releaseServer({ version: "0.14.0" });
    const { r } = runner(appExec());
    const res = await updateApp(r, { productDir: d.product, version: "0.14.0", fetchFn: s.fn, env: {}, appPath: d.app, mountRoot: d.mounts });
    expect(res.status).toBe("skipped");
    expect(res.detail).toContain("newer than release 0.14.0");
    expect(await bundleVersion(d.app)).toBe("0.15.0");
    expect(s.calls).toEqual([]);
  });

  it("REFUSES a DMG whose bytes do not match checksums.txt — nothing mounted, the app untouched", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "0.13.0");
    const exec = appExec();
    const { r, out } = runner(exec);
    const res = await updateApp(r, { productDir: d.product, version: "0.14.0", fetchFn: releaseServer({ version: "0.14.0", corrupt: true }).fn, env: {}, appPath: d.app, mountRoot: d.mounts });
    expect(res.status).toBe("failed");
    expect(out.join("\n")).toMatch(/Metistry-0\.14\.0\.dmg failed its checksum/);
    expect(exec.calls.some((c) => c.cmd === "hdiutil")).toBe(false);
    expect(await bundleVersion(d.app)).toBe("0.13.0");
    expect(existsSync(previousAppPath(d.app))).toBe(false);
    expect(existsSync(join(d.product, ".app-download"))).toBe(false);
  });

  it("REFUSES a DMG whose app is not the release's version, or not Metistry — and still detaches", async () => {
    for (const f of [{ dmgVersion: "0.13.9" }, { dmgId: "com.example.impostor" }, { dmgEmpty: true }]) {
      const d = await scratchDirs();
      await makeBundle(d.app, "0.13.0");
      const exec = appExec(f);
      const { r } = runner(exec);
      const res = await updateApp(r, { productDir: d.product, version: "0.14.0", fetchFn: releaseServer({ version: "0.14.0" }).fn, env: {}, appPath: d.app, mountRoot: d.mounts });
      expect(res.status, JSON.stringify(f)).toBe("failed");
      expect(res.detail).toMatch(f.dmgVersion ? /is 0\.13\.9 \(CFBundleShortVersionString\), not the release's 0\.14\.0/ : f.dmgId ? /bundle id is com\.example\.impostor/ : /has no Metistry\.app/);
      expect(await bundleVersion(d.app)).toBe("0.13.0");
      expect(existsSync(previousAppPath(d.app))).toBe(false);
      expect((await readdir(d.apps)).sort()).toEqual(["Metistry.app"]);
      expect(exec.calls.some((c) => c.cmd === "hdiutil" && c.args[0] === "detach")).toBe(true);
      expect(await readdir(d.mounts)).toEqual([]);
    }
  });

  it("a signed app must pass codesign --verify --deep --strict AND Gatekeeper; a rejection leaves the app as it was", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "0.13.0");
    const signed = () => true;
    const ok = appExec({ signed });
    const res = await updateApp(runner(ok).r, { productDir: d.product, version: "0.14.0", fetchFn: releaseServer({ version: "0.14.0" }).fn, env: {}, appPath: d.app, mountRoot: d.mounts });
    expect(res.status).toBe("installed");
    const verify = ok.calls.find((c) => c.cmd === "codesign" && c.args[0] === "--verify")!;
    expect(verify.args.slice(0, 3)).toEqual(["--verify", "--deep", "--strict"]);
    // what is checked is the COPY that lands, not the image it came from
    expect(verify.args[3]).toBe(join(d.apps, ".Metistry.app.incoming"));
    expect(ok.calls.find((c) => c.cmd === "spctl")!.args).toEqual(["--assess", "--type", "execute", join(d.apps, ".Metistry.app.incoming")]);

    const e = await scratchDirs();
    await makeBundle(e.app, "0.13.0");
    const rejected = appExec({ signed, spctlCode: 3 });
    const res2 = await updateApp(runner(rejected).r, { productDir: e.product, version: "0.14.0", fetchFn: releaseServer({ version: "0.14.0" }).fn, env: {}, appPath: e.app, mountRoot: e.mounts });
    expect(res2.status).toBe("failed");
    expect(res2.detail).toContain("spctl");
    expect(await bundleVersion(e.app)).toBe("0.13.0");
    expect((await readdir(e.apps)).sort()).toEqual(["Metistry.app"]);
  });

  it("REFUSES to replace a signed app with an unsigned one", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "0.13.0");
    // the installed app is signed; the copy from the DMG is not
    const exec = appExec({ signed: (p) => p === d.app });
    const res = await updateApp(runner(exec).r, { productDir: d.product, version: "0.14.0", fetchFn: releaseServer({ version: "0.14.0" }).fn, env: {}, appPath: d.app, mountRoot: d.mounts });
    expect(res.status).toBe("failed");
    expect(res.detail).toContain("refusing to replace a signed app with an unsigned one");
    expect(await bundleVersion(d.app)).toBe("0.13.0");
  });

  it("a filesystem refusal mid-swap (an old previous it cannot remove) is a failed line, never a thrown update", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "0.13.0");
    const stuck = await makeBundle(previousAppPath(d.app), "0.12.0");
    await chmod(join(stuck, "Contents"), 0o555);
    try {
      const res = await updateApp(runner(appExec()).r, { productDir: d.product, version: "0.14.0", fetchFn: releaseServer({ version: "0.14.0" }).fn, env: {}, appPath: d.app, mountRoot: d.mounts });
      expect(res.status).toBe("failed");
      expect(res.detail).toMatch(/EACCES|permission denied/i);
      expect(await bundleVersion(d.app)).toBe("0.13.0");
      expect(await readdir(d.mounts)).toEqual([]);
    } finally {
      await chmod(join(stuck, "Contents"), 0o755);
    }
  });

  it("a release with no DMG leaves the app where it is", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "0.13.0");
    const res = await updateApp(runner(appExec()).r, { productDir: d.product, version: "0.14.0", fetchFn: releaseServer({ version: "0.14.0", noDmg: true }).fn, env: {}, appPath: d.app, mountRoot: d.mounts });
    expect(res).toMatchObject({ status: "skipped" });
    expect(res.detail).toContain("carries no Metistry-0.14.0.dmg");
    expect(await bundleVersion(d.app)).toBe("0.13.0");
  });

  it("skips: --no-app, and no app anywhere it looks", async () => {
    const d = await scratchDirs();
    const s = releaseServer({ version: "0.14.0" });
    const exec = appExec();
    expect((await updateApp(runner(exec).r, { productDir: d.product, version: "0.14.0", fetchFn: s.fn, env: {}, appPath: null })).status).toBe("skipped");
    const none = await updateApp(runner(exec).r, { productDir: d.product, version: "0.14.0", fetchFn: s.fn, env: { METISTRY_APP_PATH: d.app } });
    expect(none.status).toBe("skipped");
    expect(none.detail).toContain(`no Metistry.app in ${d.apps}`);
    expect(s.calls).toEqual([]);
    expect(exec.calls.filter((c) => c.cmd !== "plutil")).toEqual([]);
  });

  it("an unwritable Applications folder: no sudo, the exact ~/Applications alternative, and the update carries on", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "0.13.0");
    await chmod(d.apps, 0o555);
    const exec = appExec();
    const s = releaseServer({ version: "0.14.0" });
    const { r, out } = runner(exec);
    const res = await updateApp(r, { productDir: d.product, version: "0.14.0", fetchFn: s.fn, env: { HOME: d.home }, appPath: d.app, mountRoot: d.mounts });
    expect(res.status).toBe("skipped");
    const text = out.join("\n");
    expect(text).toContain(`${d.apps} is not writable by this user`);
    expect(text).toContain(`metistry update --app-path ${join(d.home, "Applications", "Metistry.app")}`);
    expect(text).toContain("never asks for sudo");
    expect(exec.calls.map((c) => c.cmd)).not.toContain("sudo");
    expect(s.calls).toEqual([]);
    expect(await bundleVersion(d.app)).toBe("0.13.0");
  });

  it("--app-path into an empty ~/Applications installs there fresh — the sudo-free alternative works", async () => {
    const d = await scratchDirs();
    const target = join(d.home, "Applications", "Metistry.app");
    const res = await updateApp(runner(appExec()).r, { productDir: d.product, version: "0.14.0", fetchFn: releaseServer({ version: "0.14.0" }).fn, env: { HOME: d.home }, appPath: target, mountRoot: d.mounts });
    expect(res).toMatchObject({ status: "installed", version: "0.14.0" });
    expect(await bundleVersion(target)).toBe("0.14.0");
    expect(existsSync(previousAppPath(target))).toBe(false);
  });

  it("a running app is told to relaunch and never killed — unless --relaunch", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "0.13.0");
    const exec = appExec({ pgrep: () => "4242\n" });
    const { r, out } = runner(exec);
    const res = await updateApp(r, { productDir: d.product, version: "0.14.0", fetchFn: releaseServer({ version: "0.14.0" }).fn, env: {}, appPath: d.app, mountRoot: d.mounts });
    expect(res).toMatchObject({ status: "installed", running: "needs-relaunch" });
    expect(out.join("\n")).toContain("quit and reopen it");
    expect(exec.calls.map((c) => c.cmd)).not.toContain("kill");
    expect(exec.calls.map((c) => c.cmd)).not.toContain("open");
    // pgrep is asked about exactly THIS bundle's executable, never "anything named Metistry"
    const pg = exec.calls.find((c) => c.cmd === "pgrep")!;
    expect(pg.args[0]).toBe("-f");
    expect(pg.args[1]).toContain("/Applications/Metistry\\.app/Contents/MacOS/");

    const e = await scratchDirs();
    await makeBundle(e.app, "0.13.0");
    let alive = true;
    const relaunching = appExec({ pgrep: () => (alive ? "4242\n" : "") });
    const inner = relaunching;
    const exec2 = Object.assign(async (cmd: string, args: string[], opts?: ExecOptions) => {
      if (cmd === "kill") alive = false;
      return inner(cmd, args, opts);
    }, { calls: inner.calls });
    const res2 = await updateApp(new StepRunner({ dryRun: false, out: () => {}, exec: exec2, env: {} }), { productDir: e.product, version: "0.14.0", fetchFn: releaseServer({ version: "0.14.0" }).fn, env: {}, appPath: e.app, mountRoot: e.mounts, relaunch: true, sleep: noSleep });
    expect(res2).toMatchObject({ status: "installed", running: "relaunched" });
    expect(inner.calls.find((c) => c.cmd === "kill")!.args).toEqual(["-TERM", "4242"]);
    expect(inner.calls.find((c) => c.cmd === "open")!.args).toEqual([e.app]);
  });

  it("--dry-run reaches nothing: no release, no mount, no swap", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "0.13.0");
    const exec = appExec();
    const s = releaseServer({ version: "0.14.0" });
    const { r, out } = runner(exec, true);
    const res = await updateApp(r, { productDir: d.product, version: "0.14.0", fetchFn: s.fn, env: {}, appPath: d.app, mountRoot: d.mounts });
    expect(res.status).toBe("installed");
    expect(s.calls).toEqual([]);
    expect(exec.calls.filter((c) => c.cmd !== "plutil")).toEqual([]);
    expect(out.join("\n")).toContain("download Metistry-0.14.0.dmg");
    expect(out.join("\n")).toContain(`swap: ${d.app} (0.13.0) → Metistry.app.previous`);
    expect(await bundleVersion(d.app)).toBe("0.13.0");
    expect(existsSync(previousAppPath(d.app))).toBe(false);
  });
});

describe("rollbackApp", () => {
  it("swaps Metistry.app.previous back in and keeps the newer one — so a second rollback rolls forward", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "0.14.0");
    await makeBundle(previousAppPath(d.app), "0.13.0");
    const exec = appExec();
    const res = await rollbackApp(runner(exec).r, { env: {}, appPath: d.app });
    expect(res).toMatchObject({ status: "rolled-back", version: "0.13.0", from: "0.14.0" });
    expect(await bundleVersion(d.app)).toBe("0.13.0");
    expect(await bundleVersion(previousAppPath(d.app))).toBe("0.14.0");
    await rollbackApp(runner(exec).r, { env: {}, appPath: d.app });
    expect(await bundleVersion(d.app)).toBe("0.14.0");
    expect((await readdir(d.apps)).sort()).toEqual(["Metistry.app", "Metistry.app.previous"]);
  });

  it("with no previous copy, or a previous that is not Metistry, it changes nothing", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "0.14.0");
    expect((await rollbackApp(runner(appExec()).r, { env: {}, appPath: d.app })).status).toBe("skipped");
    await makeBundle(previousAppPath(d.app), "0.13.0", "com.example.other");
    expect((await rollbackApp(runner(appExec()).r, { env: {}, appPath: d.app })).status).toBe("skipped");
    expect(await bundleVersion(d.app)).toBe("0.14.0");
  });
});

describe("metistry update moves the app with the release", () => {
  const base = (P: string, env: NodeJS.ProcessEnv) => ({ productDir: P, env, platform: "darwin" as const, uid: 501, version: "0.0.9", out: () => {}, doctorFn: okDoctor, cliShim: false, skipMigrate: true, openSession: async () => null });

  it("release mode, launchd shape: the pack, then the app from the same release, and the summary says so", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "0.13.0");
    const src = await checkout();
    const s = releaseServer({ version: "0.14.0", target: "darwin-arm64" });
    const tar = appExec();
    const exec = Object.assign(
      async (cmd: string, args: string[], opts?: ExecOptions) => {
        if (cmd === "tar") {
          await cp(src, args[args.indexOf("-C") + 1]!, { recursive: true });
          return { code: 0, stdout: "", stderr: "" };
        }
        return tar(cmd, args, opts);
      },
      { calls: tar.calls },
    );
    const lines: string[] = [];
    const r = await update({
      ...base(d.product, { METISTRY_DEPLOYMENT_SHAPE: "launchd", METISTRY_RUNTIME_DEPS: "0" }),
      out: (l) => lines.push(l),
      exec,
      fetchFn: s.fn,
      channel: "release",
      target: "darwin-arm64",
      appPath: d.app,
    });
    expect(r.release).toMatchObject({ version: "0.14.0", installed: true });
    expect(r.app).toMatchObject({ status: "installed", version: "0.14.0", from: "0.13.0" });
    expect(await bundleVersion(d.app)).toBe("0.14.0");
    expect(await readlink(join(d.product, "current"))).toBe(join("releases", "0.14.0"));
    expect(lines.join("\n")).toContain("== app");
    expect(lines[lines.length - 1]).toContain("app 0.13.0 → 0.14.0");
  });

  it("--no-app, the compose shape, and git mode leave the app alone", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "0.13.0");
    const exec = appExec();
    const noApp = await update({ ...base(d.product, { METISTRY_DEPLOYMENT_SHAPE: "launchd" }), exec, dryRun: true, channel: "release", fetchFn: releaseServer({ version: "0.14.0" }).fn, appPath: null });
    expect(noApp.app).toMatchObject({ status: "skipped" });
    const lines: string[] = [];
    const compose = await update({ ...base(d.product, { METISTRY_DEPLOYMENT_SHAPE: "compose" }), out: (l) => lines.push(l), exec, dryRun: true, channel: "release", fetchFn: releaseServer({ version: "0.14.0" }).fn, appPath: d.app });
    expect(compose.app).toBeUndefined();
    expect(lines.join("\n")).toContain("the Mac app is not moved by update");
    const git = await update({ ...base(await checkout(), { METISTRY_DEPLOYMENT_SHAPE: "launchd" }), exec, dryRun: true, appPath: d.app });
    expect(git.app).toBeUndefined();
    expect(await bundleVersion(d.app)).toBe("0.13.0");
  });

  it("--rollback flips current back AND swaps the previous app back in", async () => {
    const d = await scratchDirs();
    for (const v of ["0.13.0", "0.14.0"]) await mkdir(join(d.product, "releases", v), { recursive: true });
    await cp(await checkout(), join(d.product, "releases", "0.13.0"), { recursive: true });
    await symlink(join("releases", "0.14.0"), join(d.product, "current"));
    await writeFile(join(d.product, "releases", ".previous"), "0.13.0\n");
    await makeBundle(d.app, "0.14.0");
    await makeBundle(previousAppPath(d.app), "0.13.0");
    const r = await update({ ...base(d.product, { METISTRY_DEPLOYMENT_SHAPE: "launchd" }), exec: appExec(), channel: "release", rollback: true, fetchFn: releaseServer({ version: "0.14.0" }).fn, appPath: d.app });
    expect(r.release).toMatchObject({ version: "0.13.0" });
    expect(r.app).toMatchObject({ status: "rolled-back", version: "0.13.0" });
    expect(await bundleVersion(d.app)).toBe("0.13.0");
  });

  it("the summary names the app's move, and a skip is not news", () => {
    const ui = defaultUi();
    const base = { ui, dryRun: false, code: 0, source: "release" as const, version: "0.14.0", restarted: [] };
    expect(updateSummary({ ...base, app: { status: "installed", detail: "app 0.13.0 → 0.14.0", running: "needs-relaunch" } })).toContain("app 0.13.0 → 0.14.0 (reopen it)");
    expect(updateSummary({ ...base, app: { status: "skipped", detail: "--no-app: the Mac app is left as it is" } })).not.toContain("no-app");
  });
});

describe("doctor: the app row", () => {
  async function lockAt(version: string, source: "git" | "release" = "release") {
    const inst = await mkdtemp(join(tmpdir(), "mi-"));
    await mkdir(join(inst, ".metistry"), { recursive: true });
    await writeFile(join(inst, ".metistry", "metistry.lock"), serializeLock({ product: { version, commit: "c", source }, updated_at: "2026-09-27T00:00:00.000Z", migrations_applied: [] }));
    return inst;
  }

  it("ok when the app is the lock's version; degraded when behind, with the verb that fixes it", async () => {
    const d = await scratchDirs();
    await makeBundle(d.app, "0.13.0");
    const exec = appExec();
    const same = await appRow({ env: { METISTRY_INSTANCE_DIR: await lockAt("0.13.0") }, exec, appPath: d.app });
    expect(same).toMatchObject({ kind: "app", name: "app", status: "ok", meta: { version: "0.13.0", lock: "0.13.0" } });

    const behind = await appRow({ env: { METISTRY_INSTANCE_DIR: await lockAt("0.14.0") }, exec, appPath: d.app });
    expect(behind).toMatchObject({ status: "degraded", action: { kind: "run_verb", command: ["metistry", "update"] } });
    expect(behind!.remediation).toContain("the app is 0.13.0 and the install is 0.14.0");

    // a checkout's update does not move the app, so it is not offered as the fix
    const git = await appRow({ env: { METISTRY_INSTANCE_DIR: await lockAt("0.14.0", "git") }, exec, appPath: d.app });
    expect(git).toMatchObject({ status: "degraded" });
    expect(git!.action).toBeUndefined();
    expect(git!.remediation).toContain("Check for Updates");

    // ahead (Sparkle got there first) is not a finding
    expect(await appRow({ env: { METISTRY_INSTANCE_DIR: await lockAt("0.12.0") }, exec, appPath: d.app })).toMatchObject({ status: "ok" });
  });

  it("absent when there is no app, and no row at all when told not to look", async () => {
    const d = await scratchDirs();
    expect(await appRow({ env: { METISTRY_APP_PATH: d.app }, exec: appExec() })).toMatchObject({ status: "absent" });
    expect(await appRow({ env: {}, exec: appExec(), appPath: null })).toBeUndefined();
  });
});
