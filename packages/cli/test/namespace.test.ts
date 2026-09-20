// Per-instance launchd labels and ports — what lets a SECOND instance run
// on one Mac beside the first (docs/product/desktop-app-plan.md, "The limit
// that remains"). The misuse cases matter more than the happy path here: a
// namespace that half-applies is two instances fighting over one port with
// no error anywhere.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { labelFor, loadPlistTemplates, logPathFor, readPlistTemplates, renderPlist, serviceOf, withNamespace } from "../src/launchd.js";
import {
  allocateBase,
  applyPorts,
  BLOCK_CEIL,
  BLOCK_FLOOR,
  BLOCK_SIZE,
  DEFAULT_PORTS,
  loadNamespace,
  parseNamespace,
  PORTED_SERVICES,
  PORT_VARS,
  portsFile,
  portsOf,
  preferredBase,
  serializeNamespace,
  suffixFor,
  type Namespace,
} from "../src/namespace.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const ID = "3f2a1b0c-4d5e-4f60-8a91-0b1c2d3e4f50";

const ns = (over: Partial<Namespace> = {}): Namespace => ({ labelSuffix: "3f2a1b0c", base: 8400, ports: portsOf(8400), from: "test", ...over });

describe("labels", () => {
  it("a suffix goes BETWEEN the prefix and the service, so the service is still the last component", () => {
    expect(labelFor("console")).toBe("com.foldedspacelabs.metistry.console");
    expect(labelFor("console", "3f2a1b0c")).toBe("com.foldedspacelabs.metistry.3f2a1b0c.console");
    expect(serviceOf("com.foldedspacelabs.metistry.console")).toBe("console");
    expect(serviceOf("com.foldedspacelabs.metistry.3f2a1b0c.console")).toBe("console");
    // hyphens, not dots, in every shipped service name — that is what makes
    // "last component" a safe rule
    expect(serviceOf("com.foldedspacelabs.metistry.eventkit-helper")).toBe("eventkit-helper");
    expect(serviceOf("com.foldedspacelabs.metistry.3f2a1b0c.apple-fm")).toBe("apple-fm");
  });

  it("two instances never share a log file either", () => {
    expect(logPathFor("console")).toBe("/tmp/metistry-console.log");
    expect(logPathFor("console", "3f2a1b0c")).toBe("/tmp/metistry-3f2a1b0c-console.log");
  });

  it("suffix is the first 8 hex of instance_id — bounded, lowercase, a legal label component", () => {
    expect(suffixFor(ID)).toBe("3f2a1b0c");
    expect(suffixFor("ABCDEF01-2345-4678-9abc-def012345678")).toBe("abcdef01");
  });
});

describe("namespaced plist templates", () => {
  it("rewrites the label, the file name and both log paths — and nothing else", async () => {
    const all = await readPlistTemplates(repoRoot, "3f2a1b0c");
    expect(all.length).toBeGreaterThan(0);
    for (const x of all) {
      // the supervisor IS the install: its label takes the suffix INSTEAD of a
      // service component, so a namespaced core is still one agent
      expect(x.label, x.file).toBe(x.service === "supervisor" ? "com.foldedspacelabs.metistry.3f2a1b0c" : `com.foldedspacelabs.metistry.3f2a1b0c.${x.service}`);
      expect(x.file).toBe(`${x.label}.plist`);
      expect(x.template).toContain(`<string>${x.label}</string>`);
      // the default label must be gone: a leftover would bootstrap over the
      // OTHER instance's job
      if (x.service !== "supervisor") expect(x.template).not.toContain(`<string>com.foldedspacelabs.metistry.${x.service}</string>`);
      if (x.standardOutPath !== undefined) {
        expect(x.standardOutPath).toBe(`/tmp/metistry-3f2a1b0c-${x.service}.log`);
        expect(x.template).not.toContain(`/tmp/metistry-${x.service}.log`);
      }
    }
  });

  it("still renders with every placeholder replaced", async () => {
    for (const t of await loadPlistTemplates(repoRoot, "compose", "3f2a1b0c")) {
      const out = renderPlist(t.template, {
        repo: "/srv/m",
        node: "/usr/bin/node",
        envFile: "/i/state/.env",
        // the compose shape still installs the reconciler as a host job, and
        // its template is rooted at sandbox-exec (ops/sandbox/reconciler.sb)
        extra: { SANDBOX_PROFILE: "/srv/m/ops/sandbox/unconfined.sb", NODE_PREFIX: "/usr", PRODUCT_DIR: "/srv/m", INSTANCE_DIR: "/i", TMP_DIR: "/tmp", GIT_PREFIX: "/Library/Developer/CommandLineTools/usr", GIT_CONFIG_GLOBAL: "/h/.gitconfig", RECONCILER_TCP: "localhost:7812", CONSOLE_TCP: "localhost:8080", DB_TCP: "localhost:5432", EMBED_TCP: "localhost:11434", PROXY_TCP: "localhost:7814" },
      });
      expect(out, t.file).not.toContain("__");
    }
  });

  it("no suffix is byte-for-byte today's template", async () => {
    const plain = await loadPlistTemplates(repoRoot, "launchd");
    for (const t of plain) expect(withNamespace(t, undefined)).toBe(t);
  });
});

describe("the port block", () => {
  it("a block is contiguous, in the documented range, and the offsets follow PORTED_SERVICES", () => {
    const p = portsOf(8400);
    expect(p).toEqual({ console: 8400, db: 8401, reconciler: 8402, eventkit: 8403, "apple-fm": 8404 });
    expect(PORTED_SERVICES.length).toBeLessThanOrEqual(BLOCK_SIZE);
    const base = preferredBase(ID);
    expect(base).toBeGreaterThanOrEqual(BLOCK_FLOOR);
    expect(base + BLOCK_SIZE - 1).toBeLessThanOrEqual(BLOCK_CEIL);
    expect((base - BLOCK_FLOOR) % BLOCK_SIZE).toBe(0);
    // deterministic: the same directory asks for the same block on a machine
    // that has never seen it
    expect(preferredBase(ID)).toBe(base);
    expect(preferredBase("00000000-0000-4000-8000-000000000000")).not.toBe(preferredBase("11111111-1111-4111-8111-111111111111"));
  });

  it("none of the defaults is inside the namespaced range — a namespaced instance cannot collide with an un-namespaced one", () => {
    for (const s of PORTED_SERVICES) {
      const d = DEFAULT_PORTS[s];
      expect(d < BLOCK_FLOOR || d > BLOCK_CEIL, `${s} default ${d}`).toBe(true);
    }
  });

  it("allocation steps PAST a block that is in use, one whole block at a time", async () => {
    const want = preferredBase(ID);
    // one port of the preferred block is taken; the whole block is skipped
    const taken = new Set([want + 3]);
    const base = await allocateBase(ID, async (p) => !taken.has(p));
    const next = want + BLOCK_SIZE + BLOCK_SIZE - 1 <= BLOCK_CEIL ? want + BLOCK_SIZE : BLOCK_FLOOR;
    expect(base).toBe(next);
  });

  it("refuses rather than guessing when nothing is free", async () => {
    await expect(allocateBase(ID, async () => false)).rejects.toThrow(/no free 8-port block/);
  });
});

describe("ports.yaml", () => {
  it("round-trips, and the serialized form carries the instance it belongs to", () => {
    const n = ns();
    const text = serializeNamespace(n, ID);
    expect(text).toContain(`instance_id: "${ID}"`);
    const back = parseNamespace(text, "ports.yaml");
    expect(back).toMatchObject({ labelSuffix: n.labelSuffix, base: n.base, ports: n.ports });
  });

  it("is strict: a half-written block is an error, never a merge with the defaults", () => {
    expect(() => parseNamespace("schema: 1\nlabel_suffix: abc\nbase: 8400\nports:\n  console: 8400\n", "p.yaml")).toThrow(/ports\.db/);
    expect(() => parseNamespace("schema: 1\nbase: 8400\nports: {}\n", "p.yaml")).toThrow(/label_suffix/);
    expect(() => parseNamespace('schema: 1\nlabel_suffix: "A B"\nbase: 8400\n', "p.yaml")).toThrow(/label_suffix/);
    expect(() => parseNamespace("schema: 1\nlabel_suffix: abc\nbase: nope\n", "p.yaml")).toThrow(/base/);
  });

  it("an instance without one has no namespace at all — today's install, unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-ns-"));
    expect(await loadNamespace(dir)).toBeUndefined();
    expect(await loadNamespace(undefined)).toBeUndefined();
    await mkdir(join(dir, ".metistry", "state"), { recursive: true });
    await writeFile(portsFile(dir), serializeNamespace(ns(), ID));
    expect((await loadNamespace(dir))?.labelSuffix).toBe("3f2a1b0c");
    // a trailing slash is the same instance
    expect((await loadNamespace(`${dir}/`))?.base).toBe(8400);
  });
});

describe("applying a block to the environment", () => {
  it("fills only what is UNSET — an explicit .env line still wins everywhere", () => {
    const env: NodeJS.ProcessEnv = { METISTRY_CONSOLE_PORT: "9999" };
    const applied = applyPorts(env, ns());
    expect(env.METISTRY_CONSOLE_PORT).toBe("9999");
    expect(env.METISTRY_DB_PORT).toBe("8401");
    expect(env.METISTRY_RECONCILER_PORT).toBe("8402");
    expect(env.METISTRY_EK_PORT).toBe("8403");
    expect(env.METISTRY_AFM_PORT).toBe("8404");
    // the URL half matters as much as the port: doctor probes the URL, and
    // the console binds the port
    expect(env.METISTRY_CONSOLE_URL).toBe("http://127.0.0.1:8400");
    expect(env.METISTRY_RECONCILER_URL).toBe("http://127.0.0.1:8402");
    // a bridge's URL is how an operator opts INTO it: unset means doctor says
    // "absent — not configured", which is a healthy install without a calendar
    // bridge. Filling it here would turn every such install red.
    expect(env.METISTRY_EK_URL).toBeUndefined();
    expect(env.METISTRY_AFM_URL).toBeUndefined();
    expect(applied).not.toContain("METISTRY_CONSOLE_PORT=8400");
    // db has no URL variable — it is reached by host+port
    expect(Object.keys(env)).not.toContain("METISTRY_DB_URL");
  });

  it("every ported service has a port variable, and the variable names are the ones the services read", () => {
    expect(Object.keys(PORT_VARS).sort()).toEqual([...PORTED_SERVICES].sort());
    expect(PORT_VARS.eventkit).toBe("METISTRY_EK_PORT");
    expect(PORT_VARS["apple-fm"]).toBe("METISTRY_AFM_PORT");
  });
});
