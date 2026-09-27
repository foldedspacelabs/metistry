// `metistry identity` — identity.yaml as the CLI understands it, the same
// file `metistry init` stamps (name, mention, voice, icon, instance_id).
// Built on a real `init` output rather than a hand-written fixture, so a
// change to what `init` writes is what this test would catch.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { init } from "../src/init.js";
import { identityProblems, identitySet, parseIdentity, readIdentity, renderIdentity, withIdentityField } from "../src/identity.js";
import { identityPath } from "../src/instance.js";
import { main } from "../src/main.js";

const seedDir = fileURLToPath(new URL("../../../seed/", import.meta.url));
const fresh = () => mkdtemp(join(tmpdir(), "metistry-identity-"));
// an explicit, empty --product-dir on every main() call below: this suite
// runs from inside the real Metistry checkout, and without one `metistry`
// would resolve it ambiently and read ITS .env (state/METISTRY_INSTANCE_DIR
// included) — exactly the deprecated-fallback behaviour docs/ops/cli.md
// documents, just not what these tests are about.
const noCheckout = () => mkdtemp(join(tmpdir(), "metistry-identity-no-checkout-"));

describe("parseIdentity", () => {
  it("reads every scalar field the seed writes, including the voice: > block scalar", () => {
    const yaml = `name: Metis\nmention: "@metis"\nvoice: >\n  Direct, warm, concise.\n  Never pads.\nicon: "🦉"\ninstance_id: "11111111-2222-4333-8444-555555555555"\n`;
    expect(parseIdentity(yaml)).toEqual({
      name: "Metis",
      mention: "@metis",
      voice: "Direct, warm, concise. Never pads.",
      icon: "🦉",
      instance_id: "11111111-2222-4333-8444-555555555555",
    });
  });

  it("omits a field the file never sets, rather than inventing an empty string", () => {
    expect(parseIdentity("name: Ada\n")).toEqual({ name: "Ada" });
  });
});

describe("readIdentity", () => {
  it("reads a real instance's identity.yaml, instance_id included", async () => {
    const dir = join(await fresh(), "instance");
    const r = await init({ dir, name: "Ada", seedDir, version: "1.0.0" });
    const identity = await readIdentity(dir);
    expect(identity).toEqual({ name: "Ada", mention: "@ada", voice: expect.any(String), icon: expect.any(String), instance_id: r.instanceId });
  });

  it("undefined when the directory has no identity.yaml at all", async () => {
    expect(await readIdentity(await fresh())).toBeUndefined();
  });
});

describe("renderIdentity", () => {
  it("one field per line, name first", () => {
    const table = renderIdentity({ name: "Ada", mention: "@ada", icon: "🦉", instance_id: "abc", voice: "Warm." });
    const lines = table.split("\n");
    expect(lines[0]).toMatch(/^name\s+Ada$/);
    expect(table).toContain("mention");
    expect(table).toContain("instance_id");
    expect(table).toContain("voice");
  });

  it("says so when nothing is set", () => {
    expect(renderIdentity({})).toMatch(/none of/);
  });
});

describe("metistry identity", () => {
  // `main()` sets METISTRY_INSTANCE_DIR on the real process.env when an
  // instance resolves (loadInstallEnv/env.ts — the pointer downstream steps
  // read); reset it so one test's --instance can't leak into the next.
  beforeEach(() => {
    delete process.env.METISTRY_INSTANCE_DIR;
  });

  it("--json prints one object with the instance's name, mention, icon and instance_id", async () => {
    const dir = join(await fresh(), "instance");
    const r = await init({ dir, name: "Ada", seedDir, version: "1.0.0" });
    const out: string[] = [];
    const code = await main(["identity", "--json", "--instance", dir, "--product-dir", await noCheckout()], { out: (l) => out.push(l) });
    expect(code).toBe(0);
    expect(out).toHaveLength(1); // --json purity: nothing but the one document reaches stdout
    const printed = JSON.parse(out.join("\n"));
    expect(printed).toEqual({ name: "Ada", mention: "@ada", voice: expect.any(String), icon: expect.any(String), instance_id: r.instanceId });
  });

  it("plain output is the short table", async () => {
    const dir = join(await fresh(), "instance");
    await init({ dir, name: "Ada", seedDir, version: "1.0.0" });
    const out: string[] = [];
    const code = await main(["identity", "--instance", dir, "--product-dir", await noCheckout()], { out: (l) => out.push(l) });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/^name\s+Ada$/m);
  });

  it("refuses without an instance dir", async () => {
    const err: string[] = [];
    const code = await main(["identity", "--product-dir", await noCheckout()], { err: (l) => err.push(l), out: () => {} });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--instance");
  });

  it("fails when the directory is not an instance (no identity.yaml)", async () => {
    const err: string[] = [];
    const code = await main(["identity", "--instance", await fresh(), "--product-dir", await noCheckout()], { err: (l) => err.push(l), out: () => {} });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("identity.yaml");
  });
});

// ---- `metistry identity set` (M10, T2-16) ------------------------------------

/** A fetch that records every call and answers like the reconciler bridge would. */
function bridge(status = 200) {
  const calls: { url: string; init: RequestInit & { headers: Record<string, string> } }[] = [];
  const fetchFn = (async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(status === 200 ? { path: ".metistry/identity.yaml", queued: true } : { error: { code: "forbidden", message: "no" } }), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const BRIDGE_ENV = { METISTRY_RECONCILER_URL: "http://127.0.0.1:1", METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner-bearer" };
const setOpts = (instanceDir: string, fetchFn: typeof fetch, env: NodeJS.ProcessEnv = BRIDGE_ENV) => ({ instanceDir, env, platform: "linux" as const, uid: 0, fetchFn, out: () => {} });
const instance = async (name = "Iris") => {
  const dir = join(await fresh(), "instance");
  const r = await init({ dir, name, seedDir, version: "1.0.0" });
  return { dir, instanceId: r.instanceId };
};

describe("identityProblems — what an invalid identity is", () => {
  it("accepts an ordinary change", () => {
    expect(identityProblems({ name: "Ada", mention: "@ada", mark: "🐙" })).toEqual([]);
    expect(identityProblems({ name: "Ada Lovelace", mention: "@ada-lovelace", mark: "A" })).toEqual([]);
    expect(identityProblems({ mark: "👩🏽‍🔬" })).toEqual([]); // one grapheme, many code points
  });

  it.each([
    [{ name: "" }, /empty/],
    [{ name: "   " }, /empty/],
    [{ name: " Ada" }, /whitespace/],
    [{ name: "Ada\nLovelace" }, /one line/],
    [{ name: "Ada\u0007" }, /control/],
    [{ name: "x".repeat(41) }, /at most 40/],
    [{ name: "{{voice}}" }, /\{\{/],
    [{ mention: "ada" }, /--mention/],
    [{ mention: "@Ada" }, /--mention/],
    [{ mention: "@ada lovelace" }, /--mention/],
    [{ mention: "@-ada" }, /--mention/],
    [{ mention: `@${"a".repeat(41)}` }, /at most 41/],
    [{ mark: "" }, /--mark/],
    [{ mark: "AB" }, /--mark/],
    [{ mark: " " }, /--mark/],
    [{ mark: "\n" }, /--mark/],
  ])("refuses %j", (change, why) => {
    const problems = identityProblems(change);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(why);
  });
});

describe("withIdentityField", () => {
  const text = `# a comment the owner wrote\nname: Iris\nmention: "@iris"\nvoice: >\n  Direct, warm.\n  Never pads.\nicon: "🦉"\n`;

  it("replaces the one line and keeps every other byte, comments and the folded voice included", () => {
    const next = withIdentityField(text, "name", "Ada");
    expect(next).toBe(text.replace("name: Iris", 'name: "Ada"'));
  });

  it("appends a key the file does not have", () => {
    expect(withIdentityField("name: Ada\n", "icon", "🐙")).toBe('name: Ada\nicon: "🐙"\n');
    expect(withIdentityField("name: Ada", "icon", "🐙")).toBe('name: Ada\nicon: "🐙"\n');
  });

  it("quotes a value YAML would otherwise read as something else", () => {
    for (const v of ["yes", "123", "@ada", "a: b", "#x", "null"]) {
      expect(parseIdentity(withIdentityField("name: X\n", "name", v)).name).toBe(v);
    }
  });

  it("a block-scalar value goes through the document and still reads back", () => {
    const next = withIdentityField("name: >\n  Old\n  Name\nicon: x\n", "name", "Ada");
    expect(parseIdentity(next)).toMatchObject({ name: "Ada", icon: "x" });
  });
});

describe("identitySet", () => {
  it("**an invalid identity is refused and nothing is written** — no bridge call, the file byte for byte", async () => {
    const { dir } = await instance();
    const before = await readFile(identityPath(dir), "utf8");
    for (const change of [{ name: "" }, { mention: "iris" }, { mark: "🦉🐙" }, { name: "Ada", mark: "too long" }]) {
      const b = bridge();
      await expect(identitySet({ ...setOpts(dir, b.fetchFn), change })).rejects.toThrow(/refused: .*NOT written/);
      expect(b.calls).toEqual([]);
    }
    // and with no reconciler configured, nothing reaches the disk either
    await expect(identitySet({ ...setOpts(dir, bridge().fetchFn, {}), change: { name: "Ada\nEvil: true" } })).rejects.toThrow(/NOT written/);
    expect(await readFile(identityPath(dir), "utf8")).toBe(before);
  });

  it("a name that yields no mention is refused unless --mention comes with it", async () => {
    const { dir } = await instance();
    const b = bridge();
    await expect(identitySet({ ...setOpts(dir, b.fetchFn), change: { name: "李" } })).rejects.toThrow(/--mention/);
    expect(b.calls).toEqual([]);
    const ok = await identitySet({ ...setOpts(dir, b.fetchFn), change: { name: "李", mention: "@li" } });
    expect(ok.changes.map((c) => c.field)).toEqual(["name", "mention"]);
  });

  it("writes through the reconciler as the owner, with the change in the commit message — the content keeps comments, voice and instance_id", async () => {
    const { dir, instanceId } = await instance();
    const b = bridge();
    const r = await identitySet({ ...setOpts(dir, b.fetchFn), change: { name: "Ada", mark: "🐙" } });
    expect(b.calls).toHaveLength(1);
    const call = b.calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:1/vault/write");
    expect(call.init.headers.authorization).toBe("Bearer owner-bearer");
    const body = JSON.parse(String(call.init.body));
    expect(body.path).toBe(".metistry/identity.yaml");
    expect(body.intent).toEqual({ principal: "user", message: "metistry identity set: name Iris → Ada, mention @iris → @ada, icon 🦉 → 🐙" });
    const before = await readFile(identityPath(dir), "utf8");
    expect(body.content).toContain("# SEED TEMPLATE"); // comments survive
    expect(parseIdentity(body.content)).toEqual({ ...parseIdentity(before), name: "Ada", mention: "@ada", icon: "🐙", instance_id: instanceId });
    expect(r.mention_followed_name).toBe(true);
    expect(r.delivery?.how).toBe("bridge");
    // the bridge did the writing, so the local file is untouched until it does
    expect(before).toContain("name: \"Iris\"");
  });

  it("a mention the owner chose on its own stays put when the name changes", async () => {
    const { dir } = await instance();
    await writeFile(identityPath(dir), (await readFile(identityPath(dir), "utf8")).replace('mention: "@iris"', 'mention: "@owl"'));
    const b = bridge();
    const r = await identitySet({ ...setOpts(dir, b.fetchFn), change: { name: "Ada" } });
    expect(r.changes).toEqual([{ field: "name", from: "Iris", to: "Ada" }]);
    expect(r.mention_followed_name).toBe(false);
    expect(parseIdentity(JSON.parse(String(b.calls[0]!.init.body)).content).mention).toBe("@owl");
  });

  it("a change to what the file already says writes nothing", async () => {
    const { dir } = await instance();
    const b = bridge();
    const r = await identitySet({ ...setOpts(dir, b.fetchFn), change: { name: "Iris", mark: "🦉" } });
    expect(r.changes).toEqual([]);
    expect(r.delivery).toBeUndefined();
    expect(b.calls).toEqual([]);
  });

  it("--dry-run reaches nothing", async () => {
    const { dir } = await instance();
    const b = bridge();
    const r = await identitySet({ ...setOpts(dir, b.fetchFn), change: { name: "Ada" }, dryRun: true });
    expect(r.changes.map((c) => c.field)).toEqual(["name", "mention"]);
    expect(b.calls).toEqual([]);
  });

  it("a bridge refusal is an error that says nothing was written", async () => {
    const { dir } = await instance();
    await expect(identitySet({ ...setOpts(dir, bridge(403).fetchFn), change: { name: "Ada" } })).rejects.toThrow(/NOT written/);
  });

  it("with no reconciler configured, a local instance is written directly", async () => {
    const { dir, instanceId } = await instance();
    const r = await identitySet({ ...setOpts(dir, bridge().fetchFn, {}), change: { mention: "@owl" } });
    expect(r.delivery?.how).toBe("direct");
    expect(await readIdentity(dir)).toMatchObject({ name: "Iris", mention: "@owl", instance_id: instanceId });
  });

  it("nothing to set is a usage error", async () => {
    const { dir } = await instance();
    await expect(identitySet({ ...setOpts(dir, bridge().fetchFn), change: {} })).rejects.toMatchObject({ code: 2 });
  });
});

describe("metistry identity set", () => {
  beforeEach(() => {
    delete process.env.METISTRY_INSTANCE_DIR;
    delete process.env.METISTRY_RECONCILER_URL;
  });

  it("refuses an invalid field with exit 1, and the file is byte for byte what it was", async () => {
    const { dir } = await instance();
    const before = await readFile(identityPath(dir), "utf8");
    const err: string[] = [];
    const b = bridge();
    const code = await main(["identity", "set", "--mention", "not-a-mention", "--instance", dir, "--product-dir", await noCheckout()], { err: (l) => err.push(l), out: () => {}, fetchFn: b.fetchFn, platform: "linux", uid: 0 });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/refused: --mention/);
    expect(b.calls).toEqual([]);
    expect(await readFile(identityPath(dir), "utf8")).toBe(before);
  });

  it("a flag with no value, and an unknown sub-verb, are usage errors", async () => {
    const { dir } = await instance();
    const err: string[] = [];
    expect(await main(["identity", "set", "--name", "--instance", dir, "--product-dir", await noCheckout()], { err: (l) => err.push(l), out: () => {} })).toBe(2);
    expect(await main(["identity", "rename", "--instance", dir, "--product-dir", await noCheckout()], { err: (l) => err.push(l), out: () => {} })).toBe(2);
    expect(await main(["identity", "set", "--instance", dir, "--product-dir", await noCheckout()], { err: (l) => err.push(l), out: () => {} })).toBe(2);
  });

  it("--json prints the result document; the read verb then shows the new identity", async () => {
    const { dir } = await instance();
    const out: string[] = [];
    const code = await main(["identity", "set", "--name", "Ada", "--mark", "🐙", "--json", "--instance", dir, "--product-dir", await noCheckout()], { out: (l) => out.push(l), err: () => {}, platform: "linux", uid: 0 });
    expect(code).toBe(0);
    const r = JSON.parse(out.join("\n"));
    expect(r.changes.map((c: { field: string }) => c.field)).toEqual(["name", "mention", "mark"]);
    expect(r.delivery.how).toBe("direct");
    const shown: string[] = [];
    await main(["identity", "--json", "--instance", dir, "--product-dir", await noCheckout()], { out: (l) => shown.push(l) });
    expect(JSON.parse(shown.join("\n"))).toMatchObject({ name: "Ada", mention: "@ada", icon: "🐙" });
  });
});
