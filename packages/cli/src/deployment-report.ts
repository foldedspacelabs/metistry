// `metistry deployment` / `metistry deployment set-shape` — the wizard's and
// the Settings pane's window onto `deployment.yaml` (docs/product/
// desktop-app-plan.md), so neither has to resolve the D4 overlay itself.
//
// This is a separate file from deployment.ts (which doctor.ts imports) so
// that reusing doctor.ts's own launchd/compose probes here — rather than a
// second "is it running" implementation — does not create an import cycle:
// doctor.ts -> deployment.ts, and this file -> both.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEPLOYMENT_FILENAME, SHAPED_SERVICES, servicePlan, usesCompose, type Deployment, type DeploymentShape, type ServiceName } from "@foldedspacelabs/metistry-core";
import { applyShapeToYaml, loadDeployment } from "./deployment.js";
import { composeRows, launchdRows } from "./doctor.js";
import { realExec, type Exec } from "./exec.js";
import { serviceOf } from "./launchd.js";
import { writeProtected } from "./protected-write.js";
import { StepRunner } from "./steps.js";

export interface DeploymentServiceRow {
  name: ServiceName;
  shape: DeploymentShape;
  enabled: boolean;
  /** omitted when not cheaply knowable: a launchd-shaped service off macOS, or a compose-shaped one when nothing in this deployment uses compose */
  running?: boolean;
}

export interface DeploymentReport {
  shape: DeploymentShape;
  from: string;
  services: DeploymentServiceRow[];
}

/**
 * The running check doctor already knows how to do — `launchctl print` /
 * `docker compose ps`, no network — reused rather than reimplemented.
 * Deliberately NOT the full `doctor()`: that also walks every manifest and
 * probes every bridge over HTTP, which is the "not cheap" doctor already
 * warns about avoiding here. Skipped per-service, not just per-report, so a
 * launchd job's state still shows when docker is unavailable and vice versa.
 */
export async function deploymentServiceRows(
  productDir: string,
  deployment: Deployment,
  ctx: { exec: Exec; uid: number; platform: NodeJS.Platform },
): Promise<DeploymentServiceRow[]> {
  const plan = servicePlan(deployment);
  const running = new Set<string>();
  const launchdChecked = ctx.platform === "darwin";
  if (launchdChecked) {
    for (const row of await launchdRows(productDir, ctx.exec, ctx.uid, deployment.shape)) {
      if (row.status === "ok") running.add(serviceOf(row.name.slice("launchd:".length)));
    }
  }
  const composeChecked = usesCompose(deployment);
  if (composeChecked) {
    for (const row of await composeRows(productDir, ctx.exec)) {
      if (row.status === "ok" || row.status === "degraded") running.add(row.name.slice("compose:".length));
    }
  }
  return plan.map((s) => {
    const checked = s.shape === "launchd" ? launchdChecked : composeChecked;
    return checked ? { ...s, running: running.has(s.name) } : s;
  });
}

export interface BuildDeploymentReportOptions {
  productDir: string;
  env: NodeJS.ProcessEnv;
  exec?: Exec | undefined;
  platform?: NodeJS.Platform | undefined;
  uid?: number | undefined;
}

export async function buildDeploymentReport(opts: BuildDeploymentReportOptions): Promise<DeploymentReport> {
  const loaded = await loadDeployment(opts.productDir, opts.env);
  const exec = opts.exec ?? realExec;
  const platform = opts.platform ?? process.platform;
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const services = await deploymentServiceRows(opts.productDir, loaded.deployment, { exec, uid, platform });
  return { shape: loaded.deployment.shape, from: loaded.from, services };
}

export function renderDeploymentReport(report: DeploymentReport): string {
  const head = ["service", "shape", "enabled", "running"];
  const body = report.services.map((s) => [s.name, s.shape, s.enabled ? "yes" : "no", s.running === undefined ? "?" : s.running ? "yes" : "no"]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [`shape: ${report.shape} (from ${report.from})`, "", line(head), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

// ---- set-shape --------------------------------------------------------------

export interface SetShapeOptions {
  productDir: string;
  instanceDir: string;
  targetShape: DeploymentShape;
  /** without it nothing is written — the preview is the whole command */
  yes?: boolean | undefined;
  /** write even though services are still running under the current shape */
  force?: boolean | undefined;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  fetchFn: typeof fetch;
  exec?: Exec | undefined;
  out: (line: string) => void;
}

export interface SetShapeResult {
  shape: DeploymentShape;
  applied: boolean;
  refused: boolean;
  detail: string;
}

/**
 * `metistry deployment set-shape <compose|launchd>`. `deployment.yaml` is a
 * §4.7 protected path (invariant 2: how the system behaves is a human
 * change), so the write goes through the reconciler as `user`, exactly the
 * way `metistry.lock`/`identity.yaml` already do (protected-write.ts) —
 * preview without `--yes` (the StepRunner's ordinary dry-run: the plan
 * prints, nothing is written or POSTed), applied with it.
 *
 * Refuses when the CURRENT shape still has enabled services running,
 * because the data does not move between shapes on its own
 * (docs/ops/deployment-shapes.md) — flipping the file out from under a
 * running Postgres would just orphan it. `--force` is the operator saying
 * they already took the dump.
 */
export async function setDeploymentShape(opts: SetShapeOptions): Promise<SetShapeResult> {
  const exec = opts.exec ?? realExec;
  const r = new StepRunner({ dryRun: opts.yes !== true, out: opts.out, exec, env: opts.env });
  const current = await loadDeployment(opts.productDir, opts.env);

  if (current.deployment.shape === opts.targetShape) {
    const detail = `already shape: ${opts.targetShape} (from ${current.from}) — nothing to change`;
    r.note(detail);
    return { shape: opts.targetShape, applied: false, refused: false, detail };
  }

  // Only the services whose shape actually depends on deployment.yaml —
  // reconciler and watchdog are host jobs in EITHER shape (invariant 6;
  // servicePlan always reports them as launchd), so their being up says
  // nothing about whether it's safe to flip db/console/assistant's shape.
  const shaped = new Set<string>(SHAPED_SERVICES);
  const rows = await deploymentServiceRows(opts.productDir, current.deployment, { exec, uid: opts.uid, platform: opts.platform });
  const running = rows.filter((s) => shaped.has(s.name) && s.enabled && s.running === true).map((s) => s.name);
  if (running.length > 0 && !opts.force) {
    const detail =
      `refusing: ${running.length} service(s) still running under ${current.deployment.shape} (${running.join(", ")}) — ` +
      `the data does not move between shapes on its own (docs/ops/deployment-shapes.md). Run \`metistry stop\`, ` +
      `change the shape, then \`metistry up\` to start them under ${opts.targetShape}; or pass --force to write the shape anyway.`;
    r.note(detail);
    return { shape: opts.targetShape, applied: false, refused: true, detail };
  }

  const path = join(opts.instanceDir, DEPLOYMENT_FILENAME);
  const existing = existsSync(path) ? await readFile(path, "utf8") : undefined;
  const content = applyShapeToYaml(existing, opts.targetShape);
  const delivery = await writeProtected(r, DEPLOYMENT_FILENAME, content, `metistry deployment set-shape → ${opts.targetShape}`, {
    env: opts.env,
    platform: opts.platform,
    uid: opts.uid,
    fetchFn: opts.fetchFn,
    instanceDir: opts.instanceDir,
  });
  return { shape: opts.targetShape, applied: !r.dryRun && delivery.how !== "none", refused: false, detail: delivery.detail };
}
