// T4-5 (plan §2.7): the kinds that load through a registry, the overlay rule
// for code-backed kinds, product code by name, what the extensions directory
// holds — and the closed list: an extension names values from Metistry's
// vocabularies and can never add one.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  REGISTRY_KINDS,
  buildRegistry,
  describeExtensions,
  extensionsDirFor,
  extensionsDirFromEnv,
  joinCode,
  kindHome,
  kindSources,
  loadKind,
  manifestKind,
  unitCode,
  type UnitCandidate,
} from "../src/registry.js";
import { ACTION_KINDS } from "../src/actions.js";
import { CONNECTION_CAPABILITIES, FIELD_KINDS } from "../src/connections.js";
import { validateManifest } from "../src/manifest.js";

const collector = (name: string, extra: Record<string, unknown> = {}) => ({ schema: 1, name, type: "collector", schedule: "@hourly", writes: ["work"], ...extra });
const at = (origin: "product" | "extension", input: { name: string }): UnitCandidate => ({
  path: `${origin === "product" ? "collectors" : ".metistry/extensions"}/${input.name}/manifest.yaml`,
  origin,
  dirName: input.name,
  input,
});

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function unit(dir: string, name: string, text: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "manifest.yaml"), text);
}

describe("REGISTRY_KINDS — the kinds §2.7 moves onto registries", () => {
  it("is collectors, routines, targets, provider templates and connection types — a closed list of kinds, not of units", () => {
    expect(Object.keys(REGISTRY_KINDS).sort()).toEqual(["collector", "connection-type", "provider", "routine", "target"]);
    expect(Object.isFrozen(REGISTRY_KINDS)).toBe(true);
    // code-backed kinds take an extension's manifest, never its code
    expect(REGISTRY_KINDS.collector.extension).toBe("overlay");
    expect(REGISTRY_KINDS.routine.extension).toBe("overlay");
    for (const k of ["target", "provider", "connection-type"] as const) expect(REGISTRY_KINDS[k].extension).toBe("unit");
  });

  it("finds each kind's product directory under the checkout or its seed, and lists the owner's sources after it", () => {
    expect(kindHome("collector", { productDir: "/p" })).toBe("/p/collectors");
    expect(kindHome("provider", { productDir: "/p" })).toBe("/p/seed/compute-templates");
    expect(kindHome("provider", { seedDir: "/cli/seed" })).toBe("/cli/seed/compute-templates"); // the published CLI, no checkout
    expect(kindHome("connection-type", { productDir: "/p", seedDir: "/s" })).toBe("/s/connection-types");
    expect(kindHome("collector", { seedDir: "/s" })).toBeUndefined();
    expect(kindHome("collector", { productDir: "/p", home: "collectors" })).toBe("collectors"); // the console's METISTRY_COLLECTORS_DIR
    expect(kindSources("target", { productDir: "/p", overlays: ["/i/.metistry/targets"], extensionsDir: "/i/.metistry/extensions" })).toEqual([
      { dir: "/p/targets", origin: "product" },
      { dir: "/i/.metistry/targets", origin: "extension" },
      { dir: "/i/.metistry/extensions", origin: "extension" },
    ]);
  });

  it("reads the extensions directory from METISTRY_INSTANCE_DIR, and none without it", () => {
    expect(extensionsDirFromEnv({ METISTRY_INSTANCE_DIR: "/home/me/instance/" })).toBe(extensionsDirFor("/home/me/instance"));
    expect(extensionsDirFor("/home/me/instance")).toBe("/home/me/instance/.metistry/extensions");
    expect(extensionsDirFromEnv({})).toBeUndefined();
    expect(extensionsDirFromEnv({ METISTRY_INSTANCE_DIR: "  " })).toBeUndefined();
  });
});

describe("the overlay rule — code from an extension never runs in the console", () => {
  const collectors = manifestKind("collector");

  it("an extension with a product collector's name replaces its manifest", () => {
    const reg = buildRegistry(collectors, [at("product", collector("github-state")), at("extension", collector("github-state", { schedule: "@daily" }))]);
    expect(reg.get("github-state")).toMatchObject({ origin: "extension", manifest: { schedule: "@daily" }, replaced: { origin: "product" } });
    expect(reg.skipped).toEqual([]);
  });

  it("an extension collector naming no product collector is skipped with the reason — it has no code to run", () => {
    const reg = buildRegistry(collectors, [at("product", collector("github-state")), at("extension", collector("my-scraper"))]);
    expect(reg.names()).toEqual(["github-state"]);
    expect(reg.skipped).toEqual([
      {
        path: ".metistry/extensions/my-scraper/manifest.yaml",
        origin: "extension",
        name: "my-scraper",
        reason: 'no product collector is named "my-scraper" — a collector is product code, and code from an extension runs only as a process (plan §5), which this Metistry does not load; an extension may only replace a product collector\'s manifest',
      },
    ]);
  });

  it("a data kind takes a new unit from an extension", () => {
    const target = { schema: 1, name: "mine", type: "target", transport: "local", submit: {}, result: { via: "report_queue" }, data_policy: { allow: [], deny_sources: [], max_brief_bytes: 1 } };
    expect(buildRegistry(manifestKind("target"), [{ path: "x/mine/manifest.yaml", origin: "extension", dirName: "mine", input: target }]).names()).toEqual(["mine"]);
  });

  it("joinCode asks for code by NAME: an overlay runs the product's code under the extension's manifest; a unit with no code is skipped", async () => {
    const reg = buildRegistry(collectors, [at("product", collector("a")), at("product", collector("b")), at("extension", collector("a", { schedule: "@daily" }))]);
    const productRun = async () => 7;
    const asked: string[] = [];
    const { units, skipped } = await joinCode(reg, async (name) => {
      asked.push(name);
      return name === "a" ? productRun : { missing: `no product code for "${name}"` };
    });
    expect(asked).toEqual(["a", "b"]);
    expect(units.map((u) => [u.name, u.origin, u.manifest.schedule])).toEqual([["a", "extension", "@daily"]]);
    expect(units[0]?.run).toBe(productRun);
    expect(skipped).toEqual([{ path: "collectors/b/manifest.yaml", origin: "product", name: "b", reason: 'no product code for "b"' }]);
  });
});

describe("unitCode — the product's run(), found by name in the package's own tree", () => {
  it("imports <base>/<name>/run.js and returns its run; refuses a missing module, a module without run, and a name that is not one", async () => {
    root = await mkdtemp(join(tmpdir(), "metistry-unitcode-"));
    await mkdir(join(root, "good"), { recursive: true });
    await writeFile(join(root, "good", "run.js"), "export async function run() { return 42; }\n");
    await mkdir(join(root, "norun"), { recursive: true });
    await writeFile(join(root, "norun", "run.js"), "export const other = 1;\n");
    const base = pathToFileURL(`${root}/`);
    const good = await unitCode<() => Promise<number>>(base, "good");
    expect(typeof good).toBe("function");
    expect(await (good as () => Promise<number>)()).toBe(42);
    expect(await unitCode(base, "norun")).toEqual({ missing: expect.stringContaining("exports no run()") });
    expect(await unitCode(base, "absent")).toEqual({ missing: expect.stringContaining('no product code for "absent"') });
    // a name is the only input, and it cannot climb out of the base
    for (const name of ["../good", "good/../../x", "Good", "/etc/passwd", ""]) expect(await unitCode(base, name)).toEqual({ missing: `"${name}" is not a unit name` });
  });
});

describe("describeExtensions — what `metistry extensions list` reports", () => {
  it("says of every extension whether it is in force, an overlay, skipped or unclaimed — and why", async () => {
    root = await mkdtemp(join(tmpdir(), "metistry-extensions-"));
    const product = join(root, "product");
    const ext = join(root, "instance", ".metistry", "extensions");
    await unit(join(product, "collectors"), "github-state", "schema: 1\nname: github-state\ntype: collector\nschedule: '@hourly'\nwrites: [work]\n");
    await unit(join(product, "seed", "compute-templates"), "ollama", "schema: 1\nname: ollama\ntype: provider\nprovider: { kind: openai-compatible, base_url: 'http://127.0.0.1:11434/v1', locality: on_machine }\n");
    await unit(ext, "github-state", "schema: 1\nname: github-state\ntype: collector\nschedule: '@daily'\nwrites: [work]\n");
    await unit(ext, "vllm", "schema: 1\nname: vllm\ntype: provider\nprovider: { kind: openai-compatible, base_url: 'http://10.0.0.2:8000/v1', locality: on_machine }\n");
    await unit(ext, "old", "name: old\ntype: provider\nprovider: { kind: openai-compatible, base_url: 'http://10.0.0.2:8000/v1', locality: on_machine }\n");
    await unit(ext, "scraper", "schema: 1\nname: scraper\ntype: collector\nschedule: '@hourly'\nwrites: [work]\n");
    await unit(ext, "helper", "schema: 1\nname: helper\ntype: bridge\ntransport: stdio\nruns_on: host\nexposes: [{ name: x }]\n");
    await unit(ext, "broken", "schema: 1\nname: [\n");

    const entries = await describeExtensions({ productDir: product, extensionsDir: ext });
    const by = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(entries.map((e) => e.name)).toEqual(["broken", "github-state", "helper", "old", "scraper", "vllm"]);
    expect(by["github-state"]).toMatchObject({ type: "collector", status: "overlay", replaced: join(product, "collectors", "github-state", "manifest.yaml") });
    expect(by.vllm).toMatchObject({ type: "provider", status: "loaded" });
    expect(by.old).toMatchObject({ status: "skipped", reason: "schema: missing — every manifest carries schema: 1" });
    expect(by.scraper).toMatchObject({ status: "skipped", reason: expect.stringContaining('no product collector is named "scraper"') });
    expect(by.helper).toMatchObject({ type: "bridge", status: "unclaimed", reason: expect.stringContaining("a bridge is code") });
    expect(by.broken).toMatchObject({ status: "skipped", reason: expect.stringMatching(/^unreadable: not YAML/) });
  });
});

// The ticket's bold test (T4-5): the closed list of §2.7 holds against
// extensions. Each of these is an extension that tries to add a value to a
// vocabulary Metistry keeps closed; each is skipped or unclaimed with the
// reason, nothing of it loads, and the vocabularies are what they were.
describe("an extension cannot add an action kind, a capability, a TCC grant or a field kind", () => {
  const snapshot = () => JSON.stringify({ actions: [...ACTION_KINDS], capabilities: CONNECTION_CAPABILITIES, fields: [...FIELD_KINDS] });

  it("every such unit is refused by the registry that would load it, and every vocabulary is unchanged", async () => {
    const before = snapshot();
    root = await mkdtemp(join(tmpdir(), "metistry-closed-"));
    const product = join(root, "product");
    const ext = join(root, "instance", ".metistry", "extensions");
    await mkdir(product, { recursive: true });
    const ct = (name: string, rest: string) => `schema: 1\nname: ${name}\ntype: connection-type\n${rest}`;
    // an action kind: there is no kind of unit that declares one
    await unit(ext, "nudge", "schema: 1\nname: nudge\ntype: action-kind\nlevel: allow\n");
    // …nor one a target could smuggle in: a target's keys are its schema's, nothing else survives
    await unit(ext, "sneaky-target", "schema: 1\nname: sneaky-target\ntype: target\ntransport: local\nsubmit: {}\nresult: { via: report_queue }\ndata_policy: { allow: [], deny_sources: [], max_brief_bytes: 1 }\nactions: { nudge: allow }\n");
    // a capability: an unknown one, and the one refused by name
    await unit(ext, "teleport-cal", ct("teleport-cal", "provides: calendar\ntransports: [http]\ncapabilities: [read, teleport]\nimplementation: { kind: bridge, bridge: eventkit }\n"));
    await unit(ext, "sending-mail", ct("sending-mail", "provides: mail\ntransports: [http]\ncapabilities: [read, send]\nimplementation: { kind: bridge, bridge: mailer }\n"));
    // a field kind
    await unit(ext, "pw-feed", ct("pw-feed", "provides: feed\ntransports: [http]\nfields: [{ key: pass, kind: password, label: Password }]\n"));
    // a TCC grant: a bridge is code, so no extension declares one at all — and the grant vocabulary refuses an unknown one regardless
    await unit(ext, "camera-bridge", "schema: 1\nname: camera-bridge\ntype: bridge\ntransport: http\nport: 7899\nruns_on: host\nrequires_tcc: [camera]\nexposes: [{ name: snap }]\n");
    await unit(ext, "tcc-collector", "schema: 1\nname: tcc-collector\ntype: collector\nschedule: '@hourly'\nwrites: [work]\nrequires_tcc: [camera]\n");

    const entries = Object.fromEntries((await describeExtensions({ productDir: product, extensionsDir: ext })).map((e) => [e.name, e]));
    expect(entries.nudge).toMatchObject({ status: "unclaimed", reason: expect.stringContaining('"action-kind" is not a kind of unit an extension may declare') });
    expect(entries["teleport-cal"]).toMatchObject({ status: "skipped", reason: expect.stringContaining('unknown calendar capability "teleport"') });
    expect(entries["sending-mail"]).toMatchObject({ status: "skipped", reason: expect.stringContaining("mail: send is refused") });
    expect(entries["pw-feed"]).toMatchObject({ status: "skipped", reason: expect.stringContaining("fields.0.kind") });
    expect(entries["camera-bridge"]).toMatchObject({ status: "unclaimed", reason: expect.stringContaining("a bridge is code") });
    expect(entries["tcc-collector"]).toMatchObject({ status: "skipped" }); // a collector names a product one or nothing
    expect(validateManifest({ name: "camera-bridge", type: "bridge", transport: "http", port: 7899, runs_on: "host", requires_tcc: ["camera"], exposes: [{ name: "snap" }] }).ok).toBe(false);

    // the target loads — and carries nothing it could not declare
    const targets = await loadKind("target", { productDir: product, extensionsDir: ext });
    expect(targets.get("sneaky-target")?.manifest).not.toHaveProperty("actions");
    // nothing else of any of them is in force, in any registry
    for (const kind of Object.keys(REGISTRY_KINDS) as (keyof typeof REGISTRY_KINDS)[]) {
      const names = (await loadKind(kind, { productDir: product, extensionsDir: ext })).names();
      expect(names.filter((n) => n !== "sneaky-target"), kind).toEqual([]);
    }
    expect(snapshot()).toBe(before);
  });
});

describe("a unit loads only from the tree it is in", () => {
  it("a data extension carries no code: an executable beside a manifest changes nothing the registry loads", async () => {
    root = await mkdtemp(join(tmpdir(), "metistry-exec-"));
    const ext = join(root, ".metistry", "extensions");
    await unit(ext, "vllm", "schema: 1\nname: vllm\ntype: provider\nprovider: { kind: openai-compatible, base_url: 'http://10.0.0.2:8000/v1', locality: on_machine }\n");
    await writeFile(join(ext, "vllm", "run.js"), "throw new Error('never imported');\n");
    await chmod(join(ext, "vllm", "run.js"), 0o755);
    const reg = await loadKind("provider", { extensionsDir: ext });
    expect(reg.names()).toEqual(["vllm"]); // the manifest is data; nothing in the directory is executed by loading it
  });
});
