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

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
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

// ---- the scope table ---------------------------------------------------------
//
// An instance directory is self-contained (owner-ratified 2026-09-09):
// nothing about an instance may persist outside its directory EXCEPT
// per-user secrets. So every secret is filed under one of two Keychain
// accounts, and this is the only table that says which:
//
//   instance  account = the instance's `instance_id`. Deleting the instance
//             directory should orphan nothing (`metistry secrets purge`).
//   user      account = `keychainAccount()`. Belongs to the person and is
//             deliberately SHARED by every instance on this Mac; a purge
//             must never touch it.
//
// The default is `instance`, because self-containment is the rule and
// user-scope is the enumerated exception. `METISTRY_SIGN_IDENTITY` and
// `METISTRY_GITHUB_OAUTH_CLIENT_ID` are not secrets at all and never reach
// here — they stay plain `.env`/config values.

export type SecretScope = "instance" | "user";

export interface ScopeRule {
  scope: SecretScope;
  /** an exact name, or a pattern for a family */
  match: string | RegExp;
  why: string;
}

/** First match wins, so the user-scoped exceptions are listed first. */
export const SECRET_SCOPES: readonly ScopeRule[] = [
  { scope: "user", match: "CLAUDE_CODE_OAUTH_TOKEN", why: "the person's Claude subscription login — one per Mac, shared by every instance" },
  { scope: "user", match: /^METISTRY_AWS_(SECRET_ACCESS_KEY|SESSION_TOKEN)$/, why: "the person's own AWS credentials (aws-costs), not this instance's" },
  { scope: "instance", match: /^METISTRY_DB_PASSWORD$/, why: "this instance's Postgres, in its own state/pg" },
  { scope: "instance", match: /^METISTRY_LOCAL_OWNER_TOKEN$/, why: "the local owner door into THIS instance's console (docs/ops/auth.md) — a second instance must not open the first's" },
  { scope: "instance", match: /^METISTRY_BRIDGE_TOKEN_/, why: "a bearer this instance's bridges were started with" },
  { scope: "instance", match: /^METISTRY_ASSISTANT_TOKEN$/, why: "the internal agent's bearer, registered in this instance's console" },
  { scope: "instance", match: /^METISTRY_AGENT_TOKEN_/, why: "an external tool's bearer, minted by THIS instance's console (`metistry connect <tool>`) — a second instance mints its own" },
  { scope: "instance", match: /^METISTRY_VAPID_/, why: "push keys bound to this instance's origin and subscriptions" },
  { scope: "instance", match: /^METISTRY_GITHUB_/, why: "a PAT scoped to the repos this instance watches or dispatches to" },
];

/** What an unlisted secret gets: self-containment is the rule. */
export const DEFAULT_SCOPE: SecretScope = "instance";

/**
 * Secrets this command may CREATE on sight rather than report missing.
 *
 * The bar is deliberately high: a generated secret is one whose value is
 * meaningless outside this install, so minting one can never be the wrong
 * guess (nobody has to paste it anywhere, and nothing else already knows
 * it). `METISTRY_DB_PASSWORD` is the precedent — `metistry up` generates it
 * into `.env` when Postgres is first prepared. Everything else
 * (CLAUDE_CODE_OAUTH_TOKEN, the GitHub PATs, the bridge tokens a service was
 * already started with) stays "not in the Keychain, left as it is".
 */
export const GENERATED_SECRETS: Readonly<Record<string, string>> = {
  METISTRY_LOCAL_OWNER_TOKEN: "the console's local owner door — an install that predates it gets one here (docs/ops/auth.md)",
};

function ruleFor(name: string): ScopeRule | undefined {
  return SECRET_SCOPES.find((r) => (typeof r.match === "string" ? r.match === name : r.match.test(name)));
}

export function scopeFor(name: string): SecretScope {
  return ruleFor(name)?.scope ?? DEFAULT_SCOPE;
}

/** Why it is scoped that way — printed by `secrets list --why`, and the reason a reviewer can check the table against. */
export function scopeReason(name: string): string {
  return ruleFor(name)?.why ?? "not named in SECRET_SCOPES, so it is treated as this instance's (the default)";
}

export interface Accounts {
  /** the user-scoped account (`keychainAccount()`) */
  user: string;
  /** the instance's `instance_id`; absent when no instance directory is configured, or it has no id yet */
  instance?: string | undefined;
}

/** The account a name's items belong under. Falls back to the user account when there is no instance id to use. */
export function accountFor(name: string, accounts: Accounts): string {
  return scopeFor(name) === "instance" && accounts.instance ? accounts.instance : accounts.user;
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
  /** The `.env` this install runs from — `<instance>/state/.env`, or the product checkout's while an install predates the move. */
  envFile: string;
  /** Where an instance's `.env` belongs; when it differs from `envFile`, `--to env` MOVES it there. */
  envTarget?: string | undefined;
  /** The instance's `instance_id`: the account instance-scoped items are filed under. Absent = everything falls back to the user account. */
  instanceId?: string | undefined;
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
  /** instance-scoped names that were found only under the user account and have now been COPIED to the instance's (never deleted) */
  migrated: string[];
  /** `--to env`: GENERATED_SECRETS names that existed nowhere and were created by this run */
  minted?: string[];
  /** `--to env`: the file that was written, which may not be the one that was read (the move) */
  wrote?: string;
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

/**
 * Write `.env` back, owner-read/write only — it is a secret-bearing file even
 * after this command generates it. The directory is created because the
 * target may be `<instance>/state/`, which nothing has needed until now.
 */
async function writeEnvFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** The two handles a run needs: the user's account, and this instance's when there is one. */
function keychains(opts: SecretsOptions): { user: Keychain; instance?: Keychain; accounts: Accounts } {
  const exec = opts.exec ?? realExec;
  const accounts: Accounts = { user: keychainAccount(opts.env ?? process.env), instance: opts.instanceId };
  return { user: new Keychain(exec, accounts.user), ...(accounts.instance ? { instance: new Keychain(exec, accounts.instance) } : {}), accounts };
}

export async function syncSecrets(direction: SyncDirection, opts: SecretsOptions): Promise<SyncResult> {
  const platform = opts.platform ?? process.platform;
  requireDarwin(platform, opts.out);
  const { user, instance, accounts } = keychains(opts);
  const forName = (name: string) => (scopeFor(name) === "instance" && instance ? instance : user);
  const names = await knownSecretNames(opts);
  const changed: string[] = [];
  const skipped: string[] = [];
  const migrated: string[] = [];
  opts.out(accounts.instance ? `keychain accounts: instance ${accounts.instance}, user ${accounts.user} (scopes: secrets.ts SECRET_SCOPES)` : `keychain account: ${accounts.user} only — no instance_id, so every secret stays user-scoped`);

  if (direction === "keychain") {
    const values = liveValues(await readText(opts.envFile));
    for (const name of names) {
      const v = values.get(name);
      if (v === undefined || v === "") {
        skipped.push(name);
        continue;
      }
      await forName(name).setSecret(name, v);
      changed.push(name);
    }
    const shown = changed.map((n) => `${n} (${scopeFor(n)})`).join(", ");
    opts.out(`imported ${changed.length} secret(s) into the login Keychain as ${serviceFor("<VAR>")}: ${shown || "(none)"}`);
    if (skipped.length) opts.out(`unset in ${opts.envFile}, so not imported: ${skipped.join(", ")}`);
    opts.out(`${opts.envFile} was NOT changed — run \`metistry secrets sync --to env\` once you are ready for it to be generated.`);
    return { direction, changed, skipped, migrated };
  }

  // Resolution order: the scoped account, then the user account as a
  // fallback — and a value found only there for an instance-scoped variable
  // is COPIED to the instance's account (never deleted, so a rollback to an
  // older CLI still finds it).
  const values = new Map<string, string>();
  const minted: string[] = [];
  for (const name of names) {
    const own = forName(name);
    let v = await own.getSecret(name);
    if (v === undefined && own !== user) {
      v = await user.getSecret(name);
      if (v !== undefined) {
        await own.setSecret(name, v);
        migrated.push(name);
      }
    }
    // Nowhere yet, and one of the few whose value only ever means "this
    // install": mint it into the Keychain now, so an instance that predates
    // the variable gains it on the next sync rather than needing a verb.
    if (v === undefined && GENERATED_SECRETS[name]) {
      v = (opts.mint ?? mintToken)();
      await own.setSecret(name, v);
      minted.push(name);
    }
    if (v === undefined) skipped.push(name);
    else values.set(name, v);
  }

  // the move: an instance's `.env` belongs under its own state/, and the
  // file being read may still be the product checkout's
  const target = opts.envTarget ?? opts.envFile;
  const seed = await readText(opts.envFile);
  if (target !== opts.envFile) {
    opts.out(`moving the environment: ${opts.envFile} → ${target} (every line is carried over; the old file is LEFT IN PLACE, so a running install keeps working — delete it yourself once ${target} is proven)`);
  }
  const { text, missing } = rewriteEnv(seed, values);
  await writeEnvFile(target, appendEnv(text, values, missing));
  changed.push(...values.keys());
  opts.out(`wrote ${changed.length} secret line(s) into ${target} from the Keychain (0600; every other line preserved): ${changed.join(", ") || "(none)"}`);
  if (migrated.length) opts.out(`copied from the user account to this instance's (${accounts.instance}), the old items left alone: ${migrated.join(", ")}`);
  for (const n of minted) opts.out(`minted ${n} — it was in neither the Keychain nor ${opts.envFile}: ${GENERATED_SECRETS[n]}`);
  if (minted.length) opts.out(`restart the console for a freshly minted secret to take effect (\`metistry restart console\`).`);
  if (missing.length) opts.out(`appended (no line existed): ${missing.join(", ")}`);
  if (skipped.length) opts.out(`not in the Keychain, left as they are: ${skipped.join(", ")}`);
  return { direction, changed, skipped, migrated, minted, wrote: target };
}

/** Mint a fresh random token into the Keychain and into `.env` — the only place a new secret is created. */
export async function mintSecret(name: string, opts: SecretsOptions): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${JSON.stringify(name)} is not a variable name`);
  if (!isSecretVar(name)) throw new Error(`${name} is not a secret-shaped name (it must end in ${SECRET_SUFFIXES.join(", ")} or be one of ${[...SECRET_NAMES].join(", ")})`);
  const platform = opts.platform ?? process.platform;
  requireDarwin(platform, opts.out);
  const { user, instance, accounts } = keychains(opts);
  const kc = scopeFor(name) === "instance" && instance ? instance : user;
  const value = (opts.mint ?? mintToken)();
  await kc.setSecret(name, value);
  const values = new Map([[name, value]]);
  const target = opts.envTarget ?? opts.envFile;
  const { text, missing } = rewriteEnv(await readText(target === opts.envFile ? opts.envFile : target), values);
  await writeEnvFile(target, appendEnv(text, values, missing));
  opts.out(`minted ${name} (${scopeFor(name)}-scoped: ${scopeReason(name)}) into the login Keychain under account ${kc.account} and ${target}.`);
  opts.out(`The value is not printed — read it with \`security find-generic-password -a ${kc.account} -s ${serviceFor(name)} -w\` if a service needs it pasted elsewhere.`);
  if (!instance && scopeFor(name) === "instance") opts.out(`(no instance_id available, so it went to the user account ${accounts.user}; the next \`secrets sync --to env\` with an instance copies it across)`);
}

// ---- purge -------------------------------------------------------------------

export interface PurgeOptions extends SecretsOptions {
  /** The instance directory being deleted — named in the output so an operator can see which one this is. */
  instanceDir: string;
  /** Without it, nothing is deleted: the preview is the whole command. */
  yes?: boolean | undefined;
}

export interface PurgeResult {
  /** the account whose items were listed/deleted — always the instance's, never the user's */
  account: string;
  /** instance-scoped names that HAVE an item under that account */
  found: string[];
  /** what was actually deleted (empty without `--yes`) */
  deleted: string[];
  /** user-scoped names deliberately left alone */
  kept: string[];
}

/**
 * Delete one instance's Keychain items, so removing a test instance
 * directory does not orphan them. Preview-then-confirm: without `--yes`
 * nothing is touched. Two refusals make it incapable of reaching the
 * person's own secrets — no instance_id, or an instance account that is
 * somehow the user account — rather than trusting the caller.
 */
export async function purgeSecrets(opts: PurgeOptions): Promise<PurgeResult> {
  const platform = opts.platform ?? process.platform;
  requireDarwin(platform, opts.out);
  const { instance, accounts } = keychains(opts);
  if (!instance || !accounts.instance) {
    throw new Error(`${opts.instanceDir} has no instance_id in identity.yaml, so it owns no Keychain account — there is nothing to purge (an instance gets one from \`metistry init\`, or from the next \`metistry secrets sync\`/\`metistry up\`)`);
  }
  if (accounts.instance === accounts.user) {
    throw new Error(`refusing to purge: this instance's account (${accounts.instance}) is the per-user account, and purging it would delete secrets that belong to you rather than to ${opts.instanceDir}`);
  }
  const names = await knownSecretNames(opts);
  const scoped = names.filter((n) => scopeFor(n) === "instance");
  const kept = names.filter((n) => scopeFor(n) === "user");
  const found: string[] = [];
  for (const n of scoped) if (await instance.hasSecret(n)) found.push(n);

  opts.out(`instance: ${opts.instanceDir}`);
  opts.out(`keychain account: ${accounts.instance} (this instance's instance_id)`);
  opts.out(`${found.length} item(s) to delete: ${found.join(", ") || "(none)"}`);
  opts.out(`never touched — the per-user account ${accounts.user} keeps: ${kept.join(", ") || "(nothing user-scoped)"}`);
  if (!opts.yes) {
    opts.out("");
    opts.out(`preview only. Nothing was deleted — rerun with --yes to delete the ${found.length} item(s) above. This does not remove ${opts.instanceDir} itself.`);
    return { account: accounts.instance, found, deleted: [], kept };
  }
  const deleted: string[] = [];
  for (const n of found) if (await instance.deleteSecret(n)) deleted.push(n);
  opts.out(`deleted ${deleted.length} item(s) from account ${accounts.instance}: ${deleted.join(", ") || "(none)"}`);
  if (deleted.length !== found.length) opts.out(`could not delete: ${found.filter((n) => !deleted.includes(n)).join(", ")}`);
  return { account: accounts.instance, found, deleted, kept };
}

export interface SecretListing {
  name: string;
  /** which account it BELONGS under, from the scope table */
  scope: SecretScope;
  inKeychain: boolean;
  /** which account an item was actually found under — "instance", "user", or none */
  foundUnder?: "instance" | "user";
  inEnv: boolean;
}

/** Names, scopes, and where each one lives. There is no code path here that can read a value. */
export async function listSecrets(opts: SecretsOptions): Promise<SecretListing[]> {
  const platform = opts.platform ?? process.platform;
  const { user, instance } = keychains(opts);
  const set = liveValues(await readText(opts.envFile));
  const rows: SecretListing[] = [];
  for (const name of await knownSecretNames(opts)) {
    const scope = scopeFor(name);
    let foundUnder: "instance" | "user" | undefined;
    if (platform === "darwin") {
      if (scope === "instance" && instance && (await instance.hasSecret(name))) foundUnder = "instance";
      else if (await user.hasSecret(name)) foundUnder = "user";
    }
    rows.push({ name, scope, inKeychain: foundUnder !== undefined, ...(foundUnder ? { foundUnder } : {}), inEnv: (set.get(name) ?? "") !== "" });
  }
  return rows;
}

/**
 * The listing. `scope` is where a secret BELONGS; `keychain` is the account
 * an item was actually found under — so `instance / user` reads "this one
 * has not been migrated yet", which the next `sync --to env` fixes.
 */
export function renderSecretList(rows: SecretListing[]): string {
  const width = Math.max(4, ...rows.map((r) => r.name.length));
  const head = `${"name".padEnd(width)}  scope     keychain  .env`;
  const body = rows.map((r) => `${r.name.padEnd(width)}  ${r.scope.padEnd(8)}  ${(r.foundUnder ?? "-").padEnd(8)}  ${r.inEnv ? "set" : "-"}`);
  const pending = rows.filter((r) => r.scope === "instance" && r.foundUnder === "user").map((r) => r.name);
  return [
    head,
    "-".repeat(head.length),
    ...body,
    "",
    "scope: instance = filed under this instance's instance_id; user = under the per-user account, shared by every instance (secrets.ts SECRET_SCOPES).",
    "keychain: the account an item was actually found under.",
    ...(pending.length ? [`still under the user account, copied to this instance's on the next \`metistry secrets sync --to env\`: ${pending.join(", ")}`] : []),
    "Values are never printed.",
  ].join("\n");
}
