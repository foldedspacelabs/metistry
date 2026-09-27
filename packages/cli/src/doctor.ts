// `metistry doctor` — generic over manifests (invariant 5): every component
// is a directory with a manifest, so doctor walks the checkout, validates
// each manifest against core's schema, and probes whatever declares a
// network surface through the one wire contract every bridge and service
// already implements (GET /check → the frozen check() shape). Nothing here
// knows what a bridge does; a new component that ships a manifest and
// answers /check is covered without touching this file.
//
// Beyond the manifests: the db (SELECT 1 + applied migrations vs. files on
// disk — the invariant-3 exception the watchdog also holds), the launchd
// jobs ops/launchd ships (macOS), the compose containers, and one row per
// local model server found on this Mac. Every row is a core CheckResult plus
// a `kind`; exit 0 when nothing is `failed`.

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  checkResultSchema,
  cutoffIsAFinding,
  failureStreaks,
  humanGap,
  instanceStatePath,
  intEnv,
  type KeychainBackend,
  keepAwakeSettingOf,
  keepAwakeValue,
  parseKeepAwakeState,
  parseSleepDisabled,
  wantsLidClosedAwake,
  powerSourceLabel,
  resolveUrl,
  shouldHold,
  runCheck,
  describeSchedule,
  isInterval,
  isLegacyCron,
  longestGapSeconds,
  configuredTimeZone,
  nextOccurrence,
  profileFacts,
  resolveDays,
  servicePlan,
  SHAPED_SERVICES,
  usesCompose,
  validateManifest,
  DEFAULT_MAX_STREAK,
  KEEP_AWAKE_CUTOFF_FACTOR,
  KEEP_AWAKE_KIND,
  KEEP_AWAKE_STATE_FILENAME,
  LID_CLOSED_COMMAND,
  LID_CLOSED_NOT_AVAILABLE,
  LID_CLOSED_UNDO,
  LID_CLOSED_WARNING,
  PMSET_READS,
  PREFLIGHT_FAILED,
  RUNNER_KIND,
  SCHEDULED_KINDS,
  SKIPPED_STREAK,
  type CheckResult,
  type Deployment,
  type DeploymentShape,
  type ChildStatus,
  type Manifest,
  type ManifestSchedule,
  type Occurrence,
  type ProfileFacts,
  type SupervisorConfig,
} from "@foldedspacelabs/metistry-core";
import { COMPUTE_FILENAME, INSTANCE_LAYOUT, LEGACY_VAULT_DIR, PROFILE_PATH, REGISTRY_KINDS, TEMPLATE_MISSING, describeVaultSync, detectLayout, pushOverrideNote, readStandupKeys, emptyCompute, extensionsDirFor, instanceFile, loadCompute, loadKind, resolveInstanceLayout, vaultStatusSchema, type Compute, type RegistryKindName, type VaultStatus } from "@foldedspacelabs/metistry-core";
import { cliShimLinkHint, cliShimPath } from "./cli-shim.js";
import { engineStatus, loadDeployment } from "./deployment.js";
import { localServerRows } from "./local-models.js";
import { realExec, type Exec } from "./exec.js";
import { labelFor, loadPlistTemplates, logPathFor, parseRegistrar, registrarPhrase, SUPERVISED_SERVICES, type RegistrarFinding } from "./launchd.js";
import { actualName } from "./migrate-inbox.js";
import { readSupervisorConfig, supervisorConfigPath, controlRequest, SUPERVISOR_SERVICE } from "./supervisor.js";
import { SANDBOX_EXEC, UNCONFINED_PROFILE_REL } from "./sandbox.js";
import { applyPorts, loadNamespace, type Namespace } from "./namespace.js";
import { defaultUi, padTo, statusName, visibleWidth, type Ui } from "./ui.js";
import { envPaths, readInstanceId } from "./instance.js";
import { securityPresence } from "./keychain.js";
import { MIGRATE_SCOPE_COMMAND, sharedScopeStatus } from "./secrets.js";
import { connectionDoctorRows } from "./connection-check.js";
import { resolveSeedDir } from "./env.js";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  end?(): Promise<void>;
}

/**
 * A structured fix for the Services pane to offer as a button, next to the
 * free-text `remediation` a person reads in a terminal (plan §3.3, T4-21).
 * Present only when doctor can NAME the fix without guessing — never derived
 * by parsing `remediation` prose ("enforce at the tool, never by prompting":
 * a regex over a sentence meant for a human is not a control). `command` is
 * argv, never a shell string — the Mac app already runs every CLI verb this
 * way (`ProcessCommandRunner`), and a `run_verb` action is refused the same
 * `--yes` gate as running it by hand: doctor never appends one, so the app's
 * own preview-then-confirm still stands between a button and a mutation.
 */
export type DoctorAction =
  | { kind: "open_secrets"; label: string }
  | { kind: "open_system_settings"; label: string }
  | { kind: "run_verb"; command: string[]; label: string };

export interface DoctorRow extends CheckResult {
  kind: string;
  /** absent when the row is `ok`, or when doctor has nothing more specific to offer than the remediation text. */
  action?: DoctorAction;
}

const runVerb = (command: string[], label: string): DoctorAction => ({ kind: "run_verb", command, label });
const openSecrets = (label: string): DoctorAction => ({ kind: "open_secrets", label });
const openSystemSettings = (label: string): DoctorAction => ({ kind: "open_system_settings", label });

export interface DoctorReport {
  as_of: string;
  product_dir: string;
  /** where this install's services run (deployment.yaml) — the shape every remediation below is written for */
  shape: DeploymentShape;
  ok: boolean;
  rows: DoctorRow[];
}

export interface DoctorDeps {
  productDir: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  /** undefined = open a pg pool from METISTRY_DB_*; null = no db configured. */
  db?: Db | null;
  exec?: Exec;
  /** normally read from deployment.yaml (seed + instance overlay); injected by tests and by `up` */
  deployment?: Deployment;
  /** this instance's label suffix + port block (`<instance>/state/ports.yaml`); read from METISTRY_INSTANCE_DIR unless given. null = "there is none", so a test never touches the filesystem */
  namespace?: Namespace | null;
  platform?: NodeJS.Platform;
  uid?: number;
  timeoutMs?: number;
  /** test seam: the Keychain presence probe the shared-scope row asks (default: `security` without -w, on darwin) — never a value */
  keychainProbe?: (service: string, account: string) => Promise<boolean>;
  /** test seam: the Keychain a connection's check fills a command's granted secrets from (default: the login Keychain, on darwin) */
  keychain?: KeychainBackend;
}

// ---- manifests ------------------------------------------------------------

/** Where component directories live in a checkout (plan §4.16). */
export const MANIFEST_ROOTS = ["collectors", "routines", "packages", "apps", "targets"] as const;

export interface FoundManifest {
  /** checkout-relative directory, e.g. `packages/mcp-eventkit` */
  dir: string;
  result: ReturnType<typeof validateManifest>;
  /** manifest `name`/`type` as written, even when invalid (for the row label) */
  name: string;
  type: string;
}

export async function walkManifests(productDir: string): Promise<FoundManifest[]> {
  const out: FoundManifest[] = [];
  for (const root of MANIFEST_ROOTS) {
    const abs = join(productDir, root);
    if (!existsSync(abs)) continue;
    for (const entry of (await readdir(abs, { withFileTypes: true })).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(abs, entry.name, "manifest.yaml");
      if (!existsSync(file)) continue;
      let raw: unknown;
      try {
        raw = parseYaml(await readFile(file, "utf8"));
      } catch (err) {
        out.push({ dir: `${root}/${entry.name}`, name: entry.name, type: "?", result: { ok: false, errors: [`not YAML: ${err instanceof Error ? err.message : String(err)}`] } });
        continue;
      }
      const r = raw as { name?: unknown; type?: unknown } | null;
      const result = validateManifest(raw);
      // packages/mcp-<name> and the rest: the directory is named for the component (targets: must equal)
      if (result.ok && root === "targets" && result.manifest.name !== entry.name) {
        out.push({ dir: `${root}/${entry.name}`, name: result.manifest.name, type: result.manifest.type, result: { ok: false, errors: [`directory ${entry.name} must equal manifest name ${result.manifest.name} (docs/ops/targets.md)`] } });
        continue;
      }
      out.push({ dir: `${root}/${entry.name}`, name: String(r?.name ?? entry.name), type: String(r?.type ?? "?"), result });
    }
  }
  return out;
}

// ---- registries (plan §2.7) ----------------------------------------------------

/**
 * One row for every registry kind: how many units each holds, which of the
 * owner's extensions replace a product unit (D4 — "doctor says so"), and
 * every unit a registry skipped, with why. The same `loadKind` the console
 * and the CLI load through, over the product checkout and — when this install
 * names its instance — the instance's `.metistry/extensions/` and legacy
 * `.metistry/targets/`. A skip is `degraded`, never `failed`: the product
 * runs without the unit, and the row says what to fix.
 */
export async function registriesRow(productDir: string, env: NodeJS.ProcessEnv): Promise<DoctorRow> {
  const instanceDir = env.METISTRY_INSTANCE_DIR?.trim().replace(/\/+$/, "") || undefined;
  const seedDir = env.METISTRY_SEED_DIR?.trim() || join(productDir, "seed");
  let action: DoctorAction | undefined;
  const result = {
    kind: "registry",
    ...(await runCheck("registries", `every registry kind loads (${Object.keys(REGISTRY_KINDS).join(", ")})${instanceDir ? "" : "; no METISTRY_INSTANCE_DIR, so product units only"}`, async () => {
      const units: Record<string, number> = {};
      const overlays: string[] = [];
      const skipped: Array<{ kind: string; name?: string; path: string; reason: string }> = [];
      for (const kind of Object.keys(REGISTRY_KINDS) as RegistryKindName[]) {
        const reg = await loadKind(kind, {
          productDir,
          seedDir,
          ...(instanceDir ? { extensionsDir: extensionsDirFor(instanceDir) } : {}),
          ...(instanceDir && kind === "target" ? { overlays: [resolveInstanceLayout(instanceDir).path("targetsDir")] } : {}),
        });
        units[kind] = reg.names().length;
        for (const u of reg.overlaid()) overlays.push(`${kind} ${u.name}: ${u.path} replaces ${u.replaced?.path}`);
        for (const sk of reg.skipped) skipped.push({ kind, ...(sk.name ? { name: sk.name } : {}), path: sk.path, reason: sk.reason });
      }
      const meta = { units, overlays, skipped };
      if (skipped.length > 0) {
        action = runVerb(["metistry", "extensions", "list"], "List extensions");
        return {
          status: "degraded" as const,
          remediation: `${skipped.length} unit(s) not loaded — ${skipped.slice(0, 3).map((x) => `${x.path}: ${x.reason}`).join("; ")}${skipped.length > 3 ? "; …" : ""} (\`metistry extensions list\`, docs/ops/extensions.md)`,
          meta,
        };
      }
      return overlays.length > 0 ? { remediation: `extensions replace ${overlays.length} product unit(s): ${overlays.join("; ")} — \`metistry extensions remove <name>\` restores one (Reset to Default)`, meta } : { meta };
    })),
  };
  return action ? { ...result, action } : result;
}

// ---- network probes (the same URL/token env conventions the watchdog and console use) ----

interface ProbeTarget {
  urlVar: string;
  tokenVar: string;
  /** the service whose launchd job serves this. The LABEL is derived from it, so a namespaced install's remediation names the job that actually exists. */
  launchdService?: string;
}

const KNOWN_TARGETS: Record<string, ProbeTarget> = {
  "apple-fm": { urlVar: "METISTRY_AFM_URL", tokenVar: "METISTRY_BRIDGE_TOKEN_APPLE_FM", launchdService: "apple-fm" },
  eventkit: { urlVar: "METISTRY_EK_URL", tokenVar: "METISTRY_BRIDGE_TOKEN_EVENTKIT", launchdService: "eventkit" },
  reconciler: { urlVar: "METISTRY_RECONCILER_URL", tokenVar: "METISTRY_BRIDGE_TOKEN_RECONCILER", launchdService: "reconciler" },
};

/** A component with no dedicated variable pair follows the convention: METISTRY_<NAME>_URL / METISTRY_BRIDGE_TOKEN_<NAME>. */
export function probeTargetFor(name: string): ProbeTarget {
  const upper = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return KNOWN_TARGETS[name] ?? { urlVar: `METISTRY_${upper}_URL`, tokenVar: `METISTRY_BRIDGE_TOKEN_${upper}` };
}

/**
 * The env is written for whichever process will use it — the console
 * container under the compose shape, a host job under launchd. Doctor
 * always probes from the host, so it asks core's one resolver rather than
 * knowing the rewrite itself (every shape resolves URLs from one function).
 */
export function hostLocal(url: string, shape: DeploymentShape = "compose"): string {
  return resolveUrl(url, { shape, vantage: "host" });
}

/** How an operator restarts a service, in the shape it actually runs in — under the label this instance's jobs actually carry. */
export function restartHint(service: string, shape: DeploymentShape, labelSuffix?: string | undefined): string {
  if (shape !== "launchd") return `docker compose up -d ${service}`;
  // under the launchd shape most services are the supervisor's children, and
  // launchd does not know they exist — `metistry restart` asks the supervisor
  return (SUPERVISED_SERVICES as readonly string[]).includes(service)
    ? `metistry restart ${service}`
    : `launchctl kickstart -k gui/$(id -u)/${labelFor(service, labelSuffix)}`;
}

/** Where its log is, in the shape it actually runs in. */
export function logHint(service: string, shape: DeploymentShape, labelSuffix?: string | undefined): string {
  return shape === "launchd" ? logPathFor(service, labelSuffix) : `docker compose logs ${service}`;
}

type Outcome = Pick<CheckResult, "status" | "remediation" | "meta">;

/**
 * Why a probe came back the way it did — read by `actionForBridgeOutcome`
 * below to pick the button, never by parsing the human `remediation`
 * sentence (that stays free text; a fifth reason is simply "no action").
 */
type ProbeCause = "unreachable" | "token_rejected" | "bad_body" | "bridge_reported";

/** GET <url>/check with the bearer; the bridge's own status and remediation ride through (watchdog bridges.ts, same split: down vs degraded). */
async function probeCheck(name: string, url: string, token: string | undefined, restart: string, fetchFn: typeof fetch, timeoutMs: number): Promise<Outcome & { cause?: ProbeCause }> {
  let res: Response;
  try {
    res = await fetchFn(`${url}/check`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { status: "failed", remediation: `${name} down at ${url} (${why}) — ${restart}`, cause: "unreachable" };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: "failed", remediation: `${name} rejected the token (HTTP ${res.status}) — the METISTRY_BRIDGE_TOKEN_* in .env differs from the one the bridge was started with`, cause: "token_rejected" };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const parsed = checkResultSchema.safeParse(body);
  if (!parsed.success) return { status: "failed", remediation: `${name} answered HTTP ${res.status} without a check() body at ${url} — wrong port, or a bridge mid-crash; ${restart}`, cause: "bad_body" };
  const r = parsed.data;
  const meta = { probe: r.probe, ...(r.meta ? { bridge_meta: r.meta } : {}) };
  if (r.status === "ok") return { status: "ok", meta };
  return { status: r.status, ...(r.remediation ? { remediation: r.remediation } : { remediation: r.probe }), meta, cause: "bridge_reported" };
}

/**
 * `cause` — set by doctor itself two lines above each of `probeCheck`'s
 * returns — decides "wrong token" vs "everything else"; that much is never a
 * guess. The one exception is `bridge_reported`: a TCC bridge's OWN
 * `check()` names the System Settings pane in its `remediation` because
 * doctor cannot fix a Calendar grant with any verb at all, and that phrase
 * is the only signal doctor has for it. Every other bridge-reported problem
 * (a stale calendar, a rate limit) gets no action — the bridge's remediation
 * text is still the whole story, read in the terminal or the app alike.
 */
function actionForBridgeOutcome(o: Outcome & { cause?: ProbeCause }, tokenVar: string): DoctorAction | undefined {
  switch (o.cause) {
    case "token_rejected":
      return openSecrets(`Fix ${tokenVar} in Secrets`);
    case "bridge_reported":
      return /system settings/i.test(o.remediation ?? "") ? openSystemSettings("Open System Settings") : undefined;
    default:
      return undefined;
  }
}

/** One component row: manifest validity first; then the network probe for anything that declares an http surface. */
async function componentRow(
  m: FoundManifest,
  deps: Required<Pick<DoctorDeps, "env" | "fetchFn" | "timeoutMs">> & { shape: DeploymentShape; labelSuffix?: string | undefined; compute: Compute },
): Promise<DoctorRow> {
  const kind = m.result.ok ? m.result.manifest.type : m.type;
  if (!m.result.ok) {
    return {
      kind,
      ...(await runCheck(m.name, `${m.dir}/manifest.yaml validates`, async () => {
        throw new Error(m.result.ok ? "" : m.result.errors.join("; "));
      })),
    };
  }
  const man: Manifest = m.result.manifest;

  if (man.type === "service" && man.name === "console") {
    const url = hostLocal(deps.env.METISTRY_CONSOLE_URL || `http://127.0.0.1:${man.port ?? 8080}`, deps.shape);
    // With the local owner token in this environment, /api/status is a real
    // AUTHENTICATED read — the same door the Mac app comes through, so this
    // row now proves it works instead of settling for "the 401 shape looks
    // right" (docs/ops/auth.md). Without it, unchanged: 401 is a pass.
    const token = (deps.env.METISTRY_LOCAL_OWNER_TOKEN ?? "").trim();
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const probe = token
      ? `GET ${url}/health ok; /api/status authenticates with METISTRY_LOCAL_OWNER_TOKEN`
      : `GET ${url}/health ok; /api/status answers (401 = a passkey session is required)`;
    let action: DoctorAction | undefined;
    const row = {
      kind,
      ...(await runCheck(man.name, probe, async () => {
        const health = await deps.fetchFn(`${url}/health`, { signal: AbortSignal.timeout(deps.timeoutMs) }).catch((err) => {
          throw new Error(`console down at ${url} (${err instanceof Error ? err.message : String(err)}) — ${restartHint("console", deps.shape, deps.labelSuffix)}`);
        });
        if (!health.ok) throw new Error(`console /health returned ${health.status} — ${logHint("console", deps.shape, deps.labelSuffix)}`);
        const status = await deps.fetchFn(`${url}/api/status`, { headers, signal: AbortSignal.timeout(deps.timeoutMs) });
        if (status.status !== 200 && status.status !== 401) throw new Error(`console /api/status returned ${status.status} — ${logHint("console", deps.shape, deps.labelSuffix)}`);
        const meta = { url, api_status: status.status, authenticated: status.status === 200 };
        // A token that is refused is a real finding — a console started
        // before the variable existed, a stale .env, or (under compose)
        // METISTRY_TRUSTED_LOOPBACK_PROXY missing — but the console itself
        // is up and serving, so this degrades rather than fails.
        if (token && status.status === 401) {
          action = runVerb(["metistry", "secrets", "sync", "--to", "env"], "Sync secrets to .env");
          return {
            status: "degraded" as const,
            // Most often a token mismatch: `.env` (and the Keychain) hold a
            // newer value than the one the running console was started with
            // — a sync or a mint rotated it — and the fix is a restart, which
            // makes the console read `.env`'s value. Re-syncing changes nothing.
            remediation: `${url} refused the METISTRY_LOCAL_OWNER_TOKEN in .env (401): the running console holds a different one — restart the console (${restartHint("console", deps.shape, deps.labelSuffix)}) so it reads .env's value; or the request did not reach it from this machine — under compose it needs METISTRY_TRUSTED_LOOPBACK_PROXY (docs/ops/auth.md)`,
            meta,
          };
        }
        return { meta };
      })),
    };
    return action ? { ...row, action } : row;
  }

  if (man.type === "bridge" && man.name === "brain") {
    // mounted at the console's POST /mcp (packages/mcp-brain/manifest.yaml) — no port of its own
    const url = hostLocal(deps.env.METISTRY_CONSOLE_URL || "http://127.0.0.1:8080", deps.shape);
    return {
      kind,
      ...(await runCheck(man.name, `${url}/mcp answers (401 = agent bearer required; served by the console)`, async () => {
        const r = await deps.fetchFn(`${url}/mcp`, { signal: AbortSignal.timeout(deps.timeoutMs) }).catch((err) => {
          throw new Error(`console down at ${url} (${err instanceof Error ? err.message : String(err)}) — ${restartHint("console", deps.shape, deps.labelSuffix)}`);
        });
        if (r.status !== 401 && r.status !== 200) throw new Error(`/mcp returned ${r.status} — ${logHint("console", deps.shape, deps.labelSuffix)}`);
      })),
    };
  }

  // The engine is the one component an install may deliberately run without
  // (docs/ops/assistant-tools.md, "Running without an engine"): with no
  // `assignments.default` — or with one whose provider key is unset — `up`
  // leaves the assistant out of the supervisor's children, so reporting it
  // `ok` would be a lie and `failed` would be wrong. It is the same "not
  // configured, degrades" row a bridge gets, read through the SAME seam `up`
  // reads (core's `engineStatus`), so the two can never disagree.
  if (man.type === "service" && man.name === "assistant") {
    const engine = engineStatus(deps.compute, deps.env);
    if (!engine.ok) {
      return {
        kind,
        ...(await runCheck(man.name, "compute.yaml assigns a default → the supervisor starts the engine", async () => ({
          status: "absent",
          remediation: `${engine.why} — \`${engine.fix}\`; meanwhile the assistant is not started at all: captures, tasks, search and the console run, and fold turns wait (docs/ops/assistant-tools.md)`,
        }))),
      };
    }
  }

  const httpSurface = (man.type === "bridge" && man.transport === "http") || (man.type === "service" && man.port !== undefined);
  if (httpSurface) {
    const t = probeTargetFor(man.name);
    const configured = deps.env[t.urlVar];
    const port = "port" in man ? man.port : undefined;
    if (!configured) {
      return {
        kind,
        action: openSecrets(`Add ${t.tokenVar} in Secrets`),
        ...(await runCheck(man.name, `${t.urlVar} set → GET /check`, async () => ({
          status: "absent",
          remediation: `not configured: set ${t.urlVar}${port ? ` (default ${deps.shape === "launchd" ? `http://127.0.0.1:${port}` : `http://host.docker.internal:${port}`})` : ""} and ${t.tokenVar} in .env — degrades ${"degrades" in man ? man.degrades : "absent"} meanwhile`,
        }))),
      };
    }
    const url = hostLocal(configured, deps.shape);
    const restart = restartHint(t.launchdService ?? man.name, t.launchdService ? "launchd" : deps.shape, deps.labelSuffix);
    let action: DoctorAction | undefined;
    const row = {
      kind,
      ...(await runCheck(man.name, `GET ${url}/check answers status ok`, async () => {
        const outcome = await probeCheck(man.name, url, deps.env[t.tokenVar], restart, deps.fetchFn, deps.timeoutMs);
        action = actionForBridgeOutcome(outcome, t.tokenVar);
        return outcome;
      })),
    };
    return action ? { ...row, action } : row;
  }

  const via =
    man.type === "service"
      ? man.runs_on === "host" || deps.shape === "launchd"
        ? `process state: launchd:${labelFor(man.name, deps.labelSuffix)}`
        : `process state: compose:${man.name}`
      : undefined;
  return { kind, ...(await runCheck(man.name, `${m.dir}/manifest.yaml validates${via ? `; ${via}` : ""}`, async () => {})) };
}

// ---- instance layout --------------------------------------------------------
//
// Two filesystem checks — no manifest, no probe — so an instance sitting on
// an older shape is TOLD, rather than quietly degrading:
//
//   * `layout`: flat (this directory is the Obsidian vault, machinery under
//     `.metistry/`) or legacy (`Knowledge/`, config at the root). The
//     migration verb is a follow-up; the hint names it.
//   * `inbox`: the pre-#156 captures directory, a gitignored
//     `<instance>/inbox/` instead of the vault's `Inbox/`.

const LEGACY_INBOX_GITIGNORE_LINE = /^\/?inbox\/?$/;

/**
 * Which shape this instance directory is in. A legacy instance is `degraded`,
 * never `failed`: it still runs, and the row is where the operator learns
 * the verb that moves it.
 */
export async function layoutRow(instanceDir: string): Promise<DoctorRow> {
  let action: DoctorAction | undefined;
  const row = {
    kind: "instance",
    ...(await runCheck("instance layout", `${instanceDir} is the flat layout — the directory is the Obsidian vault, machinery under ${INSTANCE_LAYOUT.metistryDir}/`, async () => {
      const shape = detectLayout(instanceDir);
      if (shape === "flat") return { meta: { layout: "flat" } };
      if (shape === "unknown") {
        return {
          status: "absent",
          remediation: `${instanceDir} is not an instance directory (no ${INSTANCE_LAYOUT.identity} and no ${LEGACY_VAULT_DIR}/) — \`metistry init <dir>\` stamps one`,
          meta: { layout: "unknown" },
        };
      }
      action = runVerb(["metistry", "migrate-layout", "--dry-run"], "Preview migrate-layout");
      return {
        status: "degraded",
        remediation: `the vault still lives in ${LEGACY_VAULT_DIR}/ and the config files at the instance root — \`metistry migrate-layout --dry-run\` prints the whole plan, \`metistry migrate-layout\` runs it (docs/ops/instance-layout.md)`,
        meta: { layout: "legacy" },
      };
    })),
  };
  return action ? { ...row, action } : row;
}

/**
 * `standup_days` / `standup_time` still in `Me/profile.md` — one INFO line,
 * never a finding (§2.5, §4 Q13). When the standup runs is the Standup
 * routine's now: the console read the lines once into its schedule and
 * asked, in Needs You, whether to tidy them away. Declined, or not yet
 * answered, they are ignored — and this is where the owner learns that.
 * Null (no row at all) when the profile has neither key or cannot be read.
 */
export async function profileRow(instanceDir: string): Promise<DoctorRow | null> {
  let text: string;
  try {
    text = await readFile(join(instanceDir, PROFILE_PATH), "utf8");
  } catch {
    return null;
  }
  const keys = readStandupKeys(text);
  if (keys.state === "none") return null;
  const named = keys.keys.join(", ");
  const info =
    keys.state === "unreadable"
      ? `${PROFILE_PATH} still has ${named}, which cannot be read (${keys.why}) — nothing uses ${keys.keys.length === 1 ? "it" : "them"}: when the standup runs is set on the Standup routine, under Scheduled. Delete ${keys.keys.length === 1 ? "the line" : "the lines"} when you like.`
      : `${PROFILE_PATH} still has ${named} — ignored: when the standup runs lives on the Standup routine now, under Scheduled. Approve *Tidy ${PROFILE_PATH}* in Needs You, or delete ${keys.keys.length === 1 ? "the line" : "the lines"} yourself.`;
  return {
    kind: "instance",
    ...(await runCheck("profile", `${PROFILE_PATH} holds facts about you, not when a routine runs (no standup_days, standup_time)`, async () => ({ meta: { info, ignored: [...keys.keys] } }))),
  };
}

export async function inboxRow(instanceDir: string): Promise<DoctorRow> {
  let action: DoctorAction | undefined;
  const row = {
    kind: "instance",
    ...(await runCheck("inbox", `${instanceDir}/inbox/ absent, and .gitignore does not list it — captures live at ${INSTANCE_LAYOUT.inboxDir}/`, async () => {
      // Exact-case only: on case-insensitive APFS, `existsSync(join(instanceDir, "inbox"))`
      // also answers true for the vault's TitleCase `Inbox/`, so every fresh macOS
      // instance would read as the pre-#156 layout. `actualName` reads the directory
      // and compares entries with `===`, which reports what is actually on disk.
      const legacyDir = join(instanceDir, "inbox");
      const isLegacy = (await actualName(instanceDir, "inbox")) === "inbox";
      const entries = isLegacy ? (await readdir(legacyDir)).filter((e) => e !== ".DS_Store") : [];
      const gitignorePath = join(instanceDir, ".gitignore");
      const gitignored = existsSync(gitignorePath) && (await readFile(gitignorePath, "utf8")).split("\n").some((l) => LEGACY_INBOX_GITIGNORE_LINE.test(l.trim()));
      if (entries.length === 0 && !gitignored) return;
      action = runVerb(["metistry", "migrate-inbox", "--dry-run"], "Preview migrate-inbox");
      return {
        status: "degraded",
        remediation: "the pre-#156 layout: run `metistry migrate-inbox --dry-run` to see the plan, then `metistry migrate-inbox` to move captures into the vault inbox (docs/ops/inbox.md)",
        meta: { dir: legacyDir, entries: entries.length, gitignored },
      };
    })),
  };
  return action ? { ...row, action } : row;
}

// ---- the retired shared scope (plan §2.14, T4-3) --------------------------------
//
// One row, and only for an instance with an id on a Mac: whether a
// third-party credential this instance uses is still only under the per-user
// account (run migrate-scope), or copied with the shared original left
// behind (purge-shared). Presence probes only — never a value, never a
// prompt — and never `failed`: an unmigrated instance runs exactly as before.

export async function sharedScopeRow(o: { instanceDir: string; productDir: string; env: NodeJS.ProcessEnv; probe: (service: string, account: string) => Promise<boolean> }): Promise<DoctorRow | undefined> {
  const instanceId = await readInstanceId(o.instanceDir).catch(() => undefined);
  if (!instanceId) return undefined;
  const envFile = envPaths({ instanceDir: o.instanceDir, productDir: o.productDir })?.read[0];
  let action: DoctorAction | undefined;
  const row = {
    kind: "instance",
    ...(await runCheck("shared scope", "no third-party credential left in the retired per-user Keychain account", async () => {
      let status;
      try {
        status = await sharedScopeStatus({ instanceDir: o.instanceDir, instanceId, envFile, exampleFile: join(o.productDir, ".env.example"), env: o.env, probe: o.probe });
      } catch (err) {
        return { status: "degraded", remediation: `could not ask the Keychain (${err instanceof Error ? err.message : String(err)}) — \`${MIGRATE_SCOPE_COMMAND} --instance ${o.instanceDir}\` says what is left` };
      }
      if (!status || status.originals.length === 0) return;
      if (status.unmigrated.length > 0) {
        action = runVerb(MIGRATE_SCOPE_COMMAND.split(" "), "Run secrets migrate-scope");
        return {
          status: "degraded",
          remediation: `${status.unmigrated.join(", ")} still only in the retired shared scope — this instance reads them from .env until you run \`${MIGRATE_SCOPE_COMMAND} --instance ${o.instanceDir}\` (it copies them in and deletes nothing; \`metistry update\` runs it too)`,
          meta: { unmigrated: status.unmigrated, originals: status.originals },
        };
      }
      action = runVerb(["metistry", "secrets", "purge-shared"], "Preview secrets purge-shared");
      return {
        status: "degraded",
        remediation: `copied into this instance; the shared originals of ${status.originals.join(", ")} remain — \`metistry secrets purge-shared\` previews removing each one every instance on this Mac has copied`,
        meta: { unmigrated: [], originals: status.originals },
      };
    })),
  };
  return action ? { ...row, action } : row;
}

// ---- the cli shim -----------------------------------------------------------
//
// `metistry up`/`metistry update` write a shim onto this install's own node
// and CLI (cli-shim.ts), but never put it on PATH themselves (invariant 2 —
// that is the user's own hand). This row says whether typing `metistry`
// would actually find it — searching the same places a shell's PATH
// realistically does, plus `~/.local/bin` and the shim's own directory —
// and hands back the exact line to make it so when it would not. Absent,
// never degraded: an install nobody has linked yet is not broken, it is one
// command away.

const CLI_ON_PATH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

export async function cliRow(productDir: string, env: NodeJS.ProcessEnv): Promise<DoctorRow> {
  const instanceDir = env.METISTRY_INSTANCE_DIR?.replace(/\/+$/, "");
  const shim = cliShimPath(productDir, instanceDir);
  const dirs = [...(env.PATH ?? "").split(":").filter(Boolean), ...(env.HOME ? [join(env.HOME, ".local", "bin")] : []), ...CLI_ON_PATH_DIRS];
  const found = dirs.map((d) => join(d, "metistry")).find((p) => existsSync(p));
  let action: DoctorAction | undefined;
  const row = {
    kind: "cli",
    ...(await runCheck(
      "cli on PATH",
      found ? `${found} resolves \`metistry\`` : `search PATH, ~/.local/bin and ${dirname(shim)} for a \`metistry\` executable`,
      async () => {
        if (found) return { meta: { path: found } };
        if (existsSync(shim)) {
          // argv, not the `~`-shorthand `cliShimLinkHint` prints for a
          // terminal — `ln` never sees a shell to expand it for
          if (env.HOME) action = runVerb(["ln", "-s", shim, join(env.HOME, ".local", "bin", "metistry")], "Link metistry onto PATH");
          return { status: "absent", remediation: cliShimLinkHint(shim) + "  (or add its directory to PATH)", meta: { shim } };
        }
        action = runVerb(["metistry", "up"], "Run metistry up");
        return { status: "absent", remediation: `no cli shim yet at ${shim} — \`metistry up\` writes one`, meta: { shim } };
      },
    )),
  };
  return action ? { ...row, action } : row;
}

// ---- db -------------------------------------------------------------------

export async function openDbFromEnv(env: NodeJS.ProcessEnv): Promise<Db | null> {
  if (!env.METISTRY_DB_PASSWORD) return null;
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    host: env.METISTRY_DB_HOST || "127.0.0.1",
    port: Number.parseInt(env.METISTRY_DB_PORT || "5432", 10),
    database: env.METISTRY_DB_NAME || "metistry",
    user: env.METISTRY_DB_USER || "metistry",
    password: env.METISTRY_DB_PASSWORD,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  return { query: (t, v) => pool.query(t, v as any[]), end: () => pool.end() };
}

export async function dbRows(db: Db | null, productDir: string, shape: DeploymentShape = "compose", labelSuffix?: string | undefined): Promise<DoctorRow[]> {
  const migrationsDir = join(productDir, "db", "migrations");
  const files = existsSync(migrationsDir) ? (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort() : [];

  if (!db) {
    return [
      { kind: "db", action: openSecrets("Add METISTRY_DB_PASSWORD in Secrets"), ...(await runCheck("db", "SELECT 1 round-trip", async () => ({ status: "absent", remediation: "METISTRY_DB_PASSWORD is unset — copy .env.example to .env and fill in METISTRY_DB_*" }))) },
      { kind: "db", ...(await runCheck("migrations", `schema_migrations rows = ${files.length} files in db/migrations`, async () => ({ status: "absent", remediation: "not checked — no db configured" }))) },
    ];
  }

  let reachable = true;
  const dbRow: DoctorRow = {
    kind: "db",
    ...(await runCheck("db", "SELECT 1 round-trip", async () => {
      try {
        await db.query("SELECT 1");
      } catch (err) {
        reachable = false;
        throw new Error(`${err instanceof Error ? err.message : String(err)} — ${restartHint("db", shape, labelSuffix)}; check METISTRY_DB_* in .env${shape === "launchd" ? ` (log: ${logPathFor("db", labelSuffix)})` : ""}`);
      }
    })),
  };

  let migAction: DoctorAction | undefined;
  const migRow: DoctorRow = {
    kind: "db",
    ...(await runCheck("migrations", `schema_migrations rows = ${files.length} files in db/migrations`, async () => {
      if (!reachable) return { status: "absent", remediation: "not checked — db unreachable" };
      const exists = await db.query("SELECT to_regclass('public.schema_migrations') AS t");
      if (!exists.rows[0]?.t) {
        migAction = runVerb(["metistry", "update"], "Run metistry update");
        return { status: "degraded", remediation: `no schema_migrations table — run pnpm db:migrate (${files.length} migrations pending)`, meta: { applied: 0, files: files.length } };
      }
      const { rows } = await db.query("SELECT filename FROM schema_migrations ORDER BY filename");
      const applied = rows.map((r) => String(r.filename));
      const pending = files.filter((f) => !applied.includes(f));
      const unknown = applied.filter((f) => !files.includes(f));
      const meta = { applied: applied.length, files: files.length, pending, unknown };
      if (pending.length > 0) {
        migAction = runVerb(["metistry", "update"], "Run metistry update");
        return { status: "degraded", remediation: `${pending.length} migration(s) not applied (${pending.join(", ")}) — run pnpm db:migrate`, meta };
      }
      if (unknown.length > 0) return { status: "degraded", remediation: `db has migration(s) this checkout lacks (${unknown.join(", ")}) — is the checkout older than the database?`, meta };
      return { meta };
    })),
  };
  return [dbRow, migAction ? { ...migRow, action: migAction } : migRow];
}

// ---- schedules -------------------------------------------------------------
//
// The gap the Hermes review named (docs/research/2026-09-12-hermes-agent-review-2.md
// §2): a collector whose token expired failed every hour forever, contributed
// one number to a tile, and nothing said "this has failed 168 times". These
// rows are that sentence. Generic over manifests as the rest of doctor is —
// the component list comes from `walkManifests`, the history from `runs`, and
// nothing here imports the collectors package or knows what any of them do.

/** Overdue at more than this many intervals with no run (Hermes ADOPT 3). */
export const OVERDUE_FACTOR = 2;

function humanSec(sec: number): string {
  if (sec >= 86400 && sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec >= 60) return `${Math.round(sec / 60)}m`;
  return `${Math.max(0, Math.round(sec))}s`;
}

interface LastRun {
  ts: Date;
  ok: boolean | null;
  error: string | null;
  /** the runner could not place the schedule (`no_working_days`, `no_timezone`, `unknown_timezone` — docs/ops/scheduled.md) and said why */
  refused: { reason: string; why: string } | null;
  /** the routine recorded `skipped:template_missing` on this run: the vault path of the template it could not find */
  templateMissing: string | null;
}

/** `2026-09-16 07:00 America/New_York` — the wall clock the schedule is read in, or UTC for an `{every}` one. */
export function occurrenceWhen(o: { at: Date; timeZone: string | null }): string {
  const tz = o.timeZone ?? "UTC";
  return `${o.at.toLocaleString("sv-SE", { timeZone: tz }).slice(0, 16)} ${tz}`;
}

/**
 * Does the refusal the runner recorded on a component's last run still hold?
 * The row is history the moment `Me/profile.md` answers it: a `no_working_days`
 * skip, once the profile has `working_days`, is not "not scheduled" any more —
 * it was skipped, and it runs at its next slot. Asked with the same pure
 * functions the runner places a schedule with (core's `resolveDays`,
 * `nextOccurrence`), on the profile as it is NOW. `holds` for any other
 * refusal, and for a schedule that is not a time of day: this only rechecks
 * the one fact it can read.
 */
export function recheckRefusal(
  refused: { reason: string },
  schedule: ManifestSchedule,
  facts: ProfileFacts,
  env: NodeJS.ProcessEnv,
  now: Date,
): { holds: true } | { holds: false; next: Occurrence } {
  if (refused.reason !== "no_working_days" || isLegacyCron(schedule) || isInterval(schedule)) return { holds: true };
  const days = resolveDays(schedule.days, facts.working_days);
  if (days === null || days.length === 0) return { holds: true };
  return { holds: false, next: nextOccurrence(schedule, now, { profile: facts, fallbackTimeZone: configuredTimeZone(env) }) };
}

/**
 * One row per schedulable manifest: when it last ran, whether that run
 * succeeded, its open failure streak, when it is next due, and whether the
 * runner has stopped running it (`skipped_streak`) or never started it
 * (`preflight_failed`). Actionable ⇒ `failed`, so `metistry doctor` exits
 * non-zero on exactly the states a person has to act on.
 */
export async function scheduleRows(
  db: Db | null,
  productDir: string,
  env: NodeJS.ProcessEnv = {},
  now: Date = new Date(),
): Promise<DoctorRow[]> {
  const scheduled = (await walkManifests(productDir)).flatMap((m) => {
    if (!m.result.ok) return [];
    const man = m.result.manifest;
    if (man.type !== "collector" && man.type !== "routine") return [];
    return [
      {
        dir: m.dir,
        name: man.name,
        manifestSchedule: man.schedule,
        schedule: describeSchedule(man.schedule),
        // a time of day is due at a slot, not an interval after the last run:
        // its bound below is the widest gap of its week, and when it is next
        // due depends on Me/profile.md, which the console's runner reads
        timeOfDay: !isLegacyCron(man.schedule) && !isInterval(man.schedule),
        bound: (() => {
          try {
            return longestGapSeconds(man.schedule);
          } catch {
            return 0;
          }
        })(),
        runKind: man.type === "routine" ? "routine_run" : "collector_run",
      },
    ];
  });
  if (scheduled.length === 0) return [];

  if (!db) {
    return [
      {
        kind: "schedule",
        ...(await runCheck("schedules", `${scheduled.length} scheduled component(s) have a recent, successful run`, async () => ({
          status: "absent",
          remediation: "not checked — no db configured (METISTRY_DB_PASSWORD is unset); the runs table is where every schedule's history lives",
          meta: { scheduled: scheduled.length },
        }))),
      },
    ];
  }

  const maxStreak = intEnv("METISTRY_RUNNER_MAX_STREAK", DEFAULT_MAX_STREAK, env);
  const last = new Map<string, LastRun>();
  const markers = new Map<string, { ts: Date; error: string | null }>();
  let streaks: Awaited<ReturnType<typeof failureStreaks>> = [];
  try {
    streaks = await failureStreaks(db);
    const { rows: lastRows } = await db.query(
      `SELECT DISTINCT ON (component, kind) component, kind, ts, ok, error, meta
       FROM runs WHERE kind = ANY($1) ORDER BY component, kind, ts DESC`,
      [[...SCHEDULED_KINDS]],
    );
    for (const r of lastRows) {
      const refused = typeof r.meta?.schedule_refused === "string" ? { reason: String(r.meta.schedule_refused), why: String(r.meta.why ?? r.meta.schedule_refused) } : null;
      const templateMissing = r.meta?.outcome === `skipped:${TEMPLATE_MISSING}` ? (typeof r.meta?.template === "string" && r.meta.template !== "" ? r.meta.template : "its template") : null;
      last.set(`${r.component}/${r.kind}`, { ts: new Date(r.ts), ok: r.ok === null ? null : Boolean(r.ok), error: r.error ?? null, refused, templateMissing });
    }
    const { rows: markerRows } = await db.query(
      `SELECT component, tool, max(ts) AS ts, (array_agg(error ORDER BY ts DESC))[1] AS error
       FROM runs WHERE kind = $1 AND tool = ANY($2) GROUP BY component, tool`,
      [RUNNER_KIND, [SKIPPED_STREAK, PREFLIGHT_FAILED]],
    );
    for (const r of markerRows) markers.set(`${r.component}/${r.tool}`, { ts: new Date(r.ts), error: r.error ?? null });
  } catch (err) {
    // the db answered SELECT 1 but not this: an un-migrated schema, most
    // likely. One honest row beats an exception that takes the whole report
    // with it — the migrations row above is the real finding.
    return [
      {
        kind: "schedule",
        ...(await runCheck("schedules", `${scheduled.length} scheduled component(s) have a recent, successful run`, async () => ({
          status: "degraded",
          remediation: `could not read the runs table (${err instanceof Error ? err.message : String(err)}) — run pnpm db:migrate`,
          meta: { scheduled: scheduled.length },
        }))),
      },
    ];
  }

  // the profile as it is NOW — a refusal recorded before it gained
  // working_days is history, not the current state (recheckRefusal)
  const instanceDir = env.METISTRY_INSTANCE_DIR?.replace(/\/+$/, "") || productDir;
  const facts = profileFacts(await readFile(join(instanceDir, PROFILE_PATH), "utf8").catch(() => null));

  const out: DoctorRow[] = [];
  for (const s of scheduled) {
    const intervalSec = s.bound;
    const lastRun = last.get(`${s.name}/${s.runKind}`);
    const streak = streaks.find((x) => x.component === s.name && x.kind === s.runKind);
    const skipped = markers.get(`${s.name}/${SKIPPED_STREAK}`);
    const blocked = markers.get(`${s.name}/${PREFLIGHT_FAILED}`);
    // a marker only describes the CURRENT state while it is inside its own
    // window plus a tick's grace, and while nothing has run since — an old
    // one, or one a later run has answered, is history, not a finding
    const fresh = (m: { ts: Date } | undefined): boolean =>
      m !== undefined &&
      intervalSec > 0 &&
      now.getTime() - m.ts.getTime() <= intervalSec * OVERDUE_FACTOR * 1000 &&
      (lastRun === undefined || m.ts.getTime() > lastRun.ts.getTime());
    const nextDue = lastRun && intervalSec > 0 && !s.timeOfDay ? new Date(lastRun.ts.getTime() + intervalSec * 1000) : null;
    const overdueSec = lastRun ? Math.floor((now.getTime() - lastRun.ts.getTime()) / 1000) - intervalSec : null;
    const meta = {
      dir: s.dir,
      schedule: s.schedule,
      interval_sec: intervalSec,
      run_kind: s.runKind,
      last_run_at: lastRun ? lastRun.ts.toISOString() : null,
      last_ok: lastRun ? lastRun.ok : null,
      streak: streak?.count ?? 0,
      error_signature: streak?.signature ?? null,
      next_due_at: nextDue ? nextDue.toISOString() : null,
      overdue_sec: overdueSec !== null && overdueSec > 0 ? overdueSec : 0,
      skipped_streak: fresh(skipped),
      preflight_failed: fresh(blocked),
      schedule_refused: lastRun?.refused?.reason ?? null,
      template_missing: lastRun?.templateMissing ?? null,
    };

    let action: DoctorAction | undefined;
    const viewConsoleLogs = runVerb(["metistry", "logs", "console"], "View console logs");
    const row = {
      kind: "schedule",
      ...(await runCheck(s.name, `${s.schedule} (${s.timeOfDay ? "at most" : "every"} ${humanSec(intervalSec)}${s.timeOfDay ? " apart" : ""}): ran inside ${OVERDUE_FACTOR}× that, last run ok, no open failure streak`, async () => {
        if (fresh(skipped)) {
          action = viewConsoleLogs;
          return {
            status: "failed" as const,
            remediation: `the runner has stopped running ${s.name}: ${meta.streak} failures in a row reached METISTRY_RUNNER_MAX_STREAK (${maxStreak}) — ${skipped?.error ?? "see the runner rows"}; the next successful run clears it, or raise METISTRY_RUNNER_MAX_STREAK, or remove \`schedule\` from ${s.dir}/manifest.yaml`,
            meta,
          };
        }
        if (fresh(blocked)) {
          action = viewConsoleLogs;
          return {
            status: "failed" as const,
            remediation: `${blocked?.error ?? `${s.name} is blocked_config`} (declared in \`requires\` in ${s.dir}/manifest.yaml)`,
            meta,
          };
        }
        if (!lastRun) {
          return {
            status: "absent" as const,
            remediation: `no run recorded yet — the console's runner writes one row per window; check that the console is up and that ${s.dir}/manifest.yaml is registered`,
            meta,
          };
        }
        if (lastRun.refused) {
          // §2.5's absent state: the runner could not place the schedule
          // (no working days, no timezone) and said so on its own row — a
          // fact about Me/profile.md or METISTRY_TZ, never a fault to fix here.
          // Unless the fact has changed since: then the row is history.
          const again = recheckRefusal(lastRun.refused, s.manifestSchedule, facts, env, now);
          if (again.holds) return { status: "absent" as const, remediation: `not scheduled: ${lastRun.refused.why}`, meta };
          if (!again.next.ok) return { status: "absent" as const, remediation: `not scheduled: ${again.next.why}`, meta: { ...meta, schedule_refused_now: again.next.reason } };
          return {
            meta: {
              ...meta,
              next_due_at: again.next.at.toISOString(),
              schedule_refused_now: null,
              info: `was skipped at ${lastRun.ts.toISOString().slice(0, 16)}Z (${lastRun.refused.reason}) — ${PROFILE_PATH} has working_days now, so it is scheduled again: nothing to do until the next run at ${occurrenceWhen(again.next)}`,
            },
          };
        }
        if (intervalSec > 0 && now.getTime() - lastRun.ts.getTime() > intervalSec * OVERDUE_FACTOR * 1000) {
          action = viewConsoleLogs;
          return {
            status: "failed" as const,
            remediation: `${s.name} last ran ${humanSec(Math.floor((now.getTime() - lastRun.ts.getTime()) / 1000))} ago, over ${OVERDUE_FACTOR}× its "${s.schedule}" interval — the console's runner is not running it: metistry logs console`,
            meta,
          };
        }
        if ((streak?.count ?? 0) > 0) {
          action = viewConsoleLogs;
          return {
            status: "degraded" as const,
            remediation: `${streak?.count} failed run(s) in a row since ${streak?.since.toISOString()}: ${streak?.lastError ?? "(no error text)"} — at METISTRY_RUNNER_MAX_STREAK (${maxStreak}) the runner stops running it`,
            meta,
          };
        }
        if (lastRun.templateMissing !== null) {
          // The run "succeeded" and did nothing: a routine whose template is
          // not in the vault skips every time it runs, and the row read ok
          // while it did (W2 checkpoint D1 — an upgraded vault never got
          // Templates/Brief.md). Degraded, not failed: the owner may have
          // removed it on purpose, and nothing else is broken.
          action = runVerb(["metistry", "update"], "Run metistry update");
          return {
            status: "degraded" as const,
            remediation: `${s.name} skipped its last run (${lastRun.ts.toISOString().slice(0, 16)}Z, ${TEMPLATE_MISSING}): ${lastRun.templateMissing} is not in the vault — \`metistry update\` re-seeds missing templates (only files the vault lacks; yours are never touched), or write your own ${lastRun.templateMissing}`,
            meta,
          };
        }
        return { meta };
      })),
    };
    out.push(action ? { ...row, action } : row);
  }
  return out;
}

// ---- the vault's git sync (§2.21, T10-2) -----------------------------------------

export const VAULT_SYNC_KIND = "vault";

/** One status in words: the probe line, and what an ok row is read for in `--json`. */
export function vaultSyncSummary(v: VaultStatus): string {
  const counts = v.remote === null ? "no remote" : `${v.ahead ?? "?"} ahead, ${v.behind ?? "?"} behind ${v.remote}`;
  const push = v.last_push ? `last push ${v.last_push.at} ${v.last_push.ok ? "ok" : "FAILED"}` : "never pushed";
  const conflict = v.conflict ? `conflict in ${v.conflict.paths.length} path(s)` : "no conflict";
  return `${counts}; ${push}; ${conflict}; ${describeVaultSync(v.policy)}`;
}

/**
 * The vault's sync, as the reconciler reports it (`GET /vault/status`):
 * ahead, behind, last push, conflict and the policy in force. Never `failed`
 * — commits are safe locally whatever the remote does, and the reconciler's
 * own row already fails when the reconciler is down.
 */
export async function vaultSyncRow(deps: { env: NodeJS.ProcessEnv; shape: DeploymentShape; fetchFn: typeof fetch; timeoutMs: number }): Promise<DoctorRow> {
  const url = deps.env.METISTRY_RECONCILER_URL?.trim();
  const token = deps.env.METISTRY_BRIDGE_TOKEN_RECONCILER?.trim();
  const base = url ? hostLocal(url, deps.shape) : undefined;
  return {
    kind: VAULT_SYNC_KIND,
    ...(await runCheck("vault sync", base ? `GET ${base}/vault/status: ahead, behind, last push, conflict, policy` : "the reconciler's GET /vault/status", async () => {
      if (!base || !token) {
        return { status: "absent" as const, remediation: "no reconciler bridge configured (METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER) — the vault's sync status comes from it" };
      }
      let res: Response;
      try {
        res = await deps.fetchFn(`${base}/vault/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(deps.timeoutMs) });
      } catch {
        return { status: "absent" as const, remediation: "the reconciler did not answer — its own row above says why" };
      }
      if (res.status === 404) return { status: "degraded" as const, remediation: "this reconciler predates GET /vault/status — `metistry restart reconciler` after an update" };
      if (!res.ok) return { status: "absent" as const, remediation: `the reconciler answered HTTP ${res.status} for /vault/status — its own row above says why` };
      const parsed = vaultStatusSchema.safeParse(await res.json().catch(() => undefined));
      if (!parsed.success) return { status: "degraded" as const, remediation: "the reconciler's /vault/status did not match the status schema — a reconciler and CLI from different releases; `metistry update`" };
      const v = parsed.data;
      const meta = { ...v, summary: vaultSyncSummary(v) };
      if (v.conflict) {
        const shown = v.conflict.paths.slice(0, 3).join(", ") + (v.conflict.paths.length > 3 ? ", …" : "");
        return { status: "degraded" as const, remediation: `conflict: a pull could not integrate ${shown} — resolve it in Obsidian or a terminal; commits keep landing locally and pushing waits until the next clean pull (docs/ops/reconciler.md)`, meta };
      }
      if (v.remote === null) return { status: "absent" as const, remediation: "no remote — commits stay on this Mac. `metistry connect-repo <url>` gives the vault a private remote (docs/ops/cli.md)", meta };
      if (v.last_push && !v.last_push.ok) {
        return { status: "degraded" as const, remediation: `last push failed (${v.last_push.error ?? "no detail"}) — ${v.ahead ?? "some"} commit(s) wait, safe locally; check the remote and its credentials`, meta };
      }
      if (v.last_pull && !v.last_pull.ok) return { status: "degraded" as const, remediation: `last pull failed (${v.last_pull.error ?? "no detail"}) — check the remote and its credentials`, meta };
      if (v.policy.error) return { status: "degraded" as const, remediation: `deployment.yaml's vault: block does not validate, so the last good policy is running (${v.policy.error}) — fix it with \`metistry vault settings\``, meta };
      if (v.policy.push_override !== undefined) return { status: "degraded" as const, remediation: pushOverrideNote(v.policy.push_override), meta };
      return { meta };
    })),
  };
}

// ---- keeping the Mac awake (macOS) --------------------------------------------

/**
 * Every pid holding `PreventUserIdleSystemSleep`, from the "Listed by owning
 * process" block of `pmset -g assertions`.
 *
 * NOT the summary block above it: that is a LEVEL — "the system-wide level is
 * the maximum of all individual assertions' levels"
 * (`IOPMCopyAssertionsStatus`) — and reads 1 while four processes hold it. And
 * never a NAME match: under `caffeinate` the name is Apple's, on every holder,
 * so the only honest question is whether OUR recorded pid is in this list.
 */
export function assertionHolders(pmsetAssertions: string): number[] {
  const out: number[] = [];
  for (const m of pmsetAssertions.matchAll(/^\s*pid (\d+)\([^)]*\):.*\bPreventUserIdleSystemSleep\b/gm)) out.push(Number(m[1]));
  return [...new Set(out)];
}

/**
 * The lid half (ruling 3, plan §2.15): is the administrator setting in effect?
 * One `pmset -g` — a read, from `PMSET_READS`, like every `pmset` this product
 * runs — and `undefined` when pmset did not answer or said something that is
 * not its settings list, so doctor says "could not tell" rather than "off".
 */
export async function sleepDisabledInEffect(exec: Exec): Promise<boolean | undefined> {
  try {
    const r = await exec("pmset", [...PMSET_READS.settings]);
    return r.code === 0 ? parseSleepDisabled(r.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/** What the row says while the lid half is asked for and not (known to be) in effect: the dialog, as one sentence. */
export function lidClosedRemediation(inEffect: boolean | undefined): string {
  const unknown = inEffect === undefined ? "`pmset -g` did not answer, so whether it is in effect is unknown. " : "";
  // the sentence already names the command; this adds how to undo it and the
  // warning, so the row carries the whole dialog (plan §2.15)
  return `${unknown}${LID_CLOSED_NOT_AVAILABLE} Run \`${LID_CLOSED_COMMAND}\` yourself only if you accept the risk; undo it with \`${LID_CLOSED_UNDO}\`. ${LID_CLOSED_WARNING}`;
}

/**
 * One row, macOS only, never `failed`: the install is running and correct even
 * when a promise about the machine is unmet, and `metistry up` ends with
 * doctor deciding the exit code.
 *
 * The states are the ones docs/ops/deployment-shapes.md documents: off, held,
 * released by policy, configured but absent, the fourth value's honest limit,
 * the compose shape's "nothing holds it", and the owner's ruling E — the Mac
 * slept anyway, with the repair spelled out.
 */
export async function keepAwakeRow(deps: { deployment: Deployment; instanceDir: string; exec: Exec; platform: NodeJS.Platform; now?: () => number }): Promise<DoctorRow | undefined> {
  // invariant 7: `caffeinate` is not a thing off macOS and a container holds
  // no assertions, so there is no row rather than a row that always says no
  if (deps.platform !== "darwin") return undefined;
  const now = deps.now ?? Date.now;
  const setting = keepAwakeSettingOf(deps.deployment);
  const mode = keepAwakeValue(setting);
  const statePath = instanceStatePath(deps.instanceDir, "run", KEEP_AWAKE_STATE_FILENAME);
  // the lid half is the administrator's setting, not ours: read it (never
  // write it), and say it is not in effect until pmset says it is
  const wantsLid = wantsLidClosedAwake(setting);
  const sleepDisabled = wantsLid ? await sleepDisabledInEffect(deps.exec) : undefined;
  const lidNote = wantsLid && sleepDisabled !== true ? lidClosedRemediation(sleepDisabled) : undefined;
  const lidMeta: Record<string, unknown> = wantsLid
    ? { lid_closed: sleepDisabled === true ? "in effect" : sleepDisabled === false ? "not in effect" : "unknown", sleep_lid_closed: false }
    : {};
  // the early-cutoff repair keeps the lid answer: `always` would reset it
  const alwaysVerb = setting.sleep_lid_closed ? "`metistry deployment set-keep-awake always --yes`" : "`metistry deployment set-keep-awake --sleep-on-battery false --yes`";
  const viewSupervisorLogs = runVerb(["metistry", "logs", "supervisor"], "View supervisor logs");
  let action: DoctorAction | undefined;

  const row = {
    kind: KEEP_AWAKE_KIND,
    ...(await runCheck(KEEP_AWAKE_KIND, `deployment.yaml says keep_awake: ${mode}; ${statePath} and pmset -g assertions agree`, async () => {
      // an explicit `never` is the owner's answer, not a missing one: it is
      // configured, and nothing here second-guesses it with a suggestion
      if (mode === "never" && deps.deployment.keep_awake !== undefined) {
        return {
          meta: {
            mode,
            configured: true,
            info: "keep_awake: never — your choice: this Mac may idle-sleep, and the install pauses with it (captures, collectors and the assistant's queue wait until it wakes)",
          },
        };
      }
      if (mode === "never") {
        action = runVerb(["metistry", "deployment", "set-keep-awake", "allow_sleep_on_battery"], "Turn on keep-awake");
        return {
          status: "absent",
          remediation:
            "not configured — this Mac may idle-sleep, and the install pauses with it: captures, collectors and the assistant's queue wait until it wakes. " +
            "`metistry deployment set-keep-awake allow_sleep_on_battery --yes` (held on wall power, released on battery).",
          meta: { mode },
        };
      }
      if (deps.deployment.shape === "compose") {
        return {
          status: "absent",
          remediation: `keep_awake: ${mode}, but the compose shape installs no supervisor, and that is the process whose lifetime the assertion is tied to — nothing is held (docs/ops/deployment-shapes.md)`,
          meta: { mode, shape: "compose", ...lidMeta },
        };
      }

      // every failure here is "there is no usable state file": missing,
      // truncated mid-write, or not JSON. This row must never be `failed`, so
      // the read cannot throw — a corrupt file reports as "nothing is holding"
      const state = await (async () => {
        try {
          return parseKeepAwakeState(JSON.parse(await readFile(statePath, "utf8")));
        } catch {
          return undefined;
        }
      })();
      if (!state) {
        action = runVerb(["metistry", "up"], "Run metistry up");
        return {
          status: "degraded",
          remediation: `keep_awake: ${mode}, but nothing has written ${statePath} — the supervisor is not running, or has not started since the setting changed: \`metistry up\`${lidNote ? `. ${lidNote}` : ""}`,
          meta: { mode, state_file: statePath, ...lidMeta },
        };
      }

      const held = await deps.exec("pmset", [...PMSET_READS.assertions]);
      const holders = held.code === 0 ? assertionHolders(held.stdout) : [];
      const ours = state.pid !== undefined && holders.includes(state.pid);
      const others = holders.filter((p) => p !== state.pid);
      const meta: Record<string, unknown> = {
        mode,
        holding: state.holding,
        ...(state.pid !== undefined ? { pid: state.pid } : {}),
        ...(state.since !== undefined ? { since: state.since } : {}),
        power_source: state.power_source,
        heartbeat_at: state.heartbeat_at,
        restarts: state.restarts,
        reason: state.reason,
        // informational only, and NEVER a finding: several processes holding
        // the same assertion is Apple's designed model, we cannot release
        // another's, and we must never take credit for one
        other_holders: others.length,
        ...lidMeta,
      };

      // the owner's ruling E: it slept anyway. Said first, because it is the
      // one thing on this row a person can act on.
      const cutoff = cutoffIsAFinding(state);
      if (cutoff) {
        // The repair is only offered when there IS one. Under `always` the
        // strongest setting this product has is already in force, and the
        // sleep came from something no assertion stops — offering the verb
        // that sets what is already set would be noise dressed as advice.
        const stronger = cutoff.mode === "allow_sleep_on_battery";
        // "there is nothing further to turn on" (below) means exactly that —
        // no verb belongs on this row when the strongest setting is already
        // in force and slept anyway
        if (stronger) action = runVerb(["metistry", "deployment", "set-keep-awake", "always"], "Hold awake on battery too");
        return {
          status: "degraded",
          remediation:
            `this Mac slept at ${cutoff.at} for about ${humanGap(cutoff.gap_ms)} while keep_awake: ${cutoff.mode} was set — an idle-sleep assertion does not stop lid close, ` +
            `a scheduled sleep, the Apple menu or low battery, and another policy may have won. ` +
            (stronger
              ? `If that is not what you want, ${alwaysVerb} holds on battery too, which costs battery on a laptop${wantsLid ? "" : "; a closed lid still sleeps"}`
              : `keep_awake: ${cutoff.mode} is already the strongest setting there is, so there is nothing further to turn on: the cause is outside what a power assertion can reach`) +
            `${lidNote ? ` — ${lidNote}` : ""}`,
          meta: { ...meta, last_cutoff: cutoff },
        };
      }

      if (state.stopped_at !== undefined) {
        action = runVerb(["metistry", "up"], "Run metistry up");
        return {
          status: "degraded",
          remediation: `released at ${state.stopped_at} when the supervisor stopped — nothing holds this Mac awake until it is running again: \`metistry up\``,
          meta,
        };
      }

      if (now() - Date.parse(state.heartbeat_at) > state.interval_ms * KEEP_AWAKE_CUTOFF_FACTOR) {
        action = viewSupervisorLogs;
        return {
          status: "degraded",
          remediation:
            `the holder last reported at ${state.heartbeat_at}, more than ${KEEP_AWAKE_CUTOFF_FACTOR} of its ${Math.round(state.interval_ms / 1000)}s cycles ago — ` +
            `either the supervisor is not running (\`metistry logs supervisor\`), or this Mac has just woken and the holder has not ticked yet, in which case the next run of doctor says so`,
          meta,
        };
      }

      if (!state.holding) {
        // released BY POLICY is the setting working, and must read as success
        if (!shouldHold(mode, state.power_source)) return { ...(lidNote ? { status: "degraded" as const, remediation: lidNote } : {}), meta };
        action = viewSupervisorLogs;
        return {
          status: "degraded",
          remediation: `keep_awake: ${mode} and this Mac is drawing from '${powerSourceLabel(state.power_source)}', but nothing is held — \`metistry logs supervisor\``,
          meta,
        };
      }

      if (!ours) {
        action = viewSupervisorLogs;
        return {
          status: "degraded",
          remediation:
            `${statePath} records pid ${state.pid ?? "?"} as the holder, but \`pmset -g assertions\` does not list it holding PreventUserIdleSystemSleep` +
            `${held.code === 0 ? "" : " (pmset did not answer)"} — \`metistry logs supervisor\``,
          meta,
        };
      }
      return { ...(lidNote ? { status: "degraded" as const, remediation: lidNote } : {}), meta };
    })),
  };
  return action ? { ...row, action } : row;
}

// ---- launchd (macOS) ----------------------------------------------------------

/**
 * The jobs THIS shape installs. Under `compose` the db, console and
 * assistant plists exist in the checkout but are not host jobs, so probing
 * them would report every install as broken.
 */
export async function launchdLabels(
  productDir: string,
  shape: DeploymentShape = "compose",
  labelSuffix?: string | undefined,
  env: NodeJS.ProcessEnv = {},
): Promise<{ file: string; label: string; service: string }[]> {
  return (await loadPlistTemplates(productDir, shape, labelSuffix, env)).map((t) => ({ file: t.file, label: t.label, service: t.service }));
}

/** `launchctl print gui/<uid>/<label>` → running | waiting (with last exit code) | not bootstrapped. */
export function parseLaunchctlPrint(text: string): { state: string; pid?: number; lastExit?: number } {
  const state = /^\s*state = (\S+)/m.exec(text)?.[1] ?? "unknown";
  const pid = /^\s*pid = (\d+)/m.exec(text)?.[1];
  const lastExit = /^\s*last exit code = (-?\d+)/m.exec(text)?.[1];
  return { state, ...(pid ? { pid: Number(pid) } : {}), ...(lastExit ? { lastExit: Number(lastExit) } : {}) };
}

/**
 * How long a pid has been running, from `ps -o etimes=` (elapsed seconds —
 * no `HH:MM:SS` to parse, unlike `etime`). Best-effort only: a `ps` that
 * fails or a pid `ps` no longer knows about (it exited between `launchctl
 * print` and here) reports `undefined` rather than failing the row — this is
 * an add-on fact for the Services pane, never the thing a status turns on.
 */
export async function processUptimeSec(exec: Exec, pid: number): Promise<number | undefined> {
  try {
    const r = await exec("ps", ["-o", "etimes=", "-p", String(pid)]);
    if (r.code !== 0) return undefined;
    const n = Number.parseInt(r.stdout.trim(), 10);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

export async function launchdRows(
  productDir: string,
  exec: Exec,
  uid: number,
  shape: DeploymentShape = "compose",
  labelSuffix?: string | undefined,
  env: NodeJS.ProcessEnv = {},
): Promise<DoctorRow[]> {
  const shaped = new Set<string>([...SHAPED_SERVICES, SUPERVISOR_SERVICE]);
  // one `launchctl print` per label, all at once: they are independent
  // subprocesses, and asking five of them in series is five process spawns a
  // person waits through at the end of every `up`
  const labels = await launchdLabels(productDir, shape, labelSuffix, env);
  return Promise.all(labels.map(async ({ file, label, service }): Promise<DoctorRow> => {
    // The one background item has two possible registrars, and which one owns
    // it decides who may start and stop it (docs/ops/deployment-shapes.md,
    // "Two registrars"). Reported on the supervisor's row only: the TCC
    // helpers are never the app's.
    let found: RegistrarFinding | undefined;
    let action: DoctorAction | undefined;
    const row: DoctorRow = {
      kind: "launchd",
      ...(await runCheck(`launchd:${label}`, `launchctl print gui/${uid}/${label} reports state = running`, async () => {
        const r = await exec("launchctl", ["print", `gui/${uid}/${label}`]);
        if (r.code === 127) return { status: "absent", remediation: "launchctl not found — not macOS?" };
        if (service === SUPERVISOR_SERVICE) found = parseRegistrar(r.code, r.stdout);
        if (r.code !== 0) {
          action = runVerb(["metistry", "up"], "Run metistry up");
          return {
            status: "absent",
            // the shaped jobs carry an EnvironmentVariables dict rendered
            // from .env, so the by-hand sed recipe cannot produce them
            remediation: shaped.has(service)
              ? `not bootstrapped — metistry up (this shape's ${file} is rendered with values only \`up\` computes; docs/ops/deployment-shapes.md)`
              : `not bootstrapped — metistry up, or by hand: sed "s|__REPO__|$PWD|g; s|__NODE__|$(which node)|g" ops/launchd/${file} > ~/Library/LaunchAgents/${file} && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${file}`,
          };
        }
        const p = parseLaunchctlPrint(r.stdout);
        if (p.state === "running") {
          const uptimeSec = p.pid !== undefined ? await processUptimeSec(exec, p.pid) : undefined;
          return { meta: { pid: p.pid, uptime_sec: uptimeSec } };
        }
        return {
          status: "failed",
          remediation: `state = ${p.state}${p.lastExit !== undefined ? `, last exit code ${p.lastExit}` : ""} — launchctl kickstart -k gui/$(id -u)/${label}; log: ${logPathFor(service, labelSuffix)}`,
          meta: { state: p.state, last_exit: p.lastExit },
        };
      })),
    };
    if (action) row.action = action;
    if (found && found.registrar !== "none") {
      // the probe is what the table prints for a row that is not ok, and what
      // the Mac app's Services pane prints for one that is (docs/ops/mac-app.md)
      row.probe += `; registered by ${registrarPhrase(found)}`;
      row.meta = { ...row.meta, registrar: found.registrar, ...(found.path ? { registered_from: found.path } : {}) };
    }
    return row;
  }));
}

// ---- docker compose --------------------------------------------------------------

interface ComposeEntry {
  Service?: string;
  State?: string;
  Health?: string;
  Status?: string;
  Name?: string;
}

/** `docker compose ps --format json` is an array on older compose, NDJSON (one object per line) on newer. */
export function parseComposePs(text: string): ComposeEntry[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  try {
    const whole = JSON.parse(trimmed);
    return Array.isArray(whole) ? whole : [whole];
  } catch {
    return trimmed
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ComposeEntry);
  }
}

const COMPOSE_UPTIME_UNIT_SECONDS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 604800,
  month: 2592000,
  year: 31536000,
};

/**
 * `docker compose ps`'s `Status` column (`go-units.HumanDuration`, e.g. "Up
 * 3 hours", "Up About a minute", "Up 51 seconds (healthy)") parsed back into
 * seconds. Best-effort, like `processUptimeSec`: an unrecognised phrasing —
 * a future compose version, a non-English locale — reports `undefined`
 * rather than guessing.
 */
export function parseComposeUptimeSec(status: string | undefined): number | undefined {
  if (!status) return undefined;
  const m = /^Up\s+(?:About\s+)?(a|an|\d+)?\s*([a-zA-Z]+?)s?(?:\s|$)/.exec(status.trim());
  if (!m) return undefined;
  const unit = COMPOSE_UPTIME_UNIT_SECONDS[m[2]!.toLowerCase()];
  if (!unit) return undefined;
  const count = m[1] === undefined || m[1] === "a" || m[1] === "an" ? 1 : Number.parseInt(m[1], 10);
  return Number.isFinite(count) ? count * unit : undefined;
}

/** The container names docker-compose.yml declares under `services:` — what `up` builds, what doctor probes, what `metistry restart|stop|start` acts on under the compose shape. */
export async function composeServiceNames(productDir: string): Promise<string[]> {
  const composeFile = join(productDir, "docker-compose.yml");
  if (!existsSync(composeFile)) return [];
  return Object.keys(((parseYaml(await readFile(composeFile, "utf8")) as { services?: Record<string, unknown> })?.services ?? {})).sort();
}

export async function composeRows(productDir: string, exec: Exec): Promise<DoctorRow[]> {
  const expected = await composeServiceNames(productDir);
  if (expected.length === 0) return [];

  const r = await exec("docker", ["compose", "ps", "--all", "--format", "json"], { cwd: productDir });
  if (r.code === 127) {
    return [{ kind: "compose", ...(await runCheck("compose", "docker compose ps --format json", async () => ({ status: "absent", remediation: "docker not found on PATH — install Docker (Desktop on macOS) to run the containers" }))) }];
  }
  if (r.code !== 0) {
    return [{ kind: "compose", ...(await runCheck("compose", "docker compose ps --format json", async () => {
      throw new Error(`docker compose ps failed (${r.code}): ${(r.stderr || r.stdout).trim().split("\n")[0]} — is the Docker daemon running?`);
    })) }];
  }
  let entries: ComposeEntry[];
  try {
    entries = parseComposePs(r.stdout);
  } catch (err) {
    return [{ kind: "compose", ...(await runCheck("compose", "docker compose ps --format json parses", async () => {
      throw new Error(`unparseable output: ${err instanceof Error ? err.message : String(err)}`);
    })) }];
  }
  const rows: DoctorRow[] = [];
  for (const svc of expected) {
    const e = entries.find((x) => x.Service === svc);
    rows.push({
      kind: "container",
      ...(await runCheck(`compose:${svc}`, `docker compose ps: ${svc} running${e?.Health ? " and healthy" : ""}`, async () => {
        if (!e) return { status: "absent", remediation: `no container — docker compose up -d ${svc}` };
        const meta = { state: e.State, health: e.Health || undefined, status: e.Status, uptime_sec: e.State === "running" ? parseComposeUptimeSec(e.Status) : undefined };
        if (e.State !== "running") return { status: "failed", remediation: `container ${e.State ?? "?"} (${e.Status ?? ""}) — docker compose up -d ${svc}; docker compose logs ${svc}`, meta };
        if (e.Health && e.Health !== "healthy") return { status: "degraded", remediation: `running but ${e.Health} — docker compose logs ${svc}`, meta };
        return { meta };
      })),
    });
  }
  return rows;
}

/**
 * The supervisor's children, asked of the supervisor itself.
 *
 * launchd knows one job under this shape; the console, the assistant, the
 * reconciler and the bridges are processes it has never heard of, so
 * `launchctl print` cannot report them and doctor would go blind on
 * everything that matters. One `status` call over the control socket
 * restores the rows — each child's state, pid, restart count and log path —
 * and a supervisor that does not answer is itself the finding.
 */
export async function supervisorRows(stateRoot: string): Promise<DoctorRow[]> {
  const configPath = supervisorConfigPath(stateRoot);
  const config = await readSupervisorConfig(configPath).catch(() => undefined);
  if (!config) {
    return [
      {
        kind: "supervisor",
        ...(await runCheck("supervisor", `${configPath} lists the supervisor's children`, async () => ({
          status: "absent",
          remediation: `no ${configPath} — this install has not been brought up under the supervisor yet: metistry up`,
        }))),
      },
    ];
  }
  let children: ChildStatus[] | undefined;
  const rows: DoctorRow[] = [
    {
      kind: "supervisor",
      ...(await runCheck(`supervisor:${config.label}`, `${config.socket} answers status with ${config.children.length} child(ren)`, async () => {
        const res = await controlRequest(config.socket, { op: "status", token: config.token }, 5_000);
        if (!res.ok) throw new Error(res.error ?? "the supervisor refused a status request");
        children = res.children;
        return { meta: { socket: config.socket, children: (res.children ?? []).length } };
      })),
    },
  ];
  rows.push(await confinementRow(config));
  for (const spec of config.children) {
    const st = children?.find((c) => c.name === spec.name);
    let action: DoctorAction | undefined;
    rows.push({
      kind: "child",
      ...(await runCheck(`child:${spec.name}`, `the supervisor reports ${spec.name} running`, async () => {
        if (!st) return { status: "absent", remediation: `the supervisor did not report ${spec.name} — metistry logs supervisor` };
        if (st.state === "running") return { meta: { pid: st.pid, uptime_ms: st.uptimeMs, uptime_sec: st.uptimeMs !== undefined ? Math.round(st.uptimeMs / 1000) : undefined, restarts: st.restarts } };
        // "stopped" was a deliberate `metistry stop` — the next verb is
        // start, not restart (there is nothing running to restart); a
        // crash-loop's own remediation already reads `metistry restart`, but
        // the more useful button is the log a restart-and-hope skips reading
        action =
          st.state === "stopped"
            ? runVerb(["metistry", "start", spec.name], `Start ${spec.name}`)
            : st.state === "crash-looping"
              ? runVerb(["metistry", "logs", spec.name], `View ${spec.name} logs`)
              : undefined;
        return {
          status: st.state === "stopped" ? "degraded" : "failed",
          remediation: `state = ${st.state}${st.lastExit ? ` (last exit code ${st.lastExit.code ?? "null"}${st.lastExit.signal ? `, signal ${st.lastExit.signal}` : ""} at ${st.lastExit.at})` : ""} — metistry restart ${spec.name}; log: ${st.log}`,
          meta: { state: st.state, restarts: st.restarts, last_exit: st.lastExit },
        };
      })),
    });
    if (action) rows[rows.length - 1]!.action = action;
  }
  return rows;
}

/**
 * WHICH CHILDREN RUN CONFINED, and what their one way out is.
 *
 * Derived from the child argv in `supervisor.json` rather than from a second
 * table: the argv is what actually runs, so a row computed from anything
 * else could be right about a plan and wrong about the machine. A child
 * whose argv[0] is `/usr/bin/sandbox-exec` is confined; the profile it names
 * is the honest answer to "confined by what", which is why the off switch is
 * a real file (`ops/sandbox/unconfined.sb`) rather than a missing prefix.
 *
 * Never `failed`. An install can legitimately run with the reconciler
 * unconfined (no real git on the Mac, an SSH remote, the operator's switch),
 * and doctor's job here is to SAY so — a red row for a supported shape
 * teaches the operator to ignore red rows.
 */
export async function confinementRow(config: SupervisorConfig): Promise<DoctorRow> {
  const confined: string[] = [];
  const unconfined: string[] = [];
  const profiles: Record<string, string> = {};
  for (const c of config.children) {
    const i = c.argv.indexOf(SANDBOX_EXEC);
    const profile = i !== -1 ? c.argv[c.argv.indexOf("-f", i) + 1] : undefined;
    const isOff = profile !== undefined && profile.endsWith(`/${UNCONFINED_PROFILE_REL.split("/").pop()}`);
    if (profile !== undefined) profiles[c.name] = profile;
    (profile !== undefined && !isOff ? confined : unconfined).push(c.name);
  }
  const egress = config.egress;
  return {
    kind: "sandbox",
    ...(await runCheck("sandbox", "which supervisor children run under a Seatbelt profile, and where their egress goes", async () => {
      const meta = { confined, unconfined, profiles, egress: egress ? { port: egress.port, allow: egress.allow } : null };
      const door = egress ? `egress: 127.0.0.1:${egress.port}, ${egress.allow.length} allowed host(s)` : "egress: no proxy (compose shape, or an install that predates one)";
      if (confined.length === 0) {
        return { status: "degraded", remediation: `no child runs under a profile — ${door}. Under the compose shape the container is the boundary; under launchd this is a gap (docs/ops/deployment-shapes.md)`, meta };
      }
      const detail = `confined: ${confined.join(", ")}${unconfined.length ? `; ambient: ${unconfined.join(", ")}` : ""}; ${door}`;
      if (!confined.includes("reconciler")) {
        return {
          status: "degraded",
          remediation: `the reconciler — the sole committer, and the only place git runs — is NOT confined. ${detail}. \`metistry up\` says why (no real git the profile can name, or METISTRY_RECONCILER_SANDBOX=0); docs/ops/reconciler.md`,
          meta,
        };
      }
      if (egress && egress.allow.length === 0) {
        return { status: "degraded", remediation: `${detail} — the allowlist is empty, so every off-machine call from a confined child is refused. That is correct for a local-only install and a bug for any other (compute.yaml's providers and the instance repo's remotes are where it comes from)`, meta };
      }
      return { meta };
    })),
  };
}

// ---- local model servers ------------------------------------------------------------

/**
 * `compute.yaml` through the D4 overlay, for the local-server rows ONLY —
 * which is why a file that does not parse degrades here instead of throwing.
 * Doctor's job is to report, and "compute.yaml is broken" is already the
 * console's loud startup failure and a `runs` warning row; a doctor that
 * could not run at all because of it would be the least useful possible
 * response to that.
 */
export async function computeForDoctor(env: NodeJS.ProcessEnv, productDir: string): Promise<Compute | undefined> {
  const instanceDir = env.METISTRY_INSTANCE_DIR?.replace(/\/+$/, "") || productDir;
  const paths = env.METISTRY_COMPUTE_FILES ?? `${join(productDir, "seed", COMPUTE_FILENAME)}:${instanceFile(instanceDir, "compute")}`;
  try {
    return (await loadCompute(paths)).compute;
  } catch {
    return undefined;
  }
}

/**
 * One row per local model server — `local:lmstudio`, `local:ollama`,
 * `local:llamaserver`, `local:applefm` — whether or not `compute.yaml` names
 * a provider for it. Never `failed`: a Mac with no local server is a
 * supported install, so this section can only report ok or absent
 * (local-models.ts). `env` goes in because one of them authenticates: the
 * `apple-fm` bridge takes a bearer on every route, `/v1` included.
 */
export async function localModelRows(env: NodeJS.ProcessEnv, productDir: string, fetchFn: typeof fetch, timeoutMs: number): Promise<DoctorRow[]> {
  return localServerRows({ compute: await computeForDoctor(env, productDir), env, fetchFn, timeoutMs: Math.min(timeoutMs, 2_000) });
}

// ---- the whole report -------------------------------------------------------------

/**
 * One row per connection in `.metistry/connections/` — its `check()`, through
 * the same pool the console uses, so a secret still goes only where its
 * policy says. A cold `npx -y …` downloads before it answers, so the dial gets
 * its own timeout (`METISTRY_CONNECTION_CHECK_TIMEOUT_MS`, default 15 s).
 */
export async function connectionRows(o: { instanceDir: string; productDir: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; uid: number; exec: Exec; keychain?: KeychainBackend }): Promise<DoctorRow[]> {
  let seedDir: string | undefined;
  try {
    seedDir = resolveSeedDir(o.productDir);
  } catch {
    seedDir = undefined;
  }
  try {
    return await connectionDoctorRows({
      instanceDir: o.instanceDir,
      instanceId: await readInstanceId(o.instanceDir).catch(() => undefined),
      ...(seedDir ? { seedDir } : {}),
      env: o.env,
      platform: o.platform,
      uid: o.uid,
      exec: o.exec,
      ...(o.keychain ? { keychain: o.keychain } : {}),
      timeoutMs: intEnv("METISTRY_CONNECTION_CHECK_TIMEOUT_MS", 15_000, o.env),
      out: () => undefined,
    });
  } catch (err) {
    return [{ kind: "connection", name: "connections", status: "degraded", latency_ms: 0, probe: "read .metistry/connections/", remediation: err instanceof Error ? err.message : String(err) }];
  }
}

export async function doctor(deps: DoctorDeps): Promise<DoctorReport> {
  // a COPY: doctor is read-only, and applying this instance's port block to
  // the real process environment would leak into whatever ran it
  const env: NodeJS.ProcessEnv = { ...(deps.env ?? process.env) };
  const fetchFn = deps.fetchFn ?? fetch;
  const exec = deps.exec ?? realExec;
  const platform = deps.platform ?? process.platform;
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const timeoutMs = deps.timeoutMs ?? 5000;
  const loaded = deps.deployment ? { deployment: deps.deployment, from: "caller" } : await loadDeployment(deps.productDir, env);
  const shape = loaded.deployment.shape;
  // this instance's own labels and ports, when it has been given a namespace
  // (`metistry up --namespace`) — every probe and every remediation below is
  // written for the jobs and ports that actually exist
  const ns = deps.namespace === undefined ? await loadNamespace(env.METISTRY_INSTANCE_DIR) : (deps.namespace ?? undefined);
  const labelSuffix = ns?.labelSuffix;
  if (ns) applyPorts(env, ns);

  const rows: DoctorRow[] = [
    {
      kind: "deployment",
      ...(await runCheck("deployment", `deployment.yaml shape (${loaded.from})${ns ? `; namespace ${ns.labelSuffix}, ports ${ns.base}+ (${ns.from})` : ""}`, async () => ({
        meta: {
          shape,
          from: loaded.from,
          services: Object.fromEntries(servicePlan(loaded.deployment).map((x) => [x.name, x.enabled ? x.shape : "disabled"])),
          ...(ns ? { namespace: { label_suffix: ns.labelSuffix, base: ns.base, ports: ns.ports } } : {}),
        },
      }))),
    },
  ];
  // Read once and shared: the `assistant` row and the local-server rows both
  // ask what compute.yaml says, and doctor must not answer twice differently.
  const compute = (await computeForDoctor(env, deps.productDir)) ?? emptyCompute();
  const instanceDir = env.METISTRY_INSTANCE_DIR?.replace(/\/+$/, "") || deps.productDir;

  // Every group below is INDEPENDENT of every other — a bridge's HTTP probe
  // knows nothing about `launchctl print`, which knows nothing about the
  // database — so they are started together and the table is assembled from
  // the results in the fixed order it has always had (`Promise.all` keeps
  // position, not completion order).
  //
  // Doctor is what `up` ends with, so its wall clock is `up`'s last second.
  // In series it was the SUM of every probe: a cold apple-fm helper answering
  // its first `/check` in ~1s, a console answering twice, one `launchctl
  // print` per label, a unix-socket round trip to the supervisor, four local
  // model servers. Concurrently it is the slowest single probe. Nothing about
  // any one check changes — no timeout was shortened to buy this, because a
  // slow-but-healthy bridge reported as down would be a worse table.
  const [componentRows, registries, layout, inbox, profile, cli, dbAndSchedules, launchd, keepAwake, supervisor, containers, localModels, sharedScope, vaultSync, connections] = await Promise.all([
    (async () => Promise.all((await walkManifests(deps.productDir)).map((m) => componentRow(m, { env, fetchFn, timeoutMs, shape, labelSuffix, compute }))))(),
    // the registries over product + extensions: overlays and skips (plan §2.7)
    registriesRow(deps.productDir, env),
    layoutRow(instanceDir),
    inboxRow(instanceDir),
    profileRow(instanceDir),
    // whether typing `metistry` finds this install's shim: a filesystem
    // look, so it costs nothing to start with everything else
    cliRow(deps.productDir, env),
    (async (): Promise<DoctorRow[]> => {
      const db = deps.db === undefined ? await openDbFromEnv(env) : deps.db;
      try {
        // schedules after the db rows: they read `runs`, so they are only
        // meaningful once the db row above has said the database answers
        return [...(await dbRows(db, deps.productDir, shape, labelSuffix)), ...(await scheduleRows(db, deps.productDir, env))];
      } finally {
        // every path, the throwing one included: a pool left open is a
        // handle that outlives the verb that made it
        if (deps.db === undefined && db?.end) await db.end().catch(() => {});
      }
    })(),
    platform === "darwin" ? launchdRows(deps.productDir, exec, uid, shape, labelSuffix, env) : Promise.resolve([]),
    // keeping the Mac awake: one row, macOS only, and never `failed` — the
    // install is running and correct even when a promise about the MACHINE is
    // unmet (docs/ops/deployment-shapes.md, "Keeping the Mac awake")
    keepAwakeRow({ deployment: loaded.deployment, instanceDir, exec, platform }),
    // the launchd shape's core is ONE agent with children launchd cannot see
    platform === "darwin" && shape === "launchd" ? supervisorRows(instanceDir) : Promise.resolve([]),
    // no container runtime is consulted when no service runs in one: a
    // launchd install must not report "docker not found" as a finding
    usesCompose(loaded.deployment) ? composeRows(deps.productDir, exec) : Promise.resolve([]),
    // the local model servers. Absent is the common case and never a
    // failure, so these rows can only add information, never a red run.
    localServerRows({ compute, fetchFn, timeoutMs: Math.min(timeoutMs, 2_000) }),
    // the retired shared scope: an instance with an id, on a Mac (or a probe
    // a test hands in) — presence only, so it can never prompt
    env.METISTRY_INSTANCE_DIR && (deps.keychainProbe || platform === "darwin")
      ? sharedScopeRow({ instanceDir, productDir: deps.productDir, env, probe: deps.keychainProbe ?? securityPresence(exec) })
      : Promise.resolve(undefined),
    // the vault's sync: ahead, behind, last push, conflict (§2.21) — never
    // `failed`, since commits are safe locally whatever the remote does
    vaultSyncRow({ env, shape, fetchFn, timeoutMs }),
    // each connection's own check() (plan §2.6): dialled, listed, compared
    // with its file — never `failed` here either, since a connection is
    // someone else's server (docs/ops/connections.md)
    env.METISTRY_INSTANCE_DIR ? connectionRows({ instanceDir, productDir: deps.productDir, env, platform, uid, exec, ...(deps.keychain ? { keychain: deps.keychain } : {}) }) : Promise.resolve([]),
  ]);
  rows.push(...componentRows, registries, layout, inbox, ...(profile ? [profile] : []), cli, ...dbAndSchedules, ...launchd, ...(keepAwake ? [keepAwake] : []), ...supervisor, ...containers, ...localModels, ...(sharedScope ? [sharedScope] : []), vaultSync, ...connections);

  return { as_of: new Date().toISOString(), product_dir: deps.productDir, shape, ok: !rows.some((r) => r.status === "failed"), rows };
}

// ---- rendering ------------------------------------------------------------------

/** The name column stops growing here: one 60-character launchd label must not indent every other row off the screen. */
const NAME_WIDTH_CAP = 34; // limit: fixed — a display column, not a policy; a row wider than this simply runs on

/**
 * The report as a person reads it (docs/ops/cli-style.md): one block per
 * kind, one icon and one colour per status, the remediation wrapped
 * underneath the row it belongs to rather than pushed into a ragged
 * fifth column, and the verdict last.
 *
 * `--json` is the machine's copy and is untouched by any of this.
 */
export function renderTable(report: DoctorReport, ui: Ui = defaultUi()): string {
  const statusWidth = Math.max(0, ...report.rows.map((r) => r.status.length));
  const out: string[] = [ui.dim(`${report.product_dir} — shape ${report.shape}, ${report.as_of}`), ""];

  for (const kind of [...new Set(report.rows.map((r) => r.kind))]) {
    const group = report.rows.filter((x) => x.kind === kind);
    // per group, not per report: one 60-character launchd label must not
    // push every bridge's status column halfway across the screen
    const nameWidth = Math.min(NAME_WIDTH_CAP, Math.max(0, ...group.map((r) => r.name.length)));
    out.push(ui.heading(kind));
    for (const r of group) {
      const status = padTo(ui.paint(statusName(r.status), r.status), statusWidth);
      out.push(`  ${ui.statusIcon(r.status)} ${padTo(r.name, nameWidth)}  ${status}  ${ui.dim(`${r.latency_ms}ms`.padStart(6))}`.trimEnd());
      // the one thing a red row is read for: what to do about it. Never on
      // an ok row — an ok row's probe is noise between the rows that matter —
      // except the one line an ok row carries on purpose (`meta.info`): a
      // fact the owner should know that asks nothing of them (profileRow).
      const info = typeof r.meta?.["info"] === "string" ? r.meta["info"] : "";
      const detail = r.status === "ok" ? info : (r.remediation ?? r.probe);
      if (detail) {
        // the arrow is a marker, not a word: it hangs in the margin and the
        // text wraps under itself, rather than the arrow taking a line of
        // its own when the first word is a long path
        const lead = 6 + visibleWidth(ui.icon("arrow")) + 1;
        const wrapped = ui.wrap(detail, { indent: lead, hanging: lead }).split("\n");
        wrapped[0] = `      ${ui.icon("arrow")} ${(wrapped[0] ?? "").slice(lead)}`;
        for (const l of wrapped) out.push(ui.dim(l));
      }
    }
    out.push("");
  }

  const counts = { ok: 0, degraded: 0, failed: 0, absent: 0 };
  for (const r of report.rows) counts[r.status]++;
  const tally = (Object.keys(counts) as Array<keyof typeof counts>).map((k) => ui.paint(statusName(k), `${counts[k]} ${k}`)).join(", ");
  const verdict = report.ok ? ui.paint("ok", `${ui.icon("ok")} healthy`) : ui.paint("failed", `${ui.icon("fail")} FAILED`);
  out.push(`${report.rows.length} checks: ${tally} — ${verdict}`);
  return out.join("\n");
}
