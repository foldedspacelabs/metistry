// `metistry restart|stop|start|logs` — the Mac app's menu bar is a front end
// for the CLI, never a second implementation (docs/product/desktop-app-plan.md),
// so this is the ONE place that turns "act on service X" into the right
// subprocess for the shape it actually runs in. It reuses exactly what `up`
// already knows: `runDirFor`/`instanceLock` for release mode, `loadDeployment`
// for the shape, `loadPlistTemplates` for which services are host jobs under
// that shape (the launchd shape's db/console/assistant included, excluded
// under compose), and `composeServiceNames` for the container names doctor
// already probes. No second table of "which services are containers".
//
// Every subprocess goes through the shared StepRunner (steps.ts): dry-run is
// the same code path with execution turned off, and the fake `exec` the
// tests inject is the same seam `up`/`update` use.

import { join } from "node:path";
import { usesCompose, type DeploymentShape } from "@foldedspacelabs/metistry-core";
import { loadDeployment } from "./deployment.js";
import type { Exec } from "./exec.js";
import { composeServiceNames } from "./doctor.js";
import { launchAgentsDir, loadPlistTemplates, loadSupervisedTemplates } from "./launchd.js";
import { readSupervisorConfig, supervisorConfigPath, controlRequest, SUPERVISOR_SERVICE } from "./supervisor.js";
import { loadNamespace } from "./namespace.js";
import { StepFailed, StepRunner } from "./steps.js";
import { composeEnvArgs, instanceLock, runDirFor } from "./up.js";

export type ServiceAction = "restart" | "stop" | "start";

export interface ServiceTarget {
  /** the CLI-facing name: the plist's service (`console`, `apple-fm`, …) or the compose service name */
  name: string;
  /**
   * How to act on it. `launchd` is an agent launchd owns (the supervisor
   * itself, the TCC helpers); `child` is a process of the supervisor's,
   * which launchctl cannot address at all — those go over the control
   * socket; `compose` is a container.
   */
  kind: "launchd" | "child" | "compose";
  /** launchd only: the job's full label, e.g. com.foldedspacelabs.metistry.console */
  label?: string;
  /** launchd only: where `up` installs this job's plist (~/Library/LaunchAgents/<file>) */
  plistPath?: string;
  /** launchd and child: StandardOutPath/StandardErrorPath from the plist template — `metistry logs` reads this file */
  logPath?: string;
  /** child only: the supervisor's control socket and token, from `<instance>/state/supervisor.json` */
  control?: { socket: string; token: string };
}

export interface ServiceTargetContext {
  /** the run dir `up` would use — `current` in release mode, the checkout otherwise */
  productDir: string;
  shape: DeploymentShape;
  /** where the shape came from (deployment.yaml, its instance overlay, or the env override) — echoed the way `up`/`doctor` do */
  from: string;
  uid: number;
  home: string;
  targets: ServiceTarget[];
  /** this instance's launchd label suffix (`<instance>/state/ports.yaml`); undefined = the fixed default labels */
  labelSuffix?: string;
}

export interface ServiceResult {
  service: string;
  action: ServiceAction | "logs";
  ok: boolean;
  detail: string;
}

/** Thrown when a named service isn't one this shape knows how to act on — the command refuses rather than guessing which subprocess to run. */
export class UnknownServiceError extends Error {
  constructor(
    public readonly unknown: string[],
    public readonly known: string[],
  ) {
    super(
      `unknown service${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} — known service${known.length === 1 ? "" : "s"} for this shape: ${
        known.length > 0 ? [...known].sort().join(", ") : "(none)"
      }`,
    );
  }
}

/**
 * Every service the current shape actually runs, tagged with how to act on
 * it. Host jobs (reconciler, watchdog, the TCC bridges, and — under the
 * launchd shape only — db/console/assistant) come from the same
 * `loadPlistTemplates` call `up` renders from; containers come from the
 * same `docker-compose.yml` parse `doctor` probes. Launchd targets are only
 * listed on macOS — there is no launchd anywhere else, so a Linux operator
 * naming a host job gets "unknown service" rather than a command that
 * pretends to work (docs/ops/deployment-shapes.md, "Linux hosts").
 */
export async function buildServiceTargets(opts: {
  productDir: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | undefined;
  uid?: number | undefined;
  home?: string | undefined;
}): Promise<ServiceTargetContext> {
  const env = opts.env;
  const lock = await instanceLock(env);
  const source = lock?.product.source ?? "git";
  const runDir = runDirFor(opts.productDir, source);
  const loaded = await loadDeployment(runDir, env);
  const deployment = loaded.deployment;
  const platform = opts.platform ?? process.platform;
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const home = opts.home ?? env.HOME ?? "";

  // a namespaced instance's jobs carry its label suffix, so `restart console`
  // must act on that instance's console and not the default one's
  const ns = await loadNamespace(env.METISTRY_INSTANCE_DIR);

  const targets: ServiceTarget[] = [];
  if (platform === "darwin") {
    const dir = launchAgentsDir(home);
    for (const t of await loadPlistTemplates(runDir, deployment.shape, ns?.labelSuffix, env)) {
      targets.push({
        name: t.service,
        kind: "launchd",
        label: t.label,
        plistPath: join(dir, t.file),
        ...(t.standardOutPath !== undefined ? { logPath: t.standardOutPath } : {}),
      });
    }
    // the supervisor's children. The log paths come from the plist templates
    // (the same files `up` renders them from), and the socket from the config
    // `up` wrote — so `metistry logs console` works whether or not the
    // supervisor is answering, while restart/stop/start need it.
    if (deployment.shape === "launchd") {
      const stateRoot = env.METISTRY_INSTANCE_DIR?.replace(/\/+$/, "") || runDir;
      const config = await readSupervisorConfig(supervisorConfigPath(stateRoot)).catch(() => undefined);
      const control = config ? { socket: config.socket, token: config.token } : undefined;
      for (const t of await loadSupervisedTemplates(runDir, ns?.labelSuffix, env)) {
        targets.push({
          name: t.service,
          kind: "child",
          ...(t.standardOutPath !== undefined ? { logPath: t.standardOutPath } : {}),
          ...(control ? { control } : {}),
        });
      }
      // Children the supervisor runs that no plist template declares — the
      // optional `llamaserver`, whose existence is a `serve:` block in
      // compute.yaml rather than a file in ops/launchd. Read from the config
      // `up` wrote, so `metistry logs llamaserver` and `restart llamaserver`
      // work for exactly the children this install actually has.
      const named = new Set(targets.map((t) => t.name));
      for (const child of config?.children ?? []) {
        if (named.has(child.name)) continue;
        targets.push({ name: child.name, kind: "child", logPath: child.log, ...(control ? { control } : {}) });
      }
    }
  }
  if (usesCompose(deployment)) {
    for (const name of await composeServiceNames(runDir)) targets.push({ name, kind: "compose" });
  }
  return { productDir: runDir, shape: deployment.shape, from: loaded.from, uid, home, targets, ...(ns ? { labelSuffix: ns.labelSuffix } : {}) };
}

/** `names` empty/undefined = every service the shape runs (the CLI's "no args" default). */
export function resolveServices(targets: ServiceTarget[], names: string[] | undefined): { resolved: ServiceTarget[]; unknown: string[] } {
  if (!names || names.length === 0) return { resolved: targets, unknown: [] };
  const byName = new Map(targets.map((t) => [t.name, t]));
  const resolved: ServiceTarget[] = [];
  const unknown: string[] = [];
  for (const n of names) {
    const t = byName.get(n);
    if (t) resolved.push(t);
    else unknown.push(n);
  }
  return { resolved, unknown };
}

async function actOnLaunchd(r: StepRunner, t: ServiceTarget, uid: number, action: ServiceAction): Promise<ServiceResult> {
  const gui = `gui/${uid}/${t.label}`;
  try {
    if (action === "restart") {
      await r.run("launchctl", ["kickstart", "-k", gui]);
      return { service: t.name, action, ok: true, detail: `launchctl kickstart -k ${gui}` };
    }
    if (action === "stop") {
      await r.run("launchctl", ["bootout", gui], { tolerateFailure: true, comment: "ok if not loaded" });
      return { service: t.name, action, ok: true, detail: `launchctl bootout ${gui}` };
    }
    // start: bootstrap the plist `up` already installed (tolerated — it may
    // already be bootstrapped), then kickstart -k so it is running either way
    if (!t.plistPath) throw new StepFailed(`no installed plist path known for ${t.name}`);
    await r.run("launchctl", ["bootstrap", `gui/${uid}`, t.plistPath], { tolerateFailure: true, comment: "ok if already bootstrapped" });
    await r.run("launchctl", ["kickstart", "-k", gui]);
    return { service: t.name, action, ok: true, detail: `launchctl bootstrap gui/${uid} ${t.plistPath}; launchctl kickstart -k ${gui}` };
  } catch (e) {
    if (e instanceof StepFailed) return { service: t.name, action, ok: false, detail: e.message };
    throw e;
  }
}

async function actOnCompose(r: StepRunner, t: ServiceTarget, productDir: string, envFile: string | undefined, action: ServiceAction): Promise<ServiceResult> {
  try {
    await r.run("docker", ["compose", ...composeEnvArgs(productDir, envFile), action, t.name], { cwd: productDir });
    return { service: t.name, action, ok: true, detail: `docker compose ${action} ${t.name}` };
  } catch (e) {
    if (e instanceof StepFailed) return { service: t.name, action, ok: false, detail: e.message };
    throw e;
  }
}

/**
 * A child of the supervisor: one line on the control socket. There is no
 * launchctl equivalent — launchd does not know this process exists — so a
 * dry run prints the request rather than pretending a command.
 */
async function actOnChild(r: StepRunner, t: ServiceTarget, action: ServiceAction): Promise<ServiceResult> {
  const detail = `supervisor ${action} ${t.name}`;
  if (!t.control) {
    return { service: t.name, action, ok: false, detail: `no supervisor config for this install — metistry up first (${SUPERVISOR_SERVICE} owns ${t.name})` };
  }
  if (!r.action(`${detail} (over ${t.control.socket})`)) return { service: t.name, action, ok: true, detail };
  try {
    const res = await controlRequest(t.control.socket, { op: action, token: t.control.token, service: t.name });
    if (!res.ok) return { service: t.name, action, ok: false, detail: res.error ?? "the supervisor refused" };
    const st = res.children?.find((c) => c.name === t.name);
    return { service: t.name, action, ok: true, detail: `${detail} → ${st?.state ?? "ok"}${st?.pid ? ` (pid ${st.pid})` : ""}` };
  } catch (e) {
    return { service: t.name, action, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function actOn(r: StepRunner, t: ServiceTarget, ctx: ServiceTargetContext, envFile: string | undefined, action: ServiceAction): Promise<ServiceResult> {
  if (t.kind === "child") return actOnChild(r, t, action);
  return t.kind === "launchd" ? actOnLaunchd(r, t, ctx.uid, action) : actOnCompose(r, t, ctx.productDir, envFile, action);
}

export interface ServiceControlOptions {
  productDir: string;
  env?: NodeJS.ProcessEnv | undefined;
  /** the dotenv file compose interpolates from (`<instance>/state/.env`); undefined while an install still runs from the checkout's */
  envFile?: string | undefined;
  exec?: Exec | undefined;
  out?: ((line: string) => void) | undefined;
  dryRun?: boolean | undefined;
  platform?: NodeJS.Platform | undefined;
  uid?: number | undefined;
  home?: string | undefined;
}

export interface ServiceControlResult {
  ok: boolean;
  shape: DeploymentShape;
  results: ServiceResult[];
  /** every command run/planned, in order — the dry-run seam every other verb uses */
  commands: string[];
}

/**
 * `metistry restart|stop|start [<service>…]`. Every named service is acted
 * on even when an earlier one fails — the result list is the per-service
 * report, not an abort-on-first-failure plan like `up`'s.
 */
export async function controlServices(opts: ServiceControlOptions & { action: ServiceAction; names?: string[] | undefined }): Promise<ServiceControlResult> {
  const env = opts.env ?? process.env;
  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out ?? ((s) => process.stdout.write(s + "\n")), exec: opts.exec, env });
  const ctx = await buildServiceTargets({ productDir: opts.productDir, env, platform: opts.platform, uid: opts.uid, home: opts.home });
  r.note(`shape: ${ctx.shape} — from ${ctx.from}`);
  const { resolved, unknown } = resolveServices(ctx.targets, opts.names);
  if (unknown.length > 0) throw new UnknownServiceError(unknown, ctx.targets.map((t) => t.name));
  r.section(opts.action);
  // "every service" means the agents: booting out the supervisor takes its
  // children with it, and bootstrapping it starts them in order. Acting on
  // both would fight itself — stop the children, then stop the supervisor
  // that has already stopped them.
  const acting = opts.names && opts.names.length > 0 ? resolved : resolved.filter((t) => t.kind !== "child");
  if (acting.length !== resolved.length) r.note(`the supervisor's children (${resolved.filter((t) => t.kind === "child").map((t) => t.name).join(", ")}) follow it — name one to act on it alone`);
  const results: ServiceResult[] = [];
  for (const t of acting) results.push(await actOn(r, t, ctx, opts.envFile, opts.action));
  return { ok: results.every((x) => x.ok), shape: ctx.shape, results, commands: r.commands };
}

/** `service  action  ok  detail` — the same table shape doctor's renderTable uses. */
export function renderServiceResults(results: ServiceResult[]): string {
  const head = ["service", "action", "ok", "detail"];
  const body = results.map((x) => [x.service, x.action, x.ok ? "ok" : "FAILED", x.detail]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => (i < 3 ? (row[i] ?? "").length : 0))));
  const line = (cells: string[]) => cells.map((c, i) => (i < 3 ? c.padEnd(widths[i] ?? 0) : c)).join("  ").trimEnd();
  const ok = results.filter((x) => x.ok).length;
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...body.map(line), "", `${results.length} service(s): ${ok} ok, ${results.length - ok} failed`].join("\n");
}

export interface LogsOptions extends ServiceControlOptions {
  service: string;
  lines: number;
  follow: boolean;
}

/** `metistry logs <service> [--lines N] [--follow]`: tail the launchd job's log file, or `docker compose logs`. Streams via `inherit`. */
export async function serviceLogs(opts: LogsOptions): Promise<ServiceResult> {
  const env = opts.env ?? process.env;
  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out ?? ((s) => process.stdout.write(s + "\n")), exec: opts.exec, env });
  const ctx = await buildServiceTargets({ productDir: opts.productDir, env, platform: opts.platform, uid: opts.uid, home: opts.home });
  const { resolved, unknown } = resolveServices(ctx.targets, [opts.service]);
  if (unknown.length > 0) throw new UnknownServiceError(unknown, ctx.targets.map((t) => t.name));
  const t = resolved[0]!;
  try {
    if (t.kind === "launchd" || t.kind === "child") {
      if (!t.logPath) throw new StepFailed(`no log path known for ${t.name} (its plist has no StandardOutPath)`);
      const args = opts.follow ? ["-n", String(opts.lines), "-f", t.logPath] : ["-n", String(opts.lines), t.logPath];
      await r.run("tail", args, { inherit: true });
    } else {
      const args = ["compose", ...composeEnvArgs(ctx.productDir, opts.envFile), "logs", t.name, "--tail", String(opts.lines), ...(opts.follow ? ["-f"] : [])];
      await r.run("docker", args, { cwd: ctx.productDir, inherit: true });
    }
    return { service: t.name, action: "logs", ok: true, detail: "" };
  } catch (e) {
    if (e instanceof StepFailed) return { service: t.name, action: "logs", ok: false, detail: e.message };
    throw e;
  }
}
