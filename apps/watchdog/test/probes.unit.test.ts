// Decision logic for the Phase 3–4 follow-up probes, with fakes: the 3×
// silence rule, the FM-tier counting, and the down/degraded split for
// bridges. No db, no network — the integration test covers the SQL.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runProbes, silentComponents, fmTierNeverFires, type ProbeConfig } from "../src/probes.js";
import { bridgesFromEnv, checkBridge, hostLocal, summarizeBridges, type BridgeOutcome } from "../src/bridges.js";
import { loadScheduled } from "../src/manifests.js";
import { alertFailures, isFailure } from "../src/alert.js";

const now = new Date("2026-09-06T12:00:00Z");
const ago = (sec: number) => new Date(now.getTime() - sec * 1000);
const comp = (name: string, intervalSec: number, lastRunAt: Date | null) => ({
  name,
  runKind: "collector_run" as const,
  schedule: `*/${intervalSec / 60} * * * *`,
  intervalSec,
  lastRunAt,
});

describe("silent-collector: the 3× rule", () => {
  it("a run inside factor × interval is not silent; one just past it is", () => {
    expect(silentComponents([comp("a", 300, ago(900))], now, ago(99999), 3)).toEqual([]);
    const silent = silentComponents([comp("a", 300, ago(901))], now, ago(99999), 3);
    expect(silent).toHaveLength(1);
    expect(silent[0]).toMatchObject({ name: "a", limitSec: 900, silentSec: 901, neverRan: false });
  });

  it("never-ran counts from watchdog start, so a fresh install stays quiet until the limit passes", () => {
    expect(silentComponents([comp("a", 300, null)], now, ago(100), 3)).toEqual([]);
    const silent = silentComponents([comp("a", 300, null)], now, ago(1000), 3);
    expect(silent[0]).toMatchObject({ name: "a", neverRan: true });
  });

  it("the factor is the knob", () => {
    expect(silentComponents([comp("a", 300, ago(700))], now, ago(99999), 2)).toHaveLength(1);
    expect(silentComponents([comp("a", 300, ago(700))], now, ago(99999), 3)).toHaveLength(0);
  });
});

describe("fm-tier-never-fires: counting", () => {
  it("fires only with enough rule-default captures AND deterministic fallbacks outnumbering apple-fm", () => {
    expect(fmTierNeverFires({ ruleDefault: 5, fm: 0 }, 5)).toBe(true);
    expect(fmTierNeverFires({ ruleDefault: 4, fm: 0 }, 5)).toBe(false); // too few to claim anything
    expect(fmTierNeverFires({ ruleDefault: 5, fm: 5 }, 5)).toBe(false); // the tier is firing
    expect(fmTierNeverFires({ ruleDefault: 6, fm: 5 }, 5)).toBe(true);
    expect(fmTierNeverFires({ ruleDefault: 0, fm: 3 }, 5)).toBe(false);
  });
});

describe("bridge-degraded: down vs degraded", () => {
  const ok = (name: string): BridgeOutcome => ({ name, state: "ok", message: `${name} ok` });

  it("nothing configured is absent, not a failure", () => {
    expect(summarizeBridges([]).status).toBe("absent");
    expect(isFailure({ name: "bridge-degraded", status: "absent", latency_ms: 0, probe: "p" })).toBe(false);
  });

  it("a bridge whose own check() says no is degraded, in its own words", () => {
    const s = summarizeBridges([ok("eventkit"), { name: "apple-fm", state: "degraded", message: "apple-fm failed: helper check failed — FM assets?" }]);
    expect(s.status).toBe("degraded");
    expect(s.remediation).toBe("apple-fm failed: helper check failed — FM assets?");
    expect(s.meta).toEqual({ bridges: { eventkit: "ok", "apple-fm": "degraded" } });
  });

  it("anything unreachable or refusing the token makes the probe failed, listing every bad bridge", () => {
    const s = summarizeBridges([
      { name: "apple-fm", state: "degraded", message: "apple-fm failed: x" },
      { name: "eventkit", state: "down", message: "eventkit down (ECONNREFUSED) — launchctl kickstart" },
    ]);
    expect(s.status).toBe("failed");
    expect(s.remediation).toContain("apple-fm failed: x");
    expect(s.remediation).toContain("eventkit down");
    expect(summarizeBridges([{ name: "apple-fm", state: "unauthorized", message: "token" }]).status).toBe("failed");
  });

  it("checkBridge classifies the wire: throw=down, 401=unauthorized, contract not-ok=degraded, non-contract=down", async () => {
    const target = { name: "apple-fm", url: "http://127.0.0.1:7810", token: "t", launchdLabel: "com.foldedspacelabs.metistry.apple-fm" };
    const seen: { url: string; auth: string | undefined }[] = [];
    const answer = (status: number, body: unknown) =>
      (async (url: string, init?: RequestInit) => {
        seen.push({ url, auth: (init?.headers as Record<string, string>)?.authorization });
        return { ok: status < 400, status, json: async () => body };
      }) as unknown as typeof fetch;

    const down = await checkBridge(target, (async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:7810"); }) as unknown as typeof fetch);
    expect(down.state).toBe("down");
    expect(down.message).toContain("ECONNREFUSED");
    expect(down.message).toContain("launchctl kickstart -k gui/$(id -u)/com.foldedspacelabs.metistry.apple-fm");

    expect((await checkBridge(target, answer(401, { error: { code: "unauthenticated" } }))).state).toBe("unauthorized");
    expect(seen[0]).toEqual({ url: "http://127.0.0.1:7810/check", auth: "Bearer t" });

    const good = { name: "apple-fm", status: "ok", latency_ms: 12, probe: "real classification", meta: { category: "note" } };
    expect((await checkBridge(target, answer(200, good))).state).toBe("ok");

    const bad = { ...good, status: "failed", remediation: "helper check failed — is this an Apple Silicon Mac with FM assets?" };
    const degraded = await checkBridge(target, answer(503, bad));
    expect(degraded.state).toBe("degraded");
    expect(degraded.message).toBe("apple-fm failed: helper check failed — is this an Apple Silicon Mac with FM assets?");

    const notContract = await checkBridge(target, answer(200, { hello: "world" }));
    expect(notContract.state).toBe("down");
    expect(notContract.message).toContain("without a check() body");
  });

  it("env → targets: container-facing URLs are rewritten to loopback (the watchdog is on the host)", () => {
    expect(hostLocal("http://host.docker.internal:7810")).toBe("http://127.0.0.1:7810");
    expect(hostLocal("http://127.0.0.1:7811/")).toBe("http://127.0.0.1:7811");
    expect(bridgesFromEnv({})).toEqual([]);
    const targets = bridgesFromEnv({
      METISTRY_AFM_URL: "http://host.docker.internal:7810",
      METISTRY_BRIDGE_TOKEN_APPLE_FM: "a",
      METISTRY_EK_URL: "http://host.docker.internal:7811", // token deliberately missing: still probed, will 401
      METISTRY_RECONCILER_URL: "http://127.0.0.1:7812",
      METISTRY_BRIDGE_TOKEN_RECONCILER: "r",
    });
    expect(targets.map((t) => [t.name, t.url, t.token])).toEqual([
      ["apple-fm", "http://127.0.0.1:7810", "a"],
      ["eventkit", "http://127.0.0.1:7811", undefined],
      ["reconciler", "http://127.0.0.1:7812", "r"],
    ]);
  });
});

// ---- the probes end to end over a fake db -----------------------------------

interface FakeWorld {
  lastRuns: { component: string; kind: string; last: Date }[];
  fmCounts: { fm: number; rule_default: number };
}

function fakeDb(world: FakeWorld) {
  const inserted: string[] = [];
  return {
    inserted,
    async query(text: string, values?: unknown[]) {
      if (text.includes("FROM inbound_messages")) return { rows: [{ stuck_new: "0", stuck_proc: "0" }] };
      if (text.includes("finished_at IS NULL")) return { rows: [{ n: "0" }] };
      if (text.includes("sum(cost_usd)")) return { rows: [{ usd: "0" }] };
      if (text.includes("FROM auth_sessions")) return { rows: [{ n: "1" }] };
      if (text.includes("GROUP BY component, kind")) return { rows: world.lastRuns };
      if (text.includes("FROM proposals")) return { rows: [{ fm: String(world.fmCounts.fm), rule_default: String(world.fmCounts.rule_default) }] };
      if (text.includes("FROM outbound_messages")) return { rows: inserted.includes(values![0] as string) ? [1] : [] };
      if (text.includes("INSERT INTO outbound_messages")) { inserted.push(values![0] as string); return { rows: [] }; }
      return { rows: [] };
    },
  };
}

async function manifestDirs() {
  const root = await mkdtemp(join(tmpdir(), "wd-manifests-"));
  await mkdir(join(root, "collectors", "fast"), { recursive: true });
  await writeFile(join(root, "collectors", "fast", "manifest.yaml"), `name: fast\ntype: collector\nschedule: "*/5 * * * *"\nwrites: [x]\n`);
  await mkdir(join(root, "collectors", "notes"), { recursive: true }); // no manifest → not a component
  await mkdir(join(root, "routines", "slow"), { recursive: true });
  await writeFile(join(root, "routines", "slow", "manifest.yaml"), `name: slow\ntype: routine\nschedule: "@daily"\n`);
  return { collectorsDir: join(root, "collectors"), routinesDir: join(root, "routines") };
}

const bridgeFetch = (afm: "ok" | "failed" | "dead") =>
  (async (url: string) => {
    if (!url.endsWith("/check")) return { ok: true, status: 200 };
    if (afm === "dead") throw new Error("connect ECONNREFUSED");
    const body = { name: "apple-fm", status: afm, latency_ms: 1, probe: "canned", ...(afm === "failed" ? { remediation: "helper check failed" } : {}) };
    return { ok: afm === "ok", status: afm === "ok" ? 200 : 503, json: async () => body };
  }) as unknown as typeof fetch;

async function cfgFor(extra: Partial<ProbeConfig> = {}): Promise<ProbeConfig> {
  return {
    consoleUrl: "http://test",
    stuckNewMin: 5,
    stuckProcessingMin: 15,
    inflightRunMin: 15,
    hourlyCostUsd: 5,
    ...(await manifestDirs()),
    silenceFactor: 3,
    startedAt: new Date(),
    bridges: [{ name: "apple-fm", url: "http://127.0.0.1:7810", token: "t" }],
    fmMinCaptures: 5,
    fmWindowHours: 24,
    ...extra,
  };
}

describe("probes over a fake db", () => {
  it("manifest discovery: directories with a collector/routine manifest, interval from core's parser", async () => {
    const dirs = await manifestDirs();
    expect(await loadScheduled(dirs.collectorsDir)).toEqual([{ name: "fast", runKind: "collector_run", schedule: "*/5 * * * *", intervalSec: 300 }]);
    expect(await loadScheduled(dirs.routinesDir)).toEqual([{ name: "slow", runKind: "routine_run", schedule: "@daily", intervalSec: 86400 }]);
    expect(await loadScheduled(join(dirs.routinesDir, "does-not-exist"))).toEqual([]);
  });

  it("assistant-drain: a queue nobody is draining is `absent` when the assistant is not a supervisor child (W1), and still failed when it is", async () => {
    const db = fakeDb({ lastRuns: [], fmCounts: { fm: 0, rule_default: 0 } });
    // three fold turns waiting, one abandoned mid-processing
    const query = ((orig) => async (text: string, values?: unknown[]) => {
      if (text.includes("FROM inbound_messages")) return { rows: [{ stuck_new: "3", stuck_proc: "1" }] };
      return orig(text, values);
    })(db.query.bind(db));

    // with an engine configured, this is the probe it has always been
    const running = (await runProbes({ query }, await cfgFor(), bridgeFetch("ok"))).find((c) => c.name === "assistant-drain")!;
    expect(running.status).toBe("failed");
    expect(isFailure(running)).toBe(true);

    // without one, the same rows are the expected state — and alert.ts raises
    // nothing for `absent`, so the operator is not paged every minute
    const absent = (await runProbes({ query }, await cfgFor({ assistantAbsent: true }), bridgeFetch("ok"))).find((c) => c.name === "assistant-drain")!;
    expect(absent.status).toBe("absent");
    expect(isFailure(absent)).toBe(false);
    expect(absent.remediation).toMatch(/no engine, so the supervisor does not start the assistant/);
    expect(absent.remediation).toContain("metistry compute assign default"); // the line that would give it one (R3)
    expect(absent.meta).toEqual({ waiting_new: 3, waiting_processing: 1 });
  });

  it("silent-collector names the quiet component with its limit and schedule, never a changing age (dedupe-stable)", async () => {
    const db = fakeDb({ lastRuns: [{ component: "fast", kind: "collector_run", last: ago(0) }], fmCounts: { fm: 0, rule_default: 0 } });
    const cfg = await cfgFor();
    // fast ran 20 real minutes ago (limit 15m); slow never ran but the watchdog just started
    db.query = ((orig) => async (text: string, values?: unknown[]) => {
      if (text.includes("GROUP BY component, kind")) return { rows: [{ component: "fast", kind: "collector_run", last: new Date(Date.now() - 20 * 60_000) }] };
      return orig(text, values);
    })(db.query);
    const checks = await runProbes(db, cfg, bridgeFetch("ok"));
    const silent = checks.find((c) => c.name === "silent-collector")!;
    expect(silent.status).toBe("failed");
    expect(silent.remediation).toContain('fast (no run in >15m; schedule "*/5 * * * *")');
    expect(silent.remediation).not.toContain("slow");
    expect(silent.remediation).not.toMatch(/\b20m\b/); // the age lives in meta, not the alert text
    expect(silent.meta).toMatchObject({ scheduled: 2, silent: { fast: expect.any(Number) } });
  });

  it("silent-collector: never-ran becomes silent once the watchdog has been up longer than the limit", async () => {
    const db = fakeDb({ lastRuns: [{ component: "fast", kind: "collector_run", last: new Date() }], fmCounts: { fm: 0, rule_default: 0 } });
    const cfg = await cfgFor({ startedAt: new Date(Date.now() - 4 * 86400_000) });
    const silent = (await runProbes(db, cfg, bridgeFetch("ok"))).find((c) => c.name === "silent-collector")!;
    expect(silent.status).toBe("failed");
    expect(silent.remediation).toContain('slow (never ran since watchdog start; schedule "@daily")');
  });

  it("fm-tier-never-fires: healthy bridge + deterministic fallbacks outnumbering the model = degraded, with the console-side fix", async () => {
    const db = fakeDb({ lastRuns: [{ component: "fast", kind: "collector_run", last: new Date() }], fmCounts: { fm: 0, rule_default: 7 } });
    const checks = await runProbes(db, await cfgFor(), bridgeFetch("ok"));
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["bridge-degraded"]!.status).toBe("ok");
    expect(byName["fm-tier-never-fires"]!.status).toBe("degraded");
    // the fix is now two-sided: the provider has to be declared, AND the
    // bearer has to be where the console can read it
    expect(byName["fm-tier-never-fires"]!.remediation).toContain("metistry compute providers add --from applefm");
    expect(byName["fm-tier-never-fires"]!.remediation).toContain("METISTRY_BRIDGE_TOKEN_APPLE_FM");
    expect(byName["fm-tier-never-fires"]!.meta).toEqual({ ruleDefault: 7, fm: 0 });
  });

  it("fm-tier-never-fires stays quiet when the tier is firing, or when the bridge itself is unhealthy (bridge-degraded owns that)", async () => {
    const firing = fakeDb({ lastRuns: [], fmCounts: { fm: 4, rule_default: 3 } });
    expect((await runProbes(firing, await cfgFor(), bridgeFetch("ok"))).find((c) => c.name === "fm-tier-never-fires")!.status).toBe("ok");

    const idle = fakeDb({ lastRuns: [], fmCounts: { fm: 0, rule_default: 9 } });
    const checks = await runProbes(idle, await cfgFor(), bridgeFetch("failed"));
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["bridge-degraded"]!.status).toBe("degraded");
    expect(byName["bridge-degraded"]!.remediation).toBe("apple-fm failed: helper check failed");
    expect(byName["fm-tier-never-fires"]!.status).toBe("ok");
    expect(byName["fm-tier-never-fires"]!.meta).toMatchObject({ bridge: "degraded" });

    const dead = await runProbes(idle, await cfgFor(), bridgeFetch("dead"));
    const bd = dead.find((c) => c.name === "bridge-degraded")!;
    expect(bd.status).toBe("failed");
    expect(bd.remediation).toContain("apple-fm down (connect ECONNREFUSED)");
  });

  it("no bridges configured: both bridge probes are absent and raise no alert", async () => {
    const db = fakeDb({ lastRuns: [], fmCounts: { fm: 0, rule_default: 9 } });
    const checks = await runProbes(db, await cfgFor({ bridges: [] }), bridgeFetch("ok"));
    const byName = Object.fromEntries(checks.map((c) => [c.name, c.status]));
    expect(byName["bridge-degraded"]).toBe("absent");
    expect(byName["fm-tier-never-fires"]).toBe("absent");
    expect(await alertFailures(db, checks)).toBe(0);
    expect(db.inserted).toEqual([]);
  });

  it("alert text is the probe's remediation; degraded alerts, absent does not", async () => {
    const db = fakeDb({ lastRuns: [], fmCounts: { fm: 0, rule_default: 0 } });
    const raised = await alertFailures(db, [
      { name: "bridge-degraded", status: "degraded", latency_ms: 1, probe: "p", remediation: "apple-fm failed: helper check failed" },
      { name: "fm-tier-never-fires", status: "absent", latency_ms: 1, probe: "p" },
    ]);
    expect(raised).toBe(1);
    expect(db.inserted).toEqual(["watchdog: bridge-degraded degraded — apple-fm failed: helper check failed"]);
  });
});
