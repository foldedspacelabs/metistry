// `metistry doctor` against fakes: a synthetic checkout in a temp dir,
// injected fetch (bridges + console), injected db, injected exec
// (launchctl + docker). Every status — ok, degraded, failed, absent — and
// the exit code. No network, no db, no subprocess.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliRow, confinementRow, doctor, hostLocal, inboxRow, parseComposePs, parseLaunchctlPrint, probeTargetFor, renderTable, walkManifests, type Db, type DoctorRow } from "../src/doctor.js";
import { SANDBOX_EXEC } from "../src/sandbox.js";
import { cliShimPath, writeCliShim } from "../src/cli-shim.js";
import { StepRunner } from "../src/steps.js";
import { parseDotEnv } from "../src/env.js";
import { BOOLEAN_FLAGS, main, parseArgs } from "../src/main.js";
import type { Exec } from "../src/exec.js";

const PLIST = (label: string) => `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string></dict></plist>`;

/** A minimal product checkout: two collectors, two bridges, two services, a target, migrations, plists, compose. */
async function checkout(opts: { brokenManifests?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "metistry-doctor-"));
  const put = async (rel: string, text: string) => {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), text);
  };
  await put("package.json", JSON.stringify({ name: "metistry" }));
  await put("seed/identity.yaml", "name: Seed\n");
  await put("collectors/good/manifest.yaml", "name: good\ntype: collector\nschedule: '@hourly'\nwrites: [t]\n");
  await put("packages/mcp-x/manifest.yaml", "name: x\ntype: bridge\ntransport: http\nport: 7901\nruns_on: host\nexposes: [{name: a}]\n");
  await put("packages/mcp-y/manifest.yaml", "name: y\ntype: bridge\ntransport: http\nport: 7902\nruns_on: host\nexposes: [{name: a}]\n");
  await put("apps/console/manifest.yaml", "name: console\ntype: service\nruns_on: container\nport: 8080\n");
  await put("apps/watchdog/manifest.yaml", "name: watchdog\ntype: service\nruns_on: host\n");
  await put("targets/tgt/manifest.yaml", "name: tgt\ntype: target\ntransport: local\nsubmit: {}\nresult: {via: report_queue}\ndata_policy: {allow: [], deny_sources: [], max_brief_bytes: 10}\n");
  await put("db/migrations/0001_a.sql", "select 1;");
  await put("db/migrations/0002_b.sql", "select 1;");
  await put("ops/launchd/com.foldedspacelabs.metistry.a.plist", PLIST("com.foldedspacelabs.metistry.a"));
  await put("ops/launchd/com.foldedspacelabs.metistry.b.plist", PLIST("com.foldedspacelabs.metistry.b"));
  await put("docker-compose.yml", "services:\n  db: {}\n  console: {}\n  assistant: {}\n");
  if (opts.brokenManifests) {
    await put("collectors/bad/manifest.yaml", "name: bad\ntype: collector\nwrites: [t]\n"); // no schedule
    await put("collectors/notyaml/manifest.yaml", "name: [\n");
    await put("targets/mismatch/manifest.yaml", "name: other\ntype: target\ntransport: local\nsubmit: {}\nresult: {via: report_queue}\ndata_policy: {allow: [], deny_sources: [], max_brief_bytes: 10}\n");
  }
  return root;
}

type Res = { status: number; ok: boolean; json?: () => Promise<unknown> };
const res = (status: number, body?: unknown): Res => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const checkBody = (status: "ok" | "degraded" | "failed", remediation?: string) => ({ name: "x", status, latency_ms: 1, probe: "canned", ...(remediation ? { remediation } : {}) });

/** fetch keyed by URL suffix; a value that is an Error is thrown (connection refused). */
const fakeFetch = (routes: Record<string, Res | Error>, seen: { url: string; auth?: string }[] = []) =>
  (async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ url, ...(init?.headers?.authorization ? { auth: init.headers.authorization } : {}) });
    const hit = Object.entries(routes).find(([suffix]) => url.endsWith(suffix))?.[1];
    if (!hit) throw new Error(`unrouted ${url}`);
    if (hit instanceof Error) throw hit;
    return hit;
  }) as unknown as typeof fetch;

const fakeDb = (applied: string[] | "no-table" | Error): Db => ({
  query: async (text: string) => {
    if (applied instanceof Error) throw applied;
    if (text.startsWith("SELECT 1")) return { rows: [{ "?column?": 1 }] };
    if (text.includes("to_regclass")) return { rows: [{ t: applied === "no-table" ? null : "schema_migrations" }] };
    if (text.includes("FROM schema_migrations")) return { rows: (applied as string[]).map((filename) => ({ filename })) };
    if (text.includes("FROM runs")) return { rows: [] }; // no history: the schedules section reports `absent`
    throw new Error(`unexpected query ${text}`);
  },
});

const LAUNCHCTL_RUNNING = "gui/501/x = {\n\tactive count = 1\n\tstate = running\n\n\tpid = 4242\n}\n";
const LAUNCHCTL_WAITING = "gui/501/x = {\n\tstate = waiting\n\tlast exit code = 78\n}\n";
const compose = (entries: { Service: string; State: string; Health?: string; Status?: string }[]) => entries.map((e) => JSON.stringify({ Health: "", Status: "Up", ...e })).join("\n") + "\n";

/** exec keyed by "cmd first-arg"; launchctl answers per label. */
const fakeExec = (opts: { launchctl?: Record<string, { code: number; stdout?: string }>; docker?: { code: number; stdout?: string; stderr?: string } }): Exec =>
  async (cmd, args) => {
    if (cmd === "launchctl") {
      const label = args[1]!.split("/").pop()!;
      const r = opts.launchctl?.[label] ?? { code: 113, stdout: "" };
      return { code: r.code, stdout: r.stdout ?? "", stderr: r.code ? `Could not find service "${label}"` : "" };
    }
    if (cmd === "docker") return { code: opts.docker?.code ?? 0, stdout: opts.docker?.stdout ?? "", stderr: opts.docker?.stderr ?? "" };
    throw new Error(`unexpected exec ${cmd} ${args.join(" ")}`);
  };

const env = { METISTRY_X_URL: "http://host.docker.internal:7901", METISTRY_BRIDGE_TOKEN_X: "tok-x", METISTRY_CONSOLE_URL: "http://127.0.0.1:8080" };
const byName = (rows: DoctorRow[]) => Object.fromEntries(rows.map((r) => [r.name, r]));

describe("doctor: everything healthy", () => {
  it("validates manifests, probes /check with the bearer, console /health + /api/status (401 is fine), db, migrations, launchd, compose", async () => {
    const productDir = await checkout();
    const seen: { url: string; auth?: string }[] = [];
    const report = await doctor({
      productDir,
      env,
      fetchFn: fakeFetch({ "7901/check": res(200, checkBody("ok")), "/health": res(200, { ok: true }), "/api/status": res(401) }, seen),
      db: fakeDb(["0001_a.sql", "0002_b.sql"]),
      exec: fakeExec({
        launchctl: { "com.foldedspacelabs.metistry.a": { code: 0, stdout: LAUNCHCTL_RUNNING }, "com.foldedspacelabs.metistry.b": { code: 0, stdout: LAUNCHCTL_RUNNING } },
        docker: { code: 0, stdout: compose([{ Service: "db", State: "running", Health: "healthy" }, { Service: "console", State: "running", Health: "healthy" }, { Service: "assistant", State: "running" }]) },
      }),
      platform: "darwin",
      uid: 501,
    });
    const r = byName(report.rows);
    expect(report.ok).toBe(true);
    expect(report.rows.map((x) => `${x.kind}:${x.name}=${x.status}`)).toEqual([
      "deployment:deployment=ok",
      "collector:good=ok",
      "bridge:x=ok",
      "bridge:y=absent",
      "service:console=ok",
      "service:watchdog=ok",
      "target:tgt=ok",
      "instance:instance layout=absent", // a bare temp dir is not an instance directory
      "instance:inbox=ok",
      "cli:cli on PATH=absent", // nothing on this fake PATH, and `metistry up` never ran here
      "db:db=ok",
      "db:migrations=ok",
      "schedule:good=absent",
      "launchd:launchd:com.foldedspacelabs.metistry.a=ok",
      "launchd:launchd:com.foldedspacelabs.metistry.b=ok",
      // macOS: one row for the power policy, and this install has not been
      // asked the question — absent, never a failure (see keep-awake.test.ts)
      "keep-awake:keep-awake=absent",
      "container:compose:assistant=ok",
      "container:compose:console=ok",
      "container:compose:db=ok",
      // the local model servers, last. ABSENT, and report.ok is still true:
      // a Mac that runs no local server is a supported install, so these
      // rows can only add information (docs/ops/compute.md "Local models").
      "local-model:local:lmstudio=absent",
      "local-model:local:ollama=absent",
      "local-model:local:llamaserver=absent",
      "local-model:local:applefm=absent",
    ]);
    // host.docker.internal rewritten to loopback, the bearer presented, the bridge's probe text kept
    expect(seen.find((s) => s.url.includes("7901"))).toEqual({ url: "http://127.0.0.1:7901/check", auth: "Bearer tok-x" });
    expect(r.x?.meta).toMatchObject({ probe: "canned" });
    expect(r.y?.remediation).toMatch(/set METISTRY_Y_URL \(default http:\/\/host\.docker\.internal:7902\) and METISTRY_BRIDGE_TOKEN_Y/);
    expect(r.console?.meta).toMatchObject({ api_status: 401 });
    expect(r.watchdog?.probe).toContain("launchd:com.foldedspacelabs.metistry.watchdog");
    expect(r.migrations?.meta).toMatchObject({ applied: 2, files: 2, pending: [], unknown: [] });
    expect(r["launchd:com.foldedspacelabs.metistry.a"]?.meta).toEqual({ pid: 4242 });
    expect(r["compose:db"]?.meta).toMatchObject({ state: "running", health: "healthy" });
    expect(r["local:lmstudio"]?.remediation).toContain("nothing is wrong unless you meant to run it");
  });

  it("main: exit 0, the table has one row per check and a summary; --json is the report", async () => {
    const productDir = await checkout();
    const deps = {
      env,
      fetchFn: fakeFetch({ "7901/check": res(200, checkBody("ok")), "/health": res(200), "/api/status": res(200) }),
      db: fakeDb(["0001_a.sql", "0002_b.sql"]),
      exec: fakeExec({ docker: { code: 127 } }),
      platform: "linux" as const,
    };
    const out: string[] = [];
    expect(await main(["doctor", "--product-dir", productDir], { out: (s) => out.push(s), doctorDeps: deps })).toBe(0);
    const text = out.join("\n");
    // the plain table is grouped by kind, one status icon + word per row,
    // the remediation wrapped underneath it (docs/ops/cli-style.md). The
    // icon spelling depends on the terminal's locale, so nothing here
    // asserts on the glyph itself.
    expect(text.split("\n")[0]).toContain(`${productDir} — shape compose`);
    expect(text).toMatch(/18 checks: 9 ok, 0 degraded, 0 failed, 9 absent — .*healthy/);
    expect(text).toMatch(/^local-model$/m); // the kind is the heading, not a repeated column
    expect(text).toMatch(/^\s+\S+\s+local:llamaserver\s+absent\s+\d+ms$/m);
    expect(text).toMatch(/^\s+\S+\s+local:applefm\s+absent\s+\d+ms$/m);
    expect(text).not.toMatch(/launchd:/); // linux: no launchd rows
    expect(text).toMatch(/^\s+\S+\s+compose\s+absent\s+\d+ms$/m);
    expect(text).toContain("docker not found");

    const json: string[] = [];
    expect(await main(["doctor", "--product-dir", productDir, "--json"], { out: (s) => json.push(s), doctorDeps: deps })).toBe(0);
    expect(json).toHaveLength(1); // --json purity: nothing but the one document reaches stdout
    const parsed = JSON.parse(json.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.rows).toHaveLength(18);
    expect(parsed.shape).toBe("compose");
    expect(parsed.rows.every((r: DoctorRow) => typeof r.latency_ms === "number" && typeof r.probe === "string")).toBe(true);
  });
});

// The console row used to settle for "a 401 has the right shape". With
// METISTRY_LOCAL_OWNER_TOKEN in the environment it is a real authenticated read
// through the same door the Mac app comes in by (docs/ops/auth.md).
describe("doctor: the console row with the local owner token", () => {
  const withToken = { ...env, METISTRY_LOCAL_OWNER_TOKEN: "owner-token" };

  it("presents the token and records that the read authenticated", async () => {
    const productDir = await checkout();
    const seen: { url: string; auth?: string }[] = [];
    const report = await doctor({
      productDir,
      env: withToken,
      fetchFn: fakeFetch({ "7901/check": res(200, checkBody("ok")), "/health": res(200, { ok: true }), "/api/status": res(200, { checks: [] }) }, seen),
      db: fakeDb(["0001_a.sql", "0002_b.sql"]),
      exec: fakeExec({ docker: { code: 127 } }),
      platform: "linux",
    });
    const r = byName(report.rows);
    expect(r.console).toMatchObject({ status: "ok", meta: { api_status: 200, authenticated: true } });
    expect(r.console?.probe).toContain("authenticates with METISTRY_LOCAL_OWNER_TOKEN");
    expect(seen.find((s) => s.url.endsWith("/api/status"))?.auth).toBe("Bearer owner-token");
  });

  it("degrades (never fails: the console is up) when the token is refused, and names both causes", async () => {
    const productDir = await checkout();
    const report = await doctor({
      productDir,
      env: withToken,
      fetchFn: fakeFetch({ "7901/check": res(200, checkBody("ok")), "/health": res(200, { ok: true }), "/api/status": res(401) }),
      db: fakeDb(["0001_a.sql", "0002_b.sql"]),
      exec: fakeExec({ docker: { code: 127 } }),
      platform: "linux",
    });
    const r = byName(report.rows);
    expect(r.console?.status).toBe("degraded");
    expect(r.console?.meta).toMatchObject({ api_status: 401, authenticated: false });
    expect(r.console?.remediation).toMatch(/secrets sync --to env/);
    expect(r.console?.remediation).toMatch(/METISTRY_TRUSTED_LOOPBACK_PROXY/);
    expect(r.console?.remediation).not.toContain("owner-token"); // the value never reaches a report
  });

  it("without the token, a 401 is still a pass — unchanged", async () => {
    const productDir = await checkout();
    const seen: { url: string; auth?: string }[] = [];
    const report = await doctor({
      productDir,
      env,
      fetchFn: fakeFetch({ "7901/check": res(200, checkBody("ok")), "/health": res(200, { ok: true }), "/api/status": res(401) }, seen),
      db: fakeDb(["0001_a.sql", "0002_b.sql"]),
      exec: fakeExec({ docker: { code: 127 } }),
      platform: "linux",
    });
    const r = byName(report.rows);
    expect(r.console).toMatchObject({ status: "ok", meta: { api_status: 401, authenticated: false } });
    expect(seen.find((s) => s.url.endsWith("/api/status"))?.auth).toBeUndefined();
  });
});

describe("doctor: the launchd shape", () => {
  it("reports the shape, probes the shaped jobs as launchd, and never consults docker", async () => {
    const productDir = await checkout();
    const calls: string[] = [];
    const inner = fakeExec({ docker: { code: 127 } });
    const exec: Exec = async (cmd, args, opts) => {
      calls.push(cmd);
      return inner(cmd, args, opts);
    };
    const report = await doctor({
      productDir,
      env,
      deployment: { shape: "launchd", services: {} },
      fetchFn: fakeFetch({}),
      db: null,
      exec,
      platform: "darwin",
      uid: 501,
    });
    expect(report.shape).toBe("launchd");
    expect(report.rows[0]).toMatchObject({ kind: "deployment", name: "deployment", status: "ok" });
    expect(report.rows[0]!.meta).toMatchObject({ shape: "launchd", services: { db: "launchd", console: "launchd", assistant: "launchd", reconciler: "launchd", watchdog: "launchd" } });
    // no container runtime is consulted at all
    expect(calls).not.toContain("docker");
    expect(report.rows.some((r) => r.kind === "container" || r.kind === "compose")).toBe(false);

    const r = byName(report.rows);
    // every remediation is written for the shape the install actually has
    // the console is a CHILD of the supervisor under this shape — launchctl
    // cannot address it, so the remediation is the verb that can
    expect(r.console?.remediation).toMatch(/metistry restart console/);
    expect(r.console?.remediation).not.toMatch(/docker/);
    expect(r.y?.remediation).toMatch(/default http:\/\/127\.0\.0\.1:7902/);
  });

  it("says WHICH registrar owns the one background item — the Mac app, or launchctl bootstrap", async () => {
    const productDir = await checkout();
    // the two agents the launchd shape actually installs (deployment-shapes.md):
    // the supervisor, and the TCC helper that keeps one of its own
    await mkdir(join(productDir, "ops", "launchd"), { recursive: true });
    await writeFile(join(productDir, "ops", "launchd", "com.foldedspacelabs.metistry.plist"), PLIST("com.foldedspacelabs.metistry"));
    await writeFile(join(productDir, "ops", "launchd", "com.foldedspacelabs.metistry.calendar.plist"), PLIST("com.foldedspacelabs.metistry.calendar"));
    // METISTRY_EK_URL turns the calendar helper's agent on, so the shape has
    // the two agents it really installs
    const shapeEnv = { ...env, METISTRY_EK_URL: "http://127.0.0.1:7811" };
    const run = async (exec: Exec) =>
      byName((await doctor({ productDir, env: shapeEnv, deployment: { shape: "launchd", services: {} }, fetchFn: fakeFetch({}), db: null, exec, platform: "darwin", uid: 501 })).rows);
    const printing = (out: string) =>
      fakeExec({
        launchctl: {
          "com.foldedspacelabs.metistry": { code: 0, stdout: out },
          // the helper, loaded from a bundle path too — the registrar is read
          // off the SUPERVISOR's row only, because no other job is the app's
          "com.foldedspacelabs.metistry.calendar": { code: 0, stdout: `\tpath = /Applications/Metistry.app/Contents/Library/LaunchAgents/x.plist\n${LAUNCHCTL_RUNNING}` },
        },
      });

    const app = (await run(printing("\tpath = /Applications/Metistry.app/Contents/Library/LaunchAgents/com.foldedspacelabs.metistry.plist\n\tstate = running\n\tpid = 99\n")))[
      "launchd:com.foldedspacelabs.metistry"
    ];
    expect(app?.status).toBe("ok");
    expect(app?.probe).toContain("registered by the Mac app, through SMAppService.agent(plistName:)");
    expect(app?.meta).toMatchObject({ registrar: "app", registered_from: "/Applications/Metistry.app/Contents/Library/LaunchAgents/com.foldedspacelabs.metistry.plist" });

    const terminal = await run(printing("\tpath = /Users/o/Library/LaunchAgents/com.foldedspacelabs.metistry.plist\n\tstate = running\n\tpid = 99\n"));
    expect(terminal["launchd:com.foldedspacelabs.metistry"]?.probe).toContain("registered by launchctl bootstrap");
    expect(terminal["launchd:com.foldedspacelabs.metistry"]?.meta).toMatchObject({ registrar: "launchd" });
    // asked of the supervisor only — no other agent is ever the app's
    expect(terminal["launchd:com.foldedspacelabs.metistry.calendar"]?.status).toBe("ok");
    expect(terminal["launchd:com.foldedspacelabs.metistry.calendar"]?.probe).not.toContain("registered by");

    // nothing loaded: the row is the "not bootstrapped" one it always was,
    // and no registrar is invented for a job that does not exist
    const none = (await run(fakeExec({})))["launchd:com.foldedspacelabs.metistry"];
    expect(none?.status).toBe("absent");
    expect(none?.probe).not.toContain("registered by");
    expect(none?.meta?.registrar).toBeUndefined();
  });
});

describe("doctor: degraded (runs, needs a hand) never fails the exit code", () => {
  it("bridge says degraded, migrations pending, container unhealthy", async () => {
    const productDir = await checkout();
    const report = await doctor({
      productDir,
      env,
      fetchFn: fakeFetch({ "7901/check": res(503, checkBody("degraded", "helper lost its TCC grant")), "/health": res(200), "/api/status": res(401) }),
      db: fakeDb(["0001_a.sql"]),
      exec: fakeExec({ docker: { code: 0, stdout: compose([{ Service: "db", State: "running", Health: "healthy" }, { Service: "console", State: "running", Health: "starting" }, { Service: "assistant", State: "running" }]) } }),
      platform: "linux",
    });
    const r = byName(report.rows);
    expect(report.ok).toBe(true);
    expect(r.x).toMatchObject({ status: "degraded", remediation: "helper lost its TCC grant" });
    expect(r.migrations).toMatchObject({ status: "degraded", remediation: expect.stringMatching(/1 migration\(s\) not applied \(0002_b\.sql\) — run pnpm db:migrate/) });
    expect(r["compose:console"]).toMatchObject({ status: "degraded", remediation: expect.stringMatching(/starting/) });
    expect(renderTable(report)).toMatch(/0 failed/);
  });

  it("a db with migrations the checkout lacks is degraded too; no schema_migrations table at all is degraded with the pending count", async () => {
    const productDir = await checkout();
    const base = { productDir, env, fetchFn: fakeFetch({ "7901/check": res(200, checkBody("ok")), "/health": res(200), "/api/status": res(200) }), exec: fakeExec({ docker: { code: 127 } }), platform: "linux" as const };
    expect(byName((await doctor({ ...base, db: fakeDb(["0001_a.sql", "0002_b.sql", "0003_future.sql"]) })).rows).migrations).toMatchObject({ status: "degraded", remediation: expect.stringMatching(/0003_future\.sql/) });
    expect(byName((await doctor({ ...base, db: fakeDb("no-table") })).rows).migrations).toMatchObject({ status: "degraded", remediation: expect.stringMatching(/no schema_migrations table.*2 migrations pending/) });
  });
});

describe("doctor: failed", () => {
  it("bridge down, console 500, launchd job not running, container exited, db unreachable — exit 1", async () => {
    const productDir = await checkout();
    const report = await doctor({
      productDir,
      env,
      fetchFn: fakeFetch({ "7901/check": new Error("connect ECONNREFUSED 127.0.0.1:7901"), "/health": res(500) }),
      db: fakeDb(new Error("ECONNREFUSED")),
      exec: fakeExec({
        launchctl: { "com.foldedspacelabs.metistry.a": { code: 0, stdout: LAUNCHCTL_WAITING }, "com.foldedspacelabs.metistry.b": { code: 0, stdout: LAUNCHCTL_RUNNING } },
        docker: { code: 0, stdout: compose([{ Service: "db", State: "exited", Status: "Exited (1) 2 minutes ago" }, { Service: "console", State: "running", Health: "healthy" }]) },
      }),
      platform: "darwin",
      uid: 501,
    });
    const r = byName(report.rows);
    expect(report.ok).toBe(false);
    expect(r.x).toMatchObject({ status: "failed", remediation: expect.stringMatching(/x down at http:\/\/127\.0\.0\.1:7901 \(connect ECONNREFUSED.*\) — docker compose up -d x/) });
    expect(r.console).toMatchObject({ status: "failed", remediation: expect.stringMatching(/\/health returned 500/) });
    expect(r.db).toMatchObject({ status: "failed", remediation: expect.stringMatching(/ECONNREFUSED — docker compose up -d db/) });
    expect(r.migrations).toMatchObject({ status: "absent", remediation: "not checked — db unreachable" });
    expect(r["launchd:com.foldedspacelabs.metistry.a"]).toMatchObject({ status: "failed", remediation: expect.stringMatching(/state = waiting, last exit code 78 — launchctl kickstart -k gui\/\$\(id -u\)\/com\.foldedspacelabs\.metistry\.a/) });
    expect(r["launchd:com.foldedspacelabs.metistry.b"]?.status).toBe("ok");
    expect(r["compose:db"]).toMatchObject({ status: "failed", remediation: expect.stringMatching(/container exited \(Exited \(1\).*\) — docker compose up -d db/) });
    expect(r["compose:assistant"]).toMatchObject({ status: "absent", remediation: "no container — docker compose up -d assistant" });

    const out: string[] = [];
    expect(await main(["doctor", "--product-dir", productDir], { out: (s) => out.push(s), doctorDeps: { env, fetchFn: fakeFetch({ "7901/check": res(200, checkBody("ok")), "/health": res(200), "/api/status": res(401) }), db: fakeDb(new Error("down")), exec: fakeExec({ docker: { code: 127 } }), platform: "linux" } })).toBe(1);
    expect(out.join("\n")).toMatch(/1 failed, \d+ absent — .*FAILED/);
  });

  it("a rejected bearer, a non-contract body, and a bridge reporting failed are all failed with distinct remediations", async () => {
    const productDir = await checkout();
    const base = { productDir, env, db: null, exec: fakeExec({ docker: { code: 127 } }), platform: "linux" as const };
    const okRest = { "/health": res(200), "/api/status": res(401) };
    expect(byName((await doctor({ ...base, fetchFn: fakeFetch({ "7901/check": res(401), ...okRest }) })).rows).x).toMatchObject({ status: "failed", remediation: expect.stringMatching(/rejected the token \(HTTP 401\)/) });
    expect(byName((await doctor({ ...base, fetchFn: fakeFetch({ "7901/check": res(200, { hello: "world" }), ...okRest }) })).rows).x).toMatchObject({ status: "failed", remediation: expect.stringMatching(/without a check\(\) body/) });
    expect(byName((await doctor({ ...base, fetchFn: fakeFetch({ "7901/check": res(503, checkBody("failed", "helper crashed")), ...okRest }) })).rows).x).toMatchObject({ status: "failed", remediation: "helper crashed" });
  });

  it("an invalid manifest, a non-YAML manifest, and a target whose directory name differs are failed rows; the good ones still validate", async () => {
    const productDir = await checkout({ brokenManifests: true });
    const found = await walkManifests(productDir);
    expect(found.map((f) => `${f.dir}=${f.result.ok}`)).toEqual([
      "collectors/bad=false",
      "collectors/good=true",
      "collectors/notyaml=false",
      "packages/mcp-x=true",
      "packages/mcp-y=true",
      "apps/console=true",
      "apps/watchdog=true",
      "targets/mismatch=false",
      "targets/tgt=true",
    ]);
    const report = await doctor({ productDir, env: {}, fetchFn: fakeFetch({ "/health": res(200), "/api/status": res(401) }), db: null, exec: fakeExec({ docker: { code: 127 } }), platform: "linux" });
    const r = byName(report.rows);
    expect(report.ok).toBe(false);
    expect(r.bad).toMatchObject({ kind: "collector", status: "failed", remediation: expect.stringMatching(/schedule/) });
    expect(r.notyaml).toMatchObject({ status: "failed", remediation: expect.stringMatching(/not YAML/) });
    expect(r.other).toMatchObject({ kind: "target", status: "failed", remediation: expect.stringMatching(/directory mismatch must equal manifest name other/) });
    expect(r.good?.status).toBe("ok");
  });
});

describe("doctor: absent (not configured / not installed) is informational", () => {
  it("no db password, launchd jobs not bootstrapped, docker missing", async () => {
    const productDir = await checkout();
    const report = await doctor({
      productDir,
      env: { METISTRY_CONSOLE_URL: "http://127.0.0.1:8080" },
      fetchFn: fakeFetch({ "/health": res(200), "/api/status": res(401) }),
      db: null,
      exec: fakeExec({ docker: { code: 127 } }),
      platform: "darwin",
      uid: 501,
    });
    const r = byName(report.rows);
    expect(report.ok).toBe(true);
    expect(r.db).toMatchObject({ status: "absent", remediation: expect.stringMatching(/METISTRY_DB_PASSWORD is unset/) });
    expect(r.migrations).toMatchObject({ status: "absent", remediation: "not checked — no db configured" });
    expect(r.x).toMatchObject({ status: "absent", remediation: expect.stringMatching(/set METISTRY_X_URL/) });
    expect(r["launchd:com.foldedspacelabs.metistry.a"]).toMatchObject({
      status: "absent",
      remediation: expect.stringMatching(/not bootstrapped — metistry up, or by hand: sed .*ops\/launchd\/com\.foldedspacelabs\.metistry\.a\.plist.*launchctl bootstrap gui\/\$\(id -u\)/),
    });
    expect(r.compose).toMatchObject({ kind: "compose", status: "absent", remediation: expect.stringMatching(/docker not found/) });
    expect(report.rows.filter((x) => x.name.startsWith("compose:"))).toHaveLength(0);
  });

  it("a docker daemon that is not running is failed (the containers are down), not absent", async () => {
    const productDir = await checkout();
    const report = await doctor({ productDir, env: {}, fetchFn: fakeFetch({ "/health": res(200), "/api/status": res(401) }), db: null, exec: fakeExec({ docker: { code: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" } }), platform: "linux" });
    expect(byName(report.rows).compose).toMatchObject({ status: "failed", remediation: expect.stringMatching(/Cannot connect to the Docker daemon.*is the Docker daemon running\?/) });
    expect(report.ok).toBe(false);
  });
});

describe("doctor: the pre-#156 inbox layout (docs/ops/inbox.md)", () => {
  it("ok when there is no legacy inbox/ and .gitignore does not list it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-doctor-inbox-"));
    expect(await inboxRow(dir)).toMatchObject({ name: "inbox", kind: "instance", status: "ok" });
  });

  it("degraded when <instance>/inbox/ still holds files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-doctor-inbox-"));
    await mkdir(join(dir, "inbox"), { recursive: true });
    await writeFile(join(dir, "inbox", "1757000000000-note.md"), "# an old capture\n");
    const row = await inboxRow(dir);
    expect(row).toMatchObject({ status: "degraded" });
    expect(row.remediation).toMatch(/metistry migrate-inbox --dry-run/);
    expect(row.meta).toMatchObject({ entries: 1, gitignored: false });
  });

  it("an empty inbox/ (just .DS_Store) is not itself a finding, but .gitignore still listing it is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-doctor-inbox-"));
    await mkdir(join(dir, "inbox"), { recursive: true });
    await writeFile(join(dir, "inbox", ".DS_Store"), "");
    expect(await inboxRow(dir)).toMatchObject({ status: "ok" });

    await writeFile(join(dir, ".gitignore"), "inbox/\nstate/\n");
    const row = await inboxRow(dir);
    expect(row).toMatchObject({ status: "degraded" });
    expect(row.meta).toMatchObject({ entries: 0, gitignored: true });
  });

  it("doctor() reports it as one row, at the instance dir (METISTRY_INSTANCE_DIR) rather than the product checkout", async () => {
    const productDir = await checkout();
    const instanceDir = await mkdtemp(join(tmpdir(), "metistry-doctor-instance-"));
    await mkdir(join(instanceDir, "inbox"), { recursive: true });
    await writeFile(join(instanceDir, "inbox", "1757000000000-note.md"), "# an old capture\n");
    const report = await doctor({
      productDir,
      env: { ...env, METISTRY_INSTANCE_DIR: instanceDir },
      fetchFn: fakeFetch({ "7901/check": res(200, checkBody("ok")), "/health": res(200), "/api/status": res(401) }),
      db: null,
      exec: fakeExec({ docker: { code: 127 } }),
      platform: "linux",
    });
    expect(byName(report.rows).inbox).toMatchObject({ kind: "instance", status: "degraded" });
    expect(report.ok).toBe(true); // degraded never fails the exit code
  });
});

describe("doctor: the cli shim (cli-shim.ts)", () => {
  it("absent, and points at the exact line to link it, once `metistry up` has written the shim", async () => {
    const productDir = await mkdtemp(join(tmpdir(), "metistry-doctor-cli-"));
    const r = new StepRunner({ dryRun: false, out: () => {} });
    await writeCliShim(r, productDir, undefined);
    const shim = cliShimPath(productDir, undefined);

    const row = await cliRow(productDir, { PATH: "/nonexistent" });
    expect(row).toMatchObject({ name: "cli on PATH", kind: "cli", status: "absent" });
    expect(row.remediation).toBe(`ln -s ${shim} ~/.local/bin/metistry  (or add its directory to PATH)`);
    expect(row.meta).toMatchObject({ shim });
  });

  it("absent, and says `metistry up` writes one, before it ever has", async () => {
    const productDir = await mkdtemp(join(tmpdir(), "metistry-doctor-cli-"));
    const row = await cliRow(productDir, { PATH: "/nonexistent" });
    expect(row.status).toBe("absent");
    expect(row.remediation).toMatch(/metistry up. writes one/);
  });

  it("ok, and says where, once something answering to `metistry` is actually on PATH", async () => {
    const productDir = await mkdtemp(join(tmpdir(), "metistry-doctor-cli-"));
    const bin = await mkdtemp(join(tmpdir(), "metistry-doctor-cli-bin-"));
    await writeFile(join(bin, "metistry"), "#!/bin/sh\n");
    const row = await cliRow(productDir, { PATH: bin });
    expect(row).toMatchObject({ name: "cli on PATH", kind: "cli", status: "ok" });
    expect(row.meta).toMatchObject({ path: join(bin, "metistry") });
  });

  it("ok via ~/.local/bin even when it is not on PATH", async () => {
    const productDir = await mkdtemp(join(tmpdir(), "metistry-doctor-cli-"));
    const home = await mkdtemp(join(tmpdir(), "metistry-doctor-cli-home-"));
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    await writeFile(join(home, ".local", "bin", "metistry"), "#!/bin/sh\n");
    const row = await cliRow(productDir, { PATH: "/nonexistent", HOME: home });
    expect(row.status).toBe("ok");
    expect(row.meta).toMatchObject({ path: join(home, ".local", "bin", "metistry") });
  });

  it("doctor() reports it at the instance dir, matching where `metistry up` would have written the shim", async () => {
    const productDir = await checkout();
    const instanceDir = await mkdtemp(join(tmpdir(), "metistry-doctor-cli-instance-"));
    const report = await doctor({
      productDir,
      env: { ...env, METISTRY_INSTANCE_DIR: instanceDir },
      fetchFn: fakeFetch({ "7901/check": res(200, checkBody("ok")), "/health": res(200), "/api/status": res(401) }),
      db: null,
      exec: fakeExec({ docker: { code: 127 } }),
      platform: "linux",
    });
    const row = byName(report.rows)["cli on PATH"];
    expect(row).toMatchObject({ kind: "cli", status: "absent" });
    expect(row.meta).toMatchObject({ shim: cliShimPath(productDir, instanceDir) });
    expect(report.ok).toBe(true); // absent never fails the exit code
  });
});

describe("parsers and conventions", () => {
  it("compose ps: array (older compose) and NDJSON (newer) both parse", () => {
    expect(parseComposePs('[{"Service":"db","State":"running"}]')).toEqual([{ Service: "db", State: "running" }]);
    expect(parseComposePs('{"Service":"db","State":"running"}\n{"Service":"console","State":"exited"}\n')).toHaveLength(2);
    expect(parseComposePs("")).toEqual([]);
  });

  it("launchctl print: state, pid, last exit code", () => {
    expect(parseLaunchctlPrint(LAUNCHCTL_RUNNING)).toEqual({ state: "running", pid: 4242 });
    expect(parseLaunchctlPrint(LAUNCHCTL_WAITING)).toEqual({ state: "waiting", lastExit: 78 });
    expect(parseLaunchctlPrint("garbage")).toEqual({ state: "unknown" });
  });

  it("env conventions: the three shipped bridges keep their variables; anything else follows METISTRY_<NAME>_URL", () => {
    // launchdService, not a hardcoded label: a namespaced instance's job is
    // com.foldedspacelabs.metistry.<suffix>.apple-fm, and the remediation has
    // to name the job that exists (packages/cli/src/namespace.ts)
    expect(probeTargetFor("apple-fm")).toMatchObject({ urlVar: "METISTRY_AFM_URL", tokenVar: "METISTRY_BRIDGE_TOKEN_APPLE_FM", launchdService: "apple-fm" });
    expect(probeTargetFor("eventkit")).toMatchObject({ urlVar: "METISTRY_EK_URL", tokenVar: "METISTRY_BRIDGE_TOKEN_EVENTKIT" });
    expect(probeTargetFor("reconciler")).toMatchObject({ urlVar: "METISTRY_RECONCILER_URL", tokenVar: "METISTRY_BRIDGE_TOKEN_RECONCILER" });
    expect(probeTargetFor("my-thing")).toEqual({ urlVar: "METISTRY_MY_THING_URL", tokenVar: "METISTRY_BRIDGE_TOKEN_MY_THING" });
    expect(hostLocal("http://host.docker.internal:7812/")).toBe("http://127.0.0.1:7812");
    expect(hostLocal("http://10.0.0.5:7812")).toBe("http://10.0.0.5:7812");
  });

  it("dotenv: comments, export, quotes; unset-only load semantics live in loadDotEnv", () => {
    expect(parseDotEnv('# c\nA=1\nexport B="two words"\nC=\'x\'\nD=\n bad line\nE=a=b\n')).toEqual({ A: "1", B: "two words", C: "x", D: "", E: "a=b" });
  });

  it("args: flags with values, =, booleans, positionals, --", () => {
    expect(parseArgs(["init", "/x", "--name", "Ada", "--force", "--product-dir=/p"])).toEqual({ command: "init", positional: ["/x"], flags: { name: "Ada", force: true, "product-dir": "/p" } });
    expect(parseArgs(["doctor", "--json"])).toEqual({ command: "doctor", positional: [], flags: { json: true } });
    // boolean flags never swallow the next positional
    expect(parseArgs(["init", "--force", "/x"])).toEqual({ command: "init", positional: ["/x"], flags: { force: true } });
    expect(parseArgs(["doctor", "--json", "--product-dir", "/p"])).toEqual({ command: "doctor", positional: [], flags: { json: true, "product-dir": "/p" } });
    expect(parseArgs(["init", "--", "--weird-dir"])).toEqual({ command: "init", positional: ["--weird-dir"], flags: {} });
    expect(parseArgs([])).toEqual({ command: undefined, positional: [], flags: {} });
  });

  // `--version` was listed as a boolean, so `str(flags, "version")` was
  // always undefined and `metistry update --version 0.2.0` quietly installed
  // the latest release instead (#198, "not fixed here" #2). It takes its
  // value now, and the BARE flag — nothing after it, or another flag next —
  // still reads as `true`, which is what `metistry --version` needs.
  it("args: --version takes its value for `update`, and stays boolean when bare", () => {
    expect(parseArgs(["update", "--version", "0.2.0"])).toEqual({ command: "update", positional: [], flags: { version: "0.2.0" } });
    expect(parseArgs(["update", "--version=0.2.0"])).toEqual({ command: "update", positional: [], flags: { version: "0.2.0" } });
    expect(parseArgs(["--version"])).toEqual({ command: undefined, positional: [], flags: { version: true } });
    expect(parseArgs(["--version", "--json"])).toEqual({ command: undefined, positional: [], flags: { version: true, json: true } });
    expect(BOOLEAN_FLAGS.has("version")).toBe(false);
  });
});

describe("the sandbox row — which children run confined, and where their egress goes", () => {
  const child = (name: string, argv: string[]) => ({ name, argv, env: {}, log: `/tmp/metistry-${name}.log`, stopTimeoutMs: 10_000 });
  const base = { schema: 1 as const, label: "com.foldedspacelabs.metistry", socket: "/s.sock", token: "t".repeat(32), env: {} };
  const confined = (name: string, profile: string) => child(name, [SANDBOX_EXEC, "-f", `/p/ops/sandbox/${profile}`, "-D", "X=1", "/n/bin/node", `/p/apps/${name}/dist/main.js`]);

  it("reports both confined children, their profiles and the door — from the argv that actually runs", async () => {
    const row = await confinementRow({
      ...base,
      egress: { port: 7814, allow: ["openrouter.ai", "github.com"], tokens: { assistant: "a", reconciler: "r" } },
      children: [child("db", ["/pg/bin/postgres", "-D", "/d"]), child("console", ["/n/bin/node", "/p/console.js"]), confined("reconciler", "reconciler.sb"), confined("assistant", "assistant.sb")],
    });
    expect(row.kind).toBe("sandbox");
    expect(row.status).toBe("ok");
    expect(row.meta).toMatchObject({
      confined: ["reconciler", "assistant"],
      unconfined: ["db", "console"],
      egress: { port: 7814, allow: ["openrouter.ai", "github.com"] },
    });
    expect((row.meta as { profiles: Record<string, string> }).profiles.reconciler).toBe("/p/ops/sandbox/reconciler.sb");
  });

  it("an unconfined.sb profile is NOT confinement — the off switch is visible, not silent", async () => {
    const row = await confinementRow({
      ...base,
      egress: { port: 7814, allow: ["openrouter.ai"], tokens: {} },
      children: [confined("assistant", "assistant.sb"), confined("reconciler", "unconfined.sb")],
    });
    expect(row.status).toBe("degraded");
    expect(row.remediation).toMatch(/sole committer/);
    expect(row.meta).toMatchObject({ confined: ["assistant"], unconfined: ["reconciler"] });
  });

  it("an empty allowlist is reported: correct for a local-only install, a bug for any other", async () => {
    const row = await confinementRow({
      ...base,
      egress: { port: 7814, allow: [], tokens: {} },
      children: [confined("assistant", "assistant.sb"), confined("reconciler", "reconciler.sb")],
    });
    expect(row.status).toBe("degraded");
    expect(row.remediation).toMatch(/allowlist is empty/);
  });

  it("no profile anywhere is degraded, and says which shape that is legitimate in", async () => {
    const row = await confinementRow({ ...base, children: [child("console", ["/n/bin/node", "/p/console.js"])] });
    expect(row.status).toBe("degraded");
    expect(row.remediation).toMatch(/no child runs under a profile/);
    expect(row.remediation).toMatch(/compose shape the container is the boundary/);
  });
});
