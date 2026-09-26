// `metistry secrets` — two stores, both in the macOS login Keychain, which
// never share an item:
//
//   * the install's own variables (`metistry:<VAR>`): the canonical store for
//     every secret-shaped `.env` line; `.env` is a derived file, generated
//     from it at service start and never edited by hand
//     (docs/product/desktop-app-plan.md, step 4).
//
//       secrets sync --to keychain   import `.env`'s secret lines into the Keychain
//       secrets sync --to env        regenerate `.env`'s secret lines from the Keychain
//       secrets mint <VAR>           mint a random token into both
//       secrets list                 names and where each one lives — never a value
//       secrets purge                one instance's items, preview-then-confirm
//
//   * the owner-named secrets of plan §2.14 (`metistry:secret:<name>`, per
//     instance only): `set | replace | remove | hosts | grant`, `list
//     --named` — the section at the end of this file.
//
// Rules this module exists to enforce (they are code, not advice):
//   * A value never reaches argv, only a child's stdin (keychain.ts).
//   * A value is never printed, logged, or returned in a result object.
//   * `--to env` rewrites `.env` IN PLACE: every non-secret line, comment,
//     blank line and ordering survives byte-for-byte, because `.env` also
//     carries hand-written configuration this command must not own.

import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseDocument } from "yaml";
import {
  InstanceSecrets,
  SECRET_GRANT_MODES,
  SECRET_SERVICE_PREFIX,
  describeSecrets,
  instanceFile,
  instancePresence,
  mintToken,
  normalizeSecretHost,
  parseSecretGrantee,
  parseSecretsFile,
  resolveInstanceLayout,
  secretEnvName,
  secretNameIssue,
  secretRefsIn,
  secretService,
  secretValueIssue,
  type KeychainBackend,
  type SecretGrantMode,
  type SecretPresence,
  type SecretRow,
  type SecretsFile,
} from "@foldedspacelabs/metistry-core";
import { readStdin } from "./connect-repo.js";
import { realExec, type Exec } from "./exec.js";
import { Keychain, keychainAccount, securityKeychain, securityPresence, serviceFor } from "./keychain.js";
import { protectedRel, writeProtected, type ProtectedWrite } from "./protected-write.js";
import { StepFailed, StepRunner } from "./steps.js";

/** A variable is a secret when its name ends in one of these… */
export const SECRET_SUFFIXES = ["_TOKEN", "_PASSWORD", "_PRIVATE", "_SECRET", "_KEY"] as const;
/** …or carries one of them mid-name, because the per-bridge variables are `METISTRY_BRIDGE_TOKEN_<NAME>`. */
export const SECRET_INFIXES = ["_TOKEN_", "_PASSWORD_", "_SECRET_"] as const;
/**
 * …or is one of these exactly (third-party names that follow no
 * convention). Empty since the scrub: the product's only third-party
 * credentials are compute-provider keys, and `compute.yaml` requires their
 * names to be `_API_KEY`-shaped, which the suffix rule already catches. Kept
 * as the seam, because the next vendor that ignores the convention lands
 * here and nowhere else.
 */
export const SECRET_NAMES = new Set<string>([]);

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
  { scope: "user", match: /^METISTRY_AWS_(SECRET_ACCESS_KEY|SESSION_TOKEN)$/, why: "the person's own AWS credentials (aws-costs), not this instance's" },
  { scope: "user", match: /^METISTRY_DEVIN_API_KEY$/, why: "the person's own Devin (Cognition) credential (devin-knowledge) — one per Mac, shared by every instance, and it outlives any one instance directory" },
  { scope: "user", match: /^METISTRY_[A-Z0-9_]*_API_KEY$/, why: "a compute provider credential (compute.yaml `auth.secret`) — the person's own account with that provider, shared by every instance on this Mac (docs/ops/compute.md)" },
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
 * into `.env` when Postgres is first prepared. Everything else (the compute
 * provider keys, the GitHub PATs, the bridge tokens a service was already
 * started with) stays "not in the Keychain, left as it is".
 */
export const GENERATED_SECRETS: Readonly<Record<string, string>> = {
  METISTRY_LOCAL_OWNER_TOKEN: "the console's local owner door — an install that predates it gets one here (docs/ops/auth.md)",
  // The same bar, met for the same reason: its value means nothing outside
  // this install, nobody pastes it anywhere, and without it NO caller may
  // write a §4.7 protected path — so an install that predates the credential
  // split would find `metistry update` refused until it had one. The other
  // bridge tokens stay out of this table because a service was already
  // started with them; nothing has been started with this one.
  METISTRY_BRIDGE_TOKEN_RECONCILER_USER:
    "the vault bridge's OWNER bearer — the only credential that may write .metistry/ (docs/ops/auth.md); restart the reconciler once it is minted",
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
  if (minted.length) opts.out(`restart the service that reads a freshly minted secret for it to take effect — \`metistry restart console\`, and \`metistry restart reconciler\` for ${Object.keys(GENERATED_SECRETS).filter((n) => n.startsWith("METISTRY_BRIDGE_TOKEN_")).join(", ")}.`);
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
  /** owner-named secrets (`secrets.yaml`, §2.14) that HAVE an item under this instance's account */
  named: string[];
  /** which of those were actually deleted (empty without `--yes`) */
  namedDeleted: string[];
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
  // The owner-named secrets are this instance's too, under the same
  // account: deleting the directory must orphan them no more than the rest.
  // Their names come from the instance's own secrets.yaml — the one list of
  // them there is.
  const store = new InstanceSecrets(securityKeychain(opts.exec ?? realExec), accounts.instance);
  const named: string[] = [];
  for (const n of await namedSecretNames(opts.instanceDir, opts.out)) if (await store.has(n)) named.push(n);

  opts.out(`instance: ${opts.instanceDir}`);
  opts.out(`keychain account: ${accounts.instance} (this instance's instance_id)`);
  opts.out(`${found.length} item(s) to delete: ${found.join(", ") || "(none)"}`);
  opts.out(`${named.length} named secret(s) to delete (${SECRET_SERVICE_PREFIX}<name>): ${named.join(", ") || "(none)"}`);
  opts.out(`never touched — the per-user account ${accounts.user} keeps: ${kept.join(", ") || "(nothing user-scoped)"}`);
  if (!opts.yes) {
    opts.out("");
    opts.out(`preview only. Nothing was deleted — rerun with --yes to delete the ${found.length + named.length} item(s) above. This does not remove ${opts.instanceDir} itself.`);
    return { account: accounts.instance, found, deleted: [], kept, named, namedDeleted: [] };
  }
  const deleted: string[] = [];
  for (const n of found) if (await instance.deleteSecret(n)) deleted.push(n);
  const namedDeleted: string[] = [];
  for (const n of named) if (await store.remove(n)) namedDeleted.push(n);
  opts.out(`deleted ${deleted.length + namedDeleted.length} item(s) from account ${accounts.instance}: ${[...deleted, ...namedDeleted.map((n) => `${SECRET_SERVICE_PREFIX}${n}`)].join(", ") || "(none)"}`);
  const failed = [...found.filter((n) => !deleted.includes(n)), ...named.filter((n) => !namedDeleted.includes(n))];
  if (failed.length) opts.out(`could not delete: ${failed.join(", ")}`);
  return { account: accounts.instance, found, deleted, kept, named, namedDeleted };
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

// ---- owner-named secrets (plan §2.14) -------------------------------------------
//
// The store the product's connections, providers and manifests reference as
// `{{ secret.name }}`. Everything above this line is the install's own
// variables (`metistry:<VAR>`, the `.env` generator); everything below is the
// owner's secrets, and the two never share an item:
//
//   secrets set <name> [--hosts a,b] [--expires <date>]   the value on stdin
//   secrets replace <name> [--expires <date>]             the value on stdin
//   secrets remove <name> [--yes]                         preview-then-confirm
//   secrets hosts <name> [<host> …] [--clear]             *Sent only to*
//   secrets grant <name> <connection:x|agent:y> <on|ask|off>
//   secrets list --named [--json]                         names — never a value
//
// **Per instance only** (ruling Q3): the value goes into the login Keychain
// under this instance's `instance_id` through core's `InstanceSecrets`,
// which is bound to that one account; there is no user scope and no
// fallback to one. The policy goes into `.metistry/secrets.yaml` — a §4.7
// protected path — through the reconciler as the owner (`writeProtected`),
// edited as a YAML document so hand-written comments survive, and the
// RESULT is validated by core's schema before anything is written.
//
// A value arrives on stdin only — never argv, never a flag — and is never
// printed, logged or returned: every result below carries names.

/** `.metistry/secrets.yaml` as this instance spells it. */
export function secretsFilePath(instanceDir: string): string {
  return instanceFile(instanceDir, "secrets");
}

const SECRETS_HEADER = [
  "# secrets.yaml — this instance's secrets: names and policy, NEVER a value.",
  "# The values are in the login Keychain (service metistry:secret:<name>,",
  "# account = this instance's instance_id). Written by `metistry secrets`",
  "# (docs/ops/cli.md); a §4.7 protected path, so only you change it.",
  "",
];

export interface NamedSecretsOptions {
  /** the instance repo whose `.metistry/secrets.yaml` this edits */
  instanceDir: string;
  /** its `instance_id` — the Keychain account, and the only one */
  instanceId: string | undefined;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  exec?: Exec | undefined;
  fetchFn?: typeof fetch | undefined;
  /** test seam: the Keychain. Default: the login Keychain through `security`, on darwin. */
  keychain?: KeychainBackend | undefined;
  /** where a value is read — stdin, so it is never in argv or shell history */
  readSecret?: (() => Promise<string>) | undefined;
  /** print the plan; touch neither the Keychain nor the file */
  dryRun?: boolean | undefined;
  out: (line: string) => void;
}

interface EditableSecrets {
  path: string;
  doc: ReturnType<typeof parseDocument>;
  file: SecretsFile;
}

/** The names `secrets.yaml` lists, for `purge`. A file that does not validate lists none, and says so. */
async function namedSecretNames(instanceDir: string, out: (l: string) => void): Promise<string[]> {
  const path = secretsFilePath(instanceDir);
  if (!existsSync(path)) return [];
  try {
    return Object.keys(parseSecretsFile(await readFile(path, "utf8")).secrets);
  } catch (e) {
    out(`${path} does not validate, so its named secrets are not listed here (${e instanceof Error ? e.message : String(e)})`);
    return [];
  }
}

/** The instance's file as an editable document — comments and all — refusing one this command could not read back. */
async function openSecrets(opts: Pick<NamedSecretsOptions, "instanceDir">): Promise<EditableSecrets> {
  const path = secretsFilePath(opts.instanceDir);
  const text = existsSync(path) ? await readFile(path, "utf8") : SECRETS_HEADER.join("\n");
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new StepFailed(`${path} is not valid YAML (${doc.errors[0]?.message}) — fix it by hand; refusing to edit a file this command cannot read back`);
  let file: SecretsFile;
  try {
    file = parseSecretsFile(text);
  } catch (e) {
    throw new StepFailed(`${path}: ${e instanceof Error ? e.message : String(e)} — fix it by hand; refusing to edit it`);
  }
  return { path, doc, file };
}

/** Validate the RESULT, then write it as the owner, through the reconciler. */
async function commitSecrets(opts: NamedSecretsOptions, edit: EditableSecrets, message: string): Promise<ProtectedWrite> {
  const content = String(edit.doc);
  try {
    parseSecretsFile(content);
  } catch (e) {
    throw new StepFailed(`refusing to write ${edit.path}: the result would be invalid — ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out, exec: opts.exec ?? realExec, env: opts.env });
  const delivery = await writeProtected(r, protectedRel(opts.instanceDir, "secrets"), content, message, {
    env: opts.env,
    platform: opts.platform,
    uid: opts.uid,
    fetchFn: opts.fetchFn ?? fetch,
    instanceDir: opts.instanceDir,
  });
  return delivery;
}

function has(file: SecretsFile, name: string): boolean {
  return Object.hasOwn(file.secrets, name);
}

function requireNamed(file: SecretsFile, name: string, path: string): void {
  if (!has(file, name)) throw new StepFailed(`no secret named ${name} in ${path} — \`metistry secrets set ${name}\` creates it`);
}

function checkName(name: string | undefined): string {
  const issue = secretNameIssue(name);
  if (issue || name === undefined) throw new StepFailed(issue ?? "name the secret");
  return name;
}

/** Hosts, normalised and deduplicated — or a refusal naming the one that is not a host. */
export function parseSecretHosts(hosts: readonly string[]): string[] {
  const out: string[] = [];
  for (const h of hosts) {
    const n = normalizeSecretHost(h);
    if (!n) throw new StepFailed(`${JSON.stringify(h)} is not a host — a host name, or host:port when the port is not 443; no scheme, no path, no wildcard (api.github.com, not https://api.github.com/)`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function checkExpires(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  // the schema is the one judge of the spelling: a one-entry file through it
  try {
    parseSecretsFile(`secrets:\n  probe:\n    expires: ${JSON.stringify(v)}\n`);
  } catch {
    throw new StepFailed(`--expires ${JSON.stringify(v)} is not an ISO date (2026-12-31) or date-time`);
  }
  return v;
}

/**
 * This instance's store — or a refusal. No instance_id means no account, and
 * there is deliberately no other account to fall back to (Q3). No Keychain
 * (Linux, a container) means nowhere to put a value.
 */
function instanceStore(opts: NamedSecretsOptions): InstanceSecrets {
  if (!opts.instanceId) {
    throw new StepFailed(`${opts.instanceDir} has no instance_id in identity.yaml, and a secret belongs to exactly one instance — \`metistry up\` or \`metistry secrets sync --to env\` mints one`);
  }
  if (opts.keychain) return new InstanceSecrets(opts.keychain, opts.instanceId);
  if (opts.platform !== "darwin") {
    throw new StepFailed(`a secret's value lives in the macOS login Keychain, which this host (${opts.platform}) does not have — run this on the Mac that holds the instance`);
  }
  return new InstanceSecrets(securityKeychain(opts.exec ?? realExec), opts.instanceId);
}

async function readValue(opts: NamedSecretsOptions, name: string): Promise<string> {
  const value = (await (opts.readSecret ?? readStdin)()).trim();
  const issue = secretValueIssue(value);
  if (issue) throw new StepFailed(`${issue} — pipe the value for ${name} on stdin (it is never taken as an argument)`);
  return value;
}

export interface NamedSecretResult {
  name: string;
  /** the Keychain item it is filed under — names, never a value */
  service: string;
  account: string | undefined;
  /** the policy after the verb, as the file now holds it */
  hosts: string[];
  delivery?: ProtectedWrite | undefined;
}

/** `secrets set <name>`: a NEW secret — its value from stdin into this instance's Keychain account, its policy into secrets.yaml. */
export async function secretsSet(rawName: string | undefined, args: { hosts?: string[] | undefined; expires?: string | undefined }, opts: NamedSecretsOptions): Promise<NamedSecretResult> {
  const name = checkName(rawName);
  const hosts = parseSecretHosts(args.hosts ?? []);
  const expires = checkExpires(args.expires);
  const edit = await openSecrets(opts);
  if (has(edit.file, name)) throw new StepFailed(`${name} is already set in ${edit.path} — \`metistry secrets replace ${name}\` swaps its value, \`secrets hosts\`/\`secrets grant\` change its policy`);
  const store = instanceStore(opts);
  const value = await readValue(opts, name);
  const service = secretService(name);
  if (opts.dryRun) {
    opts.out(`[dry-run] would store ${name} in the login Keychain (${service}, account ${store.account}) and add it to ${edit.path}`);
    return { name, service, account: store.account, hosts };
  }
  // The item first: a policy line naming a missing item shows as `present:
  // false` wherever it is listed, while an item with no line is invisible.
  // A rerun after a failed file write is a `set` again — the file does not
  // name it yet — and overwrites the item it left.
  await store.set(name, value);
  opts.out(`stored ${name} in the login Keychain: ${service}, account ${store.account} (this instance's instance_id). The value is not printed.`);
  edit.doc.setIn(["secrets", name], edit.doc.createNode({ hosts, grants: {}, ...(expires ? { expires } : {}) }, { flow: false }));
  flowList(edit, name);
  if (hosts.length === 0) opts.out(`no hosts: Metistry fills ${name} in for no server until \`metistry secrets hosts ${name} <host>\` names one (a local agent you grant it still gets it as ${secretEnvName(name)}).`);
  const delivery = await commitSecrets(opts, edit, `secrets: set ${name}`);
  return { name, service, account: store.account, hosts, delivery };
}

/** Keep `hosts: [a, b]` on one line — how a person writes a short list. */
function flowList(edit: EditableSecrets, name: string): void {
  const node = edit.doc.getIn(["secrets", name, "hosts"], true) as { flow?: boolean } | undefined;
  if (node && typeof node === "object") node.flow = true;
}

/** `secrets replace <name>`: a new value for a secret this instance already has. An expiry recorded for the old value does not describe the new one, so it is cleared unless `--expires` gives the new one. */
export async function secretsReplace(rawName: string | undefined, args: { expires?: string | undefined }, opts: NamedSecretsOptions): Promise<NamedSecretResult> {
  const name = checkName(rawName);
  const expires = checkExpires(args.expires);
  const edit = await openSecrets(opts);
  if (!has(edit.file, name)) throw new StepFailed(`no secret named ${name} in ${edit.path} — \`metistry secrets set ${name}\` creates it`);
  const store = instanceStore(opts);
  const value = await readValue(opts, name);
  const service = secretService(name);
  const policy = edit.file.secrets[name]!;
  if (opts.dryRun) {
    opts.out(`[dry-run] would replace the value of ${name} (${service}, account ${store.account})`);
    return { name, service, account: store.account, hosts: policy.hosts };
  }
  await store.set(name, value);
  opts.out(`replaced the value of ${name} in the login Keychain (${service}, account ${store.account}). The value is not printed.`);
  let delivery: ProtectedWrite | undefined;
  if (expires !== policy.expires) {
    if (expires) edit.doc.setIn(["secrets", name, "expires"], expires);
    else edit.doc.deleteIn(["secrets", name, "expires"]);
    opts.out(expires ? `expires: ${expires}` : `cleared the old expiry (${policy.expires}) — it was the old value's`);
    delivery = await commitSecrets(opts, edit, `secrets: replace ${name}`);
  }
  return { name, service, account: store.account, hosts: policy.hosts, ...(delivery ? { delivery } : {}) };
}

export interface RemoveSecretResult {
  name: string;
  /** files under `.metistry/` that reference `{{ secret.<name> }}` — what stops working */
  referencedBy: string[];
  /** false without `--yes`: the preview is the whole command */
  removed: boolean;
  itemDeleted: boolean;
  delivery?: ProtectedWrite | undefined;
}

/** Every file under `.metistry/` (state excluded) that references `{{ secret.<name> }}`, instance-relative. */
export async function secretReferences(instanceDir: string, name: string): Promise<string[]> {
  const root = resolveInstanceLayout(instanceDir);
  const base = root.path("metistryDir");
  const state = root.path("stateDir");
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (p !== state) await walk(p);
        continue;
      }
      if (!e.isFile() || !/\.(ya?ml|md|json)$/.test(e.name)) continue;
      const text = await readFile(p, "utf8").catch(() => "");
      if (secretRefsIn(text).names.includes(name)) found.push(relative(instanceDir, p));
    }
  };
  if (base !== instanceDir.replace(/\/+$/, "")) await walk(base);
  return found;
}

/** `secrets remove <name> [--yes]`: this instance's item and its policy. Preview-then-confirm; the preview names what references it. */
export async function secretsRemove(rawName: string | undefined, args: { yes?: boolean | undefined }, opts: NamedSecretsOptions): Promise<RemoveSecretResult> {
  const name = checkName(rawName);
  const edit = await openSecrets(opts);
  const store = instanceStore(opts);
  const named = has(edit.file, name);
  const present = await store.has(name);
  if (!named && !present) throw new StepFailed(`this instance has no secret named ${name} — neither in ${edit.path} nor in the login Keychain under account ${store.account}`);
  const referencedBy = await secretReferences(opts.instanceDir, name);
  opts.out(`secret: ${name} — ${secretService(name)}, account ${store.account} (this instance only)`);
  opts.out(`in secrets.yaml: ${named ? "yes" : "no"}; in the Keychain: ${present ? "yes" : "no"}`);
  opts.out(referencedBy.length ? `referenced by — these stop working once it is gone: ${referencedBy.join(", ")}` : "referenced by: nothing under .metistry/");
  if (!args.yes || opts.dryRun) {
    opts.out("");
    opts.out(`preview only. Nothing was removed — rerun with --yes to delete ${name}.`);
    return { name, referencedBy, removed: false, itemDeleted: false };
  }
  // The item first, then the line: a line left behind reads `present: false`
  // and a rerun finishes the job; an item left behind would be invisible.
  const itemDeleted = present ? await store.remove(name) : false;
  if (present && !itemDeleted) throw new StepFailed(`the login Keychain would not delete ${secretService(name)} (account ${store.account}) — nothing else was changed`);
  let delivery: ProtectedWrite | undefined;
  if (named) {
    edit.doc.deleteIn(["secrets", name]);
    delivery = await commitSecrets(opts, edit, `secrets: remove ${name}`);
  }
  opts.out(`removed ${name}${itemDeleted ? " — the Keychain item is deleted" : ""}${named ? " and its line in secrets.yaml" : ""}.`);
  return { name, referencedBy, removed: true, itemDeleted, ...(delivery ? { delivery } : {}) };
}

/** `secrets hosts <name> [<host> …] [--clear]`: *Sent only to*. No hosts and no `--clear` shows the list; hosts REPLACE it; `--clear` empties it. */
export async function secretsHosts(rawName: string | undefined, args: { hosts: string[]; clear?: boolean | undefined }, opts: NamedSecretsOptions): Promise<NamedSecretResult> {
  const name = checkName(rawName);
  const edit = await openSecrets(opts);
  requireNamed(edit.file, name, edit.path);
  const service = secretService(name);
  const account = opts.instanceId;
  if (args.hosts.length === 0 && !args.clear) {
    const current = edit.file.secrets[name]!.hosts;
    opts.out(`${name} is sent only to: ${current.join(", ") || "(no host — filled in for no server)"}`);
    return { name, service, account, hosts: current };
  }
  if (args.hosts.length > 0 && args.clear) throw new StepFailed("give hosts or --clear, not both — hosts replace the list, --clear empties it");
  const hosts = args.clear ? [] : parseSecretHosts(args.hosts);
  edit.doc.setIn(["secrets", name, "hosts"], hosts);
  flowList(edit, name);
  opts.out(`${name} is sent only to: ${hosts.join(", ") || "(no host — filled in for no server)"}`);
  const delivery = await commitSecrets(opts, edit, `secrets: hosts for ${name}`);
  return { name, service, account, hosts, delivery };
}

/** `secrets grant <name> <grantee> <on|ask|off>`: *Who may use it*. */
export async function secretsGrant(rawName: string | undefined, grantee: string | undefined, mode: string | undefined, opts: NamedSecretsOptions): Promise<NamedSecretResult & { grantee: string; mode: SecretGrantMode }> {
  const name = checkName(rawName);
  if (!grantee || !parseSecretGrantee(grantee)) throw new StepFailed(`${JSON.stringify(grantee ?? "")} is not a grantee — connection:<name> or agent:<id> (e.g. connection:github, agent:devin)`);
  if (!mode || !(SECRET_GRANT_MODES as readonly string[]).includes(mode)) throw new StepFailed(`the mode is one of ${SECRET_GRANT_MODES.join(", ")} — not ${JSON.stringify(mode ?? "")}`);
  const edit = await openSecrets(opts);
  requireNamed(edit.file, name, edit.path);
  // setIn with a key holding `:` — the yaml library quotes it where it must
  edit.doc.setIn(["secrets", name, "grants", grantee], mode);
  opts.out(`${grantee} may use ${name}: ${mode}${mode === "ask" ? " (each use waits for your answer in Needs You)" : mode === "off" ? " (refused)" : ""}`);
  const delivery = await commitSecrets(opts, edit, `secrets: ${grantee} ${mode} for ${name}`);
  return { name, service: secretService(name), account: opts.instanceId, hosts: edit.file.secrets[name]!.hosts, delivery, grantee, mode: mode as SecretGrantMode };
}

/**
 * `secrets list --named`: the same rows `GET /api/secrets` serves, from the
 * file and a presence probe — never a value. `last_used` is null here: it is
 * derived state the console reads through its named query, and the CLI
 * talks to no database (invariant 3).
 */
export async function secretsListNamed(opts: NamedSecretsOptions): Promise<SecretRow[]> {
  const path = secretsFilePath(opts.instanceDir);
  const file = existsSync(path) ? parseSecretsFile(await readFile(path, "utf8")) : parseSecretsFile("");
  let presence: SecretPresence | undefined;
  if (opts.instanceId && (opts.keychain || opts.platform === "darwin")) {
    presence = instancePresence(opts.keychain ? (s, a) => opts.keychain!.has(s, a) : securityPresence(opts.exec ?? realExec), opts.instanceId);
  }
  return describeSecrets(file, presence);
}

export function renderNamedSecrets(rows: SecretRow[], instanceId: string | undefined): string {
  if (rows.length === 0) return "no secrets yet — `metistry secrets set <name> --hosts <host>` (the value on stdin) adds one.";
  const width = Math.max(4, ...rows.map((r) => r.name.length));
  const head = `${"name".padEnd(width)}  keychain  sent only to / who may use it`;
  const body = rows.map((r) => {
    const where = r.present === null ? "?" : r.present ? "yes" : "MISSING";
    const grants = r.grants.map((g) => `${g.to} ${g.mode}`).join(", ");
    return `${r.name.padEnd(width)}  ${where.padEnd(8)}  ${r.hosts.join(", ") || "(no host)"}${grants ? ` / ${grants}` : ""}${r.expires ? ` · expires ${r.expires}` : ""}`;
  });
  return [
    head,
    "-".repeat(head.length),
    ...body,
    "",
    `keychain: an item under this instance's account${instanceId ? ` (${instanceId})` : ""}; ? = no Keychain to ask. Last used is the console's: GET /api/secrets.`,
    "Values are never printed.",
  ].join("\n");
}
