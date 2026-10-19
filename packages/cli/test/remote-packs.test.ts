// The provider tool packs (plan §2.23, X-112): one release asset per tool,
// fetched only when the owner picks that provider, verified against
// checksums.txt AND the pack's own manifest before anything on disk changes.
// The ticket's tests, each here: a checksum mismatch leaves runtime/remote/ as
// it was; a provider not chosen fetches nothing; every Mach-O in a pack is
// signed with the release identity (the build script's own check, asserted on
// its text — the signing itself needs CI's certificate); the pins match the
// asserted versions. Plus the misuse cases the brief names: a tampered pack
// and a downgrade. Injected fetch and exec throughout: no network, no
// subprocess.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHECKSUMS_ASSET, runtimeAssetName } from "../src/release.js";
import { ensureRemotePack, findRemotePack, MANUAL_INSTALL, remoteSet, type RemoteContext, type RemoteProvider, type RemoteRegistry } from "../src/remote/index.js";
import {
  installedRemotePackRelease,
  installedRemotePacks,
  installRemotePack,
  installRuntimeDeps,
  readRemotePackManifest,
  REMOTE_DIRNAME,
  REMOTE_TOOLS,
  remotePackAssetName,
  remoteToolDir,
  RUNTIME_DIRNAME,
  runtimeDepsAssetName,
  updateRemotePacks,
  verifyUnpackedRemotePack,
  type RemoteTool,
} from "../src/runtime-deps.js";
import { StepFailed, StepRunner } from "../src/steps.js";
import { fakeExec } from "./fixtures.js";

const repoFile = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const TARGET = "darwin-arm64";

// ---- a pack, as a tree and as served ---------------------------------------------

/** The files a tool's pack unpacks to (under `remote/<tool>/`), with a manifest that hashes its binaries. */
function packTree(tool: RemoteTool, opts: { version?: string; binaries?: Record<string, string>; manifestTool?: string; breakHash?: boolean } = {}): Record<string, string> {
  const bins = opts.binaries ?? (tool === "tailscale" ? { "bin/tailscaled": "#!/bin/sh\necho tailscaled\n", "bin/tailscale": "#!/bin/sh\necho tailscale\n" } : { [`bin/${tool}`]: `#!/bin/sh\necho ${tool}\n` });
  const manifest = {
    schema: 1,
    tool: opts.manifestTool ?? tool,
    version: opts.version ?? "1.0.0",
    target: TARGET,
    signed: true,
    binaries: Object.fromEntries(Object.entries(bins).map(([rel, body]) => [rel, opts.breakHash ? sha256("something else") : sha256(body)])),
  };
  const tree: Record<string, string> = { [`${REMOTE_DIRNAME}/${tool}/manifest.json`]: JSON.stringify(manifest), [`${REMOTE_DIRNAME}/${tool}/LICENSE`]: "a licence\n" };
  for (const [rel, body] of Object.entries(bins)) tree[`${REMOTE_DIRNAME}/${tool}/${rel}`] = body;
  return tree;
}

/** A tar-shaped fake: `tar -xzf <file> -C <dir>` writes the tree registered for that asset file name. */
function tarExec(trees: Record<string, Record<string, string>>) {
  return fakeExec({
    tar: async (args) => {
      const file = args[args.indexOf("-xzf") + 1]!;
      const dir = args[args.indexOf("-C") + 1]!;
      const tree = Object.entries(trees).find(([asset]) => file.endsWith(asset))?.[1];
      if (!tree) throw new Error(`no fake tree for ${file}`);
      for (const [rel, body] of Object.entries(tree)) {
        await mkdir(join(dir, rel, ".."), { recursive: true });
        await writeFile(join(dir, rel), body);
      }
    },
  });
}

interface ServedPack {
  tool: RemoteTool;
  /** the bytes checksums.txt is computed over; `corrupt` serves different ones */
  corrupt?: boolean;
}

/** A release carrying the packs listed (and the deps pack), served by an injected fetch that logs every URL it was asked for. */
function releaseServer(opts: { version: string; packs: ServedPack[]; depsPack?: boolean }) {
  const log: string[] = [];
  const bytes = (name: string) => Buffer.from(`${name} bytes\n`);
  const assets: { name: string; url: string }[] = [];
  const sums: string[] = [];
  for (const p of opts.packs) {
    const name = remotePackAssetName(p.tool, opts.version, TARGET);
    assets.push({ name, url: `https://example.test/dl/${name}` });
    sums.push(`${sha256(bytes(name))}  ${name}`);
  }
  if (opts.depsPack) {
    const name = runtimeDepsAssetName(opts.version, TARGET);
    assets.push({ name, url: `https://example.test/dl/${name}` });
    sums.push(`${sha256(bytes(name))}  ${name}`);
  }
  const fn = (async (u: string | URL) => {
    const url = String(u);
    log.push(url);
    if (url.includes("/releases/")) {
      return new Response(JSON.stringify({ tag_name: `v${opts.version}`, assets: [...assets.map((a) => ({ name: a.name, browser_download_url: a.url })), { name: CHECKSUMS_ASSET, browser_download_url: "https://example.test/dl/sums" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://example.test/dl/sums") return new Response(`${sums.join("\n")}\n`);
    const hit = assets.find((a) => a.url === url);
    if (hit) {
      const corrupt = opts.packs.find((p) => remotePackAssetName(p.tool, opts.version, TARGET) === hit.name)?.corrupt;
      return new Response(new Uint8Array(corrupt ? Buffer.from("tampered in transit") : bytes(hit.name)));
    }
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  const downloads = () => log.filter((u) => u.startsWith("https://example.test/dl/") && !u.endsWith("/sums"));
  return { fn, log, downloads };
}

function runner(exec: ReturnType<typeof fakeExec>) {
  const out: string[] = [];
  return { r: new StepRunner({ dryRun: false, out: (l) => out.push(l), exec, env: {} }), out };
}

const product = async () => await mkdtemp(join(tmpdir(), "metistry-rp-"));

/** Every file under runtime/remote/, with its bytes — so "left as it was" is a byte comparison, not a glance at one file. */
async function snapshot(P: string): Promise<Record<string, string>> {
  const { readdir } = await import("node:fs/promises");
  const root = join(P, RUNTIME_DIRNAME, REMOTE_DIRNAME);
  if (!existsSync(root)) return {};
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out[p.slice(root.length + 1)] = await readFile(p, "utf8");
    }
  };
  await walk(root);
  return out;
}

/** Put a pack on disk the way a previous install left it. */
async function preinstall(P: string, tool: RemoteTool, release: string, version = "0.9.0") {
  const dir = remoteToolDir(P, tool);
  for (const [rel, body] of Object.entries(packTree(tool, { version }))) {
    const p = join(P, RUNTIME_DIRNAME, rel);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, body);
  }
  await writeFile(join(dir, ".release"), `${release}\n`);
}

// ---- one asset name, three files; the pins ----------------------------------------------

describe("one asset name per tool, three files; the pins", () => {
  it("the module, the build script's layout and the workflow agree", () => {
    expect(REMOTE_TOOLS).toEqual(["tailscale", "cloudflared", "zrok"]);
    expect(remotePackAssetName("tailscale", "0.2.0", TARGET)).toBe("metistry-remote-tailscale-0.2.0-darwin-arm64.tar.gz");
    expect(remotePackAssetName("zrok", "v0.2.0", TARGET)).toBe(remotePackAssetName("zrok", "0.2.0", TARGET));
    const wf = repoFile(".github/workflows/release.yml");
    expect(wf).toContain('asset="metistry-remote-${tool}-${VERSION}-darwin-arm64.tar.gz"');
    expect(wf).toContain("for tool in tailscale cloudflared zrok; do");
    // the single top-level `remote/<tool>/` that lands as <product>/runtime/remote/<tool>/
    expect(wf).toContain('tar -czf "dist-release/$asset" -C "$GITHUB_WORKSPACE/remote-packs" "remote/$tool"');
    expect(wf).toContain("ops/release/build-remote-packs.sh");
    const script = repoFile("ops/release/build-remote-packs.sh");
    expect(script).toContain('TOOLS="tailscale cloudflared zrok"');
    for (const bin of ["remote/tailscale/bin/tailscaled", "remote/tailscale/bin/tailscale", "remote/cloudflared/bin/cloudflared"]) expect(script).toContain(bin);
    // nothing from a pack reaches the DMG
    expect(repoFile("ops/release/build-app.sh")).toContain('rm -rf "$resources_metistry/runtime/remote"');
  });

  it("every tool is pinned with a version AND a sha256, and the pins are the versions the script asserts", () => {
    const versions = repoFile("ops/release/runtime-versions.env");
    expect(/^TAILSCALE_VERSION=\d+\.\d+\.\d+$/m.test(versions), "TAILSCALE_VERSION must be a release tag's x.y.z").toBe(true);
    expect(/^CLOUDFLARED_VERSION=\d{4}\.\d{1,2}\.\d+$/m.test(versions), "CLOUDFLARED_VERSION is upstream's YYYY.M.N").toBe(true);
    expect(/^ZROK_VERSION=\d+\.\d+\.\d+$/m.test(versions), "ZROK_VERSION must be a release tag's x.y.z").toBe(true);
    for (const k of ["TAILSCALE_SHA256", "CLOUDFLARED_SHA256", "CLOUDFLARED_LICENSE_SHA256", "ZROK_SHA256", "ZROK_LICENSE_SHA256"]) {
      expect(new RegExp(`^${k}=[0-9a-f]{64}$`, "m").test(versions), `${k} must pin a sha256`).toBe(true);
    }
    const script = repoFile("ops/release/build-remote-packs.sh");
    // each download goes through the pinned fetch, and each pack's version is the pin — the archive's own VERSION.txt is checked against it
    expect(script).toContain('fetch "https://github.com/tailscale/tailscale/archive/refs/tags/v$TAILSCALE_VERSION.tar.gz" "$tarball" "$TAILSCALE_SHA256"');
    expect(script).toContain('"$CLOUDFLARED_SHA256"');
    expect(script).toContain('"$ZROK_SHA256"');
    expect(script).toContain("VERSION.txt");
    // and what upstream publishes is cross-checked, the way nodejs.org's SHASUMS256.txt is
    expect(script).toContain("github_asset_digest cloudflare/cloudflared");
    expect(script).toContain("checksums.sha256.txt");
    // the version stamped into tailscale is the pin, not whatever git the work dir sits in
    expect(script).toContain("-X tailscale.com/version.longStamp=$TAILSCALE_VERSION");
    expect(script).toContain("-X tailscale.com/version.shortStamp=$TAILSCALE_VERSION");
    // every tool's licence ships beside it
    expect(script).toContain('[ -f "$out/remote/$tool/LICENSE" ] || die');
  });

  it("every Mach-O in a pack is signed with the release identity — the runtime pack's rule, shared, and checked after signing", () => {
    const lib = repoFile("ops/release/pack-lib.sh");
    const script = repoFile("ops/release/build-remote-packs.sh");
    const deps = repoFile("ops/release/build-runtime-deps.sh");
    // one rule, in one file, sourced by both builds
    expect(script).toContain('. "$root/ops/release/pack-lib.sh"');
    expect(deps).toContain('. "$root/ops/release/pack-lib.sh"');
    expect(lib).toContain("--options runtime");
    expect(lib).toContain("--timestamp");
    expect(lib).toContain("plutil -remove 'com\\.apple\\.security\\.get-task-allow'");
    expect(script).toContain('sign_machos "$out" "com.foldedspacelabs.metistry.remote"');
    expect(deps).toContain('sign_machos "$out" "com.foldedspacelabs.metistry.runtime"');
    // after signing, EVERY Mach-O is checked for the team, the hardened runtime and a timestamp — one miss fails the build
    expect(lib).toContain("verify_signed()");
    expect(lib).toContain('grep -q "^TeamIdentifier=$team\\$"');
    expect(lib).toContain("grep -q 'flags=.*runtime'");
    expect(lib).toContain("grep -q '^Timestamp='");
    expect(script).toContain('verify_signed "$out"');
    // a missing identity is a notice, never a build failure (docs/ops/apple-signing.md)
    expect(script).toContain('if [ -z "$id" ]; then');
    // the manifest records whether the pack was signed, so an install can say so
    expect(script).toContain('"signed": %s');
  });

  it("the release workflow builds the packs in their own job and gates publish on it, and checksums.txt covers them", () => {
    const wf = repoFile(".github/workflows/release.yml");
    expect(wf).toContain("remote-packs:");
    expect(wf).toContain("name: remote-packs (darwin-arm64)");
    expect(wf).toContain("name: remote-packs-darwin-arm64");
    expect(wf).toContain("pattern: remote-packs-*");
    expect(wf).toContain("needs['remote-packs'].result == 'success'");
    expect(wf).toContain("sha256sum * | tee checksums.txt");
    // the DMG job does not wait for them: nothing from a pack is embedded
    expect(/macos-app:\n[\s\S]*?needs: \[([^\]]+)\]/.exec(wf)?.[1]).not.toContain("remote-packs");
  });
});

// ---- installRemotePack ---------------------------------------------------------------------

describe("installRemotePack: verify twice, then swap", () => {
  it("downloads, verifies against checksums.txt and the pack's own manifest, lands at runtime/remote/<tool>/ and records the release", async () => {
    const P = await product();
    const srv = releaseServer({ version: "0.3.0", packs: [{ tool: "tailscale" }] });
    const { r, out } = runner(tarExec({ [remotePackAssetName("tailscale", "0.3.0", TARGET)]: packTree("tailscale", { version: "1.104.1" }) }));
    const res = await installRemotePack(r, { productDir: P, tool: "tailscale", fetchFn: srv.fn, env: {}, target: TARGET });
    expect(res).toMatchObject({ tool: "tailscale", installed: true, version: "0.3.0" });
    expect(existsSync(join(remoteToolDir(P, "tailscale"), "bin", "tailscaled"))).toBe(true);
    expect(existsSync(join(remoteToolDir(P, "tailscale"), "LICENSE"))).toBe(true);
    expect(await installedRemotePackRelease(P, "tailscale")).toBe("0.3.0");
    expect((await readRemotePackManifest(P, "tailscale"))?.version).toBe("1.104.1");
    expect(out.join("\n")).toContain("tailscale 1.104.1, signed (release 0.3.0)");
    // staging does not survive, and nothing else appeared under runtime/remote/
    expect(existsSync(join(P, ".remote-download-tailscale"))).toBe(false);
    expect((await installedRemotePacks(P)).map((p) => p.tool)).toEqual(["tailscale"]);
    // only the one asset (plus checksums.txt) was asked for
    expect(srv.downloads()).toEqual([`https://example.test/dl/${remotePackAssetName("tailscale", "0.3.0", TARGET)}`]);
  });

  it("a checksum mismatch leaves runtime/remote/ exactly as it was — the pack being replaced AND its neighbours", async () => {
    const P = await product();
    await preinstall(P, "tailscale", "0.2.0");
    await preinstall(P, "zrok", "0.2.0");
    const before = await snapshot(P);
    expect(Object.keys(before).length).toBeGreaterThan(4);
    const srv = releaseServer({ version: "0.3.0", packs: [{ tool: "tailscale", corrupt: true }] });
    const { r } = runner(tarExec({}));
    await expect(installRemotePack(r, { productDir: P, tool: "tailscale", fetchFn: srv.fn, env: {}, target: TARGET })).rejects.toThrow(/failed its checksum .* runtime\/remote\/ is unchanged/);
    expect(await snapshot(P)).toEqual(before);
    expect(r.commands.some((c) => c.startsWith("tar"))).toBe(false);
    expect(existsSync(join(P, ".remote-download-tailscale"))).toBe(false);
  });

  it("a tampered pack — checksums.txt agrees but the contents do not hash to its manifest — is refused and leaves the tree as it was", async () => {
    const P = await product();
    await preinstall(P, "cloudflared", "0.2.0");
    const before = await snapshot(P);
    const asset = remotePackAssetName("cloudflared", "0.3.0", TARGET);
    const srv = releaseServer({ version: "0.3.0", packs: [{ tool: "cloudflared" }] });
    const { r } = runner(tarExec({ [asset]: packTree("cloudflared", { breakHash: true }) }));
    await expect(installRemotePack(r, { productDir: P, tool: "cloudflared", fetchFn: srv.fn, env: {}, target: TARGET })).rejects.toThrow(/tampered with .* runtime\/remote\/ is unchanged/);
    expect(await snapshot(P)).toEqual(before);
    expect(existsSync(join(P, ".remote-download-cloudflared"))).toBe(false);
  });

  it("verifyUnpackedRemotePack names each way a pack can lie: the wrong tool, a stray top level, a missing or escaping binary, no manifest", async () => {
    const write = async (tree: Record<string, string>) => {
      const dir = await mkdtemp(join(tmpdir(), "metistry-rp-unpacked-"));
      for (const [rel, body] of Object.entries(tree)) {
        await mkdir(join(dir, rel, ".."), { recursive: true });
        await writeFile(join(dir, rel), body);
      }
      return dir;
    };
    expect(await verifyUnpackedRemotePack(await write(packTree("zrok")), "zrok")).toBeUndefined();
    expect(await verifyUnpackedRemotePack(await write(packTree("zrok")), "tailscale")).toMatch(/holds remote\/zrok, not remote\/tailscale/);
    expect(await verifyUnpackedRemotePack(await write(packTree("zrok", { manifestTool: "tailscale" })), "zrok")).toMatch(/names tailscale, not zrok/);
    expect(await verifyUnpackedRemotePack(await write({ ...packTree("zrok"), "README.md": "hi" }), "zrok")).toMatch(/top level is/);
    expect(await verifyUnpackedRemotePack(await write({ [`${REMOTE_DIRNAME}/zrok/LICENSE`]: "x" }), "zrok")).toMatch(/no readable remote\/zrok\/manifest.json/);
    const missing = packTree("zrok");
    delete missing[`${REMOTE_DIRNAME}/zrok/bin/zrok`];
    expect(await verifyUnpackedRemotePack(await write(missing), "zrok")).toMatch(/listed in its manifest but missing/);
    const escaping = { [`${REMOTE_DIRNAME}/zrok/manifest.json`]: JSON.stringify({ tool: "zrok", binaries: { "../../etc/passwd": sha256("x") } }) };
    expect(await verifyUnpackedRemotePack(await write(escaping), "zrok")).toMatch(/outside the pack/);
    expect(await verifyUnpackedRemotePack(await write({ [`${REMOTE_DIRNAME}/zrok/manifest.json`]: JSON.stringify({ tool: "zrok", binaries: {} }) }), "zrok")).toMatch(/lists no binaries/);
  });

  it("never moves a pack backwards: an older release is refused unless forced", async () => {
    const P = await product();
    await preinstall(P, "tailscale", "0.5.0");
    const before = await snapshot(P);
    const srv = releaseServer({ version: "0.4.0", packs: [{ tool: "tailscale" }] });
    const { r } = runner(tarExec({ [remotePackAssetName("tailscale", "0.4.0", TARGET)]: packTree("tailscale") }));
    const res = await installRemotePack(r, { productDir: P, tool: "tailscale", fetchFn: srv.fn, env: {}, target: TARGET, version: "0.4.0" });
    expect(res).toMatchObject({ installed: false, skipped: "downgrade", version: "0.5.0" });
    expect(res.reason).toContain("v0.4.0 is older");
    expect(srv.downloads()).toEqual([]);
    expect(await snapshot(P)).toEqual(before);
    // --force is the one way past it
    const forced = await installRemotePack(runner(tarExec({ [remotePackAssetName("tailscale", "0.4.0", TARGET)]: packTree("tailscale") })).r, { productDir: P, tool: "tailscale", fetchFn: srv.fn, env: {}, target: TARGET, version: "0.4.0", force: true });
    expect(forced.installed).toBe(true);
    expect(await installedRemotePackRelease(P, "tailscale")).toBe("0.4.0");
  });

  it("the same release again is a note; METISTRY_RUNTIME_DEPS=0 and a foreign target reach nothing; a release without the asset is a note", async () => {
    const P = await product();
    await preinstall(P, "zrok", "0.3.0");
    const srv = releaseServer({ version: "0.3.0", packs: [{ tool: "zrok" }] });
    const same = await installRemotePack(runner(tarExec({})).r, { productDir: P, tool: "zrok", fetchFn: srv.fn, env: {}, target: TARGET });
    expect(same).toMatchObject({ installed: false, skipped: "already" });
    expect(srv.downloads()).toEqual([]);

    const never = (() => {
      throw new Error("must not reach the network");
    }) as unknown as typeof fetch;
    const off = await installRemotePack(runner(tarExec({})).r, { productDir: P, tool: "tailscale", fetchFn: never, env: { METISTRY_RUNTIME_DEPS: "0" }, target: TARGET });
    expect(off).toMatchObject({ installed: false, skipped: "off-network" });
    expect(off.reason).toContain("METISTRY_RUNTIME_DEPS=0");
    const linux = await installRemotePack(runner(tarExec({})).r, { productDir: P, tool: "tailscale", fetchFn: never, env: {}, target: "linux-x64" });
    expect(linux).toMatchObject({ installed: false, skipped: "no-target" });

    const none = await installRemotePack(runner(tarExec({})).r, { productDir: P, tool: "cloudflared", fetchFn: srv.fn, env: {}, target: TARGET });
    expect(none).toMatchObject({ installed: false, skipped: "no-asset" });
    expect(none.reason).toContain("carries no metistry-remote-cloudflared-0.3.0");
    expect(existsSync(remoteToolDir(P, "cloudflared"))).toBe(false);
  });
});

// ---- fetched on choice -----------------------------------------------------------------------

/** An adapter whose configure asks for its pack the way X-106's will, standing in for every provider that bundles a tool. */
function packedProvider(id: RemoteProvider["id"], tool: RemoteTool, origin: string, log: string[]): RemoteProvider {
  return {
    id,
    label: `Fake ${id}`,
    async detect(ctx) {
      const pack = await findRemotePack(ctx.productDir, tool);
      log.push(`detect:${id}:${pack ? "pack" : "absent"}`);
      return { tool: pack ? { present: true, version: pack.version, from: "pack" } : { present: false }, signed_in: true, origin, would_change: [] };
    },
    async configure(ctx) {
      // the pack is darwin-arm64's; this test is about the fetch path, not the host it runs on (CI is Linux)
      const got = await ensureRemotePack(ctx, tool, { target: TARGET });
      log.push(`configure:${id}:${got.pack ? `pack:${got.pack.version}:fetched=${got.fetched}` : `none:${got.skipped}`}`);
      if (!got.pack) throw new Error(got.reason);
      return { origin, settings: { upstream: `http://127.0.0.1:${ctx.proxyPort}`, tool: got.pack.bin(tool === "tailscale" ? "bin/tailscaled" : `bin/${tool}`) ?? "" } };
    },
    async status() {
      return [];
    },
    async revoke() {
      return { undone: [], left_for_owner: [] };
    },
  };
}

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

async function instance(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-rp-inst-"));
  await mkdir(join(dir, ".metistry", "state"), { recursive: true });
  await writeFile(join(dir, ".metistry", "identity.yaml"), `name: Test\ninstance_id: ${INSTANCE_ID}\n`);
  return dir;
}

/** A release server whose fetch also answers `GET <origin>/health` and `/api/identity` for the origins in `up`. */
function netAndRelease(up: Set<string>, srv: ReturnType<typeof releaseServer>) {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (up.has(url.origin)) return new Response(JSON.stringify({ instance_id: INSTANCE_ID }), { status: 200, headers: { "content-type": "application/json" } });
    return srv.fn(url.href);
  }) as unknown as typeof fetch;
}

describe("fetched on choice: `metistry remote set <provider>` fetches its provider's pack and nothing else", () => {
  it("choosing a provider fetches exactly its tool's pack through configure; the record then names the pack's binary; detect sees it from the pack", async () => {
    const P = await product();
    const I = await instance();
    const log: string[] = [];
    const srv = releaseServer({ version: "0.3.0", packs: [{ tool: "tailscale" }, { tool: "cloudflared" }, { tool: "zrok" }], depsPack: true });
    const fetchFn = netAndRelease(new Set(["https://mac.tail.ts.net"]), srv);
    const providers: RemoteRegistry = { tailscale: packedProvider("tailscale", "tailscale", "https://mac.tail.ts.net", log) };
    const exec = tarExec({ [remotePackAssetName("tailscale", "0.3.0", TARGET)]: packTree("tailscale", { version: "1.104.1" }) });
    const res = await remoteSet({ productDir: P, instanceDir: I, env: {}, platform: "darwin", uid: 501, fetchFn, exec, out: () => {}, providers, provider: "tailscale", options: { flags: {} }, yes: true, pollMs: 0, sleep: async () => {} });
    expect(res.applied).toBe(true);
    expect(log).toEqual(["detect:tailscale:absent", "configure:tailscale:pack:1.104.1:fetched=true"]);
    // ONLY tailscale's pack was downloaded — not cloudflared's, not zrok's, not the deps pack
    expect(srv.downloads()).toEqual([`https://example.test/dl/${remotePackAssetName("tailscale", "0.3.0", TARGET)}`]);
    expect((await installedRemotePacks(P)).map((p) => p.tool)).toEqual(["tailscale"]);
    expect(readFileSync(join(I, ".metistry", "deployment.yaml"), "utf8")).toContain(`tool: "${join(remoteToolDir(P, "tailscale"), "bin", "tailscaled")}"`);
    // second time: the pack is here, nothing is fetched, configure still succeeds (idempotent)
    const again = releaseServer({ version: "0.3.0", packs: [{ tool: "tailscale" }] });
    await remoteSet({ productDir: P, instanceDir: I, env: {}, platform: "darwin", uid: 501, fetchFn: netAndRelease(new Set(["https://mac.tail.ts.net"]), again), exec, out: () => {}, providers, provider: "tailscale", options: { flags: {} }, yes: true, pollMs: 0, sleep: async () => {} });
    expect(log.slice(2)).toEqual(["detect:tailscale:pack", "configure:tailscale:pack:1.104.1:fetched=false"]);
    expect(again.downloads()).toEqual([]);
  });

  it("a provider not chosen fetches nothing: `set none` and a preview reach for no pack at all", async () => {
    const P = await product();
    const I = await instance();
    const log: string[] = [];
    const srv = releaseServer({ version: "0.3.0", packs: [{ tool: "tailscale" }] });
    const providers: RemoteRegistry = { tailscale: packedProvider("tailscale", "tailscale", "https://mac.tail.ts.net", log) };
    const never = (() => {
      throw new Error("a provider the owner did not pick must not reach the network");
    }) as unknown as typeof fetch;
    // None: the default, and `remote off`
    const none = await remoteSet({ productDir: P, instanceDir: I, env: {}, platform: "darwin", uid: 501, fetchFn: never, exec: tarExec({}), out: () => {}, providers: { ...providers, none: (await import("../src/remote/index.js")).none }, provider: "none", options: { flags: {} }, yes: true });
    expect(none.applied).toBe(false);
    expect(existsSync(join(P, RUNTIME_DIRNAME))).toBe(false);
    // a PREVIEW of tailscale: detect runs, configure does not, nothing is fetched
    const preview = await remoteSet({ productDir: P, instanceDir: I, env: {}, platform: "darwin", uid: 501, fetchFn: srv.fn, exec: tarExec({}), out: () => {}, providers, provider: "tailscale", options: { flags: {} } });
    expect(preview.applied).toBe(false);
    expect(log).toEqual(["detect:tailscale:absent"]);
    expect(srv.downloads()).toEqual([]);
    expect(existsSync(join(P, RUNTIME_DIRNAME))).toBe(false);
  });

  it("a corrupt download fails configure, so nothing is written and runtime/remote/ is as it was", async () => {
    const P = await product();
    const I = await instance();
    const log: string[] = [];
    await preinstall(P, "zrok", "0.2.0");
    const before = await snapshot(P);
    const srv = releaseServer({ version: "0.3.0", packs: [{ tool: "tailscale", corrupt: true }] });
    const providers: RemoteRegistry = { tailscale: packedProvider("tailscale", "tailscale", "https://mac.tail.ts.net", log) };
    await expect(
      remoteSet({ productDir: P, instanceDir: I, env: {}, platform: "darwin", uid: 501, fetchFn: netAndRelease(new Set(), srv), exec: tarExec({}), out: () => {}, providers, provider: "tailscale", options: { flags: {} }, yes: true, pollMs: 0, sleep: async () => {} }),
    ).rejects.toThrow(/tailscale could not be set up \(.*failed its checksum.*\) — nothing was written and remote access is still none/);
    expect(existsSync(join(I, ".metistry", "deployment.yaml"))).toBe(false);
    expect(await snapshot(P)).toEqual(before);
  });

  it("METISTRY_RUNTIME_DEPS=0: ensureRemotePack fetches nothing and the reason names the manual install for the adapter to repeat", async () => {
    const P = await product();
    const never = (() => {
      throw new Error("off the network");
    }) as unknown as typeof fetch;
    const ctx: Pick<RemoteContext, "productDir" | "env" | "fetchFn" | "exec" | "dryRun" | "note"> = { productDir: P, env: { METISTRY_RUNTIME_DEPS: "0" }, fetchFn: never, exec: fakeExec(), dryRun: false, note: () => {} };
    const res = await ensureRemotePack(ctx, "tailscale");
    expect(res.pack).toBeUndefined();
    if (!res.pack) {
      expect(res.skipped).toBe("off-network");
      expect(res.reason).toContain("METISTRY_RUNTIME_DEPS=0");
      expect(res.reason).toContain(MANUAL_INSTALL.tailscale);
    }
    // a dry run with no pack: nothing fetched, said as a preview
    const dry = await ensureRemotePack({ ...ctx, env: {}, dryRun: true }, "zrok");
    expect(dry.pack).toBeUndefined();
    if (!dry.pack) expect(dry.skipped).toBe("dry-run");
    // a dry run WITH a pack reports it without reaching anywhere
    await preinstall(P, "zrok", "0.2.0", "2.0.8");
    const have = await ensureRemotePack({ ...ctx, env: {}, dryRun: true }, "zrok");
    expect(have.pack?.version).toBe("2.0.8");
    expect(have.pack?.binaries).toEqual(["bin/zrok"]);
    expect(have.pack?.bin("bin/zrok")).toBe(join(remoteToolDir(P, "zrok"), "bin", "zrok"));
    expect(have.pack?.bin("bin/zrok2")).toBeUndefined();
  });
});

// ---- moved forward by `metistry update` -------------------------------------------------------

describe("`metistry update` moves a fetched pack forward with the release, and fetches none the owner never chose", () => {
  it("updateRemotePacks: only the packs already here", async () => {
    const P = await product();
    await preinstall(P, "tailscale", "0.2.0");
    const srv = releaseServer({ version: "0.3.0", packs: [{ tool: "tailscale" }, { tool: "cloudflared" }, { tool: "zrok" }] });
    const { r } = runner(tarExec({ [remotePackAssetName("tailscale", "0.3.0", TARGET)]: packTree("tailscale", { version: "1.104.1" }) }));
    const res = await updateRemotePacks(r, { productDir: P, fetchFn: srv.fn, env: {}, target: TARGET, version: "0.3.0" });
    expect(res.map((p) => [p.tool, p.installed])).toEqual([["tailscale", true]]);
    expect(srv.downloads()).toEqual([`https://example.test/dl/${remotePackAssetName("tailscale", "0.3.0", TARGET)}`]);
    expect(await installedRemotePackRelease(P, "tailscale")).toBe("0.3.0");
    expect((await installedRemotePacks(P)).map((p) => p.tool)).toEqual(["tailscale"]);
    // an install with no pack reaches for nothing at all
    const empty = await product();
    const quiet = releaseServer({ version: "0.3.0", packs: [{ tool: "tailscale" }] });
    expect(await updateRemotePacks(runner(tarExec({})).r, { productDir: empty, fetchFn: quiet.fn, env: {}, target: TARGET })).toEqual([]);
    expect(quiet.log).toEqual([]);
  });

  it("a deps-pack unpack carries runtime/remote/ across — a new Node, Postgres or git does not take the owner's tools with it", async () => {
    const P = await product();
    await preinstall(P, "tailscale", "0.2.0");
    const before = await snapshot(P);
    const deps = runtimeDepsAssetName("0.3.0", TARGET);
    const srv = releaseServer({ version: "0.3.0", packs: [], depsPack: true });
    const { r } = runner(tarExec({ [deps]: { [`${RUNTIME_DIRNAME}/manifest.json`]: JSON.stringify({ components: { node: { version: "22.23.2" } } }), [`${RUNTIME_DIRNAME}/node/bin/node`]: "#!/bin/sh\n" } }));
    const res = await installRuntimeDeps(r, { productDir: P, fetchFn: srv.fn, env: {}, target: TARGET });
    expect(res.installed).toBe(true);
    expect(existsSync(join(P, RUNTIME_DIRNAME, "node", "bin", "node"))).toBe(true);
    expect(await snapshot(P)).toEqual(before);
    expect(existsSync(join(P, ".runtime-remote-keep"))).toBe(false);
  });

  it("through `update --channel release`: the pack already here moves to the release; the dry run says so", async () => {
    const { checkout, okDoctor } = await import("./fixtures.js");
    const { update } = await import("../src/update.js");
    const { cp } = await import("node:fs/promises");
    const { serializeLock } = await import("../src/lock.js");
    const src = await checkout();
    const P = await product();
    const inst = await mkdtemp(join(tmpdir(), "mi-"));
    await mkdir(join(inst, ".metistry"), { recursive: true });
    await writeFile(join(inst, ".metistry", "metistry.lock"), serializeLock({ product: { version: "0.2.0", commit: "unknown", source: "release" }, updated_at: "2026-09-01T00:00:00.000Z", migrations_applied: [] }));
    await preinstall(P, "zrok", "0.2.0");

    const pack = runtimeAssetName("0.3.0", TARGET);
    const srv = releaseServer({ version: "0.3.0", packs: [{ tool: "zrok" }, { tool: "tailscale" }], depsPack: true });
    // the product pack is served too
    const packBytes = Buffer.from("the product\n");
    const fn = (async (u: string | URL) => {
      const url = String(u);
      if (url.includes("/releases/")) {
        const base = (await (await srv.fn(url)).json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
        base.assets.push({ name: pack, browser_download_url: `https://example.test/dl/${pack}` });
        return new Response(JSON.stringify(base), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://example.test/dl/sums") return new Response(`${await (await srv.fn(url)).text()}${sha256(packBytes)}  ${pack}\n`);
      if (url.endsWith(pack)) return new Response(new Uint8Array(packBytes));
      return srv.fn(url);
    }) as unknown as typeof fetch;
    const exec = fakeExec({
      tar: async (args) => {
        const file = args[args.indexOf("-xzf") + 1]!;
        const dest = args[args.indexOf("-C") + 1]!;
        const tree = file.endsWith(remotePackAssetName("zrok", "0.3.0", TARGET))
          ? packTree("zrok", { version: "2.0.8" })
          : file.includes("runtime-deps")
            ? { [`${RUNTIME_DIRNAME}/manifest.json`]: JSON.stringify({ components: { node: { version: "22.23.2" } } }), [`${RUNTIME_DIRNAME}/node/bin/node`]: "#!/bin/sh\n" }
            : undefined;
        if (!tree) {
          await cp(src, dest, { recursive: true });
          return;
        }
        for (const [rel, body] of Object.entries(tree)) {
          await mkdir(join(dest, rel, ".."), { recursive: true });
          await writeFile(join(dest, rel), body);
        }
      },
    });
    const r = await update({ productDir: P, env: { METISTRY_INSTANCE_DIR: inst }, exec, out: () => {}, platform: "darwin", uid: 501, version: "0.0.9", now: new Date("2026-10-19T00:00:00Z"), fetchFn: fn, target: TARGET, skipMigrate: true, channel: "release", openSession: async () => null, doctorFn: okDoctor });
    expect(r.release).toMatchObject({ version: "0.3.0", installed: true });
    expect(r.remotePacks?.map((p) => [p.tool, p.installed])).toEqual([["zrok", true]]);
    expect(await installedRemotePackRelease(P, "zrok")).toBe("0.3.0");
    expect((await readRemotePackManifest(P, "zrok"))?.version).toBe("2.0.8");
    // tailscale was in the release and was never chosen: not fetched
    expect(srv.downloads()).not.toContain(`https://example.test/dl/${remotePackAssetName("tailscale", "0.3.0", TARGET)}`);
    expect(existsSync(remoteToolDir(P, "tailscale"))).toBe(false);

    const lines: string[] = [];
    await update({ productDir: await checkout(), env: {}, exec: fakeExec(), out: (l) => lines.push(l), dryRun: true, platform: "darwin", uid: 501, channel: "release", target: TARGET, doctorFn: okDoctor, openSession: async () => null });
    expect(lines.join("\n")).toContain(`metistry-remote-<tool>-<latest>-${TARGET}.tar.gz`);
    expect(lines.join("\n")).toContain("a tool whose provider was never chosen is not fetched");
  });
});
