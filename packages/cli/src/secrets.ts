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
//       secrets mint                 the recorder's three tokens, when it is configured (keeps what exists)
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
//   * `.env` is DERIVED (X-124; owner ruling 2026-10-04): `renderEnvFile`
//     writes the whole file from `.metistry/*.yaml` and the Keychain, under
//     a header carrying the hash of its body (env-render.ts), and `--to env`
//     IS that render. A line the file held that nothing derives yet is
//     carried by name, never silently dropped; a hand edit since the last
//     render is named line by line and adopted into the store before the
//     file is written again.

import { chmod, cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { parseDocument } from "yaml";
import { consoleSecretNames, loadInstanceCatalog } from "@foldedspacelabs/metistry-connections";
import {
  GITHUB_WRITE_SECRET,
  InstanceSecrets,
  SECRET_DELIVERY_PREFIX,
  SECRET_GRANT_MODES,
  SECRET_SERVICE_PREFIX,
  describeSecrets,
  instanceFile,
  instancePresence,
  isOwnerDoorSecret,
  loadCompute,
  mintToken,
  normalizeSecretHost,
  SECRET_GRANTEE_FORMS,
  egressDestination,
  parseCompute,
  parseSecretGrantee,
  providerCredential,
  providerGrantee,
  providerSecretNames,
  parseSecretReference,
  parseSecretsFile,
  resolveInstanceLayout,
  resolveUrl,
  secretDeliveryVar,
  secretEnvName,
  secretNameIssue,
  secretRefsIn,
  secretService,
  validateManifest,
  type Compute,
  type DeploymentShape,
  type KeychainBackend,
  type SecretGrantMode,
  type SecretPresence,
  type SecretRow,
  type SecretsFile,
} from "@foldedspacelabs/metistry-core";
import { readSecretValue } from "./stdin-value.js";
import { resolveSeedDir } from "./env.js";
import {
  composeEnvBody,
  describeLineDiff,
  diffAgainstRecord,
  inspectEnvText,
  lineHash,
  parseRenderRecord,
  preRenderSnapshotPath,
  renderRecordPath,
  restampIfRendered,
  stampEnv,
  PRE_RENDER_FILENAME,
  type EnvFileState,
  type EnvLineDiff,
  type EnvRenderRecord,
} from "./env-render.js";
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
  // The recorder's three (owner ruling 2026-10-04), on the same bar. Each is a
  // value that means nothing outside this install and that nobody pastes
  // anywhere: the bar's control key (the Keychain is where it is read), the
  // bearer the router presents to the live-capture bridge, and the capture
  // owner token the bridge posts transcripts with. Nothing was started with
  // any of them before `metistry up` mints them — the bridge is only ever
  // started WITH them — so minting can never lock a running service out. They
  // are minted only while `METISTRY_LIVE_CAPTURE_URL` is set (GENERATED_WHEN):
  // an install that never asked for a microphone gets none of the three.
  METISTRY_LIVE_CAPTURE_CONTROL_TOKEN:
    "the recorder's control key — the Mac app's capture bar reads it from the Keychain and presents it to the live-capture bridge; restart the live-capture bridge once it is minted",
  METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE:
    "the bearer the router presents to the live-capture bridge; restart the live-capture bridge once it is minted",
  METISTRY_LIVE_CAPTURE_INBOX_TOKEN:
    "the capture owner token the live-capture bridge posts transcripts with — a sync only mints the secret; `metistry up` (or `metistry secrets mint`) also records it in the console's owner tokens, labelled live-capture",
};

/**
 * A generated secret that is minted only while another variable is set — the
 * opt-in that makes it this install's business at all. Adopting one `.env`
 * already holds is never gated; only creating one is.
 */
export const GENERATED_WHEN: Readonly<Record<string, string>> = {
  METISTRY_LIVE_CAPTURE_CONTROL_TOKEN: "METISTRY_LIVE_CAPTURE_URL",
  METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE: "METISTRY_LIVE_CAPTURE_URL",
  METISTRY_LIVE_CAPTURE_INBOX_TOKEN: "METISTRY_LIVE_CAPTURE_URL",
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
  /**
   * `--to env` under an installed launchd shape: the verb re-renders the
   * jobs from `.env` and restarts the supervisor right after this
   * (env-follow.ts), so a changed token's restart is not the operator's to
   * do — and `metistry restart <service>` would not do it anyway, because
   * the child is respawned with supervisor.json's environment, not `.env`'s.
   */
  restartFollows?: boolean | undefined;
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

/** Live assignments with the right-hand side exactly as written (trimmed) — what a carried line keeps. */
function rawAssignments(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = ASSIGNMENT.exec(line);
    if (!m || m[2] || !m[3]) continue;
    out.set(m[3], (m[4] ?? "").trim());
  }
  return out;
}

/**
 * Write `.env` back, owner-read/write only — it is a secret-bearing file even
 * after this command generates it. The directory is created because the
 * target may be `<instance>/state/`, which nothing has needed until now.
 *
 * An in-place writer (`mint`, `adoptOrMintSecret`, `ensureSecret`) that
 * touches a RENDERED file re-stamps it (env-render.ts), so the file stays
 * verifiable and only a hand reaches doctor's `hand-edited`; a file that was
 * never rendered is written as it is, for `up` to derive.
 */
async function writeEnvFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const previous = existsSync(path) ? await readFile(path, "utf8") : "";
  await writeFile(path, restampIfRendered(previous, text), { mode: 0o600 });
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

  // `--to env` IS the render (X-124): the whole file from this instance's
  // Keychain and whatever `.metistry/*.yaml` decides, every line the file
  // held that nothing derives yet carried by name, a hand edit adopted first.
  const r = await renderEnvFile(opts);
  return { direction, changed: [...r.derived, ...r.keychain], skipped: r.skipped, unmigrated: r.unmigrated, minted: r.minted, adopted: [...r.adopted, ...r.adoptedEdits], rotated: r.rotated, restart: r.restart, wrote: r.wrote };
}

// ---- the render: `.env` derived from .metistry/*.yaml and the Keychain (X-124) ----
//
// Owner ruling 2026-10-04 (decisions-log, "M7 reversed — a self-managing
// instance"): `.metistry/state/.env` is written only by `up`, `update` and the
// app's actions, from `.metistry/*.yaml` and the login Keychain, and never
// edited by hand. The file carries the hash it was written with (env-render.ts);
// doctor's `env` row reads it; a hand edit is named line by line here and
// adopted into the store before the file is written again.
//
// Three sections, in a fixed order, each sorted by name — so two renders from
// the same yaml and Keychain are byte-identical:
//
//   derived    what `.metistry/*.yaml` decides (`opts.derived`): rendered over
//              whatever the file said, and a differing previous value is NAMED
//              as superseded — never silently replaced.
//   keychain   every secret-shaped variable this install knows, from this
//              instance's Keychain account; a GENERATED one minted when no
//              store has it; the named secrets a service reads delivered as
//              `METISTRY_SECRET_<NAME>`. Adopt before mint: a secret-shaped
//              line the file holds and the Keychain lacks is copied INTO the
//              Keychain first, so nothing a running service holds changes.
//   carried    every other line the file held, with the right-hand side it
//              had: configuration nothing in `.metistry/*.yaml` decides yet
//              (ports, URLs, knobs — the design note's open question 3 is
//              where these go; until the owner rules, they stay here by
//              name). On a host without a Keychain the secret lines are
//              carried too: the file is the store there.
//
// A hand edit of a rendered file is honoured before it is overwritten (design
// §2.2): an edited secret goes into the Keychain, an edited configuration
// line is carried with its new value, a removed line that a store still holds
// comes back — and every one is named. The file as it was is kept beside the
// render as `.env.pre-render` (0600) whenever the previous file was not a
// clean render, so no hand-written value is lost even when it was superseded.

/** A value `.metistry/*.yaml` decides for `.env`, and which key decided it (named when it supersedes what the file said). */
export interface DerivedEnvValue {
  value: string;
  /** where it came from, for the report and the record — e.g. "deployment.yaml remote:" */
  from: string;
  /** what superseding the file's value costs, said with it when it does (e.g. the passkeys bound to a dropped origin) — recorded for doctor's row too */
  note?: string | undefined;
}

export interface DeliveredSecrets {
  /** the owner-named secrets a service reads, each written as `METISTRY_SECRET_<NAME>` */
  names: string[];
  /** false when a source could not be read this run — a delivery line the file already has is then carried rather than dropped */
  complete: boolean;
  /** what could not be read, one line each */
  notes: string[];
}

/**
 * Every owner-named secret this instance's services read — compute.yaml's
 * providers (T4-18), every connection the console reaches (T4-10, T4-24),
 * and `github_write` when secrets.yaml names it (T2-13). One answer for
 * `secrets sync --to env` and for `up`'s render, so a provider key reaches
 * the engine from either verb. A source that does not read is a note and
 * `complete: false`, never a throw — the rest of the render is unaffected.
 */
export async function deliveredSecretNames(o: { instanceDir: string; productDir: string | undefined }): Promise<DeliveredSecrets> {
  const names = new Set<string>();
  const notes: string[] = [];
  let complete = true;
  try {
    for (const n of providerSecretNames((await loadCompute(instanceFile(o.instanceDir, "compute"))).compute)) names.add(n);
  } catch (e) {
    complete = false;
    notes.push(`compute.yaml does not validate, so no provider key is delivered this run (${e instanceof Error ? e.message : String(e)})`);
  }
  try {
    for (const n of consoleSecretNames(await loadInstanceCatalog({ instanceDir: o.instanceDir, seedDir: resolveSeedDir(o.productDir) }))) names.add(n);
  } catch (e) {
    complete = false;
    notes.push(`the connection types could not be read, so no sync's secret is delivered this run (${e instanceof Error ? e.message : String(e)})`);
  }
  const secretsPath = instanceFile(o.instanceDir, "secrets");
  try {
    if (existsSync(secretsPath) && Object.hasOwn(parseSecretsFile(await readFile(secretsPath, "utf8")).secrets, GITHUB_WRITE_SECRET)) names.add(GITHUB_WRITE_SECRET);
  } catch (e) {
    complete = false;
    notes.push(`secrets.yaml does not validate, so ${GITHUB_WRITE_SECRET} is not delivered this run (${e instanceof Error ? e.message : String(e)})`);
  }
  return { names: [...names].sort(), complete, notes };
}

export interface RenderEnvOptions extends SecretsOptions {
  /** what `.metistry/*.yaml` decides this run — rendered first; a differing value the file held is named as superseded */
  derived?: Readonly<Record<string, DerivedEnvValue>> | undefined;
  /** whether `deliver` is the whole answer; false (or `deliver` absent) carries a `METISTRY_SECRET_*` line the file already has rather than dropping it */
  deliverComplete?: boolean | undefined;
}

export interface RenderEnvResult {
  wrote: string;
  sha256: string;
  /** what the previous file was: absent, pre-render (hand-written), rendered, or hand-edited since */
  before: EnvFileState;
  /** every rendered assignment — for the caller that renders jobs from the same values. Never logged. */
  values: Map<string, string>;
  derived: string[];
  keychain: string[];
  carried: string[];
  /** secret-shaped lines copied into the Keychain because it had none */
  adopted: string[];
  /** hand-edited secret lines whose edit went INTO the Keychain */
  adoptedEdits: string[];
  minted: string[];
  /** secret-shaped names this install knows that no store holds — nothing rendered, nothing lost */
  skipped: string[];
  unmigrated: string[];
  /** names whose previous value `.metistry/*.yaml` now overrides */
  superseded: string[];
  /** `METISTRY_SECRET_*` lines the file had that nothing reads any more */
  dropped: string[];
  handEdited?: EnvLineDiff | undefined;
  preRenderKept?: string | undefined;
  /** names whose rendered value differs from the previous file's — a service started earlier holds the old one */
  rotated: string[];
  restart: TokenService[];
}

export async function renderEnvFile(opts: RenderEnvOptions): Promise<RenderEnvResult> {
  const platform = opts.platform ?? process.platform;
  const darwin = platform === "darwin";
  const target = opts.envTarget ?? opts.envFile;
  const seedExists = existsSync(opts.envFile);
  const seed = seedExists ? await readFile(opts.envFile, "utf8") : "";
  const before = inspectEnvText(seedExists ? seed : undefined);
  const prev = liveValues(seed);
  const raw = rawAssignments(seed);
  const stateDir = dirname(target);
  const recordPath = renderRecordPath(stateDir);
  const record = parseRenderRecord(existsSync(recordPath) ? await readFile(recordPath, "utf8") : undefined);
  const handEdited = before.kind === "hand-edited" && record ? diffAgainstRecord(record, prev) : undefined;
  const edited = new Set([...(handEdited?.changed ?? []), ...(handEdited?.added ?? [])]);
  const derived = opts.derived ?? {};
  const isDelivery = (n: string) => n.startsWith(SECRET_DELIVERY_PREFIX);
  const deliverKnown = opts.deliver !== undefined && opts.deliverComplete !== false;

  const values = new Map<string, string>();
  const derivedNames: string[] = [];
  const keychainNames: string[] = [];
  const carried = new Set<string>();
  const superseded: Record<string, string> = {};
  const adopted: string[] = [];
  const adoptedEdits: string[] = [];
  const minted: string[] = [];
  const skipped: string[] = [];
  const unmigrated: string[] = [];
  const dropped: string[] = [];
  let account: string | undefined;

  // 1. what .metistry/*.yaml decides
  for (const name of Object.keys(derived).sort()) {
    const d = derived[name]!;
    values.set(name, d.value);
    derivedNames.push(name);
    if (prev.has(name) && prev.get(name) !== d.value) superseded[name] = d.note ? `${d.from} — ${d.note}` : d.from;
  }

  // 2. the Keychain (or, without one, the file as the store)
  if (darwin) {
    const { own, user, named, accounts } = keychains(opts);
    account = own.account;
    // adopt: every secret-shaped line the file holds that this instance's
    // Keychain does not — the value a running service was started with. A
    // hand edit of a rendered file wins outright: into the store, named.
    for (const [name, v] of prev) {
      if (!isSecretVar(name) || v === "" || wasSharedScope(name) || isDelivery(name) || name in derived) continue;
      if (edited.has(name)) {
        if ((await own.getSecret(name)) !== v) {
          await own.setSecret(name, v);
          adoptedEdits.push(name);
        }
      } else if (!(await own.hasSecret(name))) {
        await own.setSecret(name, v);
        adopted.push(name);
      }
    }
    const known = new Set<string>([...(await knownSecretNames(opts)), ...(record?.sections.keychain ?? [])]);
    for (const name of [...known].sort()) {
      if (name in derived || isDelivery(name) || values.has(name)) continue;
      let v: string | undefined;
      if (wasSharedScope(name)) {
        // filled from the owner-named secret it became; the original under
        // the per-user account is never read, only asked whether it exists
        const secret = sharedScopeSecretName(name);
        v = named && secret ? await named.value(secret) : undefined;
        if (v === undefined && accounts.instance && (await user.hasSecret(name))) unmigrated.push(name);
      } else {
        v = (await own.getSecret(name)) || undefined; // an empty item is no value
        if (v === undefined && GENERATED_SECRETS[name]) {
          const candidate = prev.get(name) || opts.env?.[name] || undefined;
          if (candidate) {
            // adopt before mint: minting here would lock a running service
            // out of its own install (the 0.12.0 lesson, docs/ops/cli.md)
            await own.setSecret(name, candidate);
            v = candidate;
            if (!adopted.includes(name) && !adoptedEdits.includes(name)) adopted.push(name);
          } else if (!(GENERATED_WHEN[name] && !(prev.get(GENERATED_WHEN[name]!) || opts.env?.[GENERATED_WHEN[name]!]))) {
            v = (opts.mint ?? mintToken)();
            await own.setSecret(name, v);
            minted.push(name);
          }
        }
      }
      if (v === undefined) {
        // nothing rendered for it — and a line the file holds is carried, never lost
        if ((prev.get(name) ?? "") !== "") carried.add(name);
        else skipped.push(name);
      } else {
        values.set(name, v);
        keychainNames.push(name);
      }
    }
    // the named secrets a service reads, under their own variable, from this
    // instance's item and nowhere else (T4-18)
    for (const name of opts.deliver ?? []) {
      const line = secretDeliveryVar(name);
      const v = named ? await named.value(name) : undefined;
      if (v === undefined || v === "") skipped.push(line);
      else {
        values.set(line, v);
        keychainNames.push(line);
      }
    }
    for (const name of prev.keys()) {
      if (!isDelivery(name) || values.has(name)) continue;
      if (deliverKnown && (prev.get(name) ?? "") !== "") dropped.push(name);
      else if ((prev.get(name) ?? "") !== "") carried.add(name);
    }
  } else {
    for (const [name, v] of prev) if (isSecretVar(name) && v !== "" && !(name in derived)) carried.add(name);
    for (const name of opts.deliver ?? []) if (!prev.has(secretDeliveryVar(name))) skipped.push(secretDeliveryVar(name));
  }

  // 3. configuration nothing in .metistry/*.yaml decides yet: carried as written
  for (const [name, v] of prev) {
    if (values.has(name) || name in derived || carried.has(name) || isSecretVar(name) || v === "") continue;
    carried.add(name);
  }

  // 4. compose — three sections, fixed order, sorted names: a function of its inputs
  derivedNames.sort();
  keychainNames.sort();
  adopted.sort();
  adoptedEdits.sort();
  const carriedNames = [...carried].sort();
  const quoted = (n: string) => `${n}=${quoteEnvValue(values.get(n)!)}`;
  const body = composeEnvBody(
    { derived: derivedNames.map(quoted), keychain: keychainNames.map(quoted), carried: carriedNames.map((n) => `${n}=${raw.get(n) ?? ""}`) },
    {
      derived: "derived from .metistry/*.yaml",
      keychain: darwin ? `from the login Keychain (metistry:<VAR>, account ${account})` : "secrets — this host has no Keychain, so these lines are the store",
      carried: "carried from the previous .env: configuration nothing in .metistry/*.yaml decides yet (an edit here is kept, and named)",
    },
  );
  const text = stampEnv(body);
  const sha256 = inspectEnvText(text);
  if (sha256.kind !== "rendered") throw new Error("renderEnvFile: the file it just composed does not verify — a bug, not a hand edit");

  // 5. write: the previous file kept beside the render whenever it was not a
  // clean render. The FIRST copy (`.env.pre-render`) is never overwritten —
  // it is the hand-written file from before the file was derived, and the
  // only copy of a value the render stopped honouring; a later hand-edited
  // file is kept as `.env.pre-render.<n>`. Nothing here deletes any of them.
  let preRenderKept: string | undefined;
  await mkdir(stateDir, { recursive: true });
  if (seedExists && before.kind !== "rendered") {
    preRenderKept = preRenderSnapshotPath(stateDir, existsSync);
    await cp(opts.envFile, preRenderKept, { force: false });
    await chmod(preRenderKept, 0o600);
  }
  // the file itself lands whole or not at all: a crash between a truncate and
  // a write would leave the carried section — which has no other copy — empty
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, text, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, target);
  const final = liveValues(text);
  const rec: EnvRenderRecord = {
    version: 1,
    sha256: sha256.sha256,
    lines: Object.fromEntries([...final].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([n, v]) => [n, lineHash(n, v)])),
    sections: { derived: derivedNames, keychain: keychainNames, carried: carriedNames },
    superseded,
  };
  await writeFile(recordPath, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  await chmod(recordPath, 0o600);

  // 6. what changed under a running service: names only, with the restart it now needs
  const rotated = [...values.keys()].filter((n) => (prev.get(n) ?? "") !== values.get(n));
  const restart: TokenService[] = [];
  const out = opts.out;
  const how = before.kind === "absent" ? "derived" : before.kind === "rendered" ? "derived again" : before.kind === "pre-render" ? "derived from the hand-written file" : "derived again over a hand edit";
  out(`.env: ${how} → ${target} (sha256 ${sha256.sha256.slice(0, 12)}; ${derivedNames.length} from .metistry/*.yaml, ${keychainNames.length} from ${darwin ? "the login Keychain" : "the file — this host has no Keychain"}, ${carriedNames.length} carried)`);
  if (target !== opts.envFile) out(`moved: ${opts.envFile} → ${target} (every line carried over; the old file is left in place — \`metistry secrets retire-legacy-env\` retires it)`);
  if (handEdited) out(`hand edit since the last render: ${describeLineDiff(handEdited)}`);
  else if (before.kind === "hand-edited") out("hand edit since the last render (which lines is not known: no render record) — every line is rendered from the stores again");
  const removedBack = (handEdited?.removed ?? []).filter((n) => values.has(n));
  const removedGone = (handEdited?.removed ?? []).filter((n) => !values.has(n) && !carried.has(n));
  if (removedBack.length) out(`removed by hand but still in the store, so rendered again: ${removedBack.join(", ")}`);
  if (removedGone.length) out(`removed by hand and in no store, so gone: ${removedGone.join(", ")}`);
  if (adopted.length) out(`adopted into the login Keychain from the file (the value the running services hold is kept): ${adopted.join(", ")}`);
  if (adoptedEdits.length) out(`your edit of ${adoptedEdits.join(", ")} went into the login Keychain and is what is rendered — next time, \`metistry secrets mint <VAR>\` (an install token) or \`metistry secrets replace <name>\` (a credential another service issues)`);
  // an edited line the owner-named store overrules (a credential another
  // service issues, filled from its item): not adopted, not kept — but named,
  // with the verb, and the edited line is in the copy kept beside
  const overruled = [...edited].filter((n) => values.has(n) && values.get(n) !== prev.get(n) && !(n in superseded)).sort();
  if (overruled.length) out(`your edit of ${overruled.join(", ")} is not what is rendered — a credential another service issues is replaced with \`metistry secrets replace <name>\`; the edited line is in ${preRenderKept ? basename(preRenderKept) : PRE_RENDER_FILENAME}`);
  for (const n of minted) out(`minted ${n} — it was in no store: ${GENERATED_SECRETS[n]}`);
  for (const n of Object.keys(superseded).sort()) {
    const d = derived[n]!;
    out(`${n}: the file's value is superseded by ${d.from}, which is what is rendered${preRenderKept ? ` (the previous line is in ${basename(preRenderKept)})` : ""}`);
    if (d.note) out(d.note);
  }
  if (dropped.length) out(`no longer delivered — nothing in compute.yaml, the connections or secrets.yaml names ${dropped.join(", ")} any more; the secret itself stays in the Keychain`);
  if (carriedNames.length) out(`carried as written (nothing in .metistry/*.yaml decides these yet): ${carriedNames.join(", ")}`);
  if (skipped.length) out(`in no store, so not rendered: ${skipped.join(", ")}`);
  if (unmigrated.length) out(`still only in the retired shared scope, so not read: ${unmigrated.join(", ")} — \`${MIGRATE_SCOPE_COMMAND}\` copies them into this instance`);
  if (preRenderKept) out(`the previous file is kept at ${preRenderKept} (0600) — delete it once the install is proven`);
  const byService = new Map<TokenService, string[]>();
  for (const n of rotated) {
    const svc = GENERATED_SECRET_READERS[n];
    if (svc) byService.set(svc, [...(byService.get(svc) ?? []), n]);
  }
  for (const [svc, vars] of byService) {
    if (opts.restartFollows) {
      out(`${vars.join(", ")} changed — the ${svc} is restarted onto it below, with the rest of the launchd jobs`);
      continue;
    }
    const running = opts.serviceRunning ? await opts.serviceRunning(svc) : undefined;
    const cmd = `\`metistry restart ${svc}\``;
    if (running === true) {
      restart.push(svc);
      out(`RESTART NEEDED: the ${svc} is running with the previous ${vars.join(", ")} and will refuse the new value until restarted — run ${cmd}`);
    } else if (running === false) {
      out(`the ${svc} is not running; it reads the new ${vars.join(", ")} when it next starts`);
    } else {
      out(`${vars.join(", ")} changed — if the ${svc} is running it still holds the previous value: run ${cmd}`);
    }
  }
  const others = rotated.filter((n) => !GENERATED_SECRET_READERS[n] && prev.has(n) && !(n in superseded));
  if (others.length) out(`changed from the store: ${others.join(", ")} — ${opts.restartFollows ? "the running jobs are re-rendered onto it below" : "a service started before this run holds the previous value until it is restarted (`metistry restart <service>`)"}`);
  return {
    wrote: target,
    sha256: sha256.sha256,
    before,
    values,
    derived: derivedNames,
    keychain: keychainNames,
    carried: carriedNames,
    adopted,
    adoptedEdits,
    minted,
    skipped,
    unmigrated,
    superseded: Object.keys(superseded).sort(),
    dropped,
    ...(handEdited ? { handEdited } : {}),
    ...(preRenderKept ? { preRenderKept } : {}),
    rotated,
    restart,
  };
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

/**
 * This instance's Keychain value for `name`, written into `.env` — or, only
 * when the Keychain holds none, a fresh one minted into both (`mintSecret`).
 * Read-if-present, mint-only-if-absent: `update` runs this for the
 * reconciler's owner bearer, and minting over a value the Keychain already
 * holds would rotate it for nothing (and spend a Keychain write the run may
 * not be able to make). Names only in the output, never the value.
 */
export async function adoptOrMintSecret(name: string, opts: SecretsOptions): Promise<{ how: "adopted" | "minted"; value: string }> {
  const platform = opts.platform ?? process.platform;
  requireDarwin(platform, opts.out);
  const { own } = keychains(opts);
  const held = await own.getSecret(name);
  if (held !== undefined && held !== "") {
    const target = opts.envTarget ?? opts.envFile;
    const values = new Map([[name, held]]);
    const { text, missing } = rewriteEnv(await readText(target), values);
    await writeEnvFile(target, appendEnv(text, values, missing));
    opts.out(`copied ${name} from the login Keychain (account ${own.account}) into ${target} — the Keychain already had one, so nothing was minted`);
    return { how: "adopted", value: held };
  }
  let value = "";
  await mintSecret(name, { ...opts, mint: () => (value = (opts.mint ?? mintToken)()) });
  return { how: "minted", value };
}

export interface EnsuredSecret {
  /**
   * `kept` — the Keychain (macOS) or `.env` already held one and it stands;
   * `adopted` — only `.env` held one, and it is now in the Keychain too;
   * `minted` — neither did.
   */
  how: "kept" | "adopted" | "minted";
  value: string;
  /** `.env` was written by this call */
  wroteEnv: boolean;
}

/**
 * Make sure this install has `name`, creating it ONLY when no store holds one:
 * the idempotent sibling of `mintSecret` (which always replaces). On macOS
 * the Keychain is read first and its value is the one `.env` is made to hold;
 * a value only `.env` has (an owner-pasted one) is adopted into the Keychain
 * and never replaced; elsewhere `.env` is the store. Names only in the
 * output, never the value.
 */
export async function ensureSecret(name: string, opts: SecretsOptions): Promise<EnsuredSecret> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${JSON.stringify(name)} is not a variable name`);
  if (!isSecretVar(name)) throw new Error(`${name} is not a secret-shaped name`);
  const platform = opts.platform ?? process.platform;
  const target = opts.envTarget ?? opts.envFile;
  const fileText = await readText(target);
  const inEnv = liveValues(fileText).get(name) || opts.env?.[name] || undefined;
  const store = async (value: string): Promise<boolean> => {
    if (liveValues(fileText).get(name) === value) return false;
    const values = new Map([[name, value]]);
    const { text, missing } = rewriteEnv(fileText, values);
    await writeEnvFile(target, appendEnv(text, values, missing));
    return true;
  };
  if (platform !== "darwin") {
    if (inEnv) return { how: "kept", value: inEnv, wroteEnv: await store(inEnv) };
    const value = (opts.mint ?? mintToken)();
    return { how: "minted", value, wroteEnv: await store(value) };
  }
  const { own } = keychains(opts);
  const held = await own.getSecret(name);
  if (held !== undefined && held !== "") return { how: "kept", value: held, wroteEnv: await store(held) };
  if (inEnv) {
    await own.setSecret(name, inEnv);
    return { how: "adopted", value: inEnv, wroteEnv: await store(inEnv) };
  }
  const value = (opts.mint ?? mintToken)();
  await own.setSecret(name, value);
  return { how: "minted", value, wroteEnv: await store(value) };
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

// The stdin reader itself — the hidden prompt, the pipe, the refusal — is
// `stdin-value.ts` (X-105), because `metistry remote set` takes a provider's
// pasted token by the same rule; the names stay exported from here.
export { readHiddenLine, type HiddenLineStdin, type HiddenLineStderr } from "./stdin-value.js";

/** Where a secret's value comes from: piped stdin, or one hidden line at a prompt when run in a terminal (stdin-value.ts). `opts.readSecret` is the test seam. */
async function readValue(opts: NamedSecretsOptions, name: string): Promise<string> {
  return readSecretValue(name, { readSecret: opts.readSecret });
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
  if (!grantee || !parseSecretGrantee(grantee)) throw new StepFailed(`${JSON.stringify(grantee ?? "")} is not a grantee — ${SECRET_GRANTEE_FORMS} (e.g. connection:github, agent:devin, provider:openrouter)`);
  if (!mode || !(SECRET_GRANT_MODES as readonly string[]).includes(mode)) throw new StepFailed(`the mode is one of ${SECRET_GRANT_MODES.join(", ")} — not ${JSON.stringify(mode ?? "")}`);
  // X-41: an owner-door secret (`github_write`) has no *Who may use it* line
  // to widen — the door itself is the grant, and it is never a connection's
  // or an agent's. Refused here at the source, so it never reaches
  // secrets.yaml to be caught only by the schema.
  if (isOwnerDoorSecret(name)) {
    throw new StepFailed(`${name} is an owner-door secret — it is read only through its own door (docs/ops/cli.md), and \`metistry secrets grant\` never grants it to ${grantee}; no connection or agent may be granted it`);
  }
  const edit = await openSecrets(opts);
  requireNamed(edit.file, name, edit.path);
  // setIn with a key holding `:` — the yaml library quotes it where it must
  edit.doc.setIn(["secrets", name, "grants", grantee], mode);
  opts.out(`${grantee} may use ${name}: ${mode}${mode === "ask" ? " (each use waits for your answer in Needs You)" : mode === "off" ? " (refused)" : ""}`);
  const delivery = await commitSecrets(opts, edit, `secrets: ${grantee} ${mode} for ${name}`);
  return { name, service: secretService(name), account: opts.instanceId, hosts: edit.file.secrets[name]!.hosts, delivery, grantee, mode: mode as SecretGrantMode };
}

// ---- a provider key's grant (ruling 2 of the W2 checkpoint, X-7) ----------------------

export interface ProviderGrant {
  /** the secret a provider's `auth.secret` references */
  secret: string;
  /** `compute.yaml`'s provider name; the grantee is `provider:<name>` */
  provider: string;
  /** the provider's destination, added to the secret's *Sent only to* when it was not there */
  host?: string | undefined;
}

export interface ProviderGrantsResult {
  /** `provider:<name>: on` written (in a dry run: would be) */
  granted: ProviderGrant[];
  /** referenced by a provider but not in secrets.yaml — `metistry secrets set` first; nothing to grant yet */
  unlisted: ProviderGrant[];
  /** already had a grant for the provider — On, Ask or Off, the owner's word stands */
  kept: ProviderGrant[];
  delivery?: ProtectedWrite | undefined;
}

/**
 * Give each provider key its grantee: for every provider in `compute` whose
 * `auth.secret` is `{{ secret.x }}`, and whose secret `x` names NO grant for
 * `provider:<name>` yet, write `provider:<name>: on` — and add the provider's
 * host to `x`'s *Sent only to* if it is missing, since that is where the
 * key is for. A grant already there (On, Ask or Off) is the owner's word and
 * is left alone, so this is idempotent: a second run finds nothing to do and
 * writes nothing.
 *
 * Why it exists: `computeFetch` refuses a provider key without its grant
 * (X-7). An install whose keys predate the grantee must not lose compute on
 * the update that brings the refusal, so `metistry update` and
 * `secrets migrate-scope` run this, and `compute providers add|set` run it
 * for the provider they just wrote. `only` narrows it to those providers.
 */
export async function grantProviderSecrets(opts: NamedSecretsOptions & { compute?: Compute | undefined; only?: readonly string[] | undefined }): Promise<ProviderGrantsResult> {
  const res: ProviderGrantsResult = { granted: [], unlisted: [], kept: [] };
  let compute = opts.compute;
  if (!compute) {
    const path = instanceFile(opts.instanceDir, "compute");
    if (!existsSync(path)) return res;
    try {
      compute = parseCompute(await readFile(path, "utf8"));
    } catch (e) {
      opts.out(`provider grants: ${path} does not validate, so no provider key was granted (${e instanceof Error ? e.message : String(e)})`);
      return res;
    }
  }
  const bindings: ProviderGrant[] = [];
  for (const [provider, p] of Object.entries(compute.providers)) {
    if (opts.only && !opts.only.includes(provider)) continue;
    const cred = providerCredential(p);
    if (cred?.kind !== "secret") continue;
    bindings.push({ secret: cred.name, provider, host: egressDestination(p.base_url)?.entry });
  }
  if (bindings.length === 0) return res;
  const edit = await openSecrets(opts);
  for (const b of bindings) {
    const grantee = providerGrantee(b.provider);
    if (!has(edit.file, b.secret)) {
      res.unlisted.push(b);
      opts.out(`providers.${b.provider} uses {{ secret.${b.secret} }}, which ${edit.path} does not list — \`metistry secrets set ${b.secret}\` stores it; then \`metistry secrets grant ${b.secret} ${grantee} on\``);
      continue;
    }
    const policy = edit.file.secrets[b.secret]!;
    if (Object.hasOwn(policy.grants, grantee)) {
      res.kept.push(b);
      continue;
    }
    edit.doc.setIn(["secrets", b.secret, "grants", grantee], "on");
    const addHost = b.host !== undefined && !policy.hosts.includes(b.host);
    if (addHost) {
      edit.doc.setIn(["secrets", b.secret, "hosts"], [...policy.hosts, b.host]);
      flowList(edit, b.secret);
    }
    // keep the parsed view in step, so a second binding of the same secret sees this one
    policy.grants[grantee] = "on";
    if (addHost) policy.hosts.push(b.host!);
    res.granted.push({ ...b, ...(addHost ? {} : { host: undefined }) });
    opts.out(`${opts.dryRun ? "[dry-run] would grant" : "granted"} ${b.secret} to ${grantee}: on${addHost ? `, and sent only to ${b.host} as well` : ""} — the provider's key now reaches its provider (\`metistry secrets grant ${b.secret} ${grantee} off\` revokes it)`);
  }
  if (res.granted.length > 0 && !opts.dryRun) {
    res.delivery = await commitSecrets(opts, edit, `secrets: grant provider keys — ${res.granted.map((g) => `${g.secret} → provider:${g.provider}`).join(", ")}`);
  }
  return res;
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
  /** after step 2: provider keys given their `provider:<name>` grant (X-7) — see `grantProviderSecrets` */
  granted: ProviderGrant[];
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

  const res: MigrateScopeResult = { instanceId: store.account, sharedAccount, copied: [], kept: [], unreadable: [], unmappable: [], recorded: [], rewritten: [], pending: [], granted: [], originals: [], complete: false, deliveries: [] };
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

  // ---- after step 2: a provider key's grantee (X-7) ------------------------------------
  // Step 2 may just have pointed a provider at `{{ secret.x }}`, and the door
  // refuses a provider key the owner has not granted to that provider — so
  // the migration that made the reference gives it its grant, exactly as
  // `compute providers add` does. Idempotent: a grant already there is kept.
  const grants = await grantProviderSecrets({ ...opts, dryRun: dry });
  res.granted = grants.granted;
  if (grants.delivery) res.deliveries.push(grants.delivery);

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
