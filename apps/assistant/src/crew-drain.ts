// The crew queue (Phase 5 crews): `work` rows of kind `task` whose owner is
// `crew:<name>`, written by the console's agents_delegate after the brief
// passed policy. Durable and restart-safe by construction — the same
// claim/lease shape the tasks module uses, so a run that dies with the
// container is re-picked when its lease lapses, and a run that keeps
// failing parks as `blocked` (visible on the list) instead of looping.
//
// Credentials: the crew's `agents` row holds the hash of a token nobody has.
// Each run MINTS a fresh one (rotate), hands it to the SDK query for that
// run only, and BURNS it in `finally` (rotate again, discard) — a crew never
// keeps a bearer, and two runs never share one. The same SQL the console's
// rotateAgent uses; the plaintext never touches a log or a row.
//
// Sessions: a crew run NEVER resumes one (cost research decision 3 — a fresh
// session per crew run). Nothing here reads or writes the `sessions` table and
// `buildCrewOptions` has no `resume` to set, so this is a property of the code
// rather than a rule anyone has to remember; the run row says `fresh_session`
// so the fact is visible where cost is read.
//
// Every run is a two-phase `runs` row on the CREW's id (component = crew
// name, kind = crew_run) — the dashboard's "runs by component" is where a
// crew is watched — carrying cost, tokens, tools used, the brief's sha and
// the related task. The crew's own tool calls are their own rows (mcp-brain,
// kind = tool) on the same component.

import { createHash } from "node:crypto";
import { emptyCompute, finishRun, mintToken, sanitizeForAgent, startRun, tokenHash, type Compute, type ResolvedAssignment, type TierMap } from "@foldedspacelabs/metistry-core";
import { crewSystemPrompt, crewToolNames, parseCrewSnapshot, runCrew, runCrewOnEngine, type CrewRunInput, type CrewRunResult, type CrewSdk } from "./crew.js";
import { makeEngine, type Engine, type TurnGuard } from "./engine.js";
import { memorySessionStore } from "./sessions.js";
import { mcpToolHost } from "./tools.js";
import { resolveTurn } from "./tiers.js";
import { isBudgetRefusal } from "./budgets.js";
import type { Identity } from "./prompt.js";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export const CREW_OWNER_PREFIX = "crew:";

export interface CrewDrainConfig {
  /** The console's /mcp (METISTRY_BRAIN_URL). Absent → every crew row parks as blocked with the reason. */
  brainUrl?: string | undefined;
  identity?: Identity | undefined;
  /** How long a claim lasts before a dead runner's row is re-picked (default 1800s). Longer than any sane run. */
  leaseSeconds?: number | undefined;
  /** Infrastructure failures retry until this many attempts, then the row parks as blocked (default 3). */
  maxAttempts?: number | undefined;
  /** Wait before a failed attempt is re-picked (default 300s). */
  retryBackoffSeconds?: number | undefined;
  /**
   * Byte budget for the prior-work block appended to the brief from the
   * task's room (METISTRY_BRIEF_THREAD_BYTES, default 4096). 0 turns it
   * off. The block is clipped again by the brief cap the dispatch passed.
   */
  briefThreadBytes?: number | undefined;
  /** Injected SDK for tests. */
  sdk?: CrewSdk | undefined;
  /**
   * `compute.yaml` in force. A crew named in `assignments.crews` runs on ITS
   * OWN provider through the in-house engine (collaboration rule 3); one
   * that is not keeps running on the SDK path with its manifest's model.
   */
  compute?: (() => Compute) | undefined;
  /** The pre-call gate (budgets). Applies to crew runs exactly as it does to the assistant's own turns. */
  guard?: TurnGuard | undefined;
  /** Injected for tests: run an ASSIGNED crew. Production builds the engine from the assignment and this run's bearer. */
  runAssigned?: ((input: CrewRunInput, assignment: ResolvedAssignment) => Promise<CrewRunResult>) | undefined;
}

/**
 * The engine one assigned crew run gets: its own provider, its own operating
 * prompt, its own `uses` allowlist on the tool host, and THIS run's bearer —
 * which the drain burns in `finally`. Built per run and thrown away with it,
 * so no two runs can ever share a credential or a session.
 */
function engineForCrew(cfg: CrewDrainConfig, input: CrewRunInput, guard?: TurnGuard): Engine {
  return makeEngine({
    systemPrompt: crewSystemPrompt(input.crew, input.identity),
    sessions: memorySessionStore(), // a crew run never resumes one (cost research decision 3)
    tools: () => mcpToolHost({ url: input.brain.url, token: input.brain.token, allow: crewToolNames(input.crew.uses), clientName: `metistry-crew-${input.crew.name}` }),
    ...(guard ? { guard } : {}),
  });
}

export const DEFAULT_BRIEF_THREAD_BYTES = 4096;

/** A queued crew row as claimed. */
export interface ClaimedCrewRow {
  id: number;
  owner: string;
  meta: any;
  attempts: number;
}

/** Claim the oldest runnable crew row: open, or in_progress with a lapsed lease, under the attempt cap. SKIP LOCKED: safe under concurrency. */
export async function claimCrewRow(db: Db, leaseSeconds: number, maxAttempts: number): Promise<ClaimedCrewRow | null> {
  const entry = JSON.stringify([{ ts: new Date().toISOString(), agent: "crew-runner", op: "claim", note: "crew runner attempt" }]);
  const { rows } = await db.query(
    `UPDATE work w SET status = 'in_progress', claimed_by = w.owner,
       lease_expires_at = now() + ($1::int * interval '1 second'), updated_at = now(),
       meta = w.meta || jsonb_build_object('attempts', COALESCE((w.meta->>'attempts')::int, 0) + 1),
       history = w.history || $2::jsonb
     WHERE w.id = (
       SELECT id FROM work
       WHERE kind = 'task' AND owner LIKE $3 AND status IN ('open', 'in_progress')
         AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now())
         AND COALESCE((meta->>'attempts')::int, 0) < $4
       ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, owner, meta`,
    [leaseSeconds, entry, `${CREW_OWNER_PREFIX}%`, maxAttempts],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: Number(row.id), owner: String(row.owner), meta: row.meta ?? {}, attempts: Number(row.meta?.attempts ?? 1) };
}

/** Mint this run's bearer: the row's hash is replaced, the plaintext returned once. Null when the crew is unregistered or revoked. */
export async function issueRunToken(db: Db, crewId: string): Promise<string | null> {
  const token = mintToken(32);
  const { rows } = await db.query(`UPDATE agents SET token_hash = $2 WHERE id = $1 AND kind = 'crew' AND revoked_at IS NULL RETURNING id`, [crewId, tokenHash(token)]);
  return rows.length === 1 ? token : null;
}

/**
 * Name the work row on everything this crew raised while it held it
 * (`proposals.work_id`, 0016). Server-side and after the fact: the crew
 * never passes a work id — `requests_create` has no such argument — so
 * nothing an agent says decides which card its report lands on. The window
 * is this run: rows by this crew, raised since it started, not already
 * stamped. A crew holds one row at a time (its token is rotated per run),
 * so the window cannot overlap another of its own runs.
 *
 * This is the link the board was missing: no proposal kind carried a work
 * id, so "which proposal is about this card" had no answer
 * (docs/ops/board.md).
 */
export async function stampProposalWork(db: Db, crewId: string, workId: number, since: Date): Promise<number> {
  const { rows } = await db.query(
    `UPDATE proposals SET work_id = $2 WHERE source_agent = $1 AND work_id IS NULL AND ts >= $3 RETURNING id`,
    [crewId, workId, since],
  );
  return rows.length;
}

/** Burn it: replace the hash with one of a token that is discarded here. The run's bearer is dead from this statement on. */
export async function burnRunToken(db: Db, crewId: string): Promise<void> {
  await db.query(`UPDATE agents SET token_hash = $2 WHERE id = $1 AND kind = 'crew'`, [crewId, tokenHash(mintToken(32))]);
}

type Settle = { status: "closed" | "blocked"; note: string } | { status: "retry"; note: string; backoffSeconds: number };

async function settle(db: Db, id: number, s: Settle, agent: string): Promise<void> {
  const entry = (status: string) => JSON.stringify([{ ts: new Date().toISOString(), agent, op: "update", status, note: s.note }]);
  if (s.status === "retry") {
    // keep the claim; the lease is the backoff — re-picked once it lapses (claimCrewRow)
    await db.query(`UPDATE work SET lease_expires_at = now() + ($2::int * interval '1 second'), updated_at = now(), history = history || $3::jsonb WHERE id = $1`, [id, s.backoffSeconds, entry("in_progress")]);
    return;
  }
  await db.query(
    `UPDATE work SET status = $2, closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE closed_at END,
       claimed_by = CASE WHEN $2 = 'closed' THEN NULL ELSE claimed_by END,
       lease_expires_at = CASE WHEN $2 = 'closed' THEN NULL ELSE lease_expires_at END,
       updated_at = now(), history = history || $3::jsonb
     WHERE id = $1`,
    [id, s.status, entry(s.status)],
  );
}

/**
 * The prior-work block (Taskuary review ADOPT 4, agent-room review phase 2):
 * "the brief is the context transfer", so a crew that claims a row with a
 * room gets the last N messages of it — inside a byte budget, newest kept,
 * rendered oldest-first the way the thread reads.
 *
 * Why here and not at dispatch: the room keeps moving while the row sits in
 * the queue, and what matters is what was said by the time the crew runs.
 * `brief_sha` therefore stays the sha of the DISPATCHED brief (what policy
 * checked); what the block added is recorded separately on the run row, so
 * "what did this crew actually see" is answerable from `runs` without
 * re-reading a thread that has moved on again.
 *
 * Budget: `min(METISTRY_BRIEF_THREAD_BYTES, what is left under the brief cap
 * the dispatch passed)`. The cap is frozen into the row at dispatch
 * (`meta.max_brief_bytes`) precisely so this cannot smuggle a brief past the
 * size `checkBrief` allowed.
 */
export interface BriefThreadBlock {
  text: string;
  comment_ids: string[];
  bytes: number;
}

export async function briefThreadBlock(db: Db, workId: number, budget: number): Promise<BriefThreadBlock | null> {
  if (budget <= 0) return null;
  const { rows } = await db.query(
    `SELECT id, body, author_principal, author_kind, created_at FROM artifact_comments
     WHERE work_id = $1 ORDER BY created_at ASC, id ASC`,
    [workId],
  );
  if (rows.length === 0) return null;
  const header = `\n\n--- prior work on #${workId} (the room on this task; nobody is addressed here) ---\n`;
  const footer = `--- end prior work ---\n`;
  const line = (r: any) =>
    `[${new Date(r.created_at).toISOString()}] ${r.author_kind === "agent" ? "agent " : ""}${r.author_principal}: ${sanitizeForAgent(String(r.body))}\n`;
  // newest first while filling, so a long room contributes its LAST messages
  const kept: { id: string; text: string }[] = [];
  let bytes = Buffer.byteLength(header + footer, "utf8");
  for (let i = rows.length - 1; i >= 0; i--) {
    const text = line(rows[i]);
    const size = Buffer.byteLength(text, "utf8");
    if (bytes + size > budget) break;
    bytes += size;
    kept.push({ id: String(rows[i]!.id), text });
  }
  if (kept.length === 0) return null;
  kept.reverse(); // read oldest-first, like the thread
  return { text: header + kept.map((k) => k.text).join("") + footer, comment_ids: kept.map((k) => k.id), bytes };
}

/** One pass: claim a row, run it, record it. Returns false when the queue is empty. */
export async function drainCrewOne(db: Db, cfg: CrewDrainConfig, run: (input: CrewRunInput, sdk?: CrewSdk) => Promise<CrewRunResult> = runCrew): Promise<boolean> {
  const leaseSeconds = cfg.leaseSeconds ?? 1800;
  const maxAttempts = cfg.maxAttempts ?? 3;
  const backoff = cfg.retryBackoffSeconds ?? 300;
  const row = await claimCrewRow(db, leaseSeconds, maxAttempts);
  if (!row) return false;

  const crewId = row.owner.slice(CREW_OWNER_PREFIX.length);
  const agent = row.owner;

  // Everything below that can be wrong with the ROW is permanent: no retry, park it with the reason.
  let crew;
  let brief: string;
  try {
    crew = parseCrewSnapshot(row.meta?.crew);
    if (crew.name !== crewId) throw new Error(`row owner ${row.owner} does not match snapshot name ${crew.name}`);
    brief = typeof row.meta?.brief === "string" ? row.meta.brief : "";
    if (!brief) throw new Error("work row carries no brief");
    if (!cfg.brainUrl) throw new Error("METISTRY_BRAIN_URL is unset — crews need the console's /mcp");
  } catch (err) {
    await settle(db, row.id, { status: "blocked", note: `crew run refused: ${err instanceof Error ? err.message : String(err)}` }, agent);
    return true;
  }
  const taskId = typeof row.meta?.task_id === "number" ? row.meta.task_id : undefined;
  const briefSha = typeof row.meta?.brief_sha === "string" ? row.meta.brief_sha : createHash("sha256").update(brief).digest("hex");

  // The crew's own assignment decides the engine (collaboration rule 3).
  // No assignment → the SDK path with the manifest's model, unchanged.
  const turn = resolveTurn(cfg.compute?.() ?? emptyCompute(), {} as TierMap, `crew:${crewId}`, { model: crew.model, effort: crew.effort });

  // The room on the row this crew is about (the dispatched task if there is
  // one, else the crew row itself) becomes the brief's prior-work block —
  // budgeted, and clipped again by the size cap the dispatch passed.
  const roomId = taskId ?? row.id;
  const maxBrief = typeof row.meta?.max_brief_bytes === "number" ? row.meta.max_brief_bytes : Number.POSITIVE_INFINITY;
  const headroom = maxBrief - Buffer.byteLength(brief, "utf8");
  const budget = Math.max(0, Math.min(cfg.briefThreadBytes ?? DEFAULT_BRIEF_THREAD_BYTES, headroom));
  let block: BriefThreadBlock | null = null;
  try {
    block = await briefThreadBlock(db, roomId, budget);
  } catch {
    block = null; // a room is context, never a precondition: a read that fails must not park the row
  }
  if (block) brief += block.text;

  const startedAt = new Date();
  const token = await issueRunToken(db, crewId);
  if (!token) {
    await settle(db, row.id, { status: "blocked", note: `crew '${crewId}' is not registered or is revoked — the console syncs agents/<area>/<name>.md; is the manifest still there?` }, agent);
    return true;
  }

  const runId = await startRun(db, {
    component: crewId,
    kind: "crew_run",
    ...(turn.assignment ? { provider: turn.assignment.provider } : {}),
    model: turn.model,
    meta: {
      work_id: row.id,
      brief_sha: briefSha,
      ...(taskId !== undefined ? { task_id: taskId } : {}),
      // which messages the brief actually carried — answerable later without re-reading a room that has moved on
      ...(block ? { thread_room: roomId, thread_comments: block.comment_ids, thread_bytes: block.bytes } : {}),
      attempt: row.attempts,
      effort: turn.effort,
      engine: turn.assignment?.config.kind ?? "anthropic",
      ...(turn.assignment ? { model_ref: turn.assignment.ref } : {}),
      fresh_session: true,
      crew_sha: crew.sha256,
      dispatch_run_id: row.meta?.dispatch_run_id ?? null,
      uses: crew.uses,
    },
  });
  try {
    const input: CrewRunInput = { crew, brief, task_id: taskId, brain: { url: cfg.brainUrl, token }, identity: cfg.identity };
    const r = turn.assignment
      ? await (cfg.runAssigned ?? ((i, a) => runCrewOnEngine(i, a, engineForCrew(cfg, i, cfg.guard))))(input, turn.assignment)
      : await run(input, cfg.sdk);
    const reports = r.tools_used["mcp__brain__report"] ?? 0;
    await finishRun(db, runId, {
      ok: r.outcome === "ok",
      ...(r.outcome !== "ok" ? { error: `crew run ${r.outcome}${r.errors?.length ? `: ${r.errors.join("; ").slice(0, 500)}` : ""}` } : {}),
      ...(r.tokens_in !== undefined ? { tokens_in: r.tokens_in } : {}),
      ...(r.tokens_out !== undefined ? { tokens_out: r.tokens_out } : {}),
      ...(r.cost_usd !== undefined ? { cost_usd: r.cost_usd } : {}),
      meta: { outcome: r.outcome, num_turns: r.num_turns, tools_used: r.tools_used, reports, text_chars: r.text_chars, session_id: r.session_id },
    });
    const summary = `crew run #${runId}: ${r.outcome}, ${r.num_turns} turns, ${reports} report${reports === 1 ? "" : "s"}${r.cost_usd !== undefined ? `, $${r.cost_usd.toFixed(4)}` : ""}`;
    // a budget or turn stop is final: retrying would spend again for the same brief
    await settle(db, row.id, r.outcome === "ok" ? { status: "closed", note: summary } : { status: "blocked", note: `${summary}${r.errors?.length ? ` — ${r.errors[0]!.slice(0, 200)}` : ""}` }, agent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRun(db, runId, { ok: false, error: message, meta: { attempt: row.attempts } });
    // A budget refusal is final for this window: retrying would re-run the
    // check and land in the same place, and the row stays visible on the list
    // with the field that would release it (the Eve adopt: a crew fails with
    // budget_exceeded; only a person-facing turn is offered another window).
    if (isBudgetRefusal(err)) await settle(db, row.id, { status: "blocked", note: message.slice(0, 500) }, agent);
    else if (row.attempts >= maxAttempts) await settle(db, row.id, { status: "blocked", note: `crew run failed ${row.attempts}× — last: ${message.slice(0, 300)}` }, agent);
    else await settle(db, row.id, { status: "retry", note: `crew run attempt ${row.attempts} failed (${message.slice(0, 200)}); retry after ${backoff}s`, backoffSeconds: backoff }, agent);
  } finally {
    await burnRunToken(db, crewId);
    // whatever it raised belongs to the row it held — even on a failed run
    await stampProposalWork(db, crewId, row.id, startedAt).catch(() => undefined);
  }
  return true;
}
