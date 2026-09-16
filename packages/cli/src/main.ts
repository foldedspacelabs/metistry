#!/usr/bin/env node
// `metistry` — init | connect-repo | connect | secrets | console | doctor | up |
// update (plan
// §4.16; connect-repo and secrets are the install verbs the Mac app drives,
// docs/product/desktop-app-plan.md). Hand-rolled argument parsing: a handful
// of subcommands and flags does not justify a dependency this project would
// maintain for years (CLAUDE.md).

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DeploymentShape } from "@foldedspacelabs/metistry-core";
import {
  assign,
  computeReport,
  modelsInstall,
  modelsList,
  modelsLoad,
  parseAssignmentTarget,
  parseBudgetAction,
  parseBudgetTarget,
  parseEffort,
  parseTemplate,
  providerTest,
  providersAdd,
  providersRemove,
  renderComputeReport,
  renderModelsInstall,
  renderModelsList,
  renderProviderTest,
  setBudget,
  COMPUTE_TEMPLATES,
  type ComputeOptions,
} from "./compute.js";
import { buildDeploymentReport, renderDeploymentReport, setDeploymentShape } from "./deployment-report.js";
import { doctor, renderTable, type DoctorDeps } from "./doctor.js";
import { loadInstallEnv, productVersion, resolveProductDir, resolveSeedDir, type LoadedEnv } from "./env.js";
import { realExec, type Exec } from "./exec.js";
import { AUTH_MODES, connectRepo, type AuthMode } from "./connect-repo.js";
import { connect, connectList, CONNECT_TOOLS, parseTool, renderConnect, renderConnectList } from "./connect.js";
import { renderWhoami, whoami } from "./console-client.js";
import { agentAutonomy, parseAutonomyFlags, renderAutonomy } from "./agents.js";
import { importSessions } from "./import-sessions.js";
import { init } from "./init.js";
import { migrateInbox } from "./migrate-inbox.js";
import { migrateShape } from "./migrate-shape.js";
import { ensureInstanceId, instanceEnvFile, readInstanceId } from "./instance.js";
import { readIdentity, renderIdentity } from "./identity.js";
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
import { listSecrets, mintSecret, purgeSecrets, renderSecretList, syncSecrets, type SyncDirection } from "./secrets.js";
import { controlServices, renderServiceResults, serviceLogs, UnknownServiceError, type ServiceAction } from "./service-control.js";
import { StepRunner } from "./steps.js";
import { up } from "./up.js";
import { gitHead, update } from "./update.js";
import { collectVersionInfo, renderVersionInfo } from "./version.js";

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | true>;
}

/** Flags that never take a value, so `metistry init --force <dir>` keeps its dir. */
export const BOOLEAN_FLAGS = new Set(["force", "json", "help", "version", "dry-run", "no-launchd", "no-compose", "skip-build", "skip-migrate", "rollback", "yes", "follow", "namespace", "rotate", "list", "complete", "skip-test", "remote", "json-lines"]);

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
                      [--shape compose|launchd] [--force] [--product-dir <checkout>]
      Create a private instance repo at <dir> from the product's seed/ (git init,
      Knowledge/, identity.yaml with a minted instance_id, rules.yaml, config dirs,
      metistry.lock, one commit).
      Prints the .env lines to put in <dir>/state/.env next — never writes them,
      including METISTRY_ORIGIN (the console refuses to start without it) and a
      METISTRY_RECONCILER_URL shaped for --shape (default: launchd on macOS,
      compose elsewhere — docs/ops/deployment-shapes.md); both are loopback
      addresses that a namespaced instance's own ports replace.
      --channel writes metistry.lock's product.source: git (this install is a
      checkout update fast-forwards; the default) or release (it consumes
      published artifacts — docs/ops/releases.md).

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
                   [--areas Knowledge/A,Knowledge/B] [--project <slug>] [--json]
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
      read grant to those TitleCase Knowledge/ prefixes, --project adds project
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
      The macOS login Keychain (service metistry:<VAR>) is the canonical store;
      .env is generated from it, at <instance>/state/.env. --to keychain imports
      .env's secret-shaped variables (names ending _TOKEN _PASSWORD _PRIVATE
      _SECRET _KEY); --to env rewrites just those
      lines in place (0600; every comment and non-secret line preserved) and
      moves a product-checkout .env into the instance the first time. mint makes
      a new random token in both. list prints names and scopes, never values
      (--json: the same rows as an array).
      Items are scoped by account: instance-scoped ones under the instance's
      instance_id, user-scoped ones (your compute provider keys, your AWS keys)
      under the shared per-user account — secrets.ts SECRET_SCOPES is the table.
      purge deletes one instance's items and nothing else; without --yes it only
      previews.

  metistry console whoami [--json] [--instance <dir>] [--env-file <path>]
      Ask the console who it thinks you are, using this install's
      METISTRY_LOCAL_OWNER_TOKEN (docs/ops/auth.md): principal, how it was proved,
      and whether that credential reaches the management surface. The local
      owner token authenticates as the "user" principal — the same principal
      a passkey session yields — but only over a connection from THIS
      machine, so this is also the check that the door works before the Mac
      app is blamed for it. The token comes from the environment
      (<instance>/state/.env) or the login Keychain, and is never printed.

  metistry identity [--json] [--instance <dir>]
      The instance's identity.yaml (name, mention, voice, icon, instance_id) —
      the only place the assistant is named (CLAUDE.md). Read-only: identity.yaml
      is a §4.7 protected path, so this verb has no field to change it.

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
      SMAppService so Login Items shows one item nested under the app.
      --namespace allocates this instance its own launchd label suffix (from
      instance_id) and an 8-port block, recorded ONCE in <instance>/state/ports.yaml,
      so a second instance can run beside the first. Every later up/doctor/
      restart/stop/start/logs reads that file; delete it (after "metistry stop")
      to go back to the fixed labels and ports.

  metistry update [--skip-build] [--skip-migrate] [--dry-run] [--product-dir <dir>]
                  [--channel git|release] [--version <x.y.z>] [--rollback]
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

  metistry restart [<service>…] [--json] [--dry-run] [--product-dir <checkout>]
  metistry stop    [<service>…] [--json] [--dry-run] [--product-dir <checkout>]
  metistry start   [<service>…] [--json] [--dry-run] [--product-dir <checkout>]
      Act on one, several, or (no args) every service the current shape runs —
      the same shape read from deployment.yaml, and the same host-job/container
      split up and doctor use. Host jobs: launchctl kickstart -k (restart),
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
  metistry compute providers add --from <openrouter|zen|lmstudio|ollama>
                                 [--name <n>] [--base-url <url>] [--secret <NAME>] [--skip-test]
  metistry compute providers remove <name>
  metistry compute providers test <name> [--complete]
  metistry compute models list [--provider <name>] [--json]
  metistry compute models install <provider/model> [--json]
  metistry compute models load|unload <provider/model> [--ttl <seconds>] [--json]
  metistry compute assign <default|<tier>|crew:<name>> <provider/model> [--effort low|medium|high]
  metistry compute budget <instance|provider:<name>> [--daily <usd>] [--monthly <usd>]
                          --action allow|stop|critical_only
      This instance's compute.yaml: which providers exist, which model each
      tier and crew runs on, and what each may spend (docs/ops/compute.md).
      A §4.7 protected path like deployment.yaml — every write goes through
      the reconciler as the "user" principal, and an edit that would not
      validate is refused rather than written. "providers add" reads the API
      key from stdin into the login Keychain (user scope) and never takes it
      as an argument. Nothing dials a provider or enforces a budget yet.

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

  metistry migrate-inbox [--instance <dir>] [--dry-run]
      Move an existing instance's inbox into the vault: inbox/* (or a second
      instance's lowercase Knowledge/inbox/, renamed through a temp name
      because macOS is case-insensitive) into Knowledge/Inbox/, git mv for
      what git tracks and a plain move for what it does not; drop inbox/
      from .gitignore and add Knowledge/Inbox/.large/; rewrite inbox.path
      rows to Knowledge/Inbox/<file>; commit it. Idempotent — a second run
      says "already on the vault inbox" and changes nothing. Restarts
      nothing: it prints the metistry up line and stops. docs/ops/inbox.md.

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
}

export async function main(argv: string[], io: MainIo = {}): Promise<number> {
  const out = io.out ?? ((s: string) => process.stdout.write(s + "\n"));
  const err = io.err ?? ((s: string) => process.stderr.write(s + "\n"));
  const { command, positional, flags } = parseArgs(argv);
  const productDir = resolveProductDir(str(flags, "product-dir"));
  /**
   * This install's environment, from the instance's own `state/.env` and
   * then the product checkout's deprecated one. Deprecation notices go to
   * STDERR so `doctor --json` stays machine-readable.
   */
  const loadEnv = (): LoadedEnv => {
    const loaded = loadInstallEnv({ productDir, instanceDir: str(flags, "instance"), envFile: str(flags, "env-file") });
    for (const n of loaded.notices) err(n);
    return loaded;
  };
  // `metistry --version` (no subcommand): the bare flag every CLI answers,
  // ahead of the "no command" usage/exit-2 case below. `metistry version` is
  // the same thing as a real subcommand, further down.
  if (command === undefined && flags.version === true) {
    const info = await collectVersionInfo({ productDir, instanceDir: loadEnv().instanceDir });
    out(flags.json === true ? JSON.stringify(info, null, 2) : renderVersionInfo(info));
    return 0;
  }
  if (command === undefined || command === "help" || flags.help) {
    out(USAGE);
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
      const result = await init({
        dir,
        name: str(flags, "name"),
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
      };
      if (flags.list === true) {
        try {
          const r = await connectList(common);
          out(flags.json === true ? JSON.stringify(r, null, 2) : renderConnectList(r));
          return 0;
        } catch (e) {
          err(`metistry connect --list: ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
      }
      const tool = parseTool(positional[0]);
      if (!tool) {
        err(`usage: metistry connect <${CONNECT_TOOLS.join("|")}> [--rotate] [--remote] [--areas Knowledge/A,Knowledge/B] [--project <slug>] [--json]`);
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
      const loaded = loadEnv();
      const paths = loaded.paths;
      if (!paths) {
        err("secrets needs a .env to read or generate: pass --env-file, --instance <dir>, or run inside a checkout (--product-dir / METISTRY_PRODUCT_DIR)");
        return 2;
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
      const secretsOpts = {
        envFile,
        envTarget: paths.write,
        exampleFile: productDir ? join(productDir, ".env.example") : undefined,
        instanceId,
        out,
        ...(io.exec ? { exec: io.exec } : {}),
        // the Keychain exists only on darwin; CI runs this suite on Linux, so tests pin the platform
        ...(io.platform ? { platform: io.platform } : {}),
      };
      try {
        switch (sub) {
          case "sync":
            await syncSecrets(syncDirection(str(flags, "from"), str(flags, "to")), secretsOpts);
            return 0;
          case "mint": {
            const name = positional[1];
            if (!name) {
              err("usage: metistry secrets mint <VAR>");
              return 2;
            }
            await mintSecret(name, secretsOpts);
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
            return r.found.length > 0 && r.deleted.length !== r.found.length && flags.yes === true ? 1 : 0;
          }
          default:
            err("usage: metistry secrets sync --to env|keychain | metistry secrets mint <VAR> | metistry secrets list | metistry secrets purge --instance <dir> [--yes]");
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
      const identity = await readIdentity(instanceDir);
      if (!identity) {
        err(`${instanceDir} has no identity.yaml — is this an instance directory? (\`metistry init\` creates one)`);
        return 1;
      }
      out(flags.json === true ? JSON.stringify(identity, null, 2) : renderIdentity(identity));
      return 0;
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
        out,
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
        });
        err(renderRunsExport(r));
        return 0;
      } catch (e) {
        err(`metistry runs export: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "console": {
      if (positional[0] !== "whoami") {
        err("usage: metistry console whoami [--json] [--instance <dir>] [--env-file <path>]");
        return 2;
      }
      const loaded = loadEnv();
      try {
        const w = await whoami({
          ...(loaded.instanceDir ? { instanceId: await readInstanceId(loaded.instanceDir) } : {}),
          ...(io.exec ? { exec: io.exec } : {}),
          ...(io.platform ? { platform: io.platform } : {}),
        });
        out(flags.json === true ? JSON.stringify(w, null, 2) : renderWhoami(w));
        return 0;
      } catch (e) {
        err(`metistry console whoami: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "agents": {
      // The owner's own hand on an agent's autonomy — one of the two doors a
      // WIDENING may come through (docs/ops/actions.md). The mode flags are
      // read off the RAW argv because each of them may be repeated, and the
      // shared parser keeps only the last of a repeated flag.
      if (positional[0] !== "autonomy" || !positional[1]) {
        err("usage: metistry agents autonomy <id> [--level observe|propose|act_within_scope] [--allow <kind>] [--propose <kind>] [--deny <kind>] [--json]");
        return 2;
      }
      const loaded = loadEnv();
      try {
        const view = await agentAutonomy(positional[1], parseAutonomyFlags(argv), {
          ...(loaded.instanceDir ? { instanceId: await readInstanceId(loaded.instanceDir) } : {}),
          ...(io.exec ? { exec: io.exec } : {}),
          ...(io.platform ? { platform: io.platform } : {}),
        });
        out(flags.json === true ? JSON.stringify(view, null, 2) : renderAutonomy(view));
        return 0;
      } catch (e) {
        err(`metistry agents autonomy: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "version": {
      const loaded = loadEnv();
      const info = await collectVersionInfo({ productDir, instanceDir: loaded.instanceDir });
      out(flags.json === true ? JSON.stringify(info, null, 2) : renderVersionInfo(info));
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
      const report = await doctor({ productDir, ...io.doctorDeps });
      out(flags.json === true ? JSON.stringify(report, null, 2) : renderTable(report));
      return report.ok ? 0 : 1;
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
      loadEnv();
      const r = await update({
        productDir,
        out,
        exec: io.exec,
        envFile: str(flags, "env-file"),
        dryRun: flags["dry-run"] === true,
        skipBuild: flags["skip-build"] === true,
        skipMigrate: flags["skip-migrate"] === true,
        channel,
        releaseVersion: str(flags, "version"),
        rollback: flags.rollback === true,
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
          // the final array goes to stdout, none of the plan's progress lines
          out: asJson ? () => {} : out,
          exec: io.exec,
          platform: io.platform ?? undefined,
          uid: io.uid,
          home: io.home,
          dryRun: flags["dry-run"] === true,
        });
        out(asJson ? JSON.stringify(r.results, null, 2) : renderServiceResults(r.results));
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
        fetchFn: fetch,
        dryRun: flags["dry-run"] === true,
        out,
        ...(io.exec ? { exec: io.exec } : {}),
      };
      try {
        switch (positional[0]) {
          case undefined:
          case "show": {
            const report = await computeReport(computeOpts);
            out(json ? JSON.stringify(report, null, 2) : renderComputeReport(report));
            return 0;
          }
          case "providers": {
            switch (positional[1]) {
              case undefined:
              case "list": {
                const report = await computeReport(computeOpts);
                out(json ? JSON.stringify({ providers: report.providers }, null, 2) : renderComputeReport(report));
                return 0;
              }
              case "add": {
                const template = parseTemplate(str(flags, "from"));
                if (!template) {
                  err(`usage: metistry compute providers add --from ${COMPUTE_TEMPLATES.join("|")} [--name <n>] [--base-url <url>] [--secret <NAME>] [--skip-test]`);
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
                  if (r.test) out(renderProviderTest(r.test));
                }
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
                  err("usage: metistry compute providers test <name> [--complete]");
                  return 2;
                }
                const r = await providerTest({ ...computeOpts, name, complete: flags.complete === true });
                out(json ? JSON.stringify(r, null, 2) : renderProviderTest(r));
                return r.ok ? 0 : 1;
              }
              default:
                err(`usage: metistry compute providers list | add --from ${COMPUTE_TEMPLATES.join("|")} | remove <name> | test <name>`);
                return 2;
            }
          }
          case "models": {
            switch (positional[1]) {
              case undefined:
              case "list": {
                const r = await modelsList({ ...computeOpts, provider: str(flags, "provider") });
                out(json ? JSON.stringify(r, null, 2) : renderModelsList(r));
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
                err("usage: metistry compute models list [--provider <name>] | install <provider/model> | load|unload <provider/model>");
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
          default:
            err("usage: metistry compute show | providers … | models list | assign … | budget …   (metistry --help)");
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
      loadEnv();
      const report = await buildDeploymentReport({ productDir, env: process.env, exec: io.exec, platform: io.platform, uid: io.uid });
      out(flags.json === true ? JSON.stringify(report, null, 2) : renderDeploymentReport(report));
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
if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`metistry: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
