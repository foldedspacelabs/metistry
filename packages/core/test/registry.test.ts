// Registry<Kind> (§2.7): overlay by name, skip with a reason, schema: 1.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRegistry, loadRegistry, manifestKind, type UnitCandidate } from "../src/registry.js";

const connectionTypes = manifestKind("connection-type");

const feed = (name: string, extra: Record<string, unknown> = {}) => ({
  schema: 1,
  name,
  type: "connection-type",
  provides: "feed",
  transports: ["http"],
  fields: [{ key: "url", kind: "url", label: "Feed address" }],
  ...extra,
});

const product = (input: unknown, dir?: string): UnitCandidate => ({
  path: `seed/connection-types/${dir ?? (input as { name: string }).name}/manifest.yaml`,
  origin: "product",
  dirName: dir ?? (input as { name: string }).name,
  input,
});
const extension = (input: unknown, dir?: string): UnitCandidate => ({
  path: `.metistry/extensions/${dir ?? (input as { name: string }).name}/manifest.yaml`,
  origin: "extension",
  dirName: dir ?? (input as { name: string }).name,
  input,
});

describe("Registry — overlay by name (D4)", () => {
  it("an extension with a product unit's name wins, and records what it replaced", () => {
    const reg = buildRegistry(connectionTypes, [
      extension(feed("rss", { description: "mine" })), // order does not matter: origin decides
      product(feed("rss", { description: "shipped" })),
      product(feed("atom")),
    ]);
    expect(reg.names()).toEqual(["atom", "rss"]);
    const rss = reg.get("rss");
    expect(rss?.origin).toBe("extension");
    expect(rss?.manifest.description).toBe("mine");
    expect(rss?.replaced).toEqual({ origin: "product", path: "seed/connection-types/rss/manifest.yaml" });
    expect(reg.overlaid().map((u) => u.name)).toEqual(["rss"]);
    expect(reg.get("atom")?.replaced).toBeUndefined();
    expect(reg.skipped).toEqual([]);
  });

  it("two units of the same origin with one name are ambiguous: the second is skipped, not silently ordered", () => {
    // two product trees (say seed/ and packages/) that both ship "rss"
    const dup = buildRegistry(connectionTypes, [product(feed("rss")), { ...product(feed("rss")), path: "elsewhere/rss/manifest.yaml" }]);
    expect(dup.get("rss")?.path).toBe("seed/connection-types/rss/manifest.yaml");
    expect(dup.skipped).toEqual([
      { path: "elsewhere/rss/manifest.yaml", origin: "product", name: "rss", reason: 'duplicate product connection-type "rss" — already defined by seed/connection-types/rss/manifest.yaml' },
    ]);
  });
});

describe("Registry — skip with a reason, never fatal", () => {
  it("skips an invalid manifest with its reason, and loads every other unit", () => {
    const reg = buildRegistry(connectionTypes, [
      product(feed("atom")),
      extension(feed("broken", { capabilities: ["read"] })),
      extension(feed("rss")),
    ]);
    expect(reg.names()).toEqual(["atom", "rss"]);
    expect(reg.skipped).toHaveLength(1);
    expect(reg.skipped[0]).toMatchObject({ path: ".metistry/extensions/broken/manifest.yaml", origin: "extension" });
    expect(reg.skipped[0]?.reason).toMatch(/^invalid manifest: capabilities\.0: feed connections have no capabilities/);
  });

  it("skips an unreadable manifest and a manifest named for another directory", () => {
    const reg = buildRegistry(connectionTypes, [
      { path: ".metistry/extensions/bad/manifest.yaml", origin: "extension", unreadable: "not YAML — bad indentation" },
      extension(feed("rss"), "feeds"),
    ]);
    expect(reg.names()).toEqual([]);
    expect(reg.skipped.map((s) => s.reason)).toEqual(["unreadable: not YAML — bad indentation", 'manifest name "rss" must match its directory "feeds"']);
  });

  it("passes over units of another kind — they belong to another registry", () => {
    const collector = { schema: 1, name: "github-state", type: "collector", schedule: "@hourly", writes: ["work"] };
    const reg = buildRegistry(connectionTypes, [extension(collector), extension("just a string", "str"), extension(null, "empty")]);
    expect(reg.names()).toEqual([]);
    expect(reg.skipped).toEqual([]);
    expect(buildRegistry(manifestKind("collector"), [product(collector)]).names()).toEqual(["github-state"]);
  });
});

describe("Registry — schema: 1", () => {
  it("skips a unit without a schema version, naming what is missing", () => {
    const { schema: _s, ...unversioned } = feed("rss");
    const reg = buildRegistry(connectionTypes, [extension(unversioned)]);
    expect(reg.has("rss")).toBe(false);
    expect(reg.skipped[0]?.reason).toBe("schema: missing — every manifest carries schema: 1");
  });

  it("skips an unknown major with the version named, and keeps the product unit it would have replaced", () => {
    const reg = buildRegistry(connectionTypes, [product(feed("rss")), extension(feed("rss", { schema: 2 }))]);
    expect(reg.get("rss")?.origin).toBe("product");
    expect(reg.skipped).toEqual([
      { path: ".metistry/extensions/rss/manifest.yaml", origin: "extension", reason: "schema: 2 is not a version this Metistry reads (it reads schema 1)" },
    ]);
  });

  it("requires the version of every kind it loads, including kinds whose schema predates it", () => {
    const routine = { name: "evening-review", type: "routine", schedule: "@daily" };
    const reg = buildRegistry(manifestKind("routine"), [product(routine), product({ ...routine, name: "weekly", schema: 1 })]);
    expect(reg.names()).toEqual(["weekly"]);
    expect(reg.skipped[0]?.reason).toMatch(/^schema: missing/);
  });
});

describe("loadRegistry — from directories", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function unit(dir: string, name: string, text: string) {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "manifest.yaml"), text);
  }

  it("reads <dir>/<unit>/manifest.yaml from product and extension sources, and overlays", async () => {
    root = await mkdtemp(join(tmpdir(), "metistry-registry-"));
    const seed = join(root, "seed", "connection-types");
    const ext = join(root, "instance", ".metistry", "extensions");
    const yaml = (name: string, description: string) =>
      `schema: 1\nname: ${name}\ntype: connection-type\nprovides: feed\ntransports: [http]\ndescription: ${description}\n`;
    await unit(seed, "rss", yaml("rss", "shipped"));
    await unit(seed, "atom", yaml("atom", "shipped"));
    await unit(ext, "rss", yaml("rss", "mine"));
    await unit(ext, "broken", "schema: 1\nname: broken\ntype: connection-type\n  provides: [feed\n");
    await unit(ext, "sweep", "schema: 1\nname: sweep\ntype: routine\nschedule: '@daily'\n");
    await mkdir(join(ext, "notes")); // a directory without a manifest is not a unit

    const reg = await loadRegistry(connectionTypes, [
      { dir: seed, origin: "product" },
      { dir: ext, origin: "extension" },
      { dir: join(root, "missing"), origin: "extension" }, // optional overlay directory
    ]);
    expect(reg.names()).toEqual(["atom", "rss"]);
    expect(reg.get("rss")?.manifest.description).toBe("mine");
    expect(reg.get("rss")?.replaced?.path).toBe(join(seed, "rss", "manifest.yaml"));
    expect(reg.skipped).toHaveLength(1);
    expect(reg.skipped[0]?.path).toBe(join(ext, "broken", "manifest.yaml"));
    expect(reg.skipped[0]?.reason).toMatch(/^unreadable: not YAML/);
  });

  it("does not require the directory name when a product tree prefixes it", async () => {
    root = await mkdtemp(join(tmpdir(), "metistry-registry-"));
    const packages = join(root, "packages");
    await unit(packages, "mcp-feeds", "schema: 1\nname: feeds\ntype: connection-type\nprovides: feed\ntransports: [http]\n");
    const strict = await loadRegistry(connectionTypes, [{ dir: packages, origin: "product" }]);
    expect(strict.skipped[0]?.reason).toBe('manifest name "feeds" must match its directory "mcp-feeds"');
    const prefixed = await loadRegistry(connectionTypes, [{ dir: packages, origin: "product", dirNameIsName: false }]);
    expect(prefixed.names()).toEqual(["feeds"]);
  });
});
