// `metistry up` against fakes: the exact --dry-run command list, the real
// run's call order (compose, then every plist rendered + bootstrapped, then
// doctor as the verdict), the failure path, the flags, release mode from
// the instance lock, and the Linux branch that prints systemd units instead
// of touching launchd.
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeLock } from "../src/lock.js";
import { main } from "../src/main.js";
import { up } from "../src/up.js";
import { checkout, failDoctor, fakeExec, HELPER, JOBS, okDoctor, RECONCILER, shown, WATCHDOG } from "./fixtures.js";

const NODE = "/usr/local/bin/node";
const base = (P: string) => ({ productDir: P, env: {} as NodeJS.ProcessEnv, platform: "darwin" as const, uid: 501, node: NODE });

describe("metistry up", () => {
  it("--dry-run prints the exact command list and runs nothing (not even doctor)", async () => {
    const P = await checkout();
    const exec = fakeExec();
    const lines: string[] = [];
    let doctorRan = false;
    const r = await up({ ...base(P), exec, out: (l) => lines.push(l), dryRun: true, home: "/h", doctorFn: async (d) => ((doctorRan = true), failDoctor(d)) });

    expect(exec.calls).toEqual([]);
    expect(doctorRan).toBe(false);
    expect(r.code).toBe(0);
    expect(r.source).toBe("git");
    const LA = "/h/Library/LaunchAgents";
    const job = (label: string) => [
      `write ${LA}/${label}.plist  (from ops/launchd/${label}.plist, __REPO__=${P}, __NODE__=${NODE}, __ENV_FILE__=${join(P, ".env")})`,
      `launchctl bootout gui/501/${label}`,
      `launchctl bootstrap gui/501 ${LA}/${label}.plist`,
      `launchctl kickstart -k gui/501/${label}`,
    ];
    expect(r.commands).toEqual([`(cd ${P} && docker compose up -d --build)`, ...JOBS.flatMap(job), "metistry doctor"]);
    expect(lines.filter((l) => !l.startsWith("[dry-run]") && !l.startsWith("   "))).toEqual([]);
    expect(existsSync(`${LA}`)).toBe(false);
  });

  it("runs compose, renders + bootstraps every plist with no placeholder left, then doctor decides the exit code", async () => {
    const P = await checkout();
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const exec = fakeExec();
    const r = await up({ ...base(P), exec, out: () => {}, home, doctorFn: okDoctor });
    expect(r.code).toBe(0);
    expect(exec.calls.map(shown)).toEqual([
      "docker compose up -d --build",
      ...JOBS.flatMap((label) => [
        `launchctl bootout gui/501/${label}`,
        // bootout is asynchronous; bootstrapping before launchd is done gives
        // `Bootstrap failed: 5: Input/output error`
        `launchctl print gui/501/${label}`,
        `launchctl bootstrap gui/501 ${home}/Library/LaunchAgents/${label}.plist`,
        `launchctl kickstart -k gui/501/${label}`,
      ]),
    ]);
    expect(exec.calls[0]!.cwd).toBe(P);
    for (const label of JOBS) {
      const text = readFileSync(join(home, "Library", "LaunchAgents", `${label}.plist`), "utf8");
      expect(text, label).not.toMatch(/__[A-Z]+__/);
      expect(text).toContain(`<string>${label}</string>`);
    }
    expect(readFileSync(join(home, "Library", "LaunchAgents", `${WATCHDOG}.plist`), "utf8")).toContain(`set -a; . ${P}/.env; set +a; exec ${NODE} ${P}/apps/watchdog/dist/main.js`);
    expect(readFileSync(join(home, "Library", "LaunchAgents", `${HELPER}.plist`), "utf8")).toContain(`<string>${P}/packages/mcp-eventkit/helper/ek-helper.app/Contents/MacOS/ek-helper</string>`);

    // the closing doctor is the verdict
    const r2 = await up({ ...base(P), exec: fakeExec(), out: () => {}, home, doctorFn: failDoctor });
    expect(r2.code).toBe(1);
  });

  it("a failing step stops the plan, still runs doctor for the diagnosis, and keeps the failure's exit code", async () => {
    const P = await checkout();
    const exec = fakeExec({ docker: () => ({ code: 17, stderr: "Cannot connect to the Docker daemon" }) });
    const lines: string[] = [];
    let doctorRan = false;
    const r = await up({ ...base(P), exec, out: (l) => lines.push(l), home: "/h", doctorFn: async (d) => ((doctorRan = true), okDoctor(d)) });
    expect(r.code).toBe(17);
    expect(doctorRan).toBe(true);
    expect(exec.calls.map(shown)).toEqual(["docker compose up -d --build"]); // nothing after the failure
    expect(lines.join("\n")).toContain("metistry up: docker compose exited 17: Cannot connect to the Docker daemon");
  });

  it("a bootout of a job that is not loaded is tolerated; a failed bootstrap is not", async () => {
    const P = await checkout();
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const tolerated = fakeExec({ launchctl: (args) => (args[0] === "bootout" ? { code: 3, stderr: "Boot-out failed: 3: No such process" } : undefined) });
    expect((await up({ ...base(P), exec: tolerated, out: () => {}, home, doctorFn: okDoctor })).code).toBe(0);
    const broken = fakeExec({ launchctl: (args) => (args[0] === "bootstrap" ? { code: 5, stderr: "Bootstrap failed: 5: Input/output error" } : undefined) });
    const r = await up({ ...base(P), exec: broken, out: () => {}, home, doctorFn: okDoctor });
    expect(r.code).toBe(5);
    expect(broken.calls.map(shown)).toEqual([
      "docker compose up -d --build",
      `launchctl bootout gui/501/${HELPER}`,
      // the poll that waits out launchd's asynchronous teardown
      `launchctl print gui/501/${HELPER}`,
      `launchctl bootstrap gui/501 ${home}/Library/LaunchAgents/${HELPER}.plist`,
    ]);
  });

  it("--no-compose and --no-launchd skip their phases", async () => {
    const P = await checkout();
    const a = await up({ ...base(P), exec: fakeExec(), out: () => {}, dryRun: true, home: "/h", compose: false });
    expect(a.commands).toEqual([...JOBS.flatMap((l) => [expect.stringContaining(`write /h/Library/LaunchAgents/${l}.plist`), `launchctl bootout gui/501/${l}`, `launchctl bootstrap gui/501 /h/Library/LaunchAgents/${l}.plist`, `launchctl kickstart -k gui/501/${l}`]), "metistry doctor"]);
    const b = await up({ ...base(P), exec: fakeExec(), out: () => {}, dryRun: true, home: "/h", launchd: false });
    expect(b.commands).toEqual([`(cd ${P} && docker compose up -d --build)`, "metistry doctor"]);
  });

  it("release mode (the instance lock says source: release) pulls the pinned images and never builds", async () => {
    const P = await checkout();
    const inst = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    await writeFile(join(inst, "metistry.lock"), serializeLock({ product: { version: "1.0.0", commit: "abc", source: "release" }, updated_at: "2026-09-07T00:00:00.000Z", migrations_applied: [] }));
    const r = await up({ ...base(P), env: { METISTRY_INSTANCE_DIR: inst }, exec: fakeExec(), out: () => {}, dryRun: true, home: "/h", launchd: false });
    expect(r.source).toBe("release");
    // compose is told where the instance's .env is: its own `./.env` is not this install's environment
    const ef = join(inst, "state", ".env");
    expect(r.commands).toEqual([`(cd ${P} && docker compose --env-file ${ef} pull)`, `(cd ${P} && docker compose --env-file ${ef} up -d --no-build)`, "metistry doctor"]);
  });

  it("on Linux prints the systemd user units instead of touching launchd, and writes nothing", async () => {
    const P = await checkout();
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const exec = fakeExec();
    const lines: string[] = [];
    const r = await up({ ...base(P), platform: "linux", exec, out: (l) => lines.push(l), home, compose: false, doctorFn: okDoctor });
    expect(r.code).toBe(0);
    expect(exec.calls).toEqual([]);
    expect(existsSync(join(home, "Library"))).toBe(false);
    expect(existsSync(join(home, ".config"))).toBe(false);
    const text = lines.join("\n");
    expect(text).toContain("NOT written");
    expect(text).toContain(`# ~/.config/systemd/user/${WATCHDOG}.service`);
    expect(text).toContain(`EnvironmentFile=${P}/.env`);
    expect(text).toContain(`WorkingDirectory=${P}`);
    expect(text).toContain(`ExecStart=${NODE} ${P}/apps/watchdog/dist/main.js`);
    expect(text).toContain(`ExecStart=${NODE} ${P}/apps/reconciler/dist/main.js`);
    expect(text).toContain("Environment=METISTRY_EK_SOCKET=/tmp/x.sock");
    expect(text).toContain(`ExecStart=${P}/packages/mcp-eventkit/helper/ek-helper.app/Contents/MacOS/ek-helper`);
    expect(text).not.toMatch(/__[A-Z]+__/);
    expect(text).toContain(`Description=Metistry reconciler`);
    expect(r.commands).toEqual(["metistry doctor"]);
  });

  it("main: `up --dry-run` wires the flags and exits 0 without executing anything", async () => {
    const P = await checkout();
    const exec = fakeExec();
    const lines: string[] = [];
    expect(await main(["up", "--dry-run", "--no-launchd", "--product-dir", P], { out: (l) => lines.push(l), err: () => {}, exec })).toBe(0);
    expect(exec.calls).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain(`docker compose up -d --build`);
    expect(text).not.toContain("launchctl");
    expect(text).toContain("[dry-run] metistry doctor");
  });

  it("the closing doctor gets the same env and exec the plan ran with", async () => {
    const P = await checkout();
    const exec = fakeExec();
    const env = { METISTRY_CONSOLE_URL: "http://127.0.0.1:9999" };
    let seen: { env?: NodeJS.ProcessEnv; exec?: unknown } = {};
    const r = await up({ ...base(P), env, exec, out: () => {}, home: "/h", compose: false, launchd: false, doctorFn: async (d) => ((seen = { env: d.env, exec: d.exec }), okDoctor(d)) });
    expect(r.code).toBe(0);
    expect(seen.env).toBe(env);
    expect(seen.exec).toBe(exec);
    expect(RECONCILER.startsWith("com.foldedspacelabs.metistry.")).toBe(true);
  });
});
