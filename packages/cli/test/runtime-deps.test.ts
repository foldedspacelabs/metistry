// The bundled runtime — `<product>/runtime/` — as `up` and `update` see it:
// the same resolve/checksum/unpack path the product's runtime pack uses,
// `METISTRY_PG_BIN` resolution finding `runtime/postgres/bin`, the
// reconciler's plist getting the bundled git on the FRONT of its PATH, and
// the three files that must agree on one asset name (this module, the build
// script and the release workflow). Injected fetch and exec throughout: no
// network, no subprocess.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GIT_SPAWNING_SERVICES, parsePlistTemplate, renderPlist, withEnvironmentVariables } from "../src/launchd.js";
import { findPgToolchain, pgCandidates } from "../src/postgres.js";
import { CHECKSUMS_ASSET } from "../src/release.js";
import {
  describeRuntime,
  installedRuntimeVersion,
  installRuntimeDeps,
  LAUNCHD_BASE_PATH,
  pathWithRuntimeGit,
  readRuntimeManifest,
  RUNTIME_DIRNAME,
  runtimeDepsAssetName,
  runtimeDepsEnabled,
  runtimeGitBin,
} from "../src/runtime-deps.js";
import { StepFailed, StepRunner } from "../src/steps.js";
import { fakeExec } from "./fixtures.js";

const repoFile = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const TARGET = "darwin-arm64";

/** A tar-shaped fake: `tar -xzf <pack> -C <dir>` writes the tree the real pack carries. */
function tarExec(tree: Record<string, string> = { [`${RUNTIME_DIRNAME}/manifest.json`]: JSON.stringify({ components: { node: { version: "22.23.2" }, postgres: { version: "17.11" } } }) }) {
  return fakeExec({
    tar: async (args) => {
      const dir = args[args.indexOf("-C") + 1]!;
      for (const [rel, body] of Object.entries(tree)) {
        await mkdir(join(dir, rel, ".."), { recursive: true });
        await writeFile(join(dir, rel), body);
      }
    },
  });
}

/** A release carrying (or deliberately missing) a deps pack, served by an injected fetch. */
function depsServer(opts: { version: string; body?: string; corrupt?: boolean; omitAsset?: boolean }) {
  const asset = runtimeDepsAssetName(opts.version, TARGET);
  const bytes = Buffer.from(opts.body ?? "a runtime deps pack\n");
  const tarUrl = `https://example.test/dl/${asset}`;
  const sumUrl = `https://example.test/dl/${CHECKSUMS_ASSET}`;
  const fn = (async (u: string | URL) => {
    const url = String(u);
    if (url.includes("/releases/")) {
      return new Response(
        JSON.stringify({
          tag_name: `v${opts.version}`,
          assets: [
            ...(opts.omitAsset ? [] : [{ name: asset, browser_download_url: tarUrl }]),
            { name: CHECKSUMS_ASSET, browser_download_url: sumUrl },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === sumUrl) return new Response(`${sha256(bytes)}  ${asset}\n`);
    if (url === tarUrl) return new Response(new Uint8Array(opts.corrupt ? Buffer.from("tampered") : bytes));
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, asset };
}

function runner(exec = tarExec()) {
  const out: string[] = [];
  return { r: new StepRunner({ dryRun: false, out: (l) => out.push(l), exec, env: {} }), out, exec };
}

describe("one asset name, three files", () => {
  it("the module, the build script's output and the workflow agree", () => {
    expect(runtimeDepsAssetName("0.2.0", TARGET)).toBe("metistry-runtime-deps-0.2.0-darwin-arm64.tar.gz");
    expect(runtimeDepsAssetName("v0.2.0", TARGET)).toBe(runtimeDepsAssetName("0.2.0", TARGET));
    const wf = repoFile(".github/workflows/release.yml");
    expect(wf).toContain('asset="metistry-runtime-deps-${VERSION}-darwin-arm64.tar.gz"');
    // and the pack's single top-level directory is what `tar -C <product>` needs
    expect(wf).toContain(`tar -czf "dist-release/$asset" -C "$GITHUB_WORKSPACE" ${RUNTIME_DIRNAME}`);
    expect(wf).toContain("ops/release/build-runtime-deps.sh");
  });

  it("the build script and the CLI pin the same Postgres major and the same layout", () => {
    const versions = repoFile("ops/release/runtime-versions.env");
    expect(/^PG_VERSION=17\./m.test(versions)).toBe(true);
    for (const k of ["NODE_SHA256", "PG_SHA256", "PGVECTOR_SHA256", "GIT_SHA256"]) {
      expect(new RegExp(`^${k}=[0-9a-f]{64}$`, "m").test(versions), `${k} must pin a sha256`).toBe(true);
    }
    // engines.node must be satisfiable by the pinned Node
    const major = Number(/^NODE_VERSION=(\d+)\./m.exec(versions)![1]);
    expect(major).toBeGreaterThanOrEqual(Number(/>=(\d+)/.exec(JSON.parse(repoFile("package.json")).engines.node)![1]));
    const script = repoFile("ops/release/build-runtime-deps.sh");
    for (const bin of ["initdb", "pg_ctl", "psql", "pg_dump", "pg_restore", "pg_isready"]) expect(script).toContain(bin);
    expect(script).toContain("com.foldedspacelabs.metistry.runtime.");
    expect(script).toContain("--options runtime");
    expect(script).toContain("--timestamp");
    // a missing identity must never fail the build
    expect(script).toContain('if [ -z "$id" ]; then');
  });
});

describe("resolution: runtime/postgres/bin and runtime/git/bin", () => {
  it("METISTRY_PG_BIN resolution finds the bundled runtime ahead of Homebrew", () => {
    const P = "/p";
    const present = new Set(["postgres", "initdb", "psql", "createdb", "pg_isready"].map((b) => join(P, RUNTIME_DIRNAME, "postgres", "bin", b)));
    present.add(join(P, RUNTIME_DIRNAME, "postgres", "share", "extension", "vector.control"));
    // Homebrew is "installed" too — the bundled runtime still wins
    for (const b of ["postgres", "initdb", "psql", "createdb", "pg_isready"]) present.add(`/opt/homebrew/opt/postgresql@17/bin/${b}`);
    const t = findPgToolchain(pgCandidates({}, P), (p) => present.has(p));
    expect(t?.source).toBe("bundled");
    expect(t?.bin).toBe(join(P, RUNTIME_DIRNAME, "postgres", "bin"));
    expect(t?.pgvector).toBe(true);
  });

  it("pathWithRuntimeGit prefixes the bundled git, and is undefined when there is none", () => {
    const P = "/p";
    expect(pathWithRuntimeGit(P, () => false)).toBeUndefined();
    expect(pathWithRuntimeGit(P, (p) => p === join(runtimeGitBin(P), "git"))).toBe(`${join(P, RUNTIME_DIRNAME, "git", "bin")}:${LAUNCHD_BASE_PATH}`);
    // a launchd job inherits no login shell, so the base PATH is the system one
    expect(LAUNCHD_BASE_PATH.split(":")).toContain("/usr/bin");
  });

  it("METISTRY_RUNTIME_DEPS=0 keeps up/update off the network", () => {
    expect(runtimeDepsEnabled({})).toBe(true);
    expect(runtimeDepsEnabled({ METISTRY_RUNTIME_DEPS: "0" })).toBe(false);
  });
});

describe("the reconciler's plist gets the bundled git", () => {
  const real = repoFile("ops/launchd/com.foldedspacelabs.metistry.reconciler.plist");

  it("the reconciler is the job that spawns git (D5)", () => {
    expect([...GIT_SPAWNING_SERVICES]).toEqual(["reconciler"]);
    expect(parsePlistTemplate("r.plist", real).service).toBe("reconciler");
  });

  it("adds an EnvironmentVariables dict with PATH, without disturbing the rendered job", () => {
    const rendered = renderPlist(real, { repo: "/p", node: "/usr/bin/node", envFile: "/i/state/.env" });
    const withPath = withEnvironmentVariables(rendered, { PATH: `/p/${RUNTIME_DIRNAME}/git/bin:${LAUNCHD_BASE_PATH}` });
    expect(withPath).toContain("<key>EnvironmentVariables</key>");
    expect(withPath).toContain(`<key>PATH</key><string>/p/${RUNTIME_DIRNAME}/git/bin:${LAUNCHD_BASE_PATH}</string>`);
    // still one plist, still the same job
    expect(parsePlistTemplate("r.plist", withPath).programArguments).toEqual(parsePlistTemplate("r.plist", rendered).programArguments);
    expect(parsePlistTemplate("r.plist", withPath).environment.PATH).toContain(`/p/${RUNTIME_DIRNAME}/git/bin`);
    expect(withPath.match(/<\/plist>/g)).toHaveLength(1);
  });

  it("merges into a template that already has a dict, and never overrides a key the template set", () => {
    const t = `<plist version="1.0">\n<dict>\n  <key>Label</key><string>x</string>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>METISTRY_EK_SOCKET</key><string>/tmp/x.sock</string>\n  </dict>\n</dict>\n</plist>\n`;
    const merged = withEnvironmentVariables(t, { PATH: "/bundled:/usr/bin" });
    const env = parsePlistTemplate("x.plist", merged).environment;
    expect(env).toEqual({ METISTRY_EK_SOCKET: "/tmp/x.sock", PATH: "/bundled:/usr/bin" });
    expect(withEnvironmentVariables(merged, { PATH: "/somewhere/else" })).toBe(merged);
    expect(withEnvironmentVariables(t, {})).toBe(t);
  });
});

describe("installRuntimeDeps: verify, then unpack", () => {
  const product = async () => await mkdtemp(join(tmpdir(), "metistry-rt-"));

  it("downloads, verifies the sha256 against checksums.txt, unpacks to <product>/runtime/ and records the release", async () => {
    const P = await product();
    const { fn, asset } = depsServer({ version: "0.3.0" });
    const { r, out } = runner();
    const res = await installRuntimeDeps(r, { productDir: P, fetchFn: fn, env: {}, target: TARGET });
    expect(res.installed).toBe(true);
    expect(res.version).toBe("0.3.0");
    expect(existsSync(join(P, RUNTIME_DIRNAME, "manifest.json"))).toBe(true);
    expect(await installedRuntimeVersion(P)).toBe("0.3.0");
    expect(r.commands.some((c) => c.includes(`tar -xzf`) && c.includes(`-C ${P}`))).toBe(true);
    expect(out.join("\n")).toContain(asset);
    expect(describeRuntime(await readRuntimeManifest(P))).toContain("postgres 17.11");
    // the staging directory does not survive
    expect(existsSync(join(P, ".runtime-download"))).toBe(false);
  });

  it("refuses a tampered pack and leaves runtime/ exactly as it was", async () => {
    const P = await product();
    await mkdir(join(P, RUNTIME_DIRNAME), { recursive: true });
    await writeFile(join(P, RUNTIME_DIRNAME, "manifest.json"), '{"keep":"me"}');
    const { fn } = depsServer({ version: "0.3.0", corrupt: true });
    const { r } = runner();
    await expect(installRuntimeDeps(r, { productDir: P, fetchFn: fn, env: {}, target: TARGET })).rejects.toThrow(StepFailed);
    expect(await readFile(join(P, RUNTIME_DIRNAME, "manifest.json"), "utf8")).toBe('{"keep":"me"}');
  });

  it("is a note, not a failure, when the release carries no deps pack or the target has none", async () => {
    const P = await product();
    const { r } = runner();
    const linux = await installRuntimeDeps(r, { productDir: P, fetchFn: depsServer({ version: "0.3.0" }).fn, env: {}, target: "linux-x64" });
    expect(linux.installed).toBe(false);
    expect(linux.reason).toContain("linux-x64");
    const none = await installRuntimeDeps(r, { productDir: P, fetchFn: depsServer({ version: "0.3.0", omitAsset: true }).fn, env: {}, target: TARGET });
    expect(none.installed).toBe(false);
    expect(none.reason).toContain("carries no metistry-runtime-deps-0.3.0");
    expect(existsSync(join(P, RUNTIME_DIRNAME))).toBe(false);
  });

  it("does not re-download the pack it already has", async () => {
    const P = await product();
    const { fn } = depsServer({ version: "0.3.0" });
    const first = runner();
    await installRuntimeDeps(first.r, { productDir: P, fetchFn: fn, env: {}, target: TARGET });
    const second = runner();
    const res = await installRuntimeDeps(second.r, { productDir: P, fetchFn: fn, env: {}, target: TARGET });
    expect(res.installed).toBe(false);
    expect(res.reason).toContain("already the 0.3.0 pack");
    expect(second.r.commands.some((c) => c.startsWith("tar"))).toBe(false);
    // …unless asked to
    const forced = runner();
    expect((await installRuntimeDeps(forced.r, { productDir: P, fetchFn: fn, env: {}, target: TARGET, force: true })).installed).toBe(true);
  });

  it("refuses a pack that unpacks without a runtime/manifest.json", async () => {
    const P = await product();
    const { fn } = depsServer({ version: "0.3.0" });
    const { r } = runner(tarExec({ "some/other/tree.txt": "not a runtime" }));
    await expect(installRuntimeDeps(r, { productDir: P, fetchFn: fn, env: {}, target: TARGET })).rejects.toThrow(/not a runtime deps pack/);
  });
});

// ---- end to end, through `up` and `update` -------------------------------------

/** What the real pack carries, as far as `up` is concerned. */
const RUNTIME_TREE: Record<string, string> = {
  [`${RUNTIME_DIRNAME}/manifest.json`]: JSON.stringify({ components: { node: { version: "22.23.2" }, postgres: { version: "17.11" }, pgvector: { version: "0.8.6" }, git: { version: "2.54.0" } } }),
  [`${RUNTIME_DIRNAME}/postgres/share/extension/vector.control`]: "default_version = '0.8.6'\n",
  [`${RUNTIME_DIRNAME}/git/bin/git`]: "#!/bin/sh\n",
  [`${RUNTIME_DIRNAME}/node/bin/node`]: "#!/bin/sh\n",
};
for (const b of ["postgres", "initdb", "psql", "createdb", "pg_isready", "pg_ctl", "pg_dump", "pg_restore"]) RUNTIME_TREE[`${RUNTIME_DIRNAME}/postgres/bin/${b}`] = "#!/bin/sh\n";

/** Real filesystem inside the product dir, and nothing outside it — so this machine's Homebrew cannot answer for the test. */
const onlyUnder = (P: string) => (p: string) => p.startsWith(P) && existsSync(p);

describe("metistry up, launchd shape, release mode", () => {
  it("fetches the deps pack when no Postgres exists anywhere, then renders the db plist against runtime/postgres/bin and the reconciler's PATH against runtime/git/bin", async () => {
    const { checkout } = await import("./fixtures.js");
    const { okDoctor } = await import("./fixtures.js");
    const { up } = await import("../src/up.js");
    const { cp } = await import("node:fs/promises");
    const src = await checkout();
    const HOME = await mkdtemp(join(tmpdir(), "metistry-home-"));
    // the repo's REAL plists, so a template edit that breaks this fails here
    await cp(fileURLToPath(new URL("../../../ops/launchd", import.meta.url)), join(src, "ops", "launchd"), { recursive: true });
    await cp(fileURLToPath(new URL("../../../ops/sandbox", import.meta.url)), join(src, "ops", "sandbox"), { recursive: true });
    const inst = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const { serializeLock } = await import("../src/lock.js");
    await writeFile(join(inst, "metistry.lock"), serializeLock({ product: { version: "0.3.0", commit: "unknown", source: "release" }, updated_at: "2026-09-01T00:00:00.000Z", migrations_applied: [] }));
    // a release install: `current` -> releases/0.3.0, and the install root holds
    // `.env` and (once fetched) `runtime/`
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    await mkdir(join(P, "releases"), { recursive: true });
    await cp(src, join(P, "releases", "0.3.0"), { recursive: true });
    await writeFile(join(P, ".env"), "");
    const { symlink } = await import("node:fs/promises");
    await symlink(join("releases", "0.3.0"), join(P, "current"));

    const exec = tarExec(RUNTIME_TREE);
    const { fn } = depsServer({ version: "0.3.0" });
    const lines: string[] = [];
    const res = await up({
      productDir: P,
      env: { METISTRY_INSTANCE_DIR: inst, METISTRY_DB_PASSWORD: "pw", METISTRY_ORIGIN: "https://x.test", METISTRY_ASSISTANT_TOKEN: "t", HOME, TMPDIR: "/tmp" },
      exec,
      out: (l) => lines.push(l),
      platform: "darwin",
      uid: 501,
      home: HOME,
      node: "/usr/bin/node",
      deployment: { shape: "launchd", services: {} },
      exists: onlyUnder(P),
      fetchFn: fn,
      target: TARGET,
      doctorFn: okDoctor,
    });

    expect(res.source).toBe("release");
    expect(res.code).toBe(0);
    expect(lines.join("\n")).toContain("no Postgres found — fetching the bundled runtime");
    expect(res.commands.some((c) => c.includes("tar -xzf") && c.includes(`-C ${P}`))).toBe(true);
    // initdb came from the bundled tree, not from Homebrew
    expect(res.commands.some((c) => c.startsWith(join(P, RUNTIME_DIRNAME, "postgres", "bin", "initdb")))).toBe(true);

    // db and the reconciler are the supervisor's children now: what they run
    // is in its config, not in a plist each
    const config = JSON.parse(await readFile(join(inst, "state", "supervisor.json"), "utf8"));
    const child = (name: string) => config.children.find((c: { name: string }) => c.name === name);
    expect(child("db").argv[0]).toBe(`${join(P, RUNTIME_DIRNAME, "postgres", "bin")}/postgres`);
    expect(child("reconciler").env.PATH).toBe(`${join(P, RUNTIME_DIRNAME, "git", "bin")}:${LAUNCHD_BASE_PATH}`);
    // only the job that spawns git gets it — the console keeps launchd's own
    expect(child("console").env.PATH).toBe(LAUNCHD_BASE_PATH);
  });

  it("a checkout never downloads a runtime — `brew install` stays the remediation", async () => {
    const { checkout, okDoctor } = await import("./fixtures.js");
    const { up } = await import("../src/up.js");
    const P = await checkout();
    const HOME = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const lines: string[] = [];
    const res = await up({
      productDir: P,
      env: { METISTRY_DB_PASSWORD: "pw", HOME, TMPDIR: "/tmp" },
      exec: tarExec(RUNTIME_TREE),
      out: (l) => lines.push(l),
      platform: "darwin",
      uid: 501,
      home: HOME,
      node: "/usr/bin/node",
      deployment: { shape: "launchd", services: {} },
      exists: () => false,
      fetchFn: (() => {
        throw new Error("a checkout must not reach the network for a runtime");
      }) as unknown as typeof fetch,
      doctorFn: okDoctor,
    });
    expect(res.code).toBe(1);
    expect(lines.join("\n")).toContain("brew install postgresql@17 pgvector");
  });
});

describe("metistry update --channel release", () => {
  it("installs the deps pack alongside the runtime pack, and says so when the release has none", async () => {
    const { checkout, okDoctor } = await import("./fixtures.js");
    const { update } = await import("../src/update.js");
    const { cp } = await import("node:fs/promises");
    const src = await checkout();
    const P = await mkdtemp(join(tmpdir(), "metistry-rel-"));
    const inst = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const { serializeLock } = await import("../src/lock.js");
    await writeFile(join(inst, "metistry.lock"), serializeLock({ product: { version: "0.2.0", commit: "unknown", source: "release" }, updated_at: "2026-09-01T00:00:00.000Z", migrations_applied: [] }));

    // the release's runtime pack unpacks a product tree; its deps pack unpacks runtime/
    const exec = fakeExec({
      tar: async (args) => {
        const dest = args[args.indexOf("-C") + 1]!;
        if (args.some((a) => a.includes("runtime-deps"))) {
          for (const [rel, body] of Object.entries(RUNTIME_TREE)) {
            await mkdir(join(dest, rel, ".."), { recursive: true });
            await writeFile(join(dest, rel), body);
          }
          return;
        }
        await cp(src, dest, { recursive: true });
      },
    });

    // one release carrying BOTH assets
    const packBytes = Buffer.from("the product\n");
    const depsBytes = Buffer.from("the runtime\n");
    const { runtimeAssetName } = await import("../src/release.js");
    const pack = runtimeAssetName("0.3.0", TARGET);
    const deps = runtimeDepsAssetName("0.3.0", TARGET);
    const fn = (async (u: string | URL) => {
      const url = String(u);
      if (url.includes("/releases/")) {
        return new Response(
          JSON.stringify({
            tag_name: "v0.3.0",
            assets: [
              { name: pack, browser_download_url: `https://x.test/${pack}` },
              { name: deps, browser_download_url: `https://x.test/${deps}` },
              { name: CHECKSUMS_ASSET, browser_download_url: "https://x.test/sums" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://x.test/sums") return new Response(`${sha256(packBytes)}  ${pack}\n${sha256(depsBytes)}  ${deps}\n`);
      if (url.endsWith(pack)) return new Response(new Uint8Array(packBytes));
      if (url.endsWith(deps)) return new Response(new Uint8Array(depsBytes));
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;

    const r = await update({
      productDir: P,
      env: { METISTRY_INSTANCE_DIR: inst },
      exec,
      out: () => {},
      platform: "darwin",
      uid: 501,
      version: "0.0.9",
      now: new Date("2026-09-09T00:00:00Z"),
      fetchFn: fn,
      target: TARGET,
      skipMigrate: true,
      channel: "release",
      openSession: async () => null,
      doctorFn: okDoctor,
    });

    expect(r.release).toMatchObject({ version: "0.3.0", installed: true });
    expect(r.runtimeDeps).toMatchObject({ version: "0.3.0", installed: true });
    // the deps pack lands beside `releases/`, not inside the release — a version
    // flip must not orphan the runtime the plists point at
    expect(existsSync(join(P, RUNTIME_DIRNAME, "postgres", "bin", "postgres"))).toBe(true);
    expect(await installedRuntimeVersion(P)).toBe("0.3.0");
  });

  it("a dry run reaches nothing and says the deps pack would be fetched", async () => {
    const { checkout, okDoctor } = await import("./fixtures.js");
    const { update } = await import("../src/update.js");
    const P = await checkout();
    const lines: string[] = [];
    await update({
      productDir: P,
      env: {},
      exec: fakeExec(),
      out: (l) => lines.push(l),
      dryRun: true,
      platform: "darwin",
      uid: 501,
      channel: "release",
      target: TARGET,
      doctorFn: okDoctor,
      openSession: async () => null,
    });
    expect(lines.join("\n")).toContain(`metistry-runtime-deps-<latest>-${TARGET}.tar.gz`);
    expect(lines.join("\n")).toContain(`${RUNTIME_DIRNAME}/`);
  });
});
