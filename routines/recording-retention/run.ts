// recording-retention — a live-capture recording kept to the owner's rulings
// (T8-4; plan §2.15, §4 Q6/Q7; C91; migration 0033).
//
//   AUDIO       on the Mac, under `.metistry/state/capture/<session>/`, until
//               the transcript is INGESTED plus 7 days, never more than 30
//               days after the recording ended.
//   TRANSCRIPT  at `Journal/Transcripts/<date>-<session>.md`, 30 days after
//               the recording ended.
//
// Who enforces what, and why this routine is not the only line:
//
//   * The audio lives on the Mac, and the Mac's recorder deletes it — on its
//     own hourly clock, by the same rule (helper/sources/kit/retention.swift).
//     The 30-day ceiling needs nobody's word, so a console that is down, a
//     database rebuilt with `down -v`, or this routine never running cannot
//     keep audio past it. What only this side knows is INGESTION, and this
//     routine reports it (`POST /recording/retention` on the live-capture
//     bridge, bridge token, never a tool): the recorder clamps the report to
//     its delivery and to now, so it can only bring a deletion forward to no
//     earlier than 7 days after the console took the transcript.
//   * The transcript is committed, and git is the record (invariant 1): it is
//     deleted as a COMMIT through the reconciler, in the owner's name — the
//     folder is the owner's at the tool (`isUserOwnedPath`), so no other
//     principal could — never by unlinking a file. Its words also sit in the
//     database: the capture's `inbox.note` and the inbox proposal's
//     `payload.note`. Those are cleared in the same pass, so "deleted" means
//     deleted everywhere this instance put it (git history keeps what git
//     keeps; see docs/ops/scheduled.md).
//
// INGESTED, today, is the owner deciding the transcript's proposals: every
// proposal raised from its inbox row decided — allowed, allowed with changes
// or denied, never merely expired — and none pending. That is "the meeting
// proposal group approved" of plan §2.15 for the one proposal a transcript
// raises now; T8-7's per-session group decides the same way. The fold may
// set `folded_at` itself when it reads a transcript, and this routine keeps
// the first value either wrote.
//
// Model-free (invariant 4). Silent when nothing is due: the count it returns
// is what it deleted.

import { RECORDING_ID_RE, recordCaptureSession, TRANSCRIPTS_DIR, transcriptOf } from "@foldedspacelabs/metistry-core";
import type { Db, RoutineCtx } from "../morning-brief/run.js";

/** The owner's rulings — the same numbers the recorder and `recording_state` use. */
export const TRANSCRIPT_KEEP_DAYS = 30; // limit: fixed — C91, the owner's ruling
/** The principal a transcript is filed and deleted as: the owner's own recording, in the owner's folder. */
export const RETENTION_PRINCIPAL = "user";

/** How many recordings one run reports to the Mac, and how many files it reads back. */
const MAX_PER_RUN = 200; // limit: fixed — an hourly run; a recording a day is thirty rows, and the rest wait an hour

/** What this routine needs of the vault bridge — the console's client has all three. */
export interface RetentionVault {
  read(path: string): Promise<{ content: Buffer; sha256: string } | null>;
  list(prefix: string, depth?: number): Promise<{ path: string; kind: "file" | "dir" }[]>;
  delete(path: string, intent: { principal: string; message: string; group?: string | undefined; run?: string | undefined }): Promise<unknown>;
}

/** The live-capture bridge, as the console knows it: its URL and the bridge token. */
export interface LiveCaptureDoor {
  url: string;
  token: string;
}

export interface RetentionCtx extends RoutineCtx {
  vault?: Partial<RetentionVault> | undefined;
  liveCapture?: LiveCaptureDoor | undefined;
  /** Injected by tests; production uses the database's clock for SQL and the wall clock for the rest. */
  now?: Date | undefined;
}

export interface RetentionPass {
  /** Rows rebuilt from transcript files the table did not have. */
  rebuilt: number;
  /** Recordings newly marked ingested. */
  ingested: number;
  /** Recordings the Mac reported its audio deleted for, this pass. */
  audio_deleted: number;
  /** Transcripts deleted from the vault, this pass. */
  transcripts_deleted: number;
  /** Why the audio half did not run, when it did not. */
  audio_skipped?: string;
  /** Per-recording failures, in words — the pass goes on past each. */
  errors: string[];
}

const vaultOf = (ctx: RetentionCtx): RetentionVault | undefined => {
  const v = ctx.vault;
  return v && typeof v.read === "function" && typeof v.list === "function" && typeof v.delete === "function" ? (v as RetentionVault) : undefined;
};

/**
 * 1. Rebuild. A transcript in the vault with no row (the database was
 * rebuilt, or the file came in by `git pull`) gets its row back from its own
 * frontmatter — so a rebuild can never leave a transcript no purge will find.
 * Only a file whose name is `<date>-<id>.md` for the id its frontmatter
 * declares is taken: a note someone else wrote into the folder is left alone.
 */
async function rebuild(db: Db, vault: RetentionVault, errors: string[]): Promise<number> {
  const entries = (await vault.list(TRANSCRIPTS_DIR, 1)).filter((e) => e.kind === "file" && e.path.endsWith(".md"));
  if (entries.length === 0) return 0;
  const known = new Set((await db.query(`SELECT transcript_path FROM capture_sessions WHERE transcript_path IS NOT NULL`)).rows.map((r) => String(r.transcript_path)));
  let n = 0;
  for (const e of entries.filter((x) => !known.has(x.path)).slice(0, MAX_PER_RUN)) {
    try {
      const file = await vault.read(e.path);
      const t = file ? transcriptOf(file.content.toString("utf8")) : undefined;
      if (!t || !e.path.endsWith(`-${t.session}.md`)) continue;
      await recordCaptureSession(db, t, { captureId: null, path: e.path });
      n += 1;
    } catch (err) {
      errors.push(`${e.path}: could not be read back (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return n;
}

/** 2. Ingestion, from the proposals' decisions (see the head of this file). The first value written stands. */
async function markIngested(db: Db): Promise<number> {
  const { rows } = await db.query(
    `UPDATE capture_sessions c
        SET folded_at = d.decided, updated_at = now()
       FROM (SELECT (payload->>'inbox_id')::bigint AS inbox_id,
                    max(decided_at) AS decided,
                    bool_or(decision = 'pending') AS pending,
                    bool_and(decision IN ('allow', 'deny', 'accept_with_changes')) AS decided_all
               FROM proposals
              WHERE payload->>'inbox_id' ~ '^[0-9]{1,18}$'
              GROUP BY 1) d
      WHERE c.folded_at IS NULL
        AND c.transcript_capture_id = d.inbox_id
        AND NOT d.pending AND d.decided_all AND d.decided IS NOT NULL
      RETURNING c.id`,
  );
  return rows.length;
}

/** What the bridge answers for one recording (packages/mcp-live-capture `retentionState`) — the fields kept. */
interface MacState {
  media_bytes?: number;
  audio_deleted_at?: string;
  audio_deleted_reason?: string;
}

/**
 * 3. The audio: report each recording whose audio is not yet known gone to
 * the Mac, and store what it answers. The Mac decides; this records.
 */
async function reportToMac(db: Db, door: LiveCaptureDoor, fetchFn: typeof fetch, errors: string[]): Promise<number> {
  const { rows } = await db.query(
    `SELECT id, folded_at FROM capture_sessions
      WHERE audio_deleted_at IS NULL AND ended_at IS NOT NULL
      ORDER BY ended_at LIMIT $1`,
    [MAX_PER_RUN],
  );
  const url = `${door.url.replace(/\/+$/, "")}/recording/retention`;
  let deleted = 0;
  for (const r of rows) {
    const id = String(r.id);
    if (!RECORDING_ID_RE.test(id)) continue;
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { authorization: `Bearer ${door.token}`, "content-type": "application/json" },
        body: JSON.stringify({ session_id: id, ingested_at: r.folded_at ? new Date(r.folded_at).toISOString() : null }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // The bridge is down: every other recording would say the same. The Mac keeps the ceiling regardless.
      errors.push(`the live-capture bridge did not answer at ${url} (${err instanceof Error ? err.message : String(err)}) — the Mac still deletes audio 30 days after a recording`);
      break;
    }
    if (res.status === 404) continue; // this Mac never had it (another Mac's recording, or its directory is gone)
    if (!res.ok) {
      errors.push(`recording ${id}: the live-capture bridge answered HTTP ${res.status}`);
      if (res.status === 401 || res.status === 403) break; // the token is wrong for all of them
      continue;
    }
    const s = (await res.json().catch(() => ({}))) as MacState;
    const bytes = typeof s.media_bytes === "number" && Number.isSafeInteger(s.media_bytes) && s.media_bytes >= 0 ? s.media_bytes : null;
    const at = typeof s.audio_deleted_at === "string" && !Number.isNaN(Date.parse(s.audio_deleted_at)) ? new Date(s.audio_deleted_at).toISOString() : null;
    const reason = s.audio_deleted_reason === "owner" || s.audio_deleted_reason === "retention" ? s.audio_deleted_reason : null;
    await db.query(
      `UPDATE capture_sessions
          SET media_bytes = CASE WHEN $2::timestamptz IS NULL THEN COALESCE($3::bigint, media_bytes) ELSE 0 END,
              audio_deleted_at = $2::timestamptz, audio_deleted_reason = $4, updated_at = now()
        WHERE id = $1 AND audio_deleted_at IS NULL`,
      [id, at, bytes, reason],
    );
    if (at) deleted += 1;
  }
  return deleted;
}

/**
 * 4. The transcript: every one past its 30 days, deleted as a commit in the
 * owner's name, then its words cleared from the inbox row and its proposals.
 * A vault that refuses leaves the row as it was, to try again next hour.
 */
async function deleteTranscripts(db: Db, vault: RetentionVault, now: Date, runId: number | undefined, errors: string[]): Promise<number> {
  const { rows } = await db.query(
    `SELECT id, transcript_path, transcript_capture_id, ended_at FROM capture_sessions
      WHERE transcript_deleted_at IS NULL AND transcript_path IS NOT NULL AND ended_at IS NOT NULL
        AND ended_at + make_interval(days => $1::int) <= $2::timestamptz
      ORDER BY ended_at LIMIT $3`,
    [TRANSCRIPT_KEEP_DAYS, now.toISOString(), MAX_PER_RUN],
  );
  let n = 0;
  for (const r of rows) {
    const path = String(r.transcript_path);
    // Only a path in the transcripts folder, for this recording — whatever the row says.
    if (!path.startsWith(`${TRANSCRIPTS_DIR}/`) || !path.endsWith(`-${String(r.id)}.md`) || path.includes("..")) {
      errors.push(`recording ${String(r.id)}: its transcript path ${JSON.stringify(path)} is not in ${TRANSCRIPTS_DIR}/ — left alone`);
      continue;
    }
    try {
      await vault.delete(path, {
        principal: RETENTION_PRINCIPAL,
        message: `retention: delete the transcript of recording ${String(r.id)}, ${TRANSCRIPT_KEEP_DAYS} days after it ended (Q7)`,
        group: "recording-retention",
        // the §2.21 act key: every transcript one run deletes is one commit
        ...(runId !== undefined ? { run: String(runId) } : {}),
      });
    } catch (err) {
      errors.push(`recording ${String(r.id)}: the vault would not delete ${path} (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const gone = `(transcript deleted ${now.toISOString().slice(0, 10)}, ${TRANSCRIPT_KEEP_DAYS} days after the recording)`;
    if (r.transcript_capture_id !== null && r.transcript_capture_id !== undefined) {
      await db.query(`UPDATE inbox SET note = $2 WHERE id = $1`, [r.transcript_capture_id, gone]);
      await db.query(
        `UPDATE proposals SET payload = jsonb_set(payload, '{note}', to_jsonb($2::text))
          WHERE payload->>'inbox_id' = $1::text AND payload ? 'note'`,
        [String(r.transcript_capture_id), gone],
      );
    }
    await db.query(`UPDATE capture_sessions SET transcript_deleted_at = $2, updated_at = now() WHERE id = $1`, [r.id, now.toISOString()]);
    n += 1;
  }
  return n;
}

/** One pass, with its story — what the scheduled run counts and a test reads. */
export async function retentionPass(db: Db, ctx: RetentionCtx = {}): Promise<RetentionPass> {
  const now = ctx.now ?? new Date();
  const errors: string[] = [];
  const vault = vaultOf(ctx);
  const rebuilt = vault ? await rebuild(db, vault, errors) : 0;
  const ingested = await markIngested(db);
  let audioDeleted = 0;
  let skipped: string | undefined;
  if (ctx.liveCapture?.url && ctx.liveCapture.token) {
    audioDeleted = await reportToMac(db, ctx.liveCapture, ctx.fetchFn ?? fetch, errors);
  } else {
    skipped = "no live-capture bridge (METISTRY_LIVE_CAPTURE_URL, METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE) — the Mac deletes audio on its own clock, 30 days after a recording at the latest";
  }
  const transcripts = vault ? await deleteTranscripts(db, vault, now, ctx.runId, errors) : 0;
  if (!vault) errors.push("no vault bridge — transcripts past their 30 days are kept until it is back");
  return { rebuilt, ingested, audio_deleted: audioDeleted, transcripts_deleted: transcripts, ...(skipped ? { audio_skipped: skipped } : {}), errors };
}

/** The scheduled run: what it deleted (0 = silent). Failures are said, never thrown past the pass. */
export async function run(db: Db, ctx: RetentionCtx = {}): Promise<number> {
  const pass = await retentionPass(db, ctx);
  for (const e of pass.errors) console.warn(`recording-retention: ${e}`);
  return pass.audio_deleted + pass.transcripts_deleted;
}
