// `metistry down` — the other half of `up`, against fakes: the exact
// launchctl/compose argv per shape, the read-only confirmation that follows,
// containers stopped and never removed (no volume is ever named), the Mac
// app's registration reported rather than reached into, --dry-run and --json.
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import { downAll, renderDown } from "../src/service-control.js";
import { checkout, fakeExec, put, shown, HELPER, RECONCILER, SUPERVISOR, WATCHDOG } from "./fixtures.js";

const base = (P: string) => ({ productDir: P, platform: "darwin" as const, uid: 501, home: "/h", env: {} as NodeJS.ProcessEnv, out: () => {} });

const launchdCheckout = async () => {
  const P = await checkout();
  await put(P, "seed/deployment.yaml", "shape: launchd\nservices: {}\n");
  return P;
};

describe("metistry down", () => {
  it("compose shape: bootout every host agent, docker compose STOP every container, then confirm", async () => {
    const P = await checkout();
    const exec = fakeExec();
    const r = await downAll({ ...base(P), exec });
    expect(exec.calls.map(shown)).toEqual([
      // the supervisor is not an agent under compose, so nothing is asked
      // about a registrar — straight to stopping
      `launchctl bootout gui/501/${HELPER}`,
      `launchctl bootout gui/501/${RECONCILER}`,
      `launchctl bootout gui/501/${WATCHDOG}`,
      "docker compose stop console",
      "docker compose stop db",
      // the confirmation: read-only, and it really does go and look
      `launchctl print gui/501/${HELPER}`,
      `launchctl print gui/501/${RECONCILER}`,
      `launchctl print gui/501/${WATCHDOG}`,
      "docker compose ps --quiet",
    ]);
    expect(r.ok).toBe(true);
    expect(r.results.map((x) => x.service)).toEqual(["calendar", "reconciler", "watchdog", "console", "db"]);
    expect(r.results.every((x) => x.action === "stop")).toBe(true);
    expect(r.confirmations).toEqual([
      { name: HELPER, stopped: true, detail: "not loaded" },
      { name: RECONCILER, stopped: true, detail: "not loaded" },
      { name: WATCHDOG, stopped: true, detail: "not loaded" },
      { name: "compose", stopped: true, detail: "no containers running" },
    ]);
  });

  it("never removes a container and never names a volume: `stop`, never `down -v`", async () => {
    const P = await checkout();
    const exec = fakeExec();
    await downAll({ ...base(P), exec });
    const docker = exec.calls.filter((c) => c.cmd === "docker").map(shown);
    expect(docker).toEqual(["docker compose stop console", "docker compose stop db", "docker compose ps --quiet"]);
    expect(docker.join(" ")).not.toContain("-v");
    expect(docker.join(" ")).not.toContain("--volumes");
    expect(docker.some((d) => /compose (--\S+ \S+ )*down/.test(d))).toBe(false);
  });

  it("launchd shape: one bootout takes the children with it, and the children are not acted on", async () => {
    const P = await launchdCheckout();
    const exec = fakeExec();
    const r = await downAll({ ...base(P), exec });
    expect(exec.calls.map(shown)).toEqual([
      // who registered the one background item, asked BEFORE it is gone
      `launchctl print gui/501/${SUPERVISOR}`,
      `launchctl bootout gui/501/${SUPERVISOR}`,
      `launchctl print gui/501/${SUPERVISOR}`,
    ]);
    expect(r.results).toEqual([{ service: "supervisor", action: "stop", ok: true, detail: `launchctl bootout gui/501/${SUPERVISOR}` }]);
    expect(r.confirmations).toEqual([{ name: SUPERVISOR, stopped: true, detail: "not loaded" }]);
    expect(r.ok).toBe(true);
  });

  it("a job that is still loaded after the bootout is reported, and the verb fails", async () => {
    const P = await launchdCheckout();
    // launchctl print keeps answering: the job did not go
    const exec = fakeExec({ launchctl: (args) => (args[0] === "print" ? { code: 0, stdout: `path = /h/Library/LaunchAgents/${SUPERVISOR}.plist\nstate = running\n` } : undefined) });
    const r = await downAll({ ...base(P), exec });
    expect(r.confirmations).toEqual([{ name: SUPERVISOR, stopped: false, detail: `still loaded — launchctl print gui/501/${SUPERVISOR} answers` }]);
    expect(r.ok).toBe(false);
  });

  it("the Mac app's registration is reported, not reached into — no SMAppService, no login item touched", async () => {
    const P = await launchdCheckout();
    const exec = fakeExec({
      launchctl: (args) =>
        args[0] === "print" && args[1] === `gui/501/${SUPERVISOR}`
          ? { code: 0, stdout: "path = /Applications/Metistry.app/Contents/Library/LaunchAgents/com.foldedspacelabs.metistry.plist\n" }
          : undefined,
    });
    const r = await downAll({ ...base(P), exec });
    expect(r.appRegistrarNote).toContain("the Mac app, through SMAppService.agent(plistName:)");
    expect(r.appRegistrarNote).toContain("the next login");
    expect(r.appRegistrarNote).toContain("the CLI does not touch the app's login item");
    // and nothing beyond launchctl was run: the app's own registration is the
    // app's to change
    expect(exec.calls.every((c) => c.cmd === "launchctl")).toBe(true);
  });

  it("a container runtime that refuses to answer leaves the confirmation honest", async () => {
    const P = await checkout();
    const exec = fakeExec({ docker: (args) => (args[1] === "ps" ? { code: 1, stderr: "Cannot connect to the Docker daemon" } : undefined) });
    const r = await downAll({ ...base(P), exec });
    expect(r.confirmations.at(-1)).toMatchObject({ name: "compose", stopped: false });
    expect(r.confirmations.at(-1)!.detail).toContain("Cannot connect to the Docker daemon");
    expect(r.ok).toBe(false);
  });

  it("--dry-run runs nothing at all, confirmation included, and prints the plan", async () => {
    const P = await launchdCheckout();
    const exec = fakeExec();
    const lines: string[] = [];
    const r = await downAll({ ...base(P), exec, out: (l) => lines.push(l), dryRun: true });
    expect(exec.calls).toEqual([]);
    expect(r.commands).toEqual([`launchctl bootout gui/501/${SUPERVISOR}`]);
    expect(lines.join("\n")).toContain(`would ask: launchctl print gui/501/${SUPERVISOR}`);
  });

  it("renderDown shows what was stopped and what is confirmed gone", async () => {
    const P = await launchdCheckout();
    const r = await downAll({ ...base(P), exec: fakeExec() });
    const table = renderDown(r);
    expect(table).toContain("supervisor");
    expect(table).toContain(`gone  ${SUPERVISOR}  not loaded`);
    expect(table).toContain("1/1 confirmed stopped (shape launchd)");
  });

  it("via main(): exit 0, and --json puts one object on stdout with the plan on stderr", async () => {
    const P = await launchdCheckout();
    const out: string[] = [];
    const errs: string[] = [];
    const code = await main(["down", "--json", "--product-dir", P], { platform: "darwin", uid: 501, home: "/h", out: (l) => out.push(l), err: (l) => errs.push(l), exec: fakeExec() });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.shape).toBe("launchd");
    expect(parsed.results).toEqual([{ service: "supervisor", action: "stop", ok: true, detail: `launchctl bootout gui/501/${SUPERVISOR}` }]);
    expect(parsed.confirmations).toEqual([{ name: SUPERVISOR, stopped: true, detail: "not loaded" }]);
    // the plan went to stderr rather than vanishing
    expect(errs.join("\n")).toContain("== down");
  });

  it("via main(): a service name is a usage error pointing at `stop`", async () => {
    const P = await checkout();
    const errs: string[] = [];
    const code = await main(["down", "console", "--product-dir", P], { platform: "darwin", uid: 501, home: "/h", out: () => {}, err: (l) => errs.push(l), exec: fakeExec() });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("metistry stop console");
  });

  it("via main(): a job left loaded is a non-zero exit", async () => {
    const P = await launchdCheckout();
    const exec = fakeExec({ launchctl: (args) => (args[0] === "print" ? { code: 0, stdout: "state = running\n" } : undefined) });
    const code = await main(["down", "--product-dir", P], { platform: "darwin", uid: 501, home: "/h", out: () => {}, err: () => {}, exec });
    expect(code).toBe(1);
  });
});
