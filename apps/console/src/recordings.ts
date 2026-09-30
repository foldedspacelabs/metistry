// A recording's transcript and its retention state, the console's half (plan
// §2.15, T8-4; the owner's ruling on W3 question 29).
//
// TWO DOORS, ONE TABLE (`capture_sessions`, migration 0033):
//
//   * `POST /capture` — when the live-capture bridge delivers a recording's
//     transcript (Markdown with `kind: transcript` frontmatter, T8-2b), the
//     console files it at `Journal/Transcripts/<date>-<session>.md` instead
//     of `Inbox/`, in the OWNER's name — it is the owner's own recording, and
//     `Journal/` is the owner's at the tool, so no agent can ever edit one —
//     and records the session's row. Only an owner credential's capture is
//     placed: an agent bearer that sends the same frontmatter lands in
//     `Inbox/` like any other capture, as `capture`, and records nothing.
//   * `GET /api/recordings/:id` — the owner's read of that row, through the
//     `recording_state` named query (invariant 3), which also computes the
//     dates the rule gives: audio until ingested + 7 days, never over 30;
//     transcript 30 days.
//
// The rule is ENFORCED elsewhere: the Mac's recorder deletes the audio on its
// own clock (packages/mcp-live-capture/helper/sources/kit/retention.swift),
// and the `recording-retention` routine reports ingestion to it and deletes
// a due transcript through the reconciler (routines/recording-retention).
// Nothing here deletes anything.

import type { ServerResponse } from "node:http";
import { calendarDate, errorEnvelope, profileFrontmatter, statusFor, TRANSCRIPTS_DIR } from "@foldedspacelabs/metistry-core";
import type { QueryStore } from "@foldedspacelabs/metistry-queries";
import { sendJson } from "./http-util.js";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** A recorder session id: lowercase letters, digits and hyphens (the recorder's own check), never a path. */
export const RECORDING_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `GET /api/recordings/:id`. */
export const RECORDING_ROUTE = /^GET \/api\/recordings\/([^/]+)$/;

export const RECORDING_STATE_QUERY = "recording_state";

/** What a transcript capture says about its session, from its frontmatter. */
export interface TranscriptCapture {
  session: string;
  startedAt: Date;
  endedAt: Date | null;
  apps: string[];
  mediaBytes: number | null;
}

// limit: fixed — the record sheet's own cap on chosen apps (packages/mcp-live-capture MAX_SCOPE_APPS)
const MAX_APPS = 16;

/**
 * The session a capture's frontmatter declares, or undefined when it is not
 * a recording's transcript: `kind: transcript`, `source: live-capture`, a
 * `capture_session` that is a recorder id and a `started_at` that is an
 * instant. Anything short of all four is an ordinary capture.
 */
export function transcriptOf(note: string | null | undefined): TranscriptCapture | undefined {
  const fm = profileFrontmatter(note ?? null);
  if (!fm || fm.kind !== "transcript" || fm.source !== "live-capture") return undefined;
  const session = typeof fm.capture_session === "string" ? fm.capture_session : "";
  if (!RECORDING_ID_RE.test(session)) return undefined;
  const started = typeof fm.started_at === "string" ? new Date(fm.started_at) : undefined;
  if (!started || Number.isNaN(started.getTime())) return undefined;
  const endedRaw = typeof fm.ended_at === "string" && fm.ended_at !== "" ? new Date(fm.ended_at) : null;
  const endedAt = endedRaw && !Number.isNaN(endedRaw.getTime()) ? endedRaw : null;
  const apps = (typeof fm.apps === "string" ? fm.apps.split(",") : [])
    .map((a) => a.trim())
    .filter((a) => /^[A-Za-z0-9.-]{1,255}$/.test(a))
    .slice(0, MAX_APPS);
  const bytes = typeof fm.media_bytes === "string" && /^\d{1,15}$/.test(fm.media_bytes) ? Number(fm.media_bytes) : typeof fm.media_bytes === "number" && Number.isSafeInteger(fm.media_bytes) && fm.media_bytes >= 0 ? fm.media_bytes : null;
  return { session, startedAt: started, endedAt, apps, mediaBytes: bytes };
}

/** `Journal/Transcripts/<date>-<session>.md` — the day it started, in the owner's zone (the Journal's days are the owner's). */
export function transcriptPath(t: TranscriptCapture, timeZone?: string | null): string {
  return `${TRANSCRIPTS_DIR}/${calendarDate(t.startedAt, timeZone || "UTC")}-${t.session}.md`;
}

/** The principal a filed transcript is committed as: the owner's own recording. */
export const TRANSCRIPT_PRINCIPAL = "user";

/**
 * The session's row, from its transcript capture. Idempotent — a redelivery
 * (the same `Idempotency-Key`) refines the row, never duplicates it — and it
 * never clears what the routine has since learned (ingestion, deletions).
 */
export async function recordCaptureSession(db: Db, t: TranscriptCapture, filed: { captureId: number | null; path: string }): Promise<void> {
  await db.query(
    `INSERT INTO capture_sessions (id, started_at, ended_at, apps, media_bytes, transcript_capture_id, transcript_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       ended_at = COALESCE(EXCLUDED.ended_at, capture_sessions.ended_at),
       apps = CASE WHEN cardinality(EXCLUDED.apps) > 0 THEN EXCLUDED.apps ELSE capture_sessions.apps END,
       media_bytes = CASE WHEN capture_sessions.audio_deleted_at IS NULL THEN COALESCE(EXCLUDED.media_bytes, capture_sessions.media_bytes) ELSE capture_sessions.media_bytes END,
       transcript_capture_id = COALESCE(EXCLUDED.transcript_capture_id, capture_sessions.transcript_capture_id),
       transcript_path = COALESCE(EXCLUDED.transcript_path, capture_sessions.transcript_path),
       updated_at = now()`,
    [t.session, t.startedAt.toISOString(), t.endedAt?.toISOString() ?? null, t.apps, t.mediaBytes, filed.captureId, filed.path],
  );
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * `GET /api/recordings/:id` → one recording's retention state. The shape is
 * the frozen contract's (client-api.md, the Mac's `RecordingState`), with
 * what the retention door has to say beside it: the transcript's own dates
 * and the audio's size and why it went.
 */
export async function recordingRoute(res: ServerResponse, queries: QueryStore, id: string): Promise<void> {
  if (!RECORDING_ID_RE.test(id)) return void sendJson(res, statusFor("invalid_request"), errorEnvelope("invalid_request", "a recording id is lowercase letters, digits and hyphens"));
  if (!queries.names().includes(RECORDING_STATE_QUERY)) {
    return void sendJson(res, statusFor("not_available"), errorEnvelope("not_available", `the named query ${RECORDING_STATE_QUERY} is not loaded (seed/queries/${RECORDING_STATE_QUERY}.yaml, METISTRY_QUERIES_DIRS)`));
  }
  const result = await queries.run(RECORDING_STATE_QUERY, { id });
  const r = result.rows[0] as Record<string, unknown> | undefined;
  if (!r) return void sendJson(res, statusFor("not_found"), errorEnvelope("not_found", `no recording ${id}`));
  const deletedAt = iso(r.audio_deleted_at);
  sendJson(res, 200, {
    id: String(r.id),
    event_id: typeof r.event_id === "string" ? r.event_id : null,
    started_at: iso(r.started_at),
    ended_at: iso(r.ended_at),
    // T8-2b records audio only (a process tap and the microphone); Window and Screen are T8-3's
    scope: { kind: "audio_only", apps: Array.isArray(r.apps) ? r.apps.map(String) : [] },
    transcript: {
      path: typeof r.transcript_path === "string" ? r.transcript_path : null,
      ingested_at: iso(r.ingested_at),
      delete_after: iso(r.transcript_delete_after),
      deleted_at: iso(r.transcript_deleted_at),
    },
    audio: {
      kept: deletedAt === null,
      bytes: deletedAt === null && r.media_bytes !== null && r.media_bytes !== undefined ? Number(r.media_bytes) : 0,
      delete_after: iso(r.audio_delete_after),
      deleted_at: deletedAt,
      deleted_reason: typeof r.audio_deleted_reason === "string" ? r.audio_deleted_reason : null,
    },
    as_of: result.as_of.toISOString(),
  });
}
