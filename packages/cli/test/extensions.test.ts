// `metistry extensions add | remove | list` (M15, plan §2.7).
//
// Misuse first. The door is the owner's hand onto what the product loads, so
// the failures that matter are the ones that would let something other than
// data in — a script, an executable, a link out of the tree, a nested tree —
// or let a unit in that its registry would refuse: a kind no registry takes,
// a value outside a closed vocabulary. Each is refused with the reason and
// NOTHING is written. Then the happy paths, direct and through the
// reconciler, where the write is the owner class's and the principal `user`.
import { chmod, cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACTION_KINDS, CONNECTION_CAPABILITIES, FIELD_KINDS } from "@foldedspacelabs/metistry-core";
import { MAX_EXTENSION_BYTES, extensionsAdd, extensionsList, extensionsRemove, parseExtensionVerb, renderExtensions, type ExtensionsOptions } from "../src/extensions.js";
import { computeTemplates } from "../src/compute.js";
import { main } from "../src/main.js";
import { OWNER_BRIDGE_TOKEN } from "../src/protected-write.js";

/** A product checkout of its own: the real seed's provider templates, and one collector. Never the real checkout (setup.ts). */
const PRODUCT = await mkdtemp(join(tmpdir(), "metistry-ext-product-"));
await cp(fileURLToPath(new URL("../../../seed", import.meta.url)), join(PRODUCT, "seed"), { recursive: true });
await mkdir(join(PRODUCT, "collectors", "github-state"), { recursive: true });
await writeFile(join(PRODUCT, "collectors", "github-state", "manifest.yaml"), "schema: 1\nname: github-state\ntype: collector\nschedule: '*/15 * * * *'\nwrites: [work]\n");

async function instance(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-ext-instance-"));
  await mkdir(join(dir, ".metistry", "state"), { recursive: true });
  return dir;
}

/** A source directory: `files` name → content. */
async function source(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-ext-source-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

/** No reconciler, linux: writes land directly in the temp instance. */
function opts(instanceDir: string, extra: Partial<ExtensionsOptions> = {}): { o: ExtensionsOptions; lines: string[] } {
  const lines: string[] = [];
  return { o: { instanceDir, productDir: PRODUCT, seedDir: join(PRODUCT, "seed"), env: {}, platform: "linux", uid: 501, out: (l) => lines.push(l), ...extra }, lines };
}

const VLLM = "schema: 1\nname: vllm-box\ntype: provider\ndescription: my vLLM box\nprovider:\n  kind: openai-compatible\n  base_url: http://10.0.0.9:8000/v1\n  locality: on_machine\n";
const ext = (dir: string, name: string) => join(dir, ".metistry", "extensions", name);

describe("extensions add — refuses anything that is not data, and writes nothing", () => {
  const refusals: Array<[string, () => Promise<string>, RegExp]> = [
    ["a script beside the manifest", () => source({ "manifest.yaml": VLLM, "run.js": "export const run = () => 1;\n" }), /run\.js is not data/],
    ["an executable, whatever its name", async () => {
      const dir = await source({ "manifest.yaml": VLLM, "notes.md": "#!/bin/sh\n" });
      await chmod(join(dir, "notes.md"), 0o755);
      return dir;
    }, /notes\.md is executable/],
    ["a symbolic link", async () => {
      const dir = await source({ "manifest.yaml": VLLM });
      await symlink("/etc/hosts", join(dir, "hosts.txt"));
      return dir;
    }, /hosts\.txt is a symbolic link/],
    ["a nested tree", () => source({ "manifest.yaml": VLLM, "lib/helper.yaml": "x: 1\n" }), /lib\/ is a directory/],
    ["bytes that are not UTF-8 text", async () => {
      const dir = await source({ "manifest.yaml": VLLM });
      await writeFile(join(dir, "blob.txt"), Buffer.from([0xff, 0xfe, 0x00, 0xc3]));
      return dir;
    }, /blob\.txt is not UTF-8/],
    ["more than a data unit's size", () => source({ "manifest.yaml": VLLM, "big.md": "x".repeat(MAX_EXTENSION_BYTES + 1) }), /is over \d+ bytes/],
    ["no manifest", () => source({ "README.md": "hello\n" }), /has no manifest\.yaml/],
    ["a manifest without schema: 1", () => source({ "manifest.yaml": VLLM.replace("schema: 1\n", "") }), /schema: missing — every manifest carries schema: 1/],
    ["an unknown major", () => source({ "manifest.yaml": VLLM.replace("schema: 1", "schema: 2") }), /schema: 2 is not a version this Metistry reads/],
    ["a manifest that fails its kind's schema", () => source({ "manifest.yaml": VLLM.replace("on_machine", "nearby") }), /invalid manifest: provider\.locality/],
    ["a name that is not a unit name", () => source({ "manifest.yaml": VLLM.replace("name: vllm-box", "name: ../escape") }), /is not a unit name/],
    ["a bridge — code, which an extension cannot carry", () => source({ "manifest.yaml": "schema: 1\nname: helper\ntype: bridge\ntransport: stdio\nruns_on: host\nexposes: [{ name: x }]\n" }), /a bridge is code/],
    ["a collector naming no product collector — it would have no code", () => source({ "manifest.yaml": "schema: 1\nname: scraper\ntype: collector\nschedule: '@hourly'\nwrites: [work]\n" }), /no product collector is named "scraper"/],
    ["a manifest with no type", () => source({ "manifest.yaml": "schema: 1\nname: mystery\n" }), /the manifest has no type/],
  ];
  for (const [what, make, why] of refusals) {
    it(`refuses ${what}`, async () => {
      const dir = await instance();
      const { o } = opts(dir);
      await expect(extensionsAdd({ ...o, source: await make() })).rejects.toThrow(why);
      expect(existsSync(join(dir, ".metistry", "extensions"))).toBe(false);
    });
  }

  it("refuses a second unit of one name: remove first, never a silent overwrite", async () => {
    const dir = await instance();
    const { o } = opts(dir);
    await extensionsAdd({ ...o, source: await source({ "manifest.yaml": VLLM }) });
    await expect(extensionsAdd({ ...o, source: await source({ "manifest.yaml": VLLM.replace("10.0.0.9", "10.0.0.8") }) })).rejects.toThrow(/already installed .* `metistry extensions remove vllm-box` first/);
    expect(await readFile(join(ext(dir, "vllm-box"), "manifest.yaml"), "utf8")).toContain("10.0.0.9");
  });

  it("refuses a collector overlay when there is no product checkout to find the collector in", async () => {
    const dir = await instance();
    const { o } = opts(dir, { productDir: undefined });
    await expect(extensionsAdd({ ...o, source: await source({ "manifest.yaml": "schema: 1\nname: github-state\ntype: collector\nschedule: '@daily'\nwrites: [work]\n" }) })).rejects.toThrow(/no product checkout/);
  });
});

// The ticket's bold test, at the door the owner actually uses.
describe("an extension cannot add an action kind, a capability, a TCC grant or a field kind", () => {
  const ct = (name: string, rest: string) => `schema: 1\nname: ${name}\ntype: connection-type\n${rest}`;
  const attempts: Array<[string, string, RegExp]> = [
    ["an action kind", "schema: 1\nname: nudge\ntype: action-kind\nlevel: allow\n", /"action-kind" is not a kind of unit an extension may declare/],
    ["a capability", ct("teleport-cal", "provides: calendar\ntransports: [http]\ncapabilities: [read, teleport]\nimplementation: { kind: bridge, bridge: eventkit }\n"), /unknown calendar capability "teleport"/],
    ["the capability refused by name", ct("sending-mail", "provides: mail\ntransports: [http]\ncapabilities: [read, send]\nimplementation: { kind: bridge, bridge: mailer }\n"), /mail: send is refused/],
    ["a TCC grant", "schema: 1\nname: camera\ntype: bridge\ntransport: http\nport: 7899\nruns_on: host\nrequires_tcc: [camera]\nexposes: [{ name: snap }]\n", /a bridge is code/],
    ["a field kind", ct("pw-feed", "provides: feed\ntransports: [http]\nfields: [{ key: pass, kind: password, label: Password }]\n"), /fields\.0\.kind/],
  ];
  for (const [what, manifest, why] of attempts) {
    it(`refuses ${what}, writes nothing, and the vocabulary is unchanged`, async () => {
      const before = JSON.stringify({ a: [...ACTION_KINDS], c: CONNECTION_CAPABILITIES, f: [...FIELD_KINDS] });
      const dir = await instance();
      const { o } = opts(dir);
      await expect(extensionsAdd({ ...o, source: await source({ "manifest.yaml": manifest }) })).rejects.toThrow(why);
      expect(existsSync(join(dir, ".metistry", "extensions"))).toBe(false);
      expect(JSON.stringify({ a: [...ACTION_KINDS], c: CONNECTION_CAPABILITIES, f: [...FIELD_KINDS] })).toBe(before);
    });
  }
});

describe("extensions add / list / remove — the happy paths", () => {
  it("adds a provider template the compute verbs then reach; hidden files are not copied", async () => {
    const dir = await instance();
    const { o } = opts(dir);
    const r = await extensionsAdd({ ...o, source: await source({ "manifest.yaml": VLLM, "README.md": "# my box\n", ".DS_Store": "junk" }) });
    expect(r).toMatchObject({ name: "vllm-box", kind: "provider", path: ".metistry/extensions/vllm-box", files: ["README.md", "manifest.yaml"], ignored: [".DS_Store"] });
    expect(r.replaced).toBeUndefined();
    expect(r.deliveries.every((d) => d.how === "direct")).toBe(true);
    expect(await readFile(join(ext(dir, "vllm-box"), "manifest.yaml"), "utf8")).toBe(VLLM);
    expect(existsSync(join(ext(dir, "vllm-box"), ".DS_Store"))).toBe(false);
    expect((await computeTemplates({ seedDir: join(PRODUCT, "seed"), instanceDir: dir })).get("vllm-box")?.origin).toBe("extension");
    const list = await extensionsList(o);
    expect(list.extensions).toEqual([expect.objectContaining({ name: "vllm-box", type: "provider", status: "loaded" })]);
    expect(renderExtensions(list)).toContain("vllm-box");
  });

  it("an overlay says what it replaces; removing it is Reset to Default", async () => {
    const dir = await instance();
    const { o } = opts(dir);
    const added = await extensionsAdd({ ...o, source: await source({ "manifest.yaml": "schema: 1\nname: github-state\ntype: collector\nschedule: '@daily'\nwrites: [work]\n" }) });
    expect(added.replaced).toBe(join(PRODUCT, "collectors", "github-state", "manifest.yaml"));
    expect((await extensionsList(o)).extensions).toEqual([expect.objectContaining({ name: "github-state", status: "overlay", replaced: added.replaced })]);
    const removed = await extensionsRemove({ ...o, name: "github-state" });
    expect(removed).toMatchObject({ name: "github-state", kind: "collector", files: ["manifest.yaml"], restored: added.replaced });
    expect(existsSync(ext(dir, "github-state"))).toBe(false);
    expect((await extensionsList(o)).extensions).toEqual([]);
  });

  it("list reports what it cannot load, with why — never fatal", async () => {
    const dir = await instance();
    await mkdir(ext(dir, "old"), { recursive: true });
    await writeFile(join(ext(dir, "old"), "manifest.yaml"), VLLM.replace("schema: 1\n", "").replace("vllm-box", "old"));
    await mkdir(ext(dir, "nudge"), { recursive: true });
    await writeFile(join(ext(dir, "nudge"), "manifest.yaml"), "schema: 1\nname: nudge\ntype: action-kind\n");
    const list = await extensionsList(opts(dir).o);
    expect(list.extensions).toEqual([
      expect.objectContaining({ name: "nudge", status: "unclaimed" }),
      expect.objectContaining({ name: "old", status: "skipped", reason: "schema: missing — every manifest carries schema: 1" }),
    ]);
    expect(renderExtensions(list)).toContain("2 not loaded");
  });

  it("remove refuses a name that is not one, and one that is not installed", async () => {
    const dir = await instance();
    const { o } = opts(dir);
    await expect(extensionsRemove({ ...o, name: "../state" })).rejects.toThrow(/is not an extension name/);
    await expect(extensionsRemove({ ...o, name: "ghost" })).rejects.toThrow(/no extension named ghost/);
  });

  it("--dry-run prints the plan and writes nothing", async () => {
    const dir = await instance();
    const { o, lines } = opts(dir, { dryRun: true });
    await extensionsAdd({ ...o, source: await source({ "manifest.yaml": VLLM }) });
    expect(existsSync(ext(dir, "vllm-box"))).toBe(false);
    expect(lines.join("\n")).toContain("[dry-run]");
  });
});

describe("through the reconciler: the owner's hand, as `user`", () => {
  function fakeBridge() {
    const calls: Array<{ url: string; auth: string | null; body: { path: string; intent: { principal: string } } }> = [];
    const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(u), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  }

  it("add writes each file, and remove deletes each, through /vault/* with the owner-class bearer", async () => {
    const dir = await instance();
    const { calls, fetchFn } = fakeBridge();
    const env = { METISTRY_RECONCILER_URL: "http://127.0.0.1:7812", [OWNER_BRIDGE_TOKEN]: "owner-bearer", METISTRY_BRIDGE_TOKEN_RECONCILER: "console-bearer" };
    const { o } = opts(dir, { env, fetchFn });
    const r = await extensionsAdd({ ...o, source: await source({ "manifest.yaml": VLLM, "README.md": "notes\n" }) });
    expect(r.deliveries.map((d) => d.how)).toEqual(["bridge", "bridge"]);
    expect(calls.map((c) => [c.url, c.body.path])).toEqual([
      ["http://127.0.0.1:7812/vault/write", ".metistry/extensions/vllm-box/README.md"],
      ["http://127.0.0.1:7812/vault/write", ".metistry/extensions/vllm-box/manifest.yaml"],
    ]);
    for (const c of calls) {
      expect(c.auth).toBe("Bearer owner-bearer"); // never the console's
      expect(c.body.intent.principal).toBe("user");
    }
    // the bridge would have written it; put it on disk so remove has something to find
    await mkdir(ext(dir, "vllm-box"), { recursive: true });
    await writeFile(join(ext(dir, "vllm-box"), "manifest.yaml"), VLLM);
    calls.length = 0;
    await extensionsRemove({ ...o, name: "vllm-box" });
    expect(calls.map((c) => [c.url, c.body.path, c.auth])).toEqual([["http://127.0.0.1:7812/vault/delete", ".metistry/extensions/vllm-box/manifest.yaml", "Bearer owner-bearer"]]);
  });

  it("a refusal from the bridge is the verb's failure, naming the path", async () => {
    const dir = await instance();
    const fetchFn = (async () => new Response(JSON.stringify({ error: { code: "forbidden", message: "protected path" } }), { status: 403 })) as unknown as typeof fetch;
    const { o } = opts(dir, { env: { METISTRY_RECONCILER_URL: "http://127.0.0.1:7812", METISTRY_BRIDGE_TOKEN_RECONCILER: "console-bearer" }, fetchFn });
    await expect(extensionsAdd({ ...o, source: await source({ "manifest.yaml": VLLM }) })).rejects.toThrow(/reconciler refused the \.metistry\/extensions\/vllm-box\/manifest\.yaml write \(forbidden: protected path\).*owner class alone/);
  });
});

describe("metistry extensions (the command)", () => {
  const run = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s), platform: "linux", uid: 501 });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("parses its verbs; list is the default", () => {
    expect(parseExtensionVerb(undefined)).toBe("list");
    expect(parseExtensionVerb("add")).toBe("add");
    expect(parseExtensionVerb("install")).toBeUndefined();
  });

  it("list --json is one JSON document; add and remove without an argument are usage errors", async () => {
    const dir = await instance();
    const list = await run(["extensions", "list", "--json", "--instance", dir, "--product-dir", PRODUCT]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.out)).toMatchObject({ dir: join(dir, ".metistry", "extensions"), exists: false, extensions: [] });
    expect((await run(["extensions", "add", "--instance", dir])).code).toBe(2);
    expect((await run(["extensions", "remove", "--instance", dir])).code).toBe(2);
    expect((await run(["extensions", "install", "--instance", dir])).code).toBe(2);
  });

  it("add then remove, end to end", async () => {
    const dir = await instance();
    const src = await source({ "manifest.yaml": VLLM });
    const added = await run(["extensions", "add", src, "--instance", dir, "--product-dir", PRODUCT]);
    expect(added.code).toBe(0);
    expect(added.out).toContain("added provider vllm-box");
    const refused = await run(["extensions", "add", await source({ "manifest.yaml": VLLM, "go.sh": "echo hi\n" }), "--instance", dir, "--product-dir", PRODUCT]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("go.sh is not data");
    const removed = await run(["extensions", "remove", "vllm-box", "--instance", dir, "--product-dir", PRODUCT]);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain("removed provider vllm-box");
    expect(existsSync(ext(dir, "vllm-box"))).toBe(false);
  });
});
