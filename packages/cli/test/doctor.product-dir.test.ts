// X-101: a bare `metistry doctor` resolves the product directory it RUNS
// FROM — the release install's — not whichever development checkout sits
// beside or around it. Every case stands the two side by side in a temp
// directory; nothing here touches a real install or the real checkout.
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeProduct, doctor, renderTable, walkManifests } from "../src/doctor.js";
import { releaseRootAbove, resolveProductDir } from "../src/env.js";
import { main } from "../src/main.js";

/** A directory shaped like a checkout (and like an unpacked release): `seed/identity.yaml` plus a root package.json named "metistry". */
async function productTree(dir: string, version: string, component: string): Promise<string> {
  await mkdir(join(dir, "seed"), { recursive: true });
  await writeFile(join(dir, "seed", "identity.yaml"), "assistant: { name: Assistant }\n");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "metistry", version }));
  await mkdir(join(dir, "packages", "cli", "dist"), { recursive: true });
  await mkdir(join(dir, "collectors", component), { recursive: true });
  await writeFile(
    join(dir, "collectors", component, "manifest.yaml"),
    `schema: 1\nname: ${component}\ntype: collector\ndisplay_name: ${component}\ndescription: a collector named for the tree it ships in\nschedule: { every: 5m }\nwrites: [inbox]\nreads: [inbox]\n`,
  );
  return dir;
}

/** `<root>/releases/<version>` unpacked and `<root>/current` pointing at it. */
async function releaseInstall(root: string, version: string): Promise<string> {
  const dir = await productTree(join(root, "releases", version), version, "from-the-release");
  await symlink(join("releases", version), join(root, "current"));
  return dir;
}

const noNetwork = (async () => {
  throw new Error("no network in this test");
}) as unknown as typeof fetch;
const deps = { env: {}, fetchFn: noNetwork, db: null, exec: async () => ({ code: 127, stdout: "", stderr: "" }), platform: "linux" as const };

describe("resolveProductDir beside a development checkout (X-101)", () => {
  it("an installed CLI with the current directory in a checkout resolves the install, not the checkout", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "metistry-x101-")));
    const checkout = await productTree(join(base, "dev-checkout"), "9.9.9", "from-the-checkout");
    const install = join(base, "install");
    const release = await releaseInstall(install, "0.5.0");
    const cliPackage = join(release, "packages", "cli");

    expect(resolveProductDir(undefined, {}, checkout, cliPackage)).toBe(install);
    // the same through `current`, the path the shim execs
    expect(resolveProductDir(undefined, {}, checkout, join(install, "current", "packages", "cli"))).toBe(install);
  });

  it("an install unpacked INSIDE a development checkout is still the install", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "metistry-x101-")));
    const checkout = await productTree(join(base, "dev-checkout"), "9.9.9", "from-the-checkout");
    const install = join(checkout, "runtime-install");
    const release = await releaseInstall(install, "0.5.0");

    expect(resolveProductDir(undefined, {}, checkout, join(release, "packages", "cli"))).toBe(install);
  });

  it("the flag and the environment still win over where the CLI runs from", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "metistry-x101-")));
    const release = await releaseInstall(join(base, "install"), "0.5.0");
    const from = join(release, "packages", "cli");
    expect(resolveProductDir("/explicit", { METISTRY_PRODUCT_DIR: "/elsewhere" }, "/", from)).toBe("/explicit");
    expect(resolveProductDir(undefined, { METISTRY_PRODUCT_DIR: "/elsewhere" }, "/", from)).toBe("/elsewhere");
  });

  it("a workspace CLI (no releases/ around it) still resolves the checkout it sits in", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "metistry-x101-")));
    const checkout = await productTree(join(base, "dev-checkout"), "9.9.9", "from-the-checkout");
    expect(releaseRootAbove(join(checkout, "packages", "cli"))).toBeUndefined();
    expect(resolveProductDir(undefined, {}, base, join(checkout, "packages", "cli"))).toBe(checkout);
  });

  it("a releases/ directory with no current link is not an install: nothing is guessed", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "metistry-x101-")));
    const dir = await productTree(join(base, "install", "releases", "0.5.0"), "0.5.0", "from-the-release");
    expect(releaseRootAbove(join(dir, "packages", "cli"))).toBeUndefined();
  });
});

describe("doctor reads the release it runs from (X-101)", () => {
  it("doctor beside a checkout names the release's product dir, not the checkout's", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "metistry-x101-")));
    const checkout = await productTree(join(base, "dev-checkout"), "9.9.9", "from-the-checkout");
    const install = join(base, "install");
    const release = await releaseInstall(install, "0.5.0");

    // what a bare `metistry doctor` resolves, run from the checkout's directory
    const resolved = resolveProductDir(undefined, {}, checkout, join(release, "packages", "cli"));
    expect(resolved).toBe(install);

    const report = await doctor({ productDir: resolved!, ...deps });
    // it walked the release's manifests, and only those
    const names = report.rows.filter((r) => r.kind === "collector").map((r) => r.name);
    expect(names).toContain("from-the-release");
    expect(names).not.toContain("from-the-checkout");
    // and says so: the product dir it was asked for, the release it read, the version
    expect(report.product_dir).toBe(install);
    expect(report.product).toEqual({ kind: "release", version: "0.5.0", install_dir: install, read_dir: join(install, "current") });
    const table = renderTable(report);
    expect(table.split("\n")[0]).toContain(`${install} — release 0.5.0 (read from ${join(install, "current")}), shape`);
    expect(table).not.toContain("dev-checkout");
  });

  it("a checkout passed explicitly is read as a checkout, and says so", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "metistry-x101-")));
    const checkout = await productTree(join(base, "dev-checkout"), "9.9.9", "from-the-checkout");
    await releaseInstall(join(base, "install"), "0.5.0");

    const report = await doctor({ productDir: checkout, ...deps });
    expect(report.product).toEqual({ kind: "checkout", version: "9.9.9", read_dir: checkout });
    expect(report.rows.filter((r) => r.kind === "collector").map((r) => r.name)).toEqual(["from-the-checkout"]);
    expect(renderTable(report).split("\n")[0]).toContain(`${checkout} — checkout, shape`);
  });

  it("the directories `up` hands doctor (current, releases/<v>) are the release as it stands", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "metistry-x101-")));
    const install = join(base, "install");
    const release = await releaseInstall(install, "0.5.0");
    for (const dir of [join(install, "current"), release]) {
      const { product, readDir } = describeProduct(dir);
      expect(readDir, dir).toBe(dir);
      expect(product, dir).toEqual({ kind: "release", version: "0.5.0", install_dir: install, read_dir: dir });
    }
  });

  it("main --product-dir at an install root walks `current`; --json carries the same product", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "metistry-x101-")));
    const install = join(base, "install");
    await releaseInstall(install, "0.5.0");
    expect((await walkManifests(install)).length).toBe(0); // the root holds no manifests of its own: reading it as-is would see nothing

    const out: string[] = [];
    await main(["doctor", "--product-dir", install, "--json"], { out: (s) => out.push(s), doctorDeps: deps });
    const json = JSON.parse(out.join("\n"));
    expect(json.product).toEqual({ kind: "release", version: "0.5.0", install_dir: install, read_dir: join(install, "current") });
    expect(json.rows.map((r: { name: string }) => r.name)).toContain("from-the-release");
  });
});
