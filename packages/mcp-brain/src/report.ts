// report.submit (§4.19): a `proposals` row of kind `report`, source_agent
// from the credential, external trust. Idempotent on a caller-supplied
// key (the partial unique index from migration 0009 makes the retry safe
// under concurrency) and near-duplicate-suppressed: the same agent
// re-reporting the same title within 24h gets the existing id back
// instead of a second row for the user to triage.
//
// The same tool asks a QUESTION (T2-3, screen 3 §12.6): `kind: "question"`
// with `questions` writes a `decision` row — the stored kind of a question
// (core's request table) — instead of a report, so every agent can ask the
// way the assistant's ```decision block does, without a new tool (the brain
// stays at its definition budget). Its bounds are the block's own
// (`checkQuestions`), and its answers are checked against what is stored here
// and never executed (C105).

import { checkQuestions, redactSecrets, v1Options, type Question } from "@foldedspacelabs/metistry-core";
import type { Db } from "./types.js";

/**
 * What a report says it is. `decided` is *a decision was made* — C104 renamed
 * it from `decision`, which is also the stored kind of a QUESTION, and a word
 * that means both asking and having decided is misread by the first agent to
 * use it. Both names are accepted (ruled 2026-09-26: a published tool
 * schema); the row stores `decided`.
 */
export const REPORT_KINDS = ["finding", "decided", "decision", "gotcha", "progress"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** `requests_create`'s `kind`: a report's, or `question` — the one that asks. */
export const REQUEST_CREATE_KINDS = [...REPORT_KINDS, "question"] as const;
export type RequestCreateKind = (typeof REQUEST_CREATE_KINDS)[number];

export interface ReportInput {
  title: string;
  body: string;
  kind?: ReportKind | undefined;
  /** Handles, never payloads (§4.19): issue urls, task ids, note paths. */
  refs?: string[] | undefined;
  idempotency_key?: string | undefined;
}

export interface QuestionInput {
  /** The one line the owner's queue shows for the whole request. */
  title: string;
  /** Why the agent is asking: the context the owner reads above the questions. */
  body: string;
  questions: unknown;
  refs?: string[] | undefined;
  idempotency_key?: string | undefined;
}

export interface ReportResult {
  id: number;
  /** false = a new row; otherwise which rule matched an existing one. */
  deduplicated: false | "idempotency_key" | "title";
}

const NEAR_DUP_WINDOW = "24 hours";

/** `decision` is read as `decided` (C104): the stored word means one thing. */
export const reportKindOf = (kind: ReportKind | undefined): Exclude<ReportKind, "decision"> => (kind === undefined ? "finding" : kind === "decision" ? "decided" : kind);

export async function submitReport(db: Db, agentId: string, input: ReportInput): Promise<ReportResult> {
  const key = input.idempotency_key ?? null;
  if (key !== null) {
    const hit = await byKey(db, "report", agentId, key);
    if (hit !== null) return { id: hit, deduplicated: "idempotency_key" };
  }
  const dup = await byTitle(db, "report", agentId, input.title);
  if (dup !== null) return { id: dup, deduplicated: "title" };

  // Secret-named fields never land in the queue (§4.3 default 3).
  const payload = redactSecrets({
    title: input.title,
    body: input.body,
    kind: reportKindOf(input.kind),
    refs: input.refs ?? [],
    ...(key !== null ? { idempotency_key: key } : {}),
    provenance: { agent: agentId, via: "mcp-brain", submitted_at: new Date().toISOString() },
  });
  const ins = await db.query(
    `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('report', $1, 'external', $2::jsonb)
     ON CONFLICT (source_agent, (payload->>'idempotency_key')) WHERE kind = 'report' AND payload->>'idempotency_key' IS NOT NULL DO NOTHING
     RETURNING id`,
    [agentId, JSON.stringify(payload)],
  );
  if (ins.rows[0]) return { id: Number(ins.rows[0].id), deduplicated: false };
  // Lost the race on the key: the earlier insert wins.
  const again = key !== null ? await byKey(db, "report", agentId, key) : null;
  if (again === null) throw new Error("report insert returned no row and no key match"); // unreachable unless the row vanished mid-flight
  return { id: again, deduplicated: "idempotency_key" };
}

/**
 * Ask the owner (T2-3): one `decision` row carrying `questions` — the shape
 * core's `questionsOf` reads back when the answer arrives — and the agent's
 * words as `context {prose, refs}` (screen 3 §12.6). A question set outside
 * the block's bounds is refused whole with the reason, never trimmed.
 *
 * The same key and title rules as a report. Unlike a report's, the key has no
 * unique index behind it (no migration is reserved for this; plan §2.9), so a
 * truly concurrent retry could write twice — the owner then sees the same
 * question twice, and answering either settles nothing it should not.
 */
export async function submitQuestion(db: Db, agentId: string, input: QuestionInput): Promise<({ ok: true } & ReportResult) | { ok: false; error: string }> {
  const checked = checkQuestions(input.questions);
  if (!checked.ok) return { ok: false, error: `${checked.error} — questions: [{prompt, options, multi?, allow_other?}]` };
  const key = input.idempotency_key ?? null;
  if (key !== null) {
    const hit = await byKey(db, "decision", agentId, key);
    if (hit !== null) return { ok: true, id: hit, deduplicated: "idempotency_key" };
  }
  const dup = await byTitle(db, "decision", agentId, input.title);
  if (dup !== null) return { ok: true, id: dup, deduplicated: "title" };

  const questions: Question[] = checked.questions;
  const payload = redactSecrets({
    title: input.title,
    questions,
    ...v1Options(questions),
    context: { prose: input.body, refs: input.refs ?? [] },
    ...(key !== null ? { idempotency_key: key } : {}),
    provenance: { agent: agentId, via: "mcp-brain", submitted_at: new Date().toISOString() },
  });
  const ins = await db.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('decision', $1, 'external', $2::jsonb) RETURNING id`, [agentId, JSON.stringify(payload)]);
  return { ok: true, id: Number(ins.rows[0]?.id), deduplicated: false };
}

async function byKey(db: Db, kind: "report" | "decision", agentId: string, key: string): Promise<number | null> {
  const { rows } = await db.query(
    `SELECT id FROM proposals WHERE kind = $1 AND source_agent = $2 AND payload->>'idempotency_key' = $3 LIMIT 1`,
    [kind, agentId, key],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

async function byTitle(db: Db, kind: "report" | "decision", agentId: string, title: string): Promise<number | null> {
  const { rows } = await db.query(
    `SELECT id FROM proposals
     WHERE kind = $1 AND source_agent = $2 AND payload->>'title' = $3 AND ts > now() - interval '${NEAR_DUP_WINDOW}'
     ORDER BY ts DESC LIMIT 1`,
    [kind, agentId, title],
  );
  return rows[0] ? Number(rows[0].id) : null;
}
