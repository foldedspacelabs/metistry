// The egress fill's stamp, end to end against the scratch database
// (design-build-plan §2.14, T4-2; docs/ops/testing.md): a call through
// `guardedFetch` reports the names it sent, `recordSecretUse` stamps them on
// the caller's `runs` row as `meta.secrets`, and the `secret_last_used`
// named query — what `GET /api/secrets` shows as *last used* (T4-1) — reads
// them back. A refused call stamps nothing. No value reaches the row.
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import {
  InstanceSecrets,
  SECRET_LAST_USED_QUERY,
  SecretRedactor,
  finishRun,
  guardedFetch,
  memoryKeychain,
  mintToken,
  parseSecretsFile,
  recordSecretUse,
  startRun,
} from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const ID = "11111111-2222-4333-8444-555555555555";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
/** names no other test's ledger rows use, so *last used* is this file's alone */
const GH = `github_write_${suffix}`;
const LINEAR = `linear_key_${suffix}`;
const VALUE = "ghp_SENTINEL-egress-stamp-value";

describe.skipIf(!hasDb)("egress fill → runs.meta.secrets → secret_last_used", () => {
  let pool: pg.Pool;
  let queries: QueryStore;
  const runIds: number[] = [];

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM runs WHERE id = ANY($1)`, [runIds]).catch(() => undefined);
    await pool.end();
  });

  it("a call that sends a secret stamps its name; a refused one stamps nothing", async () => {
    const kc = memoryKeychain();
    const source = new InstanceSecrets(kc, ID);
    await source.set(GH, VALUE);
    await source.set(LINEAR, "lin_SENTINEL-other");
    const secrets = parseSecretsFile(`
secrets:
  ${GH}:
    hosts: [api.github.com]
    grants: { "connection:github": on }
  ${LINEAR}:
    hosts: [api.linear.app]
    grants: { "connection:github": on }
`);
    const runId = await startRun(pool, { component: "itest-egress", kind: "connection_call", meta: { tool: "x" } });
    runIds.push(runId);
    const door = guardedFetch(
      {
        secrets,
        source,
        grantee: "connection:github",
        purpose: "service",
        redactor: new SecretRedactor(),
        onUse: ({ names }) => recordSecretUse(pool, runId, names),
      },
      (async () => new Response(`echo ${VALUE}`)) as unknown as typeof fetch,
    );

    const res = await door("https://api.github.com/user", { headers: { authorization: `Bearer {{ secret.${GH} }}` } });
    const text = await res.text();
    await door("https://api.github.com/user", { headers: { authorization: `Bearer {{ secret.${GH} }}` } });
    // LINEAR is listed for api.linear.app only: refused, never stamped
    await door("https://api.github.com/user", { headers: { authorization: `{{ secret.${LINEAR} }}` } }).catch(() => undefined);
    await finishRun(pool, runId, { ok: true, error: text, meta: { note: text } });

    const { rows } = await pool.query(`SELECT meta FROM runs WHERE id = $1`, [runId]);
    expect(rows[0]!.meta).toEqual({ tool: "x", secrets: [GH], note: expect.any(String) });
    expect(JSON.stringify(rows[0]!.meta)).not.toContain(VALUE);

    const lastUsed = (await queries.run(SECRET_LAST_USED_QUERY)).rows as Array<{ name: string; last_used: unknown }>;
    expect(lastUsed.find((r) => r.name === GH)?.last_used).toBeTruthy();
    expect(lastUsed.find((r) => r.name === LINEAR)).toBeUndefined();
  });

  it("several calls in one run accumulate, as a sorted set", async () => {
    const runId = await startRun(pool, { component: "itest-egress", kind: "connection_call", meta: { [`secrets`]: "not-an-array" } });
    runIds.push(runId);
    await recordSecretUse(pool, runId, [LINEAR]);
    await recordSecretUse(pool, runId, [GH, LINEAR]);
    const { rows } = await pool.query(`SELECT meta FROM runs WHERE id = $1`, [runId]);
    expect(rows[0]!.meta.secrets).toEqual([GH, LINEAR].sort());
  });
});
