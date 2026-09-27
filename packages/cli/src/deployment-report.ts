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
import {
  DEPLOYMENT_FILENAME,
  LID_CLOSED_COMMAND,
  LID_CLOSED_DIALOG_TITLE,
  LID_CLOSED_NOT_AVAILABLE,
  LID_CLOSED_UNDO,
  LID_CLOSED_WARNING,
  SHAPED_SERVICES,
  instanceFile,
  keepAwakeChoice,
  keepAwakeSetting,
  keepAwakeSettingOf,
  keepAwakeValue,
  sameKeepAwake,
  servicePlan,
  usesCompose,
  wantsLidClosedAwake,
  type Deployment,
  type DeploymentShape,
  type KeepAwake,
  type KeepAwakeConfig,
  type KeepAwakeSetting,
  type ServiceName,
} from "@foldedspacelabs/metistry-core";
import { applyKeepAwakeToYaml, applyShapeToYaml, loadDeployment } from "./deployment.js";
import { composeRows, launchdRows } from "./doctor.js";
import { realExec, type Exec } from "./exec.js";
import { serviceOf } from "./launchd.js";
import { protectedRel, writeProtected } from "./protected-write.js";
import { StepRunner } from "./steps.js";
import { defaultUi, type Ui } from "./ui.js";

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
  /** this install's power policy; `never` when the question has not been answered (docs/ops/deployment-shapes.md) */
  keep_awake: KeepAwake;
  /**
   * The same setting as its switch and two sub-switches (T4-20) — exact where
   * `keep_awake` is the nearest value: the lid sub-switch is only here.
   */
  keep_awake_setting: KeepAwakeSetting;
  /**
   * Said here as well as in doctor, because `metistry deployment` is the cheap
   * read the app and the wizard make before offering to change anything: the
   * fourth value is accepted and is not deliverable in full without an
   * administrator change the user makes themselves.
   */
  keep_awake_note?: string;
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
  const setting = keepAwakeSettingOf(loaded.deployment);
  const note = keepAwakeNote(setting, loaded.deployment.shape, platform);
  return {
    shape: loaded.deployment.shape,
    from: loaded.from,
    keep_awake: keepAwakeValue(setting),
    keep_awake_setting: setting,
    ...(note ? { keep_awake_note: note } : {}),
    services,
  };
}

/**
 * The one sentence this install's power policy needs beyond its own name, or
 * nothing. Takes either spelling. The lid sentence stays until doctor — which
 * reads `pmset -g`, this cheap read does not — finds the administrator setting
 * in effect.
 */
export function keepAwakeNote(keepAwake: KeepAwakeConfig | KeepAwakeSetting, shape: DeploymentShape, platform: NodeJS.Platform): string | undefined {
  const s = keepAwakeSetting(keepAwake);
  if (platform !== "darwin") return s.enabled ? "keep_awake is a macOS setting; nothing on this platform holds a power assertion" : undefined;
  if (!s.enabled) return undefined;
  if (shape === "compose") return "the compose shape has no supervisor to hold the assertion, so nothing is held (docs/ops/deployment-shapes.md)";
  if (wantsLidClosedAwake(s)) return `${LID_CLOSED_NOT_AVAILABLE} \`metistry doctor\` says whether it is in effect.`;
  return undefined;
}

/**
 * The lid dialog (plan §2.15, ruling 3) as lines a terminal prints: the
 * title, the command with how to run it, how to undo it, and the warning.
 * The CLI prints it BEFORE it stores `sleep_lid_closed: false`, the same way
 * it prints what any other choice costs — and runs nothing.
 */
export function lidClosedDialog(setting: KeepAwakeSetting): string[] {
  return [
    `${LID_CLOSED_DIALOG_TITLE}.`,
    `  to turn it on, in Terminal as an administrator: ${LID_CLOSED_COMMAND}`,
    `  to undo it: ${LID_CLOSED_UNDO}`,
    `  ${LID_CLOSED_WARNING}`,
    // SleepDisabled is not a lid switch: it stops every sleep, so it overrides
    // the battery sub-switch too — said here, not discovered on a train
    ...(setting.sleep_on_battery ? ["  With it on, this Mac does not sleep on battery either: the administrator setting overrides sleep_on_battery."] : []),
    "Metistry stores your answer and never runs either command; `metistry doctor` says whether the setting is in effect.",
  ];
}

/**
 * One table (docs/ops/cli-style.md): the shape it read and where from, this
 * install's power policy with whatever caveat that policy carries, then a
 * row per service with the filled/hollow icon for running — `n/a` where the
 * state is not cheaply knowable (a launchd job off macOS, a compose one
 * where nothing uses compose), never a bare `?`.
 */
export function renderDeploymentReport(report: DeploymentReport, ui: Ui = defaultUi()): string {
  const running = (s: DeploymentServiceRow): string =>
    s.running === undefined ? `${ui.paint("n/a", ui.icon("off"))} ${ui.dim("n/a")}` : s.running ? `${ui.paint("ok", ui.icon("on"))} yes` : `${ui.paint("n/a", ui.icon("off"))} no`;
  const rows = report.services.map((s) => [s.name, s.shape, s.enabled ? "yes" : ui.dim("no"), running(s)]);
  return [
    ui.kv(
      [
        ["shape", `${report.shape}  ${ui.dim(`(from ${report.from})`)}`],
        ["keep_awake", `${report.keep_awake}${lidSuffix(report.keep_awake_setting)}${report.keep_awake_note ? `  ${ui.dim(`— ${report.keep_awake_note}`)}` : ""}`],
      ],
      { indent: 0 },
    ),
    "",
    ui.table(["service", "shape", "enabled", "running"], rows, { ragged: [] }),
  ].join("\n");
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

  const path = instanceFile(opts.instanceDir, "deployment");
  const existing = existsSync(path) ? await readFile(path, "utf8") : undefined;
  const content = applyShapeToYaml(existing, opts.targetShape);
  const delivery = await writeProtected(r, protectedRel(opts.instanceDir, "deployment"), content, `metistry deployment set-shape → ${opts.targetShape}`, {
    env: opts.env,
    platform: opts.platform,
    uid: opts.uid,
    fetchFn: opts.fetchFn,
    instanceDir: opts.instanceDir,
  });
  return { shape: opts.targetShape, applied: !r.dryRun && delivery.how !== "none", refused: false, detail: delivery.detail };
}

// ---- set-keep-awake ---------------------------------------------------------

/** `allow_sleep_on_battery` is the nearest value for the one object no value names — say its lid half beside it. */
function lidSuffix(s: KeepAwakeSetting): string {
  return wantsLidClosedAwake(s) && keepAwakeValue(s) !== "always_lid_closed" ? " (and awake with the lid closed)" : "";
}

/** The sub-switches a `set-keep-awake` flag may set; `undefined` = leave it as it is. */
export type KeepAwakeFlags = Partial<KeepAwakeSetting>;

export interface SetKeepAwakeOptions {
  productDir: string;
  instanceDir: string;
  /** one of the four values; written as itself when no flag is given */
  keepAwake?: KeepAwake | undefined;
  /**
   * `--enabled` / `--sleep-on-battery` / `--sleep-lid-closed`: applied over
   * `keepAwake` when it is given, else over the setting already in effect, and
   * written as the object form (T4-20). The Services pane's switch and its
   * two sub-switches, each one call that changes only what it names.
   */
  set?: KeepAwakeFlags | undefined;
  /** without it nothing is written — the preview is the whole command */
  yes?: boolean | undefined;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  fetchFn: typeof fetch;
  exec?: Exec | undefined;
  out: (line: string) => void;
}

export interface SetKeepAwakeResult {
  /** the nearest named value — what the holder is told */
  keep_awake: KeepAwake;
  /** exactly what is stored, as the one shape */
  keep_awake_setting: KeepAwakeSetting;
  applied: boolean;
  detail: string;
  /** the honest sentence for this value on this install, when there is one */
  note?: string;
}

/**
 * `metistry deployment set-keep-awake [<value>] [--enabled|--sleep-on-battery|--sleep-lid-closed true|false]`.
 *
 * The same path `set-shape` takes, for the same reason: `deployment.yaml` is a
 * §4.7 protected path, so the write goes through the reconciler as the `user`
 * principal (invariant 2 — how the system behaves is a human change), and it
 * is preview-then-confirm, with `--yes` as the confirmation.
 *
 * It does NOT refuse while services are running, and the difference from
 * `set-shape` is real rather than an oversight: flipping the shape under a
 * running Postgres orphans its data, while changing the power policy changes
 * nothing that is already running. It takes effect at the supervisor's next
 * start, and says so — the value reaches the holder through `supervisor.json`,
 * which `metistry up` writes.
 *
 * THE LID. `sleep_lid_closed: false` is stored as asked (ruling 3), and the
 * administrator steps and the warning are printed before it is — this verb
 * runs no `pmset` at all, let alone the one that writes.
 */
export async function setKeepAwake(opts: SetKeepAwakeOptions): Promise<SetKeepAwakeResult> {
  const exec = opts.exec ?? realExec;
  const r = new StepRunner({ dryRun: opts.yes !== true, out: opts.out, exec, env: opts.env });
  const current = await loadDeployment(opts.productDir, opts.env);
  const flags = Object.fromEntries(Object.entries(opts.set ?? {}).filter(([, v]) => v !== undefined)) as KeepAwakeFlags;
  const flagged = Object.keys(flags).length > 0;
  if (opts.keepAwake === undefined && !flagged) throw new Error("name a value or at least one of --enabled, --sleep-on-battery, --sleep-lid-closed");

  const base = opts.keepAwake !== undefined ? keepAwakeSetting(opts.keepAwake) : keepAwakeSettingOf(current.deployment);
  const target: KeepAwakeSetting = { ...base, ...flags };
  // a value alone is written as itself, so a file that only ever used the
  // four values keeps reading that way; a flag writes the object
  const config: KeepAwakeConfig = flagged ? target : opts.keepAwake!;
  const value = keepAwakeValue(target);
  const note = keepAwakeNote(target, current.deployment.shape, opts.platform);
  const said = flagged ? `{ enabled: ${target.enabled}, sleep_on_battery: ${target.sleep_on_battery}, sleep_lid_closed: ${target.sleep_lid_closed} }` : value;

  if (current.deployment.keep_awake !== undefined && sameKeepAwake(keepAwakeSettingOf(current.deployment), target)) {
    const detail = `already keep_awake: ${said} (from ${current.from}) — nothing to change`;
    r.note(detail);
    return { keep_awake: value, keep_awake_setting: target, applied: false, detail, ...(note ? { note } : {}) };
  }

  // What this choice costs, printed BEFORE it is written — the informed half
  // of informed consent, in the same words the onboarding question uses.
  r.note(`${keepAwakeChoice(value).label}${lidSuffix(target)}: ${keepAwakeChoice(value).consequence}`);
  const lidDialog = wantsLidClosedAwake(target) && opts.platform === "darwin";
  if (lidDialog) for (const line of lidClosedDialog(target)) r.note(line);
  // on a launchd install the note IS the lid sentence, which the dialog just said
  if (note && !(lidDialog && current.deployment.shape !== "compose")) r.note(note);

  const path = instanceFile(opts.instanceDir, "deployment");
  const existing = existsSync(path) ? await readFile(path, "utf8") : undefined;
  const content = applyKeepAwakeToYaml(existing, config, current.deployment.shape);
  const delivery = await writeProtected(r, protectedRel(opts.instanceDir, "deployment"), content, `metistry deployment set-keep-awake → ${said}`, {
    env: opts.env,
    platform: opts.platform,
    uid: opts.uid,
    fetchFn: opts.fetchFn,
    instanceDir: opts.instanceDir,
  });
  r.note("it takes effect when the supervisor next starts: `metistry up` (which rewrites supervisor.json) — nothing running changes underneath you");
  return { keep_awake: value, keep_awake_setting: target, applied: !r.dryRun && delivery.how !== "none", detail: delivery.detail, ...(note ? { note } : {}) };
}
