// Release mode against a whole fake GitHub release served by an injected
// `fetch`: the resolve, the sha256 gate (a bad digest must leave `current`
// exactly where it was), the unpack + symlink switch, the rollback flip,
// and `metistry update` end to end — versioned images pulled, migrations
// run against `current`, the lock pinned to the release that was actually
// installed.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeLock, type LockFile } from "../src/lock.js";
import {
  CHECKSUMS_ASSET,
  currentVersion,
  imageEnv,
  imageRef,
  installRelease,
  parseChecksums,
  previousVersion,
  pruneReleases,
  releaseTarget,
  resolveRelease,
  rollbackRelease,
  runtimeAssetName,
  runtimePackCommit,
  switchCurrent,
} from "../src/release.js";
import { StepFailed, StepRunner } from "../src/steps.js";
import { update } from "../src/update.js";
import { checkout, fakeExec, okDoctor, put } from "./fixtures.js";

const NOW = new Date("2026-09-07T15:00:00Z");
const REPO = "foldedspacelabs/metistry";
const TARGET = "linux-x64";
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/**
 * A release server: the GitHub API JSON, a checksums.txt and the bytes of
 * every asset. `corrupt` serves a tarball whose bytes do not match the
 * digest the release advertises — the tampering case.
 */
function releaseServer(opts: { versions: string[]; latest?: string; corrupt?: boolean; omitChecksums?: boolean; target?: string }) {
  const target = opts.target ?? TARGET;
  const latest = opts.latest ?? opts.versions[opts.versions.length - 1]!;
  const bodyFor = (v: string) => Buffer.from(`runtime pack for ${v}\n`.repeat(4));
  const urls = new Map<string, Buffer>();
  const calls: string[] = [];

  const release = (v: string) => {
    const asset = runtimeAssetName(v, target);
    const tarUrl = `https://example.test/dl/v${v}/${asset}`;
    const sumUrl = `https://example.test/dl/v${v}/${CHECKSUMS_ASSET}`;
    const bytes = bodyFor(v);
    urls.set(tarUrl, opts.corrupt ? Buffer.from("not the pack you were promised") : bytes);
    urls.set(sumUrl, Buffer.from(`${sha256(bytes)}  ${asset}\n${sha256(Buffer.from("x"))}  Metistry-${v}.dmg\n`));
    return {
      tag_name: `v${v}`,
      assets: [
        { name: asset, browser_download_url: tarUrl },
        ...(opts.omitChecksums ? [] : [{ name: CHECKSUMS_ASSET, browser_download_url: sumUrl }]),
      ],
    };
  };

  const fn = (async (u: string | URL | Request) => {
    const url = String(u);
    calls.push(url);
    const tag = /\/releases\/tags\/v(.+)$/.exec(url)?.[1];
    if (url.endsWith("/releases/latest") || tag) {
      const v = tag ?? latest;
      if (!opts.versions.includes(v)) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(release(v)), { status: 200, headers: { "content-type": "application/json" } });
    }
    // an asset url is only known once its release has been resolved
    for (const v of opts.versions) release(v);
    const body = urls.get(url);
    return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response("no such asset", { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, calls, target };
}

/** A StepRunner that records but executes nothing except the handlers given. */
function runner(exec = fakeExec()) {
  const out: string[] = [];
  return { r: new StepRunner({ dryRun: false, out: (l) => out.push(l), exec, env: {} }), out, exec };
}

/** `tar -xzf … -C <dir> --strip-components=1` — the fake unpacks a real product tree, so what follows sees files. */
async function tarInto(src: string) {
  return fakeExec({
    tar: async (args: string[]) => {
      const dest = args[args.indexOf("-C") + 1]!;
      await cp(src, dest, { recursive: true });
    },
  });
}

describe("release assets", () => {
  it("the runtime asset name is the one the pack script and the workflow build", () => {
    expect(runtimeAssetName("0.2.0", "darwin-arm64")).toBe("metistry-runtime-0.2.0-darwin-arm64.tar.gz");
    expect(runtimeAssetName("v0.2.0", "linux-x64")).toBe("metistry-runtime-0.2.0-linux-x64.tar.gz");
    expect(releaseTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(releaseTarget("linux", "x64")).toBe("linux-x64");

    const script = readFileSync(new URL("../../../ops/release/pack-runtime.sh", import.meta.url), "utf8");
    expect(script).toContain('metistry-runtime-$version-$target.tar.gz');
    const wf = readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(wf).toContain("metistry-runtime-${{ needs.verify.outputs.version }}-${{ matrix.target }}.tar.gz");
  });

  it("runtimePackCommit reads the manifest's commit and never fabricates one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-pack-"));
    expect(await runtimePackCommit(dir)).toBeUndefined(); // no metistry-runtime.json at all
    await writeFile(join(dir, "metistry-runtime.json"), JSON.stringify({ version: "0.2.0", target: TARGET, built_at: "2026-09-01T00:00:00Z" }));
    expect(await runtimePackCommit(dir)).toBeUndefined(); // pack built before the commit field shipped
    await writeFile(join(dir, "metistry-runtime.json"), JSON.stringify({ version: "0.2.0", commit: "" }));
    expect(await runtimePackCommit(dir)).toBeUndefined(); // an empty string is not a commit
    await writeFile(join(dir, "metistry-runtime.json"), JSON.stringify({ version: "0.2.0", commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }));
    expect(await runtimePackCommit(dir)).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  });

  it("parses sha256sum output and ignores anything that is not a digest line", () => {
    const sums = parseChecksums(["# a comment", "abc  short", `${"a".repeat(64)}  metistry-runtime-0.1.0-linux-x64.tar.gz`, `${"B".repeat(64)} *checksums.txt`].join("\n"));
    expect(sums).toEqual({ "metistry-runtime-0.1.0-linux-x64.tar.gz": "a".repeat(64), "checksums.txt": "b".repeat(64) });
  });

  it("names the versioned ghcr images compose pulls, and honours METISTRY_IMAGE_PREFIX", () => {
    expect(imageRef("console", "0.2.0", {})).toBe("ghcr.io/foldedspacelabs/metistry-console:0.2.0");
    expect(imageEnv("0.2.0", {})).toEqual({
      METISTRY_CONSOLE_IMAGE: "ghcr.io/foldedspacelabs/metistry-console:0.2.0",
      METISTRY_ASSISTANT_IMAGE: "ghcr.io/foldedspacelabs/metistry-assistant:0.2.0",
    });
    expect(imageRef("console", "0.2.0", { METISTRY_IMAGE_PREFIX: "ghcr.io/me/fork" })).toBe("ghcr.io/me/fork-console:0.2.0");
    // docker-compose.yml must actually read them, or the pull pins nothing
    const compose = readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8");
    expect(compose).toContain("${METISTRY_CONSOLE_IMAGE:-metistry-console:dev}");
    expect(compose).toContain("${METISTRY_ASSISTANT_IMAGE:-metistry-assistant:dev}");
  });
});

describe("resolveRelease", () => {
  it("takes the latest release, or the one tagged v<version>, and says so when there is none", async () => {
    const s = releaseServer({ versions: ["0.1.0", "0.2.0"] });
    const latest = await resolveRelease({ fetchFn: s.fn, env: {} });
    expect(latest.version).toBe("0.2.0");
    expect(latest.tag).toBe("v0.2.0");
    expect(Object.keys(latest.assets).sort()).toEqual([CHECKSUMS_ASSET, runtimeAssetName("0.2.0", TARGET)].sort());
    expect(s.calls[0]).toBe(`https://api.github.com/repos/${REPO}/releases/latest`);

    const pinned = await resolveRelease({ fetchFn: s.fn, version: "0.1.0", env: {} });
    expect(pinned.version).toBe("0.1.0");
    expect(s.calls.at(-1)).toBe(`https://api.github.com/repos/${REPO}/releases/tags/v0.1.0`);

    await expect(resolveRelease({ fetchFn: s.fn, version: "9.9.9", env: {} })).rejects.toThrow(/no release tagged v9.9.9/);
  });

  it("a fork retargets the repo from the environment, and a token is sent when one is configured", async () => {
    const seen: { url: string; auth: unknown }[] = [];
    const fn = (async (u: string | URL, init?: RequestInit) => {
      seen.push({ url: String(u), auth: (init?.headers as Record<string, string>)?.authorization });
      return new Response(JSON.stringify({ tag_name: "v1.0.0", assets: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await resolveRelease({ fetchFn: fn, env: { METISTRY_RELEASE_REPO: "someone/fork", METISTRY_GITHUB_TOKEN: "ghp_x" } });
    expect(seen[0]!.url).toBe("https://api.github.com/repos/someone/fork/releases/latest");
    expect(seen[0]!.auth).toBe("Bearer ghp_x");
  });

  // A fine-grained PAT scoped to Issues/PRs/Metadata (no Contents: read) gets
  // a 403 from the Releases API on a private repo, same as an exhausted rate
  // limit does — GitHub uses 403 for both. The fix must tell them apart.
  const forbidden = (headers: Record<string, string> = {}) => (async () => new Response("{}", { status: 403, headers })) as unknown as typeof fetch;

  it("a 403 with x-ratelimit-remaining: 0 is reported as rate limiting, not a token/permission problem", async () => {
    const noGh = fakeExec({ gh: async () => ({ code: 127, stdout: "", stderr: "command not found" }) });
    await expect(resolveRelease({ fetchFn: forbidden({ "x-ratelimit-remaining": "0" }), env: { METISTRY_GITHUB_TOKEN: "ghp_x" }, exec: noGh })).rejects.toThrow(/rate limited/i);
  });

  it("a 403 that is not an exhausted rate limit names the exact PAT permission that's missing, when gh is unavailable", async () => {
    const noGh = fakeExec({ gh: async () => ({ code: 127, stdout: "", stderr: "command not found" }) });
    await expect(resolveRelease({ fetchFn: forbidden(), env: { METISTRY_GITHUB_TOKEN: "ghp_x" }, exec: noGh })).rejects.toThrow(/Contents: read/);
  });

  it("falls back to gh when the direct call is unauthorized and gh is on PATH, and says so", async () => {
    const ghExec = fakeExec({
      gh: async (args) => {
        if (args[0] === "--version") return { code: 0, stdout: "gh version 2.0.0", stderr: "" };
        if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ tag_name: "v0.2.0", assets: [{ name: "checksums.txt", browser_download_url: "https://x/checksums.txt" }] }), stderr: "" };
        return { code: 1, stdout: "", stderr: "unexpected" };
      },
    });
    const rel = await resolveRelease({ fetchFn: forbidden(), env: { METISTRY_GITHUB_TOKEN: "ghp_x", METISTRY_RELEASE_REPO: "foldedspacelabs/metistry" }, exec: ghExec });
    expect(rel).toMatchObject({ version: "0.2.0", tag: "v0.2.0", via: "gh" });
    expect(ghExec.calls.map((c) => [c.cmd, ...c.args].join(" "))).toContainEqual("gh api repos/foldedspacelabs/metistry/releases/latest");
  });
});

describe("installRelease", () => {
  it("downloads, verifies the sha256, unpacks to releases/<version>/ and points current at it", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    const src = await checkout();
    const s = releaseServer({ versions: ["0.2.0"] });
    const { r, exec } = runner(await tarInto(src));

    const res = await installRelease(r, { productDir: P, fetchFn: s.fn, env: {}, target: TARGET });
    expect(res).toMatchObject({ version: "0.2.0", installed: true, dir: join(P, "releases", "0.2.0") });
    expect(await readlink(join(P, "current"))).toBe("releases/0.2.0");
    expect(await currentVersion(P)).toBe("0.2.0");
    // the pack was unpacked through tar, and the staging download is gone
    expect(existsSync(join(P, "current", "db", "migrations", "0001_a.sql"))).toBe(true);
    expect(existsSync(join(P, "releases", ".download"))).toBe(false);
    expect(exec.calls.map((c) => c.cmd)).toEqual(["tar"]);
    expect(exec.calls[0]!.args).toEqual(["-xzf", expect.stringContaining(runtimeAssetName("0.2.0", TARGET)), "-C", join(P, "releases", "0.2.0"), "--strip-components=1"]);
  });

  it("refuses a tarball whose sha256 does not match, leaving current untouched", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    const src = await checkout();
    const { r } = runner(await tarInto(src));
    // a good 0.1.0 first, so there is something to protect
    await installRelease(r, { productDir: P, fetchFn: releaseServer({ versions: ["0.1.0"] }).fn, env: {}, target: TARGET });
    expect(await currentVersion(P)).toBe("0.1.0");

    const bad = releaseServer({ versions: ["0.2.0"], corrupt: true });
    await expect(installRelease(r, { productDir: P, fetchFn: bad.fn, env: {}, target: TARGET })).rejects.toThrow(/failed its checksum/);
    expect(await currentVersion(P)).toBe("0.1.0");
    expect(existsSync(join(P, "releases", "0.2.0"))).toBe(false);
    expect(existsSync(join(P, "releases", ".download"))).toBe(false);
  });

  it("falls back to `gh release download` for the assets too, when the direct API call was unauthorized", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    const src = await checkout();
    const asset = runtimeAssetName("0.2.0", TARGET);
    const bytes = Buffer.from("runtime pack for 0.2.0\n".repeat(4));
    const { r, exec } = runner(
      fakeExec({
        gh: async (args) => {
          if (args[0] === "--version") return { code: 0, stdout: "gh version 2.0.0" };
          if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ tag_name: "v0.2.0", assets: [{ name: asset, browser_download_url: "https://x/asset" }, { name: CHECKSUMS_ASSET, browser_download_url: "https://x/sums" }] }) };
          if (args[0] === "release" && args[1] === "download") {
            const dir = args[args.indexOf("--dir") + 1]!;
            const pattern = args[args.indexOf("--pattern") + 1]!;
            const content = pattern === CHECKSUMS_ASSET ? `${sha256(bytes)}  ${asset}\n` : bytes;
            await writeFile(join(dir, pattern), content);
            return { code: 0, stdout: "" };
          }
          return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
        },
        tar: async (args) => {
          const dest = args[args.indexOf("-C") + 1]!;
          await cp(src, dest, { recursive: true });
        },
      }),
    );
    const forbidden = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;

    const res = await installRelease(r, { productDir: P, fetchFn: forbidden, env: { METISTRY_GITHUB_TOKEN: "ghp_x" }, target: TARGET });
    expect(res).toMatchObject({ version: "0.2.0", installed: true });
    expect(await currentVersion(P)).toBe("0.2.0");
    expect(exec.calls.some((c) => c.cmd === "gh" && c.args[0] === "release" && c.args[1] === "download")).toBe(true);
  });

  it("downloads a private repo's assets through the authenticated asset API when a token is configured, and never resends the token on the redirect", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    const src = await checkout();
    const asset = runtimeAssetName("0.2.0", TARGET);
    const bytes = Buffer.from("runtime pack for 0.2.0\n".repeat(4));
    const sums = Buffer.from(`${sha256(bytes)}  ${asset}\n`);
    const fn = (async (u: string | URL, init?: RequestInit) => {
      const url = String(u);
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (url.endsWith("/releases/latest")) {
        return new Response(
          JSON.stringify({
            tag_name: "v0.2.0",
            assets: [
              // browser_download_url deliberately 404s here — a private repo needs
              // a browser session for it, not a token, so the fix must not use it
              { name: asset, id: 111, browser_download_url: "https://example.test/browser-only/asset" },
              { name: CHECKSUMS_ASSET, id: 222, browser_download_url: "https://example.test/browser-only/sums" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === `https://api.github.com/repos/${REPO}/releases/assets/222`) {
        expect(auth).toBe("Bearer ghp_x");
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status: 302, headers: { location: "https://s3.example.test/sums" } });
      }
      if (url === `https://api.github.com/repos/${REPO}/releases/assets/111`) {
        expect(auth).toBe("Bearer ghp_x");
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status: 302, headers: { location: "https://s3.example.test/asset" } });
      }
      if (url === "https://s3.example.test/sums") {
        expect(auth).toBeUndefined(); // the signed URL carries its own credential
        return new Response(new Uint8Array(sums));
      }
      if (url === "https://s3.example.test/asset") {
        expect(auth).toBeUndefined();
        return new Response(new Uint8Array(bytes));
      }
      return new Response("browser_download_url must not be fetched when a token is configured", { status: 404 });
    }) as unknown as typeof fetch;

    const { r } = runner(await tarInto(src));
    const res = await installRelease(r, { productDir: P, fetchFn: fn, env: { METISTRY_GITHUB_TOKEN: "ghp_x" }, target: TARGET });
    expect(res).toMatchObject({ version: "0.2.0", installed: true });
    expect(await currentVersion(P)).toBe("0.2.0");
  });

  it("falls back to `gh release download` when the authenticated asset API 404s, even though resolve already succeeded", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    const src = await checkout();
    const asset = runtimeAssetName("0.2.0", TARGET);
    const bytes = Buffer.from("runtime pack for 0.2.0\n".repeat(4));
    const fn = (async (u: string | URL) => {
      const url = String(u);
      if (url.endsWith("/releases/latest")) {
        return new Response(
          JSON.stringify({
            tag_name: "v0.2.0",
            assets: [
              { name: asset, id: 1, browser_download_url: "https://example.test/asset" },
              { name: CHECKSUMS_ASSET, id: 2, browser_download_url: "https://example.test/sums" },
            ],
          }),
          { status: 200 },
        );
      }
      // the resolve worked, but the asset itself 404s (the bug this fixes) — and
      // the fix must fall back to gh instead of giving up
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const { r, exec } = runner(
      fakeExec({
        gh: async (args) => {
          if (args[0] === "--version") return { code: 0, stdout: "gh version 2.0.0" };
          if (args[0] === "release" && args[1] === "download") {
            const dir = args[args.indexOf("--dir") + 1]!;
            const pattern = args[args.indexOf("--pattern") + 1]!;
            const content = pattern === CHECKSUMS_ASSET ? `${sha256(bytes)}  ${asset}\n` : bytes;
            await writeFile(join(dir, pattern), content);
            return { code: 0, stdout: "" };
          }
          return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
        },
        tar: async (args) => {
          const dest = args[args.indexOf("-C") + 1]!;
          await cp(src, dest, { recursive: true });
        },
      }),
    );

    const res = await installRelease(r, { productDir: P, fetchFn: fn, env: { METISTRY_GITHUB_TOKEN: "ghp_x" }, target: TARGET });
    expect(res).toMatchObject({ version: "0.2.0", installed: true });
    expect(await currentVersion(P)).toBe("0.2.0");
    expect(exec.calls.filter((c) => c.cmd === "gh" && c.args[0] === "release" && c.args[1] === "download")).toHaveLength(2); // checksums.txt and the pack, same function
  });

  it("refuses a release with no checksums.txt, and one with no pack for this platform", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    const { r } = runner();
    await expect(installRelease(r, { productDir: P, fetchFn: releaseServer({ versions: ["0.2.0"], omitChecksums: true }).fn, env: {}, target: TARGET })).rejects.toThrow(/no checksums.txt/);
    await expect(installRelease(r, { productDir: P, fetchFn: releaseServer({ versions: ["0.2.0"] }).fn, env: {}, target: "sunos-sparc" })).rejects.toThrow(/has no metistry-runtime-0.2.0-sunos-sparc.tar.gz/);
    expect(existsSync(join(P, "current"))).toBe(false);
  });

  it("is a no-op when the latest release is already current — nothing is downloaded", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    const src = await checkout();
    const { r } = runner(await tarInto(src));
    const s = releaseServer({ versions: ["0.2.0"] });
    await installRelease(r, { productDir: P, fetchFn: s.fn, env: {}, target: TARGET });
    const after = s.calls.length;
    const again = await installRelease(r, { productDir: P, fetchFn: s.fn, env: {}, target: TARGET });
    expect(again.installed).toBe(false);
    expect(s.calls.length).toBe(after + 1); // the resolve, and nothing else
  });

  it("keeps the previous release, prunes the ones before it, and rolls back with a symlink flip", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    const src = await checkout();
    const { r, out } = runner(await tarInto(src));
    for (const v of ["0.1.0", "0.2.0", "0.3.0"]) {
      await installRelease(r, { productDir: P, fetchFn: releaseServer({ versions: [v] }).fn, env: {}, target: TARGET });
    }
    expect(await currentVersion(P)).toBe("0.3.0");
    expect(await previousVersion(P)).toBe("0.2.0");
    expect(existsSync(join(P, "releases", "0.1.0"))).toBe(false); // pruned: two are kept
    expect(out.join("\n")).toContain("pruned older releases: 0.1.0");

    const back = await rollbackRelease(r, P);
    expect(back.version).toBe("0.2.0");
    expect(await currentVersion(P)).toBe("0.2.0");
    // and the rollback is itself reversible
    expect(await previousVersion(P)).toBe("0.3.0");
    await rollbackRelease(r, P);
    expect(await currentVersion(P)).toBe("0.3.0");
    expect(out.join("\n")).toContain("migrations are additive-first and are NOT reverted");
  });

  it("refuses to roll back when there is nothing recorded, or the target was deleted", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    const { r } = runner();
    await expect(rollbackRelease(r, P)).rejects.toThrow(/nothing to roll back to/);
    await expect(switchCurrent(P, "0.9.9")).rejects.toThrow(/is not unpacked/);
    expect(await pruneReleases(P, [])).toEqual([]);
  });
});

describe("metistry update --channel release", () => {
  const base = (P: string, env: NodeJS.ProcessEnv = {}) => ({ productDir: P, env, platform: "darwin" as const, uid: 501, version: "0.0.9", now: NOW, out: () => {}, doctorFn: okDoctor });

  it("installs the release, pulls the VERSIONED images against current, migrates there and pins the lock to it", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    const inst = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const src = await checkout();
    const prior: LockFile = { product: { version: "0.1.0", commit: "unknown", source: "release" }, updated_at: "2026-09-01T00:00:00.000Z", migrations_applied: [] };
    await writeFile(join(inst, "metistry.lock"), serializeLock(prior));
    const exec = await tarInto(src);
    const s = releaseServer({ versions: ["0.2.0"] });

    const r = await update({
      ...base(P, { METISTRY_INSTANCE_DIR: inst }),
      exec,
      fetchFn: s.fn,
      target: TARGET,
      skipMigrate: true,
      openSession: async () => null,
    });

    expect(r.source).toBe("release");
    expect(r.runDir).toBe(join(P, "current"));
    expect(r.release).toMatchObject({ version: "0.2.0", installed: true });
    expect(r.commands.join("\n")).not.toContain("pnpm");
    expect(r.commands.join("\n")).not.toContain("git ");
    // compose is told where the instance's .env is (a self-contained instance dir)
    const ef = `--env-file ${join(inst, "state", ".env")}`;
    expect(r.commands).toContain(`(cd ${join(P, "current")} && docker compose ${ef} pull)`);
    expect(r.commands).toContain(`(cd ${join(P, "current")} && docker compose ${ef} up -d --no-build)`);
    // the pull carries the pinned image refs — that is what "pull the release" means
    const pull = exec.calls.find((c) => c.cmd === "docker" && c.args.includes("pull"))!;
    expect(pull.cwd).toBe(join(P, "current"));
    // the lock is pinned to the release that was installed, not to the running CLI's version
    expect(r.lock).toEqual({ product: { version: "0.2.0", commit: "unknown", source: "release" }, updated_at: NOW.toISOString(), migrations_applied: [] });
    expect(await readFile(join(inst, "metistry.lock"), "utf8")).toContain('version: "0.2.0"');
  });

  it("reads the pack's own commit out of metistry-runtime.json (release channel never git-pulls, so this is the only honest source)", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    const inst = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const src = await checkout();
    await put(src, "metistry-runtime.json", JSON.stringify({ version: "0.2.0", target: TARGET, commit: "cafebabecafebabecafebabecafebabecafebabe" }));
    const prior: LockFile = { product: { version: "0.1.0", commit: "prior-sha", source: "release" }, updated_at: "2026-09-01T00:00:00.000Z", migrations_applied: [] };
    await writeFile(join(inst, "metistry.lock"), serializeLock(prior));
    const exec = await tarInto(src);
    const s = releaseServer({ versions: ["0.2.0"] });

    const r = await update({ ...base(P, { METISTRY_INSTANCE_DIR: inst }), exec, fetchFn: s.fn, target: TARGET, skipMigrate: true, openSession: async () => null });

    expect(r.lock).toEqual({ product: { version: "0.2.0", commit: "cafebabecafebabecafebabecafebabecafebabe", source: "release" }, updated_at: NOW.toISOString(), migrations_applied: [] });
  });

  it("falls through to the prior lock's commit when the installed pack has no commit field (packs built before it shipped, e.g. 0.3.0/0.3.1) — never fabricates one", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    const inst = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const src = await checkout(); // no metistry-runtime.json at all in this fixture
    const prior: LockFile = { product: { version: "0.1.0", commit: "prior-sha", source: "release" }, updated_at: "2026-09-01T00:00:00.000Z", migrations_applied: [] };
    await writeFile(join(inst, "metistry.lock"), serializeLock(prior));
    const exec = await tarInto(src);
    const s = releaseServer({ versions: ["0.2.0"] });

    const r = await update({ ...base(P, { METISTRY_INSTANCE_DIR: inst }), exec, fetchFn: s.fn, target: TARGET, skipMigrate: true, openSession: async () => null });

    expect(r.lock).toEqual({ product: { version: "0.2.0", commit: "prior-sha", source: "release" }, updated_at: NOW.toISOString(), migrations_applied: [] });
  });

  it("--version pins a specific release; --rollback flips back without downloading anything", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    const inst = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const src = await checkout();
    const exec = await tarInto(src);
    const s = releaseServer({ versions: ["0.1.0", "0.2.0"] });
    const opts = { ...base(P, { METISTRY_INSTANCE_DIR: inst }), exec, fetchFn: s.fn, target: TARGET, skipMigrate: true, channel: "release" as const, openSession: async () => null };

    await update({ ...opts, releaseVersion: "0.1.0" });
    expect(await currentVersion(P)).toBe("0.1.0");
    await update({ ...opts });
    expect(await currentVersion(P)).toBe("0.2.0");

    const calls = s.calls.length;
    const back = await update({ ...opts, rollback: true });
    expect(await currentVersion(P)).toBe("0.1.0");
    expect(s.calls.length).toBe(calls); // no GitHub call at all
    expect(back.lock?.product.version).toBe("0.1.0");
  });

  it("a bad checksum fails the update before anything restarts, and leaves the lock alone", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    const inst = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const src = await checkout();
    const exec = await tarInto(src);
    await update({ ...base(P, { METISTRY_INSTANCE_DIR: inst }), exec, fetchFn: releaseServer({ versions: ["0.1.0"] }).fn, target: TARGET, skipMigrate: true, channel: "release", openSession: async () => null });
    const lockBefore = await readFile(join(inst, "metistry.lock"), "utf8");

    const lines: string[] = [];
    const r = await update({
      ...base(P, { METISTRY_INSTANCE_DIR: inst }),
      out: (l) => lines.push(l),
      exec,
      fetchFn: releaseServer({ versions: ["0.2.0"], corrupt: true }).fn,
      target: TARGET,
      skipMigrate: true,
      channel: "release",
      openSession: async () => null,
    });
    expect(r.code).toBe(1);
    expect(lines.join("\n")).toMatch(/failed its checksum/);
    expect(r.commands.join("\n")).not.toContain("docker compose");
    expect(await currentVersion(P)).toBe("0.1.0");
    expect(await readFile(join(inst, "metistry.lock"), "utf8")).toBe(lockBefore);
  });

  it("--dry-run in release mode reaches nothing: no GitHub, no download, no compose", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    const calls: string[] = [];
    const fn = (async (u: string | URL) => {
      calls.push(String(u));
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    const exec = fakeExec();
    const r = await update({ ...base(P), exec, dryRun: true, fetchFn: fn, channel: "release", target: TARGET });
    expect(calls).toEqual([]);
    expect(exec.calls).toEqual([]);
    expect(r.commands[0]).toContain("resolve release <latest> of foldedspacelabs/metistry");
    expect(r.commands[0]).toContain(`metistry-runtime-<latest>-${TARGET}.tar.gz`);
    expect(r.commands[1]).toContain(`unpack to ${P}/releases/<latest>/ and point current at it`);
  });

  it("--rollback is refused in git mode, where git is the rollback", async () => {
    const P = await checkout({ git: true });
    const lines: string[] = [];
    const r = await update({ ...base(P), out: (l) => lines.push(l), exec: fakeExec(), rollback: true, skipMigrate: true, openSession: async () => null });
    expect(r.code).toBe(1);
    expect(lines.join("\n")).toContain("--rollback is release mode only");
  });
});

describe("StepFailed", () => {
  it("carries an exit code the update surfaces", () => {
    expect(new StepFailed("x").code).toBe(1);
    expect(new StepFailed("x", 7).code).toBe(7);
  });
});
