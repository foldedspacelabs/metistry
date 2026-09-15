// The W6 round trip against the real (scratch) database and a live server:
// route auth (owner token → 403, session → ok), the session request Devin
// actually receives, the `devin:<id>` ref under the partial unique index,
// and the return path — the poll collector turning a finished session into a
// `report` proposal, closing the work row and writing the reported ACUs back
// onto the dispatch `runs` row. Devin itself is a fake; nothing here touches
// the network.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { collectors } from "@metistry-apps/collectors";
import { makeServer } from "../src/server.js";
import { TargetRegistry } from "../src/dispatch.js";
import * as store from "../src/auth-store.js";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;
const policy = { idleDays: 30, maxDays: 365 };
const root = fileURLToPath(new URL("../../../", import.meta.url));
const pollDevin = collectors.find((c) => c.name === "devin-sessions")!.run;
// unique per run: external_ref is unique, and a verbose re-run reuses the scratch db
const RUN = Date.now().toString(36);

/** Devin fake: POST creates a session with an incrementing id; GET answers whatever `sessions` holds. */
function devinFake(state: { next: number; sessions: Map<string, Record<string, unknown>>; posts: Record<string, unknown>[] }) {
  return (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const id = `devin-${RUN}-${state.next++}`;
      state.posts.push(JSON.parse(String(init.body)));
      state.sessions.set(id, { session_id: id, url: `https://app.devin.ai/sessions/${id}`, status: "running", status_detail: "working", acus_consumed: 0 });
      return { ok: true, status: 200, json: async () => ({ session_id: id, url: `https://app.devin.ai/sessions/${id}` }) };
    }
    if (url.endsWith("/v3/self")) return { ok: true, status: 200, json: async () => ({ org_id: "org-abc" }), text: async () => "" };
    const id = url.split("/").pop()!;
    const s = state.sessions.get(id);
    if (!s) return { ok: false, status: 404, text: async () => "no such session" };
    return { ok: true, status: 200, json: async () => s, text: async () => "" };
  }) as unknown as typeof fetch;
}

describe.skipIf(!hasDb)("devin-sessions target (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let session: string;
  let ownerToken: string;
  const devin = { next: 1, sessions: new Map<string, Record<string, unknown>>(), posts: [] as Record<string, unknown>[] };
  const fetchFn = devinFake(devin);
  const env = { METISTRY_DEVIN_API_KEY: "cog_test", METISTRY_DEVIN_ORG_ID: "org-abc" };
  // the collector's context: the same key, the same fake Devin, and the
  // organization it reads off each work row's meta (never from here)
  const pollCtx = { devinApiKey: "cog_test", fetchFn };

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      password: process.env.METISTRY_DB_PASSWORD,
    });
    const targets = new TargetRegistry({ env, fetchFn });
    await targets.loadDir(`${root}targets`);
    // The instance overlay (D4) is what widens the empty product allow list;
    // here it is done inline so the policy under test is a real one.
    targets.add({ ...targets.get("devin-sessions")!, data_policy: { allow: ["Knowledge/Projects"], deny_sources: ["comms", "devin"], max_brief_bytes: 16384 } });
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-${Date.now()}`,
      policy,
      secureCookies: false,
      targets,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `devin-${mintToken(6)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "devin-test" });
    session = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, "devin-test");
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  async function newTask(title: string): Promise<number> {
    // unique per run: `submitReport` suppresses a same-title report from the
    // same agent within 24h, and a verbose re-run reuses the scratch db
    const { rows } = await pool.query(`INSERT INTO work (title, kind, status, created_by) VALUES ($1, 'task', 'open', 'owner') RETURNING id`, [`${title} ${RUN}`]);
    return Number(rows[0].id);
  }
  const dispatchAs = (auth: Record<string, string>, id: number, body: Record<string, unknown>) =>
    fetch(`${base}/api/tasks/${id}/dispatch`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ target: "devin-sessions", ...body }) });
  const row = async (id: number) => (await pool.query(`SELECT status, external_ref, meta, closed_at, history FROM work WHERE id = $1`, [id])).rows[0];

  it("dispatch is the OWNER's action: a capture owner token is 403, an unknown bearer is 401", async () => {
    const id = await newTask("collaboration rule");
    expect((await dispatchAs({ authorization: `Bearer ${ownerToken}` }, id, { brief: "x" })).status).toBe(403);
    expect((await dispatchAs({ authorization: "Bearer not-a-real-token" }, id, { brief: "x" })).status).toBe(401);
    expect((await dispatchAs({}, id, { brief: "x" })).status).toBe(401);
    expect((await row(id)).external_ref).toBeNull();
    expect(devin.posts).toHaveLength(0);
  });

  it("an unknown purpose is refused rather than quietly dispatched as ordinary work", async () => {
    const id = await newTask("bad purpose");
    expect((await dispatchAs({ cookie: session }, id, { brief: "x", purpose: "exfiltrate" })).status).toBe(400);
    expect((await dispatchAs({ cookie: session }, id, { brief: "x", max_acu: 0 })).status).toBe(400);
    expect((await row(id)).external_ref).toBeNull();
  });

  it("a knowledge-research dispatch creates the session, binds devin:<id>, and freezes what the poller needs", async () => {
    const id = await newTask("what deploys the payments service");
    const res = await dispatchAs({ cookie: session }, id, { brief: "Answer from Knowledge/Projects/payments.md context.", purpose: "knowledge_research", max_acu: 3 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ref: string; url: string; run_id: number };
    expect(body.ref).toBe(`devin:devin-${RUN}-${devin.next - 1}`);

    const sent = devin.posts.at(-1)!;
    expect(String(sent.prompt)).toContain("**Knowledge research.**");
    expect(String(sent.prompt)).toContain("Answer from Knowledge/Projects/payments.md context.");
    expect(sent.max_acu_limit).toBe(3);
    expect(sent.structured_output_required).toBe(true);
    expect((sent.structured_output_schema as { $schema: string }).$schema).toContain("draft-07");
    expect(sent.tags).toEqual([`metistry:task:${id}`, "metistry:purpose:knowledge_research"]);

    const w = await row(id);
    expect(w.status).toBe("in_progress");
    expect(w.external_ref).toBe(body.ref);
    expect(w.meta.devin).toMatchObject({ org: "org-abc", max_acu: 3, purpose: "knowledge_research", target: "devin-sessions", dispatch_run_id: body.run_id });

    // still running: the poll records status and changes nothing else
    expect(await pollDevin(pool, pollCtx)).toBe(0);
    expect((await row(id)).status).toBe("in_progress");
    expect((await row(id)).meta.devin.status).toBe("running");

    // …and once it finishes, the structured answer becomes a report proposal
    const sessionId = body.ref.slice("devin:".length);
    devin.sessions.set(sessionId, {
      session_id: sessionId,
      url: `https://app.devin.ai/sessions/${sessionId}`,
      status: "exit",
      status_detail: "finished",
      acus_consumed: 2.5,
      structured_output: { answer: "The `release` workflow does.", sources: ["acme/api/.github/workflows/release.yml"], confidence: "high", open_questions: ["which region?"] },
    });
    expect(await pollDevin(pool, pollCtx)).toBe(1);

    const closed = await row(id);
    expect(closed.status).toBe("closed");
    expect(closed.closed_at).not.toBeNull();
    expect(closed.history.at(-1)).toMatchObject({ agent: "collector:devin-sessions", op: "update", status: "closed" });

    const { rows: props } = await pool.query(`SELECT kind, source_agent, trust, decision, payload FROM proposals WHERE payload->>'idempotency_key' = $1`, [`devin-session:${sessionId}`]);
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ kind: "report", source_agent: "devin", trust: "external", decision: "pending" });
    expect(props[0].payload.body).toContain("The `release` workflow does.");
    expect(props[0].payload.body).toContain("## Open questions\n- which region?");
    expect(props[0].payload.body).toContain("- ACUs used: 2.5 (cap 3)");
    expect(props[0].payload.refs).toContain(`task:${id}`);

    // the ACU cap went out on the dispatch runs row; the reported spend came back to it
    const { rows: runs } = await pool.query(`SELECT ok, tool, meta FROM runs WHERE id = $1`, [body.run_id]);
    expect(runs[0]).toMatchObject({ ok: true, tool: "devin-sessions" });
    expect(runs[0].meta).toMatchObject({ target: "devin-sessions", purpose: "knowledge_research", max_acu: 3, acus_consumed: 2.5, outcome: "answered" });

    // a second poll finds nothing: the row is no longer in_progress
    expect(await pollDevin(pool, pollCtx)).toBe(0);
  });

  it("a failed session reports the error and BLOCKS the row — never closes it as if answered", async () => {
    const id = await newTask("debug the flake");
    const res = await dispatchAs({ cookie: session }, id, { brief: "Find the flake." });
    const { ref } = (await res.json()) as { ref: string };
    const sessionId = ref.slice("devin:".length);
    devin.sessions.set(sessionId, { session_id: sessionId, url: `https://app.devin.ai/sessions/${sessionId}`, status: "suspended", status_detail: "out_of_credits", acus_consumed: 5 });
    expect(await pollDevin(pool, pollCtx)).toBe(1);

    const w = await row(id);
    expect(w.status).toBe("blocked");
    expect(w.closed_at).toBeNull();
    const { rows: props } = await pool.query(`SELECT payload FROM proposals WHERE payload->>'idempotency_key' = $1`, [`devin-session:${sessionId}:failed`]);
    expect(props).toHaveLength(1);
    expect(props[0].payload.body).toMatch(/suspended \(out_of_credits\)/);
    expect(props[0].payload.kind).toBe("progress");
  });

  it("a brief that cites outside the overlay's allow list never leaves, and the refusal is a runs row", async () => {
    const id = await newTask("policy refusal");
    const before = devin.posts.length;
    const res = await dispatchAs({ cookie: session }, id, { brief: "Summarize Knowledge/Journal/Daily/2026-09-15.md", purpose: "knowledge_research" });
    expect(res.status).toBe(400);
    expect((await res.json()).violations[0].kind).toBe("path_outside_allow");
    expect(devin.posts).toHaveLength(before);
    expect((await row(id)).external_ref).toBeNull();
    const { rows } = await pool.query(`SELECT ok, error, meta FROM runs WHERE kind = 'dispatch' AND tool = 'devin-sessions' AND ok = false ORDER BY id DESC LIMIT 1`);
    expect(rows[0].error).toMatch(/^data_policy: path_outside_allow$/);
    expect(rows[0].meta.violations[0].paths).toEqual(["Knowledge/Journal/Daily/2026-09-15.md"]);
  });

  it("GET /api/targets lists the target with its live check", async () => {
    const res = await fetch(`${base}/api/targets`, { headers: { cookie: session } });
    const { targets } = (await res.json()) as { targets: { name: string; transport: string; check: { status: string } }[] };
    const t = targets.find((x) => x.name === "devin-sessions")!;
    expect(t).toMatchObject({ transport: "http", check: { status: "ok" } });
  });
});
