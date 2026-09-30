// A recording's transcript, as a capture declares it (T8-4, plan §2.15; the
// owner's ruling on W3 question 29). The live-capture bridge delivers a
// transcript through `POST /capture` as Markdown with frontmatter it writes
// itself (packages/mcp-live-capture `renderTranscript`); the console files it
// at `Journal/Transcripts/<date>-<session>.md`, and the `recording-retention`
// routine reads the same frontmatter back from the vault to rebuild a
// recording's row (migration 0033 is derived). One reader, here, for both.

import { TRANSCRIPTS_DIR } from "./instance-layout.js";
import { profileFrontmatter } from "./scheduled.js";
import { calendarDate } from "./task-line.js";

/** A recorder session id: lowercase letters, digits and hyphens (the recorder's own check), never a path. */
export const RECORDING_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

/** What the row writer needs of a database — the routines' and the console's `Db` alike. */
export interface TranscriptDb {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * A recording's `capture_sessions` row (migration 0033), from its transcript:
 * the console's `POST /capture` when it files one, and the retention routine
 * when it rebuilds a row from a file in the vault (`captureId` null). A
 * redelivery refines the row, never duplicates it, and nothing here clears
 * what the routine has since learned (ingestion, deletions).
 */
export async function recordCaptureSession(db: TranscriptDb, t: TranscriptCapture, filed: { captureId: number | null; path: string }): Promise<void> {
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

