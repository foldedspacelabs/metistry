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
//     --named` — the section after the install's variables.
//
// Both are filed under ONE account: this instance's `instance_id`. The
// shared per-user scope every instance on this Mac once read
// (`SECRET_SCOPES`) is retired (plan §2.14, ruling Q3): `migrate-scope`
// copies its items into the instance, and `purge-shared` removes an original
// once every instance this Mac knows has its copy — the last section.
//
// Rules this module exists to enforce (they are code, not advice):
//   * A value never reaches argv, only a child's stdin (keychain.ts).
//   * A value is never printed, logged, or returned in a result object.
//   * `--to env` rewrites `.env` IN PLACE: every non-secret line, comment,
//     blank line and ordering survives byte-for-byte, because `.env` also
//     carries hand-written configuration this command must not own.

import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
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
  parseCompute,
  parseSecretGrantee,
  parseSecretReference,
  parseSecretsFile,
  resolveInstanceLayout,
  resolveUrl,
  secretDeliveryVar,
  secretEnvName,
  secretNameIssue,
  secretRefsIn,
  secretService,
  secretValueIssue,
  validateManifest,
  type DeploymentShape,
  type KeychainBackend,
  type SecretGrantMode,
  type SecretPresence,
  type SecretRow,
  type SecretsFile,
} from "@foldedspacelabs/metistry-core";
import { readStdin } from "./connect-repo.js";
import { realExec, type Exec } from "./exec.js";
import { envPaths, readInstanceId } from "./instance.js";
import { Keychain, keychainAccount, securityKeychain, securityPresence, serviceFor } from "./keychain.js";
import { launchAgentsDir, LABEL_PREFIX } from "./launchd.js";
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

// ---- one account: this instance's ---------------------------------------------
//
// An instance directory is self-contained (owner-ratified 2026-09-09), and
// since ruling Q3 (plan §2.14) so are its secrets: every item this command
// reads or writes is filed under the instance's `instance_id`. Deleting the
// instance directory orphans nothing (`metistry secrets purge`).
//
// There used to be a second, per-user account every instance on this Mac
// shared (`SECRET_SCOPES` put third-party credentials there). It is retired:
// `migrate-scope` copies its items in, and nothing here resolves a value
// from it any more. The one fallback left is for an install with no
// `instance_id` at all — there is no instance account to use until
// `metistry up` or `secrets sync` mints one — and it is the install's own
// variables' only. `METISTRY_SIGN_IDENTITY` and `METISTRY_GITHUB_OAUTH_CLIENT_ID`
// are not secrets and never reach here.

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

/**
 * The long-running service that holds each generated secret in memory from
 * the moment it starts. A running service never re-reads `.env`, so when
 * `sync --to env` writes a DIFFERENT value for one of these, that service
 * refuses the new value (401 / `unauthenticated`) until it is restarted —
 * which the sync must say, never leave to be discovered.
 */
export const GENERATED_SECRET_READERS: Readonly<Record<string, TokenService>> = {
  METISTRY_LOCAL_OWNER_TOKEN: "console",
  METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "reconciler",
};

export type TokenService = "console" | "reconciler";

/**
 * Whether a service is up right now, by whether its port answers at all —
 * any HTTP status counts, because the question is "is a process holding the
 * old token", not "is it healthy". Undefined = this install names no URL
 * for it, so the caller cannot tell and says so conditionally.
 */
export async function serviceAnswers(
  service: TokenService,
  opts: { env: NodeJS.ProcessEnv; shape?: DeploymentShape | undefined; fetchFn?: typeof fetch; timeoutMs?: number },
): Promise<boolean | undefined> {
  const configured =
    service === "console"
      ? opts.env.METISTRY_CONSOLE_URL || `http://127.0.0.1:${Number.parseInt(opts.env.METISTRY_CONSOLE_PORT ?? "", 10) || 8080}`
      : opts.env.METISTRY_RECONCILER_URL;
  if (!configured) return undefined;
  const url = resolveUrl(configured, { shape: opts.shape ?? "compose", vantage: "host" }).replace(/\/+$/, "");
  try {
    await (opts.fetchFn ?? fetch)(`${url}/health`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 1500) });
    return true;
  } catch {
    return false;
  }
}

export interface Accounts {
  /** the per-user account (`keychainAccount()`): the retired shared scope, and an install with no instance_id */
  user: string;
  /** the instance's `instance_id`; absent when no instance directory is configured, or it has no id yet */
  instance?: string | undefined;
}

/**
 * The account an install variable's item is filed under: the instance's,
 * always — the user account only while the install has no instance_id yet.
 * `name` no longer decides anything (the scope table is retired); it stays
 * in the signature so every caller keeps asking per variable.
 */
export function accountFor(_name: string, accounts: Accounts): string {
  return accounts.instance ?? accounts.user;
}

// ---- the retired shared scope (plan §2.14, T4-3) --------------------------------
//
// What is left of `SECRET_SCOPES`: the names it filed under the per-user
// account. They are used for exactly two things — to FIND the originals
// `migrate-scope` copies, and to decide which of them `purge-shared` may
// remove. Each is now an owner-named secret of every instance that uses it,
// under its lowercase name (`METISTRY_DEVIN_API_KEY` → `devin_api_key`).

export const RETIRED_SHARED_SCOPE: readonly { match: RegExp; what: string }[] = [
  { match: /^METISTRY_AWS_(SECRET_ACCESS_KEY|SESSION_TOKEN)$/, what: "your AWS credentials (aws-costs)" },
  { match: /^METISTRY_DEVIN_API_KEY$/, what: "your Devin (Cognition) credential" },
  // not `METISTRY_SECRET_*`: that is where a named secret is DELIVERED to a
  // service (T4-18, core's `secretDeliveryVar`), never a shared-scope original
  { match: /^METISTRY_(?!SECRET_)[A-Z0-9_]*_API_KEY$/, what: "a compute provider credential (compute.yaml `auth.secret`)" },
];

/** Whether the retired shared scope filed this variable under the per-user account. */
export function wasSharedScope(varName: string): boolean {
  return RETIRED_SHARED_SCOPE.some((r) => r.match.test(varName));
}

/** The owner-named secret a shared-scope variable becomes: `METISTRY_DEVIN_API_KEY` → `devin_api_key`. Undefined when it is not one, or the result is not a secret name. */
export function sharedScopeSecretName(varName: string): string | undefined {
  if (!wasSharedScope(varName)) return undefined;
  const name = varName.replace(/^METISTRY_/, "").toLowerCase();
  return secretNameIssue(name) === undefined ? name : undefined;
}

/** The command the doctor row, `update` and `sync` hand the owner. */
export const MIGRATE_SCOPE_COMMAND = "metistry secrets migrate-scope";

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
  /** The instance's `instance_id`: the account every item is filed under. Absent = the install's own variables fall back to the user account until one is minted. */
  instanceId?: string | undefined;
  /** `.env.example` — the canonical list of variable names, so a fresh install still knows what a secret is called. */
  exampleFile?: string | undefined;
  exec?: Exec | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  out: (line: string) => void;
  mint?: (() => string) | undefined;
  /** `--to env`: whether a service that holds a token is running now (`serviceAnswers` in the CLI). Absent = unknown, so a changed token's restart hint is conditional. */
  serviceRunning?: ((service: TokenService) => Promise<boolean | undefined>) | undefined;
  /**
   * `--to env`: named secrets this instance's services read — every
   * `{{ secret.x }}` compute.yaml's providers reference (core's
   * `providerSecretNames`). Each is written as `METISTRY_SECRET_X` from this
   * instance's item, which is how a key reaches the engine without the
   * engine ever touching the Keychain (T4-18). Nothing else named is
   * delivered: a secret no service reads stays in the Keychain.
   */
  deliver?: readonly string[] | undefined;
}

export type SyncDirection = "keychain" | "env";

export interface SyncResult {
  direction: SyncDirection;
  /** names only — a result object must never be able to carry a value into a log */
  changed: string[];
  skipped: string[];
  /** shared-scope variables whose original is still only under the per-user account — not read; `migrate-scope` copies them (presence only, never a value) */
  unmigrated: string[];
  /** `--to keychain`: shared-scope variables not imported — each is an owner-named secret now, set with `secrets set` */
  named?: string[];
  /** `--to env`: GENERATED_SECRETS names that existed nowhere and were created by this run */
  minted?: string[];
  /** `--to env`: GENERATED_SECRETS names missing from the Keychain but live in `.env` — copied INTO the Keychain, never re-minted, so a running service keeps working */
  adopted?: string[];
  /** `--to env`: secret names whose `.env` value this run changed (a service started before it holds the old one) */
  rotated?: string[];
  /** `--to env`: services seen running with a value this run changed — each needs `metistry restart <service>` */
  restart?: TokenService[];
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
async function knownSecretNames(opts: Pick<SecretsOptions, "envFile" | "exampleFile">): Promise<string[]> {
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

/**
 * The handles a run needs. `own` is the ONE account this install's items
 * are read from and written to — the instance's, or the user's only while
 * there is no instance_id. `user` is kept for presence probes of the
 * retired shared scope (never a value) and for purge's refusal.
 */
function keychains(opts: SecretsOptions): { own: Keychain; user: Keychain; named?: InstanceSecrets; accounts: Accounts } {
  const exec = opts.exec ?? realExec;
  const accounts: Accounts = { user: keychainAccount(opts.env ?? process.env), instance: opts.instanceId };
  const user = new Keychain(exec, accounts.user);
  return {
    own: accounts.instance ? new Keychain(exec, accounts.instance) : user,
    user,
    ...(accounts.instance ? { named: new InstanceSecrets(securityKeychain(exec), accounts.instance) } : {}),
    accounts,
  };
}

export async function syncSecrets(direction: SyncDirection, opts: SecretsOptions): Promise<SyncResult> {
  const platform = opts.platform ?? process.platform;
  requireDarwin(platform, opts.out);
  const { own, user, named, accounts } = keychains(opts);
  const names = await knownSecretNames(opts);
  const changed: string[] = [];
  const skipped: string[] = [];
  const unmigrated: string[] = [];
  opts.out(accounts.instance ? `keychain account: ${accounts.instance} (this instance's instance_id)` : `keychain account: ${accounts.user} — this install has no instance_id yet, so its own variables are filed there until one is minted`);

  if (direction === "keychain") {
    const values = liveValues(await readText(opts.envFile));
    const notImported: string[] = [];
    for (const name of names) {
      const v = values.get(name);
      if (v === undefined || v === "") {
        skipped.push(name);
        continue;
      }
      // A third-party credential is an owner-named secret now, and its
      // policy (where it may be sent, who may use it) is the owner's to
      // write — so it is set by `secrets set`, never swept in from `.env`.
      if (wasSharedScope(name)) {
        notImported.push(name);
        continue;
      }
      await own.setSecret(name, v);
      changed.push(name);
    }
    opts.out(`imported ${changed.length} secret(s) into the login Keychain as ${serviceFor("<VAR>")}: ${changed.join(", ") || "(none)"}`);
    if (skipped.length) opts.out(`unset in ${opts.envFile}, so not imported: ${skipped.join(", ")}`);
    if (notImported.length) {
      opts.out(`not imported — each is an owner-named secret of this instance now (plan §2.14), stored with its value on stdin: ${notImported.map((n) => `${n} → \`metistry secrets set ${sharedScopeSecretName(n) ?? "<name>"}\``).join(", ")}`);
    }
    opts.out(`${opts.envFile} was NOT changed — run \`metistry secrets sync --to env\` once you are ready for it to be generated.`);
    return { direction, changed, skipped, unmigrated, named: notImported };
  }

  // One account, no fallback: an item is this instance's or it is not in
  // the Keychain. A shared-scope variable is filled from the owner-named
  // secret it became, and its original under the per-user account is never
  // read — only asked whether it exists, so the owner is told to migrate.
  const values = new Map<string, string>();
  const minted: string[] = [];
  const adopted: string[] = [];
  // what `.env` holds NOW — the values every running service was started with
  const seed = await readText(opts.envFile);
  const before = liveValues(seed);
  for (const name of names) {
    let v: string | undefined;
    if (wasSharedScope(name)) {
      const secret = sharedScopeSecretName(name);
      v = named && secret ? await named.value(secret) : undefined;
      if (v === undefined && accounts.instance && (await user.hasSecret(name))) unmigrated.push(name);
    } else {
      v = await own.getSecret(name);
      if (v === undefined && GENERATED_SECRETS[name]) {
        const inEnv = before.get(name);
        if (inEnv) {
          // Not in the Keychain, but `.env` has one — and the running console
          // or reconciler was started with exactly that value. Adopt it: the
          // Keychain gains it and nothing a service holds changes. Minting
          // here would lock every running service out of its own install.
          v = inEnv;
          await own.setSecret(name, v);
          adopted.push(name);
        } else {
          // Nowhere yet, and one of the few whose value only ever means "this
          // install": mint it into the Keychain now, so an instance that
          // predates the variable gains it on the next sync rather than
          // needing a verb.
          v = (opts.mint ?? mintToken)();
          await own.setSecret(name, v);
          minted.push(name);
        }
      }
    }
    if (v === undefined) skipped.push(name);
    else values.set(name, v);
  }
  // the named secrets a service reads (compute.yaml's providers): delivered
  // under their own variable, from this instance's item and nowhere else
  for (const name of opts.deliver ?? []) {
    const line = secretDeliveryVar(name);
    const v = named ? await named.value(name) : undefined;
    if (v === undefined || v === "") skipped.push(line);
    else values.set(line, v);
  }

  // the move: an instance's `.env` belongs under its own state/, and the
  // file being read may still be the product checkout's
  const target = opts.envTarget ?? opts.envFile;
  if (target !== opts.envFile) {
    opts.out(`moving the environment: ${opts.envFile} → ${target} (every line is carried over; the old file is LEFT IN PLACE, so a running install keeps working — delete it yourself once ${target} is proven)`);
  }
  // a line that already holds its value is left byte-for-byte as it is
  const toWrite = new Map([...values].filter(([n, v]) => before.get(n) !== v));
  const { text, missing } = rewriteEnv(seed, toWrite);
  await writeEnvFile(target, appendEnv(text, toWrite, missing));
  changed.push(...values.keys());
  opts.out(`wrote ${changed.length} secret line(s) into ${target} from the Keychain (0600; every other line preserved): ${changed.join(", ") || "(none)"}`);
  for (const n of adopted) opts.out(`adopted ${n} from ${opts.envFile} into the Keychain — it was not in the Keychain, and the value the running services hold is kept (nothing to restart)`);
  for (const n of minted) opts.out(`minted ${n} — it was in neither the Keychain nor ${opts.envFile}: ${GENERATED_SECRETS[n]}`);
  // Every value this run CHANGED in `.env` — minted, or the Keychain's
  // differing from the file's — is one a service started earlier does not
  // hold. Never silent: name the service, whether it is running, and the
  // exact command.
  const rotated = [...values.keys()].filter((n) => (before.get(n) ?? "") !== values.get(n));
  const restart: TokenService[] = [];
  const byService = new Map<TokenService, string[]>();
  for (const n of rotated) {
    const svc = GENERATED_SECRET_READERS[n];
    if (svc) byService.set(svc, [...(byService.get(svc) ?? []), n]);
  }
  for (const [svc, vars] of byService) {
    const running = opts.serviceRunning ? await opts.serviceRunning(svc) : undefined;
    const cmd = `\`metistry restart ${svc}\``;
    if (running === true) {
      restart.push(svc);
      opts.out(`RESTART NEEDED: the ${svc} is running with the previous ${vars.join(", ")} and will refuse the new value until restarted — run ${cmd}`);
    } else if (running === false) {
      opts.out(`the ${svc} is not running; it reads the new ${vars.join(", ")} when it next starts`);
    } else {
      opts.out(`${vars.join(", ")} changed — if the ${svc} is running it still holds the previous value: run ${cmd}`);
    }
  }
  const others = rotated.filter((n) => !GENERATED_SECRET_READERS[n] && before.has(n));
  if (others.length) opts.out(`changed in ${target} from the Keychain: ${others.join(", ")} — a service started before this run holds the previous value until it is restarted (\`metistry restart <service>\`)`);
  if (missing.length) opts.out(`appended (no line existed): ${missing.join(", ")}`);
  if (skipped.length) opts.out(`not in this instance's Keychain, left as they are: ${skipped.join(", ")}`);
  if (unmigrated.length) opts.out(`still only in the retired shared scope, so not read: ${unmigrated.join(", ")} — \`${MIGRATE_SCOPE_COMMAND}\` copies them into this instance`);
  return { direction, changed, skipped, unmigrated, minted, adopted, rotated, restart, wrote: target };
}

/** Mint a fresh random token into the Keychain and into `.env` — the only place a new secret is created. */
export async function mintSecret(name: string, opts: SecretsOptions): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${JSON.stringify(name)} is not a variable name`);
  if (!isSecretVar(name)) throw new Error(`${name} is not a secret-shaped name (it must end in ${SECRET_SUFFIXES.join(", ")} or be one of ${[...SECRET_NAMES].join(", ")})`);
  // a third-party credential is issued by the third party; a random string is never it
  if (wasSharedScope(name)) throw new Error(`${name} is a credential another service issues, not a token to mint — store it with \`metistry secrets set ${sharedScopeSecretName(name) ?? "<name>"}\` (the value on stdin)`);
  const platform = opts.platform ?? process.platform;
  requireDarwin(platform, opts.out);
  const { own, accounts } = keychains(opts);
  const value = (opts.mint ?? mintToken)();
  await own.setSecret(name, value);
  const values = new Map([[name, value]]);
  const target = opts.envTarget ?? opts.envFile;
  const { text, missing } = rewriteEnv(await readText(target === opts.envFile ? opts.envFile : target), values);
  await writeEnvFile(target, appendEnv(text, values, missing));
  opts.out(`minted ${name} into the login Keychain under account ${own.account}${accounts.instance ? " (this instance's instance_id)" : ""} and ${target}.`);
  opts.out(`The value is not printed — read it with \`security find-generic-password -a ${own.account} -s ${serviceFor(name)} -w\` if a service needs it pasted elsewhere.`);
  if (!accounts.instance) opts.out(`(no instance_id available, so it went to the user account ${accounts.user}; \`metistry up\` or \`metistry secrets sync\` mints one)`);
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
  /** install variables that HAVE an item under that account */
  found: string[];
  /** what was actually deleted (empty without `--yes`) */
  deleted: string[];
  /** shared-scope variables, whose originals under the per-user account this never touches (`purge-shared` is theirs) */
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
 * per-user account — no instance_id, or an instance account that is
 * somehow the user account — rather than trusting the caller.
 */
export async function purgeSecrets(opts: PurgeOptions): Promise<PurgeResult> {
  const platform = opts.platform ?? process.platform;
  requireDarwin(platform, opts.out);
  const { own, accounts } = keychains(opts);
  if (!accounts.instance) {
    throw new Error(`${opts.instanceDir} has no instance_id in identity.yaml, so it owns no Keychain account — there is nothing to purge (an instance gets one from \`metistry init\`, or from the next \`metistry secrets sync\`/\`metistry up\`)`);
  }
  if (accounts.instance === accounts.user) {
    throw new Error(`refusing to purge: this instance's account (${accounts.instance}) is the per-user account, and purging it would delete secrets that belong to you rather than to ${opts.instanceDir}`);
  }
  const names = await knownSecretNames(opts);
  const kept = names.filter(wasSharedScope);
  const found: string[] = [];
  for (const n of names.filter((x) => !wasSharedScope(x))) if (await own.hasSecret(n)) found.push(n);
  // The owner-named secrets are this instance's too, under the same
  // account: deleting the directory must orphan them no more than the rest.
  // Their names come from the instance's own secrets.yaml — the one list of
  // them there is — and that list includes every migrated shared-scope copy.
  const store = new InstanceSecrets(securityKeychain(opts.exec ?? realExec), accounts.instance);
  const named: string[] = [];
  for (const n of await namedSecretNames(opts.instanceDir, opts.out)) if (await store.has(n)) named.push(n);

  opts.out(`instance: ${opts.instanceDir}`);
  opts.out(`keychain account: ${accounts.instance} (this instance's instance_id)`);
  opts.out(`${found.length} item(s) to delete: ${found.join(", ") || "(none)"}`);
  opts.out(`${named.length} named secret(s) to delete (${SECRET_SERVICE_PREFIX}<name>): ${named.join(", ") || "(none)"}`);
  opts.out(`never touched — the retired shared scope (account ${accounts.user}) keeps its originals of: ${kept.join(", ") || "(none)"}; \`metistry secrets purge-shared\` is theirs`);
  if (!opts.yes) {
    opts.out("");
    opts.out(`preview only. Nothing was deleted — rerun with --yes to delete the ${found.length + named.length} item(s) above. This does not remove ${opts.instanceDir} itself.`);
    return { account: accounts.instance, found, deleted: [], kept, named, namedDeleted: [] };
  }
  const deleted: string[] = [];
  for (const n of found) if (await own.deleteSecret(n)) deleted.push(n);
  const namedDeleted: string[] = [];
  for (const n of named) if (await store.remove(n)) namedDeleted.push(n);
  opts.out(`deleted ${deleted.length + namedDeleted.length} item(s) from account ${accounts.instance}: ${[...deleted, ...namedDeleted.map((n) => `${SECRET_SERVICE_PREFIX}${n}`)].join(", ") || "(none)"}`);
  const failed = [...found.filter((n) => !deleted.includes(n)), ...named.filter((n) => !namedDeleted.includes(n))];
  if (failed.length) opts.out(`could not delete: ${failed.join(", ")}`);
  return { account: accounts.instance, found, deleted, kept, named, namedDeleted };
}

export interface SecretListing {
  name: string;
  /** this instance holds it — for a shared-scope variable, the owner-named secret it became */
  inKeychain: boolean;
  /** the account an item was found under: the instance's, or the user's only while there is no instance_id */
  foundUnder?: "instance" | "user";
  inEnv: boolean;
  /** a shared-scope variable: the owner-named secret it is now (`{{ secret.<name> }}`) */
  secret?: string;
  /** a shared-scope variable whose original still sits under the per-user account (presence only) */
  sharedOriginal?: boolean;
}

/** Names and where each one lives. Every Keychain question here is presence only — there is no code path that can read a value. */
export async function listSecrets(opts: SecretsOptions): Promise<SecretListing[]> {
  const platform = opts.platform ?? process.platform;
  const { own, user, accounts } = keychains(opts);
  const probe = securityPresence(opts.exec ?? realExec);
  const set = liveValues(await readText(opts.envFile));
  const rows: SecretListing[] = [];
  for (const name of await knownSecretNames(opts)) {
    const inEnv = (set.get(name) ?? "") !== "";
    if (wasSharedScope(name)) {
      const secret = sharedScopeSecretName(name);
      const mine = platform === "darwin" && accounts.instance && secret ? await probe(secretService(secret), accounts.instance) : false;
      const original = platform === "darwin" ? await user.hasSecret(name) : false;
      rows.push({ name, inKeychain: mine, ...(mine ? { foundUnder: "instance" as const } : {}), inEnv, ...(secret ? { secret } : {}), sharedOriginal: original });
      continue;
    }
    const found = platform === "darwin" && (await own.hasSecret(name));
    rows.push({ name, inKeychain: found, ...(found ? { foundUnder: accounts.instance ? ("instance" as const) : ("user" as const) } : {}), inEnv });
  }
  return rows;
}

/**
 * The listing: one account, so `keychain` is yes or no. A shared-scope
 * variable shows the owner-named secret it became, and whether its old
 * original is still under the per-user account.
 */
export function renderSecretList(rows: SecretListing[]): string {
  const width = Math.max(4, ...rows.map((r) => r.name.length));
  const head = `${"name".padEnd(width)}  keychain  .env`;
  const body = rows.map((r) => {
    const line = `${r.name.padEnd(width)}  ${(r.inKeychain ? (r.foundUnder === "user" ? "user" : "yes") : "-").padEnd(8)}  ${r.inEnv ? "set" : "-"}`;
    return r.secret ? `${line.padEnd(width + 17)}  → {{ secret.${r.secret} }}${r.sharedOriginal ? " (original still in the shared scope)" : ""}` : line;
  });
  const unmigrated = rows.filter((r) => r.secret && !r.inKeychain && r.sharedOriginal).map((r) => r.name);
  const leftover = rows.filter((r) => r.secret && r.inKeychain && r.sharedOriginal).map((r) => r.name);
  return [
    head,
    "-".repeat(head.length),
    ...body,
    "",
    "keychain: an item under this instance's instance_id (user = the per-user account, only while the install has no instance_id).",
    ...(unmigrated.length ? [`still only in the retired shared scope: ${unmigrated.join(", ")} — \`${MIGRATE_SCOPE_COMMAND}\` copies them into this instance`] : []),
    ...(leftover.length ? [`copied, with the shared original left: ${leftover.join(", ")} — \`metistry secrets purge-shared\` removes an original once every instance on this Mac has its copy`] : []),
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

// ---- migrating the shared scope (plan §2.14's four steps, T4-3) -----------------
//
//   secrets migrate-scope [--dry-run]   steps 1–2, re-runnable; `metistry update` runs it
//   secrets purge-shared [--yes]        step 4's cleanup, preview-then-confirm
//
// 1. Every shared-scope original this instance knows of (its `.env`,
//    `.env.example`, the `auth.secret` names in compute.yaml, `requires.env`
//    in its own manifests) is COPIED from the per-user account into this
//    instance's account under its new name, and the name is recorded in
//    secrets.yaml. An item the instance already holds wins: the original is
//    not even read.
// 2. References to it (`auth.secret`, `requires.env`) are rewritten to
//    `{{ secret.name }}` through the protected write, as YAML documents so
//    comments survive — but only when the file still VALIDATES with the
//    reference in it. A schema that does not read secret references yet
//    keeps the environment name, and the rewrite waits for the release that
//    reads them: rerunning finishes it. Never a file its own reader refuses.
// 3. Nothing resolves a value from the per-user account any more — that is
//    `syncSecrets` above, not a runtime step.
// 4. The originals are LEFT. This migration has no code path that deletes a
//    Keychain item; `purge-shared` is the only one, and it removes only an
//    original every instance this Mac knows has its own copy of.

/** Where a shared-scope variable is referenced, and by which field. */
interface ReferenceSite {
  /** instance-relative */
  file: string;
  kind: "compute" | "manifest";
  path: (string | number)[];
  field: string;
  from: string;
}

/** `auth.secret` in compute.yaml and `requires.env` in the instance's own manifests that name a shared-scope variable. A file that does not parse names none. */
async function sharedReferenceSites(instanceDir: string): Promise<ReferenceSite[]> {
  const sites: ReferenceSite[] = [];
  const load = async (abs: string): Promise<unknown> => {
    const doc = parseDocument(await readText(abs));
    return doc.errors.length ? undefined : (doc.toJS() as unknown);
  };
  const computeRel = protectedRel(instanceDir, "compute");
  const compute = (await load(join(instanceDir, computeRel))) as { providers?: Record<string, { auth?: { secret?: unknown } } | null> } | undefined;
  for (const [p, cfg] of Object.entries(compute?.providers ?? {})) {
    const from = cfg?.auth?.secret;
    if (typeof from === "string" && wasSharedScope(from)) sites.push({ file: computeRel, kind: "compute", path: ["providers", p, "auth", "secret"], field: `providers.${p}.auth.secret`, from });
  }
  const root = resolveInstanceLayout(instanceDir);
  const base = root.path("metistryDir");
  const state = root.path("stateDir");
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
      if (!e.isFile() || e.name !== "manifest.yaml") continue;
      const m = (await load(p)) as { requires?: { env?: unknown } | unknown[] } | undefined;
      const env = m?.requires && !Array.isArray(m.requires) ? m.requires.env : undefined;
      if (!Array.isArray(env)) continue;
      env.forEach((from, i) => {
        if (typeof from === "string" && wasSharedScope(from)) sites.push({ file: relative(instanceDir, p), kind: "manifest", path: ["requires", "env", i], field: `requires.env[${i}]`, from });
      });
    }
  };
  if (base !== instanceDir.replace(/\/+$/, "")) await walk(base);
  return sites;
}

/**
 * The originals compute.yaml USED to name and now references as a secret:
 * `{{ secret.openrouter_api_key }}` was `METISTRY_OPENROUTER_API_KEY` before
 * step 2 rewrote it. Once compute reads references (T4-18) the rewrite lands,
 * and without this the rewritten file would stop naming the original — a
 * rerun would no longer count it as kept, and `purge-shared` would never
 * find it to remove.
 */
async function rewrittenComputeOriginals(instanceDir: string): Promise<string[]> {
  const doc = parseDocument(await readText(join(instanceDir, protectedRel(instanceDir, "compute"))));
  if (doc.errors.length) return [];
  const compute = doc.toJS() as { providers?: Record<string, { auth?: { secret?: unknown } } | null> } | undefined;
  const out: string[] = [];
  for (const cfg of Object.values(compute?.providers ?? {})) {
    const ref = cfg?.auth?.secret;
    const r = typeof ref === "string" ? parseSecretReference(ref) : undefined;
    if (r?.kind !== "secret") continue;
    const original = `METISTRY_${r.name.toUpperCase()}`;
    if (sharedScopeSecretName(original) === r.name && !out.includes(original)) out.push(original);
  }
  return out;
}

/** Every shared-scope variable an instance knows of: its `.env`, `.env.example`, and the files that reference one — or did, before step 2 rewrote them. */
async function sharedScopeCandidates(instanceDir: string, files: { envFile?: string | undefined; exampleFile?: string | undefined }): Promise<string[]> {
  const names: string[] = [];
  const add = (n: string): void => {
    if (wasSharedScope(n) && !names.includes(n)) names.push(n);
  };
  for (const f of [files.envFile, files.exampleFile]) if (f) for (const n of declaredVars(await readText(f))) add(n);
  for (const s of await sharedReferenceSites(instanceDir)) add(s.from);
  for (const n of await rewrittenComputeOriginals(instanceDir)) add(n);
  return names;
}

/** Whether a file still validates with a reference rewritten into it: undefined when it does, else why not. Core's own schema for the file is the judge. */
export type ReferenceGate = (kind: ReferenceSite["kind"], text: string) => string | undefined;

export const acceptsSecretReference: ReferenceGate = (kind, text) => {
  try {
    if (kind === "compute") {
      parseCompute(text);
      return undefined;
    }
    const r = validateManifest(parseDocument(text).toJS());
    return r.ok ? undefined : r.errors.join("; ");
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

export interface MigrateScopeOptions extends NamedSecretsOptions {
  /** this instance's `.env` — where the names of the originals are found (never their values: those come from the Keychain) */
  envFile?: string | undefined;
  /** `.env.example`: the names a fresh install knows */
  exampleFile?: string | undefined;
  /** step 2's gate — test seam; default: core's schema for the file */
  accepts?: ReferenceGate | undefined;
}

export interface ScopeCopy {
  /** the shared-scope variable, e.g. METISTRY_DEVIN_API_KEY */
  from: string;
  /** the owner-named secret, e.g. devin_api_key */
  to: string;
}

export interface ScopeRewrite extends ScopeCopy {
  file: string;
  field: string;
}

export interface MigrateScopeResult {
  instanceId: string;
  /** the retired per-user account the originals are under */
  sharedAccount: string;
  /** step 1: copied into this instance (in a dry run: would be) */
  copied: ScopeCopy[];
  /** step 1: this instance already had one — it wins, the original was not read */
  kept: ScopeCopy[];
  /** step 1: an original the Keychain would not hand over (a declined prompt, a locked keychain) */
  unreadable: Array<ScopeCopy & { why: string }>;
  /** a shared-scope variable whose lowercase name is not a secret name — left for the owner */
  unmappable: string[];
  /** step 1: names added to secrets.yaml */
  recorded: string[];
  /** step 2: references now `{{ secret.name }}` */
  rewritten: ScopeRewrite[];
  /** step 2: references left as the environment name, and why */
  pending: Array<ScopeRewrite & { why: string }>;
  /** step 4: originals still under the per-user account — the migration never deletes one */
  originals: string[];
  /** every original is in this instance: nothing is left for the owner to do. A `pending` reference waits on a release, not on the owner — `metistry update` reruns this and finishes it. */
  complete: boolean;
  deliveries: ProtectedWrite[];
}

function keychainBackend(opts: Pick<NamedSecretsOptions, "keychain" | "platform" | "exec">, what: string): KeychainBackend {
  if (opts.keychain) return opts.keychain;
  if (opts.platform !== "darwin") throw new StepFailed(`${what} works on the macOS login Keychain, which this host (${opts.platform}) does not have — there is no shared scope here to migrate`);
  return securityKeychain(opts.exec ?? realExec);
}

/**
 * `metistry secrets migrate-scope`: §2.14 steps 1–2 for ONE instance,
 * idempotent. **Deletes nothing**: the backend's `delete` is never called
 * from here, and the tests hold it to that.
 */
export async function migrateScope(opts: MigrateScopeOptions): Promise<MigrateScopeResult> {
  const store = instanceStore(opts);
  const backend = keychainBackend(opts, "migrate-scope");
  const sharedAccount = keychainAccount(opts.env);
  if (sharedAccount === store.account) {
    throw new StepFailed(`refusing to migrate: this instance's account (${store.account}) is the per-user account itself (METISTRY_KEYCHAIN_ACCOUNT), so there is nothing to copy from`);
  }
  // Refuse a secrets.yaml this command could not read back BEFORE copying
  // anything: a copy with no line to record it is invisible.
  const edit = await openSecrets(opts);
  const accepts = opts.accepts ?? acceptsSecretReference;
  const out = opts.out;
  const dry = opts.dryRun === true;

  const res: MigrateScopeResult = { instanceId: store.account, sharedAccount, copied: [], kept: [], unreadable: [], unmappable: [], recorded: [], rewritten: [], pending: [], originals: [], complete: false, deliveries: [] };
  out(`shared scope: account ${sharedAccount} → this instance's ${store.account} (${opts.instanceDir})`);

  // ---- step 1: copy, instance wins -----------------------------------------------
  for (const from of await sharedScopeCandidates(opts.instanceDir, opts)) {
    const to = sharedScopeSecretName(from);
    const original = await backend.has(serviceFor(from), sharedAccount);
    if (original) res.originals.push(from);
    if (!to) {
      if (original) {
        res.unmappable.push(from);
        out(`left ${from}: ${from.replace(/^METISTRY_/, "").toLowerCase()} is not a secret name — \`metistry secrets set <name>\` stores it under one you choose`);
      }
      continue;
    }
    if (await store.has(to)) {
      res.kept.push({ from, to });
      out(`kept ${to}: this instance already has one, and it wins${original ? ` — ${from} was not read` : ""}`);
      continue;
    }
    if (!original) continue;
    if (dry) {
      res.copied.push({ from, to });
      out(`[dry-run] would copy ${from} → ${to} (${secretService(to)}, account ${store.account})`);
      continue;
    }
    let why: string | undefined;
    try {
      const value = await backend.get(serviceFor(from), sharedAccount);
      if (value === undefined || value === "") why = "the Keychain did not hand it over — a prompt declined, or the keychain locked; run this from Terminal and allow it";
      else await store.set(to, value);
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
    }
    if (why) {
      res.unreadable.push({ from, to, why });
      out(`could not copy ${from}: ${why}`);
      continue;
    }
    res.copied.push({ from, to });
    out(`copied ${from} → ${to} (${secretService(to)}, account ${store.account}). The value is not printed.`);
  }

  for (const { to } of [...res.copied, ...res.kept]) {
    if (has(edit.file, to) || res.recorded.includes(to)) continue;
    edit.doc.setIn(["secrets", to], edit.doc.createNode({ hosts: [], grants: {} }, { flow: false }));
    flowList(edit, to);
    res.recorded.push(to);
  }
  if (res.recorded.length) {
    out(`recording in secrets.yaml: ${res.recorded.join(", ")} — sent to no host and granted to no one until you say (\`metistry secrets hosts <name> <host>\`, \`metistry secrets grant\`)`);
    res.deliveries.push(await commitSecrets(opts, edit, `secrets: migrate-scope — ${res.recorded.join(", ")}`));
  }

  // ---- step 2: rewrite references, only into a file that still validates -----------
  const held = new Set([...res.copied, ...res.kept].map((c) => c.to));
  const byFile = new Map<string, ReferenceSite[]>();
  for (const s of await sharedReferenceSites(opts.instanceDir)) {
    const to = sharedScopeSecretName(s.from);
    if (!to || !held.has(to)) continue;
    byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  }
  for (const [file, sites] of byFile) {
    const text = await readText(join(opts.instanceDir, file));
    const doc = parseDocument(text);
    for (const s of sites) doc.setIn(s.path, `{{ secret.${sharedScopeSecretName(s.from)} }}`);
    const next = String(doc);
    const broken = accepts(sites[0]!.kind, text);
    const refused = broken ?? accepts(sites[0]!.kind, next);
    if (refused) {
      // the issue about the field being rewritten, not the whole report
      const issues = refused.replace(/^invalid [^:]+: /, "").split("; ");
      const about = issues.filter((i) => sites.some((x) => i.startsWith(x.field.replace(/\[(\d+)\]/g, ".$1")))).join("; ") || issues[0];
      const why = broken ? `${file} does not validate as it stands — fix it first (${about})` : `this release's schema does not read {{ secret.name }} there yet (${about}), so it keeps the environment name until one does — \`metistry update\` then finishes it`;
      for (const s of sites) {
        const to = sharedScopeSecretName(s.from)!;
        res.pending.push({ file, field: s.field, from: s.from, to, why });
        out(`left ${file} ${s.field} as ${s.from}: ${why}`);
      }
      continue;
    }
    const r = new StepRunner({ dryRun: dry, out, exec: opts.exec ?? realExec, env: opts.env });
    res.deliveries.push(await writeProtected(r, file, next, `secrets: migrate-scope — references in ${file}`, { env: opts.env, platform: opts.platform, uid: opts.uid, fetchFn: opts.fetchFn ?? fetch, instanceDir: opts.instanceDir }));
    for (const s of sites) {
      const to = sharedScopeSecretName(s.from)!;
      res.rewritten.push({ file, field: s.field, from: s.from, to });
      out(`rewrote ${file} ${s.field}: ${s.from} → {{ secret.${to} }}`);
    }
  }

  // ---- step 4: the originals stay --------------------------------------------------------
  if (res.originals.length) out(`left in the shared scope — this migration deletes nothing: ${res.originals.join(", ")}. \`metistry secrets purge-shared\` removes an original once every instance on this Mac has its copy.`);
  res.complete = res.unreadable.length === 0 && res.unmappable.length === 0;
  const waiting = res.pending.length ? `; ${res.pending.length} reference(s) keep their environment name until a release reads {{ secret.name }} there` : "";
  // what actually happened, counted — "copied" when nothing was is a claim
  const did = [
    res.copied.length > 0 ? `${dry ? "would copy" : "copied"} ${res.copied.length} secret(s)` : "nothing to copy",
    ...(res.kept.length > 0 ? [`${res.kept.length} already here`] : []),
    ...(res.rewritten.length > 0 ? [`${res.rewritten.length} reference(s) ${dry ? "would be " : ""}rewritten`] : []),
  ].join(", ");
  out(
    res.complete
      ? `shared scope: ${did} for ${opts.instanceDir}${waiting}${dry ? " (dry run — nothing changed)" : ""}.`
      : `shared scope: not finished for ${opts.instanceDir} — deal with the lines above, then rerun \`${MIGRATE_SCOPE_COMMAND} --instance ${opts.instanceDir}\`.`,
  );
  return res;
}

// ---- the doctor row's question: presence only ---------------------------------------

export interface SharedScopeStatus {
  /** originals under the per-user account that this instance has no copy of yet */
  unmigrated: string[];
  /** every original still under the per-user account */
  originals: string[];
}

/**
 * What doctor says about the shared scope, from presence probes only — never
 * a value, never a prompt. Undefined when there is nothing to ask: no
 * instance_id means no account to compare against.
 */
export async function sharedScopeStatus(opts: { instanceDir: string; instanceId: string | undefined; envFile?: string | undefined; exampleFile?: string | undefined; env: NodeJS.ProcessEnv; probe: (service: string, account: string) => Promise<boolean> }): Promise<SharedScopeStatus | undefined> {
  if (!opts.instanceId) return undefined;
  const shared = keychainAccount(opts.env);
  if (shared === opts.instanceId) return undefined;
  const status: SharedScopeStatus = { unmigrated: [], originals: [] };
  for (const from of await sharedScopeCandidates(opts.instanceDir, opts)) {
    if (!(await opts.probe(serviceFor(from), shared))) continue;
    status.originals.push(from);
    const to = sharedScopeSecretName(from);
    if (!to || !(await opts.probe(secretService(to), opts.instanceId))) status.unmigrated.push(from);
  }
  return status;
}

// ---- purge-shared -----------------------------------------------------------------------

/** Instance directories a Metistry LaunchAgent on this Mac runs (their METISTRY_INSTANCE_DIR), plus `current` — "every instance this Mac knows". */
export async function knownInstanceDirs(current: string, home: string): Promise<string[]> {
  const dirs = [current.replace(/\/+$/, "")];
  const agents = launchAgentsDir(home);
  let files: string[] = [];
  try {
    files = (await readdir(agents)).filter((f) => f.startsWith(LABEL_PREFIX.replace(/\.$/, "")) && f.endsWith(".plist")).sort();
  } catch {
    return dirs;
  }
  for (const f of files) {
    const text = await readText(join(agents, f));
    const m = /<key>METISTRY_INSTANCE_DIR<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
    const dir = m?.[1]?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/\/+$/, "");
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

export interface PurgeSharedOptions {
  /** the instance running the verb */
  instanceDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  exec?: Exec | undefined;
  /** test seam: the Keychain */
  keychain?: KeychainBackend | undefined;
  /** the instance directories to count; default: `knownInstanceDirs` */
  instances?: string[] | undefined;
  home?: string | undefined;
  exampleFile?: string | undefined;
  /** without it nothing is deleted: the preview is the whole command */
  yes?: boolean | undefined;
  out: (line: string) => void;
}

export interface PurgeSharedResult {
  sharedAccount: string;
  /** the instances counted; `instanceId: null` = none, which keeps every original */
  instances: Array<{ dir: string; instanceId: string | null }>;
  /** originals every counted instance has its own copy of */
  removable: string[];
  /** originals kept, and the instances still without a copy */
  kept: Array<{ name: string; missingIn: string[] }>;
  /** what was deleted (empty without `--yes`) */
  deleted: string[];
}

/**
 * `metistry secrets purge-shared`: step 4's cleanup. An original under the
 * per-user account is removable only when EVERY instance this Mac knows has
 * its own copy — so no instance can lose the one it still reads. An instance
 * with no instance_id has no copy of anything, so it keeps every original.
 * Presence probes only; preview-then-confirm.
 */
export async function purgeShared(opts: PurgeSharedOptions): Promise<PurgeSharedResult> {
  const backend = keychainBackend(opts, "purge-shared");
  const sharedAccount = keychainAccount(opts.env);
  const dirs = opts.instances ?? (await knownInstanceDirs(opts.instanceDir, opts.home ?? homedir()));
  const instances: PurgeSharedResult["instances"] = [];
  const names: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      opts.out(`skipped ${dir}: a LaunchAgent names it, but the directory is gone`);
      continue;
    }
    const id = (await readInstanceId(dir).catch(() => undefined)) ?? null;
    if (id === sharedAccount) throw new StepFailed(`refusing: ${dir}'s instance_id is the per-user account itself (METISTRY_KEYCHAIN_ACCOUNT) — its items and the shared originals cannot be told apart`);
    instances.push({ dir, instanceId: id });
    const envFile = envPaths({ instanceDir: dir })?.read[0];
    for (const n of await sharedScopeCandidates(dir, { envFile, exampleFile: opts.exampleFile })) if (!names.includes(n)) names.push(n);
  }
  const removable: string[] = [];
  const kept: PurgeSharedResult["kept"] = [];
  for (const name of names) {
    if (!(await backend.has(serviceFor(name), sharedAccount))) continue;
    const to = sharedScopeSecretName(name);
    const missingIn: string[] = [];
    for (const i of instances) if (!to || !i.instanceId || !(await backend.has(secretService(to), i.instanceId))) missingIn.push(i.dir);
    if (missingIn.length === 0 && instances.length > 0) removable.push(name);
    else kept.push({ name, missingIn });
  }

  opts.out(`shared scope: account ${sharedAccount}`);
  opts.out(`instances this Mac knows: ${instances.map((i) => `${i.dir} (${i.instanceId ?? "no instance_id"})`).join(", ") || "(none)"}`);
  opts.out(`${removable.length} original(s) every one of them has copied — removable: ${removable.join(", ") || "(none)"}`);
  for (const k of kept) opts.out(`kept ${k.name}: no copy yet in ${k.missingIn.join(", ")} — \`${MIGRATE_SCOPE_COMMAND} --instance <dir>\` there first`);
  if (!opts.yes) {
    opts.out("");
    opts.out(`preview only. Nothing was deleted — rerun with --yes to delete the ${removable.length} original(s) above.`);
    return { sharedAccount, instances, removable, kept, deleted: [] };
  }
  const deleted: string[] = [];
  for (const n of removable) if (await backend.delete(serviceFor(n), sharedAccount)) deleted.push(n);
  opts.out(`deleted ${deleted.length} original(s) from account ${sharedAccount}: ${deleted.join(", ") || "(none)"}`);
  const failed = removable.filter((n) => !deleted.includes(n));
  if (failed.length) opts.out(`could not delete: ${failed.join(", ")}`);
  return { sharedAccount, instances, removable, kept, deleted };
}
