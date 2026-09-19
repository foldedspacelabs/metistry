// `metistry --version` / `metistry version` — every version number an
// install can be asked about: this binary's own package.json (always),
// the resolved product dir's own package.json, metistry.lock's pin, and a
// release install's metistry-runtime.json.
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CURRENT_LINK, RUNTIME_PACK_MANIFEST } from "../src/release.js";
import { collectVersionInfo, renderVersionInfo } from "../src/version.js";
import { main } from "../src/main.js";

async function checkout(version = "0.4.0"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-version-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "metistry", version }));
  return dir;
}

async function instance(lock?: { version: string; commit: string; source: "git" | "release" }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-version-inst-"));
  if (lock) {
    await mkdir(join(dir, ".metistry"), { recursive: true });
  await writeFile(
      join(dir, ".metistry", "metistry.lock"),
      `product:\n  version: ${JSON.stringify(lock.version)}\n  commit: ${JSON.stringify(lock.commit)}\n  source: ${lock.source}\nupdated_at: "2026-09-09T00:00:00.000Z"\nmigrations_applied: []\n`,
    );
  }
  return dir;
}

describe("collectVersionInfo", () => {
  it("cli_version alone when neither a product dir nor an instance resolves", async () => {
    const info = await collectVersionInfo({});
    expect(info.cli_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.product_version).toBeUndefined();
    expect(info.lock).toBeUndefined();
    expect(info.runtime_pack).toBeUndefined();
  });

  it("product_version from the resolved product dir's own package.json (git mode: no lock needed)", async () => {
    const P = await checkout("9.9.9");
    const info = await collectVersionInfo({ productDir: P });
    expect(info.product_version).toBe("9.9.9");
    expect(info.lock).toBeUndefined();
    expect(info.runtime_pack).toBeUndefined();
  });

  it("the instance's metistry.lock: pinned version + channel", async () => {
    const P = await checkout("9.9.9");
    const I = await instance({ version: "9.9.8", commit: "deadbeef", source: "git" });
    const info = await collectVersionInfo({ productDir: P, instanceDir: I });
    expect(info.lock).toEqual({ version: "9.9.8", channel: "git" });
    expect(info.product_version).toBe("9.9.9"); // git mode: the checkout itself, not `current`
  });

  it("release mode: product_version and runtime_pack both come from current/, not the product dir root", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-version-release-"));
    await writeFile(join(P, "package.json"), JSON.stringify({ name: "metistry", version: "0.0.0-do-not-use" }));
    await mkdir(join(P, "releases", "0.5.0"), { recursive: true });
    await writeFile(join(P, "releases", "0.5.0", "package.json"), JSON.stringify({ name: "metistry", version: "0.5.0" }));
    await writeFile(join(P, "releases", "0.5.0", RUNTIME_PACK_MANIFEST), JSON.stringify({ version: "0.5.0", commit: "91ca417c", built_at: "2026-09-10T02:41:56Z" }));
    await symlink(join("releases", "0.5.0"), join(P, CURRENT_LINK));
    const I = await instance({ version: "0.5.0", commit: "91ca417c", source: "release" });

    const info = await collectVersionInfo({ productDir: P, instanceDir: I });
    expect(info.lock).toEqual({ version: "0.5.0", channel: "release" });
    expect(info.product_version).toBe("0.5.0");
    expect(info.runtime_pack).toEqual({ version: "0.5.0", commit: "91ca417c", built_at: "2026-09-10T02:41:56Z" });
  });

  it("a release pack built before metistry-runtime.json shipped: omitted, never fabricated", async () => {
    const P = await mkdtemp(join(tmpdir(), "metistry-version-release-old-"));
    await mkdir(join(P, "releases", "0.3.0"), { recursive: true });
    await writeFile(join(P, "releases", "0.3.0", "package.json"), JSON.stringify({ name: "metistry", version: "0.3.0" }));
    await symlink(join("releases", "0.3.0"), join(P, CURRENT_LINK));
    const I = await instance({ version: "0.3.0", commit: "unknown", source: "release" });
    const info = await collectVersionInfo({ productDir: P, instanceDir: I });
    expect(info.product_version).toBe("0.3.0");
    expect(info.runtime_pack).toBeUndefined();
  });
});

describe("renderVersionInfo", () => {
  it("one line per number that resolved", () => {
    const text = renderVersionInfo({
      cli_version: "0.4.0",
      product_version: "0.4.0",
      lock: { version: "0.4.0", channel: "release" },
      runtime_pack: { version: "0.4.0", commit: "91ca417cabcdef", built_at: "2026-09-10T02:41:56Z" },
    });
    // aligned into two columns, keys dimmed (plain here: the suite's stdout is not a terminal)
    expect(text.split("\n")).toEqual([
      "cli           0.4.0",
      "product       0.4.0",
      "lock          0.4.0 (release)",
      "runtime pack  0.4.0 (commit 91ca417, built 2026-09-10T02:41:56Z)",
    ]);
  });

  it("just the cli line when nothing else resolved", () => {
    expect(renderVersionInfo({ cli_version: "0.4.0" })).toBe("cli  0.4.0");
  });
});

describe("metistry --version / metistry version", () => {
  beforeEach(() => {
    delete process.env.METISTRY_INSTANCE_DIR;
  });

  it("--version (no subcommand) prints the plain lines", async () => {
    const out: string[] = [];
    const code = await main(["--version", "--product-dir", await checkout("1.2.3")], { out: (l) => out.push(l) });
    expect(code).toBe(0);
    expect(out.join("\n")).toBe(`cli      ${(await collectVersionInfo({})).cli_version}\nproduct  1.2.3`);
  });

  it("version --json prints one object", async () => {
    const out: string[] = [];
    const code = await main(["version", "--json", "--product-dir", await checkout("1.2.3")], { out: (l) => out.push(l) });
    expect(code).toBe(0);
    const info = JSON.parse(out.join("\n"));
    expect(info.product_version).toBe("1.2.3");
    expect(typeof info.cli_version).toBe("string");
  });
});
