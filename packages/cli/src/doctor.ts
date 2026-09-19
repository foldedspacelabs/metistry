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
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  checkResultSchema,
  cutoffIsAFinding,
  failureStreaks,
  humanGap,
  instanceStatePath,
  intEnv,
  keepAwakeOf,
  parseKeepAwakeState,
  powerSourceLabel,
  resolveUrl,
  shouldHold,
  runCheck,
  scheduleToSeconds,
  servicePlan,
  SHAPED_SERVICES,
  usesCompose,
  validateManifest,
  DEFAULT_MAX_STREAK,
  KEEP_AWAKE_CUTOFF_FACTOR,
  KEEP_AWAKE_KIND,
  KEEP_AWAKE_STATE_FILENAME,
  LID_CLOSED_NOT_AVAILABLE,
  PREFLIGHT_FAILED,
  RUNNER_KIND,
  SCHEDULED_KINDS,
  SKIPPED_STREAK,
  type CheckResult,
  type Deployment,
  type DeploymentShape,
  type ChildStatus,
  type Manifest,
} from "@foldedspacelabs/metistry-core";
import { COMPUTE_FILENAME, INSTANCE_LAYOUT, LEGACY_VAULT_DIR, detectLayout, emptyCompute, instanceFile, loadCompute, type Compute } from "@foldedspacelabs/metistry-core";
import { engineStatus, loadDeployment } from "./deployment.js";
import { localServerRows } from "./local-models.js";
import { realExec, type Exec } from "./exec.js";
import { labelFor, loadPlistTemplates, logPathFor, parseRegistrar, registrarPhrase, SUPERVISED_SERVICES, type RegistrarFinding } from "./launchd.js";
import { readSupervisorConfig, supervisorConfigPath, controlRequest, SUPERVISOR_SERVICE } from "./supervisor.js";
import { applyPorts, loadNamespace, type Namespace } from "./namespace.js";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  end?(): Promise<void>;
}

export interface DoctorRow extends CheckResult {
  kind: string;
}

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

/** GET <url>/check with the bearer; the bridge's own status and remediation ride through (watchdog bridges.ts, same split: down vs degraded). */
async function probeCheck(name: string, url: string, token: string | undefined, restart: string, fetchFn: typeof fetch, timeoutMs: number): Promise<Outcome> {
  let res: Response;
  try {
    res = await fetchFn(`${url}/check`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { status: "failed", remediation: `${name} down at ${url} (${why}) — ${restart}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: "failed", remediation: `${name} rejected the token (HTTP ${res.status}) — the METISTRY_BRIDGE_TOKEN_* in .env differs from the one the bridge was started with` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const parsed = checkResultSchema.safeParse(body);
  if (!parsed.success) return { status: "failed", remediation: `${name} answered HTTP ${res.status} without a check() body at ${url} — wrong port, or a bridge mid-crash; ${restart}` };
  const r = parsed.data;
  const meta = { probe: r.probe, ...(r.meta ? { bridge_meta: r.meta } : {}) };
  if (r.status === "ok") return { status: "ok", meta };
  return { status: r.status, ...(r.remediation ? { remediation: r.remediation } : { remediation: r.probe }), meta };
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
    return {
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
          return {
            status: "degraded" as const,
            remediation: `${url} refused METISTRY_LOCAL_OWNER_TOKEN (401): the console was started with a different value (\`metistry secrets sync --to env\` then ${restartHint("console", deps.shape, deps.labelSuffix)}), or the request did not reach it from this machine — under compose it needs METISTRY_TRUSTED_LOOPBACK_PROXY (docs/ops/auth.md)`,
            meta,
          };
        }
        return { meta };
      })),
    };
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
        ...(await runCheck(man.name, `${t.urlVar} set → GET /check`, async () => ({
          status: "absent",
          remediation: `not configured: set ${t.urlVar}${port ? ` (default ${deps.shape === "launchd" ? `http://127.0.0.1:${port}` : `http://host.docker.internal:${port}`})` : ""} and ${t.tokenVar} in .env — degrades ${"degrades" in man ? man.degrades : "absent"} meanwhile`,
        }))),
      };
    }
    const url = hostLocal(configured, deps.shape);
    const restart = restartHint(t.launchdService ?? man.name, t.launchdService ? "launchd" : deps.shape, deps.labelSuffix);
    return {
      kind,
      ...(await runCheck(man.name, `GET ${url}/check answers status ok`, () => probeCheck(man.name, url, deps.env[t.tokenVar], restart, deps.fetchFn, deps.timeoutMs))),
    };
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
  return {
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
      return {
        status: "degraded",
        remediation: `the vault still lives in ${LEGACY_VAULT_DIR}/ and the config files at the instance root — \`metistry migrate-layout --dry-run\` prints the whole plan, \`metistry migrate-layout\` runs it (docs/ops/instance-layout.md)`,
        meta: { layout: "legacy" },
      };
    })),
  };
}

export async function inboxRow(instanceDir: string): Promise<DoctorRow> {
  return {
    kind: "instance",
    ...(await runCheck("inbox", `${instanceDir}/inbox/ absent, and .gitignore does not list it — captures live at ${INSTANCE_LAYOUT.inboxDir}/`, async () => {
      const legacyDir = join(instanceDir, "inbox");
      const entries = existsSync(legacyDir) ? (await readdir(legacyDir)).filter((e) => e !== ".DS_Store") : [];
      const gitignorePath = join(instanceDir, ".gitignore");
      const gitignored = existsSync(gitignorePath) && (await readFile(gitignorePath, "utf8")).split("\n").some((l) => LEGACY_INBOX_GITIGNORE_LINE.test(l.trim()));
      if (entries.length === 0 && !gitignored) return;
      return {
        status: "degraded",
        remediation: "the pre-#156 layout: run `metistry migrate-inbox --dry-run` to see the plan, then `metistry migrate-inbox` to move captures into the vault inbox (docs/ops/inbox.md)",
        meta: { dir: legacyDir, entries: entries.length, gitignored },
      };
    })),
  };
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
      { kind: "db", ...(await runCheck("db", "SELECT 1 round-trip", async () => ({ status: "absent", remediation: "METISTRY_DB_PASSWORD is unset — copy .env.example to .env and fill in METISTRY_DB_*" }))) },
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

  const migRow: DoctorRow = {
    kind: "db",
    ...(await runCheck("migrations", `schema_migrations rows = ${files.length} files in db/migrations`, async () => {
      if (!reachable) return { status: "absent", remediation: "not checked — db unreachable" };
      const exists = await db.query("SELECT to_regclass('public.schema_migrations') AS t");
      if (!exists.rows[0]?.t) return { status: "degraded", remediation: `no schema_migrations table — run pnpm db:migrate (${files.length} migrations pending)`, meta: { applied: 0, files: files.length } };
      const { rows } = await db.query("SELECT filename FROM schema_migrations ORDER BY filename");
      const applied = rows.map((r) => String(r.filename));
      const pending = files.filter((f) => !applied.includes(f));
      const unknown = applied.filter((f) => !files.includes(f));
      const meta = { applied: applied.length, files: files.length, pending, unknown };
      if (pending.length > 0) return { status: "degraded", remediation: `${pending.length} migration(s) not applied (${pending.join(", ")}) — run pnpm db:migrate`, meta };
      if (unknown.length > 0) return { status: "degraded", remediation: `db has migration(s) this checkout lacks (${unknown.join(", ")}) — is the checkout older than the database?`, meta };
      return { meta };
    })),
  };
  return [dbRow, migRow];
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
    return [{ dir: m.dir, name: man.name, schedule: man.schedule, runKind: man.type === "routine" ? "routine_run" : "collector_run" }];
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
      `SELECT DISTINCT ON (component, kind) component, kind, ts, ok, error
       FROM runs WHERE kind = ANY($1) ORDER BY component, kind, ts DESC`,
      [[...SCHEDULED_KINDS]],
    );
    for (const r of lastRows) {
      last.set(`${r.component}/${r.kind}`, { ts: new Date(r.ts), ok: r.ok === null ? null : Boolean(r.ok), error: r.error ?? null });
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

  const out: DoctorRow[] = [];
  for (const s of scheduled) {
    const intervalSec = (() => {
      try {
        return scheduleToSeconds(s.schedule);
      } catch {
        return 0;
      }
    })();
    const lastRun = last.get(`${s.name}/${s.runKind}`);
    const streak = streaks.find((x) => x.component === s.name && x.kind === s.runKind);
    const skipped = markers.get(`${s.name}/${SKIPPED_STREAK}`);
    const blocked = markers.get(`${s.name}/${PREFLIGHT_FAILED}`);
    // a marker only describes the CURRENT state while it is inside its own
    // window plus a tick's grace — an old one is history, not a finding
    const fresh = (m: { ts: Date } | undefined): boolean =>
      m !== undefined && intervalSec > 0 && now.getTime() - m.ts.getTime() <= intervalSec * OVERDUE_FACTOR * 1000;
    const nextDue = lastRun && intervalSec > 0 ? new Date(lastRun.ts.getTime() + intervalSec * 1000) : null;
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
    };

    out.push({
      kind: "schedule",
      ...(await runCheck(s.name, `${s.schedule} (every ${humanSec(intervalSec)}): ran inside ${OVERDUE_FACTOR}× its interval, last run ok, no open failure streak`, async () => {
        if (fresh(skipped)) {
          return {
            status: "failed" as const,
            remediation: `the runner has stopped running ${s.name}: ${meta.streak} failures in a row reached METISTRY_RUNNER_MAX_STREAK (${maxStreak}) — ${skipped?.error ?? "see the runner rows"}; the next successful run clears it, or raise METISTRY_RUNNER_MAX_STREAK, or remove \`schedule\` from ${s.dir}/manifest.yaml`,
            meta,
          };
        }
        if (fresh(blocked)) {
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
        if (intervalSec > 0 && now.getTime() - lastRun.ts.getTime() > intervalSec * OVERDUE_FACTOR * 1000) {
          return {
            status: "failed" as const,
            remediation: `${s.name} last ran ${humanSec(Math.floor((now.getTime() - lastRun.ts.getTime()) / 1000))} ago, over ${OVERDUE_FACTOR}× its "${s.schedule}" interval — the console's runner is not running it: metistry logs console`,
            meta,
          };
        }
        if ((streak?.count ?? 0) > 0) {
          return {
            status: "degraded" as const,
            remediation: `${streak?.count} failed run(s) in a row since ${streak?.since.toISOString()}: ${streak?.lastError ?? "(no error text)"} — at METISTRY_RUNNER_MAX_STREAK (${maxStreak}) the runner stops running it`,
            meta,
          };
        }
        return { meta };
      })),
    });
  }
  return out;
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
  const mode = keepAwakeOf(deps.deployment);
  const statePath = instanceStatePath(deps.instanceDir, "run", KEEP_AWAKE_STATE_FILENAME);
  const lidNote = mode === "always_lid_closed" ? LID_CLOSED_NOT_AVAILABLE : undefined;

  return {
    kind: KEEP_AWAKE_KIND,
    ...(await runCheck(KEEP_AWAKE_KIND, `deployment.yaml says keep_awake: ${mode}; ${statePath} and pmset -g assertions agree`, async () => {
      if (mode === "never") {
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
          meta: { mode, shape: "compose" },
        };
      }

      const state = parseKeepAwakeState(await readFile(statePath, "utf8").then(JSON.parse, () => undefined));
      if (!state) {
        return {
          status: "degraded",
          remediation: `keep_awake: ${mode}, but nothing has written ${statePath} — the supervisor is not running, or has not started since the setting changed: \`metistry up\`${lidNote ? `. ${lidNote}` : ""}`,
          meta: { mode, state_file: statePath },
        };
      }

      const held = await deps.exec("pmset", ["-g", "assertions"]);
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
        ...(lidNote ? { lid_closed: "not available without an administrator change" } : {}),
      };

      // the owner's ruling E: it slept anyway. Said first, because it is the
      // one thing on this row a person can act on.
      const cutoff = cutoffIsAFinding(state);
      if (cutoff) {
        return {
          status: "degraded",
          remediation:
            `this Mac slept at ${cutoff.at} for about ${humanGap(cutoff.gap_ms)} while keep_awake: ${cutoff.mode} was set — an idle-sleep assertion does not stop lid close, ` +
            `a scheduled sleep or the Apple menu, and another policy may have won. If that is not what you want, ` +
            `\`metistry deployment set-keep-awake always --yes\` holds on battery too, which costs battery on a laptop; a closed lid still sleeps${lidNote ? ` — ${lidNote}` : ""}`,
          meta: { ...meta, last_cutoff: cutoff },
        };
      }

      if (state.stopped_at !== undefined) {
        return {
          status: "degraded",
          remediation: `released at ${state.stopped_at} when the supervisor stopped — nothing holds this Mac awake until it is running again: \`metistry up\``,
          meta,
        };
      }

      if (now() - Date.parse(state.heartbeat_at) > state.interval_ms * KEEP_AWAKE_CUTOFF_FACTOR) {
        return {
          status: "degraded",
          remediation: `the holder last reported at ${state.heartbeat_at}, more than ${KEEP_AWAKE_CUTOFF_FACTOR} of its ${Math.round(state.interval_ms / 1000)}s cycles ago — the supervisor is not running: \`metistry logs supervisor\``,
          meta,
        };
      }

      if (!state.holding) {
        // released BY POLICY is the setting working, and must read as success
        if (!shouldHold(mode, state.power_source)) return { ...(lidNote ? { status: "degraded" as const, remediation: lidNote } : {}), meta };
        return {
          status: "degraded",
          remediation: `keep_awake: ${mode} and this Mac is drawing from '${powerSourceLabel(state.power_source)}', but nothing is held — \`metistry logs supervisor\``,
          meta,
        };
      }

      if (!ours) {
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
    const row: DoctorRow = {
      kind: "launchd",
      ...(await runCheck(`launchd:${label}`, `launchctl print gui/${uid}/${label} reports state = running`, async () => {
        const r = await exec("launchctl", ["print", `gui/${uid}/${label}`]);
        if (r.code === 127) return { status: "absent", remediation: "launchctl not found — not macOS?" };
        if (service === SUPERVISOR_SERVICE) found = parseRegistrar(r.code, r.stdout);
        if (r.code !== 0) {
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
        if (p.state === "running") return { meta: { pid: p.pid } };
        return {
          status: "failed",
          remediation: `state = ${p.state}${p.lastExit !== undefined ? `, last exit code ${p.lastExit}` : ""} — launchctl kickstart -k gui/$(id -u)/${label}; log: ${logPathFor(service, labelSuffix)}`,
          meta: { state: p.state, last_exit: p.lastExit },
        };
      })),
    };
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
        const meta = { state: e.State, health: e.Health || undefined, status: e.Status };
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
  for (const spec of config.children) {
    const st = children?.find((c) => c.name === spec.name);
    rows.push({
      kind: "child",
      ...(await runCheck(`child:${spec.name}`, `the supervisor reports ${spec.name} running`, async () => {
        if (!st) return { status: "absent", remediation: `the supervisor did not report ${spec.name} — metistry logs supervisor` };
        if (st.state === "running") return { meta: { pid: st.pid, uptime_ms: st.uptimeMs, restarts: st.restarts } };
        return {
          status: st.state === "stopped" ? "degraded" : "failed",
          remediation: `state = ${st.state}${st.lastExit ? ` (last exit code ${st.lastExit.code ?? "null"}${st.lastExit.signal ? `, signal ${st.lastExit.signal}` : ""} at ${st.lastExit.at})` : ""} — metistry restart ${spec.name}; log: ${st.log}`,
          meta: { state: st.state, restarts: st.restarts, last_exit: st.lastExit },
        };
      })),
    });
  }
  return rows;
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
  const [componentRows, layout, inbox, dbAndSchedules, launchd, keepAwake, supervisor, containers, localModels] = await Promise.all([
    (async () => Promise.all((await walkManifests(deps.productDir)).map((m) => componentRow(m, { env, fetchFn, timeoutMs, shape, labelSuffix, compute }))))(),
    layoutRow(instanceDir),
    inboxRow(instanceDir),
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
  ]);
  rows.push(...componentRows, layout, inbox, ...dbAndSchedules, ...launchd, ...(keepAwake ? [keepAwake] : []), ...supervisor, ...containers, ...localModels);

  return { as_of: new Date().toISOString(), product_dir: deps.productDir, shape, ok: !rows.some((r) => r.status === "failed"), rows };
}

// ---- rendering ------------------------------------------------------------------

export function renderTable(report: DoctorReport): string {
  const head = ["name", "kind", "status", "ms", "remediation"];
  const body = report.rows.map((r) => [r.name, r.kind, r.status, String(r.latency_ms), r.status === "ok" ? "" : (r.remediation ?? r.probe)]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => (i < 4 ? (row[i] ?? "").length : 0))));
  const line = (cells: string[]) => cells.map((c, i) => (i < 4 ? c.padEnd(widths[i] ?? 0) : c)).join("  ").trimEnd();
  const counts = { ok: 0, degraded: 0, failed: 0, absent: 0 };
  for (const r of report.rows) counts[r.status]++;
  return [
    line(head),
    line(widths.map((w) => "-".repeat(w))),
    ...body.map(line),
    "",
    `${report.rows.length} checks: ${counts.ok} ok, ${counts.degraded} degraded, ${counts.failed} failed, ${counts.absent} absent — ${report.ok ? "healthy" : "FAILED"} (${report.product_dir}, shape ${report.shape})`,
  ].join("\n");
}
