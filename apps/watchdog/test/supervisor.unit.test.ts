// The supervisor against fakes: ordered start, the restart policy, crash-loop
// detection, graceful stop, and the one security property that must not
// regress — a child's environment is the spec's, whole, never the
// supervisor's (the engine's allowlist is only an allowlist if nothing leaks
// in around it).
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { parseSupervisorConfig, type ChildSpec } from "@foldedspacelabs/metistry-core";
import { Supervisor } from "../src/supervisor.js";

/** A child process that does nothing but remember what was done to it. */
class FakeChild extends EventEmitter {
  pid = 1000 + FakeChild.n++;
  static n = 0;
  signals: string[] = [];
  kill(signal?: string): boolean {
    this.signals.push(signal ?? "SIGTERM");
    // SIGKILL is always fatal; SIGTERM is honoured unless a test says otherwise
    if (signal === "SIGKILL" || !this.ignoreTerm) this.exit(0, signal ?? null);
    return true;
  }
  ignoreTerm = false;
  exit(code: number | null, signal: string | null = null): void {
    this.emit("exit", code, signal);
  }
}

const child = (name: string, extra: Partial<ChildSpec> = {}) => ({ name, argv: ["/bin/true"], log: `/tmp/metistry-${name}.log`, env: {}, stopTimeoutMs: 50, ...extra });

function make(children: ReturnType<typeof child>[], deps: { probe?: (h: string, p: number, t: number) => Promise<boolean> } = {}) {
  const spawned: FakeChild[] = [];
  const log: string[] = [];
  // each child's log file, in memory: what a child "writes" before it exits
  // is what the supervisor reads to classify the exit
  const logs = new Map<string, string>();
  const config = parseSupervisorConfig({ schema: 1, label: "com.foldedspacelabs.metistry", socket: "/tmp/x.sock", token: "t".repeat(32), children });
  const sup = new Supervisor(config, {
    spawn: () => {
      const c = new FakeChild();
      spawned.push(c);
      return c as unknown as ChildProcess;
    },
    openLog: () => "ignore",
    logSize: (p) => (logs.get(p) ?? "").length,
    readLogSince: (p, offset) => (logs.get(p) ?? "").slice(offset),
    log: (l) => log.push(l),
    probe: deps.probe ?? (async () => true),
  });
  const write = (name: string, text: string) => logs.set(`/tmp/metistry-${name}.log`, (logs.get(`/tmp/metistry-${name}.log`) ?? "") + text);
  return { sup, spawned, log, write };
}

describe("ordered start", () => {
  it("a child with a readiness probe holds the next one until its port answers", async () => {
    const order: string[] = [];
    let dbUp = false;
    const { sup, spawned } = make(
      [child("db", { ready: { kind: "tcp", port: 5432, host: "127.0.0.1", timeoutMs: 1000 } }), child("console")],
      { probe: async () => dbUp },
    );
    const started = sup.start();
    await new Promise((r) => setTimeout(r, 30));
    order.push(...sup.status().filter((c) => c.state === "running").map((c) => c.name));
    // the console has NOT started: Postgres has not answered
    expect(order).toEqual(["db"]);
    dbUp = true;
    await started;
    expect(sup.status().map((c) => c.state)).toEqual(["running", "running"]);
    expect(spawned.length).toBe(2);
  });

  it("a probe that never answers is a log line, not an abort — the rest of the install still comes up", async () => {
    const { sup, log } = make([child("db", { ready: { kind: "tcp", port: 5432, host: "127.0.0.1", timeoutMs: 10 } }), child("console")], { probe: async () => false });
    await sup.start();
    expect(log.join("\n")).toContain("not ready on 127.0.0.1:5432");
    expect(sup.status().map((c) => c.state)).toEqual(["running", "running"]);
  });
});

describe("the restart policy", () => {
  it("an exit is restarted after a backoff that doubles, and a deliberate stop is not restarted at all", async () => {
    vi.useFakeTimers();
    try {
      const { sup, spawned } = make([child("console")]);
      await sup.start();
      expect(spawned.length).toBe(1);
      spawned[0]!.exit(1);
      expect(sup.status()[0]!.state).toBe("backoff");
      await vi.advanceTimersByTimeAsync(999);
      expect(spawned.length).toBe(1); // still waiting out the first second
      await vi.advanceTimersByTimeAsync(2);
      expect(spawned.length).toBe(2);
      spawned[1]!.exit(1);
      await vi.advanceTimersByTimeAsync(1500);
      expect(spawned.length).toBe(2); // the second backoff is 2s, not 1
      await vi.advanceTimersByTimeAsync(600);
      expect(spawned.length).toBe(3);
      expect(sup.status()[0]!.restarts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("crash-looping is REPORTED rather than hammered: five restarts in the window, then the ceiling", async () => {
    vi.useFakeTimers();
    try {
      const { sup, spawned, log } = make([child("console")]);
      await sup.start();
      // it dies as fast as it is restarted; each backoff is waited out, so
      // the five failures land well inside the 120s window
      for (let i = 0; i < 5; i++) {
        spawned[spawned.length - 1]!.exit(1);
        if (i < 4) await vi.advanceTimersByTimeAsync(2 ** i * 1000 + 5);
      }
      expect(sup.status()[0]!.state).toBe("crash-looping");
      expect(log.join("\n")).toContain("CRASH-LOOPING: 5 restarts");
      expect(sup.status()[0]!.lastExit).toMatchObject({ code: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the restart race: a port the previous generation still holds", () => {
  // The owner's 0.14.2 `metistry up`: the supervisor was kickstarted while
  // the previous one's reconciler was still exiting, the new reconciler hit
  // EADDRINUSE on 7812 three times, and the supervisor declared it
  // CRASH-LOOPING and backed off to 60 s.
  const EADDRINUSE = "Error: listen EADDRINUSE: address already in use 127.0.0.1:7812\n    at Server.setupListenHandle\n";

  it("an early exit that logged EADDRINUSE is retried every 500ms and is NOT counted toward crash-looping", async () => {
    vi.useFakeTimers();
    try {
      const { sup, spawned, log, write } = make([child("reconciler")]);
      await sup.start();
      // eight fast failures — more than CRASH_LOOP_RESTARTS — while the old one lets go
      for (let i = 0; i < 8; i++) {
        write("reconciler", EADDRINUSE);
        spawned[spawned.length - 1]!.exit(1);
        expect(sup.status()[0]!.state).toBe("backoff");
        await vi.advanceTimersByTimeAsync(499);
        expect(spawned.length).toBe(i + 1); // not before the retry interval
        await vi.advanceTimersByTimeAsync(2);
      }
      // …and then the port is free and it stays up
      expect(spawned.length).toBe(9);
      expect(sup.status()[0]).toMatchObject({ state: "running", restarts: 8 });
      expect(log.join("\n")).not.toContain("CRASH-LOOPING");
      expect(log.join("\n")).toContain("its port is still held");
      // the exponential backoff was left where it was: an ordinary crash now waits 1 s, not 2^8
      spawned[8]!.exit(1);
      await vi.advanceTimersByTimeAsync(1001);
      expect(spawned.length).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("EPERM on a listen is treated the same way inside the window (a sandbox that forbids it still ends up crash-looping, later)", async () => {
    vi.useFakeTimers();
    try {
      const { sup, spawned, log, write } = make([child("reconciler")]);
      await sup.start();
      write("reconciler", "Error: listen EPERM: operation not permitted 127.0.0.1:7812\n");
      spawned[0]!.exit(1);
      await vi.advanceTimersByTimeAsync(501);
      expect(spawned.length).toBe(2);
      expect(log.join("\n")).toContain("its port is still held");
    } finally {
      vi.useRealTimers();
    }
  });

  it("after the startup window the same exit counts exactly as before", async () => {
    vi.useFakeTimers();
    try {
      const { sup, spawned, log, write } = make([child("reconciler")]);
      await sup.start();
      await vi.advanceTimersByTimeAsync(31_000); // up past STARTUP_GRACE_MS, healthy
      for (let i = 0; i < 5; i++) {
        write("reconciler", EADDRINUSE);
        spawned[spawned.length - 1]!.exit(1);
        if (i < 4) await vi.advanceTimersByTimeAsync(2 ** i * 1000 + 5);
      }
      expect(sup.status()[0]!.state).toBe("crash-looping");
      expect(log.join("\n")).toContain("CRASH-LOOPING: 5 restarts");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an early exit that did NOT name a port is counted — and a port error from a PREVIOUS spawn's log does not excuse it", async () => {
    vi.useFakeTimers();
    try {
      const { sup, spawned, write } = make([child("reconciler")]);
      // the log already says EADDRINUSE before this spawn started writing
      write("reconciler", EADDRINUSE);
      await sup.start();
      for (let i = 0; i < 5; i++) {
        write("reconciler", "TypeError: something else entirely\n");
        spawned[spawned.length - 1]!.exit(1);
        if (i < 4) await vi.advanceTimersByTimeAsync(2 ** i * 1000 + 5);
      }
      expect(sup.status()[0]!.state).toBe("crash-looping");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the child's REAL log file from where this spawn began (default readers)", async () => {
    const { mkdtemp, appendFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "metistry-sup-"));
    const logPath = join(dir, "reconciler.log");
    await appendFile(logPath, "an earlier generation: " + EADDRINUSE);
    const lines: string[] = [];
    const spawned: FakeChild[] = [];
    const config = parseSupervisorConfig({ schema: 1, label: "com.foldedspacelabs.metistry", socket: "/tmp/x.sock", token: "t".repeat(32), children: [child("reconciler", { log: logPath })] });
    const sup = new Supervisor(config, {
      spawn: () => {
        const c = new FakeChild();
        spawned.push(c);
        return c as unknown as ChildProcess;
      },
      openLog: () => "ignore",
      log: (l) => lines.push(l),
      probe: async () => true,
    });
    await sup.start();
    // nothing new written: an ordinary, counted exit
    spawned[0]!.exit(1);
    expect(lines.join("\n")).toContain("restarting in 1000ms");
    await sup.shutdown();
    const sup2 = new Supervisor(config, {
      spawn: () => {
        const c = new FakeChild();
        spawned.push(c);
        return c as unknown as ChildProcess;
      },
      openLog: () => "ignore",
      log: (l) => lines.push(l),
      probe: async () => true,
    });
    await sup2.start();
    await appendFile(logPath, EADDRINUSE);
    spawned[spawned.length - 1]!.exit(1);
    expect(lines[lines.length - 1]).toContain("its port is still held");
    await sup2.shutdown();
  });
});

describe("graceful stop", () => {
  it("SIGTERM, then SIGKILL after the grace period — and children stop in reverse order", async () => {
    const { sup, spawned } = make([child("db"), child("console")]);
    await sup.start();
    const stopped: string[] = [];
    spawned[0]!.on("exit", () => stopped.push("db"));
    spawned[1]!.on("exit", () => stopped.push("console"));
    await sup.shutdown();
    expect(stopped).toEqual(["console", "db"]);
    expect(spawned[1]!.signals).toEqual(["SIGTERM"]);
  });

  it("a child that ignores SIGTERM is killed", async () => {
    const { sup, spawned, log } = make([child("console", { stopTimeoutMs: 20 })]);
    await sup.start();
    spawned[0]!.ignoreTerm = true;
    await sup.stopChild("console");
    expect(spawned[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(log.join("\n")).toContain("did not exit 20ms after SIGTERM — SIGKILL");
    expect(sup.status()[0]!.state).toBe("stopped");
  });

  it("`stop console` then `start console` is not a crash — the child is restarted on purpose, not by policy", async () => {
    const { sup, spawned } = make([child("console")]);
    await sup.start();
    await sup.stopChild("console");
    expect(sup.status()[0]).toMatchObject({ state: "stopped", restarts: 0 });
    await sup.startService("console");
    expect(sup.status()[0]!.state).toBe("running");
    expect(spawned.length).toBe(2);
  });
});

describe("status() reports uptime", () => {
  // T4-21: the Services pane reads uptime per service from doctor's
  // `child:<name>` rows, which pass `uptimeMs` straight through — so a
  // regression here is silent everywhere else until someone notices the
  // pane just stopped showing an age.
  it("uptimeMs grows from a running child's own startedAt, and is absent before it starts", async () => {
    let clock = 1_000_000;
    const config = parseSupervisorConfig({ schema: 1, label: "com.foldedspacelabs.metistry", socket: "/tmp/x.sock", token: "t".repeat(32), children: [child("console")] });
    const sup = new Supervisor(config, {
      spawn: () => new FakeChild() as unknown as ChildProcess,
      openLog: () => "ignore",
      log: () => {},
      probe: async () => true,
      now: () => clock,
    });
    expect(sup.status()[0]!.uptimeMs).toBeUndefined();
    await sup.start();
    clock += 5_000;
    expect(sup.status()[0]).toMatchObject({ state: "running", uptimeMs: 5_000 });
  });
});

describe("a child's environment", () => {
  it("is the spec's, whole: nothing of the supervisor's leaks in", async () => {
    // the supervisor's own environment carries the install's secrets (the db
    // password, the console's outbound credentials). The engine's is an
    // ALLOWLIST — PoC-4 — and it is only one if the spawn replaces the
    // environment rather than merging into it.
    process.env.ANTHROPIC_API_KEY = "leaked";
    try {
      const seen: Record<string, string>[] = [];
      const config = parseSupervisorConfig({
        schema: 1,
        label: "com.foldedspacelabs.metistry",
        socket: "/tmp/x.sock",
        token: "t".repeat(32),
        children: [{ name: "assistant", argv: ["/usr/bin/sandbox-exec"], log: "/tmp/l", env: { HOME: "/state/assistant" } }],
      });
      const sup = new Supervisor(config, {
        openLog: () => "ignore",
        log: () => {},
        spawn: (spec) => {
          seen.push(spec.env);
          return new FakeChild() as unknown as ChildProcess;
        },
      });
      await sup.start();
      expect(seen[0]).toEqual({ HOME: "/state/assistant" });
      expect(seen[0]!.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
