// The request type table (docs/product/design-build-plan.md §2.12, ticket F-5).
//
// Everything that waits on the owner is a `proposals` row whose `kind` is free
// text (migration 0002; 0022 kept it free text on purpose, so a new kind needs
// no migration). The owner never reads that kind. They read one of TWELVE
// TYPES (docs/product/glossary.md), each drawn with one BODY from a closed set
// and answered by the type's own primary verb, Revise and Decline. This file
// is the one place that says which is which. It is DATA and pure functions:
// no Postgres, no console, no vault (the dependency arrow).
//
// It replaces two copies of the kind → word mapping that had drifted from
// each other and from the console: a CASE in seed/queries/pending_requests.yaml
// and `REQUEST_TYPE` in routines/morning-brief/run.ts, both of which said
// *note* for `action` (C80: an agent asking to act is not a note). Now the
// brief imports `requestWordOf`, and the query's CASE is `requestWordSql()`'s
// output — a YAML file cannot import TypeScript, so the query carries the
// rendered text and apps/console/test/seed-queries.test.ts refuses any other
// spelling of it, then checks the SQL against this table kind by kind.
//
// Two decisions worth stating before the code:
//
//   * A kind this table does not know reads as a REPORT drawn as an EXCERPT,
//     with Dismiss (`skip`) its only answer. It is the one reading that can
//     fire no consequence this build has not reviewed: an unknown kind's
//     `allow` could mean anything, so it is not offered. The stored kind is
//     never shown in its place — the words are the owner's, not the
//     machinery's.
//   * A payload may choose among its type's bodies (`payload.body.kind`,
//     screen 3 §12.6) and never outside them. A body the type does not draw,
//     or one outside the closed set, is its type's default — so a payload can
//     pick the thread over the diff, and cannot give an access request some
//     other type's answers.

import { createHash } from "node:crypto";
import { questionsOf, type Question } from "./decision-block.js";

/** The twelve types the owner reads, in §2.12's order. Closed: a new type is a product change that picks a body from `REQUEST_BODIES` (plan §2.7). */
export const REQUEST_TYPES = [
  "question",
  "pull_request",
  "access",
  "action",
  "meeting",
  "review",
  "note",
  "improvement",
  "report",
  "invitation",
  "task",
  "message",
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

/** Screen 3 §12.2's closed set: a request's body is exactly one of these blocks, so a new type renders without new UI. */
export const REQUEST_BODIES = ["choices", "diff", "thread", "before_after", "preview", "todos", "excerpt"] as const;
export type RequestBody = (typeof REQUEST_BODIES)[number];

/**
 * What an answer stores on the request row itself — `proposals.decision`,
 * through `POST /api/proposals/:id` (docs/ops/reply-feedback.md). `answers`
 * is a question's: one answer per question, its options and/or `other` + text
 * (T2-3, `checkAnswers`), stored as `answered` — what a question answered in
 * chat has always stored — with the record in `payload.answers` and its words
 * in `feedback`. `skip` is stored as `deny` + `SKIP_FEEDBACK` and fires none of
 * `deny`'s consequences. `later` is absent on purpose: it is not an answer
 * (it sets `snoozed_until`) and every type takes it.
 */
export const REQUEST_DECISIONS = ["answers", "allow", "accept_as_work", "accept_with_changes", "deny", "skip"] as const;
export type RequestDecision = (typeof REQUEST_DECISIONS)[number];

/**
 * An answer that posts to another system goes through that system's door
 * (§2.11), not through the request row; the request clears when the source
 * does (`resolved_at_source`). `pr_review` is §2.11's PR review, `rsvp` and
 * `draft` its Respond / Draft, `resolve_conflict` its Resolve a conflict.
 * `act` is the act a report names (Try Again, Reconnect — C96, T2-9);
 * `today` and `delegate` are a mirrored task's two answers (§2.12).
 */
export const REQUEST_DOORS = ["pr_review", "rsvp", "draft", "resolve_conflict", "act", "today", "delegate"] as const;
export type RequestDoor = (typeof REQUEST_DOORS)[number];

export type RequestSend = { readonly decision: RequestDecision } | { readonly door: RequestDoor };

export interface RequestAnswer {
  /**
   * The button's word, HIG Title Case. `null` for a report's act only: its
   * word is the act's own (Try Again, Reconnect), named by the event that
   * raised it.
   */
  readonly label: string | null;
  readonly sends: RequestSend;
  /** What the answer carries beside its verb: the owner's words, or — access only — the narrower area (Revise can only grant less, C40). */
  readonly carries?: "feedback" | "area";
  /** The words are not optional (Request Changes; a Reply). */
  readonly required?: true;
}

/** One body a type draws, and the three answers it offers there. `null` is an answer the type does not have (a pull request has no Decline). */
export interface RequestBodyAnswers {
  readonly body: RequestBody;
  readonly primary: RequestAnswer | null;
  readonly revise: RequestAnswer | null;
  readonly decline: RequestAnswer | null;
}

export interface RequestTypeSpec {
  /** The word the owner reads (docs/product/glossary.md). */
  readonly word: string;
  /** The bodies this type draws, each with its answers. The FIRST is what a row renders when its payload names no body, or one this type does not draw. */
  readonly bodies: readonly [RequestBodyAnswers, ...RequestBodyAnswers[]];
  /** The answers apply to every row of the group, one per row, in order (a meeting's Accept All; Decline All after a 10 s Undo the client holds). */
  readonly grouped?: true;
}

const approve: RequestAnswer = { label: "Approve", sends: { decision: "allow" } };
const revise: RequestAnswer = { label: "Revise", sends: { decision: "accept_with_changes" }, carries: "feedback" };
const decline: RequestAnswer = { label: "Decline", sends: { decision: "deny" } };
/** The three answers of R1 (C92), unchanged — most types are these over one body. */
const plain = (body: RequestBody): RequestBodyAnswers => ({ body, primary: approve, revise, decline });

/**
 * The table. Each row is §2.12's, column for column; where §2.12 gives two
 * words for one answer ("Approve / Reply", "`allow` / Keep Mine") the body
 * decides, so that row has two bodies.
 */
export const REQUEST_TYPE_TABLE: { readonly [T in RequestType]: RequestTypeSpec } = {
  question: {
    word: "question",
    bodies: [{ body: "choices", primary: { label: "Send Answers", sends: { decision: "answers" } }, revise, decline }],
  },
  pull_request: {
    word: "pull request",
    // Posted to GitHub as the owner, so the buttons use GitHub's words; no
    // Decline — the owner either reviews or leaves it for the source to clear.
    bodies: [
      {
        body: "diff",
        primary: { label: "Approve", sends: { door: "pr_review" }, carries: "feedback" },
        revise: { label: "Request Changes", sends: { door: "pr_review" }, carries: "feedback", required: true },
        decline: null,
      },
      {
        body: "thread",
        primary: { label: "Reply", sends: { door: "pr_review" }, carries: "feedback", required: true },
        revise: { label: "Request Changes", sends: { door: "pr_review" }, carries: "feedback", required: true },
        decline: null,
      },
    ],
  },
  access: {
    word: "access",
    bodies: [{ body: "before_after", primary: approve, revise: { label: "Revise", sends: { decision: "accept_with_changes" }, carries: "area" }, decline }],
  },
  action: { word: "action", bodies: [plain("preview")] },
  meeting: {
    word: "meeting",
    grouped: true,
    bodies: [
      {
        body: "todos",
        primary: { label: "Accept All", sends: { decision: "allow" } },
        revise,
        decline: { label: "Decline All", sends: { decision: "deny" } },
      },
    ],
  },
  review: {
    word: "review",
    // `preview` first: every review stored today is an artifact review whose
    // payload names no body. A knowledge conflict names `before_after` (T2-9)
    // and is settled at the Resolve a conflict door instead.
    bodies: [
      plain("preview"),
      {
        body: "before_after",
        primary: { label: "Keep Mine", sends: { door: "resolve_conflict" } },
        revise: { label: "Take the Other", sends: { door: "resolve_conflict" } },
        decline,
      },
    ],
  },
  note: { word: "note", bodies: [plain("preview")] },
  improvement: { word: "improvement", bodies: [plain("before_after")] },
  report: {
    word: "report",
    bodies: [{ body: "excerpt", primary: { label: null, sends: { door: "act" } }, revise: null, decline: { label: "Dismiss", sends: { decision: "skip" } } }],
  },
  invitation: {
    word: "invitation",
    bodies: [
      {
        body: "preview",
        primary: { label: "Accept", sends: { door: "rsvp" } },
        revise: { label: "Maybe", sends: { door: "rsvp" } },
        decline: { label: "Decline", sends: { door: "rsvp" } },
      },
    ],
  },
  task: {
    word: "task",
    bodies: [{ body: "excerpt", primary: { label: "Add to Today", sends: { door: "today" } }, revise: null, decline: { label: "Delegate", sends: { door: "delegate" } } }],
  },
  message: {
    word: "message",
    // "excerpt + reason": the reason is the ask's context (screen 3 §12.2, part 3), not a second body.
    bodies: [{ body: "excerpt", primary: { label: "Draft Reply", sends: { door: "draft" } }, revise: null, decline: { label: "Not Mine", sends: { decision: "skip" } } }],
  },
};

/**
 * Stored `proposals.kind` → type: every kind the product stores today, and
 * the ones §2.12 names for the types still to come. `meeting` has none — it
 * is a `group_id` over note, to-do and transcript rows (T1-8), never a kind.
 * C96's events are raised AS these kinds, not beside them: a failed routine is
 * a `report`, a knowledge conflict a `review`, a routine suggestion an
 * `improvement` (T2-9). A failed secret is the one that needs its own kind,
 * `secret_failure` — §2.12 lists it beside `access_request` and
 * `grant_elevation` as a third stored kind of access — because
 * `access_request`'s Approve is a grants write for the area it names, and a
 * secret names no area: raised as one, its Approve could only be refused.
 */
export const REQUEST_KIND_TYPE = {
  decision: "question",
  pull_request: "pull_request",
  access_request: "access",
  grant_elevation: "access",
  secret_failure: "access",
  action: "action",
  connection_call: "action",
  review: "review",
  knowledge: "note",
  draft_settle: "note",
  improvement: "improvement",
  report: "report",
  invitation: "invitation",
  task: "task",
  message: "message",
} as const satisfies Record<string, RequestType>;
export type RequestKind = keyof typeof REQUEST_KIND_TYPE;
export const REQUEST_KINDS: readonly RequestKind[] = Object.keys(REQUEST_KIND_TYPE) as RequestKind[];

/** What a kind this table does not know reads as — see the file header. */
export const UNKNOWN_KIND_TYPE: RequestType = "report";
/** ...and the body it renders. */
export const UNKNOWN_KIND_BODY: RequestBody = "excerpt";

export const isRequestKind = (kind: string): kind is RequestKind => Object.hasOwn(REQUEST_KIND_TYPE, kind);

/** The type a stored kind reads as; a kind this table does not know is a report. */
export function requestTypeOf(kind: string): RequestType {
  return isRequestKind(kind) ? REQUEST_KIND_TYPE[kind] : UNKNOWN_KIND_TYPE;
}

/** The word the owner reads for a stored kind — never the kind itself. */
export function requestWordOf(kind: string): string {
  return REQUEST_TYPE_TABLE[requestTypeOf(kind)].word;
}

/** The body a payload names (`payload.body.kind`), or null. A `body` that is a string (a report's text today) or has no `kind` names nothing. */
function namedBody(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = (payload as { body?: unknown }).body;
  if (typeof body !== "object" || body === null) return null;
  const kind = (body as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

/** The body and answers a known kind renders with, or null for a kind this table does not know. */
function bodyAnswersOf(kind: string, payload: unknown): RequestBodyAnswers | null {
  if (!isRequestKind(kind)) return null;
  const { bodies } = REQUEST_TYPE_TABLE[REQUEST_KIND_TYPE[kind]];
  const named = namedBody(payload);
  return bodies.find((b) => b.body === named) ?? bodies[0];
}

/** The body block a row renders: the one its payload names if its type draws it, else its type's first; a kind this table does not know renders an excerpt. */
export function requestBodyOf(kind: string, payload?: unknown): RequestBody {
  return bodyAnswersOf(kind, payload)?.body ?? UNKNOWN_KIND_BODY;
}

/** `payload.suggested_work` is what makes Approve mean Approve as Work (§1.4) — a flag, never a row. */
function suggestsWork(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && Object.hasOwn(payload, "suggested_work");
}

const sendsDecision = (a: RequestAnswer | null, d: RequestDecision): boolean => a !== null && "decision" in a.sends && a.sends.decision === d;

export interface RequestShape {
  readonly type: RequestType;
  readonly word: string;
  readonly body: RequestBody;
  readonly primary: RequestAnswer | null;
  readonly revise: RequestAnswer | null;
  readonly decline: RequestAnswer | null;
  readonly grouped: boolean;
  /** The decisions this row's answers store — what `POST /api/proposals/:id` may record for it, `later` aside. Doors are not listed: they are not decisions on the row. */
  readonly decisions: readonly RequestDecision[];
  /**
   * A question's questions (type `question` only): `payload.questions`, or a
   * row from before v2 read as its one pick-one question (`questionsOf`,
   * decision-block.ts). What Send Answers answers, one entry per question —
   * served here so no client keeps its own reading of the two shapes. A
   * question row that holds none has no Send Answers: `primary` is null and
   * `answers` is not among its decisions.
   */
  readonly questions?: readonly Question[];
}

/**
 * Everything a client needs to draw one row and offer its answers. Approve
 * sends `accept_as_work` where the payload suggests work (§1.4), and `allow`
 * stays valid beside it — §2.12's answer set makes both Approve's wire. A
 * question carries its questions, read from the payload. A kind this table
 * does not know is a report with no act: Dismiss is its only answer.
 */
export function describeRequest(kind: string, payload?: unknown): RequestShape {
  const type = requestTypeOf(kind);
  const spec = REQUEST_TYPE_TABLE[type];
  const at: RequestBodyAnswers = bodyAnswersOf(kind, payload) ?? { body: UNKNOWN_KIND_BODY, primary: null, revise: null, decline: spec.bodies[0].decline };
  const questions = type === "question" ? questionsOf(payload) : null;
  const asWork = suggestsWork(payload) && sendsDecision(at.primary, "allow");
  const primary: RequestAnswer | null =
    questions !== null && questions.length === 0 ? null : asWork && at.primary !== null ? { ...at.primary, sends: { decision: "accept_as_work" } } : at.primary;
  const decisions = new Set<RequestDecision>(asWork ? ["allow"] : []);
  for (const a of [primary, at.revise, at.decline]) if (a !== null && "decision" in a.sends) decisions.add(a.sends.decision);
  return {
    type,
    word: spec.word,
    body: at.body,
    primary,
    revise: at.revise,
    decline: at.decline,
    grouped: spec.grouped === true,
    decisions: REQUEST_DECISIONS.filter((d) => decisions.has(d)),
    ...(questions !== null ? { questions } : {}),
  };
}

// ----- the subject: what a request is ABOUT, and whether it moved (T2-14) -----
//
// A card never acts on something the owner didn't see (design-system
// amendments §9; plan §2.12, *Stale*). Most requests are about something that
// lives outside their row — a pull request's head, a task's line, the work row
// an action would change — and that thing can move while the card is open. So
// every row is served with a FINGERPRINT of its subject as it stands, the
// client sends back the one it rendered (`if_unchanged.subject`), and an answer
// whose fingerprint is not the subject's now is refused `409 stale` before
// anything is sent or settled (apps/console/src/server.ts, `decideProposal`).
//
// One basis per type, where the row can supply it:
//
//   pull_request → `head_sha`   the head the card shows: a new commit is a new question
//   task         → `line_text`  the task's own words, not its facets
//   any other    → `work_updated_at`, when the row names a work row (`work_id`)
//
// A pull request or a task whose own basis the row cannot supply falls back to
// its work row, and a row with neither has no subject: nothing to go stale.
// The narrow bases are deliberate — a comment on a PR moves its work row but
// not its head, and approving what the owner read is still approving it.
//
// WHERE each basis is read is the console's (the dependency arrow: no Postgres
// here). This file decides only which basis a row is judged by and what its
// fingerprint is.

/** The closed set of things a request's subject is fingerprinted by. */
export const REQUEST_SUBJECT_BASES = ["head_sha", "line_text", "work_updated_at"] as const;
export type RequestSubjectBasis = (typeof REQUEST_SUBJECT_BASES)[number];

/** A type's own basis (plan §2.12: PR head SHA, task line text). Every other type is judged by its work row, where it has one. */
export const REQUEST_TYPE_SUBJECT: { readonly [T in RequestType]?: Exclude<RequestSubjectBasis, "work_updated_at"> } = {
  pull_request: "head_sha",
  task: "line_text",
};

/**
 * The subject as the console read it, basis by basis. `undefined`: this row
 * cannot supply that basis (no work row, no head recorded). `null`: the row
 * names it and it is GONE — a deleted task line — which is a change like any
 * other, never a pass.
 */
export interface SubjectReading {
  readonly head_sha?: string | null;
  readonly line_text?: string | null;
  readonly work_updated_at?: string | null;
}

export interface RequestSubject {
  readonly basis: RequestSubjectBasis;
  /** Opaque to a client: rendered, sent back as `if_unchanged.subject`, compared — never parsed. */
  readonly fingerprint: string;
}

const GONE = "gone";

/** `<basis>:<32 hex>` — a hash, so a line's words and a head's SHA cross the wire only where the row already carries them — or `<basis>:gone`. */
export function subjectFingerprint(basis: RequestSubjectBasis, value: string | null): string {
  if (value === null) return `${basis}:${GONE}`;
  return `${basis}:${createHash("sha256").update(`${basis}\0${value}`).digest("hex").slice(0, 32)}`;
}

/** The subject a stored kind is judged by, from what the console read of it now; null when the row has none. */
export function requestSubjectOf(kind: string, reading: SubjectReading): RequestSubject | null {
  const own = REQUEST_TYPE_SUBJECT[requestTypeOf(kind)];
  const bases: RequestSubjectBasis[] = own === undefined ? ["work_updated_at"] : [own, "work_updated_at"];
  for (const basis of bases) {
    const value = reading[basis];
    if (value !== undefined) return { basis, fingerprint: subjectFingerprint(basis, value) };
  }
  return null;
}

const FINGERPRINT_RE = new RegExp(`^(${REQUEST_SUBJECT_BASES.join("|")}):([0-9a-f]{32}|${GONE})$`);

/**
 * `if_unchanged.subject` as a client may send it: a fingerprint this server
 * serves, or `null` for a row that was rendered with no subject. Anything else
 * is `undefined` — the caller's 400, never a comparison that happens to fail.
 */
export function parseSubjectFingerprint(v: unknown): string | null | undefined {
  if (v === null) return null;
  return typeof v === "string" && FINGERPRINT_RE.test(v) ? v : undefined;
}

/** Is the subject the client rendered (`seen`) still the subject now? A row that gained or lost one has changed too. */
export function subjectUnchanged(seen: string | null, now: RequestSubject | null): boolean {
  return seen === (now === null ? null : now.fingerprint);
}

const SQL_COLUMN = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
const SQL_WORD = /^[a-z][a-z_ ]*$/;

/**
 * The kind → word mapping as a SQL expression over `column`, for a named
 * query that must say the owner's word (seed/queries/pending_requests.yaml
 * carries this output verbatim; a test refuses any other text). It is
 * rendered from constants and still refuses anything but a bare column
 * reference and plain words — generated SQL is code.
 */
export function requestWordSql(column: string): string {
  if (!SQL_COLUMN.test(column)) throw new Error(`requestWordSql: ${JSON.stringify(column)} is not a column reference`);
  const lines = [`CASE ${column}`];
  for (const kind of REQUEST_KINDS) {
    const word = requestWordOf(kind);
    if (!SQL_WORD.test(kind) || !SQL_WORD.test(word)) throw new Error(`requestWordSql: ${JSON.stringify(kind)} → ${JSON.stringify(word)} is not a plain word`);
    lines.push(`  WHEN '${kind}' THEN '${word}'`);
  }
  lines.push(`  ELSE '${REQUEST_TYPE_TABLE[UNKNOWN_KIND_TYPE].word}'`, "END");
  return lines.join("\n");
}
