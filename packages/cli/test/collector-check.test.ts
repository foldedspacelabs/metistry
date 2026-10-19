// A collector's own `check()` inside `metistry doctor` (X-87): the entry is
// loaded from the product checkout or the release pack, called with what the
// console would hand `run()`, and its verdict is merged into the collector's
// ONE row. The misuse cases are the point: a module that will not load, a
// `check()` that throws, hangs, or answers nonsense is a `failed` row — and
// the rest of the report still runs.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emptyCompute } from "@foldedspacelabs/metistry-core";
import { collectorCheckContext, collectorEntry, mergeCollectorCheck, runCollectorCheck } from "../src/collector-check.js";
import { doctor } from "../src/doctor.js";

const GOOD = "export async function check() { return { name: 'x', status: 'ok', latency_ms: 2, probe: 'asked', meta: { seen: 1 } }; }\n";

async function pack(entries: Record<string, string>, where: "dist" | "flat" = "dist"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "metistry-collector-check-"));
  await mkdir(join(root, "collectors"), { recursive: true });
  await writeFile(join(root, "collectors", "package.json"), JSON.stringify({ type: "module" }));
  for (const [name, code] of Object.entries(entries)) {
    const dir = where === "dist" ? join(root, "collectors", "dist", name) : join(root, "collectors", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.js"), code);
  }
  return root;
}

const base = { timeoutMs: 200 };

describe("runCollectorCheck", () => {
  it("loads collectors/dist/<name>/run.js (a build or a release pack) and returns the collector's verdict", async () => {
    const productDir = await pack({ alpha: GOOD });
    const r = await runCollectorCheck({ productDir, name: "alpha", ctx: base });
    expect(r).toMatchObject({ name: "x", status: "ok", meta: { seen: 1 } });
  });

  it("also finds a flat tree (collectors/<name>/run.js)", async () => {
    const productDir = await pack({ alpha: GOOD }, "flat");
    expect((await runCollectorCheck({ productDir, name: "alpha", ctx: base })).status).toBe("ok");
  });

  it("hands the collector the context, plus uses_model: from its manifest", async () => {
    const productDir = await pack({ alpha: "export async function check(ctx) { return { name: 'a', status: 'ok', latency_ms: 0, probe: 'p', meta: { got: [ctx.usesModel, ctx.marker] } }; }\n" });
    const r = await runCollectorCheck({ productDir, name: "alpha", usesModel: "applefm/foundation-model", ctx: { ...base, marker: "m" } });
    expect(r.meta).toEqual({ got: ["applefm/foundation-model", "m"] });
  });

  it("a collector that has not been built is degraded and says how to build it — doctor does not pretend to have asked", async () => {
    const productDir = await pack({});
    const r = await runCollectorCheck({ productDir, name: "alpha", ctx: base });
    expect(r.status).toBe("degraded");
    expect(r.remediation).toMatch(/collectors\/dist\/alpha\/run\.js is not here.*pnpm -r build.*metistry update/);
  });

  it("a module that fails to load is FAILED with the error, and does not throw", async () => {
    const productDir = await pack({ alpha: "export const x = ;\n" });
    const r = await runCollectorCheck({ productDir, name: "alpha", ctx: base });
    expect(r.status).toBe("failed");
    expect(r.remediation).toMatch(/collectors\/dist\/alpha\/run\.js did not load: /);
    const throwsOnImport = await pack({ alpha: "throw new Error('boom at import');\n" });
    expect((await runCollectorCheck({ productDir: throwsOnImport, name: "alpha", ctx: base })).remediation).toMatch(/did not load: boom at import/);
  });

  it("an entry with no check() is failed — the convention, held at the door as well as in CI", async () => {
    const productDir = await pack({ alpha: "export async function run() { return 0; }\n" });
    const r = await runCollectorCheck({ productDir, name: "alpha", ctx: base });
    expect(r.status).toBe("failed");
    expect(r.remediation).toMatch(/exports no check\(\)/);
  });

  it("a check() that throws is failed with its message", async () => {
    const productDir = await pack({ alpha: "export async function check() { throw new Error('the token file is unreadable'); }\n" });
    const r = await runCollectorCheck({ productDir, name: "alpha", ctx: base });
    expect(r).toMatchObject({ status: "failed", remediation: "the token file is unreadable" });
  });

  it("a check() that throws synchronously is failed too", async () => {
    const productDir = await pack({ alpha: "export function check() { throw new Error('sync boom'); }\n" });
    expect((await runCollectorCheck({ productDir, name: "alpha", ctx: base })).remediation).toBe("sync boom");
  });

  it("a check() that hangs is failed at the guard, not waited for", async () => {
    const productDir = await pack({ alpha: "export function check() { return new Promise(() => {}); }\n" });
    const t0 = Date.now();
    const r = await runCollectorCheck({ productDir, name: "alpha", ctx: base, guardMs: 60 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.status).toBe("failed");
    expect(r.remediation).toMatch(/check\(\) did not answer within 60 ms/);
  });

  it("the default guard is twice the context's timeoutMs", async () => {
    const productDir = await pack({ alpha: "export function check() { return new Promise(() => {}); }\n" });
    const r = await runCollectorCheck({ productDir, name: "alpha", ctx: { timeoutMs: 30 } });
    expect(r.remediation).toMatch(/within 60 ms/);
  });

  it("an answer that is not core's check() shape is failed — a collector cannot put an unrecognised status on a row", async () => {
    for (const body of ["null", "{ name: 'a', status: 'fine', latency_ms: 0, probe: 'p' }", "'ok'", "{ name: 'a', status: 'ok' }"]) {
      const productDir = await pack({ alpha: `export async function check() { return ${body}; }\n` });
      const r = await runCollectorCheck({ productDir, name: "alpha", ctx: base });
      expect(r.status, body).toBe("failed");
      expect(r.remediation, body).toMatch(/not a check\(\) result/);
    }
  });

  it("a name that is not a collector directory cannot point the loader outside collectors/", async () => {
    const productDir = await pack({ alpha: GOOD });
    for (const name of ["../alpha", "a/b", "Alpha", "", ".."]) {
      expect(collectorEntry(productDir, name), name).toBeUndefined();
    }
    expect(collectorEntry(productDir, "alpha")).toBe(join(productDir, "collectors", "dist", "alpha", "run.js"));
  });
});

describe("mergeCollectorCheck", () => {
  it("keeps the row's name, takes the collector's status/reason/meta, and joins both probes", () => {
    const row = { name: "alpha", status: "ok" as const, latency_ms: 1, probe: "collectors/alpha/manifest.yaml validates" };
    const m = mergeCollectorCheck(row, { name: "other", status: "degraded", latency_ms: 4, probe: "asked", remediation: "why", meta: { a: 1 } });
    expect(m).toEqual({ name: "alpha", status: "degraded", latency_ms: 5, probe: "collectors/alpha/manifest.yaml validates; check(): asked", remediation: "why", meta: { a: 1 } });
    expect(mergeCollectorCheck(row, { name: "o", status: "ok", latency_ms: 0, probe: "p" })).not.toHaveProperty("remediation");
  });
});

describe("collectorCheckContext", () => {
  const o = { fetchFn: fetch, shape: "launchd" as const, hostLocal: (u: string) => u.replace("host.docker.internal", "127.0.0.1"), compute: emptyCompute(), timeoutMs: 1234 };

  it("reads the same environment variables the console reads for run(), and rewrites the bridge URL for the host", () => {
    const ctx = collectorCheckContext({
      ...o,
      env: { METISTRY_EK_URL: "http://host.docker.internal:7811", METISTRY_BRIDGE_TOKEN_EVENTKIT: "t", METISTRY_DEVIN_REPOS: "a/b, c/d", METISTRY_AWS_ACCESS_KEY_ID: "k", METISTRY_AWS_SECRET_ACCESS_KEY: "s" },
    });
    expect(ctx).toMatchObject({ ekUrl: "http://127.0.0.1:7811", ekToken: "t", aws: { accessKeyId: "k", secretAccessKey: "s" }, timeoutMs: 1234 });
    expect(typeof (ctx.compute as () => unknown)()).toBe("object");
  });

  it("without an instance there is no opener and no connection check — nothing can be dialled", () => {
    const ctx = collectorCheckContext({ ...o, env: {} });
    expect(ctx).not.toHaveProperty("openSync");
    expect(ctx).not.toHaveProperty("openImap");
    expect(ctx).not.toHaveProperty("connectionCheck");
    expect(ctx).not.toHaveProperty("ekUrl");
    expect(ctx).not.toHaveProperty("aws");
  });

  it("with an instance, the connection check is the shared checker's", async () => {
    const asked: string[] = [];
    const checker = { check: async (n: string) => (asked.push(n), { name: n, status: "ok" as const, latency_ms: 0, probe: "p" }), names: async () => [], close: async () => {} };
    const ctx = collectorCheckContext({ ...o, env: {}, instance: { dir: "/nowhere", seedDir: undefined, checker } });
    expect(typeof ctx.openSync).toBe("function");
    expect(typeof ctx.openImap).toBe("function");
    await (ctx.connectionCheck as (n: string) => Promise<unknown>)("cal");
    expect(asked).toEqual(["cal"]);
  });
});

// ---- doctor, whole ----------------------------------------------------------

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

async function checkoutWith(collectors: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "metistry-doctor-collectors-"));
  const put = async (rel: string, text: string) => {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), text);
  };
  await put("package.json", JSON.stringify({ name: "metistry" }));
  await put("seed/identity.yaml", "name: Seed\n");
  await put("collectors/package.json", JSON.stringify({ type: "module" }));
  for (const [name, code] of Object.entries(collectors)) {
    await put(`collectors/${name}/manifest.yaml`, `schema: 1\nname: ${name}\ntype: collector\nschedule: '@hourly'\nwrites: [t]\n`);
    await put(`collectors/dist/${name}/run.js`, code);
  }
  await put("packages/mcp-z/manifest.yaml", "name: z\ntype: bridge\ntransport: http\nport: 7909\nruns_on: host\nexposes: [{name: a}]\n");
  await put("db/migrations/0001_a.sql", "select 1;");
  return root;
}

describe("doctor with collectors that misbehave", () => {
  it("a check() that throws, one that hangs and one that will not load are each a failed row — and every other row is still there", async () => {
    const productDir = await checkoutWith({
      fine: GOOD,
      throws: "export async function check() { throw new Error('exploded'); }\n",
      hangs: "export function check() { return new Promise(() => {}); }\n",
      broken: "export const = ;\n",
    });
    const t0 = Date.now();
    const report = await doctor({
      productDir,
      env: {},
      fetchFn: (async () => { throw new Error("no network in this test"); }) as unknown as typeof fetch,
      db: null,
      exec: async () => ({ code: 127, stdout: "", stderr: "" }),
      platform: "linux",
      namespace: null,
      timeoutMs: 100,
    });
    expect(Date.now() - t0).toBeLessThan(5_000);
    const row = (n: string) => report.rows.find((r) => r.kind === "collector" && r.name === n)!;
    expect(row("fine")).toMatchObject({ status: "ok", meta: { seen: 1 } });
    expect(row("throws")).toMatchObject({ status: "failed", remediation: "exploded" });
    expect(row("hangs")).toMatchObject({ status: "failed" });
    expect(row("hangs").remediation).toMatch(/did not answer within 200 ms/);
    expect(row("broken").status).toBe("failed");
    expect(row("broken").remediation).toMatch(/did not load/);
    // the manifest's own words stay in the probe: ONE row per collector, no second kind
    expect(row("fine").probe).toMatch(/collectors\/fine\/manifest\.yaml validates; check\(\): asked/);
    expect(report.rows.filter((r) => r.name === "fine")).toHaveLength(1);
    // the rest of the report ran: the bridge probe, the db row, the registries
    expect(report.rows.some((r) => r.kind === "bridge" && r.name === "z")).toBe(true);
    expect(report.rows.some((r) => r.kind === "db")).toBe(true);
    expect(report.rows.some((r) => r.kind === "registry")).toBe(true);
    expect(report.ok).toBe(false); // a failed collector is a failed install — it cannot do its job
  });
});

describe.skipIf(!existsSync(join(REPO, "collectors", "dist", "index.js")))("the built collectors, asked by doctor (a build or a release pack)", () => {
  it("every collector answers a check() in core's shape and none is failed with nothing configured", async () => {
    const report = await doctor({
      productDir: REPO,
      env: {},
      fetchFn: (async () => { throw new Error("no network in this test"); }) as unknown as typeof fetch,
      db: null,
      exec: async () => ({ code: 127, stdout: "", stderr: "" }),
      platform: "linux",
      namespace: null,
    });
    const rows = report.rows.filter((r) => r.kind === "collector");
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const r of rows) {
      expect(r.status, `${r.name}: ${r.remediation}`).not.toBe("failed");
      expect(r.probe, r.name).toMatch(/; check\(\): /);
    }
  });
});

describe.skipIf(!existsSync(join(REPO, "collectors", "dist", "index.js")))("doctor, a collector and the connection it reads (shared dial)", () => {
  it("the ICS sync's row asks the shared check once; a calendar is read by its sync, so the check says 'not dialled' and the collector stays ok on what it could see", async () => {
    const instanceDir = await mkdtemp(join(tmpdir(), "metistry-doctor-ics-"));
    await mkdir(join(instanceDir, ".metistry", "connections"), { recursive: true });
    await writeFile(join(instanceDir, ".metistry", "connections", "cal.yaml"), "name: cal\ntype: calendar\nprovider: ics\nreach:\n  http:\n    url: https://127.0.0.1:9/feed.ics\n");
    const report = await doctor({
      productDir: REPO,
      env: { METISTRY_INSTANCE_DIR: instanceDir },
      fetchFn: (async () => { throw new Error("no network in this test"); }) as unknown as typeof fetch,
      db: null,
      exec: async () => ({ code: 127, stdout: "", stderr: "" }),
      platform: "linux",
      namespace: null,
    });
    const ics = report.rows.find((r) => r.kind === "collector" && r.name === "ics-calendar")!;
    const conn = report.rows.find((r) => r.kind === "connection" && r.name === "cal")!;
    expect(conn).toMatchObject({ status: "absent", meta: { refused: "not_built" } });
    expect(ics.status).toBe("ok");
    expect(ics.meta).toMatchObject({ connection: "cal", dialled: false });
    expect(String(ics.meta?.not_dialled)).toMatch(/not dialled as MCP/);
    // the other collectors, with no connection to read, are absent — not failed
    expect(report.rows.find((r) => r.kind === "collector" && r.name === "google-calendar")!.status).toBe("absent");
    expect(report.rows.find((r) => r.kind === "collector" && r.name === "linear")!.status).toBe("absent");
  }, 30_000);
});
