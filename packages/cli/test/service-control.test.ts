// `metistry restart|stop|start|logs` against fakes: the exact launchctl/
// compose argv per shape, the "no args = every service this shape runs"
// default, an unknown service failing with the list of known ones, --json,
// dry-run, and logs (launchd tail vs. compose logs).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import { buildServiceTargets, controlServices, resolveServices, serviceLogs, UnknownServiceError } from "../src/service-control.js";
import { checkout, fakeExec, put, shown, HELPER, RECONCILER, WATCHDOG } from "./fixtures.js";

const base = (P: string) => ({ productDir: P, platform: "darwin" as const, uid: 501, home: "/h" });

describe("buildServiceTargets", () => {
  it("compose shape (the default): the non-shaped host jobs plus the containers docker-compose.yml declares", async () => {
    const P = await checkout();
    const ctx = await buildServiceTargets({ ...base(P), env: {} });
    expect(ctx.shape).toBe("compose");
    expect(ctx.targets.map((t) => t.name)).toEqual(["eventkit-helper", "reconciler", "watchdog", "console", "db"]);
    expect(ctx.targets.filter((t) => t.kind === "launchd").map((t) => t.label)).toEqual([HELPER, RECONCILER, WATCHDOG]);
    expect(ctx.targets.find((t) => t.name === "watchdog")).toMatchObject({ kind: "launchd", label: WATCHDOG, plistPath: `/h/Library/LaunchAgents/${WATCHDOG}.plist` });
    expect(ctx.targets.filter((t) => t.kind === "compose").map((t) => t.name)).toEqual(["console", "db"]);
  });

  it("launchd shape: no containers at all — db/console/assistant aren't shipped as plists in this fixture, so the service list shrinks to the host-only jobs", async () => {
    const P = await checkout();
    await put(P, "seed/deployment.yaml", "shape: launchd\nservices: {}\n");
    const ctx = await buildServiceTargets({ ...base(P), env: {} });
    expect(ctx.shape).toBe("launchd");
    expect(ctx.targets.every((t) => t.kind === "launchd")).toBe(true);
    expect(ctx.targets.map((t) => t.name)).toEqual(["eventkit-helper", "reconciler", "watchdog"]);
  });

  it("non-darwin: no launchd targets at all (there is no launchd to act on)", async () => {
    const P = await checkout();
    const ctx = await buildServiceTargets({ ...base(P), platform: "linux", env: {} });
    expect(ctx.targets.every((t) => t.kind === "compose")).toBe(true);
    expect(ctx.targets.map((t) => t.name)).toEqual(["console", "db"]);
  });
});

describe("resolveServices", () => {
  it("no names = every target; named services split into resolved + unknown", async () => {
    const P = await checkout();
    const { targets } = await buildServiceTargets({ ...base(P), env: {} });
    expect(resolveServices(targets, undefined).resolved).toBe(targets);
    expect(resolveServices(targets, []).resolved).toBe(targets);
    const r = resolveServices(targets, ["watchdog", "bogus", "db"]);
    expect(r.resolved.map((t) => t.name)).toEqual(["watchdog", "db"]);
    expect(r.unknown).toEqual(["bogus"]);
  });
});

describe("metistry restart|stop|start", () => {
  it("restart, no args: kickstart -k every host job, docker compose restart every container, in shape order", async () => {
    const P = await checkout();
    const exec = fakeExec();
    const r = await controlServices({ ...base(P), env: {}, action: "restart", exec, out: () => {} });
    expect(exec.calls.map(shown)).toEqual([
      `launchctl kickstart -k gui/501/${HELPER}`,
      `launchctl kickstart -k gui/501/${RECONCILER}`,
      `launchctl kickstart -k gui/501/${WATCHDOG}`,
      "docker compose restart console",
      "docker compose restart db",
    ]);
    expect(exec.calls.filter((c) => c.cmd === "docker").every((c) => c.cwd === P)).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.results).toEqual([
      { service: "eventkit-helper", action: "restart", ok: true, detail: `launchctl kickstart -k gui/501/${HELPER}` },
      { service: "reconciler", action: "restart", ok: true, detail: `launchctl kickstart -k gui/501/${RECONCILER}` },
      { service: "watchdog", action: "restart", ok: true, detail: `launchctl kickstart -k gui/501/${WATCHDOG}` },
      { service: "console", action: "restart", ok: true, detail: "docker compose restart console" },
      { service: "db", action: "restart", ok: true, detail: "docker compose restart db" },
    ]);
  });

  it("restart, one named host job: exactly one launchctl kickstart -k call", async () => {
    const P = await checkout();
    const exec = fakeExec();
    const r = await controlServices({ ...base(P), env: {}, action: "restart", names: ["watchdog"], exec, out: () => {} });
    expect(exec.calls.map(shown)).toEqual([`launchctl kickstart -k gui/501/${WATCHDOG}`]);
    expect(r.results).toEqual([{ service: "watchdog", action: "restart", ok: true, detail: `launchctl kickstart -k gui/501/${WATCHDOG}` }]);
  });

  it("stop: launchctl bootout (tolerated) for a host job, docker compose stop for a container", async () => {
    const P = await checkout();
    const exec = fakeExec();
    const r = await controlServices({ ...base(P), env: {}, action: "stop", names: ["watchdog", "db"], exec, out: () => {} });
    expect(exec.calls.map(shown)).toEqual([`launchctl bootout gui/501/${WATCHDOG}`, "docker compose stop db"]);
    expect(r.ok).toBe(true);
  });

  it("stop tolerates a job that was never loaded", async () => {
    const P = await checkout();
    const exec = fakeExec({ launchctl: () => ({ code: 3, stderr: "Boot-out failed: 3: No such process" }) });
    const r = await controlServices({ ...base(P), env: {}, action: "stop", names: ["watchdog"], exec, out: () => {} });
    expect(r.results).toEqual([{ service: "watchdog", action: "stop", ok: true, detail: `launchctl bootout gui/501/${WATCHDOG}` }]);
  });

  it("start: bootstrap the installed plist then kickstart -k; docker compose start for a container", async () => {
    const P = await checkout();
    const exec = fakeExec();
    const r = await controlServices({ ...base(P), env: {}, action: "start", names: ["watchdog", "console"], exec, out: () => {} });
    expect(exec.calls.map(shown)).toEqual([
      `launchctl bootstrap gui/501 /h/Library/LaunchAgents/${WATCHDOG}.plist`,
      `launchctl kickstart -k gui/501/${WATCHDOG}`,
      "docker compose start console",
    ]);
    expect(r.results[0]).toMatchObject({ service: "watchdog", action: "start", ok: true });
  });

  it("start tolerates a plist that is already bootstrapped", async () => {
    const P = await checkout();
    const exec = fakeExec({ launchctl: (args) => (args[0] === "bootstrap" ? { code: 5, stderr: "Bootstrap failed: 5: Input/output error" } : undefined) });
    const r = await controlServices({ ...base(P), env: {}, action: "start", names: ["watchdog"], exec, out: () => {} });
    expect(r.results).toEqual([{ service: "watchdog", action: "start", ok: true, detail: `launchctl bootstrap gui/501 /h/Library/LaunchAgents/${WATCHDOG}.plist; launchctl kickstart -k gui/501/${WATCHDOG}` }]);
  });

  it("a failing action is reported per-service, not thrown, and does not stop the others", async () => {
    const P = await checkout();
    const exec = fakeExec({ docker: () => ({ code: 17, stderr: "Cannot connect to the Docker daemon" }) });
    const r = await controlServices({ ...base(P), env: {}, action: "restart", names: ["watchdog", "db"], exec, out: () => {} });
    expect(r.ok).toBe(false);
    expect(r.results).toEqual([
      { service: "watchdog", action: "restart", ok: true, detail: `launchctl kickstart -k gui/501/${WATCHDOG}` },
      { service: "db", action: "restart", ok: false, detail: expect.stringContaining("Cannot connect to the Docker daemon") },
    ]);
  });

  it("an unknown service throws with the known list, and runs nothing", async () => {
    const P = await checkout();
    const exec = fakeExec();
    await expect(controlServices({ ...base(P), env: {}, action: "restart", names: ["bogus"], exec, out: () => {} })).rejects.toThrow(UnknownServiceError);
    await expect(controlServices({ ...base(P), env: {}, action: "restart", names: ["bogus"], exec, out: () => {} })).rejects.toThrow(/unknown service: bogus.*known services.*console.*db.*eventkit-helper.*reconciler.*watchdog/s);
    expect(exec.calls).toEqual([]);
  });

  it("dry-run prints the plan and runs nothing, reporting every service ok", async () => {
    const P = await checkout();
    const exec = fakeExec();
    const lines: string[] = [];
    const r = await controlServices({ ...base(P), env: {}, action: "restart", exec, out: (l) => lines.push(l), dryRun: true });
    expect(exec.calls).toEqual([]);
    expect(r.commands).toEqual([
      `launchctl kickstart -k gui/501/${HELPER}`,
      `launchctl kickstart -k gui/501/${RECONCILER}`,
      `launchctl kickstart -k gui/501/${WATCHDOG}`,
      `(cd ${P} && docker compose restart console)`,
      `(cd ${P} && docker compose restart db)`,
    ]);
    expect(r.results.every((x) => x.ok)).toBe(true);
    expect(lines.some((l) => l.startsWith("[dry-run]"))).toBe(true);
  });
});

describe("metistry restart|stop|start via main()", () => {
  it("--json prints [{service, action, ok, detail}, …] and nothing else", async () => {
    const P = await checkout();
    const exec = fakeExec();
    const lines: string[] = [];
    const code = await main(["restart", "watchdog", "--json", "--product-dir", P], { out: (l) => lines.push(l), err: () => {}, exec });
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual([{ service: "watchdog", action: "restart", ok: true, detail: `launchctl kickstart -k gui/501/${WATCHDOG}` }]);
  });

  it("a failing service exits 1 even though other services succeeded", async () => {
    const P = await checkout();
    const exec = fakeExec({ docker: () => ({ code: 17, stderr: "boom" }) });
    const errs: string[] = [];
    const code = await main(["restart", "watchdog", "db", "--json", "--product-dir", P], { out: () => {}, err: (l) => errs.push(l), exec });
    expect(code).toBe(1);
  });

  it("an unknown service exits 2 and names the known services on stderr", async () => {
    const P = await checkout();
    const errs: string[] = [];
    const code = await main(["stop", "bogus", "--product-dir", P], { out: () => {}, err: (l) => errs.push(l), exec: fakeExec() });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/unknown service: bogus/);
    expect(errs.join("\n")).toMatch(/watchdog/);
  });

  it("plain output is a table with a summary line", async () => {
    const P = await checkout();
    const lines: string[] = [];
    const code = await main(["restart", "watchdog", "--product-dir", P], { out: (l) => lines.push(l), err: () => {}, exec: fakeExec() });
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toMatch(/service\s+action\s+ok\s+detail/);
    expect(text).toContain("watchdog");
    expect(text).toMatch(/1 service\(s\): 1 ok, 0 failed/);
  });
});

const withLogPlist = (label: string, logPath: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key>\n  <array><string>/bin/sh</string></array>\n  <key>StandardOutPath</key><string>${logPath}</string>\n  <key>StandardErrorPath</key><string>${logPath}</string>\n</dict>\n</plist>\n`;

async function logsCheckout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "metistry-logs-"));
  await put(root, "package.json", JSON.stringify({ name: "metistry" }));
  await put(root, "seed/identity.yaml", "name: Seed\n");
  await put(root, "ops/launchd/com.foldedspacelabs.metistry.apple-fm.plist", withLogPlist("com.foldedspacelabs.metistry.apple-fm", "/tmp/metistry-apple-fm.log"));
  await put(root, "docker-compose.yml", "services:\n  db: {}\n  console: {}\n");
  return root;
}

describe("metistry logs", () => {
  it("launchd: tails the plist's StandardOutPath, last 200 lines by default", async () => {
    const P = await logsCheckout();
    const exec = fakeExec();
    const r = await serviceLogs({ ...base(P), env: {}, service: "apple-fm", lines: 200, follow: false, exec, out: () => {} });
    expect(exec.calls.map(shown)).toEqual(["tail -n 200 /tmp/metistry-apple-fm.log"]);
    expect(r.ok).toBe(true);
  });

  it("launchd --follow: tail -f", async () => {
    const P = await logsCheckout();
    const exec = fakeExec();
    await serviceLogs({ ...base(P), env: {}, service: "apple-fm", lines: 50, follow: true, exec, out: () => {} });
    expect(exec.calls.map(shown)).toEqual(["tail -n 50 -f /tmp/metistry-apple-fm.log"]);
  });

  it("compose: docker compose logs --tail, and -f when following", async () => {
    const P = await logsCheckout();
    const exec = fakeExec();
    await serviceLogs({ ...base(P), env: {}, service: "console", lines: 200, follow: false, exec, out: () => {} });
    expect(exec.calls.map(shown)).toEqual(["docker compose logs console --tail 200"]);
    const exec2 = fakeExec();
    await serviceLogs({ ...base(P), env: {}, service: "console", lines: 200, follow: true, exec: exec2, out: () => {} });
    expect(exec2.calls.map(shown)).toEqual(["docker compose logs console --tail 200 -f"]);
  });

  it("an unknown service throws with the known list", async () => {
    const P = await logsCheckout();
    await expect(serviceLogs({ ...base(P), env: {}, service: "bogus", lines: 200, follow: false, exec: fakeExec(), out: () => {} })).rejects.toThrow(UnknownServiceError);
  });

  it("via main(): --lines and default 200, dry-run prints and runs nothing", async () => {
    const P = await logsCheckout();
    const exec = fakeExec();
    const lines: string[] = [];
    const code = await main(["logs", "apple-fm", "--dry-run", "--product-dir", P], { out: (l) => lines.push(l), err: () => {}, exec });
    expect(code).toBe(0);
    expect(exec.calls).toEqual([]);
    expect(lines.join("\n")).toContain("tail -n 200 /tmp/metistry-apple-fm.log");
  });

  it("via main(): a missing service name is a usage error", async () => {
    const P = await logsCheckout();
    const errs: string[] = [];
    const code = await main(["logs", "--product-dir", P], { out: () => {}, err: (l) => errs.push(l), exec: fakeExec() });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/usage: metistry logs/);
  });
});
