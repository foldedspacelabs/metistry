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
import { openSync } from "node:fs";
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

export interface SupervisorDeps {
  spawn?: Spawner;
  now?: () => number;
  /** resolves when the port answers, false on timeout — the ordered-start gate */
  probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  log?: (line: string) => void;
  /** test seam: the per-child log file descriptor (default: append to spec.log) */
  openLog?: (path: string) => number | "ignore";
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
  private shuttingDown = false;

  constructor(
    public readonly config: SupervisorConfig,
    deps: SupervisorDeps = {},
  ) {
    this.spawn = deps.spawn ?? defaultSpawn;
    this.now = deps.now ?? Date.now;
    this.probe = deps.probe ?? tcpProbe;
    this.log = deps.log ?? ((l) => console.log(l));
    this.openLog = deps.openLog ?? defaultOpenLog;
    this.order = config.children.map((c) => c.name);
    for (const spec of config.children) {
      this.children.set(spec.name, { spec, state: "pending", restarts: 0, recent: [], backoffMs: RESTART_BACKOFF_MS });
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

  private scheduleRestart(c: ChildRuntime): void {
    if (this.shuttingDown) return;
    const wait = c.backoffMs;
    c.backoffMs = Math.min(c.backoffMs * 2, RESTART_BACKOFF_MAX_MS);
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
