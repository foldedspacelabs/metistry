// T9-1's own test (docs/ops/dynamic-router.md §8): **the served route, the
// 202 body and the reply are byte-identical to today's, with a stub policy
// that answers, throws, or never resolves** — held at the HTTP door, over a
// real database, because that is where "in shadow" either holds or does not.
// And the record it writes: one `runs` row of kind `route` per message, with
// no message text in it.
//
// Skipped when no db is configured (CI provides one; locally
// ops/scripts/test-db.sh does).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import { loadRules, type RoutePolicy } from "../src/router.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

const rules = loadRules(readFileSync(new URL("../../../seed/rules.yaml", import.meta.url), "utf8"));
const ROUTE_FEATURES = readFileSync(new URL("../../../seed/queries/route_features.yaml", import.meta.url), "utf8");

// Every rule the router has, once: R1 /note, R4 a fast path, R3 /deep, R2
// /model, R5 the picker, an unknown /model tag and an unknown picker tier
// (both fall through), and the plain fall-through R6.
const MESSAGES: { text: string; tier?: string }[] = [
  { text: "/note buy oat milk" },
  { text: "/status" },
  { text: "/deep weigh the two offers against each other" },
  { text: "/model fast what time is it in lisbon" },
  { text: "plan my week around the move", tier: "deep" },
  { text: "/model gpt99 hello there" },
  { text: "summarise what changed", tier: "nonesuch" },
  { text: "remind me about the dentist appointment on thursday" },
];

const STUBS: Record<string, RoutePolicy | undefined> = {
  none: undefined,
  answers: { decide: () => ({ outcome: "chosen", row: "always-deep", chosen: { operation: "tools", tier: "deep", tool_calls: 3 } }), tiers: ["fast", "default", "deep"] },
  throws: {
    decide: () => {
      throw new Error("stub policy threw");
    },
  },
  never: { decide: () => new Promise(() => {}) }, // the default 400 ms deadline
};

describe.skipIf(!hasDb)("the route record, in shadow (T9-1)", () => {
  let pool: pg.Pool;
  const servers: ReturnType<typeof makeServer>[] = [];
  const bases: Record<string, string> = {};
  const token = mintToken();
  const run = mintToken(6);

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const queries = new QueryStore(pool);
    // a fast path whose answer does not move while the test runs — the real
    // `open_work` reads `work`, which other files write concurrently
    queries.load(`
name: open_work
description: test
params:
  limit: { type: int, default: 5 }
sql: SELECT 'the one open thing' AS title, (:limit)::int AS n
`);
    queries.load(ROUTE_FEATURES);
    for (const [name, routePolicy] of Object.entries(STUBS)) {
      const server = makeServer(pool, queries, {
        origin: "http://127.0.0.1:0",
        inboxDir: mkdtempSync(join(tmpdir(), "metistry-route-record-")),
        policy: { idleDays: 30, maxDays: 365 },
        secureCookies: false,
        rules,
        routePolicy,
        localOwner: { token, trusted: [] },
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      servers.push(server);
      bases[name] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }
  });

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    // let any shadow consultation still in flight finish writing before the pool goes
    await new Promise((r) => setTimeout(r, 600));
    await pool.end();
  });

  const post = async (base: string, thread: string, m: { text: string; tier?: string }) => {
    const r = await fetch(`${base}/message`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ thread_id: thread, text: m.text, ...(m.tier ? { tier: m.tier } : {}) }),
    });
    return { status: r.status, body: (await r.json()) as { message_id: number | string; reply?: string } };
  };

  /** The route row for a message, once it has finished — shadow writes it after the 202. */
  const routeRow = async (messageId: number | string): Promise<Record<string, any>> => {
    for (let i = 0; i < 60; i++) {
      const { rows } = await pool.query(
        `SELECT component, kind, tool, provider, model, ok, error, duration_ms, started_at, finished_at, meta
           FROM runs WHERE kind = 'route' AND meta->>'message_id' = $1 AND finished_at IS NOT NULL`,
        [String(messageId)],
      );
      if (rows[0]) return rows[0];
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no finished route row for message ${String(messageId)}`);
  };

  /** Everything the rules served for one message, with the ids that differ between two servers masked. */
  const servedFor = async (messageId: number | string, body: unknown) => {
    const inbound = await pool.query(`SELECT meta::text AS meta, text, status FROM inbound_messages WHERE id = $1`, [messageId]);
    const outbound = await pool.query(`SELECT text, kind FROM outbound_messages WHERE in_reply_to = $1 ORDER BY id`, [messageId]);
    const mask = (s: string) => s.replace(/#\d+/g, "#N");
    return {
      body: mask(JSON.stringify({ ...(body as object), message_id: "N" })),
      inbound: inbound.rows[0],
      replies: outbound.rows.map((r) => ({ kind: r.kind, text: mask(String(r.text)) })),
    };
  };

  it("**the served route, the 202 body and the reply are byte-identical to today's, with a stub policy that answers, throws, or never resolves**", async () => {
    const served: Record<string, unknown[]> = {};
    const ids: Record<string, (number | string)[]> = {};
    for (const name of Object.keys(STUBS)) {
      served[name] = [];
      ids[name] = [];
      for (const m of MESSAGES) {
        const r = await post(bases[name]!, `rr-${run}-${name}`, m);
        expect(r.status, `${name}: ${m.text}`).toBe(202);
        served[name]!.push(await servedFor(r.body.message_id, r.body));
        ids[name]!.push(r.body.message_id);
      }
    }
    // the fast path answered, the note was acked — so the replies compared are real ones
    expect(JSON.stringify(served.none)).toContain("the one open thing");
    expect(JSON.stringify(served.none)).toContain("noted → inbox #N");
    for (const name of ["answers", "throws", "never"]) expect(served[name], name).toEqual(served.none);

    // …and the record says what each stub did, beside what was served
    const outcomes = async (name: string) => Promise.all(ids[name]!.map(async (id) => (await routeRow(id)).meta.policy.outcome));
    const rulesFirst = ["not_consulted", "not_consulted"]; // /note, /status: the policy is never asked
    expect(await outcomes("none")).toEqual([...rulesFirst, "absent", "absent", "absent", "absent", "absent", "absent"]);
    expect(await outcomes("answers")).toEqual([...rulesFirst, "counterfactual", "counterfactual", "counterfactual", "chosen", "chosen", "chosen"]);
    expect(await outcomes("throws")).toEqual([...rulesFirst, "failed", "failed", "failed", "failed", "failed", "failed"]);
    expect(await outcomes("never")).toEqual([...rulesFirst, "timeout", "timeout", "timeout", "timeout", "timeout", "timeout"]);
  });

  it("shadow does not wait: the 202 is sent while a policy that never answers is still being waited for", async () => {
    const r = await post(bases.never!, `rr-${run}-wait`, { text: "is the 202 held up by the policy" });
    expect(r.status).toBe(202);
    const now = await pool.query(`SELECT ok, finished_at FROM runs WHERE kind = 'route' AND meta->>'message_id' = $1`, [String(r.body.message_id)]);
    // not written yet, or written in flight (two-phase: started, not finished) — never finished before the 202
    for (const row of now.rows) expect(row.finished_at).toBeNull();
    const done = await routeRow(r.body.message_id);
    expect(done).toMatchObject({ ok: false, error: "the consultation ran past 400 ms" });
    expect(Number(done.duration_ms)).toBeGreaterThanOrEqual(350);
  });

  it("one row per message: component console, kind route, the derived kind in `tool`, no provider or model, and the cheap features", async () => {
    const thread = `rr-${run}-shape`;
    const first = await post(bases.none!, thread, { text: "where is the quarterly report" });
    const again = await post(bases.none!, thread, { text: "Where is the quarterly report?" });
    const row = await routeRow(again.body.message_id);
    expect(row).toMatchObject({ component: "console", kind: "route", tool: "default", provider: null, model: null, ok: true, error: null });
    expect(row.started_at).not.toBeNull();
    expect(row.meta).toMatchObject({
      v: 1,
      message_id: Number(again.body.message_id),
      thread,
      phase: "shadow",
      rules: { served: "default", default_tier: "default" },
      served: { kind: "model", tier: "default", operation: "tools", routed_by: "rule" },
      // the previous message in the thread, within 30 minutes, the same words: a re-ask
      features: { words: 5, attachments: 0, thread_turns: 0, recent_failures: 0, reask: true },
      policy: { outcome: "absent" },
    });
    // the first message is not compared with itself (`exclude_id`)
    expect((await routeRow(first.body.message_id)).meta.features.reask).toBe(false);
    expect(await pool.query(`SELECT count(*)::int AS n FROM runs WHERE kind = 'route' AND meta->>'message_id' = $1`, [String(again.body.message_id)])).toMatchObject({ rows: [{ n: 1 }] });
  });

  it("the row carries no message text — not the text, not `meta.route.text`'s copy, not the previous message the re-ask read", async () => {
    const thread = `rr-${run}-private`;
    const texts = ["the safe combination is seven three nine", "/note the safe combination is seven three nine", "/deep the safe combination is seven three nine"];
    for (const name of ["none", "answers"]) {
      for (const text of texts) {
        const r = await post(bases[name]!, thread, { text });
        const row = await routeRow(r.body.message_id);
        const cells = JSON.stringify(row);
        for (const needle of ["combination", "seven three", "safe"]) expect(cells, `${name}: ${text}`).not.toContain(needle);
      }
    }
  });
});
