-- 0033_capture_sessions — a recording's retention state (design-build-plan
-- §2.9, §2.15; the owner's Q7 rulings; ticket T8-4).
--
-- A live-capture recording leaves two things behind: its audio, which stays
-- on the Mac under `.metistry/state/capture/<session>/` and never reaches
-- Postgres or git, and its transcript, which the recorder delivers through
-- `POST /capture` and the console files at `Journal/Transcripts/<date>-
-- <session>.md` (Q29, ruled 2026-09-30). The rule:
--
--   * the audio stays until the transcript is INGESTED — the meeting's
--     proposals decided, or the fold has read it — plus 7 days, and never
--     more than 30 days after the recording ended;
--   * the transcript stays 30 days after the recording ended.
--
-- One row per recording says where each part is in that life. The Mac's
-- recorder enforces the audio half on its own clock (the 30-day ceiling needs
-- nobody's word); the `recording-retention` routine reports ingestion to it,
-- stores what it answers, and deletes a transcript that is due — as a commit
-- in its own name through the reconciler, never a raw unlink (invariant 1).
-- `GET /api/recordings/:id` reads this table through `recording_state`.
--
--   id                     the recorder's session id (`20260928-120000-00ab`)
--   event_id               the calendar event the recording was of — set
--                          when a session is tied to a meeting (T8-5, T8-7)
--   started_at, ended_at   from the transcript's frontmatter
--   apps                   the owner's chosen apps (the recording's scope)
--   media_bytes            audio bytes the Mac still keeps; 0 once deleted
--   transcript_capture_id  the `inbox` row `POST /capture` answered with
--   transcript_path        where the transcript lives in the vault
--   folded_at              when the transcript was ingested (the routine
--                          derives it from the proposals' decisions; the fold
--                          may set it directly)
--   audio_deleted_at       when the Mac deleted the audio, as it reported it
--   audio_deleted_reason   `retention` (the rule) or `owner` (Purge Now)
--   transcript_deleted_at  when the routine deleted the transcript file
--
-- The plan reserved the first eight; `apps`, `transcript_path`,
-- `audio_deleted_reason`, `transcript_deleted_at` and `updated_at` are this
-- ticket's additions, all additive — what the retention door has to say and
-- where the purge has to look.
--
-- DURABILITY — DERIVED (invariant 1). The transcript is the record: its file
-- carries `capture_session`, `started_at`, `ended_at`, `apps` and
-- `media_bytes` in its frontmatter, and the routine rebuilds a missing row
-- from any file under `Journal/Transcripts/` on its next run; the audio's
-- state is the Mac's `session.json`, which the routine's report reads back.
-- After `docker compose down -v` the only thing lost is `folded_at` for a
-- transcript whose proposals went with the database — and the audio then
-- falls back to the 30-day ceiling, which the Mac enforces regardless. Nothing
-- here is backed up and nothing here needs to be.
--
-- ADDITIVE (CLAUDE.md): one new table, nothing rewritten; `IF NOT EXISTS`
-- throughout, so applying the file twice is a no-op the second time.
--
-- ROLLBACK NOTE: `DROP TABLE IF EXISTS capture_sessions;` — after reverting
-- the console's write on `POST /capture` (apps/console/src/recordings.ts),
-- the routine (`routines/recording-retention`) and `recording_state`. No
-- foreign key points in or out: a transcript capture's `inbox` row can be
-- triaged or deleted on its own schedule.

CREATE TABLE IF NOT EXISTS capture_sessions (
    id                     text        PRIMARY KEY,
    event_id               text,
    started_at             timestamptz NOT NULL,
    ended_at               timestamptz,
    apps                   text[]      NOT NULL DEFAULT '{}',
    media_bytes            bigint,
    transcript_capture_id  bigint,
    transcript_path        text,
    folded_at              timestamptz,
    audio_deleted_at       timestamptz,
    audio_deleted_reason   text,
    transcript_deleted_at  timestamptz,
    updated_at             timestamptz NOT NULL DEFAULT now()
);

-- The routine's two sweeps: sessions whose audio is not yet reported gone,
-- and transcripts not yet deleted — both small, both read once a run.
CREATE INDEX IF NOT EXISTS capture_sessions_audio_kept_idx ON capture_sessions (ended_at) WHERE audio_deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS capture_sessions_transcript_kept_idx ON capture_sessions (ended_at) WHERE transcript_deleted_at IS NULL;
