// `metistry update`, finished by the release it installed.
//
// In release mode the `metistry` shim execs `current/packages/cli/dist/main.js`
// — the release the install is RUNNING, which is the one an update is about
// to leave. So everything after the switch (migrations, restart, the owner
// bearer, the lock, templates, secrets) used to run on the old release's
// code, and a fix to any of those steps only took effect on the NEXT update:
// the 0.14.1 fixes needed three runs to land (0.12.0 → 0.14.0 → 0.14.1).
//
// The fix is boring on purpose. Once `current` points at the new release and
// its pack has been verified (and its bundled runtime unpacked — the child
// runs on that Node), `update` re-executes the NEW release's CLI:
//
//   node current/packages/cli/dist/main.js update --continue-from=switched …
//
// with the same environment plus a marker, streams its output, and exits
// with its code. The child skips the product step (it has happened) and runs
// everything after it on the new code.
//
// Three guards:
//   - capability: a release whose CLI predates this module does not know
//     `--continue-from` (and this CLI ignores flags it does not know — it
//     would run a whole second update), so the parent only hands over when
//     the release carries this module's compiled file. A downgrade onto such
//     a release finishes on the running code, as before.
//   - loop: the child's environment carries METISTRY_UPDATE_REEXEC=1, and an
//     update that sees it never re-executes again.
//   - a child that never started (a bad pack: node cannot load it) did
//     nothing, so the parent finishes the update itself and says so loudly.
//     "Started" is not guessed from the exit code — a child that ran and
//     failed exits 1 too — it is a file the child writes before its first
//     step (METISTRY_UPDATE_REEXEC_ACK). A child that started and failed is
//     never re-run by the parent: its exit code is the answer.

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepRunner } from "./steps.js";
import { nodeFor } from "./up.js";

/** Set (to "1") in the re-executed child's environment; an update that sees it never re-executes again. */
export const UPDATE_REEXEC_ENV = "METISTRY_UPDATE_REEXEC";
/** A file path the child writes before its first step — how the parent tells "started, then failed" from "never started". */
export const UPDATE_REEXEC_ACK_ENV = "METISTRY_UPDATE_REEXEC_ACK";

/** Where a re-executed `update` picks up. One value today: right after the product step's switch. */
export type ContinueFrom = "switched";
export const CONTINUE_FROM_VALUES: readonly ContinueFrom[] = ["switched"];

/**
 * The compiled name of THIS module. A release that ships it understands
 * `--continue-from`; one that does not predates it. update-reexec.test.ts
 * holds this to the module's real file name.
 */
export const REEXEC_CAPABILITY_FILE = "update-reexec.js";

/** Flags `update` sets on the child itself, never forwarded from the parent's command line. */
const OWN_FLAGS = new Set(["continue-from", "no-reexec", "product-dir", "channel"]);

/** `--continue-from` — anything but a known step is a typo, not a guess. */
export function parseContinueFrom(v: string | true | undefined): ContinueFrom | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string" && (CONTINUE_FROM_VALUES as readonly string[]).includes(v)) return v as ContinueFrom;
  throw new Error(`--continue-from must be ${CONTINUE_FROM_VALUES.join(" or ")}, not ${JSON.stringify(v === true ? "" : v)}`);
}

/** The new release's CLI entry point — the same file the `metistry` shim execs. */
export function releaseCliMain(runDir: string): string {
  return join(runDir, "packages", "cli", "dist", "main.js");
}

/** Does the release at `runDir` carry a CLI that understands `--continue-from`? */
export function supportsContinuation(runDir: string, exists: (p: string) => boolean = existsSync): boolean {
  return exists(join(runDir, "packages", "cli", "dist", REEXEC_CAPABILITY_FILE));
}

/**
 * The child's argv (after `node`): the new CLI, `update`, every flag the
 * owner gave except the ones this sets itself, then those — last, so they
 * win (`parseArgs` keeps the last value). Flags are forwarded as
 * `--name=value`, which parses the same whatever the value looks like.
 */
export function continuationArgs(main: string, flags: Record<string, string | true>, productDir: string): string[] {
  const forwarded = Object.entries(flags)
    .filter(([k]) => !OWN_FLAGS.has(k))
    .map(([k, v]) => (v === true ? `--${k}` : `--${k}=${v}`));
  return [main, "update", ...forwarded, "--continue-from=switched", "--channel=release", `--product-dir=${productDir}`];
}

/** The child's half of the handshake: say "started" before the first step. Never fails the update over it. */
export async function acknowledgeContinuation(env: NodeJS.ProcessEnv): Promise<void> {
  const path = env[UPDATE_REEXEC_ACK_ENV];
  if (!path) return;
  await writeFile(path, `${process.pid}\n`).catch(() => {});
}

export interface ReexecOutcome {
  /** continued: the new CLI ran the rest (its code is `code`); skipped: not attempted; fell-back: attempted, and the new CLI never started */
  status: "continued" | "skipped" | "fell-back";
  /** the child's exit code (continued), or how it failed to start (fell-back) */
  code?: number | undefined;
  /** why, in the words printed */
  reason: string;
}

export interface ReexecOptions {
  productDir: string;
  /** `<product-dir>/current`, now pointing at the new release */
  runDir: string;
  /** the release `current` now points at */
  version: string;
  /** the release this process is (the one being left) */
  runningVersion: string;
  /** the owner's own flags, to forward */
  flags: Record<string, string | true>;
  env: NodeJS.ProcessEnv;
  /** `--no-reexec` */
  disabled?: boolean | undefined;
  exists?: ((p: string) => boolean) | undefined;
  /** test seam: where the handshake file's directory is made (default: os.tmpdir()) */
  tmpDir?: string | undefined;
}

/**
 * Hand the rest of this update to the release it just switched to. Returns
 * `continued` with the child's exit code — the caller stops and returns it —
 * or `skipped` / `fell-back`, and the caller finishes the update itself.
 */
export async function reexecIntoRelease(r: StepRunner, o: ReexecOptions): Promise<ReexecOutcome> {
  const exists = o.exists ?? existsSync;
  const skip = (reason: string): ReexecOutcome => {
    r.note(reason);
    return { status: "skipped", reason };
  };
  if (o.disabled) return skip(`--no-reexec: the rest of this update runs on ${o.runningVersion}'s code (the release being left), not ${o.version}'s — a debugging switch; a standalone \`metistry doctor\` afterwards is the new release's verdict`);
  if (o.env[UPDATE_REEXEC_ENV]) {
    return skip(`${r.ui.paint("failed", `${r.ui.icon("warn")} ${UPDATE_REEXEC_ENV} is set`)} — this is already a re-executed update, and it never hands over a second time; the rest runs on this process's code`);
  }
  if (!supportsContinuation(o.runDir, exists)) {
    return skip(`${o.version}'s CLI predates the hand-over (no packages/cli/dist/${REEXEC_CAPABILITY_FILE}) — the rest of this update runs on ${o.runningVersion}'s code`);
  }
  const main = releaseCliMain(o.runDir);
  const { node } = nodeFor(o.productDir, o.env, exists);
  const args = continuationArgs(main, o.flags, o.productDir);

  const dir = await mkdtemp(join(o.tmpDir ?? tmpdir(), "metistry-update-"));
  const ack = join(dir, "started");
  try {
    r.note(`handing over to ${o.version}'s own CLI — build, migrations, restart, lock and doctor run on the release just installed, not on ${o.runningVersion}`);
    let code: number;
    try {
      // no timeout: the child owns its own step timeouts, and one that
      // killed it mid-restart would leave the install worse than either
      const res = await r.run(node, args, { inherit: true, tolerateFailure: true, env: { ...o.env, [UPDATE_REEXEC_ENV]: "1", [UPDATE_REEXEC_ACK_ENV]: ack }, comment: `${o.version} finishes the update` });
      code = res.code;
    } catch {
      code = 127; // the exec seam could not spawn it at all
    }
    if (existsSync(ack)) return { status: "continued", code, reason: `${o.version}'s CLI ran the rest of the update (exit ${code})` };
    const reason = `${o.version}'s CLI did not start (exit ${code}) — the rest of this update runs on ${o.runningVersion}'s code instead`;
    r.out(`${r.ui.paint("failed", `${r.ui.icon("fail")} ${reason}`)}`);
    return { status: "fell-back", code, reason };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
