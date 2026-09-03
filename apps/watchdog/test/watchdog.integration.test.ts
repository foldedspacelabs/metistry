// Watchdog probes + alert dedupe against the real db; console probe via
// injected fetch. Skipped without a db.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { runProbes, type ProbeConfig } from "../src/probes.js";
import { alertFailures } from "../src/alert.js";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;
const okFetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
const deadFetch = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;

const cfg: ProbeConfig = { consoleUrl: "http://test", stuckNewMin: 5, stuckProcessingMin: 15, inflightRunMin: 15, hourlyCostUsd: 5 };

describe.skipIf(!hasDb)("watchdog", () => {
  let pool: pg.Pool;

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
  });
  afterAll(async () => pool.end());

  it("all-ok on a healthy system (probe names are the doctor contract)", async () => {
    const checks = await runProbes(pool, cfg, okFetch);
    const byName = Object.fromEntries(checks.map((c) => [c.name, c.status]));
    expect(byName["db"]).toBe("ok");
    expect(byName["console"]).toBe("ok");
    expect(byName["assistant-drain"]).toBe("ok");
    expect(byName["runs-inflight"]).toBe("ok");
    expect(byName["hourly-cost"]).toBe("ok");
  });

  it("dead console fails its probe with remediation, never throws", async () => {
    const checks = await runProbes(pool, cfg, deadFetch);
    const consoleCheck = checks.find((c) => c.name === "console")!;
    expect(consoleCheck.status).toBe("failed");
    expect(consoleCheck.remediation).toContain("ECONNREFUSED");
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

  it("alerts once per quiet window, not per cycle", async () => {
    const failing = [{ name: `wd-${Date.now()}`, status: "failed" as const, latency_ms: 1, probe: "p", remediation: "fix it" }];
    expect(await alertFailures(pool, failing)).toBe(1);
    expect(await alertFailures(pool, failing)).toBe(0); // deduped
    const { rows } = await pool.query(`SELECT kind FROM outbound_messages WHERE text LIKE '%' || $1 || '%'`, [failing[0].name]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("alert");
  });
});
