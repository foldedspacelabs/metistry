// tasks module (plan §4.20) — the shared task list any agent can claim from.
// One TypeScript service over a pg-shaped client; policy, idempotency,
// attribution, and the action record live here, once. Adapters (console
// HTTP, MCP tools, CLI verbs) adapt this and add nothing.
//
// Trust rule (§4.19): `agent` on every mutating call is the SERVER-SIDE
// identity the adapter derived from the credential. Nothing an agent says
// about itself in a payload is ever read here — the parameter exists so an
// adapter is forced to supply it.
//
// Every state change is ONE atomic statement whose WHERE clause carries the
// policy (claim, heartbeat, update, release). Never read-then-write: the
// convergent primitive every serious coordination system landed on
// (docs/research/2026-08-agent-coordination.md).

import { readFile } from "node:fs/promises";
import { finishRun, runCheck, startRun, type CheckResult } from "@foldedspacelabs/metistry-core";

/** Minimal executor shape — satisfied by pg.Pool / pg.Client. Injectable for tests. */
export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type TaskStatus = "open" | "in_progress" | "blocked" | "closed";

export interface HistoryEntry {
  ts: string;
  agent: string;
  op: "create" | "claim" | "heartbeat" | "update" | "release";
  note?: string;
  status?: TaskStatus;
}

export interface Task {
  id: number;
  title: string;
  project: string | null;
  area: string | null;
  kind: string;
  status: TaskStatus;
  external_ref: string | null;
  owner: string | null;
  /** ISO date (YYYY-MM-DD) or null. */
  due: string | null;
  claimed_by: string | null;
  lease_expires_at: Date | null;
  depends_on: number[];
  idempotency_key: string | null;
  history: HistoryEntry[];
  created_by: string | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  meta: Record<string, unknown>;
}

export interface CreateInput {
  title: string;
  project?: string;
  area?: string;
  depends_on?: number[];
  /** YYYY-MM-DD */
  due?: string;
  /** Caller-supplied; a retried create with the same key returns the existing row. */
  idempotency_key?: string;
  external_ref?: string;
}

export interface UpdateInput {
  /** `closed` releases the claim and stamps closed_at; `blocked` keeps the claim. */
  status?: Exclude<TaskStatus, "open">;
  note?: string;
}

export type ClaimFailure =
  | "not_found"
  | "not_claimable" // a collected row (issue/pr/event) — the source of truth owns its status
  | "closed"
  | "blocked"
  | "claimed" // held by another agent with a live lease
  | "dependencies_open"
  | "not_holder" // heartbeat/update/release by someone other than the claim holder
  | "lease_expired"; // heartbeat after expiry — the task is up for grabs again

export { CLAIMABLE_KINDS };
export type Result = { ok: true; task: Task } | { ok: false; reason: ClaimFailure; task?: Task };

export class TasksError extends Error {
  constructor(
    readonly code: "invalid_input" | "unknown_dependency" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

// --- SQL fragments -------------------------------------------------------

/** Every column, normalized: dates as text so the wire shape is stable across pg type parsers. */
const COLS = `id, title, project, area, kind, status, external_ref, owner, due::text AS due,
  claimed_by, lease_expires_at, depends_on, idempotency_key, history, created_by, closed_at,
  created_at, updated_at, meta`;

/**
 * "Every id in depends_on is closed." A dangling id (deleted row) blocks
 * rather than silently unblocks — a typo must not release work.
 */
const DEPS_CLOSED = `NOT EXISTS (
  SELECT 1 FROM unnest(w.depends_on) AS dep(id)
  LEFT JOIN work t ON t.id = dep.id
  WHERE t.status IS DISTINCT FROM 'closed')`;

const UNCLAIMED = `(w.claimed_by IS NULL OR w.lease_expires_at < now())`;
// Only rows the task list owns are claimable (owner ruling 2026-09-06).
// Rows collected from a source of truth (kind issue/pr/event — github-state
// upserts them back to `open` every tick) are visible in `work` but never
// handed to an agent here; the §4.18 target for GitHub dispatch is the
// place where that becomes a real claim.
const CLAIMABLE_KINDS = ["task", "review"] as const;
const CLAIMABLE = `w.kind = ANY('{${CLAIMABLE_KINDS.join(",")}}'::text[])`;

function toTask(row: Record<string, unknown>): Task {
  // pg returns int8 as string and int8[] as string[]; normalize once here.
  return {
    ...(row as unknown as Task),
    id: Number(row.id),
    depends_on: ((row.depends_on as unknown[] | null) ?? []).map(Number),
    history: (row.history as HistoryEntry[] | null) ?? [],
    meta: (row.meta as Record<string, unknown> | null) ?? {},
  };
}

function entry(agent: string, op: HistoryEntry["op"], extra: { note?: string; status?: TaskStatus } = {}): string {
  const e: HistoryEntry = { ts: new Date().toISOString(), agent, op };
  if (extra.note !== undefined) e.note = extra.note;
  if (extra.status !== undefined) e.status = extra.status;
  return JSON.stringify([e]);
}

// --- input validation (hand-rolled: the surface is five fields) ------------

const STATUSES: readonly TaskStatus[] = ["open", "in_progress", "blocked", "closed"];

function requireAgent(agent: unknown): string {
  if (typeof agent !== "string" || agent.trim() === "") {
    throw new TasksError("invalid_input", "agent identity is required (supplied by the adapter from the credential)");
  }
  return agent;
}

function requireId(id: unknown): number {
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new TasksError("invalid_input", "id must be a positive integer");
  }
  return id;
}

function optionalText(name: string, v: unknown, max = 4000): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new TasksError("invalid_input", `${name} must be a string`);
  if (v.length > max) throw new TasksError("invalid_input", `${name} exceeds ${max} characters`);
  return v;
}

// --- service ----------------------------------------------------------------

export interface TasksServiceOptions {
  /** Default lease length for claim(); heartbeat renews by the same amount. */
  defaultLeaseSeconds?: number;
}

export class TasksService {
  private readonly defaultLease: number;

  constructor(
    private readonly db: Db,
    opts: TasksServiceOptions = {},
  ) {
    this.defaultLease = opts.defaultLeaseSeconds ?? 900;
  }

  /** Action record (§4.20): every mutation is a two-phase `runs` row — component = agent, kind = task_op. */
  private async recorded<T>(agent: string, op: HistoryEntry["op"], id: number | null, fn: () => Promise<T>, idOf?: (out: T) => number | null): Promise<T> {
    const runId = await startRun(this.db, { component: agent, kind: "task_op", meta: { op, id } });
    try {
      const out = await fn();
      const finalId = idOf ? idOf(out) : id;
      await finishRun(this.db, runId, { ok: true, meta: { op, id: finalId } });
      return out;
    } catch (err) {
      await finishRun(this.db, runId, { ok: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /** Idempotent on `idempotency_key`: a retry returns the existing row untouched. */
  async create(input: CreateInput, agent: string): Promise<Task> {
    agent = requireAgent(agent);
    const title = optionalText("title", input.title, 500);
    if (!title || title.trim() === "") throw new TasksError("invalid_input", "title is required");
    const project = optionalText("project", input.project, 200);
    const area = optionalText("area", input.area, 200);
    const key = optionalText("idempotency_key", input.idempotency_key, 200);
    const externalRef = optionalText("external_ref", input.external_ref, 500);
    const due = optionalText("due", input.due, 10);
    if (due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new TasksError("invalid_input", "due must be YYYY-MM-DD");
    const dependsOn = [...new Set((input.depends_on ?? []).map(requireId))];

    return this.recorded(agent, "create", null, async () => {
      if (dependsOn.length > 0) {
        const { rows } = await this.db.query(`SELECT id FROM work WHERE id = ANY($1::bigint[])`, [dependsOn]);
        const found = new Set(rows.map((r) => Number(r.id)));
        const missing = dependsOn.filter((d) => !found.has(d));
        if (missing.length > 0) throw new TasksError("unknown_dependency", `depends_on references unknown task(s): ${missing.join(", ")}`);
      }
      const values = [title, project, area, dependsOn, due, key, externalRef, agent, entry(agent, "create")];
      let rows: Record<string, unknown>[];
      try {
        ({ rows } = await this.db.query(
          `INSERT INTO work (title, project, area, kind, status, depends_on, due, idempotency_key, external_ref, created_by, history)
           VALUES ($1, $2, $3, 'task', 'open', $4::bigint[], $5::date, $6, $7, $8, $9::jsonb)
           ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING ${COLS}`,
          values,
        ));
      } catch (err) {
        // 23505 = unique_violation; the only remaining unique index is external_ref.
        if ((err as { code?: string }).code === "23505") throw new TasksError("conflict", `a task with external_ref ${externalRef} already exists`);
        throw err;
      }
      if (rows[0]) return toTask(rows[0]);
      // Key already taken: the earlier create wins; hand its row back.
      const existing = await this.db.query(`SELECT ${COLS} FROM work w WHERE idempotency_key = $1`, [key]);
      if (!existing.rows[0]) throw new TasksError("conflict", "idempotent create found no row"); // unreachable unless the row was deleted mid-flight
      return toTask(existing.rows[0]);
    }, (t) => t.id);
  }

  /** Open, unclaimed (or lease expired), every dependency closed. Oldest first, due dates ahead of none. */
  async listReady(opts: { project?: string; limit?: number } = {}): Promise<Task[]> {
    const limit = opts.limit ?? 50;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 500) throw new TasksError("invalid_input", "limit must be 1..500");
    const project = optionalText("project", opts.project, 200);
    const { rows } = await this.db.query(
      `SELECT ${COLS} FROM work w
       WHERE w.status = 'open' AND ${CLAIMABLE} AND ${UNCLAIMED} AND ${DEPS_CLOSED}
         AND ($1::text IS NULL OR w.project = $1)
       ORDER BY w.due NULLS LAST, w.created_at ASC, w.id ASC
       LIMIT $2`,
      [project, limit],
    );
    return rows.map(toTask);
  }

  /**
   * ONE atomic UPDATE: the WHERE clause is the whole policy. Two agents
   * racing for the same row get exactly one winner; the loser sees zero
   * rows and gets a reason from a diagnostic read afterwards.
   */
  async claim(id: number, agent: string, leaseSeconds?: number): Promise<Result> {
    id = requireId(id);
    agent = requireAgent(agent);
    const lease = leaseSeconds ?? this.defaultLease;
    if (!Number.isInteger(lease) || lease <= 0 || lease > 86_400) throw new TasksError("invalid_input", "leaseSeconds must be 1..86400");
    return this.recorded(agent, "claim", id, async () => {
      const { rows } = await this.db.query(
        `UPDATE work w
         SET claimed_by = $2, lease_expires_at = now() + ($3::int * interval '1 second'),
             status = 'in_progress', updated_at = now(), history = history || $4::jsonb
         WHERE w.id = $1 AND ${CLAIMABLE} AND ${UNCLAIMED} AND w.status IN ('open', 'in_progress') AND ${DEPS_CLOSED}
         RETURNING ${COLS}`,
        [id, agent, lease, entry(agent, "claim")],
      );
      if (rows[0]) return { ok: true as const, task: toTask(rows[0]) };
      return this.explainClaimFailure(id);
    });
  }

  /** Why did a claim return no row? Diagnostic only — never a decision input. */
  private async explainClaimFailure(id: number): Promise<Result> {
    const { rows } = await this.db.query(
      `SELECT ${COLS}, ${DEPS_CLOSED} AS deps_closed FROM work w WHERE w.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: "not_found" };
    const task = toTask(row);
    if (!(CLAIMABLE_KINDS as readonly string[]).includes(task.kind)) return { ok: false, reason: "not_claimable", task };
    if (task.status === "closed") return { ok: false, reason: "closed", task };
    if (task.status === "blocked") return { ok: false, reason: "blocked", task };
    if (row.deps_closed === false) return { ok: false, reason: "dependencies_open", task };
    return { ok: false, reason: "claimed", task };
  }

  /** Extend the lease — holder only, and only while it is still live. An expired lease is not renewed. */
  async heartbeat(id: number, agent: string, leaseSeconds?: number): Promise<Result> {
    id = requireId(id);
    agent = requireAgent(agent);
    const lease = leaseSeconds ?? this.defaultLease;
    if (!Number.isInteger(lease) || lease <= 0 || lease > 86_400) throw new TasksError("invalid_input", "leaseSeconds must be 1..86400");
    return this.recorded(agent, "heartbeat", id, async () => {
      const { rows } = await this.db.query(
        `UPDATE work w
         SET lease_expires_at = now() + ($3::int * interval '1 second'), updated_at = now()
         WHERE w.id = $1 AND w.claimed_by = $2 AND w.lease_expires_at > now() AND w.status IN ('in_progress', 'blocked')
         RETURNING ${COLS}`,
        [id, agent, lease],
      );
      if (rows[0]) return { ok: true as const, task: toTask(rows[0]) };
      return this.explainHolderFailure(id, agent, true);
    });
  }

  /**
   * Holder-only status/note change. `closed` stamps closed_at and releases
   * the claim; `blocked` keeps it (the holder is waiting on something and
   * should keep heartbeating). The holder keeps its authority after lease
   * expiry until someone else claims the task — late work can still land.
   */
  async update(id: number, agent: string, change: UpdateInput): Promise<Result> {
    id = requireId(id);
    agent = requireAgent(agent);
    const status = change.status ?? null;
    // The type excludes "open", but adapters hand us JSON — guard at runtime too.
    if (status !== null && (!STATUSES.includes(status) || (status as string) === "open")) {
      throw new TasksError("invalid_input", "status must be in_progress, blocked, or closed (use release() to hand a task back)");
    }
    const note = optionalText("note", change.note);
    if (status === null && note === null) throw new TasksError("invalid_input", "update needs a status or a note");
    return this.recorded(agent, "update", id, async () => {
      const { rows } = await this.db.query(
        `UPDATE work w
         SET status = COALESCE($3::text, w.status),
             closed_at = CASE WHEN $3::text = 'closed' THEN now() ELSE w.closed_at END,
             claimed_by = CASE WHEN $3::text = 'closed' THEN NULL ELSE w.claimed_by END,
             lease_expires_at = CASE WHEN $3::text = 'closed' THEN NULL ELSE w.lease_expires_at END,
             updated_at = now(), history = history || $4::jsonb
         WHERE w.id = $1 AND w.claimed_by = $2 AND w.status <> 'closed'
         RETURNING ${COLS}`,
        [id, agent, status, entry(agent, "update", { ...(note !== null ? { note } : {}), ...(status !== null ? { status } : {}) })],
      );
      if (rows[0]) return { ok: true as const, task: toTask(rows[0]) };
      return this.explainHolderFailure(id, agent, false);
    });
  }

  /** Hand a task back: clears the claim and reopens it. Holder only (lease expiry does not matter). */
  async release(id: number, agent: string, note?: string): Promise<Result> {
    id = requireId(id);
    agent = requireAgent(agent);
    const n = optionalText("note", note);
    return this.recorded(agent, "release", id, async () => {
      const { rows } = await this.db.query(
        `UPDATE work w
         SET claimed_by = NULL, lease_expires_at = NULL, status = 'open', updated_at = now(), history = history || $3::jsonb
         WHERE w.id = $1 AND w.claimed_by = $2 AND w.status <> 'closed'
         RETURNING ${COLS}`,
        [id, agent, entry(agent, "release", n !== null ? { note: n } : {})],
      );
      if (rows[0]) return { ok: true as const, task: toTask(rows[0]) };
      return this.explainHolderFailure(id, agent, false);
    });
  }

  private async explainHolderFailure(id: number, agent: string, leaseMatters: boolean): Promise<Result> {
    const task = await this.get(id);
    if (!task) return { ok: false, reason: "not_found" };
    if (task.status === "closed") return { ok: false, reason: "closed", task };
    if (task.claimed_by !== agent) return { ok: false, reason: "not_holder", task };
    if (leaseMatters) return { ok: false, reason: "lease_expired", task };
    return { ok: false, reason: "not_holder", task };
  }

  async get(id: number): Promise<Task | null> {
    id = requireId(id);
    const { rows } = await this.db.query(`SELECT ${COLS} FROM work w WHERE w.id = $1`, [id]);
    return rows[0] ? toTask(rows[0]) : null;
  }

  /** Everything this agent currently holds (open claims, live or expired), soonest lease first. */
  async listForAgent(agent: string): Promise<Task[]> {
    agent = requireAgent(agent);
    const { rows } = await this.db.query(
      `SELECT ${COLS} FROM work w WHERE w.claimed_by = $1 AND w.status <> 'closed'
       ORDER BY w.lease_expires_at ASC NULLS LAST, w.id ASC`,
      [agent],
    );
    return rows.map(toTask);
  }

  check(): Promise<CheckResult> {
    return check(this.db);
  }
}

/** Behavioral probe: select every column the service depends on. Fails on an unmigrated db. */
export async function check(db: Db): Promise<CheckResult> {
  return runCheck("tasks", "select the claim/lease/dependency/history columns from work and the runs ledger", async () => {
    await db.query(`SELECT ${COLS} FROM work w WHERE false`);
    await db.query(`SELECT id, component, kind, meta, started_at, finished_at FROM runs WHERE false`);
  });
}

/**
 * Standalone schema (sql/schema.sql): idempotent, and a no-op on a database
 * that already carries Metistry's own migrations. Inside the console the
 * migration runner owns the schema and this is never called.
 */
export async function ensureSchema(db: Db): Promise<void> {
  const sql = await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8");
  await db.query(sql);
}
