// T9-2 at the door (docs/ops/dynamic-router.md §7.1): with the owner's table
// wired as the console's `routePolicy` — the real one, `makeRoutePolicy` over
// a `rules.yaml` `policy:` block, its local scorer answering — the served
// route, the 202 body and the reply are byte-identical to a console with no
// policy at all, and the `runs` row of kind `route` records what the table
// chose, with the features it read and no text.
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
import { codesFor, COMPLEXITY_NAMES, INTENT_NAMES, mintToken, parseCompute } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import { loadRules, makeRoutePolicy, type RoutePolicy } from "../src/router.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

const SEED = readFileSync(new URL("../../../seed/rules.yaml", import.meta.url), "utf8");
const ROUTE_FEATURES = readFileSync(new URL("../../../seed/queries/route_features.yaml", import.meta.url), "utf8");

const plain = loadRules(SEED);
const withPolicy = loadRules(`${SEED}
intent:
  min_confidence: 0.8
policy:
  tiers: [fast, default, deep]
  caps: { tool_calls: 12, tokens: 150000, cost_usd: 0.5 }
  complexity: { min_confidence: 0.7 }
  table:
    - { id: status, when: { intent: status_open_work, words: { max: 15 } }, then: { operation: "fast_path:open_work" } }
    - { id: by-complexity, when: { complexity: [simple, moderate, demanding] }, then: { operation: tools, tier: { simple: fast, moderate: default, demanding: deep } } }
`);

const COMPUTE = parseCompute(`
providers:
  ollama: { kind: openai-compatible, base_url: http://127.0.0.1:11434/v1, locality: on_machine }
assignments:
  default: { model: ollama/small-model }
  tiers:
    fast: { model: ollama/small-model, effort: low }
    deep: { model: ollama/big-model, effort: high }
  intent: { model: ollama/gemma4:e4b-it-qat }
`);

/** The local scorer: every message is `explanation_request`, `demanding`. Nothing listens on 11434; this is the only server. */
const scorerFetch = (async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body);
  const names: readonly string[] = body.top_logprobs === 3 ? COMPLEXITY_NAMES : INTENT_NAMES;
  const want = body.top_logprobs === 3 ? "demanding" : "explanation_request";
  const codes = codesFor(names.length);
  const i = names.indexOf(want);
  const top = [
    { token: codes[i]!, logprob: Math.log(0.97) },
    { token: codes[(i + 1) % names.length]!, logprob: Math.log(0.03) },
  ];
  return new Response(JSON.stringify({ choices: [{ message: { content: codes[i] }, logprobs: { content: [{ top_logprobs: top }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

const MESSAGES: { text: string; tier?: string }[] = [
  { text: "/note buy oat milk" },
  { text: "/status" },
  { text: "/deep weigh the two offers against each other" },
  { text: "plan my week around the move", tier: "fast" },
  { text: "remind me about the dentist appointment on thursday" },
];

describe.skipIf(!hasDb)("the owner's table, in shadow, at the door (T9-2)", () => {
  let pool: pg.Pool;
  const servers: ReturnType<typeof makeServer>[] = [];
  const bases: Record<string, string> = {};
  const token = mintToken();
  const run = mintToken(6);

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const queries = new QueryStore(pool);
    queries.load(`
name: open_work
description: test
params:
  limit: { type: int, default: 5 }
sql: SELECT 'the one open thing' AS title, (:limit)::int AS n
`);
    queries.load(ROUTE_FEATURES);
    const policy = makeRoutePolicy({ rules: withPolicy, compute: () => COMPUTE, fetchFn: scorerFetch, hasQuery: (n) => queries.names().includes(n), hasCrew: () => false });
    const configs: Record<string, { rules: typeof plain; routePolicy: RoutePolicy | undefined }> = {
      none: { rules: plain, routePolicy: undefined },
      table: { rules: withPolicy, routePolicy: policy },
    };
    for (const [name, c] of Object.entries(configs)) {
      const server = makeServer(pool, queries, {
        origin: "http://127.0.0.1:0",
        inboxDir: mkdtempSync(join(tmpdir(), "metistry-route-policy-")),
        policy: { idleDays: 30, maxDays: 365 },
        secureCookies: false,
        rules: c.rules,
        routePolicy: c.routePolicy,
        localOwner: { token, trusted: [] },
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      servers.push(server);
      bases[name] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }
  });

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
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

  const routeRow = async (messageId: number | string): Promise<Record<string, any>> => {
    for (let i = 0; i < 60; i++) {
      const { rows } = await pool.query(`SELECT ok, error, meta FROM runs WHERE kind = 'route' AND meta->>'message_id' = $1 AND finished_at IS NOT NULL`, [String(messageId)]);
      if (rows[0]) return rows[0];
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no finished route row for message ${String(messageId)}`);
  };

  const servedFor = async (messageId: number | string, body: unknown) => {
    const inbound = await pool.query(`SELECT meta::text AS meta, text, status FROM inbound_messages WHERE id = $1`, [messageId]);
    const outbound = await pool.query(`SELECT text, kind FROM outbound_messages WHERE in_reply_to = $1 ORDER BY id`, [messageId]);
    const mask = (s: string) => s.replace(/#\d+/g, "#N");
    return { body: mask(JSON.stringify({ ...(body as object), message_id: "N" })), inbound: inbound.rows[0], replies: outbound.rows.map((r) => ({ kind: r.kind, text: mask(String(r.text)) })) };
  };

  it("the served route, the 202 body and the reply are byte-identical with the owner's table wired; the record says what it chose", async () => {
    const served: Record<string, unknown[]> = { none: [], table: [] };
    const ids: (number | string)[] = [];
    for (const name of ["none", "table"]) {
      for (const m of MESSAGES) {
        const r = await post(bases[name]!, `rp-${run}-${name}`, m);
        expect(r.status).toBe(202);
        served[name]!.push(await servedFor(r.body.message_id, r.body));
        if (name === "table") ids.push(r.body.message_id);
      }
    }
    expect(JSON.stringify(served.none)).toContain("the one open thing");
    expect(served.table).toEqual(served.none);

    const rows = await Promise.all(ids.map(routeRow));
    expect(rows.map((r) => r.meta.policy.outcome)).toEqual(["not_consulted", "not_consulted", "counterfactual", "counterfactual", "chosen"]);
    const fallThrough = rows[4]!;
    expect(fallThrough).toMatchObject({
      ok: true,
      meta: {
        served: { kind: "model", tier: "default", operation: "tools", routed_by: "rule" },
        policy: { row: "by-complexity", chosen: { operation: "tools", tier: "deep", tool_calls: 12 }, bounded_by: [], tiers: ["fast", "default", "deep"] },
        features: { intent: { outcome: "scored", intent: "explanation_request" }, complexity: { outcome: "scored", class: "demanding" } },
        agrees: false,
      },
    });
    // /deep agreed with the table; the picker's `fast` did not
    expect(rows[2]!.meta.agrees).toBe(true);
    expect(rows[3]!.meta.agrees).toBe(false);
    for (const r of rows) expect(JSON.stringify(r)).not.toMatch(/dentist|oat milk|offers|the move/);
  });
});
