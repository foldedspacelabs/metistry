// The control socket, including its misuse tests: a request authenticates
// even though it arrives on a 0600 unix socket in the instance's own state
// directory (invariant 8 — a boundary is tested, and "it cannot be reached"
// is not an authentication story).
import { mkdtemp } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { parseSupervisorConfig, type ControlResponse } from "@foldedspacelabs/metistry-core";
import { Supervisor } from "../src/supervisor.js";
import { handleControl, listenControl, tokenMatches } from "../src/control.js";

const TOKEN = "a".repeat(64);

function supervisor(socket: string) {
  const config = parseSupervisorConfig({
    schema: 1,
    label: "com.foldedspacelabs.metistry",
    socket,
    token: TOKEN,
    children: [
      { name: "console", argv: ["/bin/true"], log: "/tmp/metistry-console.log" },
      { name: "assistant", argv: ["/bin/true"], log: "/tmp/metistry-assistant.log" },
    ],
  });
  return new Supervisor(config, {
    openLog: () => "ignore",
    log: () => {},
    spawn: () => {
      const c = new EventEmitter() as EventEmitter & { pid: number; kill: (s?: string) => boolean };
      c.pid = 4242;
      c.kill = () => (c.emit("exit", 0, "SIGTERM"), true);
      return c as unknown as ChildProcess;
    },
  });
}

describe("the control protocol", () => {
  it("status lists every child; restart/stop/start act on one and report the state they produced", async () => {
    const sup = supervisor("/tmp/unused.sock");
    await sup.start();
    const status = await handleControl(sup, { op: "status", token: TOKEN });
    expect(status.ok).toBe(true);
    expect(status.children?.map((c) => c.name)).toEqual(["console", "assistant"]);
    expect(status.children?.[0]).toMatchObject({ state: "running", pid: 4242, restarts: 0, log: "/tmp/metistry-console.log" });

    const stopped = await handleControl(sup, { op: "stop", token: TOKEN, service: "console" });
    expect(stopped.ok).toBe(true);
    expect(stopped.children?.find((c) => c.name === "console")?.state).toBe("stopped");
    const restarted = await handleControl(sup, { op: "restart", token: TOKEN, service: "console" });
    expect(restarted.detail).toBe("restart console");
    expect(restarted.children?.find((c) => c.name === "console")?.state).toBe("running");
  });

  it("refuses a wrong token with nothing but `unauthorized`, and never acts", async () => {
    const sup = supervisor("/tmp/unused.sock");
    await sup.start();
    for (const token of ["", "b".repeat(64), TOKEN + "x", TOKEN.slice(0, -1)]) {
      const res = await handleControl(sup, { op: "stop", token, service: "console" });
      expect(res).toEqual({ ok: false, error: "unauthorized" });
    }
    expect(sup.status()[0]!.state).toBe("running");
    // the comparison is constant-time and length-safe
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches("short", TOKEN)).toBe(false);
  });

  it("refuses a malformed request, an unknown op, an unknown service and a missing one — with the list of what it runs", async () => {
    const sup = supervisor("/tmp/unused.sock");
    expect((await handleControl(sup, "restart console")).error).toMatch(/bad request/);
    expect((await handleControl(sup, { op: "shutdown", token: TOKEN })).error).toMatch(/bad request/);
    expect((await handleControl(sup, { op: "restart", token: TOKEN })).error).toMatch(/needs a service name — known: console, assistant/);
    expect((await handleControl(sup, { op: "restart", token: TOKEN, service: "db" })).error).toMatch(/unknown service: db — this supervisor runs console, assistant/);
  });
});

describe("the socket itself", () => {
  it("is 0600, answers one JSON line per request, and is removed when the supervisor closes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-sock-"));
    const socket = join(dir, "supervisor.sock");
    const sup = supervisor(socket);
    await sup.start();
    const server = await listenControl(sup, () => {});
    try {
      expect(statSync(socket).mode & 0o777).toBe(0o600);
      const answer = await new Promise<ControlResponse>((resolve, reject) => {
        const s = connect(socket, () => s.write(JSON.stringify({ op: "status", token: TOKEN }) + "\n"));
        s.once("error", reject);
        s.once("data", (b: Buffer) => {
          resolve(JSON.parse(b.toString("utf8").trim()) as ControlResponse);
          s.destroy();
        });
      });
      expect(answer.ok).toBe(true);
      expect(answer.children?.length).toBe(2);
    } finally {
      await server.close();
    }
    expect(() => statSync(socket)).toThrow();
  });
});
