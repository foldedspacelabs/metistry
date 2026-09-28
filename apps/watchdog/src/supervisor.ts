// The supervisor: one launchd agent, several children.
//
// macOS names a background item after the agent's executable, so five agents
// meant five System Settings entries called "postgres" and "node". This
// process is the only agent the core installs — it is the file named
// `Metistry` — and it runs Postgres, the console, the reconciler, the
// assistant (still rooted at `sandbox-exec`, exactly as its plist did) and
// any enabled bridges as children of its own.
//
// It is the watchdog grown up, not a new component: the liveness probes and
// the presence feed keep running in the same process (invariant 3's sole
// exception stays where it was). What is new is child supervision:
//
//   ordered start   each child with a readiness probe gates the next one
//                   (Postgres answers → console → reconciler → assistant)
//   restart policy  exponential backoff per child, reset once it has been up
//                   a while, and crash-looping is REPORTED rather than
//                   silently hammered
//   graceful stop   SIGTERM, wait its grace period, SIGKILL; children are
//                   stopped in reverse order
//   per-child logs  the same /tmp/metistry-<service>.log paths `metistry
//                   logs` has always tailed, appended to
//
// Everything here takes its spawn/now/sleep from the constructor so the
// tests drive it with fakes rather than real processes.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { connect } from "node:net";
import {
  CRASH_LOOP_RESTARTS,
  CRASH_LOOP_WINDOW_MS,
  RESTART_BACKOFF_MAX_MS,
  RESTART_BACKOFF_MS,
  RESTART_HEALTHY_MS,
  type ChildSpec,
  type ChildStatus,
  type SupervisorConfig,
} from "@foldedspacelabs/metistry-core";

export type Spawner = (spec: ChildSpec, stdio: number | "ignore") => ChildProcess;

/**
 * THE RESTART RACE (owner's 0.14.2 instance). `metistry up` and `restart`
 * kickstart this job while the PREVIOUS supervisor's children may still be
 * exiting — launchd has let go of the old supervisor, but its reconciler is
 * still holding 7812 for a moment. The new reconciler died on
 * `listen EADDRINUSE` three times in two seconds, which is a crash loop by
 * the numbers, and the child sat at the 60 s ceiling for no fault of its own.
 *
 * So: for STARTUP_GRACE_MS after this supervisor starts, a child that exits
 * early having logged a port it could not take (EADDRINUSE, or EPERM on a
 * listen) is retried every PORT_BUSY_RETRY_MS and does NOT count toward
 * CRASH_LOOP_RESTARTS. Every other exit, and any exit after the window, is
 * counted exactly as before — a profile that really forbids the listen
 * still ends up `crash-looping` and named in doctor, just 30 s later.
 */
export const STARTUP_GRACE_MS = 30_000; // limit: fixed — covers a previous generation's graceful stop (children stop in reverse, each with its own grace)
export const PORT_BUSY_RETRY_MS = 500; // limit: fixed — a poll for a port to free, not a policy
/** What a child that could not take its port writes: node's EADDRINUSE / EPERM, and Postgres' "could not bind … Address already in use". */
export const PORT_BUSY_PATTERN = /\bEADDRINUSE\b|\blisten EPERM\b|Address already in use/;
/** How much of a child's log, from where this spawn started writing, is read to classify its exit. */
const PORT_BUSY_READ_BYTES = 16 * 1024;

export interface SupervisorDeps {
  spawn?: Spawner;
  now?: () => number;
  /** resolves when the port answers, false on timeout — the ordered-start gate */
  probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  log?: (line: string) => void;
  /** test seam: the per-child log file descriptor (default: append to spec.log) */
  openLog?: (path: string) => number | "ignore";
  /** test seam: how many bytes the child's log holds now (default: its size on disk, 0 when absent) */
  logSize?: (path: string) => number;
  /** test seam: what the child's log gained since `offset` (default: read it, at most 16 KiB) */
  readLogSince?: (path: string, offset: number) => string;
}

interface ChildRuntime {
  spec: ChildSpec;
  proc?: ChildProcess | undefined;
  state: ChildStatus["state"];
  startedAt?: number | undefined;
  restarts: number;
  /** restart timestamps inside the crash-loop window */
  recent: number[];
  backoffMs: number;
  lastExit?: ChildStatus["lastExit"] | undefined;
  /** set while a deliberate stop is in flight, so the exit handler does not restart it */
  stopping?: boolean | undefined;
  /** the child log's size when this process was spawned: what it wrote is after this */
  logOffset?: number | undefined;
  /** early exits on a port the previous generation still held — retried, not counted (STARTUP_GRACE_MS) */
  portRetries: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

/** Append to the child's log file, creating it. `metistry logs <service>` tails exactly this path. */
function defaultOpenLog(path: string): number | "ignore" {
  try {
    return openSync(path, "a");
  } catch {
    return "ignore";
  }
}

function defaultLogSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function defaultReadLogSince(path: string, offset: number): string {
  try {
    const size = statSync(path).size;
    const from = Math.max(offset, size - PORT_BUSY_READ_BYTES);
    if (size <= from) return "";
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - from);
      readSync(fd, buf, 0, buf.length, from);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

function defaultSpawn(spec: ChildSpec, stdio: number | "ignore"): ChildProcess {
  return nodeSpawn(spec.argv[0]!, spec.argv.slice(1), {
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    // the child's environment is the spec's, whole — never this process's
    env: spec.env,
    stdio: ["ignore", stdio, stdio],
    // its own process group, so a SIGTERM to the supervisor does not race
    // launchd's own signal delivery to the whole job
    detached: false,
  });
}

/** A TCP connect that either succeeds inside the budget or answers false — no throwing, no retry storm. */
export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export class Supervisor {
  private readonly children = new Map<string, ChildRuntime>();
  private readonly order: string[];
  private readonly spawn: Spawner;
  private readonly now: () => number;
  private readonly probe: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  private readonly log: (line: string) => void;
  private readonly openLog: (path: string) => number | "ignore";
  private readonly logSize: (path: string) => number;
  private readonly readLogSince: (path: string, offset: number) => string;
  private shuttingDown = false;
  /** when `start()` began: the restart race can only happen inside STARTUP_GRACE_MS of it */
  private bootAt: number | undefined;

  constructor(
    public readonly config: SupervisorConfig,
    deps: SupervisorDeps = {},
  ) {
    this.spawn = deps.spawn ?? defaultSpawn;
    this.now = deps.now ?? Date.now;
    this.probe = deps.probe ?? tcpProbe;
    this.log = deps.log ?? ((l) => console.log(l));
    this.openLog = deps.openLog ?? defaultOpenLog;
    this.logSize = deps.logSize ?? defaultLogSize;
    this.readLogSince = deps.readLogSince ?? defaultReadLogSince;
    this.order = config.children.map((c) => c.name);
    for (const spec of config.children) {
      this.children.set(spec.name, { spec, state: "pending", restarts: 0, recent: [], backoffMs: RESTART_BACKOFF_MS, portRetries: 0 });
    }
  }

  names(): string[] {
    return [...this.order];
  }

  has(name: string): boolean {
    return this.children.has(name);
  }

  /**
   * Ordered start. A child with a readiness probe holds the next one until
   * its port answers — Postgres before the console, the console before the
   * assistant, which is the order the compose shape got from `depends_on`
   * and the five-agent launchd shape never had at all.
   *
   * A probe that times out is a LOG LINE, not an abort: the next child
   * starts anyway and doctor reports what actually happened. An install
   * whose Postgres is slow must still end up with a console.
   */
  async start(): Promise<void> {
    this.bootAt = this.now();
    for (const name of this.order) {
      const c = this.children.get(name)!;
      this.startChild(c);
      if (!c.spec.ready) continue;
      const { host, port, timeoutMs } = c.spec.ready;
      const ok = await this.waitReady(host, port, timeoutMs);
      this.log(ok ? `[${name}] ready on ${host}:${port}` : `[${name}] not ready on ${host}:${port} after ${timeoutMs}ms — starting the next child anyway`);
    }
  }

  private async waitReady(host: string, port: number, timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      if (await this.probe(host, port, 1_000)) return true;
      if (this.now() >= deadline || this.shuttingDown) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private startChild(c: ChildRuntime): void {
    if (c.proc) return;
    c.stopping = false;
    c.logOffset = this.logSize(c.spec.log);
    const stdio = this.openLog(c.spec.log);
    let proc: ChildProcess;
    try {
      proc = this.spawn(c.spec, stdio);
    } catch (err) {
      c.state = "backoff";
      c.lastExit = { code: null, signal: null, at: new Date(this.now()).toISOString() };
      this.log(`[${c.spec.name}] spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleRestart(c);
      return;
    }
    c.proc = proc;
    c.state = "running";
    c.startedAt = this.now();
    this.log(`[${c.spec.name}] started pid ${proc.pid ?? "?"} → ${c.spec.log}`);
    proc.once("exit", (code, signal) => this.onExit(c, code, signal));
  }

  private onExit(c: ChildRuntime, code: number | null, signal: NodeJS.Signals | null): void {
    const upFor = c.startedAt ? this.now() - c.startedAt : 0;
    c.proc = undefined;
    c.startedAt = undefined;
    c.lastExit = { code, signal: signal ?? null, at: new Date(this.now()).toISOString() };
    if (c.stopping || this.shuttingDown) {
      c.state = "stopped";
      this.log(`[${c.spec.name}] stopped (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`);
      return;
    }
    // the restart race: a port the previous supervisor's child still holds.
    // Retried quickly and NOT counted, but only inside the startup window
    // and only when the child said so in its own log.
    if (this.portStillHeld(c, this.now(), upFor)) {
      c.restarts += 1;
      c.portRetries += 1;
      c.state = "backoff";
      this.log(`[${c.spec.name}] its port is still held — the previous generation is still stopping (exit code ${code ?? "null"}); retrying in ${PORT_BUSY_RETRY_MS}ms, not counted toward crash-looping`);
      this.scheduleRestart(c, PORT_BUSY_RETRY_MS);
      return;
    }
    // a child that stayed up is healthy: its backoff and its crash-loop
    // history start again, so a restart six months from now is not "the
    // sixth crash"
    if (upFor >= RESTART_HEALTHY_MS) {
      c.backoffMs = RESTART_BACKOFF_MS;
      c.recent = [];
    }
    c.restarts += 1;
    const at = this.now();
    c.recent = [...c.recent.filter((t) => at - t < CRASH_LOOP_WINDOW_MS), at];
    const looping = c.recent.length >= CRASH_LOOP_RESTARTS;
    c.state = looping ? "crash-looping" : "backoff";
    if (looping) {
      c.backoffMs = RESTART_BACKOFF_MAX_MS;
      this.log(
        `[${c.spec.name}] CRASH-LOOPING: ${c.recent.length} restarts in ${Math.round(CRASH_LOOP_WINDOW_MS / 1000)}s (last exit code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}) — retrying every ${RESTART_BACKOFF_MAX_MS / 1000}s; log: ${c.spec.log}`,
      );
    } else {
      this.log(`[${c.spec.name}] exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}) — restarting in ${c.backoffMs}ms`);
    }
    this.scheduleRestart(c);
  }

  /** Inside the startup window, an early exit whose log names a port it could not take. */
  private portStillHeld(c: ChildRuntime, at: number, upFor: number): boolean {
    if (this.bootAt === undefined || at - this.bootAt >= STARTUP_GRACE_MS || upFor >= STARTUP_GRACE_MS) return false;
    return PORT_BUSY_PATTERN.test(this.readLogSince(c.spec.log, c.logOffset ?? 0));
  }

  /** `fixedMs`: a port-busy retry, which leaves the exponential backoff where it was. */
  private scheduleRestart(c: ChildRuntime, fixedMs?: number): void {
    if (this.shuttingDown) return;
    const wait = fixedMs ?? c.backoffMs;
    if (fixedMs === undefined) c.backoffMs = Math.min(c.backoffMs * 2, RESTART_BACKOFF_MAX_MS);
    c.timer = setTimeout(() => {
      c.timer = undefined;
      if (this.shuttingDown || c.stopping) return;
      this.startChild(c);
    }, wait);
    c.timer.unref?.();
  }

  /** SIGTERM, wait the child's grace period, SIGKILL. Resolves once the process is gone (or was never there). */
  async stopChild(name: string): Promise<void> {
    const c = this.children.get(name);
    if (!c) return;
    if (c.timer) {
      clearTimeout(c.timer);
      c.timer = undefined;
    }
    c.stopping = true;
    const proc = c.proc;
    if (!proc) {
      c.state = "stopped";
      return;
    }
    const gone = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    proc.kill("SIGTERM");
    const killed = await Promise.race([gone.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), c.spec.stopTimeoutMs))]);
    if (!killed) {
      this.log(`[${name}] did not exit ${c.spec.stopTimeoutMs}ms after SIGTERM — SIGKILL`);
      proc.kill("SIGKILL");
      await gone;
    }
    c.state = "stopped";
  }

  async startService(name: string): Promise<void> {
    const c = this.children.get(name);
    if (!c) return;
    c.backoffMs = RESTART_BACKOFF_MS;
    c.recent = [];
    this.startChild(c);
  }

  async restartService(name: string): Promise<void> {
    await this.stopChild(name);
    await this.startService(name);
  }

  /** Stop everything, in reverse start order — the assistant before the console, the console before Postgres. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const name of [...this.order].reverse()) await this.stopChild(name);
  }

  status(): ChildStatus[] {
    return this.order.map((name) => {
      const c = this.children.get(name)!;
      return {
        name,
        state: c.state,
        ...(c.proc?.pid !== undefined ? { pid: c.proc.pid } : {}),
        ...(c.startedAt !== undefined ? { uptimeMs: this.now() - c.startedAt } : {}),
        restarts: c.restarts,
        ...(c.lastExit ? { lastExit: c.lastExit } : {}),
        log: c.spec.log,
      };
    });
  }
}

/** The supervisor's own log line, so `metistry logs supervisor` shows the config it came up with. */
export function startupSummary(config: SupervisorConfig): string {
  return `${config.label}: ${config.children.length} child(ren) — ${config.children.map((c) => c.name).join(", ")}; control socket ${config.socket}`;
}
