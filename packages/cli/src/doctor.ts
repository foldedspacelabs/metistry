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
// jobs ops/launchd ships (macOS), and the compose containers. Every row is
// a core CheckResult plus a `kind`; exit 0 when nothing is `failed`.

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  checkResultSchema,
  resolveUrl,
  runCheck,
  servicePlan,
  SHAPED_SERVICES,
  usesCompose,
  validateManifest,
  type CheckResult,
  type Deployment,
  type DeploymentShape,
  type Manifest,
} from "@foldedspacelabs/metistry-core";
import { loadDeployment } from "./deployment.js";
import { realExec, type Exec } from "./exec.js";
import { loadPlistTemplates, serviceOf, LABEL_PREFIX } from "./launchd.js";

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
  launchdLabel?: string;
}

const KNOWN_TARGETS: Record<string, ProbeTarget> = {
  "apple-fm": { urlVar: "METISTRY_AFM_URL", tokenVar: "METISTRY_BRIDGE_TOKEN_APPLE_FM", launchdLabel: "com.foldedspacelabs.metistry.apple-fm" },
  eventkit: { urlVar: "METISTRY_EK_URL", tokenVar: "METISTRY_BRIDGE_TOKEN_EVENTKIT", launchdLabel: "com.foldedspacelabs.metistry.eventkit" },
  reconciler: { urlVar: "METISTRY_RECONCILER_URL", tokenVar: "METISTRY_BRIDGE_TOKEN_RECONCILER", launchdLabel: "com.foldedspacelabs.metistry.reconciler" },
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

/** How an operator restarts a service, in the shape it actually runs in. */
export function restartHint(service: string, shape: DeploymentShape): string {
  return shape === "launchd" ? `launchctl kickstart -k gui/$(id -u)/${LABEL_PREFIX}${service}` : `docker compose up -d ${service}`;
}

/** Where its log is, in the shape it actually runs in. */
export function logHint(service: string, shape: DeploymentShape): string {
  return shape === "launchd" ? `/tmp/metistry-${service}.log` : `docker compose logs ${service}`;
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
async function componentRow(m: FoundManifest, deps: Required<Pick<DoctorDeps, "env" | "fetchFn" | "timeoutMs">> & { shape: DeploymentShape }): Promise<DoctorRow> {
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
    return {
      kind,
      ...(await runCheck(man.name, `GET ${url}/health ok; /api/status answers (401 = a passkey session is required)`, async () => {
        const health = await deps.fetchFn(`${url}/health`, { signal: AbortSignal.timeout(deps.timeoutMs) }).catch((err) => {
          throw new Error(`console down at ${url} (${err instanceof Error ? err.message : String(err)}) — ${restartHint("console", deps.shape)}`);
        });
        if (!health.ok) throw new Error(`console /health returned ${health.status} — ${logHint("console", deps.shape)}`);
        const status = await deps.fetchFn(`${url}/api/status`, { signal: AbortSignal.timeout(deps.timeoutMs) });
        if (status.status !== 200 && status.status !== 401) throw new Error(`console /api/status returned ${status.status} — ${logHint("console", deps.shape)}`);
        return { meta: { url, api_status: status.status } };
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
          throw new Error(`console down at ${url} (${err instanceof Error ? err.message : String(err)}) — ${restartHint("console", deps.shape)}`);
        });
        if (r.status !== 401 && r.status !== 200) throw new Error(`/mcp returned ${r.status} — ${logHint("console", deps.shape)}`);
      })),
    };
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
    const restart = t.launchdLabel ? `launchctl kickstart -k gui/$(id -u)/${t.launchdLabel}` : restartHint(man.name, deps.shape);
    return {
      kind,
      ...(await runCheck(man.name, `GET ${url}/check answers status ok`, () => probeCheck(man.name, url, deps.env[t.tokenVar], restart, deps.fetchFn, deps.timeoutMs))),
    };
  }

  const via =
    man.type === "service"
      ? man.runs_on === "host" || deps.shape === "launchd"
        ? `process state: launchd:${LABEL_PREFIX}${man.name}`
        : `process state: compose:${man.name}`
      : undefined;
  return { kind, ...(await runCheck(man.name, `${m.dir}/manifest.yaml validates${via ? `; ${via}` : ""}`, async () => {})) };
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

export async function dbRows(db: Db | null, productDir: string, shape: DeploymentShape = "compose"): Promise<DoctorRow[]> {
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
        throw new Error(`${err instanceof Error ? err.message : String(err)} — ${restartHint("db", shape)}; check METISTRY_DB_* in .env${shape === "launchd" ? " (log: /tmp/metistry-db.log)" : ""}`);
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

// ---- launchd (macOS) ----------------------------------------------------------

/**
 * The jobs THIS shape installs. Under `compose` the db, console and
 * assistant plists exist in the checkout but are not host jobs, so probing
 * them would report every install as broken.
 */
export async function launchdLabels(productDir: string, shape: DeploymentShape = "compose"): Promise<{ file: string; label: string }[]> {
  return (await loadPlistTemplates(productDir, shape)).map((t) => ({ file: t.file, label: t.label }));
}

/** `launchctl print gui/<uid>/<label>` → running | waiting (with last exit code) | not bootstrapped. */
export function parseLaunchctlPrint(text: string): { state: string; pid?: number; lastExit?: number } {
  const state = /^\s*state = (\S+)/m.exec(text)?.[1] ?? "unknown";
  const pid = /^\s*pid = (\d+)/m.exec(text)?.[1];
  const lastExit = /^\s*last exit code = (-?\d+)/m.exec(text)?.[1];
  return { state, ...(pid ? { pid: Number(pid) } : {}), ...(lastExit ? { lastExit: Number(lastExit) } : {}) };
}

export async function launchdRows(productDir: string, exec: Exec, uid: number, shape: DeploymentShape = "compose"): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  const shaped = new Set<string>(SHAPED_SERVICES);
  for (const { file, label } of await launchdLabels(productDir, shape)) {
    rows.push({
      kind: "launchd",
      ...(await runCheck(`launchd:${label}`, `launchctl print gui/${uid}/${label} reports state = running`, async () => {
        const r = await exec("launchctl", ["print", `gui/${uid}/${label}`]);
        if (r.code === 127) return { status: "absent", remediation: "launchctl not found — not macOS?" };
        if (r.code !== 0) {
          return {
            status: "absent",
            // the shaped jobs carry an EnvironmentVariables dict rendered
            // from .env, so the by-hand sed recipe cannot produce them
            remediation: shaped.has(serviceOf(label))
              ? `not bootstrapped — metistry up (this shape's ${file} is rendered with values only \`up\` computes; docs/ops/deployment-shapes.md)`
              : `not bootstrapped — metistry up, or by hand: sed "s|__REPO__|$PWD|g; s|__NODE__|$(which node)|g" ops/launchd/${file} > ~/Library/LaunchAgents/${file} && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${file}`,
          };
        }
        const p = parseLaunchctlPrint(r.stdout);
        if (p.state === "running") return { meta: { pid: p.pid } };
        return {
          status: "failed",
          remediation: `state = ${p.state}${p.lastExit !== undefined ? `, last exit code ${p.lastExit}` : ""} — launchctl kickstart -k gui/$(id -u)/${label}; log: /tmp/metistry-*.log`,
          meta: { state: p.state, last_exit: p.lastExit },
        };
      })),
    });
  }
  return rows;
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

// ---- the whole report -------------------------------------------------------------

export async function doctor(deps: DoctorDeps): Promise<DoctorReport> {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;
  const exec = deps.exec ?? realExec;
  const platform = deps.platform ?? process.platform;
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const timeoutMs = deps.timeoutMs ?? 5000;
  const loaded = deps.deployment ? { deployment: deps.deployment, from: "caller" } : await loadDeployment(deps.productDir, env);
  const shape = loaded.deployment.shape;

  const rows: DoctorRow[] = [
    {
      kind: "deployment",
      ...(await runCheck("deployment", `deployment.yaml shape (${loaded.from})`, async () => ({
        meta: { shape, from: loaded.from, services: Object.fromEntries(servicePlan(loaded.deployment).map((x) => [x.name, x.enabled ? x.shape : "disabled"])) },
      }))),
    },
  ];
  for (const m of await walkManifests(deps.productDir)) rows.push(await componentRow(m, { env, fetchFn, timeoutMs, shape }));

  const db = deps.db === undefined ? await openDbFromEnv(env) : deps.db;
  try {
    rows.push(...(await dbRows(db, deps.productDir, shape)));
  } finally {
    if (deps.db === undefined && db?.end) await db.end().catch(() => {});
  }

  if (platform === "darwin") rows.push(...(await launchdRows(deps.productDir, exec, uid, shape)));
  // no container runtime is consulted when no service runs in one: a
  // launchd install must not report "docker not found" as a finding
  if (usesCompose(loaded.deployment)) rows.push(...(await composeRows(deps.productDir, exec)));

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
