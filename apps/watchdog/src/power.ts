// Keeping the Mac awake: the holder, and the loop that decides whether to.
//
// The supervisor is the right process to own this. It is `runs_on: host`, it
// is `KeepAlive`, and it outlives everything it watches — so an assertion tied
// to ITS lifetime is tied to the install's. The Mac app is not: it is a
// window, and the promise is "running with no window open".
//
// WHAT IS HELD. `caffeinate -i -w <supervisor pid>`, which is exactly
// `IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleSystemSleep)` —
// `caffeinate` is a thin wrapper over the same IOKit call, so the choice is
// which process holds it, not capability, and invariant 6 settles it: macOS
// does not require native code here. Never `-d` (that pins the display, which
// the user notices and did not ask for) and never `-s` (deprecated, and
// AC-only anyway).
//
// WHY `-w`. "Waits for the process with the specified pid to exit. Once the
// process exits, the assertion is also released" (caffeinate(8)). That holds
// even when the supervisor is SIGKILLed, so the failure this design must not
// have — supervisor killed, launchd starts a new one, the old `caffeinate`
// still running with no owner — cannot happen.
//
// WHY A SEAM. Everything the holder does goes through `PowerHolder`, and the
// `caffeinate` implementation is one class behind it. The research doc's
// option B — a ~40-line signed Swift binary whose assertion NAME is the
// assistant's, so `pmset -g` stops answering "caffeinate" — is a swap of this
// one class, not a rewrite of the loop above it. That swap is the owner's
// ruling to make (invariant 6); the seam is here so it stays a swap.
//
// WHAT IT NEVER DOES. It never writes a `pmset` setting (every `pmset` call
// here is `-g ps`, a read), never touches another process's assertion (there
// is no API that would let it: `IOPMAssertionRelease` is id-scoped to the
// creator), and never claims another holder's assertion as ours — doctor
// matches OUR recorded pid, never "is any caffeinate running".

import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  KEEP_AWAKE_CUTOFF_FACTOR,
  RESTART_BACKOFF_MAX_MS,
  RESTART_BACKOFF_MS,
  describeKeepAwake,
  humanGap,
  parseKeepAwakeState,
  parsePowerSource,
  shouldHold,
  type KeepAwake,
  type KeepAwakeCutoff,
  type KeepAwakeState,
  type PowerSource,
} from "@foldedspacelabs/metistry-core";

/** Apple's binary, on the sealed read-only system volume, by absolute path — the way this repo already invokes `/usr/bin/sandbox-exec`. We invoke it; we never ship it. */
export const CAFFEINATE_BIN = "/usr/bin/caffeinate";
/** The one read: `pmset -g ps` says which power source this Mac is drawing from. */
export const PMSET_BIN = "/usr/bin/pmset";

/**
 * How often the loop asks. There is no notification-free way to hear "the
 * power source changed" from Node — `IOPSNotificationCreateRunLoopSource` is
 * native — so it polls, and 60s is the same cadence the watchdog's probe loop
 * already runs at. The cost is one `pmset -g ps` fork per minute (~15ms of CPU
 * on the Studio this was measured on) plus one small file write; a laptop
 * unplugged at t keeps the assertion for at most one interval longer.
 */
export const KEEP_AWAKE_INTERVAL_SEC_DEFAULT = 60;

// ---- the holder ------------------------------------------------------------

export interface PowerHolderStatus {
  holding: boolean;
  /** the holding process's pid, when there is one */
  pid?: number | undefined;
  /** epoch ms, when THIS hold started */
  since?: number | undefined;
  /** how many times the child had to be respawned this run */
  restarts: number;
  /** the reason the current hold was taken for, as `hold()` was given it */
  reason?: string | undefined;
}

/**
 * The seam. `hold` is idempotent — calling it while already holding refreshes
 * the reason and does nothing else — and `release` is safe to call when
 * nothing is held.
 */
export interface PowerHolder {
  hold(reason: string): Promise<void>;
  release(): Promise<void>;
  status(): PowerHolderStatus;
}

/** Just enough of a child process for the holder to own one, so a test can hand it a fake. */
export interface HeldProcess {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type PowerSpawner = (argv: string[]) => HeldProcess;

export interface CaffeinateHolderDeps {
  spawn?: PowerSpawner;
  now?: () => number;
  log?: (line: string) => void;
}

function defaultSpawn(argv: string[]): HeldProcess {
  return spawn(argv[0]!, argv.slice(1), { stdio: "ignore", detached: false });
}

/**
 * `caffeinate -i -w <pid>`, kept alive for as long as we want it.
 *
 * The child dying is not fatal and not silent: it is respawned on the same
 * exponential backoff the supervisor uses for its children, and the restart
 * count reaches doctor through the state file.
 */
export class CaffeinateHolder implements PowerHolder {
  private child: HeldProcess | undefined;
  private wanted = false;
  private reason: string | undefined;
  private since: number | undefined;
  private restarts = 0;
  private backoffMs = RESTART_BACKOFF_MS;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly spawn: PowerSpawner;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(
    /** the pid `-w` watches: the supervisor's own, so the assertion dies with the install even under SIGKILL */
    public readonly watchPid: number,
    deps: CaffeinateHolderDeps = {},
  ) {
    this.spawn = deps.spawn ?? defaultSpawn;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((l) => console.log(l));
  }

  argv(): string[] {
    return [CAFFEINATE_BIN, "-i", "-w", String(this.watchPid)];
  }

  async hold(reason: string): Promise<void> {
    this.reason = reason;
    if (this.wanted && this.child) return;
    this.wanted = true;
    this.start();
  }

  async release(): Promise<void> {
    this.wanted = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    this.since = undefined;
    if (!child) return;
    child.kill("SIGTERM");
    this.log(`[keep-awake] released (pid ${child.pid ?? "?"})`);
  }

  status(): PowerHolderStatus {
    return {
      holding: this.child !== undefined,
      pid: this.child?.pid,
      since: this.since,
      restarts: this.restarts,
      reason: this.reason,
    };
  }

  private start(): void {
    if (this.child) return;
    let child: HeldProcess;
    try {
      child = this.spawn(this.argv());
    } catch (err) {
      // a Mac with no /usr/bin/caffeinate is not a Mac; still, this must not
      // take the supervisor down — doctor reports the row as degraded
      this.log(`[keep-awake] could not start ${CAFFEINATE_BIN}: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.since = this.now();
    this.log(`[keep-awake] holding PreventUserIdleSystemSleep — ${this.argv().join(" ")} (pid ${child.pid ?? "?"})`);
    child.once("exit", (code, signal) => {
      if (this.child !== child) return; // already released and replaced
      this.child = undefined;
      this.since = undefined;
      if (!this.wanted) return;
      this.restarts += 1;
      this.log(`[keep-awake] holder exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}) — restarting in ${this.backoffMs}ms`);
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (!this.wanted || this.timer) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RESTART_BACKOFF_MAX_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.wanted) this.start();
    }, wait);
    this.timer.unref?.();
  }
}

// ---- the loop --------------------------------------------------------------

export type PowerProbe = () => Promise<PowerSource>;

/** `pmset -g ps`, read-only. A Mac that will not answer reads as `unknown`, which counts as wall power. */
export const realPowerProbe: PowerProbe = () =>
  new Promise((resolve) => {
    execFile(PMSET_BIN, ["-g", "ps"], { timeout: 5_000 }, (err, stdout) => resolve(err ? "unknown" : parsePowerSource(String(stdout))));
  });

export interface KeepAwakeOptions {
  setting: KeepAwake;
  /** the supervisor's own pid — what `-w` watches and what doctor matches */
  supervisorPid: number;
  /** templated from identity.yaml (core's `keepAwakeReason`) */
  reason: string;
  /** `<instance>/.metistry/state/run/keep-awake.json` */
  statePath: string;
  intervalMs: number;
}

export interface KeepAwakeDeps {
  holder?: PowerHolder;
  power?: PowerProbe;
  now?: () => number;
  log?: (line: string) => void;
  /** test seam: where the state file goes (default: the real write) */
  writeState?: (path: string, state: KeepAwakeState) => Promise<void>;
  readState?: (path: string) => Promise<KeepAwakeState | undefined>;
}

async function defaultWriteState(path: string, state: KeepAwakeState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function defaultReadState(path: string): Promise<KeepAwakeState | undefined> {
  try {
    return parseKeepAwakeState(JSON.parse(await readFile(path, "utf8")));
  } catch {
    // missing, truncated, or not JSON: there is simply no previous word
    return undefined;
  }
}

/**
 * The loop: evaluate, hold or release, write the file, repeat.
 *
 * It is also the early-cutoff detector (the owner's ruling E). The holder
 * compares wall clocks between its OWN ticks: a process that was running the
 * whole time and finds `Date.now()` has jumped by minutes was suspended, and
 * on a Mac that means the machine slept. That is the honest signal — a gap
 * ACROSS a restart proves only that the supervisor was not running, which is
 * what `metistry stop`, a logout and a reboot all look like — so a cutoff is
 * only ever recorded from inside a run, and carried forward across restarts so
 * doctor still reports the last one.
 */
export class KeepAwakeLoop {
  private readonly holder: PowerHolder;
  private readonly power: PowerProbe;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly writeState: (path: string, state: KeepAwakeState) => Promise<void>;
  private readonly readState: (path: string) => Promise<KeepAwakeState | undefined>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastTickAt: number | undefined;
  private lastTickHeld = false;
  private lastSource: PowerSource = "unknown";
  private cutoff: KeepAwakeCutoff | undefined;
  private stopped = false;

  constructor(
    public readonly options: KeepAwakeOptions,
    deps: KeepAwakeDeps = {},
  ) {
    this.holder = deps.holder ?? new CaffeinateHolder(options.supervisorPid, { ...(deps.now ? { now: deps.now } : {}), ...(deps.log ? { log: deps.log } : {}) });
    this.power = deps.power ?? realPowerProbe;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((l) => console.log(l));
    this.writeState = deps.writeState ?? defaultWriteState;
    this.readState = deps.readState ?? defaultReadState;
  }

  /** One evaluation now, then every `intervalMs`. Returns the state it wrote, so `start()` is testable without a timer. */
  async start(): Promise<KeepAwakeState> {
    // Carry the previous run's cutoff forward, but only while it is still
    // about the policy in force: a user who answered the question differently
    // has acted, and being shown a finding about the setting they replaced
    // would be the software arguing with them.
    const previous = await this.readState(this.options.statePath);
    if (previous?.last_cutoff && previous.last_cutoff.mode === this.options.setting) this.cutoff = previous.last_cutoff;
    const state = await this.tick();
    this.timer = setInterval(() => void this.tick().catch((err) => this.log(`[keep-awake] tick failed: ${err instanceof Error ? err.message : String(err)}`)), this.options.intervalMs);
    this.timer.unref?.();
    return state;
  }

  /** One evaluation: read the power source, hold or release, write the file. */
  async tick(): Promise<KeepAwakeState> {
    const at = this.now();
    const source = this.options.setting === "never" ? "unknown" : await this.power();
    this.detectCutoff(at);
    const want = shouldHold(this.options.setting, source);
    const was = this.holder.status().holding;
    if (want) await this.holder.hold(this.options.reason);
    else await this.holder.release();
    if (want !== was) this.log(`[keep-awake] ${describeKeepAwake(this.options.setting, source)}`);
    this.lastTickAt = at;
    this.lastTickHeld = want;
    this.lastSource = source;
    return this.writeNow(at, source);
  }

  /**
   * A tick that arrived `KEEP_AWAKE_CUTOFF_FACTOR` intervals late, while we
   * were holding, is the Mac having slept under us anyway — lid closed, a
   * scheduled sleep, the Apple menu, or another policy winning. Recorded with
   * the mode and power source that were live at the time, so the finding
   * cannot outlive the policy it is about.
   */
  private detectCutoff(at: number): void {
    if (this.lastTickAt === undefined || !this.lastTickHeld) return;
    const gap = at - this.lastTickAt;
    if (gap <= this.options.intervalMs * KEEP_AWAKE_CUTOFF_FACTOR) return;
    this.cutoff = {
      at: new Date(at).toISOString(),
      from: new Date(this.lastTickAt).toISOString(),
      gap_ms: gap,
      mode: this.options.setting,
      power_source: this.lastSource,
    };
    this.log(
      `[keep-awake] this Mac slept for about ${humanGap(gap)} while keep_awake: ${this.options.setting} was set — ` +
        `an idle-sleep assertion does not stop lid close, a scheduled sleep or the Apple menu (doctor reports this)`,
    );
  }

  /** SIGTERM: release, and say so in the file, so the gap that follows is never read as a sleep. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.holder.release();
    const at = this.now();
    await this.writeNow(at, this.lastSource, new Date(at).toISOString());
  }

  status(): PowerHolderStatus {
    return this.holder.status();
  }

  private async writeNow(at: number, source: PowerSource, stoppedAt?: string): Promise<KeepAwakeState> {
    const held = this.holder.status();
    const state: KeepAwakeState = {
      schema: 1,
      mode: this.options.setting,
      holding: held.holding,
      ...(held.pid !== undefined ? { pid: held.pid } : {}),
      ...(held.since !== undefined ? { since: new Date(held.since).toISOString() } : {}),
      power_source: source,
      reason: this.options.reason,
      supervisor_pid: this.options.supervisorPid,
      heartbeat_at: new Date(at).toISOString(),
      interval_ms: this.options.intervalMs,
      restarts: held.restarts,
      ...(stoppedAt ? { stopped_at: stoppedAt } : {}),
      ...(this.cutoff ? { last_cutoff: this.cutoff } : {}),
    };
    try {
      await this.writeState(this.options.statePath, state);
    } catch (err) {
      // the file is how doctor reports; failing to write it must not stop us
      // holding, which is the thing the user actually asked for
      this.log(`[keep-awake] could not write ${this.options.statePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return state;
  }
}
