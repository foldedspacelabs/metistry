// A collector's own `check()` in `metistry doctor` (CLAUDE.md: "every bridge
// and collector exports `check()` so `metistry doctor` is generic"; X-87).
//
// Doctor already had one row per collector — "the manifest validates" — and
// nothing asked the collector anything. This is the other half: load the
// collector's compiled entry, call the `check()` it exports with what the
// console would hand its `run()`, and MERGE the answer into that one row. No
// second row kind: the schedule row (last run, overdue, failure streak) is
// its own and stays as it was.
//
// Doctor imports nothing from `collectors/` (the dependency arrow points
// from `apps/` to `packages/`, and the CLI is a package): the entry is found
// by PATH in the product checkout or the release pack — `collectors/dist/
// <name>/run.js`, where the console's registry finds the same code
// (`unitCode`) — and imported dynamically. The name is the manifest's, which
// the schema holds to kebab-case, so no manifest points outside
// `<product>/collectors/`.
//
// Three promises, each a code path with a test (U3):
//   * a module that will not load is a `failed` row carrying the error;
//   * a `check()` that throws, hangs past the guard, or returns something that
//     is not core's `check()` shape is a `failed` row — it never crashes
//     doctor, and the rest of the report still runs;
//   * a collector that has not been built is `degraded`, saying which command
//     builds it — doctor does not pretend to have asked.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkResultSchema, type CheckResult, type Compute, type DeploymentShape } from "@foldedspacelabs/metistry-core";
import { instanceImapOpener, instanceSyncOpener } from "@foldedspacelabs/metistry-connections";
import type { ConnectionChecker } from "./connection-check.js";

/** `<product>/collectors/dist/<name>/run.js` (a build or a release pack), else `<product>/collectors/<name>/run.js`; undefined = not built. */
export function collectorEntry(productDir: string, name: string): string | undefined {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return undefined;
  return [join(productDir, "collectors", "dist", name, "run.js"), join(productDir, "collectors", name, "run.js")].find((f) => existsSync(f));
}

/**
 * What every collector's `check()` is handed: the context the console builds
 * for `run()` — read from the same environment variables, by the same names —
 * plus `connectionCheck` (the shared connection check) and `timeoutMs`.
 * Structural: doctor does not know which fields a given collector reads.
 */
export type CollectorCheckContext = Record<string, unknown>;

export interface CollectorCheckContextOptions {
  env: NodeJS.ProcessEnv;
  fetchFn: typeof fetch;
  shape: DeploymentShape;
  /** the URL rewrite for a probe made from the host (core's `resolveUrl`, through doctor's `hostLocal`) */
  hostLocal: (url: string, shape: DeploymentShape) => string;
  compute: Compute;
  /** how long a probe may take — doctor's own `timeoutMs` */
  timeoutMs: number;
  /** the instance's connections, shared with doctor's connection rows; absent = no instance */
  instance?: { dir: string; seedDir: string | undefined; checker: ConnectionChecker } | undefined;
}

const list = (v: string | undefined): string[] | undefined => {
  const out = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
};

/** The environment → context mapping `apps/console/src/main.ts` applies for `run()`, restricted to what a probe reads. */
export function collectorCheckContext(o: CollectorCheckContextOptions): CollectorCheckContext {
  const { env } = o;
  const ctx: CollectorCheckContext = { fetchFn: o.fetchFn, timeoutMs: o.timeoutMs, compute: () => o.compute, secretEnv: env };
  if (o.instance) {
    const roots = { instanceDir: o.instance.dir, ...(o.instance.seedDir ? { seedDir: o.instance.seedDir } : {}), env };
    ctx.openSync = instanceSyncOpener(roots);
    ctx.openImap = instanceImapOpener(roots);
    const checker = o.instance.checker;
    ctx.connectionCheck = (name: string) => checker.check(name);
  }
  const set = (key: string, value: unknown): void => {
    if (value !== undefined && value !== "") ctx[key] = value;
  };
  set("ekUrl", env.METISTRY_EK_URL?.trim() ? o.hostLocal(env.METISTRY_EK_URL.trim(), o.shape) : undefined);
  set("ekToken", env.METISTRY_BRIDGE_TOKEN_EVENTKIT?.trim());
  if (env.METISTRY_AWS_ACCESS_KEY_ID && env.METISTRY_AWS_SECRET_ACCESS_KEY) {
    ctx.aws = {
      accessKeyId: env.METISTRY_AWS_ACCESS_KEY_ID,
      secretAccessKey: env.METISTRY_AWS_SECRET_ACCESS_KEY,
      ...(env.METISTRY_AWS_SESSION_TOKEN ? { sessionToken: env.METISTRY_AWS_SESSION_TOKEN } : {}),
    };
  }
  set("devinApiKey", env.METISTRY_DEVIN_API_KEY?.trim());
  set("devinOrgId", env.METISTRY_DEVIN_ORG_ID?.trim());
  set("devinRepos", list(env.METISTRY_DEVIN_REPOS));
  set("devinApiUrl", env.METISTRY_DEVIN_API_URL?.trim());
  return ctx;
}

export interface CollectorCheckOptions {
  productDir: string;
  /** the manifest's name — the collector's directory */
  name: string;
  /** the manifest's `uses_model:`, for the collector that pins one */
  usesModel?: string | undefined;
  ctx: CollectorCheckContext;
  /** the outer guard: a `check()` that has not settled by then is `failed`. Default: twice `ctx.timeoutMs`. */
  guardMs?: number | undefined;
  /** test seam: how the entry is imported (default: `import()` of the file's URL) */
  load?: ((file: string) => Promise<unknown>) | undefined;
}

const failed = (name: string, probe: string, started: number, remediation: string): CheckResult => ({
  name,
  status: "failed",
  latency_ms: Math.round(performance.now() - started),
  probe,
  remediation,
});

/**
 * Run one collector's `check()` and return its verdict in core's shape. Never
 * throws and never waits longer than the guard.
 */
export async function runCollectorCheck(o: CollectorCheckOptions): Promise<CheckResult> {
  const started = performance.now();
  const rel = `collectors/dist/${o.name}/run.js`;
  const probe = `${rel} exports check() and it answers`;
  const file = collectorEntry(o.productDir, o.name);
  if (!file) {
    return {
      name: o.name,
      status: "degraded",
      latency_ms: 0,
      probe,
      remediation: `${rel} is not here, so its own check() was not asked — a checkout needs \`pnpm -r build\`; a release pack should carry it, so \`metistry update\` re-installs it`,
    };
  }
  let mod: { check?: unknown };
  try {
    mod = (await (o.load ?? ((f) => import(pathToFileURL(f).href)))(file)) as { check?: unknown };
  } catch (err) {
    return failed(o.name, probe, started, `${rel} did not load: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof mod.check !== "function") return failed(o.name, probe, started, `${rel} exports no check() — every collector must (CLAUDE.md), and CI holds it`);

  const guardMs = o.guardMs ?? (typeof o.ctx.timeoutMs === "number" ? o.ctx.timeoutMs * 2 : 10_000);
  let timer: NodeJS.Timeout | undefined;
  try {
    const ctx = { ...o.ctx, ...(o.usesModel ? { usesModel: o.usesModel } : {}) };
    const got: unknown = await Promise.race([
      Promise.resolve().then(() => (mod.check as (c: CollectorCheckContext) => Promise<unknown>)(ctx)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`check() did not answer within ${guardMs} ms`)), guardMs);
      }),
    ]);
    const parsed = checkResultSchema.safeParse(got);
    if (!parsed.success) return failed(o.name, probe, started, `check() returned something that is not a check() result: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    return parsed.data;
  } catch (err) {
    return failed(o.name, probe, started, err instanceof Error ? err.message : String(err));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The collector's verdict laid over its manifest row: its status, reason and numbers; the row's name, and both probes. */
export function mergeCollectorCheck(row: CheckResult, check: CheckResult): CheckResult {
  return {
    name: row.name,
    status: check.status,
    latency_ms: row.latency_ms + check.latency_ms,
    probe: `${row.probe}; check(): ${check.probe}`,
    ...(check.remediation ? { remediation: check.remediation } : {}),
    ...(check.meta ? { meta: check.meta } : {}),
  };
}
