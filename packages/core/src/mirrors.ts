// Mirrors: requests that stand for something living somewhere else (plan
// §2.9, §2.12; ticket T1-8; K15, R7).
//
// A pull request waiting on the owner's review, an invitation, an issue
// assigned to them — the thing itself lives at its source, and the request is
// only the owner's view of it. Migration 0027 gives `proposals` a `source`
// ({kind, external_ref, person}) and a UNIQUE partial index on
// (source->>'kind', source->>'external_ref') over the pending rows. This file
// is the one way to use them, so no sync hand-writes the ON CONFLICT clause
// that has to match that index expression for expression:
//
//   * `raiseMirror` — one subject, one row. The second raise of a subject that
//     is still pending returns the first row's id and writes nothing, so two
//     raises for one PR make one row, and a sync can raise on every pass.
//   * `resolveAtSource` — the source changed (the review landed, the
//     invitation was answered elsewhere), so the mirror leaves the queue as
//     `decision = 'resolved_at_source'`. It matches on `source` only, so it
//     cannot clear a request that is not a mirror.
//
// **One subject, one card — with every asker on it** (screen 3 §12.7, T4-23).
// An agent's review ask and GitHub's review request for the same PR are the
// same subject, so the second raise lands on the first row. What it adds is
// its ASKER: a raise by anyone other than the row's own `source_agent` is
// appended once to `payload.also_asked` ({source_agent, trust, at, title?,
// event?, context?}), so the card names both and the second asker's reason
// is not lost. Nothing the first asker wrote changes; the same asker raising
// again writes nothing.
//
// **A receipt when the source clears it** (T4-23): `resolveAtSource` writes
// `payload.cleared = {what, where}` beside the decision — what happened at
// the source, in the caller's words (*You approved it on GitHub*), and the
// source system it happened in — so every reader of the closed row (the
// `409 already_decided` a late answer gets, Activity) can say *where* it was
// settled rather than only that nobody here settled it. `also_asked` and
// `cleared` are written here and nowhere else: a raise carrying either is
// refused.
//
// A mirror never EXPIRES: the morning brief's 14-day expiry skips every row
// with a `source` (K15), because the review is still owed while the PR is open.
//
// Takes any executor with pg's query shape; no pg dependency in core (the
// dependency arrow), as `runs.ts` does.

import { redactSecrets } from "./redact.js";
import { isRequestKind } from "./requests.js";

/** The decision a mirror is closed with when its source changes — never an owner's answer, so it is not in `REQUEST_DECISIONS`. */
export const RESOLVED_AT_SOURCE = "resolved_at_source";

/** `payload.also_asked` — everyone but the row's own `source_agent` who raised the same subject while it waited. */
export const ALSO_ASKED_KEY = "also_asked";
/** `payload.cleared` — the receipt `resolveAtSource` writes: `{what, where}`. */
export const SOURCE_RECEIPT_KEY = "cleared";
/** The receipt of a clear whose caller did not say what happened — still a receipt, naming the source by `where`. */
export const DEFAULT_SOURCE_RECEIPT = "Changed at its source";
/** How long a receipt's `what` may be: one line on a collapsed card. */
export const SOURCE_RECEIPT_MAX = 200; // limit: fixed — a receipt is one line (components-01 §2.5), never a report
/** How many other askers one card records. */
export const ALSO_ASKED_MAX = 20; // limit: fixed — each is a distinct server-side identity, so this is a bound on a storm, not on real use

/** Someone else who asked about a waiting mirror's subject (module header). */
export interface MirrorAsker {
  readonly source_agent: string;
  readonly trust: RequestTrust;
  readonly at: string;
  readonly title?: string;
  readonly event?: string;
  readonly context?: unknown;
}

/** What a mirror stands for. `kind` is the source system (`github`, `linear`, `calendar`), `external_ref` the subject within it (`gh:owner/repo#41`), `person` who the source names. */
export interface RequestSource {
  readonly kind: string;
  readonly external_ref: string;
  readonly person?: string | null;
}

export interface MirrorExecutor {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const REQUEST_TRUSTS = ["internal", "external", "user"] as const;
export type RequestTrust = (typeof REQUEST_TRUSTS)[number];

export interface MirrorRaise {
  /** The stored `proposals.kind` — one the request type table knows (`pull_request`, `invitation`, `task`, …). */
  readonly kind: string;
  /** Server-side identity of whatever raised it (the collector, the agent) — never self-declared. */
  readonly source_agent: string;
  readonly trust: RequestTrust;
  readonly payload: Record<string, unknown>;
  readonly source: RequestSource;
  /** The card several rows are answered as (a meeting's session); omitted = its own card. */
  readonly group_id?: string | null;
  readonly work_id?: number | null;
}

export interface MirrorRaised {
  readonly id: number;
  /** false when a pending row for this subject already existed and was returned instead. */
  readonly raised: boolean;
}

const RAISE_ATTEMPTS = 3; // limit: fixed — a pending row answered between our insert and our read is a race won at most once or twice, never a loop

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * A source as the database's CHECK (`proposals_source_shape`) accepts it —
 * refused here first, with a message, rather than as a constraint violation.
 */
export function parseRequestSource(value: unknown): RequestSource {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("request source: must be an object {kind, external_ref, person?}");
  const { kind, external_ref, person } = value as Record<string, unknown>;
  if (!nonEmpty(kind)) throw new TypeError("request source: `kind` must be a non-empty string");
  if (!nonEmpty(external_ref)) throw new TypeError("request source: `external_ref` must be a non-empty string");
  if (person !== undefined && person !== null && typeof person !== "string") throw new TypeError("request source: `person` must be a string when present");
  return person === undefined ? { kind, external_ref } : { kind, external_ref, person };
}

/**
 * Raise a mirror, or find the one already waiting. Two raises for one subject
 * make one row: the second returns the first's id with `raised: false`, and
 * the first row is left exactly as it was — what changed at the source since
 * is the stale check's business (T2-14), not a silent rewrite of what the
 * owner may be reading. The payload is redacted like every other queue write.
 */
export async function raiseMirror(db: MirrorExecutor, r: MirrorRaise): Promise<MirrorRaised> {
  if (!isRequestKind(r.kind)) throw new TypeError(`raiseMirror: ${JSON.stringify(r.kind)} is not a request kind the type table knows`);
  if (!nonEmpty(r.source_agent)) throw new TypeError("raiseMirror: source_agent is required");
  if (!(REQUEST_TRUSTS as readonly string[]).includes(r.trust)) throw new TypeError(`raiseMirror: trust must be one of ${REQUEST_TRUSTS.join(", ")}`);
  if (r.group_id !== undefined && r.group_id !== null && !nonEmpty(r.group_id)) throw new TypeError("raiseMirror: group_id must be a non-empty string when present");
  for (const key of [ALSO_ASKED_KEY, SOURCE_RECEIPT_KEY]) {
    if (Object.hasOwn(r.payload, key)) throw new TypeError(`raiseMirror: payload.${key} is written by the mirror itself, never raised`);
  }
  const source = parseRequestSource(r.source);
  const redacted = redactSecrets(r.payload) as Record<string, unknown>;
  const payload = JSON.stringify(redacted);

  for (let attempt = 1; attempt <= RAISE_ATTEMPTS; attempt++) {
    const ins = await db.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload, source, group_id, work_id)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       ON CONFLICT ((source->>'kind'), (source->>'external_ref')) WHERE decision = 'pending' DO NOTHING
       RETURNING id`,
      [r.kind, r.source_agent, r.trust, payload, JSON.stringify(source), r.group_id ?? null, r.work_id ?? null],
    );
    if (ins.rows[0]) return { id: Number(ins.rows[0].id), raised: true };
    const existing = await db.query(
      `SELECT id, source_agent, payload->'${ALSO_ASKED_KEY}' AS also_asked FROM proposals WHERE decision = 'pending' AND source->>'kind' = $1 AND source->>'external_ref' = $2 LIMIT 1`,
      [source.kind, source.external_ref],
    );
    const waiting = existing.rows[0];
    if (waiting) {
      const id = Number(waiting.id);
      if (String(waiting.source_agent) !== r.source_agent && !askedAlready(waiting.also_asked, r.source_agent)) {
        await noteAsker(db, id, askerOf(r, redacted));
      }
      return { id, raised: false };
    }
    // The pending row was answered between the insert and the read: the
    // subject is free again, so the next insert takes it.
  }
  throw new Error(`raiseMirror: ${source.kind} ${source.external_ref} kept being answered while it was raised`);
}

function askedAlready(also: unknown, agent: string): boolean {
  return Array.isArray(also) && also.some((a) => typeof a === "object" && a !== null && (a as { source_agent?: unknown }).source_agent === agent);
}

/** The asker a raise that found its subject waiting adds to the card: who, how trusted, when, and what they said — from the redacted payload. */
function askerOf(r: MirrorRaise, payload: Record<string, unknown>): MirrorAsker {
  return {
    source_agent: r.source_agent,
    trust: r.trust,
    at: new Date().toISOString(),
    ...(typeof payload.title === "string" ? { title: payload.title } : {}),
    ...(typeof payload.event === "string" ? { event: payload.event } : {}),
    ...(payload.context !== undefined ? { context: payload.context } : {}),
  };
}

/**
 * Append one asker to a waiting row's `also_asked` — atomically, so two
 * askers at once both land and one asker twice lands once; never on the
 * row's own asker, never past `ALSO_ASKED_MAX`, never on a row that stopped
 * waiting. Nothing else in the payload moves.
 */
async function noteAsker(db: MirrorExecutor, id: number, asker: MirrorAsker): Promise<void> {
  await db.query(
    `UPDATE proposals
     SET payload = jsonb_set(payload, '{${ALSO_ASKED_KEY}}', coalesce(payload->'${ALSO_ASKED_KEY}', '[]'::jsonb) || jsonb_build_array($2::jsonb))
     WHERE id = $1 AND decision = 'pending' AND source_agent <> $3
       AND NOT coalesce(payload->'${ALSO_ASKED_KEY}', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('source_agent', $3::text))
       AND jsonb_array_length(coalesce(payload->'${ALSO_ASKED_KEY}', '[]'::jsonb)) < $4`,
    [id, JSON.stringify(asker), asker.source_agent, ALSO_ASKED_MAX],
  );
}

/**
 * The source changed: close its pending mirror as `resolved_at_source`, with
 * a receipt — `payload.cleared = {what, where}`: what happened there, in the
 * caller's words (`DEFAULT_SOURCE_RECEIPT` when it gives none), and the
 * source system (`source.kind`) it happened in. Returns the ids it closed —
 * none when nothing was waiting (the owner answered first, or it was never
 * raised). A request with no `source` is never matched, so this cannot clear
 * anything but a mirror.
 */
export async function resolveAtSource(db: MirrorExecutor, source: Pick<RequestSource, "kind" | "external_ref">, receipt: string = DEFAULT_SOURCE_RECEIPT): Promise<number[]> {
  const { kind, external_ref } = parseRequestSource({ kind: source.kind, external_ref: source.external_ref });
  const what = sourceReceipt(receipt);
  const { rows } = await db.query(
    `UPDATE proposals SET decision = '${RESOLVED_AT_SOURCE}', decided_at = now(), snoozed_until = NULL,
       payload = payload || jsonb_build_object('${SOURCE_RECEIPT_KEY}', jsonb_build_object('what', $3::text, 'where', source->>'kind'))
     WHERE decision = 'pending' AND source IS NOT NULL AND source->>'kind' = $1 AND source->>'external_ref' = $2
     RETURNING id`,
    [kind, external_ref, what],
  );
  return rows.map((r) => Number(r.id));
}

/** A receipt as `resolveAtSource` stores it: one trimmed, non-empty line of at most `SOURCE_RECEIPT_MAX` characters — refused otherwise, never cut. */
export function sourceReceipt(value: unknown): string {
  if (!nonEmpty(value)) throw new TypeError("resolveAtSource: the receipt must be a non-empty string");
  const what = value.trim();
  if (what.length > SOURCE_RECEIPT_MAX || /[\r\n]/.test(what)) throw new TypeError(`resolveAtSource: the receipt is one line of at most ${SOURCE_RECEIPT_MAX} characters`);
  return what;
}

/** The newest request ever raised for a subject, answered or not. */
export interface MirrorHistory {
  readonly id: number;
  /** `pending`, an owner's answer, `resolved_at_source` or `expired`. */
  readonly decision: string;
}

/**
 * Has this subject EVER been raised — pending or answered? `raiseMirror`
 * de-duplicates only while a row waits; a subject that must be asked once
 * and never again (a declined answer is an answer) checks this first. Null
 * when nothing was ever raised for it.
 */
export async function lastMirror(db: MirrorExecutor, source: Pick<RequestSource, "kind" | "external_ref">): Promise<MirrorHistory | null> {
  const { kind, external_ref } = parseRequestSource({ kind: source.kind, external_ref: source.external_ref });
  const { rows } = await db.query(
    `SELECT id, decision FROM proposals WHERE source IS NOT NULL AND source->>'kind' = $1 AND source->>'external_ref' = $2 ORDER BY id DESC LIMIT 1`,
    [kind, external_ref],
  );
  const row = rows[0];
  return row ? { id: Number(row.id), decision: String(row.decision) } : null;
}

// ---- a knowledge conflict's mirror (C96, T2-9; T2-10) ----------------------
//
// A sync-conflict copy in the vault is raised by the reconciler as ONE
// `review` mirroring the copy, and settled at the Resolve a conflict door
// (`POST /api/knowledge/conflicts/resolve`), which lives in the console. Two
// apps name the same subject, and apps never import each other, so the
// subject's spelling lives here, once.

/** The mirror's source system: the subject lives in this instance's own vault. */
export const KNOWLEDGE_CONFLICT_SOURCE_KIND = "metistry";
/** `source.external_ref` is this prefix and the copy's vault path. */
export const KNOWLEDGE_CONFLICT_REF_PREFIX = "conflict:";

/** The subject a conflict copy's request mirrors. */
export function knowledgeConflictSource(path: string): RequestSource {
  return { kind: KNOWLEDGE_CONFLICT_SOURCE_KIND, external_ref: `${KNOWLEDGE_CONFLICT_REF_PREFIX}${path}` };
}
