// Add to Today — a mirrored Linear task's primary answer (plan §2.12's
// `task` row; T4-24).
//
// The owner presses it on a `task` request; the service captures
//
//   - [ ] <title> do <today> linear:<KEY>
//
// into the vault's `Inbox/` **through the capture service** (mcp-brain's
// `captureToInbox`, the one write path every capture door shares), with
// `source: linear` and an idempotency key per issue. So:
//
//   * a second Add to Today for the same issue returns the FIRST capture —
//     same row, same file, `replayed: true` — and writes nothing (the
//     `inbox_idempotency_uidx` index decides even when two presses race);
//   * nothing here writes the owner's own notes: the line lands as a new
//     capture the owner files like any other (T4-26's rule, *the sync never
//     writes the owner's note*, holds for this path too);
//   * the title is Linear's as the sync recorded it in `work`, never text the
//     caller sends — the caller names an issue by its key and nothing else.
//
// The door that calls this is `POST /api/today/add`
// (`apps/console/src/today-routes.ts`, X-12), the console route answering
// `{door: "today"}`.

import { captureToInbox, type CaptureSink } from "@foldedspacelabs/metistry-mcp-brain";
import { LINEAR_KEY_RE, linearRef } from "@foldedspacelabs/metistry-connections";
import type { Db } from "./run.js";

/** `inbox.source` of every Add to Today capture. */
export const TODAY_SOURCE = "linear";
/**
 * The idempotency principal: the source, not a credential class — so the
 * owner's own `POST /capture` with an `Idempotency-Key` of `linear:ENG-1`
 * (scoped to `user`) can never collide with, or replay, this one.
 */
export const TODAY_PRINCIPAL = "tracker:linear";

const TITLE_CHARS = 200; // limit: fixed — one task line, read on a phone

/** Why Add to Today refused. Each a code path with a test (U3). */
export const TODAY_REFUSAL_CODES = ["bad_key", "bad_date", "unknown_issue"] as const;
export type TodayRefusalCode = (typeof TODAY_REFUSAL_CODES)[number];

export class TodayRefused extends Error {
  override readonly name = "TodayRefused";
  constructor(
    readonly code: TodayRefusalCode,
    message: string,
  ) {
    super(`add to today refused (${code}): ${message}`);
  }
}

/** A title as one task line can carry it: one line, no control characters, no list marker of its own, bounded. */
export function taskTitle(title: string): string {
  const one = title
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^([-*+]\s+)?\[[ xX-]\]\s*/, "");
  const clipped = one.length > TITLE_CHARS ? `${one.slice(0, TITLE_CHARS - 1)}…` : one;
  return clipped || "(untitled)";
}

/** The line Add to Today captures. */
export function todayLine(title: string, key: string, today: string): string {
  return `- [ ] ${taskTitle(title)} do ${today} ${linearRef(key)}`;
}

export interface AddToTodayResult {
  /** the inbox row */
  id: number;
  /** vault-relative, `Inbox/<file>` */
  path: string;
  sha256: string;
  /** true when an earlier Add to Today for this issue already captured it — this is that capture */
  replayed: boolean;
  /** the line as captured (the first capture's, on a replay) */
  line: string;
}

/**
 * Capture a Linear issue's task line for today. `today` is the owner's
 * calendar date (`YYYY-MM-DD`, core's `taskToday` in their zone) — the
 * caller's clock, because "today" is the owner's, not the server's UTC.
 */
export async function addIssueToToday(db: Db, sink: CaptureSink, req: { key: string; today: string }): Promise<AddToTodayResult> {
  if (typeof req.key !== "string" || !LINEAR_KEY_RE.test(req.key)) throw new TodayRefused("bad_key", "a Linear issue is named by its key (TEAM-123)");
  if (typeof req.today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(req.today) || Number.isNaN(Date.parse(`${req.today}T00:00:00Z`))) {
    throw new TodayRefused("bad_date", "today is a calendar date, YYYY-MM-DD");
  }
  const ref = linearRef(req.key);
  const { rows } = await db.query(`SELECT title FROM work WHERE external_ref = $1 AND kind = 'issue'`, [ref]);
  const row = rows[0] as { title: string } | undefined;
  if (!row) throw new TodayRefused("unknown_issue", `${req.key} is not an issue the Linear sync has seen`);
  const line = todayLine(row.title, req.key, req.today);
  const bytes = Buffer.from(`${line}\n`, "utf8");
  const r = await captureToInbox(db, sink, {
    bytes,
    filename: `linear-${req.key}.md`,
    mime: "text/markdown",
    note: line,
    source: TODAY_SOURCE,
    sourceAgent: null, // the owner pressed it
    idempotency: { principal: TODAY_PRINCIPAL, key: ref },
  });
  if (r.replayed) {
    const prior = await db.query(`SELECT note FROM inbox WHERE id = $1`, [r.id]);
    return { id: r.id, path: r.path, sha256: r.sha256, replayed: true, line: String(prior.rows[0]?.note ?? line) };
  }
  return { id: r.id, path: r.path, sha256: r.sha256, replayed: false, line };
}
