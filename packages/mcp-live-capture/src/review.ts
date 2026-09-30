// Retention and re-review, the bridge's half (T8-4, plan §2.15, Q7). The
// rule itself lives in the helper (helper/sources/kit/retention.swift), on
// the machine that holds the audio; this file is the three doors onto it and
// the shape of what comes back.
//
//   recording_review   GET /recording/review — a TOOL (manifest `exposes`),
//                      read-only. Re-transcribes a span and answers TEXT with
//                      timestamps: the answer is rebuilt here from known
//                      fields only — a source word, two numbers and a string
//                      per line — so nothing the helper might add (a path, a
//                      buffer, a base64 blob) can ride out to a model. After
//                      the audio is deleted it says when, and that the
//                      transcript remains.
//   retention          POST /recording/retention — NOT a tool: the console's
//                      recording-retention routine reports when a transcript
//                      was ingested; the helper clamps it and applies the rule.
//                      It can only bring a deletion forward, never past the
//                      helper's own 30-day ceiling, and never earlier than 7
//                      days after the console took the transcript.
//   purge              POST /recording/purge — Purge Now, the owner's hand
//                      (the control credential only).
//
// Who may call recording_review is decided upstream as well as here: it is in
// core's CREW_NEVER_TOOLS, so no crew's `uses` can ever name it.

import { clock } from "./delivery.js";
import type { HelperResponse } from "./helper.js";

/** A recorder session id, as the helper names its directories: lowercase, digits, hyphens. */
export const SESSION_ID_RE = /^[a-z0-9-]{1,64}$/;

/** The longest span one review re-reads — the helper's own cap (retention.swift `maxReviewSpanS`), checked here first. */
export const MAX_REVIEW_SPAN_S = 15 * 60; // limit: fixed — matched by the helper; a review answers "what exactly was said there", minutes around a moment

/** A question the caller is asking of the span: echoed back beside the text, never sent to the helper. */
export const MAX_QUESTION_CHARS = 500; // limit: fixed — a question about a moment, not a document

/** One re-read line's text. */
const MAX_LINE_CHARS = 4000; // limit: fixed — a transcriber segment is a sentence or two; this only stops a runaway

export type ReviewQuery =
  | { ok: true; payload: { op: "review"; session_id: string; from_s: number; to_s: number }; question?: string }
  | { ok: false; message: string };

/** `?session_id=&from_s=&to_s=&question=` → the helper's request, rebuilt from those four and nothing else. */
export function reviewQuery(params: URLSearchParams): ReviewQuery {
  const unknown = [...new Set(params.keys())].filter((k) => !["session_id", "from_s", "to_s", "question"].includes(k));
  if (unknown.length > 0) return { ok: false, message: `unknown parameter${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}` };
  for (const k of ["session_id", "from_s", "to_s", "question"]) {
    if (params.getAll(k).length > 1) return { ok: false, message: `${k} is given once` };
  }
  const session = params.get("session_id") ?? "";
  if (!SESSION_ID_RE.test(session)) return { ok: false, message: "session_id is a recording's id (lowercase letters, digits, hyphens)" };
  const num = (k: string) => {
    const raw = params.get(k);
    if (raw === null || !/^\d+(\.\d+)?$/.test(raw)) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const from = num("from_s");
  const to = num("to_s");
  if (from === undefined || to === undefined) return { ok: false, message: "from_s and to_s are seconds from Record (non-negative numbers)" };
  if (to <= from) return { ok: false, message: "from_s comes before to_s" };
  if (to - from > MAX_REVIEW_SPAN_S) return { ok: false, message: `a review re-reads at most ${MAX_REVIEW_SPAN_S / 60} minutes at a time` };
  const question = params.get("question");
  if (question !== null && (question.trim() === "" || question.length > MAX_QUESTION_CHARS)) {
    return { ok: false, message: `question is 1–${MAX_QUESTION_CHARS} characters` };
  }
  return {
    ok: true,
    payload: { op: "review", session_id: session, from_s: from, to_s: to },
    ...(question !== null ? { question: question.trim() } : {}),
  };
}

/** One line of a review answer: text, where it was said, and who (the chosen apps, or the owner). */
export interface ReviewLine {
  source: "app" | "mic";
  speaker: "apps" | "you";
  from_s: number;
  to_s: number;
  /** `00:02:40` — the same clock the transcript's lines are stamped with. */
  at: string;
  text: string;
}

/** What `recording_review` answers: text only. */
export interface ReviewAnswer {
  session_id: string;
  from_s: number;
  to_s: number;
  question?: string;
  audio: "kept" | "deleted";
  lines: ReviewLine[];
  /** The lines as one block, the transcript's own format. Empty when there are none. */
  text: string;
  /** Present when the audio is gone, and when nothing was heard: in the owner's words. */
  note?: string;
  audio_deleted_at?: string;
  as_of: string;
}

const SPEAKER = { app: "apps", mic: "you" } as const;

/** Seconds to the hundredth — the helper's own precision; a double's tail (1.9199999999999999) is noise to a reader. */
function cents(s: number): number {
  return Math.round(s * 100) / 100;
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isoOrUndefined(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** `2026-10-05`, as the note says it. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Why the audio is gone, in the owner's words — the plan's sentence when the
 * fold (or the meeting's proposals) came first, the ceiling's or Purge Now's
 * otherwise. The transcript is the one in the vault; whether IT remains is
 * said too, because after 30 days it does not.
 */
export function deletedNote(session: Record<string, unknown>): { at: string | undefined; note: string } {
  const at = isoOrUndefined(session.audio_deleted_at);
  const on = at ? ` on ${day(at)}` : "";
  const why =
    session.audio_deleted_reason === "owner"
      ? " by Purge Now"
      : isoOrUndefined(session.ingested_at)
        ? " after the fold"
        : " 30 days after the recording";
  const transcriptGone = isoOrUndefined(session.transcript_deleted_at);
  const remains = transcriptGone ? `; the transcript was deleted on ${day(transcriptGone)}` : "; the transcript remains";
  return { at, note: `Audio deleted${on}${why}${remains}.` };
}

/**
 * The helper's answer → what a model may see. Rebuilt field by field: a
 * line is kept only when its source is one of the two words, its times are
 * numbers and its text is a string; anything else on it — or on the answer —
 * is dropped. Text never audio (plan §2.15).
 */
export function reviewAnswer(r: HelperResponse, asked: { session_id: string; from_s: number; to_s: number; question?: string }, now = new Date()): ReviewAnswer {
  const base = {
    session_id: asked.session_id,
    from_s: asked.from_s,
    to_s: asked.to_s,
    ...(asked.question !== undefined ? { question: asked.question } : {}),
  };
  if (r.audio === "deleted") {
    const session = (typeof r.session === "object" && r.session !== null ? r.session : {}) as Record<string, unknown>;
    const { at, note } = deletedNote(session);
    return { ...base, audio: "deleted", lines: [], text: "", note, ...(at ? { audio_deleted_at: at } : {}), as_of: now.toISOString() };
  }
  const raw = Array.isArray(r.lines) ? (r.lines as unknown[]) : [];
  const lines: ReviewLine[] = [];
  for (const l of raw) {
    if (typeof l !== "object" || l === null) continue;
    const { source, from_s, to_s, text } = l as Record<string, unknown>;
    if ((source !== "app" && source !== "mic") || !finite(from_s) || !finite(to_s) || typeof text !== "string") continue;
    const clean = text.replace(/\s*\n\s*/g, " ").trim().slice(0, MAX_LINE_CHARS);
    if (clean === "") continue;
    lines.push({ source, speaker: SPEAKER[source], from_s: cents(from_s), to_s: cents(to_s), at: clock(from_s), text: clean });
  }
  lines.sort((a, b) => a.from_s - b.from_s || a.source.localeCompare(b.source)); // in time order, whatever order the helper wrote them
  const text = lines.map((l) => `[${l.at}] (${l.speaker}) ${l.text}`).join("\n");
  return {
    ...base,
    audio: "kept",
    lines,
    text,
    ...(lines.length === 0 ? { note: "Nothing was heard in that span." } : {}),
    as_of: now.toISOString(),
  };
}

/** The retention fields of a helper record — what the console's routine stores. Never transcript text. */
export interface RetentionState {
  session_id: string;
  started_at?: string;
  ended_at?: string;
  media_bytes: number;
  ingested_at?: string;
  audio_delete_after?: string;
  audio_deleted_at?: string;
  audio_deleted_reason?: "retention" | "owner";
  transcript_delete_after?: string;
  transcript_deleted_at?: string;
  delivered_inbox_id?: number;
}

export function retentionState(r: HelperResponse): RetentionState | undefined {
  const s = r.session;
  if (typeof s !== "object" || s === null) return undefined;
  const o = s as Record<string, unknown>;
  if (typeof o.session_id !== "string" || !SESSION_ID_RE.test(o.session_id)) return undefined;
  const out: RetentionState = { session_id: o.session_id, media_bytes: finite(o.media_bytes) && o.media_bytes >= 0 ? Math.floor(o.media_bytes) : 0 };
  for (const k of ["started_at", "ended_at", "ingested_at", "audio_delete_after", "audio_deleted_at", "transcript_delete_after", "transcript_deleted_at"] as const) {
    const v = isoOrUndefined(o[k]);
    if (v) out[k] = v;
  }
  if (o.audio_deleted_reason === "retention" || o.audio_deleted_reason === "owner") out.audio_deleted_reason = o.audio_deleted_reason;
  const inbox = (o.delivery as { inbox_id?: unknown } | null | undefined)?.inbox_id;
  if (typeof inbox === "number" && Number.isInteger(inbox) && inbox > 0) out.delivered_inbox_id = inbox;
  return out;
}

export type RetentionBody =
  | { ok: true; payload: { op: "retention"; session_id: string; ingested_at: string | null } }
  | { ok: false; message: string };

/** The routine's report, rebuilt from `{session_id, ingested_at?}` and nothing else. */
export function retentionBody(body: unknown): RetentionBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, message: "the body is an object: {session_id, ingested_at?}" };
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !["session_id", "ingested_at"].includes(k));
  if (unknown.length > 0) return { ok: false, message: `unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}` };
  if (typeof b.session_id !== "string" || !SESSION_ID_RE.test(b.session_id)) return { ok: false, message: "session_id is a recording's id" };
  let ingested: string | null = null;
  if (b.ingested_at !== undefined && b.ingested_at !== null) {
    const iso = isoOrUndefined(b.ingested_at);
    if (!iso) return { ok: false, message: "ingested_at is an ISO 8601 instant, or null" };
    ingested = iso;
  }
  return { ok: true, payload: { op: "retention", session_id: b.session_id, ingested_at: ingested } };
}

export type PurgeBody = { ok: true; payload: { op: "purge"; session_id: string } } | { ok: false; message: string };

/** Purge Now's body: `{session_id}` and nothing else. */
export function purgeBody(body: unknown): PurgeBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, message: "the body is an object: {session_id}" };
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => k !== "session_id");
  if (unknown.length > 0) return { ok: false, message: `unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}` };
  if (typeof b.session_id !== "string" || !SESSION_ID_RE.test(b.session_id)) return { ok: false, message: "session_id is a recording's id" };
  return { ok: true, payload: { op: "purge", session_id: b.session_id } };
}
