// X-122: doctor waits out a job it has just started. The recorder helper's
// socket is not there one second after bootstrap; the bridge's own `check()`
// says so (failed) and doctor used to believe it. The misuse side is held as
// hard as the grace: a job that was NOT just started is still reported failed,
// on the first answer, with no waiting.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { doctor, graceSubject, type DoctorRow } from "../src/doctor.js";
import { parseStarted, runnerGraceSec, serializeStarted, serviceAgeSec, startGraceSec, waitOutStart, type AgeContext } from "../src/doctor-grace.js";
import { labelFor } from "../src/launchd.js";
import { StepRunner } from "../src/steps.js";
import { closingDoctor } from "../src/up.js";
import { childClosingDoctor } from "../src/update.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const NOW = 1_800_000_000_000;
const RECORDER = labelFor("recorder");

const row = (status: DoctorRow["status"]): DoctorRow => ({ kind: "bridge", name: "live-capture", status, latency_ms: 1, probe: "GET /check" });

/** A clock the sleep moves, so a 30-second grace costs the test nothing. */
function fakeClock(start = NOW) {
  let t = start;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms: number) => void (slept.push(ms), (t += ms)), slept };
}

describe("waitOutStart", () => {
  it("a socket that answers inside the grace passes — and is asked again only until it does", async () => {
    const c = fakeClock();
    const answers: DoctorRow["status"][] = ["failed", "failed", "ok"];
    let probes = 0;
    const out = await waitOutStart(row("failed"), { reprobe: async () => row(answers[probes++]!), ageSec: async () => 1, graceSec: 30, sleep: c.sleep, now: c.now });
    expect(out.status).toBe("ok");
    expect(probes).toBe(3);
    expect(out.meta).toMatchObject({ waited_for_start: true, started_sec_ago: 1 });
  });

  it("a job that never answers fails once its grace is spent, and not before", async () => {
    const c = fakeClock();
    let probes = 0;
    const out = await waitOutStart(row("failed"), { reprobe: async () => (probes++, row("failed")), ageSec: async () => 10, graceSec: 30, sleep: c.sleep, now: c.now });
    expect(out.status).toBe("failed");
    // 20 s left of the grace, asked every second
    expect(c.slept.reduce((a, b) => a + b, 0)).toBe(20_000);
    expect(probes).toBe(20);
  });

  it("MISUSE: a job started past the grace is failed on the first answer — no sleeping, no second probe", async () => {
    const c = fakeClock();
    let probes = 0;
    for (const age of [30, 31, 3600]) {
      const out = await waitOutStart(row("failed"), { reprobe: async () => (probes++, row("ok")), ageSec: async () => age, graceSec: 30, sleep: c.sleep, now: c.now });
      expect(out.status, `age ${age}`).toBe("failed");
    }
    expect(probes).toBe(0);
    expect(c.slept).toEqual([]);
  });

  it("MISUSE: a job whose age nothing can tell is failed at once — unknown is not new", async () => {
    const c = fakeClock();
    let probes = 0;
    const out = await waitOutStart(row("failed"), { reprobe: async () => (probes++, row("ok")), ageSec: async () => undefined, graceSec: 30, sleep: c.sleep, now: c.now });
    expect(out.status).toBe("failed");
    expect(probes + c.slept.length).toBe(0);
  });

  it("only a failed row waits: ok, degraded and absent are returned as they came", async () => {
    const c = fakeClock();
    for (const status of ["ok", "degraded", "absent"] as const) {
      const first = row(status);
      expect(await waitOutStart(first, { reprobe: async () => row("failed"), ageSec: async () => 1, graceSec: 30, sleep: c.sleep, now: c.now })).toBe(first);
    }
    expect(c.slept).toEqual([]);
  });
});

describe("serviceAgeSec", () => {
  const exec = async () => ({ code: 127, stdout: "", stderr: "" });
  const ctx = (over: Partial<AgeContext> = {}): AgeContext => ({ env: {}, exec, uid: 501, platform: "linux", started: {}, nowMs: NOW, ...over });

  it("reads the supervisor's own uptime for a running child", async () => {
    const children = [{ name: "live-capture", state: "running", uptimeMs: 4_200 }] as AgeContext["children"];
    expect(await serviceAgeSec(ctx({ children }), "live-capture")).toBeCloseTo(4.2);
  });

  it("a stopped child has no uptime to read", async () => {
    const children = [{ name: "live-capture", state: "stopped", uptimeMs: 4_200 }] as AgeContext["children"];
    expect(await serviceAgeSec(ctx({ children }), "live-capture")).toBeUndefined();
  });

  it("takes the youngest witness: a job `up` just bootstrapped, though the process listing says it has run for an hour", async () => {
    const execAlive: AgeContext["exec"] = async (cmd) =>
      cmd === "launchctl" ? { code: 0, stdout: "\tstate = running\n\tpid = 99\n", stderr: "" } : { code: 0, stdout: "3600\n", stderr: "" };
    const age = await serviceAgeSec(ctx({ platform: "darwin", exec: execAlive, started: { [RECORDER]: NOW - 2_000 } }), "live-capture", ["live-capture", "recorder"]);
    expect(age).toBe(2);
  });

  it("the recorder helper counts for the bridge it answers for", async () => {
    const execHelper: AgeContext["exec"] = async (cmd, args) => {
      if (cmd === "launchctl") return args[1]!.endsWith(".recorder") ? { code: 0, stdout: "state = running\npid = 7\n", stderr: "" } : { code: 113, stdout: "", stderr: "" };
      return { code: 0, stdout: "1\n", stderr: "" };
    };
    expect(await serviceAgeSec(ctx({ platform: "darwin", exec: execHelper }), "live-capture", ["live-capture", "recorder"])).toBe(1);
    // …and without the helper in its jobs, nothing says the bridge is young
    expect(await serviceAgeSec(ctx({ platform: "darwin", exec: execHelper }), "live-capture", ["live-capture"])).toBeUndefined();
  });

  it("a supervisor child was restarted with the supervisor: its start counts, a stranger's does not", async () => {
    const children = [{ name: "console", state: "running", uptimeMs: 600_000 }] as AgeContext["children"];
    const started = { [labelFor("supervisor")]: NOW - 3_000 };
    expect((await serviceAgeSec(ctx({ children, started }), "console"))!).toBe(3);
    expect(await serviceAgeSec(ctx({ started }), "console")).toBeUndefined();
  });

  it("a start time in the future (a skewed clock) is zero seconds ago, never negative", async () => {
    expect(await serviceAgeSec(ctx({ started: { [labelFor("console")]: NOW + 60_000 } }), "console")).toBe(0);
  });

  it("a container's `Up 12 seconds` is its age", async () => {
    const execCompose: AgeContext["exec"] = async () => ({ code: 0, stdout: JSON.stringify([{ Service: "console", State: "running", Status: "Up 12 seconds" }]), stderr: "" });
    expect(await serviceAgeSec(ctx({ exec: execCompose, composeDir: "/p" }), "console")).toBe(12);
  });
});

describe("the hints and the knobs", () => {
  it("started-at hints round-trip through the environment, and a bad one grants less, never more", () => {
    const hints = { "com.x.recorder": NOW, "com.x.console": NOW - 5 };
    expect(parseStarted(serializeStarted(hints))).toEqual(hints);
    expect(parseStarted("garbage,=5,a=NaN,b=-3,c=0,d=7")).toEqual({ d: 7 });
    expect(parseStarted(undefined)).toEqual({});
  });

  it("the grace is configuration, with a default", () => {
    expect(startGraceSec({})).toBe(30);
    expect(startGraceSec({ METISTRY_DOCTOR_START_GRACE_SEC: "5" })).toBe(5);
    expect(runnerGraceSec({})).toBe(90);
    expect(runnerGraceSec({ METISTRY_RUNNER_TICK_MS: "10000", METISTRY_DOCTOR_START_GRACE_SEC: "5" })).toBe(15);
  });

  it("the live-capture bridge answers for its recorder helper; the brain bridge for the console", () => {
    expect(graceSubject("live-capture")).toEqual({ service: "live-capture", jobs: ["live-capture", "recorder"] });
    expect(graceSubject("brain")).toEqual({ service: "console", jobs: ["console"] });
    expect(graceSubject("eventkit")).toEqual({ service: "eventkit", jobs: ["eventkit"] });
  });
});

// The whole of doctor, over the real checkout's manifests: the recorder race.
describe("doctor: the recorder socket raced at `up`", () => {
  const TOKEN = "t".repeat(32);
  const failedBody = JSON.stringify({ name: "live-capture", status: "failed", latency_ms: 3, probe: "asked the helper", remediation: "ENOENT /…/lc-helper.sock — is lc-helper running?" });
  const okBody = JSON.stringify({ name: "live-capture", status: "ok", latency_ms: 3, probe: "asked the helper" });

  async function run(o: { answers: ("failed" | "ok")[]; startedAgoMs?: number }) {
    const c = fakeClock();
    let probes = 0;
    const fetchFn = (async (url: string) => {
      if (!String(url).includes("7814")) throw new Error("not in this test");
      const a = o.answers[Math.min(probes++, o.answers.length - 1)]!;
      return new Response(a === "ok" ? okBody : failedBody, { status: 200 });
    }) as unknown as typeof fetch;
    const report = await doctor({
      productDir: repoRoot,
      env: { METISTRY_LIVE_CAPTURE_URL: "http://127.0.0.1:7814", METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE: TOKEN },
      fetchFn,
      db: null,
      exec: async () => ({ code: 127, stdout: "", stderr: "" }),
      platform: "linux",
      namespace: null,
      now: c.now,
      sleep: c.sleep,
      ...(o.startedAgoMs !== undefined ? { startedAt: { [RECORDER]: c.now() - o.startedAgoMs } } : {}),
    });
    return { row: report.rows.find((r) => r.name === "live-capture")!, probes, slept: c.slept };
  }

  it("a helper bootstrapped a second ago whose socket answers within the grace passes", async () => {
    const r = await run({ answers: ["failed", "failed", "ok"], startedAgoMs: 1_000 });
    expect(r.row.status).toBe("ok");
    expect(r.probes).toBe(3);
  });

  it("MISUSE: the same failing socket with no start on record is reported failed on the first answer", async () => {
    const r = await run({ answers: ["failed", "ok"] });
    expect(r.row.status).toBe("failed");
    expect(r.probes).toBe(1);
    expect(r.slept).toEqual([]);
  });

  it("MISUSE: a helper bootstrapped long ago is failed too, however well it answers a moment later", async () => {
    const r = await run({ answers: ["failed", "ok"], startedAgoMs: 10 * 60_000 });
    expect(r.row.status).toBe("failed");
    expect(r.probes).toBe(1);
  });

  it("a helper bootstrapped a second ago that never answers still fails — after the grace, not before", async () => {
    const r = await run({ answers: ["failed"], startedAgoMs: 1_000 });
    expect(r.row.status).toBe("failed");
    expect(r.slept.reduce((a, b) => a + b, 0)).toBe(29_000);
  });

  it("the grace is configuration: METISTRY_DOCTOR_START_GRACE_SEC=0 turns the waiting off", async () => {
    const c = fakeClock();
    let probes = 0;
    const report = await doctor({
      productDir: repoRoot,
      env: { METISTRY_LIVE_CAPTURE_URL: "http://127.0.0.1:7814", METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE: TOKEN, METISTRY_DOCTOR_START_GRACE_SEC: "0" },
      fetchFn: (async (url: string) => {
        if (!String(url).includes("7814")) throw new Error("not in this test");
        probes++;
        return new Response(failedBody, { status: 200 });
      }) as unknown as typeof fetch,
      db: null,
      exec: async () => ({ code: 127, stdout: "", stderr: "" }),
      platform: "linux",
      namespace: null,
      now: c.now,
      sleep: c.sleep,
      startedAt: { [RECORDER]: c.now() - 1_000 },
    });
    expect(report.rows.find((r) => r.name === "live-capture")!.status).toBe("failed");
    expect(probes).toBe(1);
  });
});

// `up` and `update` hand doctor the jobs they have just started.
describe("the closing doctors pass on what was just started", () => {
  const report = { as_of: "now", product_dir: "x", shape: "compose" as const, ok: true, rows: [] };

  it("up's closing doctor gives doctor the start times it recorded", async () => {
    let seen: unknown;
    const r = new StepRunner({ dryRun: false, out: () => {}, env: {} });
    await closingDoctor(r, "/p", undefined, async (d) => ((seen = d.startedAt), report), { [RECORDER]: NOW });
    expect(seen).toEqual({ [RECORDER]: NOW });
  });

  it("a caller's own doctorDeps still win", async () => {
    let seen: unknown;
    const r = new StepRunner({ dryRun: false, out: () => {}, env: {} });
    await closingDoctor(r, "/p", { startedAt: { mine: 1 } }, async (d) => ((seen = d.startedAt), report), { [RECORDER]: NOW });
    expect(seen).toEqual({ mine: 1 });
  });

  it("update's child doctor gets them in its environment, where the child's doctor reads them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-grace-child-"));
    await mkdir(join(dir, "packages", "cli", "dist"), { recursive: true });
    await writeFile(
      join(dir, "packages", "cli", "dist", "main.js"),
      `process.stdout.write(JSON.stringify({ as_of: "now", product_dir: "x", shape: "compose", ok: true, rows: [{ kind: "manifest", name: "echo", status: "degraded", latency_ms: 0, probe: "echo", remediation: process.env.METISTRY_DOCTOR_STARTED ?? "unset" }] }));\n`,
    );
    const lines: string[] = [];
    const r = new StepRunner({ dryRun: false, out: (l) => lines.push(l), env: { PATH: process.env.PATH } });
    const code = await childClosingDoctor(r, { productDir: dir, runDir: dir, doctorFn: async () => report, startedAt: { [RECORDER]: NOW } });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain(`${RECORDER}=${NOW}`);
  });

  it("with nothing started the child's environment is untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-grace-child-"));
    await mkdir(join(dir, "packages", "cli", "dist"), { recursive: true });
    await writeFile(
      join(dir, "packages", "cli", "dist", "main.js"),
      `process.stdout.write(JSON.stringify({ as_of: "now", product_dir: "x", shape: "compose", ok: true, rows: [{ kind: "manifest", name: "echo", status: "degraded", latency_ms: 0, probe: "echo", remediation: process.env.METISTRY_DOCTOR_STARTED ?? "unset" }] }));\n`,
    );
    const lines: string[] = [];
    const r = new StepRunner({ dryRun: false, out: (l) => lines.push(l), env: { PATH: process.env.PATH } });
    await childClosingDoctor(r, { productDir: dir, runDir: dir, doctorFn: async () => report, startedAt: {} });
    expect(lines.join("\n")).toContain("unset");
  });
});
