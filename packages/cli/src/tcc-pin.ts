// The two Developer-ID-signed Swift helper bundles a release does not carry
// (D3, invariant 6): `pack-runtime.sh` copies each `mcp-<name>/helper`, but
// the `.app` bundles inside it are gitignored build output that no release
// runner builds, so a release ships the sources and the Info.plist and
// nothing executable (verified against the installed v0.5.0 pack).
//
// Under the compose shape this never showed, because the two host bridge
// jobs were rendered with `__REPO__` = the git checkout, which is where the
// hand-built bundles live. Re-rendering them against `current/` would point
// both at a path that does not exist.
//
// So this pin keeps the two jobs pointing at the bundles that already hold
// the TCC grant — same bundle id, same certificate chain, therefore the
// same TCC designated requirement, therefore no re-grant
// (docs/ops/apple-signing.md §3). Shipping prebuilt signed helpers in the
// pack is the real fix and is recorded as a follow-up
// (docs/ops/migrate-compose-to-launchd.md, "The TCC helper bundles").
//
// Two callers apply this pin, and both must, every time they render the
// launchd shape:
//
//   `up`             writes the calendar plist and `supervisor.json` on
//                    EVERY run — the release-channel `update` and the
//                    eight-agents-to-one-supervisor conversion both go
//                    through it — so it must re-pin every time too, or a
//                    later `up` silently un-pins what `migrate-shape` set.
//   `migrate-shape`  calls it again after `up (launchd)` for the same
//                    reason, and it is a no-op the second time.
//
// This module exists so both can call it: `migrate-shape.ts` imports
// `up.ts` (for the shared `up()` step and `awaitBootout`), so `up.ts`
// cannot import `migrate-shape.ts` back — the pin had to move somewhere
// both can reach.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { awaitBootout, labelFor, launchAgentsDir, launchdCommands, renderPlist, withEnvironmentVariables, type PlistTemplate } from "./launchd.js";
import { runtimeNodeBin } from "./runtime-deps.js";
import { readSupervisorConfig, serializeSupervisorConfig, supervisorConfigPath, SUPERVISOR_SERVICE } from "./supervisor.js";
import type { StepRunner } from "./steps.js";

export interface TccHelper {
  /** the plist service whose job needs the pin */
  service: string;
  /** the bundle, relative to a product tree */
  bundle: string;
  /** the executable inside the bundle */
  exe: string;
  /** set this variable in the job's environment instead of re-rendering __REPO__ */
  envVar?: string;
}

export const TCC_HELPERS: TccHelper[] = [
  {
    service: "calendar",
    bundle: join("packages", "mcp-eventkit", "helper", "ek-helper.app"),
    exe: join("Contents", "MacOS", "ek-helper"),
  },
  {
    service: "apple-fm",
    bundle: join("packages", "mcp-apple-fm", "helper", "afm-helper.app"),
    exe: join("Contents", "MacOS", "afm-helper"),
    envVar: "METISTRY_AFM_HELPER",
  },
];

/**
 * Everything `pinTccHelpers`/`pinSupervisorChild` need from a caller's
 * larger context — deliberately a small structural subset so both `up.ts`
 * and `migrate-shape.ts`'s own (much bigger) `Ctx` satisfy it without a
 * cast.
 */
export interface TccPinCtx {
  r: StepRunner;
  env: NodeJS.ProcessEnv;
  /** the install root — `.env`, `state/`, `runtime/` live here, never inside a release */
  productDir: string;
  /** the product's files: `current` in release mode — where the plists render `__REPO__` from */
  runDir: string;
  home: string;
  uid: number;
  labelSuffix: string | undefined;
  /** `__ENV_FILE__`: only used when the plist has to be rendered fresh (e.g. it does not exist on disk yet) */
  envFile: string;
}

/** The root the instance's derived state hangs off: the instance repo when there is one, else the install root. */
function supervisorStateRoot(ctx: TccPinCtx): string {
  return ctx.env.METISTRY_INSTANCE_DIR?.replace(/\/+$/, "") || ctx.productDir;
}

/** The child spec `up` wrote for this service, when there is one. */
async function supervisorChild(ctx: TccPinCtx, service: string): Promise<{ name: string } | undefined> {
  const config = await readSupervisorConfig(supervisorConfigPath(supervisorStateRoot(ctx))).catch(() => undefined);
  return config?.children.find((c) => c.name === service);
}

/**
 * Put one variable into a child's environment in `supervisor.json` and,
 * unless the caller is about to kickstart the supervisor itself a moment
 * later anyway, kickstart it here so the pin takes.
 *
 * The same reasoning as patching the plist `up` wrote rather than
 * re-rendering it: the config already carries this instance's namespaced
 * ports and everything else `up` computed, and rebuilding it here could only
 * forget something.
 */
export async function pinSupervisorChild(ctx: TccPinCtx, service: string, envVar: string, value: string, kickstart = true): Promise<void> {
  const path = supervisorConfigPath(supervisorStateRoot(ctx));
  const config = await readSupervisorConfig(path);
  if (!config) {
    ctx.r.note(`${service}: no ${path} — nothing to pin (metistry up writes it)`);
    return;
  }
  const next = {
    ...config,
    children: config.children.map((c) => (c.name === service ? { ...c, env: { ...c.env, [envVar]: value } } : c)),
  };
  await ctx.r.write(path, serializeSupervisorConfig(next), `the config up wrote, plus ${service}'s ${envVar}=${value} (the signed bundle holding the TCC grant; this release carries none)`);
  if (kickstart) {
    await ctx.r.run("launchctl", ["kickstart", "-k", `gui/${ctx.uid}/${labelFor(SUPERVISOR_SERVICE, ctx.labelSuffix)}`], { comment: `${service} restarts with the pinned helper` });
  }
}

/**
 * Pin the two bridge jobs at the signed helper bundles that already hold
 * the TCC grant (see `TCC_HELPERS`).
 *
 * Called from two places: `up`, right after it writes the calendar plist
 * and `supervisor.json` and before it bootstraps/kickstarts them (so the
 * pinned values are what launchd actually loads — no extra kickstart), and
 * `migrate-shape`, again, after its own restore (idempotent either way, and
 * there the supervisor is ALREADY running, so this pin's own kickstart is
 * the only thing that makes the correction take).
 *
 * `bootstrapPinned` is that difference: `up` passes `false` because its own
 * bootstrap loop, a few lines below this call, is about to bootstrap and
 * kickstart every one of these jobs anyway (the calendar agent, and the
 * supervisor for apple-fm's sake) — doing it here too would be a second,
 * redundant restart of jobs that have not even loaded once yet.
 * `migrate-shape` (and any other caller applying the pin standalone, after
 * everything is already running) leaves it `true`, the default: there the
 * pin's own bootstrap/kickstart is the only thing that makes the
 * correction take.
 *
 * A bundle that is not there is a NOTE, not a failure: an install with no
 * calendar bridge is a healthy install (doctor reports `absent`), and
 * failing over a missing Swift binary would be absurd here.
 */
export async function pinTccHelpers(ctx: TccPinCtx, templates: PlistTemplate[], exists: (p: string) => boolean, bootstrapPinned = true): Promise<string[]> {
  const pinned: string[] = [];
  for (const h of TCC_HELPERS) {
    const t = templates.find((x) => x.service === h.service);
    // under the supervisor a bridge is a child, not an agent: it has no plist
    // in ~/Library/LaunchAgents to patch, and its environment lives in the
    // supervisor's config
    const child = t ? undefined : await supervisorChild(ctx, h.service);
    if (!t && !child) continue;
    const inRelease = join(ctx.runDir, h.bundle, h.exe);
    if (exists(inRelease)) {
      ctx.r.note(`${h.service}: ${inRelease} is in this release — no pin needed`);
      continue;
    }
    const onHost = join(ctx.productDir, h.bundle, h.exe);
    if (!exists(onHost)) {
      ctx.r.note(
        `${h.service}: no signed helper at ${onHost} and none in the release — this bridge will not start. ` +
          `Build it (packages/${h.service === "apple-fm" ? "mcp-apple-fm" : "mcp-eventkit"}/scripts/build-helper.sh) and re-run \`metistry up\`; ` +
          `doctor reports the bridge absent until then.`,
      );
      continue;
    }
    if (!t) {
      // a child: one entry in its spec, then the supervisor restarts it
      if (!h.envVar) {
        ctx.r.note(`${h.service}: it is a supervisor child with no environment override — nothing to pin`);
        continue;
      }
      await pinSupervisorChild(ctx, h.service, h.envVar, onHost, bootstrapPinned);
      pinned.push(`${h.service} → ${onHost}`);
      continue;
    }
    // PATCH the plist `up` just wrote — never re-render it from the template.
    //
    // `up` puts more into these files than the three placeholders: this
    // instance's namespaced ports for the jobs that source `.env`, and the
    // bundled git on the reconciler's PATH. A re-render here dropped the
    // ports, and the rehearsal's scratch apple-fm bridge went looking for
    // the DEFAULT 7810 — which is the production install's, and it only
    // failed to take it because production had it (`EADDRINUSE`). Patching
    // what `up` wrote cannot forget something `up` knows.
    const target = join(launchAgentsDir(ctx.home), t.file);
    const written = existsSync(target) && !ctx.r.dryRun ? await readFile(target, "utf8") : renderPlist(t.template, { repo: ctx.runDir, node: runtimeNodeBin(ctx.productDir), envFile: ctx.envFile });
    if (h.envVar) {
      // the bridge is a node service that resolves its helper relative to its
      // own dist/; the override is one added environment entry
      await ctx.r.write(target, withEnvironmentVariables(written, { [h.envVar]: onHost }), `the plist up wrote, plus ${h.envVar}=${onHost} (the signed bundle holding the TCC grant; this release carries none)`);
    } else {
      // the helper IS the job's root process — that is what the TCC grant
      // attaches to — so its path is in ProgramArguments, and only there
      const from = join(ctx.runDir, h.bundle);
      const to = join(ctx.productDir, h.bundle);
      if (!written.includes(from)) {
        ctx.r.note(`${h.service}: ${target} does not name ${from} — leaving it alone rather than guessing`);
        continue;
      }
      await ctx.r.write(target, written.split(from).join(to), `the plist up wrote, with ${from} → ${to} (the signed bundle holding the TCC grant; this release carries none)`);
    }
    // the SAME sequence `up` installs a job with, wait included: `bootout` is
    // asynchronous, and bootstrapping the label straight after races launchd
    // and fails `Bootstrap failed: 5: Input/output error` (#117's fourth
    // defect — and this section reproduced it exactly once by hand-rolling
    // the three commands). Skipped when the caller is about to run this same
    // sequence itself a moment later (`up`, via `bootstrapPinned: false`) —
    // patching the file on disk is enough; nothing has loaded it yet.
    if (bootstrapPinned) {
      const label = labelFor(h.service, ctx.labelSuffix);
      for (const c of launchdCommands(label, target, ctx.uid)) {
        if (c.awaitGone) {
          await awaitBootout(ctx.r, label, ctx.uid);
          continue;
        }
        await ctx.r.run(c.cmd, c.args, { tolerateFailure: c.tolerateFailure, comment: c.tolerateFailure ? "ok if not loaded" : undefined });
      }
    }
    pinned.push(`${h.service} → ${onHost}`);
  }
  return pinned;
}
