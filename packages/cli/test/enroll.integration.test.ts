// `metistry enroll` against a real Postgres (plan §2.22): a refused origin
// writes no `auth_enrollment_codes` row; a mint writes one hashed row that the
// console's own spend path accepts exactly once; a code is refused after one
// use, after its ten minutes, and after `--cancel`; and each act lands in
// `runs`. The scratch database `pnpm test` prepares has every migration
// applied. Skipped without a db.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { consumeEnrollmentCode, peekEnrollmentCode, stampEnrollmentOpened, tokenHash } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { enroll, enrollCancel, enrollStatus } from "../src/enroll.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const ORIGIN = "https://assistant.example";

/** A reachable console with no identity to compare (this test has no instance dir). */
const up = (async (url: string | URL | Request) => {
  const path = new URL(String(url)).pathname;
  if (path === "/health") return new Response(JSON.stringify({ ok: true, api_version: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response("", { status: 404 });
}) as unknown as typeof fetch;

const down = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

describe.skipIf(!hasDb)("metistry enroll against the scratch db", () => {
  let pool: pg.Pool;
  const count = async () => Number((await pool.query("SELECT count(*)::int AS n FROM auth_enrollment_codes")).rows[0].n);
  const codeOf = (url: string) => url.slice(`${ORIGIN}/#enroll=`.length);

  beforeAll(async () => {
    pool = await testDb(pg.Pool, { max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("a loopback, an http: and an IP-literal origin are each refused and write no row — and so is an origin this Mac cannot reach", async () => {
    const before = await count();
    const cases: [string, string][] = [
      ["http://127.0.0.1:8080", "loopback"],
      ["http://assistant.example", "http"],
      ["https://192.168.1.4:8443", "ip_literal"],
    ];
    for (const [origin, c] of cases) {
      const r = await enroll({ env: { METISTRY_ORIGIN: origin }, db: pool, fetchFn: down });
      expect(r, origin).toMatchObject({ kind: "refused", refusal: { case: c } });
    }
    expect(await enroll({ env: { METISTRY_ORIGIN: ORIGIN }, db: pool, fetchFn: down })).toMatchObject({ kind: "refused", refusal: { case: "unreachable" } });
    expect(await count()).toBe(before);
  });

  it("a mint writes one hashed row with a ten-minute life, the document names the row and not the code, and a runs row records it", async () => {
    const before = await count();
    const r = await enroll({ env: { METISTRY_ORIGIN: ORIGIN }, db: pool, fetchFn: up });
    expect(r.kind).toBe("minted");
    if (r.kind !== "minted") return;
    expect(await count()).toBe(before + 1);
    const code = codeOf(r.minted.url);
    const { rows } = await pool.query("SELECT id, code_hash, used_at, created_at, expires_at FROM auth_enrollment_codes WHERE id = $1", [r.minted.code_id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_hash).toBe(tokenHash(code));
    expect(rows[0].code_hash).not.toBe(code);
    expect(rows[0].used_at).toBeNull();
    expect(new Date(rows[0].expires_at).getTime() - new Date(rows[0].created_at).getTime()).toBe(10 * 60 * 1000);
    expect(r.minted.expires_at).toBe(new Date(rows[0].expires_at).toISOString());
    expect(r.minted.origin).toBe(ORIGIN);
    expect(JSON.stringify({ ...r.minted, url: "" })).not.toContain(code);
    const runs = await pool.query("SELECT component, kind, tool, ok, meta FROM runs WHERE kind = 'auth' AND tool = 'enroll' AND (meta->>'code_id')::bigint = $1", [r.minted.code_id]);
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({ component: "cli", kind: "auth", tool: "enroll", ok: true });
    expect(runs.rows[0].meta).toMatchObject({ origin: ORIGIN, code_id: r.minted.code_id });
    expect(JSON.stringify(runs.rows[0].meta)).not.toContain(code);
  });

  it("a code works once: the console's spend path takes it the first time and refuses it after", async () => {
    const r = await enroll({ env: { METISTRY_ORIGIN: ORIGIN }, db: pool, fetchFn: up });
    if (r.kind !== "minted") throw new Error("not minted");
    const code = codeOf(r.minted.url);
    expect(await peekEnrollmentCode(pool, code)).toBe(true);
    expect(await consumeEnrollmentCode(pool, code)).toBe(true);
    expect(await consumeEnrollmentCode(pool, code)).toBe(false);
    expect(await peekEnrollmentCode(pool, code)).toBe(false);
    // cancelling a spent code changes nothing and says so
    expect(await enrollCancel({ env: {}, db: pool, codeId: r.minted.code_id })).toEqual({ code_id: r.minted.code_id, outcome: "already_used", cancelled: false });
  });

  it("a code is refused after ten minutes", async () => {
    const r = await enroll({ env: { METISTRY_ORIGIN: ORIGIN }, db: pool, fetchFn: up });
    if (r.kind !== "minted") throw new Error("not minted");
    const code = codeOf(r.minted.url);
    // the clock, moved: the row's own expiry is what the spend path reads
    await pool.query("UPDATE auth_enrollment_codes SET expires_at = now() - interval '1 second' WHERE id = $1", [r.minted.code_id]);
    expect(await peekEnrollmentCode(pool, code)).toBe(false);
    expect(await consumeEnrollmentCode(pool, code)).toBe(false);
    expect(await enrollCancel({ env: {}, db: pool, codeId: r.minted.code_id })).toMatchObject({ outcome: "already_expired", cancelled: false });
  });

  it("a code is refused after --cancel: the row is expired at once, the URL is dead, and runs records the cancel", async () => {
    const r = await enroll({ env: { METISTRY_ORIGIN: ORIGIN }, db: pool, fetchFn: up });
    if (r.kind !== "minted") throw new Error("not minted");
    const code = codeOf(r.minted.url);
    expect(await peekEnrollmentCode(pool, code)).toBe(true);
    expect(await enrollCancel({ env: {}, db: pool, codeId: r.minted.code_id })).toEqual({ code_id: r.minted.code_id, outcome: "cancelled", cancelled: true });
    expect(await peekEnrollmentCode(pool, code)).toBe(false);
    expect(await consumeEnrollmentCode(pool, code)).toBe(false);
    const { rows } = await pool.query("SELECT used_at, expires_at <= now() AS dead FROM auth_enrollment_codes WHERE id = $1", [r.minted.code_id]);
    expect(rows[0]).toEqual({ used_at: null, dead: true });
    // a second cancel finds it already dead; a stranger's id finds nothing
    expect(await enrollCancel({ env: {}, db: pool, codeId: r.minted.code_id })).toMatchObject({ outcome: "already_expired", cancelled: false });
    expect(await enrollCancel({ env: {}, db: pool, codeId: 2147483647 })).toMatchObject({ outcome: "not_found", cancelled: false });
    const runs = await pool.query("SELECT ok, meta FROM runs WHERE kind = 'auth' AND tool = 'enroll_cancel' AND (meta->>'code_id')::bigint = $1 ORDER BY id", [r.minted.code_id]);
    expect(runs.rows.map((x) => [x.ok, x.meta.outcome])).toEqual([
      [true, "cancelled"],
      [true, "already_expired"],
    ]);
  });
  it("--status reads the opened stamp by id: null until the console stamps it, `proxy` after, and the code is never in the document — read-only, no runs row", async () => {
    const r = await enroll({ env: { METISTRY_ORIGIN: ORIGIN }, db: pool, fetchFn: up });
    if (r.kind !== "minted") throw new Error("not minted");
    const code = codeOf(r.minted.url);
    const runsBefore = Number((await pool.query("SELECT count(*)::int AS n FROM runs WHERE tool LIKE 'enroll%'")).rows[0].n);
    const fresh = await enrollStatus({ env: {}, db: pool, codeId: r.minted.code_id });
    expect(fresh).toEqual({ code_id: r.minted.code_id, state: "live", expires_at: r.minted.expires_at, opened_at: null, opened_via: null, provider: null });
    await stampEnrollmentOpened(pool, code, "main");
    expect(await enrollStatus({ env: {}, db: pool, codeId: r.minted.code_id })).toMatchObject({ state: "live", opened_via: "main" });
    await stampEnrollmentOpened(pool, code, "proxy");
    const opened = await enrollStatus({ env: {}, db: pool, codeId: r.minted.code_id });
    expect(opened).toMatchObject({ state: "live", opened_via: "proxy" });
    expect(opened?.opened_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(JSON.stringify(opened)).not.toContain(code);
    // cancelled is dead but keeps what it saw; a stranger's id is undefined
    await enrollCancel({ env: {}, db: pool, codeId: r.minted.code_id });
    expect(await enrollStatus({ env: {}, db: pool, codeId: r.minted.code_id })).toMatchObject({ state: "expired", opened_via: "proxy" });
    expect(await enrollStatus({ env: {}, db: pool, codeId: 2147483647 })).toBeUndefined();
    const runsAfter = Number((await pool.query("SELECT count(*)::int AS n FROM runs WHERE tool LIKE 'enroll%'")).rows[0].n);
    expect(runsAfter).toBe(runsBefore + 1); // the cancel's row alone
  });
});
