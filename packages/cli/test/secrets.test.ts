// `metistry secrets`: a full round trip through a fake login Keychain and
// a temp `.env`. The assertions that matter are the conservative ones —
// every non-secret line survives byte-for-byte, the file comes back 0600,
// values travel on stdin rather than argv, and `list` cannot print one.
import { statSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec, ExecOptions } from "../src/exec.js";
import { promptStdin } from "../src/keychain.js";
import { main } from "../src/main.js";
import { accountFor, DEFAULT_SCOPE, isSecretVar, listSecrets, mintSecret, purgeSecrets, renderSecretList, rewriteEnv, scopeFor, scopeReason, SECRET_SCOPES, syncSecrets } from "../src/secrets.js";

/** One instance's id — the account its own secrets are filed under. */
const INSTANCE_ID = "11111111-2222-4333-8444-555555555555";

const ENV_TEXT = `# Metistry environment — copy to .env and fill in.

# --- database ---
METISTRY_DB_HOST=127.0.0.1
METISTRY_DB_PASSWORD=change-me

# --- compute: the engine's provider key (docs/ops/compute.md) ---
# Named by compute.yaml's providers.<name>.auth.secret; never bake into an image.
METISTRY_OPENROUTER_API_KEY=sk-or-v1-EXAMPLE

# Web push (PoC-6). The subject must be a REAL mailto: contact.
METISTRY_VAPID_PUBLIC=BPublicKeyIsNotASecret
METISTRY_VAPID_PRIVATE=vapid-private-EXAMPLE
METISTRY_VAPID_SUBJECT=mailto:someone@example.com

# not set yet — a commented declaration, which is where the name is documented
# METISTRY_GITHUB_TOKEN=
METISTRY_GITHUB_REPOS=owner/repo
`;

/** A Keychain item is an (account, service) pair — the scoping this whole feature turns on. */
const key = (account: string, name: string) => `${account}/metistry:${name}`;
const USER = "metistry";

/** A Keychain in a Map, keyed by account AND service. Records every call so the tests can prove argv never carried a value. */
function fakeSecurity(seed: Record<string, string> = {}): { exec: Exec; store: Map<string, string>; calls: Array<{ args: string[]; opts: ExecOptions }> } {
  const store = new Map(Object.entries(seed));
  const calls: Array<{ args: string[]; opts: ExecOptions }> = [];
  const exec: Exec = async (cmd, args, opts = {}) => {
    calls.push({ args, opts });
    if (cmd !== "security") return { code: 127, stdout: "", stderr: "not security" };
    const at = `${args[args.indexOf("-a") + 1] ?? ""}/${args[args.indexOf("-s") + 1] ?? ""}`;
    if (args[0] === "add-generic-password") {
      const [a, b] = String(opts.stdin ?? "").split("\n");
      if (a === undefined || a !== b) return { code: 1, stdout: "", stderr: "passwords don't match" };
      store.set(at, a);
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
  return { exec, store, calls };
}

async function envFile(text = ENV_TEXT): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-secrets-"));
  const file = join(dir, ".env");
  await writeFile(file, text, { mode: 0o600 });
  return file;
}

describe("isSecretVar", () => {
  it("catches the secret-shaped names and leaves the public ones alone", () => {
    for (const n of ["METISTRY_DB_PASSWORD", "METISTRY_GITHUB_TOKEN", "METISTRY_VAPID_PRIVATE", "METISTRY_ASSISTANT_TOKEN", "METISTRY_AWS_SECRET_ACCESS_KEY", "METISTRY_BRIDGE_TOKEN_RECONCILER", "METISTRY_OPENROUTER_API_KEY"]) {
      expect(isSecretVar(n), n).toBe(true);
    }
    for (const n of ["METISTRY_VAPID_PUBLIC", "METISTRY_VAPID_SUBJECT", "METISTRY_DB_HOST", "METISTRY_GITHUB_REPOS", "METISTRY_GITHUB_OAUTH_CLIENT_ID", "METISTRY_AWS_ACCESS_KEY_ID"]) {
      expect(isSecretVar(n), n).toBe(false);
    }
  });
});

describe("metistry secrets sync", () => {
  it("round-trips .env → Keychain → .env, preserving every other line byte-for-byte", async () => {
    const file = await envFile();
    const kc = fakeSecurity();
    const lines: string[] = [];
    const opts = { envFile: file, exec: kc.exec, out: (l: string) => lines.push(l), platform: "darwin" as const, env: {} };

    const imported = await syncSecrets("keychain", opts);
    expect(imported.changed).toEqual(["METISTRY_DB_PASSWORD", "METISTRY_OPENROUTER_API_KEY", "METISTRY_VAPID_PRIVATE"]);
    expect(imported.skipped).toEqual(["METISTRY_GITHUB_TOKEN"]); // declared but commented out, so nothing to import
    expect(Object.fromEntries(kc.store)).toEqual({
      [key(USER, "METISTRY_DB_PASSWORD")]: "change-me",
      [key(USER, "METISTRY_OPENROUTER_API_KEY")]: "sk-or-v1-EXAMPLE",
      [key(USER, "METISTRY_VAPID_PRIVATE")]: "vapid-private-EXAMPLE",
    });
    // importing never touches the file
    expect(readFileSync(file, "utf8")).toBe(ENV_TEXT);
    // and never puts a value on a command line
    for (const c of kc.calls) for (const a of c.args) expect(a).not.toContain("change-me");

    // now rotate one in the Keychain and regenerate .env from it
    kc.store.set(key(USER, "METISTRY_DB_PASSWORD"), "rotated-in-the-keychain");
    const back = await syncSecrets("env", opts);
    expect(back.changed.sort()).toEqual(["METISTRY_DB_PASSWORD", "METISTRY_OPENROUTER_API_KEY", "METISTRY_VAPID_PRIVATE"]);
    expect(back.skipped).toEqual(["METISTRY_GITHUB_TOKEN"]);

    const after = readFileSync(file, "utf8");
    expect(after).toBe(ENV_TEXT.replace("METISTRY_DB_PASSWORD=change-me", "METISTRY_DB_PASSWORD=rotated-in-the-keychain"));
    // every comment, blank line and non-secret assignment is identical
    const untouched = (t: string) => t.split("\n").filter((l) => !l.startsWith("METISTRY_DB_PASSWORD="));
    expect(untouched(after)).toEqual(untouched(ENV_TEXT));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("appends a secret .env never declared (the name comes from .env.example) under one marker", async () => {
    const file = await envFile("METISTRY_DB_HOST=127.0.0.1\n");
    const example = join(file, "..", ".env.example");
    await writeFile(example, "METISTRY_DB_HOST=\n# METISTRY_ASSISTANT_TOKEN=\n");
    const kc = fakeSecurity({ [key(USER, "METISTRY_ASSISTANT_TOKEN")]: "tok" });
    await syncSecrets("env", { envFile: file, exampleFile: example, exec: kc.exec, out: () => {}, platform: "darwin", env: {} });
    expect(readFileSync(file, "utf8")).toBe(
      "METISTRY_DB_HOST=127.0.0.1\n\n# --- written by `metistry secrets sync --to env` from the Keychain ---\nMETISTRY_ASSISTANT_TOKEN=tok\n",
    );
  });

  // GENERATED_SECRETS: an install that predates a variable gains it on the
  // next sync instead of needing a verb. The bar is that the value means
  // nothing outside this install — METISTRY_LOCAL_OWNER_TOKEN, like the DB
  // password `metistry up` generates.
  it("mints METISTRY_LOCAL_OWNER_TOKEN when it is in neither the Keychain nor .env, into both, under the instance's account", async () => {
    const file = await envFile("METISTRY_DB_HOST=127.0.0.1\nMETISTRY_LOCAL_OWNER_TOKEN=\n");
    const kc = fakeSecurity();
    const out: string[] = [];
    const r = await syncSecrets("env", {
      envFile: file,
      instanceId: INSTANCE_ID,
      exec: kc.exec,
      out: (l) => out.push(l),
      platform: "darwin",
      env: {},
      mint: () => "MINTED-OWNER-TOKEN",
    });
    expect(r.minted).toEqual(["METISTRY_LOCAL_OWNER_TOKEN"]);
    expect(kc.store.get(key(INSTANCE_ID, "METISTRY_LOCAL_OWNER_TOKEN"))).toBe("MINTED-OWNER-TOKEN");
    expect(kc.store.has(key(USER, "METISTRY_LOCAL_OWNER_TOKEN"))).toBe(false); // instance-scoped, not the person's
    expect(readFileSync(file, "utf8")).toBe("METISTRY_DB_HOST=127.0.0.1\nMETISTRY_LOCAL_OWNER_TOKEN=MINTED-OWNER-TOKEN\n");
    expect(out.join("\n")).toContain("minted METISTRY_LOCAL_OWNER_TOKEN");
    expect(out.join("\n")).not.toContain("MINTED-OWNER-TOKEN"); // a value is never printed
    for (const c of kc.calls) for (const a of c.args) expect(a).not.toContain("MINTED-OWNER-TOKEN");

    // idempotent: a second run reads the item back rather than rotating it
    const again = await syncSecrets("env", { envFile: file, instanceId: INSTANCE_ID, exec: kc.exec, out: () => {}, platform: "darwin", env: {}, mint: () => "SECOND" });
    expect(again.minted).toEqual([]);
    expect(readFileSync(file, "utf8")).toContain("METISTRY_LOCAL_OWNER_TOKEN=MINTED-OWNER-TOKEN");
  });

  it("mints only the generated names — a missing third-party secret is still reported, never invented", async () => {
    const file = await envFile("METISTRY_GITHUB_TOKEN=\nMETISTRY_OPENROUTER_API_KEY=\nMETISTRY_BRIDGE_TOKEN_RECONCILER=\n");
    const kc = fakeSecurity();
    const r = await syncSecrets("env", { envFile: file, instanceId: INSTANCE_ID, exec: kc.exec, out: () => {}, platform: "darwin", env: {} });
    expect(r.minted).toEqual([]);
    expect(r.skipped.sort()).toEqual(["METISTRY_BRIDGE_TOKEN_RECONCILER", "METISTRY_GITHUB_TOKEN", "METISTRY_OPENROUTER_API_KEY"]);
    expect(readFileSync(file, "utf8")).toBe("METISTRY_GITHUB_TOKEN=\nMETISTRY_OPENROUTER_API_KEY=\nMETISTRY_BRIDGE_TOKEN_RECONCILER=\n");
  });

  it("uncomments a documented-but-unset declaration in place", () => {
    const { text, missing } = rewriteEnv("# a comment\n#   METISTRY_GITHUB_TOKEN=\nX=1\n", new Map([["METISTRY_GITHUB_TOKEN", "ghp_x"]]));
    expect(text).toBe("# a comment\nMETISTRY_GITHUB_TOKEN=ghp_x\nX=1\n");
    expect(missing).toEqual([]);
  });

  it("quotes a value the parser would otherwise mangle, and refuses one that cannot round-trip", async () => {
    const file = await envFile("METISTRY_DB_PASSWORD=x\n");
    const kc = fakeSecurity({ [key(USER, "METISTRY_DB_PASSWORD")]: "pass word # not a comment" });
    await syncSecrets("env", { envFile: file, exec: kc.exec, out: () => {}, platform: "darwin", env: {} });
    expect(readFileSync(file, "utf8")).toBe("METISTRY_DB_PASSWORD='pass word # not a comment'\n");

    kc.store.set(key(USER, "METISTRY_DB_PASSWORD"), "has'quote");
    await expect(syncSecrets("env", { envFile: file, exec: kc.exec, out: () => {}, platform: "darwin", env: {} })).rejects.toThrow(/single quote/);
  });

  it("strips the quotes .env uses, and refuses a value the Keychain prompt cannot round-trip", async () => {
    const file = await envFile();
    const kc = fakeSecurity();
    await writeFile(file, 'METISTRY_DB_PASSWORD="quoted in .env"\n');
    await syncSecrets("keychain", { envFile: file, exec: kc.exec, out: () => {}, platform: "darwin", env: {} });
    expect(kc.store.get(key(USER, "METISTRY_DB_PASSWORD"))).toBe("quoted in .env");
    // `security ... -w` prompts twice, a line at a time: a newline cannot survive it
    expect(() => promptStdin("two\nlines")).toThrow(/newline/);
    expect(promptStdin("one")).toBe("one\none\n");
  });

  it("tells a Linux host what to do instead of pretending there is a Keychain", async () => {
    const file = await envFile();
    const lines: string[] = [];
    await expect(syncSecrets("keychain", { envFile: file, exec: fakeSecurity().exec, out: (l) => lines.push(l), platform: "linux", env: {} })).rejects.toThrow(/no Keychain/);
    expect(lines.join("\n")).toMatch(/chmod 600/);
  });
});

describe("metistry secrets mint", () => {
  it("mints into both stores and never prints the value", async () => {
    const file = await envFile("METISTRY_DB_HOST=127.0.0.1\n# METISTRY_ASSISTANT_TOKEN=\n");
    const kc = fakeSecurity();
    const lines: string[] = [];
    await mintSecret("METISTRY_ASSISTANT_TOKEN", { envFile: file, exec: kc.exec, out: (l) => lines.push(l), platform: "darwin", env: {}, mint: () => "MINTED-VALUE" });

    expect(kc.store.get(key(USER, "METISTRY_ASSISTANT_TOKEN"))).toBe("MINTED-VALUE");
    expect(readFileSync(file, "utf8")).toBe("METISTRY_DB_HOST=127.0.0.1\nMETISTRY_ASSISTANT_TOKEN=MINTED-VALUE\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const l of lines) expect(l).not.toContain("MINTED-VALUE");
    for (const c of kc.calls) for (const a of c.args) expect(a).not.toContain("MINTED-VALUE");

    await expect(mintSecret("METISTRY_GITHUB_REPOS", { envFile: file, exec: kc.exec, out: () => {}, platform: "darwin", env: {} })).rejects.toThrow(/not a secret-shaped name/);
  });
});

describe("the scope table", () => {
  it("classifies every secret this install has a name for", () => {
    for (const n of ["METISTRY_DB_PASSWORD", "METISTRY_BRIDGE_TOKEN_RECONCILER", "METISTRY_BRIDGE_TOKEN_APPLE_FM", "METISTRY_ASSISTANT_TOKEN", "METISTRY_VAPID_PRIVATE", "METISTRY_GITHUB_TOKEN", "METISTRY_GITHUB_WRITE_TOKEN"]) {
      expect(scopeFor(n), n).toBe("instance");
    }
    for (const n of ["METISTRY_OPENROUTER_API_KEY", "METISTRY_AWS_SECRET_ACCESS_KEY", "METISTRY_AWS_SESSION_TOKEN"]) {
      expect(scopeFor(n), n).toBe("user");
    }
    // self-containment is the rule, so anything unlisted belongs to the instance
    expect(scopeFor("METISTRY_SOMETHING_NEW_TOKEN")).toBe("instance");
    expect(DEFAULT_SCOPE).toBe("instance");
    for (const r of SECRET_SCOPES) expect(r.why.length).toBeGreaterThan(10);
    expect(scopeReason("METISTRY_OPENROUTER_API_KEY")).toContain("compute provider credential");
    expect(scopeReason("METISTRY_SOMETHING_NEW_TOKEN")).toContain("default");
  });

  it("accountFor sends instance-scoped items to the instance_id and user-scoped ones to the user account", () => {
    const accounts = { user: "metistry", instance: INSTANCE_ID };
    expect(accountFor("METISTRY_DB_PASSWORD", accounts)).toBe(INSTANCE_ID);
    expect(accountFor("METISTRY_OPENROUTER_API_KEY", accounts)).toBe("metistry");
    // with no instance id there is nowhere else to put it — the user account, as before
    expect(accountFor("METISTRY_DB_PASSWORD", { user: "metistry" })).toBe("metistry");
  });
});

describe("instance-scoped secrets", () => {
  it("imports each secret under its own account, so two instances never share one", async () => {
    const file = await envFile();
    const kc = fakeSecurity();
    const lines: string[] = [];
    const r = await syncSecrets("keychain", { envFile: file, exec: kc.exec, out: (l) => lines.push(l), platform: "darwin", env: {}, instanceId: INSTANCE_ID });
    expect(r.changed).toEqual(["METISTRY_DB_PASSWORD", "METISTRY_OPENROUTER_API_KEY", "METISTRY_VAPID_PRIVATE"]);
    expect(Object.fromEntries(kc.store)).toEqual({
      [key(INSTANCE_ID, "METISTRY_DB_PASSWORD")]: "change-me",
      [key(INSTANCE_ID, "METISTRY_VAPID_PRIVATE")]: "vapid-private-EXAMPLE",
      // the person's Claude login is deliberately shared by every instance
      [key(USER, "METISTRY_OPENROUTER_API_KEY")]: "sk-or-v1-EXAMPLE",
    });
    expect(lines.join("\n")).toContain(`instance ${INSTANCE_ID}`);
  });

  it("resolves the instance account first, falls back to the user's, and COPIES what it found there — never deleting it", async () => {
    const file = await envFile();
    const kc = fakeSecurity({
      // an install that predates scoping: everything under the user account
      [key(USER, "METISTRY_DB_PASSWORD")]: "from-before-scoping",
      [key(USER, "METISTRY_OPENROUTER_API_KEY")]: "oauth",
      // …except one that has already been scoped, and must win over the user copy
      [key(USER, "METISTRY_VAPID_PRIVATE")]: "stale-user-copy",
      [key(INSTANCE_ID, "METISTRY_VAPID_PRIVATE")]: "the-instance-one",
    });
    const lines: string[] = [];
    const r = await syncSecrets("env", { envFile: file, exec: kc.exec, out: (l) => lines.push(l), platform: "darwin", env: {}, instanceId: INSTANCE_ID });

    expect(r.migrated).toEqual(["METISTRY_DB_PASSWORD"]);
    expect(kc.store.get(key(INSTANCE_ID, "METISTRY_DB_PASSWORD"))).toBe("from-before-scoping");
    // the old item is left exactly where it was: a rollback to an older CLI still finds it
    expect(kc.store.get(key(USER, "METISTRY_DB_PASSWORD"))).toBe("from-before-scoping");
    // nothing is ever deleted by a sync
    expect(kc.calls.some((c) => c.args[0] === "delete-generic-password")).toBe(false);

    const after = readFileSync(file, "utf8");
    expect(after).toContain("METISTRY_DB_PASSWORD=from-before-scoping");
    expect(after).toContain("METISTRY_VAPID_PRIVATE=the-instance-one"); // the instance account won
    expect(after).toContain("METISTRY_OPENROUTER_API_KEY=oauth");
    expect(lines.join("\n")).toContain("copied from the user account to this instance's");
    for (const l of lines) expect(l).not.toContain("from-before-scoping");
  });

  it("`--to env` MOVES the file to the instance when the one it read was the checkout's, leaving the old one in place", async () => {
    const file = await envFile();
    const target = join(file, "..", "state", ".env");
    const kc = fakeSecurity({ [key(INSTANCE_ID, "METISTRY_DB_PASSWORD")]: "rotated" });
    const lines: string[] = [];
    const r = await syncSecrets("env", { envFile: file, envTarget: target, exec: kc.exec, out: (l) => lines.push(l), platform: "darwin", env: {}, instanceId: INSTANCE_ID });

    expect(r.wrote).toBe(target);
    // every line of the old file is carried over, not just the secrets
    const moved = readFileSync(target, "utf8");
    expect(moved).toBe(ENV_TEXT.replace("METISTRY_DB_PASSWORD=change-me", "METISTRY_DB_PASSWORD=rotated"));
    expect(statSync(target).mode & 0o777).toBe(0o600);
    // and the running install's file is untouched
    expect(readFileSync(file, "utf8")).toBe(ENV_TEXT);
    expect(lines.join("\n")).toContain("LEFT IN PLACE");
  });

  it("mint files the new token under the instance's account", async () => {
    const file = await envFile("METISTRY_DB_HOST=127.0.0.1\n");
    const kc = fakeSecurity();
    const lines: string[] = [];
    await mintSecret("METISTRY_BRIDGE_TOKEN_RECONCILER", { envFile: file, exec: kc.exec, out: (l) => lines.push(l), platform: "darwin", env: {}, instanceId: INSTANCE_ID, mint: () => "MINTED" });
    expect(kc.store.get(key(INSTANCE_ID, "METISTRY_BRIDGE_TOKEN_RECONCILER"))).toBe("MINTED");
    expect(kc.store.get(key(USER, "METISTRY_BRIDGE_TOKEN_RECONCILER"))).toBeUndefined();
    for (const l of lines) expect(l).not.toContain("MINTED");
  });

  it("list says which account each item belongs under and which it was found under", async () => {
    const file = await envFile();
    const kc = fakeSecurity({ [key(USER, "METISTRY_DB_PASSWORD")]: "not-yet-migrated", [key(INSTANCE_ID, "METISTRY_VAPID_PRIVATE")]: "scoped" });
    const rows = await listSecrets({ envFile: file, exec: kc.exec, out: () => {}, platform: "darwin", env: {}, instanceId: INSTANCE_ID });
    expect(rows.find((r) => r.name === "METISTRY_DB_PASSWORD")).toMatchObject({ scope: "instance", foundUnder: "user" });
    expect(rows.find((r) => r.name === "METISTRY_VAPID_PRIVATE")).toMatchObject({ scope: "instance", foundUnder: "instance" });
    const table = renderSecretList(rows);
    expect(table).toContain("still under the user account");
    expect(table).toContain("METISTRY_DB_PASSWORD");
    for (const v of ["not-yet-migrated", "scoped"]) expect(table).not.toContain(v);
    for (const c of kc.calls) expect(c.args).not.toContain("-w");
  });

  it("--json prints the same rows the table shows — names, scope, keychain account found under, set/unset — and no value", async () => {
    const file = await envFile("METISTRY_DB_PASSWORD=set-in-env\n");
    const kc = fakeSecurity({ [key(USER, "METISTRY_DB_PASSWORD")]: "not-yet-migrated" });
    const out: string[] = [];
    // no --product-dir: knownSecretNames() falls back to .env's own names only (no .env.example to widen the list)
    const code = await main(["secrets", "list", "--json", "--env-file", file, "--product-dir", await mkdtemp(join(tmpdir(), "metistry-no-example-"))], {
      out: (l) => out.push(l),
      exec: kc.exec,
      platform: "darwin",
    });
    expect(code).toBe(0);
    const printed = out.join("\n");
    const rows = JSON.parse(printed) as unknown[];
    expect(rows).toEqual(await listSecrets({ envFile: file, exec: kc.exec, out: () => {}, platform: "darwin", env: {} }));
    expect(rows).toEqual([{ name: "METISTRY_DB_PASSWORD", scope: "instance", inKeychain: true, foundUnder: "user", inEnv: true }]);
    expect(printed).not.toContain("not-yet-migrated");
    expect(printed).not.toContain("set-in-env");
  });
});

describe("metistry secrets purge", () => {
  const seeded = () =>
    fakeSecurity({
      [key(INSTANCE_ID, "METISTRY_DB_PASSWORD")]: "db",
      [key(INSTANCE_ID, "METISTRY_VAPID_PRIVATE")]: "vapid",
      [key(USER, "METISTRY_OPENROUTER_API_KEY")]: "the-person's-provider-key",
      [key(USER, "METISTRY_DB_PASSWORD")]: "a-sibling-instance's-old-copy",
    });

  it("previews and deletes NOTHING without --yes", async () => {
    const file = await envFile();
    const kc = seeded();
    const lines: string[] = [];
    const before = new Map(kc.store);
    const r = await purgeSecrets({ envFile: file, instanceDir: "/i/test-two", exec: kc.exec, out: (l) => lines.push(l), platform: "darwin", env: {}, instanceId: INSTANCE_ID });

    expect(r.found).toEqual(["METISTRY_DB_PASSWORD", "METISTRY_VAPID_PRIVATE"]);
    expect(r.deleted).toEqual([]);
    expect(Object.fromEntries(kc.store)).toEqual(Object.fromEntries(before));
    expect(kc.calls.some((c) => c.args[0] === "delete-generic-password")).toBe(false);
    expect(lines.join("\n")).toContain("rerun with --yes");
    expect(lines.join("\n")).toContain("/i/test-two");
    for (const l of lines) expect(l).not.toContain("the-person's-provider-key");
  });

  it("with --yes deletes only this instance's account, never the per-user one", async () => {
    const file = await envFile();
    const kc = seeded();
    const lines: string[] = [];
    const r = await purgeSecrets({ envFile: file, instanceDir: "/i/test-two", exec: kc.exec, out: (l) => lines.push(l), platform: "darwin", env: {}, instanceId: INSTANCE_ID, yes: true });

    expect(r.deleted).toEqual(["METISTRY_DB_PASSWORD", "METISTRY_VAPID_PRIVATE"]);
    expect(r.kept).toEqual(["METISTRY_OPENROUTER_API_KEY"]);
    expect(Object.fromEntries(kc.store)).toEqual({
      [key(USER, "METISTRY_OPENROUTER_API_KEY")]: "the-person's-provider-key",
      [key(USER, "METISTRY_DB_PASSWORD")]: "a-sibling-instance's-old-copy",
    });
    // every delete named this instance's account explicitly
    for (const c of kc.calls.filter((x) => x.args[0] === "delete-generic-password")) {
      expect(c.args[c.args.indexOf("-a") + 1]).toBe(INSTANCE_ID);
    }
  });

  it("refuses an instance with no id, and refuses to purge the per-user account", async () => {
    const file = await envFile();
    const kc = seeded();
    await expect(purgeSecrets({ envFile: file, instanceDir: "/i/old", exec: kc.exec, out: () => {}, platform: "darwin", env: {} })).rejects.toThrow(/no instance_id/);
    // METISTRY_KEYCHAIN_ACCOUNT pointed at the instance's own id: purging it would take the person's secrets with it
    await expect(
      purgeSecrets({ envFile: file, instanceDir: "/i/x", exec: kc.exec, out: () => {}, platform: "darwin", env: { METISTRY_KEYCHAIN_ACCOUNT: INSTANCE_ID }, instanceId: INSTANCE_ID, yes: true }),
    ).rejects.toThrow(/refusing to purge/);
    expect(kc.calls.some((c) => c.args[0] === "delete-generic-password")).toBe(false);
  });
});

describe("metistry secrets list", () => {
  it("prints names and where each lives, and no value anywhere", async () => {
    const file = await envFile();
    const kc = fakeSecurity({ [key(USER, "METISTRY_GITHUB_TOKEN")]: "ghp_only-in-the-keychain" });
    const rows = await listSecrets({ envFile: file, exec: kc.exec, out: () => {}, platform: "darwin", env: {} });

    expect(rows).toEqual([
      { name: "METISTRY_DB_PASSWORD", scope: "instance", inKeychain: false, inEnv: true },
      { name: "METISTRY_OPENROUTER_API_KEY", scope: "user", inKeychain: false, inEnv: true },
      { name: "METISTRY_VAPID_PRIVATE", scope: "instance", inKeychain: false, inEnv: true },
      { name: "METISTRY_GITHUB_TOKEN", scope: "instance", inKeychain: true, foundUnder: "user", inEnv: false },
    ]);
    const table = renderSecretList(rows);
    for (const v of ["ghp_only-in-the-keychain", "change-me", "sk-or-v1-EXAMPLE", "vapid-private-EXAMPLE"]) expect(table).not.toContain(v);
    expect(table).toContain("METISTRY_GITHUB_TOKEN");
    // presence is checked WITHOUT -w, so `security` is never even asked for a value
    for (const c of kc.calls) expect(c.args).not.toContain("-w");
  });
});
