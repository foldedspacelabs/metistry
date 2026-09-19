// What `metistry up` costs a person in wall-clock seconds, held in place by
// tests rather than by good intentions:
//
//   * the retire step asks launchd ONCE (`launchctl list`) instead of running
//     a bootout and an rm per retired label, and falls back to the old
//     unconditional sweep when it cannot ask;
//   * the Postgres readiness poll is fine-grained, so a server that is up in
//     300ms is not waited on for a whole second;
//   * doctor's independent probes run concurrently, so the closing table
//     costs the SLOWEST probe rather than the sum of all of them;
//   * `up` says where its time went, and who owns the processes it started.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/doctor.js";
import { parseLaunchctlList } from "../src/launchd.js";
import { StepRunner } from "../src/steps.js";
import { bootoutRetired, finishPostgres, fmtMs, renderTimings, runningNote, up, PG_READY_INTERVAL_MS, PG_READY_TRIES, type LaunchdEnv } from "../src/up.js";
import { checkout, fakeExec, launchctlList, okDoctor, retired, retiredCalls, shown } from "./fixtures.js";

const LE: LaunchdEnv = { platform: "darwin", uid: 501, home: "/h", node: "/usr/local/bin/node" };
const runner = (exec: ReturnType<typeof fakeExec>, dryRun = false) => new StepRunner({ dryRun, out: () => {}, exec, env: {} });

describe("parseLaunchctlList", () => {
  it("takes the third tab-separated column and drops the header", () => {
    const set = parseLaunchctlList(launchctlList(["console", "db"]));
    expect([...set]).toEqual(["com.foldedspacelabs.metistry.console", "com.foldedspacelabs.metistry.db"]);
    expect(set.has("Label")).toBe(false);
  });

  it("empty output is an empty set, not a crash", () => {
    expect(parseLaunchctlList("").size).toBe(0);
    expect(parseLaunchctlList("PID\tStatus\tLabel\n").size).toBe(0);
  });
});

describe("bootoutRetired: one probe, not sixteen commands", () => {
  it("nothing loaded and no plist left: ONE launchctl list, and not one bootout", async () => {
    const exec = fakeExec({ launchctl: (args) => (args[0] === "list" ? { code: 0, stdout: launchctlList([]) } : undefined) });
    const r = runner(exec);
    await bootoutRetired(r, LE, "launchd", undefined, () => false);
    // eight services, sixteen commands, every one of them a no-op — this is
    // what a Mac that migrated months ago used to pay on every `up`
    expect(exec.calls.map(shown)).toEqual(["launchctl list"]);
    expect(r.commands).toEqual([]);
  });

  it("a label launchd still has loaded IS booted out", async () => {
    const exec = fakeExec({ launchctl: (args) => (args[0] === "list" ? { code: 0, stdout: launchctlList(["console", "db"]) } : undefined) });
    const r = runner(exec);
    await bootoutRetired(r, LE, "launchd", undefined, () => false);
    expect(r.commands).toEqual([
      "launchctl bootout gui/501/com.foldedspacelabs.metistry.db",
      "rm -f /h/Library/LaunchAgents/com.foldedspacelabs.metistry.db.plist",
      "launchctl bootout gui/501/com.foldedspacelabs.metistry.console",
      "rm -f /h/Library/LaunchAgents/com.foldedspacelabs.metistry.console.plist",
    ]);
  });

  it("a stale plist with nothing loaded is still cleaned up", async () => {
    const exec = fakeExec({ launchctl: (args) => (args[0] === "list" ? { code: 0, stdout: launchctlList([]) } : undefined) });
    const r = runner(exec);
    await bootoutRetired(r, LE, "compose", undefined, (p) => p.endsWith("com.foldedspacelabs.metistry.eventkit-helper.plist"));
    expect(r.commands).toEqual([
      "launchctl bootout gui/501/com.foldedspacelabs.metistry.eventkit-helper",
      "rm -f /h/Library/LaunchAgents/com.foldedspacelabs.metistry.eventkit-helper.plist",
    ]);
  });

  it("launchctl cannot be asked: the old unconditional sweep, never a silent skip", async () => {
    const exec = fakeExec({ launchctl: (args) => (args[0] === "list" ? { code: 1, stdout: "", stderr: "boom" } : undefined) });
    const r = runner(exec);
    await bootoutRetired(r, LE, "launchd", undefined, () => false);
    expect(r.commands).toEqual(retired("/h", "launchd"));
  });

  it("a dry run runs no probe and prints the whole plan a real run could do", async () => {
    const exec = fakeExec();
    const r = runner(exec, true);
    await bootoutRetired(r, LE, "launchd", undefined, () => false);
    expect(exec.calls).toEqual([]);
    expect(r.commands).toEqual(retired("/h", "launchd"));
  });
});

describe("the Postgres readiness poll", () => {
  it("polls four times a second, keeping the 15s ceiling it always had", async () => {
    expect(PG_READY_INTERVAL_MS).toBe(250);
    expect((PG_READY_TRIES * PG_READY_INTERVAL_MS) / 1000).toBe(15);
  });

  it("sleeps the interval, not a whole second, between tries", async () => {
    let tries = 0;
    const slept: number[] = [];
    const exec = fakeExec({ "/pg/bin/pg_isready": () => ({ code: ++tries >= 3 ? 0 : 1, stdout: "", stderr: "" }) });
    const r = runner(exec);
    const plan = { toolchain: { bin: "/pg/bin", why: "test", pgvector: true }, dataDir: "/d", socketDir: "/s", port: 5432, user: "u", database: "db", password: "p", initialised: true };
    await finishPostgres(r, { plan, password: "p" }, async (ms) => void slept.push(ms));
    expect(slept).toEqual([250, 250]);
  });
});

describe("doctor probes concurrently", () => {
  it("independent probes overlap: the table costs the slowest probe, not the sum", async () => {
    const P = await checkout();
    const DELAY = 120;
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
    // every network probe and every subprocess is slow by the same amount —
    // in series this checkout's probes were a dozen of these back to back
    const fetchFn = (async (url: string) => {
      await sleep(DELAY);
      return new Response(JSON.stringify({ status: "ok", probe: String(url) }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const exec = async (_cmd: string, _args: string[]) => {
      await sleep(DELAY);
      return { code: 1, stdout: "", stderr: "" };
    };

    const t0 = Date.now();
    const report = await doctor({ productDir: P, env: {}, fetchFn, exec, db: null, platform: "darwin", uid: 501 });
    const elapsed = Date.now() - t0;

    // Every one of these rows waited `DELAY` on its own probe. Add their
    // latencies up and you get what doctor USED to cost, because it ran them
    // one after another; the wall clock is now a small multiple of one probe.
    const slow = report.rows.filter((r) => r.latency_ms >= DELAY);
    const inSeries = slow.reduce((n, r) => n + r.latency_ms, 0);
    expect(slow.length).toBeGreaterThanOrEqual(3);
    expect(inSeries).toBeGreaterThan(elapsed * 1.5);
    expect(elapsed).toBeLessThan(DELAY * 3);
  });
});

describe("up says where the time went and who owns what it started", () => {
  it("renderTimings is one readable line, and fmtMs switches to seconds", () => {
    expect(fmtMs(312)).toBe("312ms");
    expect(fmtMs(4120)).toBe("4.1s");
    expect(renderTimings([{ title: "launchd", ms: 900 }, { title: "doctor", ms: 1200 }], 2300)).toBe("launchd 900ms · doctor 1.2s — total 2.3s");
    expect(renderTimings([], 12)).toBe("total 12ms");
  });

  it("names the owner of the daemon per shape — never the CLI", () => {
    expect(runningNote("launchd")).toBe("running under launchd — `metistry down` stops it, `metistry logs <service> --follow` tails");
    expect(runningNote("compose")).toContain("running under docker compose");
  });

  it("a real up reports a timing per section and ends with the running note", async () => {
    const P = await checkout();
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const lines: string[] = [];
    const exec = fakeExec({ launchctl: (args) => (args[0] === "list" ? { code: 0, stdout: launchctlList([]) } : undefined) });
    const r = await up({ productDir: P, env: {}, platform: "darwin", uid: 501, node: "/usr/local/bin/node", exec, out: (l) => lines.push(l), home, doctorFn: okDoctor });
    // `cli` is the shim write (#220) — last of the install sections, before doctor's diagnosis
    expect(r.timings.map((t) => t.title)).toEqual(["compose", "launchd", "cli", "doctor"]);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(lines.at(-1)).toBe(`   ${runningNote("compose")}`);
    expect(lines.at(-3)).toBe("== timings");
    expect(lines.at(-2)).toContain("total ");
    // and the retire step really did cost one subprocess on this install
    expect(exec.calls.map(shown).slice(0, 2)).toEqual(["docker compose up -d --build", ...retiredCalls(home)]);
  });
});
