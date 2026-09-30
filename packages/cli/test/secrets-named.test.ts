// `metistry secrets set|replace|remove|hosts|grant` and `list --named` — the
// owner-named secrets of plan §2.14 (T4-1), driven through `main()` exactly
// as the Mac app drives them, against a fake `security` (never the login
// Keychain) and scratch instance directories under the OS temp dir.
//
// The bold test is the isolation one: two instances on one Mac share one
// Keychain, and even when the second's secrets.yaml names the first's secret
// word for word, the second can neither see, read, overwrite nor delete the
// first's item — every `security` call it makes is addressed to its own
// account.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSecretsFile } from "@foldedspacelabs/metistry-core";
import type { Exec, ExecOptions } from "../src/exec.js";
import { main } from "../src/main.js";
import { parseSecretHosts, purgeSecrets, secretReferences, secretsListNamed, secretsSet } from "../src/secrets.js";
import { decodeSecurity } from "./fake-security.js";

const ID_A = "11111111-2222-4333-8444-555555555555";
const ID_B = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const VALUE_A = "ghp_A-SENTINEL-never-printed";
const VALUE_B = "ghp_B-other-instance";

/** A Keychain in a Map keyed `<account>/<service>`, answering `security` the way the real one does. Records every call. */
function fakeSecurity(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const calls: Array<{ args: string[]; argv: string[]; opts: ExecOptions }> = [];
  const exec: Exec = async (cmd, argv, opts = {}) => {
    const { args, value } = cmd === "security" ? decodeSecurity(argv, opts) : { args: argv, value: undefined };
    calls.push({ args, argv, opts });
    if (cmd !== "security") return { code: 127, stdout: "", stderr: `${cmd}: not faked` };
    const at = `${args[args.indexOf("-a") + 1] ?? ""}/${args[args.indexOf("-s") + 1] ?? ""}`;
    if (args[0] === "add-generic-password") {
      if (value === undefined) return { code: 1, stdout: "", stderr: "add-generic-password: no -w value on the security -i line" };
      store.set(at, value);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") {
      if (!store.has(at)) return { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
      return { code: 0, stdout: args.includes("-w") ? `${store.get(at)}\n` : "", stderr: "" };
    }
    if (args[0] === "delete-generic-password") {
      if (!store.has(at)) return { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
      store.delete(at);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args[0]}` };
  };
  const accountsAsked = () => calls.filter((c) => c.args[0]?.endsWith("generic-password")).map((c) => c.args[c.args.indexOf("-a") + 1]);
  return { exec, store, calls, accountsAsked };
}

const item = (id: string, name: string) => `${id}/metistry:secret:${name}`;

/** A scratch instance: `.metistry/identity.yaml` with an id, nothing else — no reconciler, so a protected write lands directly. */
async function instance(id: string | undefined, label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `metistry-secrets-${label}-`));
  await mkdir(join(dir, ".metistry"), { recursive: true });
  await writeFile(join(dir, ".metistry/identity.yaml"), `name: Aide\n${id ? `instance_id: "${id}"\n` : ""}`);
  return dir;
}

/** `main()` with the fake Keychain, darwin, a value on "stdin", and every line of output captured. */
async function run(argv: string[], kc: ReturnType<typeof fakeSecurity>, stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), exec: kc.exec, platform: "darwin", uid: 501, readStdin: async () => stdin });
  return { code, out: out.join("\n"), err: err.join("\n"), all: [...out, ...err].join("\n") };
}

const secretsYaml = (dir: string) => readFileSync(join(dir, ".metistry/secrets.yaml"), "utf8");

describe("**one instance can never read another's item** (through the CLI)", () => {
  it("B's secrets.yaml naming A's secret word for word still reaches only B's account: absent, then B's own, and A's is never touched", async () => {
    const kc = fakeSecurity();
    const a = await instance(ID_A, "a");
    const b = await instance(ID_B, "b");

    expect((await run(["secrets", "set", "github_write", "--hosts", "api.github.com", "--instance", a], kc, VALUE_A)).code).toBe(0);
    expect(kc.store.get(item(ID_A, "github_write"))).toBe(VALUE_A);

    // the worst case: B's policy file is a copy of A's, so B believes it has the secret
    await writeFile(join(b, ".metistry/secrets.yaml"), secretsYaml(a));
    kc.calls.length = 0;

    const listed = await run(["secrets", "list", "--named", "--json", "--instance", b], kc);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out).secrets).toEqual([{ name: "github_write", hosts: ["api.github.com"], grants: [], expires: null, present: false, last_used: null }]);

    // replace writes B's OWN item; A's value is untouched
    expect((await run(["secrets", "replace", "github_write", "--instance", b], kc, VALUE_B)).code).toBe(0);
    expect(kc.store.get(item(ID_B, "github_write"))).toBe(VALUE_B);
    expect(kc.store.get(item(ID_A, "github_write"))).toBe(VALUE_A);

    // remove deletes B's item alone
    expect((await run(["secrets", "remove", "github_write", "--yes", "--instance", b], kc)).code).toBe(0);
    expect(kc.store.has(item(ID_B, "github_write"))).toBe(false);
    expect(kc.store.get(item(ID_A, "github_write"))).toBe(VALUE_A);

    // and every Keychain call B's verbs made was addressed to B's account — never A's, never the per-user one
    expect(kc.accountsAsked().length).toBeGreaterThan(0);
    expect(new Set(kc.accountsAsked())).toEqual(new Set([ID_B]));
  });

  it("an instance with no instance_id gets no account at all — no fallback to a shared one", async () => {
    const kc = fakeSecurity();
    const old = await instance(undefined, "no-id");
    const r = await run(["secrets", "set", "github_write", "--instance", old], kc, VALUE_A);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no instance_id/);
    expect(kc.calls).toEqual([]);
    expect(existsSync(join(old, ".metistry/secrets.yaml"))).toBe(false);
  });
});

describe("metistry secrets set", () => {
  it("stores the value from stdin under this instance's account, the policy in secrets.yaml — and the value is in no argv and no output", async () => {
    const kc = fakeSecurity();
    const a = await instance(ID_A, "set");
    const r = await run(["secrets", "set", "github_write", "--hosts", "API.github.com,uploads.github.com", "--expires", "2026-12-31", "--instance", a], kc, `${VALUE_A}\n`);
    expect(r.code).toBe(0);
    expect(kc.store.get(item(ID_A, "github_write"))).toBe(VALUE_A);
    expect(parseSecretsFile(secretsYaml(a)).secrets.github_write).toEqual({ hosts: ["api.github.com", "uploads.github.com"], grants: {}, expires: "2026-12-31" });
    expect(secretsYaml(a)).toContain("hosts: [ api.github.com, uploads.github.com ]");
    expect(secretsYaml(a)).not.toContain(VALUE_A);
    expect(r.all).not.toContain(VALUE_A);
    expect(r.all).toContain("metistry:secret:github_write");
    for (const c of kc.calls) expect(c.argv.join(" ")).not.toContain(VALUE_A);
    const add = kc.calls.find((c) => c.args[0] === "add-generic-password")!;
    // `security -i`: the process argv is that one flag, and the whole command — value included — is the line on stdin
    expect(add.argv).toEqual(["-i"]);
    expect(add.args).toEqual(["add-generic-password", "-U", "-a", ID_A, "-s", "metistry:secret:github_write", "-w", VALUE_A]);
    expect(add.opts.stdin).toBe(`"add-generic-password" "-U" "-a" "${ID_A}" "-s" "metistry:secret:github_write" "-w" "${VALUE_A}"\n`);
  });

  it("--json prints the result — names, never the value", async () => {
    const kc = fakeSecurity();
    const a = await instance(ID_A, "set-json");
    const r = await run(["secrets", "set", "k", "--json", "--instance", a], kc, VALUE_A);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out);
    expect(body).toMatchObject({ name: "k", service: "metistry:secret:k", account: ID_A, hosts: [] });
    expect(r.out).not.toContain(VALUE_A);
    expect(r.err).toMatch(/no hosts/);
  });

  it("refuses a second set, a bad name, a bad host, an empty value and a bad expiry — and stores nothing", async () => {
    const kc = fakeSecurity();
    const a = await instance(ID_A, "set-refusals");
    expect((await run(["secrets", "set", "k", "--instance", a], kc, VALUE_A)).code).toBe(0);
    const before = new Map(kc.store);
    const file = secretsYaml(a);

    const again = await run(["secrets", "set", "k", "--instance", a], kc, VALUE_B);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already set .* secrets replace k/);
    for (const [argv, why] of [
      [["secrets", "set", "GitHub"], /not a secret name/],
      [["secrets", "set", "x:y"], /not a secret name/],
      [["secrets", "set"], /not a secret name/],
      [["secrets", "set", "h", "--hosts", "https://api.github.com/"], /not a host/],
      [["secrets", "set", "h", "--hosts", "*.github.com"], /not a host/],
      [["secrets", "set", "h", "--expires", "soon"], /not an ISO date/],
    ] as const) {
      const r = await run([...argv, "--instance", a], kc, VALUE_B);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err, argv.join(" ")).toMatch(why);
    }
    const empty = await run(["secrets", "set", "e", "--instance", a], kc, "   ");
    expect(empty.err).toMatch(/cannot be empty/);
    expect(kc.store).toEqual(before);
    expect(secretsYaml(a)).toBe(file);
  });

  it("refuses on a host with no Keychain, before reading a value", async () => {
    const a = await instance(ID_A, "linux");
    const out: string[] = [];
    let asked = false;
    const code = await main(["secrets", "set", "k", "--instance", a], { out: (s) => out.push(s), err: (s) => out.push(s), platform: "linux", readStdin: async () => ((asked = true), VALUE_A) });
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/login Keychain, which this host \(linux\) does not have/);
    expect(asked).toBe(false);
  });

  it("--dry-run touches neither the Keychain nor the file", async () => {
    const kc = fakeSecurity();
    const a = await instance(ID_A, "dry");
    const r = await run(["secrets", "set", "k", "--dry-run", "--instance", a], kc, VALUE_A);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[dry-run\] would store k/);
    expect(kc.store.size).toBe(0);
    expect(existsSync(join(a, ".metistry/secrets.yaml"))).toBe(false);
  });
});

describe("metistry secrets replace, hosts, grant", () => {
  it("replace swaps the value, keeps the policy, clears an expiry that was the old value's — and refuses a secret this instance does not have", async () => {
    const kc = fakeSecurity();
    const a = await instance(ID_A, "replace");
    await run(["secrets", "set", "k", "--hosts", "x.test", "--expires", "2026-10-01", "--instance", a], kc, VALUE_A);
    const r = await run(["secrets", "replace", "k", "--instance", a], kc, VALUE_B);
    expect(r.code).toBe(0);
    expect(kc.store.get(item(ID_A, "k"))).toBe(VALUE_B);
    expect(parseSecretsFile(secretsYaml(a)).secrets.k).toEqual({ hosts: ["x.test"], grants: {} });
    expect(r.all).toMatch(/cleared the old expiry \(2026-10-01\)/);
    expect(r.all).not.toContain(VALUE_B);

    const unknown = await run(["secrets", "replace", "nope", "--instance", a], kc, VALUE_B);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/no secret named nope .* secrets set nope/);
  });

  it("hosts shows, replaces and clears *Sent only to*, and keeps the owner's comments", async () => {
    const kc = fakeSecurity();
    const a = await instance(ID_A, "hosts");
    await writeFile(join(a, ".metistry/secrets.yaml"), "# my secrets — kept by hand too\nsecrets:\n  k: # the deploy key\n    hosts: [old.test]\n");
    expect((await run(["secrets", "hosts", "k", "--instance", a], kc)).out).toContain("old.test");
    expect((await run(["secrets", "hosts", "k", "a.test", "B.test:8443", "a.test", "--instance", a], kc)).code).toBe(0);
    expect(parseSecretsFile(secretsYaml(a)).secrets.k?.hosts).toEqual(["a.test", "b.test:8443"]);
    expect(secretsYaml(a)).toContain("# my secrets — kept by hand too");
    expect(secretsYaml(a)).toContain("# the deploy key");
    expect((await run(["secrets", "hosts", "k", "--clear", "--instance", a], kc)).code).toBe(0);
    expect(parseSecretsFile(secretsYaml(a)).secrets.k?.hosts).toEqual([]);
    const both = await run(["secrets", "hosts", "k", "a.test", "--clear", "--instance", a], kc);
    expect(both.err).toMatch(/not both/);
    const bad = await run(["secrets", "hosts", "k", "https://a.test", "--instance", a], kc);
    expect(bad.err).toMatch(/not a host/);
    // none of this touched the Keychain (the only subprocess is the "is a reconciler running?" probe before a direct write)
    expect(kc.accountsAsked()).toEqual([]);
  });

  it("grant records On · Ask · Off per connection and actor, and refuses anything else", async () => {
    const kc = fakeSecurity();
    const a = await instance(ID_A, "grant");
    await run(["secrets", "set", "k", "--instance", a], kc, VALUE_A);
    expect((await run(["secrets", "grant", "k", "connection:github", "on", "--instance", a], kc)).code).toBe(0);
    expect((await run(["secrets", "grant", "k", "agent:devin", "ask", "--instance", a], kc)).code).toBe(0);
    expect(parseSecretsFile(secretsYaml(a)).secrets.k?.grants).toEqual({ "connection:github": "on", "agent:devin": "ask" });
    for (const [argv, why] of [
      [["secrets", "grant", "k", "github", "on"], /not a grantee/],
      [["secrets", "grant", "k", "agent:devin", "always"], /one of on, ask, off/],
      [["secrets", "grant", "nope", "agent:devin", "on"], /no secret named nope/],
    ] as const) {
      const r = await run([...argv, "--instance", a], kc);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err, argv.join(" ")).toMatch(why);
    }
    const listed = JSON.parse((await run(["secrets", "list", "--named", "--json", "--instance", a], kc)).out);
    expect(listed.secrets[0].grants).toEqual([
      { to: "connection:github", mode: "on" },
      { to: "agent:devin", mode: "ask" },
    ]);
  });

  it("**refuses granting github_write to a connection or an agent; the owner door still reads it** (X-41)", async () => {
    const kc = fakeSecurity();
    const a = await instance(ID_A, "grant-owner-door");
    await run(["secrets", "set", "github_write", "--hosts", "api.github.com", "--instance", a], kc, VALUE_A);
    for (const [grantee, mode] of [
      ["connection:github", "on"],
      ["agent:devin", "ask"],
      ["agent:devin", "off"],
    ] as const) {
      const r = await run(["secrets", "grant", "github_write", grantee, mode, "--instance", a], kc);
      expect(r.code, `${grantee} ${mode}`).toBe(1);
      expect(r.err, `${grantee} ${mode}`).toMatch(/owner-door secret/);
    }
    // nothing was written: no grants line, and the value is untouched
    expect(parseSecretsFile(secretsYaml(a)).secrets.github_write).toEqual({ hosts: ["api.github.com"], grants: {}, expires: undefined });
    const listed = JSON.parse((await run(["secrets", "list", "--named", "--json", "--instance", a], kc)).out);
    expect(listed.secrets).toEqual([{ name: "github_write", hosts: ["api.github.com"], grants: [], expires: null, present: true, last_used: null }]);
    // the owner door still reads it: an ordinary secret grant on the same instance is unaffected
    expect((await run(["secrets", "grant", "github_write", "connection:github", "on", "--instance", a], kc)).err).toMatch(/owner-door secret/);
    expect((await run(["secrets", "set", "other", "--instance", a], kc, VALUE_B)).code).toBe(0);
    expect((await run(["secrets", "grant", "other", "connection:github", "on", "--instance", a], kc)).code).toBe(0);
  });
});

describe("metistry secrets remove", () => {
  it("previews, naming what references it, and deletes nothing without --yes; with --yes removes the item and the line", async () => {
    const kc = fakeSecurity();
    const a = await instance(ID_A, "remove");
    await run(["secrets", "set", "github_write", "--hosts", "api.github.com", "--instance", a], kc, VALUE_A);
    await run(["secrets", "set", "other", "--instance", a], kc, VALUE_B);
    await mkdir(join(a, ".metistry/connections"), { recursive: true });
    await writeFile(join(a, ".metistry/connections/github.yaml"), "auth: { secret: \"{{ secret.github_write }}\" }\n");
    await mkdir(join(a, ".metistry/state"), { recursive: true });
    await writeFile(join(a, ".metistry/state/cache.yaml"), "x: {{ secret.github_write }}\n"); // derived state is not a reference

    const preview = await run(["secrets", "remove", "github_write", "--instance", a], kc);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain(".metistry/connections/github.yaml");
    expect(preview.out).not.toContain("state/cache.yaml");
    expect(preview.out).toMatch(/preview only/);
    expect(kc.store.has(item(ID_A, "github_write"))).toBe(true);
    expect(parseSecretsFile(secretsYaml(a)).secrets.github_write).toBeDefined();

    const done = await run(["secrets", "remove", "github_write", "--yes", "--instance", a], kc);
    expect(done.code).toBe(0);
    expect(kc.store.has(item(ID_A, "github_write"))).toBe(false);
    expect(kc.store.get(item(ID_A, "other"))).toBe(VALUE_B);
    expect(Object.keys(parseSecretsFile(secretsYaml(a)).secrets)).toEqual(["other"]);

    const gone = await run(["secrets", "remove", "github_write", "--yes", "--instance", a], kc);
    expect(gone.code).toBe(1);
    expect(gone.err).toMatch(/no secret named github_write/);
  });

  it("finds references in any text file under .metistry/", async () => {
    const a = await instance(ID_A, "refs");
    await mkdir(join(a, ".metistry/extensions/x"), { recursive: true });
    await writeFile(join(a, ".metistry/compute.yaml"), "providers: { p: { auth: { secret: '{{ secret.k }}' } } }\n");
    await writeFile(join(a, ".metistry/extensions/x/manifest.yaml"), "env: { K: '{{secret.k}}' }\n");
    await writeFile(join(a, ".metistry/extensions/x/notes.md"), "{{ secret.kk }} is a different one\n");
    expect(await secretReferences(a, "k")).toEqual([".metistry/compute.yaml", ".metistry/extensions/x/manifest.yaml"]);
  });
});

describe("the install's own variables keep working beside the named secrets", () => {
  it("purge --yes deletes this instance's named items too, and only this instance's", async () => {
    const kc = fakeSecurity();
    const a = await instance(ID_A, "purge-a");
    const b = await instance(ID_B, "purge-b");
    await run(["secrets", "set", "k", "--instance", a], kc, VALUE_A);
    await run(["secrets", "set", "k", "--instance", b], kc, VALUE_B);
    const envFile = join(a, ".metistry/state/.env");
    await mkdir(join(a, ".metistry/state"), { recursive: true });
    await writeFile(envFile, "", { mode: 0o600 });

    const preview = await purgeSecrets({ envFile, instanceDir: a, exec: kc.exec, out: () => {}, platform: "darwin", env: {}, instanceId: ID_A });
    expect(preview.named).toEqual(["k"]);
    expect(preview.namedDeleted).toEqual([]);
    expect(kc.store.has(item(ID_A, "k"))).toBe(true);

    const r = await purgeSecrets({ envFile, instanceDir: a, exec: kc.exec, out: () => {}, platform: "darwin", env: {}, instanceId: ID_A, yes: true });
    expect(r.namedDeleted).toEqual(["k"]);
    expect(kc.store.has(item(ID_A, "k"))).toBe(false);
    expect(kc.store.get(item(ID_B, "k"))).toBe(VALUE_B);
  });

  it("`secrets list` without --named is still the install variables' table, and `list --named` never runs `security -w`", async () => {
    const kc = fakeSecurity();
    const a = await instance(ID_A, "list");
    await run(["secrets", "set", "k", "--instance", a], kc, VALUE_A);
    kc.calls.length = 0;
    const named = await run(["secrets", "list", "--named", "--instance", a], kc);
    expect(named.out).toMatch(/^name\s+keychain/m);
    expect(named.out).not.toContain(VALUE_A);
    for (const c of kc.calls) expect(c.args).not.toContain("-w");
    // the function the console shares: presence only, rows only
    const rows = await secretsListNamed({ instanceDir: a, instanceId: ID_A, env: {}, platform: "darwin", uid: 501, exec: kc.exec, out: () => {} });
    expect(rows.map((r) => [r.name, r.present])).toEqual([["k", true]]);
  });

  it("unknown sub-verbs still print the usage", async () => {
    const kc = fakeSecurity();
    const a = await instance(ID_A, "usage");
    const r = await run(["secrets", "frobnicate", "--instance", a, "--env-file", join(a, "none.env")], kc);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/set\|replace\|remove\|hosts\|grant/);
  });
});

describe("parseSecretHosts", () => {
  it("normalises, deduplicates and refuses what is not a host", () => {
    expect(parseSecretHosts(["API.github.com", "api.github.com", "x.test:8443"])).toEqual(["api.github.com", "x.test:8443"]);
    expect(() => parseSecretHosts(["api.github.com/v3"])).toThrow(/not a host/);
  });

  it("secretsSet through a memory Keychain seam never needs `security`", async () => {
    const { memoryKeychain } = await import("@foldedspacelabs/metistry-core");
    const kc = memoryKeychain();
    const a = await instance(ID_A, "seam");
    await secretsSet("k", { hosts: ["x.test"] }, { instanceDir: a, instanceId: ID_A, env: {}, platform: "linux", uid: 501, keychain: kc, readSecret: async () => VALUE_A, out: () => {} });
    expect(kc.items()).toEqual([{ service: "metistry:secret:k", account: ID_A }]);
  });
});
