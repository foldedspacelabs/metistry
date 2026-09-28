// Agent routines (T3-8, design-build-plan §2.5): a New Routine — an actor, a
// task and per-run READ grants in `.metistry/scheduled.yaml`, no code — runs
// as ONE crew run. Against the scratch database:
//
//   * the runner schedules it like any routine and its run enqueues exactly
//     one crew row: the crew's definition, the task as the brief (appended,
//     never replacing it), and the run's grant on the row — never on the
//     crew's own registry row;
//   * **a per-run grant is gone after the run; outside it the actor cannot
//     read the area** — the console's door (`authenticateAgent`) honours the
//     row's grant only for the bearer the drain stamped on it, only while the
//     row is running; before, after, for the next run's bearer and for any
//     other crew it holds nothing extra, and it never admits a write;
//   * an actor that is not a crew this console loaded is a failed run naming
//     the fix, and enqueues nothing;
//   * the actor's permission lines draw the grant *while this routine runs*.
//
// The drain's half — stamping the bearer at mint and removing the stamp after
// the burn — is held by apps/assistant/test/crew-drain.integration.test.ts;
// here the drain's two statements are replayed by hand around the door.
// Skipped without a db.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { may, mintToken, tokenHash, type Principal } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import type { AgentPrincipal } from "@foldedspacelabs/metistry-mcp-brain";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { crewRoutineQueue, parseCrewFile, type CrewDefinition, type CrewRegistry } from "../src/crews.js";
import { agentRoutineComponents, overlayFromText, runNow, tick, ASSIGNMENT_HOME } from "../src/runner.js";
import * as agents from "../src/agents.js";
import * as actors from "../src/actors.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const CREW = `itest-rtn-${suffix}`;
const OTHER = `itest-rtn2-${suffix}`;
const ROUTINE = `vendor-sweep-${suffix}`;
const STRANGER = `stranger-sweep-${suffix}`;
const NOW = new Date("2026-09-28T13:05:00Z");

function crewFile(name: string): CrewDefinition {
  return parseCrewFile(
    `---
name: ${name}
type: agent
model: testbench/generalist
effort: low
uses: [knowledge, requests]
skills: []
scope: [Projects]
projects: []
manages: []
max_turns: 5
budget_usd_per_run: 0.1
---

You sweep vendor notes for {{name}}.
`,
    `agents/itest/${name}.md`,
    { name, area: "itest" },
  );
}

/** A crew bearer's principal as `/mcp` decides on it (mcp-brain's `principalOf`, for a crew — not exported by the package). */
function crewPrincipal(p: AgentPrincipal): Principal {
  expect(p.kind).toBe("crew");
  return {
    id: p.id,
    role: "crew",
    scope: { tier: p.grants.tier, areas: [...p.grants.areas], queries: p.grants.queries === true, projects: [...p.projects], autonomy: p.autonomy },
    source: "registry",
    uses: [...(p.uses ?? [])],
  };
}

const overlay = (extra = "") =>
  overlayFromText(`routines:
  ${ROUTINE}:
    actor: ${CREW}
    task: "Summarise everything added to Areas/Finance since yesterday."
    grants: { read: [Areas/Finance/] }
    schedule: { every: 1h }
${extra}`);

describe.skipIf(!hasDb)("agent routines (integration)", () => {
  let pool: pg.Pool;
  const defs = new Map<string, CrewDefinition>([
    [CREW, crewFile(CREW)],
    [OTHER, crewFile(OTHER)],
  ]);
  // the console's CrewRegistry, as much of it as the runner and the actor sources read
  const registry = {
    get: (id: string) => defs.get(id),
    actorSource: (id: string) => {
      const d = defs.get(id);
      return d ? { manifest: d.manifest, prompt: d.prompt, file: { path: d.where, origin: "instance" as const, sha256: d.sha256 } } : undefined;
    },
    toolset: (id: string) => (defs.has(id) ? { uses: defs.get(id)!.manifest.uses } : undefined),
  };

  const auth = (token: string) => agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${token}` } }, (id) => registry.toolset(id));
  const principal = async (token: string): Promise<Principal | null> => {
    const p = await auth(token);
    return p ? crewPrincipal(p) : null;
  };
  const canRead = (p: Principal | null, path: string) => p !== null && may(p, "read", { kind: "knowledge", door: "read", path }).ok;
  const canWrite = (p: Principal | null, path: string) => p !== null && may(p, "write", { kind: "knowledge", door: "write", path }).ok;
  /** The drain's mint: the crew's row takes the hash of a token only this run holds. */
  const mint = async (crew: string): Promise<string> => {
    const t = mintToken(32);
    await pool.query(`UPDATE agents SET token_hash = $2 WHERE id = $1`, [crew, tokenHash(t)]);
    return t;
  };
  const crewRows = async (crew: string) => (await pool.query(`SELECT id, status, title, meta, created_by FROM work WHERE owner = $1 ORDER BY id`, [`crew:${crew}`])).rows;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    for (const id of [CREW, OTHER]) {
      await pool.query(`INSERT INTO agents (id, display_name, kind, token_hash, grants, projects, grant_source) VALUES ($1, $1, 'crew', $2, '{"tier":"areas","areas":["Projects"]}', '{}', 'manifest')`, [
        id,
        tokenHash(mintToken(32)),
      ]);
    }
  });

  afterAll(async () => {
    const owners = [`crew:${CREW}`, `crew:${OTHER}`];
    // the runner's own task_op rows for the rows this suite enqueued — never another suite's runner rows
    await pool.query(`DELETE FROM runs WHERE component = 'runner' AND kind = 'task_op' AND (meta->>'id')::bigint IN (SELECT id FROM work WHERE owner = ANY($1))`, [owners]);
    await pool.query(`DELETE FROM work WHERE owner = ANY($1)`, [owners]);
    await pool.query(`DELETE FROM runs WHERE component = ANY($1)`, [[ROUTINE, STRANGER, CREW, OTHER]]);
    await pool.query(`DELETE FROM outbound_messages WHERE kind = 'alert' AND (position($1 in text) > 0 OR position($2 in text) > 0)`, [ROUTINE, STRANGER]);
    await pool.query(`DELETE FROM agents WHERE id = ANY($1)`, [[CREW, OTHER]]);
    await pool.end();
  });

  const queue = () => crewRoutineQueue(new TasksService(pool), registry as unknown as CrewRegistry);

  it("the runner schedules a New Routine like any routine, and its run enqueues ONE crew run: definition kept, task appended as the brief, the grant on the row", async () => {
    const opts = { env: {}, scheduled: async () => overlay(), agentRoutines: queue(), requests: null, now: NOW, startedAt: new Date(NOW.getTime() - 3_600_000) };
    await tick(pool, [], {}, opts);
    const rows = await crewRows(CREW);
    expect(rows).toHaveLength(1);
    const [w] = rows;
    expect(w.status).toBe("open");
    expect(w.created_by).toBe("runner");
    expect(w.title).toBe(`[routine:${ROUTINE}] Summarise everything added to Areas/Finance since yesterday.`);
    // the crew's own definition is the system prompt; the task is the brief — appended, never replacing it
    expect(w.meta.crew.prompt).toBe(defs.get(CREW)!.prompt);
    expect(w.meta.crew.name).toBe(CREW);
    expect(w.meta.brief).toBe("Summarise everything added to Areas/Finance since yesterday.");
    // the run's grant: read-only, one spelling per prefix, on the ROW
    const run = (await pool.query(`SELECT id, kind, ok, meta FROM runs WHERE component = $1 ORDER BY id`, [ROUTINE])).rows;
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({ kind: "routine_run", ok: true, meta: { outcome: "acted", processed: 1 } });
    expect(w.meta.routine).toEqual({ name: ROUTINE, run_id: Number(run[0].id), grants: { read: ["Areas/Finance"] } });
    expect(w.meta.dispatch_run_id).toBe(Number(run[0].id));
    // …and never on the crew's registry row
    expect((await pool.query(`SELECT grants FROM agents WHERE id = $1`, [CREW])).rows[0].grants).toEqual({ tier: "areas", areas: ["Projects"] });

    // not due again within the hour: the same tick a minute later enqueues nothing
    await tick(pool, [], {}, { ...opts, now: new Date(NOW.getTime() + 60_000) });
    expect(await crewRows(CREW)).toHaveLength(1);
    // paused: nothing, and no row a tick
    await tick(pool, [], {}, { ...opts, scheduled: async () => overlayFromText(`routines:\n  ${ROUTINE}:\n    actor: ${CREW}\n    task: go\n    paused: true\n    schedule: { every: 5m }\n`), now: new Date(NOW.getTime() + 2 * 3_600_000) });
    expect(await crewRows(CREW)).toHaveLength(1);
    // no crew queue wired: a New Routine is listed and not run
    expect(agentRoutineComponents(overlay(), [], undefined)).toEqual([]);
    expect(agentRoutineComponents(overlay(), [], queue()).map((c) => [c.name, c.dir, c.unit?.displayName])).toEqual([[ROUTINE, ASSIGNMENT_HOME, `Vendor Sweep ${suffix[0]!.toUpperCase()}${suffix.slice(1)}`]]);
  });

  it("**a per-run grant is gone after the run; outside it the actor cannot read the area**", async () => {
    const FINANCE = "Areas/Finance/q3-vendors.md";
    // outside any run: the crew holds its own scope and nothing else
    const idle = await mint(CREW);
    expect(canRead(await principal(idle), "Projects/x.md")).toBe(true);
    expect(canRead(await principal(idle), FINANCE)).toBe(false);

    // the routine's row is queued but not running: still nothing
    const [w] = await crewRows(CREW);
    expect(w.meta.routine.grants.read).toEqual(["Areas/Finance"]);
    expect(canRead(await principal(idle), FINANCE)).toBe(false);

    // the drain claims it, mints THIS run's bearer and stamps it on the row
    await pool.query(`UPDATE work SET status = 'in_progress', claimed_by = owner WHERE id = $1`, [w.id]);
    const run = await mint(CREW);
    expect(canRead(await principal(idle), FINANCE)).toBe(false); // the previous bearer is dead
    expect(canRead(await principal(run), FINANCE)).toBe(false); // minted, not yet bound to the row
    await pool.query(`UPDATE work SET meta = jsonb_set(meta, '{run_bearer_sha256}', to_jsonb($2::text)) WHERE id = $1`, [w.id, tokenHash(run)]);

    // DURING the run: this bearer reads the granted area — and only reads it
    const during = await principal(run);
    expect(canRead(during, FINANCE)).toBe(true);
    expect(canRead(during, "Areas/Finance")).toBe(true);
    expect(canRead(during, "Projects/x.md")).toBe(true); // its own scope still holds
    expect(canRead(during, "Areas/Ops/x.md")).toBe(false); // nothing it was not granted
    expect(canRead(during, "Me/profile.md")).toBe(false);
    expect(canWrite(during, FINANCE)).toBe(false); // per-run grants are read-only
    expect(canWrite(during, "Journal/Digest/2026-09-28.md")).toBe(false);
    // another crew's bearer holds nothing through this row
    const other = await mint(OTHER);
    expect(canRead(await principal(other), FINANCE)).toBe(false);
    // the registry row — what every panel draws as the base — was never widened
    expect((await pool.query(`SELECT grants FROM agents WHERE id = $1`, [CREW])).rows[0].grants).toEqual({ tier: "areas", areas: ["Projects"] });

    // a stale stamp on a row that is no longer running grants nothing, even to a live matching bearer
    await pool.query(`UPDATE work SET status = 'blocked' WHERE id = $1`, [w.id]);
    expect(canRead(await principal(run), FINANCE)).toBe(false);
    await pool.query(`UPDATE work SET status = 'in_progress' WHERE id = $1`, [w.id]);
    expect(canRead(await principal(run), FINANCE)).toBe(true);

    // AFTER the run: the drain burns the bearer, removes the stamp and closes the row
    await pool.query(`UPDATE agents SET token_hash = $2 WHERE id = $1`, [CREW, tokenHash(mintToken(32))]);
    await pool.query(`UPDATE work SET status = 'closed', claimed_by = NULL, meta = meta - 'run_bearer_sha256' WHERE id = $1`, [w.id]);
    expect(await auth(run)).toBeNull(); // the run's bearer authenticates nothing
    // the crew's next run — a dispatched one, no routine — holds its own scope and nothing of the routine's
    const { rows: next } = await pool.query(
      `INSERT INTO work (title, kind, status, owner, created_by, meta) VALUES ('[crew] next', 'task', 'in_progress', $1, 'assistant', '{"brief":"next"}'::jsonb) RETURNING id`,
      [`crew:${CREW}`],
    );
    const nextRun = await mint(CREW);
    await pool.query(`UPDATE work SET meta = jsonb_set(meta, '{run_bearer_sha256}', to_jsonb($2::text)) WHERE id = $1`, [next[0].id, tokenHash(nextRun)]);
    expect(canRead(await principal(nextRun), FINANCE)).toBe(false);
    expect(canRead(await principal(nextRun), "Projects/x.md")).toBe(true);
    await pool.query(`UPDATE work SET status = 'closed' WHERE id = $1`, [next[0].id]);
  });

  it("a row written by another hand cannot carry the machinery into a scope — only agent-grantable prefixes are honoured", async () => {
    const { rows } = await pool.query(
      `INSERT INTO work (title, kind, status, owner, created_by, meta) VALUES ('[routine] forged', 'task', 'in_progress', $1, 'owner', $2::jsonb) RETURNING id`,
      [`crew:${OTHER}`, JSON.stringify({ routine: { name: "forged", run_id: 1, grants: { read: [".metistry", "Artifacts/Reports", "Areas/../Me", "Areas/Ops"] } } })],
    );
    const t = await mint(OTHER);
    await pool.query(`UPDATE work SET meta = jsonb_set(meta, '{run_bearer_sha256}', to_jsonb($2::text)) WHERE id = $1`, [rows[0].id, tokenHash(t)]);
    const p = await auth(t);
    expect(p?.grants).toEqual({ tier: "areas", areas: ["Projects", "Areas/Ops"] });
    await pool.query(`UPDATE work SET status = 'closed' WHERE id = $1`, [rows[0].id]);
  });

  it("an actor that is not a crew this console loaded is a failed run naming the fix — and nothing is enqueued", async () => {
    const text = overlayFromText(`routines:\n  ${STRANGER}:\n    actor: not-a-crew\n    task: go\n    schedule: { every: 1h }\n`);
    const r = await runNow(pool, [], STRANGER, {}, { env: {}, scheduled: async () => text, agentRoutines: queue(), requests: null, now: NOW });
    expect(r.started).toBe(true);
    if (r.started) await r.done;
    const run = (await pool.query(`SELECT ok, error, meta FROM runs WHERE component = $1 AND kind = 'routine_run' ORDER BY id DESC LIMIT 1`, [STRANGER])).rows[0];
    expect(run.ok).toBe(false);
    expect(run.error).toMatch(/not-a-crew is not a crew this console has loaded .* change its actor in Scheduled/);
    expect((await pool.query(`SELECT count(*)::int AS n FROM work WHERE owner = 'crew:not-a-crew'`)).rows[0].n).toBe(0);
    // Run Now finds a New Routine only where a crew queue is wired
    expect(await runNow(pool, [], STRANGER, {}, { env: {}, scheduled: async () => text, requests: null, now: NOW })).toMatchObject({ started: false, reason: "not_found" });
  });

  it("the actor's permission lines draw the routine's grant as held while this routine runs — never in the base", async () => {
    const rows = (await agents.listAgents(pool)).filter((a) => a.id === CREW);
    const file = overlay();
    if (!file.ok) throw new Error("overlay");
    const { routineGrantsFor } = await import("@foldedspacelabs/metistry-core");
    const sources = await actors.consoleActorSources(pool, {
      rows,
      crews: registry as unknown as CrewRegistry,
      assistant: { identity: undefined, files: [] },
      routineGrants: (id) => routineGrantsFor(file.value, [], id),
    });
    const knowledge = actors.permissionLines(CREW, sources).find((l) => l.resource.kind === "knowledge")!;
    expect(knowledge.read.map((e) => [e.key, e.provenance])).toEqual([
      ["Projects", { kind: "base", source: { manifest: expect.any(String) } }],
      ["Areas/Finance", { kind: "routine", routine: ROUTINE }],
    ]);
    expect(knowledge.write).toEqual([]);
  });
});
