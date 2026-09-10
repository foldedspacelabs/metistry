// `metistry identity` — identity.yaml as the CLI understands it, the same
// file `metistry init` stamps (name, mention, voice, icon, instance_id).
// Built on a real `init` output rather than a hand-written fixture, so a
// change to what `init` writes is what this test would catch.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { init } from "../src/init.js";
import { parseIdentity, readIdentity, renderIdentity } from "../src/identity.js";
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
