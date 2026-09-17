// An instance directory is self-contained: its `.env` lives at
// `<instance>/state/.env`, and `identity.yaml` carries the `instance_id`
// that its Keychain items are filed under. The assertions that matter are
// the migration-safe ones — a product-dir `.env` is still READ (nobody's
// running install breaks), it is never written to once the instance has its
// own, and a minted `instance_id` goes through the reconciler when there is
// one.
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureInstanceId,
  envNotices,
  envPaths,
  instanceEnvFile,
  instanceStateDir,
  mintInstanceId,
  parseInstanceId,
  productEnvFile,
  readInstanceId,
  resolveInstanceDir,
  withInstanceId,
  INSTANCE_ID_RE,
} from "../src/instance.js";
import { loadInstallEnv } from "../src/env.js";
import { StepRunner } from "../src/steps.js";
import type { Exec } from "../src/exec.js";

const ID = "11111111-2222-4333-8444-555555555555";
const IDENTITY = `# SEED TEMPLATE — the ONLY place the assistant is named.\nname: Seed\nmention: "@seed"\nicon: "🦉"\n`;

const okExec: Exec = async () => ({ code: 1, stdout: "", stderr: "not loaded" });

async function instanceDir(opts: { identity?: string | undefined; ownEnv?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-instance-"));
  await mkdir(join(dir, ".metistry"), { recursive: true });
    await writeFile(join(dir, ".metistry", "identity.yaml"), opts.identity ?? IDENTITY);
  if (opts.ownEnv) {
    await mkdir(instanceStateDir(dir), { recursive: true });
    await writeFile(instanceEnvFile(dir), "METISTRY_DB_PASSWORD=x\n");
  }
  return dir;
}

async function productDir(withEnv = true): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-product-"));
  if (withEnv) await writeFile(productEnvFile(dir), "METISTRY_INSTANCE_DIR=/somewhere\n");
  return dir;
}

describe("where .env lives", () => {
  it("puts an instance's .env under its own state/, gitignored by the seed", async () => {
    const dir = await instanceDir({ ownEnv: true });
    expect(instanceEnvFile(dir)).toBe(join(dir, ".metistry", "state", ".env"));
    // a trailing slash must not produce `<dir>//state`
    expect(instanceEnvFile(`${dir}/`)).toBe(join(dir, ".metistry", "state", ".env"));
  });

  it("reads the instance's own .env first and the product checkout's second, calling the product one deprecated", async () => {
    const inst = await instanceDir({ ownEnv: true });
    const prod = await productDir();
    const p = envPaths({ instanceDir: inst, productDir: prod })!;
    expect(p.read).toEqual([instanceEnvFile(inst), productEnvFile(prod)]);
    expect(p.write).toBe(instanceEnvFile(inst));
    expect(p.legacy).toBe(productEnvFile(prod));
    expect(p.pendingMove).toBe(false);
    expect(envNotices(p).join(" ")).toContain("deprecated");
  });

  it("before the move: the product checkout's .env is the only one read, and the notice says which command moves it", async () => {
    const inst = await instanceDir();
    const prod = await productDir();
    const p = envPaths({ instanceDir: inst, productDir: prod })!;
    expect(p.read).toEqual([productEnvFile(prod)]);
    expect(p.write).toBe(instanceEnvFile(inst));
    expect(p.pendingMove).toBe(true);
    expect(envNotices(p).join(" ")).toContain("metistry secrets sync --to env");
  });

  it("with no instance dir configured it is the product checkout's .env, exactly as before", async () => {
    const prod = await productDir();
    const p = envPaths({ productDir: prod })!;
    expect(p.read).toEqual([productEnvFile(prod)]);
    expect(p.write).toBe(productEnvFile(prod));
    expect(p.legacy).toBeUndefined();
    expect(envNotices(p)).toEqual([]);
  });

  it("--env-file wins over both and is never called deprecated", async () => {
    const p = envPaths({ instanceDir: "/i", productDir: "/p", explicit: "/tmp/other.env" })!;
    expect(p).toEqual({ read: ["/tmp/other.env"], write: "/tmp/other.env", pendingMove: false });
  });

  it("says nothing at all when there is neither an instance dir nor a checkout", () => {
    expect(envPaths({})).toBeUndefined();
  });

  it("resolves the instance dir from the flag, then the environment", () => {
    expect(resolveInstanceDir({ METISTRY_INSTANCE_DIR: "/from/env/" }, "/from/flag")).toBe("/from/flag");
    expect(resolveInstanceDir({ METISTRY_INSTANCE_DIR: "/from/env/" })).toBe("/from/env");
    expect(resolveInstanceDir({})).toBeUndefined();
  });
});

describe("loadInstallEnv", () => {
  /** A checkout whose .env carries only the pointer, and an instance whose state/.env carries the rest. */
  async function pair(): Promise<{ prod: string; inst: string }> {
    const inst = await instanceDir();
    const prod = await mkdtemp(join(tmpdir(), "metistry-product-"));
    await writeFile(productEnvFile(prod), `METISTRY_INSTANCE_DIR=${inst}\nMETISTRY_DB_PASSWORD=old-and-stale\nMETISTRY_TZ=UTC\n`);
    await mkdir(instanceStateDir(inst), { recursive: true });
    await writeFile(instanceEnvFile(inst), "METISTRY_DB_PASSWORD=the-real-one\n");
    return { prod, inst };
  }

  it("follows the checkout's pointer to the instance, then lets the instance's own values win", async () => {
    const { prod, inst } = await pair();
    const env: NodeJS.ProcessEnv = {};
    const loaded = loadInstallEnv({ productDir: prod, env });
    expect(loaded.instanceDir).toBe(inst);
    expect(loaded.files).toEqual([instanceEnvFile(inst), productEnvFile(prod)]);
    // the instance's file is applied FIRST, so the checkout's stale copy cannot win
    expect(env.METISTRY_DB_PASSWORD).toBe("the-real-one");
    // and the checkout's file still supplies what the instance's does not name
    expect(env.METISTRY_TZ).toBe("UTC");
    expect(env.METISTRY_INSTANCE_DIR).toBe(inst);
    expect(loaded.notices.join(" ")).toContain("deprecated");
  });

  it("nothing the caller already set is overwritten, by either file", async () => {
    const { prod } = await pair();
    const env: NodeJS.ProcessEnv = { METISTRY_DB_PASSWORD: "from-the-shell", METISTRY_TZ: "Europe/Lisbon" };
    loadInstallEnv({ productDir: prod, env });
    expect(env.METISTRY_DB_PASSWORD).toBe("from-the-shell");
    expect(env.METISTRY_TZ).toBe("Europe/Lisbon");
  });

  it("an explicit --instance wins over the environment and is what downstream reads", async () => {
    const { prod, inst } = await pair();
    const other = await instanceDir({ ownEnv: true });
    const env: NodeJS.ProcessEnv = { METISTRY_INSTANCE_DIR: inst };
    const loaded = loadInstallEnv({ productDir: prod, env, instanceDir: other });
    expect(loaded.instanceDir).toBe(other);
    expect(env.METISTRY_INSTANCE_DIR).toBe(other);
  });

  it("with no instance anywhere it is the checkout's .env and no notice at all", async () => {
    const prod = await mkdtemp(join(tmpdir(), "metistry-product-"));
    await writeFile(productEnvFile(prod), "METISTRY_TZ=UTC\n");
    const env: NodeJS.ProcessEnv = {};
    const loaded = loadInstallEnv({ productDir: prod, env });
    expect(loaded.files).toEqual([productEnvFile(prod)]);
    expect(loaded.notices).toEqual([]);
    expect(env.METISTRY_TZ).toBe("UTC");
  });
});

describe("instance_id", () => {
  it("mints a v4 UUID", () => {
    const id = mintInstanceId();
    expect(id).toMatch(INSTANCE_ID_RE);
    expect(mintInstanceId()).not.toBe(id);
  });

  it("adds the key with its explanation, and replaces it in place on a second call", () => {
    const once = withInstanceId(IDENTITY, ID);
    expect(once).toContain(IDENTITY); // every seed line survives byte-for-byte
    expect(once).toContain(`instance_id: "${ID}"`);
    expect(once).toContain("filed under it as the account");
    const twice = withInstanceId(once, "99999999-2222-4333-8444-555555555555");
    expect(twice.match(/^instance_id:/gm)).toHaveLength(1);
    expect(twice).toContain("filed under it as the account");
  });

  it("refuses anything that is not a UUID, reading or writing — a typo must not split an instance's secrets in two", () => {
    expect(() => withInstanceId(IDENTITY, "work-instance")).toThrow(/not a UUID/);
    expect(parseInstanceId(`${IDENTITY}instance_id: "work-instance"\n`)).toBeUndefined();
    expect(parseInstanceId(IDENTITY)).toBeUndefined();
    expect(parseInstanceId("{ not: [yaml")).toBeUndefined();
    expect(parseInstanceId(`instance_id: "${ID.toUpperCase()}"\n`)).toBe(ID);
  });

  it("reads it back off disk", async () => {
    const dir = await instanceDir({ identity: withInstanceId(IDENTITY, ID) });
    expect(await readInstanceId(dir)).toBe(ID);
    expect(await readInstanceId(join(dir, "nope"))).toBeUndefined();
  });
});

describe("ensureInstanceId", () => {
  const runner = (dryRun = false) => {
    const lines: string[] = [];
    return { r: new StepRunner({ dryRun, out: (l) => lines.push(l), exec: okExec, env: {} }), lines };
  };

  it("leaves an existing id alone and writes nothing", async () => {
    const dir = await instanceDir({ identity: withInstanceId(IDENTITY, ID) });
    const { r } = runner();
    const got = await ensureInstanceId(r, { instanceDir: dir, env: {}, platform: "darwin", uid: 501, fetchFn: (async () => new Response()) as typeof fetch });
    expect(got).toMatchObject({ id: ID, minted: false, how: "existing" });
    expect(r.commands).toEqual([]);
  });

  it("mints one into identity.yaml directly when no reconciler is configured, and says so", async () => {
    const dir = await instanceDir();
    const { r } = runner();
    const got = await ensureInstanceId(r, { instanceDir: dir, env: {}, platform: "linux", uid: 501, fetchFn: (async () => new Response()) as typeof fetch, mint: () => ID });
    expect(got).toMatchObject({ id: ID, minted: true, how: "direct" });
    expect(got.detail).toContain("written directly");
    const identity = await readFile(join(dir, ".metistry", "identity.yaml"), "utf8");
    expect(identity).toContain(`instance_id: "${ID}"`);
    expect(identity).toContain("name: Seed");
    expect(await readInstanceId(dir)).toBe(ID);
  });

  it("goes through the reconciler as the user principal when there is one — identity.yaml is a protected path", async () => {
    const dir = await instanceDir();
    const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const { r } = runner();
    const env = { METISTRY_RECONCILER_URL: "http://host.docker.internal:7812", METISTRY_BRIDGE_TOKEN_RECONCILER: "tok" };
    const got = await ensureInstanceId(r, { instanceDir: dir, env, platform: "darwin", uid: 501, fetchFn, mint: () => ID });
    expect(got).toMatchObject({ id: ID, minted: true, how: "bridge" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:7812/vault/write");
    expect(calls[0]!.auth).toBe("Bearer tok");
    expect(calls[0]!.body).toMatchObject({ path: ".metistry/identity.yaml", intent: { principal: "user" } });
    expect(String((calls[0]!.body as { content: string }).content)).toContain(`instance_id: "${ID}"`);
    // the bridge is the committer: nothing was written to disk here
    expect(await readInstanceId(dir)).toBeUndefined();
  });

  it("reports a directory that is not an instance rather than creating one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-empty-"));
    const { r } = runner();
    const got = await ensureInstanceId(r, { instanceDir: dir, env: {}, platform: "linux", uid: 501, fetchFn: (async () => new Response()) as typeof fetch });
    expect(got).toMatchObject({ minted: false, how: "none" });
    expect(got.detail).toContain("is not an instance directory");
  });
});
