#!/usr/bin/env node
// `metistry` — init | connect-repo | connect | secrets | console | doctor |
// up | down | update (plan
// §4.16; connect-repo and secrets are the install verbs the Mac app drives,
// docs/product/desktop-app-plan.md). Hand-rolled argument parsing: a handful
// of subcommands and flags does not justify a dependency this project would
// maintain for years (CLAUDE.md).

import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GITHUB_WRITE_SECRET, KEEP_AWAKE_VALUES, instanceFile, loadCompute, parseKeepAwake, parsePullArg, parsePushArg, parseSecretsFile, providerSecretNames, type DeploymentShape, type Effort, type KeepAwake } from "@foldedspacelabs/metistry-core";
import {
  assign,
  cacheReport,
  computeReport,
  modelsInstall,
  modelsList,
  modelsLoad,
  modelsSearch,
  parseAssignmentTarget,
  parseBilling,
  parseSwitch,
  parseBudgetAction,
  parseBudgetTarget,
  parseEffort,
  computeTemplates,
  templateChoices,
  providerTest,
  providersAdd,
  providersRemove,
  providersSet,
  renderCacheReport,
  renderComputeReport,
  renderModelsInstall,
  renderModelsList,
  renderModelsSearch,
  renderProviderTest,
  renderRouteReport,
  routeReport,
  setBudget,
  unassign,
  type ComputeOptions,
} from "./compute.js";
import { buildDeploymentReport, renderDeploymentReport, setDeploymentShape, setKeepAwake, type KeepAwakeFlags } from "./deployment-report.js";
import { loadDeployment } from "./deployment.js";
import { loadVaultSettings, renderVaultSettings, rollbackVault, setVaultSettings, VAULT_VERBS } from "./vault.js";
import { EXTENSION_VERBS, extensionsAdd, extensionsList, extensionsRemove, parseExtensionVerb, renderExtensions, type ExtensionsOptions } from "./extensions.js";
import { doctor, renderTable, type DoctorDeps } from "./doctor.js";
import { VARIABLE_VERBS, parseVariableVerb, renderVariables, variablesList, variablesSet, variablesUnset, type VariablesOptions } from "./variables.js";
import {
  CONNECTION_VERBS,
  afterDoubleDash,
  connectionsAdd,
  connectionsAuthorize,
  connectionsList,
  connectionsPolicy,
  connectionsRemove,
  connectionsSet,
  connectionsShow,
  connectionsTest,
  parseConnectionVerb,
  renderCheck,
  renderConnectionDetail,
  renderConnections,
  renderPolicy,
  repeatedFlag,
  type ConnectionsOptions,
} from "./connections.js";
import { loadInstallEnv, productVersion, resolveProductDir, resolveSeedDir, type LoadedEnv } from "./env.js";
import { consoleSecretNames, loadInstanceCatalog } from "@foldedspacelabs/metistry-connections";
import { realExec, type Exec } from "./exec.js";
import { AUTH_MODES, connectRepo, readStdin, type AuthMode } from "./connect-repo.js";
import { connect, connectList, CONNECT_TOOLS, parseTool, renderConnect, renderConnectList } from "./connect.js";
import { consoleCall, renderConsoleCallError, renderWhoami, runConsoleSession, whoami } from "./console-client.js";
import { agentAutonomy, agentsDefine, agentsList, parseAutonomyFlags, renderAgents, renderAutonomy, renderDefine } from "./agents.js";

const AGENTS_USAGE =
  "usage: metistry agents list [--json] | metistry agents autonomy <id> [--level observe|propose|act_within_scope] [--allow <kind>] [--propose <kind>] [--deny <kind>] [--json]" +
  " | metistry agents define <id> [--area <area>] [--model <provider/model>|same_as_assistant] [--effort low|medium|high] [--description <text>] [--prompt-file <file>|-] [--if-sha256 <hex>] [--dry-run] [--json]";
import { importSessions } from "./import-sessions.js";
import { askKeepAwake, init, type Ask } from "./init.js";
import { migrateInbox } from "./migrate-inbox.js";
import { migrateLayout } from "./migrate-layout.js";
import { migrateShape } from "./migrate-shape.js";
import { ensureInstanceId, instanceEnvFile, readInstanceId } from "./instance.js";
import { identitySet, readIdentity, renderIdentity, renderIdentitySet, IDENTITY_SET_FIELDS, type IdentityChange } from "./identity.js";
import {
  INSTANCE_VERBS,
  instancesAdd,
  instancesList,
  instancesRefresh,
  instancesRemove,
  parseInstanceVerb,
  renderInstances,
  type InstancesOptions,
} from "./instances.js";
import { renderRunsExport, runsExport } from "./runs.js";
import type { LockSource } from "./lock.js";
import { installRuntime } from "./runtime-install.js";
import {
  listSecrets,
  mintSecret,
  purgeSecrets,
  renderNamedSecrets,
  renderSecretList,
  migrateScope,
  purgeShared,
  secretsGrant,
  secretsHosts,
  secretsListNamed,
  secretsRemove,
  secretsReplace,
  secretsSet,
  syncSecrets,
  serviceAnswers,
  type TokenService,
  type NamedSecretsOptions,
  type SyncDirection,
} from "./secrets.js";
import { controlServices, downAll, renderDown, renderServiceResults, serviceLogs, UnknownServiceError, type ServiceAction } from "./service-control.js";
import { StepFailed, StepRunner } from "./steps.js";
import { renderTemplatesCheck, templatesCheck } from "./templates.js";
import { configureUi, createUi, defaultUi, type Ui } from "./ui.js";
import { up } from "./up.js";
import { gitHead, update } from "./update.js";
import { parseContinueFrom, type ContinueFrom } from "./update-reexec.js";
import { jobFilesFor, retireLegacyEnv } from "./legacy-env.js";
import { followEnvFile, type FollowEnvResult } from "./env-follow.js";
import { supervisorConfigPath } from "./supervisor.js";
import { collectVersionInfo, renderVersionInfo } from "./version.js";

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | true>;
}

/**
 * Flags that never take a value, so `metistry init --force <dir>` keeps its
 * dir. `version` is deliberately NOT here:
 * `metistry update --version 0.9.0` needs its argument, and a trailing
 * `--version` with nothing after it still parses as `true`, which is what
 * the bare `metistry --version` reads. Listing it as a boolean made
 * `str(flags, "version")` permanently undefined, so the documented
 * `--version <x.y.z>` silently installed the latest release instead
 * (#198, "not fixed here" #2).
 */
export const BOOLEAN_FLAGS = new Set(["force", "json", "help", "dry-run", "allow-dirty", "no-launchd", "no-compose", "no-color", "skip-build", "skip-migrate", "rollback", "allow-legacy", "yes", "follow", "namespace", "rotate", "list", "complete", "skip-test", "remote", "json-lines", "stdio", "named", "clear", "no-discover", "no-browser", "plain", "include-config", "no-app", "relaunch", "no-reexec"]);

/** The §2.14 verbs over owner-named secrets (M7), and the shared scope's migration (T4-3). `list --named` joins them; `sync|mint|list|purge` are the install's own variables. */
export const NAMED_SECRET_VERBS = new Set(["set", "replace", "remove", "hosts", "grant", "migrate-scope", "purge-shared"]);

/** `--channel git|release` — anything else is a typo, not a guess (the lock parser is strict for the same reason). */
export function parseChannel(v: string | undefined): LockSource | undefined {
  if (v === undefined) return undefined;
  if (v !== "git" && v !== "release") throw new Error(`--channel must be git or release, not ${JSON.stringify(v)}`);
  return v;
}

/** `--flag`, `--flag value`, `--flag=value`; everything else positional; `--` ends flag parsing. */
export function parseArgs(argv: string[], booleans = BOOLEAN_FLAGS): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (!booleans.has(a.slice(2)) && next !== undefined && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else {
        flags[a.slice(2)] = true;
      }
      continue;
    }
    positional.push(a);
  }
  const [command, ...rest] = positional;
  return { command, positional: rest, flags };
}

/**
 * `set-keep-awake`'s three switches (T4-20). Each takes `true` or `false` and
 * nothing else: a bare `--sleep-lid-closed` is refused rather than read as
 * true, because the one that keeps a closed Mac awake is `false` and a flag
 * that meant the opposite of what it looks like would be the worst guess.
 */
export function keepAwakeFlags(flags: ParsedArgs["flags"]): KeepAwakeFlags {
  const out: KeepAwakeFlags = {};
  for (const [flag, key] of [
    ["enabled", "enabled"],
    ["sleep-on-battery", "sleep_on_battery"],
    ["sleep-lid-closed", "sleep_lid_closed"],
  ] as const) {
    const v = flags[flag];
    if (v === undefined) continue;
    if (v !== "true" && v !== "false") throw new Error(`--${flag} takes true or false, not ${v === true ? "nothing" : JSON.stringify(v)}`);
    out[key] = v === "true";
  }
  return out;
}

function str(flags: ParsedArgs["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

/** `--daily 5` / `--monthly 60` — a flag that must be a positive number of dollars, never silently 0 or NaN. */
export function usd(flags: ParsedArgs["flags"], name: string): number | undefined {
  const v = flags[name];
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} takes a positive number of US dollars, not ${JSON.stringify(v)}`);
  return n;
}

/** `--ttl 3600` — a positive whole number of seconds, never silently 0 or NaN. */
export function seconds(flags: ParsedArgs["flags"], name: string): number | undefined {
  const v = flags[name];
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} takes a positive whole number of seconds, not ${JSON.stringify(v)}`);
  return n;
}

/** `--areas a,b` / `--project p,q` — one flag, several values, no repetition rules to remember. */
export function csv(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const out = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
  return out.length > 0 ? out : undefined;
}

/** `--auth device|token|ssh` — a typo must not silently pick a weaker path. */
export function parseAuth(v: string | undefined): AuthMode | undefined {
  if (v === undefined) return undefined;
  if (!(AUTH_MODES as string[]).includes(v)) throw new Error(`--auth must be ${AUTH_MODES.join(", ")} — not ${JSON.stringify(v)}`);
  return v as AuthMode;
}

/** `deployment set-shape <compose|launchd>` — undefined (never a guess) on anything else, including a missing argument. */
export function parseDeploymentShape(v: string | undefined): DeploymentShape | undefined {
  return v === "compose" || v === "launchd" ? v : undefined;
}

/**
 * One line from the terminal, for the one question this CLI asks. Node's own
 * readline — no dependency, and nothing else in this package needs a prompt
 * (the Keychain's own `security -w` reads stdin itself).
 */
async function terminalAsk(prompt: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/** `secrets sync` direction: `--to` names it outright, `--from` names the other end. Never guessed. */
export function syncDirection(from: string | undefined, to: string | undefined): SyncDirection {
  const ok = (v: string | undefined, flag: string): SyncDirection | undefined => {
    if (v === undefined) return undefined;
    if (v !== "env" && v !== "keychain") throw new Error(`${flag} must be env or keychain, not ${JSON.stringify(v)}`);
    return v;
  };
  const t = ok(to, "--to");
  const f = ok(from, "--from");
  if (t && f && t === f) throw new Error(`--from ${f} --to ${t} is a no-op`);
  if (t) return t;
  if (f) return f === "env" ? "keychain" : "env";
  throw new Error("say which way: `metistry secrets sync --to keychain` (import .env) or `--to env` (regenerate .env)");
}

const USAGE = `metistry — Metistry command line

  metistry init <dir> [--name <assistant name>] [--channel git|release]
                      [--shape compose|launchd] [--keep-awake <value>]
                      [--force] [--product-dir <checkout>]
      Create a private instance repo at <dir> from the product's seed/ (git init,
      the vault at the root — Inbox/, now.md, CLAUDE.md — and .metistry/ with
      identity.yaml carrying a minted instance_id, rules.yaml, the config dirs
      and metistry.lock; one commit). <dir> IS the Obsidian vault: open it.
      Prints the .env lines to put in <dir>/.metistry/state/.env next — never writes them,
      including METISTRY_ORIGIN (the console refuses to start without it) and a
      METISTRY_RECONCILER_URL shaped for --shape (default: launchd on macOS,
      compose elsewhere — docs/ops/deployment-shapes.md); both are loopback
      addresses that a namespaced instance's own ports replace.
      --channel writes metistry.lock's product.source: git (this install is a
      checkout update fast-forwards; the default) or release (it consumes
      published artifacts — docs/ops/releases.md).
      On a terminal it asks ONE question: whether to keep this Mac awake while
      Metistry runs (never | allow_sleep_on_battery | always |
      always_lid_closed), with what each one costs printed beside it, and
      writes your answer to <dir>/.metistry/deployment.yaml. --keep-awake
      <value> answers it without a terminal; with neither, the question is not
      asked and nothing is written — an install that was never asked holds
      nothing.

  metistry connect-repo <url> [--instance <dir>] [--auth device|token|ssh] [--force]
      Point the instance repo at a private remote and leave credentials the
      reconciler can push with unattended: set origin (refusing to repoint one
      without --force), configure credential.helper=osxkeychain for an https
      remote, get a token (--auth device runs GitHub's device-authorization
      flow against METISTRY_GITHUB_OAUTH_CLIENT_ID; --auth token reads a PAT
      from stdin; --auth ssh trusts your key) into the login Keychain, verify
      with git ls-remote, flush the reconciler's queue, and push once.
      The token is never printed, never written to .env, never in .git/config.

  metistry connect <cursor|opencode|devin|claude-code> [--instance <dir>] [--rotate] [--remote]
                   [--areas Areas/A,Projects/B] [--project <slug>] [--json]
  metistry connect --list [--json]
      Give one external dev tool its own way into this instance: register it as
      an EXTERNAL agent in the console (the agent id IS the tool name, so a
      re-run finds the row the last one made), take the bearer the console
      returns once, and configure the tool's own end.
        cursor       merges mcpServers.<key> into ~/.cursor/mcp.json (0600,
                     every other server preserved) as url + headers, with the
                     bearer named "Bearer \${env:METISTRY_AGENT_TOKEN_CURSOR}"
                     and the value in the login Keychain — never in the file.
        opencode     merges mcp.<key> into ~/.config/opencode/opencode.json
                     (0600, every other server preserved) as a "remote" server,
                     with the bearer named "Bearer {env:…_OPENCODE}" and the
                     value in the login Keychain — never in the file.
        claude-code  mints the token docs/ops/claude-code-plugin.md has you
                     mint by hand and prints the plugin's env lines; it does
                     NOT install the plugin.
        devin        has no config file to write — prints the name, URL and
                     Authorization value to paste at Customize -> MCPs.
      Grants start default-deny ({tier: "none", areas: []}); --areas widens the
      read grant to those TitleCase vault prefixes, --project adds project
      membership. No flag can grant knowledge_write: an external principal
      cannot reach it at the bridge at all. --rotate mints a replacement bearer
      (the old one stops authenticating at once) — without it an
      already-registered tool is told its token is unchanged rather than shown a
      secret. --list reports every tool's row, token and config.
      --remote says this tool will present its bearer from off this machine: the
      row enrols PENDING and its token authenticates nothing — /mcp and /capture
      answer the same 401 an unknown token gets — until you let it in from Needs
      You or with POST /api/agents/<id>/approve. Loopback tools stay immediate,
      and --remote is decided at enrolment, never added to a row afterwards.
      docs/ops/cursor.md, docs/ops/opencode.md, docs/ops/devin.md,
      docs/ops/console-api.md.

  metistry secrets sync [--from keychain|env] [--to env|keychain]
                        [--instance <dir>] [--env-file <path>]
  metistry secrets mint <VAR> [--instance <dir>] [--env-file <path>]
  metistry secrets list [--json] [--instance <dir>] [--env-file <path>]
  metistry secrets purge --instance <dir> [--yes]
  metistry secrets retire-legacy-env [--yes] [--instance <dir>]
      The macOS login Keychain (service metistry:<VAR>) is the canonical store;
      .env is generated from it, at <instance>/state/.env. --to keychain imports
      .env's secret-shaped variables (names ending _TOKEN _PASSWORD _PRIVATE
      _SECRET _KEY); --to env rewrites just those
      lines in place (0600; every comment and non-secret line preserved) and
      moves a product-checkout .env into the instance the first time. mint makes
      a new random token in both. list prints names and where each lives, never
      values (--json: the same rows as an array).
      Every item is filed under ONE account: this instance's instance_id. A
      third-party credential (a METISTRY_*_API_KEY, your AWS keys) is an
      owner-named secret of the instance now: --to env fills its line from
      {{ secret.<name> }} and never reads the retired shared per-user account.
      --to env also delivers every {{ secret.<name> }} compute.yaml's providers
      reference as METISTRY_SECRET_<NAME>, from this instance's item — how a
      key reaches the engine, which never reads the Keychain — and every
      secret a sync-read connection lists (Linear's key), which the console's
      sync fills at the egress door for the secret's listed hosts only, and
      github_write when secrets.yaml names it — the console's pull request
      doors post your reviews with it, to api.github.com only.
      purge deletes one instance's items and nothing else — its owner-named
      secrets included; without --yes it only previews.
      retire-legacy-env ends the "still being read as a fallback" notice: it
      lists the variables only the product checkout's .env still has (names,
      never values), and with --yes appends them to <instance>/state/.env —
      never over a line it already has — and deletes the old file. It keeps
      the file while a job still sources it (run metistry up first) or
      while it is how this CLI finds the instance (use the shim).

  metistry secrets migrate-scope [--dry-run] [--instance <dir>]
  metistry secrets purge-shared [--yes] [--instance <dir>]
      The retired shared scope (plan §2.14). migrate-scope copies each original
      under the per-user account into THIS instance as an owner-named secret
      (METISTRY_DEVIN_API_KEY → devin_api_key) and records it in secrets.yaml;
      an item the instance already has wins. It rewrites auth.secret and
      requires.env to {{ secret.<name> }} only where the file still validates
      with it, and deletes nothing. metistry update runs it; rerun it any
      time. purge-shared removes an original only when every instance this
      Mac knows (this one and each METISTRY_INSTANCE_DIR a LaunchAgent names)
      has its own copy; without --yes it only previews.

  metistry secrets set <name> [--hosts <host>,…] [--expires <date>] [--instance <dir>]
  metistry secrets replace <name> [--expires <date>] [--instance <dir>]
  metistry secrets remove <name> [--yes] [--instance <dir>]
  metistry secrets hosts <name> [<host> …] [--clear] [--instance <dir>]
  metistry secrets grant <name> <connection:<name>|agent:<id>> <on|ask|off>
  metistry secrets list --named [--json] [--instance <dir>]
      Owner-named secrets (plan §2.14), referenced as {{ secret.<name> }} in
      connection files, compute providers and manifests. A name is lowercase
      snake_case. The value is read from STDIN — never an argument — and goes
      into the login Keychain as metistry:secret:<name> under THIS instance's
      instance_id: per instance only, never shared with another instance on
      this Mac. The policy — the hosts it is sent only to, who may use it (On
      · Ask · Off; unlisted = Off), an expiry — goes into
      .metistry/secrets.yaml through the reconciler as you; never a value.
      set refuses a name the file already has (replace swaps the value and
      clears an old expiry); remove previews what references the secret and
      deletes nothing without --yes; hosts with no host shows the list, with
      hosts replaces it, --clear empties it. list --named prints names,
      hosts, grants and whether the Keychain holds an item (--json: the rows
      GET /api/secrets serves). Values are never printed.

  metistry console whoami [--json] [--instance <dir>] [--env-file <path>]
      Ask the console who it thinks you are, using this install's
      METISTRY_LOCAL_OWNER_TOKEN (docs/ops/auth.md): principal, how it was proved,
      and whether that credential reaches the management surface. The local
      owner token authenticates as the "user" principal — the same principal
      a passkey session yields — but only over a connection from THIS
      machine, so this is also the check that the door works before the Mac
      app is blamed for it. The token comes from the environment
      (<instance>/state/.env) or the login Keychain, and is never printed.

  metistry console call <METHOD> <path> [--body @file|-]
                        [--idempotency-key <key>] [--json] [--instance <dir>]
      One authenticated request against the console, as the same principal and
      token as console whoami — the scripting seam behind it (docs/ops/console-api.md
      lists the routes). Prints the response body, pretty unless --json (which
      prints the console's own bytes verbatim), and exits non-zero on a >=400
      answer naming the error envelope's code/message on stderr. --body @file
      or --body - (stdin) supplies a request body; a GET needs neither. Refuses
      a non-loopback METISTRY_CONSOLE_URL/METISTRY_URL outright — the token is
      minted for this machine only.
      --idempotency-key <key> sends Idempotency-Key (docs/ops/console-api.md;
      today only POST /capture reads it) — trimmed, refused here rather than
      on the wire if empty or over 200 characters. A replay (the console's
      idempotency-replayed header) folds "replayed": true into the --json
      body; in plain mode it is a one-line note on stderr instead.

  metistry console session --stdio [--instance <dir>] [--env-file <path>]
      console call, held open: one long-lived process for a client that makes
      many requests (the Mac app). The token is resolved once, at start, and
      never printed; a non-loopback console is refused before a line is read.
      Each stdin line is {id, method, path, body?, idempotency_key?, stream?,
      last_event_id?} and gets exactly one terminal stdout line, matched by id
      and in any order: {id, status, body, replayed?} when the console
      answered, {id, error: {code, message}} when it did not. stream: true
      (GET /api/events only) writes {id, event} frames until {id, cancel: true}
      or the console closes it, then {id, ended}. EOF on stdin ends the session.

  metistry identity [--json] [--instance <dir>]
  metistry identity set [--name <name>] [--mention <@slug>] [--mark <glyph>] [--dry-run] [--json]
      The instance's identity.yaml (name, mention, voice, icon, instance_id) —
      the only place the assistant is named (CLAUDE.md). "set" changes the
      name, the mention and the mark (the file's icon:) through the protected
      write — the reconciler as the owner, recorded as a config_write run that
      Activity shows. A new name brings its mention along when the mention was
      the one derived from the old name. Every field is validated first; an
      invalid one is refused and nothing is written. The console and the
      assistant read the file at start: "metistry restart" shows the change.

  metistry templates check [<file>] [--json] [--instance <dir>]
      Validate the vault's Templates/ — every directive, with the line number
      Obsidian shows. A template change takes effect at the NEXT run
      (docs/product/daily-flow-spec.md §6.5), so this is how you find out
      before the run does: unknown directives, a where: the filter vocabulary
      refuses, an unclosed {{ section }}, and {{ prose }} in a template whose
      output the assistant may not write. Reads nothing but the
      files — no database, no calendar, no vault lookups. <file> checks one
      template instead (a path, or just its name). Exit 1 when a template has
      an error; a template with only notes still renders.

  metistry instances list [--json] [--instance <dir>]
  metistry instances add <origin> [--dry-run]
  metistry instances remove <instance_id|name> [--dry-run]
  metistry instances refresh [--dry-run]
      The peer registry: which OTHER instances this one knows about
      (instances.yaml, docs/ops/instances.md). "add" asks that origin who it is
      — GET /api/identity, the one unauthenticated read a console has — and
      records its instance_id, name and the coarse capabilities it advertises;
      an origin that will not say is not written. Keyed by instance_id, never by
      origin, because an origin can move; "refresh" re-asks every recorded one
      and leaves an unreachable peer's row exactly as it was (a closed laptop is
      not a departed instance). A §4.7 protected path like compute.yaml: every
      write goes through the reconciler as the "user" principal, and an edit
      that would not validate is refused rather than written. The console serves
      the same file to the app and the phone at GET /api/instances.
      What an instance exposes as a "resource" is OPEN-7 and is not designed
      here — the file's "resources:" key stays empty.

  metistry extensions list [--json] [--instance <dir>] [--product-dir <checkout>]
  metistry extensions add <dir> [--dry-run]
  metistry extensions remove <name> [--dry-run]
      Your own units, in .metistry/extensions/<name>/ (docs/ops/extensions.md):
      a provider template, a connection type, a target, or a replacement
      manifest for a product collector or routine. Each loads through the
      SAME registry as the product's, and one with a product unit's name
      replaces it (D4). "list" shows every one — in force, an overlay and what
      it replaces, or skipped/unclaimed with the reason. "add" copies one flat
      directory of data — manifest.yaml and .yaml/.yml/.md/.txt beside it —
      and refuses anything that could run (a script, an executable, a link, a
      nested tree), and any unit its registry would skip, naming why; an
      extension names values from Metistry's closed vocabularies (action
      kinds, capabilities, TCC grants, field kinds) and can never add one.
      "remove" deletes it; for an overlay that is Reset to Default. What
      referred to a removed unit turns absent, naming it; nothing else is
      deleted. A §4.7 protected path: every write goes through the reconciler
      as the "user" principal.

  metistry variables list [--json] [--instance <dir>]
  metistry variables set <name> <value> [--dry-run]
  metistry variables unset <name> [--dry-run]
      Plain shared values in .metistry/variables.yaml, referenced as
      {{ variable.<name> }} in connection files and agents' instructions.
      Agents read them, so "set" refuses a value that looks like a key, token
      or password — store it as a secret instead (metistry secrets set) — or
      that is one of this instance's secret values, and refuses a schedule or
      a time (standup_time, timezone, 09:15, a cron line): a routine's timing
      is its own schedule, and facts about you are Me/profile.md. A refusal
      names the variable, never the value. "unset" names what still
      references it. "list" prints each value and where it is used (--json:
      the rows GET /api/variables serves). A §4.7 protected path: every write
      goes through the reconciler as the "user" principal.

  metistry connections list [--json] [--instance <dir>]
  metistry connections show <name> [--json]
  metistry connections add <name> --type mcp|api|feed|files|mail|agent|tracker
                           (--url <url> [--auth bearer|api_key|basic --secret <name> [--auth-header <Header>]
                                          [--username <user>]] [--header K=V]…
                           | --url <url> --auth oauth [--client-id-secret <name>] [--client-secret-secret <name>]
                                          [--token-secret <name>] [--authorize-url <url> --token-url <url> --scope <s>…]
                           | --imap <host[:port]> --username <user> --secret <name> [--plain]
                           | --path <folder|file> [--include <glob>]… [--skip <glob>]…
                           | [--env K=V]… [--runs-on host|container] -- <command> [args…])
                           [--provider <type> [--config KEY=VALUE]…] [--description <text>] [--no-discover] [--dry-run]
  metistry connections set <name> [--url <url>] [--auth …] [--header K=V]… [--unset-header K]…
                           [--config KEY=VALUE]… [--unset-config KEY]…
                           [--env K=V]… [--unset-env K]… [--runs-on …] [--description <text>]
                           [--client-id-secret <name>] [--client-secret-secret <name>] [--token-secret <name>]
                           [-- <command> [args…]] [--dry-run]
  metistry connections authorize <name> [--no-browser] [--timeout <seconds>]
  metistry connections policy <name> [<tool> allow|ask|never [--group reads|changes|starts_agent]]
                              [--offer on|off] [--dry-run]
  metistry connections remove <name> [--dry-run]
  metistry connections test <name> [--json]
      Servers Metistry reaches for you (.metistry/connections/<name>.yaml,
      docs/ops/connections.md): an MCP server by URL or by command. Secrets
      and variables are written as {{ secret.<name> }} and {{ variable.<name> }}
      — names, never values; a value that looks like a key is refused. "add"
      dials it once and lists what it offers: a tool its connection type
      declares keeps its group, any other is filed under Changes things, and
      the modes start at Reads Allow, Changes things Ask First, Starts an
      agent Ask First, offer to agents off (--no-discover writes it without
      dialling). "policy" prints the tool table, or sets one tool to Allow,
      Ask First or Never — a tool that is not listed is refused before
      anything is dialled. "test" dials it and compares what it offers with
      the file. "remove" deletes it; what referred to it turns absent. A
      command is given only the environment the file names — never this
      process's — and a granted secret there is given to that command only.
      --auth basic writes --username beside the secret that holds an app
      password (a CalDAV calendar: --provider caldav, icloud-calendar or
      fastmail-calendar); the password is filled at the egress door, never
      written. --imap reaches a mailbox (--type mail --provider imap or
      gmail-mail) with --username and the app password --secret names, over
      TLS on 993 unless a port is given (--plain: a server on this Mac only);
      nothing is dialled on add, "test" signs in, and nothing ever sends mail.
      An api, feed or files connection is written with the tools
      Metistry generates for it (api: get, request; feed: list_items,
      get_item, search_items; files: list_files, read_file, search_files, or
      read_page for a URL), every one at Ask First. --auth oauth signs in with
      the connection type's client, or your own (--client-id-secret, the NAME
      of a secret); a custom connection names its client (--authorize-url,
      --token-url, --scope) and always brings its own id. "authorize" signs
      in: it listens on 127.0.0.1 for one callback, opens the browser at the
      provider (--no-browser prints the address), checks the state, exchanges
      the code with its PKCE verifier through the egress door, and keeps the
      refresh token in this instance's Keychain — never printed. "add" also
      points a sync at its first connection in scheduled.yaml when the
      provider is read by one and nothing names a connection for it yet.
      --config KEY=VALUE sets one of the connection type's fields (an agent
      connection's --config org=… or repo=owner/repo, a GitHub tracker's
      repos=owner/a,owner/b); set --unset-config KEY removes one. An agent
      connection (--type agent --provider devin|github-issues) is a target a
      task is dispatched to (POST /api/tasks/:id/dispatch), never dialled —
      pass --no-discover. A
      §4.7 protected path: every write goes through the reconciler as the
      "user" principal. The console reads the same files at GET
      /api/connections and never writes them.

  metistry runs export [--since <cursor|timestamp>] [--until <timestamp>]
                       [--component <name>] [--limit N] [--json-lines]
      The runs audit ledger as NDJSON on stdout, oldest first, one JSON object
      per line, with core's redaction already applied and each row carrying this
      instance's instance_id and — where the row names an agent — the qualified
      agent:<name>@<instance_id> form, so two instances' ledgers merge without
      colliding. Streamed: lines are written as they arrive, and a stream that
      stops mid-line is an error, never a short export.
      Every line carries a "cursor"; the last one is what --since takes to
      resume, and a bare timestamp works too. It goes through the console
      (GET /api/runs/export, the "user" principal) and never straight to
      Postgres — one read path into state (invariant 3). The summary line goes
      to stderr so stdout stays pipeable; --json-lines is the explicit spelling
      of the default and changes nothing.

  metistry agents list [--json]
      Every registered agent and what it holds: role, access, and the rest —
      queries, projects, a crew's toolset, autonomy — then its permissions
      table, Resource × Read × Write, where an empty cell is "—" and anything
      not listed is not granted. The SAME words the console's Agents panel,
      the Mac app and the Needs You card use, because the console renders them
      and this prints what it is sent (one vocabulary, docs/ops/auth.md,
      docs/ops/actors.md). Read-only: a grant is the owner's hand, and the door
      that widens one is the console's alone. An agent waiting on an answer
      shows what it asked for and which request to answer.

  metistry agents define <id> [--area <area>] [--model <provider/model>|same_as_assistant]
                   [--effort low|medium|high] [--description <text>]
                   [--prompt-file <file>|-] [--if-sha256 <hex>] [--dry-run] [--json]
      A crew's definition — .metistry/agents/<area>/<id>.md, a protected path
      in your hand alone (the assistant can never write it). Edits the
      operating prompt, the model and effort, the description; every other
      line of the file is kept as it was. A shipped crew becomes the
      instance's own copy, which then wins by name; a new crew needs --area,
      --model and --prompt-file. The result is checked the way the console
      reads it before anything is written, and --if-sha256 refuses a file that
      changed since you read it (stale). With no edit flags it shows where the
      definition is and its hash. Written through the reconciler as you.

  metistry agents autonomy <id> [--level observe|propose|act_within_scope]
                   [--allow <kind>] [--propose <kind>] [--deny <kind>] [--json]
      Show, or change, how much room one agent has with an action — dispatch,
      task_update, comment, capture (docs/ops/actions.md). With no flags it
      prints the effective table. The level is a CEILING: "allow" only takes
      effect at act_within_scope. A change that RAISES anything is a widening:
      it goes through the console as you, lands in runs as
      agent_admin/autonomy_widened, and puts one alert in Needs You. Kinds may
      repeat or be comma-separated.

  metistry --version
  metistry version [--json] [--product-dir <checkout>] [--instance <dir>]
      Every version number an install can be asked about: this CLI's own
      package version (always known); when a product dir resolves, its own
      package.json version (the checkout, or a release's unpacked current/);
      metistry.lock's pinned version + channel, from the instance; and a
      release install's metistry-runtime.json (version, commit, built_at).
      Each is reported only as far as it resolves — never guessed.

  metistry import-sessions [--since <date>] [--project <path>] [--limit N] [--dry-run]
      Summarise this machine's Claude Code sessions (~/.claude/projects/*/*.jsonl)
      and POST each one to /capture as kind "session". Host only — the console
      container has no home directory — and deterministic: no model is called,
      and what is sent is a summary (turns, files touched, tools, models, first
      prompt, last response), never a transcript. A ledger at
      ~/.metistry/imported-sessions.json keyed by session id + transcript mtime
      makes a re-run a no-op; the note also carries an idempotency_key so the
      server can dedupe across this verb and the Claude Code plugin's hook.
      METISTRY_URL and METISTRY_OWNER_TOKEN come from the environment (.env in
      the checkout) or the login Keychain; neither is ever printed.

  metistry doctor [--json] [--product-dir <checkout>]
      Validate every manifest in the checkout and probe every bridge, service,
      container and launchd job. Exit 0 when nothing is failed.

  metistry runtime install --from <Metistry.app | .../Contents/Resources/metistry>
                           [--to <dir>] [--force] [--dry-run]
      Copy a signed bundle's product SEED to a writable product dir — by default
      ~/Library/Application Support/Metistry/product. A bundle's Resources cannot
      be written to, and "metistry update --channel release" must write
      releases/<version>/, flip current and unpack runtime/; so the bundle seeds
      the product dir once and the CLI owns it from then on, identically to a
      checkout install. Idempotent: the same seed twice is a no-op, verified
      against the pack's own metistry-runtime.json and runtime/manifest.json,
      whose sha256s go into .metistry-install.json beside current.

  metistry up [--no-compose] [--no-launchd] [--dry-run] [--product-dir <checkout>]
              [--instance <dir>] [--env-file <path>] [--namespace]
              [--register-via launchd|app]
      Bring an install to running from a checkout + .env: docker compose up (built
      from source, or pulled when metistry.lock pins a release), every launchd job
      this shape installs rendered into ~/Library/LaunchAgents and (re)bootstrapped
      (macOS; Linux prints systemd units), then doctor — its verdict is the exit code.
      Under the launchd shape that is ONE agent for the core — com.foldedspacelabs.metistry,
      "Metistry" — which runs Postgres, the console, the reconciler, the assistant
      and any configured bridge as its children (docs/ops/deployment-shapes.md);
      the TCC helpers keep an agent each. --register-via app leaves that one
      agent to the Mac app, which registers its bundled copy through
      SMAppService so Login Items shows one item nested under the app; without
      the flag, up asks launchd who already registered it and leaves an
      app-registered agent alone, saying so in one line.
      --namespace allocates this instance its own launchd label suffix (from
      instance_id) and an 8-port block, recorded ONCE in <instance>/state/ports.yaml,
      so a second instance can run beside the first. Every later up/doctor/
      restart/stop/start/logs reads that file; delete it (after "metistry down")
      to go back to the fixed labels and ports.
      up ALWAYS EXITS: launchd (or compose) owns the processes it started, so
      the terminal comes back and "metistry down" is what stops them. Its last
      two lines are where the time went, per section, and who owns the daemon.

  metistry down [--json] [--dry-run] [--product-dir <checkout>] [--instance <dir>]
      The other half of up: stop every host job and every container this
      instance runs, then confirm by looking — launchctl print finding nothing,
      docker compose ps listing nothing. Containers are STOPPED, never removed,
      and no volume is ever touched (that is "docker compose down -v", which
      this verb deliberately is not). Under the launchd shape booting out the
      one agent takes its children — Postgres, the console, the reconciler, the
      assistant, the bridges — with it. When the Mac app registered the
      background item, down stops it for this login session and says so: the
      app puts it back at the next login unless you turn it off in the app,
      which the CLI does not reach into.

  metistry update [--skip-build] [--skip-migrate] [--dry-run] [--product-dir <dir>]
                  [--channel git|release] [--version <x.y.z>] [--rollback]
                  [--allow-legacy] [--app-path <path>] [--no-app] [--relaunch]
                  [--no-reexec]
      Move an install forward: git fetch + pull --ff-only, pnpm install + build,
      db/migrations under a Postgres advisory lock, rebuild containers and
      kickstart the host jobs whose code changed, write metistry.lock into the
      instance repo (through the reconciler), doctor.
      In release mode (metistry.lock says source: release, or --channel release)
      the product step instead downloads the release's runtime pack, verifies its
      sha256, unpacks it to <dir>/releases/<version>/ and points <dir>/current at
      it; the pinned container images are pulled, never built. --version installs
      a specific release instead of the latest; --rollback flips current back to
      the previous one (migrations are additive and are not reverted).
      On a Mac under the launchd shape, release mode also moves the Mac app:
      Metistry-<version>.dmg from the same release, sha256-verified, mounted
      read-only, its version and signature checked, swapped into
      /Applications/Metistry.app (or ~/Applications, or --app-path) with the
      old one kept as Metistry.app.previous for --rollback. Never sudo; a
      running app is told to relaunch, and only quit with --relaunch.
      --no-app leaves the app alone.
      Once current points at the new release, update hands the rest (build,
      migrations, restart, lock, doctor) to that release's own CLI, so one run
      moves everything onto the new code; --no-reexec finishes on the running
      code instead (debugging). --continue-from=switched is that hand-over's
      own flag, never needed by hand.
      An instance still on the legacy layout (the vault in Knowledge/, the config
      files at the instance root) is REFUSED past 0.8.x before anything is
      fetched, with the "metistry migrate-layout" line to run; --allow-legacy
      pins it anyway (docs/ops/instance-layout.md).

  metistry restart [<service>…] [--json] [--dry-run] [--product-dir <checkout>]
  metistry stop    [<service>…] [--json] [--dry-run] [--product-dir <checkout>]
  metistry start   [<service>…] [--json] [--dry-run] [--product-dir <checkout>]
      Act on one, several, or (no args) every service the current shape runs —
      the same shape read from deployment.yaml, and the same host-job/container
      split up and doctor use. "metistry down" is "stop everything" plus a
      read-only confirmation; these three stay the per-service verbs.
      Host jobs: launchctl kickstart -k (restart),
      bootout (stop), bootstrap + kickstart -k (start), against the plist up
      already installed. Containers: docker compose restart|stop|start.
      Every named service is acted on even if an earlier one fails; --json
      prints [{service, action, ok, detail}, …] for the Mac app's menu bar,
      which calls exactly these three verbs and never launchctl/docker itself.
      An unknown service name fails (exit 2) with the list of known ones.

  metistry logs <service> [--lines N] [--follow] [--dry-run] [--product-dir <checkout>]
      Tail one service's log: the launchd job's StandardOutPath (default
      /tmp/metistry-<service>.log) or, under compose, docker compose logs.
      Default is the last 200 lines; --follow streams.

  metistry compute show [--json]
  metistry compute providers list [--json]
  metistry compute providers add --from <template>
                                 [--name <n>] [--base-url <url>] [--secret <name>] [--skip-test]
  metistry compute providers set <name> [--enabled on|off] [--billing token|subscription]
                                 [--base-url <url>] [--secret <name>]
  metistry compute providers remove <name>
  metistry compute providers test <name> [--complete] [--model <id>]
  metistry compute models list [--provider <name>] [--json]
  metistry compute models search [<query>] [--provider <name>] [--json]
  metistry compute models install <provider/model> [--json]
  metistry compute models load|unload <provider/model> [--ttl <seconds>] [--json]
  metistry compute assign <default|<tier>|crew:<name>> <provider/model> [--effort low|medium|high]
  metistry compute unassign <tier|crew:<name>>
  metistry compute budget <instance|provider:<name>> [--daily <usd>] [--monthly <usd>]
                          --action allow|stop|critical_only
  metistry compute cache-report [--since 7d] [--json]
  metistry compute route-report [--since 30d] [--json]
      This instance's compute.yaml: which providers exist, which model each
      tier and crew runs on, and what each may spend (docs/ops/compute.md).
      A §4.7 protected path like deployment.yaml — every write goes through
      the reconciler as the "user" principal, and an edit that would not
      validate is refused rather than written. "providers add --from" copies
      a provider template — a unit of the provider registry: the product's
      seed/compute-templates/ and your own in .metistry/extensions/ (metistry
      extensions list); "providers add" with no --from names them — and reads
      the API key from stdin into one of THIS instance's secrets (the login
      Keychain under its instance_id; recorded in secrets.yaml), never taking
      it as an argument, and writes auth.secret: "{{ secret.<name> }}".
      "providers set" is the provider's gear: its switch (off = not searched,
      not offered, nothing assignable), billing, base URL, and which secret
      its key is. "models search" groups every switched-on provider's
      catalogue by model through seed/model-identities.yaml (an id it cannot
      map stays its own row). "unassign" removes a tier or a crew; default
      is reassigned, never removed. Budgets are enforced in the engine, before the call
      (docs/ops/compute.md). "cache-report" and "route-report" are the two
      that read rather than write. cache-report: prompt-cache effectiveness
      per provider, model and tier over the last --since days (7d, 2w, 3m,
      or a bare number of days), from the runs ledger through the console —
      turns, cache reads and writes, hit ratio, what it cost and what the
      cache saved where compute.yaml names a rate (OPEN-6's measurement).
      route-report: how the deterministic router placed real messages over
      the same kind of window (default 30d) — note, fast_path, override and
      the fall-through to the default tier, the tiers and rules that fired,
      and the length and first word of the fall-throughs, with PoC-20 phase
      0's exit rule as the verdict — and, under it, the route record: what
      a local policy would have chosen, in shadow, beside what the rules
      served (docs/ops/dynamic-router.md). Neither calls a model or changes
      anything (docs/ops/compute.md).

  metistry deployment [--json] [--product-dir <checkout>]
      The effective shape (deployment.yaml's D4 overlay) and the services it
      implies, each with launchctl/docker's cheap running state where that is
      knowable without a network probe (never the full doctor).

  metistry deployment set-shape <compose|launchd> [--yes] [--force]
                                [--product-dir <checkout>] [--instance <dir>]
      Write the instance's deployment.yaml. A §4.7 protected path (invariant
      2), so this goes through the reconciler as the user principal, exactly
      like metistry.lock/identity.yaml — preview without --yes, applied with
      it. Refuses while services still run under the current shape (the data
      does not move between shapes on its own); --force writes anyway.

  metistry deployment set-keep-awake [<never|allow_sleep_on_battery|always|always_lid_closed>]
                                [--enabled true|false] [--sleep-on-battery true|false]
                                [--sleep-lid-closed true|false]
                                [--yes] [--product-dir <checkout>] [--instance <dir>]
      Whether this install holds the Mac awake, and on which power (macOS).
      The same protected write as set-shape — preview without --yes, applied
      with it — and it prints what the choice costs before writing it. It does
      NOT refuse while services run: changing the policy changes nothing
      already running, and it takes effect at the next metistry up.
      A value alone is written as itself. A flag changes only the switch it
      names — over the value when one is given, else over the setting in
      effect — and writes the object form { enabled, sleep_on_battery,
      sleep_lid_closed }. Keeping a closed Mac awake (always_lid_closed, or
      --sleep-lid-closed false) is stored as asked, but only an administrator
      setting delivers it: this prints the command, how to undo it and why it
      is not recommended, and never runs it. doctor reads pmset -g and says
      whether it is in effect (docs/ops/deployment-shapes.md).

  metistry vault settings [--push <after_commit|manual|<n>m|<n>h>] [--pull <n>m|<n>h]
                          [--yes] [--json] [--product-dir <checkout>] [--instance <dir>]
      The vault's git sync policy (M18): when the reconciler pushes the
      instance repo to its remote — after_commit (once a flush has made
      commits), manual (never on its own), or on an interval — and how often
      it pulls (there is no "never"). With no flag it shows the policy in
      force and where each answer came from; with --push/--pull it previews
      the new vault: block of deployment.yaml, and --yes writes it — the same
      protected write as set-shape. The reconciler re-reads the file: no
      restart. METISTRY_PUSH_SCHEDULE still overrides push for this release,
      and this verb says so (docs/ops/reconciler.md).

  metistry vault rollback <commit> | --to <date> | --file <path> [--to <date>]
                          [--include-config] [--json] [--instance <dir>]
  metistry vault rollback --request <id>
      Roll the vault back — undo one commit, put everything back as it was
      at a date (a day means as that day left it), or one file as it was
      before its last change (or at --to). Never on the spot: it raises a
      Needs You request with the preview (the commits it undoes, the files
      it puts back) and Approve makes ONE new commit, as you; history keeps
      everything, and undo is rolling back that commit. Configuration
      (.metistry/, CLAUDE.md, README.md) is left as it is and named, unless
      --include-config: then Approve is carried out by this terminal, which
      waits for it (up to 30 minutes; --request <id> resumes the wait) and
      reverts with the owner-class bearer (docs/ops/cli.md).

  metistry migrate-inbox [--instance <dir>] [--dry-run]
      Move an existing instance's inbox into the vault: inbox/* (or a
      differently-cased vault inbox, renamed through a temp name because
      macOS is case-insensitive) into the vault inbox — Inbox/ under the flat
      layout, Knowledge/Inbox/ while an instance is still legacy — git mv for
      what git tracks and a plain move for what it does not; drop inbox/
      from .gitignore and add the .large/ spill line; rewrite inbox.path
      rows to <vault inbox>/<file>; commit it. Idempotent — a second run
      says "already on the vault inbox" and changes nothing. Restarts
      nothing: it prints the metistry up line and stops. docs/ops/inbox.md.

  metistry migrate-layout [--instance <dir>] [--dry-run] [--json] [--allow-dirty]
      Carry an instance from the legacy layout (vault in Knowledge/, config at
      the root) to the flat one: the instance directory IS the Obsidian vault,
      everything that is not knowledge under .metistry/ (2026-09-17 ruling,
      docs/ops/instance-layout.md). Refuses unless the layout is legacy, and
      says so and changes nothing when it is already flat.
        preflight   a git repo, a clean tree (--allow-dirty overrides), a
                    warning naming the supervisor/reconciler job if one is
                    running (stop it first — it is the repo's sole committer),
                    and a list of any lowercase root entry that becomes vault
                    content after the move (vault content is TitleCase)
        .metistry/  identity.yaml, rules.yaml, compute.yaml, deployment.yaml,
                    instances.yaml, sources.yaml, assistant-prompt.md,
                    metistry.lock, agents/ routines/ queries/ extensions/
                    instance-migrations/ targets/ eval/, and the gitignored
                    state/
        Inbox/      the pre-#156 root inbox/, renamed through a temp name
                    (macOS is case-insensitive) and merged if both exist
        vault       every entry of Knowledge/ to the root — Knowledge/CLAUDE.md
                    becomes the root CLAUDE.md, .obsidian/ comes up with it —
                    then the empty Knowledge/ is removed. A name collision with
                    an existing root entry is refused BEFORE anything moves.
        manifests   crew scope: and target data_policy.allow: lose the
                    Knowledge/ prefix, spliced byte-for-byte so comments and
                    formatting survive. Without this the console's next crew
                    sync writes the legacy scope back over the migrated grant.
        .gitignore  core's set for the flat layout; lines you added are kept
        database    one transaction: Knowledge/ drops out of knowledge_files,
                    knowledge_links, embeddings, inbox and projects.area, and
                    agents.grants' whole-vault sentinel becomes "/". With no
                    database configured the rewrites are named and skipped.
        .env        METISTRY_* values that spelled the old paths. launchd
                    plists under state/ are regenerated by 'metistry up'.
        commit      one commit, "Migrate to the flat instance layout".
      Idempotent; --dry-run prints every move and every row count and touches
      nothing. Restarts nothing: it prints the 'metistry up' line and stops.

  metistry migrate-shape <launchd|compose> [--dry-run] [--namespace]
                         [--product-dir <checkout>] [--instance <dir>] [--env-file <path>]
      Move a LIVE install between the two deployment shapes, with its data.
      One verb, reversible, and every step printed before it runs.
        launchd  refuse unless this product carries a bundled runtime/ and a
                 release with ops/sandbox/ (PR #117 — without it the assistant
                 job cannot start); pg_dump the compose database through the
                 running db container to <instance>/state/migrate/<ts>.dump and
                 verify it with pg_restore --list; docker compose stop db console
                 assistant (containers and the named volume are LEFT IN PLACE);
                 write deployment.yaml through the reconciler as the user
                 principal; metistry up (initdb under <instance>/state/pg, every
                 host plist re-rendered against current/, the bundled node and
                 <instance>/state/.env); pg_restore BEFORE any migration runs —
                 the dump carries schema_migrations, so the next metistry update
                 applies none; compare every table's row count with the compose
                 database and fail if one differs; then doctor.
        compose  the documented rollback: bootout the launchd db/console/
                 assistant jobs, set the shape back, docker compose up -d. The
                 compose volume still holds the database as it was at the
                 cutover — anything written under launchd since is NOT copied
                 back, so dump it first if you want it.
      docs/ops/migrate-compose-to-launchd.md is the production runbook.

  --dry-run prints every command and runs nothing.

Product checkout resolution: --product-dir, METISTRY_PRODUCT_DIR, the checkout
this package is installed in, the current directory's enclosing checkout.

Environment resolution: <instance>/state/.env first (--instance, else
METISTRY_INSTANCE_DIR), then the product checkout's .env — deprecated, still
read, and where a terminal install may keep declaring METISTRY_INSTANCE_DIR.
An instance directory is self-contained (docs/ops/cli.md); --env-file overrides
both. Nothing already set in the environment is overwritten by either file.
`;

/**
 * The overview `metistry --help` opens with: every verb, grouped by what
 * you are in the middle of doing, one aligned line each. The reference
 * below it (USAGE) is unabridged and stays that way — this is the map, not
 * a replacement for the territory. A new verb belongs in both.
 */
export const HELP_GROUPS: Array<{ title: string; verbs: Array<[string, string]> }> = [
  {
    title: "install",
    verbs: [
      ["init <dir>", "create a private instance repo from the product's seed/"],
      ["connect-repo <url>", "point it at a private remote, with credentials to push with"],
      ["secrets sync|mint|list|purge", "the login Keychain is the store; .env is generated from it"],
      ["secrets retire-legacy-env", "move what only the product checkout's .env still has into the instance, then delete it"],
      ["secrets set|replace|remove|hosts|grant", "owner-named secrets, per instance: the value in the Keychain, the policy in secrets.yaml"],
      ["secrets migrate-scope|purge-shared", "copy the retired shared scope into this instance; remove originals every instance has copied"],
      ["runtime install --from <bundle>", "seed a writable product dir from a signed app bundle"],
      ["up", "containers and host jobs, then doctor"],
      ["down", "stop everything this instance runs, then confirm by looking"],
    ],
  },
  {
    title: "every day",
    verbs: [
      ["doctor", "validate every manifest; probe every bridge, service and job"],
      ["restart|stop|start [<service>…]", "one service, several, or everything this shape runs"],
      ["logs <service>", "tail one service's log"],
      ["update", "pull, build, migrate under a lock, restart what changed, pin"],
      ["version", "cli, product, the lock's pin, a release's runtime pack"],
    ],
  },
  {
    title: "configure",
    verbs: [
      ["compute show|providers|models", "which providers exist and which model each tier runs on"],
      ["compute assign|budget", "point a tier at a model; cap what it may spend"],
      ["compute cache-report", "is prompt caching paying off — hit ratio per provider and model"],
      ["compute route-report", "where real messages went — the router's fall-through rate, PoC-20 phase 0"],
      ["deployment [set-shape]", "the effective shape (D4 overlay) and its services"],
      ["deployment set-keep-awake", "whether this install holds the Mac awake, and on which power"],
      ["vault settings", "when the reconciler pushes the vault to its remote, and pulls from it"],
      ["vault rollback", "undo a commit, a day or a file — a Needs You request, then one new commit"],
      ["agents list", "every registered agent and what it holds"],
      ["agents autonomy <id>", "how much room one agent has with an action"],
      ["agents define <id>", "a crew's definition: its prompt, model and effort"],
      ["identity [set]", "identity.yaml — the one place the assistant is named; set its name, mention and mark"],
      ["templates check [<file>]", "does the vault's Templates/ read, before the next run reads it"],
      ["instances list|add|remove|refresh", "the peer registry: which other instances this one knows"],
      ["extensions list|add|remove", "your own units — templates, connection types, targets, overlays"],
      ["variables list|set|unset", "plain shared values agents read — never a secret, never a schedule"],
      ["connections list|show|add|set|policy|remove|test|authorize", "what Metistry reaches for you, which of its tools may run, and signing in"],
    ],
  },
  {
    title: "reach in",
    verbs: [
      ["connect <tool> | --list", "give Cursor, OpenCode, Devin or Claude Code its own way in"],
      ["console whoami | call | session", "authenticated requests against the console, as you"],
      ["runs export", "the audit ledger as NDJSON, oldest first, resumable"],
      ["import-sessions", "summarise this machine's Claude Code sessions into /capture"],
    ],
  },
  {
    title: "move an install",
    verbs: [
      ["migrate-layout", "legacy layout → the instance directory IS the vault"],
      ["migrate-inbox", "a pre-#156 inbox/ → the vault's Inbox/"],
      ["migrate-shape <launchd|compose>", "move a LIVE install between shapes, with its data"],
    ],
  },
];

/** The grouped overview, then the full reference. `--json` never reaches here; `--no-color` and a pipe flatten it to plain text. */
export function renderHelp(ui: Ui = defaultUi()): string {
  const out = [`${ui.strong("metistry")} ${ui.dim("— Metistry command line")}`, ""];
  out.push(...ui.wrap("A local-first personal assistant and knowledge graph. The assistant is named in identity.yaml — nowhere else.").split("\n"), "");
  for (const g of HELP_GROUPS) {
    out.push(ui.heading(g.title));
    // the verb is what the eye is hunting for: it stays plain (the
    // terminal's own foreground) while its description is dimmed
    out.push(ui.kv(g.verbs.map(([v, d]) => [v, ui.dim(d)]), { keyRole: "plain" }));
    out.push("");
  }
  out.push(...ui.wrap("--json prints the machine-readable answer where a verb has one; --dry-run runs nothing; --no-color is plain text.").split("\n").map((l) => ui.dim(l)), "");
  out.push(ui.heading("reference — every verb, every flag"));
  // USAGE's own first line is the title this already printed
  return [...out, USAGE.split("\n").slice(1).join("\n")].join("\n");
}

export interface MainIo {
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** test seam: fakes for doctor's fetch/db/exec */
  doctorDeps?: Partial<DoctorDeps>;
  /** test seam: every subprocess up/update/init run */
  exec?: Exec;
  /** test seams for restart/stop/start/logs: the host platform decides whether launchd jobs exist at all (CI runs the suite on Linux) */
  platform?: NodeJS.Platform;
  uid?: number;
  home?: string;
  /** test seam: the console request of `console whoami|call|session`, `connect`, `agents` and `runs export` */
  fetchFn?: typeof fetch;
  /** test seam: the base fetch a connection's dials and an OAuth sign-in go through, under the egress guard (a fixture server on loopback) */
  dialFetch?: typeof fetch;
  /** test seam: `console call --body -` reads this instead of the real stdin */
  readStdin?: () => Promise<string>;
  /** test seam: `console session --stdio` reads its request lines from this instead of the real stdin */
  sessionInput?: AsyncIterable<string>;
  /**
   * test seam: the one interactive question this CLI asks (`init`'s
   * keep-awake choice). Absent and no tty = the question is not asked and
   * nothing is written, which is what keeps `init` safe to drive from the Mac
   * app's first run and from a script.
   */
  ask?: Ask;
}

/**
 * The CLI's entry point.
 *
 * Everything it does is `dispatch()`; this wrapper owns the two things that
 * bracket a command rather than belong to one — the process's Ui (so
 * `--json` and `--no-color` are decided once, before anything renders) and
 * the deprecation notices, which are dimmed and printed ONCE, on stderr,
 * AFTER the output they qualify (docs/ops/cli-style.md rule 7). They used to
 * be the first thing on the screen, which made a fallback `.env` shout
 * louder than the answer you asked for.
 */
export async function main(argv: string[], io: MainIo = {}): Promise<number> {
  const err = io.err ?? ((s: string) => process.stderr.write(s + "\n"));
  const { flags } = parseArgs(argv);
  const json = flags.json === true;
  configureUi({ json, noColor: flags["no-color"] === true });
  const notices: string[] = [];
  try {
    return await dispatch(argv, io, notices);
  } finally {
    const noteUi = createUi({ stream: process.stderr, json, noColor: flags["no-color"] === true });
    for (const n of notices) for (const l of noteUi.wrap(n).split("\n")) err(noteUi.note(l));
  }
}

async function dispatch(argv: string[], io: MainIo, notices: string[]): Promise<number> {
  const out = io.out ?? ((s: string) => process.stdout.write(s + "\n"));
  const err = io.err ?? ((s: string) => process.stderr.write(s + "\n"));
  const { command, positional, flags } = parseArgs(argv);
  const ui = defaultUi();
  const productDir = resolveProductDir(str(flags, "product-dir"));
  /**
   * This install's environment, from the instance's own `state/.env` and
   * then the product checkout's deprecated one. A deprecation notice is
   * collected, not printed: `main()` flushes them to STDERR at the end, so
   * `doctor --json` stays machine-readable and nothing shouts over the
   * output.
   */
  const loadEnv = (): LoadedEnv => {
    const loaded = loadInstallEnv({ productDir, instanceDir: str(flags, "instance"), envFile: str(flags, "env-file") });
    for (const n of loaded.notices) if (!notices.includes(n)) notices.push(n);
    return loaded;
  };
  // `metistry --version` (no subcommand): the bare flag every CLI answers,
  // ahead of the "no command" usage/exit-2 case below. `metistry version` is
  // the same thing as a real subcommand, further down.
  if (command === undefined && flags.version === true) {
    const info = await collectVersionInfo({ productDir, instanceDir: loadEnv().instanceDir });
    out(flags.json === true ? JSON.stringify(info, null, 2) : renderVersionInfo(info, ui));
    return 0;
  }
  if (command === undefined || command === "help" || flags.help) {
    out(renderHelp(ui));
    return command === undefined && !flags.help ? 2 : 0;
  }
  let channel: LockSource | undefined;
  try {
    channel = parseChannel(str(flags, "channel"));
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 2;
  }

  switch (command) {
    case "init": {
      const dir = positional[0];
      if (!dir) {
        err("usage: metistry init <dir> [--name <assistant name>] [--shape compose|launchd] [--force]");
        return 2;
      }
      // --shape decides which .env lines are printed below (compose or
      // launchd — a typo must not silently fall back to the platform
      // guess); undefined lets `init` guess from the platform, as launchd
      // on darwin (docs/ops/deployment-shapes.md).
      const shapeFlag = str(flags, "shape");
      const shape = parseDeploymentShape(shapeFlag);
      if (shapeFlag !== undefined && !shape) {
        err(`--shape must be compose or launchd, not ${JSON.stringify(shapeFlag)}`);
        return 2;
      }
      // The keep-awake question. `--keep-awake <value>` answers it without a
      // terminal; otherwise it is ASKED, and only where there is somebody to
      // ask — a pipe, a script or the Mac app's first run gets no question
      // and no answer, and an install with no answer holds nothing. That is
      // the invariant here: this setting changes how the machine behaves, so
      // it is never taken by default (owner's ruling, 2026-09-19).
      const keepAwakeFlag = str(flags, "keep-awake");
      let keepAwake = parseKeepAwake(keepAwakeFlag);
      if (keepAwakeFlag !== undefined && keepAwake === undefined) {
        err(`--keep-awake must be one of ${KEEP_AWAKE_VALUES.join(", ")} — not ${JSON.stringify(keepAwakeFlag)}`);
        return 2;
      }
      const ask = io.ask ?? (process.stdin.isTTY ? terminalAsk : undefined);
      if (keepAwake === undefined && ask) {
        try {
          keepAwake = await askKeepAwake(ask, out, { ui });
        } catch (e) {
          err(e instanceof Error ? e.message : String(e));
          return 2;
        }
      }
      const result = await init({
        dir,
        name: str(flags, "name"),
        ...(keepAwake !== undefined ? { keepAwake } : {}),
        force: flags.force === true,
        seedDir: resolveSeedDir(productDir),
        version: productVersion(),
        productSource: channel ?? "git",
        productCommit: productDir ? await gitHead(productDir, io.exec ?? realExec) : undefined,
        exec: io.exec,
        shape,
        platform: io.platform,
      });
      out(`instance created at ${result.dir} (commit ${result.commit.slice(0, 7)}; assistant named "${result.assistantName}" in identity.yaml; instance_id ${result.instanceId})`);
      out(
        result.keepAwake === undefined
          ? "keep-awake: not configured — this Mac may idle-sleep and the install pauses with it (`metistry deployment set-keep-awake <value> --yes`, or `metistry init --keep-awake <value>`)"
          : `keep-awake: ${result.keepAwake} — written to this instance's .metistry/deployment.yaml; it takes effect at \`metistry up\``,
      );
      out("");
      out(`Next — put these in this instance's environment, ${instanceEnvFile(result.dir)} (the token below is minted once and shown only here):`);
      out("");
      for (const l of result.envLines) out(`  ${l}`);
      out("");
      out("That file is the install's environment: gitignored, 0600, and never in the product checkout (an instance directory is self-contained — docs/ops/cli.md).");
      out("");
      out("Then: pnpm -r build && metistry up   (containers, every launchd job, doctor — docs/ops/cli.md).");
      out(`Then, to version it off this machine: metistry connect-repo <your private remote> --instance ${result.dir} (docs/ops/cli.md).`);
      return 0;
    }
    case "connect-repo": {
      const url = positional[0];
      if (!url) {
        err("usage: metistry connect-repo <url> [--instance <dir>] [--auth device|token|ssh] [--force]");
        return 2;
      }
      loadEnv();
      const instanceDir = str(flags, "instance") ?? process.env.METISTRY_INSTANCE_DIR;
      if (!instanceDir) {
        err("connect-repo needs the instance repo: pass --instance <dir> or set METISTRY_INSTANCE_DIR (docs/ops/cli.md)");
        return 2;
      }
      try {
        const r = await connectRepo({
          url,
          instanceDir,
          auth: parseAuth(str(flags, "auth")),
          force: flags.force === true,
          out,
          ...(io.exec ? { exec: io.exec } : {}),
        });
        out(`connected: ${instanceDir} → ${url} (branch ${r.branch}, credential ${r.credential})`);
        return 0;
      } catch (e) {
        err(`metistry connect-repo: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "connect": {
      const loaded = loadEnv();
      const instanceId = loaded.instanceDir ? await readInstanceId(loaded.instanceDir) : undefined;
      // the same three seams every verb takes, so CI (Linux) can exercise the
      // macOS paths: the platform, the `security` child, and $HOME
      const common = {
        ...(loaded.instanceDir ? { instanceDir: loaded.instanceDir } : {}),
        ...(instanceId ? { instanceId } : {}),
        ...(io.exec ? { exec: io.exec } : {}),
        ...(io.platform ? { platform: io.platform } : {}),
        ...(io.home ? { home: io.home } : {}),
        ...(io.fetchFn ? { fetchFn: io.fetchFn } : {}),
      };
      if (flags.list === true) {
        try {
          const r = await connectList(common);
          out(flags.json === true ? JSON.stringify(r, null, 2) : renderConnectList(r, ui));
          return 0;
        } catch (e) {
          err(`metistry connect --list: ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
      }
      const tool = parseTool(positional[0]);
      if (!tool) {
        err(`usage: metistry connect <${CONNECT_TOOLS.join("|")}> [--rotate] [--remote] [--areas Areas/A,Projects/B] [--project <slug>] [--json]`);
        err("       metistry connect --list [--json]");
        return 2;
      }
      try {
        const r = await connect({
          tool,
          rotate: flags.rotate === true,
          remote: flags.remote === true,
          ...(csv(str(flags, "areas")) ? { areas: csv(str(flags, "areas")) } : {}),
          ...(csv(str(flags, "project")) ? { projects: csv(str(flags, "project")) } : {}),
          ...common,
        });
        out(flags.json === true ? JSON.stringify(r, null, 2) : renderConnect(r));
        return 0;
      } catch (e) {
        err(`metistry connect ${tool}: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "secrets": {
      const sub = positional[0];
      // Every verb below that rewrites `.env` ends here: under the launchd
      // shape the supervisor's plist and supervisor.json carry `.env` as `up`
      // last rendered it, so a changed token or key reaches nothing until
      // they are re-rendered (env-follow.ts). A no-op anywhere else.
      const followEnv = async (loadedF: LoadedEnv, outF: (l: string) => void): Promise<FollowEnvResult | undefined> => {
        if (!productDir || !loadedF.paths) return undefined;
        try {
          return await followEnvFile({
            productDir,
            envFiles: loadedF.paths.read.length > 0 ? loadedF.paths.read : [loadedF.paths.write],
            envFileFlag: str(flags, "env-file"),
            instanceDir: loadedF.instanceDir,
            home: io.home ?? process.env.HOME,
            platform: io.platform ?? process.platform,
            env: process.env,
            exec: io.exec ?? realExec,
            out: outF,
            // this very CLI, on this very node: the `up` that renders is the code that just wrote `.env`
            cli: { node: process.execPath, main: fileURLToPath(import.meta.url) },
            dryRun: flags["dry-run"] === true,
          });
        } catch (e) {
          outF(`launchd: could not compare the running jobs with .env (${e instanceof Error ? e.message : String(e)}) — run \`metistry up\` so they carry its values`);
          return undefined;
        }
      };
      if ((sub !== undefined && NAMED_SECRET_VERBS.has(sub)) || (sub === "list" && flags.named === true)) {
        // An owner-named secret needs the instance, not a `.env`: its value
        // is in the Keychain under the instance's id, its policy in the
        // instance's secrets.yaml.
        const loadedNamed = loadEnv();
        const instanceDir = str(flags, "instance") ?? loadedNamed.instanceDir;
        if (!instanceDir) {
          err("secrets needs the instance repo: pass --instance <dir> or set METISTRY_INSTANCE_DIR (docs/ops/cli.md) — secrets.yaml lives there");
          return 2;
        }
        const instanceId = await readInstanceId(instanceDir);
        const json = flags.json === true;
        const namedOpts: NamedSecretsOptions = {
          instanceDir,
          instanceId,
          env: process.env,
          platform: io.platform ?? process.platform,
          uid: io.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
          fetchFn: io.fetchFn ?? fetch,
          dryRun: flags["dry-run"] === true,
          out: json ? err : out,
          ...(io.exec ? { exec: io.exec } : {}),
          ...(io.readStdin ? { readSecret: io.readStdin } : {}),
        };
        try {
          const done = (r: unknown): number => {
            if (json) out(JSON.stringify(r, null, 2));
            return 0;
          };
          switch (sub) {
            case "set":
              return done(await secretsSet(positional[1], { hosts: csv(str(flags, "hosts")), expires: str(flags, "expires") }, namedOpts));
            case "replace":
              return done(await secretsReplace(positional[1], { expires: str(flags, "expires") }, namedOpts));
            case "remove":
              return done(await secretsRemove(positional[1], { yes: flags.yes === true }, namedOpts));
            case "hosts":
              return done(await secretsHosts(positional[1], { hosts: positional.slice(2), clear: flags.clear === true }, namedOpts));
            case "grant":
              return done(await secretsGrant(positional[1], positional[2], positional[3], namedOpts));
            case "migrate-scope": {
              const r = await migrateScope({
                ...namedOpts,
                envFile: loadedNamed.paths?.read[0] ?? loadedNamed.paths?.write,
                exampleFile: productDir ? join(productDir, ".env.example") : undefined,
              });
              done(r);
              // it rewrites `.env`'s references, so the running jobs follow
              await followEnv(loadedNamed, namedOpts.out);
              // an original the Keychain would not hand over is a failure;
              // a reference waiting on a schema that reads {{ secret.name }} is not
              return r.unreadable.length > 0 ? 1 : 0;
            }
            case "purge-shared": {
              const r = await purgeShared({
                instanceDir,
                env: process.env,
                platform: namedOpts.platform,
                yes: flags.yes === true,
                out: namedOpts.out,
                exampleFile: productDir ? join(productDir, ".env.example") : undefined,
                ...(io.exec ? { exec: io.exec } : {}),
              });
              done(r);
              return flags.yes === true && r.deleted.length !== r.removable.length ? 1 : 0;
            }
            default: {
              const rows = await secretsListNamed(namedOpts);
              out(json ? JSON.stringify({ secrets: rows }, null, 2) : renderNamedSecrets(rows, instanceId));
              return 0;
            }
          }
        } catch (e) {
          err(`metistry secrets ${sub}: ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
      }
      const loaded = loadEnv();
      const paths = loaded.paths;
      if (!paths) {
        err("secrets needs a .env to read or generate: pass --env-file, --instance <dir>, or run inside a checkout (--product-dir / METISTRY_PRODUCT_DIR)");
        return 2;
      }
      // No Keychain involved — it moves plain lines between two files — so it
      // runs on every platform, before anything below asks for an instance_id.
      if (sub === "retire-legacy-env") {
        if (!loaded.instanceDir) {
          err("metistry secrets retire-legacy-env: no instance — until one exists, the product checkout's .env IS this install's environment (--instance <dir>)");
          return 2;
        }
        if (!paths.legacy) {
          out(`no product-checkout .env is being read — ${paths.write} is already this install's whole environment; nothing to retire.`);
          return 0;
        }
        try {
          const r = await retireLegacyEnv({
            legacy: paths.legacy,
            target: paths.write,
            jobFiles: await jobFilesFor({ instanceDir: loaded.instanceDir, home: io.home ?? process.env.HOME }),
            yes: flags.yes === true,
            pointerOnlyInLegacy: loaded.instanceFrom === "legacy-env",
            out,
          });
          // the file this run deleted is not "still being read": drop the notice collected before it went
          if (r.deleted) for (let i = notices.length - 1; i >= 0; i--) if (notices[i]!.includes(paths.legacy)) notices.splice(i, 1);
          // lines moved into the instance's `.env`: the jobs follow it (only
          // the file that is left is read now)
          if (flags.yes === true) await followEnv({ ...loaded, paths: { ...paths, read: r.deleted ? [paths.write] : paths.read } }, out);
          return r.kept ? 1 : 0;
        } catch (e) {
          err(`metistry secrets retire-legacy-env: ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
      }
      // read the highest-precedence file that exists (the product checkout's
      // while an install predates the move); write where it now belongs
      const envFile = paths.read[0] ?? paths.write;
      let instanceId = loaded.instanceDir ? await readInstanceId(loaded.instanceDir) : undefined;
      // `sync` is where an instance created before instance_id existed gets
      // one — it has to, because that id is the account it files under. A
      // read-only verb (`list`) and a destructive one (`purge`) never mint.
      if (!instanceId && loaded.instanceDir && positional[0] === "sync") {
        const runner = new StepRunner({ dryRun: false, out, ...(io.exec ? { exec: io.exec } : {}) });
        const minted = await ensureInstanceId(runner, {
          instanceDir: loaded.instanceDir,
          env: process.env,
          platform: io.platform ?? process.platform,
          uid: io.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
          fetchFn: fetch,
        });
        out(minted.detail);
        if (minted.id) instanceId = minted.id;
      }
      // `--to env` delivers every named secret compute.yaml's providers
      // reference (T4-18): the engine reads a key from its environment, never
      // the Keychain. A compute.yaml that does not validate delivers nothing,
      // and says so — the rest of the sync is unaffected.
      let deliver: string[] = [];
      if (loaded.instanceDir && positional[0] === "sync") {
        try {
          deliver = providerSecretNames((await loadCompute(instanceFile(loaded.instanceDir, "compute"))).compute);
        } catch (e) {
          out(`compute.yaml does not validate, so no provider key is delivered this run (${e instanceof Error ? e.message : String(e)})`);
        }
        // ...and every secret a connection the console reaches lists: a sync's
        // (T4-24: the Linear key) and, since the console holds the pool the
        // proxy dials through (T4-10), an MCP, API, feed or files
        // connection's — an OAuth sign-in's refresh token and the owner's own
        // client included. Each is filled at the egress door, for the secret's
        // listed hosts only; the console never reads the Keychain
        try {
          const syncSecrets = consoleSecretNames(await loadInstanceCatalog({ instanceDir: loaded.instanceDir, seedDir: resolveSeedDir(productDir) }));
          deliver = [...new Set([...deliver, ...syncSecrets])];
        } catch (e) {
          out(`the connection types could not be read, so no sync's secret is delivered this run (${e instanceof Error ? e.message : String(e)})`);
        }
        // ...and the owner's own github_write when secrets.yaml names it
        // (T2-13): the console's pull request doors post with it, filled only
        // while its *Sent only to* list names api.github.com. Named by the
        // file, never assumed: an instance without it delivers nothing
        const secretsPath = instanceFile(loaded.instanceDir, "secrets");
        try {
          if (existsSync(secretsPath) && Object.hasOwn(parseSecretsFile(await readFile(secretsPath, "utf8")).secrets, GITHUB_WRITE_SECRET)) deliver = [...new Set([...deliver, GITHUB_WRITE_SECRET])];
        } catch (e) {
          out(`secrets.yaml does not validate, so ${GITHUB_WRITE_SECRET} is not delivered this run (${e instanceof Error ? e.message : String(e)})`);
        }
      }
      // an installed launchd shape (this instance's supervisor.json): the
      // verb re-renders the jobs from `.env` itself, below
      const followRoot = loaded.instanceDir ?? productDir;
      const restartFollows = (io.platform ?? process.platform) === "darwin" && followRoot !== undefined && existsSync(supervisorConfigPath(followRoot));
      const secretsOpts = {
        envFile,
        restartFollows,
        envTarget: paths.write,
        exampleFile: productDir ? join(productDir, ".env.example") : undefined,
        instanceId,
        deliver,
        out,
        ...(io.exec ? { exec: io.exec } : {}),
        // the Keychain exists only on darwin; CI runs this suite on Linux, so tests pin the platform
        ...(io.platform ? { platform: io.platform } : {}),
        // `--to env`: a changed token's service is probed (its port answering
        // at all), so the restart it now needs is said, never discovered
        serviceRunning: async (service: TokenService) => {
          const shape = productDir ? await loadDeployment(productDir).then((d) => d.deployment.shape, () => undefined) : undefined;
          return serviceAnswers(service, { env: process.env, shape, fetchFn: io.fetchFn ?? fetch });
        },
      };
      try {
        switch (sub) {
          case "sync": {
            const direction = syncDirection(str(flags, "from"), str(flags, "to"));
            await syncSecrets(direction, secretsOpts);
            // `--to keychain` never writes `.env`
            if (direction === "env") await followEnv(loaded, out);
            return 0;
          }
          case "mint": {
            const name = positional[1];
            if (!name) {
              err("usage: metistry secrets mint <VAR>");
              return 2;
            }
            await mintSecret(name, secretsOpts);
            await followEnv(loaded, out);
            return 0;
          }
          case "list": {
            const rows = await listSecrets(secretsOpts);
            out(flags.json === true ? JSON.stringify(rows, null, 2) : renderSecretList(rows));
            return 0;
          }
          case "purge": {
            const dir = str(flags, "instance") ?? loaded.instanceDir;
            if (!dir) {
              err("usage: metistry secrets purge --instance <dir> [--yes]   (which instance's Keychain items to delete)");
              return 2;
            }
            const r = await purgeSecrets({ ...secretsOpts, instanceDir: dir, yes: flags.yes === true });
            const incomplete = r.deleted.length !== r.found.length || r.namedDeleted.length !== r.named.length;
            return r.found.length + r.named.length > 0 && incomplete && flags.yes === true ? 1 : 0;
          }
          default:
            err("usage: metistry secrets sync --to env|keychain | mint <VAR> | list [--named] | purge --instance <dir> [--yes] | retire-legacy-env [--yes]");
            err("       metistry secrets set|replace|remove|hosts|grant <name> … (owner-named secrets — docs/ops/cli.md)");
            err("       metistry secrets migrate-scope [--dry-run] | purge-shared [--yes] (the retired shared scope)");
            return 2;
        }
      } catch (e) {
        err(`metistry secrets: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "identity": {
      loadEnv();
      const instanceDir = str(flags, "instance") ?? process.env.METISTRY_INSTANCE_DIR;
      if (!instanceDir) {
        err("identity needs the instance repo: pass --instance <dir> or set METISTRY_INSTANCE_DIR (docs/ops/cli.md)");
        return 2;
      }
      if (positional[0] === "set") {
        const change: IdentityChange = {};
        for (const f of IDENTITY_SET_FIELDS) {
          const v = flags[f];
          if (v === true) {
            err(`--${f} takes a value (metistry identity set --${f} <value>)`);
            return 2;
          }
          if (v !== undefined) change[f] = v;
        }
        const json = flags.json === true;
        const dryRun = flags["dry-run"] === true;
        try {
          const r = await identitySet({
            instanceDir,
            change,
            env: process.env,
            platform: io.platform ?? process.platform,
            uid: io.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
            fetchFn: io.fetchFn ?? fetch,
            ...(io.exec ? { exec: io.exec } : {}),
            dryRun,
            // --json is a wire contract (docs/ops/cli.md): progress to stderr
            out: json ? err : out,
          });
          out(json ? JSON.stringify(r, null, 2) : renderIdentitySet(r, dryRun));
          return 0;
        } catch (e) {
          err(`metistry identity set: ${e instanceof Error ? e.message : String(e)}`);
          return e instanceof StepFailed ? e.code : 1;
        }
      }
      if (positional[0] !== undefined) {
        err("usage: metistry identity [--json] | metistry identity set [--name <name>] [--mention <@slug>] [--mark <glyph>] [--dry-run]");
        return 2;
      }
      const identity = await readIdentity(instanceDir);
      if (!identity) {
        err(`${instanceDir} has no identity.yaml — is this an instance directory? (\`metistry init\` creates one)`);
        return 1;
      }
      out(flags.json === true ? JSON.stringify(identity, null, 2) : renderIdentity(identity));
      return 0;
    }
    case "templates": {
      // §6.5: a template change takes effect at the NEXT run, which is the
      // right semantics and leaves one gap — between the edit and 19:00
      // nothing says whether the directive reads. This is that, and it needs
      // no database, no calendar and no vault (validateTemplate is pure).
      if (positional[0] !== "check") {
        err("usage: metistry templates check [<file>] [--instance <dir>] [--json]");
        return 2;
      }
      const loadedTemplates = loadEnv();
      const instanceDir = str(flags, "instance") ?? loadedTemplates.instanceDir;
      if (!instanceDir) {
        err("templates needs the instance repo: pass --instance <dir> or set METISTRY_INSTANCE_DIR (docs/ops/cli.md) — Templates/ is in the vault");
        return 2;
      }
      try {
        const file = positional[1];
        const report = await templatesCheck({ instanceDir, ...(file !== undefined ? { file } : {}) });
        out(flags.json === true ? JSON.stringify(report, null, 2) : renderTemplatesCheck(report, ui));
        // absent is not failed (design-system §3.15): no Templates/ exits 0
        return report.errors > 0 ? 1 : 0;
      } catch (e) {
        err(`metistry templates check: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "instances": {
      // The peer registry (S4, docs/ops/instances.md). Every write is a §4.7
      // protected write through the reconciler as the `user`, like compute.
      const loadedInstances = loadEnv();
      const instanceDir = str(flags, "instance") ?? loadedInstances.instanceDir;
      if (!instanceDir) {
        err("instances needs the instance repo: pass --instance <dir> or set METISTRY_INSTANCE_DIR (docs/ops/cli.md) — instances.yaml lives there");
        return 2;
      }
      const verb = parseInstanceVerb(positional[0]);
      if (!verb) {
        err(`usage: metistry instances ${INSTANCE_VERBS.join(" | ")}   (metistry --help)`);
        return 2;
      }
      const json = flags.json === true;
      const instancesOpts: InstancesOptions = {
        instanceDir,
        env: process.env,
        platform: io.platform ?? process.platform,
        uid: io.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
        fetchFn: fetch,
        ...(io.exec ? { exec: io.exec } : {}),
        dryRun: flags["dry-run"] === true,
        // --json is a wire contract (docs/ops/cli.md): only the final JSON
        // document goes to stdout, so a step's progress line goes to stderr.
        out: json ? err : out,
      };
      try {
        if (verb === "list") {
          const r = await instancesList(instancesOpts);
          out(json ? JSON.stringify(r, null, 2) : renderInstances(r));
          return 0;
        }
        if (verb === "add") {
          const origin = positional[1];
          if (!origin) {
            err("usage: metistry instances add <origin>   (e.g. https://metis.example.com — the verb asks it who it is)");
            return 2;
          }
          const selfId = await readInstanceId(instanceDir);
          const r = await instancesAdd({ ...instancesOpts, origin, ...(selfId ? { selfInstanceId: selfId } : {}) });
          out(json ? JSON.stringify(r, null, 2) : `${r.action} ${r.entry?.name} (${r.entry?.instance_id}) at ${r.entry?.origin} — ${r.delivery?.detail}\n\n${renderInstances(r)}`);
          return 0;
        }
        if (verb === "remove") {
          const target = positional[1];
          if (!target) {
            err("usage: metistry instances remove <instance_id|name>");
            return 2;
          }
          const r = await instancesRemove({ ...instancesOpts, target });
          out(json ? JSON.stringify(r, null, 2) : `removed ${r.entry?.name} (${r.entry?.instance_id}) — ${r.delivery?.detail}\n\n${renderInstances(r)}`);
          return 0;
        }
        const r = await instancesRefresh(instancesOpts);
        out(json ? JSON.stringify(r, null, 2) : `${r.action}${r.delivery ? ` — ${r.delivery.detail}` : ""}\n\n${renderInstances(r)}`);
        return 0;
      } catch (e) {
        err(`metistry instances ${verb}: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "vault": {
      // M18 (plan §2.21): the vault's git policy. The write is a §4.7
      // protected write through the reconciler as `user`, like set-shape.
      if (positional[0] === undefined || !(VAULT_VERBS as readonly string[]).includes(positional[0])) {
        err(`usage: metistry vault settings [--push <after_commit|manual|15m>] [--pull <5m>] [--yes]`);
        err(`       metistry vault rollback <commit> | --to <date> | --file <path> [--to <date>] [--include-config] | --request <id>   (metistry --help)`);
        return 2;
      }
      if (positional[0] === "rollback") {
        // M18 (plan §2.21, T10-6): a Needs You request, never a revert on
        // the spot; with --include-config this process carries out the
        // approved revert as the owner class.
        const loadedRb = loadEnv();
        const instanceDir = str(flags, "instance") ?? loadedRb.instanceDir;
        const commit = positional[1];
        const to = str(flags, "to");
        const file = str(flags, "file");
        const request = str(flags, "request");
        if (flags.to === true || flags.file === true || flags.request === true || positional.length > 2) {
          err("usage: metistry vault rollback <commit> | --to <date> | --file <path> [--to <date>] [--include-config] | --request <id>");
          return 2;
        }
        const named = [commit !== undefined, file !== undefined, to !== undefined && file === undefined, request !== undefined].filter(Boolean).length;
        if (named !== 1) {
          err("name exactly one thing to roll back: <commit>, --to <date>, --file <path> (optionally with --to), or --request <id> to resume a wait");
          return 2;
        }
        const target = commit !== undefined ? { commit } : file !== undefined ? { file, ...(to !== undefined ? { to } : {}) } : to !== undefined ? { to } : undefined;
        try {
          const r = await rollbackVault({
            target,
            includeConfig: flags["include-config"] === true || request !== undefined,
            request,
            env: { ...process.env, ...(instanceDir ? { METISTRY_INSTANCE_DIR: instanceDir } : {}) },
            platform: io.platform ?? process.platform,
            ...(instanceDir ? { instanceDir, instanceId: await readInstanceId(instanceDir) } : {}),
            fetchFn: io.fetchFn ?? fetch,
            ...(io.exec ? { exec: io.exec } : {}),
            out: flags.json === true ? () => {} : out,
          });
          if (flags.json === true) out(JSON.stringify(r, null, 2));
          return 0;
        } catch (e) {
          err(`metistry vault rollback: ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
      }
      if (!productDir) {
        err("vault settings needs a Metistry checkout: pass --product-dir or set METISTRY_PRODUCT_DIR — the seed's deployment.yaml is half of the policy");
        return 2;
      }
      const loadedVault = loadEnv();
      const instanceDir = str(flags, "instance") ?? loadedVault.instanceDir;
      const push = str(flags, "push");
      const pull = str(flags, "pull");
      if (flags.push === true || flags.pull === true) {
        err("--push and --pull each take a value: --push after_commit|manual|15m, --pull 5m");
        return 2;
      }
      const env = { ...process.env, ...(instanceDir ? { METISTRY_INSTANCE_DIR: instanceDir } : {}) };
      try {
        if (push === undefined && pull === undefined) {
          const settings = await loadVaultSettings(productDir, env);
          out(flags.json === true ? JSON.stringify(settings, null, 2) : renderVaultSettings(settings));
          return 0;
        }
        if (!instanceDir) {
          err("vault settings needs the instance repo: pass --instance <dir> or set METISTRY_INSTANCE_DIR (docs/ops/cli.md) — deployment.yaml lives there");
          return 2;
        }
        const r = await setVaultSettings({
          productDir,
          instanceDir,
          ...(push !== undefined ? { push: parsePushArg(push) } : {}),
          ...(pull !== undefined ? { pull: parsePullArg(pull) } : {}),
          yes: flags.yes === true,
          env,
          platform: io.platform ?? process.platform,
          uid: io.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
          fetchFn: io.fetchFn ?? fetch,
          ...(io.exec ? { exec: io.exec } : {}),
          out,
        });
        if (flags.json === true) out(JSON.stringify(r, null, 2));
        if (flags.yes !== true) out("preview only — pass --yes to write this.");
        return 0;
      } catch (e) {
        err(`metistry vault settings: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "extensions": {
      // M15 (plan §2.7): the owner's own units. Every write is a §4.7
      // protected write through the reconciler as the `user`, like compute.
      const loadedExt = loadEnv();
      const instanceDir = str(flags, "instance") ?? loadedExt.instanceDir;
      if (!instanceDir) {
        err("extensions needs the instance repo: pass --instance <dir> or set METISTRY_INSTANCE_DIR (docs/ops/cli.md) — .metistry/extensions/ lives there");
        return 2;
      }
      const verb = parseExtensionVerb(positional[0]);
      if (!verb) {
        err(`usage: metistry extensions ${EXTENSION_VERBS.join(" | ")}   (metistry --help)`);
        return 2;
      }
      let seedDir: string | undefined;
      try {
        seedDir = resolveSeedDir(productDir);
      } catch {
        seedDir = undefined; // no seed: only product units under the checkout, if any, are compared against
      }
      const json = flags.json === true;
      const extOpts: ExtensionsOptions = {
        instanceDir,
        ...(productDir ? { productDir } : {}),
        ...(seedDir ? { seedDir } : {}),
        env: process.env,
        platform: io.platform ?? process.platform,
        uid: io.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
        fetchFn: io.fetchFn ?? fetch,
        ...(io.exec ? { exec: io.exec } : {}),
        dryRun: flags["dry-run"] === true,
        // --json is a wire contract (docs/ops/cli.md): progress to stderr
        out: json ? err : out,
      };
      try {
        if (verb === "list") {
          const r = await extensionsList(extOpts);
          out(json ? JSON.stringify(r, null, 2) : renderExtensions(r));
          return 0;
        }
        if (verb === "add") {
          const source = positional[1];
          if (!source) {
            err("usage: metistry extensions add <dir>   (a directory holding the unit's manifest.yaml — docs/ops/extensions.md)");
            return 2;
          }
          const r = await extensionsAdd({ ...extOpts, source });
          out(
            json
              ? JSON.stringify(r, null, 2)
              : `${extOpts.dryRun ? "would add" : "added"} ${r.kind} ${r.name} (${r.files.join(", ")})${r.replaced ? ` — replaces the product's ${r.replaced}` : ""}${r.ignored.length > 0 ? `; not copied: ${r.ignored.join(", ")}` : ""} — ${r.deliveries.at(-1)?.detail ?? ""}`,
          );
          return 0;
        }
        const name = positional[1];
        if (!name) {
          err("usage: metistry extensions remove <name>   (`metistry extensions list` names them)");
          return 2;
        }
        const r = await extensionsRemove({ ...extOpts, name });
        out(
          json
            ? JSON.stringify(r, null, 2)
            : `${extOpts.dryRun ? "would remove" : "removed"} ${r.kind ?? "extension"} ${r.name}${r.restored ? ` — the product's ${r.restored} is back in force` : ""} — ${r.deliveries.at(-1)?.detail ?? "nothing to delete"}`,
        );
        return 0;
      } catch (e) {
        err(`metistry extensions ${verb}: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "variables": {
      // M14 (plan §2.2, §2.14): plain values agents read. Every write is a
      // §4.7 protected write through the reconciler as the `user`.
      const loadedVars = loadEnv();
      const instanceDir = str(flags, "instance") ?? loadedVars.instanceDir;
      if (!instanceDir) {
        err("variables needs the instance repo: pass --instance <dir> or set METISTRY_INSTANCE_DIR (docs/ops/cli.md) — variables.yaml lives there");
        return 2;
      }
      const verb = parseVariableVerb(positional[0]);
      if (!verb) {
        err(`usage: metistry variables ${VARIABLE_VERBS.join(" | ")}   (metistry --help)`);
        return 2;
      }
      const json = flags.json === true;
      const varOpts: VariablesOptions = {
        instanceDir,
        instanceId: await readInstanceId(instanceDir),
        env: process.env,
        platform: io.platform ?? process.platform,
        uid: io.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
        fetchFn: io.fetchFn ?? fetch,
        ...(io.exec ? { exec: io.exec } : {}),
        dryRun: flags["dry-run"] === true,
        // --json is a wire contract (docs/ops/cli.md): progress to stderr
        out: json ? err : out,
      };
      try {
        if (verb === "list") {
          const rows = await variablesList(varOpts);
          out(json ? JSON.stringify({ variables: rows }, null, 2) : renderVariables(rows));
          return 0;
        }
        if (verb === "set") {
          if (positional.length > 3) {
            err("usage: metistry variables set <name> <value>   (quote a value with spaces: one argument)");
            return 2;
          }
          const r = await variablesSet(positional[1], positional[2], varOpts);
          if (json) out(JSON.stringify(r, null, 2));
          else if (r.delivery) out(r.delivery.detail);
          return 0;
        }
        const r = await variablesUnset(positional[1], varOpts);
        if (json) out(JSON.stringify(r, null, 2));
        else if (r.delivery) out(r.delivery.detail);
        return 0;
      } catch (e) {
        err(`metistry variables ${verb}: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "connections": {
      // M13 (plan §2.2, §2.6): where Metistry reaches for the owner. Every
      // write is a §4.7 protected write through the reconciler as the `user`;
      // `add` and `test` dial, through the same pool the console uses.
      const loadedConn = loadEnv();
      const instanceDir = str(flags, "instance") ?? loadedConn.instanceDir;
      if (!instanceDir) {
        err("connections needs the instance repo: pass --instance <dir> or set METISTRY_INSTANCE_DIR (docs/ops/cli.md) — .metistry/connections/ lives there");
        return 2;
      }
      const verb = parseConnectionVerb(positional[0]);
      if (!verb) {
        err(`usage: metistry connections ${CONNECTION_VERBS.join(" | ")}   (metistry --help)`);
        return 2;
      }
      // parseArgs appends everything after `--` to the positionals: split it back off
      const command = afterDoubleDash(argv);
      const args = command ? positional.slice(0, positional.length - command.length) : positional;
      let seedDir: string | undefined;
      try {
        seedDir = resolveSeedDir(productDir);
      } catch {
        seedDir = undefined; // no seed: only the owner's own connection types
      }
      const json = flags.json === true;
      const connOpts: ConnectionsOptions = {
        instanceDir,
        instanceId: await readInstanceId(instanceDir),
        ...(seedDir ? { seedDir } : {}),
        env: process.env,
        platform: io.platform ?? process.platform,
        uid: io.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
        fetchFn: io.fetchFn ?? fetch,
        ...(io.dialFetch ? { dialFetch: io.dialFetch } : {}),
        ...(io.exec ? { exec: io.exec } : {}),
        dryRun: flags["dry-run"] === true,
        // --json is a wire contract (docs/ops/cli.md): progress to stderr
        out: json ? err : out,
      };
      const scopes = repeatedFlag(argv, "scope");
      const auth = {
        auth: str(flags, "auth"),
        secret: str(flags, "secret"),
        authHeader: str(flags, "auth-header"),
        username: str(flags, "username"),
        authorizeUrl: str(flags, "authorize-url"),
        tokenUrl: str(flags, "token-url"),
        ...(scopes.length ? { scopes } : {}),
        clientIdSecret: str(flags, "client-id-secret"),
        clientSecretSecret: str(flags, "client-secret-secret"),
        tokenSecret: str(flags, "token-secret"),
      };
      try {
        if (verb === "list") {
          const rows = await connectionsList(connOpts);
          out(json ? JSON.stringify({ connections: rows }, null, 2) : renderConnections(rows));
          return 0;
        }
        if (verb === "show") {
          const d = await connectionsShow(args[1], connOpts);
          out(json ? JSON.stringify({ connection: d }, null, 2) : renderConnectionDetail(d));
          return 0;
        }
        if (verb === "test") {
          const r = await connectionsTest(args[1], connOpts);
          out(json ? JSON.stringify(r, null, 2) : renderCheck(r));
          return r.status === "failed" ? 1 : 0;
        }
        if (verb === "add") {
          const r = await connectionsAdd(
            {
              name: args[1],
              type: str(flags, "type"),
              provider: str(flags, "provider"),
              url: str(flags, "url"),
              imap: str(flags, "imap"),
              plain: flags.plain === true,
              path: str(flags, "path"),
              include: repeatedFlag(argv, "include"),
              skip: repeatedFlag(argv, "skip"),
              command,
              env: repeatedFlag(argv, "env"),
              headers: repeatedFlag(argv, "header"),
              runsOn: str(flags, "runs-on"),
              description: str(flags, "description"),
              config: repeatedFlag(argv, "config"),
              discover: flags["no-discover"] !== true,
              ...auth,
            },
            connOpts,
          );
          out(json ? JSON.stringify(r, null, 2) : [r.delivery?.detail ?? "", ...(r.sync ? [r.sync.delivery.detail] : [])].filter(Boolean).join("\n"));
          return 0;
        }
        if (verb === "authorize") {
          const t = str(flags, "timeout");
          const timeoutS = t === undefined ? undefined : Number(t);
          if (timeoutS !== undefined && (!Number.isFinite(timeoutS) || timeoutS <= 0 || timeoutS > 3600)) throw new StepFailed("--timeout is seconds, more than 0 and at most 3600");
          const r = await connectionsAuthorize(args[1], { browser: flags["no-browser"] !== true, ...(timeoutS !== undefined ? { timeoutS } : {}) }, connOpts);
          out(json ? JSON.stringify(r, null, 2) : (r.policy?.delivery.detail ?? ""));
          return 0;
        }
        if (verb === "set") {
          const r = await connectionsSet(
            args[1],
            {
              url: str(flags, "url"),
              command,
              env: repeatedFlag(argv, "env"),
              unsetEnv: repeatedFlag(argv, "unset-env"),
              headers: repeatedFlag(argv, "header"),
              unsetHeaders: repeatedFlag(argv, "unset-header"),
              runsOn: str(flags, "runs-on"),
              description: str(flags, "description"),
              config: repeatedFlag(argv, "config"),
              unsetConfig: repeatedFlag(argv, "unset-config"),
              ...auth,
            },
            connOpts,
          );
          out(json ? JSON.stringify(r, null, 2) : (r.delivery?.detail ?? ""));
          return 0;
        }
        if (verb === "policy") {
          const r = await connectionsPolicy(args[1], { tool: args[2], mode: args[3], group: str(flags, "group"), offer: str(flags, "offer") }, connOpts);
          out(json ? JSON.stringify(r, null, 2) : [renderPolicy(r.row), ...(r.delivery ? [r.delivery.detail] : [])].join("\n"));
          return 0;
        }
        const r = await connectionsRemove(args[1], connOpts);
        out(json ? JSON.stringify(r, null, 2) : r.delivery.detail);
        return 0;
      } catch (e) {
        err(`metistry connections ${verb}: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "runs": {
      if (positional[0] !== "export") {
        err("usage: metistry runs export [--since <cursor|timestamp>] [--until <timestamp>] [--component <name>] [--limit N] [--json-lines]");
        return 2;
      }
      const loadedRuns = loadEnv();
      const instanceId = loadedRuns.instanceDir ? await readInstanceId(loadedRuns.instanceDir) : undefined;
      try {
        // NDJSON on stdout so a pipe gets nothing else; the summary is stderr's.
        const r = await runsExport({
          write: (chunk) => process.stdout.write(chunk),
          ...(str(flags, "since") ? { since: str(flags, "since") } : {}),
          ...(str(flags, "until") ? { until: str(flags, "until") } : {}),
          ...(str(flags, "component") ? { component: str(flags, "component") } : {}),
          ...(str(flags, "limit") ? { limit: Number(str(flags, "limit")) } : {}),
          ...(loadedRuns.instanceDir ? { instanceDir: loadedRuns.instanceDir } : {}),
          ...(instanceId ? { instanceId } : {}),
          ...(io.exec ? { exec: io.exec } : {}),
          ...(io.platform ? { platform: io.platform } : {}),
          ...(io.fetchFn ? { fetchFn: io.fetchFn } : {}),
        });
        err(renderRunsExport(r));
        return 0;
      } catch (e) {
        err(`metistry runs export: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "console": {
      const printConsoleUsage = () => {
        err("usage: metistry console whoami [--json] [--instance <dir>] [--env-file <path>]");
        err("       metistry console call <METHOD> <path> [--body @file|-] [--idempotency-key <key>] [--json] [--instance <dir>] [--env-file <path>]");
        err("       metistry console session --stdio [--instance <dir>] [--env-file <path>]");
      };
      if (positional[0] !== "whoami" && positional[0] !== "call" && positional[0] !== "session") {
        printConsoleUsage();
        return 2;
      }
      const loaded = loadEnv();
      const consoleCommon = {
        // instanceDir: a namespaced instance's console is on its own port (state/ports.yaml), never the default 8080
        ...(loaded.instanceDir ? { instanceDir: loaded.instanceDir, instanceId: await readInstanceId(loaded.instanceDir) } : {}),
        ...(io.exec ? { exec: io.exec } : {}),
        ...(io.platform ? { platform: io.platform } : {}),
        ...(io.fetchFn ? { fetchFn: io.fetchFn } : {}),
      };
      if (positional[0] === "session") {
        // --stdio is the only transport today, and it is spelled out so a
        // second one (a socket) is a new flag rather than a changed default.
        if (flags.stdio !== true || positional.length > 1) {
          printConsoleUsage();
          return 2;
        }
        try {
          await runConsoleSession({
            ...consoleCommon,
            input: io.sessionInput ?? createInterface({ input: process.stdin, crlfDelay: Infinity }),
            // A line is written whole and awaited: stdout to a pipe is
            // asynchronous on macOS, and the last answer must not be lost to
            // the exit that follows it.
            write: io.out ? (line) => io.out?.(line) : (line) => new Promise<void>((resolve) => process.stdout.write(`${line}\n`, () => resolve())),
          });
          return 0;
        } catch (e) {
          err(`metistry console session: ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
      }
      if (positional[0] === "call") {
        const method = positional[1];
        const path = positional[2];
        if (!method || !path || !path.startsWith("/")) {
          printConsoleUsage();
          return 2;
        }
        let body: string | undefined;
        const bodyFlag = str(flags, "body");
        if (bodyFlag !== undefined) {
          try {
            if (bodyFlag === "-") body = await (io.readStdin ?? readStdin)();
            else if (bodyFlag.startsWith("@")) body = await readFile(bodyFlag.slice(1), "utf8");
            else throw new Error(`--body takes @<file> or - (stdin), not ${JSON.stringify(bodyFlag)}`);
          } catch (e) {
            err(`metistry console call: ${e instanceof Error ? e.message : String(e)}`);
            return 2;
          }
        }
        try {
          const r = await consoleCall({ method: method.toUpperCase(), path, body, idempotencyKey: str(flags, "idempotency-key"), ...consoleCommon });
          if (r.status >= 400) {
            err(`metistry console call: ${renderConsoleCallError(r)}`);
            // --json also prints the console's own body on stdout, so a 409's
            // `reason` and the row it names (docs/ops/console-api.md's
            // conflictBody) survive the trip — the envelope alone is
            // `{code, message}`. Plain mode stays exactly as it was: the
            // envelope on stderr, nothing on stdout.
            if (flags.json === true) out(r.raw);
            return 1;
          }
          // A replay is the ORIGINAL response, not a new write (docs/ops/console-api.md).
          // --json folds it into the printed body so a script sees it without
          // reading headers this CLI never prints; plain mode says it on stderr
          // instead, leaving the body exactly what it always was.
          if (flags.json === true) {
            if (r.replayed && r.body !== null && typeof r.body === "object" && !Array.isArray(r.body)) {
              out(JSON.stringify({ ...(r.body as Record<string, unknown>), replayed: true }));
            } else {
              if (r.replayed) err("metistry console call: idempotency-replayed (the original response, not a new write) — could not fold into a non-object --json body");
              out(r.raw);
            }
          } else {
            out(typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2));
            if (r.replayed) err("metistry console call: idempotency-replayed — the console returned the ORIGINAL response, not a new write");
          }
          return 0;
        } catch (e) {
          err(`metistry console call: ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
      }
      try {
        const w = await whoami(consoleCommon);
        out(flags.json === true ? JSON.stringify(w, null, 2) : renderWhoami(w));
        return 0;
      } catch (e) {
        err(`metistry console whoami: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "agents": {
      const common = () => {
        const loaded = loadEnv();
        return (async () => ({
          // instanceDir: a namespaced instance's console is on its own port (state/ports.yaml), never the default 8080
          ...(loaded.instanceDir ? { instanceDir: loaded.instanceDir, instanceId: await readInstanceId(loaded.instanceDir) } : {}),
          ...(io.exec ? { exec: io.exec } : {}),
          ...(io.platform ? { platform: io.platform } : {}),
          ...(io.fetchFn ? { fetchFn: io.fetchFn } : {}),
        }))();
      };
      // `list` is READ-ONLY, and deliberately renders nothing of its own: the
      // console sends each row's scope already rendered (core's
      // `describeScope`), so the CLI, the panel and the queue cannot drift
      // into three vocabularies for one record again (§2.10 of
      // docs/research/2026-09-19-grants-and-access-simplified.md).
      if (positional[0] === "list") {
        try {
          const rows = await agentsList(await common());
          out(flags.json === true ? JSON.stringify({ agents: rows }, null, 2) : renderAgents(rows, ui));
          return 0;
        } catch (e) {
          err(`metistry agents list: ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
      }
      // M12 (§2.2): a crew's definition — `.metistry/agents/<area>/<id>.md`,
      // a protected path — in the owner's hand. The console only reads it.
      if (positional[0] === "define") {
        const id = positional[1];
        const loadedDefine = loadEnv();
        const instanceDir = str(flags, "instance") ?? loadedDefine.instanceDir;
        if (!id || !instanceDir) {
          err(`${AGENTS_USAGE}${id ? "\n(define needs the instance repo: pass --instance <dir> or set METISTRY_INSTANCE_DIR)" : ""}`);
          return 2;
        }
        const json = flags.json === true;
        try {
          const promptFile = str(flags, "prompt-file");
          const effort = str(flags, "effort");
          const view = await agentsDefine({
            id,
            change: {
              area: str(flags, "area"),
              model: str(flags, "model"),
              effort: effort as Effort | undefined,
              description: str(flags, "description"),
              prompt: promptFile === undefined ? undefined : promptFile === "-" ? await (io.readStdin ?? readStdin)() : await readFile(promptFile, "utf8"),
            },
            ifSha256: str(flags, "if-sha256"),
            instanceDir,
            seedDir: resolveSeedDir(productDir),
            env: process.env,
            platform: io.platform ?? process.platform,
            uid: io.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
            fetchFn: io.fetchFn ?? fetch,
            dryRun: flags["dry-run"] === true,
            // --json is a wire contract: only the final document on stdout
            out: json ? err : out,
            ...(io.exec ? { exec: io.exec } : {}),
          });
          out(json ? JSON.stringify(view, null, 2) : renderDefine(view, ui));
          return 0;
        } catch (e) {
          err(`metistry agents define: ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
      }
      // The owner's own hand on an agent's autonomy — one of the two doors a
      // WIDENING may come through (docs/ops/actions.md). The mode flags are
      // read off the RAW argv because each of them may be repeated, and the
      // shared parser keeps only the last of a repeated flag.
      if (positional[0] !== "autonomy" || !positional[1]) {
        err(AGENTS_USAGE);
        return 2;
      }
      const loaded = loadEnv();
      try {
        const view = await agentAutonomy(positional[1], parseAutonomyFlags(argv), {
          ...(loaded.instanceDir ? { instanceDir: loaded.instanceDir, instanceId: await readInstanceId(loaded.instanceDir) } : {}),
          ...(io.exec ? { exec: io.exec } : {}),
          ...(io.platform ? { platform: io.platform } : {}),
          ...(io.fetchFn ? { fetchFn: io.fetchFn } : {}),
        });
        out(flags.json === true ? JSON.stringify(view, null, 2) : renderAutonomy(view, ui));
        return 0;
      } catch (e) {
        err(`metistry agents autonomy: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "version": {
      const loaded = loadEnv();
      const info = await collectVersionInfo({ productDir, instanceDir: loaded.instanceDir });
      out(flags.json === true ? JSON.stringify(info, null, 2) : renderVersionInfo(info, ui));
      return 0;
    }
    case "import-sessions": {
      loadEnv();
      const limitRaw = str(flags, "limit");
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        err(`--limit must be a positive integer, not ${JSON.stringify(limitRaw)}`);
        return 2;
      }
      try {
        const r = await importSessions({
          out,
          err,
          since: str(flags, "since"),
          project: str(flags, "project"),
          limit,
          dryRun: flags["dry-run"] === true,
          ...(io.exec ? { exec: io.exec } : {}),
        });
        return r.code;
      } catch (e) {
        err(`metistry import-sessions: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "doctor": {
      if (!productDir) {
        err("doctor needs a Metistry checkout to walk: pass --product-dir or set METISTRY_PRODUCT_DIR");
        return 2;
      }
      loadEnv();
      // the probes are the slow part (every bridge over HTTP, launchctl,
      // docker): a TTY gets a spinner, a pipe gets nothing, and neither gets
      // a byte of it in the --json document
      const probing = flags.json === true ? undefined : ui.spinner(`probing ${productDir}`, out);
      try {
        const report = await doctor({ productDir, ...io.doctorDeps });
        probing?.stop();
        out(flags.json === true ? JSON.stringify(report, null, 2) : renderTable(report, ui));
        return report.ok ? 0 : 1;
      } finally {
        probing?.stop();
      }
    }
    case "runtime": {
      if (positional[0] !== "install") {
        err("usage: metistry runtime install --from <Metistry.app | .../Contents/Resources/metistry> [--to <dir>] [--force]");
        return 2;
      }
      const from = str(flags, "from");
      if (!from) {
        err("usage: metistry runtime install --from <Metistry.app | .../Contents/Resources/metistry> [--to <dir>] [--force]");
        return 2;
      }
      const runner = new StepRunner({ dryRun: flags["dry-run"] === true, out, ...(io.exec ? { exec: io.exec } : {}) });
      try {
        const r = await installRuntime(runner, { from, to: str(flags, "to"), force: flags.force === true, home: io.home });
        out(r.installed ? `runtime installed: ${r.productDir} (${r.version})` : `runtime unchanged: ${r.productDir} (${r.reason ?? "already current"})`);
        return 0;
      } catch (e) {
        err(`metistry runtime install: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "up": {
      if (!productDir) {
        err("up needs a Metistry checkout: pass --product-dir or set METISTRY_PRODUCT_DIR");
        return 2;
      }
      const registerViaRaw = str(flags, "register-via");
      if (registerViaRaw !== undefined && registerViaRaw !== "launchd" && registerViaRaw !== "app") {
        err(`--register-via must be launchd or app, not ${JSON.stringify(registerViaRaw)}`);
        return 2;
      }
      const registerVia = registerViaRaw as "launchd" | "app" | undefined;
      loadEnv();
      const r = await up({
        productDir,
        out,
        exec: io.exec,
        envFile: str(flags, "env-file"),
        dryRun: flags["dry-run"] === true,
        compose: flags["no-compose"] !== true,
        launchd: flags["no-launchd"] !== true,
        namespace: flags.namespace === true,
        ...(registerVia ? { registerVia } : {}),
        doctorDeps: io.doctorDeps,
      });
      return r.code;
    }
    case "update": {
      if (!productDir) {
        err("update needs a Metistry checkout: pass --product-dir or set METISTRY_PRODUCT_DIR");
        return 2;
      }
      let continueFrom: ContinueFrom | undefined;
      try {
        continueFrom = parseContinueFrom(flags["continue-from"]);
      } catch (e) {
        err(`metistry update: ${e instanceof Error ? e.message : String(e)}`);
        return 2;
      }
      loadEnv();
      const r = await update({
        productDir,
        continueFrom,
        noReexec: flags["no-reexec"] === true,
        forwardFlags: flags,
        out,
        exec: io.exec,
        envFile: str(flags, "env-file"),
        dryRun: flags["dry-run"] === true,
        skipBuild: flags["skip-build"] === true,
        skipMigrate: flags["skip-migrate"] === true,
        channel,
        releaseVersion: str(flags, "version"),
        rollback: flags.rollback === true,
        allowLegacy: flags["allow-legacy"] === true,
        appPath: flags["no-app"] === true ? null : str(flags, "app-path"),
        relaunch: flags.relaunch === true,
        doctorDeps: io.doctorDeps,
      });
      return r.code;
    }
    case "migrate-inbox": {
      const loadedMi = loadEnv();
      const dir = loadedMi.instanceDir ?? str(flags, "instance");
      if (!dir) {
        err("usage: metistry migrate-inbox [--instance <dir>] [--dry-run]  (or set METISTRY_INSTANCE_DIR)");
        return 2;
      }
      try {
        const r = await migrateInbox({ instanceDir: dir, out, exec: io.exec, dryRun: flags["dry-run"] === true });
        return r.code;
      } catch (e) {
        err(`metistry migrate-inbox: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "migrate-layout": {
      // loadEnv first: the database rewrite needs the install's own
      // environment, and under the legacy layout that file is still at
      // `<instance>/state/.env` (instance.ts reads both spellings).
      const loadedMl = loadEnv();
      const dir = loadedMl.instanceDir ?? str(flags, "instance");
      if (!dir) {
        err("usage: metistry migrate-layout [--instance <dir>] [--dry-run] [--json] [--allow-dirty]  (or set METISTRY_INSTANCE_DIR)");
        return 2;
      }
      const jsonMl = flags.json === true;
      try {
        const r = await migrateLayout({
          instanceDir: dir,
          // --json is a machine-readable result, so the step log goes to
          // stderr rather than into the middle of the document
          out: jsonMl ? err : out,
          exec: io.exec,
          dryRun: flags["dry-run"] === true,
          allowDirty: flags["allow-dirty"] === true,
          ...(io.platform ? { platform: io.platform } : {}),
          ...(io.uid !== undefined ? { uid: io.uid } : {}),
        });
        if (jsonMl) out(JSON.stringify(r, null, 2));
        return r.code;
      } catch (e) {
        err(`metistry migrate-layout: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "migrate-shape": {
      if (!productDir) {
        err("migrate-shape needs a Metistry checkout: pass --product-dir or set METISTRY_PRODUCT_DIR");
        return 2;
      }
      const target = parseDeploymentShape(positional[0]);
      if (!target) {
        err("usage: metistry migrate-shape <launchd|compose> [--dry-run] [--namespace] [--instance <dir>]");
        return 2;
      }
      loadEnv();
      try {
        const r = await migrateShape({
          productDir,
          target,
          out,
          exec: io.exec,
          envFile: str(flags, "env-file"),
          dryRun: flags["dry-run"] === true,
          namespace: flags.namespace === true,
          platform: io.platform ?? undefined,
          uid: io.uid,
          home: io.home,
          doctorDeps: io.doctorDeps,
        });
        return r.code;
      } catch (e) {
        err(`metistry migrate-shape: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "down": {
      if (!productDir) {
        err("down needs a Metistry checkout: pass --product-dir or set METISTRY_PRODUCT_DIR");
        return 2;
      }
      if (positional.length > 0) {
        err(`metistry down takes no service names — it stops everything. For one service: metistry stop ${positional.join(" ")}`);
        return 2;
      }
      const loadedDown = loadEnv();
      const downJson = flags.json === true;
      try {
        const r = await downAll({
          productDir,
          envFile: loadedDown.paths ? (loadedDown.paths.read[0] ?? loadedDown.paths.write) : undefined,
          // --json is the same wire contract restart/stop/start keep: only
          // the final object on stdout, the plan's lines on stderr
          out: downJson ? err : out,
          exec: io.exec,
          platform: io.platform ?? undefined,
          uid: io.uid,
          home: io.home,
          dryRun: flags["dry-run"] === true,
        });
        out(downJson ? JSON.stringify({ ok: r.ok, shape: r.shape, results: r.results, confirmations: r.confirmations, ...(r.appRegistrarNote ? { app_registrar_note: r.appRegistrarNote } : {}) }, null, 2) : renderDown(r, ui));
        return r.ok ? 0 : 1;
      } catch (e) {
        err(`metistry down: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "restart":
    case "stop":
    case "start": {
      if (!productDir) {
        err(`${command} needs a Metistry checkout: pass --product-dir or set METISTRY_PRODUCT_DIR`);
        return 2;
      }
      const loadedSc = loadEnv();
      const asJson = flags.json === true;
      try {
        const r = await controlServices({
          productDir,
          envFile: loadedSc.paths ? (loadedSc.paths.read[0] ?? loadedSc.paths.write) : undefined,
          action: command as ServiceAction,
          names: positional,
          // --json is a wire contract for the Mac app (docs/ops/cli.md): only
          // the final array goes to stdout — the plan's progress lines go to
          // stderr rather than vanish, so they are still there to read.
          out: asJson ? err : out,
          exec: io.exec,
          platform: io.platform ?? undefined,
          uid: io.uid,
          home: io.home,
          dryRun: flags["dry-run"] === true,
        });
        out(asJson ? JSON.stringify(r.results, null, 2) : renderServiceResults(r.results, ui));
        return r.ok ? 0 : 1;
      } catch (e) {
        if (e instanceof UnknownServiceError) {
          err(`metistry ${command}: ${e.message}`);
          return 2;
        }
        err(`metistry ${command}: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "logs": {
      if (!productDir) {
        err("logs needs a Metistry checkout: pass --product-dir or set METISTRY_PRODUCT_DIR");
        return 2;
      }
      const service = positional[0];
      if (!service) {
        err("usage: metistry logs <service> [--lines N] [--follow]");
        return 2;
      }
      const loadedLogs = loadEnv();
      const linesRaw = str(flags, "lines");
      const lines = linesRaw === undefined ? 200 : Number(linesRaw);
      if (!Number.isInteger(lines) || lines <= 0) {
        err(`--lines must be a positive integer, not ${JSON.stringify(linesRaw)}`);
        return 2;
      }
      try {
        const r = await serviceLogs({
          productDir,
          envFile: loadedLogs.paths ? (loadedLogs.paths.read[0] ?? loadedLogs.paths.write) : undefined,
          service,
          lines,
          follow: flags.follow === true,
          out,
          exec: io.exec,
          platform: io.platform ?? undefined,
          uid: io.uid,
          home: io.home,
          dryRun: flags["dry-run"] === true,
        });
        if (!r.ok) err(`metistry logs: ${r.detail}`);
        return r.ok ? 0 : 1;
      } catch (e) {
        if (e instanceof UnknownServiceError) {
          err(`metistry logs: ${e.message}`);
          return 2;
        }
        err(`metistry logs: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "compute": {
      const loadedCompute = loadEnv();
      const instanceDir = str(flags, "instance") ?? loadedCompute.instanceDir;
      if (!instanceDir) {
        err("compute needs the instance repo: pass --instance <dir> or set METISTRY_INSTANCE_DIR (docs/ops/cli.md) — compute.yaml lives there");
        return 2;
      }
      let seedDir: string;
      try {
        seedDir = resolveSeedDir(productDir);
      } catch (e) {
        err(`metistry compute: ${e instanceof Error ? e.message : String(e)}`);
        return 2;
      }
      const json = flags.json === true;
      const computeOpts: ComputeOptions = {
        instanceDir,
        seedDir,
        env: process.env,
        platform: io.platform ?? process.platform,
        uid: io.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
        // `io.fetchFn` FIRST, like every other verb that makes a request
        // (`console`, `connect`). Hardcoding the global here meant a test
        // driving these verbs through `main()` reached the real console and
        // the real provider endpoints instead of its own fakes — which is
        // exactly the class of thing docs/ops/testing.md exists to prevent.
        fetchFn: io.fetchFn ?? fetch,
        dryRun: flags["dry-run"] === true,
        // --json is a wire contract (docs/ops/cli.md): only the final JSON
        // document goes to stdout, so a step's progress line (a stored-secret
        // notice, a download's progress, a budget's reminder) goes to stderr.
        out: json ? err : out,
        ...(io.exec ? { exec: io.exec } : {}),
      };
      // The provider templates in force (the registry, plan §2.7) — every
      // hint and usage line that names them reads this, never a list in code.
      const templates = await computeTemplates(computeOpts);
      const templateNames = (): string[] => templates.names();
      try {
        switch (positional[0]) {
          case undefined:
          case "show": {
            const report = await computeReport(computeOpts);
            out(json ? JSON.stringify(report, null, 2) : renderComputeReport(report, templateNames()));
            return 0;
          }
          case "providers": {
            switch (positional[1]) {
              case undefined:
              case "list": {
                const report = await computeReport(computeOpts);
                out(json ? JSON.stringify({ providers: report.providers }, null, 2) : renderComputeReport(report, templateNames()));
                return 0;
              }
              case "add": {
                // a template is a unit of the provider registry (plan §2.7):
                // the product's and this instance's own
                const template = str(flags, "from");
                if (!template || !templates.has(template)) {
                  // a typo, never a guess: name what exists, and why a unit of that name did not load
                  const skipped = templates.skipped.filter((s) => s.name === template).map((s) => `${s.path} was skipped: ${s.reason}`);
                  if (template) err(`no provider template named ${JSON.stringify(template)}${skipped.length > 0 ? ` (${skipped.join("; ")})` : ""}`);
                  err(`usage: metistry compute providers add --from ${templateChoices(templateNames())} [--name <n>] [--base-url <url>] [--secret <name>] [--skip-test]`);
                  return 2;
                }
                const r = await providersAdd({
                  ...computeOpts,
                  template,
                  name: str(flags, "name"),
                  baseUrl: str(flags, "base-url"),
                  secret: str(flags, "secret"),
                  skipTest: flags["skip-test"] === true,
                });
                if (json) out(JSON.stringify(r, null, 2));
                else {
                  out(`provider ${r.name} added (${r.provider.locality}, ${r.provider.base_url}) — ${r.delivery.detail}`);
                  if (r.test) out(renderProviderTest(r.test, ui));
                }
                return 0;
              }
              case "set": {
                const name = positional[2];
                if (!name || flags.enabled === true || flags.billing === true || flags.secret === true || flags["base-url"] === true) {
                  err("usage: metistry compute providers set <name> [--enabled on|off] [--billing token|subscription] [--base-url <url>] [--secret <name>]");
                  return 2;
                }
                const r = await providersSet({
                  ...computeOpts,
                  name,
                  enabled: parseSwitch(str(flags, "enabled")),
                  billing: parseBilling(str(flags, "billing")),
                  baseUrl: str(flags, "base-url"),
                  secret: str(flags, "secret"),
                });
                out(json ? JSON.stringify(r, null, 2) : `provider ${r.name}: ${r.changed.join(", ")} — ${r.delivery.detail}`);
                return 0;
              }
              case "remove": {
                const name = positional[2];
                if (!name) {
                  err("usage: metistry compute providers remove <name>");
                  return 2;
                }
                const r = await providersRemove({ ...computeOpts, name });
                out(json ? JSON.stringify(r, null, 2) : `provider ${r.name} removed — ${r.delivery.detail}`);
                return 0;
              }
              case "test": {
                const name = positional[2];
                if (!name) {
                  err("usage: metistry compute providers test <name> [--complete] [--model <id>]");
                  return 2;
                }
                // a live GET /v1/models (and, with --complete, a real call):
                // seconds against a cloud provider, and nothing to look at
                // meanwhile unless this says so
                const testing = json ? undefined : ui.spinner(`${name}: GET /v1/models${flags.complete === true ? " and one completion" : ""}`, out);
                try {
                  const r = await providerTest({ ...computeOpts, name, complete: flags.complete === true, model: str(flags, "model") });
                  testing?.stop();
                  out(json ? JSON.stringify(r, null, 2) : renderProviderTest(r, ui));
                  return r.ok ? 0 : 1;
                } finally {
                  testing?.stop();
                }
              }
              default:
                err(`usage: metistry compute providers list | add --from ${templateChoices(templateNames())} | set <name> … | remove <name> | test <name> [--complete] [--model <id>]`);
                return 2;
            }
          }
          case "models": {
            switch (positional[1]) {
              case undefined:
              case "list": {
                const r = await modelsList({ ...computeOpts, provider: str(flags, "provider") });
                out(json ? JSON.stringify(r, null, 2) : renderModelsList(r, templateNames()));
                return r.providers.every((p) => p.ok) ? 0 : 1;
              }
              case "search": {
                // every switched-on provider's catalogue, grouped by model
                // (C131) — live from the CLI; the console keeps the listings
                // and re-reads them on Refresh
                const r = await modelsSearch({ ...computeOpts, query: positional.slice(2).join(" "), provider: str(flags, "provider") });
                out(json ? JSON.stringify(r, null, 2) : renderModelsSearch(r, ui));
                return r.providers.every((p) => p.ok) ? 0 : 1;
              }
              case "install": {
                const ref = positional[2];
                if (!ref) {
                  err("usage: metistry compute models install <provider>/<model>   (llamaserver: <provider>/<hf-owner>/<hf-repo>/<file>.gguf)");
                  return 2;
                }
                const r = await modelsInstall({ ...computeOpts, ref });
                out(json ? JSON.stringify(r, null, 2) : renderModelsInstall(r));
                return r.ok ? 0 : 1;
              }
              case "load":
              case "unload": {
                const ref = positional[2];
                if (!ref) {
                  err(`usage: metistry compute models ${positional[1]} <provider>/<model> [--ttl <seconds>]`);
                  return 2;
                }
                const ttl = seconds(flags, "ttl");
                const r = await modelsLoad({ ...computeOpts, ref, unload: positional[1] === "unload", ttlSeconds: ttl });
                if (json) out(JSON.stringify(r, null, 2));
                return r.ok ? 0 : 1;
              }
              default:
                err("usage: metistry compute models list [--provider <name>] | search [<query>] | install <provider/model> | load|unload <provider/model>");
                return 2;
            }
          }
          case "assign": {
            const target = parseAssignmentTarget(positional[1]);
            const model = positional[2];
            if (!model) {
              err("usage: metistry compute assign <default|<tier>|crew:<name>> <provider/model> [--effort low|medium|high]");
              return 2;
            }
            const r = await assign({ ...computeOpts, target, model, effort: parseEffort(str(flags, "effort")) });
            out(json ? JSON.stringify(r, null, 2) : `${r.target} → ${r.provider}/${r.model} at ${r.effort} effort — ${r.delivery.detail}`);
            return 0;
          }
          case "unassign": {
            const target = parseAssignmentTarget(positional[1]);
            const r = await unassign({ ...computeOpts, target });
            out(json ? JSON.stringify(r, null, 2) : `${r.target} removed — ${r.delivery.detail}`);
            return 0;
          }
          case "budget": {
            const target = parseBudgetTarget(positional[1]);
            const action = parseBudgetAction(str(flags, "action"));
            if (!action) {
              err("usage: metistry compute budget <instance|provider:<name>> [--daily <usd>] [--monthly <usd>] --action allow|stop|critical_only");
              return 2;
            }
            const r = await setBudget({ ...computeOpts, target, daily: usd(flags, "daily"), monthly: usd(flags, "monthly"), action });
            out(json ? JSON.stringify(r, null, 2) : `${r.target}: ${r.daily_usd ? `$${r.daily_usd}/day ` : ""}${r.monthly_usd ? `$${r.monthly_usd}/month ` : ""}action ${r.action} — ${r.delivery.detail}`);
            return 0;
          }
          case "cache-report": {
            // A READ, alone among the compute verbs: the runs ledger through
            // the console's generic query door (invariant 3), joined to
            // compute.yaml's rates. Nothing is written and no model is called.
            const loadedRun = loadEnv();
            const r = await cacheReport({
              ...computeOpts,
              since: str(flags, "since"),
              ...(loadedRun.instanceDir ? { instanceId: await readInstanceId(loadedRun.instanceDir) } : {}),
            });
            out(json ? JSON.stringify(r, null, 2) : renderCacheReport(r, ui));
            // `degraded` is a reading, not a failure: the command worked, and
            // exiting non-zero would make a low hit ratio look like a broken
            // console to anything scripting this.
            return 0;
          }
          case "route-report": {
            // The other READ verb, and PoC-20 phase 0 entire
            // (docs/research/2026-09-21-intent-classification-tier.md §5.2):
            // `inbound_messages.meta.route` through the console's generic
            // query door (invariant 3). Nothing is written, no model is
            // called, and no message body leaves the database.
            const loadedRun = loadEnv();
            const r = await routeReport({
              ...computeOpts,
              since: str(flags, "since"),
              ...(loadedRun.instanceDir ? { instanceId: await readInstanceId(loadedRun.instanceDir) } : {}),
            });
            out(json ? JSON.stringify(r, null, 2) : renderRouteReport(r, ui));
            // A high fall-through is a READING — the reading that says build
            // phase 1 — not a failure of the command.
            return 0;
          }
          default:
            err("usage: metistry compute show | providers … | models list|search … | assign … | unassign … | budget … | cache-report | route-report   (metistry --help)");
            return 2;
        }
      } catch (e) {
        err(`metistry compute: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "deployment": {
      if (!productDir) {
        err("deployment needs a Metistry checkout: pass --product-dir or set METISTRY_PRODUCT_DIR");
        return 2;
      }
      if (positional[0] === "set-shape") {
        const targetShape = parseDeploymentShape(positional[1]);
        if (!targetShape) {
          err("usage: metistry deployment set-shape <compose|launchd> [--yes] [--force] [--instance <dir>]");
          return 2;
        }
        const loadedDep = loadEnv();
        const instanceDir = str(flags, "instance") ?? loadedDep.instanceDir;
        if (!instanceDir) {
          err("deployment set-shape needs the instance repo: pass --instance <dir> or set METISTRY_INSTANCE_DIR (docs/ops/cli.md) — deployment.yaml lives there");
          return 2;
        }
        try {
          const r = await setDeploymentShape({
            productDir,
            instanceDir,
            targetShape,
            yes: flags.yes === true,
            force: flags.force === true,
            env: process.env,
            platform: io.platform ?? process.platform,
            uid: io.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
            fetchFn: fetch,
            exec: io.exec,
            out,
          });
          if (r.refused) return 1;
          if (flags.yes !== true) out("preview only — pass --yes to write this.");
          return 0;
        } catch (e) {
          err(`metistry deployment set-shape: ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
      }
      if (positional[0] === "set-keep-awake") {
        const usage = `usage: metistry deployment set-keep-awake [<${KEEP_AWAKE_VALUES.join("|")}>] [--enabled true|false] [--sleep-on-battery true|false] [--sleep-lid-closed true|false] [--yes] [--instance <dir>]`;
        const keepAwake: KeepAwake | undefined = parseKeepAwake(positional[1]);
        let set: KeepAwakeFlags;
        try {
          set = keepAwakeFlags(flags);
        } catch (e) {
          err(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
          return 2;
        }
        // a value that is not one of the four is a typo, never a guess — and
        // so is naming nothing at all
        if ((positional[1] !== undefined && !keepAwake) || positional.length > 2 || (keepAwake === undefined && Object.keys(set).length === 0)) {
          err(usage);
          return 2;
        }
        const loadedDep = loadEnv();
        const instanceDir = str(flags, "instance") ?? loadedDep.instanceDir;
        if (!instanceDir) {
          err("deployment set-keep-awake needs the instance repo: pass --instance <dir> or set METISTRY_INSTANCE_DIR (docs/ops/cli.md) — deployment.yaml lives there");
          return 2;
        }
        try {
          await setKeepAwake({
            productDir,
            instanceDir,
            keepAwake,
            set,
            yes: flags.yes === true,
            env: process.env,
            platform: io.platform ?? process.platform,
            uid: io.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
            fetchFn: fetch,
            exec: io.exec,
            out,
          });
          if (flags.yes !== true) out("preview only — pass --yes to write this.");
          return 0;
        } catch (e) {
          err(`metistry deployment set-keep-awake: ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
      }
      loadEnv();
      const report = await buildDeploymentReport({ productDir, env: process.env, exec: io.exec, platform: io.platform, uid: io.uid });
      out(flags.json === true ? JSON.stringify(report, null, 2) : renderDeploymentReport(report, ui));
      return 0;
    }
    default:
      err(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

// bin entry: only when executed directly, so tests can import main(). The
// bin is a symlink under npx/pnpm; compare real paths.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}
/**
 * Every verb ends here, and every verb LEAVES.
 *
 * launchd (or docker) owns the daemon; the CLI never does. `up` bootstraps
 * the supervisor and returns — the supervisor is launchd's child, not this
 * process's — so nothing a verb did entitles it to sit in a terminal, and a
 * probe that left a socket or a timer behind must not be able to keep it
 * there. `process.exitCode` is set first so a normal drain still carries the
 * right code, then the process is ended once stdout has flushed (exiting
 * mid-write truncates a piped doctor table).
 */
function finish(code: number): void {
  process.exitCode = code;
  process.stdout.write("", () => process.exit(code));
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(finish, (e) => {
    process.stderr.write(`metistry: ${e instanceof Error ? e.message : String(e)}\n`);
    finish(1);
  });
}
