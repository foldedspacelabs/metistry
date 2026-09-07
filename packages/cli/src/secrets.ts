// `metistry secrets` — the canonical store for every secret an install
// holds is the macOS login Keychain (`metistry:<VAR>`); `.env` is a
// derived file, generated from it at service start and never edited by
// hand (docs/product/desktop-app-plan.md, step 4).
//
//   secrets sync --to keychain   import `.env`'s secret lines into the Keychain
//   secrets sync --to env        regenerate `.env`'s secret lines from the Keychain
//   secrets mint <VAR>           mint a random token into both
//   secrets list                 names and where each one lives — never a value
//
// Rules this module exists to enforce (they are code, not advice):
//   * A value never reaches argv, only a child's stdin (keychain.ts).
//   * A value is never printed, logged, or returned in a result object.
//   * `--to env` rewrites `.env` IN PLACE: every non-secret line, comment,
//     blank line and ordering survives byte-for-byte, because `.env` also
//     carries hand-written configuration this command must not own.

import { chmod, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { realExec, type Exec } from "./exec.js";
import { Keychain, keychainAccount, serviceFor } from "./keychain.js";

/** A variable is a secret when its name ends in one of these… */
export const SECRET_SUFFIXES = ["_TOKEN", "_PASSWORD", "_PRIVATE", "_SECRET", "_KEY"] as const;
/** …or carries one of them mid-name, because the per-bridge variables are `METISTRY_BRIDGE_TOKEN_<NAME>`. */
export const SECRET_INFIXES = ["_TOKEN_", "_PASSWORD_", "_SECRET_"] as const;
/** …or is one of these exactly (third-party names that follow no convention). */
export const SECRET_NAMES = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

/** Name rules only. `METISTRY_VAPID_PUBLIC`, `..._ACCESS_KEY_ID` and `..._CLIENT_ID` are not secrets and are left alone. */
export function isSecretVar(name: string): boolean {
  return SECRET_NAMES.has(name) || SECRET_SUFFIXES.some((s) => name.endsWith(s)) || SECRET_INFIXES.some((s) => name.includes(s));
}

/** An assignment line, live (`NAME=…`) or commented out (`# NAME=`). The commented form names a variable without setting it. */
const ASSIGNMENT = /^(\s*)(#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** Every variable named by a dotenv-shaped file, including the commented-out ones (`.env.example` is written that way). */
export function declaredVars(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = ASSIGNMENT.exec(line);
    if (m?.[3] && !out.includes(m[3])) out.push(m[3]);
  }
  return out;
}

/** Quote for a dotenv line the way env.ts's parser reads it back. Values that cannot round-trip are refused, not mangled. */
export function quoteEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("a secret containing a newline cannot be written to .env");
  if (/^[A-Za-z0-9_@%+=:,./~-]*$/.test(value)) return value;
  if (value.includes("'")) throw new Error("a secret containing a single quote cannot be written to .env — store it in the Keychain only");
  return `'${value}'`;
}

/**
 * Rewrite only the lines that assign one of `values`' variables; return the
 * new text plus the names that had no line to rewrite. Commented-out
 * declarations are uncommented in place (that is where `.env.example`'s
 * documentation put them), preserving indentation. Everything else — every
 * comment, blank line, ordering, and non-secret assignment — is untouched.
 */
export function rewriteEnv(text: string, values: Map<string, string>): { text: string; missing: string[] } {
  const seen = new Set<string>();
  const lines = text.split("\n").map((line) => {
    const m = ASSIGNMENT.exec(line);
    const name = m?.[3];
    if (!m || !name || !values.has(name)) return line;
    seen.add(name);
    return `${m[1] ?? ""}${name}=${quoteEnvValue(values.get(name)!)}`;
  });
  return { text: lines.join("\n"), missing: [...values.keys()].filter((n) => !seen.has(n)) };
}

/** Append variables the file never declared, under one marker comment. */
export function appendEnv(text: string, values: Map<string, string>, names: string[]): string {
  if (names.length === 0) return text;
  const body = names.map((n) => `${n}=${quoteEnvValue(values.get(n)!)}`);
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  return `${text}${sep}\n# --- written by \`metistry secrets sync --to env\` from the Keychain ---\n${body.join("\n")}\n`;
}

export interface SecretsOptions {
  /** The `.env` this install runs from (the product checkout's). */
  envFile: string;
  /** `.env.example` — the canonical list of variable names, so a fresh install still knows what a secret is called. */
  exampleFile?: string | undefined;
  exec?: Exec | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  out: (line: string) => void;
  mint?: (() => string) | undefined;
}

export type SyncDirection = "keychain" | "env";

export interface SyncResult {
  direction: SyncDirection;
  /** names only — a result object must never be able to carry a value into a log */
  changed: string[];
  skipped: string[];
}

function requireDarwin(platform: NodeJS.Platform, out: (l: string) => void): void {
  if (platform === "darwin") return;
  out("`metistry secrets` stores secrets in the macOS login Keychain, which this host does not have.");
  out(`On Linux keep .env as the store (chmod 600), or put the values in your own secret manager and export them before ${"`metistry up`"}.`);
  throw new Error(`secrets: no Keychain on ${platform}`);
}

async function readText(path: string): Promise<string> {
  return existsSync(path) ? await readFile(path, "utf8") : "";
}

/** Every secret-shaped name this install knows about: declared in `.env`, then any extra from `.env.example`. */
async function knownSecretNames(opts: SecretsOptions): Promise<string[]> {
  const names = declaredVars(await readText(opts.envFile)).filter(isSecretVar);
  for (const n of declaredVars(await readText(opts.exampleFile ?? "")).filter(isSecretVar)) if (!names.includes(n)) names.push(n);
  return names;
}

/** The live (uncommented, non-empty) assignments of `.env`. */
function liveValues(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = ASSIGNMENT.exec(line);
    if (!m || m[2] || !m[3]) continue;
    let v = (m[4] ?? "").trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    out.set(m[3], v);
  }
  return out;
}

/** Write `.env` back, owner-read/write only — it is a secret-bearing file even after this command generates it. */
async function writeEnvFile(path: string, text: string): Promise<void> {
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function syncSecrets(direction: SyncDirection, opts: SecretsOptions): Promise<SyncResult> {
  const platform = opts.platform ?? process.platform;
  requireDarwin(platform, opts.out);
  const kc = new Keychain(opts.exec ?? realExec, keychainAccount(opts.env ?? process.env));
  const names = await knownSecretNames(opts);
  const changed: string[] = [];
  const skipped: string[] = [];

  if (direction === "keychain") {
    const values = liveValues(await readText(opts.envFile));
    for (const name of names) {
      const v = values.get(name);
      if (v === undefined || v === "") {
        skipped.push(name);
        continue;
      }
      await kc.setSecret(name, v);
      changed.push(name);
    }
    opts.out(`imported ${changed.length} secret(s) into the login Keychain as ${serviceFor("<VAR>")}: ${changed.join(", ") || "(none)"}`);
    if (skipped.length) opts.out(`unset in ${opts.envFile}, so not imported: ${skipped.join(", ")}`);
    opts.out(`${opts.envFile} was NOT changed — run \`metistry secrets sync --to env\` once you are ready for it to be generated.`);
    return { direction, changed, skipped };
  }

  const values = new Map<string, string>();
  for (const name of names) {
    const v = await kc.getSecret(name);
    if (v === undefined) skipped.push(name);
    else values.set(name, v);
  }
  const before = await readText(opts.envFile);
  const { text, missing } = rewriteEnv(before, values);
  await writeEnvFile(opts.envFile, appendEnv(text, values, missing));
  changed.push(...values.keys());
  opts.out(`wrote ${changed.length} secret line(s) into ${opts.envFile} from the Keychain (0600; every other line preserved): ${changed.join(", ") || "(none)"}`);
  if (missing.length) opts.out(`appended (no line existed): ${missing.join(", ")}`);
  if (skipped.length) opts.out(`not in the Keychain, left as they are: ${skipped.join(", ")}`);
  return { direction, changed, skipped };
}

/** Mint a fresh random token into the Keychain and into `.env` — the only place a new secret is created. */
export async function mintSecret(name: string, opts: SecretsOptions): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${JSON.stringify(name)} is not a variable name`);
  if (!isSecretVar(name)) throw new Error(`${name} is not a secret-shaped name (it must end in ${SECRET_SUFFIXES.join(", ")} or be one of ${[...SECRET_NAMES].join(", ")})`);
  const platform = opts.platform ?? process.platform;
  requireDarwin(platform, opts.out);
  const kc = new Keychain(opts.exec ?? realExec, keychainAccount(opts.env ?? process.env));
  const value = (opts.mint ?? mintToken)();
  await kc.setSecret(name, value);
  const values = new Map([[name, value]]);
  const { text, missing } = rewriteEnv(await readText(opts.envFile), values);
  await writeEnvFile(opts.envFile, appendEnv(text, values, missing));
  opts.out(`minted ${name} into the login Keychain (${serviceFor(name)}) and ${opts.envFile}. The value is not printed — read it with \`security find-generic-password -s ${serviceFor(name)} -w\` if a service needs it pasted elsewhere.`);
}

export interface SecretListing {
  name: string;
  inKeychain: boolean;
  inEnv: boolean;
}

/** Names and where each one lives. There is no code path here that can read a value. */
export async function listSecrets(opts: SecretsOptions): Promise<SecretListing[]> {
  const platform = opts.platform ?? process.platform;
  const kc = new Keychain(opts.exec ?? realExec, keychainAccount(opts.env ?? process.env));
  const set = liveValues(await readText(opts.envFile));
  const rows: SecretListing[] = [];
  for (const name of await knownSecretNames(opts)) {
    rows.push({ name, inKeychain: platform === "darwin" ? await kc.hasSecret(name) : false, inEnv: (set.get(name) ?? "") !== "" });
  }
  return rows;
}

export function renderSecretList(rows: SecretListing[]): string {
  const width = Math.max(4, ...rows.map((r) => r.name.length));
  const head = `${"name".padEnd(width)}  keychain  .env`;
  const body = rows.map((r) => `${r.name.padEnd(width)}  ${(r.inKeychain ? "yes" : "-").padEnd(8)}  ${r.inEnv ? "set" : "-"}`);
  return [head, "-".repeat(head.length), ...body, "", "Values are never printed."].join("\n");
}
