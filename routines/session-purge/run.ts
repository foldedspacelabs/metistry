// session-purge — the session archive's retention (T3-9; migration 0030,
// §4 Q16, screen-12 §4 "Keep sessions — 30 days").
//
// The archive is EPHEMERAL (invariant 1): a 30-day cache of the working
// conversation, lost on `down -v` by design. The engine sets every row's
// `expires_at` 30 days out when it writes it (apps/assistant/src/archive.ts);
// `session_detail` already hides a row past it. This routine is what makes
// "hidden" into "gone":
//
//   * every turn past its `expires_at` — the ruling's ceiling, which needs no
//     configuration; and
//   * every turn older than `retention_days` — the routine's Scheduled config
//     (§2.5: retention is set through the Scheduled doors like every other
//     routine setting), 1 to 30, default 30. Shorter is the owner's choice;
//     longer is refused, because a row past `expires_at` is one no reader can
//     see, and keeping it would be keeping nothing.
//
// Expiry wins over the fold's queue: an unfolded turn (`folded_at IS NULL`)
// is deleted like any other once it is due. The fold (T3-10) must read a
// session BEFORE it expires (screen-12 §5.4) — a purge that spared unfolded
// rows would make a stopped fold into an archive that never empties. What
// the purge cut unread is counted, so the loss is visible rather than silent.
//
// Purge Now (`POST /api/sessions/purge`, reach `local`) is the same delete
// on demand, through `purgePreview` + `purgeArchive` below: the console's
// door answers with the preview first — the sessions not yet folded, so the
// confirm can name them and offer Fold First (C136) — and deletes only on an
// explicit confirm.
//
// Model-free. Never touches the vault or git: the archive lives in Postgres
// only, and what is worth keeping from it leaves through the fold.

import type { Db, RoutineCtx } from "../morning-brief/run.js";

/** The ruling's ceiling, and the default (§4 Q16). The engine's `expires_at` is the same 30 days. */
export const MAX_RETENTION_DAYS = 30; // limit: fixed — the owner's ruling; `session_detail` hides a row past its expires_at, so a longer retention would keep nothing anyone can read
export const DEFAULT_RETENTION_DAYS = MAX_RETENTION_DAYS;
export const MIN_RETENTION_DAYS = 1; // limit: fixed — a whole day is the shortest retention a daily purge can keep honestly

/** The config key, as scheduled.yaml's `routines.session-purge.config` carries it (snake_case, §2.5). */
export const RETENTION_KEY = "retention_days";

/** How many unfolded sessions a preview names. The count is always exact; the list is what a confirm can show. */
export const PREVIEW_SESSIONS = 50; // limit: fixed — a confirm dialog names sessions, it does not page through them; `sessions_unfolded` is the exact count

export interface SessionPurgeCtx extends RoutineCtx {
  /**
   * The routine's resolved Scheduled config (manifest ⊕ `.metistry/scheduled.yaml`,
   * §2.5), handed on per run by the runner (T3-3). Absent — a caller that
   * passes none — the default applies, which is the ruling.
   */
  config?: Record<string, unknown> | undefined;
}

/**
 * `retention_days` from the routine's config, or the default. A value that
 * is not a whole number of days from 1 to 30 is REFUSED with the field
 * named — never clamped, and never read as "keep everything" or "keep
 * nothing": a purge that guessed would either delete what the owner meant to
 * keep or keep what the ruling says must go.
 */
export function retentionDays(config?: Record<string, unknown>): number {
  const v = config?.[RETENTION_KEY];
  if (v === undefined) return DEFAULT_RETENTION_DAYS;
  if (typeof v !== "number" || !Number.isInteger(v) || v < MIN_RETENTION_DAYS || v > MAX_RETENTION_DAYS) {
    throw new Error(
      `session-purge: config.${RETENTION_KEY} is ${JSON.stringify(v)} — it must be a whole number of days from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS} ` +
        `(routines.session-purge.config in .metistry/scheduled.yaml); nothing was purged`,
    );
  }
  return v;
}

export interface PurgeCounts {
  /** Distinct sessions with at least one turn deleted. */
  sessions: number;
  /** Turns (rows) deleted. */
  turns: number;
  /** Of those sessions, how many had a turn the fold had not yet read and could still have read (unfolded, not yet expired). */
  sessions_unfolded: number;
}

const counts = (row: any): PurgeCounts => ({
  sessions: Number(row?.sessions ?? 0),
  turns: Number(row?.turns ?? 0),
  sessions_unfolded: Number(row?.sessions_unfolded ?? 0),
});

/**
 * The scheduled purge: past `expires_at`, or older than `retentionDays`.
 * One statement, so the counts are of exactly the rows it deleted.
 */
export async function purgeExpired(db: Db, retention: number): Promise<PurgeCounts> {
  const { rows } = await db.query(
    `WITH gone AS (
       DELETE FROM session_archive
       WHERE expires_at <= now() OR ts < now() - make_interval(days => $1::int)
       RETURNING session_id, folded_at, expires_at
     )
     SELECT count(DISTINCT session_id) AS sessions,
            count(*) AS turns,
            count(DISTINCT session_id) FILTER (WHERE folded_at IS NULL AND expires_at > now()) AS sessions_unfolded
     FROM gone`,
    [retention],
  );
  return counts(rows[0]);
}

/** One session the fold has not finished with — what Purge Now's confirm names. */
export interface UnfoldedSession {
  session_id: string;
  thread: string;
  turns: number;
  unfolded_turns: number;
  first_ts: string;
  last_ts: string;
}

export interface PurgePreview {
  /** What a purge now would delete: every archived session and turn, expired or not. */
  sessions: number;
  turns: number;
  /** Exact count of sessions with a turn the fold has not read and still could (unfolded, not expired). */
  sessions_unfolded: number;
  /** The newest of them, at most PREVIEW_SESSIONS. */
  unfolded: UnfoldedSession[];
  /** The database's clock when the preview was read — pass it back as `as_of` so the purge deletes exactly what was counted, and nothing newer. */
  as_of: string;
}

/**
 * What Purge Now would cost, without deleting anything: every session and
 * turn in the archive, and — named — the sessions not yet folded, so the
 * confirm can say what learning is lost and offer Fold First (C136).
 */
export async function purgePreview(db: Db): Promise<PurgePreview> {
  const totals = await db.query(
    `SELECT count(DISTINCT session_id) AS sessions, count(*) AS turns,
            count(DISTINCT session_id) FILTER (WHERE folded_at IS NULL AND expires_at > now()) AS sessions_unfolded,
            now() AS as_of
     FROM session_archive`,
  );
  const list = await db.query(
    `SELECT session_id::text AS session_id, min(thread) AS thread, count(*) AS turns,
            count(*) FILTER (WHERE folded_at IS NULL AND expires_at > now()) AS unfolded_turns,
            min(ts) AS first_ts, max(ts) AS last_ts
     FROM session_archive
     GROUP BY session_id
     HAVING count(*) FILTER (WHERE folded_at IS NULL AND expires_at > now()) > 0
     ORDER BY max(ts) DESC
     LIMIT $1`,
    [PREVIEW_SESSIONS],
  );
  const t = totals.rows[0] ?? {};
  return {
    sessions: Number(t.sessions ?? 0),
    turns: Number(t.turns ?? 0),
    sessions_unfolded: Number(t.sessions_unfolded ?? 0),
    unfolded: list.rows.map((r) => ({
      session_id: String(r.session_id),
      thread: String(r.thread),
      turns: Number(r.turns),
      unfolded_turns: Number(r.unfolded_turns),
      first_ts: new Date(r.first_ts).toISOString(),
      last_ts: new Date(r.last_ts).toISOString(),
    })),
    as_of: new Date(t.as_of ?? Date.now()).toISOString(),
  };
}

/**
 * Purge Now: every archived turn, folded or not, expired or not — at or
 * before `asOf` when the caller passes the preview's `as_of`, so a turn
 * archived between the confirm being shown and being pressed is not deleted
 * unseen. Irreversible; the door that calls this confirms first.
 */
export async function purgeArchive(db: Db, asOf?: Date): Promise<PurgeCounts> {
  const { rows } = await db.query(
    `WITH gone AS (
       DELETE FROM session_archive
       WHERE $1::timestamptz IS NULL OR ts <= $1::timestamptz
       RETURNING session_id, folded_at, expires_at
     )
     SELECT count(DISTINCT session_id) AS sessions,
            count(*) AS turns,
            count(DISTINCT session_id) FILTER (WHERE folded_at IS NULL AND expires_at > now()) AS sessions_unfolded
     FROM gone`,
    [asOf ? asOf.toISOString() : null],
  );
  return counts(rows[0]);
}

/** The scheduled run: the count of turns deleted (0 = silent). A bad `retention_days` fails the run with the field named, before anything is deleted. */
export async function run(db: Db, ctx: SessionPurgeCtx = {}): Promise<number> {
  const retention = retentionDays(ctx.config);
  const gone = await purgeExpired(db, retention);
  if (gone.sessions_unfolded > 0) {
    // Not an error — the retention is the owner's — but the learning in those
    // sessions is gone, and the fold (T3-10) is what should have read them.
    console.warn(`session-purge: ${gone.sessions_unfolded} session(s) were purged before the session fold read them (retention ${retention} days)`);
  }
  return gone.turns;
}
