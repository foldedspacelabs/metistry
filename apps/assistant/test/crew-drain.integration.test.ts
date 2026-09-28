// The crew queue against the real (scratch) db with a fake runner: a queued
// row is claimed, run with the crew's model/tools/turns and a token minted
// for THAT run (its hash is the crew's row while the run is live and dies
// after), recorded as a crew_run row on the crew's id, and closed; a second
// run gets a different token; failures retry with a backoff then park as
// blocked; a budget stop parks at once. Skipped without a db.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { mintToken, tokenHash } from "@foldedspacelabs/metistry-core";
import { emptyCompute, parseCompute, type ResolvedAssignment } from "@foldedspacelabs/metistry-core";
import { briefThreadBlock, claimCrewRow, drainCrewOne, issueRunToken } from "../src/crew-drain.js";
import { EngineHttpError } from "../src/engine-openai.js";
import { crewSystemPrompt, crewToolNames, type CrewRunInput, type CrewRunResult, type CrewSnapshot } from "../src/crew.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const crewId = `itest-runner-${suffix}`;

const snapshot: CrewSnapshot = {
  name: crewId,
  area: "itest",
  model: "sonnet",
  effort: "medium",
  uses: ["brain-read", "brain-report"],
  skills: [],
  scope: ["Projects"],
  projects: [],
  manages: [],
  max_turns: 5,
  budget_usd_per_run: 0.1,
  prompt: "You work for {{name}}.",
  sha256: "c".repeat(64),
};

// The crew's compute (C2): a crew runs on ITS OWN provider, and a crew
// nothing assigns has no engine at all. One local provider is enough — the
// runner is faked, so nothing dials it.
const computeFile = parseCompute(`
providers:
  testbench: { kind: openai-compatible, base_url: "http://127.0.0.1:1/v1", locality: on_machine }
assignments:
  default: { model: testbench/generalist }
  crews:
    ${crewId}: { model: testbench/sonnet, effort: medium }
`);

describe.skipIf(!hasDb)("crew drain (integration)", () => {
  let pool: pg.Pool;
  const cfg = { brainUrl: "http://console:8080/mcp", identity: { name: "Tester" }, leaseSeconds: 60, maxAttempts: 2, retryBackoffSeconds: 120, compute: () => computeFile };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    // the console's registration, minimally: a crew row whose hash is of a token nobody holds
    await pool.query(`INSERT INTO agents (id, display_name, kind, token_hash, grants, projects) VALUES ($1, 'itest crew', 'crew', $2, '{"tier":"areas","areas":["Projects"]}', '{}')`, [crewId, tokenHash(mintToken(32))]);
    // park other suites' crew rows so this suite drains only its own
    await pool.query(`UPDATE work SET status = 'closed' WHERE kind = 'task' AND owner LIKE 'crew:%' AND status <> 'closed' AND owner <> $1`, [`crew:${crewId}`]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM proposals WHERE source_agent = $1`, [crewId]);
    await pool.query(`DELETE FROM artifact_comments WHERE work_id IN (SELECT id FROM work WHERE owner = $1)`, [`crew:${crewId}`]);
    await pool.query(`DELETE FROM work WHERE owner = $1`, [`crew:${crewId}`]);
    await pool.query(`DELETE FROM runs WHERE component = $1`, [crewId]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [crewId]);
    await pool.end();
  });

  async function enqueue(brief: string, meta: Record<string, unknown> = {}, crew: unknown = snapshot): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO work (title, kind, status, owner, created_by, meta) VALUES ($1, 'task', 'open', $2, 'assistant', $3::jsonb) RETURNING id`,
      [`[crew:${crewId}] ${brief.slice(0, 40)}`, `crew:${crewId}`, JSON.stringify({ target: "local-crew", crew, brief, brief_sha: "d".repeat(64), dispatch_run_id: 1, allow: ["Projects"], ...meta })],
    );
    return Number(rows[0].id);
  }
  const hashOf = async () => (await pool.query(`SELECT token_hash FROM agents WHERE id = $1`, [crewId])).rows[0].token_hash as string;
  const workRow = async (id: number) => (await pool.query(`SELECT status, claimed_by, lease_expires_at, closed_at, meta, history FROM work WHERE id = $1`, [id])).rows[0];

  const ok: CrewRunResult = { outcome: "ok", session_id: "s1", num_turns: 4, tokens_in: 900, tokens_out: 120, cost_usd: 0.031, tools_used: { mcp__brain__knowledge_read: 2, mcp__brain__report: 1 }, text_chars: 50 };

  it("claims the row, runs with the crew's options and a token that authenticates ONLY during the run, records a crew_run row on the crew id, closes the row", async () => {
    const id = await enqueue("Summarize Projects/X.md", { task_id: 77 });
    const hashBefore = await hashOf();
    let seen: CrewRunInput | null = null;
    let assigned: ResolvedAssignment | null = null;
    let liveHashDuringRun = "";
    const run = async (input: CrewRunInput, assignment: ResolvedAssignment) => {
      seen = input;
      assigned = assignment;
      liveHashDuringRun = await hashOf();
      return ok;
    };
    expect(await drainCrewOne(pool, { ...cfg, runAssigned: run })).toBe(true);

    // the runner got the snapshot, the brief, the handle, the brain URL and a fresh bearer
    const s = seen!;
    expect(s.crew).toEqual(snapshot);
    expect(s.brief).toBe("Summarize Projects/X.md");
    expect(s.task_id).toBe(77);
    expect(s.brain.url).toBe("http://console:8080/mcp");
    expect(s.identity).toEqual({ name: "Tester" });
    // …and its OWN assignment (collaboration rule 3), not the assistant's default
    expect(assigned!).toMatchObject({ provider: "testbench", model: "sonnet", effort: "medium", from: `crew:${crewId}` });
    expect(crewSystemPrompt(s.crew, s.identity)).toMatch(/^You work for Tester\./);
    expect(crewToolNames(s.crew.uses)).toEqual([
      "mcp__brain__knowledge_search",
      "mcp__brain__knowledge_read",
      "mcp__brain__knowledge_list",
      "mcp__brain__knowledge_grep",
      "mcp__brain__requests_create",
    ]);

    // single-run credential: minted for this run (its hash IS the row while live), dead afterwards
    expect(liveHashDuringRun).toBe(tokenHash(s.brain.token));
    expect(liveHashDuringRun).not.toBe(hashBefore);
    expect(await hashOf()).not.toBe(tokenHash(s.brain.token));

    const row = await workRow(id);
    expect(row).toMatchObject({ status: "closed", claimed_by: null, lease_expires_at: null });
    expect(row.closed_at).not.toBeNull();
    expect(row.meta.attempts).toBe(1);
    expect(row.history.at(-1)).toMatchObject({ agent: `crew:${crewId}`, op: "update", status: "closed", note: expect.stringMatching(/^crew run #\d+: ok, 4 turns, 1 report, \$0\.0310$/) });

    const run_ = (await pool.query(`SELECT component, kind, model, ok, tokens_in, tokens_out, cost_usd::float8 AS cost_usd, meta, finished_at IS NOT NULL AS finished FROM runs WHERE component = $1 AND kind = 'crew_run' AND (meta->>'work_id')::bigint = $2`, [crewId, id])).rows[0];
    expect(run_).toMatchObject({ component: crewId, kind: "crew_run", model: "sonnet", ok: true, tokens_in: 900, tokens_out: 120, cost_usd: 0.031, finished: true });
    expect(run_.meta).toMatchObject({ work_id: id, brief_sha: "d".repeat(64), task_id: 77, attempt: 1, effort: "medium", fresh_session: true, crew_sha: "c".repeat(64), outcome: "ok", num_turns: 4, reports: 1, tools_used: ok.tools_used, uses: ["brain-read", "brain-report"] });
  });

  it("a New Routine's run: its read grant is bound to THIS run's bearer while it runs, and gone — stamp and bearer — after (T3-8)", async () => {
    const id = await enqueue("Summarise Areas/Finance since yesterday", { routine: { name: "vendor-sweep", run_id: 9001, grants: { read: ["Areas/Finance"] } } });
    const grantsBefore = (await pool.query(`SELECT grants FROM agents WHERE id = $1`, [crewId])).rows[0].grants;
    let stampDuringRun: unknown;
    let liveHash = "";
    let token = "";
    const run = async (input: CrewRunInput) => {
      token = input.brain.token;
      liveHash = await hashOf();
      stampDuringRun = (await workRow(id)).meta.run_bearer_sha256;
      return ok;
    };
    expect(await drainCrewOne(pool, { ...cfg, runAssigned: run })).toBe(true);

    // during the run: the row names exactly the live bearer
    expect(stampDuringRun).toBe(tokenHash(token));
    expect(stampDuringRun).toBe(liveHash);
    // after: the bearer is burnt and the stamp is gone, so no hash can match the grant again
    const after = await workRow(id);
    expect(after.status).toBe("closed");
    expect(after.meta).not.toHaveProperty("run_bearer_sha256");
    expect(after.meta.routine).toEqual({ name: "vendor-sweep", run_id: 9001, grants: { read: ["Areas/Finance"] } });
    expect(await hashOf()).not.toBe(tokenHash(token));
    // the crew's own registry row was never widened
    expect((await pool.query(`SELECT grants FROM agents WHERE id = $1`, [crewId])).rows[0].grants).toEqual(grantsBefore);
    // the run row says which routine this was and what its bearer read beyond the crew's scope
    const run_ = (await pool.query(`SELECT meta FROM runs WHERE component = $1 AND kind = 'crew_run' AND (meta->>'work_id')::bigint = $2`, [crewId, id])).rows[0];
    expect(run_.meta).toMatchObject({ routine: "vendor-sweep", routine_run_id: 9001, run_grants: { read: ["Areas/Finance"] } });
  });

  it("defer and report (C59): a New Routine's run is unattended, and the Ask First calls it deferred end up in its run row and its note — read from the rows, scoped to this run", async () => {
    const id = await enqueue("Comment on the flaky issues", { routine: { name: "flake-sweep", run_id: 9101, grants: { read: [] } } });
    let seen: CrewRunInput | null = null;
    const deferRow = async (component: string, turnId: string, extra: Record<string, unknown> = {}) =>
      pool.query(`INSERT INTO runs (component, kind, tool, ok, started_at, finished_at, meta) VALUES ($1, 'connection_call', 'connections_call', true, now(), now(), $2)`, [
        component,
        JSON.stringify({ connection: "github", connection_tool: "comment_issue", mode: "ask", outcome: "deferred", proposal_id: 4242, turn_id: turnId, unattended: true, ...extra }),
      ]);
    const run = async (input: CrewRunInput) => {
      seen = input;
      // what the bridge writes when this run's Ask First call is deferred…
      await deferRow(crewId, input.turn_id!);
      // …and what must NOT reach this run's report: another caller claiming this turn, a paused call, another turn
      await deferRow(`${crewId}-other`, input.turn_id!);
      await deferRow(crewId, input.turn_id!, { outcome: undefined, connection_tool: "create_issue" });
      await deferRow(crewId, "another-turn", { connection_tool: "run_workflow" });
      return ok;
    };
    expect(await drainCrewOne(pool, { ...cfg, runAssigned: run })).toBe(true);
    expect(seen!.interactive).toBe(false);
    expect(seen!.turn_id).toMatch(/^[0-9a-f-]{36}$/);

    const row = await workRow(id);
    expect(row.status).toBe("closed"); // a deferred step does not make the run fail
    expect(row.history.at(-1).note).toMatch(/, skipped 1 waiting for approval in Needs You \(comment_issue on github #4242\)$/);
    const r = (await pool.query(`SELECT meta FROM runs WHERE component = $1 AND kind = 'crew_run' AND (meta->>'work_id')::bigint = $2`, [crewId, id])).rows[0];
    expect(r.meta).toMatchObject({ unattended: true, turn_id: seen!.turn_id, skipped_count: 1, skipped: [{ connection: "github", tool: "comment_issue", proposal_id: 4242 }] });
  });

  it("a crew the assistant delegated to pauses rather than defers: interactive, and nothing to report", async () => {
    const id = await enqueue("delegated in a conversation");
    let seen: CrewRunInput | null = null;
    expect(await drainCrewOne(pool, { ...cfg, runAssigned: async (input) => { seen = input; return ok; } })).toBe(true);
    expect(seen!.interactive).toBe(true);
    const r = (await pool.query(`SELECT meta FROM runs WHERE component = $1 AND kind = 'crew_run' AND (meta->>'work_id')::bigint = $2`, [crewId, id])).rows[0];
    expect(r.meta.unattended).toBeUndefined();
    expect(r.meta.skipped).toBeUndefined();
    expect(r.meta.turn_id).toBe(seen!.turn_id);
  });

  it("a routine run that fails still leaves no stamp behind; a dispatched (non-routine) row is never stamped", async () => {
    const failing = await enqueue("routine that throws", { routine: { name: "vendor-sweep", run_id: 9002, grants: { read: ["Areas/Finance"] } } });
    await drainCrewOne(pool, { ...cfg, maxAttempts: 1, runAssigned: async () => { throw new Error("engine fell over"); } });
    expect((await workRow(failing)).meta).not.toHaveProperty("run_bearer_sha256");

    const plain = await enqueue("dispatched, not a routine");
    let stamp: unknown = "unset";
    await drainCrewOne(pool, { ...cfg, runAssigned: async () => { stamp = (await workRow(plain)).meta.run_bearer_sha256; return ok; } });
    expect(stamp).toBeUndefined();
  });

  it("a second run gets a different token, and the first one's hash is nowhere", async () => {
    const tokens: string[] = [];
    const run = async (input: CrewRunInput) => {
      tokens.push(input.brain.token);
      return ok;
    };
    await enqueue("run two");
    await drainCrewOne(pool, { ...cfg, runAssigned: run });
    await enqueue("run three");
    await drainCrewOne(pool, { ...cfg, runAssigned: run });
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    const current = await hashOf();
    expect(current).not.toBe(tokenHash(tokens[0]!));
    expect(current).not.toBe(tokenHash(tokens[1]!));
    // the console's authenticateAgent is a hash lookup on this column: neither token authenticates now
    expect((await pool.query(`SELECT id FROM agents WHERE token_hash = ANY($1::text[]) AND revoked_at IS NULL`, [tokens.map(tokenHash)])).rows).toEqual([]);
  });

  it("an infrastructure failure retries after the backoff (claim kept, lease = backoff), then parks as blocked at the attempt cap; the token is burned each time", async () => {
    const id = await enqueue("flaky");
    const boom = async () => {
      throw new Error("sdk exploded");
    };
    expect(await drainCrewOne(pool, { ...cfg, runAssigned: boom })).toBe(true);
    let row = await workRow(id);
    expect(row).toMatchObject({ status: "in_progress", claimed_by: `crew:${crewId}` });
    expect(row.meta.attempts).toBe(1);
    expect(new Date(row.lease_expires_at).getTime()).toBeGreaterThan(Date.now() + 100_000); // ~120s backoff
    expect(row.history.at(-1).note).toMatch(/attempt 1 failed \(sdk exploded\); retry after 120s/);
    // not re-picked while the lease/backoff holds
    expect(await claimCrewRow(pool, 60, 2)).toBeNull();
    // lapse it by hand: the next pass retries, hits the cap, parks
    await pool.query(`UPDATE work SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await drainCrewOne(pool, { ...cfg, runAssigned: boom })).toBe(true);
    row = await workRow(id);
    expect(row).toMatchObject({ status: "blocked" });
    expect(row.meta.attempts).toBe(2);
    expect(row.history.at(-1).note).toMatch(/failed 2× — last: sdk exploded/);
    const runs = await pool.query(`SELECT ok, error, meta->>'attempt' AS attempt FROM runs WHERE component = $1 AND kind = 'crew_run' AND (meta->>'work_id')::bigint = $2 ORDER BY id`, [crewId, id]);
    expect(runs.rows).toEqual([{ ok: false, error: "sdk exploded", attempt: "1" }, { ok: false, error: "sdk exploded", attempt: "2" }]);
    expect(await claimCrewRow(pool, 60, 2)).toBeNull(); // blocked rows are never re-picked
  });

  it("a budget or turn stop is final: the run is recorded ok=false with the outcome, the row parks as blocked, nothing retries", async () => {
    const id = await enqueue("expensive");
    const stopped: CrewRunResult = { ...ok, outcome: "max_budget", num_turns: 5, cost_usd: 0.11, errors: ["budget exceeded"] };
    await drainCrewOne(pool, { ...cfg, runAssigned: async () => stopped });
    const row = await workRow(id);
    expect(row.status).toBe("blocked");
    expect(row.history.at(-1).note).toMatch(/max_budget, 5 turns, 1 report, \$0\.1100 — budget exceeded/);
    const r = (await pool.query(`SELECT ok, error, meta->>'outcome' AS outcome FROM runs WHERE component = $1 AND kind = 'crew_run' AND (meta->>'work_id')::bigint = $2`, [crewId, id])).rows[0];
    expect(r).toEqual({ ok: false, error: "crew run max_budget: budget exceeded", outcome: "max_budget" });
  });

  it("a provider refusing the account (402) is final too: parked as blocked on the first attempt, never retried", async () => {
    const id = await enqueue("no credits");
    const refused = async () => {
      throw new EngineHttpError(402, JSON.stringify({ error: { message: "This request requires more credits" } }), "https://openrouter.ai/api/v1/chat/completions");
    };
    expect(await drainCrewOne(pool, { ...cfg, runAssigned: refused })).toBe(true);
    const row = await workRow(id);
    expect(row.status).toBe("blocked");
    expect(row.meta.attempts).toBe(1);
    expect(row.history.at(-1).note).toMatch(/returned 402/);
  });

  // --- the prior-work block (0016; "the brief is the context transfer") ---------

  it("a room on the claimed row rides along in the brief, newest messages kept under the byte budget, and the run records exactly which ones", async () => {
    const id = await enqueue("Summarize the room");
    const say = async (n: number, kind: "human" | "agent", who: string, body: string, parent: string | null) => {
      const cid = `cmt_${String(n).padStart(6, "0")}${"0".repeat(20)}`;
      await pool.query(
        `INSERT INTO artifact_comments (id, work_id, body, author_principal, author_kind, parent_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, now() + ($7::int * interval '1 second'))`,
        [cid, id, body, who, kind, parent, n],
      );
      return cid;
    };
    const root = await say(1, "human", "user", "does this include the migration?", null);
    const second = await say(2, "agent", "helper-a", "it does — I will take the schema", root);
    const third = await say(3, "agent", "helper-b", "then I take the console side", root);

    let seen: CrewRunInput | null = null;
    await drainCrewOne(pool, { ...cfg, briefThreadBytes: 4096, runAssigned: async (input) => { seen = input; return ok; } });
    const brief = seen!.brief;
    expect(brief.startsWith("Summarize the room")).toBe(true); // the dispatched brief is untouched; the block is appended
    expect(brief).toContain(`--- prior work on #${id}`);
    expect(brief.indexOf("does this include the migration?")).toBeLessThan(brief.indexOf("then I take the console side")); // oldest first
    expect(brief).toContain("agent helper-a:");
    expect(brief).toContain("--- end prior work ---");

    const run = (await pool.query(`SELECT meta FROM runs WHERE component = $1 AND kind = 'crew_run' AND (meta->>'work_id')::bigint = $2`, [crewId, id])).rows[0];
    expect(run.meta).toMatchObject({ thread_room: id, thread_comments: [root, second, third] });
    expect(run.meta.thread_bytes).toBeLessThanOrEqual(4096);
    expect(run.meta.brief_sha).toBe("d".repeat(64)); // still the sha of what policy checked
  });

  it("the budget clips the block to the LAST messages, 0 turns it off, and the dispatch's max_brief_bytes clips it again", async () => {
    const id = (await pool.query(`SELECT id FROM work WHERE owner = $1 AND title LIKE $2 ORDER BY id DESC LIMIT 1`, [`crew:${crewId}`, "%Summarize the room%"])).rows[0].id;
    const tiny = await briefThreadBlock(pool, Number(id), 220);
    expect(tiny!.comment_ids).toHaveLength(1);
    expect(tiny!.text).toContain("then I take the console side"); // the newest survives, not the oldest
    expect(await briefThreadBlock(pool, Number(id), 0)).toBeNull();
    expect(await briefThreadBlock(pool, 999_999_999, 4096)).toBeNull(); // no room, no block

    // a row whose dispatch allowed almost nothing gets no block, however big the env budget is
    const capped = await enqueue("x".repeat(100), { max_brief_bytes: 120 });
    await pool.query(`INSERT INTO artifact_comments (id, work_id, body, author_principal, author_kind) VALUES ($1, $2, 'a long thing to say', 'helper-a', 'agent')`, [
      `cmt_${"7".repeat(26)}`,
      capped,
    ]);
    let briefSeen = "";
    await drainCrewOne(pool, { ...cfg, briefThreadBytes: 4096, runAssigned: async (input) => { briefSeen = input.brief; return ok; } });
    expect(briefSeen).toBe("x".repeat(100)); // nothing appended: no headroom under the size checkBrief allowed
  });

  it("whatever the crew raised while it held the row is stamped with that work id — server-side, after the fact, never a tool argument", async () => {
    const id = await enqueue("raise something");
    await drainCrewOne(pool, {
      ...cfg,
      runAssigned: async () => {
        // the crew's own requests_create, as mcp-brain would write it: no work id anywhere in the call
        await pool.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('report', $1, 'external', $2::jsonb)`, [
          crewId,
          JSON.stringify({ title: "found a thing", body: "…" }),
        ]);
        return ok;
      },
    });
    const { rows } = await pool.query(`SELECT work_id, payload->>'title' AS title FROM proposals WHERE source_agent = $1 ORDER BY id DESC LIMIT 1`, [crewId]);
    expect(rows[0]).toEqual({ work_id: String(id), title: "found a thing" });
  });

  // T4-6 (C128): the definition names the model. A pinned reference runs as
  // written — over assignments.crews — with the crew's own effort; `same_as_
  // assistant` runs the default tier, model AND effort; a pinned reference to
  // a provider compute.yaml does not declare parks, never runs elsewhere.
  it("a crew's own `model:` decides what it runs on: pinned, same_as_assistant, or a provider that does not exist (parked)", async () => {
    const seen: ResolvedAssignment[] = [];
    const run = async (_input: CrewRunInput, assignment: ResolvedAssignment) => {
      seen.push(assignment);
      return ok;
    };
    const pinned = await enqueue("pinned", {}, { ...snapshot, model: "testbench/pinned-model", effort: "high" });
    await drainCrewOne(pool, { ...cfg, runAssigned: run });
    expect((await workRow(pinned)).status).toBe("closed");
    const same = await enqueue("same", {}, { ...snapshot, model: "same_as_assistant", effort: "high" });
    await drainCrewOne(pool, { ...cfg, runAssigned: run });
    expect((await workRow(same)).status).toBe("closed");
    expect(seen.map((a) => [a.ref, a.effort, a.from])).toEqual([
      ["testbench/pinned-model", "high", `crew:${crewId}`], // not assignments.crews' testbench/sonnet
      ["testbench/generalist", "medium", "default"], // the default tier's pair: its effort (the schema default), not the crew's high
    ]);
    const nowhere = await enqueue("nowhere", {}, { ...snapshot, model: "elsewhere/some-model" });
    await drainCrewOne(pool, { ...cfg, runAssigned: run });
    const parked = await workRow(nowhere);
    expect(parked.status).toBe("blocked");
    expect(parked.history.at(-1).note).toMatch(/runs on elsewhere\/some-model, but compute.yaml declares no provider 'elsewhere'/);
    expect(seen).toHaveLength(2); // nothing ran for it
  });

  it("a crew compute.yaml assigns nothing to parks as blocked naming the line to write — no engine, so no run (C2/C3)", async () => {
    const id = await enqueue("unassigned");
    const calls: string[] = [];
    const run = async (input: CrewRunInput) => {
      calls.push(input.crew.name);
      return ok;
    };
    expect(await drainCrewOne(pool, { ...cfg, compute: () => emptyCompute(), runAssigned: run })).toBe(true);
    const row = await workRow(id);
    expect(row.status).toBe("blocked");
    expect(row.history.at(-1).note).toMatch(new RegExp(`has no compute:.*assignments\\.crews\\.${crewId}.*assignments\\.default`));
    expect(row.history.at(-1).note).toContain(`metistry compute assign crew:${crewId} <provider/model>`);
    expect(calls).toEqual([]); // nothing ran, and no token was minted for it
  });

  it("a row the runner cannot honour parks with the reason and never mints: no snapshot, a write tool in the snapshot, a revoked crew, no brain URL", async () => {
    const calls: string[] = [];
    const run = async (input: CrewRunInput) => {
      calls.push(input.crew.name);
      return ok;
    };
    const noSnap = await enqueue("no snapshot", {}, null);
    await drainCrewOne(pool, { ...cfg, runAssigned: run });
    expect((await workRow(noSnap)).history.at(-1).note).toMatch(/crew run refused: crew snapshot missing/);
    const writer = await enqueue("writer", {}, { ...snapshot, uses: ["knowledge_write"] });
    await drainCrewOne(pool, { ...cfg, runAssigned: run });
    expect((await workRow(writer)).history.at(-1).note).toMatch(/never available to a crew/);
    const noBrain = await enqueue("no brain");
    await drainCrewOne(pool, { ...cfg, brainUrl: undefined, runAssigned: run });
    expect((await workRow(noBrain)).history.at(-1).note).toMatch(/METISTRY_BRAIN_URL is unset/);
    await pool.query(`UPDATE agents SET revoked_at = now() WHERE id = $1`, [crewId]);
    const hashBefore = await hashOf();
    const revoked = await enqueue("revoked crew");
    await drainCrewOne(pool, { ...cfg, runAssigned: run });
    expect((await workRow(revoked)).history.at(-1).note).toMatch(/not registered or is revoked/);
    expect(await issueRunToken(pool, crewId)).toBeNull();
    expect(await hashOf()).toBe(hashBefore); // a revoked row is never re-keyed
    expect(calls).toEqual([]);
    expect(await drainCrewOne(pool, { ...cfg, runAssigned: run })).toBe(false); // queue empty
  });
});
