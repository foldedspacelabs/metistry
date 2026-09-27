// `metistry secrets migrate-scope` and `purge-shared` — plan §2.14's
// migration from the retired shared scope (T4-3), against core's in-memory
// Keychain (never the login Keychain) and scratch instance directories.
//
// The bold test is the first one: **no item is deleted by the migration**.
// The Keychain handed to it throws on `delete`, and every item it started
// with is still there, with the same value, after a real run, a rerun and a
// dry run. The rest: it is idempotent, an item the instance already holds
// wins, a reference is rewritten only into a file that still validates, and
// `purge-shared` removes only an original every instance has copied.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryKeychain, parseSecretsFile, type KeychainBackend } from "@foldedspacelabs/metistry-core";
import type { Exec, ExecOptions } from "../src/exec.js";
import { main } from "../src/main.js";
import { sharedScopeRow } from "../src/doctor.js";
import { knownInstanceDirs, migrateScope, purgeShared, sharedScopeStatus, type MigrateScopeOptions } from "../src/secrets.js";
import { update, updateSharedScope } from "../src/update.js";
import { StepRunner } from "../src/steps.js";
import { checkout, fakeExec, okDoctor } from "./fixtures.js";

const ID_A = "11111111-2222-4333-8444-555555555555";
const ID_B = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const USER = "metistry";
const svc = (v: string) => `metistry:${v}`;
const named = (n: string) => `metistry:secret:${n}`;

/** The per-user originals an install from before T4-3 has. */
const ORIGINALS = [
  { service: svc("METISTRY_DEVIN_API_KEY"), account: USER, value: "devin-SHARED-original" },
  { service: svc("METISTRY_LOCAL_API_KEY"), account: USER, value: "local-SHARED-original" },
  { service: svc("METISTRY_AWS_SECRET_ACCESS_KEY"), account: USER, value: "aws-SHARED-original" },
];

type Op = { op: "get" | "has" | "set" | "delete"; service: string; account: string };

/** core's memory Keychain, recording every call; `delete` throws unless a test allows it. */
function keychain(seed = ORIGINALS, opts: { allowDelete?: boolean; unreadable?: string[] } = {}): KeychainBackend & { ops: Op[]; value(service: string, account: string): Promise<string | undefined>; items(): Array<{ service: string; account: string }> } {
  const kc = memoryKeychain(seed);
  const ops: Op[] = [];
  return {
    ops,
    items: () => kc.items(),
    value: (s, a) => kc.get(s, a),
    async get(service, account) {
      ops.push({ op: "get", service, account });
      if (opts.unreadable?.includes(service)) return undefined;
      return kc.get(service, account);
    },
    async has(service, account) {
      ops.push({ op: "has", service, account });
      return kc.has(service, account);
    },
    async set(service, account, value) {
      ops.push({ op: "set", service, account });
      return kc.set(service, account, value);
    },
    async delete(service, account) {
      ops.push({ op: "delete", service, account });
      if (!opts.allowDelete) throw new Error(`the migration deleted ${service} (${account})`);
      return kc.delete(service, account);
    },
  };
}

const COMPUTE = `# compute.yaml — this comment is the owner's and must survive
providers:
  local:
    kind: openai-compatible
    base_url: http://127.0.0.1:1234/v1
    locality: on_machine
    auth: { secret: METISTRY_LOCAL_API_KEY } # a NAME, never the key
`;

/** A scratch instance: identity with an id, a `.env` naming the shared-scope variables, compute.yaml naming one. No reconciler, so a protected write lands directly. */
async function instance(id: string | undefined, label: string, envText = "METISTRY_DEVIN_API_KEY=\nMETISTRY_AWS_SECRET_ACCESS_KEY=\nMETISTRY_DB_PASSWORD=x\n"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `metistry-scope-${label}-`));
  await mkdir(join(dir, ".metistry/state"), { recursive: true });
  await writeFile(join(dir, ".metistry/identity.yaml"), `name: Aide\n${id ? `instance_id: "${id}"\n` : ""}`);
  await writeFile(join(dir, ".metistry/state/.env"), envText, { mode: 0o600 });
  await writeFile(join(dir, ".metistry/compute.yaml"), COMPUTE);
  return dir;
}

function opts(dir: string, id: string | undefined, kc: KeychainBackend, extra: Partial<MigrateScopeOptions> = {}): MigrateScopeOptions & { lines: string[] } {
  const lines: string[] = [];
  // linux + a Keychain seam: no `security`, and no `launchctl` probe of a real reconciler
  return { instanceDir: dir, instanceId: id, envFile: join(dir, ".metistry/state/.env"), env: {}, platform: "linux", uid: 501, keychain: kc, out: (l) => lines.push(l), lines, ...extra };
}

async function snapshot(kc: ReturnType<typeof keychain>): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const i of kc.items()) out[`${i.account}/${i.service}`] = await kc.value(i.service, i.account);
  return out;
}

describe("**no item is deleted by the migration**", () => {
  it("a real run, a rerun and a dry run never call delete, and every item it started with is still there with the same value", async () => {
    const kc = keychain([...ORIGINALS, { service: named("devin_api_key"), account: ID_A, value: "devin-INSTANCE-own" }]);
    const dir = await instance(ID_A, "nodelete");
    const before = await snapshot(kc);

    await migrateScope(opts(dir, ID_A, kc));
    await migrateScope(opts(dir, ID_A, kc));
    await migrateScope(opts(dir, ID_A, kc, { dryRun: true }));

    expect(kc.ops.filter((o) => o.op === "delete")).toEqual([]);
    const after = await snapshot(kc);
    for (const [k, v] of Object.entries(before)) expect(after[k], k).toBe(v);
  });

  it("says so, naming the originals it left and the one verb that removes them", async () => {
    const kc = keychain();
    const dir = await instance(ID_A, "says");
    const o = opts(dir, ID_A, kc);
    const r = await migrateScope(o);
    expect(r.originals.sort()).toEqual(["METISTRY_AWS_SECRET_ACCESS_KEY", "METISTRY_DEVIN_API_KEY", "METISTRY_LOCAL_API_KEY"]);
    expect(o.lines.join("\n")).toContain("this migration deletes nothing");
    expect(o.lines.join("\n")).toContain("metistry secrets purge-shared");
  });
});

describe("step 1 — copy into this instance, record the name", () => {
  it("copies each original under its new name into THIS instance's account and records it in secrets.yaml — never a value in the file or the output", async () => {
    const kc = keychain();
    const dir = await instance(ID_A, "copy");
    const o = opts(dir, ID_A, kc);
    const r = await migrateScope(o);

    expect(r.copied).toEqual([
      { from: "METISTRY_DEVIN_API_KEY", to: "devin_api_key" },
      { from: "METISTRY_AWS_SECRET_ACCESS_KEY", to: "aws_secret_access_key" },
      { from: "METISTRY_LOCAL_API_KEY", to: "local_api_key" },
    ]);
    expect(await kc.value(named("devin_api_key"), ID_A)).toBe("devin-SHARED-original");
    expect(await kc.value(named("local_api_key"), ID_A)).toBe("local-SHARED-original");
    // every write went to this instance's account — none to the per-user one
    for (const s of kc.ops.filter((x) => x.op === "set")) expect(s.account).toBe(ID_A);

    const file = readFileSync(join(dir, ".metistry/secrets.yaml"), "utf8");
    expect(Object.keys(parseSecretsFile(file).secrets).sort()).toEqual(["aws_secret_access_key", "devin_api_key", "local_api_key"]);
    expect(parseSecretsFile(file).secrets.devin_api_key).toEqual({ hosts: [], grants: {} });
    expect(r.recorded.sort()).toEqual(["aws_secret_access_key", "devin_api_key", "local_api_key"]);
    for (const v of ["devin-SHARED-original", "local-SHARED-original", "aws-SHARED-original"]) {
      expect(file).not.toContain(v);
      expect(o.lines.join("\n")).not.toContain(v);
      expect(JSON.stringify(r)).not.toContain(v);
    }
  });

  it("**an instance item wins**: the instance's own value is kept, and the original is not even read", async () => {
    const kc = keychain([...ORIGINALS, { service: named("devin_api_key"), account: ID_A, value: "devin-INSTANCE-own" }]);
    const dir = await instance(ID_A, "wins");
    const r = await migrateScope(opts(dir, ID_A, kc));

    expect(r.kept).toEqual([{ from: "METISTRY_DEVIN_API_KEY", to: "devin_api_key" }]);
    expect(r.copied.map((c) => c.to)).not.toContain("devin_api_key");
    expect(await kc.value(named("devin_api_key"), ID_A)).toBe("devin-INSTANCE-own");
    expect(kc.ops.some((o) => o.op === "get" && o.service === svc("METISTRY_DEVIN_API_KEY"))).toBe(false);
    // …and it is still recorded, so it is listed and purged with the instance
    expect(parseSecretsFile(readFileSync(join(dir, ".metistry/secrets.yaml"), "utf8")).secrets).toHaveProperty("devin_api_key");
  });

  it("**is idempotent**: a second run copies nothing, reads no original, writes no file and changes no item", async () => {
    const kc = keychain();
    const dir = await instance(ID_A, "idem");
    await migrateScope(opts(dir, ID_A, kc));
    const file = readFileSync(join(dir, ".metistry/secrets.yaml"), "utf8");
    const items = await snapshot(kc);
    kc.ops.length = 0;

    const again = await migrateScope(opts(dir, ID_A, kc));
    expect(again.copied).toEqual([]);
    expect(again.recorded).toEqual([]);
    expect(again.kept.map((k) => k.to).sort()).toEqual(["aws_secret_access_key", "devin_api_key", "local_api_key"]);
    expect(kc.ops.filter((o) => o.op === "get" || o.op === "set" || o.op === "delete")).toEqual([]);
    expect(readFileSync(join(dir, ".metistry/secrets.yaml"), "utf8")).toBe(file);
    expect(await snapshot(kc)).toEqual(items);
  });

  it("keeps the owner's comments and existing entries in secrets.yaml", async () => {
    const kc = keychain();
    const dir = await instance(ID_A, "comments");
    await writeFile(join(dir, ".metistry/secrets.yaml"), "# mine — keep me\nsecrets:\n  github_write:\n    hosts: [api.github.com] # the PAT\n    grants: {}\n");
    await migrateScope(opts(dir, ID_A, kc));
    const file = readFileSync(join(dir, ".metistry/secrets.yaml"), "utf8");
    expect(file).toContain("# mine — keep me");
    expect(file).toContain("# the PAT");
    expect(Object.keys(parseSecretsFile(file).secrets)).toContain("github_write");
  });

  it("one instance never touches another's items: B's migration writes only B's account", async () => {
    const kc = keychain();
    const a = await instance(ID_A, "iso-a");
    const b = await instance(ID_B, "iso-b");
    await migrateScope(opts(a, ID_A, kc));
    const aItems = await snapshot(kc);
    kc.ops.length = 0;
    await migrateScope(opts(b, ID_B, kc));
    for (const o of kc.ops.filter((x) => x.op !== "has" || x.service.startsWith("metistry:secret:"))) {
      // a get is an original, or B reading back its own fresh copy — never A's
      if (o.op === "get") expect([USER, ID_B]).toContain(o.account);
      else expect(o.account).toBe(ID_B);
      expect(o.account).not.toBe(ID_A);
    }
    const after = await snapshot(kc);
    for (const [k, v] of Object.entries(aItems)) expect(after[k], k).toBe(v);
  });

  it("an original the Keychain will not hand over is reported and left, and the verb exits 1", async () => {
    const kc = keychain(ORIGINALS, { unreadable: [svc("METISTRY_DEVIN_API_KEY")] });
    const dir = await instance(ID_A, "unreadable");
    const r = await migrateScope(opts(dir, ID_A, kc));
    expect(r.unreadable.map((u) => u.from)).toEqual(["METISTRY_DEVIN_API_KEY"]);
    expect(r.complete).toBe(false);
    expect(await kc.value(named("devin_api_key"), ID_A)).toBeUndefined();
    // nothing half-recorded: the file names only what the instance holds
    expect(Object.keys(parseSecretsFile(readFileSync(join(dir, ".metistry/secrets.yaml"), "utf8")).secrets)).not.toContain("devin_api_key");
  });

  it("--dry-run reads no original, writes no item and no file", async () => {
    const kc = keychain();
    const dir = await instance(ID_A, "dry");
    const o = opts(dir, ID_A, kc, { dryRun: true });
    const r = await migrateScope(o);
    expect(r.copied.map((c) => c.to).sort()).toEqual(["aws_secret_access_key", "devin_api_key", "local_api_key"]);
    expect(kc.ops.filter((x) => x.op !== "has")).toEqual([]);
    expect(existsSync(join(dir, ".metistry/secrets.yaml"))).toBe(false);
    expect(o.lines.join("\n")).toContain("[dry-run] would copy METISTRY_DEVIN_API_KEY → devin_api_key");
  });

  it("refuses an instance with no instance_id, a host with no Keychain, and a per-user account that IS the instance's", async () => {
    const kc = keychain();
    const dir = await instance(undefined, "noid");
    await expect(migrateScope(opts(dir, undefined, kc))).rejects.toThrow(/no instance_id/);
    const withId = await instance(ID_A, "nokc");
    await expect(migrateScope({ ...opts(withId, ID_A, kc), keychain: undefined })).rejects.toThrow(/does not have/);
    await expect(migrateScope(opts(withId, ID_A, kc, { env: { METISTRY_KEYCHAIN_ACCOUNT: ID_A } }))).rejects.toThrow(/refusing to migrate/);
    expect(kc.ops.filter((o) => o.op !== "has")).toEqual([]);
  });
});

describe("step 2 — references, only into a file that still validates", () => {
  it("today's compute.yaml schema takes an environment name, so auth.secret is LEFT and reported — the file byte-for-byte unchanged", async () => {
    const kc = keychain();
    const dir = await instance(ID_A, "gate");
    const o = opts(dir, ID_A, kc);
    const r = await migrateScope(o);
    expect(r.rewritten).toEqual([]);
    expect(r.pending).toMatchObject([{ file: ".metistry/compute.yaml", field: "providers.local.auth.secret", from: "METISTRY_LOCAL_API_KEY", to: "local_api_key" }]);
    expect(r.pending[0]!.why).toContain("does not read {{ secret.name }} there yet");
    // only the issue about that field, not the whole schema report
    expect(r.pending[0]!.why).toContain("providers.local.auth.secret: auth.secret is the NAME");
    // a reference waiting on a release is not the owner's to do: the copy is complete
    expect(r.complete).toBe(true);
    expect(readFileSync(join(dir, ".metistry/compute.yaml"), "utf8")).toBe(COMPUTE);
    expect(o.lines.join("\n")).toContain("keep their environment name until a release reads");
  });

  it("once the schema reads secret references, the rewrite lands through the protected write with every comment kept — and a rerun is then a no-op", async () => {
    const kc = keychain();
    const dir = await instance(ID_A, "rewrite");
    await mkdir(join(dir, ".metistry/agents/cost"), { recursive: true });
    const manifest = "# the owner's agent\nname: cost\nrequires:\n  env: [METISTRY_AWS_SECRET_ACCESS_KEY, METISTRY_DB_HOST] # both needed\n";
    await writeFile(join(dir, ".metistry/agents/cost/manifest.yaml"), manifest);
    const accepts = () => undefined;
    const r = await migrateScope(opts(dir, ID_A, kc, { accepts }));

    expect(r.rewritten).toEqual([
      { file: ".metistry/compute.yaml", field: "providers.local.auth.secret", from: "METISTRY_LOCAL_API_KEY", to: "local_api_key" },
      { file: ".metistry/agents/cost/manifest.yaml", field: "requires.env[0]", from: "METISTRY_AWS_SECRET_ACCESS_KEY", to: "aws_secret_access_key" },
    ]);
    const compute = readFileSync(join(dir, ".metistry/compute.yaml"), "utf8");
    expect(compute).toContain("# compute.yaml — this comment is the owner's and must survive");
    expect(compute).toContain("# a NAME, never the key");
    expect(compute).toContain('"{{ secret.local_api_key }}"');
    const m = readFileSync(join(dir, ".metistry/agents/cost/manifest.yaml"), "utf8");
    expect(m).toContain("# the owner's agent");
    expect(m).toContain("{{ secret.aws_secret_access_key }}");
    expect(m).toContain("METISTRY_DB_HOST");
    expect(r.complete).toBe(true);

    const again = await migrateScope(opts(dir, ID_A, kc, { accepts }));
    expect(again.rewritten).toEqual([]);
    expect(again.pending).toEqual([]);
    expect(readFileSync(join(dir, ".metistry/compute.yaml"), "utf8")).toBe(compute);
  });

  it("never rewrites a reference to a secret the instance does not hold", async () => {
    const kc = keychain(ORIGINALS.filter((o) => !o.service.endsWith("LOCAL_API_KEY")));
    const dir = await instance(ID_A, "noheld");
    const r = await migrateScope(opts(dir, ID_A, kc, { accepts: () => undefined }));
    expect(r.rewritten).toEqual([]);
    expect(readFileSync(join(dir, ".metistry/compute.yaml"), "utf8")).toBe(COMPUTE);
  });
});

describe("purge-shared — only an original every instance has copied", () => {
  it("keeps an original while one instance on this Mac lacks its copy, then removes it — and only from the per-user account", async () => {
    const kc = keychain(ORIGINALS, { allowDelete: true });
    const a = await instance(ID_A, "purge-a");
    const b = await instance(ID_B, "purge-b");
    await migrateScope(opts(a, ID_A, kc));
    const lines: string[] = [];
    const base = { instanceDir: a, env: {}, platform: "linux" as const, keychain: kc, instances: [a, b], out: (l: string) => lines.push(l) };

    const preview = await purgeShared({ ...base, yes: true });
    expect(preview.removable).toEqual([]);
    expect(preview.kept.map((k) => [k.name, k.missingIn])).toContainEqual(["METISTRY_DEVIN_API_KEY", [b]]);
    expect(kc.ops.filter((o) => o.op === "delete")).toEqual([]);

    await migrateScope(opts(b, ID_B, kc));
    const dry = await purgeShared(base);
    expect(dry.removable.sort()).toEqual(["METISTRY_AWS_SECRET_ACCESS_KEY", "METISTRY_DEVIN_API_KEY", "METISTRY_LOCAL_API_KEY"]);
    expect(dry.deleted).toEqual([]);
    expect(kc.ops.filter((o) => o.op === "delete")).toEqual([]);
    expect(lines.join("\n")).toContain("preview only");

    const r = await purgeShared({ ...base, yes: true });
    expect(r.deleted.sort()).toEqual(dry.removable.sort());
    for (const d of kc.ops.filter((o) => o.op === "delete")) expect(d.account).toBe(USER);
    // both instances still hold their copies
    expect(await kc.value(named("devin_api_key"), ID_A)).toBe("devin-SHARED-original");
    expect(await kc.value(named("devin_api_key"), ID_B)).toBe("devin-SHARED-original");
    expect(await kc.value(svc("METISTRY_DEVIN_API_KEY"), USER)).toBeUndefined();
  });

  it("an instance with no instance_id holds no copy of anything, so it keeps every original", async () => {
    const kc = keychain(ORIGINALS, { allowDelete: true });
    const a = await instance(ID_A, "noid-a");
    const b = await instance(undefined, "noid-b");
    await migrateScope(opts(a, ID_A, kc));
    const r = await purgeShared({ instanceDir: a, env: {}, platform: "linux", keychain: kc, instances: [a, b], out: () => {}, yes: true });
    expect(r.removable).toEqual([]);
    expect(r.deleted).toEqual([]);
    expect(kc.ops.filter((o) => o.op === "delete")).toEqual([]);
  });

  it("refuses when an instance's id is the per-user account itself", async () => {
    const kc = keychain(ORIGINALS, { allowDelete: true });
    const a = await instance(ID_A, "refuse");
    await expect(purgeShared({ instanceDir: a, env: { METISTRY_KEYCHAIN_ACCOUNT: ID_A }, platform: "linux", keychain: kc, instances: [a], out: () => {}, yes: true })).rejects.toThrow(/refusing/);
    expect(kc.ops.filter((o) => o.op === "delete")).toEqual([]);
  });

  it("knows the instances a Metistry LaunchAgent runs, plus the current one", async () => {
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    await mkdir(join(home, "Library/LaunchAgents"), { recursive: true });
    const plist = (dir: string) => `<plist><dict><key>EnvironmentVariables</key><dict><key>METISTRY_INSTANCE_DIR</key><string>${dir}</string></dict></dict></plist>`;
    await writeFile(join(home, "Library/LaunchAgents/com.foldedspacelabs.metistry.plist"), plist("/i/first"));
    await writeFile(join(home, "Library/LaunchAgents/com.foldedspacelabs.metistry.abc.reconciler.plist"), plist("/i/second &amp; more/"));
    await writeFile(join(home, "Library/LaunchAgents/com.other.plist"), plist("/i/not-ours"));
    expect(await knownInstanceDirs("/i/current/", home)).toEqual(["/i/current", "/i/second & more", "/i/first"]);
  });
});

describe("the doctor row: presence only", () => {
  it("degraded with the exact migrate-scope command while an original has no copy here; then with purge-shared; then no finding", async () => {
    const kc = keychain(ORIGINALS, { allowDelete: true });
    const dir = await instance(ID_A, "doctor");
    const probe = (s: string, a: string) => kc.has(s, a);
    const product = await mkdtemp(join(tmpdir(), "metistry-product-"));

    const before = await sharedScopeRow({ instanceDir: dir, productDir: product, env: {}, probe });
    expect(before?.status).toBe("degraded");
    expect(before?.remediation).toContain(`metistry secrets migrate-scope --instance ${dir}`);
    expect(kc.ops.filter((o) => o.op !== "has")).toEqual([]);
    // T4-21: argv the app can run directly, without needing --instance (the
    // CLI reads METISTRY_INSTANCE_DIR the same way every other verb does)
    expect(before?.action).toEqual({ kind: "run_verb", command: ["metistry", "secrets", "migrate-scope"], label: "Run secrets migrate-scope" });

    await migrateScope(opts(dir, ID_A, kc));
    const copied = await sharedScopeRow({ instanceDir: dir, productDir: product, env: {}, probe });
    expect(copied?.status).toBe("degraded");
    expect(copied?.remediation).toContain("metistry secrets purge-shared");
    expect(copied?.action).toEqual({ kind: "run_verb", command: ["metistry", "secrets", "purge-shared"], label: "Preview secrets purge-shared" });

    await purgeShared({ instanceDir: dir, env: {}, platform: "linux", keychain: kc, instances: [dir], out: () => {}, yes: true });
    expect((await sharedScopeRow({ instanceDir: dir, productDir: product, env: {}, probe }))?.status).toBe("ok");
    expect(await sharedScopeStatus({ instanceDir: dir, instanceId: undefined, env: {}, probe })).toBeUndefined();
    expect(await sharedScopeRow({ instanceDir: await instance(undefined, "doctor-noid"), productDir: product, env: {}, probe })).toBeUndefined();
  });
});

describe("metistry update runs it, and can never be failed by it", () => {
  const runner = (dryRun = false) => {
    const lines: string[] = [];
    return { r: new StepRunner({ dryRun, out: (l) => lines.push(l), exec: fakeExec(), env: {} }), lines };
  };
  const base = (dir: string) => ({ instanceDir: dir, envFile: join(dir, ".metistry/state/.env"), exampleFile: "/nonexistent/.env.example", env: {}, platform: "linux" as const, uid: 501, fetchFn: fetch });

  it("a dry run asks the Keychain nothing and prints the command", async () => {
    const kc = keychain();
    const dir = await instance(ID_A, "upd-dry");
    const { r, lines } = runner(true);
    expect(await updateSharedScope(r, { ...base(dir), keychain: kc })).toBeUndefined();
    expect(kc.ops).toEqual([]);
    expect(lines.join("\n")).toContain(`metistry secrets migrate-scope --instance ${dir}`);
  });

  it("an instance with no id, or no Keychain, gets the command and no error", async () => {
    const { r, lines } = runner();
    expect(await updateSharedScope(r, { ...base(await instance(undefined, "upd-noid")), keychain: keychain() })).toBeUndefined();
    expect(await updateSharedScope(r, { ...base(await instance(ID_A, "upd-nokc")) })).toBeUndefined();
    expect(lines.join("\n")).toContain("metistry secrets migrate-scope --instance");
    expect(lines.join("\n")).toContain("no login Keychain");
  });

  it("a Keychain that throws is a note naming the command — never a failed update", async () => {
    const broken: KeychainBackend = {
      async has() {
        throw new Error("keychain locked");
      },
      async get() {
        throw new Error("keychain locked");
      },
      async set() {
        throw new Error("keychain locked");
      },
      async delete() {
        throw new Error("never");
      },
    };
    const { r, lines } = runner();
    const dir = await instance(ID_A, "upd-broken");
    expect(await updateSharedScope(r, { ...base(dir), keychain: broken })).toBeUndefined();
    expect(lines.join("\n")).toContain("the update is unaffected");
    expect(lines.join("\n")).toContain(`metistry secrets migrate-scope --instance ${dir}`);
  });

  it("a full `metistry update` copies the originals into the instance, deletes nothing, and still exits 0", async () => {
    const P = await checkout({ git: true });
    const inst = await instance(ID_A, "upd-full");
    const kc = keychain();
    const r = await update({
      productDir: P,
      env: { METISTRY_INSTANCE_DIR: inst },
      platform: "darwin",
      uid: 501,
      version: "0.0.9",
      out: () => {},
      cliShim: false,
      exec: fakeExec(),
      skipMigrate: true,
      fetchFn: fetch,
      doctorFn: okDoctor,
      keychain: kc,
    });
    expect(r.code).toBe(0);
    expect(r.sharedScope?.copied.map((c) => c.to).sort()).toEqual(["aws_secret_access_key", "devin_api_key", "local_api_key"]);
    expect(await kc.value(named("devin_api_key"), ID_A)).toBe("devin-SHARED-original");
    expect(kc.ops.filter((o) => o.op === "delete")).toEqual([]);
  });
});

/** A fake `security`, for the verbs driven through `main()` exactly as a terminal would. */
function fakeSecurity(seed: Record<string, string>) {
  const store = new Map(Object.entries(seed));
  const calls: Array<{ args: string[] }> = [];
  const exec: Exec = async (cmd, args, o: ExecOptions = {}) => {
    calls.push({ args });
    if (cmd !== "security") return { code: 127, stdout: "", stderr: `${cmd}: not faked` };
    const at = `${args[args.indexOf("-a") + 1] ?? ""}/${args[args.indexOf("-s") + 1] ?? ""}`;
    if (args[0] === "add-generic-password") {
      const [x, y] = String(o.stdin ?? "").split("\n");
      if (x === undefined || x !== y) return { code: 1, stdout: "", stderr: "mismatch" };
      store.set(at, x);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") {
      if (!store.has(at)) return { code: 44, stdout: "", stderr: "not found" };
      return { code: 0, stdout: args.includes("-w") ? `${store.get(at)}\n` : "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args[0]}` };
  };
  return { exec, store, calls };
}

describe("through main(), as the owner runs it", () => {
  it("`metistry secrets migrate-scope --instance <dir>` copies, prints no value, and `purge-shared` previews", async () => {
    const kc = fakeSecurity({ [`${USER}/${svc("METISTRY_DEVIN_API_KEY")}`]: "devin-SHARED-original" });
    // the instance's .env is loaded into the environment by main(), so it
    // carries nothing but a db host; the NAME comes from .env.example
    const dir = await instance(ID_A, "main", "METISTRY_DB_HOST=127.0.0.1\n");
    const product = await mkdtemp(join(tmpdir(), "metistry-product-"));
    await writeFile(join(product, ".env.example"), "# METISTRY_DEVIN_API_KEY=\n");
    const out: string[] = [];
    const run = (argv: string[]) => main([...argv, "--product-dir", product], { out: (s) => out.push(s), err: (s) => out.push(s), exec: kc.exec, platform: "darwin", uid: 501 });
    expect(await run(["secrets", "migrate-scope", "--instance", dir])).toBe(0);
    expect(kc.store.get(`${ID_A}/${named("devin_api_key")}`)).toBe("devin-SHARED-original");
    expect(kc.calls.some((c) => c.args[0] === "delete-generic-password")).toBe(false);
    expect(out.join("\n")).toContain("copied METISTRY_DEVIN_API_KEY → devin_api_key");
    expect(out.join("\n")).not.toContain("devin-SHARED-original");

    // HOME pointed at an empty scratch dir: the verb discovers instances from
    // ~/Library/LaunchAgents, and a test must never read this Mac's real ones
    const home = process.env.HOME;
    process.env.HOME = await mkdtemp(join(tmpdir(), "metistry-home-"));
    try {
      expect(await run(["secrets", "purge-shared", "--instance", dir])).toBe(0);
    } finally {
      process.env.HOME = home;
    }
    expect(out.join("\n")).toContain("preview only");
    expect(kc.store.has(`${USER}/${svc("METISTRY_DEVIN_API_KEY")}`)).toBe(true);
  });
});
