// `metistry secrets`: a full round trip through a fake login Keychain and
// a temp `.env`. The assertions that matter are the conservative ones —
// every non-secret line survives byte-for-byte, the file comes back 0600,
// values travel on stdin rather than argv, and `list` cannot print one.
import { statSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Exec, ExecOptions } from "../src/exec.js";
import { interactiveLine } from "../src/keychain.js";
import { main } from "../src/main.js";
import { accountFor, isSecretVar, listSecrets, mintSecret, purgeSecrets, renderSecretList, rewriteEnv, serviceAnswers, sharedScopeSecretName, syncSecrets, wasSharedScope } from "../src/secrets.js";
import { decodeSecurity } from "./fake-security.js";

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
function fakeSecurity(seed: Record<string, string> = {}): { exec: Exec; store: Map<string, string>; calls: Array<{ args: string[]; argv: string[]; opts: ExecOptions }> } {
  const store = new Map(Object.entries(seed));
  const calls: Array<{ args: string[]; argv: string[]; opts: ExecOptions }> = [];
  const exec: Exec = async (cmd, argv, opts = {}) => {
    const { args, value } = cmd === "security" ? decodeSecurity(argv, opts) : { args: argv, value: undefined };
    calls.push({ args, argv, opts });
    if (cmd !== "security") return { code: 127, stdout: "", stderr: "not security" };
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
    expect(imported.changed).toEqual(["METISTRY_DB_PASSWORD", "METISTRY_VAPID_PRIVATE"]);
    expect(imported.skipped).toEqual(["METISTRY_GITHUB_TOKEN"]); // declared but commented out, so nothing to import
    // a third-party credential is an owner-named secret now: set with `secrets set`, never swept in from .env
    expect(imported.named).toEqual(["METISTRY_OPENROUTER_API_KEY"]);
    expect(lines.join("\n")).toContain("metistry secrets set openrouter_api_key");
    expect(Object.fromEntries(kc.store)).toEqual({
      [key(USER, "METISTRY_DB_PASSWORD")]: "change-me",
      [key(USER, "METISTRY_VAPID_PRIVATE")]: "vapid-private-EXAMPLE",
    });
    // importing never touches the file
    expect(readFileSync(file, "utf8")).toBe(ENV_TEXT);
    // and never puts a value on a command line
    for (const c of kc.calls) for (const a of c.argv) expect(a).not.toContain("change-me");

    // now rotate one in the Keychain and regenerate .env from it
    kc.store.set(key(USER, "METISTRY_DB_PASSWORD"), "rotated-in-the-keychain");
    const back = await syncSecrets("env", opts);
    expect(back.changed.sort()).toEqual(["METISTRY_DB_PASSWORD", "METISTRY_VAPID_PRIVATE"]);
    // no instance_id, so no owner-named store to fill it from: its .env line is left exactly as it was
    expect(back.skipped).toEqual(["METISTRY_OPENROUTER_API_KEY", "METISTRY_GITHUB_TOKEN"]);

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
    for (const c of kc.calls) for (const a of c.argv) expect(a).not.toContain("MINTED-OWNER-TOKEN");

    // idempotent: a second run reads the item back rather than rotating it
    const again = await syncSecrets("env", { envFile: file, instanceId: INSTANCE_ID, exec: kc.exec, out: () => {}, platform: "darwin", env: {}, mint: () => "SECOND" });
    expect(again.minted).toEqual([]);
    expect(readFileSync(file, "utf8")).toContain("METISTRY_LOCAL_OWNER_TOKEN=MINTED-OWNER-TOKEN");
  });

  // The credential split's migration (docs/ops/auth.md): an install that
  // predates METISTRY_BRIDGE_TOKEN_RECONCILER_USER cannot write a §4.7
  // protected path at all until it has one, so this sync mints it. The OTHER
  // bridge tokens stay out of the generated set — a service was already
  // started with those, and inventing a new value would lock it out.
  it("mints METISTRY_BRIDGE_TOKEN_RECONCILER_USER, and still leaves the shared reconciler bearer alone", async () => {
    const file = await envFile("METISTRY_BRIDGE_TOKEN_RECONCILER=\nMETISTRY_BRIDGE_TOKEN_RECONCILER_USER=\n");
    const kc = fakeSecurity();
    const out: string[] = [];
    const r = await syncSecrets("env", { envFile: file, instanceId: INSTANCE_ID, exec: kc.exec, out: (l) => out.push(l), platform: "darwin", env: {}, mint: () => "MINTED-OWNER-BEARER" });
    expect(r.minted).toEqual(["METISTRY_BRIDGE_TOKEN_RECONCILER_USER"]);
    expect(r.skipped).toEqual(["METISTRY_BRIDGE_TOKEN_RECONCILER"]);
    expect(kc.store.get(key(INSTANCE_ID, "METISTRY_BRIDGE_TOKEN_RECONCILER_USER"))).toBe("MINTED-OWNER-BEARER");
    expect(readFileSync(file, "utf8")).toBe("METISTRY_BRIDGE_TOKEN_RECONCILER=\nMETISTRY_BRIDGE_TOKEN_RECONCILER_USER=MINTED-OWNER-BEARER\n");
    expect(out.join("\n")).not.toContain("MINTED-OWNER-BEARER");
    expect(out.join("\n")).toContain("restart");
  });

  // The 0.12.0 lock-out: an install whose `.env` already held both tokens —
  // the values the running console and reconciler were started with — but
  // whose Keychain did not. Minting there rotated both behind the running
  // services, and every Mac app write came back 401 / `unauthenticated`.
  it("**adopts a generated token .env already holds into the Keychain — never mints over it, .env byte-for-byte unchanged**", async () => {
    const text = "METISTRY_DB_HOST=127.0.0.1\nMETISTRY_LOCAL_OWNER_TOKEN=running-console-token\n# the reconciler's owner bearer\nMETISTRY_BRIDGE_TOKEN_RECONCILER_USER='running-owner-bearer'\n";
    const file = await envFile(text);
    const kc = fakeSecurity();
    const out: string[] = [];
    let mints = 0;
    const probed: string[] = [];
    const r = await syncSecrets("env", {
      envFile: file,
      instanceId: INSTANCE_ID,
      exec: kc.exec,
      out: (l) => out.push(l),
      platform: "darwin",
      env: {},
      mint: () => `MINTED-${++mints}`,
      serviceRunning: async (svc) => (probed.push(svc), true),
    });
    expect(mints).toBe(0);
    expect(r.minted).toEqual([]);
    expect(r.adopted).toEqual(["METISTRY_LOCAL_OWNER_TOKEN", "METISTRY_BRIDGE_TOKEN_RECONCILER_USER"]);
    expect(r.rotated).toEqual([]);
    expect(r.restart).toEqual([]);
    expect(probed).toEqual([]); // nothing changed, so nothing to ask about
    expect(kc.store.get(key(INSTANCE_ID, "METISTRY_LOCAL_OWNER_TOKEN"))).toBe("running-console-token");
    expect(kc.store.get(key(INSTANCE_ID, "METISTRY_BRIDGE_TOKEN_RECONCILER_USER"))).toBe("running-owner-bearer");
    expect(readFileSync(file, "utf8")).toBe(text);
    const said = out.join("\n");
    expect(said).toContain("adopted METISTRY_LOCAL_OWNER_TOKEN");
    expect(said).not.toContain("minted");
    expect(said).not.toContain("running-console-token");
    expect(said).not.toContain("running-owner-bearer");
    for (const c of kc.calls) for (const a of c.argv) expect(a).not.toMatch(/running-(console-token|owner-bearer)/);

    // and the next run reads the adopted item back: still no mint, still no change
    const again = await syncSecrets("env", { envFile: file, instanceId: INSTANCE_ID, exec: kc.exec, out: () => {}, platform: "darwin", env: {}, mint: () => `MINTED-${++mints}` });
    expect(mints).toBe(0);
    expect(again.adopted).toEqual([]);
    expect(again.rotated).toEqual([]);
  });

  it("mints a generated token exactly once when neither the Keychain nor .env has it", async () => {
    const file = await envFile("METISTRY_LOCAL_OWNER_TOKEN=\n");
    const kc = fakeSecurity();
    let mints = 0;
    const r = await syncSecrets("env", { envFile: file, instanceId: INSTANCE_ID, exec: kc.exec, out: () => {}, platform: "darwin", env: {}, mint: () => `MINTED-${++mints}`, serviceRunning: async () => false });
    expect(mints).toBe(1);
    expect(r.minted).toEqual(["METISTRY_LOCAL_OWNER_TOKEN"]);
    expect(r.adopted).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("METISTRY_LOCAL_OWNER_TOKEN=MINTED-1\n");
    await syncSecrets("env", { envFile: file, instanceId: INSTANCE_ID, exec: kc.exec, out: () => {}, platform: "darwin", env: {}, mint: () => `MINTED-${++mints}` });
    expect(mints).toBe(1);
  });

  it("the Keychain is canonical: its value replaces a differing .env line", async () => {
    const file = await envFile("X=1\nMETISTRY_LOCAL_OWNER_TOKEN=stale-env-value\n");
    const kc = fakeSecurity({ [key(INSTANCE_ID, "METISTRY_LOCAL_OWNER_TOKEN")]: "keychain-value" });
    const r = await syncSecrets("env", { envFile: file, instanceId: INSTANCE_ID, exec: kc.exec, out: () => {}, platform: "darwin", env: {}, mint: () => "NEVER", serviceRunning: async () => false });
    expect(r.minted).toEqual([]);
    expect(r.adopted).toEqual([]);
    expect(r.rotated).toEqual(["METISTRY_LOCAL_OWNER_TOKEN"]);
    expect(readFileSync(file, "utf8")).toBe("X=1\nMETISTRY_LOCAL_OWNER_TOKEN=keychain-value\n");
  });

  it("**a changed token with its service running is never silent: RESTART NEEDED and the exact command**", async () => {
    const file = await envFile("METISTRY_LOCAL_OWNER_TOKEN=console-was-started-with-this\nMETISTRY_BRIDGE_TOKEN_RECONCILER_USER=\n");
    const kc = fakeSecurity({ [key(INSTANCE_ID, "METISTRY_LOCAL_OWNER_TOKEN")]: "the-keychain-differs" });
    const out: string[] = [];
    const running = { console: true, reconciler: true } as const;
    const r = await syncSecrets("env", { envFile: file, instanceId: INSTANCE_ID, exec: kc.exec, out: (l) => out.push(l), platform: "darwin", env: {}, mint: () => "FRESH", serviceRunning: async (svc) => running[svc] });
    expect(r.rotated).toEqual(["METISTRY_LOCAL_OWNER_TOKEN", "METISTRY_BRIDGE_TOKEN_RECONCILER_USER"]);
    expect(r.restart).toEqual(["console", "reconciler"]);
    const said = out.join("\n");
    expect(said).toMatch(/RESTART NEEDED: the console is running with the previous METISTRY_LOCAL_OWNER_TOKEN .* `metistry restart console`/);
    expect(said).toMatch(/RESTART NEEDED: the reconciler is running with the previous METISTRY_BRIDGE_TOKEN_RECONCILER_USER .* `metistry restart reconciler`/);
    for (const v of ["console-was-started-with-this", "the-keychain-differs", "FRESH"]) expect(said).not.toContain(v);

    // not running: said, but no restart owed; unknown: the command, conditionally
    const quiet: string[] = [];
    const file2 = await envFile("METISTRY_LOCAL_OWNER_TOKEN=\n");
    const r2 = await syncSecrets("env", { envFile: file2, instanceId: INSTANCE_ID, exec: fakeSecurity().exec, out: (l) => quiet.push(l), platform: "darwin", env: {}, mint: () => "FRESH", serviceRunning: async () => false });
    expect(r2.restart).toEqual([]);
    expect(quiet.join("\n")).toContain("the console is not running; it reads the new METISTRY_LOCAL_OWNER_TOKEN when it next starts");
    const unknown: string[] = [];
    const file3 = await envFile("METISTRY_LOCAL_OWNER_TOKEN=\n");
    await syncSecrets("env", { envFile: file3, instanceId: INSTANCE_ID, exec: fakeSecurity().exec, out: (l) => unknown.push(l), platform: "darwin", env: {}, mint: () => "FRESH" });
    expect(unknown.join("\n")).toContain("if the console is running it still holds the previous value: run `metistry restart console`");
  });

  it("serviceAnswers: any HTTP answer is running, a refused connection is not, no URL is unknown", async () => {
    const seen: string[] = [];
    const answering = (async (url: string | URL | Request) => (seen.push(String(url)), new Response("", { status: 401 }))) as unknown as typeof fetch;
    const refusing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await serviceAnswers("console", { env: { METISTRY_CONSOLE_URL: "http://127.0.0.1:18080/" }, shape: "launchd", fetchFn: answering })).toBe(true);
    expect(seen).toEqual(["http://127.0.0.1:18080/health"]);
    expect(await serviceAnswers("reconciler", { env: { METISTRY_RECONCILER_URL: "http://127.0.0.1:18081" }, shape: "launchd", fetchFn: refusing })).toBe(false);
    expect(await serviceAnswers("reconciler", { env: {}, fetchFn: answering })).toBeUndefined();
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
    // `security -i` reads its command a line at a time: a newline cannot survive it
    expect(() => interactiveLine(["add-generic-password", "-w", "two\nlines"])).toThrow(/newline/);
    expect(interactiveLine(["add-generic-password", "-w", "one"])).toBe('"add-generic-password" "-w" "one"\n');
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
    for (const c of kc.calls) for (const a of c.argv) expect(a).not.toContain("MINTED-VALUE");

    await expect(mintSecret("METISTRY_GITHUB_REPOS", { envFile: file, exec: kc.exec, out: () => {}, platform: "darwin", env: {} })).rejects.toThrow(/not a secret-shaped name/);
  });
});

describe("one account (the scope table is retired, plan §2.14)", () => {
  it("names the retired shared scope's variables and the secret each becomes", () => {
    for (const n of ["METISTRY_OPENROUTER_API_KEY", "METISTRY_DEVIN_API_KEY", "METISTRY_AWS_SECRET_ACCESS_KEY", "METISTRY_AWS_SESSION_TOKEN"]) expect(wasSharedScope(n), n).toBe(true);
    for (const n of ["METISTRY_DB_PASSWORD", "METISTRY_BRIDGE_TOKEN_RECONCILER", "METISTRY_ASSISTANT_TOKEN", "METISTRY_VAPID_PRIVATE", "METISTRY_GITHUB_TOKEN", "METISTRY_LOCAL_OWNER_TOKEN", "METISTRY_AWS_ACCESS_KEY_ID"]) expect(wasSharedScope(n), n).toBe(false);
    expect(sharedScopeSecretName("METISTRY_DEVIN_API_KEY")).toBe("devin_api_key");
    expect(sharedScopeSecretName("METISTRY_OPENROUTER_API_KEY")).toBe("openrouter_api_key");
    expect(sharedScopeSecretName("METISTRY_AWS_SECRET_ACCESS_KEY")).toBe("aws_secret_access_key");
    expect(sharedScopeSecretName("METISTRY_DB_PASSWORD")).toBeUndefined();
    // a lowercase name must still be a secret name, or there is no mapping
    expect(sharedScopeSecretName("METISTRY_1X_API_KEY")).toBeUndefined();
  });

  it("accountFor is the instance's account for every variable, and the user's only with no instance_id", () => {
    const accounts = { user: "metistry", instance: INSTANCE_ID };
    expect(accountFor("METISTRY_DB_PASSWORD", accounts)).toBe(INSTANCE_ID);
    expect(accountFor("METISTRY_OPENROUTER_API_KEY", accounts)).toBe(INSTANCE_ID);
    // with no instance id there is nowhere else to put it — the user account, as before
    expect(accountFor("METISTRY_DB_PASSWORD", { user: "metistry" })).toBe("metistry");
  });

  it("mint refuses a third-party credential — a random string is never it", async () => {
    const file = await envFile("");
    await expect(mintSecret("METISTRY_OPENROUTER_API_KEY", { envFile: file, exec: fakeSecurity().exec, out: () => {}, platform: "darwin", env: {}, instanceId: INSTANCE_ID })).rejects.toThrow(/secrets set openrouter_api_key/);
  });
});

describe("instance-scoped secrets", () => {
  it("imports every secret under the instance's account, so two instances never share one", async () => {
    const file = await envFile();
    const kc = fakeSecurity();
    const lines: string[] = [];
    const r = await syncSecrets("keychain", { envFile: file, exec: kc.exec, out: (l) => lines.push(l), platform: "darwin", env: {}, instanceId: INSTANCE_ID });
    expect(r.changed).toEqual(["METISTRY_DB_PASSWORD", "METISTRY_VAPID_PRIVATE"]);
    // nothing reaches the per-user account any more — not even a provider key
    expect(Object.fromEntries(kc.store)).toEqual({
      [key(INSTANCE_ID, "METISTRY_DB_PASSWORD")]: "change-me",
      [key(INSTANCE_ID, "METISTRY_VAPID_PRIVATE")]: "vapid-private-EXAMPLE",
    });
    expect(lines.join("\n")).toContain(`keychain account: ${INSTANCE_ID}`);
  });

  it("**never reads the per-user account**: a shared-scope line fills from the owner-named secret, an unmigrated one is only reported", async () => {
    const file = await envFile();
    const kc = fakeSecurity({
      // an install from before: items under the per-user account
      [key(USER, "METISTRY_DB_PASSWORD")]: "from-before-scoping",
      [key(USER, "METISTRY_OPENROUTER_API_KEY")]: "shared-original",
      [key(INSTANCE_ID, "METISTRY_VAPID_PRIVATE")]: "the-instance-one",
    });
    const lines: string[] = [];
    const r = await syncSecrets("env", { envFile: file, exec: kc.exec, out: (l) => lines.push(l), platform: "darwin", env: {}, instanceId: INSTANCE_ID });

    // not one value was asked of the per-user account
    for (const c of kc.calls.filter((x) => x.args.includes("-w"))) expect(c.args[c.args.indexOf("-a") + 1]).toBe(INSTANCE_ID);
    expect(kc.calls.some((c) => c.args[0] === "delete-generic-password")).toBe(false);
    expect(r.unmigrated).toEqual(["METISTRY_OPENROUTER_API_KEY"]);
    const after = readFileSync(file, "utf8");
    expect(after).toContain("METISTRY_VAPID_PRIVATE=the-instance-one");
    // lines with nothing in THIS instance are left exactly as they were
    expect(after).toContain("METISTRY_DB_PASSWORD=change-me");
    expect(after).toContain("METISTRY_OPENROUTER_API_KEY=sk-or-v1-EXAMPLE");
    expect(lines.join("\n")).toContain("metistry secrets migrate-scope");

    // once migrated (the owner-named item exists), the line fills from it
    kc.store.set(`${INSTANCE_ID}/metistry:secret:openrouter_api_key`, "the-migrated-copy");
    const again = await syncSecrets("env", { envFile: file, exec: kc.exec, out: () => {}, platform: "darwin", env: {}, instanceId: INSTANCE_ID });
    expect(again.unmigrated).toEqual([]);
    expect(readFileSync(file, "utf8")).toContain("METISTRY_OPENROUTER_API_KEY=the-migrated-copy");
    for (const l of lines) expect(l).not.toContain("shared-original");
  });

  it("`--to env` delivers every secret compute.yaml references as METISTRY_SECRET_<NAME> — from this instance's item, and no other secret (T4-18)", async () => {
    const file = await envFile();
    const kc = fakeSecurity({
      [`${INSTANCE_ID}/metistry:secret:openrouter_api_key`]: "sk-or-the-instance-key",
      [`${INSTANCE_ID}/metistry:secret:github_write`]: "ghp-not-for-the-engine",
      // a secret of the same NAME under the per-user account is never it
      [`${USER}/metistry:secret:zen_key`]: "the-wrong-account",
    });
    const lines: string[] = [];
    const r = await syncSecrets("env", { envFile: file, exec: kc.exec, out: (l) => lines.push(l), platform: "darwin", env: {}, instanceId: INSTANCE_ID, deliver: ["openrouter_api_key", "zen_key"] });
    const after = readFileSync(file, "utf8");
    expect(after).toContain("METISTRY_SECRET_OPENROUTER_API_KEY=sk-or-the-instance-key");
    expect(after).not.toContain("ghp-not-for-the-engine"); // referenced by no provider: stays in the Keychain
    expect(after).not.toContain("the-wrong-account");
    expect(r.skipped).toContain("METISTRY_SECRET_ZEN_KEY"); // referenced, and this instance has no item: said, never invented
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const c of kc.calls.filter((x) => x.args.includes("-w"))) expect(c.args[c.args.indexOf("-a") + 1]).toBe(INSTANCE_ID);
    for (const l of lines) expect(l).not.toContain("sk-or-the-instance-key");
    // a delivery line is never mistaken for a retired shared-scope original
    expect(wasSharedScope("METISTRY_SECRET_OPENROUTER_API_KEY")).toBe(false);
    expect(wasSharedScope("METISTRY_OPENROUTER_API_KEY")).toBe(true);
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

  it("list says what this instance holds, and which shared originals are still waiting", async () => {
    const file = await envFile();
    const kc = fakeSecurity({ [key(USER, "METISTRY_OPENROUTER_API_KEY")]: "not-yet-migrated", [key(INSTANCE_ID, "METISTRY_VAPID_PRIVATE")]: "scoped", [key(USER, "METISTRY_DB_PASSWORD")]: "old-user-copy" });
    const rows = await listSecrets({ envFile: file, exec: kc.exec, out: () => {}, platform: "darwin", env: {}, instanceId: INSTANCE_ID });
    // an old per-user copy of an install variable is not this instance's: not found
    expect(rows.find((r) => r.name === "METISTRY_DB_PASSWORD")).toMatchObject({ inKeychain: false });
    expect(rows.find((r) => r.name === "METISTRY_VAPID_PRIVATE")).toMatchObject({ inKeychain: true, foundUnder: "instance" });
    expect(rows.find((r) => r.name === "METISTRY_OPENROUTER_API_KEY")).toMatchObject({ inKeychain: false, secret: "openrouter_api_key", sharedOriginal: true });
    const table = renderSecretList(rows);
    expect(table).toContain("still only in the retired shared scope: METISTRY_OPENROUTER_API_KEY");
    expect(table).toContain("{{ secret.openrouter_api_key }}");
    for (const v of ["not-yet-migrated", "scoped", "old-user-copy"]) expect(table).not.toContain(v);
    for (const c of kc.calls) expect(c.args).not.toContain("-w");
  });

  it("--json prints the same rows the table shows — names, keychain, set/unset — and no value", async () => {
    const file = await envFile("METISTRY_DB_PASSWORD=set-in-env\n");
    const kc = fakeSecurity({ [key(USER, "METISTRY_DB_PASSWORD")]: "no-instance-id-yet" });
    const out: string[] = [];
    // no --product-dir: knownSecretNames() falls back to .env's own names only (no .env.example to widen the list)
    const code = await main(["secrets", "list", "--json", "--env-file", file, "--product-dir", await mkdtemp(join(tmpdir(), "metistry-no-example-"))], {
      out: (l) => out.push(l),
      exec: kc.exec,
      platform: "darwin",
    });
    expect(code).toBe(0);
    expect(out).toHaveLength(1); // --json purity: nothing but the one document reaches stdout
    const printed = out.join("\n");
    const rows = JSON.parse(printed) as unknown[];
    expect(rows).toEqual(await listSecrets({ envFile: file, exec: kc.exec, out: () => {}, platform: "darwin", env: {} }));
    // no instance_id: the install's own variables are still the user account's, and say so
    expect(rows).toEqual([{ name: "METISTRY_DB_PASSWORD", inKeychain: true, foundUnder: "user", inEnv: true }]);
    expect(printed).not.toContain("no-instance-id-yet");
    expect(printed).not.toContain("set-in-env");
  });
});

describe("metistry secrets sync --to env — a sync-read connection's secret (T4-24)", () => {
  it("delivers the Linear key as METISTRY_SECRET_LINEAR_API_KEY for the console's sync — and never an MCP connection's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-sync-linear-"));
    const files: Record<string, string> = {
      ".metistry/identity.yaml": `name: Aide\ninstance_id: "${INSTANCE_ID}"\n`,
      ".metistry/state/.env": "METISTRY_DB_HOST=127.0.0.1\n",
      ".metistry/connections/linear.yaml":
        "name: linear\ntype: tracker\nprovider: linear\nreach:\n  http:\n    url: https://api.linear.app/graphql\n    auth: { scheme: api_key, header: Authorization, secret: linear_api_key }\nsecrets: [linear_api_key]\n",
      ".metistry/connections/gh.yaml": "name: gh\ntype: mcp\nprovider: custom\nreach:\n  http:\n    url: https://mcp.example.test/mcp\n    auth: { scheme: bearer, secret: github_read }\nsecrets: [github_read]\n",
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(join(dir, rel, ".."), { recursive: true });
      await writeFile(join(dir, rel), text, { mode: 0o600 });
    }
    const kc = fakeSecurity({
      [`${INSTANCE_ID}/metistry:secret:linear_api_key`]: "linear-value-for-the-sync",
      [`${INSTANCE_ID}/metistry:secret:github_read`]: "mcp-value-stays-in-the-keychain",
    });
    const out: string[] = [];
    const code = await main(["secrets", "sync", "--to", "env", "--instance", dir, "--product-dir", fileURLToPath(new URL("../../..", import.meta.url))], {
      out: (l) => out.push(l),
      err: (l) => out.push(l),
      exec: kc.exec,
      platform: "darwin",
      // no service is probed over the network from a test
      fetchFn: (async () => {
        throw new Error("no network in this test");
      }) as typeof fetch,
    });
    expect(code, out.join("\n")).toBe(0);
    const env = readFileSync(join(dir, ".metistry/state/.env"), "utf8");
    expect(env).toContain("METISTRY_SECRET_LINEAR_API_KEY=linear-value-for-the-sync");
    expect(env).not.toContain("mcp-value-stays-in-the-keychain"); // the pool fills an MCP connection's secret where it dials
    expect(env).not.toContain("METISTRY_SECRET_GITHUB_READ");
    for (const l of out) expect(l).not.toContain("linear-value-for-the-sync");
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
      { name: "METISTRY_DB_PASSWORD", inKeychain: false, inEnv: true },
      { name: "METISTRY_OPENROUTER_API_KEY", inKeychain: false, inEnv: true, secret: "openrouter_api_key", sharedOriginal: false },
      { name: "METISTRY_VAPID_PRIVATE", inKeychain: false, inEnv: true },
      { name: "METISTRY_GITHUB_TOKEN", inKeychain: true, foundUnder: "user", inEnv: false },
    ]);
    const table = renderSecretList(rows);
    for (const v of ["ghp_only-in-the-keychain", "change-me", "sk-or-v1-EXAMPLE", "vapid-private-EXAMPLE"]) expect(table).not.toContain(v);
    expect(table).toContain("METISTRY_GITHUB_TOKEN");
    // presence is checked WITHOUT -w, so `security` is never even asked for a value
    for (const c of kc.calls) expect(c.args).not.toContain("-w");
  });
});
