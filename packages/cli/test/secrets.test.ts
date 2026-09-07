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
import { isSecretVar, listSecrets, mintSecret, renderSecretList, rewriteEnv, syncSecrets } from "../src/secrets.js";

const ENV_TEXT = `# Metistry environment — copy to .env and fill in.

# --- database ---
METISTRY_DB_HOST=127.0.0.1
METISTRY_DB_PASSWORD=change-me

# --- assistant container auth ---
# Mint with \`claude setup-token\`; never bake into an image.
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-EXAMPLE

# Web push (PoC-6). The subject must be a REAL mailto: contact.
METISTRY_VAPID_PUBLIC=BPublicKeyIsNotASecret
METISTRY_VAPID_PRIVATE=vapid-private-EXAMPLE
METISTRY_VAPID_SUBJECT=mailto:someone@example.com

# not set yet — a commented declaration, which is where the name is documented
# METISTRY_GITHUB_TOKEN=
METISTRY_GITHUB_REPOS=owner/repo
`;

/** A Keychain in a Map. Records every call so the tests can prove argv never carried a value. */
function fakeSecurity(seed: Record<string, string> = {}): { exec: Exec; store: Map<string, string>; calls: Array<{ args: string[]; opts: ExecOptions }> } {
  const store = new Map(Object.entries(seed));
  const calls: Array<{ args: string[]; opts: ExecOptions }> = [];
  const exec: Exec = async (cmd, args, opts = {}) => {
    calls.push({ args, opts });
    if (cmd !== "security") return { code: 127, stdout: "", stderr: "not security" };
    const service = args[args.indexOf("-s") + 1] ?? "";
    if (args[0] === "add-generic-password") {
      const [a, b] = String(opts.stdin ?? "").split("\n");
      if (a === undefined || a !== b) return { code: 1, stdout: "", stderr: "passwords don't match" };
      store.set(service, a);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") {
      if (!store.has(service)) return { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
      return { code: 0, stdout: args.includes("-w") ? `${store.get(service)}\n` : "", stderr: "" };
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
    for (const n of ["METISTRY_DB_PASSWORD", "METISTRY_GITHUB_TOKEN", "METISTRY_VAPID_PRIVATE", "METISTRY_ASSISTANT_TOKEN", "METISTRY_AWS_SECRET_ACCESS_KEY", "METISTRY_BRIDGE_TOKEN_RECONCILER", "CLAUDE_CODE_OAUTH_TOKEN"]) {
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
    expect(imported.changed).toEqual(["METISTRY_DB_PASSWORD", "CLAUDE_CODE_OAUTH_TOKEN", "METISTRY_VAPID_PRIVATE"]);
    expect(imported.skipped).toEqual(["METISTRY_GITHUB_TOKEN"]); // declared but commented out, so nothing to import
    expect(Object.fromEntries(kc.store)).toEqual({
      "metistry:METISTRY_DB_PASSWORD": "change-me",
      "metistry:CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat-EXAMPLE",
      "metistry:METISTRY_VAPID_PRIVATE": "vapid-private-EXAMPLE",
    });
    // importing never touches the file
    expect(readFileSync(file, "utf8")).toBe(ENV_TEXT);
    // and never puts a value on a command line
    for (const c of kc.calls) for (const a of c.args) expect(a).not.toContain("change-me");

    // now rotate one in the Keychain and regenerate .env from it
    kc.store.set("metistry:METISTRY_DB_PASSWORD", "rotated-in-the-keychain");
    const back = await syncSecrets("env", opts);
    expect(back.changed.sort()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "METISTRY_DB_PASSWORD", "METISTRY_VAPID_PRIVATE"]);
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
    const kc = fakeSecurity({ "metistry:METISTRY_ASSISTANT_TOKEN": "tok" });
    await syncSecrets("env", { envFile: file, exampleFile: example, exec: kc.exec, out: () => {}, platform: "darwin", env: {} });
    expect(readFileSync(file, "utf8")).toBe(
      "METISTRY_DB_HOST=127.0.0.1\n\n# --- written by `metistry secrets sync --to env` from the Keychain ---\nMETISTRY_ASSISTANT_TOKEN=tok\n",
    );
  });

  it("uncomments a documented-but-unset declaration in place", () => {
    const { text, missing } = rewriteEnv("# a comment\n#   METISTRY_GITHUB_TOKEN=\nX=1\n", new Map([["METISTRY_GITHUB_TOKEN", "ghp_x"]]));
    expect(text).toBe("# a comment\nMETISTRY_GITHUB_TOKEN=ghp_x\nX=1\n");
    expect(missing).toEqual([]);
  });

  it("quotes a value the parser would otherwise mangle, and refuses one that cannot round-trip", async () => {
    const file = await envFile("METISTRY_DB_PASSWORD=x\n");
    const kc = fakeSecurity({ "metistry:METISTRY_DB_PASSWORD": "pass word # not a comment" });
    await syncSecrets("env", { envFile: file, exec: kc.exec, out: () => {}, platform: "darwin", env: {} });
    expect(readFileSync(file, "utf8")).toBe("METISTRY_DB_PASSWORD='pass word # not a comment'\n");

    kc.store.set("metistry:METISTRY_DB_PASSWORD", "has'quote");
    await expect(syncSecrets("env", { envFile: file, exec: kc.exec, out: () => {}, platform: "darwin", env: {} })).rejects.toThrow(/single quote/);
  });

  it("strips the quotes .env uses, and refuses a value the Keychain prompt cannot round-trip", async () => {
    const file = await envFile();
    const kc = fakeSecurity();
    await writeFile(file, 'METISTRY_DB_PASSWORD="quoted in .env"\n');
    await syncSecrets("keychain", { envFile: file, exec: kc.exec, out: () => {}, platform: "darwin", env: {} });
    expect(kc.store.get("metistry:METISTRY_DB_PASSWORD")).toBe("quoted in .env");
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

    expect(kc.store.get("metistry:METISTRY_ASSISTANT_TOKEN")).toBe("MINTED-VALUE");
    expect(readFileSync(file, "utf8")).toBe("METISTRY_DB_HOST=127.0.0.1\nMETISTRY_ASSISTANT_TOKEN=MINTED-VALUE\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const l of lines) expect(l).not.toContain("MINTED-VALUE");
    for (const c of kc.calls) for (const a of c.args) expect(a).not.toContain("MINTED-VALUE");

    await expect(mintSecret("METISTRY_GITHUB_REPOS", { envFile: file, exec: kc.exec, out: () => {}, platform: "darwin", env: {} })).rejects.toThrow(/not a secret-shaped name/);
  });
});

describe("metistry secrets list", () => {
  it("prints names and where each lives, and no value anywhere", async () => {
    const file = await envFile();
    const kc = fakeSecurity({ "metistry:METISTRY_GITHUB_TOKEN": "ghp_only-in-the-keychain" });
    const rows = await listSecrets({ envFile: file, exec: kc.exec, out: () => {}, platform: "darwin", env: {} });

    expect(rows).toEqual([
      { name: "METISTRY_DB_PASSWORD", inKeychain: false, inEnv: true },
      { name: "CLAUDE_CODE_OAUTH_TOKEN", inKeychain: false, inEnv: true },
      { name: "METISTRY_VAPID_PRIVATE", inKeychain: false, inEnv: true },
      { name: "METISTRY_GITHUB_TOKEN", inKeychain: true, inEnv: false },
    ]);
    const table = renderSecretList(rows);
    for (const v of ["ghp_only-in-the-keychain", "change-me", "sk-ant-oat-EXAMPLE", "vapid-private-EXAMPLE"]) expect(table).not.toContain(v);
    expect(table).toContain("METISTRY_GITHUB_TOKEN");
    // presence is checked WITHOUT -w, so `security` is never even asked for a value
    for (const c of kc.calls) expect(c.args).not.toContain("-w");
  });
});
