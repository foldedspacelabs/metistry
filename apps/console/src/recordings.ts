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
import { errorEnvelope, RECORDING_ID_RE, statusFor } from "@foldedspacelabs/metistry-core";
import type { QueryStore } from "@foldedspacelabs/metistry-queries";
import { sendJson } from "./http-util.js";

export { recordCaptureSession, RECORDING_ID_RE, transcriptOf, transcriptPath, type TranscriptCapture } from "@foldedspacelabs/metistry-core";

/** `GET /api/recordings/:id`. */
export const RECORDING_ROUTE = /^GET \/api\/recordings\/([^/]+)$/;

export const RECORDING_STATE_QUERY = "recording_state";

/** The principal a filed transcript is committed as: the owner's own recording. */
export const TRANSCRIPT_PRINCIPAL = "user";

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
