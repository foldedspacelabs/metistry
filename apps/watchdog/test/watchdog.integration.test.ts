// Watchdog probes + alert dedupe against the real db; console and bridge
// probes via injected fetch. Skipped without a db.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { runProbes, type ProbeConfig } from "../src/probes.js";
import { alertFailures } from "../src/alert.js";
import { loadScheduled } from "../src/manifests.js";
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

// console /health ok; apple-fm /check answers the wire contract with the given status
const bridgeFetch = (afm: "ok" | "failed") =>
  (async (url: string) => {
    if (!url.endsWith("/check")) return { ok: true, status: 200 };
    const body = { name: "apple-fm", status: afm, latency_ms: 1, probe: "canned", ...(afm === "failed" ? { remediation: "helper check failed" } : {}) };
    return { ok: afm === "ok", status: afm === "ok" ? 200 : 503, json: async () => body };
  }) as unknown as typeof fetch;
const okFetch = bridgeFetch("ok");
const deadFetch = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;

// one synthetic scheduled component per run, so the SQL is exercised without
// depending on which collectors other packages' tests happened to run
const component = `wd-silent-${Date.now()}`;

describe.skipIf(!hasDb)("watchdog", () => {
  let pool: pg.Pool;
  let cfg: ProbeConfig;

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test", // scratch db (ops/scripts/test-db.sh)
      password: process.env.METISTRY_DB_PASSWORD,
    });
    // park stray queue rows so drain-staleness probes see a clean world
    await pool.query(`UPDATE inbound_messages SET status='done' WHERE status IN ('new','processing')`);
    await pool.query(`UPDATE runs SET finished_at = now(), ok = false WHERE finished_at IS NULL`);
    // push other tests' inbox proposals out of the FM window (never deleted)
    await pool.query(`UPDATE proposals SET ts = ts - interval '2 days' WHERE payload ? 'tier' AND ts > now() - interval '1 day'`);

    const root = await mkdtemp(join(tmpdir(), "wd-int-"));
    await mkdir(join(root, "collectors", component), { recursive: true });
    await writeFile(join(root, "collectors", component, "manifest.yaml"), `name: ${component}\ntype: collector\nschedule: "*/5 * * * *"\nwrites: [x]\n`);
    await mkdir(join(root, "routines"), { recursive: true });
    cfg = {
      consoleUrl: "http://test",
      stuckNewMin: 5,
      stuckProcessingMin: 15,
      inflightRunMin: 15,
      hourlyCostUsd: 5,
      collectorsDir: join(root, "collectors"),
      routinesDir: join(root, "routines"),
      silenceFactor: 3,
      startedAt: new Date(),
      bridges: [{ name: "apple-fm", url: "http://127.0.0.1:7810", token: "t" }],
      fmMinCaptures: 5,
      fmWindowHours: 24,
    };
    await pool.query(`INSERT INTO runs (component, kind, ok, started_at, finished_at) VALUES ($1, 'collector_run', true, now(), now())`, [component]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM runs WHERE component = $1`, [component]);
    await pool.query(`DELETE FROM proposals WHERE source_agent = 'wd-test'`);
    await pool.end();
  });

  it("all-ok on a healthy system (probe names are the doctor contract)", async () => {
    const checks = await runProbes(pool, cfg, okFetch);
    const byName = Object.fromEntries(checks.map((c) => [c.name, c.status]));
    expect(byName["db"]).toBe("ok");
    expect(byName["console"]).toBe("ok");
    expect(byName["assistant-drain"]).toBe("ok");
    expect(byName["runs-inflight"]).toBe("ok");
    expect(byName["hourly-cost"]).toBe("ok");
    expect(byName["silent-collector"]).toBe("ok");
    expect(byName["bridge-degraded"]).toBe("ok");
    expect(byName["fm-tier-never-fires"]).toBe("ok");
  });

  it("every shipped collector/routine manifest loads through the watchdog's own discovery", async () => {
    const names = [...(await loadScheduled(`${repoRoot}collectors`)), ...(await loadScheduled(`${repoRoot}routines`))].map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["inbox-drain", "github-state", "aws-costs", "claude-usage", "morning-brief", "weekly-review"]));
  });

  it("dead console fails its probe with remediation, never throws", async () => {
    const checks = await runProbes(pool, cfg, deadFetch);
    const consoleCheck = checks.find((c) => c.name === "console")!;
    expect(consoleCheck.status).toBe("failed");
    expect(consoleCheck.remediation).toContain("ECONNREFUSED");
    // the same dead fetch takes the bridge down — distinctly from a degraded one
    const bridge = checks.find((c) => c.name === "bridge-degraded")!;
    expect(bridge.status).toBe("failed");
    expect(bridge.remediation).toContain("apple-fm down (connect ECONNREFUSED)");
    expect((await runProbes(pool, cfg, bridgeFetch("failed"))).find((c) => c.name === "bridge-degraded")!).toMatchObject({
      status: "degraded",
      remediation: "apple-fm failed: helper check failed",
    });
  });

  it("detects a hung in-flight run (CRIT-8 payoff)", async () => {
    const { rows } = await pool.query(
      `INSERT INTO runs (component, kind, started_at, ok) VALUES ('test', 'turn', now() - interval '30 minutes', NULL) RETURNING id`,
    );
    const checks = await runProbes(pool, cfg, okFetch);
    expect(checks.find((c) => c.name === "runs-inflight")!.status).toBe("failed");
    await pool.query(`UPDATE runs SET finished_at = now(), ok = false WHERE id = $1`, [rows[0].id]);
  });

  it("detects an unclaimed message (assistant down)", async () => {
    const { rows } = await pool.query(
      `INSERT INTO inbound_messages (thread, text, ts) VALUES ('wd-test', 'stuck', now() - interval '10 minutes') RETURNING id`,
    );
    const checks = await runProbes(pool, cfg, okFetch);
    expect(checks.find((c) => c.name === "assistant-drain")!.status).toBe("failed");
    await pool.query(`UPDATE inbound_messages SET status='done' WHERE id = $1`, [rows[0].id]);
  });

  it("silent-collector: the last runs row for the component, older than 3× its interval", async () => {
    await pool.query(`UPDATE runs SET ts = now() - interval '20 minutes' WHERE component = $1`, [component]);
    const silent = (await runProbes(pool, cfg, okFetch)).find((c) => c.name === "silent-collector")!;
    expect(silent.status).toBe("failed");
    expect(silent.remediation).toContain(`${component} (no run in >15m; schedule "*/5 * * * *")`);
    expect(silent.remediation).toContain("docker compose logs console");
    // a fresh row (a later run) clears it — max(ts) per component, not the first row
    await pool.query(`INSERT INTO runs (component, kind, ok, started_at, finished_at) VALUES ($1, 'collector_run', true, now(), now())`, [component]);
    expect((await runProbes(pool, cfg, okFetch)).find((c) => c.name === "silent-collector")!.status).toBe("ok");
  });

  it("fm-tier-never-fires: counts inbox-drain's payload fields inside the window", async () => {
    const insert = (tier: string, reason: string, note: string | null, ageHours = 0) =>
      pool.query(
        `INSERT INTO proposals (kind, source_agent, trust, payload, ts)
         VALUES ('knowledge', 'wd-test', 'user', $1, now() - make_interval(hours => $2))`,
        [JSON.stringify({ inbox_id: 1, path: "x", classification: { kind: "note", reason, title: "t" }, note, tier }), ageHours],
      );
    for (let i = 0; i < 5; i++) await insert("deterministic", "default", `thought ${i}`);
    await insert("deterministic", "leading action verb", "todo call bob"); // rules fired — not a candidate
    await insert("deterministic", "default", null); // no note — not a candidate
    await insert("deterministic", "default", "old", 30); // outside the 24h window
    let fm = (await runProbes(pool, cfg, okFetch)).find((c) => c.name === "fm-tier-never-fires")!;
    expect(fm.status).toBe("degraded");
    expect(fm.meta).toEqual({ ruleDefault: 5, fm: 0 });
    expect(fm.remediation).toContain("apple-fm answers /check but inbox-drain never reaches it");

    // The tier recorded is the PROVIDER's name, whatever compute.yaml calls
    // it — the probe counts "not deterministic", never one spelling.
    for (let i = 0; i < 3; i++) await insert("applefm", "applefm", `refined ${i}`);
    for (let i = 0; i < 2; i++) await insert("my-local", "my-local", `refined local ${i}`);
    fm = (await runProbes(pool, cfg, okFetch)).find((c) => c.name === "fm-tier-never-fires")!;
    expect(fm.status).toBe("ok");
    expect(fm.meta).toEqual({ ruleDefault: 5, fm: 5 });
  });

  it("alerts once per quiet window, not per cycle", async () => {
    const failing = [{ name: `wd-${Date.now()}`, status: "failed" as const, latency_ms: 1, probe: "p", remediation: "fix it" }];
    expect(await alertFailures(pool, failing)).toBe(1);
    expect(await alertFailures(pool, failing)).toBe(0); // deduped
    const { rows } = await pool.query(`SELECT kind FROM outbound_messages WHERE text LIKE '%' || $1 || '%'`, [failing[0].name]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("alert");
  });
});
